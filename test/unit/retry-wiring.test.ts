/** Port #23 wiring tests: the REAL createRuntime stream — router.wrap(withRetry(middlewared)) —
 *  through the REAL agent loop against a local OpenAI-compatible stub (router-wiring.test.ts
 *  idiom). The seam assertions the module suite cannot see:
 *  - env chain A,B; A answers 429, 429, 200 → A serves, the stub saw A three times, and the
 *    router emitted ZERO notes (retries are not advances)
 *  - A answers 429 forever, AION_RETRY_MAX=2 → A is tried 3× (exhaust) THEN B serves — exactly
 *    one note; the swapped composition (retry OUTSIDE the router) would show A once
 *  - abort mid-backoff (Retry-After: 30 keeps the sleep long) → the run stops promptly, the stub
 *    never sees a second request, no note */

import { test, expect, beforeAll, afterAll } from "bun:test";
import { createRuntime } from "../../src/cli/runtime.ts";
import { agentLoop, SteeringQueue } from "../../src/core/loop.ts";
import type { ModelRef, RunEvent } from "../../src/core/types.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------- OpenAI-compatible stub: per-model scripted status sequences ----------

interface Step { status: number; retryAfter?: string }

const modelsSeen: string[] = [];
const scripts = new Map<string, Step[]>(); // per-model steps, the last repeats; unscripted → 200
const cursors = new Map<string, number>();
let onRequest: ((model: string) => void) | null = null;

function script(model: string, steps: Step[]): void { scripts.set(model, steps); cursors.set(model, 0); }

const server = Bun.serve({
  port: 0,
  fetch: async (req) => {
    const body = (await req.json()) as { model?: string };
    const model = body.model ?? "";
    modelsSeen.push(model);
    onRequest?.(model);
    const steps = scripts.get(model) ?? [];
    const i = cursors.get(model) ?? 0;
    cursors.set(model, i + 1);
    const step = steps[Math.min(i, steps.length - 1)] ?? { status: 200 };
    if (step.status !== 200) {
      return new Response(`${model} says no`, { status: step.status, headers: step.retryAfter === undefined ? {} : { "retry-after": step.retryAfter } });
    }
    return Response.json({
      choices: [{ message: { content: `${model} says hi` }, finish_reason: "stop" }],
      usage: { prompt_tokens: 7, completion_tokens: 5 },
    });
  },
});

// ---------- env harness (bun runs test files in one process — always restore) ----------

const ENV_KEYS = [
  "AION_BASE_URL", "AION_API_KEY", "AION_MODEL",
  "AION_MODEL_DEFAULT", "AION_MODEL_SMOL", "AION_MODEL_PLAN", "AION_MODEL_COMMIT", "AION_MODEL_TASK",
  "AION_NO_TOOL_MIDDLEWARE", "AION_TOOL_MIDDLEWARE", "AION_NO_REPOMAP",
  "AION_RETRY_MAX", "AION_RETRY_BASE_MS",
] as const;
const savedEnv = new Map<string, string | undefined>();
const tmpDirs: string[] = [];

beforeAll(() => {
  for (const k of ENV_KEYS) { savedEnv.set(k, process.env[k]); delete process.env[k]; }
  process.env.AION_BASE_URL = `http://127.0.0.1:${server.port}/v1`;
  process.env.AION_API_KEY = "test-key";
  process.env.AION_MODEL_DEFAULT = "custom/alpha, custom/beta";
  process.env.AION_NO_REPOMAP = "1"; // hermetic + fast buildDef in tmp cwds
  process.env.AION_RETRY_MAX = "2"; // 1 attempt + 2 retries per candidate
  process.env.AION_RETRY_BASE_MS = "1"; // REAL backoff with millisecond caps — the schedule itself is pinned in retry.test.ts
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
  const d = mkdtempSync(join(tmpdir(), "aion-retry-wiring-"));
  tmpDirs.push(d);
  return d;
}

/** One goal through the REAL loop on the runtime's REAL (router → retry → middleware → adapter) stream. */
async function drive(rt: ReturnType<typeof createRuntime>, model: ModelRef, goal: string, signal?: AbortSignal): Promise<RunEvent[]> {
  if (!rt.stream) throw new Error("runtime has no stream — provider not resolved from env");
  const events: RunEvent[] = [];
  const deps = { stream: rt.stream, registry: rt.registry, store: rt.store, guard: rt.guard, ...(signal ? { signal } : {}) };
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

/** Bounded await (acp.test.ts idiom): a hang-shaped mutant fails here instead of hanging bun. */
function deadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const bomb = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error(`${what}: not settled within ${ms}ms`)), ms); });
  return Promise.race([p, bomb]).finally(() => clearTimeout(t));
}

