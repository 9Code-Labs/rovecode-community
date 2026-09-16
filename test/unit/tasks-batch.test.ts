/** BATCHES — one note for a crew, not one per agent (TaskInfo.batch, bindRun's second argument).
 *  The grouping under test is "started under the same run": bindRun is called exactly once per run by
 *  every surface, so the run IS the batch. Anything time- or label-shaped would be a guess, and these
 *  tests are written so that a guess cannot pass them (see the nested-inheritance test).
 *
 *  What the summary must say, and each of these is a way it could lie:
 *    - a batch with a failure says FAILED in its FIRST line, not as a footnote under a success count
 *    - two agents that wrote the same file are named with the path — the one thing nobody can work
 *      out from "3 agents finished"
 *    - a counter nothing reported stays UNDEFINED: 0 tool calls is a claim, and an unread lane has
 *      not earned it
 *
 *  Also here, because it is the OTHER end of the same batch entry: the sentence a lane states when it
 *  starts running — not when it is queued behind the concurrency bound, and exactly once. */

import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  TaskManager, batchNote, summariseBatch, BATCH_LABEL_MAX,
  type TaskInfo, type TaskManagerOptions,
} from "../../src/core/tasks.ts";
import { SteeringQueue } from "../../src/core/loop.ts";
import { ToolRegistry } from "../../src/core/tools.ts";
import { writeTool } from "../../src/coding/hashline.ts";
import { textTurn, toolTurn } from "../../src/providers/stream.ts";
import type { ChildRunnerDeps } from "../../src/core/orchestrator.ts";
import type { LaneJobDeps } from "../../src/lanes/job.ts";
import { fakeLaneSpawn } from "../helpers/fake-lane.ts";
import type { AgentDefinition, Message, ModelRef, RunConfig, StreamEvent, StreamFn, StreamOptions } from "../../src/core/types.ts";

const allowAll = [{ action: "*", resource: "*", effect: "allow" as const }];
const cfg: RunConfig = { maxTurns: 6, contextBudgetTokens: 100_000, compactionThreshold: 0.8, parallelTools: false, permissionRules: allowAll };
const worker: AgentDefinition = { name: "worker", systemPrompt: "w", tools: ["*"] };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function deadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const bomb = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error(`${what}: not settled within ${ms}ms`)), ms); });
  return Promise.race([p, bomb]).finally(() => clearTimeout(t));
}

const goalOf = (messages: Message[]): string => {
  const u = messages.find((m) => m.role === "user");
  return u ? u.parts.filter((p) => p.kind === "text").map((p) => (p as { text: string }).text).join("") : "";
};

/** goal "FAIL …" → the child's run ends in an error turn; "HOLD …" parks until its signal aborts;
 *  anything else answers at once. */
const plainChildren = (): StreamFn => async function* (_m: ModelRef, messages: Message[], opts?: StreamOptions): AsyncGenerator<StreamEvent> {
  const goal = goalOf(messages);
  if (goal.startsWith("HOLD")) {
    const sig = opts?.signal;
    if (!sig?.aborted) await new Promise<void>((r) => sig?.addEventListener("abort", () => r(), { once: true }));
    yield { type: "turn", turn: { parts: [], stopReason: "aborted", usage: { input: 0, output: 0 } } };
    return;
  }
  if (goal.startsWith("FAIL")) {
    yield { type: "turn", turn: { parts: [], stopReason: "error", usage: { input: 0, output: 0 }, error: "provider exploded" } };
    return;
  }
  yield { type: "turn", turn: textTurn(`done: ${goal}`) };
};

