/** PORT #26 wiring: the `task` tool inside a REAL parent loop built by createRuntime;
 *  children run through orchestrator runChild (the one agentLoop); the completion steer
 *  reaches the parent's NEXT model turn through rt.steering. One scripted provider serves
 *  parent and children alike — a run's identity is its goal (its first user message) — and
 *  records every request so tests assert what the model actually SAW. */

import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createRuntime } from "../../src/cli/runtime.ts";
import { agentLoop } from "../../src/core/loop.ts";
import { SessionStore } from "../../src/core/session.ts";
import { textTurn, toolTurn } from "../../src/providers/stream.ts";
import type { ApprovalFn, AssistantTurn, Message, ModelRef, PermissionRule, RunEvent, StreamEvent, StreamFn, StreamOptions, ToolContext } from "../../src/core/types.ts";

const text = (m: Message): string => m.parts.filter((p) => p.kind === "text").map((p) => (p as { text: string }).text).join("");
const goalOf = (messages: Message[]): string => { const u = messages.find((m) => m.role === "user"); return u ? text(u) : ""; };
const lastToolOutput = (messages: Message[]): string => {
  const m = [...messages].reverse().find((x) => x.role === "tool");
  const p = m?.parts.find((x) => x.kind === "tool_result");
  return p && p.kind === "tool_result" ? p.output : "";
};
const turn = (t: AssistantTurn): StreamEvent => ({ type: "turn", turn: t });
const toolCall = (id: string, args: unknown) => toolTurn([{ id, tool: "task", args }]);
/** reads (status/result/list) live on the kind-read `task_status` tool (MED-2 split) */
const statusCall = (id: string, args: unknown) => toolTurn([{ id, tool: "task_status", args }]);

interface Recorded { goal: string; messages: Message[] }

/** Level scripts keyed by goal prefix. Each level: T1 `task start` the next level, T2
 *  `task result` on the id its start returned (parsed from the tool output), T3 a final
 *  text carrying the result output. The deepest level's start is refused, so it ends at T2. */
