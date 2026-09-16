/** PORT #82 — approval log records of the #39 OTel hook set (src/telemetry/otel-logs.ts + the correlation in
 *  otel.ts): through a REAL HookRunner with a spy human behind hooks.approver, the set's `approval` member is
 *  invoked, returns void, and the human is still asked with their verdict standing (once / deny); a card followed
 *  by the call's tool_execution_start is an `allow` record carrying the tool span's trace/span ids + call id, a
 *  `tool_call_failed{permission_denied}` a `deny` (severity 13), a card still pending at post_run `unanswered`;
 *  two same-tool spans awaiting execution → ids omitted (never a guess); a lane start request → rovecode.lane =
 *  the adapter id and the card text/args/reason nowhere in the payload; the REAL loop order (post_tool before the
 *  buffered start event) yields exactly one record; no cards → no /v1/logs POST. Each test names its mutation. */

import { test, expect, mock } from "bun:test";
import { HookRunner } from "../../src/core/hooks.ts";
import type { ApprovalRequest } from "../../src/core/types.ts";
import type { OtlpLogsRequest } from "../../src/telemetry/otel.ts";
import { ctx, ENDPOINT, make, postsTo, traces, spansOf, standardRun } from "../helpers/otel-fixtures.ts";

const LOGS = "/v1/logs";
const CARD = "spawn codex lane · sandbox workspace-write · approval never · worktree";
const BASE = { cwd: "/w", sessionId: "s1" };
type Rec = OtlpLogsRequest["resourceLogs"][0]["scopeLogs"][0]["logRecords"][0];
const recordsOf = (ff: Parameters<typeof postsTo>[0]): Rec[] => postsTo<OtlpLogsRequest>(ff, LOGS).flatMap((p) => p.body.resourceLogs[0]!.scopeLogs[0]!.logRecords);
const attrOf = (r: Rec, key: string): unknown => { const a = r.attributes.find((x) => x.key === key); return a ? Object.values(a.value)[0] : undefined; };
const req = (tool: string, args: unknown, reason = `permission required for ${tool}`): ApprovalRequest => ({ tool, args, revisedArgs: args, reason });

test("through a real HookRunner + hooks.approver: the otel set's approval() is consulted and returns void — the spy human is asked exactly once and its verdict stands ('once' and 'deny'); the runner records no invalid-result warning; approval() called directly returns undefined", async () => {
  const runner = new HookRunner(BASE, { timeoutMs: 2000 });
  const { set, ff, warnings } = make();
  runner.add(set, "otel");
  expect(runner.has("approval")).toBe(true);
  const human = mock(async (_r: ApprovalRequest): Promise<"once" | "always" | "deny"> => "once");
  const approve = runner.approver(human);
  expect(await approve(req("bash", { command: "ls" }))).toBe("once"); // MUTATION TARGET (b): approval() returns "allow" → "once" WITHOUT asking → human 0 calls
  expect(human).toHaveBeenCalledTimes(1);
  expect(human.mock.calls[0]![0]!.tool).toBe("bash");
  human.mockImplementation(async () => "deny");
  expect(await approve(req("bash", { command: "rm -rf /" }))).toBe("deny"); // the human's deny is the verdict, untouched
  expect(human).toHaveBeenCalledTimes(2);
  expect(await set.approval!(BASE, req("bash", { command: "ls" }))).toBeUndefined();
  expect(runner.warnings).toEqual([]); expect(warnings).toEqual([]);
  // headless (no human): the chain still fails closed — the set never "answers"
  expect(await runner.approver(undefined)(req("bash", { command: "ls" }))).toBe("deny");
  await runner.close();
  const recs = recordsOf(ff);
  expect(recs.length).toBe(4); // every card recorded, drained as unanswered at session_close (no run, no events)
  expect(recs.map((r) => attrOf(r, "rovecode.decision"))).toEqual(["unanswered", "unanswered", "unanswered", "unanswered"]);
  expect(traces(ff).length).toBe(0);
});

