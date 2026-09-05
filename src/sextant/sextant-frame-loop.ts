/** Sextant frame loop (port #44): the ONE interval of the surface. Owns the Screen (#40) over the
 *  TerminalIO, the layout, the per-frame hit zones, the painters wiring (#41 frame/files/plan/usage,
 *  #42 code/messages, #45 pet, #43 suggest/palette/help overlays), the scroll write-backs the pure
 *  #42 painters cannot do, the cursor placement and the input pipeline (parseInput → keys.handleInput).
 *  Ported from the user's sextant v0.4.0 app.js:1599-1632 (the boot: 40 ms tick, paint only when
 *  dirty / animating / every 170 ms, input and resize handlers). No git/fs here — the renderer
 *  schedules its I/O from `onTick`, off the paint path. `clock` is injected: tests drive time. */

import { agentsScrollTop, laneCells } from "./draw-agents.ts";
import { drawCode, codeScrollTop } from "./draw-code.ts";
import { drawMessages, messagesScroll, promptCursor } from "./draw-messages.ts";
import { drawPet } from "./draw-pet.ts";
import { fuzzy, tokenize } from "./engine.ts";
import { renderFrame } from "./frame.ts";
import { parseInput } from "./input.ts";
import { handleInput, type KeyCtx } from "./keys.ts";
import { layout as layoutFn } from "./layout.ts";
import { treeRows } from "./model.ts";
import { drawHelp, drawPalette, drawSuggest, suggestions } from "./overlays.ts";
import { drawMarket } from "./draw-market.ts";
import { drawContext } from "./draw-context.ts";
import { petEnabled, type Pet } from "./pet.ts";
import { Screen } from "./screen.ts";
import { cardHits } from "./card-hits.ts";
import { fileRowHits } from "./panel-hits.ts";
import { followTailIfAtEnd, scrollThumbHits } from "./scroll-hits.ts";
import { frameHits } from "./frame-hits.ts";
import { messageRowHits } from "./message-hits.ts";
import { drawTabs, mainPage } from "./draw-tabs.ts";
import type { HitZone, InputEvent, Layout, SextantState, TerminalIO, Theme, TreeRow } from "./types.ts";

/** the interval (app.js: setInterval(tick, 40)) */
export const FRAME_MS = 40;
/** an idle surface still repaints this often (glyph pulse, pet sway) */
export const IDLE_REPAINT_MS = 170;
/** the suggestion box shows at most this many rows (#43 fix-wave cap) */
export const MAX_SUGGESTIONS = 8;
/** the boot reveal animates for this long after bootAt (5 × 90 ms steps + slack) */
const REVEAL_MS = 600;
/** a chunk that ENDS in a lone ESC is held this long: parseInput reports a lone ESC as Escape at once
 *  (the esc-esc arm needs that), so a sequence split right after its ESC byte would otherwise be typed
 *  as text — the next chunk (or the timer) completes it */
export const ESC_HOLD_MS = 20;

export interface FrameLoopDeps {
  io: TerminalIO;
  clock: () => number;
  state: SextantState;
  theme: () => Theme;
  pet: Pet;
  truecolor: boolean;
  /** RendererHooks + the renderer-owned local effects keys.ts needs */
  keyCtx: () => Pick<KeyCtx, "hooks" | "local">;
  /** renderer-level intercept BEFORE keys.handleInput (picker Enter/Esc, the ⌃c arm); true = swallowed */
  beforeInput?: (ev: InputEvent, now: number) => boolean;
  /** after keys.handleInput ran for `ev` */
  afterInput?: (ev: InputEvent, now: number) => void;
  /** every tick, BEFORE the paint decision — the renderer reloads the code panel's file and schedules
   *  its git/fs work here, so a reload an event asked for lands in the same frame (never a one-frame
   *  `cannot read <file>` between an edit's end and the next tick) */
  onTick?: (now: number) => void;
}

export class FrameLoop {
  private screen: Screen | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubs: (() => void)[] = [];
  private carry = "";
  private held = "";
  private holdTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = true;
  private lastRender = -Infinity;
  private L: Layout;
  private hits: HitZone[] = [];
  /** the grabbed zone (a scrollbar thumb) and the row it was pressed on; outlives the per-frame hits */
  private readonly drag = { zone: null as HitZone | null, y0: 0 };
  private rows: TreeRow[] = [];
  /** frames painted (tests: "a render happened") */
  frames = 0;

