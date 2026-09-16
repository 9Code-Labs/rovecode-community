/** Cross-session recall (port #17): tokenized full-text search over
 *  `.rovecode/sessions/<id>/entries.jsonl` message text, exposed as a `recall` tool.
 *
 *  Ported from hermes-agent's session search (MIT), adapted from SQLite FTS5 to an
 *  in-memory inverted index over the JSONL session tree:
 *  - Index = tokenized message content, maintained incrementally; hermes keeps an
 *    external-content FTS5 table in sync via insert triggers + high-water/progress
 *    markers so only unindexed rows are (re)indexed (hermes_state_common.py:637-684,
 *    hermes_state_search.py:280-346 fts_rebuild_step). Here the incremental unit is
 *    the session FILE, keyed by mtime (+size guard): only changed files re-index.
 *  - Ranking tiers = hermes's routing: exact tokenized FTS5 match is the primary
 *    path, substring (trigram) matching is the fallback tier
 *    (hermes_state_search.py:1467-1489 _describe_search_path, 1846-1885 routing);
 *    within a tier hermes orders by BM25 `ORDER BY rank` with timestamp tiebreaks
 *    (hermes_state_search.py:1791-1798). Here: exact-term count desc, then weighted
 *    term frequency, then recency. Query terms are implicitly ANDed, matching FTS5
 *    (tools/session_search_tool.py:807-809).
 *  - Partial matches need terms >=3 chars, mirroring trigram eligibility
 *    (hermes_state_search.py:1322-1337 _trigram_eligible_tokens).
 *  - Hits are snippet + metadata only, never full content
 *    (hermes_state_search.py:1694-1701, 1827-1844); preview = 120-char window
 *    starting 40 before the first match, the LIKE-fallback snippet shape
 *    (hermes_state_search.py:1585-1595).
 *  - Result budget: limit clamped like hermes's max(1, min(limit, 10))
 *    (tools/session_search_tool.py:1040-1046).
 *  - NO LLM anywhere in the search path (tools/session_search_tool.py:25-33 — the
 *    historical "summary mode" was removed upstream); summarization is an optional
 *    injected fn here, off by default.
 *  - Trust boundary: previews get the same per-line injection neutralization as
 *    BlockStore (blocks.ts:24-27) — threat lines render as [BLOCKED]; disk is never
 *    rewritten. The query echo in tool output is bounded to MAX_QUERY_CHARS.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Tool, ToolContext, ToolOutput } from "../core/types.ts";

/** Ranked hit — the bar's exact shape. Preview only; full text stays on disk. */
export interface RecallHit { sessionId: string; entryId: string; preview: string; timestamp: number }

/** Optional post-search summarizer (LLM or otherwise) — injected, never required. */
export type SummarizeFn = (query: string, hits: RecallHit[]) => Promise<string> | string;

export interface RefreshStats { scanned: number; indexed: number; removed: number }

const MAX_RESULTS = 10;      // hermes limit ceiling (session_search_tool.py:1046)
const DEFAULT_RESULTS = 5;
const PREVIEW_WINDOW = 120;  // hermes LIKE-fallback snippet width (hermes_state_search.py:1587)
const PREVIEW_LEAD = 40;     // window starts 40 chars before the match (same line)
const MIN_PARTIAL_TERM = 3;  // trigram eligibility (hermes_state_search.py:1322-1337)
const MAX_QUERY_CHARS = 512; // bounded adversarial input (hermes MAX_FTS5_QUERY_CHARS, hermes_state_search.py:1199-1201)
const EXACT_WEIGHT = 2;
const PARTIAL_WEIGHT = 1;

/** unicode61-style tokenization (hermes's base FTS5 index): case-fold, split on
 *  anything that is not a letter or digit. */
export function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 0);
}

interface Doc {
  sessionId: string;
  entryId: string;
  text: string;
  timestamp: number;
  tokens: Map<string, number>; // token -> tf (kept for O(tokens) removal on re-index)
}

interface FileState { mtimeMs: number; size: number; docKeys: string[] }

