/** The tab strip: paging between panels the terminal is too narrow to show at once.
 *
 *  layout.ts hides the files panel under 140 columns and the plan/usage column under 110, and until
 *  now a hidden panel was simply gone — ⌃e answered "the files panel needs ≥ 140 columns" and that was
 *  that. Berkay asked for the panels to behave like tabs instead: on a narrow terminal the MAIN slot
 *  (the code panel's rect) shows whichever panel `s.page` names, and a strip on that slot's top border
 *  says which panels exist and which one is showing. Clicking a tab pages to it; ⌃e pages to files,
 *  ⌃o cycles.
 *
 *  Deliberately absent on a wide terminal: when every panel is on screen there is nothing to page,
 *  and a strip would be one more thing to read. tabsFor() returns [] and nothing is drawn.
 *
 *  Geometry and painting live together here so the hit zones the frame loop registers are the cells
 *  that were actually painted — the same rule card-hits.ts and panel-hits.ts follow. The strip
 *  overpaints the panel title on the top border (panel() draws the title at x+2); the active tab IS
 *  the title. */

import { st } from "./draw-util.ts";
import { strWidth } from "./screen.ts";
import { ATTR, PAGES, type Layout, type Page, type Rect, type ScreenLike, type SextantState, type Theme } from "./types.ts";

export interface Tab {
  page: Page;
  /** the cells the label occupies on the border row */
  rect: Rect;
  active: boolean;
}

const LABEL: Record<Page, string> = { code: "code", files: "files", plan: "plan" };
const SEP = " · ";

/** is this page's own panel hidden by the layout, so it needs a tab to be reachable? */
export function hiddenByLayout(L: Layout, page: Page): boolean {
  return page === "files" ? L.files === null : page === "plan" ? L.plan === null : false;
}

/** the page actually showing in the main slot: `s.page` if that panel is hidden by the layout (so
 *  paging is what makes it visible), else code — a page pointing at a panel that is already on
 *  screen is inert, never a duplicate */
export function mainPage(L: Layout, s: SextantState): Page {
  return hiddenByLayout(L, s.page) ? s.page : "code";
}

/** The tabs to show, positioned on the main slot's top border; [] on a wide terminal. */
export function tabsFor(L: Layout, s: SextantState): Tab[] {
  const hidden = PAGES.filter((p) => hiddenByLayout(L, p));
  if (hidden.length === 0) return [];
  const pages: Page[] = ["code", ...hidden];
  const active = mainPage(L, s);
  const y = L.code.y;
  const right = L.code.x + L.code.w - 2; // the border's last usable cell before the corner
  let x = L.code.x + 2;
  const out: Tab[] = [];
  for (const [i, page] of pages.entries()) {
    const w = strWidth(LABEL[page]) + 2; // ` label `
    if (x + w > right) break;           // a strip the border cannot hold stops, never wraps
    out.push({ page, rect: { x, y, w, h: 1 }, active: page === active });
    x += w + (i < pages.length - 1 ? strWidth(SEP) : 0);
  }
  return out;
}

/** Paint the strip over the main slot's top border. Pure; returns what it painted. */
export function drawTabs(scr: ScreenLike, L: Layout, s: SextantState, theme: Theme): Tab[] {
  const tabs = tabsFor(L, s);
  if (tabs.length === 0) return tabs;
  const focused = s.focus === "code" || s.focus === "files";
  for (const [i, t] of tabs.entries()) {
    const style = t.active
      ? st(theme.bg, focused ? theme.accent : theme.fg2, ATTR.BOLD)
      : st(theme.muted);
    scr.text(t.rect.x, t.rect.y, [[` ${LABEL[t.page]} `, style]], t.rect.w);
    const next = tabs[i + 1];
    if (next) scr.text(t.rect.x + t.rect.w, t.rect.y, [[SEP, st(theme.frame)]], next.rect.x - (t.rect.x + t.rect.w));
  }
  return tabs;
}

/** the page after `page` among the tabs on screen (⌃o); `page` itself when there is nothing to cycle */
export function nextPage(L: Layout, s: SextantState): Page {
  const tabs = tabsFor(L, s);
  if (tabs.length < 2) return s.page;
  const i = tabs.findIndex((t) => t.active);
  return tabs[(i + 1) % tabs.length]!.page;
}
