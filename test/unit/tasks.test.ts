/** PORT #26 — TaskManager: bounded FIFO background jobs over orchestrator runChild.
 *  Children here run through the REAL runChild → agentLoop with scripted streams; only
 *  the provider is mocked. Every wait is deadline-bounded (a parked promise with no
 *  pending timer hangs the Bun runner). Each test names its mutation target. */

import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { TaskManager, taskNote, formatTaskList, tasksMaxFromEnv, DEFAULT_TASKS_MAX, type TaskManagerOptions, type TaskStatus } from "../../src/core/tasks.ts";
import { createTaskStatusTool, DEFAULT_WAIT_MS } from "../../src/tools/task.ts";
import { SteeringQueue } from "../../src/core/loop.ts";
import { ToolRegistry } from "../../src/core/tools.ts";
import { writeTool } from "../../src/coding/hashline.ts";
import { textTurn, toolTurn } from "../../src/providers/stream.ts";
import type { ChildRunnerDeps } from "../../src/core/orchestrator.ts";
import type { AgentDefinition, Message, ModelRef, RunConfig, StreamEvent, StreamFn, StreamOptions, ToolContext } from "../../src/core/types.ts";

const allowAll = [{ action: "*", resource: "*", effect: "allow" as const }];
const cfg: RunConfig = { maxTurns: 6, contextBudgetTokens: 100_000, compactionThreshold: 0.8, parallelTools: false, permissionRules: allowAll };
const worker: AgentDefinition = { name: "worker", systemPrompt: "w", tools: ["*"] };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Bounded await (server.test.ts idiom): the deadline rejects below bun's per-test
 *  timeout so a hang-shaped mutant reads as OUR failure, and finally blocks still run. */
function deadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const bomb = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error(`${what}: not settled within ${ms}ms`)), ms); });
  return Promise.race([p, bomb]).finally(() => clearTimeout(t));
}

/** A child's identity is its goal: runChild appends it as the run's first user message. */
function goalOf(messages: Message[]): string {
  const u = messages.find((m) => m.role === "user");
  return u ? u.parts.filter((p) => p.kind === "text").map((p) => (p as { text: string }).text).join("") : "";
}

/** Scripted children: goals starting with "HOLD" park until released — or until the
 *  run's OWN signal aborts (then an aborted turn, like a killed fetch). Others answer
 *  `done: <goal>` at once. Records which goals started and each run's signal. */
function gatedChildren() {
  const gates = new Map<string, { release: () => void; opened: Promise<void> }>();
  const gate = (goal: string) => {
    let g = gates.get(goal);
    if (!g) { let release!: () => void; const opened = new Promise<void>((r) => { release = r; }); g = { release, opened }; gates.set(goal, g); }
    return g;
  };
  const started: string[] = [];
  const startWaiters = new Map<string, () => void>();
  const signals = new Map<string, AbortSignal>();
  const stream: StreamFn = async function* (_m: ModelRef, messages: Message[], opts?: StreamOptions): AsyncGenerator<StreamEvent> {
    const goal = goalOf(messages);
    started.push(goal);
    startWaiters.get(goal)?.();
    if (opts?.signal) signals.set(goal, opts.signal);
    if (goal.startsWith("HOLD")) {
      const sig = opts?.signal;
      const aborted = new Promise<"aborted">((r) => {
        if (sig?.aborted) r("aborted"); else sig?.addEventListener("abort", () => r("aborted"), { once: true });
      });
      const w = await Promise.race([gate(goal).opened.then(() => "released" as const), aborted]);
      if (w === "aborted") { yield { type: "turn", turn: { parts: [], stopReason: "aborted", usage: { input: 0, output: 0 } } }; return; }
    }
    yield { type: "turn", turn: textTurn(`done: ${goal}`) };
  };
  const untilStarted = (goal: string): Promise<void> =>
    started.includes(goal) ? Promise.resolve() : new Promise<void>((r) => startWaiters.set(goal, r));
  return { stream, started, untilStarted, release: (goal: string) => gate(goal).release(), releaseAll: () => { for (const g of gates.values()) g.release(); }, signalOf: (goal: string) => signals.get(goal) };
}