function chainStream(recorded: Recorded[]): StreamFn {
  const next: Record<string, { goal: string; label: string } | undefined> = {
    PARENT: { goal: "CHILD nest", label: "child" },
    CHILD: { goal: "GRANDCHILD nest", label: "grandchild" },
    GRANDCHILD: { goal: "GREAT deep", label: "great" },
  };
  return async function* (_m: ModelRef, messages: Message[]): AsyncGenerator<StreamEvent> {
    const goal = goalOf(messages);
    recorded.push({ goal, messages: messages.map((m) => ({ ...m, parts: [...m.parts] })) });
    const level = goal.split(" ")[0]!;
    const tools = messages.filter((m) => m.role === "tool").length;
    const spawn = next[level];
    if (spawn && tools === 0) { yield turn(toolCall(`${level}-start`, { action: "start", goal: spawn.goal, label: spawn.label })); return; }
    if (spawn && tools === 1) {
      const started = /task (t\d+) \(/.exec(lastToolOutput(messages));
      if (started) { yield turn(statusCall(`${level}-result`, { action: "result", id: started[1], timeout_ms: 20_000 })); return; }
      yield turn(textTurn(`${level}-DONE: ${lastToolOutput(messages)}`)); return; // refused start → finish
    }
    yield turn(textTurn(`${level}-DONE: ${lastToolOutput(messages)}`));
  };
}

async function runParent(cwd: string, stream: StreamFn, yolo: boolean, goal: string) {
  const rt = createRuntime({ cwd, stream });
  const events: RunEvent[] = [];
  const def = rt.buildDef({ provider: "mock", model: "default" });
  const cfg = rt.buildCfg(yolo);
  for await (const ev of agentLoop(def, goal, {}, cfg, {
    stream, registry: rt.registry, store: rt.store, tools: rt.registry.list().map((t) => t.schema),
    guard: rt.guard, cwd: rt.cwd,
  }, rt.steering)) events.push(ev);
  return { rt, events };
}

const toolEnd = (events: RunEvent[], callId: string) => {
  const e = events.find((ev) => ev.type === "tool_execution_end" && ev.callId === callId);
  return e && e.type === "tool_execution_end" ? e : undefined;
};

test("parent loop: `task start` returns at once, `task result` collects the child's text, and the completion steer reaches the parent's NEXT model turn", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-tasks-wire-"));
  const recorded: Recorded[] = [];
  const stream: StreamFn = async function* (_m: ModelRef, messages: Message[]): AsyncGenerator<StreamEvent> {
    const goal = goalOf(messages);
    recorded.push({ goal, messages: messages.map((m) => ({ ...m, parts: [...m.parts] })) });
    const tools = messages.filter((m) => m.role === "tool").length;
    if (goal.startsWith("PARENT")) {
      if (tools === 0) { yield turn(toolCall("p1", { action: "start", goal: "CHILD compute the answer", label: "compute" })); return; }
      if (tools === 1) { yield turn(statusCall("p2", { action: "result", id: "t1", timeout_ms: 20_000 })); return; }
      yield turn(textTurn("PARENT-DONE")); return;
    }
    yield turn(textTurn("CHILD-RESULT-42"));
  };
  try {
    const { rt, events } = await runParent(cwd, stream, true, "PARENT delegate");
    const end = events.at(-1);
    expect(end?.type === "run_end" && end.status === "done" && end.summary === "PARENT-DONE").toBe(true);
    // start returned immediately with the id + no-polling guidance
    const started = toolEnd(events, "p1");
    expect(started?.ok).toBe(true);
    expect(started?.output).toContain("task t1 (compute) started");
    expect(started?.output).toContain("do NOT poll");
    // result collected the child's final text through runChild (the one loop)
    const result = toolEnd(events, "p2");
    expect(result?.ok).toBe(true);
    expect(result?.output).toContain("task t1 (compute) done");
    expect(result?.output).toContain("CHILD-RESULT-42");
    expect(rt.tasks.status("t1")).toMatchObject({ status: "done", depth: 1, agent: "main", summary: "CHILD-RESULT-42" });
    // the steer landed in THIS run (mutation target: drop the push in TaskManager.settle,
    // or hand the loop a fresh SteeringQueue instead of rt.steering → no steer event)
    const steer = events.find((e) => e.type === "steer");
    expect(steer?.type === "steer" && steer.text).toContain("task t1 (compute) finished: CHILD-RESULT-42");
    // …and the model SAW it: the parent's third request carries it as a user message
    const parentReqs = recorded.filter((r) => r.goal === "PARENT delegate");
    expect(parentReqs).toHaveLength(3);
    const seen = parentReqs[2]!.messages.filter((m) => m.role === "user").map(text);
    expect(seen.some((t) => t.includes("task t1 (compute) finished"))).toBe(true);
    expect(parentReqs[1]!.messages.filter((m) => m.role === "user").map(text).some((t) => t.includes("finished"))).toBe(false);
    // the child ran in its OWN session: it saw only its goal, none of the parent's history
    const childReq = recorded.find((r) => r.goal === "CHILD compute the answer");
    expect(childReq).toBeDefined();
    expect(childReq!.messages.filter((m) => m.role === "user")).toHaveLength(1);
    expect(childReq!.messages.some((m) => text(m).includes("PARENT delegate"))).toBe(false);
    expect(rt.steering.size).toBe(0); // drained by the parent's turn, nothing left over
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}, 30_000);

test("nested chain: child → grandchild runs (depth 2), the grandchild's own start is refused at the depth cap, and each note lands in ITS parent's queue", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-tasks-nest-"));
  const recorded: Recorded[] = [];
  try {
    const { rt, events } = await runParent(cwd, chainStream(recorded), true, "PARENT nest");
    const end = events.at(-1);
    expect(end?.type).toBe("run_end");
    const list = rt.tasks.list();
    expect(list.map((t) => [t.id, t.depth, t.status])).toEqual([["t1", 1, "done"], ["t2", 2, "done"]]);
    // the grandchild tried to go one level deeper and the ORCHESTRATOR's preflight refused
    // (mutation target: a task tool bound to parentDepth 0 for every level → t3 exists)
    expect(list[1]!.summary).toContain("task refused: depth cap 3 reached (current 3)");
    expect(list[0]!.summary).toContain("GRANDCHILD-DONE");
    // the grandchild's note went to the CHILD's steering queue, not the root's
    // (mutation target: registryFactory ignoring child.steering → root sees "task t2")
    const childReqs = recorded.filter((r) => r.goal === "CHILD nest");
    expect(childReqs).toHaveLength(3);
    expect(childReqs[2]!.messages.filter((m) => m.role === "user").map(text).some((t) => t.includes("task t2 (grandchild) finished"))).toBe(true);
    const parentReqs = recorded.filter((r) => r.goal === "PARENT nest");
    expect(parentReqs).toHaveLength(3);
    const rootSaw = parentReqs[2]!.messages.filter((m) => m.role === "user").map(text);
    expect(rootSaw.some((t) => t.includes("task t1 (child) finished"))).toBe(true);
    // t1's summary legitimately QUOTES the grandchild's result text; what must not appear at
    // the root is the grandchild's own completion NOTE
    expect(rootSaw.some((t) => t.includes("task t2 (grandchild) finished"))).toBe(false);
    expect(events.filter((e) => e.type === "steer")).toHaveLength(1);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}, 40_000);

/** Parks until the run's OWN signal aborts, then yields an aborted turn (a killed fetch). */
async function parkUntilAbort(opts: StreamOptions | undefined): Promise<StreamEvent> {
  const sig = opts?.signal;
  if (!sig?.aborted) await new Promise<void>((r) => sig?.addEventListener("abort", () => r(), { once: true }));
  return turn({ parts: [], stopReason: "aborted", usage: { input: 0, output: 0 } });
}

const deadline = <T,>(p: Promise<T>, ms: number, what: string): Promise<T> => {
  let t: ReturnType<typeof setTimeout> | undefined;
  const bomb = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error(`${what}: not settled within ${ms}ms`)), ms); });
  return Promise.race([p, bomb]).finally(() => clearTimeout(t));
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(pred: () => boolean, ms: number, what: string): Promise<void> {
  const t0 = Date.now();
  while (!pred()) { if (Date.now() - t0 > ms) throw new Error(`${what}: not true within ${ms}ms`); await sleep(15); }
}

