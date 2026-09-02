/** Hashline-anchored edits (ADR-006): read emits path#TAG + N#hash|content;
 *  edit requires LINE#HASH anchors to match, applies in reverse order,
 *  failures return nearest-match diagnostics (aider did-you-mean). */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { Tool, ToolContext, ToolOutput } from "../core/types.ts";
import { getExecutor } from "../core/executor.ts";

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

export type EditFailure =
  | { kind: "tag-mismatch"; path: string; expected: string; actual: string }
  | { kind: "hash-mismatch"; path: string; line: number; expected: string; actual: string; nearest: string }
  | { kind: "out-of-range"; path: string; line: number; lineCount: number };

export type EditResult = { ok: true; newTag: string } | { ok: false; failure: EditFailure };

/** Applies edits reverse-order (later lines first) so earlier anchors stay valid (phi hashline.go). */
export function applyEdits(absPath: string, edits: EditOp[]): EditResult {
  if (!existsSync(absPath)) return { ok: false, failure: { kind: "out-of-range", path: absPath, line: 0, lineCount: 0 } };
  const content = readFileSync(absPath, "utf8");
  const tag = fileTag(content);
  const stale = edits.find((e) => e.tag !== tag);
  if (stale) return { ok: false, failure: { kind: "tag-mismatch", path: absPath, expected: stale.tag, actual: tag } };

  const lines = content.split("\n");
  const sorted = [...edits].sort((a, b) => b.anchorLine - a.anchorLine);
  for (const e of sorted) {
    if (e.anchorLine < 1 || e.anchorLine > lines.length) {
      return { ok: false, failure: { kind: "out-of-range", path: absPath, line: e.anchorLine, lineCount: lines.length } };
    }
    const actual = lineHash(lines[e.anchorLine - 1]!);
    if (actual !== e.anchorHash) {
      // nearest-match diagnostic (aider find_similar_lines): show the closest line by hash-distance of text
      const idx = lines.findIndex((l) => lineHash(l) === e.anchorHash);
      const nearest = idx >= 0
        ? `line ${idx + 1} currently holds that hash: ${lines[idx]!.slice(0, 80)}`
        : `no line matches; line ${e.anchorLine} is now: ${lines[e.anchorLine - 1]!.slice(0, 80)}`;
      return { ok: false, failure: { kind: "hash-mismatch", path: absPath, line: e.anchorLine, expected: e.anchorHash, actual, nearest } };
    }
    lines.splice(e.anchorLine - 1, 1, ...e.newLines);
  }
  const next = lines.join("\n");
  writeFileSync(absPath, next);
  return { ok: true, newTag: fileTag(next) };
}

// ---------- Tools ----------

function resolvePath(cwd: string, p: string): string { return isAbsolute(p) ? p : join(cwd, p); }

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
    const before = existsSync(p) ? readFileSync(p, "utf8") : "";
    const r = applyEdits(p, a.edits.map((e) => ({ ...e, path: p })));
    if (!r.ok) {
      const f = r.failure;
      const detail = f.kind === "tag-mismatch"
        ? `stale read: file TAG is now ${f.actual}, you read ${f.expected}. Re-read the file.`
        : f.kind === "hash-mismatch"
          ? `line ${f.line} hash is ${f.actual}, expected ${f.expected}. ${f.nearest}`
          : `line ${f.line} out of range (file has ${f.lineCount} lines)`;
      return Promise.resolve({ ok: false, output: `Edit rejected: ${detail}` });
    }
    // Lint-gate (SWE-agent revert+requery): if the edit introduced NEW lint errors,
    // revert to the pre-edit content and report them so the agent retries.
    if (editLinter) {
      const errorsBefore = editLinter(before, p);
      const errorsAfter = editLinter(readFileSync(p, "utf8"), p);
      const before2 = new Set(errorsBefore);
      const newErrors = errorsAfter.filter((e) => !before2.has(e));
      if (newErrors.length > 0) {
        writeFileSync(p, before);
        return Promise.resolve({
          ok: false,
          output: `Edit applied but lint failed — file reverted to original. New lint errors:\n${newErrors.join("\n")}\nFix these and retry the edit.`,
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
    writeFileSync(p, a.content);
    return Promise.resolve({ ok: true, output: `wrote ${p} (${a.content.length} bytes, TAG ${fileTag(a.content)})` });
  },
};

export const bashTool: Tool = {
  schema: {
    name: "bash",
    description: "Run a shell command in the workspace (cwd locked to the session cwd). One automatic retry on non-zero exit. Destructive system commands are refused by a best-effort blocklist — this is NOT a sandbox. Output truncated to 10k chars.",
    args: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
  },
  kind: "execute",
  sequential: true,
  async execute(args, ctx): Promise<ToolOutput> {
    const cmd = String((args as { command: string }).command);
    const denied = deniedCommand(cmd);
    if (denied) return { ok: false, output: denied };
    // port #10: shell execution goes through the Executor seam (direct/wsl/docker
    // rungs, probed not assumed). Direct rung is byte-compatible with the old
    // inline runOnce; a missing bash now returns exit=-1 instead of throwing.
    let r = await getExecutor().run(cmd, ctx.cwd, ctx.signal);
    // single self-contained retry — but NEVER after an abort (port #21): the kill
    // makes the exit non-zero, and a blind retry would respawn the cancelled
    // command as a detached subprocess that outlives the run
    if (r.code !== 0 && !ctx.signal.aborted) r = await getExecutor().run(cmd, ctx.cwd, ctx.signal);
    return { ok: r.code === 0, output: `exit=${r.code}\n${r.text}` };
  },
};

// ---------- Bash safety (best-effort blocklist, NOT a sandbox) ----------

/** Footgun guard on the raw command string. A determined agent bypasses it;
 *  real isolation belongs at the process/OS layer. */
const denyPatterns: RegExp[] = [
  /rm\s+(-[a-z]*\s+)*\/(\s|$)/,           // rm -rf /
  /rm\s+(-[a-z]*\s+)*\/\*/,               // rm -rf /*
  /rm\s+(-[a-z]*\s+)*(--no-preserve-root\s+)?\*(\s|$)/, // rm -rf *
  /:\(\)\s*\{/,                            // fork bomb body :(){ ...
  /\bmkfs(\.\w+)?\b/,
  /\b(shutdown|reboot|poweroff|halt)\b/,
  /(^|[;&|\s])(sudo\s+)?format\s+(\/|[c-z]:)/i,  // windows format
  /(^|[;&|\s])(sudo\s+)?del\s+\/[fqs]/i,         // windows del /f
  /(^|[;&|\s])(sudo\s+)?rd\s+\/[sq]/i,
  /(^|[;&|\s])(sudo\s+)?remove-item\s+-(rec|r|f|force)/i,
  /\bdd\s+[^|]*of=\/dev\/(sd|nvme|hd|disk)/,  // raw disk overwrite
  />\s*\/dev\/(sd|nvme|hd|disk)/,
  /\bsudo\b.*\b(rm|mkfs|dd|shutdown|reboot|halt|format)\b/, // sudo + destructive core
];

function deniedCommand(cmd: string): string | null {
  const hit = denyPatterns.find((re) => re.test(cmd));
  return hit
    ? `command refused by safety blocklist (matched ${hit.source}): this tool is not a sandbox; rephrase without destructive system commands`
    : null;
}

