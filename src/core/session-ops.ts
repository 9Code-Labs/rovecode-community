/** Session management ops (aion port #84, brought over 2026-09-07): resolve · rename · fork · delete · search over the
 *  existing SessionStore JSONL tree. The headless `rovecode sessions rename|delete|fork|search` verbs (cli/sessions-cmd.ts),
 *  `rovecode trace` / `--resume` (cli/session-arg.ts), `rovecode export` and the TUI /resume all call exactly these
 *  functions, so there is ONE id rule, ONE matcher, ONE meta writer, ONE delete path and ONE search — the /resume
 *  matching rule used to live three times in this repository (tui/app.ts, tui/session-cmd.ts, cli/export.ts):
 *   - ids are validated FIRST (core/session-id.ts: a plain directory name, or a one-line refusal), then resolved
 *     through `matchSessions(listSessions(root), ref)` over readdir NAMES only — an unknown id is "no session",
 *     answered before any write or mkdir (the SessionStore is constructed only AFTER resolution);
 *   - meta writes go through `SessionStore.patchMeta` (core/session.ts), which forces `id` = directory name; a title is
 *     one-lined by `oneLineTitle` (session-text.ts) before it is written AND by listSessions when it is read, so a planted
 *     meta.json title never reaches a table row, `--json` row, picker label or search hit raw;
 *   - delete removes `<sessions>/<id>` and the session's checkpoints shadow dir, the latter from the ONE helper
 *     `checkpointShadowDir` (coding/checkpoints.ts) — never a path built from the raw argument;
 *   - fork copies entries.jsonl + meta.json + attachments/ verbatim into a fresh uuid dir. The attachments copy is
 *     BOUNDED (FORK_MAX_ATTACHMENT_BYTES, 256 MB): a session whose sidecars exceed it is refused with the size, rather
 *     than silently doubling a large directory — the copy is measured with one stat per file before anything is written;
 *   - search = the RecallIndex over the same root (memory/recall.ts: implicit AND, exact-before-partial, neutralised
 *     previews; NO excludeSession — the live session is a candidate) ∪ case-insensitive title-substring hits.
 *  Pattern sources (no code copied): opencode (MIT) packages/opencode/src/session/session.ts @ ebece6e — `getForkedTitle`
 *  :161-169 (the "(fork #N)" suffix rule = forkTitle below), the title `like` search :561, `remove` :606-627, `fork`
 *  :691-732 (copy-up-to-message; here the fork is a verbatim tree copy — branches, chain and leaf survive — and
 *  "fork at a turn" is fork then /rewind), `setTitle` :753-755; `cli/cmd/session.ts` :51-68 (delete), :70-147 (list and
 *  its json shape). Codex (Apache-2.0, pattern only) `codex-rs/tui/src/session_archive_commands.rs:41-45`
 *  `DeleteConfirmation { Prompt, Skip }` → `--yes`. hermes-agent's recall (MIT) is the #17 port this reuses read-only. */

import { randomUUID } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { checkpointShadowDir } from "../coding/checkpoints.ts";
import { RecallIndex } from "../memory/recall.ts";
import { describeBadSessionId } from "./session-id.ts";
import { ATTACHMENTS_DIR } from "./session-images.ts";
import { listSessions, SessionStore, type SessionSummary } from "./session.ts";

/** `<cwd>/.rovecode/sessions` — the one sessions root for `cwd` (the same join cli/main.ts and tui/app.ts use) */
export function sessionsRoot(cwd: string): string {
  return join(cwd, ".rovecode", "sessions");
}

/** The ONE /resume matching rule: an exact id wins outright; otherwise every session whose id starts with `ref` —
 *  the CALLER decides what to do with 0 or several matches (resolving an ambiguous prefix silently to the first hit
 *  resumed the wrong session). */
export function matchSessions(known: readonly SessionSummary[], ref: string): SessionSummary[] {
  const exact = known.find((s) => s.id === ref);
  return exact ? [exact] : known.filter((s) => s.id.startsWith(ref));
}

