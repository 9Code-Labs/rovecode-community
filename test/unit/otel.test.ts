/** PORT #39 OTel exporter unit tests: a scripted sequence of hook calls (pre_run, on_event turn/tool/
 *  compaction events, pre_tool/post_tool, post_run — in the loop's REAL order: turn_end before the
 *  turn's tools, tool events buffered after pre/post_tool) against a fake fetch → the OTLP/HTTP JSON is
 *  decoded and pinned: envelope, span tree by parentSpanId, id/time well-formedness, attribute schema,
 *  statuses, one trace per run, endpoint/header parsing, failure → warning (never a throw), flush.
 *  This file: the envelope + tree + ids, times, attributes, outcomes, cost and one-trace-per-run.
 *  The sibling otel-2.test.ts holds endpoint/headers/env, export failure → warning, flush, the
 *  HookRunner path, otelDebug, the consumer-closed run, leftover state, reused call ids and endpoint
 *  validation; the fake fetch, clock, message builders and the scripted runs live in
 *  test/helpers/otel-fixtures.ts. */

import { test, expect } from "bun:test";
import { unixNano, otelDebug, type OtlpSpan, type PricingSource } from "../../src/telemetry/otel.ts";
import { HookRunner } from "../../src/core/hooks.ts";
import { costUsd } from "../../src/core/usage.ts";
import { ctx, call, URL_, clock, assistant, flat, PM, make, spansOf, attr, standardRun, minimalRun, traces } from "../helpers/otel-fixtures.ts";

// ---------- envelope + tree + ids ----------

