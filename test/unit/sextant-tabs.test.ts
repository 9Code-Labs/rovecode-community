/** draw-tabs.ts + the paging it drives — Berkay's "paneller sekme olsun". On a narrow terminal the
 *  layout hides files (< 140 cols) and plan (< 110), and until now a hidden panel was simply gone;
 *  ⌃e answered "the files panel needs ≥ 140 columns". Now the main slot pages between them, with a
 *  clickable strip on its border. These pin: no strip when everything fits, the strip's content and
 *  order when it does not, click → page, ⌃o cycles, ⌃e pages files in, Tab reaches files once paged,
 *  and a click in the main slot focuses whatever is showing there. */

import { test, expect } from "bun:test";
import { drawTabs, hiddenByLayout, mainPage, nextPage, tabsFor } from "../../src/sextant/draw-tabs.ts";
import { focusOrder, type HitZone } from "../../src/sextant/keys.ts";
import { GridScreen } from "../../src/sextant/grid.ts";
import type { SextantState } from "../../src/sextant/types.ts";
import { makeState, makeLayout, spyCtx, ctrl, key, mouse, press, THEME } from "../helpers/sextant-fixtures-keys.ts";

const WIDE = makeLayout(160, 44);   // files + plan columns both on screen
const NARROW = makeLayout(100, 30); // neither: 100 < 110 hides plan, < 140 hides files

/** the zones the frame loop registers for the strip */
const tabZones = (L: typeof WIDE, s: SextantState): HitZone[] =>
  tabsFor(L, s).map((t) => ({ rect: t.rect, onClick: () => { s.page = t.page; s.focus = t.page === "files" ? "files" : "code"; } }));

test("a wide terminal has nothing to page: no tabs, main slot is code whatever page says", () => {
  const s = makeState();
  expect(tabsFor(WIDE, s)).toEqual([]);
  expect(hiddenByLayout(WIDE, "files")).toBe(false);
  s.page = "files";
  expect(mainPage(WIDE, s)).toBe("code"); // inert, never a duplicate files panel
  expect(nextPage(WIDE, s)).toBe("files"); // nothing to cycle to
});

test("a narrow terminal gets code · files · plan on the main slot's top border, code active", () => {
  const s = makeState();
  const tabs = tabsFor(NARROW, s);
  expect(tabs.map((t) => t.page)).toEqual(["code", "files", "plan"]);
  expect(tabs.map((t) => t.active)).toEqual([true, false, false]);
  expect(new Set(tabs.map((t) => t.rect.y))).toEqual(new Set([NARROW.code.y]));
  expect(tabs[0]!.rect.x).toBe(NARROW.code.x + 2); // over the title, panel() draws it at x+2
  // left to right, no overlap
  expect(tabs[0]!.rect.x + tabs[0]!.rect.w).toBeLessThan(tabs[1]!.rect.x);
  expect(tabs[1]!.rect.x + tabs[1]!.rect.w).toBeLessThan(tabs[2]!.rect.x);
});

test("between 110 and 140 columns only files is hidden: the strip is code · files", () => {
  const L = makeLayout(120, 40);
  expect(L.plan).not.toBeNull();
  expect(L.files).toBeNull();
  expect(tabsFor(L, makeState()).map((t) => t.page)).toEqual(["code", "files"]);
});

test("the strip paints the labels it reports zones for", () => {
  const s = makeState({ page: "files" });
  const scr = new GridScreen(100, 30, THEME.bg);
  const tabs = drawTabs(scr, NARROW, s, THEME);
  const row = scr.toText().split("\n")[NARROW.code.y]!;
  // toText() trims trailing blanks, so the last label is matched without its trailing pad
  expect(row).toContain(" code ");
  expect(row).toContain(" files ");
  expect(row).toContain(" plan");
  expect(row.indexOf("code")).toBeLessThan(row.indexOf("files"));
  expect(row.indexOf("files")).toBeLessThan(row.indexOf("plan"));
  expect(tabs.find((t) => t.active)?.page).toBe("files");
});

test("clicking a tab pages to it and moves focus with it", () => {
  const s = makeState(), spy = spyCtx(NARROW);
  spy.ctx.hits = tabZones(NARROW, s);
  const files = spy.ctx.hits[1]!.rect;
  press(s, spy, mouse(0, files.x + 1, files.y));
  expect(s.page).toBe("files");
  expect(s.focus).toBe("files");
  expect(mainPage(NARROW, s)).toBe("files");
  spy.ctx.hits = tabZones(NARROW, s);
  const plan = spy.ctx.hits[2]!.rect;
  press(s, spy, mouse(0, plan.x, plan.y));
  expect(s.page).toBe("plan");
  expect(s.focus).toBe("code"); // plan has no focus of its own; the main slot's focus stays usable
});

test("⌃o cycles code → files → plan → code on a narrow terminal and does nothing on a wide one", () => {
  const s = makeState(), spy = spyCtx(NARROW);
  press(s, spy, ctrl("o")); expect(s.page).toBe("files"); expect(s.focus).toBe("files");
  press(s, spy, ctrl("o")); expect(s.page).toBe("plan");
  press(s, spy, ctrl("o")); expect(s.page).toBe("code"); expect(s.focus).toBe("code");
  const w = makeState(), wspy = spyCtx(WIDE);
  press(w, wspy, ctrl("o"));
  expect(w.page).toBe("code");
});

test("⌃e on a narrow terminal pages files in instead of refusing with a toast", () => {
  const s = makeState(), spy = spyCtx(NARROW);
  press(s, spy, ctrl("e"));
  expect(s.page).toBe("files");
  expect(s.focus).toBe("files");
  expect(spy.toasts).toEqual([]); // the old "needs ≥ 140 columns" toast is gone
});

test("Tab reaches files once it is paged in, and skips it while hidden", () => {
  expect(focusOrder(NARROW, "code")).toEqual(["messages", "code"]);
  expect(focusOrder(NARROW, "files")).toEqual(["messages", "code", "files"]);
  expect(focusOrder(WIDE, "code")).toEqual(["messages", "code", "files"]);
  const s = makeState({ page: "files", focus: "code" }), spy = spyCtx(NARROW);
  press(s, spy, key("tab"));
  expect(s.focus).toBe("files");
});

test("a click in the main slot focuses whatever is showing there", () => {
  const s = makeState({ page: "files" }), spy = spyCtx(NARROW);
  const c = NARROW.code;
  press(s, spy, mouse(0, c.x + 5, c.y + 5));
  expect(s.focus).toBe("files");
  s.page = "code";
  press(s, spy, mouse(0, c.x + 5, c.y + 5));
  expect(s.focus).toBe("code");
});
