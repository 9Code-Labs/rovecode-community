/** Scrollbar thumbs as grab zones (types.ts HitZone.onDrag). Each painter draws its bar from a
 *  handful of numbers — track x/y/h, content rows, viewport rows, offset (draw-messages.ts:338,
 *  draw-frame.ts:111, draw-code.ts:385). The same numbers rebuilt here give the thumb's rect; a drag
 *  slides the thumb by `dy` rows from where it was painted and maps that back onto an offset, so the
 *  thumb stays under the finger wherever it was grabbed. */
import { codeScrollTop, RAIL_W, rowCount } from "./draw-code.ts";
import { areas, messagesScroll } from "./draw-messages.ts";
import { inner } from "./draw-util.ts";
import { scrollbarGeom, thumbRect, type ScrollbarGeom } from "./scrollbar.ts";
import type { HitZone, Layout, Page, SextantState, Theme, TreeRow } from "./types.ts";

/** the content offset after sliding the thumb `dy` rows from where it was painted (clamped) */
export function slideOffset(g: ScrollbarGeom, dy: number, total: number, viewport: number): number {
  const range = Math.max(0, total - viewport), track = g.trackH - g.thumbH;
  if (track <= 0 || range === 0) return 0;
  const top = Math.max(g.trackY, Math.min(g.trackY + track, g.thumbY + dy));
  return Math.round((top - g.trackY) / track * range);
}

function thumbZone(g: ScrollbarGeom, total: number, viewport: number, set: (offset: number) => void): HitZone | null {
  if (!g.visible) return null;
  return { rect: thumbRect(g), onClick: () => {}, onDrag: (_y, dy) => set(slideOffset(g, dy, total, viewport)) };
}

/** Wheeling the messages up unsticks the view from the tail; once the person scrolls back down to the end
 *  (wheel, drag, keys) the view follows the tail again — otherwise a conversation that has been scrolled
 *  once never follows new text until pgdn/end. Called by the frame loop after the paint. */
export function followTailIfAtEnd(L: Layout, s: SextantState, theme: Theme, now: number): void {
  if (s.stick) return;
  const { max } = messagesScroll(L.messages, s, theme, now);
  if (s.msgScroll >= max) { s.stick = true; s.msgScroll = max; }
}

/** one zone per visible scrollbar thumb: messages, the files tree (in its panel or paged into the
 *  main slot), and the code panel in a scrolling mode (file / diff / search; run and agents tail) */
export function scrollThumbHits(L: Layout, main: Page, s: SextantState, theme: Theme, now: number, rows: TreeRow[]): HitZone[] {
  const out: HitZone[] = [];
  {
    const B = inner(L.messages);
    const { msgH } = areas(B, s);
    const { offset, max } = messagesScroll(L.messages, s, theme, now);
    const total = max + msgH;
    const z = thumbZone(scrollbarGeom(B.x + B.w - 1, B.y, msgH, total, msgH, offset), total, msgH,
      (o) => { s.msgScroll = o; s.stick = o >= max; }); // dragged to the bottom = follow the tail again
    if (z) out.push(z);
  }
  // the files painter re-clamps scroll around the cursor, so the cursor is pulled into the new window
  const filesRect = L.files ?? (main === "files" ? L.code : null);
  if (filesRect) {
    const B = inner(filesRect);
    const z = thumbZone(scrollbarGeom(B.x + B.w - 1, B.y, B.h, rows.length, B.h, s.files.scroll), rows.length, B.h,
      (o) => { s.files.scroll = o; s.files.cursor = Math.max(o, Math.min(s.files.cursor, o + B.h - 1)); });
    if (z) out.push(z);
  }
  const c = s.code;
  if (main === "code" && (c.mode === "code" || c.mode === "diff" || c.mode === "search")) {
    const B = inner(L.code);
    if (B.w >= RAIL_W + 2) {
      const total = rowCount(s, B.w - RAIL_W - 2), top = codeScrollTop(L.code, s);
      const z = thumbZone(scrollbarGeom(B.x + B.w - RAIL_W - 1, B.y, B.h, total, B.h, top), total, B.h,
        (o) => { c.scroll = o; });
      if (z) out.push(z);
    }
  }
  return out;
}
