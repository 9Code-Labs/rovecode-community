/** ported from the user's sextant v0.4.0 prototype, src/app.js lines 184-220 (layout, panel) */
/* Panel geometry for the sextant surface and the rounded panel frame. Pure: no clock, no I/O.
   layout() mirrors app.js layout() number for number (sextant-layout.test.ts pins nine sizes
   computed from the prototype); panel() takes the screen and theme explicitly instead of closing
   over them, and measures title/extra widths in cells (the prototype used string length). */

import { MIN_COLS, MIN_ROWS, strWidth } from "./screen.ts";
import { st } from "./theme.ts";
import { ATTR, type Layout, type LayoutOptions, type Rect, type ScreenLike, type Seg, type Theme } from "./types.ts";

/** files column at w ≥ 140 (30 wide from 150, else 26); right column at w ≥ 110 (34 / 28);
 *  messages = max(8, round(contentH · 0.34)) rows; usage 5 rows; pet 14 rows when contentH ≥ 36 —
 *  under files when present, else under plan; the size is clamped to the 40×12 floor like Screen. */
export function layout(w: number, h: number, opts: LayoutOptions): Layout {
  const W = Math.max(MIN_COLS, w), H = Math.max(MIN_ROWS, h);
  const frame: Rect = { x: 0, y: 0, w: W - 1, h: H };
  const x0 = 2, x1 = W - 4, y0 = 1, y1 = H - 2;
  const showFiles = W >= 140, showRight = W >= 110;
  const filesW = showFiles ? (W >= 150 ? 30 : 26) : 0;
  const rightW = showRight ? (W >= 150 ? 34 : 28) : 0;
  const contentH = y1 - y0 + 1;
  const files: Rect | null = showFiles ? { x: x0, y: y0, w: filesW, h: contentH } : null;
  const right: Rect | null = showRight ? { x: x1 - rightW + 1, y: y0, w: rightW, h: contentH } : null;
  const cx = x0 + (showFiles ? filesW + 1 : 0);
  const cw = (right ? right.x - 1 : x1 + 1) - cx;
  const msgH = Math.max(8, Math.round(contentH * 0.34));
  const code: Rect = { x: cx, y: y0, w: cw, h: contentH - msgH };
  const messages: Rect = { x: cx, y: y0 + code.h, w: cw, h: msgH };
  const petH = opts.pet && contentH >= 36 ? 14 : 0;
  let plan: Rect | null = null, usage: Rect | null = null, pet: Rect | null = null;
  if (right) {
    const usageH = 5;
    plan = { x: right.x, y: y0, w: rightW, h: contentH - usageH };
    usage = { x: right.x, y: y0 + plan.h, w: rightW, h: usageH };
  }
  if (petH && files) { files.h = contentH - petH; pet = { x: x0, y: y0 + files.h, w: filesW, h: petH }; }
  else if (petH && right && plan) { plan.h -= petH; pet = { x: right.x, y: y0 + plan.h, w: rightW, h: petH }; }
  return { w: W, h: H, frame, files, code, messages, plan, usage, pet };
}

/** rounded panel with the title in the top border and right-aligned extra segments; returns the inner rect.
 *  Border/title colors: `color` when given, else accent when focused, else frame (border) / fg2 (title). */
export function panel(scr: ScreenLike, P: Rect, title: string, focused: boolean, extra: readonly Seg[] | undefined, C: Theme, color?: number): Rect {
  const col = color ?? (focused ? C.accent : C.frame);
  scr.box(P.x, P.y, P.w, P.h, st(col));
  if (title) scr.text(P.x + 2, P.y, [[" ", st(-1)], [title, st(color ?? (focused ? C.accent : C.fg2), -1, ATTR.BOLD)], [" ", st(-1)]]);
  if (extra && extra.length) {
    const ew = extra.reduce((s, [t]) => s + strWidth(t), 0);
    const ex = P.x + P.w - 3 - ew;
    if (ex > P.x + 4 + (title ? strWidth(title) : 0)) scr.text(ex, P.y, [[" ", st(-1)], ...extra, [" ", st(-1)]]);
  }
  return { x: P.x + 2, y: P.y + 1, w: P.w - 4, h: P.h - 2 };
}