async function until(pred: () => boolean, ms = 2_000): Promise<void> {
  const start = performance.now();
  while (!pred()) {
    if (performance.now() - start > ms) throw new Error(`condition not met within ${ms}ms`);
    await new Promise<void>((r) => setTimeout(r, 5));
  }
}

// ---------- retries are not advances ----------

test("real wiring: 429, 429, 200 on the chain head → the head serves after two same-model retries; ZERO router notes", async () => {
  script("alpha", [{ status: 429 }, { status: 429 }, { status: 200 }]);
  const rt = createRuntime({ cwd: tmpCwd() });
  const before = modelsSeen.length;
  const events = await drive(rt, { provider: "custom", model: "alpha" }, "hello");

  expect(modelsSeen.slice(before)).toEqual(["alpha", "alpha", "alpha"]); // same model on the wire each time
  const end = runEnd(events);
  expect(end.status).toBe("done");
  expect(end.summary).toBe("alpha says hi");
  expect(rt.drainRouterNotes()).toEqual([]); // retries are not advances
  const assistant = rt.store.messages().find((m) => m.role === "assistant");
  expect(assistant?.origin).toEqual({ provider: "custom", model: "alpha" });
  expect(assistant?.usage).toMatchObject({ input: 7, output: 5 });
});

// ---------- exhaust THEN advance ----------

test("real wiring: 429 forever on the head → retries EXHAUST (1 + AION_RETRY_MAX) THEN the chain advances; exactly one note", async () => {
  script("alpha", [{ status: 429 }]);
  const rt = createRuntime({ cwd: tmpCwd() });
  const before = modelsSeen.length;
  const events = await drive(rt, { provider: "custom", model: "alpha" }, "hello");

  // M8 (composition swapped to withRetry(router.wrap(...))) shows ["alpha", "beta"] here
  expect(modelsSeen.slice(before)).toEqual(["alpha", "alpha", "alpha", "beta"]);
  const end = runEnd(events);
  expect(end.status).toBe("done");
  expect(end.summary).toBe("beta says hi");
  const notes = rt.drainRouterNotes();
  expect(notes).toHaveLength(1);
  expect(notes[0]).toContain("custom/alpha");
  expect(notes[0]).toContain("custom/beta");
  expect(notes[0]).toContain("429");
  expect(rt.drainRouterNotes()).toHaveLength(0);
});

// ---------- abort mid-backoff ----------

test("real wiring: abort mid-backoff → the sleep wakes, no further request, no note, run stopped", async () => {
  script("alpha", [{ status: 429, retryAfter: "30" }]); // 30s server floor: only the abort can end the wait in time
  const rt = createRuntime({ cwd: tmpCwd() });
  const ac = new AbortController();
  const before = modelsSeen.length;
  let seen = 0;
  onRequest = (m) => { if (m === "alpha") seen++; };
  const started = performance.now();
  try {
    const run = drive(rt, { provider: "custom", model: "alpha" }, "hello", ac.signal);
    await until(() => seen === 1); // the stub answered 429 …
    await new Promise<void>((r) => setTimeout(r, 50)); // … and the wrapper has entered its backoff sleep
    ac.abort();
    const events = await deadline(run, 4_000, "run after abort mid-backoff");
    expect(runEnd(events).status).toBe("stopped");
    expect(modelsSeen.slice(before)).toEqual(["alpha"]); // no retry, no advance to beta
    expect(rt.drainRouterNotes()).toEqual([]);
    expect(performance.now() - started).toBeLessThan(3_000); // woke on the abort, not after 30s
  } finally {
    onRequest = null;
  }
});
