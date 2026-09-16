/** PORT #39 OTel exporter unit tests, part 2 — sibling of otel.test.ts (same fixtures: scripted hook
 *  calls in the loop's real order against a fake fetch, the OTLP/HTTP JSON decoded and pinned).
 *  This file: endpoint + headers + env parsing, export failure → one warning per failed export,
 *  flush() awaiting in-flight posts, the HookRunner path without onWarning, otelDebug, the
 *  consumer-closed run (observer.close), leftover state at session_close, a call id reused across
 *  turns and endpoint validation. Shared fixtures live in test/helpers/otel-fixtures.ts. */

import { test, expect } from "bun:test";
import {
  createOtelHooks, otelOptionsFromEnv, parseOtelHeaders, normalizeEndpoint, validEndpoint, otelDebug, DEFAULT_EXPORT_TIMEOUT_MS,
  type OtlpSpan,
} from "../../src/telemetry/otel.ts";
import { HookRunner } from "../../src/core/hooks.ts";
import type { Message } from "../../src/core/types.ts";
import {
  deadline, ctx, call, ENDPOINT, URL_, fakeFetch, assistant, flat, PM, make, spansOf, attr, named, standardRun, minimalRun, traces,
} from "../helpers/otel-fixtures.ts";

// ---------- endpoint / headers / env ----------

