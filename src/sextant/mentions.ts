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
 *  way to spend a context window without knowing.
 *
 *  Three widenings (2026-09-07), each because the promise was narrower than the words: `@~/notes.md` and an
 *  ABSOLUTE mention name a file outright and are attached wherever they point (the person typed the whole path —
 *  that IS the choice; a RELATIVE mention still has to land in the workspace); a relative mention that resolves
 *  nowhere under cwd is tried against the `--add-dir` roots, without which a file in an added root could not be
 *  mentioned at all; and an IMAGE mention takes the /attach seam so it reaches the model as an image part instead
 *  of being refused as "a binary file". The token class carries `~`, `:` and `\` for the first of those, which is
 *  what lets `@C:\Users\me\notes.md` tokenize on Windows — the cost is that a prose `@foo:bar` is read as a path
 *  and reported as not found, which is a note, not a loss. */

import { existsSync, openSync, closeSync, readSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve, sep } from "node:path";
import { sniffImageMime } from "../core/images.ts";
import { fileTag, lineHash, readAnchored, renderAnchored, type AnchoredFile } from "../coding/hashline.ts";

/** `@path` tokens in free text: at the start or after whitespace, so `me@example.com` is not one. The one
 *  regex both surfaces and overlays.ts parseInput read — this module imports nothing from the sextant, so the
 *  classic renderer can use it without loading the cockpit's module graph. */
export const MENTION_RE = /(?:^|\s)@([\w./\\:~-]+)/g;
/** the mentions of a typed line — none for a `/command` or a `!shell` line, which are never expanded */
export function mentionsIn(text: string): string[] {
  const t = text.trim();
  if (t[0] === "/" || t[0] === "!") return [];
  return [...t.matchAll(MENTION_RE)].map((m) => m[1]!);
}

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
  /** a mention → the cwd-relative posix path it names, or null. The sextant ranks over its scanned file list
   *  (overlays.ts resolveFile: exact, unique basename, fuzzy); the classic renderer, which has no list, takes
   *  the exact path only — what its own `@` autocomplete inserts. */
  resolve: (mention: string) => string | null;
  /** already parsed mentions (default: mentionsIn(text)) */
  mentions?: readonly string[];
  /** `--add-dir` roots (core/workspace.ts): a RELATIVE mention that resolves nowhere under cwd is tried against
   *  each of these in order, so a file in an added root can be mentioned at all. cwd always wins a tie. */
  roots?: readonly string[];
  /** an image mention takes the /attach seam instead of being refused as binary — it reaches the model as an
   *  image part, and costs nothing against the text budget. Without this the old "binary file" refusal stands. */
  attachImage?: (abs: string) => void;
  /** seams for tests */
  stat?: (abs: string) => { isFile(): boolean; size: number };
  read?: (abs: string) => string;
  exists?: (abs: string) => boolean;
}

/** Where a mention points, and by what right. `~`/`~/x` and an ABSOLUTE mention are the person naming a file
 *  outright — that is the choice, so they are allowed wherever they point; a RELATIVE mention must land inside the
 *  cwd or one of the `--add-dir` roots, which is the containment rule the workspace already enforces everywhere
 *  else. `label` is what the notes and the attached header show. */
export function locateMention(m: string, opts: ExpandOptions): { abs: string; label: string; root?: string } | null {
  const exists = opts.exists ?? existsSync;
  if (m === "~" || m.startsWith("~/") || m.startsWith("~\\")) { const abs = resolve(homedir(), m.slice(2)); return { abs, label: m }; }
  if (isAbsolute(m)) return { abs: resolve(m), label: m };
  const rel = opts.resolve(m);
  if (rel !== null) return { abs: resolve(opts.cwd, rel), label: rel };
  for (const root of opts.roots ?? []) {
    const abs = resolve(root, m);
    if ((abs === resolve(root) || abs.startsWith(resolve(root) + sep)) && exists(abs)) return { abs, label: m, root };
  }
  return null;
}

const BINARY_PROBE = 8 * 1024;

/** the file's image MIME by magic bytes (core/images.ts), reading only the first bytes — an image mention must not
 *  pull a 4 MB photo into memory just to learn it is a photo. null when it is not an image we accept. */
function sniffImage(abs: string, opts: ExpandOptions): string | null {
  try {
    if (opts.read) { const head = Buffer.from(opts.read(abs).slice(0, 32), "binary"); return sniffImageMime(head) ?? null; }
    const fd = openSync(abs, "r");
    try { const buf = Buffer.alloc(32); const n = readSync(fd, buf, 0, 32, 0); return sniffImageMime(buf.subarray(0, n)) ?? null; }
    finally { closeSync(fd); }
  } catch { return null; }
}

/** Expand every `@mention` in a typed line. Pure apart from the reads; never throws — a file that cannot be
 *  read becomes a note and the message goes out without it. */
export function expandMentions(text: string, opts: ExpandOptions): MentionExpansion {
  const mentions = [...new Set(opts.mentions ?? mentionsIn(text))];
  const notes: string[] = [];
  const attached: AttachedFile[] = [];
  const blocks: string[] = [];
  if (mentions.length === 0) return { text, attached, notes };
  const root = resolve(opts.cwd);
  const stat = opts.stat ?? ((p: string) => statSync(p));
  let budget = MENTION_MAX_CHARS;
  for (const m of mentions) {
    if (attached.length >= MENTION_MAX_FILES) { notes.push(`@${m}: not attached — ${MENTION_MAX_FILES} files per message is the cap; ask me to read it`); continue; }
    const found = locateMention(m, opts);
    if (found === null) { notes.push(`@${m}: no file in the workspace matches`); continue; }
    const { abs } = found;
    const rel = found.label;
    // a relative mention resolved through the workspace list stays inside it; `~`/absolute and the added roots
    // carry their own right (locateMention), so only the cwd-relative case is re-checked here
    if (found.root === undefined && !isAbsolute(m) && !m.startsWith("~") && abs !== root && !abs.startsWith(root + sep)) { notes.push(`@${rel}: outside the workspace — not attached`); continue; }
    let st: { isFile(): boolean; size: number };
    try { st = stat(abs); } catch { notes.push(`@${rel}: cannot be read — not attached`); continue; }
    if (!st.isFile()) { notes.push(`@${rel}: a directory — name a file in it`); continue; }
    // an IMAGE takes the /attach seam BEFORE the size and budget checks: it reaches the model as an image part
    // and spends none of the text budget, so refusing it as "binary" was the wrong answer to the right question
    if (opts.attachImage) {
      const mime = sniffImage(abs, opts);
      if (mime !== null) {
        opts.attachImage(abs);
        notes.push(`@${rel}: attached as an image (${mime})${found.root ? ` (from ${found.root})` : ""}`);
        continue;
      }
    }
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
