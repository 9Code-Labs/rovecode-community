/** Hashline-anchored edits (ADR-006): read emits path#TAG + N#hash|content;
 *  edit requires LINE#HASH anchors to match, applies in reverse order,
 *  failures return nearest-match diagnostics (aider did-you-mean).
 *  Port #28: a rejected edit/write is an ACTIONABLE message (describeEditFailure) — expected vs
 *  what the file holds NOW (the anchor line's current text + hash, the lines whose hash IS the
 *  anchor), the line count for out-of-range, the missing directory for write — plus the remedy,
 *  bounded to MAX_EDIT_MESSAGE_CHARS with the remedy always surviving the clip. Pattern: aider
 *  @ 5dc9490 aider/coders/editblock_coder.py:84-124 (failed-block report → "Did you mean to match
 *  some of these actual lines", "The SEARCH section must exactly match…"); no code copied. */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { toolPath } from "../core/workspace.ts";
import type { Tool, ToolContext, ToolOutput } from "../core/types.ts";

/** FNV-1a over whitespace-stripped line → 3 base36 chars (phi hash.go). */
export function lineHash(line: string): string {
  const stripped = line.replace(/\s/g, "");
  let h = 0x811c9dc5;
  for (let i = 0; i < stripped.length; i++) {
    h ^= stripped.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36).padStart(3, "0").slice(-3);
}

/** 4-hex file TAG from content (phi hash.go). */
export function fileTag(content: string): string {
  return createHash("sha1").update(content).digest("hex").slice(0, 4);
}

export interface AnchoredFile { path: string; tag: string; lines: { n: number; hash: string; text: string }[] }

export function readAnchored(absPath: string): AnchoredFile {
  const content = readFileSync(absPath, "utf8");
  const lines = content.split("\n").map((text, i) => ({ n: i + 1, hash: lineHash(text), text }));
  return { path: absPath, tag: fileTag(content), lines };
}

export function renderAnchored(f: AnchoredFile): string {
  const header = `${f.path}#${f.tag}`;
  const body = f.lines.map((l) => `${l.n}#${l.hash}|${l.text}`).join("\n");
  return `${header}\n${body}`;
}

export interface EditOp {
  path: string;
  tag: string;                 // must match current fileTag, else stale-read rejection
  anchorLine: number;          // 1-based line the edit replaces
  anchorHash: string;          // must match lineHash at anchorLine
  newLines: string[];          // replacement content (empty = delete line)
}

/** lines listed as "carry your anchor's hash" in a hash-mismatch failure */
const MAX_ANCHOR_MATCHES = 3;

export type EditFailure =
  | { kind: "tag-mismatch"; path: string; expected: string; actual: string }
  /** text = the anchor line's CURRENT content (clipped); matches = line numbers whose hash is the anchor (≤ MAX_ANCHOR_MATCHES) */
  | { kind: "hash-mismatch"; path: string; line: number; expected: string; actual: string; nearest: string; text: string; matches: number[] }
  | { kind: "out-of-range"; path: string; line: number; lineCount: number };

export type EditResult = { ok: true; newTag: string } | { ok: false; failure: EditFailure };
export type ApplyResult = { ok: true; content: string; newTag: string } | { ok: false; failure: EditFailure };

/** Pure core of applyEdits over in-memory content: tag check, reverse-order anchored splices
 *  (later lines first so earlier anchors stay valid — phi hashline.go), nearest-match
 *  diagnostics. Port #24 previews the exact post-edit content through this without writing. */
export function applyEditsToContent(content: string, edits: EditOp[], path: string): ApplyResult {
  const tag = fileTag(content);
  const stale = edits.find((e) => e.tag !== tag);
  if (stale) return { ok: false, failure: { kind: "tag-mismatch", path, expected: stale.tag, actual: tag } };

  const lines = content.split("\n");
  const sorted = [...edits].sort((a, b) => b.anchorLine - a.anchorLine);
  for (const e of sorted) {
    if (e.anchorLine < 1 || e.anchorLine > lines.length) {
      return { ok: false, failure: { kind: "out-of-range", path, line: e.anchorLine, lineCount: lines.length } };
    }
    const text = lines[e.anchorLine - 1]!;
    const actual = lineHash(text);
    if (actual !== e.anchorHash) {
      // nearest-match diagnostic (aider find_similar_lines): the lines that DO carry the anchor's hash
      const matches: number[] = [];
      for (let i = 0; i < lines.length && matches.length < MAX_ANCHOR_MATCHES; i++) if (lineHash(lines[i]!) === e.anchorHash) matches.push(i + 1);
      const nearest = matches.length > 0
        ? `line ${matches[0]} currently holds that hash: ${lines[matches[0]! - 1]!.slice(0, 80)}`
        : `no line matches; line ${e.anchorLine} is now: ${text.slice(0, 80)}`;
      return { ok: false, failure: { kind: "hash-mismatch", path, line: e.anchorLine, expected: e.anchorHash, actual, nearest, text: text.slice(0, 80), matches } };
    }
    lines.splice(e.anchorLine - 1, 1, ...e.newLines);
  }
  const next = lines.join("\n");
  return { ok: true, content: next, newTag: fileTag(next) };
}

