/** scroll-hits.ts + the drag half of keys.ts onMouse — grabbing a scrollbar thumb and dragging it.
 *  Before this the bars were paint only: the wheel and the keys scrolled, the mouse could not. These pin
 *  the thumb geometry against the painters' scrollbar calls, the dy→offset mapping (the thumb stays
 *  under the finger, the ends clamp), and the grab lifecycle through handleInput: press on the thumb
 *  grabs, drag rows scroll, release lets go, and a drag with nothing grabbed is still a no-op. */

import { test, expect } from "bun:test";
import { scrollThumbHits, slideOffset } from "../../src/sextant/scroll-hits.ts";
import { scrollbarGeom } from "../../src/sextant/scrollbar.ts";
import { treeRows } from "../../src/sextant/model.ts";
import { makeState, makeLayout, spyCtx, mouse, press, THEME } from "../helpers/sextant-fixtures-keys.ts";

const L = makeLayout(160, 44);
const NOW = 1000;

/** a state whose messages panel, files tree and code panel all overflow their viewports */
function busy() {
  const s = makeState();
  for (let i = 0; i < 80; i++) s.messages.push({ kind: "user", text: `line ${i}` });
  s.files.paths = Array.from({ length: 120 }, (_, i) => `src/f${String(i).padStart(3, "0")}.ts`);
  s.files.expanded = new Set(["src"]);
  s.code.file = "src/f000.ts";
  s.code.content = Array.from({ length: 400 }, (_, i) => `const x${i} = ${i};`).join("\n");
  s.stick = false;
  return s;
}

test("slideOffset: the thumb follows dy proportionally and clamps at both ends of the track", () => {
  // 10-row track, 100 rows of content in a 10-row viewport → thumb 1 row, 9 rows of travel for 90 of scroll
  const g = scrollbarGeom(5, 10, 10, 100, 10, 0);
  expect(g.thumbH).toBe(1);
  expect(slideOffset(g, 0, 100, 10)).toBe(0);
  expect(slideOffset(g, 3, 100, 10)).toBe(30);
  expect(slideOffset(g, 9, 100, 10)).toBe(90);
  expect(slideOffset(g, 40, 100, 10)).toBe(90); // dragged past the bottom of the track
  expect(slideOffset(g, -5, 100, 10)).toBe(0); // and above the top
  // a thumb painted mid-track slides from where it is, not from the top
  const mid = scrollbarGeom(5, 10, 10, 100, 10, 30);
  expect(slideOffset(mid, 1, 100, 10)).toBe(40);
  expect(slideOffset(mid, -1, 100, 10)).toBe(20);
  // nothing to scroll → always 0
  expect(slideOffset(scrollbarGeom(5, 10, 10, 8, 10, 0), 4, 8, 10)).toBe(0);
});

test("one thumb zone per overflowing panel, each in its painter's scrollbar column", () => {
  const s = busy();
  const rows = treeRows(s);
  const hits = scrollThumbHits(L, "code", s, THEME, NOW, rows);
  expect(hits.length).toBe(3);
  const xs = hits.map((h) => h.rect.x).sort((a, b) => a - b);
  const M = L.messages, F = L.files!, C = L.code;
  expect(xs).toEqual([F.x + F.w - 3, C.x + C.w - 6, M.x + M.w - 3].sort((a, b) => a - b)); // files & messages: inner right edge; code: left of the 3-wide rail
  for (const h of hits) { expect(h.rect.w).toBe(1); expect(h.rect.h).toBeGreaterThan(0); expect(typeof h.onDrag).toBe("function"); }
  // nothing overflowing → no zones
  expect(scrollThumbHits(L, "code", makeState(), THEME, NOW, treeRows(makeState())).length).toBe(0);
});

test("press on the messages thumb grabs it; drag rows scroll; the bottom re-sticks; release lets go", () => {
  const s = busy();
  const spy = spyCtx(L);
  spy.ctx.hits = scrollThumbHits(L, "code", s, THEME, NOW, treeRows(s));
  const M = L.messages;
  const thumb = spy.ctx.hits.find((h) => h.rect.x === M.x + M.w - 3)!;
  const y0 = thumb.rect.y;
  press(s, spy, mouse(0, thumb.rect.x, y0), NOW); // left press on the thumb
  expect(spy.ctx.drag.zone).toBe(thumb);
  expect(spy.ctx.drag.y0).toBe(y0);
  const before = s.msgScroll;
  press(s, spy, mouse(32, thumb.rect.x, y0 + 2), NOW); // b=32: left button held, motion
  expect(s.msgScroll).toBeGreaterThan(before);
  expect(s.stick).toBe(false);
  press(s, spy, mouse(32, thumb.rect.x, y0 + 200), NOW); // way past the end → clamps to max, follows the tail again
  expect(s.stick).toBe(true);
  press(s, spy, mouse(0, thumb.rect.x, y0 + 200, false), NOW); // release
  expect(spy.ctx.drag.zone).toBeNull();
  const after = s.msgScroll;
  press(s, spy, mouse(32, thumb.rect.x, y0 - 3), NOW); // a drag with nothing grabbed does nothing
  expect(s.msgScroll).toBe(after);
});

test("the files thumb drags the window and pulls the cursor along; the code thumb writes code.scroll", () => {
  const s = busy();
  const spy = spyCtx(L);
  spy.ctx.hits = scrollThumbHits(L, "code", s, THEME, NOW, treeRows(s));
  const F = L.files!, C = L.code;
  const files = spy.ctx.hits.find((h) => h.rect.x === F.x + F.w - 3)!;
  press(s, spy, mouse(0, files.rect.x, files.rect.y), NOW);
  press(s, spy, mouse(32, files.rect.x, files.rect.y + 5), NOW);
  expect(s.files.scroll).toBeGreaterThan(0);
  expect(s.files.cursor).toBeGreaterThanOrEqual(s.files.scroll); // the painter would otherwise snap scroll back to the cursor
  expect(s.files.cursor).toBeLessThan(s.files.scroll + F.h - 2);
  press(s, spy, mouse(0, files.rect.x, files.rect.y + 5, false), NOW);
  const code = spy.ctx.hits.find((h) => h.rect.x === C.x + C.w - 6)!;
  press(s, spy, mouse(0, code.rect.x, code.rect.y), NOW);
  press(s, spy, mouse(32, code.rect.x, code.rect.y + 4), NOW);
  expect(s.code.scroll).toBeGreaterThan(0);
  expect(s.code.scroll).toBeLessThanOrEqual(400 - (C.h - 2));
});

test("a press on a zone without onDrag clears any grab, so a stale thumb never keeps scrolling", () => {
  const s = busy();
  const spy = spyCtx(L);
  const thumb = scrollThumbHits(L, "code", s, THEME, NOW, treeRows(s))[0]!;
  spy.ctx.hits = [thumb, { rect: { x: 2, y: 2, w: 5, h: 1 }, onClick: () => {} }];
  press(s, spy, mouse(0, thumb.rect.x, thumb.rect.y), NOW);
  expect(spy.ctx.drag.zone).toBe(thumb);
  press(s, spy, mouse(0, thumb.rect.x, thumb.rect.y, false), NOW);
  press(s, spy, mouse(0, 3, 2), NOW);
  expect(spy.ctx.drag.zone).toBeNull();
});