function makeManager(stream: StreamFn, over: Partial<ChildRunnerDeps> = {}, opts: { max?: number; run?: TaskManagerOptions["run"]; maxDepth?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "rovecode-tasks-root-"));
  const sessions = mkdtempSync(join(tmpdir(), "rovecode-tasks-sess-"));
  const deps: ChildRunnerDeps = {
    defs: new Map([["worker", worker]]), stream, registryFactory: () => new ToolRegistry(),
    rootDir: root, sessionsDir: sessions, baseConfig: cfg, ...over,
  };
  const tasks = new TaskManager({ deps: () => deps, maxConcurrent: opts.max ?? 3, ...(opts.run ? { run: opts.run } : {}), ...(opts.maxDepth !== undefined ? { maxDepth: opts.maxDepth } : {}) });
  const cleanup = async () => {
    tasks.cancelAll();
    await tasks.drain(3_000);
    rmSync(root, { recursive: true, force: true });
    rmSync(sessions, { recursive: true, force: true });
  };
  return { tasks, root, sessions, cleanup };
}

const startOk = (tasks: TaskManager, goal: string, extra: Parameters<TaskManager["start"]>[1] = {}, agent = "worker"): string => {
  const r = tasks.start({ agent, goal }, extra);
  if (!r.ok) throw new Error(`start refused: ${r.reason}`);
  return r.id;
};

// ---------- concurrency bound ----------

test("concurrency bound: 4 starts → 3 run, the 4th queues, then runs when a slot frees", async () => {
  const kids = gatedChildren();
  const { tasks, cleanup } = makeManager(kids.stream, {}, { max: 3 });
  try {
    const ids = ["HOLD a", "HOLD b", "HOLD c", "HOLD d"].map((g) => startOk(tasks, g));
    expect(ids).toEqual(["t1", "t2", "t3", "t4"]);
    await deadline(Promise.all(["HOLD a", "HOLD b", "HOLD c"].map(kids.untilStarted)), 5_000, "first three children start");
    await sleep(150); // a bound-less mutant would have started the 4th by now
    expect(kids.started).toHaveLength(3); // mutation target: `this.running < this.maxConcurrent` in pump()
    expect(tasks.status("t4")?.status).toBe("queued");
    expect(tasks.counts()).toMatchObject({ running: 3, queued: 1 });
    kids.release("HOLD a");
    expect((await deadline(tasks.result("t1", { timeoutMs: 5_000 }), 6_000, "t1 settles"))?.status).toBe("done");
    await deadline(kids.untilStarted("HOLD d"), 5_000, "the 4th child starts once a slot frees");
    expect(tasks.status("t4")?.status).toBe("running");
    kids.releaseAll();
    expect(await tasks.drain(5_000)).toBe(true);
    expect(tasks.list().map((t) => t.status)).toEqual(["done", "done", "done", "done"]);
  } finally {
    kids.releaseAll();
    await cleanup();
  }
}, 20_000);

// ---------- status transitions ----------

test("status transitions: queued → running → done | failed | cancelled, one terminal emission each", async () => {
  const kids = gatedChildren();
  const failing: StreamFn = async function* () {
    yield { type: "turn", turn: { parts: [], stopReason: "error", usage: { input: 0, output: 0 }, error: "provider boom" } };
  };
  const { tasks, cleanup } = makeManager(kids.stream);
  const seen = new Map<string, TaskStatus[]>();
  tasks.subscribe((t) => { seen.set(t.id, [...(seen.get(t.id) ?? []), t.status]); });
  try {
    const okId = startOk(tasks, "HOLD ok");
    expect(seen.get(okId)).toEqual(["queued", "running"]); // start() emits queued, the pump launches at once
    kids.release("HOLD ok");
    const done = await deadline(tasks.result(okId, { timeoutMs: 5_000 }), 6_000, "ok child");
    expect(done?.status).toBe("done");
    expect(done?.startedAt).toBeDefined();
    expect(done?.finishedAt).toBeGreaterThanOrEqual(done!.startedAt!);
    expect(seen.get(okId)).toEqual(["queued", "running", "done"]);

    const cancelId = startOk(tasks, "HOLD cancel");
    await deadline(kids.untilStarted("HOLD cancel"), 5_000, "cancel child starts");
    expect(tasks.cancel(cancelId)?.status).toBe("cancelled");
    await deadline(tasks.result(cancelId, { timeoutMs: 5_000 }), 6_000, "cancelled child settles");
    expect(seen.get(cancelId)).toEqual(["queued", "running", "cancelled"]);

    const m2 = makeManager(failing);
    const failSeen: TaskStatus[] = [];
    m2.tasks.subscribe((t) => failSeen.push(t.status));
    const failId = startOk(m2.tasks, "explode");
    const failed = await deadline(m2.tasks.result(failId, { timeoutMs: 5_000 }), 6_000, "failing child");
    expect(failed?.status).toBe("failed");
    expect(failSeen).toEqual(["queued", "running", "failed"]);
    await m2.cleanup();
  } finally {
    kids.releaseAll();
    await cleanup();
  }
}, 20_000);