function makeManager(stream: StreamFn, over: Partial<ChildRunnerDeps> = {}, opts: { max?: number; run?: TaskManagerOptions["run"]; lanes?: LaneJobDeps } = {}) {
  const root = mkdtempSync(join(tmpdir(), "rovecode-batch-root-"));
  const sessions = mkdtempSync(join(tmpdir(), "rovecode-batch-sess-"));
  const deps: ChildRunnerDeps = {
    defs: new Map([["worker", worker]]), stream, registryFactory: () => new ToolRegistry(),
    rootDir: root, sessionsDir: sessions, baseConfig: cfg, ...over,
  };
  const tasks = new TaskManager({ deps: () => deps, maxConcurrent: opts.max ?? 3, ...(opts.run ? { run: opts.run } : {}), ...(opts.lanes ? { lanes: opts.lanes } : {}) });
  const cleanup = async () => {
    tasks.cancelAll();
    await tasks.drain(3_000);
    rmSync(root, { recursive: true, force: true });
    rmSync(sessions, { recursive: true, force: true });
  };
  return { tasks, root, sessions, cleanup };
}

const startOk = (tasks: TaskManager, goal: string, extra: Parameters<TaskManager["start"]>[1] = {}): string => {
  const r = tasks.start({ agent: "worker", goal }, extra);
  if (!r.ok) throw new Error(`start refused: ${r.reason}`);
  return r.id;
};

// ---------- the seam: one batch per bound run ----------

test("bindRun stamps a batch: two runs, two batch ids; the label is one-lined and clipped here", async () => {
  const { tasks, cleanup } = makeManager(plainChildren());
  try {
    tasks.bindRun(new AbortController().signal, { label: "test project\nscan   the   docs" });
    const a = startOk(tasks, "one");
    tasks.bindRun(new AbortController().signal, { label: `x${"y".repeat(200)}` });
    const b = startOk(tasks, "two");

    const ia = tasks.status(a)!, ib = tasks.status(b)!;
    expect(ia.batch).toBeDefined();
    expect(ib.batch).toBeDefined();
    // mutation target: one shared default id (every run would render as a single workflow)
    expect(ia.batch).not.toBe(ib.batch);
    // the label is bounded BEFORE it leaves this file — no surface should be the first thing to clip it
    expect(ia.batchLabel).toBe("test project scan the docs");
    expect(ib.batchLabel!.length).toBe(BATCH_LABEL_MAX);
    expect(ib.batchLabel!.endsWith("…")).toBe(true);
  } finally { await cleanup(); }
}, 20_000);

test("an explicit batch id is honoured, and a task started before any run has no batch at all", async () => {
  const { tasks, cleanup } = makeManager(plainChildren());
  try {
    const orphan = startOk(tasks, "before any run");
    expect(tasks.status(orphan)!.batch).toBeUndefined(); // not "" and not a shared bucket
    tasks.bindRun(new AbortController().signal, { id: "run-42" });
    expect(tasks.status(startOk(tasks, "after"))!.batch).toBe("run-42");
  } finally { await cleanup(); }
}, 20_000);

test("a NESTED task inherits its CALLER's batch, even after the next run has been bound", async () => {
  const { tasks, cleanup } = makeManager(plainChildren());
  try {
    tasks.bindRun(new AbortController().signal, { id: "run-A", label: "first" });
    const parent = startOk(tasks, "HOLD parent");
    await deadline((async () => { while (tasks.status(parent)?.status !== "running") await sleep(10); })(), 5_000, "parent running");

    // the next run is bound while the long task is still going — a manager-current-batch stamp would
    // put its child in run-B, a workflow card it has nothing to do with
    tasks.bindRun(new AbortController().signal, { id: "run-B", label: "second" });
    const child = startOk(tasks, "child work", { caller: parent, parentDepth: 1 });

    const ic = tasks.status(child)!;
    expect(ic.batch).toBe("run-A");
    expect(ic.batchLabel).toBe("first");
    expect(tasks.status(startOk(tasks, "unrelated"))!.batch).toBe("run-B");
  } finally { await cleanup(); }
}, 20_000);

// ---------- one note per batch ----------

const notes = (q: SteeringQueue): string[] => q.drainAll();