test("endpoint + headers: base URL, trailing slashes and a full …/v1/traces URL all POST to <base>/v1/traces; ROVECODE_OTEL_HEADERS 'k=v,k2=v2' parses on the FIRST '=' (values keep later '='), blanks skipped, and rides every POST beside content-type application/json; otelOptionsFromEnv is null without an endpoint", async () => {
  expect(normalizeEndpoint("http://h:4318")).toBe("http://h:4318/v1/traces");
  expect(normalizeEndpoint(" http://h:4318// ")).toBe("http://h:4318/v1/traces");
  expect(normalizeEndpoint("http://h:4318/v1/traces")).toBe("http://h:4318/v1/traces");
  expect(normalizeEndpoint("http://h:4318/v1/traces/")).toBe("http://h:4318/v1/traces");
  expect(normalizeEndpoint("https://otlp.example.com/api/otlp")).toBe("https://otlp.example.com/api/otlp/v1/traces");
  for (const ep of ["http://h:4318", "http://h:4318/", "http://h:4318/v1/traces"]) {
    const m = make({ endpoint: ep });
    await minimalRun(m.set, ctx("r"));
    await m.set.flush();
    expect(traces(m.ff)[0]!.url).toBe("http://h:4318/v1/traces");
  }
  expect(parseOtelHeaders("authorization=Bearer a=b, x-team = rovecode ,,junk,=novalue")).toEqual({ authorization: "Bearer a=b", "x-team": "rovecode" });
  expect(parseOtelHeaders(undefined)).toEqual({});
  expect(parseOtelHeaders("")).toEqual({});
  const m = make({ headers: parseOtelHeaders("authorization=Bearer a=b,x-team=rovecode") });
  await minimalRun(m.set, ctx("r"));
  await m.set.flush();
  expect(traces(m.ff)[0]!.headers).toEqual({ authorization: "Bearer a=b", "x-team": "rovecode", "content-type": "application/json" });
  expect(otelOptionsFromEnv({})).toBeNull();
  expect(otelOptionsFromEnv({ ROVECODE_OTEL_ENDPOINT: "   " })).toBeNull();
  expect(otelOptionsFromEnv({ ROVECODE_OTEL_ENDPOINT: " http://h:4318 ", ROVECODE_OTEL_HEADERS: "a=1" })).toEqual({ endpoint: "http://h:4318", headers: { a: "1" } });
  expect(otelOptionsFromEnv({ ROVECODE_OTEL_ENDPOINT: "http://h:4318" })).toEqual({ endpoint: "http://h:4318", headers: {} });
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
  expect(traces(held).length).toBe(1); // minimalRun: no turn → no metrics POST; the traces POST is the one held
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
  expect(traces(held).length).toBe(3);
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
  expect(traces(first).length).toBe(2); // #82: each run also POSTs /v1/metrics (its turn fed the histogram) — call 1 (R1's traces) was the refused one
  expect(spansOf(traces(first)[1]!.body).map((s) => s.name)).toEqual(["rovecode.run", "rovecode.turn"]);
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

test("otelDebug.constructed counts constructions (the off-path spy); the set exposes exactly the hooks it needs plus flush/openRuns (#82: + approval, observeTasks, recordRetry)", () => {
  const before = otelDebug.constructed;
  const { set } = make();
  expect(otelDebug.constructed).toBe(before + 1);
  expect(Object.keys(set).sort()).toEqual(["approval", "flush", "observeTasks", "on_event", "openRuns", "post_run", "post_tool", "pre_run", "pre_tool", "recordRetry", "session_close"]);
});

// ---------- fix-wave 4 (#39): cancelled runs, leftover drain, reused call ids, endpoint validation ----------

test("consumer-closed run (observer.close — the loop's teardown seam): post_run fires ONCE as stopped → exactly one export, rovecode.status stopped, the open turn closed UNSET, no RunState left; a second close() is a no-op; after a yielded run_end close() adds nothing; before any run_start it does nothing", async () => {
  const { set, ff, warnings } = make();
  const runner = new HookRunner({ cwd: "/w", sessionId: "s1" }, { timeoutMs: 2000 });
  runner.add(set, "otel");
  const a = runner.observer({ cwd: "/w", sessionId: "s1" });
  await a.observe({ type: "run_start", runId: "X", sessionId: "s1", goal: "g" });
  await a.observe({ type: "turn_start", turn: 1 });
  expect(set.openRuns()).toBe(1);
  await a.close(); // the consumer .return()ed the generator mid-turn (TUI Esc / ACP cancel / serve disconnect)
  await a.close(); // idempotent
  await set.flush();
  expect(traces(ff).length).toBe(1); // MUTATION TARGET: drop the post_run in close() → 0 (the trace is never exported)
  const [run, turn] = spansOf(traces(ff)[0]!.body) as [OtlpSpan, OtlpSpan];
  expect(attr(run, "rovecode.run_id")).toBe("X");
  expect(attr(run, "rovecode.status")).toBe("stopped"); expect(run.status).toEqual({ code: 1 });
  expect(turn.status).toEqual({ code: 0 }); expect(turn.endTimeUnixNano).toBe(run.endTimeUnixNano);
  expect(set.openRuns()).toBe(0); // the RunState was released (mutation: leave the state → 1)
  const b = runner.observer({ cwd: "/w", sessionId: "s1" });
  await b.observe({ type: "run_start", runId: "Y", sessionId: "s1", goal: "g" });
  await b.observe({ type: "run_end", status: "done", summary: "ok" });
  await b.close(); // a yielded run_end already fired post_run
  await set.flush();
  expect(traces(ff).length).toBe(2);
  expect(attr(spansOf(traces(ff)[1]!.body)[0]!, "rovecode.status")).toBe("done");
  const c = runner.observer({ cwd: "/w", sessionId: "s1" });
  await c.close(); // never started: no pre_run → no post_run
  await set.flush();
  expect(traces(ff).length).toBe(2);
  expect(set.openRuns()).toBe(0);
  expect(warnings).toEqual([]); expect(runner.warnings).toEqual([]);
});

test("leftover state at session_close (a generator dropped without .return()): the run is exported as stopped with its open spans closed UNSET, then flushed; openRuns returns to 0; a completed run leaves nothing to drain", async () => {
  const { set, ff, msgs } = make();
  const c = ctx("leak");
  await set.pre_run!(c);
  await set.on_event!(c, { type: "turn_start", turn: 1 });
  await set.pre_tool!(c, call);
  expect(set.openRuns()).toBe(1);
  await set.session_close!(c);
  expect(set.openRuns()).toBe(0); // MUTATION TARGET: drop the drain → 1 and no POST
  expect(traces(ff).length).toBe(1);
  const [run, turn, tool] = spansOf(traces(ff)[0]!.body) as [OtlpSpan, OtlpSpan, OtlpSpan];
  expect(attr(run, "rovecode.run_id")).toBe("leak");
  expect(attr(run, "rovecode.status")).toBe("stopped"); expect(run.status).toEqual({ code: 1 });
  expect(attr(run, "rovecode.tool_calls")).toBe("1");
  for (const s of [turn, tool]) { expect(s.status).toEqual({ code: 0 }); expect(s.endTimeUnixNano).toBe(run.endTimeUnixNano); }
  await standardRun(set, ctx("fine"), msgs);
  expect(set.openRuns()).toBe(0);
  await set.session_close!(ctx("fine"));
  await set.flush();
  expect(traces(ff).length).toBe(2); // the completed run exported once at post_run; the drain added nothing (its /v1/metrics POST is a separate URL)
});

test("a call id reused across turns (the SSE adapter's `tc<idx>` fallback) is one tool span PER TURN under its issuing turn, never a merge; a tool_call_failed for the reused id lands on the CURRENT turn's span; tool_calls counts every issue", async () => {
  const { set, ff, msgs } = make();
  const c = ctx("reuse");
  await set.pre_run!(c);
  for (let t = 1; t <= 3; t++) {
    await set.on_event!(c, { type: "turn_start", turn: t });
    msgs.push(assistant({ input: 1, output: 1 }, PM));
    await set.on_event!(c, { type: "turn_end", turn: t, stopReason: "tool_use" });
    await set.pre_tool!(c, { id: "same", tool: "probe", args: {} });
    await set.post_tool!(c, { id: "same", tool: "probe", args: {} }, { ok: true, output: `t${t}` });
    await set.on_event!(c, { type: "tool_execution_start", callId: "same", tool: "probe", args: {} });
    await set.on_event!(c, { type: "tool_execution_end", callId: "same", ok: true, output: `t${t}`, durationMs: t });
  }
  await set.on_event!(c, { type: "turn_start", turn: 4 }); // turn 4 reuses the id and a hook denies it after pre_tool
  await set.on_event!(c, { type: "turn_end", turn: 4, stopReason: "tool_use" });
  await set.pre_tool!(c, { id: "same", tool: "probe", args: {} });
  await set.on_event!(c, { type: "tool_call_failed", callId: "same", reason: "permission_denied", detail: "no" });
  await set.post_run!(c, { status: "done", summary: "" });
  await set.flush();
  const spans = spansOf(traces(ff)[0]!.body);
  const turns = named(spans, "rovecode.turn"), tools = named(spans, "rovecode.tool");
  expect(tools.length).toBe(4); // MUTATION TARGET: key by callId alone → 1 span carrying turn 1's data
  expect(tools.map((s) => s.parentSpanId)).toEqual(turns.map((t) => t.spanId));
  expect(tools.map((s) => attr(s, "rovecode.call_id"))).toEqual(["same", "same", "same", "same"]);
  expect(tools.slice(0, 3).map((s) => attr(s, "rovecode.duration_ms"))).toEqual(["1", "2", "3"]);
  for (const s of tools.slice(0, 3)) { expect(s.status).toEqual({ code: 1 }); expect(attr(s, "rovecode.failure_reason")).toBeUndefined(); }
  expect(tools[3]!.status).toEqual({ code: 2, message: "permission_denied" }); // turn 4's span, not turn 1's
  expect(attr(spans[0]!, "rovecode.tool_calls")).toBe("4");
});

test("endpoint validation: `http://` (unparseable) and `host:4318` (no scheme → no host) disable export with ONE note at construction — no POST is ever attempted (no 5 s stall against host `v1`); through a HookRunner the note is raised by the first lifecycle hook, once; valid shapes stay valid", async () => {
  for (const good of ["http://h:4318", " https://otlp.example.com/api/otlp ", "http://127.0.0.1:4318/v1/traces"]) expect(validEndpoint(good)).toBe(true);
  for (const bad of ["http://", "localhost:4318", "4318", "ftp://h:1", "//h:1", ""]) expect(validEndpoint(bad)).toBe(false);
  const direct = make({ endpoint: "http://" });
  expect(direct.warnings).toEqual(['ROVECODE_OTEL_ENDPOINT "http://" is not an absolute http(s) URL — OTel export disabled']);
  const t0 = Date.now();
  await minimalRun(direct.set, ctx("r1")); await minimalRun(direct.set, ctx("r2"));
  await direct.set.flush();
  expect(Date.now() - t0).toBeLessThan(1000);
  expect(direct.ff.posts.length).toBe(0); // MUTATION TARGET: drop the `usable` gate in post() → 2 POSTs to http:/v1/traces
  expect(direct.warnings.length).toBe(1); // once, not per run
  const ff = fakeFetch();
  const runner = new HookRunner({ cwd: "/w", sessionId: "s" }, { timeoutMs: 2000 });
  runner.add(createOtelHooks({ endpoint: "localhost:4318", fetch: ff.fn, messages: () => [] }), "otel");
  await runner.run("pre_run", ctx("a")); await runner.run("post_run", ctx("a"), { status: "done", summary: "" });
  await runner.run("pre_run", ctx("b")); await runner.run("post_run", ctx("b"), { status: "done", summary: "" });
  await runner.close();
  expect(runner.warnings).toEqual(['otel: pre_run hook threw: ROVECODE_OTEL_ENDPOINT "localhost:4318" is not an absolute http(s) URL — OTel export disabled — ignored, run continues']);
  expect(ff.posts.length).toBe(0);
});
