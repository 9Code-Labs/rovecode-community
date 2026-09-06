/** Reflection × background tasks (port #28 × port #26; fix-wave 4 MED-A). Children run under the
 *  runtime's hooks (0cf2992) but the reflection set serves ONE queue — the parent's — so it must act
 *  only on runs it owns (core/reflection.ts `owns`, bound in cli/runtime.ts to the ACTIVE store's id).
 *  Pinned with a REAL createRuntime (yolo), the real task/task_status tools, and the real hashline edit
 *  on a MISSING file, in the three shapes the critic reproduced: (1) the parent keeps working while
 *  the child's edit fails — its 3rd request used to carry `reflection: the edit call failed — … does-
 *  not-exist.txt` for an edit it never made; (2) the parent blocked in `task_status result` — the
 *  child's nudge was pushed for nobody and swept by the child's own post_run; (3) the parent's OWN
 *  failed edit while a child starts/finishes inside the same batch wait — the child's pre_run / post_run
 *  swept the parent's pending nudge. One scripted provider serves parent and children (a run's identity
 *  is its goal); every gate is explicit, every run has a deadline; ROVECODE_HOME pinned to a temp dir. */

import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime, type Runtime } from "../../src/cli/runtime.ts";
import { agentLoop } from "../../src/core/loop.ts";
import { REFLECTION_PREFIX } from "../../src/core/reflection.ts";
import { textTurn, toolTurn } from "../../src/providers/stream.ts";
import type { AssistantTurn, Message, RunEvent, StreamEvent, StreamFn } from "../../src/core/types.ts";

const MISSING = "does-not-exist.txt";
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const text = (m: Message): string => m.parts.filter((p) => p.kind === "text").map((p) => (p as { text: string }).text).join("");
const goalOf = (messages: Message[]): string => { const u = messages.find((m) => m.role === "user"); return u ? text(u) : ""; };
const toolCount = (messages: Message[]): number => messages.filter((m) => m.role === "tool").length;
const userTexts = (messages: Message[]): string[] => messages.filter((m) => m.role === "user").map(text);
const toolOutputs = (messages: Message[]): string[] => messages.flatMap((m) => m.parts.flatMap((p) => (p.kind === "tool_result" ? [p.output] : [])));
const isReflection = (t: string): boolean => t.startsWith(REFLECTION_PREFIX);
const turn = (t: AssistantTurn): StreamEvent => ({ type: "turn", turn: t });
type Call = { id: string; tool: string; args: unknown };
/** the hashline edit on a file that does not exist — fails with the actionable "file not found" text */
const editCall = (id: string): Call => ({ id, tool: "edit", args: { path: MISSING, edits: [{ tag: "0000", anchorLine: 1, anchorHash: "aaa", newLines: ["x"] }] } });
const startCall = (id: string, goal: string, label: string): Call => ({ id, tool: "task", args: { action: "start", goal, label } });
const resultCall = (id: string, task: string): Call => ({ id, tool: "task_status", args: { action: "result", id: task, timeout_ms: 20_000 } });
const statusCall = (id: string, task: string): Call => ({ id, tool: "task_status", args: { action: "status", id: task } });
const steers = (events: RunEvent[]): string[] => events.flatMap((e) => (e.type === "steer" ? [e.text] : []));
/** steer texts classified: the reflection nudge, the task note, or the raw text */
const kinds = (events: RunEvent[]): string[] => steers(events).map((s) => (isReflection(s) ? "reflection" : /^task t\d+ \(.*\) finished/.test(s) ? "task-note" : s));
function gate(): { wait: Promise<void>; open: () => void } {
  let open: () => void = () => {};
  const wait = new Promise<void>((r) => { open = r; });
  return { wait, open };
}

