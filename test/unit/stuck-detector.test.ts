/** 5-pattern stuck detector core (eval P0-4 / G12, OpenHands thresholds 4/3/3/6 + context-window).
 *  Pure module, no loop wiring here — integration has a single owner (coordinator note 2026-09-14). */

import { describe, test, expect } from "bun:test";
import {
  StuckDetector,
  detectStuck,
  STUCK_THRESHOLDS,
  type StuckStep,
} from "../../src/core/stuck-detector.ts";

const act = (tool: string, sig: string): StuckStep => ({ kind: "action", tool, signature: sig });
const obs = (tool: string, sig: string, ok = true): StuckStep => ({ kind: "observation", tool, signature: sig, ok });
const say = (len = 200): StuckStep => ({ kind: "assistant", textLength: len });
const usr = (): StuckStep => ({ kind: "user" });

function pairs(tool: string, asig: string, osig: string, n: number, ok = true): StuckStep[] {
  const out: StuckStep[] = [];
  for (let i = 0; i < n; i++) out.push(act(tool, asig), obs(tool, osig, ok));
  return out;
}

describe("thresholds (OpenHands-derived, pinned)", () => {
  test("4 / 3 / 3 / 6 / 2 and the window bound", () => {
    expect(STUCK_THRESHOLDS.actionObservation).toBe(4);
    expect(STUCK_THRESHOLDS.actionError).toBe(3);
    expect(STUCK_THRESHOLDS.monologue).toBe(3);
    expect(STUCK_THRESHOLDS.pingPong).toBe(6);
    expect(STUCK_THRESHOLDS.contextWindowErrors).toBe(2);
    expect(STUCK_THRESHOLDS.windowSize).toBeGreaterThanOrEqual(32);
  });
});

describe("repeated-action-observation", () => {
  test("fires at the 4th identical pair, not before", () => {
    expect(detectStuck(pairs("read", "a1", "o1", 3)).map((e) => e.pattern)).not.toContain("repeated-action-observation");
    const at4 = detectStuck(pairs("read", "a1", "o1", 4));
    const ev = at4.find((e) => e.pattern === "repeated-action-observation");
    expect(ev).toBeDefined();
    expect(ev!.count).toBe(4);
  });

  test("a changed observation resets the streak (progress is not a loop)", () => {
    const steps = [...pairs("read", "a1", "o1", 3), act("read", "a1"), obs("read", "o2"), ...pairs("read", "a1", "o1", 3)];
    expect(detectStuck(steps).map((e) => e.pattern)).not.toContain("repeated-action-observation");
  });

  test("a different action breaks the streak", () => {
    const steps = [...pairs("read", "a1", "o1", 3), act("grep", "a2"), obs("grep", "o2"), ...pairs("read", "a1", "o1", 3)];
    expect(detectStuck(steps).map((e) => e.pattern)).not.toContain("repeated-action-observation");
  });

  test("poller tools are exempt", () => {
    expect(detectStuck(pairs("process", "a1", "o1", 9)).map((e) => e.pattern)).not.toContain("repeated-action-observation");
    expect(detectStuck(pairs("job_get_result", "a1", "o1", 9)).map((e) => e.pattern)).not.toContain("repeated-action-observation");
  });
});

describe("repeated-action-error", () => {
  test("fires at the 3rd failing repeat of the same action, not before", () => {
    expect(detectStuck(pairs("bash", "e1", "x1", 2, false)).map((e) => e.pattern)).not.toContain("repeated-action-error");
    const at3 = detectStuck(pairs("bash", "e1", "x1", 3, false));
    expect(at3.find((e) => e.pattern === "repeated-action-error")).toBeDefined();
  });

  test("success or a changed action resets it", () => {
    const recover = [...pairs("bash", "e1", "x1", 2, false), act("bash", "e1"), obs("bash", "x9", true), ...pairs("bash", "e1", "x1", 2, false)];
    expect(detectStuck(recover).map((e) => e.pattern)).not.toContain("repeated-action-error");
  });
});

describe("monologue (no-progress assistant turns)", () => {
  test("fires at the 3rd consecutive no-tool assistant turn", () => {
    expect(detectStuck([say(), say()]).map((e) => e.pattern)).not.toContain("monologue");
    expect(detectStuck([say(), say(), say()]).map((e) => e.pattern)).toContain("monologue");
  });

  test("a tool call or a user turn resets it", () => {
    expect(detectStuck([say(), say(), act("read", "a"), obs("read", "o"), say(), say()]).map((e) => e.pattern)).not.toContain("monologue");
    expect(detectStuck([say(), say(), usr(), say(), say()]).map((e) => e.pattern)).not.toContain("monologue");
  });
});

