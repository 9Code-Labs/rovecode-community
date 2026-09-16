/** Port #14 wiring tests (R2 verdict HIGH-1/HIGH-2/MED-3/LOW-4): drive the REAL
 *  createRuntime stream (router.wrap OUTERMOST over provider+middleware) through the REAL
 *  agent loop against a local OpenAI-compatible stub — per the port-#7 middleware-wiring
 *  precedent. The seam assertions the module suite cannot see:
 *  - HIGH-1: env chain (ROVECODE_MODEL_DEFAULT) + scripted 429 from candidate 1 → candidate 2
 *    actually serves the turn (stub sees both models on the wire) AND exactly one advance
 *    note surfaces via drainRouterNotes(), draining once.
 *  - HIGH-2: the surviving assistant message's origin is the model that SERVED (candidate 2),
 *    and /cost (buildCostNote) prices that model, not the one the loop asked for.
 *  - MED-3: a requested model OUTSIDE the env chain still falls back into it (prepend).
 *  - LOW/MED-4: a single-model chain surfaces the provider error verbatim — no
 *    "chain exhausted" rewrite, no note. */

import { test, expect, beforeAll, afterAll } from "bun:test";
import { createRuntime } from "../../src/cli/runtime.ts";
import { agentLoop, SteeringQueue } from "../../src/core/loop.ts";
import { createRouter } from "../../src/providers/router.ts";
import { SessionStore } from "../../src/core/session.ts";
import { ToolRegistry } from "../../src/core/tools.ts";
import { ModelCatalog } from "../../src/providers/catalog.ts";
import { costUsd } from "../../src/core/usage.ts";
import { buildCostNote } from "../../src/tui/cost.ts";
import type { AssistantTurn, ModelRef, RunConfig, RunEvent, StreamEvent, StreamFn } from "../../src/core/types.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------- OpenAI-compatible stub: per-model scripted availability ----------

const modelsSeen: string[] = [];