/** One session-entry line, already filtered to message text. */
function parseLine(line: string): { entryId: string; text: string; timestamp: number } | null {
  let raw: unknown;
  try { raw = JSON.parse(line); } catch { return null; } // malformed lines: skip, never throw (session.ts reload pattern)
  if (!raw || typeof raw !== "object") return null;
  const w = raw as { id?: unknown; createdAt?: unknown; entry?: unknown };
  if (typeof w.id !== "string") return null;
  const e = w.entry;
  // events (kind:"event") and non-message shapes are not "message text" — skip
  if (!e || typeof e !== "object" || !("role" in e)) return null;
  const parts = (e as { parts?: unknown }).parts;
  if (!Array.isArray(parts)) return null;
  const texts: string[] = [];
  for (const p of parts) {
    if (p && typeof p === "object"
      && (p as { kind?: unknown }).kind === "text"
      && typeof (p as { text?: unknown }).text === "string") {
      texts.push((p as { text: string }).text);
    }
  }
  const text = texts.join(" ").trim();
  if (!text) return null; // tool_call/tool_result-only messages carry no text parts
  return { entryId: w.id, text, timestamp: typeof w.createdAt === "number" ? w.createdAt : 0 };
}

/** Recalled transcript text sits at the SAME trust level as BlockStore markdown:
 *  text a past model/user wrote, re-entering a live context. Local copy of the
 *  blocks.ts:24-27 neutralization — any line matching the injection pattern
 *  renders as [BLOCKED]; the raw text on disk is never rewritten. */
const THREAT = /(?:ignore previous|disregard above|system prompt)/i;
function neutralize(text: string): string {
  return text.split("\n").map((l) => (THREAT.test(l) ? "[BLOCKED]" : l)).join("\n");
}

/** Slicing by UTF-16 unit can strand half of a surrogate pair at either cut —
 *  drop a leading low / trailing high orphan so emitted text stays well-formed. */
function trimOrphanSurrogates(s: string): string {
  const head = s.charCodeAt(0); // NaN on empty: both range checks are false
  if (head >= 0xdc00 && head <= 0xdfff) s = s.slice(1);
  const tail = s.charCodeAt(s.length - 1);
  if (tail >= 0xd800 && tail <= 0xdbff) s = s.slice(0, -1);
  return s;
}

/** Single-line preview: 120-char window starting 40 before the first matched term
 *  (hermes_state_search.py:1585-1595). Ellipses mark clipping. */
function makePreview(text: string, terms: string[]): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const lower = flat.toLowerCase();
  let pos = -1;
  for (const t of terms) {
    const i = lower.indexOf(t);
    if (i !== -1 && (pos === -1 || i < pos)) pos = i;
  }
  const start = pos === -1 ? 0 : Math.max(0, pos - PREVIEW_LEAD);
  const clip = trimOrphanSurrogates(flat.slice(start, start + PREVIEW_WINDOW));
  return (start > 0 ? "…" : "") + clip + (start + PREVIEW_WINDOW < flat.length ? "…" : "");
}

/** Inverted index over every session's entries.jsonl. Incremental: a file is
 *  re-read only when its mtime (or size — appends always grow JSONL) changed;
 *  deleted session dirs drop out. Session identity = the DIRECTORY name, matching
 *  session.ts listSessions (a tampered meta.json must not redirect recall). */
export class RecallIndex {
  private docs = new Map<string, Doc>();                    // docKey -> doc
  private postings = new Map<string, Map<string, number>>(); // token -> docKey -> tf
  private files = new Map<string, FileState>();              // sessionId -> file state

  constructor(private readonly root: string) {}