test("one run → one traces POST (#82: metrics/logs are separate URLs — counts pinned per path): one resourceSpans/scopeSpans with service.name rovecode; tree run→turn→tool by parentSpanId (the tool hangs off the turn that ISSUED it); 32/16-hex ids sharing one traceId; kind INTERNAL; OTLP/JSON value encodings", async () => {
  const { set, ff, msgs, warnings } = make();
  await standardRun(set, ctx("r1"), msgs);
  await set.flush();
  expect(warnings).toEqual([]);
  expect(traces(ff).length).toBe(1);
  expect(traces(ff)[0]!.url).toBe(URL_);
  const req = traces(ff)[0]!.body;
  expect(req.resourceSpans.length).toBe(1);
  expect(req.resourceSpans[0]!.scopeSpans.length).toBe(1);
  expect(req.resourceSpans[0]!.resource.attributes).toContainEqual({ key: "service.name", value: { stringValue: "rovecode" } });
  expect(req.resourceSpans[0]!.scopeSpans[0]!.scope.name).toBe("rovecode");
  const spans = spansOf(req);
  expect(spans.map((s) => s.name)).toEqual(["rovecode.run", "rovecode.turn", "rovecode.tool", "rovecode.turn"]); // start order
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
  expect(run.attributes.find((a) => a.key === "rovecode.tokens.input")!.value).toEqual({ intValue: "150" });
  expect(run.attributes.find((a) => a.key === "rovecode.cost_usd")!.value).toEqual({ doubleValue: expect.any(Number) });
  expect(tool.attributes.find((a) => a.key === "rovecode.ok")!.value).toEqual({ boolValue: true });
  expect(run.attributes.find((a) => a.key === "rovecode.status")!.value).toEqual({ stringValue: "done" });
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
  const spans = spansOf(traces(ff)[0]!.body);
  const run = spans[0]!;
  expect(run.startTimeUnixNano).toBe("1700000000002000000"); // the clock's SECOND reading, at pre_run — #82 takes the first at construction as the cumulative metrics window start
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
  const r = spansOf(traces(real.ff)[0]!.body)[0]!;
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
  const spans = spansOf(traces(ff)[0]!.body);
  const [run, t1, tool, t2] = spans as [OtlpSpan, OtlpSpan, OtlpSpan, OtlpSpan];
  const pick = (s: OtlpSpan, keys: string[]) => Object.fromEntries(keys.map((k) => [k, attr(s, k)]));
  expect(pick(run, ["rovecode.status", "rovecode.session_id", "rovecode.run_id", "rovecode.turns", "rovecode.tool_calls", "rovecode.tokens.input", "rovecode.tokens.output", "rovecode.tokens.cacheRead", "rovecode.tokens.cacheWrite", "rovecode.model.provider", "rovecode.model.model"])).toEqual({
    "rovecode.status": "done", "rovecode.session_id": "sess-9", "rovecode.run_id": "run-7", "rovecode.turns": "2", "rovecode.tool_calls": "1",
    "rovecode.tokens.input": "150", "rovecode.tokens.output": "15", "rovecode.tokens.cacheRead": "5", "rovecode.tokens.cacheWrite": "2",
    "rovecode.model.provider": "p", "rovecode.model.model": "m",
  });
  const row = flat.lookup("p", "m")!.pricing!;
  expect(attr(run, "rovecode.cost_usd") as number).toBeCloseTo(costUsd({ input: 150, output: 15, cacheRead: 5, cacheWrite: 2 }, row)!, 12);
  expect(pick(t1, ["rovecode.turn", "rovecode.stop_reason", "rovecode.tokens.input", "rovecode.tokens.output", "rovecode.tokens.cacheRead", "rovecode.tokens.cacheWrite", "rovecode.model.provider"]))
    .toEqual({ "rovecode.turn": "1", "rovecode.stop_reason": "tool_use", "rovecode.tokens.input": "100", "rovecode.tokens.output": "10", "rovecode.tokens.cacheRead": "5", "rovecode.tokens.cacheWrite": "2", "rovecode.model.provider": "p" });
  expect(attr(t1, "rovecode.cost_usd") as number).toBeCloseTo(costUsd({ input: 100, output: 10, cacheRead: 5, cacheWrite: 2 }, row)!, 12);
  expect(pick(t2, ["rovecode.turn", "rovecode.stop_reason", "rovecode.tokens.input", "rovecode.tokens.output", "rovecode.tokens.cacheRead", "rovecode.tokens.cacheWrite"]))
    .toEqual({ "rovecode.turn": "2", "rovecode.stop_reason": "end_turn", "rovecode.tokens.input": "50", "rovecode.tokens.output": "5", "rovecode.tokens.cacheRead": "0", "rovecode.tokens.cacheWrite": "0" });
  expect(pick(tool, ["rovecode.tool", "rovecode.call_id", "rovecode.ok", "rovecode.duration_ms", "rovecode.output_bytes"]))
    .toEqual({ "rovecode.tool": "probe", "rovecode.call_id": "c1", "rovecode.ok": true, "rovecode.duration_ms": "7", "rovecode.output_bytes": "6" });
  for (const s of spans) expect(s.status).toEqual({ code: 1 });
  expect(tool.events).toBeUndefined(); // no events → field omitted
});