interface Recorded { goal: string; messages: Message[] }
const ENV_KEYS = ["ROVECODE_HOME", "ROVECODE_NO_CHECKPOINTS", "ROVECODE_NO_REPOMAP", "ROVECODE_REFLECTION", "ROVECODE_REFLECTION_MAX"] as const;
interface Rig { cwd: string; recorded: Recorded[]; done: () => void }
function rig(): Rig {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-refl-tasks-"));
  const home = mkdtempSync(join(tmpdir(), "rovecode-refl-tasks-home-"));
  const saved: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.ROVECODE_HOME = home; // hermetic user scope: the developer's real ~/.rovecode/hooks.* must not load
  process.env.ROVECODE_NO_CHECKPOINTS = "1";
  process.env.ROVECODE_NO_REPOMAP = "1";
  delete process.env.ROVECODE_REFLECTION;
  delete process.env.ROVECODE_REFLECTION_MAX;
  return {
    cwd, recorded: [],
    done: () => {
      for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    },
  };
}
/** a provider that records every request (parent and children alike) before answering through `script` */
function recording(r: Rig, script: (goal: string, tools: number, messages: Message[]) => Promise<AssistantTurn> | AssistantTurn): StreamFn {
  return async function* (_m, messages) {
    r.recorded.push({ goal: goalOf(messages), messages: messages.map((m) => ({ ...m, parts: [...m.parts] })) });
    yield turn(await script(goalOf(messages), toolCount(messages), messages));
  };
}
const requestsOf = (r: Rig, prefix: string): Message[][] => r.recorded.filter((x) => x.goal.startsWith(prefix)).map((x) => x.messages);

/** the cmdRun/TUI LoopDeps shape: rt.hooks + rt.guard + rt.cwd threaded, rt.steering as the queue; yolo so
 *  `task start` needs no approver and children inherit allow-all (their edit is allowed — and fails) */
// These tests count REQUESTS around an edit that fails on a missing file and a model that then stops — exactly the
// shape the finish check (core/loop.ts, test/unit/finish-check.test.ts) adds one turn to. The subject here is the
// reflection nudge's isolation between parent and child, so the finish check is off for this file.
process.env.ROVECODE_FINISH_CHECK = "0";

async function drive(rt: Runtime, stream: StreamFn, goal: string, deadlineMs = 20_000): Promise<RunEvent[]> {
  const events: RunEvent[] = [];
  const def = rt.buildDef({ provider: "mock", model: "default" });
  const cfg = { ...rt.buildCfg(true), maxTurns: 8 };
  const run = (async () => {
    for await (const ev of agentLoop(def, goal, {}, cfg, {
      stream, registry: rt.registry, store: rt.store, tools: rt.registry.list().map((t) => t.schema), guard: rt.guard, cwd: rt.cwd, hooks: rt.hooks,
    }, rt.steering)) events.push(ev);
  })();
  const outcome = await Promise.race([run.then(() => "ran" as const), sleep(deadlineMs).then(() => "DEADLINE" as const)]);
  if (outcome === "DEADLINE") throw new Error(`run did not settle within ${deadlineMs}ms; events so far: ${events.map((e) => e.type).join(",")}`);
  return events;
}
async function teardown(rt: Runtime, r: Rig): Promise<void> {
  rt.tasks.cancelAll();
  await rt.tasks.drain(4_000);
  await rt.hooks.close();
  await rt.mcp?.close();
  r.done();
}
const T = 30_000;