// ---------- result collection ----------

test("result collection: the child's final text and usage come back through result()", async () => {
  const kids = gatedChildren();
  const { tasks, cleanup } = makeManager(kids.stream);
  try {
    const id = startOk(tasks, "say hi", { label: "greeter" });
    const r = await deadline(tasks.result(id, { timeoutMs: 5_000 }), 6_000, "child result");
    expect(r?.status).toBe("done");
    expect(r?.summary).toBe("done: say hi"); // mutation target: finish() dropping r.summary
    expect(r?.usage).toEqual({ input: 0, output: 1 });
    expect(r?.label).toBe("greeter");
    expect(r?.depth).toBe(1); // root-started task = parent depth 0 + 1
    expect(r?.agent).toBe("worker");
    // a second result() on a settled task returns at once
    const t0 = Date.now();
    expect((await tasks.result(id))?.status).toBe("done");
    expect(Date.now() - t0).toBeLessThan(200);
    expect(await tasks.result("nope")).toBeUndefined();
  } finally {
    await cleanup();
  }
}, 15_000);

// ---------- cancel ----------

test("cancel mid-run aborts the child's run through the signal (deadline-bounded); a queued cancel never runs", async () => {
  const kids = gatedChildren();
  const { tasks, cleanup } = makeManager(kids.stream, {}, { max: 1 });
  try {
    const running = startOk(tasks, "HOLD cancel-me");
    const queued = startOk(tasks, "HOLD never");
    await deadline(kids.untilStarted("HOLD cancel-me"), 5_000, "child starts");
    const sig = kids.signalOf("HOLD cancel-me");
    expect(sig?.aborted).toBe(false);
    // queued cancel: removed from the queue, settles at once, never reaches the provider
    const q = tasks.cancel(queued);
    expect(q?.status).toBe("cancelled");
    expect(q?.finishedAt).toBeDefined();
    // running cancel: status flips now; the run settles when the aborted child returns.
    // Mutation target: drop `signal` from runChild's agentLoop deps → the child's stream
    // never sees an abort, the HOLD child parks, result() times out with no finishedAt.
    const c = tasks.cancel(running);
    expect(c?.status).toBe("cancelled");
    const settled = await deadline(tasks.result(running, { timeoutMs: 3_000 }), 4_000, "cancelled child settles");
    expect(settled?.status).toBe("cancelled");
    expect(settled?.finishedAt).toBeDefined();
    expect(settled?.error).toBe("cancelled");
    expect(sig?.aborted).toBe(true); // the child's run controller REALLY fired
    expect(kids.started).toEqual(["HOLD cancel-me"]); // the queued task never ran
    // cancel is idempotent on settled tasks and honest on unknown ids
    expect(tasks.cancel(running)?.status).toBe("cancelled");
    expect(tasks.cancel("nope")).toBeUndefined();
    expect(tasks.counts()).toMatchObject({ cancelled: 2, running: 0, queued: 0 });
  } finally {
    kids.releaseAll();
    await cleanup();
  }
}, 15_000);

// ---------- depth cap + spawn policy (the orchestrator's preflight, its reasons) ----------

