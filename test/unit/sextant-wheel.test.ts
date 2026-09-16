/** The wheel over the files tree and the tail-follow rule. Before this: wheeling the tree moved
 *  files.scroll but drawFiles snapped it straight back to the cursor, so the wheel looked dead; on a
 *  narrow terminal with files paged into the main slot the wheel scrolled the (hidden) code view; and a
 *  conversation scrolled up once never followed new text again until pgdn/end. */

import { test, expect } from "bun:test";
import { followTailIfAtEnd } from "../../src/sextant/scroll-hits.ts";
import { treeRows } from "../../src/sextant/model.ts";
import { makeState, makeLayout, spyCtx, mouse, press } from "../helpers/sextant-fixtures-keys.ts";
import { nightTheme } from "../helpers/sextant-theme-41.ts";

const theme = nightTheme();
const NOW = 10_000_000;

function tall() {
  const s = makeState();
  s.files.paths = Array.from({ length: 120 }, (_, i) => `f${String(i).padStart(3, "0")}.ts`);
  return s;
}

test("wheel over the files panel moves the window, clamps to the rows, and pulls the cursor into view", () => {
  const L = makeLayout(160, 44), s = tall(), spy = spyCtx(L);
  spy.ctx.rows = treeRows(s);
  const h = L.files!.h - 2;
  press(s, spy, mouse(65, L.files!.x + 2, L.files!.y + 2));
  expect(s.files.scroll).toBe(2);
  expect(s.files.cursor).toBe(2); // was 0, above the window → pulled to its first row
  for (let i = 0; i < 100; i++) press(s, spy, mouse(65, L.files!.x + 2, L.files!.y + 2));
  expect(s.files.scroll).toBe(spy.ctx.rows.length - h); // never past the last page (the fixture's status entry adds a collapsed dir row)
  expect(s.files.cursor).toBeGreaterThanOrEqual(s.files.scroll);
  for (let i = 0; i < 100; i++) press(s, spy, mouse(64, L.files!.x + 2, L.files!.y + 2));
  expect(s.files.scroll).toBe(0);
  expect(s.files.cursor).toBeLessThan(h);
});

test("narrow terminal, files paged into the main slot: the wheel there scrolls the tree, not the code view", () => {
  const L = makeLayout(120, 40), s = tall(), spy = spyCtx(L);
  expect(L.files).toBeNull();
  s.page = "files";
  spy.ctx.rows = treeRows(s);
  press(s, spy, mouse(65, L.code.x + 2, L.code.y + 2));
  expect(s.files.scroll).toBe(2);
  expect(s.code.scroll).toBe(0);
  // paged to plan (the right column is gone below 110 columns): the wheel over the slot scrolls nothing
  const L2 = makeLayout(100, 40), spy2 = spyCtx(L2);
  expect(L2.plan).toBeNull();
  s.page = "plan";
  expect(press(s, spy2, mouse(65, L2.code.x + 2, L2.code.y + 2))).toEqual([]);
  expect(s.code.scroll).toBe(0);
});

test("followTailIfAtEnd: a view scrolled up stays put; scrolled back to the end it follows the tail again", () => {
  const L = makeLayout(160, 44), s = makeState();
  for (let i = 0; i < 80; i++) s.messages.push({ kind: "user", text: `line ${i}` });
  s.stick = false; s.msgScroll = 0; // scrolled to the very top
  followTailIfAtEnd(L, s, theme, NOW);
  expect(s.stick).toBe(false);
  s.msgScroll = 10_000; // wheeled/dragged past the end
  followTailIfAtEnd(L, s, theme, NOW);
  expect(s.stick).toBe(true);
  expect(s.msgScroll).toBeLessThan(10_000); // clamped to max
  // nothing to scroll at all → follows
  const short = makeState(); short.stick = false; short.msgScroll = 0;
  followTailIfAtEnd(L, short, theme, NOW);
  expect(short.stick).toBe(true);
});