test("parent-run ownership: a NORMAL run end leaves its background task running; a parent ABORT (the surface's controller) cancels the tasks that run started", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-tasks-own-"));
  const parked: string[] = [];
  const stream: StreamFn = async function* (_m: ModelRef, messages: Message[], opts?: StreamOptions): AsyncGenerator<StreamEvent> {
    const goal = goalOf(messages);
    const tools = messages.filter((m) => m.role === "tool").length;
    if (goal.startsWith("PARENT")) {
      if (tools === 0) { yield turn(toolCall("s1", { action: "start", goal: `CHILD HOLD for ${goal}`, label: goal.includes("normal") ? "survivor" : "doomed" })); return; }
      if (goal.includes("normal")) { yield turn(textTurn("PARENT-DONE")); return; }
      parked.push(goal);
      yield await parkUntilAbort(opts); return; // the aborted-run parent parks in its second turn
    }
    parked.push(goal);
    yield await parkUntilAbort(opts); // every child parks until ITS run is aborted
  };
  const rt = createRuntime({ cwd, stream });
  const def = rt.buildDef({ provider: "mock", model: "default" });
  const cfg = rt.buildCfg(true);
  // one fresh session store per run: the script keys on a run's FIRST user message (its goal)
  const deps = (signal: AbortSignal) => ({
    stream, registry: rt.registry, store: new SessionStore(join(cwd, ".rovecode", "sessions"), randomUUID()),
    tools: rt.registry.list().map((t) => t.schema), guard: rt.guard, cwd: rt.cwd, signal,
  });
  try {
    // run A ends normally: its task must SURVIVE the run's end (mutation target: owning
    // tasks by ToolContext.signal — the loop aborts that on every settle, loop.ts:91)
    const acA = new AbortController();
    rt.tasks.bindRun(acA.signal);
    const evsA: RunEvent[] = [];
    for await (const ev of agentLoop(def, "PARENT normal", {}, cfg, deps(acA.signal), rt.steering)) evsA.push(ev);
    expect(evsA.at(-1)).toMatchObject({ type: "run_end", status: "done" });
    await until(() => parked.includes("CHILD HOLD for PARENT normal"), 5_000, "survivor child reaches its provider turn");
    await sleep(100);
    expect(rt.tasks.status("t1")).toMatchObject({ label: "survivor", status: "running" });

    // run B is aborted by the surface's controller while its task runs: task cancelled,
    // run A's task untouched (mutation target: drop bindRun / the owner listener)
    const acB = new AbortController();
    rt.tasks.bindRun(acB.signal);
    const evsB: RunEvent[] = [];
    const doneB = (async () => { for await (const ev of agentLoop(def, "PARENT abort", {}, cfg, deps(acB.signal), rt.steering)) evsB.push(ev); })();
    await until(() => parked.includes("PARENT abort") && parked.includes("CHILD HOLD for PARENT abort"), 5_000, "parent parked, doomed child running");
    expect(rt.tasks.status("t2")).toMatchObject({ label: "doomed", status: "running" });
    acB.abort();
    await deadline(doneB, 4_000, "aborted parent settles");
    expect(evsB.at(-1)).toMatchObject({ type: "run_end", status: "stopped" });
    const t2 = await deadline(rt.tasks.result("t2", { timeoutMs: 3_000 }), 4_000, "doomed child settles");
    expect(t2).toMatchObject({ status: "cancelled" });
    expect(t2?.finishedAt).toBeDefined();
    expect(rt.tasks.status("t1")?.status).toBe("running");
    // and the cancellation was announced on the session queue for the next turn
    expect(rt.steering.drainAll().some((s) => s.includes("task t2 (doomed) cancelled"))).toBe(true);
  } finally {
    rt.tasks.cancelAll();
    await rt.tasks.drain(4_000);
    rmSync(cwd, { recursive: true, force: true });
  }
}, 30_000);