test("depth cap: a start whose child would sit at the cap is refused with the orchestrator's reason; below the cap it runs", async () => {
  const kids = gatedChildren();
  const { tasks, cleanup } = makeManager(kids.stream);
  try {
    // mutation target: delete the preflightSpawn gate in start() → ok:true, a record exists
    const deep = tasks.start({ agent: "worker", goal: "too deep" }, { parentDepth: 2 });
    expect(deep.ok).toBe(false);
    if (!deep.ok) expect(deep.reason).toBe("depth cap 3 reached (current 3)");
    expect(tasks.list()).toHaveLength(0); // refusals leave no task behind
    const ok = tasks.start({ agent: "worker", goal: "fine" }, { parentDepth: 1 });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(tasks.status(ok.id)?.depth).toBe(2);
      expect((await deadline(tasks.result(ok.id, { timeoutMs: 5_000 }), 6_000, "depth-2 child"))?.status).toBe("done");
    }
    // a smaller cap is honored
    const strict = new TaskManager({ deps: () => ({ defs: new Map([["worker", worker]]), stream: kids.stream, registryFactory: () => new ToolRegistry(), rootDir: ".", sessionsDir: ".", baseConfig: cfg }), maxDepth: 1 });
    const r = strict.start({ agent: "worker", goal: "x" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("depth cap 1 reached");
  } finally {
    await cleanup();
  }
}, 15_000);

test("maxDepth ABOVE the orchestrator cap is clamped to it: a child at the cap is refused at start() as data, never launched-then-failed (fix-wave L4)", async () => {
  const kids = gatedChildren();
  // pre-fix: the manager accepted depth 3 (its own cap 5), launched the child, and runChild's
  // preflight (hard-coded DEFAULT_MAX_DEPTH) failed it — a "failed" task instead of a refusal
  const { tasks, cleanup } = makeManager(kids.stream, {}, { maxDepth: 5 });
  try {
    expect(tasks.maxDepth).toBe(3); // mutation target: the Math.min clamp in the constructor
    const r = tasks.start({ agent: "worker", goal: "at the cap" }, { parentDepth: 2 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("depth cap 3 reached (current 3)");
    expect(tasks.list()).toHaveLength(0);
    expect(kids.started).toEqual([]); // nothing reached the provider
    // below the cap the larger option changes nothing
    const ok = tasks.start({ agent: "worker", goal: "fine" }, { parentDepth: 1 });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect((await deadline(tasks.result(ok.id, { timeoutMs: 5_000 }), 6_000, "depth-2 child"))?.status).toBe("done");
  } finally {
    await cleanup();
  }
}, 15_000);

test("start() reports the child's policy class for the tool's output: 'gated' when the starting config has a prompt rule, 'open' under allow-all (fix-wave MED-2)", async () => {
  const kids = gatedChildren();
  const gatedCfg: RunConfig = { ...cfg, permissionRules: [{ action: "file.read", resource: "*", effect: "allow" }, { action: "spawn", resource: "*", effect: "prompt" }] };
  const g = makeManager(kids.stream, { baseConfig: gatedCfg });
  const o = makeManager(kids.stream);
  try {
    const r = g.tasks.start({ agent: "worker", goal: "policy gated" });
    expect(r.ok && r.childPolicy).toBe("gated"); // mutation target: the prompt-rule test in start()
    const r2 = o.tasks.start({ agent: "worker", goal: "policy open" });
    expect(r2.ok && r2.childPolicy).toBe("open");
  } finally {
    await g.cleanup();
    await o.cleanup();
  }
}, 15_000);

test("spawn policy 'none', unknown agent and no provider are refused as data (never throws)", () => {
  const kids = gatedChildren();
  const none: AgentDefinition = { ...worker, name: "hermit", spawns: "none" };
  const { tasks } = makeManager(kids.stream, { defs: new Map([["worker", worker], ["hermit", none]]) });
  const r = tasks.start({ agent: "hermit", goal: "x" });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.reason).toBe("agent 'hermit' spawn policy is 'none'");
  const u = tasks.start({ agent: "ghost", goal: "x" });
  expect(u.ok).toBe(false);
  if (!u.ok) expect(u.reason).toBe("unknown agent 'ghost'");
  const offline = new TaskManager({ deps: () => null });
  const o = offline.start({ agent: "worker", goal: "x" });
  expect(o.ok).toBe(false);
  if (!o.ok) expect(o.reason).toBe("no provider configured");
  expect(tasks.list()).toHaveLength(0);
});

// ---------- completion steer ----------

test("completion note lands in the attached SteeringQueue with id + label; a per-task notify queue wins; failures say so", async () => {
  const kids = gatedChildren();
  const failing: StreamFn = async function* () {
    yield { type: "turn", turn: { parts: [], stopReason: "error", usage: { input: 0, output: 0 }, error: "provider boom" } };
  };
  const { tasks, cleanup } = makeManager(kids.stream);
  const parent = new SteeringQueue();
  tasks.attach(parent);
  try {
    const id = startOk(tasks, "note me", { label: "notes job" });
    await deadline(tasks.result(id, { timeoutMs: 5_000 }), 6_000, "child");
    // mutation target: drop the push in settle() → size 0
    expect(parent.size).toBe(1);
    const note = parent.drainAll()[0]!;
    expect(note).toContain(`task ${id} (notes job) finished`);
    expect(note).toContain("done: note me");
    expect(note).toContain(`call task_status result ${id}`); // the read tool, not the spawn tool (MED-2 split)
    // nested-style override: the note goes to the given queue, not the attached sink
    const own = new SteeringQueue();
    const nested = startOk(tasks, "nested", { notify: own, parentDepth: 1 });
    await deadline(tasks.result(nested, { timeoutMs: 5_000 }), 6_000, "nested child");
    expect(own.size).toBe(1);
    expect(own.drainAll()[0]).toContain(`task ${nested} (nested) finished`);
    expect(parent.size).toBe(0);
    // cancelled tasks are announced too
    const held = startOk(tasks, "HOLD later", { label: "held" });
    tasks.cancel(held);
    await deadline(tasks.result(held, { timeoutMs: 5_000 }), 6_000, "cancelled child");
    expect(parent.drainAll()).toEqual([`task ${held} (held) cancelled`]);

    const m2 = makeManager(failing);
    const q2 = new SteeringQueue();
    m2.tasks.attach(q2);
    const f = startOk(m2.tasks, "explode", { label: "boom job" });
    await deadline(m2.tasks.result(f, { timeoutMs: 5_000 }), 6_000, "failing child");
    const fnote = q2.drainAll()[0]!;
    expect(fnote).toContain(`task ${f} (boom job) failed`);
    expect(fnote).toContain("provider boom");
    await m2.cleanup();
  } finally {
    kids.releaseAll();
    await cleanup();
  }
}, 20_000);

// ---------- failed children ----------

test("a failed child → status failed + error in result; a throwing runner → failed; never throws", async () => {
  const failing: StreamFn = async function* () {
    yield { type: "turn", turn: { parts: [], stopReason: "error", usage: { input: 0, output: 0 }, error: "provider boom" } };
  };
  const { tasks, cleanup } = makeManager(failing);
  try {
    const id = startOk(tasks, "explode");
    const r = await deadline(tasks.result(id, { timeoutMs: 5_000 }), 6_000, "failing child");
    expect(r?.status).toBe("failed");
    expect(r?.error).toContain("provider boom"); // runChild reports the run_end error (mutation: ok:true always → "done")
    expect(r?.summary).toBeUndefined();
    // a runner that THROWS (host failure) is a failed task, not an unhandled rejection
    const thrower = makeManager(failing, {}, { run: async () => { throw new Error("kaboom"); } });
    const t = startOk(thrower.tasks, "host failure");
    const tr = await deadline(thrower.tasks.result(t, { timeoutMs: 5_000 }), 6_000, "throwing runner");
    expect(tr?.status).toBe("failed");
    expect(tr?.error).toContain("kaboom");
    expect(thrower.tasks.counts().running).toBe(0); // the slot was released
    await thrower.cleanup();
  } finally {
    await cleanup();
  }
}, 15_000);

// ---------- slot lending (nested pools never deadlock) ----------

test("slot lending: a running task waiting on its queued child promotes it; a non-task waiter does not", async () => {
  const kids = gatedChildren();
  const { tasks, cleanup } = makeManager(kids.stream, {}, { max: 1 });
  try {
    const parent = startOk(tasks, "HOLD parent");
    const child = startOk(tasks, "child work");
    await deadline(kids.untilStarted("HOLD parent"), 5_000, "parent runs");
    expect(tasks.status(child)?.status).toBe("queued");
    // mutation target: drop the lending branch in result() → the child stays queued → "queued"
    const r = await deadline(tasks.result(child, { timeoutMs: 3_000, caller: parent }), 4_000, "lent child");
    expect(r?.status).toBe("done");
    expect(tasks.status(parent)?.status).toBe("running"); // the parent kept its slot
    // without a running caller the bound holds: the waiter times out, the task stays queued
    const other = startOk(tasks, "other work");
    const still = await deadline(tasks.result(other, { timeoutMs: 200 }), 2_000, "bounded wait");
    expect(still?.status).toBe("queued");
    kids.release("HOLD parent");
    expect(await tasks.drain(5_000)).toBe(true);
    expect(tasks.status(other)?.status).toBe("done");
  } finally {
    kids.releaseAll();
    await cleanup();
  }
}, 15_000);

// ---------- isolation: relative writes land in the copy, merge back only on success ----------

/** Two-turn child script: a relative `write` of a goal-specific file, then either a
 *  final text or a HOLD park (until the run's signal aborts). */
function isoChildren() {
  const stamp = randomUUID().slice(0, 8);
  const fileFor = (goal: string) => `iso-${goal.replace(/\W+/g, "-").toLowerCase()}-${stamp}.txt`;
  const stream: StreamFn = async function* (_m: ModelRef, messages: Message[], opts?: StreamOptions): AsyncGenerator<StreamEvent> {
    const goal = goalOf(messages);
    if (!messages.some((m) => m.role === "tool")) {
      yield { type: "turn", turn: toolTurn([{ id: "w1", tool: "write", args: { path: fileFor(goal), content: `from ${goal}\n` } }]) };
      return;
    }
    if (goal.startsWith("HOLD")) {
      const sig = opts?.signal;
      if (!sig?.aborted) await new Promise<void>((r) => sig?.addEventListener("abort", () => r(), { once: true }));
      yield { type: "turn", turn: { parts: [], stopReason: "aborted", usage: { input: 0, output: 0 } } };
      return;
    }
    yield { type: "turn", turn: textTurn("wrote it") };
  };
  return { stream, fileFor };
}

test("isolated task: the child's relative write lands in the isolation copy and merges back as a patch on success", async () => {
  const { stream, fileFor } = isoChildren();
  const file = fileFor("ISO write");
  const { tasks, root, cleanup } = makeManager(stream, { registryFactory: () => { const r = new ToolRegistry(); r.register(writeTool); return r; } });
  writeFileSync(join(root, "base.txt"), "base\n");
  try {
    const r = tasks.start({ agent: "worker", goal: "ISO write", isolated: true });
    expect(r.ok).toBe(true);
    const info = await deadline(tasks.result((r as { id: string }).id, { timeoutMs: 15_000 }), 16_000, "isolated child");
    expect(info?.status).toBe("done");
    expect(info?.summary).toBe("wrote it"); // no "patch-apply-failed" tail
    expect(info?.isolated).toBe(true);
    expect(info?.patchLines ?? 0).toBeGreaterThan(0); // mutation: drop `cwd: iso.dir` in runChild → the write misses the copy, empty patch
    expect(existsSync(join(root, file))).toBe(true);   // merged back into the parent tree
    expect(existsSync(join(process.cwd(), file))).toBe(false); // …and NOT into the process cwd
  } finally {
    rmSync(join(process.cwd(), file), { force: true });
    await cleanup();
  }
}, 30_000);

test("isolated task cancelled mid-run: its half-done patch is NOT merged back (a sibling's success still is)", async () => {
  const { stream, fileFor } = isoChildren();
  const held = fileFor("HOLD iso");
  const sibling = fileFor("ISO write");
  const { tasks, root, cleanup } = makeManager(stream, { registryFactory: () => { const r = new ToolRegistry(); r.register(writeTool); return r; } });
  writeFileSync(join(root, "base.txt"), "base\n");
  try {
    const id = tasks.start({ agent: "worker", goal: "HOLD iso", isolated: true });
    expect(id.ok).toBe(true);
    const heldId = (id as { id: string }).id;
    // the write has happened once the child is parked in its second provider turn
    await deadline(waitUntil(() => tasks.status(heldId)?.status === "running"), 5_000, "child running");
    await sleep(400); // let the first turn (the write) complete inside the copy
    const sib = tasks.start({ agent: "worker", goal: "ISO write", isolated: true });
    expect(sib.ok).toBe(true);
    expect(tasks.cancel(heldId)?.status).toBe("cancelled");
    const info = await deadline(tasks.result(heldId, { timeoutMs: 15_000 }), 16_000, "cancelled isolated child");
    expect(info?.status).toBe("cancelled");
    expect(info?.finishedAt).toBeDefined();
    expect(existsSync(join(root, held))).toBe(false); // mutation: apply the patch regardless of ok → file appears
    const sibInfo = await deadline(tasks.result((sib as { id: string }).id, { timeoutMs: 15_000 }), 16_000, "sibling");
    expect(sibInfo?.status).toBe("done");
    expect(existsSync(join(root, sibling))).toBe(true);
  } finally {
    rmSync(join(process.cwd(), held), { force: true });
    rmSync(join(process.cwd(), sibling), { force: true });
    await cleanup();
  }
}, 30_000);

async function waitUntil(pred: () => boolean): Promise<boolean> {
  while (!pred()) await sleep(10);
  return true;
}

function tempGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-tasks-git-"));
  writeFileSync(join(dir, "tracked.txt"), "tracked\n");
  Bun.spawnSync(["git", "init", "-q"], { cwd: dir });
  Bun.spawnSync(["git", "add", "."], { cwd: dir });
  Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: dir });
  return dir;
}
const gitOut = (args: string[], cwd: string): string => Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" }).stdout.toString().trim();

