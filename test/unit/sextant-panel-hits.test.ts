/** panel-hits.ts — clicking a files-tree row. Before this a click in the files panel only moved focus
 *  there; the row under the pointer was ignored. These pin the row geometry against drawFiles's, then
 *  drive a real click through handleInput: a directory folds, a file opens — the same two things Enter
 *  does, so clicking can never do more than the keyboard could. */

import { test, expect } from "bun:test";
import { fileRowHits } from "../../src/sextant/panel-hits.ts";
import { treeRows } from "../../src/sextant/model.ts";
import type { HitZone } from "../../src/sextant/keys.ts";
import type { SextantState } from "../../src/sextant/types.ts";
import { makeState, makeLayout, spyCtx, mouse, press } from "../helpers/sextant-fixtures-keys.ts";

const L = makeLayout(160, 44); // wide enough for the files panel

/** the zones exactly as the frame loop registers them */
const zones = (s: SextantState): HitZone[] => {
  const rows = treeRows(s);
  return fileRowHits(L.files, s, rows).map((h) => ({
    rect: h.rect,
    onClick: () => { s.focus = "files"; s.files.cursor = h.index; },
    key: { type: "key" as const, name: "enter" },
  }));
};

test("one zone per visible row, top to bottom, the full inner width, starting at files.scroll", () => {
  const s = makeState();
  const rows = treeRows(s);
  const hits = fileRowHits(L.files, s, rows);
  expect(hits.length).toBe(Math.min(rows.length, L.files!.h - 2));
  expect(hits.map((h) => h.index)).toEqual(hits.map((_, i) => i));
  expect(hits[0]!.rect.y).toBe(L.files!.y + 1);
  expect(hits[1]!.rect.y).toBe(hits[0]!.rect.y + 1);
  expect(hits[0]!.rect.w).toBe(L.files!.w - 4);
  // scrolled: the first zone is the first VISIBLE row
  s.files.scroll = 1;
  expect(fileRowHits(L.files, s, rows)[0]!.index).toBe(1);
});

test("no files panel (narrow layout) or an empty tree yields no zones", () => {
  const s = makeState();
  expect(fileRowHits(null, s, treeRows(s))).toEqual([]);
  expect(fileRowHits(L.files, makeState({ files: { ...s.files, paths: [] } }), [])).toEqual([]);
});

test("clicking a directory row folds it open, and clicking again folds it shut", () => {
  const s = makeState(), spy = spyCtx(L);
  const rows = treeRows(s);
  const dirIdx = rows.findIndex((r) => r.dir);
  expect(dirIdx).toBeGreaterThanOrEqual(0);
  const dir = rows[dirIdx]!;
  spy.ctx.hits = zones(s); spy.ctx.rows = rows;
  const z = spy.ctx.hits[dirIdx]!.rect;
  press(s, spy, mouse(0, z.x + 3, z.y));
  expect(s.focus).toBe("files");
  expect(s.files.cursor).toBe(dirIdx);
  expect(s.files.expanded.has(dir.path)).toBe(true);
  // the tree grew; rebuild the zones as the next frame would, then click the same dir again
  const rows2 = treeRows(s);
  spy.ctx.hits = zones(s); spy.ctx.rows = rows2;
  const again = spy.ctx.hits[rows2.findIndex((r) => r.path === dir.path)]!.rect;
  press(s, spy, mouse(0, again.x, again.y));
  expect(s.files.expanded.has(dir.path)).toBe(false);
});

test("clicking a file row opens that file — not the row the cursor was on", () => {
  const s = makeState(), spy = spyCtx(L);
  const rows = treeRows(s);
  const fileIdx = rows.findIndex((r) => !r.dir);
  expect(fileIdx).toBeGreaterThanOrEqual(0);
  s.files.cursor = 0; // somewhere else
  spy.ctx.hits = zones(s); spy.ctx.rows = rows;
  const z = spy.ctx.hits[fileIdx]!.rect;
  press(s, spy, mouse(0, z.x + z.w - 1, z.y)); // the last cell of the row still counts
  expect(spy.opened).toEqual([rows[fileIdx]!.path]);
  expect(s.files.cursor).toBe(fileIdx);
});
