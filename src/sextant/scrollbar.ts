/** Sextant surface — shared one-column scrollbar painter.
 *  Pure: no I/O, no timers, no state mutation. All geometry is exported so a
 *  caller can hang a mouse hit-zone on the thumb rectangle. */

import type { Rect, ScreenLike, Theme } from "./types.ts";
import { st } from "./theme.ts";

/** Geometry for a vertical scrollbar track.
 *  When `visible` is false, no other fields are meaningful. */
export interface ScrollbarGeom {
  /** column the bar occupies */
  x: number;
  /** first row of the track */
  trackY: number;
  /** number of rows in the track */
  trackH: number;
  /** first row of the thumb (absolute) */
  thumbY: number;
  /** number of rows the thumb spans (≥ 1 when visible) */
  thumbH: number;
  visible: boolean;
}

/** Compute scrollbar geometry without drawing.
 *  @param x        - column for the bar
 *  @param trackY   - first row of the track
 *  @param trackH   - track height (rows)
 *  @param total    - total content rows
 *  @param viewport - visible rows (same unit as total)
 *  @param offset   - first visible row (0-based)
 */
export function scrollbarGeom(
  x: number,
  trackY: number,
  trackH: number,
  total: number,
  viewport: number,
  offset: number,
): ScrollbarGeom {
  const visible = total > viewport && trackH >= 2;
  if (!visible) return { x, trackY, trackH, thumbY: trackY, thumbH: 0, visible: false };
  const thumbH = Math.max(1, Math.round(trackH * viewport / total));
  const scrollRange = Math.max(1, total - viewport);
  const trackRange = Math.max(0, trackH - thumbH);
  const rawThumbY = trackY + Math.round(trackRange * Math.max(0, offset) / scrollRange);
  const thumbY = Math.min(rawThumbY, trackY + trackH - thumbH);
  return { x, trackY, trackH, thumbY, thumbH, visible: true };
}

/** Paint the scrollbar described by `geom`.
 *  Track: thin `│` in theme.rule; thumb: `▌` in theme.dim. */
export function drawScrollbar(scr: ScreenLike, geom: ScrollbarGeom, theme: Theme): void {
  if (!geom.visible) return;
  const trackSt = st(theme.rule);
  const thumbSt = st(theme.dim);
  for (let i = 0; i < geom.trackH; i++) {
    const y = geom.trackY + i;
    const inThumb = y >= geom.thumbY && y < geom.thumbY + geom.thumbH;
    scr.put(geom.x, y, inThumb ? "▌" : "│", inThumb ? thumbSt : trackSt);
  }
}

/** Convenience: compute + draw in one call; returns the geometry (for hit-zone export). */
export function scrollbar(
  scr: ScreenLike,
  theme: Theme,
  x: number,
  trackY: number,
  trackH: number,
  total: number,
  viewport: number,
  offset: number,
): ScrollbarGeom {
  const geom = scrollbarGeom(x, trackY, trackH, total, viewport, offset);
  drawScrollbar(scr, geom, theme);
  return geom;
}

/** A Rect covering the thumb — useful for registering a mouse hit-zone. */
export function thumbRect(geom: ScrollbarGeom): Rect {
  return { x: geom.x, y: geom.thumbY, w: 1, h: geom.thumbH };
}
