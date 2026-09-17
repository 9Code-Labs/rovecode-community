/** Port #45 rovecode brain (src/sextant/pet.ts): the pinned mood table (direct MoodCtx and moodCtxFrom over
 *  a SextantState fixture), storm on tool_fail within one frame / seeded 5-7 s / cleared by SUCCESS and by
 *  done / edge-triggered on the state's entry into ERROR (two episodes = two storms, a lingering ERROR = one),
 *  observe table + 5.5 s rate limit + deferral behind event quips (dropped past 10 s), react, poke (event
 *  "poke" counts too), say, level steps, todo counting, ambient hums and snores, "still going", suggest,
 *  permission quips, animating, determinism, petEnabled, and the source pins (no wall clock / timers /
 *  Math.random / process in pet.ts, draw-pet.ts). */
import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createPet, moodCtxFrom, petEnabled, seededRandom, QUIPS, OBSERVE, OBSERVE_DEL, MOODS, SPRITE, INNER,
  OBSERVE_GAP_MS, OBSERVE_DEFER_MS, STORM_MIN_MS, STORM_MAX_MS, SLEEP_AFTER_MS, LONG_RUN_MS, BOOT_MS,
  type MoodCtx, type Mood, type Pet,
} from "../../src/sextant/pet.ts";
import type { SextantState } from "../../src/sextant/types.ts";
import { T0, stateFixture, activity, task, approvalCard, questionCard } from "../helpers/sextant-pet-fixtures.ts";

const ctx = (over: Partial<MoodCtx> = {}): MoodCtx => ({
  state: "IDLE", running: false, waiting: false, delegating: false, errorAt: null, tokens: 0,
  activeAt: 0, runStartedAt: null, changed: 0, typing: false, booting: false, ...over,
});
/** a pet born (first tick) at T0 */
const born = (seed = 1): Pet => { const pet = createPet({ seed }); pet.tick(T0); return pet; };
const busy = (state: MoodCtx["state"]) => ctx({ state, running: true });

// ---------- mood table ----------

describe("mood table (direct MoodCtx)", () => {
  const rows: [string, Partial<MoodCtx>, Mood][] = [
    ["ERROR → furious", { state: "ERROR" }, "furious"],
    ["WAITING → patient", { state: "WAITING", running: true }, "patient"],
    ["card open (waiting) → patient", { state: "THINKING", running: true, waiting: true }, "patient"],
    ["DELEGATING → conducting", { state: "DELEGATING", running: true }, "conducting"],
    ["crew non-terminal (delegating) → conducting", { state: "THINKING", running: true, delegating: true }, "conducting"],
    ["EDITING → focused", { state: "EDITING", running: true }, "focused"],
    ["RUNNING → zapping", { state: "RUNNING", running: true }, "zapping"],
    ["TESTING → zapping", { state: "TESTING", running: true }, "zapping"],
    ["SUCCESS → sunny", { state: "SUCCESS" }, "sunny"],
    ["THINKING while running → humming", { state: "THINKING", running: true }, "humming"],
    ["READING / WRITING while running → humming", { state: "WRITING", running: true }, "humming"],
    ["IDLE → humming", {}, "humming"],
  ];
  for (const [name, over, want] of rows) test(name, () => expect(born().mood(ctx(over), T0)).toBe(want));

  test("idle ≥45 s → sleepy; 44.999 s → humming; a run in flight never sleeps; state activity wakes it", () => {
    expect(SLEEP_AFTER_MS).toBe(45_000);
    const pet = born();
    expect(pet.mood(ctx(), T0 + 44_999)).toBe("humming");
    expect(pet.mood(ctx(), T0 + 45_000)).toBe("sleepy");
    expect(pet.mood(busy("THINKING"), T0 + SLEEP_AFTER_MS)).toBe("humming");
    expect(pet.mood(ctx({ activeAt: T0 + 30_000 }), T0 + SLEEP_AFTER_MS)).toBe("humming");
    pet.event("read", { f: "a.ts" }, T0 + 40_000); // any event resets the idle clock
    expect(pet.mood(ctx(), T0 + SLEEP_AFTER_MS)).toBe("humming");
    expect(pet.mood(ctx(), T0 + 40_000 + SLEEP_AFTER_MS)).toBe("sleepy");
  });

  test("precedence: ERROR > waiting > delegating > EDITING > RUNNING > SUCCESS > sleepy", () => {
    const pet = born();
    expect(pet.mood(ctx({ state: "ERROR", waiting: true, delegating: true }), T0)).toBe("furious");
    expect(pet.mood(ctx({ state: "EDITING", waiting: true, delegating: true, running: true }), T0)).toBe("patient");
    expect(pet.mood(ctx({ state: "EDITING", delegating: true, running: true }), T0)).toBe("conducting");
    expect(pet.mood(ctx({ state: "SUCCESS", delegating: true }), T0)).toBe("conducting");
    expect(pet.mood(ctx({ state: "SUCCESS" }), T0 + 90_000)).toBe("sunny"); // sunny outranks sleepy
  });

  test("MOODS lists the eight pinned moods in precedence order", () => {
    expect(MOODS).toEqual(["furious", "patient", "conducting", "focused", "zapping", "sunny", "sleepy", "humming"]);
  });
});