/** Applies edits to the file on disk (applyEditsToContent + write); a missing file is out-of-range. */
export function applyEdits(absPath: string, edits: EditOp[]): EditResult {
  if (!existsSync(absPath)) return { ok: false, failure: { kind: "out-of-range", path: absPath, line: 0, lineCount: 0 } };
  const r = applyEditsToContent(readFileSync(absPath, "utf8"), edits, absPath);
  if (!r.ok) return r;
  writeFileSync(absPath, r.content);
  return { ok: true, newTag: r.newTag };
}

// ---------- port #28: actionable failure text ----------

/** hard bound on every rejection message the model sees (the remedy is never the part clipped) */
export const MAX_EDIT_MESSAGE_CHARS = 600;
const EDIT_REMEDY = "Remedy: re-read the file with `read` to get fresh line hashes, then retry the edit.";
/** lint errors listed in a lint-gate rejection before "… and N more" */
const MAX_LINT_LINES = 8;

/** What went wrong, what the file holds NOW, and what to do — aider's failed-block report shape
 *  (editblock_coder.py:84-124: the failing block, "Did you mean to match some of these actual
 *  lines", the exact-match rule) for hashline anchors. Detail is clipped first; the remedy survives. */
export function describeEditFailure(f: EditFailure): string {
  const head = "Edit rejected: ";
  const room = MAX_EDIT_MESSAGE_CHARS - head.length - EDIT_REMEDY.length - 1;
  return `${head}${clip(editFailureDetail(f), room)} ${EDIT_REMEDY}`;
}

function editFailureDetail(f: EditFailure): string {
  switch (f.kind) {
    case "tag-mismatch":
      return `stale read — ${f.path} changed since you read it (file TAG is now ${f.actual}, your edit carries ${f.expected}).`;
    case "hash-mismatch": {
      const where = f.matches.length > 0
        ? `Lines whose hash matches your anchor: ${f.matches.join(", ")} — did you mean one of those?`
        : "No line in the file has that hash now — the content changed since your read.";
      return `anchor mismatch at ${f.path}:${f.line} — line ${f.line} now reads ${JSON.stringify(f.text)} (hash ${f.actual}), your anchor expected hash ${f.expected}. ${where}`;
    }
    case "out-of-range":
      return `line ${f.line} is out of range — ${f.path} has ${f.lineCount} lines (valid anchors: 1-${f.lineCount}).`;
  }
}

function clip(s: string, max: number): string { return s.length <= max ? s : s.slice(0, Math.max(0, max - 1)) + "…"; }

// ---------- Tools ----------

/** the ladder's own spelling (core/workspace.ts toolPath): `..` collapses lexically BEFORE the open, never through a symlink */
function resolvePath(cwd: string, p: string): string { return toolPath(cwd, p); }

/** Windowed anchored read: keep absolute line numbers, note the slice bounds. */
function renderWindow(f: AnchoredFile, offset: number, limit: number): string {
  const total = f.lines.length;
  const start = Math.max(1, Math.floor(offset));
  if (start > total) return `${f.path}#${f.tag}\n(showing lines 0-0 of ${total}; offset ${start} is past EOF)`;
  const end = Math.min(total, start + Math.floor(limit) - 1);
  const slice = f.lines.slice(start - 1, end);
  return renderAnchored({ ...f, lines: slice }).replace(/\n$/, "") + `\n(showing lines ${start}-${end} of ${total})`;
}



export const readTool: Tool = {
  schema: {
    name: "read",
    description: "Read a file window. Output is `path#TAG` header plus `N#hash|content` lines; use hashes for edit anchors. Defaults: offset 1, limit 2000 lines. Footer notes `showing lines X-Y of Z`; if Y < Z pass a larger offset to see more.",
    args: {
      type: "object",
      properties: {
        path: { type: "string" },
        offset: { type: "integer", description: "first line to show (1-based, default 1)" },
        limit: { type: "integer", description: "max lines to show (default 2000)" },
      },
      required: ["path"],
    },
  },
  kind: "read",
  sequential: false,
  execute(args, ctx): Promise<ToolOutput> {
    const a = args as { path: string; offset?: number; limit?: number };
    const p = resolvePath(ctx.cwd, a.path);
    if (!existsSync(p)) return Promise.resolve({ ok: false, output: `file not found: ${p}` });
    const offset = Number.isFinite(a.offset) && a.offset! > 0 ? Math.floor(a.offset!) : 1;
    const limit = Number.isFinite(a.limit) && a.limit! > 0 ? Math.floor(a.limit!) : 2000;
    return Promise.resolve({ ok: true, output: renderWindow(readAnchored(p), offset, limit) });
  },
};