test("three tasks in one batch produce ONE note when the LAST settles, naming every agent", async () => {
  const q = new SteeringQueue();
  const { tasks, cleanup } = makeManager(plainChildren());
  try {
    tasks.attach(q);
    tasks.bindRun(new AbortController().signal, { id: "r1", label: "project scan" });
    const ids = [startOk(tasks, "read docs"), startOk(tasks, "read tests"), startOk(tasks, "read src")];
    for (const id of ids) await deadline(tasks.result(id, { timeoutMs: 10_000 }), 11_000, id);
    await sleep(50);

    const out = notes(q);
    // mutation target: push taskNote per task (3 notes, and no statement about the batch)
    expect(out.length).toBe(1);
    const note = out[0]!;
    expect(note).toContain("batch r1 (project scan)");
    expect(note).toContain("3 agents");
    for (const id of ids) expect(note).toContain(id);
    expect(note).toContain("3 done");
  } finally { await cleanup(); }
}, 30_000);

test("nothing is said until the batch is complete: a still-running sibling holds the summary", async () => {
  const q = new SteeringQueue();
  const { tasks, cleanup } = makeManager(plainChildren());
  try {
    tasks.attach(q);
    tasks.bindRun(new AbortController().signal, { id: "r1" });
    const quick = startOk(tasks, "quick");
    const slow = startOk(tasks, "HOLD slow");
    await deadline(tasks.result(quick, { timeoutMs: 10_000 }), 11_000, "quick");
    await sleep(50);
    expect(notes(q).length).toBe(0); // mutation: summarise on the first settle → a half-batch report

    tasks.cancel(slow);
    await deadline(tasks.result(slow, { timeoutMs: 10_000 }), 11_000, "slow");
    await sleep(50);
    const out = notes(q);
    expect(out.length).toBe(1);
    expect(out[0]!).toContain("2 agents");
    expect(out[0]!).toContain("1 cancelled");
  } finally { await cleanup(); }
}, 30_000);

test("a batch of one reads exactly as it did before batches existed", async () => {
  const q = new SteeringQueue();
  const { tasks, cleanup } = makeManager(plainChildren());
  try {
    tasks.attach(q);
    tasks.bindRun(new AbortController().signal, { id: "r1" });
    const id = startOk(tasks, "alone");
    await deadline(tasks.result(id, { timeoutMs: 10_000 }), 11_000, "alone");
    await sleep(50);
    const out = notes(q);
    expect(out.length).toBe(1);
    expect(out[0]!).toStartWith(`task ${id} (alone) finished:`);
    expect(out[0]!).not.toContain("batch");
  } finally { await cleanup(); }
}, 30_000);

test("a second group in the SAME run gets its own summary, and no agent is reported twice", async () => {
  const q = new SteeringQueue();
  const { tasks, cleanup } = makeManager(plainChildren());
  try {
    tasks.attach(q);
    tasks.bindRun(new AbortController().signal, { id: "r1" });
    const first = [startOk(tasks, "a"), startOk(tasks, "b")];
    for (const id of first) await deadline(tasks.result(id, { timeoutMs: 10_000 }), 11_000, id);
    await sleep(50);
    const one = notes(q);
    expect(one.length).toBe(1);

    // the same run starts more work on a later turn: the new group is summarised on its own
    const second = [startOk(tasks, "c"), startOk(tasks, "d")];
    for (const id of second) await deadline(tasks.result(id, { timeoutMs: 10_000 }), 11_000, id);
    await sleep(50);
    const two = notes(q);
    expect(two.length).toBe(1);
    expect(two[0]!).toContain("2 agents");
    for (const id of second) expect(two[0]!).toContain(id);
    for (const id of first) expect(two[0]!).not.toContain(id); // mutation: drop `reported` → a and b said twice
  } finally { await cleanup(); }
}, 30_000);

test("a nested task steers its CALLER's queue, not the batch summary's", async () => {
  const root = new SteeringQueue(), childQ = new SteeringQueue();
  const { tasks, cleanup } = makeManager(plainChildren());
  try {
    tasks.attach(root);
    tasks.bindRun(new AbortController().signal, { id: "r1" });
    const parent = startOk(tasks, "HOLD parent");
    await deadline((async () => { while (tasks.status(parent)?.status !== "running") await sleep(10); })(), 5_000, "parent running");
    // the nested task shares the batch but reports into the child's own steering queue
    const nested = startOk(tasks, "nested", { caller: parent, parentDepth: 1, notify: childQ });
    await deadline(tasks.result(nested, { timeoutMs: 10_000 }), 11_000, "nested");
    await sleep(50);

    // mutation: group by batch alone → the caller's queue gets nothing and the root gets a
    // summary about a child it never started
    expect(root.drainAll().length).toBe(0);
    const kid = childQ.drainAll();
    expect(kid.length).toBe(1);
    expect(kid[0]!).toContain(`task ${nested} (nested) finished`);
  } finally { await cleanup(); }
}, 30_000);

