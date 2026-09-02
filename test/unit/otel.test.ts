/** PORT #39 OTel exporter unit tests: a scripted sequence of hook calls (pre_run, on_event turn/tool/
 *  compaction events, pre_tool/post_tool, post_run — in the loop's REAL order: turn_end before the
 *  turn's tools, tool events buffered after pre/post_tool) against a fake fetch → the OTLP/HTTP JSON is
 *  decoded and pinned: envelope, span tree by parentSpanId, id/time well-formedness, attribute schema,
 *  statuses, one trace per run, endpoint/header parsing, failure → warning (never a throw), flush. */

import { test, expect } from "bun:test";
import {
  createOtelHooks, otelOptionsFromEnv, parseOtelHeaders, normalizeEndpoint, unixNano, otelDebug, DEFAULT_EXPORT_TIMEOUT_MS,
  type OtelHooks, type OtlpTraceRequest, type OtlpSpan, type PricingSource,
} from "../../src/telemetry/otel.ts";
import { HookRunner, type HookCtx } from "../../src/core/hooks.ts";
import { costUsd } from "../../src/core/usage.ts";
import type { Message } from "../../src/core/types.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** house hazard: an awaited promise with no pending timer hangs the runner forever */
const deadline = <T>(p: Promise<T>, ms: number) => Promise.race([p, sleep(ms).then(() => "DEADLINE" as const)]);
const ctx = (runId: string, sessionId = "s1"): HookCtx => ({ cwd: "/w", sessionId, runId });
const call = { id: "c1", tool: "probe", args: { q: 1 } };
const ENDPOINT = "http://collector:4318";
const URL_ = `${ENDPOINT}/v1/traces`;

interface Posted { url: string; headers: Record<string, string>; body: OtlpTraceRequest }
/** records every POST; `respond(n)` decides the n-th call's outcome */
function fakeFetch(respond: (n: number) => Response | Promise<Response> = () => new Response("{}", { status: 200 })) {
  const posts: Posted[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => { headers[k] = v; });
    posts.push({ url: String(input), headers, body: JSON.parse(String(init?.body)) as OtlpTraceRequest });
    return respond(posts.length);
  }) as unknown as typeof fetch;
  return { fn, posts };
}
/** +1ms per reading, so every span/event time is distinct and ordered */
const clock = (start = 1_700_000_000_000) => { let t = start; return () => (t += 1); };
let seq = 0;
const assistant = (usage: Message["usage"], origin?: Message["origin"]): Message =>
  ({ id: `m${++seq}`, role: "assistant", parts: [{ kind: "text", text: "x" }], parentId: null, createdAt: 0, ...(usage ? { usage } : {}), ...(origin ? { origin } : {}) });
const flat: PricingSource = { lookup: () => ({ pricing: { inputPerMTok: 1, outputPerMTok: 10, cacheReadPerMTok: 0.1, cacheWritePerMTok: 2 } }) };
const PM = { provider: "p", model: "m" };
function make(over: Partial<Parameters<typeof createOtelHooks>[0]> = {}) {
  const ff = fakeFetch(); const msgs: Message[] = []; const warnings: string[] = [];
  const set = createOtelHooks({ endpoint: ENDPOINT, fetch: ff.fn, now: clock(), messages: () => msgs, pricing: flat, onWarning: (w) => warnings.push(w), ...over });
  return { set, ff, msgs, warnings };
}
const spansOf = (req: OtlpTraceRequest): OtlpSpan[] => req.resourceSpans[0]!.scopeSpans[0]!.spans;
const attr = (s: OtlpSpan, key: string): unknown => { const a = s.attributes.find((x) => x.key === key); return a ? Object.values(a.value)[0] : undefined; };
const named = (spans: OtlpSpan[], name: string) => spans.filter((s) => s.name === name);

