/** Sextant frame loop (port #44): the ONE timer of the surface. Owns the Screen (#40) over the
 *  TerminalIO, the layout, the per-frame hit zones, the painters wiring (#41 frame/files/plan/usage,
 *  #42 code/messages, #45 pet, #43 suggest/palette/help overlays), the scroll write-backs the pure
 *  #42 painters cannot do, the cursor placement and the input pipeline (parseInput → keys.handleInput).
 *  Ported from the user's sextant v0.4.0 app.js:1599-1632 (the boot: 40 ms tick, paint only when
 *  dirty / animating / every 170 ms, input and resize handlers; idle, the timer now sleeps until the next ambient change — see the class note). No git/fs here — the renderer
 *  schedules its I/O from `onTick`, off the paint path. `clock` is injected: tests drive time. */

import { agentsScrollTop, laneCells } from "./draw-agents.ts";
import { drawCode, codeScrollTop } from "./draw-code.ts";
import { drawMessages, messagesScroll, promptCursor } from "./draw-messages.ts";
import { drawPet, SWAY_MS } from "./draw-pet.ts";
import { fuzzy, tokenize } from "./engine.ts";
import { renderFrame } from "./frame.ts";
import { parseInput } from "./input.ts";
import { handleInput, type KeyCtx } from "./keys.ts";
import { layout as layoutFn } from "./layout.ts";
import { treeRows } from "./model.ts";
import { drawHelp, drawPalette, drawSuggest, suggestions } from "./overlays.ts";
import { drawMarket } from "./draw-market.ts";
import { drawWizard } from "./draw-wizard.ts";
import { drawContext } from "./draw-context.ts";
import { petEnabled, type Pet } from "./pet.ts";
import { Screen } from "./screen.ts";
import { TextSelection } from "./selection.ts";
import { mix } from "./theme.ts";
import { cardHits } from "./card-hits.ts";
import { fileRowHits } from "./panel-hits.ts";
import { followTailIfAtEnd, scrollThumbHits } from "./scroll-hits.ts";
import { frameHits } from "./frame-hits.ts";
import { messageRowHits } from "./message-hits.ts";
import { drawTabs, mainPage } from "./draw-tabs.ts";
import type { HitZone, InputEvent, Layout, SextantState, TerminalIO, Theme, TreeRow } from "./types.ts";

/** the frame period while something moves (app.js: setInterval(tick, 40)) */
export const FRAME_MS = 40;
/** a tick repaints a frame older than this even when nothing asked (tests drive the clock and tick by hand) */
export const IDLE_REPAINT_MS = 170;
/** the loop never sleeps longer than this: the repo's idle scan and the pet's due hum ride on the tick */
export const IDLE_TICK_MS = 2000;
/** the idle header glyph steps through its four colours every 500 ms (draw-frame.ts activityGlyph) */
export const PULSE_MS = 500;
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

/** The loop is one re-armed setTimeout, not a setInterval. Its period is FRAME_MS while something MOVES
 *  (a spinner, a storm, the boot reveal: a new picture every frame). Otherwise the surface is only
 *  AMBIENT — the header glyph steps colour every 500 ms, the pet sways every 1.8 s, a quip or a toast
 *  expires at a known time — and the loop sleeps until the earliest of those instants (nextAmbient), so an
 *  idle session paints ~2 frames a second instead of 6 and wakes ~2 times instead of 25; after a run,
 *  when the glyph holds still, well under one a second. Nothing waits for the sleeping timer: a keystroke
 *  paints in parse(), and every state change goes through markDirty() (dispatch, resize, the renderer),
 *  which pulls the next tick forward to one frame from now (wake()). */
export class FrameLoop {
  private screen: Screen | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** performance.now() at which `timer` fires (wake() only re-arms when that is further than a frame away) */
  private dueAt = 0;
  /** the delay the last tick chose for the next one (fire() arms it) */
  private _pace = FRAME_MS;
  /** clock time of the next ambient change the last tick saw (a tick at or past it paints) */
  private ambientDue = -Infinity;
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
  /** drag-select over the messages panel: held presses, the tint rect and the OSC 52 copy (selection.ts) */
  private readonly selection: TextSelection;
  private rows: TreeRow[] = [];
  /** frames painted (tests: "a render happened") */
  frames = 0;