export type ResolvedSession = { ok: true; id: string; summary: SessionSummary } | { ok: false; error: string };

/** the one-line ambiguity message: `"<ref>" matches N sessions: a, b, c, d, … — be more specific` */
export function ambiguityMessage(ref: string, matches: readonly SessionSummary[]): string {
  const named = matches.slice(0, 4).map((s) => s.id.slice(0, 8)).join(", ");
  return `"${ref}" matches ${matches.length} sessions: ${named}${matches.length > 4 ? ", …" : ""} — be more specific`;
}

/** Validity (session-id.ts) then the /resume rule over readdir names ONLY (matchSessions, hollow directories included
 *  so an exact id still opens a never-written session): an exact id wins, a unique prefix resolves, an ambiguous prefix
 *  is refused naming ≤ 4 candidates, anything else — an unknown id, `../x`, an absolute path, "" — is refused with the
 *  reason. Reads only; never creates anything. */
export function resolveSession(root: string, ref: string): ResolvedSession {
  const want = ref.trim();
  if (want === "") return { ok: false, error: "a session id or prefix is required" };
  const bad = describeBadSessionId(want);
  if (bad !== undefined) return { ok: false, error: bad };
  const matches = matchSessions(listSessions(root, { includeHollow: true }), want);
  if (matches.length === 1) return { ok: true, id: matches[0]!.id, summary: matches[0]! };
  if (matches.length > 1) return { ok: false, error: ambiguityMessage(want, matches) };
  return { ok: false, error: `no session matching "${want}"` };
}

/** The title normaliser lives beside the scanner (core/session-text.ts — listSessions applies it on READ as well); re-exported
 *  here so the two rename paths and their tests import ONE spelling. */
export { oneLineTitle, TITLE_MAX_CHARS } from "./session-text.ts";

