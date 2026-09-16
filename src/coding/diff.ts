/** Port #24 — bounded unified-diff preview for edit/write approvals.
 *
 *  The post-change content is computed IN MEMORY (edit: hashline's pure apply over the
 *  current file; write: the proposed content), diffed against the file with jsdiff
 *  (`diff`, BSD-3-Clause — see THIRD_PARTY_NOTICES.md), and rendered git-style, clipped
 *  to maxLines with an exact "… +N more lines" marker. Never throws: stale anchors,
 *  binary content, malformed args and I/O errors all come back as kind "unavailable"
 *  carrying the reason, so the approval overlay degrades instead of blocking the ask.
 *  Shape follows gemini-cli's confirmation diffs — structuredPatch with a small context
 *  (packages/core/src/tools/diffOptions.ts:10-18) and CR-tolerant line comparison
 *  (diff-utils.ts:22 splits on /\r?\n/; here jsdiff's stripTrailingCr). No code copied. */

import { existsSync, readFileSync } from "node:fs";
import { relative } from "node:path";
import { toolPath } from "../core/workspace.ts";
import { structuredPatch } from "diff";
import { applyEditsToContent, type EditFailure, type EditOp } from "./hashline.ts";

export type DiffKind = "modify" | "create" | "unchanged" | "unavailable";
export interface DiffPreview { text: string; truncated: boolean; kind: DiffKind }
export interface DiffPreviewOptions { maxLines?: number; context?: number }

/** default cap on rendered lines (headers + hunks); the TUI clips further to its rows */
export const DIFF_MAX_LINES = 40;
const DIFF_CONTEXT = 3;
/** git's buffer_is_binary heuristic: a NUL byte within the first 8000 bytes */
const BINARY_SNIFF = 8000;
/** Myers budget: a rewrite beyond this many edited lines is reported, not diffed (bounded CPU);
 *  the wall-clock cap is a safety net for huge files, the edit-length cap is the deterministic one */
const MAX_EDIT_LENGTH = 2000;
const MAX_DIFF_MS = 1000;
const MAX_CHARS = 4_000_000;

/** `… +N more lines` — the exact marker appended when the output is clipped. */
export function moreMarker(n: number): string { return `… +${n} more line${n === 1 ? "" : "s"}`; }

/** Keep the first `max` lines; the marker accounts for every hidden line. */
export function clipLines(lines: string[], max: number): string[] {
  return lines.length > max ? [...lines.slice(0, max), moreMarker(lines.length - max)] : lines;
}

/** the ladder's own spelling (core/workspace.ts toolPath): the preview names the file the tool will open */
function resolvePath(cwd: string, p: string): string { return toolPath(cwd, p); }

function hasNul(buf: Uint8Array): boolean {
  const n = Math.min(buf.length, BINARY_SNIFF);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

const unavailable = (reason: string): DiffPreview => ({ text: `diff unavailable: ${reason}`, truncated: false, kind: "unavailable" });

function failureReason(f: EditFailure): string {
  switch (f.kind) {
    case "tag-mismatch": return `stale read — file TAG is now ${f.actual}, the edit expects ${f.expected}`;
    case "hash-mismatch": return `stale anchor — line ${f.line} hash is ${f.actual}, the edit expects ${f.expected}; ${f.nearest}`;
    case "out-of-range": return `line ${f.line} out of range (file has ${f.lineCount} lines)`;
  }
}

/** The edit tool's args, validated (a malformed call yields "unavailable", never a throw). */
function editOps(args: Record<string, unknown>, path: string): EditOp[] | null {
  if (!Array.isArray(args.edits)) return null;
  const ops: EditOp[] = [];
  for (const e of args.edits as unknown[]) {
    const o = (typeof e === "object" && e !== null ? e : {}) as Record<string, unknown>;
    if (typeof o.tag !== "string" || typeof o.anchorHash !== "string" || typeof o.anchorLine !== "number") return null;
    if (!Array.isArray(o.newLines) || !o.newLines.every((l) => typeof l === "string")) return null;
    ops.push({ path, tag: o.tag, anchorLine: o.anchorLine, anchorHash: o.anchorHash, newLines: o.newLines as string[] });
  }
  return ops;
}

/** Content → signed display lines: CRLF-tolerant, trailing newline dropped, missing EOF newline noted. */
function signedLines(content: string, sign: "+" | "-"): string[] {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const eofNewline = lines[lines.length - 1] === "";
  if (eofNewline) lines.pop();
  const out = lines.map((l) => sign + l);
  if (!eofNewline && out.length > 0) out.push("\\ No newline at end of file");
  return out;
}

function renderUnified(rel: string, before: string | null, after: string, opts: DiffPreviewOptions): DiffPreview {
  const maxLines = opts.maxLines ?? DIFF_MAX_LINES;
  if (before === after) return { text: "", truncated: false, kind: "unchanged" };
  const body: string[] = [];
  let kind: DiffKind = "modify";
  if (before === null) {
    // new file: every line is an add — no Myers pass needed (nor its cost on big files)
    kind = "create";
    const adds = signedLines(after, "+");
    if (adds.length > 0) body.push(`@@ -0,0 +1,${adds.filter((l) => l[0] === "+").length} @@`, ...adds);
  } else {
    if (before.length + after.length > MAX_CHARS) return unavailable("file too large to preview");
    // stripTrailingCr: a CRLF file diffs by content, not by line ending (gemini-cli diff-utils.ts:22)
    const patch = structuredPatch(rel, rel, before, after, undefined, undefined,
      { context: opts.context ?? DIFF_CONTEXT, stripTrailingCr: true, maxEditLength: MAX_EDIT_LENGTH, timeout: MAX_DIFF_MS });
    if (patch === undefined) return unavailable(`change too large to preview (over ${MAX_EDIT_LENGTH} edited lines or ${MAX_DIFF_MS}ms)`);
    for (const h of patch.hunks) body.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`, ...h.lines);
    if (body.length === 0) return { text: "no content changes (line endings only)", truncated: false, kind: "unchanged" };
  }
  const lines = [`--- ${before === null ? "/dev/null" : `a/${rel}`}`, `+++ b/${rel}`, ...body];
  return { text: clipLines(lines, maxLines).join("\n"), truncated: lines.length > maxLines, kind };
}

/** Preview what an edit/write tool call would do to its file, as a bounded unified diff.
 *  `args` are the (revised) tool args exactly as the tool would receive them. */
export function previewDiff(tool: "edit" | "write", args: unknown, cwd: string, opts: DiffPreviewOptions = {}): DiffPreview {
  try {
    const a = (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>;
    if (typeof a.path !== "string" || a.path === "") return unavailable("missing path");
    const abs = resolvePath(cwd, a.path);
    const rel = relative(cwd, abs).replace(/\\/g, "/") || a.path;
    let before: string | null = null;
    if (existsSync(abs)) {
      const buf = readFileSync(abs);
      if (hasNul(buf)) return unavailable("binary file");
      before = buf.toString("utf8");
    }
    let after: string;
    if (tool === "write") {
      if (typeof a.content !== "string") return unavailable("missing content");
      after = a.content;
    } else {
      if (before === null) return unavailable(`file not found: ${abs}`);
      const ops = editOps(a, abs);
      if (ops === null) return unavailable("malformed edits");
      const r = applyEditsToContent(before, ops, abs);
      if (!r.ok) return unavailable(failureReason(r.failure));
      after = r.content;
    }
    if (after.includes("\0")) return unavailable("binary content");
    return renderUnified(rel, before, after, opts);
  } catch (e) {
    return unavailable(e instanceof Error ? e.message : String(e));
  }
}