test("isolated task in a git repo (worktree isolation): a NEW file the child creates reaches the merged-back patch", async () => {
  const { stream, fileFor } = isoChildren();
  const file = fileFor("ISO write");
  const root = tempGitRepo();
  const { tasks, cleanup } = makeManager(stream, { rootDir: root, registryFactory: () => { const r = new ToolRegistry(); r.register(writeTool); return r; } });
  try {
    const r = tasks.start({ agent: "worker", goal: "ISO write", isolated: true });
    expect(r.ok).toBe(true);
    const info = await deadline(tasks.result((r as { id: string }).id, { timeoutMs: 20_000 }), 21_000, "worktree child");
    expect(info?.status).toBe("done");
    expect(info?.summary).toBe("wrote it");
    // mutation target: drop the intent-to-add before `git diff HEAD` → untracked new file, empty patch
    expect(info?.patchLines ?? 0).toBeGreaterThan(0);
    expect(existsSync(join(root, file))).toBe(true);
    expect(existsSync(join(process.cwd(), file))).toBe(false);
    expect(existsSync(join(root, ".rovecode", "worktrees"))).toBe(true); // it WAS the worktree path
    // fix-wave L3: the isolation worktree is a DETACHED checkout — `worktree remove` leaves no
    // `rovecode/task/<id>` branch behind in the root repo (mutation: `-b rovecode/task/${id}` → one stray
    // branch per isolated task), and the root is the only worktree left
    expect(gitOut(["branch", "--list", "rovecode/task/*"], root)).toBe("");
    expect(gitOut(["worktree", "list", "--porcelain"], root).split("\n").filter((l) => l.startsWith("worktree ")).length).toBe(1);
  } finally {
    rmSync(join(process.cwd(), file), { force: true });
    await cleanup();
    rmSync(root, { recursive: true, force: true });
  }
}, 40_000);