  /** Stat every session file; (re)index changed/new ones, drop vanished ones. */
  refresh(): RefreshStats {
    const stats: RefreshStats = { scanned: 0, indexed: 0, removed: 0 };
    let names: string[] = [];
    try { names = readdirSync(this.root); } catch { /* missing root = empty index */ }
    const live = new Set<string>();
    for (const name of names) {
      const file = join(this.root, name, "entries.jsonl");
      let st: { mtimeMs: number; size: number };
      try { const s = statSync(file); st = { mtimeMs: s.mtimeMs, size: s.size }; }
      catch { continue; } // foreign dir / no entries yet: skip, never throw
      live.add(name);
      stats.scanned++;
      const prev = this.files.get(name);
      if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size) continue; // unchanged: keyed by mtime
      this.dropSession(name);
      this.indexFile(name, file, st);
      stats.indexed++;
    }
    for (const name of [...this.files.keys()]) {
      if (!live.has(name)) { this.dropSession(name); stats.removed++; }
    }
    return stats;
  }

  private dropSession(sessionId: string): void {
    const prev = this.files.get(sessionId);
    if (!prev) return;
    for (const key of prev.docKeys) {
      const doc = this.docs.get(key);
      if (doc) {
        for (const token of doc.tokens.keys()) {
          const posting = this.postings.get(token);
          if (posting) { posting.delete(key); if (posting.size === 0) this.postings.delete(token); }
        }
      }
      this.docs.delete(key);
    }
    this.files.delete(sessionId);
  }

  private indexFile(sessionId: string, file: string, st: { mtimeMs: number; size: number }): void {
    const docKeys: string[] = [];
    let content = "";
    try { content = readFileSync(file, "utf8"); } catch { /* raced deletion: index as empty */ }
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      const parsed = parseLine(line);
      if (!parsed) continue;
      // length-prefixed doc key: immune to separator-content collisions — session
      // "s" + entry "0000e1" and session "s0000" + entry "e1" must stay distinct.
      // The previous separator was the literal 4-char string "0000" (bytes 0x30
      // 0x30 0x30 0x30 — an intended U+0000 NUL escape written without the
      // backslash-u), so exactly that pair collided and the second doc was
      // silently dropped by the duplicate-key guard below.
      const key = `${sessionId.length}:${sessionId}:${parsed.entryId}`;
      if (this.docs.has(key)) continue; // duplicate-id guard (session.ts corruption class)
      const tokens = new Map<string, number>();
      for (const t of tokenize(parsed.text)) tokens.set(t, (tokens.get(t) ?? 0) + 1);
      if (tokens.size === 0) continue;
      this.docs.set(key, { sessionId, entryId: parsed.entryId, text: parsed.text, timestamp: parsed.timestamp, tokens });
      docKeys.push(key);
      for (const [token, tf] of tokens) {
        let posting = this.postings.get(token);
        if (!posting) { posting = new Map(); this.postings.set(token, posting); }
        posting.set(key, tf);
      }
    }
    this.files.set(sessionId, { mtimeMs: st.mtimeMs, size: st.size, docKeys });
  }

  /** Ranked search. Terms are ANDed (FTS5 implicit AND). Tiering: docs with more
   *  exact-term matches ALWAYS outrank docs matching only partially (hermes's
   *  exact-FTS5-before-trigram routing as a rank, not a fallback); within a tier,
   *  weighted tf desc, then timestamp desc, then key for determinism. */
  search(query: string, limit: number, excludeSession?: string): RecallHit[] {
    this.refresh();
    const terms = [...new Set(tokenize(query.slice(0, MAX_QUERY_CHARS)))];
    if (terms.length === 0) return [];

    let cands: Map<string, { exact: number; weighted: number }> | null = null;
    for (const term of terms) {
      const matched = new Map<string, { ex: number; part: number }>();
      const exact = this.postings.get(term);
      if (exact) for (const [key, tf] of exact) matched.set(key, { ex: tf, part: 0 });
      if (term.length >= MIN_PARTIAL_TERM) { // substring tier, trigram-eligible terms only
        for (const [token, posting] of this.postings) {
          if (token === term || !token.includes(term)) continue;
          for (const [key, tf] of posting) {
            const m = matched.get(key) ?? { ex: 0, part: 0 };
            m.part += tf;
            matched.set(key, m);
          }
        }
      }
      const next = new Map<string, { exact: number; weighted: number }>();
      for (const [key, m] of matched) {
        const prev = cands === null ? { exact: 0, weighted: 0 } : cands.get(key);
        if (prev === undefined) continue; // AND: term missing from doc drops it
        next.set(key, {
          exact: prev.exact + (m.ex > 0 ? 1 : 0),
          weighted: prev.weighted + EXACT_WEIGHT * m.ex + PARTIAL_WEIGHT * m.part,
        });
      }
      cands = next;
      if (cands.size === 0) return [];
    }

    const ranked = [...(cands ?? new Map<string, { exact: number; weighted: number }>())]
      .flatMap(([key, cand]) => {
        const doc = this.docs.get(key);
        // exclude the live session: recall is CROSS-session (hermes skips the
        // current lineage, session_search_tool.py:852-860)
        return doc && doc.sessionId !== excludeSession ? [{ key, cand, doc }] : [];
      })
      .sort((a, b) =>
        b.cand.exact - a.cand.exact
        || b.cand.weighted - a.cand.weighted
        || b.doc.timestamp - a.doc.timestamp
        || (a.key < b.key ? -1 : 1));

    return ranked.slice(0, Math.max(0, limit)).map(({ doc }) => ({
      sessionId: doc.sessionId,
      entryId: doc.entryId,
      // neutralized HERE so every consumer — tool output, data.hits, the injected
      // summarizer — sees the scanned view, never the verbatim transcript line
      preview: neutralize(makePreview(doc.text, terms)),
      timestamp: doc.timestamp,
    }));
  }
}