describe("mood table via moodCtxFrom(SextantState)", () => {
  const thinking = activity("THINKING", T0 - 1000);
  const rows: [string, Partial<SextantState>, Mood][] = [
    ["activity ERROR", { activity: activity("ERROR", T0 - 1000, T0 - 10) }, "furious"],
    ["approval card open", { card: approvalCard(), running: true, activity: thinking }, "patient"],
    ["question card open", { card: questionCard(), running: true, activity: thinking }, "patient"],
    ["crew running", { crew: [task("running")], running: true, activity: thinking }, "conducting"],
    ["crew queued", { crew: [task("queued")], running: true, activity: thinking }, "conducting"],
    ["crew all terminal → not conducting", { crew: [task("done", "a"), task("failed", "b"), task("cancelled", "c")], running: true, activity: thinking }, "humming"],
    ["EDITING", { running: true, activity: activity("EDITING", T0 - 1000) }, "focused"],
    ["RUNNING", { running: true, activity: activity("RUNNING", T0 - 1000) }, "zapping"],
    ["TESTING", { running: true, activity: activity("TESTING", T0 - 1000) }, "zapping"],
    ["SUCCESS", { activity: activity("SUCCESS", T0 - 5000, T0 - 100) }, "sunny"],
    ["fresh IDLE", {}, "humming"],
  ];
  for (const [name, over, want] of rows) {
    test(name, () => {
      const pet = createPet({ seed: 2 });
      const s = stateFixture(over);
      pet.tick(T0, moodCtxFrom(s, T0));
      expect(pet.mood(moodCtxFrom(s, T0), T0)).toBe(want);
    });
  }

  test("sleepy from state: born at T0, idle 45 s later; a run end recorded in the state keeps it awake", () => {
    const pet = createPet({ seed: 2 });
    const s = stateFixture();
    pet.tick(T0, moodCtxFrom(s, T0));
    expect(pet.mood(moodCtxFrom(s, T0 + SLEEP_AFTER_MS - 1), T0 + SLEEP_AFTER_MS - 1)).toBe("humming");
    expect(pet.mood(moodCtxFrom(s, T0 + SLEEP_AFTER_MS), T0 + SLEEP_AFTER_MS)).toBe("sleepy");
    const s2 = stateFixture({ activity: activity("IDLE", T0 + 40_000, T0 + 44_000) });
    expect(pet.mood(moodCtxFrom(s2, T0 + SLEEP_AFTER_MS), T0 + SLEEP_AFTER_MS)).toBe("humming");
  });

  test("moodCtxFrom derives tokens, errorAt, runStartedAt, activeAt, changed, typing, booting", () => {
    const s = stateFixture({
      running: true, activity: activity("ERROR", T0 - 900, T0 - 20), repo: { name: "r", branch: null, modified: 12 },
      input: { text: "/he", cur: 3, history: [], histIdx: -1, sgSel: 0 }, bootAt: T0 - 500,
    });
    s.usage.tokensIn = 1200; s.usage.tokensOut = 300;
    const c = moodCtxFrom(s, T0);
    expect(c).toEqual({ state: "ERROR", running: true, waiting: false, delegating: false, errorAt: T0 - 20, tokens: 1500,
      activeAt: T0 - 20, runStartedAt: T0 - 900, changed: 12, typing: true, booting: true });
    expect(moodCtxFrom(stateFixture(), T0).errorAt).toBeNull();
    expect(moodCtxFrom(stateFixture({ activity: activity("ERROR", T0 - 900) }), T0).errorAt).toBe(T0 - 900);
    expect(BOOT_MS).toBe(1300);
    expect(moodCtxFrom(stateFixture(), T0 - 60_000 + 1299).booting).toBe(true);
    expect(moodCtxFrom(stateFixture(), T0 - 60_000 + 1300).booting).toBe(false);
    expect(moodCtxFrom(stateFixture({ activity: activity("READING", T0 - 5) }), T0).runStartedAt).toBeNull(); // not running
  });
});