test("(1) a child's failed edit never nudges the parent: the parent keeps working while the child fails on a missing file — no parent request carries a reflection message, no reflection steer; the child (its own store) gets none either; the task note still arrives", async () => {
  const r = rig();
  const childFailed = gate(), parentReq3 = gate();
  const stream = recording(r, async (goal, n) => {
    if (goal.startsWith("PARENT")) {
      if (n === 0) return toolTurn([startCall("p1", "CHILD break an edit", "breaker")]);
      if (n === 1) { await childFailed.wait; return toolTurn([statusCall("p2", "t1")]); } // other work — issued AFTER the child's edit failed
      if (n === 2) { parentReq3.open(); return toolTurn([resultCall("p3", "t1")]); }
      return textTurn("PARENT-DONE");
    }
    if (n === 0) return toolTurn([editCall("k1")]);
    childFailed.open();
    await parentReq3.wait; // the child finishes only after the parent's 3rd request went out (its post_run must not race the parent's drain)
    return textTurn("CHILD-DONE");
  });
  const rt = createRuntime({ cwd: r.cwd, stream }); // the runtime's stream: children run on it (TaskManager deps)
  try {
    await rt.hooks.ready;
    const events = await drive(rt, stream, "PARENT keep working");
    expect(events.at(-1)).toMatchObject({ type: "run_end", status: "done", summary: "PARENT-DONE" });
    expect(rt.tasks.status("t1")).toMatchObject({ status: "done", summary: "CHILD-DONE" });
    const child = requestsOf(r, "CHILD");
    expect(child.length).toBe(2);
    const failed = toolOutputs(child[1]!);
    expect(failed.length).toBe(1);
    expect(failed[0]!.startsWith("Edit rejected: file not found: ")).toBe(true);
    expect(failed[0]).toContain(MISSING);
    const parent = requestsOf(r, "PARENT");
    expect(parent.length).toBe(4);
    // MUTATION TARGET (drop the owns check in post_tool): parent request 3 ends with the user message
    // `reflection: the edit call failed — Edit rejected: file not found: …does-not-exist.txt …`
    for (const req of parent) expect(userTexts(req).filter(isReflection)).toEqual([]);
    for (const req of child) expect(userTexts(req).filter(isReflection)).toEqual([]); // the documented trade-off: children get no reflection
    expect(kinds(events)).toEqual(["task-note"]);
    expect(steers(events)[0]).toContain("task t1 (breaker) finished: CHILD-DONE");
    expect(rt.steering.size).toBe(0);
    expect(rt.hooks.warnings).toEqual([]);
  } finally { await teardown(rt, r); }
}, T);

test("(2) parent blocked in `task_status result`: nothing reflection-shaped is EVER pushed to the parent's queue by the child's failure (push spy); the task note is the only steer and the parent's next request carries just that", async () => {
  const r = rig();
  const stream = recording(r, (goal, n) => {
    if (goal.startsWith("PARENT")) {
      if (n === 0) return toolTurn([startCall("p1", "CHILD fail fast", "fast")]);
      if (n === 1) return toolTurn([resultCall("p2", "t1")]);
      return textTurn("PARENT-DONE");
    }
    return n === 0 ? toolTurn([editCall("f1")]) : textTurn("CHILD-DONE");
  });
  const rt = createRuntime({ cwd: r.cwd, stream });
  try {
    await rt.hooks.ready;
    const pushed: string[] = [];
    const push = rt.steering.push.bind(rt.steering);
    rt.steering.push = (t: string): void => { pushed.push(t); push(t); }; // the set holds THIS queue object: every push it makes lands here
    const events = await drive(rt, stream, "PARENT wait for it");
    expect(events.at(-1)).toMatchObject({ type: "run_end", status: "done", summary: "PARENT-DONE" });
    expect(rt.tasks.status("t1")).toMatchObject({ status: "done", summary: "CHILD-DONE" });
    expect(toolOutputs(requestsOf(r, "CHILD")[1]!)[0]!.startsWith("Edit rejected: file not found: ")).toBe(true);
    // MUTATION TARGET (drop the owns check in post_tool): the child's failure pushed a nudge the child's
    // own post_run then swept — a nudge for nobody, and a parent-visible one had the timing differed
    expect(pushed.filter(isReflection)).toEqual([]);
    expect(pushed.filter((s) => s.includes("task t1 (fast) finished: CHILD-DONE"))).toHaveLength(1);
    const parent = requestsOf(r, "PARENT");
    expect(parent.length).toBe(3);
    expect(userTexts(parent[2]!).filter(isReflection)).toEqual([]);
    expect(userTexts(parent[2]!).some((t) => t.includes("task t1 (fast) finished: CHILD-DONE"))).toBe(true);
    expect(kinds(events)).toEqual(["task-note"]);
    expect(rt.steering.size).toBe(0);
  } finally { await teardown(rt, r); }
}, T);

