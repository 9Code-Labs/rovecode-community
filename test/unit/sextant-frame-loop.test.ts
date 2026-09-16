/** Port #44 frame loop pacing: an idle session must cost near nothing without losing responsiveness.
 *  The loop is one re-armed timer whose delay (`pace`) is a frame while something moves, else the time to
 *  the next ambient change (the header glyph's 500 ms colour step, the pet's 1.8 s sway, a quip's or a
 *  toast's expiry). Pins: the pace by state, the wake on markDirty()/input/resize, the immediate paint on a
 *  keystroke, no paint after stop(), and the real-timer cadence (few frames in a second of idle). */

import { test, expect } from "bun:test";
import { FrameLoop, FRAME_MS, IDLE_TICK_MS, PULSE_MS } from "../../src/sextant/sextant-frame-loop.ts";
import { SWAY_MS } from "../../src/sextant/draw-pet.ts";
import { initialState, pushToast } from "../../src/sextant/model.ts";
import { createPet } from "../../src/sextant/pet.ts";
import { buildTheme } from "../../src/sextant/theme.ts";
import { MemoryIO } from "../../src/tui/sextant-io.ts";
import type { RendererHooks } from "../../src/tui/renderer.ts";

const T0 = 1_700_000_000_000;
const HOOKS: RendererHooks = { onSubmit: () => {}, onInterrupt: () => {}, onExit: () => {} };

function make(o: { rows?: number; clock?: () => number } = {}) {
  let now = T0;
  const clock = o.clock ?? (() => now);
  const io = new MemoryIO(160, o.rows ?? 44, {});
  const state = initialState({ cwd: "C:/repo", repo: { name: "repo", branch: null }, version: "0", theme: "night", mode: "act", yolo: false, commands: [], now: clock() });
  state.bootAt = clock();
  const pet = createPet({ name: "rovecode", seed: 1 });
  const theme = buildTheme("night");
  const loop = new FrameLoop({
    io, clock, state, theme: () => theme, pet, truecolor: true,
    keyCtx: () => ({ hooks: HOOKS, local: { openFile: () => {}, } as never }),
  });
  const advance = (ms: number): void => { now += ms; };
  return { io, state, pet, loop, advance, at: () => now };
}

test("pace: a frame during the boot reveal, then the time to the header glyph's next colour step; after a run the glyph holds and only the pet's sway wakes the loop", () => {
  const { loop, state, advance } = make();
  loop.start();
  expect(loop.active).toBe(true);
  loop.tick();
  expect(loop.pace).toBe(FRAME_MS);                                   // the reveal is movement
  advance(600); loop.tick();                                           // T0+600: reveal over, glyph step due at T0+1000
  expect(loop.pace).toBe(400);
  advance(400); loop.tick();                                           // exactly on a step: the next one is a full period away
  expect(loop.pace).toBe(PULSE_MS);
  state.activity.state = "SUCCESS";                                    // the glyph shows a still ◆ after a run
  advance(PULSE_MS); loop.tick();
  const toSway = (Math.floor(loop["d"].clock() / SWAY_MS) + 1) * SWAY_MS - loop["d"].clock();
  expect(loop.pace).toBe(Math.max(FRAME_MS, toSway));
  expect(loop.pace).toBeGreaterThan(PULSE_MS);
  loop.stop();
});

test("pace never exceeds IDLE_TICK_MS: a narrow terminal has no pet and, after a run, no ambient change at all", () => {
  const { loop, state, advance } = make({ rows: 30 });                 // below 34 rows the layout drops the pet
  loop.start();
  state.activity.state = "SUCCESS";
  advance(1000); loop.tick();
  expect(loop.layout.pet).toBeNull();
  expect(loop.pace).toBe(IDLE_TICK_MS);
  loop.stop();
});

test("moving state holds the loop at a frame: a run, a card, touched files, a pet storm", () => {
  const { loop, state, pet, advance } = make();
  loop.start(); advance(1000); loop.tick();
  expect(loop.pace).toBe(PULSE_MS);
  state.running = true; loop.tick(); expect(loop.pace).toBe(FRAME_MS); state.running = false;
  state.files.touched.set("a.ts", loop["d"].clock() + 5000); loop.tick(); expect(loop.pace).toBe(FRAME_MS); state.files.touched.clear();
  pet.state.stormUntil = loop["d"].clock() + 5000; loop.tick(); expect(loop.pace).toBe(FRAME_MS); pet.state.stormUntil = 0;
  loop.tick(); expect(loop.pace).toBeGreaterThan(FRAME_MS);
  loop.stop();
});

test("a toast or a quip is ambient, not movement: the loop sleeps until it expires, then paints it away", () => {
  const { loop, state, advance } = make();
  loop.start(); advance(1000); loop.tick();
  state.activity.state = "SUCCESS";                                    // keep the glyph still so the toast decides the pace
  const now = loop["d"].clock();
  pushToast(state, "copied", now);                                     // until = now + 2600
  advance(SWAY_MS - (now % SWAY_MS)); loop.tick();                     // on a sway step, so the toast's expiry is the earliest instant
  const toToast = state.toasts[0]!.until - loop["d"].clock();
  expect(loop.pace).toBe(Math.min(toToast, (Math.floor(loop["d"].clock() / SWAY_MS) + 1) * SWAY_MS - loop["d"].clock()));
  advance(toToast); const before = loop.frames; loop.tick();
  expect(loop.frames).toBe(before + 1);
  expect(state.toasts.length).toBe(0);
  loop.stop();
});

test("a keystroke paints immediately, in parse(), however long the loop was sleeping — and never after stop()", () => {
  const { loop, io, advance } = make();
  loop.start(); advance(1000); loop.tick();
  const before = loop.frames;
  io.feed("x");                                                        // no tick: the paint is the input path's
  expect(loop.frames).toBe(before + 1);
  loop.stop();
  io.feed("y");
  expect(loop.frames).toBe(before + 1);
  expect(io.listeners).toBe(0);
});

test("real timers: an idle second costs a few frames, not 25; markDirty() while asleep paints within a frame or two", async () => {
  const { loop, state } = make({ clock: Date.now });
  state.bootAt = Date.now() - 10_000;                                  // no reveal, no boot movement
  state.activity.state = "SUCCESS";                                    // glyph still: the pet's 1.8 s sway is the only ambient change
  loop.start();
  await new Promise((r) => setTimeout(r, 150));                        // the first tick (40 ms) settles the pace
  const f0 = loop.frames;
  await new Promise((r) => setTimeout(r, 1000));
  const idleFrames = loop.frames - f0;
  expect(idleFrames).toBeLessThanOrEqual(2);                           // at most one sway step (plus a timer that fired a hair early)
  expect(loop.pace).toBeGreaterThan(FRAME_MS);
  const f1 = loop.frames;
  loop.markDirty();                                                    // the renderer's way to say "state changed"
  await new Promise((r) => setTimeout(r, 100));
  expect(loop.frames).toBeGreaterThanOrEqual(f1 + 1);
  loop.stop();
  const f2 = loop.frames;
  await new Promise((r) => setTimeout(r, 100));
  expect(loop.frames).toBe(f2);                                        // the timer is gone
});

test("real timers: a running spinner still animates at the frame rate", async () => {
  const { loop, state } = make({ clock: Date.now });
  state.bootAt = Date.now() - 10_000;
  state.running = true;
  loop.start();
  const f0 = loop.frames;
  await new Promise((r) => setTimeout(r, 500));
  expect(loop.frames - f0).toBeGreaterThanOrEqual(8);                  // ≥ 16 fps of the nominal 25 even on a loaded CI box
  loop.stop();
});