// ---------- a failure is not a footnote ----------

test("one failed agent: the FIRST line of the summary says FAILED", async () => {
  const q = new SteeringQueue();
  const { tasks, cleanup } = makeManager(plainChildren());
  try {
    tasks.attach(q);
    tasks.bindRun(new AbortController().signal, { id: "r1", label: "scan" });
    const ids = [startOk(tasks, "ok one"), startOk(tasks, "FAIL two"), startOk(tasks, "ok three")];
    for (const id of ids) await deadline(tasks.result(id, { timeoutMs: 10_000 }), 11_000, id);
    await sleep(50);

    const note = notes(q)[0]!;
    const head = note.split("\n")[0]!;
    expect(head).toContain("1 FAILED");
    // the failure comes BEFORE the successes in the head — "2 done, 1 failed" is the footnote shape
    expect(head.indexOf("FAILED")).toBeLessThan(head.indexOf("done"));
    expect(note).toContain(`${ids[1]} worker`);
    expect(note).toContain("provider exploded");
  } finally { await cleanup(); }
}, 30_000);

// ---------- collisions, with the path ----------

/** Isolated children that each write ONE file: the goal names it, so two goals can name the same one. */
function writingChildren() {
  const stamp = randomUUID().slice(0, 8);
  const fileFor = (goal: string) => `${goal.split(" ")[1] ?? "x"}-${stamp}.txt`;
  const stream: StreamFn = async function* (_m: ModelRef, messages: Message[]): AsyncGenerator<StreamEvent> {
    const goal = goalOf(messages);
    if (!messages.some((m) => m.role === "tool")) {
      yield { type: "turn", turn: toolTurn([{ id: "w1", tool: "write", args: { path: fileFor(goal), content: `from ${goal}\n` } }]) };
      return;
    }
    yield { type: "turn", turn: textTurn("wrote it") };
  };
  return { stream, fileFor };
}

test("two agents that wrote the same file are named in the summary, with the path", async () => {
  const q = new SteeringQueue();
  const { stream, fileFor } = writingChildren();
  const { tasks, root, cleanup } = makeManager(stream, { registryFactory: () => { const r = new ToolRegistry(); r.register(writeTool); return r; } });
  writeFileSync(join(root, "base.txt"), "base\n");
  const shared = fileFor("write shared"), own = fileFor("write own");
  // isolation is a property of the REQUEST, and only an isolated task has a patch to read
  const iso = (goal: string, label: string): string => {
    const r = tasks.start({ agent: "worker", goal, isolated: true }, { label });
    if (!r.ok) throw new Error(`start refused: ${r.reason}`);
    return r.id;
  };
  try {
    tasks.attach(q);
    tasks.bindRun(new AbortController().signal, { id: "r1", label: "crew" });
    // serialised so the two patches merge back one after the other, as they would in a real crew.
    // The two goals differ (so the second's content differs from what the first merged, and its own
    // diff is not empty) but name the SAME file — which is exactly the overlap worth shouting about.
    const a = iso("write shared left", "left");
    await deadline(tasks.result(a, { timeoutMs: 20_000 }), 21_000, "first writer");
    const b = iso("write shared right", "right");
    const c = iso("write own thing", "elsewhere");
    for (const id of [b, c]) await deadline(tasks.result(id, { timeoutMs: 20_000 }), 21_000, id);
    await sleep(50);

    expect(tasks.status(a)!.files).toEqual([shared]);
    expect(tasks.status(c)!.files).toEqual([own]);

    // the first writer settled alone and got its own note; the overlap only exists once the
    // second one lands, so it is the LAST note that has to name it
    const out = notes(q);
    expect(out.length).toBe(2);
    const note = out[1]!;
    // mutation target: report only counts ("3 agents finished") → nobody learns about the overlap
    expect(note).toContain(`COLLISION: ${shared}`);
    expect(note).toContain(`${a} and ${b}`);
    expect(note).not.toContain(`COLLISION: ${own}`);
    // and it is said ABOVE the per-agent rows, where it cannot be skimmed past
    expect(note.indexOf("COLLISION")).toBeLessThan(note.indexOf(`${c} worker`));
  } finally { await cleanup(); }
}, 60_000);