  constructor(private readonly d: FrameLoopDeps) {
    const { cols, rows } = d.io.size();
    this.L = layoutFn(cols, rows, this.layoutOpts());
    this.selection = new TextSelection({
      state: d.state,
      messagesRect: () => this.L.messages,
      hits: () => this.hits,
      screenText: () => this.screen?.toText() ?? null,
      write: (seq) => { d.io.write(seq); },
      markDirty: () => this.markDirty(),
      forward: (ev, now) => this.forward(ev, now),
    });
  }

  private layoutOpts(): { pet: boolean } { return { pet: petEnabled(this.d.io.env) }; }
  /** the interval is live */
  get active(): boolean { return this.timer !== null; }
  /** the layout of the last frame (before the first frame: computed from the io size) */
  get layout(): Layout { return this.L; }
  /** the delay between the last tick and the next (tests: the idle backoff) */
  get pace(): number { return this._pace; }
  markDirty(): void { this.dirty = true; this.wake(); }
  /** the last painted frame as text (tests/smoke); "" before start() */
  frameText(): string { return this.screen?.toText() ?? ""; }

  /** Build the entire layout, textbox/cursor and hit zones in memory. No writes, input or timers. */
  prepare(): void {
    const { cols, rows } = this.d.io.size();
    this.screen = new Screen(this.d.io, cols, rows, { truecolor: this.d.truecolor });
    this.render(this.d.clock(), false);
  }

  /** build the Screen, subscribe input/resize, paint the first frame, start the interval */
  start(beforeFlush?: () => void, synchronized = false): void {
    if (this.timer) return;
    const { cols, rows } = this.d.io.size();
    let handoff = beforeFlush;
    this.screen = new Screen({ write: (text) => {
      const ready = handoff; handoff = undefined;
      // Synchronized output keeps terminals from showing the intro-clear or half a frame mid-write.
      if (ready && synchronized) {
        const esc = String.fromCharCode(27);
        this.d.io.write(`${esc}[?2026h`);
        try { ready(); this.d.io.write(text); } finally { this.d.io.write(`${esc}[?2026l`); }
      } else { ready?.(); this.d.io.write(text); }
    } }, cols, rows, { truecolor: this.d.truecolor });
    this.unsubs.push(this.d.io.onInput((chunk) => this.feed(chunk)));
    this.unsubs.push(this.d.io.onResize((c, r) => { this.screen?.resize(c, r); this.selection.cancel(); this.markDirty(); }));
    this._pace = FRAME_MS;
    this.arm(FRAME_MS);
    this.render(this.d.clock());
  }

