/** Two ceilings on a run — turns and wall-clock seconds — and how they reach the loop. Pinned: a scripted
 *  model that never stops calling tools hits `maxTurns` and ends with run_end "budget" (exit 1) carrying what
 *  was done; a fake clock crossing `maxSeconds` ends the run at the NEXT turn boundary, never mid-tool, with the
 *  turn count in the summary; the flags/env/default ladder (cli/run-limits.ts) with a usage error for junk; the
 *  runtime's buildCfg reads env and setRunLimits ahead of it; the working agreement carries the verify ceiling. */

import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { agentLoop, SteeringQueue } from "../../src/core/loop.ts";
import { SessionStore } from "../../src/core/session.ts";
import { ToolRegistry } from "../../src/core/tools.ts";
import type { AgentDefinition, RunConfig, RunEvent, StreamFn, Tool } from "../../src/core/types.ts";
import { toolTurn } from "../../src/providers/stream.ts";
import { exitCodeFor } from "../../src/cli/output.ts";
import { parseRunLimits, positiveInt } from "../../src/cli/run-limits.ts";
import { createRuntime } from "../../src/cli/runtime.ts";
import { GLM_53_AGENT_CONTRACT } from "../../src/providers/profile-glm53.ts";

const dirs: string[] = [];
function tmp(): string { const d = mkdtempSync(join(tmpdir(), "rovecode-limits-")); dirs.push(d); return d; }
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const NOOP: Tool = { kind: "read", schema: { name: "noop", description: "does nothing", args: { type: "object" } }, async execute() { return { ok: true, output: "ok" }; } };
/** a model that never finishes: every turn is one more tool call */
const forever: StreamFn = async function* () { yield { type: "turn", turn: toolTurn([{ id: `c${Math.random()}`, tool: "noop", args: {} }]) }; };
const def: AgentDefinition = { name: "t", systemPrompt: "test", tools: ["*"] };
const cfg = (over: Partial<RunConfig>): RunConfig => ({ maxTurns: 60, contextBudgetTokens: 100_000, compactionThreshold: 0.8, parallelTools: true, permissionRules: [{ action: "*", resource: "*", effect: "allow" }], ...over });

async function run(c: RunConfig, clock?: () => number): Promise<RunEvent[]> {
  const registry = new ToolRegistry(); registry.register(NOOP);
  const store = new SessionStore(tmp(), randomUUID());
  const events: RunEvent[] = [];
  for await (const ev of agentLoop(def, "go", {}, c, { stream: forever, registry, store, ...(clock ? { clock } : {}) }, new SteeringQueue())) events.push(ev);
  return events;
}
const end = (events: RunEvent[]) => events.find((e): e is Extract<RunEvent, { type: "run_end" }> => e.type === "run_end")!;

test("turn cap: a model that never stops ends with run_end budget after exactly maxTurns turns, every tool result kept, exit code 1", async () => {
  const events = await run(cfg({ maxTurns: 3 }));
  expect(events.filter((e) => e.type === "turn_start").length).toBe(3);
  expect(events.filter((e) => e.type === "tool_execution_end").length).toBe(3); // the work done so far is in the transcript
  expect(end(events)).toEqual({ type: "run_end", status: "budget", summary: "max turns (3) reached" });
  expect(exitCodeFor("budget")).toBe(1);
});

test("wall clock: a fake clock crossing maxSeconds ends the run at the next turn boundary — never mid-tool — and the summary says how many turns ran; no clock, no stop", async () => {
  let now = 0;
  const ticks: number[] = [];
  // the clock is in ms like Date.now; each read advances 400 s: startedAt=0, turn1 check 400, turn2 check 800, turn3 check 1200 ≥ 1000 → stop
  const clock = () => { ticks.push(now); const t = now; now += 400_000; return t; };
  const events = await run(cfg({ maxSeconds: 1000 }), clock);
  expect(events.filter((e) => e.type === "turn_start").length).toBe(2);
  expect(events.filter((e) => e.type === "tool_execution_end").length).toBe(2); // both tools that started also finished
  expect(end(events)).toEqual({ type: "run_end", status: "budget", summary: "wall clock (1000s) reached after 2 turns" });
  // no maxSeconds: the same clock never stops the run; the turn cap does
  now = 0;
  const free = await run(cfg({ maxTurns: 5 }), clock);
  expect(end(free).summary).toBe("max turns (5) reached");
  // one turn: singular
  now = 0;
  const one = await run(cfg({ maxSeconds: 500 }), () => { const t = now; now += 400_000; return t; });
  expect(end(one).summary).toBe("wall clock (500s) reached after 1 turn");
});

