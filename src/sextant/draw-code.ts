/** Sextant surface (port #42) — the CODE panel: title per mode, the right-edge rail (▤ ± $ ∷ + the
 *  minimap), file view with syntax coloring and the reading highlight, run output with PASS/FAIL
 *  chips, search results, unified/split diff. Ported from the user's own sextant v0.4.0 prototype,
 *  src/app.js:164-181 (tokStyle/putCode) and :333-558 (drawCode … drawSplitSide); the mock file
 *  fixture, edit replay and click hit-boxes are gone — every field is read from SextantState and
 *  the painter is pure (no clock, no timers, no state mutation; `now` is a parameter). The
 *  prototype's scroll write-backs became `codeScrollTop` so the renderer can persist the view. */

import type { DiffHunk, Rect, ScreenLike, Seg, SextantState, Style, Theme } from "./types.ts";
import { ATTR } from "./types.ts";
import { hardWrap, inner, panel, spinner, splitLines, splitLinesCached, st } from "./draw-util.ts";
import { EMPTY } from "../core/voice.ts";
import { moreMarker } from "../coding/diff.ts";
import { scrollbar } from "./scrollbar.ts";

/** a syntax token: text + either a prototype class name (kw str num dec cm ty fn key … plain,
 *  colored by `tokStyle`) or a ready Style (undefined = plain) */
export type Token = readonly [text: string, cls: string | Style | undefined];
export type TokenizeFn = (line: string, lang: string) => readonly Token[];
/** optional engine seams: the syntax tokenizer (#40's engine); default = uncolored lines */
export interface CodeDeps { tokenize?: TokenizeFn }
export type Painter = (scr: ScreenLike, rect: Rect, s: SextantState, theme: Theme, now: number) => void;

export const RAIL_W = 3;
const MODES: readonly (readonly [string, string])[] = [["code", "▤"], ["diff", "±"], ["run", "$"], ["agents", "∷"]];
const plainTokens: TokenizeFn = (line) => [[line, "plain"]];

let agentsPainter: Painter | null = null;
/** #46 plugs the crew board in here; until then `∷` shows the crew summary from s.crew */
export function setAgentsPainter(fn: Painter | null): void { agentsPainter = fn; }

/** language tag from the path (drives the tokenizer); the prototype knew ts/json/md/text */
export function langOf(path: string): string {
  if (/\.(?:[cm]?[jt]sx?)$/.test(path)) return "ts";
  if (path.endsWith(".json")) return "json";
  if (path.endsWith(".md")) return "md";
  return "text";
}

/** token class → style (app.js:164-173); `bg` rides along so tinted rows keep their background */
export function tokStyle(cls: string, theme: Theme, bg = -1): Style {
  switch (cls) {
    case "kw": return st(theme.fg, bg, ATTR.BOLD);
    case "str": case "num": case "dec": return st(theme.str, bg);
    case "cm": return st(theme.muted, bg, ATTR.ITALIC);
    case "ty": return st(theme.ty, bg);
    case "fn": return st(theme.fg, bg);
    default: return st(theme.fg2, bg);
  }
}

/** write one code line colored token by token, clipped to maxW; returns the x after the last cell */
function putCode(scr: ScreenLike, x: number, y: number, text: string, lang: string, bg: number, maxW: number, theme: Theme, tokenize: TokenizeFn, fgOverride?: number): number {
  if (maxW <= 0) return x;
  if (fgOverride !== undefined) return scr.put(x, y, text, st(fgOverride, bg), maxW);
  let cx = x;
  const end = x + maxW;
  for (const [tok, cls] of tokenize(text, lang)) {
    if (cx >= end) break;
    const style = typeof cls === "string" ? tokStyle(cls, theme, bg) : cls ? { ...cls, bg: cls.bg >= 0 ? cls.bg : bg } : st(theme.fg2, bg);
    cx = scr.put(cx, y, tok, style, end - cx);
  }
  return cx;
}

/** the activity is reading/editing the file on screen (the reducer switches the panel to it) */
const readingThis = (s: SextantState): boolean => s.running && (s.activity.state === "READING" || s.activity.state === "EDITING");

/** the file named in the title/body: the diff's file in diff mode, else the code file */
const shownFile = (s: SextantState): string | null => (s.code.mode === "diff" && s.code.diff ? s.code.diff.file : s.code.file);