  /** (re)arm the one timer */
  private arm(ms: number): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.dueAt = performance.now() + ms;
    this.timer = setTimeout(() => this.fire(), ms);
  }
  /** the timer fired: tick, then arm the pace the tick chose — unless the tick stopped the loop (timer
   *  gone) or a wake() inside it already re-armed (timer replaced): then it is no longer ours to arm */
  private fire(): void {
    const fired = this.timer;
    this.tick();
    if (this.timer === fired) { this.timer = null; this.arm(this._pace); }
  }
  /** something changed: if the loop is asleep, pull the next tick forward to one frame from now */
  private wake(): void {
    if (this.timer !== null && this.dueAt - performance.now() > FRAME_MS) this.arm(FRAME_MS);
  }

  /** clear the frame timer and the ESC-hold timer, unsubscribe; the screen keeps its last frame for frameText() */
  stop(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.holdTimer) { clearTimeout(this.holdTimer); this.holdTimer = null; }
    this.held = "";
    this.selection.cancel();
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
    // `this.timer` is the guard, not `this.screen`: a key can END the session — ⌃c, /exit, a click on
    // the exit row — and by the time this line runs the loop has been stopped and the terminal handed
    // back. Painting then writes a frame over the shell the user has just been returned to. The screen
    // object is still there; the loop is what says whether it is ours to paint on.
    if (this.timer !== null && r.events.length > 0) this.render(this.d.clock());
  }

  dispatch(ev: InputEvent): void {
    const now = this.d.clock();
    this.markDirty(); // and wake: the tick that follows this key (onTick: file reload) must come in one frame, not one sleep
    if (this.d.beforeInput?.(ev, now)) return;
    // the chat stays copyable without a mode or a permission: a drag over the messages panel is a
    // text selection (selection.ts) — a press that never moves is replayed, so clicks are untouched
    if (ev.type === "key" && this.selection.active) this.selection.cancel();
    if (ev.type === "mouse" && this.selection.onMouseEvent(ev, now)) return;
    this.forward(ev, now);
  }

  /** the normal input pipeline (also how a held press is replayed when it never became a drag) */
  private forward(ev: InputEvent, now: number): void {
    const kc = this.d.keyCtx();
    const ctx: KeyCtx = { layout: this.L, hooks: kc.hooks, local: kc.local, hits: this.hits, rows: this.rows, fuzzy, drag: this.drag };
    handleInput(this.d.state, ev, ctx, now);
    this.d.afterInput?.(ev, now);
  }

  /** a new picture EVERY frame: a run's spinners, a waiting card's blink, touched-file spinners, the pet's
   *  storms and effects, the boot reveal. These hold the loop at FRAME_MS. */
  moving(now: number): boolean {
    const s = this.d.state, P = this.d.pet.state;
    return s.running || s.card !== null || s.files.touched.size > 0 || now - s.bootAt < REVEAL_MS
      || now < P.stormUntil || P.fx.some((f) => f.until > now);
  }

  /** the clock time the picture next changes on its own while nothing moves — Infinity when it never will:
   *  the idle header glyph's next colour step (only while the activity state is IDLE and no card is up —
   *  draw-frame.ts modeOf; after a run the glyph holds), the pet's next sway step (only while it is on
   *  screen — the pet also hums from drawPet, so its due hum lands on the sway wake), and the instants a
   *  quip, a glance, a toast or the esc arm expire */
  nextAmbient(now: number): number {
    const s = this.d.state, P = this.d.pet.state;
    let due = Infinity;
    if (s.card === null && s.activity.state === "IDLE") due = Math.min(due, (Math.floor(now / PULSE_MS) + 1) * PULSE_MS);
    if (this.L.pet) due = Math.min(due, (Math.floor(now / SWAY_MS) + 1) * SWAY_MS);
    if (P.quip && P.quip.until > now) due = Math.min(due, P.quip.until);
    if (P.glance && P.glance.until > now) due = Math.min(due, P.glance.until);
    for (const t of s.toasts) if (t.until > now) due = Math.min(due, t.until);
    if (now < s.escUntil) due = Math.min(due, s.escUntil);
    return due;
  }

  tick(): void {
    const now = this.d.clock();
    this.d.onTick?.(now); // first: a reload marks dirty and paints below, in this very frame
    if (this.dirty || this.moving(now) || now >= this.ambientDue || now - this.lastRender >= IDLE_REPAINT_MS) this.render(now);
    this._pace = this.nextPace(now);
  }

  /** the delay to the next tick, decided AFTER the paint (a painter can mark dirty or start a quip): a
   *  frame while anything moves or is dirty, else the time to the next ambient change, never under a frame
   *  (a timer that fires a millisecond early must not spin) and never over IDLE_TICK_MS */
  private nextPace(now: number): number {
    if (this.dirty || this.moving(now)) { this.ambientDue = -Infinity; return FRAME_MS; }
    this.ambientDue = this.nextAmbient(now);
    return Math.min(IDLE_TICK_MS, Math.max(FRAME_MS, this.ambientDue - now));
  }

  /** paint one frame: panels (renderFrame) → suggestion box → palette → help → scroll write-backs → cursor → flush */
  render(now: number, flush = true): void {
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
    // the drag-selection tint (selection.ts): over the messages panel, under any overlay
    const hl = this.selection.highlight();
    if (hl) scr.tint(hl.x, hl.y, hl.w, hl.h, mix(theme.bg, theme.accent, 0.35));
    drawSuggest(scr, L.messages, s, suggestions(s, s.files.paths, fuzzy).slice(0, MAX_SUGGESTIONS), theme, hits);
    const paletteCursor = drawPalette(scr, L, theme, s, fuzzy, hits);
    const marketCursor = drawMarket(scr, L, theme, s, fuzzy, hits);
    const contextCursor = drawContext(scr, L, theme, s, hits);
    const wizardCursor = drawWizard(scr, L, theme, s, hits);
    if (s.help) drawHelp(scr, L, theme, s, hits);
    this.hits = hits;
    // the #42/#46 seams: the painters are pure, so the effective scroll positions are written back here
    // (codeScrollTop counts 0 rows in agents mode and would pin the open lane to its top)
    s.code.scroll = s.code.mode === "agents" ? agentsScrollTop(body, s) : codeScrollTop(L.code, s);
    s.msgScroll = messagesScroll(L.messages, s, theme, now).offset;
    const cursor = s.palette ? paletteCursor : s.market ? marketCursor : s.context ? contextCursor : s.wizard ? wizardCursor : s.help ? null : promptCursor(L.messages, s);
    if (flush) {
      scr.flush(cursor);
      this.frames++;
    }
    this.dirty = false;
    this.lastRender = now;
  }
}
