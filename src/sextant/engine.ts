/** ported from the user's sextant v0.4.0 prototype, src/engine.js (+ wrap() from app.js lines 66-78) */
/* Pure helpers for the panels: syntax tokenizer, diff hunks/line marks over jsdiff output, fuzzy
   match, word wrap, small formatters. The prototype's O(n·m) LCS diffLines() is NOT ported —
   jsdiff (Myers, already a dependency) produces the ops, which then feed the same hunk/mark code. */

import { diffLines, type ChangeObject, type StructuredPatch } from "diff";
import type { DiffHunk } from "./types.ts";

export type Lang = "ts" | "json" | "md" | "text";
export const LANG_NAME: Readonly<Record<Lang, string>> = { ts: "TypeScript", json: "JSON", md: "Markdown", text: "Plain Text" };

/** split on \n, dropping the empty tail a trailing newline leaves */
export const splitLines = (s: string): string[] => { const l = s.split("\n"); if (l.length && l[l.length - 1] === "") l.pop(); return l; };
export const basename = (p: string): string => p.slice(p.lastIndexOf("/") + 1);
export const dirname = (p: string): string => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

/** language by extension; the TS tokenizer serves the whole JS/TS family (the prototype knew .ts/.tsx only) */
export function langOf(p: string): Lang {
  if (/\.[cm]?[jt]sx?$/.test(p)) return "ts";
  if (/\.jsonc?$/.test(p)) return "json";
  if (/\.(md|markdown)$/.test(p)) return "md";
  return "text";
}

/* ------------------------------------------------------------ tokenizer */

export type TokenClass = "kw" | "str" | "num" | "cm" | "fn" | "ty" | "pu" | "op" | "prop" | "id" | "key" | "dec" | "plain";
export type Token = [string, TokenClass];

const KW = new Set("import export from const let var function return if else async await new type interface extends implements class throw try catch finally for while of in as default void typeof instanceof null undefined true false this readonly declare satisfies keyof enum switch case break continue do yield static private public protected".split(" "));
const TS_RE = /(\/\/.*)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b\d[\d_]*(?:\.\d+)?\b)|(@?[A-Za-z_$][\w$]*)|([{}()[\]])|([;,.:])|(=>|\?\?|\?\.|[<>=!+\-*/%&|^~?]+)/g;