/** panel title + right-aligned extras per mode (app.js:337-351) */
export function codeTitle(s: SextantState, theme: Theme, now: number): { title: string; extra: Seg[] } {
  const c = s.code;
  if (c.mode === "run") {
    if (!c.run) return { title: "run", extra: [] };
    // the command lives in the body (drawRun's pinned `$ cmd` header), not here: the title clips it
    // to one ellipsized segment while the body can budget it in rows, and one copy is enough
    const tail: Seg = c.run.status === "running" ? [spinner(now), st(theme.accent)] : c.run.status === "ok" ? ["exit 0", st(theme.muted)] : ["failed", st(theme.err)];
    return { title: "run", extra: [tail] };
  }
  if (c.mode === "search") {
    if (!c.search) return { title: "search", extra: [] };
    return { title: "search", extra: [[c.search.query, st(theme.str)], [`  ${c.search.lines.length} results`, st(theme.muted)]] };
  }
  if (c.mode === "agents") {
    const live = s.crew.filter((t) => t.status === "queued" || t.status === "running").length;
    const done = s.crew.filter((t) => t.status === "done").length;
    const failed = s.crew.filter((t) => t.status === "failed").length;
    if (!s.crew.length) return { title: "agents", extra: [["crew", st(theme.muted)]] };
    const extra: Seg[] = [[`${live} running`, st(live ? theme.accent : theme.muted)], [`  ${done} done`, st(theme.muted)]];
    if (failed) extra.push([`  ${failed} failed`, st(theme.err)]);
    return { title: "agents", extra };
  }
  const file = shownFile(s);
  const title = c.mode === "diff" ? "diff" : "code";
  if (!file) return { title, extra: [] };
  const extra: Seg[] = [[file, st(theme.fg2)]];
  if (c.diff && c.diff.file === file) {
    if (c.diff.add || c.diff.del) extra.push(["  ", st(-1)], [c.diff.add ? `+${c.diff.add}` : "", st(theme.ok)], [c.diff.del ? `${c.diff.add ? " " : ""}−${c.diff.del}` : "", st(theme.err)]);
    if (c.diff.base === "head") extra.push(["  vs HEAD", st(theme.muted)]); // cumulative hunks, not the one edit that landed
  }
  if (readingThis(s) && c.mode === "code") extra.push([`   ${s.activity.state.toLowerCase()}`, st(theme.accent)]);
  return { title, extra };
}

/** new-file line numbers touched by the hunks: "added" (pure insert) or "changed" (replaced lines) */
export function hunkMarks(hunks: readonly DiffHunk[]): Map<number, "added" | "changed"> {
  const marks = new Map<number, "added" | "changed">();
  for (const h of hunks) {
    let nl = h.newStart, i = 0;
    while (i < h.rows.length) {
      if (h.rows[i]!.op === " ") { nl++; i++; continue; }
      const added: number[] = [];
      let hasDel = false;
      while (i < h.rows.length && h.rows[i]!.op !== " ") { if (h.rows[i]!.op === "-") hasDel = true; else added.push(nl++); i++; }
      for (const n of added) marks.set(n, hasDel ? "changed" : "added");
    }
  }
  return marks;
}

const marksFor = (s: SextantState): Map<number, "added" | "changed"> =>
  s.code.diff && s.code.diff.file === s.code.file ? hunkMarks(s.code.diff.hunks) : new Map();

/** the rows the current mode would draw (for scroll clamping); split diff depends on the body width */
export function rowCount(s: SextantState, bodyW: number): number {
  const c = s.code;
  if (c.mode === "code") return c.content === null ? 0 : splitLinesCached(c.content).length;
  if (c.mode === "diff") return c.diff ? diffRows(c.diff.hunks, bodyW > 110).length : 0;
  if (c.mode === "search") return c.search ? c.search.lines.length : 0;
  return 0;
}

/** Effective top row of the body for the panel at `rect` — s.code.scroll clamped to the content,
 *  or the row that centers the highlight while the run is reading/editing the file (app.js:407-408).
 *  The renderer writes this back into s.code.scroll after a frame so the view persists (the
 *  prototype mutated S.code.scroll in place; a pure painter cannot). run/agents follow their tail. */
export function codeScrollTop(rect: Rect, s: SextantState): number {
  const B = inner(rect);
  const h = B.h, bodyW = B.w - RAIL_W - 2;
  const n = rowCount(s, bodyW);
  const max = Math.max(0, n - h);
  if (s.code.mode === "code" && s.code.hl && readingThis(s)) return Math.min(max, Math.max(0, s.code.hl[0] - 1 - Math.floor(h / 2)));
  return Math.max(0, Math.min(s.code.scroll, max));
}

