/** frame-hits.ts — the outer frame's border rows answer clicks: the unread badge opens the notices (⌃b),
 *  the theme word in the footer tag cycles the theme (⌃t), `effort X` prefills `/effort `. The zones are
 *  located with the painter's own segment math, so each test first proves the zone covers exactly the
 *  word painted there, then drives a real click through handleInput. */

import { test, expect } from "bun:test";
import { renderFrame } from "../../src/sextant/frame.ts";
import { frameHits } from "../../src/sextant/frame-hits.ts";
import { notify, setUsage } from "../../src/sextant/model.ts";
import type { Rect, SextantState } from "../../src/sextant/types.ts";
import { makeState, makeLayout, spyCtx, mouse, press } from "../helpers/sextant-fixtures-keys.ts";
import { GridScreen } from "../helpers/sextant-grid.ts";
import { nightTheme } from "../helpers/sextant-theme-41.ts";

const theme = nightTheme();
const NOW = 10_000_000;
/** the frame painted on a cell grid — read back by cell, not by string index (a wide glyph in the row
 *  would shift a string slice by one). The zones take the REAL layout's frame: at 160 columns it is
 *  159 wide (the last column is left alone), which the makeLayout fixture does not model. */
const paint = (s: SextantState): { g: GridScreen; F: Rect } => { const g = new GridScreen(160, 44); const L = renderFrame(g, s, theme, NOW, {}); return { g, F: L.frame }; };
const word = (g: GridScreen, r: Rect): string => g.span(r.x, r.y, r.w);

test("each zone sits exactly on the word it reads: `◆ 1` in the header, `effort high` and `night` in the footer", () => {
  const s = makeState();
  setUsage(s, { provider: "anthropic", model: "claude-x", effort: "high" });
  notify(s, "run done", NOW, "info", "done");
  const { g, F } = paint(s);
  const hits = frameHits(F, s, theme, NOW);
  expect(hits.map((h) => word(g, h.rect))).toEqual(["◆ 1", "effort high", "night"]);
  // plan mode + auto push the tag left; the zones follow
  s.mode = "plan"; s.yolo = true;
  const p2 = paint(s);
  expect(frameHits(p2.F, s, theme, NOW).map((h) => word(p2.g, h.rect))).toEqual(["◆ 1", "effort high", "night"]);
});

test("no unread notice and no reported effort → only the theme zone remains", () => {
  const s = makeState();
  setUsage(s, { provider: "p", model: "m" });
  const { g, F } = paint(s);
  const hits = frameHits(F, s, theme, NOW);
  expect(hits).toHaveLength(1);
  expect(word(g, hits[0]!.rect)).toBe("night");
});

test("clicks: the badge opens the notices and clears the unread count; effort prefills `/effort `; the theme word cycles the theme", () => {
  const s = makeState();
  setUsage(s, { provider: "anthropic", model: "claude-x", effort: "auto" });
  notify(s, "needs you: edit", NOW, "warn", "approval");
  const spy = spyCtx(makeLayout(160, 44));
  spy.ctx.hits = frameHits(paint(s).F, s, theme, NOW);
  const [badge, effort, th] = spy.ctx.hits.map((h) => h.rect) as [Rect, Rect, Rect];
  press(s, spy, mouse(0, badge.x, badge.y), NOW);
  expect(s.palette).not.toBeNull();
  expect(s.notices.every((n) => n.read)).toBe(true);
  s.palette = null;
  press(s, spy, mouse(0, effort.x + 2, effort.y), NOW);
  expect(s.input.text).toBe("/effort ");
  expect(s.input.cur).toBe(8);
  expect(s.focus).toBe("messages");
  press(s, spy, mouse(0, th.x, th.y), NOW);
  expect(spy.themes).toEqual(["ember"]); // night → ember (THEME_ORDER), the same as ⌃t
});