// ---------- parent-run ownership: abort propagates downward, normal end does not ----------

test("bindRun: aborting the bound parent run cancels the tasks it started; other runs' tasks are untouched; an explicit owner cascades", async () => {
  const kids = gatedChildren();
  const { tasks, cleanup } = makeManager(kids.stream);
  try {
    const run1 = new AbortController();
    tasks.bindRun(run1.signal);
    const a = startOk(tasks, "HOLD run1-a");
    const run2 = new AbortController();
    tasks.bindRun(run2.signal);
    const b = startOk(tasks, "HOLD run2-b");
    await deadline(Promise.all([kids.untilStarted("HOLD run1-a"), kids.untilStarted("HOLD run2-b")]), 5_000, "children start");
    // mutation target: drop the owner abort listener in start() → b keeps running, result() times out
    run2.abort();
    const bInfo = await deadline(tasks.result(b, { timeoutMs: 3_000 }), 4_000, "run2's task settles");
    expect(bInfo?.status).toBe("cancelled");
    expect(bInfo?.finishedAt).toBeDefined();
    expect(kids.signalOf("HOLD run2-b")?.aborted).toBe(true);
    expect(tasks.status(a)?.status).toBe("running"); // run1's task is not run2's
    // a start under an already-aborted owner is refused as data
    const late = tasks.start({ agent: "worker", goal: "late" });
    expect(late.ok).toBe(false);
    if (!late.ok) expect(late.reason).toBe("parent run aborted");
    // explicit owner (the nested case: a task's own signal owns its children) cascades
    const parentTask = new AbortController();
    const c = startOk(tasks, "HOLD cascade", { owner: parentTask.signal });
    await deadline(kids.untilStarted("HOLD cascade"), 5_000, "cascade child starts");
    parentTask.abort();
    expect((await deadline(tasks.result(c, { timeoutMs: 3_000 }), 4_000, "cascade settles"))?.status).toBe("cancelled");
    // settled tasks have detached from their owner: a late abort is a no-op
    kids.release("HOLD run1-a");
    expect((await deadline(tasks.result(a, { timeoutMs: 3_000 }), 4_000, "run1 task"))?.status).toBe("done");
    run1.abort();
    expect(tasks.status(a)?.status).toBe("done");
  } finally {
    kids.releaseAll();
    await cleanup();
  }
}, 20_000);