export interface RecallToolOptions {
  /** injected summarizer; absent = raw hits only (upstream removed its LLM summary mode) */
  summarize?: SummarizeFn;
  /** result-budget ceiling; defaults to hermes's 10 */
  maxResults?: number;
}

/** Build the `recall` tool over a sessions root (one lazy index per tool instance).
 *
 *  kind "read", NOT "memory": recall only READS session files from disk — it never
 *  mutates memory. core/tools.ts actionFor() maps "read" -> "file.read" but
 *  "memory" -> "memory.write"; gating a pure read behind a write action would let
 *  memory-write policies silently grant history reads AND lock recall out of
 *  read-only rule sets. With no `path` arg, describeResource() falls back to the
 *  tool name, so policy can target `file.read recall` precisely; deny-by-default
 *  still applies when no rule matches (core/tools.ts evaluatePermissions). */
export function recallTool(sessionsRoot: string, opts: RecallToolOptions = {}): Tool {
  const index = new RecallIndex(sessionsRoot);
  const ceiling = Math.max(1, opts.maxResults ?? MAX_RESULTS);
  return {
    schema: {
      name: "recall",
      description:
        "Search past session transcripts (cross-session recall). Full-text over prior conversation " +
        "message text — no LLM. Terms are ANDed; exact word matches rank above partial (substring) " +
        `matches. Returns up to ${ceiling} hits: sessionId, entryId, timestamp, and a short preview. ` +
        "Use for questions about past conversations: 'what did we decide about X', 'where did we leave Y'.",
      args: {
        type: "object",
        properties: {
          query: { type: "string", description: "words to find in past sessions" },
          limit: { type: "integer", description: `max hits (default ${Math.min(DEFAULT_RESULTS, ceiling)}, max ${ceiling})` },
        },
        required: ["query"],
      },
    },
    kind: "read",
    sequential: false, // pure read: safe to run concurrently with sibling reads
    async execute(args: unknown, ctx: ToolContext): Promise<ToolOutput> {
      // Defense in depth: keep ONLY schema args (query, limit) — smuggled keys,
      // notably `path`, must never influence behavior. core/tools.ts
      // describeResource() prefers an args `path` over the tool-name fallback, so
      // {query, path:"/x"} re-aims a `file.read recall` deny rule at "/x"; policy
      // runs BEFORE execute, so this strip cannot repair that gate — the
      // authoritative fix belongs in describeResource (validate against the tool
      // schema). Residual gap documented in recall.test.ts. A fresh object (not
      // deletes on `args`) because the registry reuses the caller's object for
      // loop-guard identity and onToolResult after execute.
      const raw = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
      const a: { query?: unknown; limit?: unknown } = { query: raw.query, limit: raw.limit };
      if (typeof a.query !== "string" || a.query.trim().length === 0) {
        return { ok: false, output: "recall failed: query must be a non-empty string" };
      }
      // the echoed query is bounded like the searched one: a 200k-char query must
      // not reflect 200k chars into tool output (truncation marked with an ellipsis)
      const trimmed = a.query.trim();
      const echo = trimmed.length > MAX_QUERY_CHARS
        ? trimOrphanSurrogates(trimmed.slice(0, MAX_QUERY_CHARS)) + "…" : trimmed;
      // hermes limit clamp: max(1, min(limit, ceiling)) (session_search_tool.py:1040-1046)
      let limit = Math.min(DEFAULT_RESULTS, ceiling);
      if (typeof a.limit === "number" && Number.isFinite(a.limit)) limit = Math.trunc(a.limit);
      limit = Math.max(1, Math.min(limit, ceiling));

      const hits = index.search(a.query, limit, ctx.sessionId);
      if (hits.length === 0) {
        // actionable empty message, hermes session_search_tool.py:806-810
        return { ok: true, output: `recall: no matches for "${echo}" — terms are ANDed; try fewer or broader terms`, data: { hits } };
      }
      const lines = hits.map((h) =>
        `- [${h.sessionId}] entry ${h.entryId} @ ${h.timestamp > 0 ? new Date(h.timestamp).toISOString() : "unknown time"}\n  ${h.preview}`);
      let output = `recall: ${hits.length} hit(s) for "${echo}"\n` + lines.join("\n");
      if (opts.summarize) {
        try {
          const summary = await opts.summarize(a.query, hits);
          if (summary) output += `\n\nsummary: ${summary}`;
        } catch (e) {
          output += `\n\n(summarize step failed: ${e instanceof Error ? e.message : String(e)}; hits above are unaffected)`;
        }
      }
      return { ok: true, output, data: { hits } };
    },
  };
}