// ---------- storm ----------

describe("storm", () => {
  test("tool_fail flips to furious in the same frame; SUCCESS clears it within one frame (not merely outranks it)", () => {
    const pet = born(3);
    expect(pet.mood(ctx(), T0)).toBe("humming");
    pet.event("tool_fail", { f: "a.ts" }, T0 + 16);
    expect(pet.mood(busy("READING"), T0 + 16)).toBe("furious");
    expect(QUIPS.error).toContain(pet.state.quip!.text);
    expect(pet.state.fx.some((f) => f.kind === "shiver")).toBe(true);
    expect(pet.animating(T0 + 16)).toBe(true);
    const ok = ctx({ state: "SUCCESS" });
    pet.tick(T0 + 32, ok);
    expect(pet.mood(ok, T0 + 32)).toBe("sunny");
    expect(pet.state.stormUntil).toBe(0);
    expect(pet.mood(ctx(), T0 + 48)).toBe("humming");
  });

  test("error / fail / fail-line start a storm; done / start / pass / fresh / stopped end it", () => {
    for (const kind of ["error", "fail"] as const) {
      const pet = born(3);
      pet.event(kind, { r: "3 failed" }, T0);
      expect(pet.mood(ctx(), T0 + 100)).toBe("furious");
      pet.event("done", undefined, T0 + 200);
      expect(pet.mood(ctx(), T0 + 300)).toBe("humming");
    }
    const pet = born(3);
    pet.react("fail-line", T0);
    expect(pet.mood(ctx(), T0 + 100)).toBe("furious");
    expect(QUIPS.failLine).toContain(pet.state.quip!.text);
    for (const kind of ["start", "pass", "fresh", "stopped"] as const) {
      pet.react("fail-line", T0 + 1000);
      pet.event(kind, { r: "ok" }, T0 + 1100);
      expect(pet.mood(ctx(), T0 + 1200)).toBe("humming");
    }
  });

  test("a state-level error (activity ERROR) storms once via tick and outlives the state by 5-7 s; while ERROR lingers nothing re-arms", () => {
    const pet = createPet({ seed: 4 });
    const s = stateFixture({ activity: activity("ERROR", T0 - 1000, T0 - 5) });
    pet.tick(T0, moodCtxFrom(s, T0));
    const after = busy("READING");
    expect(pet.mood(after, T0 + 4999)).toBe("furious");
    expect(pet.mood(after, T0 + 7000)).toBe("humming");
    const until = pet.state.stormUntil;
    pet.tick(T0 + 100, moodCtxFrom(s, T0 + 100)); // the same error is not re-armed
    expect(pet.state.stormUntil).toBe(until);
    // a newer error clock while the state never left ERROR is the same episode — the edge, not the clock, arms it
    pet.tick(T0 + 3000, moodCtxFrom(stateFixture({ activity: activity("ERROR", T0 - 1000, T0 + 2900) }), T0 + 3000));
    expect(pet.state.stormUntil).toBe(until);
    expect(pet.state.wasError).toBe(true);
  });

  test("edge-trigger (critic probe): ERROR → READING → 9 s → ERROR → READING with one error clock (endedAt null) is two storms", () => {
    const pet = createPet({ seed: 4 });
    const running = (state: "ERROR" | "READING", t: number) =>
      moodCtxFrom(stateFixture({ running: true, activity: activity(state, T0 - 1000) }), t); // endedAt null → errorAt = startedAt both times
    expect(running("ERROR", T0).errorAt).toBe(running("ERROR", T0 + 9000).errorAt);
    pet.tick(T0, running("ERROR", T0));
    const first = pet.state.stormUntil;
    expect(first).toBeGreaterThanOrEqual(T0 + STORM_MIN_MS);
    pet.tick(T0 + 40, running("READING", T0 + 40));
    expect(pet.mood(running("READING", T0 + 40), T0 + 40)).toBe("furious"); // the first storm outlives the state
    expect(pet.state.wasError).toBe(false);
    pet.tick(T0 + 9000, running("ERROR", T0 + 9000));
    expect(pet.state.stormUntil).toBeGreaterThanOrEqual(T0 + 9000 + STORM_MIN_MS); // a second storm, not humming
    pet.tick(T0 + 9040, running("READING", T0 + 9040));
    expect(pet.mood(running("READING", T0 + 9040), T0 + 9040)).toBe("furious");
  });

  test("edge-trigger guard: ERROR lingering for 150 frames arms exactly one storm (stormUntil < T0 + 7 s); THINKING at T0 + 7 s hums", () => {
    const pet = createPet({ seed: 4 });
    const err = ctx({ state: "ERROR", running: true, errorAt: T0 - 1000 });
    for (let i = 0; i < 150; i++) pet.tick(T0 + i * 40, err); // 6 s of ERROR frames
    expect(pet.state.stormUntil).toBeGreaterThanOrEqual(T0 + STORM_MIN_MS);
    expect(pet.state.stormUntil).toBeLessThan(T0 + STORM_MAX_MS);
    expect(pet.mood(err, T0 + 7000)).toBe("furious"); // the state itself still rules while it is ERROR …
    expect(pet.mood(busy("THINKING"), T0 + 7000)).toBe("humming"); // … but no re-armed storm lingers past it
  });

  test("a new error during a storm never shortens it (stormUntil only grows until cleared)", () => {
    for (let seed = 1; seed <= 8; seed++) {
      const pet = born(seed);
      pet.event("tool_fail", undefined, T0);
      const first = pet.state.stormUntil;
      pet.react("fail-line", T0 + 50);
      expect(pet.state.stormUntil).toBeGreaterThanOrEqual(first);
      pet.event("error", undefined, T0 + 4000);
      expect(pet.state.stormUntil).toBeGreaterThanOrEqual(T0 + 4000 + STORM_MIN_MS);
    }
  });

  test("storm duration is seeded within [5 s, 7 s) and varies across seeds", () => {
    expect([STORM_MIN_MS, STORM_MAX_MS]).toEqual([5000, 7000]);
    const durations = new Set<number>();
    for (let seed = 1; seed <= 12; seed++) {
      const pet = createPet({ seed });
      pet.event("tool_fail", undefined, T0);
      const d = pet.state.stormUntil - T0;
      durations.add(d);
      expect(d).toBeGreaterThanOrEqual(5000);
      expect(d).toBeLessThan(7000);
      expect(pet.mood(ctx(), T0 + 4999)).toBe("furious");
      expect(pet.mood(ctx(), T0 + 7000)).toBe("humming");
    }
    expect(durations.size).toBeGreaterThan(1);
  });
});

