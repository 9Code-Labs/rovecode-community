/** PORT #82 — `rovecode.lane` spans (src/telemetry/otel-lanes.ts) from scripted TaskInfo snapshots pushed through a
 *  fake TaskManager.subscribe seam, decoded off the fake fetch: queued → running → running (progress) → done is
 *  0 traces POSTs before the terminal snapshot and exactly ONE afterwards, a root span (no parentSpanId) in its
 *  own trace whose start/end are unixNano-equal to the snapshot's startedAt/finishedAt (never the observer's
 *  clock), with task_id / lane / status / depth / exit_code / lane.model / tokens / patch_lines / resumable; a
 *  child task (kind absent) and a queued → cancelled task yield NO span; failed → status 2 "lane failed" and the
 *  raw body lacks error/summary/label/goal; a null exit code omits the attr; running → cancelled → status 1; an
 *  all-zero usage omits the token attrs; observeTasks() through the hook set counts otelDebug.lanesObserved and
 *  session_close unsubscribes. Each test names its mutation target. */

import { test, expect } from "bun:test";
import { otelDebug, unixNano, type OtlpSpan } from "../../src/telemetry/otel.ts";
import { observeLanes, type LaneSource, type LaneTaskInfo } from "../../src/telemetry/otel-lanes.ts";
import type { OtelSpan } from "../../src/telemetry/otlp.ts";
/** a TaskInfo snapshot as the lanes port shapes it: the observer's seam plus the text fields it must never export */
type TaskInfo = LaneTaskInfo & { label?: string; goal?: string; isolated?: boolean; createdAt?: number; permissions?: string; summary?: string; error?: string };
import { ctx, make, spansOf, attr, traces, standardRun } from "../helpers/otel-fixtures.ts";

const GOAL = "write vitest cases for requireAuth in the codex lane";
const LAST_LINE = "Added 4 vitest cases for requireAuth."; // the CODEX fixture's last agent message = the lane's summary
const CARD = "spawn codex lane · sandbox workspace-write · approval never · worktree";
const T0 = 1_700_000_000_000;

/** a fake TaskManager.subscribe: the test pushes snapshots; unsubscribes are counted */
function fakeTasks() {
  const fns = new Set<(t: TaskInfo) => void>();
  let unsubscribed = 0;
  const src: LaneSource = { subscribe(fn) { fns.add(fn); return () => { fns.delete(fn); unsubscribed++; }; } };
  return { src, push: (t: TaskInfo) => { for (const fn of fns) fn({ ...t }); }, get listeners() { return fns.size; }, get unsubscribed() { return unsubscribed; } };
}
const base = (id: string, over: Partial<TaskInfo> = {}): TaskInfo => ({
  id, label: "codex lane", agent: "codex", goal: GOAL, isolated: true, depth: 1, status: "queued", createdAt: T0, kind: "external", permissions: CARD, ...over,
});
const running = (id: string, over: Partial<TaskInfo> = {}): TaskInfo => base(id, { status: "running", startedAt: T0 + 1_000, ...over });
const lanesOf = (posts: { body: Parameters<typeof spansOf>[0] }[]): OtlpSpan[] => posts.flatMap((p) => spansOf(p.body)).filter((s) => s.name === "rovecode.lane");

test("queued → running → running (progress) → done: nothing POSTs before the terminal snapshot, then ONE /v1/traces request holding ONE rovecode.lane root span (no parentSpanId, own trace) with start/end = startedAt/finishedAt and the TaskInfo attributes; goal/label/summary/card text never appear", () => {
  const spans: OtelSpan[] = [];
  const tasks = fakeTasks();
  const off = observeLanes(tasks.src, (s) => spans.push(s), () => 42);
  expect(tasks.listeners).toBe(1);
  tasks.push(base("t1"));
  tasks.push(running("t1"));
  tasks.push(running("t1", { summary: "thread thr-codex-1\nthinking: Look at the guard first." })); // a progress re-emit
  expect(spans.length).toBe(0); // MUTATION TARGET: emit at `running` → 1 here
  tasks.push(base("t1", { status: "done", startedAt: T0 + 1_000, finishedAt: T0 + 7_500, summary: LAST_LINE, usage: { input: 5300, output: 800, cacheRead: 2000 }, patchLines: 12, laneSession: "thr-codex-1", laneExit: 0, laneModel: "o4-mini" }));
  expect(spans.length).toBe(1); // MUTATION TARGET: drop the terminal branch → 0
  const s = spans[0]!;
  expect(s.name).toBe("rovecode.lane");
  expect(s.parentSpanId).toBeUndefined(); // a root span: TaskInfo carries no runId, nothing is guessed
  expect(s.traceId).toMatch(/^[0-9a-f]{32}$/); expect(s.spanId).toMatch(/^[0-9a-f]{16}$/);
  expect(unixNano(s.start)).toBe(unixNano(T0 + 1_000)); // the snapshot's clock, not the observer's (42)
  expect(unixNano(s.end!)).toBe(unixNano(T0 + 7_500));
  expect(s.status).toEqual({ code: 1 });
  const a = (k: string) => { const v = s.attrs.get(k); return v ? Object.values(v)[0] : undefined; };
  expect(a("rovecode.task_id")).toBe("t1"); expect(a("rovecode.lane")).toBe("codex"); expect(a("rovecode.status")).toBe("done"); expect(a("rovecode.depth")).toBe("1");
  expect(a("rovecode.exit_code")).toBe("0"); // MUTATION TARGET (f): drop the laneExit copy in tasks.ts finish() → undefined (pinned end-to-end in otel-lanes-wiring)
  expect(a("rovecode.lane.model")).toBe("o4-mini");
  expect([a("rovecode.tokens.input"), a("rovecode.tokens.output"), a("rovecode.tokens.cacheRead"), a("rovecode.tokens.cacheWrite")]).toEqual(["5300", "800", "2000", "0"]);
  expect(a("rovecode.patch_lines")).toBe("12");
  expect(a("rovecode.lane.resumable")).toBe(true);
  expect([...s.attrs.keys()].sort()).toEqual(["rovecode.depth", "rovecode.exit_code", "rovecode.lane", "rovecode.lane.model", "rovecode.lane.resumable", "rovecode.patch_lines", "rovecode.status", "rovecode.task_id", "rovecode.tokens.cacheRead", "rovecode.tokens.cacheWrite", "rovecode.tokens.input", "rovecode.tokens.output"]);
  // a later re-emit of the settled task adds nothing; unsubscribe detaches
  tasks.push(base("t1", { status: "done", startedAt: T0 + 1_000, finishedAt: T0 + 7_500 }));
  expect(spans.length).toBe(1);
  off();
  expect(tasks.listeners).toBe(0); expect(tasks.unsubscribed).toBe(1);
});