test("(3a) the parent's OWN nudge survives a child's run START and END inside one batch — [edit(missing), task start, task_status result]: the child's pre_run/post_run used to sweep the parent's pending nudge; the next request carries the reflection, then the task note", async () => {
  const r = rig();
  const stream = recording(r, (goal, n) => {
    if (goal.startsWith("PARENT")) return n === 0 ? toolTurn([editCall("pa1"), startCall("pa2", "CHILD quick", "quick"), resultCall("pa3", "t1")]) : textTurn("PARENT-DONE");
    return textTurn("CHILD-QUICK-DONE");
  });
  const rt = createRuntime({ cwd: r.cwd, stream });
  try {
    await rt.hooks.ready;
    const events = await drive(rt, stream, "PARENT boundary a");
    expect(events.at(-1)).toMatchObject({ type: "run_end", status: "done", summary: "PARENT-DONE" });
    expect(rt.tasks.status("t1")).toMatchObject({ status: "done", summary: "CHILD-QUICK-DONE" });
    const parent = requestsOf(r, "PARENT");
    expect(parent.length).toBe(2);
    const refl = userTexts(parent[1]!).filter(isReflection);
    expect(refl).toHaveLength(1); // MUTATION TARGET (drop the owns check in pre_run OR post_run): the child's boundary swept it → []
    expect(refl[0]!.startsWith(`${REFLECTION_PREFIX}the edit call failed — Edit rejected: file not found: `)).toBe(true);
    expect(refl[0]).toContain(MISSING);
    expect(userTexts(parent[1]!).some((t) => t.includes("task t1 (quick) finished: CHILD-QUICK-DONE"))).toBe(true);
    expect(kinds(events)).toEqual(["reflection", "task-note"]); // queue order: the edit failed before the child settled
    expect(rt.steering.size).toBe(0);
    expect(rt.hooks.warnings).toEqual([]);
  } finally { await teardown(rt, r); }
}, T);

test("(3b) the parent's OWN nudge survives a child FINISHING during its `task_status result` wait — [edit(missing), task_status result] with the child started a turn earlier: only the child's post_run lands in the window, and it must not sweep", async () => {
  const r = rig();
  const parentEditFailed = gate();
  const stream = recording(r, async (goal, n) => {
    if (goal.startsWith("PARENT")) {
      if (n === 0) return toolTurn([startCall("pb1", "CHILD wait for the parent", "waiter")]);
      if (n === 1) return toolTurn([editCall("pb2"), resultCall("pb3", "t1")]);
      return textTurn("PARENT-DONE");
    }
    await parentEditFailed.wait; // the child ends only once the parent's nudge is pending
    return textTurn("CHILD-WAITED");
  });
  const rt = createRuntime({ cwd: r.cwd, stream });
  try {
    await rt.hooks.ready;
    // attached AFTER the built-in set, so it fires once the nudge is already queued; sessionId filters the parent
    rt.hooks.add({ post_tool(ctx, call, out) { if (call.tool === "edit" && !out.ok && ctx.sessionId === rt.store.id) parentEditFailed.open(); } }, "probe");
    const events = await drive(rt, stream, "PARENT boundary b");
    expect(events.at(-1)).toMatchObject({ type: "run_end", status: "done", summary: "PARENT-DONE" });
    expect(rt.tasks.status("t1")).toMatchObject({ status: "done", summary: "CHILD-WAITED" });
    const parent = requestsOf(r, "PARENT");
    expect(parent.length).toBe(3);
    const refl = userTexts(parent[2]!).filter(isReflection);
    expect(refl).toHaveLength(1); // MUTATION TARGET (drop the owns check in post_run): swept by the child's post_run → []
    expect(refl[0]).toContain(MISSING);
    expect(userTexts(parent[2]!).some((t) => t.includes("task t1 (waiter) finished: CHILD-WAITED"))).toBe(true);
    expect(kinds(events)).toEqual(["reflection", "task-note"]);
    expect(rt.steering.size).toBe(0);
    expect(rt.hooks.warnings).toEqual([]);
  } finally { await teardown(rt, r); }
}, T);