test("cascade through the runtime's child registry: cancelling a task cancels the grandchild it started", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-tasks-cascade-"));
  const parked: string[] = [];
  const stream: StreamFn = async function* (_m: ModelRef, messages: Message[], opts?: StreamOptions): AsyncGenerator<StreamEvent> {
    const goal = goalOf(messages);
    const tools = messages.filter((m) => m.role === "tool").length;
    if (goal === "CHILD cascade" && tools === 0) { yield turn(toolCall("c1", { action: "start", goal: "GRANDCHILD hold", label: "grandchild" })); return; }
    parked.push(goal);
    yield await parkUntilAbort(opts);
  };
  const rt = createRuntime({ cwd, stream });
  rt.buildDef({ provider: "mock", model: "default" });
  rt.buildCfg(true); // children derive allow-all → the nested spawn is allowed
  try {
    const r = rt.tasks.start({ agent: "main", goal: "CHILD cascade" }, { label: "child" });
    expect(r.ok).toBe(true);
    await until(() => parked.includes("GRANDCHILD hold") && parked.includes("CHILD cascade"), 8_000, "child + grandchild both parked");
    expect(rt.tasks.list().map((t) => [t.id, t.depth, t.status])).toEqual([["t1", 1, "running"], ["t2", 2, "running"]]);
    // mutation target: childRegistry not passing owner: child.signal → t2 keeps running
    rt.tasks.cancel("t1");
    const t2 = await deadline(rt.tasks.result("t2", { timeoutMs: 4_000 }), 5_000, "grandchild settles");
    expect(t2?.status).toBe("cancelled");
    expect(t2?.finishedAt).toBeDefined();
    expect((await deadline(rt.tasks.result("t1", { timeoutMs: 4_000 }), 5_000, "child settles"))?.status).toBe("cancelled");
  } finally {
    rt.tasks.cancelAll();
    await rt.tasks.drain(4_000);
    rmSync(cwd, { recursive: true, force: true });
  }
}, 30_000);