test("parseRunLimits: flags beat env beats the headless default; --max-seconds off means no clock; junk is a usage error, never a silent default", () => {
  expect(parseRunLimits(["run", "x"], {}, { defaultSeconds: 1200 })).toEqual({ maxSeconds: 1200 });
  expect(parseRunLimits(["run", "x"], {})).toEqual({});
  expect(parseRunLimits(["run", "x", "--max-turns", "12", "--max-seconds", "90"], { ROVECODE_MAX_TURNS: "3", ROVECODE_MAX_SECONDS: "5" }, { defaultSeconds: 1200 })).toEqual({ maxTurns: 12, maxSeconds: 90 });
  expect(parseRunLimits(["run", "x"], { ROVECODE_MAX_TURNS: "3", ROVECODE_MAX_SECONDS: "5" }, { defaultSeconds: 1200 })).toEqual({ maxTurns: 3, maxSeconds: 5 });
  expect(parseRunLimits(["run", "x", "--max-seconds", "off"], {}, { defaultSeconds: 1200 })).toEqual({});
  expect(parseRunLimits(["run", "x"], { ROVECODE_MAX_SECONDS: "none" }, { defaultSeconds: 1200 })).toEqual({});
  expect(parseRunLimits(["run", "x", "--max-turns", "0"], {})).toEqual({ error: '--max-turns wants a positive whole number, not "0"' });
  expect(parseRunLimits(["run", "x", "--max-turns"], {})).toEqual({ error: '--max-turns wants a positive whole number, not ""' });
  expect(parseRunLimits(["run", "x", "--max-seconds", "ten"], {})).toEqual({ error: '--max-seconds wants a positive whole number of seconds (or "off"), not "ten"' });
  expect(parseRunLimits(["run", "x"], { ROVECODE_MAX_TURNS: "junk" })).toEqual({}); // env junk: ignored, the default stands
  expect(positiveInt(" 7 ")).toBe(7);
  expect(positiveInt("7.5")).toBeUndefined();
  expect(positiveInt("-1")).toBeUndefined();
});

test("runtime: buildCfg takes ROVECODE_MAX_TURNS / ROVECODE_MAX_SECONDS, setRunLimits beats them, and without either it is 60 turns and no clock", async () => {
  const cwd = tmp();
  const saved = { t: process.env.ROVECODE_MAX_TURNS, s: process.env.ROVECODE_MAX_SECONDS };
  try {
    delete process.env.ROVECODE_MAX_TURNS; delete process.env.ROVECODE_MAX_SECONDS;
    const rt = createRuntime({ cwd, stream: null });
    const plain = rt.buildCfg(false);
    expect(plain.maxTurns).toBe(60);
    expect("maxSeconds" in plain).toBe(false);
    process.env.ROVECODE_MAX_TURNS = "7"; process.env.ROVECODE_MAX_SECONDS = "300";
    expect(rt.buildCfg(false)).toMatchObject({ maxTurns: 7, maxSeconds: 300 });
    rt.setRunLimits({ maxTurns: 2, maxSeconds: 1200 });
    expect(rt.buildCfg(true)).toMatchObject({ maxTurns: 2, maxSeconds: 1200 });
    rt.setRunLimits({});
    expect(rt.buildCfg(false)).toMatchObject({ maxTurns: 7, maxSeconds: 300 });
    await rt.hooks.close();
  } finally {
    if (saved.t === undefined) delete process.env.ROVECODE_MAX_TURNS; else process.env.ROVECODE_MAX_TURNS = saved.t;
    if (saved.s === undefined) delete process.env.ROVECODE_MAX_SECONDS; else process.env.ROVECODE_MAX_SECONDS = saved.s;
  }
});

test("the working agreement carries the verify ceiling in one sentence (reaches every model: the profile-less base prompt appends the same contract)", () => {
  expect(GLM_53_AGENT_CONTRACT).toContain("with the checks the task implies: a test, a build, design_audit or one structural read that would expose a mistake");
  expect(GLM_53_AGENT_CONTRACT).toContain("No pixel measuring, no probe pages, unless asked.");
});