const server = Bun.serve({
  port: 0,
  fetch: async (req) => {
    const body = (await req.json()) as { model?: string };
    const model = body.model ?? "";
    modelsSeen.push(model);
    if (model === "alpha" || model === "gamma") return new Response("rate limited", { status: 429 });
    if (model === "beta") {
      return Response.json({
        choices: [{ message: { content: "beta says hi" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 7, completion_tokens: 5 },
      });
    }
    return new Response("no such model", { status: 500 });
  },
});

// ---------- env harness (bun runs test files in one process — always restore) ----------

const ENV_KEYS = [
  "ROVECODE_BASE_URL", "ROVECODE_API_KEY", "ROVECODE_MODEL",
  "ROVECODE_MODEL_DEFAULT", "ROVECODE_MODEL_SMOL", "ROVECODE_MODEL_PLAN", "ROVECODE_MODEL_COMMIT", "ROVECODE_MODEL_TASK",
  "ROVECODE_NO_TOOL_MIDDLEWARE", "ROVECODE_TOOL_MIDDLEWARE", "ROVECODE_NO_REPOMAP", "ROVECODE_RETRY_MAX",
] as const;
const savedEnv = new Map<string, string | undefined>();
const tmpDirs: string[] = [];

beforeAll(() => {
  for (const k of ENV_KEYS) { savedEnv.set(k, process.env[k]); delete process.env[k]; }
  process.env.ROVECODE_BASE_URL = `http://127.0.0.1:${server.port}/v1`;
  process.env.ROVECODE_API_KEY = "test-key";
  process.env.ROVECODE_MODEL_DEFAULT = "custom/alpha, custom/beta";
  process.env.ROVECODE_NO_REPOMAP = "1"; // hermetic + fast buildDef in tmp cwds
  process.env.ROVECODE_RETRY_MAX = "0"; // port #23: same-model retry off — these tests pin chain advance alone (retry-wiring.test.ts covers the interplay)
});

afterAll(() => {
  for (const k of ENV_KEYS) {
    const v = savedEnv.get(k);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  server.stop(true);
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

// ---------- helpers ----------

function tmpCwd(): string {
  const d = mkdtempSync(join(tmpdir(), "rovecode-router-wiring-"));
  tmpDirs.push(d);
  return d;
}

/** One goal through the REAL loop on the runtime's REAL (router-wrapped) stream. */
async function drive(rt: ReturnType<typeof createRuntime>, model: ModelRef, goal: string): Promise<RunEvent[]> {
  if (!rt.stream) throw new Error("runtime has no stream — provider not resolved from env");
  const events: RunEvent[] = [];
  const deps = { stream: rt.stream, registry: rt.registry, store: rt.store, guard: rt.guard };
  for await (const ev of agentLoop(rt.buildDef(model), goal, {}, rt.buildCfg(true), deps, new SteeringQueue())) {
    events.push(ev);
  }
  return events;
}

const runEnd = (events: RunEvent[]): Extract<RunEvent, { type: "run_end" }> => {
  const end = events.find((e) => e.type === "run_end");
  if (!end || end.type !== "run_end") throw new Error("no run_end event");
  return end;
};

// ---------- HIGH-1: the seam — env chain + 429 → candidate 2 serves, one note ----------

test("real wiring: 429 on the env-chain head fails over — candidate 2 serves, exactly one note", async () => {
  const rt = createRuntime({ cwd: tmpCwd() });
  const before = modelsSeen.length;
  const events = await drive(rt, { provider: "custom", model: "alpha" }, "hello");

  // candidate 2 actually served: both models hit the wire, in chain order, and its text won
  expect(modelsSeen.slice(before)).toEqual(["alpha", "beta"]);
  const end = runEnd(events);
  expect(end.status).toBe("done");
  expect(end.summary).toBe("beta says hi");

  // exactly one advance note surfaced, and it drains exactly once
  const notes = rt.drainRouterNotes();
  expect(notes).toHaveLength(1);
  expect(notes[0]).toContain("custom/alpha");
  expect(notes[0]).toContain("custom/beta");
  expect(notes[0]).toContain("429");
  expect(rt.drainRouterNotes()).toHaveLength(0);

  // HIGH-2 at the seam: origin records the model that SERVED, not the one asked for
  const assistant = rt.store.messages().find((m) => m.role === "assistant");
  expect(assistant?.origin).toEqual({ provider: "custom", model: "beta" });
  expect(assistant?.usage).toMatchObject({ input: 7, output: 5 });
});

// ---------- MED-3: a model OUTSIDE the env chain still gets it as a fallback pool ----------

test("real wiring: requested model outside the env chain falls back into it (prepend)", async () => {
  const rt = createRuntime({ cwd: tmpCwd() });
  const before = modelsSeen.length;
  const events = await drive(rt, { provider: "custom", model: "gamma" }, "hello");

  // gamma stays primary, then the configured chain serves
  expect(modelsSeen.slice(before)).toEqual(["gamma", "alpha", "beta"]);
  const end = runEnd(events);
  expect(end.status).toBe("done");
  expect(end.summary).toBe("beta says hi");
  expect(rt.drainRouterNotes()).toHaveLength(2); // gamma→alpha, alpha→beta
});

// ---------- LOW/MED-4: single-model chain → provider error verbatim, no note ----------

test("real wiring: single-model env chain surfaces the raw provider error — no exhausted rewrite, no note", async () => {
  process.env.ROVECODE_MODEL_DEFAULT = "custom/alpha";
  try {
    const rt = createRuntime({ cwd: tmpCwd() });
    const before = modelsSeen.length;
    const events = await drive(rt, { provider: "custom", model: "alpha" }, "hello");
    expect(modelsSeen.slice(before)).toEqual(["alpha"]);
    const end = runEnd(events);
    expect(end.status).toBe("error");
    expect(end.summary).toContain("HTTP 429: rate limited");
    expect(end.summary).not.toContain("exhausted");
    expect(rt.drainRouterNotes()).toHaveLength(0);
  } finally {
    process.env.ROVECODE_MODEL_DEFAULT = "custom/alpha, custom/beta";
  }
});

// ---------- MED-3 seam gate: env UNSET → the synthesized default must NOT capture loose models ----------

test("real wiring: with ROVECODE_MODEL_DEFAULT unset, a failing model gets NO loose fallback (env gate off)", async () => {
  delete process.env.ROVECODE_MODEL_DEFAULT;
  try {
    const rt = createRuntime({ cwd: tmpCwd() });
    const before = modelsSeen.length;
    const events = await drive(rt, { provider: "custom", model: "alpha" }, "hello");
    // gate off: alpha alone — the synthesized {custom,default} placeholder is never tried
    expect(modelsSeen.slice(before)).toEqual(["alpha"]);
    const end = runEnd(events);
    expect(end.status).toBe("error");
    expect(end.summary).toContain("HTTP 429: rate limited");
    expect(end.summary).not.toContain("exhausted");
    expect(rt.drainRouterNotes()).toHaveLength(0);
  } finally {
    process.env.ROVECODE_MODEL_DEFAULT = "custom/alpha, custom/beta";
  }
});

// ---------- HIGH-2: /cost prices the SERVING model (buildCostNote composes from origin) ----------

test("origin honesty: after a fallback /cost prices candidate 2, not the requested model", async () => {
  const c1: ModelRef = { provider: "openai", model: "gpt-4o" };
  const c2: ModelRef = { provider: "openai", model: "gpt-4o-mini" };
  const usage = { input: 1_000_000, output: 1_000_000 };
  const scripted: StreamFn = async function* (model): AsyncGenerator<StreamEvent> {
    const turn: AssistantTurn = model.model === c1.model
      ? { parts: [], stopReason: "error", usage: { input: 0, output: 0 }, error: "HTTP 429: rate limited" }
      : { parts: [{ kind: "text", text: "served by mini" }], stopReason: "end_turn", usage };
    yield { type: "turn", turn };
  };
  const router = createRouter({ roles: { default: [c1, c2] } });
  const store = new SessionStore(tmpCwd(), "cost-origin");
  const cfg: RunConfig = {
    maxTurns: 3, contextBudgetTokens: 100_000, compactionThreshold: 0.8, parallelTools: true,
    permissionRules: [{ action: "*", resource: "*", effect: "allow" }],
  };
  const def = { name: "t", systemPrompt: "sys", tools: ["*"], model: c1 };
  const deps = { stream: router.wrap(scripted), registry: new ToolRegistry(), store };
  for await (const ev of agentLoop(def, "hi", {}, cfg, deps, new SteeringQueue())) void ev;

  const assistant = store.messages().find((m) => m.role === "assistant");
  expect(assistant?.origin).toEqual(c2); // stamped with the model that SERVED

  const catalog = new ModelCatalog();
  const p1 = catalog.lookup(c1.provider, c1.model)?.pricing;
  const p2 = catalog.lookup(c2.provider, c2.model)?.pricing;
  if (!p1 || !p2) throw new Error("catalog snapshot lost openai pricing — pick other models");
  const at1 = costUsd({ ...usage, cacheRead: 0, cacheWrite: 0 }, p1)!;
  const at2 = costUsd({ ...usage, cacheRead: 0, cacheWrite: 0 }, p2)!;
  expect(at1).not.toBe(at2); // the assertion below discriminates between the two stampings

  const note = buildCostNote(store.messages(), catalog, c1); // current = the model the loop ASKED for
  expect(note).toContain(`estimated cost: $${at2.toFixed(4)}`);
  expect(note).not.toContain(`estimated cost: $${at1.toFixed(4)}`);
  expect(note).not.toContain("without origin"); // origin was stamped, no caveat
});
