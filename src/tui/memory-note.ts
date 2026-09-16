/** `#<text>` memory shortcut + `/memory [--user] [text]`. A prompt LINE that starts with `#` appends the rest of
 *  the line to the MEMORY block (the project store, memory/scope.ts) — no model turn, one transcript note — the way
 *  `!cmd` short-circuits the prompt (tui/shell-cmd.ts). Pattern source: Claude Code's `#` "add to memory" shortcut
 *  (proprietary — PATTERN ONLY, no code copied).
 *
 *  The classifier is deliberately narrow, because the obvious version swallows pasted code: a note is ONE line
 *  whose trimmed text is `#` followed by a letter or digit (`#always use bun`, `#1 is flaky`). Everything else is a
 *  prompt for the model — any submission with a newline (a pasted `#include …` block, a shebang script), `#`,
 *  `# heading`, `##x`, `#!…`, `#[…]`, `#-flag`, and a `#` INSIDE a line (`fix the #1 bug`).
 *
 *  The edit lands on disk and in the live store at once (memory_edit and /memory see it); the prompt keeps its boot
 *  snapshot and picks the note up on the NEXT run (memory/blocks.ts). Both surfaces share this module. No store is
 *  constructed here — the ACTIVE runtime store is injected, so a session switch cannot leave this writing to a
 *  store nobody reads. */

import type { BlockName, BlockStore } from "../memory/blocks.ts";
import type { Renderer } from "./renderer.ts";

/** the classifier's opener: `#` then a letter or digit (any script) */
const NOTE_OPENER = /^#[\p{L}\p{N}]/u;

/** The note of a `#<text>` line, or null when the submission is a prompt for the model (header rule). */
export function memoryNoteLine(text: string): string | null {
  if (/[\r\n]/.test(text)) return null; // a multi-line submission is pasted content, never a note
  const t = text.trim();
  if (!NOTE_OPENER.test(t)) return null;
  return t.slice(1).trim();
}

export type Tone = "info" | "warn";

const LABEL: Readonly<Record<BlockName, string>> = { memory: "MEMORY", user: "USER" };

/** Append `text` to `block` through the store (cap, trust and ledger guarded); the line says WHERE it landed —
 *  the path is the point, since the whole bug this replaced was a note landing somewhere the person did not mean. */
export function appendMemory(store: BlockStore, block: BlockName, text: string): { ok: boolean; text: string; tone: Tone } {
  const r = store.add(block, text);
  if (!r.ok) return { ok: false, tone: "warn", text: `memory: not saved to ${LABEL[block]} — ${r.reason ?? "edit failed"}` };
  return { ok: true, tone: "info", text: `memory: noted in ${LABEL[block]} (${r.current}/${r.limit} chars, ${store.path(block)}) — in the prompt from the next run` };
}

export interface MemoryNoteCtx {
  renderer: Pick<Renderer, "addUser" | "addSystemNote">;
  /** the ACTIVE block store, read live */
  blocks(): BlockStore;
}

/** Run one `#<text>` line: echo it, append to MEMORY, note the outcome. false = not a note line (nothing done). */
export function runMemoryNote(ctx: MemoryNoteCtx, line: string): boolean {
  const note = memoryNoteLine(line);
  if (note === null) return false;
  ctx.renderer.addUser(line.trim());
  const r = appendMemory(ctx.blocks(), "memory", note);
  ctx.renderer.addSystemNote(r.text, r.tone);
  return true;
}

/** the /memory hints under a block: an edit this run, a block withheld from the prompt, a block over its cap */
function blockHints(store: BlockStore, b: BlockName): string {
  const over = store.overCap(b);
  return (store.edited(b) ? "\n(edited this run — in the prompt from the next run)" : "")
    + (store.isWithheld(b) ? "\n(not in the prompt and not writable — it came with this repository; rovecode trust show)" : "")
    + (over ? `\n(over the ${over.cap}-char cap — the prompt shows the first ${over.cap}; trim the file)` : "");
}

/** `/memory` → both blocks as the store holds them NOW (live text, path, and a hint when an edit this run is not
 *  yet in the prompt); `/memory --user` → the USER block alone; `/memory <text>` appends to MEMORY and
 *  `/memory --user <text>` to USER (the same append path as `#<text>` and memory_edit add). */
export function memoryCommand(store: BlockStore, arg: string): { text: string; tone: Tone } {
  const a = arg.trim();
  const user = a === "--user" || a.startsWith("--user ");
  const text = user ? a.slice("--user".length).trim() : a;
  if (text) { const r = appendMemory(store, user ? "user" : "memory", text); return { text: r.text, tone: r.tone }; }
  const blocks: BlockName[] = user ? ["user"] : ["memory", "user"];
  const shown = blocks.map((b) => `# ${LABEL[b]} — ${store.path(b)}\n${store.liveText(b) || "(empty)"}${blockHints(store, b)}`);
  return { text: shown.join("\n\n"), tone: "info" };
}
