/** `--max-cost D` / ROVECODE_MAX_COST: a spend ceiling on one run, priced from each turn's usage as it lands.
 *  Pinned: the parse ladder (flag, "off", $-prefixed, junk = usage error, env fallback, a zero cap refused); the
 *  loop ends at the NEXT turn boundary once the priced total reaches the cap, with status "budget", the turn
 *  count, the dollars spent and the unpriced count in the summary; an unpriced turn never trips it; without a
 *  cap nothing is priced at all; and the runtime binds the cap and the pricer together from the catalog. */

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
import { parseRunLimits, positiveUsd } from "../../src/cli/run-limits.ts";
import { createRuntime } from "../../src/cli/runtime.ts";

const dirs: string[] = [];
function tmp(): string { const d = mkdtempSync(join(tmpdir(), "rovecode-maxcost-")); dirs.push(d); return d; }
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const NOOP: Tool = { kind: "read", schema: { name: "noop", description: "does nothing", args: { type: "object" } }, async execute() { return { ok: true, output: "ok" }; } };
/** a model that never finishes and reports the same usage every turn */
const forever: StreamFn = async function* () {
  yield { type: "turn", turn: { ...toolTurn([{ id: `c${Math.random()}`, tool: "noop", args: {} }]), usage: { input: 1000, output: 100 } } };
};
const def: AgentDefinition = { name: "t", systemPrompt: "test", tools: ["*"] };
const cfg = (over: Partial<RunConfig>): RunConfig => ({ maxTurns: 60, contextBudgetTokens: 100_000, compactionThreshold: 0.8, parallelTools: true, permissionRules: [{ action: "*", resource: "*", effect: "allow" }], ...over });

async function run(over: Partial<RunConfig>): Promise<RunEvent[]> {
  const registry = new ToolRegistry(); registry.register(NOOP);
  const store = new SessionStore(tmp(), randomUUID());
  const events: RunEvent[] = [];
  for await (const ev of agentLoop(def, "go", {}, cfg(over), { stream: forever, registry, store }, new SteeringQueue())) events.push(ev);
  return events;
}

test("parse: flag, $-prefixed, 'off', junk → usage error, zero refused, env fallback, flag beats env", () => {
  const env = {} as Record<string, string | undefined>;
  expect(parseRunLimits(["run", "--max-cost", "0.50"], env)).toMatchObject({ maxCostUsd: 0.5 });
  expect(parseRunLimits(["run", "--max-cost", "$2"], env)).toMatchObject({ maxCostUsd: 2 });
  expect("maxCostUsd" in parseRunLimits(["run", "--max-cost", "off"], { ROVECODE_MAX_COST: "5" })).toBe(false);
  expect(parseRunLimits(["run", "--max-cost", "lots"], env)).toEqual({ error: '--max-cost wants a positive amount in dollars (or "off"), not "lots"' });
  expect("maxCostUsd" in parseRunLimits(["run", "--max-cost", "0"], env)).toBe(false);          // "0" is "off", as it is for --max-seconds
  expect(parseRunLimits(["run", "--max-cost", "0.00"], env)).toMatchObject({ error: expect.stringContaining("positive amount") });
  expect(parseRunLimits(["run", "--max-cost"], env)).toMatchObject({ error: expect.stringContaining("--max-cost") });
  expect(parseRunLimits(["run"], { ROVECODE_MAX_COST: "1.25" })).toMatchObject({ maxCostUsd: 1.25 });
  expect("maxCostUsd" in parseRunLimits(["run"], { ROVECODE_MAX_COST: "junk" })).toBe(false);   // env junk is ignored, a flag is not
  expect(parseRunLimits(["run", "--max-cost", "3"], { ROVECODE_MAX_COST: "1" })).toMatchObject({ maxCostUsd: 3 });
  expect(positiveUsd(" $0.01 ")).toBe(0.01);
  expect(positiveUsd("-1")).toBeUndefined();
});

test("loop: $0.30 a turn against a $0.50 cap ends at the boundary after turn 2 with status budget, the count and the dollars in the summary", async () => {
  const priced: number[] = [];
  const events = await run({ maxCostUsd: 0.5, priceUsd: (u) => { priced.push(u.input); return 0.3; } });
  const end = events.at(-1) as { type: string; status: string; summary: string };
  expect(end.type).toBe("run_end");
  expect(end.status).toBe("budget");
  expect(end.summary).toBe("cost cap ($0.50) reached after 2 turns — $0.6000 spent");
  expect(events.filter((e) => e.type === "turn_end").length).toBe(2);                 // never mid-turn
  expect(priced).toEqual([1000, 1000]);                                               // priced from the turn's own usage
});

test("loop: unpriced turns never trip the cap and are counted in the summary; without a cap nothing is priced", async () => {
  let calls = 0;
  // turn 1 unpriced, turns 2-3 priced at $0.30 → cap reached after 3 turns with 1 unpriced
  const events = await run({ maxCostUsd: 0.5, maxTurns: 10, priceUsd: () => (++calls === 1 ? undefined : 0.3) });
  const end = events.at(-1) as { status: string; summary: string };
  expect(end.status).toBe("budget");
  expect(end.summary).toBe("cost cap ($0.50) reached after 3 turns — $0.6000 spent; 1 turn unpriced");

  let asked = 0;
  const noCap = await run({ maxTurns: 3, priceUsd: () => { asked++; return 0.3; } });
  expect((noCap.at(-1) as { summary: string }).summary).toBe("max turns (3) reached");
  expect(asked).toBe(0);                                                              // no cap → the pricer is never consulted
});

test("runtime: buildCfg binds the cap and a catalog-backed pricer together — from setRunLimits, else ROVECODE_MAX_COST, else neither", () => {
  const cwd = tmp();
  const rt = createRuntime({ cwd, stream: null });
  const bare = rt.buildCfg(true);
  expect(bare.maxCostUsd).toBeUndefined();
  expect(bare.priceUsd).toBeUndefined();
  rt.setRunLimits({ maxCostUsd: 0.75 });
  const capped = rt.buildCfg(true);
  expect(capped.maxCostUsd).toBe(0.75);
  expect(typeof capped.priceUsd).toBe("function");
  // the catalog prices a known model and declines an unknown one
  expect(capped.priceUsd!({ input: 1_000_000, output: 0 }, { provider: "anthropic", model: "claude-opus-5" })).toBeGreaterThan(0);
  expect(capped.priceUsd!({ input: 1000, output: 10 }, { provider: "nobody", model: "nothing" })).toBeUndefined();
  process.env.ROVECODE_MAX_COST = "2";
  try {
    const fromEnv = createRuntime({ cwd, stream: null }).buildCfg(true);
    expect(fromEnv.maxCostUsd).toBe(2);
  } finally { delete process.env.ROVECODE_MAX_COST; }
});
