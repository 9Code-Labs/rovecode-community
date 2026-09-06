/** `@file` mentions, made true. overlays.ts has parsed `@path` into `mentions[]` (with a fuzzy resolveFile) since
 *  the port, and the input footer promised "@ mentions attach files" — but nothing ever read `.mentions`, so the
 *  promise did nothing. This module is the consumer: on submit, each mention that resolves to a workspace file is
 *  appended to the message exactly as the `read` tool would return it (hashline `path#TAG` header, `N#hash|text`
 *  lines), so the model has the contents — and valid edit anchors — without spending a tool round-trip.
 *
 *  Why here and not in tui/commands.ts: that file's note ("no `!shell` / `@file` injection … the template reaches
 *  the model as plain text") is about CUSTOM COMMAND TEMPLATES — files a repo or a plugin ships, where injecting
 *  files or shell output from a template is a way for a project to read the user's disk. That reason stands and
 *  is untouched. A `@file` the human types into their own prompt is the human choosing to show a file; the only
 *  risk is cost, so the caps below exist and every cap is SAID, in the message and as a toast.
 *
 *  What is refused, and said: a mention no workspace file matches; a directory; a file outside the workspace
 *  (resolveFile only knows the scanned list, and the absolute path is checked against cwd again); a binary; a
 *  file past MAX_BYTES. What is capped, and said: lines per file (MAX_LINES — the footer names the offset that
 *  continues), files per message (MAX_FILES), characters per message (MAX_CHARS). Never silent: `@` must not be a
 *  way to spend a context window without knowing. */

import { readFileSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import { fileTag, lineHash, readAnchored, renderAnchored, type AnchoredFile } from "../coding/hashline.ts";
import { parseInput, resolveFile, type Fuzzy } from "./overlays.ts";

/** the most lines one mention contributes — the rest is one `read` with an offset away */
export const MENTION_MAX_LINES = 400;
/** mentions expanded per message; the rest are named and left for the model to read */
export const MENTION_MAX_FILES = 8;
/** characters all expansions together may add to one message (~15k tokens) */
export const MENTION_MAX_CHARS = 60_000;
/** a file larger than this is not read at all — name it, let the model ask for a window */
export const MENTION_MAX_BYTES = 2 * 1024 * 1024;
/** with less than this left of the character budget, a further file is named rather than squeezed to a
 *  line or two — a three-line fragment of a file is worse context than "read it yourself" */
export const MENTION_MIN_BLOCK = 500;

/** the line that opens the attached section — what userRow cuts the transcript at */
export const MENTION_FRAME = "(files attached by @mention — each block is what `read` returns for the file; its edit anchors are valid)";
/** one per attached file, right above its read block: `[@src/x.ts — attached: 120 lines]` */
export const MENTION_HEAD = /^\[@(\S+) — attached: (\d+)(?: of (\d+))? lines(, capped[^\]]*)?\]$/;

export interface AttachedFile { path: string; shown: number; total: number; capped: boolean }
export interface MentionExpansion {
  /** the message as submitted: the typed text, then the attached section (unchanged when nothing attached) */
  text: string;
  attached: AttachedFile[];
  /** what was refused or capped, one sentence each — the renderer toasts them */
  notes: string[];
}

export interface ExpandOptions {
  cwd: string;
  /** the workspace file list (SextantState.files.paths — cwd-relative, posix) that resolveFile ranks over */
  paths: readonly string[];
  /** already parsed mentions (default: parseInput(text).mentions) */
  mentions?: readonly string[];
  fz?: Fuzzy;
  /** seams for tests */
  stat?: (abs: string) => { isFile(): boolean; size: number };
  read?: (abs: string) => string;
}

const BINARY_PROBE = 8 * 1024;

/** Expand every `@mention` in a typed line. Pure apart from the reads; never throws — a file that cannot be
 *  read becomes a note and the message goes out without it. */
