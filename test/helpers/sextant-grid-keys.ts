/** Port #43 test helper: a minimal in-memory ScreenLike (one cell per code point, styles ignored)
 *  so the overlay drawers can be asserted as text without #40's screen.ts. */

import type { ScreenLike, Seg, Style } from "../../src/sextant/types.ts";

export class GridScreen implements ScreenLike {
  readonly cells: string[][];
  constructor(readonly w: number, readonly h: number) {
    this.cells = Array.from({ length: h }, () => Array.from({ length: w }, () => " "));
  }
  private set(x: number, y: number, ch: string): void {
    if (x >= 0 && x < this.w && y >= 0 && y < this.h) this.cells[y]![x] = ch;
  }
  put(x: number, y: number, str: string, _st?: Style, maxW = Infinity): number {
    let i = 0;
    for (const ch of str) { if (i >= maxW) break; this.set(x + i, y, ch); i++; }
    return x + i;
  }
  text(x: number, y: number, segs: readonly Seg[], maxW = Infinity): number {
    let cx = x;
    for (const [str, st] of segs) cx = this.put(cx, y, str, st, Math.max(0, x + maxW - cx));
    return cx;
  }
  clip(x: number, y: number, str: string, st: Style | undefined, maxW: number): number {
    const chars = [...str];
    return this.put(x, y, chars.length > maxW ? chars.slice(0, Math.max(0, maxW - 1)).join("") + "…" : str, st, maxW);
  }
  fill(x: number, y: number, w: number, h: number, ch: string): void {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) this.set(xx, yy, ch);
  }
  tint(): void {}
  hline(x: number, y: number, w: number, _st?: Style, ch = "─"): void { this.fill(x, y, w, 1, ch); }
  vline(x: number, y: number, h: number, _st?: Style, ch = "│"): void { this.fill(x, y, 1, h, ch); }
  box(x: number, y: number, w: number, h: number, _st?: Style, bgFill?: number): void {
    if (bgFill !== undefined) this.fill(x, y, w, h, " ");
    this.hline(x + 1, y, w - 2); this.hline(x + 1, y + h - 1, w - 2);
    this.vline(x, y + 1, h - 2); this.vline(x + w - 1, y + 1, h - 2);
    this.set(x, y, "╭"); this.set(x + w - 1, y, "╮"); this.set(x, y + h - 1, "╰"); this.set(x + w - 1, y + h - 1, "╯");
  }
  /** rows joined by \n, trailing spaces trimmed */
  toText(): string { return this.cells.map((r) => r.join("").replace(/\s+$/, "")).join("\n"); }
  row(y: number): string { return this.cells[y]?.join("").replace(/\s+$/, "") ?? ""; }
}