test("a REJECTED patch claims no files: `git apply` refusing leaves ok:true, and the second writer of a file is the likeliest one refused", async () => {
  const patch = "diff --git a/src/auth.ts b/src/auth.ts\n--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -1 +1 @@\n-old\n+new\n";
  const { tasks, cleanup } = makeManager(plainChildren(), {}, {
    // the shape orchestrator.ts / job.ts actually return when the merge-back is refused: ok TRUE,
    // a real patch, and applied FALSE (the marker in the summary is a message for a human, not the fact)
    run: async () => ({ agent: "worker", ok: true, summary: "did the work\npatch-apply-failed", usage: { input: 1, output: 1 }, patch, applied: false }),
  });
  try {
    const id = startOk(tasks, "rejected", {});
    await deadline(tasks.result(id, { timeoutMs: 10_000 }), 11_000, "rejected");
    const info = tasks.status(id)!;
    expect(info.status).toBe("done");
    expect(info.patchLines).toBeGreaterThan(0); // the patch exists and has a size…
    expect(info.files).toBeUndefined();          // …but nothing in the parent tree changed
  } finally { await cleanup(); }
}, 30_000);

test("the summary text is not load-bearing: at the 4000-char cap, where the marker is truncated away, `applied` decides in BOTH directions", async () => {
  const patch = "diff --git a/src/auth.ts b/src/auth.ts\n--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -1 +1 @@\n-old\n+new\n";
  // Why this length. orchestrator appends "\npatch-apply-failed" and THEN slices the summary to 4000,
  // so a child that ends by describing its own diff loses the marker — and a child that writes a lot is
  // the one whose patch is likeliest to be refused. That is why the fact is a boolean and not this text.
  const summary = (`${"x".repeat(3_990)}\npatch-apply-failed`).slice(0, 4_000);
  expect(summary.includes("patch-apply-failed")).toBe(false); // the premise, pinned
  const run = (applied: boolean): TaskManagerOptions["run"] =>
    async () => ({ agent: "worker", ok: true, summary, usage: { input: 1, output: 1 }, patch, applied });

  const refused = makeManager(plainChildren(), {}, { run: run(false) });
  try {
    const id = startOk(refused.tasks, "verbose refused", {});
    await deadline(refused.tasks.result(id, { timeoutMs: 10_000 }), 11_000, "verbose refused");
    // mutation target: sniff the marker again → its absence reads as applied and the task that LOST
    // the race is named as a writer of the file it never wrote
    expect(refused.tasks.status(id)!.files).toBeUndefined();
  } finally { await refused.cleanup(); }

  const took = makeManager(plainChildren(), {}, { run: run(true) });
  try {
    const id = startOk(took.tasks, "verbose applied", {});
    await deadline(took.tasks.result(id, { timeoutMs: 10_000 }), 11_000, "verbose applied");
    // the same 4000-char summary, but the merge-back TOOK it — the files are real and must be named.
    // mutation target: treat cap-length as "not known to have landed" → every verbose child's file
    // list is silently discarded on evidence that has nothing to do with whether the patch applied
    expect(took.tasks.status(id)!.files).toEqual(["src/auth.ts"]);
  } finally { await took.cleanup(); }
}, 30_000);

test("a task that changed nothing has no file list — an empty patch is not an empty claim", async () => {
  const q = new SteeringQueue();
  const { tasks, cleanup } = makeManager(plainChildren());
  try {
    tasks.attach(q);
    const id = startOk(tasks, "reads only", {});
    await deadline(tasks.result(id, { timeoutMs: 10_000 }), 11_000, "reader");
    expect(tasks.status(id)!.files).toBeUndefined();
    expect(tasks.status(id)!.progress).toBeUndefined(); // no runner reported: NOT a zeroed tally
  } finally { await cleanup(); }
}, 30_000);

