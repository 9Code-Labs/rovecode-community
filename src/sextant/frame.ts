/** Sextant headless frame (port #41): paint every panel onto a ScreenLike and dump it as text — the
 *  deterministic golden-test seam (DumpFrame). Ported from the user's sextant v0.4.0 app.js:223-242
 *  (render(): layout → drawFrame → staggered panel reveal → toasts) and tools/snap.js (headless
 *  dumps). Layout and the panel painters arrive as dependencies: #40's layout.ts and #42/#45's
 *  code/messages/pet painters plug in here; until they do, `layoutFallback` (the same breakpoint
 *  math) and empty titled boxes keep the frame renderable. No timers, no clocks — `now` is a parameter. */

import { GridScreen } from "./grid.ts";
import { drawFiles, drawFrame, drawToasts } from "./draw-frame.ts";
import { drawPlan, drawUsage } from "./draw-plan.ts";
import { panel } from "./layout.ts";
import { pruneToasts } from "./model.ts";
import type { DumpFrame, Layout, LayoutOptions, Rect, ScreenLike, SextantState, Theme } from "./types.ts";
import { mainPage } from "./draw-tabs.ts";

export type Painter = (scr: ScreenLike, rect: Rect, s: SextantState, theme: Theme, now: number) => void;
export interface Painters { frame: Painter; files: Painter; code: Painter; messages: Painter; plan: Painter; usage: Painter; pet: Painter }
export type LayoutFn = (w: number, h: number, opts: LayoutOptions) => Layout;
export interface FrameDeps {
  /** #40 layout(); layoutFallback when absent */
  layout?: LayoutFn;
  /** overrides per panel; a missing painter draws an empty titled box */
  painters?: Partial<Painters>;
  layoutOpts?: LayoutOptions;
}

/** boot reveal (app.js render()): panels appear in 90 ms steps after bootAt */
export const REVEAL_STEP_MS = 90;

const placeholder = (title: string): Painter => (scr, rect, _s, theme) => { panel(scr, rect, title, false, [], theme); };
export const defaultPainters: Painters = {
  frame: (scr, rect, s, theme, now) => drawFrame(scr, { frame: rect }, s, theme, now),
  files: drawFiles,
  code: placeholder("code"),
  messages: placeholder("messages"),
  plan: drawPlan,
  usage: drawUsage,
  pet: placeholder("rovecode"),
};

/** app.js layout(): files column at w ≥ 140 (30 wide at ≥ 150, else 26); right column (plan + usage)
 *  at w ≥ 110 (34 / 28); messages = max(8, round(contentH · 0.34)); usage 5 rows; pet 14 rows when
 *  contentH ≥ 36 — under files when present, else carved out of plan. */
export function layoutFallback(W: number, H: number, opts: LayoutOptions): Layout {
  const x0 = 2, x1 = W - 4, y0 = 1, y1 = H - 2;
  const showFiles = W >= 140, showRight = W >= 110;
  const filesW = showFiles ? (W >= 150 ? 30 : 26) : 0;
  const rightW = showRight ? (W >= 150 ? 34 : 28) : 0;
  const contentH = y1 - y0 + 1;
  const files: Rect | null = showFiles ? { x: x0, y: y0, w: filesW, h: contentH } : null;
  const rightX = x1 - rightW + 1;
  const cx = x0 + (showFiles ? filesW + 1 : 0);
  const cw = (showRight ? rightX - 1 : x1 + 1) - cx;
  const msgH = Math.max(8, Math.round(contentH * 0.34));
  const code: Rect = { x: cx, y: y0, w: cw, h: contentH - msgH };
  const messages: Rect = { x: cx, y: y0 + code.h, w: cw, h: msgH };
  let plan: Rect | null = null, usage: Rect | null = null, pet: Rect | null = null;
  if (showRight) {
    const usageH = 5;
    plan = { x: rightX, y: y0, w: rightW, h: contentH - usageH };
    usage = { x: rightX, y: y0 + plan.h, w: rightW, h: usageH };
  }
  const petH = opts.pet && contentH >= 36 ? 14 : 0;
  if (petH && files) { files.h = contentH - petH; pet = { x: x0, y: y0 + files.h, w: filesW, h: petH }; }
  else if (petH && plan) { plan.h -= petH; pet = { x: rightX, y: y0 + plan.h, w: rightW, h: petH }; }
  return { w: W, h: H, frame: { x: 0, y: 0, w: W - 1, h: H }, files, code, messages, plan, usage, pet };
}

/** Paint one frame onto `scr` (the real Screen or a GridScreen); returns the layout used. */
export function renderFrame(scr: ScreenLike, s: SextantState, theme: Theme, now: number, deps: FrameDeps = {}): Layout {
  const P: Painters = { ...defaultPainters };
  for (const k of Object.keys(P) as (keyof Painters)[]) { const p = deps.painters?.[k]; if (p) P[k] = p; }
  const L = (deps.layout ?? layoutFallback)(scr.w, scr.h, deps.layoutOpts ?? { pet: true });
  pruneToasts(s, now);
  const age = now - s.bootAt;
  P.frame(scr, L.frame, s, theme, now);
  if (L.files && age >= 0) P.files(scr, L.files, s, theme, now);
  // paging (draw-tabs.ts): on a narrow terminal the main slot shows the panel `s.page` names when
  // the layout hid it; the tab strip itself is painted by the frame loop after the panels
  const main = mainPage(L, s);
  if (age >= REVEAL_STEP_MS) {
    if (main === "files") P.files(scr, L.code, s, theme, now);
    else if (main === "plan") P.plan(scr, L.code, s, theme, now);
    else P.code(scr, L.code, s, theme, now);
  }
  if (age >= REVEAL_STEP_MS * 2) P.messages(scr, L.messages, s, theme, now);
  if (L.plan && age >= REVEAL_STEP_MS * 3) P.plan(scr, L.plan, s, theme, now);
  if (L.usage && age >= REVEAL_STEP_MS * 4) P.usage(scr, L.usage, s, theme, now);
  if (L.pet && age >= REVEAL_STEP_MS * 5) P.pet(scr, L.pet, s, theme, now);
  drawToasts(scr, s, theme, now);
  return L;
}

/** Headless text frame at a fixed clock — identical input, identical output; creates no timers. */
export function dumpFrame(s: SextantState, cols: number, rows: number, now: number, theme: Theme, deps: FrameDeps = {}): string {
  const scr = new GridScreen(cols, rows, theme.bg);
  renderFrame(scr, s, theme, now, deps);
  return scr.toText();
}
/** compile-time proof that dumpFrame satisfies the contract seam */
export const dumpFrameSeam: DumpFrame = dumpFrame;