/** The rail: a 3-wide box with the four mode glyphs (active = accent + bold) and, for a file, the
 *  minimap — file lines folded into rail rows, added = ok, changed = warn, the visible region as a
 *  thick block ▌ and the rest as ▏ (app.js:367-397). */
function drawRail(scr: ScreenLike, R: Rect, s: SextantState, theme: Theme, viewTop: number, viewH: number): void {
  scr.box(R.x, R.y, R.w, R.h, st(theme.frameDim));
  MODES.forEach(([m, g], i) => {
    if (R.y + 1 + i >= R.y + R.h - 1) return; // a rail shorter than the glyph column shows what fits
    const active = s.code.mode === m || (m === "code" && s.code.mode === "search");
    scr.put(R.x + 1, R.y + 1 + i, g, st(active ? theme.accent : theme.dim, -1, active ? ATTR.BOLD : 0));
  });
  const top = R.y + 6, h = R.h - 7;
  if (h < 3 || (s.code.mode !== "code" && s.code.mode !== "diff") || s.code.content === null || !s.code.file) return;
  const n = Math.max(1, splitLinesCached(s.code.content).length);
  const marks = marksFor(s);
  const rows = Math.min(h, n);
  for (let i = 0; i < rows; i++) {
    const l0 = Math.floor((i / rows) * n), l1 = Math.max(l0 + 1, Math.floor(((i + 1) / rows) * n));
    let col = theme.rule;
    for (let k = l0; k < l1; k++) {
      const m = marks.get(k + 1);
      if (m === "added") col = theme.ok; else if (m === "changed" && col !== theme.ok) col = theme.warn;
    }
    const inView = l1 > viewTop && l0 < viewTop + viewH;
    const marked = col !== theme.rule;
    scr.put(R.x + 1, top + i, inView ? "▌" : "▏", st(marked ? col : inView ? theme.rule2 : theme.rule));
  }
}

/** line numbers, change marks (▎), colored code, the highlight band with its "◂ reading" tag (app.js:398-427) */
function drawFileView(scr: ScreenLike, B: Rect, s: SextantState, theme: Theme, top: number, tokenize: TokenizeFn): void {
  const file = s.code.file;
  if (!file) { scr.put(B.x, B.y, EMPTY.code, st(theme.muted), B.w); return; }
  if (s.code.content === null) { scr.clip(B.x, B.y, `cannot read ${file}`, st(theme.muted), B.w); return; }
  const lines = splitLinesCached(s.code.content);
  if (!lines.length) { scr.put(B.x, B.y, "(empty)", st(theme.dim), B.w); return; }
  const lang = langOf(file), marks = marksFor(s), hl = s.code.hl;
  const tag = readingThis(s) ? `◂ ${s.activity.state.toLowerCase()}` : null;
  const lw = Math.max(3, String(lines.length).length);
  for (let i = 0; i < B.h; i++) {
    const idx = top + i, ln = lines[idx];
    if (ln === undefined) break;
    const y = B.y + i;
    const inHl = hl !== null && idx + 1 >= hl[0] && idx + 1 <= hl[1];
    const mark = marks.get(idx + 1);
    const bg = inHl ? theme.hlBg : -1;
    if (inHl) scr.tint(B.x, y, B.w, 1, bg);
    scr.put(B.x, y, String(idx + 1).padStart(lw), st(inHl ? theme.accent : theme.dim, bg));
    scr.put(B.x + lw + 1, y, mark ? "▎" : " ", st(mark === "changed" ? theme.warn : theme.ok, bg));
    putCode(scr, B.x + lw + 3, y, ln, lang, bg, B.w - lw - 3, theme, tokenize);
    if (tag && inHl && hl !== null && idx + 1 === hl[0] && B.w > 24) scr.put(B.x + B.w - tag.length, y, tag, st(theme.accent, bg));
  }
}

/** ` PASS ` / ` FAIL ` inverse chip; returns the x after it */
function chip(scr: ScreenLike, x: number, y: number, pass: boolean, theme: Theme): number {
  return scr.put(x, y, pass ? " PASS " : " FAIL ", st(theme.bg, pass ? theme.ok : theme.err, ATTR.BOLD));
}