test("through the hook set (observeTasks): the lane span is POSTed as ONE /v1/traces request when the task settles — separate from the run's trace (distinct traceId, no parent), 0 requests while it runs; otelDebug.lanesObserved counts the subscription; the raw JSON never carries goal, label, summary/last output line, error, permissions card text", async () => {
  const { set, ff, msgs, warnings } = make();
  const tasks = fakeTasks();
  const before = otelDebug.lanesObserved;
  set.observeTasks(tasks.src);
  expect(otelDebug.lanesObserved).toBe(before + 1);
  await standardRun(set, ctx("r1"), msgs); // the run that "started" the lane: its own trace
  tasks.push(base("t1")); tasks.push(running("t1")); tasks.push(running("t1", { summary: "thread thr-codex-1" }));
  await set.flush();
  expect(traces(ff).length).toBe(1); // MUTATION TARGET (g): POST at `running` → 2 here
  tasks.push(base("t1", { status: "done", startedAt: T0 + 1_000, finishedAt: T0 + 9_000, summary: LAST_LINE, usage: { input: 5300, output: 800, cacheRead: 2000 }, patchLines: 3, laneSession: "thr-codex-1", laneExit: 0 }));
  await set.flush();
  expect(traces(ff).length).toBe(2);
  expect(warnings).toEqual([]);
  const runTrace = spansOf(traces(ff)[0]!.body), laneReq = traces(ff)[1]!;
  const lane = spansOf(laneReq.body);
  expect(lane.length).toBe(1); // ONE span in the request
  expect(lane[0]!.name).toBe("rovecode.lane");
  expect(lane[0]!.parentSpanId).toBeUndefined();
  expect(lane[0]!.traceId).not.toBe(runTrace[0]!.traceId); // its OWN trace
  expect(lane[0]!.startTimeUnixNano).toBe(unixNano(T0 + 1_000)); expect(lane[0]!.endTimeUnixNano).toBe(unixNano(T0 + 9_000));
  expect(laneReq.body.resourceSpans[0]!.resource.attributes).toContainEqual({ key: "service.name", value: { stringValue: "rovecode" } });
  const raw = JSON.stringify(laneReq.body);
  for (const secret of [GOAL, "requireAuth", "codex lane", LAST_LINE, "Added 4", CARD, "sandbox", "thread thr-codex-1"]) expect(raw).not.toContain(secret); // MUTATION TARGET (e): add t.label / r.summary as an attr
  expect(raw).toContain('"codex"'); // the adapter id is the only text besides ids and outcomes
  expect(attr(lane[0]!, "rovecode.exit_code")).toBe("0");
  expect(attr(lane[0]!, "rovecode.lane.model")).toBeUndefined(); // no ROVECODE_LANE_CODEX_MODEL → omitted
  // session_close unsubscribes: a lane settling afterwards is not exported by a closed set
  tasks.push(base("t2")); tasks.push(running("t2"));
  await set.session_close!(ctx("r1"));
  expect(tasks.listeners).toBe(0);
  tasks.push(base("t2", { status: "done", startedAt: T0, finishedAt: T0 + 1 }));
  await set.flush();
  expect(traces(ff).length).toBe(2);
});

