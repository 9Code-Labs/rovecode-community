/** `rovecode sessions [--json]` (aion port #59, brought over 2026-09-07): the headless view of the TUI's /sessions picker
 *  over the ONE scanner (core/session.ts scanSessions — no second directory walk). Rows carry id, created, updated, cwd
 *  (the workspace whose sessions were listed — sessions are per project dir), the first prompt and the user-turn
 *  count; newest (updatedAt) first. `--json` prints the row array; the text table prints the cwd once in its header
 *  and, when there are any, ONE footer line counting the hollow directories (a meta.json, nothing ever written) from
 *  the stat alone — they are not rows, and whether to delete them is Berkay's open question; the count keeps it
 *  askable. Exit 0, also for an empty list.
 *  Port #84 — four verbs over core/session-ops.ts: `rename <id|prefix> <title…>`, `delete <id|prefix> [--yes]`,
 *  `fork <id|prefix> [--json]`, `search <terms…> [--json]`. Rows and the table show a set `title` (`--json` rows carry
 *  the key ONLY when set). Ids resolve by the /resume rule BEFORE any write; a usage error (unknown verb, missing id,
 *  bad / ambiguous / unknown id, empty title or query, an oversize fork) is exit 2 + ONE stderr line, nothing removed
 *  or created. Nothing boots a runtime or provider. `--yes` (codex's DeleteConfirmation Skip, pattern only) skips the
 *  y/N confirmation; a non-TTY stdin without it is refused (exit 2) — the TTY prompt itself (Bun's synchronous
 *  `confirm`, default N) is not hermetically tested. `--json` / `--yes` are booleans: no dispatch.ts VALUE_FLAGS entry.
 *  aion's `--cwd <dir>` is not brought: rovecode commands act on the cwd. */

import { scanSessions } from "../core/session.ts";
import { deleteSession, forkSession, oneLineTitle, renameSession, resolveSession, searchSessions, sessionsRoot, type SearchRow } from "../core/session-ops.ts";

export interface SessionRow {
  id: string;
  /** ISO 8601 */
  created: string;
  updated: string;
  cwd: string;
  /** first user-message text, single line, ≤80 chars ("" for an empty session) */
  firstPrompt: string;
  /** user messages recorded in the session file (every branch) */
  turns: number;
  /** all entries (messages + event markers) */
  entries: number;
  /** the user-given title — the key is present ONLY when one is set */
  title?: string;
}

export interface SessionListing { rows: SessionRow[]; hollow: number; root: string }

/** the rows (sessions that hold something) plus the hollow count, from one scan */
export function sessionListing(cwd: string): SessionListing {
  const root = sessionsRoot(cwd);
  const scan = scanSessions(root);
  const rows = scan.sessions.map((s) => ({
    id: s.id, created: new Date(s.createdAt).toISOString(), updated: new Date(s.updatedAt).toISOString(),
    cwd, firstPrompt: s.preview, turns: s.turns, entries: s.entryCount,
    ...(s.title !== undefined ? { title: s.title } : {}),
  }));
  return { rows, hollow: scan.hollow.length, root };
}

export function sessionRows(cwd: string): SessionRow[] {
  return sessionListing(cwd).rows;
}

/** the one footer line for the hollow directories, or undefined when there are none */
export function hollowLine(count: number, root: string): string | undefined {
  if (count === 0) return undefined;
  return `${count} empty session director${count === 1 ? "y" : "ies"} in ${root} — nothing was ever written to them`;
}

export function formatSessions(listing: SessionListing, json: boolean): string {
  const { rows, hollow, root } = listing;
  if (json) return JSON.stringify(rows);
  const footer = hollowLine(hollow, root);
  if (rows.length === 0) return [`no sessions in ${root} — a \`rovecode run\` or a TUI turn starts one`, ...(footer ? [footer] : [])].join("\n");
  const lines = [`sessions in ${root} (newest first; --json for the full rows):`, `${"id".padEnd(36)}  ${"created".padEnd(24)}  turns  first prompt`];
  for (const r of rows) lines.push(`${r.id.padEnd(36)}  ${r.created.padEnd(24)}  ${String(r.turns).padStart(5)}  ${r.title ?? (r.firstPrompt || "(empty session)")}`); // a title stands in for the first prompt
  if (footer) lines.push(footer);
  return lines.join("\n");
}