/** Rows the `$ cmd` header may take: two of text and the marker. At the 100-column floor the body
 *  is ~50 cells, so two rows show the program and its leading arguments — what identifies a run —
 *  and a 900-char pipeline (the screenshot that motivated this) folds into `… +N more lines`
 *  instead of a dozen bold rows that push the output under them. */
const CMD_ROWS = 3;

/** the header rows: the wrapped command, clipped to `max` the way the approval card clips its
 *  detail (moreMarker on the last budgeted row — the one clip convention on the surface) */
export function runCmdRows(cmd: string, w: number, max: number): string[] {
  if (max <= 0) return [];
  const all = hardWrap("$ " + cmd, w);
  return all.length > max ? [...all.slice(0, max - 1), moreMarker(all.length - max + 1)] : all;
}

/** The run view is a terminal tail with a pinned prompt: the `$ cmd` header stays at the top (the
 *  title no longer names the command, so the header must survive the output scrolling past it),
 *  then the output verbatim (real newlines stay rows; long rows hard-wrap like a terminal — never
 *  one-lined with ⏎) and the tail: the spinner while running or the PASS/FAIL chip from run.status.
 *  Output and tail sit against the BOTTOM of the panel — the newest line and the verdict are what
 *  the eye looks for, so short output leaves its slack above, not a dead zone below. Lines that
 *  start with PASS/FAIL get the chip too (app.js:428-449). */
function drawRun(scr: ScreenLike, B: Rect, s: SextantState, theme: Theme, now: number): void {
  const run = s.code.run;
  if (!run) { scr.put(B.x, B.y, "nothing has run yet", st(theme.muted), B.w); return; }
  const cmd = runCmdRows(run.cmd, B.w, B.h >= 4 ? Math.min(CMD_ROWS, B.h - 2) : 0); // below 4 rows the output and the verdict win
  cmd.forEach((t, i) => scr.put(B.x, B.y + i, t, t.startsWith("…") ? st(theme.dim) : st(theme.fg, -1, ATTR.BOLD), B.w));
  type Row = { kind: "out" | "tail"; text: string; first: boolean };
  const rows: Row[] = [];
  for (const line of run.lines) for (const [i, t] of hardWrap(line, B.w).entries()) rows.push({ kind: "out", text: t, first: i === 0 });
  rows.push({ kind: "tail", text: "", first: true });
  const outH = B.h - cmd.length;
  const start = Math.max(0, rows.length - outH);
  const y0 = B.y + B.h - Math.min(rows.length, outH);
  for (let i = 0; start + i < rows.length; i++) {
    const r = rows[start + i]!;
    const y = y0 + i;
    if (r.kind === "tail") {
      if (run.status === "running") scr.text(B.x, y, [[spinner(now), st(theme.accent)], ["  running", st(theme.muted)]], B.w);
      else { const cx = chip(scr, B.x, y, run.status === "ok", theme); scr.put(cx, y, run.status === "ok" ? "  exit 0" : "  non-zero exit", st(theme.muted), B.x + B.w - cx); }
      continue;
    }
    const m = r.first ? /^\s*(PASS|FAIL)\b\s?(.*)$/.exec(r.text) : null;
    if (m) { const cx = chip(scr, B.x, y, m[1] === "PASS", theme); scr.put(cx + 1, y, m[2] ?? "", st(theme.fg), B.x + B.w - cx - 1); continue; }
    scr.put(B.x, y, r.text, st(theme.fg2), B.w);
  }
}

/** glob/grep result lines: `path:line:` locations muted + the match colored; plain rows get a `·` (app.js:450-464) */
function drawSearch(scr: ScreenLike, B: Rect, s: SextantState, theme: Theme, top: number, tokenize: TokenizeFn): void {
  const v = s.code.search;
  if (!v) { scr.put(B.x, B.y, "no search yet", st(theme.muted), B.w); return; }
  const locW = Math.min(26, Math.floor(B.w * 0.4));
  let y = B.y;
  for (let i = top; i < v.lines.length && y < B.y + B.h; i++, y++) {
    const line = v.lines[i]!;
    const m = /^(\S+?:\d+(?::\d+)?):\s?(.*)$/.exec(line);
    if (m) { scr.clip(B.x, y, m[1]!, st(theme.muted), locW); putCode(scr, B.x + locW + 1, y, (m[2] ?? "").trimStart(), "ts", -1, B.w - locW - 1, theme, tokenize); }
    else scr.text(B.x, y, [["· ", st(theme.dim)], [line, st(theme.fg2)]], B.w);
  }
  const summary = v.lines.length ? `${v.lines.length} result${v.lines.length === 1 ? "" : "s"}` : "no results";
  if (y < B.y + B.h) scr.put(B.x, Math.min(y + (y > B.y ? 1 : 0), B.y + B.h - 1), summary, st(theme.muted), B.w);
}

