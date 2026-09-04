/** Click zones on the outer frame's two border rows (draw-frame.ts headerRight / footerRight): the
 *  unread badge `◆ N` opens the notices (⌃b), the theme name in the footer tag cycles the theme (⌃t),
 *  and `effort X` prefills `/effort ` so the levels appear as suggestions. The words are located by
 *  the same segment math the painter uses, so a zone is exactly the word it reads. */
import { footerRight, headerRight } from "./draw-frame.ts";
import { segWidth } from "./layout.ts";
import type { HitZone, Rect, SextantState, Theme } from "./types.ts";

export function frameHits(F: Rect, s: SextantState, theme: Theme, now: number): HitZone[] {
  const out: HitZone[] = [];
  const head = headerRight(s, theme, now);
  const hx = F.x + F.w - 2 - segWidth(head.segs);
  if (head.badge) out.push({ rect: { x: hx + head.badge[0], y: F.y, w: head.badge[1], h: 1 }, onClick: () => {}, key: { type: "key", name: "b", ctrl: true } });
  const foot = footerRight(s, theme);
  const fx = F.x + F.w - 2 - segWidth(foot.segs), fy = F.y + F.h - 1;
  if (foot.effort) {
    out.push({
      rect: { x: fx + foot.effort[0], y: fy, w: foot.effort[1], h: 1 },
      // the prompt gets `/effort ` with the cursor at the end; the suggestion strip then lists the levels
      onClick: () => { s.input.text = "/effort "; s.input.cur = s.input.text.length; s.input.sgSel = 0; s.focus = "messages"; },
    });
  }
  out.push({ rect: { x: fx + foot.theme[0], y: fy, w: foot.theme[1], h: 1 }, onClick: () => {}, key: { type: "key", name: "t", ctrl: true } });
  return out;
}