  constructor(private readonly d: FrameLoopDeps) {
    const { cols, rows } = d.io.size();
    this.L = layoutFn(cols, rows, this.layoutOpts());
  }

  private layoutOpts(): { pet: boolean } { return { pet: petEnabled(this.d.io.env) }; }
  /** the interval is live */
  get active(): boolean { return this.timer !== null; }
  /** the layout of the last frame (before the first frame: computed from the io size) */
  get layout(): Layout { return this.L; }
  markDirty(): void { this.dirty = true; }
  /** the last painted frame as text (tests/smoke); "" before start() */
  frameText(): string { return this.screen?.toText() ?? ""; }

  /** build the Screen, subscribe input/resize, paint the first frame, start the interval */
  start(): void {
    if (this.timer) return;
    const { cols, rows } = this.d.io.size();
    this.screen = new Screen(this.d.io, cols, rows, { truecolor: this.d.truecolor });
    this.unsubs.push(this.d.io.onInput((chunk) => this.feed(chunk)));
    this.unsubs.push(this.d.io.onResize((c, r) => { this.screen?.resize(c, r); this.dirty = true; }));
    this.timer = setInterval(() => this.tick(), FRAME_MS);
    this.render(this.d.clock());
  }

  /** clear the interval and the ESC-hold timer, unsubscribe; the screen keeps its last frame for frameText() */
  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.holdTimer) { clearTimeout(this.holdTimer); this.holdTimer = null; }
    this.held = "";
    for (const u of this.unsubs) u();
    this.unsubs = [];
  }

  /** raw bytes → events: a chunk ending in a lone ESC waits ESC_HOLD_MS for its continuation; an
   *  incomplete CSI/paste is carried by parseInput into the next chunk */
  feed(chunk: string): void {
    if (this.holdTimer) { clearTimeout(this.holdTimer); this.holdTimer = null; }
    const data = this.held + chunk;
    this.held = "";
    if (data.endsWith("\x1b")) {
      this.held = data;
      this.holdTimer = setTimeout(() => { this.holdTimer = null; this.flushInput(); }, ESC_HOLD_MS);
      return;
    }
    this.parse(data);
  }
  /** parse the held bytes now (the hold timer fired, or a test wants determinism) */
  flushInput(): void {
    if (this.holdTimer) { clearTimeout(this.holdTimer); this.holdTimer = null; }
    const data = this.held;
    this.held = "";
    if (data) this.parse(data);
  }
  private parse(data: string): void {
    const r = parseInput(data, this.carry);
    this.carry = r.rest;
    for (const ev of r.events) this.dispatch(ev);
    // Paint the result of this chunk NOW rather than waiting for the next 40 ms tick. A keystroke was
    // always handled immediately, but its echo waited for the timer — invisible on an idle machine, and
    // on a loaded one, where setInterval is starved, it is the difference between a responsive prompt
    // and one that appears to have stopped accepting input. This costs no extra frame: the tick would
    // have painted the same state a moment later, and it clears `dirty` so the tick then skips.
    // Once per CHUNK, not once per event, so a paste of two hundred characters still paints once.
    if (this.screen && r.events.length > 0) this.render(this.d.clock());
  }

  dispatch(ev: InputEvent): void {
    const now = this.d.clock();
    this.dirty = true;
    if (this.d.beforeInput?.(ev, now)) return;
    const kc = this.d.keyCtx();
    const ctx: KeyCtx = { layout: this.L, hooks: kc.hooks, local: kc.local, hits: this.hits, rows: this.rows, fuzzy, drag: this.drag };
    handleInput(this.d.state, ev, ctx, now);
    this.d.afterInput?.(ev, now);
  }

  /** something on screen moves by itself: spinners, a waiting card, toasts, touched files, the esc arm, the pet, the boot reveal */
  animating(now: number): boolean {
    const s = this.d.state;
    return s.running || s.card !== null || s.toasts.length > 0 || s.files.touched.size > 0 || now < s.escUntil
      || this.d.pet.animating(now) || now - s.bootAt < REVEAL_MS;
  }

  tick(): void {
    const now = this.d.clock();
    this.d.onTick?.(now); // first: a reload marks dirty and paints below, in this very frame
    if (this.dirty || this.animating(now) || now - this.lastRender >= IDLE_REPAINT_MS) this.render(now);
  }

  /** paint one frame: panels (renderFrame) → suggestion box → palette → help → scroll write-backs → cursor → flush */
  render(now: number): void {
    const scr = this.screen;
    if (!scr) return;
    const s = this.d.state, theme = this.d.theme(), pet = this.d.pet;
    scr.begin(theme.bg);
    this.rows = treeRows(s, now); // the same (version, now) key drawFiles uses → one build per frame (model.ts cache)
    const hits: HitZone[] = [];
    const L = renderFrame(scr, s, theme, now, {
      layout: layoutFn,
      layoutOpts: this.layoutOpts(),
      painters: {
        code: (g, r, st, th, t) => drawCode(g, r, st, th, t, { tokenize }),
        messages: drawMessages,
        pet: (g, r, st, th, t) => drawPet(g, r, pet, st, th, t),
      },
    });
    this.L = L;
    if (L.pet) hits.push({ rect: L.pet, onClick: () => pet.poke(this.d.clock()) });
    // the frame's border rows (frame-hits.ts): unread badge → notices, theme name → next theme, effort → /effort
    for (const z of frameHits(L.frame, s, theme, now)) hits.push(z);
    // paging (draw-tabs.ts): on a narrow terminal the main slot may be showing files or plan instead
    // of code; the strip is painted over the slot's top border and each tab is a click zone
    const main = mainPage(L, s);
    for (const t of drawTabs(scr, L, s, theme)) {
      hits.push({ rect: t.rect, onClick: () => { s.page = t.page; s.focus = t.page === "files" ? "files" : "code"; } });
    }
    // the body rect drawCode hands its mode painter (inner rect minus the 3-wide rail and its gutter)
    const body = { x: L.code.x + 2, y: L.code.y + 1, w: L.code.w - 9, h: L.code.h - 2 };
    if (main === "code" && s.code.mode === "agents" && !s.code.laneOpen) {
      for (const { index, rect } of laneCells(body, s).cells) hits.push({ rect, onClick: () => { s.code.lane = index; s.focus = "code"; } });
    }
    // the files tree rows (panel-hits.ts): click = select + Enter, i.e. fold a dir / open a file.
    // The rows live in the files panel, or in the main slot when files is paged in there.
    const filesRect = L.files ?? (main === "files" ? L.code : null);
    for (const hit of fileRowHits(filesRect, s, this.rows)) {
      hits.push({
        rect: hit.rect,
        onClick: () => { s.focus = "files"; s.files.cursor = hit.index; },
        key: { type: "key", name: "enter" },
      });
    }
    // scrollbar thumbs (scroll-hits.ts): grab + drag scrolls; after the row zones so the thumb column wins
    for (const hit of scrollThumbHits(L, main, s, theme, now, this.rows)) hits.push(hit);
    followTailIfAtEnd(L, s, theme, now); // scrolled back to the end → follow new text again
    // tool rows that name a file (message-hits.ts): click = open it in the code panel, like /open
    for (const hit of messageRowHits(L.messages, s, theme, now)) hits.push({ rect: hit.rect, onClick: () => this.d.keyCtx().local.openFile(hit.path) });
    // the modal card's buttons (card-hits.ts). Registered BEFORE the palette/help so those overlays,
    // which draw over the card, still win the last-registered-wins walk in keys.ts.
    for (const hit of cardHits(L.messages, s, theme)) {
      hits.push({
        rect: hit.rect,
        onClick: () => { if (s.card) s.card.selected = hit.index; },
        // a click on a labelled button IS the decision; the free-text row only takes the caret
        ...(hit.confirm ? { key: { type: "key" as const, name: "enter" } } : {}),
      });
    }
    drawSuggest(scr, L.messages, s, suggestions(s, s.files.paths, fuzzy).slice(0, MAX_SUGGESTIONS), theme, hits);
    const paletteCursor = drawPalette(scr, L, theme, s, fuzzy, hits);
    const marketCursor = drawMarket(scr, L, theme, s, fuzzy, hits);
    const contextCursor = drawContext(scr, L, theme, s, hits);
    if (s.help) drawHelp(scr, L, theme, s, hits);
    this.hits = hits;
    // the #42/#46 seams: the painters are pure, so the effective scroll positions are written back here
    // (codeScrollTop counts 0 rows in agents mode and would pin the open lane to its top)
    s.code.scroll = s.code.mode === "agents" ? agentsScrollTop(body, s) : codeScrollTop(L.code, s);
    s.msgScroll = messagesScroll(L.messages, s, theme, now).offset;
    scr.flush(s.palette ? paletteCursor : s.market ? marketCursor : s.context ? contextCursor : s.help ? null : promptCursor(L.messages, s));
    this.dirty = false;
    this.lastRender = now;
    this.frames++;
  }
}