// ------------------------------------------------------------------ diff

interface DiffLine { op: " " | "+" | "-"; an: number | null; bn: number | null; text: string }
type DiffRow = { t: "hunk"; text: string } | ({ t: "line" } & DiffLine) | { t: "pair"; l: DiffLine | null; r: DiffLine | null };

/** unified rows, or side-by-side pairs when `split` (app.js:490-506): equal lines pair with
 *  themselves, a run of deletes pairs index-wise with the run of inserts that follows it */
export function diffRows(hunks: readonly DiffHunk[], split: boolean): DiffRow[] {
  const rows: DiffRow[] = [];
  for (const h of hunks) {
    let a = h.oldStart, b = h.newStart;
    const lines: DiffLine[] = h.rows.map((r) => ({ op: r.op, text: r.text, an: r.op === "+" ? null : a++, bn: r.op === "-" ? null : b++ }));
    const ac = lines.filter((l) => l.op !== "+").length, bc = lines.filter((l) => l.op !== "-").length;
    rows.push({ t: "hunk", text: `@@ -${h.oldStart},${ac} +${h.newStart},${bc} @@` });
    if (!split) { for (const l of lines) rows.push({ t: "line", ...l }); continue; }
    let i = 0;
    while (i < lines.length) {
      if (lines[i]!.op === " ") { rows.push({ t: "pair", l: lines[i]!, r: lines[i]! }); i++; continue; }
      const dels: DiffLine[] = [], inss: DiffLine[] = [];
      while (i < lines.length && lines[i]!.op === "-") dels.push(lines[i++]!);
      while (i < lines.length && lines[i]!.op === "+") inss.push(lines[i++]!);
      for (let k = 0; k < Math.max(dels.length, inss.length); k++) rows.push({ t: "pair", l: dels[k] ?? null, r: inss[k] ?? null });
    }
  }
  return rows;
}

function drawSplitSide(scr: ScreenLike, x: number, y: number, w: number, o: DiffLine | null, side: "del" | "add", lang: string, theme: Theme, tokenize: TokenizeFn): void {
  if (!o || w < 8) return;
  const change = o.op !== " ";
  const bg = !change ? -1 : side === "add" ? theme.addBg : theme.delBg;
  if (bg >= 0) scr.tint(x, y, w, 1, bg);
  scr.put(x, y, String((side === "del" ? o.an : o.bn) ?? "").padStart(4), st(theme.dim, bg));
  scr.put(x + 5, y, change ? (side === "add" ? "+" : "−") : " ", st(side === "add" ? theme.ok : theme.err, bg));
  putCode(scr, x + 7, y, o.text, lang, bg, w - 7, theme, tokenize, side === "del" && change ? theme.muted : undefined);
}

function drawDiffRow(scr: ScreenLike, x: number, y: number, w: number, r: DiffRow, lang: string, theme: Theme, tokenize: TokenizeFn): void {
  if (r.t === "hunk") { scr.put(x, y, r.text, st(theme.dim), w); return; }
  if (r.t === "pair") {
    const half = Math.floor((w - 1) / 2);
    drawSplitSide(scr, x, y, half, r.l, "del", lang, theme, tokenize);
    drawSplitSide(scr, x + half + 1, y, w - half - 1, r.r, "add", lang, theme, tokenize);
    return;
  }
  const isIns = r.op === "+", isDel = r.op === "-";
  const bg = isIns ? theme.addBg : isDel ? theme.delBg : -1;
  if (bg >= 0) scr.tint(x, y, w, 1, bg);
  scr.put(x, y, String(r.an ?? "").padStart(4) + " " + String(r.bn ?? "").padStart(4), st(theme.dim, bg), w);
  scr.put(x + 10, y, isIns ? "+" : isDel ? "−" : " ", st(isIns ? theme.ok : theme.err, bg), Math.max(0, w - 10));
  putCode(scr, x + 12, y, r.text, lang, bg, w - 12, theme, tokenize, isDel ? theme.muted : undefined);
}