// ---------- observe / react / suggest ----------

describe("observe", () => {
  test("a matching line speaks; 1 s later is rate-limited; 6 s later speaks again", () => {
    const pet = born(5);
    pet.observe("res.cookie('sid', v, { httpOnly: true })", "ins", T0);
    expect(pet.state.quip?.text).toBe("httpOnly. good call.");
    expect(pet.state.quip?.kind).toBe("observe");
    pet.observe("console.log(x)", "ins", T0 + 1000);
    expect(pet.state.quip?.text).toBe("httpOnly. good call.");
    pet.observe("console.log(x)", "ins", T0 + 6000);
    expect(pet.state.quip?.text).toBe("leftover console.log?");
  });

  test("the gate is exactly OBSERVE_GAP_MS = 5.5 s", () => {
    expect(OBSERVE_GAP_MS).toBe(5500);
    const pet = born(5);
    pet.observe("throw new Error('x')", "ins", T0);
    pet.observe("console.log(x)", "ins", T0 + OBSERVE_GAP_MS - 1);
    expect(pet.state.quip?.text).toBe("throwing. brave.");
    pet.observe("console.log(x)", "ins", T0 + OBSERVE_GAP_MS);
    expect(pet.state.quip?.text).toBe("leftover console.log?");
  });

  test("del table, silence on no match, first matching line of a multi-line write, per-line anchors", () => {
    const pet = born(5);
    pet.observe("const cache = new Map()", "del", T0);
    expect(pet.state.quip?.text).toBe("bye, in-memory Map.");
    const quiet = born(5);
    quiet.observe("const x = 1;\nreturn x;", "ins", T0);
    expect(quiet.state.quip).toBeNull();
    expect(quiet.state.nextObserveAt).toBe(0); // a miss does not consume the gate
    const multi = born(5);
    multi.observe("const a = 1;\nsetCookie(res, { sameSite: 'lax' });\nconsole.log(a);", "ins", T0);
    expect(multi.state.quip?.text).toBe("sameSite too. tidy.");
    const anchored = born(5);
    anchored.observe("x = 1; import y from 'z'", "ins", T0); // ^import must start the line
    expect(anchored.state.quip).toBeNull();
    anchored.observe("import y from 'z'", "ins", T0);
    expect(anchored.state.quip?.text).toBe("imports rolling in.");
    expect(OBSERVE.length).toBe(23);
    expect(OBSERVE_DEL.length).toBe(4);
  });

  test("deferred behind an event quip: spoken by tick when that quip ends; the burst still counts once", () => {
    const pet = born(5);
    pet.event("edit", { f: "a.ts" }, T0);
    const edit = pet.state.quip!.text;
    expect(edit).toContain("a.ts");
    pet.observe("secure: true", "ins", T0 + 5);
    pet.observe("httpOnly", "ins", T0 + 6);
    expect(pet.state.quip!.text).toBe(edit);
    expect(pet.state.pendingObserve).toEqual({ text: "secure cookie ♥", at: T0 + 5 });
    pet.tick(T0 + 4000);
    expect(pet.state.quip!.text).toBe(edit);
    pet.tick(T0 + 4200);
    expect(pet.state.quip!.text).toBe("secure cookie ♥");
    expect(pet.state.pendingObserve).toBeNull();
    expect(pet.state.nextObserveAt).toBe(T0 + 5 + OBSERVE_GAP_MS);
  });

  test("a deferred observation older than OBSERVE_DEFER_MS (10 s) is dropped, never surfaced minutes later behind a permission quip", () => {
    expect(OBSERVE_DEFER_MS).toBe(10_000);
    const pet = born(5);
    pet.event("permission", undefined, T0); // a 2-minute event quip holds the floor
    pet.observe("httpOnly", "ins", T0 + 100);
    expect(pet.state.pendingObserve).toEqual({ text: "httpOnly. good call.", at: T0 + 100 });
    pet.tick(T0 + 10_100); // exactly 10 s old: still held
    expect(pet.state.pendingObserve).not.toBeNull();
    pet.tick(T0 + 10_101); // 10.001 s old: dropped
    expect(pet.state.pendingObserve).toBeNull();
    pet.event("allowed", undefined, T0 + 60_000);
    pet.tick(T0 + 64_200); // the allowed quip ended — nothing stale surfaces
    expect(pet.state.quip).toBeNull();
    // behind a short event quip the same observation still speaks when the quip ends (age ≤ 10 s)
    const quick = born(5);
    quick.say("hold on.", T0, 9000);
    quick.observe("httpOnly", "ins", T0 + 100);
    quick.tick(T0 + 9000);
    expect(quick.state.quip?.text).toBe("httpOnly. good call.");
    expect(quick.state.quip?.kind).toBe("observe");
  });
});

