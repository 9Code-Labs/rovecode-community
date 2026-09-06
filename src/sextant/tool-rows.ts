/** Sextant tool rows (port #41): RunEvent tool name + args → the compact row's verb/label, the
 *  activity it drives and the code-panel target; tool output → the row's trailing detail. Ported
 *  from the user's sextant v0.4.0 app.js scenario verbs (read/edit/write/remove/run/search) — here
 *  derived from rovecode's real tools (coding/hashline.ts, coding/files.ts, tools/webfetch.ts, tools/task.ts). */

import { isAbsolute, relative } from "node:path";
import type { ActivityState } from "./types.ts";

export interface CallDesc {
  /** "read" | "edit" | "write" | "remove" | "run" | "search" | "fetch" | "task" | "other" */
  verb: string;
  label: string;
  /** cwd-relative posix path for file tools, else null */
  path: string | null;
  /** mark the file touched (diamond spinner) + open the tree to it */
  touch: boolean;
  state: ActivityState;
  activity: string;
  /** 1-based highlight range for the code panel (read window / edit anchors) */
  hl: [number, number] | null;
  add: number;
  del: number;
  cmd: string | null;
}

export interface CallEnd {
  detail?: string;
  add?: number;
  del?: number;
  /** bash: output lines (exit= header stripped) */
  runLines?: string[];
  /** bash: the `exit=N` header's code (absent when the output carries none) */
  exitCode?: number;
  /** glob/grep: result lines */
  searchLines?: string[];
}

const LABEL_MAX = 48;
const DETAIL_MAX = 80;
const SEARCH_LINES_MAX = 500;
const TEST_CMD = /\b(tests?|vitest|jest|pytest|mocha|spec)\b/i;

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined);

/** Surrogate-safe clip with an ellipsis (code points, one cell each). */
export function clipText(s: string, max: number): string {
  const cps = [...s];
  return cps.length <= max ? s : cps.slice(0, Math.max(0, max - 1)).join("") + "…";
}
/** First non-empty line, whitespace collapsed, clipped. */
export function firstLine(s: string, max = DETAIL_MAX): string {
  const line = s.split(/\r?\n/).find((l) => l.trim().length > 0) ?? "";
  return clipText(line.replace(/\s+/g, " ").trim(), max);
}
function lastLine(s: string, max = DETAIL_MAX): string {
  const lines = s.split(/\r?\n/).filter((l) => l.trim().length > 0);
  return clipText((lines[lines.length - 1] ?? "").replace(/\s+/g, " ").trim(), max);
}

/** cwd-relative posix path: absolute paths under cwd become relative, others stay absolute
 *  (posix separators either way — never a `..` escape, never derived across drives). */
export function relPath(cwd: string, p: string): string {
  if (!p) return "";
  let r = p;
  if (isAbsolute(p)) {
    const rel = relative(cwd, p);
    r = rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : p;
  } else if (WIN_ABS.test(p)) {
    // a drive-letter path on a POSIX host (a session replayed from Windows, a model that writes them):
    // node's path module does not know it is absolute, so relativize by prefix, case-insensitively
    const P = posixly(p), C = posixly(cwd).replace(/\/+$/, "");
    if (C && P.toLowerCase().startsWith(C.toLowerCase() + "/")) r = P.slice(C.length + 1);
  }
  return posixly(r).replace(/^\.\/+/, "");
}
const WIN_ABS = /^[A-Za-z]:[\\/]/;
const posixly = (s: string): string => s.replace(/\\/g, "/");
export const baseName = (p: string): string => p.slice(p.lastIndexOf("/") + 1) || p;

function hostOf(url: string): string {
  try { return new URL(url).host || clipText(url, LABEL_MAX); } catch { return clipText(url, LABEL_MAX) || "url"; }
}
const cmdHead = (cmd: string): string => clipText(cmd.replace(/\s+/g, " ").trim(), LABEL_MAX);

const file = (verb: string, cwd: string, a: Record<string, unknown>, state: ActivityState, word: string, extra: Partial<CallDesc> = {}): CallDesc => {
  const path = relPath(cwd, str(a.path));
  const base = baseName(path) || "file";
  return { verb, label: base, path: path || null, touch: true, state, activity: `${word} ${base}`, hl: null, add: 0, del: 0, cmd: null, ...extra };
};