// ---------- waits: bounded, abortable, snapshot on timeout ----------

test("result(): timeout 0 snapshots at once, an aborted signal returns promptly, both report the live status", async () => {
  const kids = gatedChildren();
  const { tasks, cleanup } = makeManager(kids.stream);
  try {
    const id = startOk(tasks, "HOLD wait");
    const t0 = Date.now();
    expect((await tasks.result(id, { timeoutMs: 0 }))?.status).toBe("running");
    expect(Date.now() - t0).toBeLessThan(500);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 30);
    const r = await deadline(tasks.result(id, { signal: ac.signal }), 2_000, "abortable wait");
    expect(r?.status).toBe("running");
    const pre = new AbortController(); pre.abort();
    expect((await deadline(tasks.result(id, { signal: pre.signal }), 2_000, "pre-aborted wait"))?.status).toBe("running");
  } finally {
    kids.releaseAll();
    await cleanup();
  }
}, 15_000);

// ---------- tool surface (src/tools/task.ts): task_status result waits ----------

const toolCtx = (): ToolContext => ({ sessionId: "s", cwd: process.cwd(), signal: new AbortController().signal, permissions: { effect: "allow" } });

test("task_status result: a numeric-string timeout_ms is honored; garbage is a clear error, never the 60s default (fix-wave L6)", async () => {
  const kids = gatedChildren();
  const { tasks, cleanup } = makeManager(kids.stream);
  const status = createTaskStatusTool(tasks);
  try {
    const id = startOk(tasks, "HOLD wait-str");
    await deadline(kids.untilStarted("HOLD wait-str"), 5_000, "child starts");
    const t0 = Date.now();
    // mutation target: parseTimeout treating strings as absent → the 60_000 default → the 3s deadline trips
    const r = await deadline(status.execute({ action: "result", id, timeout_ms: "300" }, toolCtx()), 3_000, "string timeout_ms wait");
    expect(r.ok).toBe(true);
    expect(r.output).toContain("still running after 0s");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
    for (const bad of ["soon", "", true, {}]) {
      const e = await status.execute({ action: "result", id, timeout_ms: bad }, toolCtx());
      expect(e.ok).toBe(false);
      expect(e.output).toContain("timeout_ms");
      expect(e.output).toContain("milliseconds");
    }
    // absent → the (pinned) default; 0 → snapshot at once; negative → clamped to 0
    expect(DEFAULT_WAIT_MS).toBe(60_000);
    expect((await status.execute({ action: "result", id, timeout_ms: 0 }, toolCtx())).output).toContain("still running after 0s");
    expect((await deadline(status.execute({ action: "result", id, timeout_ms: -5 }, toolCtx()), 2_000, "negative timeout")).output).toContain("still running after 0s");
    // status/list are plain reads; an unknown id is data
    expect((await status.execute({ action: "status", id }, toolCtx())).output).toMatch(/^task t1 \(HOLD wait-str\) running/);
    expect((await status.execute({ action: "list" }, toolCtx())).output).toContain("t1   running");
    expect((await status.execute({ action: "result", id: "nope" }, toolCtx())).output).toBe("Error: unknown task 'nope'");
    expect((await status.execute({ action: "start", goal: "x" }, toolCtx())).output).toContain("start|cancel live on task");
  } finally {
    kids.releaseAll();
    await cleanup();
  }
}, 15_000);