test("react: fail-line storms + shivers, pass-line bounces, risk comments", () => {
  const pet = born(6);
  pet.react("pass-line", T0);
  expect(pet.state.fx.map((f) => f.kind)).toEqual(["bounce"]);
  expect(pet.mood(ctx(), T0)).toBe("humming");
  pet.react("risk", T0 + 10);
  expect(QUIPS.risk).toContain(pet.state.quip!.text);
  pet.react("fail-line", T0 + 20);
  expect(pet.state.fx.map((f) => f.kind)).toEqual(["bounce", "shiver"]);
  expect(pet.mood(ctx(), T0 + 20)).toBe("furious");
});

test("suggest: '<label>? sure.' once per label, 4 s apart, never over an event quip", () => {
  const pet = born(6);
  pet.suggest("/help", T0);
  expect(pet.state.quip?.text).toBe("/help? sure.");
  pet.suggest("/help", T0 + 100);
  pet.suggest("/plan", T0 + 200); // within the 4 s gap
  expect(pet.state.quip?.text).toBe("/help? sure.");
  pet.suggest("/theme", T0 + 4000);
  expect(pet.state.quip?.text).toBe("/theme? sure.");
  pet.event("run", undefined, T0 + 5000);
  pet.suggest("/cost", T0 + 9000);
  expect(QUIPS.run).toContain(pet.state.quip!.text);
});

