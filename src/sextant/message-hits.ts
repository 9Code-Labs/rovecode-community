/** Click zones on the transcript: a tool row that names a file (`~ edit src/a.ts`, `◆ read …`) opens
 *  that file in the code panel — what `/open <path>` does. The rows come from the same cached build the
 *  painter used (draw-messages.ts cachedBuildRows), at the same scroll offset, so a zone is exactly the
 *  painted row. Rows under a card, or off the visible window, get no zone. */
import { areas, cachedBuildRows, messagesScroll } from "./draw-messages.ts";
import { inner } from "./draw-util.ts";
import type { Rect, SextantState, Theme } from "./types.ts";

export interface MessageHit { rect: Rect; path: string }

export function messageRowHits(rect: Rect, s: SextantState, theme: Theme, now: number): MessageHit[] {
  const B = inner(rect);
  if (B.w < 3 || B.h < 1) return [];
  const { msgH } = areas(B, s);
  if (msgH <= 0) return [];
  const rows = cachedBuildRows(s, B.w, theme, now);
  const { offset } = messagesScroll(rect, s, theme, now);
  const out: MessageHit[] = [];
  for (let i = 0; i < msgH; i++) {
    const r = rows[offset + i];
    if (!r?.path) continue;
    const x = B.x + (r.indent ?? 0);
    out.push({ rect: { x, y: B.y + i, w: Math.max(1, B.w - (r.indent ?? 0) - 1), h: 1 }, path: r.path }); // -1: the scrollbar column
  }
  return out;
}