test("MED-2 split: under gated rules `task start` prompts exactly ONCE while task_status status/result/list run with ZERO prompts; approver-less (headless) the reads still run; the start output tells the approver the child is read-only", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-tasks-split-"));
  const stream: StreamFn = async function* (_m: ModelRef, messages: Message[]): AsyncGenerator<StreamEvent> {
    const goal = goalOf(messages);
    const tools = messages.filter((m) => m.role === "tool").length;
    if (goal.startsWith("CHILD")) { yield turn(textTurn("CHILD-42")); return; }
    if (goal.startsWith("PARENT gated")) {
      if (tools === 0) { yield turn(toolCall("s1", { action: "start", goal: "CHILD quick", label: "quick" })); return; }
      if (tools === 1) { yield turn(statusCall("s2", { action: "status", id: "t1" })); return; }
      if (tools === 2) { yield turn(statusCall("s3", { action: "result", id: "t1", timeout_ms: 20_000 })); return; }
      if (tools === 3) { yield turn(statusCall("s4", { action: "list" })); return; }
      yield turn(textTurn("PARENT-DONE")); return;
    }
    // "PARENT headless": reads only, on a run with NO approver connected
    if (tools === 0) { yield turn(statusCall("h1", { action: "status", id: "t1" })); return; }
    if (tools === 1) { yield turn(statusCall("h2", { action: "list" })); return; }
    yield turn(textTurn("HEADLESS-DONE"));
  };
  try {
    const rt = createRuntime({ cwd, stream });
    const prompts: string[] = [];
    const approval: ApprovalFn = async (req) => { prompts.push(req.tool); return "once"; };
    const def = rt.buildDef({ provider: "mock", model: "default" });
    const deps = { stream, registry: rt.registry, store: rt.store, tools: rt.registry.list().map((t) => t.schema), guard: rt.guard, cwd: rt.cwd };
    const events: RunEvent[] = [];
    for await (const ev of agentLoop(def, "PARENT gated split", {}, rt.buildCfg(false, approval), deps, rt.steering)) events.push(ev);
    expect(events.at(-1)).toMatchObject({ type: "run_end", status: "done", summary: "PARENT-DONE" });
    // exactly ONE prompt, for the spawn ("once" is never cached, so the pre-split action-agnostic tool
    // prompted 4× here — mutation target: task_status kind "read" → "spawn")
    expect(prompts).toEqual(["task"]);
    expect(events.filter((e) => e.type === "tool_call_failed")).toEqual([]);
    expect(toolEnd(events, "s1")?.output).toContain("read-only"); // gated: the approver/model learn what the child can do
    expect(toolEnd(events, "s1")?.output).toContain("task_status result");
    expect(toolEnd(events, "s2")?.output).toMatch(/^task t1 \(quick\) (running|done)/);
    expect(toolEnd(events, "s3")?.output).toContain("CHILD-42");
    expect(toolEnd(events, "s4")?.output).toContain("t1   done");
    // headless: no approver at all — the reads still run (a start would fail closed, pinned below)
    const evs2: RunEvent[] = [];
    const store2 = new SessionStore(join(cwd, ".rovecode", "sessions"), randomUUID()); // fresh store: the script keys on the run's first user message
    for await (const ev of agentLoop(def, "PARENT headless", {}, rt.buildCfg(false), { ...deps, store: store2 }, rt.steering)) evs2.push(ev);
    expect(evs2.at(-1)).toMatchObject({ type: "run_end", status: "done", summary: "HEADLESS-DONE" });
    expect(evs2.filter((e) => e.type === "tool_call_failed")).toEqual([]);
    expect(toolEnd(evs2, "h1")?.ok).toBe(true);
    expect(toolEnd(evs2, "h2")?.output).toContain("t1   done");
    // yolo: the start output says the child inherits the allow rules instead
    const rt2 = createRuntime({ cwd, stream });
    const evs3: RunEvent[] = [];
    for await (const ev of agentLoop(rt2.buildDef({ provider: "mock", model: "default" }), "PARENT gated split", {}, rt2.buildCfg(true), { ...deps, registry: rt2.registry, store: rt2.store, guard: rt2.guard }, rt2.steering)) evs3.push(ev);
    expect(toolEnd(evs3, "s1")?.output).toContain("inherits your allow rules");
    expect(toolEnd(evs3, "s1")?.output).not.toContain("read-only");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}, 40_000);