describe("ping-pong", () => {
  test("fires at the 6th action of a strict two-signature alternation, not before", () => {
    const two = [act("read", "A"), obs("read", "oA"), act("edit", "B"), obs("edit", "oB"), act("read", "A"), obs("read", "oA"), act("edit", "B"), obs("edit", "oB")];
    expect(detectStuck(two).map((e) => e.pattern)).not.toContain("ping-pong");
    const six = [...two, act("read", "A"), obs("read", "oA"), act("edit", "B"), obs("edit", "oB")];
    expect(detectStuck(six).find((e) => e.pattern === "ping-pong")).toBeDefined();
  });

  test("strict alternation does NOT also count as repeated-action-observation", () => {
    const six: StuckStep[] = [];
    for (let i = 0; i < 6; i++) six.push(i % 2 === 0 ? act("read", "A") : act("edit", "B"), obs(i % 2 === 0 ? "read" : "edit", i % 2 === 0 ? "oA" : "oB"));
    const events = detectStuck(six);
    expect(events.find((e) => e.pattern === "ping-pong")).toBeDefined();
    expect(events.map((e) => e.pattern)).not.toContain("repeated-action-observation");
  });

  test("a third signature or a repeat breaks the alternation", () => {
    const withThird = [
      act("read", "A"), obs("read", "oA"), act("edit", "B"), obs("edit", "oB"),
      act("read", "A"), obs("read", "oA"), act("grep", "C"), obs("grep", "oC"),
      act("read", "A"), obs("read", "oA"), act("edit", "B"), obs("edit", "oB"),
    ];
    expect(detectStuck(withThird).map((e) => e.pattern)).not.toContain("ping-pong");
    const withRepeat = [
      act("read", "A"), obs("read", "oA"), act("read", "A"), obs("read", "oA"),
      act("edit", "B"), obs("edit", "oB"), act("read", "A"), obs("read", "oA"),
      act("edit", "B"), obs("edit", "oB"), act("read", "A"), obs("read", "oA"),
    ];
    expect(detectStuck(withRepeat).map((e) => e.pattern)).not.toContain("ping-pong");
  });
});

describe("context-window-thrash", () => {
  test("fires on 2 consecutive context-window errors, resets after a normal step", () => {
    const cw = (ok = false): StuckStep => ({ kind: "observation", tool: "read", signature: `x${Math.random()}`, ok, isContextWindowError: true });
    const normal = (): StuckStep => ({ kind: "observation", tool: "read", signature: `fresh${Math.random()}`, ok: true });
    expect(detectStuck([cw()]).map((e) => e.pattern)).not.toContain("context-window-thrash");
    expect(detectStuck([cw(), cw()]).map((e) => e.pattern)).toContain("context-window-thrash");
    // a normal observation between the errors breaks the consecutive run
    expect(detectStuck([cw(), normal(), cw()]).map((e) => e.pattern)).not.toContain("context-window-thrash");
  });
});

describe("stateful API", () => {
  test("observe/detect matches the stateless batch, reset clears", () => {
    const d = new StuckDetector();
    for (const s of pairs("read", "a1", "o1", 4)) d.observe(s);
    const streamed = d.detect();
    expect(streamed.find((e) => e.pattern === "repeated-action-observation")).toBeDefined();
    d.reset();
    expect(d.detect()).toEqual([]);
    expect(d.isStuck()).toBe(false);
  });

  test("isStuck agrees with detect", () => {
    const d = new StuckDetector();
    for (const s of [say(), say(), say()]) d.observe(s);
    expect(d.isStuck()).toBe(true);
  });

  test("a long session beyond the window bound does not crash or false-fire", () => {
    const steps: StuckStep[] = [];
    for (let i = 0; i < 60; i++) steps.push(act("read", `a${i}`, ), obs("read", `o${i}`));
    steps.push(say(), say(), say());
    const events = detectStuck(steps);
    expect(events.find((e) => e.pattern === "monologue")).toBeDefined();
  });

  test("empty detector reports nothing", () => {
    expect(detectStuck([])).toEqual([]);
  });

  test("custom thresholds are honored", () => {
    const steps = pairs("read", "a1", "o1", 2);
    expect(detectStuck(steps, { thresholds: { actionObservation: 2 } }).map((e) => e.pattern)).toContain("repeated-action-observation");
  });
});