export function expandMentions(text: string, opts: ExpandOptions): MentionExpansion {
  const mentions = [...new Set(opts.mentions ?? parseInput(text).mentions)];
  const notes: string[] = [];
  const attached: AttachedFile[] = [];
  const blocks: string[] = [];
  if (mentions.length === 0) return { text, attached, notes };
  const root = resolve(opts.cwd);
  const stat = opts.stat ?? ((p: string) => statSync(p));
  let budget = MENTION_MAX_CHARS;
  for (const m of mentions) {
    if (attached.length >= MENTION_MAX_FILES) { notes.push(`@${m}: not attached — ${MENTION_MAX_FILES} files per message is the cap; ask me to read it`); continue; }
    const rel = resolveFile(m, opts.paths, opts.fz);
    if (rel === null) { notes.push(`@${m}: no file in the workspace matches`); continue; }
    const abs = resolve(root, rel);
    if (abs !== root && !abs.startsWith(root + sep)) { notes.push(`@${rel}: outside the workspace — not attached`); continue; }
    let st: { isFile(): boolean; size: number };
    try { st = stat(abs); } catch { notes.push(`@${rel}: cannot be read — not attached`); continue; }
    if (!st.isFile()) { notes.push(`@${rel}: a directory — name a file in it`); continue; }
    if (st.size > MENTION_MAX_BYTES) { notes.push(`@${rel}: ${(st.size / 1048576).toFixed(1)} MB is too large to attach — ask me to read a window of it`); continue; }
    let content: string;
    try { content = opts.read ? opts.read(abs) : readFileSync(abs, "utf8"); }
    catch { notes.push(`@${rel}: cannot be read — not attached`); continue; }
    if (content.slice(0, BINARY_PROBE).includes("\0")) { notes.push(`@${rel}: a binary file — not attached`); continue; }
    if (budget < MENTION_MIN_BLOCK) { notes.push(`@${rel}: not attached — this message already carries ${MENTION_MAX_CHARS.toLocaleString()} characters of files; ask me to read it`); continue; }
    const file = opts.read ? anchoredFrom(abs, content) : readAnchored(abs);
    const total = file.lines.length;
    // the line cap first, then the character budget: whichever is hit, the footer says where to continue
    let shown = Math.min(total, MENTION_MAX_LINES);
    let body = renderAnchored({ ...file, lines: file.lines.slice(0, shown) }).replace(/\n$/, "");
    while (body.length > budget && shown > 1) {
      shown = Math.max(1, Math.floor(shown * budget / body.length));
      body = renderAnchored({ ...file, lines: file.lines.slice(0, shown) }).replace(/\n$/, "");
    }
    const capped = shown < total;
    budget -= body.length;
    const head = capped
      ? `[@${rel} — attached: ${shown} of ${total} lines, capped: read it with offset ${shown + 1} for the rest]`
      : `[@${rel} — attached: ${total} lines]`;
    blocks.push(`${head}\n${body}\n(showing lines ${total === 0 ? 0 : 1}-${shown} of ${total})`);
    attached.push({ path: rel, shown, total, capped });
    if (capped) notes.push(`@${rel}: ${total} lines — attached the first ${shown}; the rest is a read away`);
  }
  if (blocks.length === 0) return { text, attached, notes };
  return { text: `${text.trimEnd()}\n\n${MENTION_FRAME}\n\n${blocks.join("\n\n")}`, attached, notes };
}

/** an AnchoredFile from content already in hand (the `read` seam), split and hashed exactly as readAnchored does —
 *  including the empty last line a trailing newline yields, so the counts match what the read tool reports */
function anchoredFrom(abs: string, content: string): AnchoredFile {
  return { path: abs, tag: fileTag(content), lines: content.split("\n").map((t, i) => ({ n: i + 1, hash: lineHash(t), text: t })) };
}

/** The transcript's view of a submitted line: the typed text, and one chip per attached file — never the file
 *  bodies, which would flood the messages panel (they are in the session, where the model reads them). */
export function splitAttached(text: string): { text: string; files: string[] } {
  const lines = text.split("\n");
  const at = lines.indexOf(MENTION_FRAME);
  if (at < 0) return { text, files: [] };
  const files: string[] = [];
  for (const l of lines.slice(at + 1)) {
    const m = MENTION_HEAD.exec(l);
    if (m) files.push(m[3] !== undefined ? `${m[1]} · ${m[2]}/${m[3]} lines, capped` : `${m[1]} · ${m[2]} lines`);
  }
  return { text: lines.slice(0, at).join("\n").trimEnd(), files };
}