/** the loop's order for: turn 1 (tool call) → tool runs → turn 2 (text) → done */
async function standardRun(set: OtelHooks, c: HookCtx, msgs: Message[], toolOk = true): Promise<void> {
  await set.on_event!(c, { type: "run_start", runId: c.runId!, sessionId: c.sessionId, goal: "g" }); // observer taps on_event before pre_run
  await set.pre_run!(c);
  await set.on_event!(c, { type: "turn_start", turn: 1 });
  msgs.push(assistant({ input: 100, output: 10, cacheRead: 5, cacheWrite: 2 }, PM));
  await set.on_event!(c, { type: "turn_end", turn: 1, stopReason: "tool_use" });
  await set.pre_tool!(c, call);
  await set.post_tool!(c, call, { ok: toolOk, output: "héllo" }); // 6 utf-8 bytes
  await set.on_event!(c, { type: "tool_execution_start", callId: "c1", tool: "probe", args: call.args });
  await set.on_event!(c, { type: "tool_execution_end", callId: "c1", ok: toolOk, output: "héllo", durationMs: 7 });
  await set.on_event!(c, { type: "turn_start", turn: 2 });
  msgs.push(assistant({ input: 50, output: 5 }, PM));
  await set.on_event!(c, { type: "turn_end", turn: 2, stopReason: "end_turn" });
  await set.on_event!(c, { type: "run_end", status: "done", summary: "final" });
  await set.post_run!(c, { status: "done", summary: "final" });
}
async function minimalRun(set: OtelHooks, c: HookCtx, status: "done" | "stopped" | "error" | "budget" = "done"): Promise<void> {
  await set.pre_run!(c);
  await set.post_run!(c, { status, summary: "" });
}

// ---------- envelope + tree + ids ----------