test("task_status is a READ at the registry seam: gated rules run it approver-less, and a smuggled `path` cannot re-aim a deny targeted at the tool (its schema declares no path)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-tasks-read-"));
  try {
    const rt = createRuntime({ cwd, stream: null });
    const gated = rt.buildCfg(false).permissionRules;
    const ctx: ToolContext = { sessionId: rt.sessionId, cwd, signal: new AbortController().signal, permissions: { effect: "allow" } };
    const dispatch = async (args: unknown, rules: PermissionRule[]) => {
      const events: RunEvent[] = [];
      const out = await rt.registry.dispatch({ kind: "tool_call", id: "c", tool: "task_status", args }, ctx, undefined, rules, undefined, (e) => events.push(e));
      return { out, failed: events.find((e) => e.type === "tool_call_failed") };
    };
    // no approver, gated rules: a read runs (mutation: kind "read" → "spawn" → permission_denied, no approver)
    const ok = await dispatch({ action: "list" }, gated);
    expect(ok.failed).toBeUndefined();
    expect(ok.out).toMatchObject({ ok: true, output: "(no background tasks)" });
    // a deny aimed at the tool NAME holds against a smuggled path (mutation: declare `path` in the
    // task_status schema → describeResource resolves the path → the deny no longer matches → ok:true)
    const denyTool: PermissionRule[] = [...gated, { action: "file.read", resource: "task_status", effect: "deny" }];
    const smuggled = await dispatch({ action: "list", path: join(cwd, "elsewhere") }, denyTool);
    expect(smuggled.failed?.type === "tool_call_failed" && smuggled.failed.reason).toBe("permission_denied");
    expect(smuggled.out.ok).toBe(false);
    // …and without the deny the smuggled key is simply ignored
    expect((await dispatch({ action: "list", path: join(cwd, "elsewhere") }, gated)).out.ok).toBe(true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("children run the PARENT's model: the child stream receives the ModelRef of the run that started it (fix-wave L5 pin)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-tasks-model-"));
  const childModels: ModelRef[] = [];
  const stream: StreamFn = async function* (m: ModelRef, messages: Message[]): AsyncGenerator<StreamEvent> {
    const goal = goalOf(messages);
    const tools = messages.filter((x) => x.role === "tool").length;
    if (goal.startsWith("CHILD")) { childModels.push(m); yield turn(textTurn("CHILD-DONE")); return; }
    if (tools === 0) { yield turn(toolCall("m1", { action: "start", goal: "CHILD which model", label: "model probe" })); return; }
    if (tools === 1) { yield turn(statusCall("m2", { action: "result", id: "t1", timeout_ms: 20_000 })); return; }
    yield turn(textTurn("PARENT-DONE"));
  };
  try {
    const rt = createRuntime({ cwd, stream });
    const pin: ModelRef = { provider: "pin-provider", model: "pin-model-7" }; // no env/provider fallback can produce this ref
    const def = rt.buildDef(pin);
    const events: RunEvent[] = [];
    for await (const ev of agentLoop(def, "PARENT model pin", {}, rt.buildCfg(true), { stream, registry: rt.registry, store: rt.store, tools: rt.registry.list().map((t) => t.schema), guard: rt.guard, cwd: rt.cwd }, rt.steering)) events.push(ev);
    expect(events.at(-1)).toMatchObject({ type: "run_end", status: "done", summary: "PARENT-DONE" });
    // mutation target: delete `activeModel = model` in runtime.ts buildDef → the child runs fallbackRef
    // (mock/default, or the env provider's default model), never the parent's pin
    // buildDef also stamps the runtime's thinking dial, so the child inherits the parent's effort too
    expect(childModels).toEqual([{ ...pin, effort: "auto" }]); // the runtime's default dial rides to children: "auto" = the provider's own default
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}, 30_000);

test("gated (non-yolo) parent without an approver: the spawn door is policy — `task start` fails closed and nothing runs", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-tasks-gated-"));
  const stream: StreamFn = async function* (_m: ModelRef, messages: Message[]): AsyncGenerator<StreamEvent> {
    if (messages.some((m) => m.role === "tool")) { yield turn(textTurn("after")); return; }
    yield turn(toolCall("g1", { action: "start", goal: "CHILD never" }));
  };
  try {
    const { rt, events } = await runParent(cwd, stream, false, "PARENT gated");
    const failed = events.find((e) => e.type === "tool_call_failed");
    expect(failed?.type === "tool_call_failed" && failed.reason).toBe("permission_denied");
    expect(rt.tasks.list()).toHaveLength(0);
    expect(events.some((e) => e.type === "tool_execution_start")).toBe(false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}, 20_000);