/** What a starting tool call means for the surface. */
export function describeCall(tool: string, args: unknown, cwd: string): CallDesc {
  const a = rec(args);
  switch (tool) {
    case "read": {
      const off = num(a.offset), lim = num(a.limit);
      const hl: [number, number] | null = off !== undefined || lim !== undefined ? [off ?? 1, (off ?? 1) + (lim ?? 2000) - 1] : null;
      return file("read", cwd, a, "READING", "reading", { hl });
    }
    case "edit": {
      const edits = Array.isArray(a.edits) ? a.edits : [];
      let add = 0, lo = Infinity, hi = -Infinity;
      for (const e of edits) {
        const r = rec(e);
        const n = Array.isArray(r.newLines) ? r.newLines.length : 0;
        add += n;
        const line = num(r.anchorLine);
        if (line !== undefined) { lo = Math.min(lo, line); hi = Math.max(hi, line + Math.max(0, n - 1)); }
      }
      return file("edit", cwd, a, "EDITING", "editing", { add, del: edits.length, hl: lo <= hi ? [lo, hi] : null });
    }
    case "write": {
      const content = str(a.content);
      return file("write", cwd, a, "EDITING", "writing", { add: content ? content.split(/\r?\n/).length : 0 });
    }
    case "remove": case "rm": case "delete": case "unlink":
      return file("remove", cwd, a, "EDITING", "removing");
    case "bash": case "shell": case "run": {
      const cmd = str(a.command) || str(a.cmd);
      const head = cmdHead(cmd) || "command";
      const testing = TEST_CMD.test(cmd);
      return { verb: "run", label: head, path: null, touch: false, state: testing ? "TESTING" : "RUNNING", activity: testing ? "running tests" : `running ${head}`, hl: null, add: 0, del: 0, cmd };
    }
    case "glob": case "grep": {
      const q = clipText(str(a.pattern), LABEL_MAX) || tool;
      return { verb: "search", label: q, path: null, touch: false, state: "READING", activity: `searching ${q}`, hl: null, add: 0, del: 0, cmd: null };
    }
    case "ls": {
      const p = relPath(cwd, str(a.path)) || ".";
      return { verb: "other", label: p, path: null, touch: false, state: "READING", activity: `listing ${p}`, hl: null, add: 0, del: 0, cmd: null };
    }
    case "web_fetch": {
      const host = hostOf(str(a.url));
      return { verb: "fetch", label: host, path: null, touch: false, state: "READING", activity: `fetching ${host}`, hl: null, add: 0, del: 0, cmd: null };
    }
    case "task": {
      const label = clipText(str(a.label) || str(a.agent) || "task", LABEL_MAX);
      return { verb: "task", label, path: null, touch: false, state: "DELEGATING", activity: `delegating ${label}`, hl: null, add: 0, del: 0, cmd: null };
    }
    case "ask_user":
      return { verb: "other", label: clipText(firstLine(str(a.question), LABEL_MAX) || "question", LABEL_MAX), path: null, touch: false, state: "WAITING", activity: "waiting for you", hl: null, add: 0, del: 0, cmd: null };
    case "todo_write": case "todo_read":
      return { verb: "other", label: "todos", path: null, touch: false, state: "THINKING", activity: "planning", hl: null, add: 0, del: 0, cmd: null };
    default:
      return { verb: "other", label: clipText(tool, LABEL_MAX), path: null, touch: false, state: "RUNNING", activity: `running ${tool}`, hl: null, add: 0, del: 0, cmd: null };
  }
}

/** Lines of the read window from the footer `(showing lines X-Y of Z)`, else the anchored-line count. */
function readLineCount(output: string): number {
  const m = /\(showing lines (\d+)-(\d+) of (\d+)\)/.exec(output);
  if (m) { const a = Number(m[1]), b = Number(m[2]); return b >= a && a > 0 ? b - a + 1 : 0; }
  return output.split(/\r?\n/).filter((l) => /^\d+#/.test(l)).length;
}

/** a rejection's ` at <abs path>:<line>` locator (coding/hashline.ts describeEditFailure): the row's label
 *  already names the file and the locator alone can fill the 80-cell detail, so the reason and the
 *  "line N now reads …" tail take its place */
const dropLocator = (s: string): string => s.replace(/ at \S.*?:\d+(?=\s|$)/, "");

/** The row's trailing detail (and panel payloads) when a tool call ends. A command's output is
 *  parsed whether it passed or failed (a red test run is exactly when the run panel matters);
 *  every other failed call reports its first output line — a file tool's without the path locator. */
export function summarizeEnd(desc: Pick<CallDesc, "verb">, tool: string, ok: boolean, output: string): CallEnd {
  if (desc.verb === "run") {
    const m = /^exit=(-?\d+)\r?\n?/.exec(output);
    const text = m ? output.slice(m[0].length) : output;
    const lines = text.split(/\r?\n/);
    while (lines.length && lines[lines.length - 1]!.trim() === "") lines.pop();
    const last = lastLine(text);
    return { detail: last || (m ? `exit ${m[1]}` : ""), runLines: lines, ...(m ? { exitCode: Number(m[1]) } : {}) };
  }
  if (!ok) return { detail: firstLine(desc.verb === "edit" || desc.verb === "write" ? dropLocator(output) : output) };
  switch (desc.verb) {
    case "read": return { detail: `${readLineCount(output)} lines` };
    case "edit": return {};
    case "write": { const m = /\((\d+) bytes/.exec(output); return m ? { detail: `${m[1]} bytes` } : {}; }
    case "remove": return {};
    case "search": {
      const lines = output.split(/\r?\n/).filter((l) => l.trim().length > 0);
      const hits = lines.filter((l) => !l.startsWith("(")).length;
      return { detail: `${hits} ${tool === "glob" ? (hits === 1 ? "file" : "files") : (hits === 1 ? "match" : "matches")}`, searchLines: lines.slice(0, SEARCH_LINES_MAX) };
    }
    case "fetch": return { detail: `${output.length} chars` };
    default: return { detail: firstLine(output) };
  }
}
