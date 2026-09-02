/** Port #45 test helper: a minimal in-memory ScreenLike — one cell per code point, clipped writes, style
 *  and tint recorded per cell so tests can assert colors and "nothing outside the rect". */
import type { ScreenLike, Seg, Style } from "../../src/sextant/types.ts";

export interface Cell { ch: string; fg: number; bg: number; a: number }

export class GridScreen implements ScreenLike {
  readonly cells: Cell[][];
  constructor(readonly w: number, readonly h: number, fillCh = " ") {
    this.cells = Array.from({ length: h }, () => Array.from({ length: w }, () => ({ ch: fillCh, fg: -1, bg: -1, a: 0 })));
  }
  at(x: number, y: number): Cell | undefined { return this.cells[y]?.[x]; }
  private set(x: number, y: number, ch: string, s?: Style): void {
    const c = this.at(x, y);
    if (!c) return;
    c.ch = ch;
    if (s) { if (s.fg !== -1) c.fg = s.fg; if (s.bg !== -1) c.bg = s.bg; c.a = s.a; }
  }
  put(x: number, y: number, str: string, s?: Style, maxW = Infinity): number {
    let i = 0;
    for (const ch of str) { if (i >= maxW) break; this.set(x + i, y, ch, s); i++; }
    return x + i;
  }
  text(x: number, y: number, segs: readonly Seg[], maxW = Infinity): number {
    let cx = x;
    for (const [t, s] of segs) cx = this.put(cx, y, t, s, Math.max(0, x + maxW - cx));
    return cx;
  }
  clip(x: number, y: number, str: string, s: Style | undefined, maxW: number): number {
    const cps = [...str];
    return this.put(x, y, cps.length > maxW ? cps.slice(0, Math.max(0, maxW - 1)).join("") + "…" : str, s, maxW);
  }
  fill(x: number, y: number, w: number, h: number, ch: string, s?: Style): void {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.set(x + i, y + j, ch, s);
  }
  tint(x: number, y: number, w: number, h: number, bg: number): void {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) { const c = this.at(x + i, y + j); if (c) c.bg = bg; }
  }
  hline(x: number, y: number, w: number, s?: Style, ch = "─"): void { this.fill(x, y, w, 1, ch, s); }
  vline(x: number, y: number, h: number, s?: Style, ch = "│"): void { this.fill(x, y, 1, h, ch, s); }
  box(x: number, y: number, w: number, h: number, s?: Style, bgFill?: number): void {
    if (bgFill !== undefined) this.tint(x, y, w, h, bgFill);
    this.hline(x + 1, y, w - 2, s); this.hline(x + 1, y + h - 1, w - 2, s);
    this.vline(x, y + 1, h - 2, s); this.vline(x + w - 1, y + 1, h - 2, s);
    this.set(x, y, "╭", s); this.set(x + w - 1, y, "╮", s); this.set(x, y + h - 1, "╰", s); this.set(x + w - 1, y + h - 1, "╯", s);
  }
  row(y: number): string { return this.cells[y]?.map((c) => c.ch).join("") ?? ""; }
  /** rows as text, trailing spaces trimmed */
  toText(): string { return this.cells.map((r) => r.map((c) => c.ch).join("").replace(/\s+$/, "")).join("\n"); }
}