/** opencode getForkedTitle (session.ts:161-169): "X" → "X (fork #1)" → "X (fork #2)" → … */
export function forkTitle(title: string): string {
  const m = /^(.+) \(fork #(\d+)\)$/.exec(title);
  return m ? `${m[1]} (fork #${Number(m[2]) + 1})` : `${title} (fork #1)`;
}

/** rename: the store is constructed AFTER resolution (its constructor touches nothing) and the title lands through
 *  patchMeta — `leaf`, unknown keys and the entries file are untouched. */
export function renameSession(root: string, id: string, title: string): void {
  new SessionStore(root, id).patchMeta({ title });
}

export interface ForkResult { id: string; from: string; title: string }

/** the most a fork copies from `attachments/` before refusing (a 200 MB session must not double silently) */
export const FORK_MAX_ATTACHMENT_BYTES = 256 * 1024 * 1024;

/** bytes under a directory, one stat per file, 0 when absent */
export function dirBytes(dir: string): number {
  let total = 0;
  let names: string[];
  try { names = readdirSync(dir); } catch { return 0; }
  for (const n of names) {
    const p = join(dir, n);
    try { const st = statSync(p); total += st.isDirectory() ? dirBytes(p) : st.size; } catch { /* vanished mid-walk */ }
  }
  return total;
}

const mb = (bytes: number): string => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

/** fork = a verbatim copy of entries.jsonl + meta.json + attachments/ (an ALLOW-LIST: todos.json, a legacy memory/ and
 *  the checkpoints shadow repo stay with the source) into a fresh uuid dir, then ONE patchMeta — createdAt = now,
 *  title = forkTitle(title ?? preview), forkedFrom = source. The chain never hashes the session id, so the fork's
 *  reload() finds what the source's finds (`[]` for a clean one), every hash is identical, `leaf` is kept, and the copied
 *  sidecars hydrate under the fork's OWN attachments/ (session-images.ts resolves the session-relative form against the
 *  new dir). Never `append()`: re-appending path() would lose branches, re-chain, and drop hydrated absolute image paths.
 *  Throws (nothing written) when the attachments exceed `maxBytes`. */
export function forkSession(root: string, source: SessionSummary, opts: { maxBytes?: number } = {}): ForkResult {
  const src = join(root, source.id);
  const attachments = join(src, ATTACHMENTS_DIR);
  const max = opts.maxBytes ?? FORK_MAX_ATTACHMENT_BYTES;
  const size = existsSync(attachments) ? dirBytes(attachments) : 0;
  if (size > max) throw new Error(`session ${source.id.slice(0, 8)} carries ${mb(size)} of attachments, over the fork limit of ${mb(max)} — nothing copied; \`rovecode export ${source.id.slice(0, 8)}\` writes the transcript without them`);
  const id = randomUUID();
  const dst = join(root, id);
  mkdirSync(dst, { recursive: true });
  for (const f of ["entries.jsonl", "meta.json"]) if (existsSync(join(src, f))) copyFileSync(join(src, f), join(dst, f));
  // node fs.cpSync: Windows-safe (no `cp -r`), the core/orchestrator.ts copy-isolation precedent
  if (existsSync(attachments)) cpSync(attachments, join(dst, ATTACHMENTS_DIR), { recursive: true });
  const base = source.title ?? source.preview;
  const title = forkTitle(base === "" ? "(empty session)" : base);
  new SessionStore(root, id).patchMeta({ createdAt: Date.now(), title, forkedFrom: source.id }); // forces id = the new dir
  return { id, from: source.id, title };
}

export interface DeleteResult { removed: string[] }

/** delete = exactly `<sessions>/<id>` (entries, meta, attachments, todos.json, a legacy memory/) plus the session's
 *  checkpoints shadow dir `<cwd>/.rovecode/checkpoints/<sanitised id>` from checkpointShadowDir (one helper, no second
 *  spelling). `id` is a RESOLVED directory name, never the raw argument. rmSync(force) clears read-only files (a shadow
 *  repo's objects on Windows). Returns the paths that existed and were removed. */
export function deleteSession(cwd: string, root: string, id: string): DeleteResult {
  const removed: string[] = [];
  for (const dir of [join(root, id), checkpointShadowDir(cwd, id)]) {
    if (!existsSync(dir)) continue;
    rmSync(dir, { recursive: true, force: true });
    removed.push(dir);
  }
  return { removed };
}

export interface SearchRow {
  sessionId: string;
  /** the session's title when one is set (both tiers) */
  title?: string;
  /** "" for a title hit; the matching entry's id for a recall hit */
  entryId: string;
  timestamp: number;
  /** title hit: the session's first prompt; recall hit: the neutralised snippet around the match */
  preview: string;
}

/** search = title-substring hits (case-insensitive, `entryId: ""`, listed first) ∪ `RecallIndex.search(query, limit)` over
 *  the same root (#17 semantics; NO excludeSession, so the live session is a candidate), de-duplicated on (session, entry),
 *  capped at `limit`. The index is rebuilt in memory per call (nothing persisted). Empty query → []. */
export function searchSessions(root: string, query: string, limit = 10): SearchRow[] {
  const q = query.trim();
  if (q === "") return [];
  const all = listSessions(root);
  const titles = new Map<string, string>();
  for (const s of all) if (s.title !== undefined) titles.set(s.id, s.title);
  const needle = q.toLowerCase();
  const rows: SearchRow[] = [];
  for (const s of all) {
    if (s.title !== undefined && s.title.toLowerCase().includes(needle)) rows.push({ sessionId: s.id, title: s.title, entryId: "", timestamp: s.updatedAt, preview: s.preview });
  }
  for (const h of new RecallIndex(root).search(q, limit)) {
    const title = titles.get(h.sessionId);
    rows.push({ sessionId: h.sessionId, ...(title !== undefined ? { title } : {}), entryId: h.entryId, timestamp: h.timestamp, preview: h.preview });
  }
  const seen = new Set<string>();
  return rows.filter((r) => {
    const key = `${r.sessionId.length}:${r.sessionId}:${r.entryId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, limit);
}