test("outcomes: a failed tool → ERROR + ok false; a hook-denied call (tool_call_failed after pre_tool) → ERROR with the reason; a call that never reached pre_tool → an rovecode.tool_call_failed EVENT on the issuing turn; compaction → an rovecode.compaction event; an 'error' turn and an 'error'/'budget' run are ERROR, 'stopped' is OK; a guard-stubbed call (events only) still gets a span, tagged loop_guard; rovecode.tool_calls counts ISSUED calls (3 spans + the never-dispatched c3)", async () => {
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
  const spans = spansOf(traces(ff)[0]!.body);
  expect(spans.map((s) => s.name)).toEqual(["rovecode.run", "rovecode.turn", "rovecode.tool", "rovecode.tool", "rovecode.tool", "rovecode.turn"]);
  const [run, t1, c1, c2, c4, t2] = spans as [OtlpSpan, OtlpSpan, OtlpSpan, OtlpSpan, OtlpSpan, OtlpSpan];
  expect(c1.status).toEqual({ code: 2, message: "tool probe failed" });
  expect(attr(c1, "rovecode.ok")).toBe(false); expect(attr(c1, "rovecode.duration_ms")).toBe("3");
  expect(c2.status).toEqual({ code: 2, message: "permission_denied" });
  expect(attr(c2, "rovecode.ok")).toBe(false); expect(attr(c2, "rovecode.failure_reason")).toBe("permission_denied"); expect(attr(c2, "rovecode.tool")).toBe("bash");
  expect(c4.parentSpanId).toBe(t1.spanId); expect(attr(c4, "rovecode.tool")).toBe("probe"); expect(attr(c4, "rovecode.ok")).toBe(false); expect(attr(c4, "rovecode.duration_ms")).toBe("0");
  expect(attr(c4, "rovecode.failure_reason")).toBe("loop_guard"); // opened by tool_execution_start with no pre_tool: the stub path (mutation: drop the tag → undefined)
  expect(attr(c1, "rovecode.failure_reason")).toBeUndefined(); // a dispatched call (pre_tool opened it) is never tagged
  for (const s of [c1, c2, c4]) expect(s.parentSpanId).toBe(t1.spanId);
  expect(t1.events!.map((e) => e.name)).toEqual(["rovecode.compaction", "rovecode.tool_call_failed"]);
  expect(t1.events![0]!.attributes).toEqual([
    { key: "rovecode.compaction.strategy", value: { stringValue: "keep-window" } }, { key: "rovecode.compaction.trigger", value: { stringValue: "speculative" } },
    { key: "rovecode.compaction.tokens_before", value: { intValue: "900" } }, { key: "rovecode.compaction.tokens_after", value: { intValue: "300" } },
  ]);
  expect(t1.events![1]!.attributes).toEqual([{ key: "rovecode.call_id", value: { stringValue: "c3" } }, { key: "rovecode.failure_reason", value: { stringValue: "not_found" } }]);
  for (const e of t1.events!) expect(e.timeUnixNano).toMatch(/^\d{19}$/);
  expect(t2.status).toEqual({ code: 2, message: "error" });
  expect(run.status).toEqual({ code: 2, message: "error" });
  expect(attr(run, "rovecode.status")).toBe("error"); expect(attr(run, "rovecode.turns")).toBe("2");
  expect(attr(run, "rovecode.tool_calls")).toBe("4"); // c1 + c2 + c4 (spans) + c3 (never dispatched: event) — the cli/output.ts toolCalls count (mutation: spans only → "3")
  // run-level status mapping: done/stopped → OK, budget → ERROR
  const m2 = make();
  await minimalRun(m2.set, ctx("a"), "stopped"); await minimalRun(m2.set, ctx("b"), "budget"); await minimalRun(m2.set, ctx("d"), "done");
  await m2.set.flush();
  expect(traces(m2.ff).map((p) => spansOf(p.body)[0]!.status)).toEqual([{ code: 1 }, { code: 2, message: "budget" }, { code: 1 }]);
  // unfinished turn + tool at post_run: closed at the run's end, status UNSET; a tool with no turn parents to the run
  const m3 = make();
  const c3 = ctx("u");
  await m3.set.pre_run!(c3);
  await m3.set.pre_tool!(c3, call); // before any turn (bare dispatch shape)
  await m3.set.on_event!(c3, { type: "turn_start", turn: 1 });
  await m3.set.post_run!(c3, { status: "stopped", summary: "run aborted" });
  await m3.set.flush();
  const [r3, tool3, turn3] = spansOf(traces(m3.ff)[0]!.body) as [OtlpSpan, OtlpSpan, OtlpSpan];
  expect(tool3.parentSpanId).toBe(r3.spanId);
  for (const s of [tool3, turn3]) { expect(s.status).toEqual({ code: 0 }); expect(s.endTimeUnixNano).toBe(r3.endTimeUnixNano); }
});

