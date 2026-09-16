/** Port #38: session export — markdown transcript or raw JSONL copy, LOCAL only.
 *  Pattern: opencode cli/cmd/export.ts @ ebece6e (MIT) — session resolution → serialize;
 *  their export emits the raw session data verbatim to stdout, which maps to --json here
 *  (verbatim byte copy of entries.jsonl, the whole tree incl. abandoned branches). The
 *  cloud-share half of opencode's feature (share/session.ts) is explicitly deferred
 *  (PORTS.md wave-3 ledger: "export stays local"), and the markdown layout is rovecode-native:
 *  the snapshot has no session→markdown renderer at ebece6e.
 *
 *  Markdown walks the ACTIVE path only (store.path()), mirroring TUI replayHistory:
 *  user/assistant text, tool cards (args one-liner, bounded output, ok/ERROR badge),
 *  mode switches as "mode → plan" lines (wave-2 replay convention, never raw
 *  <mode_notice> XML), compaction markers, and a costs section over per-origin usage
 *  totals + buildCostNote. Output is deterministic: every timestamp comes from the
 *  entries themselves (ISO UTC), there is no "generated at" wall-clock line, and the
 *  catalog is the offline snapshot (lookup() never fetches). */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { SessionStore, type Entry } from "../core/session.ts";
import { describeBadSessionId } from "../core/session-id.ts";
import { resolveSession } from "../core/session-ops.ts";
import { modeSwitchOf } from "../core/modes.ts";
import { ModelCatalog } from "../providers/catalog.ts";
import { buildCostNote } from "../tui/cost.ts";
import { describeImage } from "../core/images.ts";
import type { ImagePart, Message, ToolCallPart, ToolResultPart } from "../core/types.ts";

/** Tool output cap (chars) per card. Clipped output gets an explicit marker line. */
export const TOOL_OUTPUT_CAP = 2000;
/** One-line args summary cap — same 120-char clip the TUI uses for tool cards. */
const ARGS_CAP = 120;
/** CLI usage line — thrown on a missing id or a dangling --out; cmdExport turns it into exit 2, the
 *  usage/startup class README documents, while a real export failure stays exit 1. */
const USAGE = "usage: rovecode export <session-id|prefix> [--json] [--out <path>] [--force]";

export interface ExportOptions {
  /** raw JSONL copy (verbatim bytes) instead of markdown */
  json?: boolean;
  /** target path; default ./<sessionId-short>.(md|jsonl) under cwd */
  out?: string;
  /** overwrite an existing target file */
  force?: boolean;
  /** base dir for relative/default output paths; default process.cwd() */
  cwd?: string;
}

export interface ExportResult { path: string; format: "markdown" | "jsonl" }

// ---------- session-prefix resolution: the ONE rule (core/session-ops.ts resolveSession — shared with /resume,
// `--resume`, `trace` and the `sessions` verbs; this file used to carry its own copy) ----------

/** Exact id wins outright; a prefix must match exactly ONE session; an ambiguous prefix lists candidates instead
 *  of silently picking one. An id that is not a plain directory name is refused on export's own usage path
 *  before any listing (`../x` never reaches a path join). */
export function resolveSessionId(sessionsRoot: string, idOrPrefix: string): string {
  const bad = describeBadSessionId(idOrPrefix);
  if (bad !== undefined) throw new Error(`${bad} — ${USAGE}`);
  const r = resolveSession(sessionsRoot, idOrPrefix);
  if (!r.ok) throw new Error(r.error);
  return r.id;
}

// ---------- markdown rendering ----------

function isMessage(e: Entry): e is Message { return "role" in e; }