/** one source line → [text, class] runs; "text" is one plain run, "md" goes through tokenizeMd */
export function tokenize(line: string, lang: string): Token[] {
  if (lang === "md") return tokenizeMd(line);
  if (lang === "text") return [[line, "plain"]];
  const out: Token[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  TS_RE.lastIndex = 0;
  while ((m = TS_RE.exec(line))) {
    if (m.index > last) out.push([line.slice(last, m.index), "plain"]);
    const tok = m[0];
    let cls: TokenClass;
    if (m[1]) cls = "cm";
    else if (m[2]) cls = lang === "json" && /^\s*:/.test(line.slice(m.index + tok.length)) ? "key" : "str";
    else if (m[3]) cls = "num";
    else if (m[4]) {
      const before = line[m.index - 1];
      const after = line.slice(m.index + tok.length);
      if (tok[0] === "@") cls = "dec";
      else if (KW.has(tok)) cls = "kw";
      else if (before === ".") cls = "prop";
      else if (/^\s*\(/.test(after) || (/^</.test(after) && /^[a-z]/.test(tok))) cls = "fn";
      else if (/^[A-Z]/.test(tok)) cls = "ty";
      else if (/^\??:/.test(after)) cls = "prop";
      else cls = "id";
    } else if (m[5] || m[6]) cls = "pu";
    else cls = "op";
    out.push([tok, cls]);
    last = m.index + tok.length;
  }
  if (last < line.length) out.push([line.slice(last), "plain"]);
  return out;
}

export function tokenizeMd(line: string): Token[] {
  if (/^#{1,6}\s/.test(line)) return [[line, "kw"]];
  if (/^\s{4}/.test(line)) return [[line, "str"]];
  const out: Token[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  const re = /`[^`]+`/g;
  while ((m = re.exec(line))) {
    if (m.index > last) out.push([line.slice(last, m.index), "plain"]);
    out.push([m[0], "str"]);
    last = m.index + m[0].length;
  }
  if (last < line.length) out.push([line.slice(last), "plain"]);
  return out;
}

/* ------------------------------------------------------------ diff */

export type OpKind = "eq" | "del" | "ins";
/** one diff line; an/bn are the 1-based old/new line numbers (absent on the side the line is not on) */
export interface DiffOp { t: OpKind; text: string; an?: number; bn?: number }
/** a run of ops with its @@ header numbers: old start/count, new start/count */
export interface Hunk { ops: DiffOp[]; as: number; bs: number; ac: number; bc: number }
export type LineMark = "added" | "changed";

/** jsdiff diffLines() change objects → the prototype's op list with line numbers */
export function opsFromChanges(changes: readonly ChangeObject<string>[]): DiffOp[] {
  const ops: DiffOp[] = [];
  let an = 0, bn = 0;
  for (const c of changes) {
    const lines = c.value.split("\n");
    if (lines.length > c.count) lines.pop(); // the value ends with its last line's newline
    for (const text of lines) {
      if (c.added) ops.push({ t: "ins", text, bn: ++bn });
      else if (c.removed) ops.push({ t: "del", text, an: ++an });
      else ops.push({ t: "eq", text, an: ++an, bn: ++bn });
    }
  }
  return ops;
}

/** line-diff two texts (jsdiff Myers) → ops; replaces the prototype's O(n·m) LCS table */
export function diffOps(a: string, b: string): DiffOp[] {
  return opsFromChanges(diffLines(a, b));
}

/** added/deleted line counts */
export const opStats = (ops: readonly DiffOp[]): { a: number; d: number } => {
  let a = 0, d = 0;
  for (const o of ops) { if (o.t === "ins") a++; else if (o.t === "del") d++; }
  return { a, d };
};

function hunkOf(ops: readonly DiffOp[], s: number, e: number): Hunk {
  const slice = ops.slice(s, e);
  let as: number | null = null, bs: number | null = null, ac = 0, bc = 0;
  for (const o of slice) {
    if (o.an) { if (as == null) as = o.an; ac++; }
    if (o.bn) { if (bs == null) bs = o.bn; bc++; }
  }
  return { ops: slice, as: as ?? 0, bs: bs ?? 0, ac, bc };
}

/** group changes into hunks with `ctx` context lines; changes closer than 2·ctx share a hunk; Infinity = one hunk */
export function buildHunks(ops: readonly DiffOp[], ctx: number): Hunk[] {
  if (!isFinite(ctx)) return ops.length ? [hunkOf(ops, 0, ops.length)] : [];
  const hunks: Hunk[] = [];
  let i = 0;
  while (i < ops.length) {
    if (ops[i]!.t === "eq") { i++; continue; }
    const start = Math.max(0, i - ctx);
    let end = i + 1, j = i + 1;
    while (j < ops.length) {
      if (ops[j]!.t !== "eq") { end = j + 1; j++; continue; }
      let k = j;
      while (k < ops.length && ops[k]!.t === "eq") k++;
      if (k < ops.length && k - j <= ctx * 2) { j = k; continue; }
      break;
    }
    end = Math.min(ops.length, end + ctx);
    hunks.push(hunkOf(ops, start, end));
    i = end;
  }
  return hunks;
}

/** new-line-number → "added" (pure insertion) | "changed" (insertion next to a deletion) */
export function lineMarks(ops: readonly DiffOp[]): Map<number, LineMark> {
  const marks = new Map<number, LineMark>();
  let i = 0;
  while (i < ops.length) {
    if (ops[i]!.t === "eq") { i++; continue; }
    let j = i, hasDel = false;
    while (j < ops.length && ops[j]!.t !== "eq") { if (ops[j]!.t === "del") hasDel = true; j++; }
    for (let k = i; k < j; k++) { const o = ops[k]!; if (o.t === "ins" && o.bn) marks.set(o.bn, hasDel ? "changed" : "added"); }
    i = j;
  }
  return marks;
}

/** a prototype hunk → the contract's DiffHunk rows */
export function toDiffHunk(h: Hunk): DiffHunk {
  return { rows: h.ops.map((o) => ({ op: o.t === "ins" ? "+" : o.t === "del" ? "-" : " ", text: o.text })), oldStart: h.as, newStart: h.bs };
}

/** jsdiff structuredPatch() hunks → the contract's DiffHunk rows ("\ No newline at end of file" stays a context row) */
export function hunksFromPatch(patch: StructuredPatch): DiffHunk[] {
  return patch.hunks.map((h) => ({
    oldStart: h.oldStart,
    newStart: h.newStart,
    rows: h.lines.map((l) => {
      const c = l[0];
      const op = c === "+" ? "+" : c === "-" ? "-" : " ";
      return { op, text: c === "+" || c === "-" || c === " " ? l.slice(1) : l };
    }),
  }));
}

/* ------------------------------------------------------------ fuzzy */

export interface FuzzyMatch { score: number; idx: number[] }

/** subsequence match, case-insensitive: +3 for a run, +1 otherwise, +2 at a word/path start; null when q is not in s */
export function fuzzy(q: string, s: string): FuzzyMatch | null {
  q = q.toLowerCase(); s = s.toLowerCase();
  let qi = 0, score = 0, last = -2;
  const idx: number[] = [];
  for (let i = 0; i < s.length && qi < q.length; i++) {
    if (s[i] === q[qi]) {
      idx.push(i);
      score += (last === i - 1 ? 3 : 1) + (i === 0 || s[i - 1] === " " || s[i - 1] === "/" ? 2 : 0);
      last = i; qi++;
    }
  }
  return qi === q.length ? { score, idx } : null;
}

/* ------------------------------------------------------------ text */

/** greedy word wrap per paragraph (\n); a word longer than width is hard-split (app.js wrap) */
export function wrap(text: string, width: number): string[] {
  width = Math.max(1, width); // width ≤ 0 never advanced the hard-split loop below (prototype quirk)
  const out: string[] = [];
  for (const para of String(text).split("\n")) {
    let line = "";
    for (const w of para.split(" ")) {
      if (!line) { line = w; continue; }
      if (line.length + 1 + w.length <= width) line += " " + w; else { out.push(line); line = w; }
    }
    while (line.length > width) { out.push(line.slice(0, width)); line = line.slice(width); }
    out.push(line);
  }
  return out;
}

/** mm:ss.t run clock */
export const fmtClock = (ms: number): string => {
  const s = Math.max(0, ms) / 1000;
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${String(m).padStart(2, "0")}:${r.toFixed(1).padStart(4, "0")}`;
};
export const fmtDur = (ms: number): string => (ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`);
export const fmtK = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