/** hunks of s.code.diff, unified (± backgrounds) or split when the body is wider than 110 cells (app.js:531-539) */
function drawDiff(scr: ScreenLike, B: Rect, s: SextantState, theme: Theme, top: number, tokenize: TokenizeFn): void {
  const d = s.code.diff;
  if (!d || !d.hunks.length) { scr.put(B.x, B.y, "no changes in this file", st(theme.muted), B.w); return; }
  const rows = diffRows(d.hunks, B.w > 110), lang = langOf(d.file);
  for (let i = 0; i < B.h; i++) { const r = rows[top + i]; if (!r) break; drawDiffRow(scr, B.x, B.y + i, B.w, r, lang, theme, tokenize); }
}

/** Parse unified-diff text (previewDiff output, `git diff`) into DiffHunks. File headers, the
 *  `\ No newline` note and the `… +N more lines` clip marker are skipped; garbage yields []. */
export function hunksFromUnified(text: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let cur: DiffHunk | null = null;
  for (const line of text.split(/\r?\n/)) {
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (m) { cur = { rows: [], oldStart: Number(m[1]), newStart: Number(m[2]) }; hunks.push(cur); continue; }
    if (!cur) continue;
    const op = line[0];
    if (op === "+" || op === "-" || op === " ") cur.rows.push({ op, text: line.slice(1) });
  }
  return hunks;
}

// ------------------------------------------------------------------ agents (until #46 registers its painter)

function drawCrewSummary(scr: ScreenLike, B: Rect, s: SextantState, theme: Theme, now: number): void {
  const n = s.crew.length;
  scr.put(B.x, B.y, `crew: ${n} task${n === 1 ? "" : "s"}`, st(n ? theme.fg2 : theme.muted), B.w);
  s.crew.forEach((t, i) => {
    const y = B.y + 2 + i;
    if (y >= B.y + B.h) return;
    const g = t.status === "running" ? spinner(now) : t.status === "queued" ? "◇" : t.status === "done" ? "◆" : t.status === "failed" ? "×" : "−";
    const gc = t.status === "running" ? theme.accent : t.status === "done" ? theme.ok : t.status === "failed" ? theme.err : theme.dim;
    const statusW = t.status.length;
    scr.text(B.x, y, [[g + " ", st(gc)], [t.label, st(theme.fg2)]], Math.max(0, B.w - statusW - 2));
    scr.put(B.x + B.w - statusW, y, t.status, st(t.status === "failed" ? theme.err : t.status === "done" ? theme.ok : theme.muted));
  });
}

// ------------------------------------------------------------------ the panel

/** Paint the code panel into `rect`: frame + title, the mode body, the rail. Pure over its inputs. */
export function drawCode(scr: ScreenLike, rect: Rect, s: SextantState, theme: Theme, now: number, deps: CodeDeps = {}): void {
  if (rect.w < 4 || rect.h < 3) return;
  const { title, extra } = codeTitle(s, theme, now);
  const B = panel(scr, rect, title, s.focus === "code", extra, theme);
  const rail: Rect = { x: B.x + B.w - RAIL_W, y: B.y, w: RAIL_W, h: B.h };
  const body: Rect = { x: B.x, y: B.y, w: B.w - RAIL_W - 2, h: B.h };
  const top = codeScrollTop(rect, s);
  if (body.w >= 6 && body.h >= 1) {
    const tokenize = deps.tokenize ?? plainTokens;
    switch (s.code.mode) {
      case "run": drawRun(scr, body, s, theme, now); break;
      case "search": drawSearch(scr, body, s, theme, top, tokenize); break;
      case "agents": (agentsPainter ?? drawCrewSummary)(scr, body, s, theme, now); break;
      case "diff": drawDiff(scr, body, s, theme, top, tokenize); break;
      default: drawFileView(scr, body, s, theme, top, tokenize);
    }
  }
  // scrollbar in the one-column gap between body and rail (code/diff/search only; run/agents tail)
  if (B.w >= RAIL_W + 2 && body.h >= 2 &&
      (s.code.mode === "code" || s.code.mode === "diff" || s.code.mode === "search")) {
    const total = rowCount(s, body.w);
    scrollbar(scr, theme, B.x + B.w - RAIL_W - 1, B.y, body.h, total, body.h, top); // scroll-hits.ts rebuilds this geometry for the drag zone
  }
  if (rail.h >= 2 && B.w >= RAIL_W) drawRail(scr, rail, s, theme, top, body.h);
}
