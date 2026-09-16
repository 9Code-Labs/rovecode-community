/** Sextant headless cell grid (port #41) — term.js Screen minus I/O (user's sextant v0.4.0
 *  src/term.js:32-147): the ScreenLike double dumpFrame paints on. One cell per code point;
 *  writes outside the buffer clip; bg -1 inherits the cell's current background. */

import type { ScreenLike, Seg, Style } from "./types.ts";

export class GridScreen implements ScreenLike {
  readonly w: number; readonly h: number;
  readonly ch: string[]; readonly fg: Int32Array; readonly bg: Int32Array; readonly at: Uint8Array;

  constructor(cols: number, rows: number, bg = -1) {
    this.w = Math.max(1, Math.floor(cols)); this.h = Math.max(1, Math.floor(rows));
    const n = this.w * this.h;
    this.ch = new Array<string>(n).fill(" "); this.fg = new Int32Array(n).fill(-1); this.bg = new Int32Array(n).fill(bg); this.at = new Uint8Array(n);
  }
  put(x: number, y: number, str: string, st?: Style, maxW = Infinity): number {
    if (y < 0 || y >= this.h || !str) return x;
    const fg = st ? st.fg : -1, bg = st ? st.bg : -1, a = st ? st.a : 0, end = Math.min(this.w, x + maxW);
    let cx = x;
    for (const c of str) {
      if (cx >= end) break;
      if (cx >= 0) { const i = y * this.w + cx; this.ch[i] = c; this.fg[i] = fg; if (bg >= 0) this.bg[i] = bg; this.at[i] = a; }
      cx++;
    }
    return cx;
  }
  text(x: number, y: number, segs: readonly Seg[], maxW = Infinity): number {
    let cx = x;
    for (const [s, st] of segs) { if (cx >= x + maxW) break; cx = this.put(cx, y, s, st, x + maxW - cx); }
    return cx;
  }
  clip(x: number, y: number, str: string, st: Style | undefined, maxW: number): number {
    if (maxW <= 0) return x;
    const cps = [...str];
    return this.put(x, y, cps.length > maxW ? (maxW > 1 ? cps.slice(0, maxW - 1).join("") + "…" : cps.slice(0, maxW).join("")) : str, st, maxW);
  }
  fill(x: number, y: number, w: number, h: number, ch: string, st?: Style): void {
    for (let yy = Math.max(0, y); yy < Math.min(this.h, y + h); yy++) for (let xx = Math.max(0, x); xx < Math.min(this.w, x + w); xx++) {
      const i = yy * this.w + xx;
      this.ch[i] = ch; this.fg[i] = st ? st.fg : -1; if (st && st.bg >= 0) this.bg[i] = st.bg; this.at[i] = st ? st.a : 0;
    }
  }
  tint(x: number, y: number, w: number, h: number, bg: number): void {
    for (let yy = Math.max(0, y); yy < Math.min(this.h, y + h); yy++) for (let xx = Math.max(0, x); xx < Math.min(this.w, x + w); xx++) this.bg[yy * this.w + xx] = bg;
  }
  hline(x: number, y: number, w: number, st?: Style, ch = "─"): void { for (let i = 0; i < w; i++) this.put(x + i, y, ch, st); }
  vline(x: number, y: number, h: number, st?: Style, ch = "│"): void { for (let i = 0; i < h; i++) this.put(x, y + i, ch, st); }
  box(x: number, y: number, w: number, h: number, st?: Style, bgFill?: number): void {
    if (bgFill !== undefined) this.fill(x, y, w, h, " ", { fg: -1, bg: bgFill, a: 0 });
    this.put(x, y, "╭", st); this.put(x + w - 1, y, "╮", st); this.put(x, y + h - 1, "╰", st); this.put(x + w - 1, y + h - 1, "╯", st);
    this.hline(x + 1, y, w - 2, st); this.hline(x + 1, y + h - 1, w - 2, st); this.vline(x, y + 1, h - 2, st); this.vline(x + w - 1, y + 1, h - 2, st);
  }
  /** plain-text dump: one line per row, trailing whitespace trimmed (the golden-test form) */
  toText(): string {
    const lines: string[] = [];
    for (let y = 0; y < this.h; y++) lines.push(this.ch.slice(y * this.w, (y + 1) * this.w).join("").replace(/\s+$/, ""));
    return lines.join("\n");
  }
}