/** Longest backtick run in s (0 when none) — a CommonMark span/fence must be longer. */
function tickRun(s: string): number {
  let run = 0;
  for (const m of s.matchAll(/`+/g)) run = Math.max(run, m[0].length);
  return run;
}

/** Inline-code span that survives backticks in the content (args may contain them):
 *  delimiter = longest run + 1 (a fixed `` closes at the first inner double tick),
 *  space-padded so a leading/trailing tick stays inside the span. */
function inlineCode(s: string): string {
  const run = tickRun(s);
  if (run === 0) return `\`${s}\``;
  const tick = "`".repeat(run + 1);
  return `${tick} ${s} ${tick}`;
}

/** Fenced block whose fence is longer than any backtick run in the content. */
function fenced(content: string): string {
  const fence = "`".repeat(Math.max(3, tickRun(content) + 1));
  return `${fence}\n${content}\n${fence}`;
}

/** One tool card: name + badge header, one-line args, bounded output block. */
function toolCard(tool: string, args: unknown, res: ToolResultPart | undefined): string {
  const badge = res === undefined ? "no result recorded" : res.ok ? "ok" : "ERROR";
  const argsLine = JSON.stringify(args) ?? "undefined";
  const argsShown = argsLine.length > ARGS_CAP ? argsLine.slice(0, ARGS_CAP) + "…" : argsLine;
  const parts = [`### tool: ${tool} — ${badge}`, `args: ${inlineCode(argsShown)}`];
  if (res !== undefined) {
    if (res.output.length === 0) parts.push("*(no output)*");
    else {
      const clipped = res.output.length > TOOL_OUTPUT_CAP;
      parts.push(fenced(clipped ? res.output.slice(0, TOOL_OUTPUT_CAP) : res.output));
      if (clipped) parts.push(`*+${res.output.length - TOOL_OUTPUT_CAP} chars clipped (cap ${TOOL_OUTPUT_CAP})*`);
    }
  }
  return parts.join("\n\n");
}

function textOf(m: Message): string {
  return m.parts.filter((p) => p.kind === "text").map((p) => (p as { text: string }).text).join("");
}

/** Render the active path as markdown. Exported for tests; pure over the entries. */
export function renderSessionMarkdown(entries: readonly Entry[], sessionId: string, catalog: ModelCatalog): string {
  const messages = entries.filter(isMessage);
  // pair tool_call parts with their results up front so a card renders where the
  // assistant issued the call; results without a visible call render as orphan cards
  const results = new Map<string, ToolResultPart>();
  for (const m of messages) {
    if (m.role !== "tool") continue;
    for (const p of m.parts) if (p.kind === "tool_result" && !results.has(p.callId)) results.set(p.callId, p);
  }
  const consumed = new Set<string>();

  // title block: id, date range, model origins (first-appearance order)
  const stamps = entries.map((e) => e.createdAt).filter((t) => typeof t === "number");
  const range = stamps.length > 0
    ? `${new Date(Math.min(...stamps)).toISOString()} → ${new Date(Math.max(...stamps)).toISOString()}`
    : "(empty)";
  const origins: string[] = [];
  for (const m of messages) {
    if (!m.origin) continue;
    const key = `${m.origin.provider}/${m.origin.model}`;
    if (!origins.includes(key)) origins.push(key);
  }
  const blocks: string[] = [
    `# rovecode session ${sessionId.slice(0, 8)}`,
    [`- id: ${inlineCode(sessionId)}`, `- range: ${range}`, `- models: ${origins.length > 0 ? origins.join(", ") : "(none)"}`].join("\n"),
  ];

  for (const e of entries) {
    if (!isMessage(e)) {
      // event entries: compaction becomes a marker (TUI wording, app.ts); others skipped
      if (e.event.type === "compaction") {
        blocks.push(`> compacted (${e.event.strategy}): ${e.event.tokensBefore} → ${e.event.tokensAfter} tokens`);
      }
      continue;
    }
    const sw = modeSwitchOf(e);
    if (sw) { blocks.push(`> mode → ${sw.to}`); continue; } // replay convention, never the raw XML
    const text = textOf(e);
    if (e.role === "user") {
      // port #34: image parts render as one chip line each under the text (name, WxH, size), the
      // same describeImage text the TUI notes use; the bytes stay in the session's attachments
      // dir (header) so no image link that would dangle next to the export is emitted
      const chips = e.parts.filter((p): p is ImagePart => p.kind === "image").map((p) => `[image: ${describeImage(p)}]`);
      if (text || chips.length > 0) blocks.push("## User", ...(text ? [text] : []), ...chips);
    } else if (e.role === "assistant") {
      blocks.push("## Assistant");
      if (text) blocks.push(text);
      for (const p of e.parts) {
        if (p.kind !== "tool_call") continue;
        const call = p as ToolCallPart;
        blocks.push(toolCard(call.tool, call.args, results.get(call.id)));
        consumed.add(call.id);
      }
    } else if (e.role === "tool") {
      for (const p of e.parts) {
        if (p.kind === "tool_result" && !consumed.has(p.callId)) {
          blocks.push(toolCard("(unknown)", undefined, p));
          consumed.add(p.callId);
        }
      }
    } else if (text) {
      // plain system note (e.g. a compaction summary message)
      blocks.push(text.split("\n").map((l) => `> ${l}`).join("\n"));
    }
  }
  if (messages.length === 0) blocks.push("*(no entries)*");

  // costs: per-origin usage totals, then the /cost note (existing helpers, deterministic
  // against the offline catalog; "current" = the last message origin on the path)
  const byOrigin = new Map<string, { input: number; output: number; cacheRead: number; cacheWrite: number; msgs: number }>();
  for (const m of messages) {
    if (!m.usage) continue;
    const key = m.origin ? `${m.origin.provider}/${m.origin.model}` : "(no origin)";
    const row = byOrigin.get(key) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, msgs: 0 };
    row.input += m.usage.input; row.output += m.usage.output;
    row.cacheRead += m.usage.cacheRead ?? 0; row.cacheWrite += m.usage.cacheWrite ?? 0;
    row.msgs += 1;
    byOrigin.set(key, row);
  }
  blocks.push("## Costs");
  if (byOrigin.size > 0) {
    blocks.push([
      "| model | input | output | cache read | cache write | messages |",
      "| --- | ---: | ---: | ---: | ---: | ---: |",
      ...[...byOrigin.entries()].map(([k, r]) => `| ${k} | ${r.input} | ${r.output} | ${r.cacheRead} | ${r.cacheWrite} | ${r.msgs} |`),
    ].join("\n"));
  }
  const current = [...messages].reverse().find((m) => m.origin)?.origin ?? { provider: "unknown", model: "unknown" };
  blocks.push(buildCostNote(messages, catalog, current).split("\n").map((l) => `- ${l}`).join("\n"));

  return blocks.join("\n\n") + "\n";
}

// ---------- export entrypoint ----------

function targetPath(out: string | undefined, id: string, format: "markdown" | "jsonl", cwd: string): string {
  const fallback = `${id.slice(0, 8)}.${format === "jsonl" ? "jsonl" : "md"}`;
  const p = out ?? fallback;
  return isAbsolute(p) ? p : join(cwd, p);
}

/** Export a session (full id or unique prefix) to markdown or a raw JSONL copy.
 *  --json copies entries.jsonl BYTE-VERBATIM (whole tree, every branch); markdown
 *  renders the active path only. Never overwrites an existing file without force. */
export function exportSession(sessionsRoot: string, idOrPrefix: string, opts: ExportOptions = {}): ExportResult {
  if (!idOrPrefix) throw new Error(USAGE);
  const id = resolveSessionId(sessionsRoot, idOrPrefix);
  const format: ExportResult["format"] = opts.json ? "jsonl" : "markdown";
  const target = targetPath(opts.out, id, format, opts.cwd ?? process.cwd());
  if (existsSync(target) && !opts.force) throw new Error(`refusing to overwrite ${target} — pass --force`);
  if (opts.json) {
    const src = join(sessionsRoot, id, "entries.jsonl");
    if (!existsSync(src)) throw new Error(`session ${id.slice(0, 8)} has no entries.jsonl to copy`);
    writeFileSync(target, readFileSync(src)); // Buffer in → Buffer out: verbatim bytes
  } else {
    const store = new SessionStore(sessionsRoot, id);
    writeFileSync(target, renderSessionMarkdown(store.path(), id, new ModelCatalog()));
  }
  return { path: target, format };
}

// ---------- CLI glue (rovecode export …) ----------

export interface ExportCliArgs { idOrPrefix?: string; json: boolean; out?: string; force: boolean }

/** Parse `rovecode export` argv. Flags may sit anywhere — parseCli accepts `rovecode --json
 *  export <id>` for every subcommand — so the whole argv after the script path is
 *  scanned and the single `export` command token skipped. parseCli strips flags but
 *  leaves flag VALUES in rest, so --out is consumed here (same reason main.ts hand-
 *  parses --resume: dispatch flags are boolean-only); a missing or flag-shaped --out
 *  value is a usage error, never a silent default. First remaining non-flag = the id. */
export function parseExportArgs(argv: readonly string[]): ExportCliArgs {
  const args = argv.slice(2);
  const parsed: ExportCliArgs = { json: false, force: false };
  let cmdSeen = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--json") parsed.json = true;
    else if (a === "--force") parsed.force = true;
    else if (a === "--out") {
      const v = args[++i];
      if (v === undefined || v.startsWith("-")) throw new Error(`--out needs a path — ${USAGE}`);
      parsed.out = v;
    } else if (!a.startsWith("-")) { // other flags (--yolo, --plain, …) belong to dispatch
      if (!cmdSeen && a === "export") cmdSeen = true; // the command token itself
      else if (parsed.idOrPrefix === undefined) parsed.idOrPrefix = a;
    }
  }
  return parsed;
}

/** `rovecode export <session> [--json] [--out <path>] [--force]` — errors exit 1. */
export function cmdExport(argv: readonly string[]): void {
  try {
    const a = parseExportArgs(argv); // inside: a dangling --out is a usage error too
    const res = exportSession(join(process.cwd(), ".rovecode", "sessions"), a.idOrPrefix ?? "", a);
    console.log(`exported ${res.format} → ${res.path}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`error: ${msg}`);
    // "you typed it wrong" and "it did not work" are different answers to a script: 2 is the usage class
    // (README: 0 done · 1 error/budget · 2 usage/startup), and every other command already answers that way
    process.exit(msg.startsWith("usage:") ? 2 : 1);
  }
}