test("one run → one POST: one resourceSpans/scopeSpans with service.name aion; tree run→turn→tool by parentSpanId (the tool hangs off the turn that ISSUED it); 32/16-hex ids sharing one traceId; kind INTERNAL; OTLP/JSON value encodings", async () => {
  const { set, ff, msgs, warnings } = make();
  await standardRun(set, ctx("r1"), msgs);
  await set.flush();
  expect(warnings).toEqual([]);
  expect(ff.posts.length).toBe(1);
  expect(ff.posts[0]!.url).toBe(URL_);
  const req = ff.posts[0]!.body;
  expect(req.resourceSpans.length).toBe(1);
  expect(req.resourceSpans[0]!.scopeSpans.length).toBe(1);
  expect(req.resourceSpans[0]!.resource.attributes).toContainEqual({ key: "service.name", value: { stringValue: "aion" } });
  expect(req.resourceSpans[0]!.scopeSpans[0]!.scope.name).toBe("aion");
  const spans = spansOf(req);
  expect(spans.map((s) => s.name)).toEqual(["aion.run", "aion.turn", "aion.tool", "aion.turn"]); // start order
  const [run, t1, tool, t2] = spans as [OtlpSpan, OtlpSpan, OtlpSpan, OtlpSpan];
  expect(run.parentSpanId).toBeUndefined();
  expect(t1.parentSpanId).toBe(run.spanId);
  expect(t2.parentSpanId).toBe(run.spanId);
  expect(tool.parentSpanId).toBe(t1.spanId);
  for (const s of spans) {
    expect(s.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(s.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(s.traceId).toBe(run.traceId);
    expect(s.kind).toBe(1);
  }
  expect(new Set(spans.map((s) => s.spanId)).size).toBe(4);
  // encodings: int64 as decimal strings, doubles as numbers, bools, strings
  expect(run.attributes.find((a) => a.key === "aion.tokens.input")!.value).toEqual({ intValue: "150" });
  expect(run.attributes.find((a) => a.key === "aion.cost_usd")!.value).toEqual({ doubleValue: expect.any(Number) });
  expect(tool.attributes.find((a) => a.key === "aion.ok")!.value).toEqual({ boolValue: true });
  expect(run.attributes.find((a) => a.key === "aion.status")!.value).toEqual({ stringValue: "done" });
  // the module never wrote the goal, the args or the tool output anywhere in the payload
  const raw = JSON.stringify(req);
  for (const secret of ['"g"', "héllo", '"q"']) expect(raw).not.toContain(secret);
});

test("times: unix-nano decimal strings from the injected clock (fractions kept, no float rounding), end ≥ start on every span, every child inside the run, turn/tool ordered by the clock; the default clock is wall time", async () => {
  expect(unixNano(1_700_000_000_000.25)).toBe("1700000000000250000");
  expect(unixNano(0)).toBe("0");
  expect(unixNano(1.9999999)).toBe("2000000");
  const { set, ff, msgs } = make();
  await standardRun(set, ctx("r1"), msgs);
  await set.flush();
  const spans = spansOf(ff.posts[0]!.body);
  const run = spans[0]!;
  expect(run.startTimeUnixNano).toBe("1700000000001000000"); // the clock's first reading, at pre_run
  for (const s of spans) {
    expect(s.startTimeUnixNano).toMatch(/^\d{19}$/); expect(s.endTimeUnixNano).toMatch(/^\d{19}$/);
    expect(BigInt(s.endTimeUnixNano) >= BigInt(s.startTimeUnixNano)).toBe(true);
    expect(BigInt(s.startTimeUnixNano) >= BigInt(run.startTimeUnixNano)).toBe(true);
    expect(BigInt(s.endTimeUnixNano) <= BigInt(run.endTimeUnixNano)).toBe(true);
  }
  const [, t1, tool, t2] = spans as [OtlpSpan, OtlpSpan, OtlpSpan, OtlpSpan];
  expect(BigInt(t1.endTimeUnixNano) > BigInt(t1.startTimeUnixNano)).toBe(true);
  expect(BigInt(tool.startTimeUnixNano) > BigInt(t1.endTimeUnixNano)).toBe(true); // tools run after their turn ended (loop order)
  expect(BigInt(t2.startTimeUnixNano) > BigInt(tool.endTimeUnixNano)).toBe(true);
  // default clock: wall time in ns, within a minute of Date.now()
  const real = make({ now: undefined });
  const before = Date.now();
  await minimalRun(real.set, ctx("w"));
  await real.set.flush();
  const r = spansOf(real.ff.posts[0]!.body)[0]!;
  const startMs = Number(BigInt(r.startTimeUnixNano) / 1_000_000n);
  expect(Math.abs(startMs - before)).toBeLessThan(60_000);
  expect(BigInt(r.endTimeUnixNano) >= BigInt(r.startTimeUnixNano)).toBe(true);
});

// ---------- attribute schema ----------

test("attributes: run = status/session_id/run_id/turns/tool_calls/tokens summed over THIS run's assistant messages/cost priced per message/served model; turn = index/stop_reason/its own tokens+cost+model; tool = tool/call_id/ok/duration_ms (from tool_execution_end)/output_bytes; all statuses OK", async () => {
  const { set, ff, msgs } = make();
  msgs.push(assistant({ input: 999, output: 999 }, PM)); // BEFORE the run: never counted
  await standardRun(set, ctx("run-7", "sess-9"), msgs);
  await set.flush();
  const spans = spansOf(ff.posts[0]!.body);
  const [run, t1, tool, t2] = spans as [OtlpSpan, OtlpSpan, OtlpSpan, OtlpSpan];
  const pick = (s: OtlpSpan, keys: string[]) => Object.fromEntries(keys.map((k) => [k, attr(s, k)]));
  expect(pick(run, ["aion.status", "aion.session_id", "aion.run_id", "aion.turns", "aion.tool_calls", "aion.tokens.input", "aion.tokens.output", "aion.tokens.cacheRead", "aion.tokens.cacheWrite", "aion.model.provider", "aion.model.model"])).toEqual({
    "aion.status": "done", "aion.session_id": "sess-9", "aion.run_id": "run-7", "aion.turns": "2", "aion.tool_calls": "1",
    "aion.tokens.input": "150", "aion.tokens.output": "15", "aion.tokens.cacheRead": "5", "aion.tokens.cacheWrite": "2",
    "aion.model.provider": "p", "aion.model.model": "m",
  });
  const row = flat.lookup("p", "m")!.pricing!;
  expect(attr(run, "aion.cost_usd") as number).toBeCloseTo(costUsd({ input: 150, output: 15, cacheRead: 5, cacheWrite: 2 }, row)!, 12);
  expect(pick(t1, ["aion.turn", "aion.stop_reason", "aion.tokens.input", "aion.tokens.output", "aion.tokens.cacheRead", "aion.tokens.cacheWrite", "aion.model.provider"]))
    .toEqual({ "aion.turn": "1", "aion.stop_reason": "tool_use", "aion.tokens.input": "100", "aion.tokens.output": "10", "aion.tokens.cacheRead": "5", "aion.tokens.cacheWrite": "2", "aion.model.provider": "p" });
  expect(attr(t1, "aion.cost_usd") as number).toBeCloseTo(costUsd({ input: 100, output: 10, cacheRead: 5, cacheWrite: 2 }, row)!, 12);
  expect(pick(t2, ["aion.turn", "aion.stop_reason", "aion.tokens.input", "aion.tokens.output", "aion.tokens.cacheRead", "aion.tokens.cacheWrite"]))
    .toEqual({ "aion.turn": "2", "aion.stop_reason": "end_turn", "aion.tokens.input": "50", "aion.tokens.output": "5", "aion.tokens.cacheRead": "0", "aion.tokens.cacheWrite": "0" });
  expect(pick(tool, ["aion.tool", "aion.call_id", "aion.ok", "aion.duration_ms", "aion.output_bytes"]))
    .toEqual({ "aion.tool": "probe", "aion.call_id": "c1", "aion.ok": true, "aion.duration_ms": "7", "aion.output_bytes": "6" });
  for (const s of spans) expect(s.status).toEqual({ code: 1 });
  expect(tool.events).toBeUndefined(); // no events → field omitted
});

test("outcomes: a failed tool → ERROR + ok false; a hook-denied call (tool_call_failed after pre_tool) → ERROR with the reason; a call that never reached pre_tool → an aion.tool_call_failed EVENT on the issuing turn; compaction → an aion.compaction event; an 'error' turn and an 'error'/'budget' run are ERROR, 'stopped' is OK; a guard-stubbed call (events only) still gets a span", async () => {
  const { set, ff, msgs } = make();
  const c = ctx("r1");
  await set.pre_run!(c);
  await set.on_event!(c, { type: "turn_start", turn: 1 });
  await set.on_event!(c, { type: "compaction", strategy: "keep-window", trigger: "speculative", tokensBefore: 900, tokensAfter: 300 });
  msgs.push(assistant({ input: 1, output: 1 }, PM));
  await set.on_event!(c, { type: "turn_end", turn: 1, stopReason: "tool_use" });
  await set.pre_tool!(c, { id: "c1", tool: "probe", args: {} });
  await set.post_tool!(c, { id: "c1", tool: "probe", args: {} }, { ok: false, output: "boom" });
  await set.on_event!(c, { type: "tool_execution_end", callId: "c1", ok: false, output: "boom", durationMs: 3 });
  await set.pre_tool!(c, { id: "c2", tool: "bash", args: {} }); // a hook denies it → no post_tool, a buffered tool_call_failed
  await set.on_event!(c, { type: "tool_call_failed", callId: "c2", reason: "permission_denied", detail: "hook says no" });
  await set.on_event!(c, { type: "tool_call_failed", callId: "c3", reason: "not_found", detail: "unknown tool" }); // never reached pre_tool
  await set.on_event!(c, { type: "tool_execution_start", callId: "c4", tool: "probe", args: {} }); // loop-guard stub path
  await set.on_event!(c, { type: "tool_execution_end", callId: "c4", ok: false, output: "stubbed", durationMs: 0 });
  await set.on_event!(c, { type: "turn_start", turn: 2 });
  msgs.push(assistant({ input: 1, output: 0 }, PM));
  await set.on_event!(c, { type: "turn_end", turn: 2, stopReason: "error" });
  await set.post_run!(c, { status: "error", summary: "error: provider stream failed" });
  await set.flush();
  const spans = spansOf(ff.posts[0]!.body);
  expect(spans.map((s) => s.name)).toEqual(["aion.run", "aion.turn", "aion.tool", "aion.tool", "aion.tool", "aion.turn"]);
  const [run, t1, c1, c2, c4, t2] = spans as [OtlpSpan, OtlpSpan, OtlpSpan, OtlpSpan, OtlpSpan, OtlpSpan];
  expect(c1.status).toEqual({ code: 2, message: "tool probe failed" });
  expect(attr(c1, "aion.ok")).toBe(false); expect(attr(c1, "aion.duration_ms")).toBe("3");
  expect(c2.status).toEqual({ code: 2, message: "permission_denied" });
  expect(attr(c2, "aion.ok")).toBe(false); expect(attr(c2, "aion.failure_reason")).toBe("permission_denied"); expect(attr(c2, "aion.tool")).toBe("bash");
  expect(c4.parentSpanId).toBe(t1.spanId); expect(attr(c4, "aion.tool")).toBe("probe"); expect(attr(c4, "aion.ok")).toBe(false); expect(attr(c4, "aion.duration_ms")).toBe("0");
  for (const s of [c1, c2, c4]) expect(s.parentSpanId).toBe(t1.spanId);
  expect(t1.events!.map((e) => e.name)).toEqual(["aion.compaction", "aion.tool_call_failed"]);
  expect(t1.events![0]!.attributes).toEqual([
    { key: "aion.compaction.strategy", value: { stringValue: "keep-window" } }, { key: "aion.compaction.trigger", value: { stringValue: "speculative" } },
    { key: "aion.compaction.tokens_before", value: { intValue: "900" } }, { key: "aion.compaction.tokens_after", value: { intValue: "300" } },
  ]);
  expect(t1.events![1]!.attributes).toEqual([{ key: "aion.call_id", value: { stringValue: "c3" } }, { key: "aion.failure_reason", value: { stringValue: "not_found" } }]);
  for (const e of t1.events!) expect(e.timeUnixNano).toMatch(/^\d{19}$/);
  expect(t2.status).toEqual({ code: 2, message: "error" });
  expect(run.status).toEqual({ code: 2, message: "error" });
  expect(attr(run, "aion.status")).toBe("error"); expect(attr(run, "aion.tool_calls")).toBe("3"); expect(attr(run, "aion.turns")).toBe("2");
  // run-level status mapping: done/stopped → OK, budget → ERROR
  const m2 = make();
  await minimalRun(m2.set, ctx("a"), "stopped"); await minimalRun(m2.set, ctx("b"), "budget"); await minimalRun(m2.set, ctx("d"), "done");
  await m2.set.flush();
  expect(m2.ff.posts.map((p) => spansOf(p.body)[0]!.status)).toEqual([{ code: 1 }, { code: 2, message: "budget" }, { code: 1 }]);
  // unfinished turn + tool at post_run: closed at the run's end, status UNSET; a tool with no turn parents to the run
  const m3 = make();
  const c3 = ctx("u");
  await m3.set.pre_run!(c3);
  await m3.set.pre_tool!(c3, call); // before any turn (bare dispatch shape)
  await m3.set.on_event!(c3, { type: "turn_start", turn: 1 });
  await m3.set.post_run!(c3, { status: "stopped", summary: "run aborted" });
  await m3.set.flush();
  const [r3, tool3, turn3] = spansOf(m3.ff.posts[0]!.body) as [OtlpSpan, OtlpSpan, OtlpSpan];
  expect(tool3.parentSpanId).toBe(r3.spanId);
  for (const s of [tool3, turn3]) { expect(s.status).toEqual({ code: 0 }); expect(s.endTimeUnixNano).toBe(r3.endTimeUnixNano); }
});

test("cost: omitted (never 0, never a lower bound) when any usage-bearing message lacks pricing — unknown provider under the default catalog, a partially-priced run, or no origin; tokens still summed; an all-zero-usage run prices at 0", async () => {
  const dflt = make({ pricing: undefined }); // lazy ModelCatalog: knows no provider "p"
  await standardRun(dflt.set, ctx("r1"), dflt.msgs);
  await dflt.set.flush();
  const run = spansOf(dflt.ff.posts[0]!.body)[0]!;
  expect(attr(run, "aion.cost_usd")).toBeUndefined();
  expect(attr(run, "aion.tokens.input")).toBe("150");
  const onlyP2: PricingSource = { lookup: (prov) => prov === "p2" ? { pricing: { inputPerMTok: 1, outputPerMTok: 1 } } : undefined };
  const part = make({ pricing: onlyP2 });
  const c = ctx("r2");
  await part.set.pre_run!(c);
  await part.set.on_event!(c, { type: "turn_start", turn: 1 });
  part.msgs.push(assistant({ input: 10, output: 1 }, { provider: "p2", model: "m" }));
  await part.set.on_event!(c, { type: "turn_end", turn: 1, stopReason: "tool_use" });
  await part.set.on_event!(c, { type: "turn_start", turn: 2 });
  part.msgs.push(assistant({ input: 10, output: 1 }, PM)); // unpriced
  await part.set.on_event!(c, { type: "turn_end", turn: 2, stopReason: "end_turn" });
  await part.set.post_run!(c, { status: "done", summary: "" });
  await part.set.flush();
  const [r2, t1, t2] = spansOf(part.ff.posts[0]!.body) as [OtlpSpan, OtlpSpan, OtlpSpan];
  expect(attr(r2, "aion.cost_usd")).toBeUndefined(); // one unpriced message → the run's cost is unknown
  expect(attr(t1, "aion.cost_usd") as number).toBeCloseTo(11 / 1_000_000, 12); // the priced turn still carries its own
  expect(attr(t2, "aion.cost_usd")).toBeUndefined();
  expect(attr(r2, "aion.tokens.input")).toBe("20");
  const noOrigin = make();
  const c3 = ctx("r3");
  await noOrigin.set.pre_run!(c3);
  noOrigin.msgs.push(assistant({ input: 5, output: 5 })); // usage, no origin → unpriceable
  await noOrigin.set.post_run!(c3, { status: "done", summary: "" });
  const zero = make();
  const c4 = ctx("r4");
  await zero.set.pre_run!(c4);
  zero.msgs.push(assistant({ input: 0, output: 0 }, PM));
  await zero.set.post_run!(c4, { status: "done", summary: "" });
  await noOrigin.set.flush(); await zero.set.flush();
  expect(attr(spansOf(noOrigin.ff.posts[0]!.body)[0]!, "aion.cost_usd")).toBeUndefined();
  expect(attr(spansOf(zero.ff.posts[0]!.body)[0]!, "aion.cost_usd")).toBe(0);
  expect(attr(spansOf(zero.ff.posts[0]!.body)[0]!, "aion.model.provider")).toBe("p");
});

// ---------- one trace per run ----------

test("one trace per run: two sequential runs → two POSTs with distinct traceIds and disjoint spanIds; two INTERLEAVED runs (distinct runIds on one set) keep separate trees and traces", async () => {
  const { set, ff, msgs } = make();
  await standardRun(set, ctx("r1"), msgs);
  await standardRun(set, ctx("r2"), msgs);
  await set.flush();
  expect(ff.posts.length).toBe(2);
  const a = spansOf(ff.posts[0]!.body), b = spansOf(ff.posts[1]!.body);
  expect(a[0]!.traceId).not.toBe(b[0]!.traceId);
  expect(new Set([...a, ...b].map((s) => s.spanId)).size).toBe(a.length + b.length);
  expect(attr(a[0]!, "aion.run_id")).toBe("r1"); expect(attr(b[0]!, "aion.run_id")).toBe("r2");
  expect(attr(b[0]!, "aion.tokens.input")).toBe("150"); // the second run counts only ITS messages
  // interleaved
  const m = make();
  const x = ctx("x"), y = ctx("y");
  await m.set.pre_run!(x); await m.set.pre_run!(y);
  await m.set.on_event!(x, { type: "turn_start", turn: 1 }); await m.set.on_event!(y, { type: "turn_start", turn: 1 });
  await m.set.pre_tool!(y, call);
  await m.set.on_event!(y, { type: "turn_end", turn: 1, stopReason: "end_turn" }); await m.set.on_event!(x, { type: "turn_end", turn: 1, stopReason: "end_turn" });
  await m.set.post_run!(y, { status: "done", summary: "" }); await m.set.post_run!(x, { status: "done", summary: "" });
  await m.set.flush();
  const py = spansOf(m.ff.posts[0]!.body), px = spansOf(m.ff.posts[1]!.body);
  expect(attr(py[0]!, "aion.run_id")).toBe("y"); expect(py.map((s) => s.name)).toEqual(["aion.run", "aion.turn", "aion.tool"]);
  expect(attr(px[0]!, "aion.run_id")).toBe("x"); expect(px.map((s) => s.name)).toEqual(["aion.run", "aion.turn"]);
  for (const s of py) expect(s.traceId).toBe(py[0]!.traceId);
  for (const s of px) expect(s.traceId).toBe(px[0]!.traceId);
  expect(px[0]!.traceId).not.toBe(py[0]!.traceId);
  // events for an unknown run (no pre_run) are ignored, never a throw
  await m.set.on_event!(ctx("ghost"), { type: "turn_start", turn: 1 });
  await m.set.post_run!(ctx("ghost"), { status: "done", summary: "" });
  await m.set.pre_tool!({ cwd: "/w", sessionId: "s" }, call); // bare dispatch: no runId
  await m.set.flush();
  expect(m.ff.posts.length).toBe(2);
});

// ---------- endpoint / headers / env ----------

test("endpoint + headers: base URL, trailing slashes and a full …/v1/traces URL all POST to <base>/v1/traces; AION_OTEL_HEADERS 'k=v,k2=v2' parses on the FIRST '=' (values keep later '='), blanks skipped, and rides every POST beside content-type application/json; otelOptionsFromEnv is null without an endpoint", async () => {
  expect(normalizeEndpoint("http://h:4318")).toBe("http://h:4318/v1/traces");
  expect(normalizeEndpoint(" http://h:4318// ")).toBe("http://h:4318/v1/traces");
  expect(normalizeEndpoint("http://h:4318/v1/traces")).toBe("http://h:4318/v1/traces");
  expect(normalizeEndpoint("http://h:4318/v1/traces/")).toBe("http://h:4318/v1/traces");
  expect(normalizeEndpoint("https://otlp.example.com/api/otlp")).toBe("https://otlp.example.com/api/otlp/v1/traces");
  for (const ep of ["http://h:4318", "http://h:4318/", "http://h:4318/v1/traces"]) {
    const m = make({ endpoint: ep });
    await minimalRun(m.set, ctx("r"));
    await m.set.flush();
    expect(m.ff.posts[0]!.url).toBe("http://h:4318/v1/traces");
  }
  expect(parseOtelHeaders("authorization=Bearer a=b, x-team = aion ,,junk,=novalue")).toEqual({ authorization: "Bearer a=b", "x-team": "aion" });
  expect(parseOtelHeaders(undefined)).toEqual({});
  expect(parseOtelHeaders("")).toEqual({});
  const m = make({ headers: parseOtelHeaders("authorization=Bearer a=b,x-team=aion") });
  await minimalRun(m.set, ctx("r"));
  await m.set.flush();
  expect(m.ff.posts[0]!.headers).toEqual({ authorization: "Bearer a=b", "x-team": "aion", "content-type": "application/json" });
  expect(otelOptionsFromEnv({})).toBeNull();
  expect(otelOptionsFromEnv({ AION_OTEL_ENDPOINT: "   " })).toBeNull();
  expect(otelOptionsFromEnv({ AION_OTEL_ENDPOINT: " http://h:4318 ", AION_OTEL_HEADERS: "a=1" })).toEqual({ endpoint: "http://h:4318", headers: { a: "1" } });
  expect(otelOptionsFromEnv({ AION_OTEL_ENDPOINT: "http://h:4318" })).toEqual({ endpoint: "http://h:4318", headers: {} });
});

// ---------- failures / flush ----------

test("export failure → one warning per failed export via onWarning, the hooks never throw, flush resolves: a rejected fetch, an HTTP 500, and a hung fetch (timeout on a ref'd timer; the request is aborted); post_run returns before the POST settles", async () => {
  const rej = fakeFetch(() => Promise.reject(new Error("ECONNREFUSED")));
  const a = make({ fetch: rej.fn });
  await minimalRun(a.set, ctx("r"));
  await expect(deadline(a.set.flush(), 3000)).resolves.toBeUndefined();
  expect(a.warnings).toEqual([`OTLP export to ${URL_} failed: ECONNREFUSED`]);
  const five = fakeFetch(() => new Response("nope", { status: 500 }));
  const b = make({ fetch: five.fn });
  await minimalRun(b.set, ctx("r"));
  await b.set.flush();
  expect(b.warnings).toEqual([`OTLP export to ${URL_} failed: HTTP 500`]);
  let aborted = false;
  const hang = ((_u: unknown, init?: RequestInit) => new Promise<Response>((_, reject) => { init?.signal?.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); }); })) as unknown as typeof fetch;
  const c = make({ fetch: hang, timeoutMs: 60 });
  const t0 = Date.now();
  await expect(deadline(Promise.resolve(minimalRun(c.set, ctx("r"))), 500)).resolves.toBeUndefined(); // post_run did not wait for the POST
  expect(c.warnings).toEqual([]); // nothing settled yet
  await expect(deadline(c.set.flush(), 3000)).resolves.toBeUndefined();
  expect(Date.now() - t0).toBeGreaterThanOrEqual(55);
  expect(c.warnings).toEqual([`OTLP export to ${URL_} failed: timed out after 60ms`]);
  expect(aborted).toBe(true);
  expect(DEFAULT_EXPORT_TIMEOUT_MS).toBe(5000);
  // a fetch that ignores the signal entirely still settles at the timeout (the race does not depend on it)
  const deaf = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;
  const d = make({ fetch: deaf, timeoutMs: 40 });
  await minimalRun(d.set, ctx("r"));
  await expect(deadline(d.set.flush(), 3000)).resolves.toBeUndefined();
  expect(d.warnings).toEqual([`OTLP export to ${URL_} failed: timed out after 40ms`]);
});