// ---------- events ----------

test("poke: bounce + hearts, glance at the user, first poke says hi., later pokes cycle the pool", () => {
  const pet = born(8);
  pet.poke(T0);
  expect(pet.state.pokes).toBe(1);
  expect(pet.state.quip!.text).toBe("hi.");
  expect(pet.state.fx.map((f) => f.kind).sort()).toEqual(["bounce", "hearts"]);
  expect(pet.state.glance).toEqual({ dir: 0, until: T0 + 1500 });
  expect(pet.animating(T0 + 1799)).toBe(true);
  pet.tick(T0 + 4300);
  expect(pet.animating(T0 + 4300)).toBe(false);
  pet.poke(T0 + 4300);
  expect(pet.state.quip!.text).toBe(QUIPS.poke[1]!);
  pet.poke(T0 + 4400);
  expect(pet.state.quip!.text).toBe(QUIPS.poke[2]!);
});

test("event('poke') is the same click as poke(): it counts, so the greeting advances either way (#44 may call either)", () => {
  const pet = born(8);
  pet.event("poke", undefined, T0);
  expect(pet.state.pokes).toBe(1);
  expect(pet.state.quip!.text).toBe("hi.");
  expect(pet.state.fx.map((f) => f.kind).sort()).toEqual(["bounce", "hearts"]);
  pet.event("poke", undefined, T0 + 100);
  expect(pet.state.pokes).toBe(2);
  expect(pet.state.quip!.text).toBe(QUIPS.poke[1]!);
  pet.poke(T0 + 200);
  expect(pet.state.pokes).toBe(3);
  expect(pet.state.quip!.text).toBe(QUIPS.poke[2]!);
});

test("say: an event-tone quip from the surface (/pet <name> → '<name>? i like it.'), 4.2 s by default, custom ms, holds the floor over observations", () => {
  const pet = createPet({ seed: 8 });
  pet.state.name = "stratus";
  pet.say(`${pet.state.name}? i like it.`, T0);
  expect(pet.state.quip).toEqual({ text: "stratus? i like it.", until: T0 + 4200, kind: "event" });
  expect(pet.state.lastActiveAt).toBe(T0); // first sight = birth, like every other entry point
  expect(pet.animating(T0 + 4199)).toBe(true);
  expect(pet.animating(T0 + 4200)).toBe(false);
  pet.observe("httpOnly", "ins", T0 + 10);
  expect(pet.state.quip!.text).toBe("stratus? i like it."); // the observation defers behind it
  expect(pet.state.pendingObserve?.text).toBe("httpOnly. good call.");
  pet.say("solo it is.", T0 + 5000, 1000);
  expect(pet.state.quip).toEqual({ text: "solo it is.", until: T0 + 6000, kind: "event" });
});

