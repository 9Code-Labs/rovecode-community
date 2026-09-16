/** Test doubles for the sextant draw modules (port #42): an in-memory ScreenLike cell grid with
 *  per-cell style queries + toText(), a fixed Theme with distinguishable colors, a SextantState
 *  factory. No I/O, no clock. */

import type { ScreenLike, Seg, SextantState, Style, Theme } from "../../src/sextant/types.ts";

export class GridScreen implements ScreenLike {
  readonly ch: string[]; readonly fg: number[]; readonly bg: number[]; readonly at: number[];
  constructor(readonly w: number, readonly h: number, fill = " ") {
    const n = w * h;
    this.ch = new Array<string>(n).fill(fill); this.fg = new Array<number>(n).fill(-1);
    this.bg = new Array<number>(n).fill(-1); this.at = new Array<number>(n).fill(0);
  }
  put(x: number, y: number, str: string, s?: Style, maxW = Infinity): number {
    if (y < 0 || y >= this.h || !str) return x;
    let cx = x;
    const end = Math.min(this.w, x + maxW);
    for (const c of str) {
      if (cx >= end) break;
      if (cx >= 0) { const i = y * this.w + cx; this.ch[i] = c; this.fg[i] = s ? s.fg : -1; if (s && s.bg >= 0) this.bg[i] = s.bg; this.at[i] = s ? s.a : 0; }
      cx++;
    }
    return cx;
  }
  text(x: number, y: number, segs: readonly Seg[], maxW = Infinity): number {
    let cx = x;
    const end = x + maxW;
    for (const [s, style] of segs) { if (cx >= end) break; cx = this.put(cx, y, s, style, end - cx); }
    return cx;
  }
  clip(x: number, y: number, str: string, s: Style | undefined, maxW: number): number {
    if (maxW <= 0) return x;
    const t = str.length > maxW ? (maxW > 1 ? str.slice(0, maxW - 1) + "…" : str.slice(0, maxW)) : str;
    return this.put(x, y, t, s, maxW);
  }
  fill(x: number, y: number, w: number, h: number, ch: string, s?: Style): void { for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) this.put(xx, yy, ch, s); }
  tint(x: number, y: number, w: number, h: number, bg: number): void {
    for (let yy = Math.max(0, y); yy < Math.min(this.h, y + h); yy++) for (let xx = Math.max(0, x); xx < Math.min(this.w, x + w); xx++) this.bg[yy * this.w + xx] = bg;
  }
  hline(x: number, y: number, w: number, s?: Style, ch = "─"): void { for (let i = 0; i < w; i++) this.put(x + i, y, ch, s); }
  vline(x: number, y: number, h: number, s?: Style, ch = "│"): void { for (let i = 0; i < h; i++) this.put(x, y + i, ch, s); }
  box(x: number, y: number, w: number, h: number, s?: Style, bgFill?: number): void {
    if (bgFill !== undefined) this.fill(x, y, w, h, " ", { fg: -1, bg: bgFill, a: 0 });
    this.put(x, y, "╭", s); this.put(x + w - 1, y, "╮", s); this.put(x, y + h - 1, "╰", s); this.put(x + w - 1, y + h - 1, "╯", s);
    this.hline(x + 1, y, w - 2, s); this.hline(x + 1, y + h - 1, w - 2, s); this.vline(x, y + 1, h - 2, s); this.vline(x + w - 1, y + 1, h - 2, s);
  }
  row(y: number): string { return this.ch.slice(y * this.w, (y + 1) * this.w).join("").replace(/\s+$/, ""); }
  /** `w` cells from (x,y), trailing blanks trimmed — a panel body row without its borders */
  span(x: number, y: number, w: number): string { return this.ch.slice(y * this.w + x, y * this.w + x + w).join("").replace(/\s+$/, ""); }
  toText(): string { return Array.from({ length: this.h }, (_, y) => this.row(y)).join("\n"); }
  cell(x: number, y: number): { ch: string; fg: number; bg: number; at: number } { const i = y * this.w + x; return { ch: this.ch[i]!, fg: this.fg[i]!, bg: this.bg[i]!, at: this.at[i]! }; }
}

/** every color distinct so a cell's fg/bg identifies the role that painted it */
export const THEME: Theme = {
  name: "night", label: "test", bg: 0x000001, bg2: 0x000002, fg: 0x000003, fg2: 0x000004, muted: 0x000005, dim: 0x000006,
  rule: 0x000007, rule2: 0x000008, accent: 0x000009, accent2: 0x00000a, ok: 0x00000b, err: 0x00000c, warn: 0x00000d,
  info: 0x00000e, str: 0x00000f, ty: 0x000010, hlBg: 0x000011, addBg: 0x000012, delBg: 0x000013, selBg: 0x000014,
  accentDim: 0x000015, okDim: 0x000016, mixDim: 0x000017, frame: 0x000018, frameDim: 0x000019,
};

export function baseState(over: Partial<SextantState> = {}): SextantState {
  return {
    cwd: "/repo", repo: { name: "repo", branch: "main", modified: 0 },
    files: { paths: [], statuses: new Map(), expanded: new Set(), touched: new Map(), cursor: 0, scroll: 0, version: 0 },
    activity: { state: "IDLE", label: "", runId: null, startedAt: null, endedAt: null },
    code: { mode: "code", file: null, content: null, hl: null, scroll: 0, search: null, run: null, diff: null, lane: 0, laneOpen: false },
    messages: [], msgScroll: 0, stick: true, card: null, plan: { todos: [] }, crew: [],
    usage: { provider: "mock", model: "m", turns: 0, tokensIn: 0, tokensOut: 0, contextPct: null, costUsd: null },
    input: { text: "", cur: 0, history: [], histIdx: -1, sgSel: 0 },
    focus: "messages", page: "code", palette: null, market: null, context: null, wizard: null, help: false, toasts: [], notices: [], staged: [], escUntil: 0, running: false, mode: "act", yolo: false,
    theme: "night", bootAt: 0, commands: [], version: "0.0.0-test", ...over,
  };
}

/** every cell outside `r` still holds the sentinel the grid was filled with */
export function untouchedOutside(g: GridScreen, r: { x: number; y: number; w: number; h: number }, sentinel: string): boolean {
  for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) {
    const inside = x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
    if (!inside) { const c = g.cell(x, y); if (c.ch !== sentinel || c.fg !== -1 || c.bg !== -1 || c.at !== 0) return false; }
  }
  return true;
}
