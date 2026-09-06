/** ported from the user's sextant v0.4.0 prototype, src/app.js lines 184-220 (layout, panel) */
/* Panel geometry for the sextant surface and the rounded panel frame. Pure: no clock, no I/O.
   layout() mirrors app.js layout() number for number (sextant-layout.test.ts pins nine sizes
   computed from the prototype); panel() takes the screen and theme explicitly instead of closing
   over them, and measures title/extra widths in cells (the prototype used string length). This is
   the ONE panel() of the surface (#44 folded the #41 draw-frame and #42 draw-util copies into it):
   the interior is cleared to the theme background and an extra that would not fit is clipped with
   an ellipsis before it is dropped — text-identical to the prototype for every extra that fits. */

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

/** cells a segment list occupies (East-Asian-width aware, like the borders) */
export const segWidth = (segs: readonly Seg[]): number => segs.reduce((n, [t]) => n + strWidth(t), 0);

/** the longest prefix of `s` that fits `w` cells */
function headCells(s: string, w: number): string {
  let out = "", used = 0;
  for (const c of s) { const cw = strWidth(c); if (used + cw > w) break; out += c; used += cw; }
  return out;
}

/** clip the widest segment (with an ellipsis) until the run fits `room` cells; [] when hopeless
 *  (room under 6 cells, or fewer than 3 cells of the clipped text would survive) */
export function fitSegs(segs: readonly Seg[], room: number): Seg[] {
  let out: Seg[] = segs.filter(([t]) => t.length > 0);
  let ew = segWidth(out);
  if (ew <= room) return out;
  if (room < 6) return [];
  let widest = 0;
  out.forEach(([t], i) => { if (strWidth(t) > strWidth(out[widest]?.[0] ?? "")) widest = i; });
  const [text, style] = out[widest]!;
  const keep = strWidth(text) - (ew - room) - 1;
  if (keep < 3) return [];
  out = out.map((sg, i) => (i === widest ? [headCells(text, keep) + "…", style] : sg));
  ew = segWidth(out);
  return ew <= room ? out : [];
}

/** rounded panel with the title in the top border and right-aligned extra segments; returns the inner rect.
 *  Interior cleared to the theme background; the title is clipped to the box; extras must leave a
 *  `─` between themselves and the title (the prototype's strict `ex > x + 4 + titleW`) — when they do
 *  not fit, the widest one is clipped with an ellipsis (fitSegs), else they are dropped.
 *  Border/title colors: `color` when given, else accent when focused, else frame (border) / fg2 (title). */
export function panel(scr: ScreenLike, P: Rect, title: string, focused: boolean, extra: readonly Seg[] | undefined, C: Theme, color?: number): Rect {
  const col = color ?? (focused ? C.accent : C.frame);
  scr.box(P.x, P.y, P.w, P.h, st(col), C.bg);
  if (title) scr.text(P.x + 2, P.y, [[" ", st(-1)], [title, st(color ?? (focused ? C.accent : C.fg2), -1, ATTR.BOLD)], [" ", st(-1)]], Math.max(0, P.w - 4));
  if (extra && extra.length) {
    const segs = fitSegs(extra, P.w - 8 - strWidth(title));
    const ew = segWidth(segs);
    if (ew > 0) scr.text(P.x + P.w - 3 - ew, P.y, [[" ", st(-1)], ...segs, [" ", st(-1)]]);
  }
  return { x: P.x + 2, y: P.y + 1, w: P.w - 4, h: P.h - 2 };
}