// ---------- env + formatting ----------

test("ROVECODE_TASKS_MAX: positive integers win, anything else falls back to the default", () => {
  expect(DEFAULT_TASKS_MAX).toBe(3);
  expect(tasksMaxFromEnv({ ROVECODE_TASKS_MAX: "5" })).toBe(5);
  expect(tasksMaxFromEnv({ ROVECODE_TASKS_MAX: "0" })).toBe(3);
  expect(tasksMaxFromEnv({ ROVECODE_TASKS_MAX: "-2" })).toBe(3);
  expect(tasksMaxFromEnv({ ROVECODE_TASKS_MAX: "abc" })).toBe(3);
  expect(tasksMaxFromEnv({ ROVECODE_TASKS_MAX: "2.5" })).toBe(3);
  expect(tasksMaxFromEnv({})).toBe(3);
  expect(new TaskManager({ deps: () => null, maxConcurrent: 0 }).maxConcurrent).toBe(1);
});

test("formatTaskList / taskNote: one bounded row per task, ids + status + label visible", () => {
  const base = { agent: "main", goal: "g", isolated: false, depth: 1, createdAt: 0 };
  expect(formatTaskList([])).toBe("(no background tasks)");
  const rows = formatTaskList([
    { ...base, id: "t1", label: "first job", status: "running", startedAt: 1_000 },
    { ...base, id: "t2", label: "second job", status: "queued" },
    { ...base, id: "t3", label: "third job", status: "failed", startedAt: 0, finishedAt: 2_000, error: "boom\nmore" },
  ], 6_000).split("\n");
  expect(rows).toHaveLength(3);
  expect(rows[0]).toMatch(/^t1 {3}running {3}5s {4}first job$/);
  expect(rows[1]).toContain("t2   queued");
  expect(rows[1]).toContain("second job");
  expect(rows[2]).toContain("failed");
  expect(rows[2]).toContain("— boom");
  expect(rows[2]).not.toContain("more");
  expect(taskNote({ ...base, id: "t9", label: "l", status: "cancelled" })).toBe("task t9 (l) cancelled");
  const long = formatTaskList(Array.from({ length: 60 }, (_, i) => ({ ...base, id: `t${i}`, label: "x", status: "done" as const })));
  expect(long.startsWith("(showing 50 of 60)")).toBe(true);
  expect(long.split("\n")).toHaveLength(51);
});