/** one search hit per line: session id8 · ISO time · entry id8 (or `title` for a title-tier hit) · [title] preview */
export function formatSearchHit(r: SearchRow): string {
  const where = r.entryId === "" ? "title" : r.entryId.slice(0, 8);
  return `${r.sessionId.slice(0, 8)}  ${new Date(r.timestamp).toISOString()}  ${where.padEnd(8)}  ${r.title !== undefined ? `[${r.title}] ` : ""}${r.preview}`;
}

export const SESSIONS_USAGE = "usage: rovecode sessions [--json] | rename <id|prefix> <title…> | delete <id|prefix> [--yes] | fork <id|prefix> [--json] | search <terms…> [--json]";
const VERBS: ReadonlySet<string> = new Set(["rename", "delete", "fork", "search"]);

/** a token that is a flag, not a value: `-x`, `--x` (a lone `-` would be stdin, a value) */
const isFlag = (a: string): boolean => a.length > 1 && a.startsWith("-");

/** the words after the `sessions` token minus every flag token */
export function sessionWords(argv: readonly string[]): string[] {
  const at = argv.indexOf("sessions");
  return at === -1 ? [] : argv.slice(at + 1).filter((a) => !isFlag(a));
}

export interface SessionsCmdIo {
  out: (text: string) => void;
  err: (text: string) => void;
  /** stdin is a terminal (the y/N prompt is possible); default process.stdin.isTTY */
  tty?: boolean;
  /** the y/N prompt; default Bun's global confirm */
  confirm?: (question: string) => boolean;
}

/** main.ts dispatch: the sessions of `cwd`. Returns the exit code. */
export function cmdSessions(argv: readonly string[], cwd: string, io: Partial<SessionsCmdIo> = {}): number {
  const out = io.out ?? ((t: string) => console.log(t));
  const err = io.err ?? ((t: string) => process.stderr.write(`${t}\n`));
  const usageError = (msg: string): number => { err(`error: ${msg} — ${SESSIONS_USAGE}`); return 2; }; // ONE stderr line, exit 2
  const json = argv.includes("--json");
  const words = sessionWords(argv);
  const verb = words[0];
  if (verb === undefined) { out(formatSessions(sessionListing(cwd), json)); return 0; }
  if (!VERBS.has(verb)) return usageError(`unknown sessions verb "${verb}"`);
  const root = sessionsRoot(cwd);
  if (verb === "search") {
    const q = words.slice(1).join(" ").trim();
    if (q === "") return usageError("search needs at least one term");
    const rows = searchSessions(root, q, 10);
    if (json) out(JSON.stringify(rows));
    else out(rows.length === 0 ? `no matches for "${q}" in ${root}` : rows.map(formatSearchHit).join("\n"));
    return 0;
  }
  const ref = words[1];
  if (ref === undefined) return usageError(`${verb} needs a session id or prefix`);
  const found = resolveSession(root, ref); // validity + the /resume rule over readdir names — nothing is created or removed before this
  if (!found.ok) return usageError(found.error);
  if (verb === "rename") {
    const title = oneLineTitle(words.slice(2).join(" "));
    if (title === undefined) return usageError("rename needs a non-empty title");
    renameSession(root, found.id, title);
    out(`renamed ${found.id} → "${title}"`);
    return 0;
  }
  if (verb === "fork") {
    let r;
    try { r = forkSession(root, found.summary); } catch (e) { return usageError(e instanceof Error ? e.message : String(e)); }
    out(json ? JSON.stringify(r) : `${r.id}  fork of ${r.from.slice(0, 8)} · "${r.title}"`);
    return 0;
  }
  // delete — codex DeleteConfirmation { Prompt, Skip }: `--yes` = Skip; Prompt only on a TTY (default N); otherwise refused
  if (!argv.includes("--yes")) {
    const tty = io.tty ?? process.stdin.isTTY === true;
    if (!tty) return usageError(`delete ${found.id.slice(0, 8)} needs --yes when stdin is not a terminal`);
    const label = found.summary.title ?? (found.summary.preview || "(empty session)");
    const ask = io.confirm ?? ((q: string) => confirm(q));
    if (!ask(`delete session ${found.id} (${label}, ${found.summary.entryCount} entries) and its checkpoints?`)) { out("delete cancelled — nothing removed"); return 0; }
  }
  const { removed } = deleteSession(cwd, root, found.id);
  out(removed.length === 0 ? `nothing to remove for ${found.id}` : removed.map((p) => `removed ${p}`).join("\n"));
  return 0;
}