test("correlation in the loop's order: pre_tool → approval → tool_execution_start = allow with the tool span's traceId/spanId + rovecode.call_id (severity 9/INFO, body rovecode.approval, rovecode.session_id from the approval ctx); → tool_call_failed permission_denied = deny (13/WARN); pending at post_run = unanswered (no ids); records POST once per run AFTER traces and metrics", async () => {
  const { set, ff, msgs } = make();
  const c = ctx("r1", "sess-9");
  await set.pre_run!(c);
  await set.on_event!(c, { type: "turn_start", turn: 1 });
  msgs.push({ id: "m-a", role: "assistant", parts: [{ kind: "text", text: "x" }], parentId: null, createdAt: 0, usage: { input: 1, output: 1 }, origin: { provider: "p", model: "m" } });
  await set.on_event!(c, { type: "turn_end", turn: 1, stopReason: "tool_use" });
  await set.pre_tool!(c, { id: "c1", tool: "bash", args: { command: "ls" } });
  await set.approval!(BASE, req("bash", { command: "ls" }));
  await set.on_event!(c, { type: "tool_execution_start", callId: "c1", tool: "bash", args: { command: "ls" } });
  await set.on_event!(c, { type: "tool_execution_end", callId: "c1", ok: true, output: "a b", durationMs: 3 });
  await set.pre_tool!(c, { id: "c2", tool: "write", args: { path: "x" } });
  await set.approval!(BASE, req("write", { path: "x" }));
  await set.on_event!(c, { type: "tool_call_failed", callId: "c2", reason: "permission_denied", detail: "user denied" });
  await set.pre_tool!(c, { id: "c3", tool: "edit", args: { path: "y" } });
  await set.approval!(BASE, req("edit", { path: "y" }));
  await set.post_run!(c, { status: "stopped", summary: "run aborted" }); // c3's card was still up
  await set.flush();
  expect(ff.posts.map((p) => new URL(p.url).pathname)).toEqual(["/v1/traces", "/v1/metrics", LOGS]); // MUTATION TARGET: logs before metrics / per card
  const spans = spansOf(traces(ff)[0]!.body);
  const tool = (id: string) => spans.find((s) => s.name === "rovecode.tool" && s.attributes.some((a) => a.key === "rovecode.call_id" && "stringValue" in a.value && a.value.stringValue === id))!;
  const recs = recordsOf(ff);
  expect(recs.length).toBe(3);
  const [allow, deny, open] = recs as [Rec, Rec, Rec];
  expect(allow.body).toEqual({ stringValue: "rovecode.approval" });
  expect(allow.severityNumber).toBe(9); expect(allow.severityText).toBe("INFO");
  expect(attrOf(allow, "rovecode.tool")).toBe("bash"); expect(attrOf(allow, "rovecode.decision")).toBe("allow");
  expect(attrOf(allow, "rovecode.session_id")).toBe("s1"); // the approval ctx (hooks.base), not the run's
  expect(attrOf(allow, "rovecode.call_id")).toBe("c1");
  expect(allow.traceId).toBe(tool("c1").traceId); expect(allow.spanId).toBe(tool("c1").spanId); // MUTATION TARGET: attach the run span's id instead
  expect(allow.timeUnixNano).toMatch(/^\d{19}$/);
  expect(deny.severityNumber).toBe(13); expect(deny.severityText).toBe("WARN");
  expect(attrOf(deny, "rovecode.tool")).toBe("write"); expect(attrOf(deny, "rovecode.decision")).toBe("deny");
  expect(deny.spanId).toBe(tool("c2").spanId); expect(attrOf(deny, "rovecode.call_id")).toBe("c2");
  expect(attrOf(open, "rovecode.tool")).toBe("edit"); expect(attrOf(open, "rovecode.decision")).toBe("unanswered");
  expect(open.severityNumber).toBe(9);
  expect(open.traceId).toBeUndefined(); expect(open.spanId).toBeUndefined(); expect(attrOf(open, "rovecode.call_id")).toBeUndefined();
  const raw = JSON.stringify(postsTo(ff, LOGS)[0]!.body);
  for (const secret of ['"ls"', "command", "user denied", "permission required", '"path"']) expect(raw).not.toContain(secret); // args / reason / detail never exported
  for (const r of recs) expect(r.attributes.map((a) => a.key).sort()).toEqual(["rovecode.call_id", "rovecode.decision", "rovecode.session_id", "rovecode.tool"].filter((k) => k !== "rovecode.call_id" || attrOf(r, "rovecode.call_id") !== undefined));
  // a second run with no card → no second /v1/logs POST
  await standardRun(set, ctx("r2"), msgs);
  await set.flush();
  expect(postsTo(ff, LOGS).length).toBe(1);
});

