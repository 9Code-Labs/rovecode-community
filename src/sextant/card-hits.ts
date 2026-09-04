/** Click zones for the modal card (approval verdicts, question options, free text, skip).
 *
 *  Why this exists: the card is the single most frequent interaction in the surface — every gated
 *  edit, every shell command, every ask_user question goes through it — and until now it answered
 *  only to the arrow keys. Clicking `allow` did nothing at all: keys.ts's onMouse walks the hit zones
 *  the drawers registered that frame, and nobody registered any for the card, so the click fell
 *  through to the "focus the panel under the pointer" fallback. That is the complaint "most things do
 *  not respond to clicks, it only works with the arrow keys", in its most-used place.
 *
 *  Geometry, not painting: draw-messages.ts owns how the card looks, this file owns where its targets
 *  landed. The two are kept honest by deriving everything from the SAME exported helpers the painter
 *  uses (areas, cardShape, cardRows) rather than re-deriving row counts — a second copy of the layout
 *  arithmetic would drift the moment the card grew a row.
 *
 *  Two subtleties the card forces:
 *    - The card is CLIPPED from the top when it does not fit (draw-messages keeps the tail so the
 *      buttons stay reachable), so a row's screen y is its index minus the hidden count, and a target
 *      scrolled off the top has no zone at all rather than a wrong one.
 *    - The approval verdicts share ONE row, laid out horizontally, so they need x ranges; the question
 *      card gives every option its own row.
 *
 *  `confirm` is false for exactly one target, the free-text row: clicking it means "I want to type
 *  here", not "submit an empty answer". Every other target is a labelled button, and a click on a
 *  button is the decision — the same as clicking OK in any dialog. */

import { areas, cardRows, cardShape, SKIP_LABEL, VERDICT_LABEL } from "./draw-messages.ts";
import { inner } from "./draw-util.ts";
import { strWidth } from "./screen.ts";
import type { Rect, SextantState, Theme } from "./types.ts";

export interface CardHit {
  rect: Rect;
  /** the value card.selected takes when this target is clicked */
  index: number;
  /** replay Enter after selecting (a button); false leaves the caret on the row (free text) */
  confirm: boolean;
}

/** button() in draw-messages renders a label as ` label `, and the verdict row separates them by two
 *  spaces at indent 2. */
const BUTTON_PAD = 2;
const BUTTON_GAP = 2;
const ROW_INDENT = 2;

/** The card's clickable targets in screen coordinates, or [] when no card is open, the panel is too
 *  small to draw one, or every target is clipped away. `rect` is the messages panel, as passed to
 *  drawMessages. */
export function cardHits(rect: Rect, s: SextantState, theme: Theme): CardHit[] {
  const card = s.card;
  if (card === null || card === undefined) return [];
  if (rect.w < 4 || rect.h < 3) return []; // drawMessages paints nothing at all below this
  const B = inner(rect);
  const { cardH, msgH, maxDetail } = areas(B, s);
  if (cardH <= 0) return [];

  const all = cardRows(card, B.w, maxDetail, theme);
  // when the card is taller than its slot the painter keeps the TAIL: rows [hidden..] are on screen
  const hidden = all.length - cardH;
  const yOf = (i: number): number | null => {
    const v = i - hidden;
    return v < 0 || v >= cardH ? null : B.y + msgH + v;
  };
  const out: CardHit[] = [];

  if (card.kind === "approval") {
    // the verdicts are the last row, so they survive clipping — that is why the painter keeps the tail
    const y = yOf(all.length - 1);
    if (y === null) return [];
    let x = B.x + ROW_INDENT;
    for (const [i, v] of card.verdicts.entries()) {
      const w = strWidth(VERDICT_LABEL[v] ?? String(v)) + BUTTON_PAD;
      if (x + w > B.x + B.w) break; // a verdict pushed past the right edge was never drawn
      out.push({ rect: { x, y, w, h: 1 }, index: i, confirm: true });
      x += w + BUTTON_GAP;
    }
    return out;
  }

  // question card: blank, q question rows, one row per option, [free text], skip, hint.
  // q is derived from cardShape rather than re-wrapped here, so the two cannot disagree.
  const opts = card.prompt.options ?? [];
  const free = card.prompt.allowFreeText !== false;
  const shape = cardShape(card, B.w, maxDetail);
  const q = shape.total - opts.length - (free ? 1 : 0) - 3;
  if (q < 0) return [];
  const push = (rowIndex: number, index: number, w: number, confirm: boolean): void => {
    const y = yOf(rowIndex);
    if (y !== null && w > 0) out.push({ rect: { x: B.x + ROW_INDENT, y, w, h: 1 }, index, confirm });
  };
  const full = Math.max(0, B.w - ROW_INDENT);
  for (const [i, o] of opts.entries()) push(1 + q + i, i, Math.min(strWidth(o) + BUTTON_PAD, full), true);
  // the free-text row is a text field: select it, do not answer for the human
  if (free) push(1 + q + opts.length, opts.length, full, false);
  push(1 + q + opts.length + (free ? 1 : 0), opts.length + (free ? 1 : 0), Math.min(strWidth(SKIP_LABEL) + BUTTON_PAD, full), true);
  return out;
}