test("negatives: a child task (kind absent) running → done and a queued → cancelled external lane yield NO span; two external lanes get two requests with distinct traceIds and spanIds", async () => {
  const { set, ff } = make();
  const tasks = fakeTasks();
  set.observeTasks(tasks.src);
  const child = (over: Partial<TaskInfo>): TaskInfo => ({ id: "c1", label: "child", agent: "worker", goal: "child goal", isolated: false, depth: 1, status: "queued", createdAt: T0, ...over });
  tasks.push(child({})); tasks.push(child({ status: "running", startedAt: T0 })); tasks.push(child({ status: "done", startedAt: T0, finishedAt: T0 + 10, summary: "done: child" }));
  tasks.push(base("q1")); tasks.push(base("q1", { status: "cancelled", error: "cancelled", finishedAt: T0 + 5 })); // never ran
  await set.flush();
  expect(ff.posts.length).toBe(0); // MUTATION TARGET (a): drop the kind === "external" filter → the child's span POSTs
  tasks.push(base("a")); tasks.push(running("a")); tasks.push(base("b")); tasks.push(running("b", { startedAt: T0 + 2_000 }));
  tasks.push(base("b", { status: "done", startedAt: T0 + 2_000, finishedAt: T0 + 3_000, usage: { input: 1, output: 1 }, laneExit: 0 }));
  tasks.push(base("a", { status: "done", startedAt: T0 + 1_000, finishedAt: T0 + 4_000, usage: { input: 1, output: 1 }, laneExit: 0 }));
  await set.flush();
  const lanes = lanesOf(traces(ff));
  expect(traces(ff).length).toBe(2); expect(lanes.length).toBe(2);
  expect(lanes.map((s) => attr(s, "rovecode.task_id"))).toEqual(["b", "a"]); // in settle order
  expect(new Set(lanes.map((s) => s.traceId)).size).toBe(2); expect(new Set(lanes.map((s) => s.spanId)).size).toBe(2);
});

test("outcomes: failed → status 2 'lane failed' (rovecode.status failed) with error/summary/label absent from the body; a null exit code (abandoned pipe) omits rovecode.exit_code; a refused lane (no exit, usage {0,0}, no session) has neither exit_code nor tokens and resumable false; running → cancelled → status 1 with rovecode.status cancelled and its exit code", async () => {
  const { set, ff } = make();
  const tasks = fakeTasks();
  set.observeTasks(tasks.src);
  tasks.push(running("f1"));
  tasks.push(base("f1", { status: "failed", startedAt: T0 + 1_000, finishedAt: T0 + 2_000, error: "codex exited with code 2 without a result: FATAL secret path", usage: { input: 10, output: 0 }, laneExit: 2, laneSession: "thr-x" }));
  tasks.push(running("n1"));
  tasks.push(base("n1", { status: "failed", startedAt: T0 + 1_000, finishedAt: T0 + 2_000, error: "timed out after 5ms", usage: { input: 1, output: 1 }, laneExit: null }));
  tasks.push(running("r1"));
  tasks.push(base("r1", { status: "failed", startedAt: T0 + 1_000, finishedAt: T0 + 1_001, error: "isolation unavailable — an external lane never runs in the parent tree", usage: { input: 0, output: 0 } }));
  tasks.push(running("k1"));
  tasks.push(base("k1", { status: "cancelled", startedAt: T0 + 1_000, finishedAt: T0 + 5_000, error: "cancelled", usage: { input: 0, output: 0 }, laneExit: 143 }));
  await set.flush();
  const [f1, n1, r1, k1] = lanesOf(traces(ff)) as [OtlpSpan, OtlpSpan, OtlpSpan, OtlpSpan];
  expect(f1.status).toEqual({ code: 2, message: "lane failed" }); // MUTATION TARGET: OK for every terminal status
  expect(attr(f1, "rovecode.status")).toBe("failed"); expect(attr(f1, "rovecode.exit_code")).toBe("2"); expect(attr(f1, "rovecode.lane.resumable")).toBe(true);
  expect([attr(f1, "rovecode.tokens.input"), attr(f1, "rovecode.tokens.output")]).toEqual(["10", "0"]);
  const raw = JSON.stringify(traces(ff)[0]!.body);
  for (const secret of ["FATAL", "secret path", "exited with code", "codex lane", GOAL]) expect(raw).not.toContain(secret);
  expect(attr(n1, "rovecode.exit_code")).toBeUndefined(); // null = never observed → omitted (never "0", never "-1")
  expect(n1.status).toEqual({ code: 2, message: "lane failed" });
  expect(attr(r1, "rovecode.exit_code")).toBeUndefined(); // refused before any spawn
  expect(attr(r1, "rovecode.tokens.input")).toBeUndefined(); // nothing came back
  expect(attr(r1, "rovecode.lane.resumable")).toBe(false);
  expect(attr(r1, "rovecode.patch_lines")).toBeUndefined();
  expect(k1.status).toEqual({ code: 1 }); // the #39 "stopped" rule: cancelled is not an error
  expect(attr(k1, "rovecode.status")).toBe("cancelled"); expect(attr(k1, "rovecode.exit_code")).toBe("143");
  expect(k1.endTimeUnixNano).toBe(unixNano(T0 + 5_000));
});