test("flush() awaits in-flight posts and session_close flushes: with the response held back, flush stays pending until it is released; a second run posted mid-flush is awaited too", async () => {
  let release: (() => void)[] = [];
  const held = fakeFetch(() => new Promise<Response>((r) => { release.push(() => r(new Response("{}"))); }));
  const { set, warnings } = make({ fetch: held.fn });
  await minimalRun(set, ctx("r1"));
  expect(held.posts.length).toBe(1);
  const f = set.flush().then(() => "flushed" as const);
  expect(await deadline(f, 120)).toBe("DEADLINE"); // still waiting on the POST
  await minimalRun(set, ctx("r2")); // a second export while the first flush waits
  release[0]!();
  expect(await deadline(f, 120)).toBe("DEADLINE"); // the second post is now outstanding too
  release[1]!();
  expect(await deadline(f, 3000)).toBe("flushed");
  // session_close flushes as well
  release = [];
  await minimalRun(set, ctx("r3"));
  const closing = Promise.resolve(set.session_close!(ctx("r3"))).then(() => "closed" as const);
  expect(await deadline(closing, 120)).toBe("DEADLINE");
  release[0]!();
  expect(await deadline(closing, 3000)).toBe("closed");
  expect(warnings).toEqual([]);
  expect(held.posts.length).toBe(3);
});