test("level grows stepwise: 1 + floor(sqrt(tokens / 1500))", () => {
  const pet = createPet();
  expect([0, 1499, 1500, 5999, 6000, 13_499, 13_500, 24_000, -5].map((n) => pet.level(n))).toEqual([1, 1, 2, 2, 3, 3, 4, 5, 1]);
});

test("todo_done counts finished plan steps and formats d/n; without data it counts up and skips {n} quips", () => {
  const pet = born(9);
  pet.event("todo_done", { d: 2, n: 5 }, T0);
  expect(pet.state.todosDone).toBe(2);
  expect(["one down.", "2/5. moving.", "check.", "that's 2 of 5."]).toContain(pet.state.quip!.text);
  expect(pet.state.fx.some((f) => f.kind === "bounce")).toBe(true);
  pet.event("todo_done", undefined, T0 + 100);
  expect(pet.state.todosDone).toBe(3);
  expect(["one down.", "check."]).toContain(pet.state.quip!.text);
});

test("event quips fill {f} {n} {a} {r}; read/edit/... glance at the code panel; permission waits 2 minutes", () => {
  const pet = born(10);
  pet.event("read", { f: "auth.ts" }, T0);
  expect(["reading auth.ts.", "let me skim auth.ts."]).toContain(pet.state.quip!.text);
  expect(pet.state.glance).toEqual({ dir: 1, until: T0 + 2600 });
  pet.event("grep", { n: 3 }, T0 + 1600); // past MIN_DWELL_MS: a different routine kind may take the floor
  expect(["found 3.", "3. noted."]).toContain(pet.state.quip!.text);
  pet.event("spawn", { a: "codex" }, T0 + 3200);
  expect(pet.state.quip!.text).toContain("codex");
  pet.event("permission", undefined, T0 + 30);
  expect(QUIPS.permission).toContain(pet.state.quip!.text);
  expect(pet.state.quip!.until).toBe(T0 + 30 + 120_000);
  pet.event("allowed", undefined, T0 + 40);
  expect(QUIPS.allowed).toContain(pet.state.quip!.text);
  expect(pet.state.fx.some((f) => f.kind === "hearts")).toBe(true);
  pet.event("pass", { r: "9 passed" }, T0 + 50);
  expect(pet.state.quip!.text).toContain("9 passed");
  expect(pet.state.quip!.until).toBe(T0 + 50 + 6000);
  expect(pet.state.fx.some((f) => f.kind === "sparkle")).toBe(true);
});

// ---------- tick: ambient, long runs ----------

test("ambient: an idle hum 6 s after birth (11 s from the seeded lastQuipAt), snores when sleepy, quiet while running/booting", () => {
  const pet = born(6);
  pet.tick(T0 + 6000, ctx());
  expect(pet.state.quip).toBeNull();
  pet.tick(T0 + 6001, ctx());
  expect(QUIPS.idle).toContain(pet.state.quip!.text);
  expect(pet.state.quip!.kind).toBe("ambient");
  const sleepy = born(6);
  sleepy.tick(T0 + 50_000, ctx());
  expect(QUIPS.sleep).toContain(sleepy.state.quip!.text);
  const running = born(6);
  running.tick(T0 + 20_000, busy("THINKING"));
  expect(running.state.quip).toBeNull();
  const booting = born(6);
  booting.tick(T0 + 20_000, ctx({ booting: true }));
  expect(booting.state.quip).toBeNull();
  const branch = born(6);
  branch.tick(T0 + 20_000, ctx({ changed: 9 }));
  expect([...QUIPS.idle, "9 modified files. busy branch."]).toContain(branch.state.quip!.text);
});

test("asks for patience once after 25 s of one run; a new start re-arms it", () => {
  expect(LONG_RUN_MS).toBe(25_000);
  const pet = born(6);
  const run = ctx({ state: "THINKING", running: true, runStartedAt: T0 });
  pet.tick(T0 + 25_000, run);
  expect(pet.state.quip).toBeNull();
  pet.tick(T0 + 25_001, run);
  expect(QUIPS.long).toContain(pet.state.quip!.text);
  pet.tick(T0 + 30_000, run);
  expect(pet.state.quip).toBeNull();
  expect(pet.state.saidLong).toBe(true);
  pet.event("start", undefined, T0 + 60_000);
  expect(pet.state.saidLong).toBe(false);
});