test("two same-tool spans awaiting execution when the card fires → the allow record carries NO trace/span/call id (never a guessed id); once the first executed, the second card correlates to the lone remaining span", async () => {
  const { set, ff } = make();
  const c = ctx("r1");
  await set.pre_run!(c);
  await set.pre_tool!(c, { id: "c1", tool: "bash", args: { command: "a" } });
  await set.pre_tool!(c, { id: "c2", tool: "bash", args: { command: "b" } });
  await set.approval!(BASE, req("bash", { command: "a" }));
  await set.on_event!(c, { type: "tool_execution_start", callId: "c1", tool: "bash", args: { command: "a" } });
  await set.approval!(BASE, req("bash", { command: "b" }));
  await set.on_event!(c, { type: "tool_execution_start", callId: "c2", tool: "bash", args: { command: "b" } });
  await set.post_run!(c, { status: "done", summary: "" });
  await set.flush();
  const recs = recordsOf(ff);
  expect(recs.map((r) => attrOf(r, "rovecode.decision"))).toEqual(["allow", "allow"]);
  expect(recs[0]!.traceId).toBeUndefined(); expect(recs[0]!.spanId).toBeUndefined(); expect(attrOf(recs[0]!, "rovecode.call_id")).toBeUndefined(); // MUTATION TARGET: always attach → c1's ids
  const c2 = spansOf(traces(ff)[0]!.body).find((s) => s.attributes.some((a) => a.key === "rovecode.call_id" && "stringValue" in a.value && a.value.stringValue === "c2"))!;
  expect(recs[1]!.spanId).toBe(c2.spanId); expect(attrOf(recs[1]!, "rovecode.call_id")).toBe("c2");
  // a same-tool start whose args differ from the pending card does not answer it (an allow-listed sibling call)
  const m = make();
  const d = ctx("r2");
  await m.set.pre_run!(d);
  await m.set.pre_tool!(d, { id: "p1", tool: "bash", args: { command: "prompted" } });
  await m.set.pre_tool!(d, { id: "p2", tool: "bash", args: { command: "allowlisted" } });
  await m.set.approval!(BASE, req("bash", { command: "prompted" }));
  await m.set.on_event!(d, { type: "tool_execution_start", callId: "p2", tool: "bash", args: { command: "allowlisted" } });
  await m.set.on_event!(d, { type: "tool_call_failed", callId: "p1", reason: "permission_denied", detail: "user denied" });
  await m.set.post_run!(d, { status: "done", summary: "" });
  await m.set.flush();
  const r2 = recordsOf(m.ff);
  expect(r2.map((r) => attrOf(r, "rovecode.decision"))).toEqual(["deny"]); // p2's start did not count as p1's allow
  expect(attrOf(r2[0]!, "rovecode.call_id")).toBe("p1");
});

test("a lane start (`task start {agent:\"codex\"}` after lanes/approval.ts rewrote the card): the record carries rovecode.lane = codex, and neither the card text, the goal, the reason nor revisedArgs appear anywhere in the payload; a plain child start has no rovecode.lane", async () => {
  const { set, ff } = make({ isLane: (a: unknown): a is string => a === "codex" }); // the runtime injects lanes/types.ts isAdapterId; the default tags nothing
  const c = ctx("r1");
  await set.pre_run!(c);
  const args = { action: "start", agent: "codex", goal: "write vitest cases for requireAuth", label: "codex lane" };
  await set.pre_tool!(c, { id: "t1", tool: "task", args });
  await set.approval!(BASE, { tool: "task", args, revisedArgs: { lane: CARD, ...args }, reason: CARD }); // the laneApprover shape (lanes-wiring.test.ts)
  await set.post_tool!(c, { id: "t1", tool: "task", args }, { ok: true, output: `task t1 (codex lane) started: queued. External codex lane — permissions: ${CARD}` });
  await set.on_event!(c, { type: "tool_execution_start", callId: "t1", tool: "task", args }); // the buffered event arrives after post_tool on the real loop
  await set.on_event!(c, { type: "tool_execution_end", callId: "t1", ok: true, output: "started", durationMs: 1 });
  const child = { action: "start", agent: "worker", goal: "child goal" };
  await set.pre_tool!(c, { id: "t2", tool: "task", args: child });
  await set.approval!(BASE, { tool: "task", args: child, revisedArgs: child, reason: "permission required for spawn task" });
  await set.post_tool!(c, { id: "t2", tool: "task", args: child }, { ok: true, output: "started" });
  await set.post_run!(c, { status: "done", summary: "" });
  await set.flush();
  const recs = recordsOf(ff);
  expect(recs.length).toBe(2); // exactly ONE record per card even though post_tool AND tool_execution_start both signalled t1
  expect(attrOf(recs[0]!, "rovecode.lane")).toBe("codex"); // MUTATION TARGET: drop the isAdapterId(revisedArgs.agent) attr
  expect(attrOf(recs[0]!, "rovecode.decision")).toBe("allow"); expect(attrOf(recs[0]!, "rovecode.tool")).toBe("task"); expect(attrOf(recs[0]!, "rovecode.call_id")).toBe("t1");
  expect(attrOf(recs[1]!, "rovecode.lane")).toBeUndefined();
  expect(attrOf(recs[1]!, "rovecode.decision")).toBe("allow");
  const raw = JSON.stringify(postsTo(ff, LOGS)[0]!.body);
  for (const secret of [CARD, "sandbox", "worktree", "write vitest", "requireAuth", "codex lane", "permission required", "child goal", "worker"]) expect(raw).not.toContain(secret);
  expect(raw).not.toContain(ENDPOINT);
});

test("no cards → no /v1/logs POST (standardRun POSTs traces + metrics only); a card outside any run (bare dispatch, no runId) is still recorded and drained at session_close as unanswered", async () => {
  const { set, ff, msgs } = make();
  await standardRun(set, ctx("r1"), msgs);
  await set.flush();
  expect(postsTo(ff, LOGS).length).toBe(0); // MUTATION TARGET: POST an empty logs request per run
  await set.approval!(BASE, req("bash", { command: "ls" }));
  await set.session_close!(ctx("r1"));
  const recs = recordsOf(ff);
  expect(recs.length).toBe(1);
  expect(attrOf(recs[0]!, "rovecode.decision")).toBe("unanswered");
  expect(attrOf(recs[0]!, "rovecode.session_id")).toBe("s1");
});