test("through a HookRunner without onWarning: an export failure is raised from the NEXT lifecycle hook — session_close (one-shot run) or the following pre_run — and lands as ONE bounded runner warning; the failing run itself saw nothing; the next run is still exported", async () => {
  const first = fakeFetch((n) => n === 1 ? Promise.reject(new Error("ECONNREFUSED")) : new Response("{}"));
  const msgs: Message[] = [];
  const runner = new HookRunner({ cwd: "/w", sessionId: "s1" }, { timeoutMs: 2000 });
  const set = createOtelHooks({ endpoint: ENDPOINT, fetch: first.fn, messages: () => msgs, pricing: flat });
  runner.add(set, "otel");
  expect(runner.has("on_event")).toBe(true);
  const obs = runner.observer({ cwd: "/w", sessionId: "s1" });
  const drive = async (runId: string) => {
    await obs.observe({ type: "run_start", runId, sessionId: "s1", goal: "g" });
    await obs.observe({ type: "turn_start", turn: 1 });
    await obs.observe({ type: "turn_end", turn: 1, stopReason: "end_turn" });
    await obs.observe({ type: "run_end", status: "done", summary: "ok" });
  };
  await drive("R1");
  expect(runner.warnings).toEqual([]); // post_run returned; the failure is still in flight
  await set.flush();
  expect(runner.warnings).toEqual([]); // recorded, not yet raised (no lifecycle hook ran)
  await drive("R2"); // pre_run raises the deferred note, then still records the run
  expect(runner.warnings).toEqual([`otel: pre_run hook threw: OTLP export to ${URL_} failed: ECONNREFUSED — ignored, run continues`]);
  await runner.close(); // flush + nothing left to raise
  expect(runner.warnings.length).toBe(1);
  expect(first.posts.length).toBe(2);
  expect(spansOf(first.posts[1]!.body).map((s) => s.name)).toEqual(["aion.run", "aion.turn"]);
  // one-shot shape: the failure is raised at session_close; failures that settle before any lifecycle
  // hook runs (two posts held open, both refused after run b began) collapse into ONE note
  const refuse: (() => void)[] = [];
  const held = fakeFetch(() => new Promise<Response>((_, reject) => { refuse.push(() => reject(new Error("ECONNREFUSED"))); }));
  const runner2 = new HookRunner({ cwd: "/w", sessionId: "s2" }, { timeoutMs: 2000 });
  const set2 = createOtelHooks({ endpoint: ENDPOINT, fetch: held.fn, messages: () => msgs });
  runner2.add(set2, "otel");
  await runner2.run("pre_run", ctx("a", "s2")); await runner2.run("post_run", ctx("a", "s2"), { status: "done", summary: "" });
  await runner2.run("pre_run", ctx("b", "s2")); await runner2.run("post_run", ctx("b", "s2"), { status: "done", summary: "" });
  expect(refuse.length).toBe(2);
  for (const f of refuse) f();
  await set2.flush();
  expect(runner2.warnings).toEqual([]); // recorded, awaiting the next lifecycle hook
  await runner2.close();
  expect(runner2.warnings).toEqual([`otel: session_close hook threw: OTLP export to ${URL_} failed: ECONNREFUSED (2 exports failed) — ignored, run continues`]);
  await runner2.close(); // idempotent: nothing left to raise
  expect(runner2.warnings.length).toBe(1);
});

test("otelDebug.constructed counts constructions (the off-path spy); the set exposes exactly the hooks it needs plus flush", () => {
  const before = otelDebug.constructed;
  const { set } = make();
  expect(otelDebug.constructed).toBe(before + 1);
  expect(Object.keys(set).sort()).toEqual(["flush", "on_event", "post_run", "post_tool", "pre_run", "pre_tool", "session_close"]);
});