test("tick expires fx, glance and quips; animating reflects quip / fx / storm", () => {
  const pet = born(7);
  expect(pet.animating(T0)).toBe(false);
  pet.event("edit", { f: "a.ts" }, T0);
  expect(pet.animating(T0 + 4199)).toBe(true);
  expect(pet.animating(T0 + 4200)).toBe(false);
  pet.tick(T0 + 4200);
  expect(pet.state.quip).toBeNull();
  expect(pet.state.glance).toBeNull();
  pet.event("tool_fail", undefined, T0 + 5000);
  pet.tick(T0 + 9500);
  expect(pet.state.fx).toEqual([]); // shiver expired
  expect(pet.animating(T0 + 9500)).toBe(true); // the storm is still live
});

// ---------- determinism, naming, enablement, source pins ----------

test("same seed + same script → identical state; other seeds choose differently somewhere", () => {
  const script = (pet: Pet) => {
    pet.tick(T0); pet.event("start", undefined, T0); pet.event("edit", { f: "x.ts" }, T0 + 10);
    pet.react("fail-line", T0 + 20); pet.poke(T0 + 30); pet.event("pass", { r: "9 passed" }, T0 + 40); pet.tick(T0 + 20_000, ctx());
  };
  const a = createPet({ seed: 11 }), b = createPet({ seed: 11 });
  script(a); script(b);
  expect(JSON.stringify(a.state)).toBe(JSON.stringify(b.state));
  const sigs = new Set<string>();
  for (let seed = 1; seed <= 6; seed++) { const p = createPet({ seed }); script(p); sigs.add(JSON.stringify(p.state)); }
  expect(sigs.size).toBeGreaterThan(1);
  const r1 = seededRandom(42), r2 = seededRandom(42);
  expect([r1(), r1(), r1()]).toEqual([r2(), r2(), r2()]);
});

test("name defaults to rovecode and is capped at 14 chars; INNER spans the outline interior per row", () => {
  expect(createPet().state.name).toBe("rovecode");
  expect(createPet({ name: "cumulonimbus-maximus" }).state.name).toBe("cumulonimbus-m");
  expect(SPRITE.every((r) => r.length === 18)).toBe(true);
  expect(INNER[0]).toEqual([7, 12]);
  expect(INNER[3]).toEqual([2, 16]);
});

test("petEnabled: ROVECODE_PET=0/false/off/no hides the panel; unset, empty or anything else shows it", () => {
  expect(petEnabled({ ROVECODE_PET: "0" })).toBe(false);
  expect(petEnabled({ ROVECODE_PET: "false" })).toBe(false);
  expect(petEnabled({ ROVECODE_PET: " OFF " })).toBe(false);
  expect(petEnabled({ ROVECODE_PET: "no" })).toBe(false);
  expect(petEnabled({})).toBe(true);
  expect(petEnabled({ ROVECODE_PET: undefined })).toBe(true);
  expect(petEnabled({ ROVECODE_PET: "" })).toBe(true);
  expect(petEnabled({ ROVECODE_PET: "1" })).toBe(true);
});

test("source pins: pet.ts and draw-pet.ts have no wall clock, timers, Math.random or process access; ≤400 lines; provenance header", () => {
  for (const f of ["pet.ts", "draw-pet.ts"]) {
    const src = readFileSync(join(import.meta.dir, "../../src/sextant", f), "utf8");
    for (const bad of [/Math\.random/, /Date\.now/, /new Date\b/, /setTimeout|setInterval|setImmediate|queueMicrotask/, /\bprocess\./, /performance\.now/]) {
      expect(src).not.toMatch(bad);
    }
    expect(src.split("\n").length).toBeLessThanOrEqual(400);
    expect(src.includes("\0")).toBe(false);
    expect(src.startsWith("/** ")).toBe(true);
  }
});