test("cost: omitted (never 0, never a lower bound) when any usage-bearing message lacks pricing — unknown provider under the default catalog, a partially-priced run, or no origin; tokens still summed; an all-zero-usage run prices at 0", async () => {
  const dflt = make({ pricing: undefined }); // lazy ModelCatalog: knows no provider "p"
  await standardRun(dflt.set, ctx("r1"), dflt.msgs);
  await dflt.set.flush();
  const run = spansOf(traces(dflt.ff)[0]!.body)[0]!;
  expect(attr(run, "rovecode.cost_usd")).toBeUndefined();
  expect(attr(run, "rovecode.tokens.input")).toBe("150");
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
  const [r2, t1, t2] = spansOf(traces(part.ff)[0]!.body) as [OtlpSpan, OtlpSpan, OtlpSpan];
  expect(attr(r2, "rovecode.cost_usd")).toBeUndefined(); // one unpriced message → the run's cost is unknown
  expect(attr(t1, "rovecode.cost_usd") as number).toBeCloseTo(11 / 1_000_000, 12); // the priced turn still carries its own
  expect(attr(t2, "rovecode.cost_usd")).toBeUndefined();
  expect(attr(r2, "rovecode.tokens.input")).toBe("20");
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
  expect(attr(spansOf(traces(noOrigin.ff)[0]!.body)[0]!, "rovecode.cost_usd")).toBeUndefined();
  expect(attr(spansOf(traces(zero.ff)[0]!.body)[0]!, "rovecode.cost_usd")).toBe(0);
  expect(attr(spansOf(traces(zero.ff)[0]!.body)[0]!, "rovecode.model.provider")).toBe("p");
});

// ---------- one trace per run ----------

test("one trace per run: two sequential runs → two POSTs with distinct traceIds and disjoint spanIds; two INTERLEAVED runs (distinct runIds on one set) keep separate trees and traces", async () => {
  const { set, ff, msgs } = make();
  await standardRun(set, ctx("r1"), msgs);
  await standardRun(set, ctx("r2"), msgs);
  await set.flush();
  expect(traces(ff).length).toBe(2);
  const a = spansOf(traces(ff)[0]!.body), b = spansOf(traces(ff)[1]!.body);
  expect(a[0]!.traceId).not.toBe(b[0]!.traceId);
  expect(new Set([...a, ...b].map((s) => s.spanId)).size).toBe(a.length + b.length);
  expect(attr(a[0]!, "rovecode.run_id")).toBe("r1"); expect(attr(b[0]!, "rovecode.run_id")).toBe("r2");
  expect(attr(b[0]!, "rovecode.tokens.input")).toBe("150"); // the second run counts only ITS messages
  // interleaved
  const m = make();
  const x = ctx("x"), y = ctx("y");
  await m.set.pre_run!(x); await m.set.pre_run!(y);
  await m.set.on_event!(x, { type: "turn_start", turn: 1 }); await m.set.on_event!(y, { type: "turn_start", turn: 1 });
  await m.set.pre_tool!(y, call);
  await m.set.on_event!(y, { type: "turn_end", turn: 1, stopReason: "end_turn" }); await m.set.on_event!(x, { type: "turn_end", turn: 1, stopReason: "end_turn" });
  await m.set.post_run!(y, { status: "done", summary: "" }); await m.set.post_run!(x, { status: "done", summary: "" });
  await m.set.flush();
  const py = spansOf(traces(m.ff)[0]!.body), px = spansOf(traces(m.ff)[1]!.body);
  expect(attr(py[0]!, "rovecode.run_id")).toBe("y"); expect(py.map((s) => s.name)).toEqual(["rovecode.run", "rovecode.turn", "rovecode.tool"]);
  expect(attr(px[0]!, "rovecode.run_id")).toBe("x"); expect(px.map((s) => s.name)).toEqual(["rovecode.run", "rovecode.turn"]);
  for (const s of py) expect(s.traceId).toBe(py[0]!.traceId);
  for (const s of px) expect(s.traceId).toBe(px[0]!.traceId);
  expect(px[0]!.traceId).not.toBe(py[0]!.traceId);
  // events for an unknown run (no pre_run) are ignored, never a throw
  await m.set.on_event!(ctx("ghost"), { type: "turn_start", turn: 1 });
  await m.set.post_run!(ctx("ghost"), { status: "done", summary: "" });
  await m.set.pre_tool!({ cwd: "/w", sessionId: "s" }, call); // bare dispatch: no runId
  await m.set.flush();
  expect(traces(m.ff).length).toBe(2);
});