// ---------- Edit lint-gate ----------

export type EditLinter = (content: string, path: string) => string[];

let editLinter: EditLinter | undefined;

/** Install a linter (e.g. `tsc --noEmit` or biome) consulted after every applied edit.
 *  When set, an edit that introduces NEW lint errors is reverted and reported. */
export function setEditLinter(fn: EditLinter | undefined): void { editLinter = fn; }

export const editTool: Tool = {
  schema: {
    name: "edit",
    description: "Anchored edit. Each op replaces the line at anchorLine (whose hash must equal anchorHash) with newLines. tag must match the TAG from your last read.",
    args: {
      type: "object",
      properties: {
        path: { type: "string" },
        edits: {
          type: "array",
          items: {
            type: "object",
            properties: {
              tag: { type: "string" }, anchorLine: { type: "integer" },
              anchorHash: { type: "string" }, newLines: { type: "array", items: { type: "string" } },
            },
            required: ["tag", "anchorLine", "anchorHash", "newLines"],
          },
        },
      },
      required: ["path", "edits"],
    },
  },
  kind: "write",
  sequential: true,
  execute(args, ctx): Promise<ToolOutput> {
    const a = args as { path: string; edits: EditOp[] };
    const p = resolvePath(ctx.cwd, a.path);
    if (!existsSync(p)) {
      // port #28: a missing file used to surface as "line 0 out of range (file has 0 lines)"
      return Promise.resolve({ ok: false, output: clip(`Edit rejected: file not found: ${p} — check the path (relative paths resolve against ${ctx.cwd}) or create the file with \`write\`.`, MAX_EDIT_MESSAGE_CHARS) });
    }
    const before = readFileSync(p, "utf8");
    const r = applyEdits(p, a.edits.map((e) => ({ ...e, path: p })));
    if (!r.ok) return Promise.resolve({ ok: false, output: describeEditFailure(r.failure) });
    // Lint-gate (SWE-agent revert+requery): if the edit introduced NEW lint errors,
    // revert to the pre-edit content and report them so the agent retries.
    if (editLinter) {
      const errorsBefore = editLinter(before, p);
      const errorsAfter = editLinter(readFileSync(p, "utf8"), p);
      const before2 = new Set(errorsBefore);
      const newErrors = errorsAfter.filter((e) => !before2.has(e));
      if (newErrors.length > 0) {
        writeFileSync(p, before);
        const shown = newErrors.slice(0, MAX_LINT_LINES).join("\n") + (newErrors.length > MAX_LINT_LINES ? `\n… and ${newErrors.length - MAX_LINT_LINES} more` : "");
        return Promise.resolve({
          ok: false,
          output: `Edit applied but lint failed — file reverted to original. New lint errors:\n${shown}\nFix these and retry the edit.`,
        });
      }
    }
    return Promise.resolve({ ok: true, output: `applied ${a.edits.length} edit(s); new TAG ${r.newTag}` });
  },
};

export const writeTool: Tool = {
  schema: {
    name: "write",
    description: "Create or overwrite a file with content.",
    args: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
  },
  kind: "write",
  sequential: true,
  execute(args, ctx): Promise<ToolOutput> {
    const a = args as { path: string; content: string };
    const p = resolvePath(ctx.cwd, a.path);
    const dir = dirname(p);
    if (!existsSync(dir)) {
      // port #28: say WHY instead of leaking the raw ENOENT — the fix is a mkdir, not a different path
      return Promise.resolve({ ok: false, output: clip(`Write rejected: directory ${dir} does not exist — create it first (bash: mkdir -p ${JSON.stringify(dir)}) or write into an existing directory.`, MAX_EDIT_MESSAGE_CHARS) });
    }
    writeFileSync(p, a.content);
    return Promise.resolve({ ok: true, output: `wrote ${p} (${a.content.length} bytes, TAG ${fileTag(a.content)})` });
  },
};

// port #55: the bash tool moved to coding/bash.ts when it grew a timeout and a background flag — this
// file is about ANCHORED EDITS (the phi hashline port) and shell execution had drifted into the end of
// it. Re-exported here because ten files import `bashTool` from this path and a move that changes no
// import is a move nobody has to review twice.
export { bashTool, deniedCommand } from "./bash.ts";