// ---------- the lane start note (the other end of a batch entry) ----------

test("a QUEUED lane announces nothing; the note fires once, when it actually starts running", async () => {
  const root = mkdtempSync(join(tmpdir(), "rovecode-batch-lane-"));
  const q = new SteeringQueue();
  const { spawn } = fakeLaneSpawn({ lines: ['{"type":"item.completed","item":{"type":"agent_message","text":"lane done"}}'] });
  const { tasks, cleanup } = makeManager(plainChildren(), { rootDir: root }, {
    max: 1, lanes: { spawn, env: { ROVECODE_LANES_ALLOW: "codex" }, timeoutMs: 5_000 },
  });
  try {
    tasks.attach(q);
    const blocker = startOk(tasks, "HOLD the only slot");
    await deadline((async () => { while (tasks.status(blocker)?.status !== "running") await sleep(10); })(), 5_000, "blocker running");
    const lane = tasks.start({ agent: "codex", goal: "queued behind the bound" });
    expect(lane.ok).toBe(true);
    await sleep(100);
    // mutation target: announce at start() → a lane that has spawned nothing claims to be working
    expect(tasks.status((lane as { id: string }).id)!.status).toBe("queued");
    expect(notes(q).length).toBe(0);

    tasks.cancel(blocker);
    await deadline(tasks.result((lane as { id: string }).id, { timeoutMs: 20_000 }), 21_000, "lane settles");
    await sleep(50);
    const out = notes(q);
    const starts = out.filter((n) => n.includes("— started;"));
    expect(starts.length).toBe(1); // mutation: announce on every emit → the sentence repeats until nobody reads it
    expect(starts[0]!).toContain("spawn codex lane");
  } finally {
    await cleanup();
    rmSync(root, { recursive: true, force: true });
  }
}, 40_000);

// ---------- the summary as data (what a card reads) ----------

const info = (over: Partial<TaskInfo>): TaskInfo => ({
  id: "t1", label: "l", agent: "worker", goal: "g", isolated: false, depth: 1,
  status: "done", createdAt: 0, startedAt: 0, finishedAt: 1_000, batch: "r1", ...over,
});

test("summariseBatch counts by status and names every multi-writer file, sorted", () => {
  const s = summariseBatch([
    info({ id: "t1", batchLabel: "crew", files: ["src/a.ts", "src/b.ts"] }),
    info({ id: "t2", status: "failed", error: "boom" }),
    info({ id: "t3", files: ["src/b.ts", "src/a.ts"] }),
    info({ id: "t4", status: "cancelled" }),
  ]);
  expect(s).toMatchObject({ batch: "r1", label: "crew", done: 2, failed: 1, cancelled: 1 });
  expect(s.collisions).toEqual([
    { path: "src/a.ts", tasks: ["t1", "t3"] },
    { path: "src/b.ts", tasks: ["t1", "t3"] },
  ]);
});

test("batchNote: three writers of one file are all named", () => {
  const note = batchNote(summariseBatch([
    info({ id: "t1", files: ["x.ts"] }), info({ id: "t2", files: ["x.ts"] }), info({ id: "t3", files: ["x.ts"] }),
  ]));
  expect(note).toContain("COLLISION: x.ts — t1, t2 and t3 both changed this file");
});

test("batchNote reports a per-agent duration and file count, and stays quiet about what it was not told", () => {
  const note = batchNote(summariseBatch([
    info({ id: "t1", agent: "claude", finishedAt: 12_000, files: ["a.ts"], summary: "did the thing" }),
    info({ id: "t2", agent: "codex", startedAt: undefined, finishedAt: undefined, summary: "no clock" }),
  ]));
  expect(note).toContain("t1 claude 12s done [1 file] — did the thing");
  expect(note).toContain("t2 codex done — no clock"); // no invented 0s, no invented [0 files]
});
