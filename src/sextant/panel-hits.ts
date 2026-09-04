/** Click zones for the panels' own rows — today the files tree.
 *
 *  The files panel drew a cursor row and answered to ↑↓ ←→ Enter, and a click anywhere in it merely
 *  moved focus there (keys.ts onMouse's fallback), so "click the file to open it" — the one thing
 *  everyone tries first — did nothing. Same shape of gap as the card (card-hits.ts): the painter knew
 *  where every row was and told nobody.
 *
 *  Geometry mirrors drawFiles exactly: rows start at the panel's inner top, one per line, the first
 *  visible row is `files.scroll`. Computed AFTER the frame is painted (drawFiles clamps scroll and the
 *  cursor while painting), so the zones describe what is actually on screen this frame.
 *
 *  A click selects the row AND replays Enter: a directory toggles its fold, a file opens in the code
 *  panel — the same two things Enter already does on the cursor row (keys.ts onEnter), so clicking
 *  cannot do anything the keyboard could not. */

import { inner } from "./draw-util.ts";
import type { Rect, SextantState, TreeRow } from "./types.ts";

export interface RowHit {
  rect: Rect;
  /** the row's index into the flattened tree (files.cursor takes this value) */
  index: number;
}

/** One zone per visible tree row, or [] when the files panel is hidden or empty. `rows` is the
 *  flattened tree as drawn this frame (frame loop: treeRows(s)). */
export function fileRowHits(files: Rect | null, s: SextantState, rows: readonly TreeRow[]): RowHit[] {
  if (files === null || rows.length === 0) return [];
  const B = inner(files);
  if (B.w <= 0 || B.h <= 0) return [];
  const out: RowHit[] = [];
  for (let i = 0; i < B.h; i++) {
    const index = s.files.scroll + i;
    if (index >= rows.length) break;
    out.push({ rect: { x: B.x, y: B.y + i, w: B.w, h: 1 }, index });
  }
  return out;
}
