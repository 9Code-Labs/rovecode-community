/** PORT #39 OTel WIRING tests: the REAL runtime (bootRuntime → createRuntime registers the set only
 *  under ROVECODE_OTEL_ENDPOINT) + the real agentLoop (scripted mock stream with a tool call) against a
 *  local Bun.serve OTLP receiver. Pins: ON → one request whose span tree matches the run and whose
 *  usage/cost attrs match the store; OFF → nothing exported AND the exporter was never constructed
 *  (module spy — the bar's mutation target); unreachable endpoint → the run completes, one warning. */

import { test, expect } from "bun:test";
import { bootRuntime, type Runtime } from "../../src/cli/runtime.ts";
import { agentLoop } from "../../src/core/loop.ts";
import { mockStream, textTurn, toolTurn } from "../../src/providers/stream.ts";
import { ModelCatalog } from "../../src/providers/catalog.ts";
import { costUsd } from "../../src/core/usage.ts";
import { otelDebug, type OtlpSpan, type OtlpTraceRequest } from "../../src/telemetry/otel.ts";
import { startServer } from "../../src/server/http.ts";
import { createOutputSink, type RunResult } from "../../src/cli/output.ts";
import type { AssistantTurn, Message, ModelRef, RunEvent, StreamEvent, StreamFn, StreamOptions, Tool } from "../../src/core/types.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** vendor-prefixed id: the catalog prices it for provider "custom" via VENDOR_PREFIX_MAP (output-modes idiom) */
const MODEL = "zai-org/glm-5.3-flash";
const T = 30_000;

const probe: Tool = { schema: { name: "probe", description: "probe", args: { type: "object" } }, kind: "custom", async execute() { return { ok: true, output: "probe-output" }; } };
const script = () => mockStream({ turns: [toolTurn([{ id: "c1", tool: "probe", args: { q: 1 } }]), textTurn("final")] });

/** local OTLP receiver: records path/headers/body of every request, answers `{}` */
function receiver() {
  const got: { path: string; headers: Record<string, string>; body: OtlpTraceRequest }[] = [];
  const server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(req) {
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => { headers[k] = v; });
      got.push({ path: new URL(req.url).pathname, headers, body: (await req.json()) as OtlpTraceRequest });
      return new Response("{}", { headers: { "content-type": "application/json" } });
    },
  });
  // #82: the receiver now also gets /v1/metrics and /v1/logs — the #39 pins below count the traces requests per path
  return { got, traces: () => got.filter((g) => g.path === "/v1/traces"), url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}
/** set/unset env vars for one test; returns the restorer */
function pinEnv(vars: Record<string, string | undefined>): () => void {
  const saved = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(vars)) {
    saved.set(k, process.env[k]);
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  return () => { for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
}
interface Rig { cwd: string; home: string; rx: ReturnType<typeof receiver>; restore: () => void; rt?: Runtime }
function rig(endpoint: string | undefined | ((rx: ReturnType<typeof receiver>) => string), headers?: string): Rig {
  const rx = receiver();
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-otel-cwd-"));
  const home = mkdtempSync(join(tmpdir(), "rovecode-otel-home-"));
  const restore = pinEnv({
    ROVECODE_OTEL_ENDPOINT: typeof endpoint === "function" ? endpoint(rx) : endpoint, ROVECODE_OTEL_HEADERS: headers,
    ROVECODE_HOME: home, ROVECODE_NO_REPOMAP: "1", ROVECODE_NO_CHECKPOINTS: "1", ROVECODE_NO_HOOKS: undefined,
  });
  return { cwd, home, rx, restore };
}
async function teardown(r: Rig): Promise<void> {
  await r.rt?.hooks.close();
  await r.rt?.mcp?.close().catch(() => {});
  r.rx.stop();
  r.restore();
  rmSync(r.cwd, { recursive: true, force: true }); rmSync(r.home, { recursive: true, force: true });
}
/** the cmdRun deps shape (main.ts:92) with the runtime's registry + hooks + store */
async function scriptedRun(rt: Runtime, model: ModelRef): Promise<RunEvent[]> {
  rt.registry.register(probe);
  const events: RunEvent[] = [];
  for await (const ev of agentLoop(rt.buildDef(model), "otel wiring", {}, rt.buildCfg(true), {
    stream: rt.stream!, registry: rt.registry, store: rt.store, tools: rt.registry.list().map((t) => t.schema), guard: rt.guard, cwd: rt.cwd, hooks: rt.hooks,
  }, rt.steering)) events.push(ev);
  return events;
}
const attr = (s: OtlpSpan, key: string): unknown => { const a = s.attributes.find((x) => x.key === key); return a ? Object.values(a.value)[0] : undefined; };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(pred: () => boolean, ms: number, what: string): Promise<void> {
  const t0 = Date.now();
  while (!pred()) { if (Date.now() - t0 > ms) throw new Error(`${what}: not true within ${ms}ms`); await sleep(15); }
}
const runSpanOf = (body: OtlpTraceRequest): OtlpSpan => body.resourceSpans[0]!.scopeSpans[0]!.spans.find((s) => s.name === "rovecode.run")!;
/** parks until ITS OWN ctx.signal aborts — a consumer that merely .return()s the generator releases it through the loop-owned controller */
const parked: Tool = {
  schema: { name: "parked", description: "parks until aborted", args: { type: "object" } }, kind: "custom",
  async execute(_a, ctx) { await new Promise<void>((r) => { if (ctx.signal.aborted) r(); else ctx.signal.addEventListener("abort", () => r(), { once: true }); }); return { ok: true, output: "released" }; },
};
/** every run: turn 1 calls `parked`, the turn after a tool result is text (goal-agnostic, so runs never share a script cursor) */
const parkedScript: StreamFn = async function* (_m: ModelRef, messages: Message[]): AsyncGenerator<StreamEvent> {
  yield { type: "turn", turn: messages.at(-1)?.role === "tool" ? textTurn("late") : toolTurn([{ id: `p${messages.length}`, tool: "parked", args: {} }]) };
};

test("ON: ROVECODE_OTEL_ENDPOINT set → the runtime constructs the exporter once and taps on_event; a real run with a tool call reaches the receiver as ONE request (headers ride along) whose tree matches the run (1 run, N turns, 1 tool), token attrs equal the store's sums, cost matches costUsd() for the priced origin; close() flushes; no warnings", async () => {
  const r = rig((rx) => `${rx.url}/`, "authorization=Bearer x=y, x-team=rovecode");
  try {
    const before = otelDebug.constructed;
    r.rt = await bootRuntime({ cwd: r.cwd, sessionId: "otel-s", stream: script() });
    expect(otelDebug.constructed).toBe(before + 1);
    expect(r.rt.hooks.has("on_event")).toBe(true);
    expect(r.rt.hooks.size).toBe(2); // otel + the built-in port-#28 reflection set
    const events = await scriptedRun(r.rt, { provider: "custom", model: MODEL });
    expect(events.at(-1)).toMatchObject({ type: "run_end", status: "done", summary: "final" });
    await r.rt.hooks.close(); // session_close → flush (the POST is fire-and-forget at post_run)
    expect(r.rx.traces().length).toBe(1);
    expect(r.rx.got.filter((g) => g.path === "/v1/metrics").length).toBe(1); // #82: the run's cumulative metrics ride beside the trace
    const { path, headers, body } = r.rx.traces()[0]!;
    expect(path).toBe("/v1/traces");
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["authorization"]).toBe("Bearer x=y");
    expect(headers["x-team"]).toBe("rovecode");
    expect(body.resourceSpans.length).toBe(1);
    expect(body.resourceSpans[0]!.resource.attributes).toContainEqual({ key: "service.name", value: { stringValue: "rovecode" } });
    const spans = body.resourceSpans[0]!.scopeSpans[0]!.spans;
    const runs = spans.filter((s) => s.name === "rovecode.run"), turns = spans.filter((s) => s.name === "rovecode.turn"), tools = spans.filter((s) => s.name === "rovecode.tool");
    expect(runs.length).toBe(1);
    expect(turns.length).toBe(events.filter((e) => e.type === "turn_start").length);
    expect(turns.length).toBe(2);
    expect(tools.length).toBe(1);
    expect(spans.length).toBe(4);
    const run = runs[0]!;
    for (const t of turns) expect(t.parentSpanId).toBe(run.spanId);
    expect(tools[0]!.parentSpanId).toBe(turns[0]!.spanId); // issued by turn 1
    for (const s of spans) { expect(s.traceId).toBe(run.traceId); expect(BigInt(s.endTimeUnixNano) >= BigInt(s.startTimeUnixNano)).toBe(true); }
    const start = events.find((e) => e.type === "run_start") as Extract<RunEvent, { type: "run_start" }>;
    expect(attr(run, "rovecode.run_id")).toBe(start.runId);
    expect(attr(run, "rovecode.session_id")).toBe("otel-s");
    expect(attr(run, "rovecode.status")).toBe("done");
    expect(run.status).toEqual({ code: 1 });
    // tokens = the store's sums over the run's assistant messages; cost = per-message catalog pricing
    const assistants = r.rt.store.messages().filter((m) => m.role === "assistant");
    expect(assistants.length).toBe(2);
    const sum = (k: "input" | "output" | "cacheRead" | "cacheWrite") => assistants.reduce((n, m) => n + (m.usage?.[k] ?? 0), 0);
    expect(attr(run, "rovecode.tokens.input")).toBe(String(sum("input")));
    expect(attr(run, "rovecode.tokens.output")).toBe(String(sum("output")));
    expect(attr(run, "rovecode.tokens.cacheRead")).toBe(String(sum("cacheRead")));
    expect(attr(run, "rovecode.tokens.cacheWrite")).toBe(String(sum("cacheWrite")));
    expect(sum("output")).toBe(2);
    const pricing = new ModelCatalog().lookup("custom", MODEL)?.pricing;
    expect(pricing).toBeDefined();
    const expected = assistants.reduce((n, m) => n + costUsd({ input: m.usage!.input, output: m.usage!.output, cacheRead: m.usage!.cacheRead ?? 0, cacheWrite: m.usage!.cacheWrite ?? 0 }, pricing!)!, 0);
    expect(expected).toBeGreaterThan(0);
    expect(attr(run, "rovecode.cost_usd") as number).toBeCloseTo(expected, 12);
    expect(attr(run, "rovecode.model.provider")).toBe("custom");
    expect(attr(run, "rovecode.model.model")).toBe(MODEL);
    expect(turns.map((t) => attr(t, "rovecode.stop_reason"))).toEqual(["tool_use", "end_turn"]);
    expect(turns.map((t) => attr(t, "rovecode.turn"))).toEqual(["1", "2"]);
    expect(turns.map((t) => attr(t, "rovecode.tokens.output"))).toEqual(["1", "1"]);
    const end = events.find((e) => e.type === "tool_execution_end") as Extract<RunEvent, { type: "tool_execution_end" }>;
    expect(attr(tools[0]!, "rovecode.tool")).toBe("probe");
    expect(attr(tools[0]!, "rovecode.call_id")).toBe("c1");
    expect(attr(tools[0]!, "rovecode.ok")).toBe(true);
    expect(attr(tools[0]!, "rovecode.duration_ms")).toBe(String(end.durationMs));
    expect(attr(tools[0]!, "rovecode.output_bytes")).toBe(String(Buffer.byteLength("probe-output")));
    expect(tools[0]!.status).toEqual({ code: 1 });
    expect(JSON.stringify(body)).not.toContain("probe-output"); // sizes, never output
    expect(r.rt.hooks.warnings).toEqual([]);
  } finally { await teardown(r); }
}, T);

test("OFF: ROVECODE_OTEL_ENDPOINT unset → the exporter is never constructed (module spy unchanged), the runner has no sets and no on_event tap, a full scripted run exports nothing and warns nothing", async () => {
  const r = rig(undefined);
  try {
    const before = otelDebug.constructed;
    r.rt = await bootRuntime({ cwd: r.cwd, sessionId: "otel-off", stream: script() });
    expect(otelDebug.constructed).toBe(before); // MUTATION TARGET: register-always → constructed ticks
    expect(r.rt.hooks.size).toBe(1); // only the built-in port-#28 reflection set — no otel set
    expect(r.rt.hooks.has("on_event")).toBe(false);
    const events = await scriptedRun(r.rt, { provider: "mock", model: "default" });
    expect(events.at(-1)).toMatchObject({ type: "run_end", status: "done" });
    expect(events.some((e) => e.type === "tool_execution_end")).toBe(true);
    await r.rt.hooks.close();
    expect(r.rx.traces().length).toBe(0);
    expect(otelDebug.constructed).toBe(before);
    expect(r.rt.hooks.warnings).toEqual([]);
  } finally { await teardown(r); }
}, T);

// ---------- fix-wave 4 (#39 MED-1): cancelled runs export; RunState is released ----------

test("cancelled runs export (real runtime + agentLoop): (1) abort + gen.return() at the tool (ACP cancel / TUI Esc shape) → ONE trace, status stopped; (2) abort-only (cmdRun) → ONE trace, unchanged; (3) a bare .return() with no abort → ONE trace, stopped; close() drains nothing more — three runs, three traces", async () => {
  const r = rig((rx) => rx.url);
  try {
    r.rt = await bootRuntime({ cwd: r.cwd, sessionId: "otel-cancel", stream: parkedScript });
    r.rt.registry.register(parked);
    const rt = r.rt;
    const def = rt.buildDef({ provider: "mock", model: "default" }), cfg = rt.buildCfg(true);
    const deps = (signal?: AbortSignal) => ({ stream: rt.stream!, registry: rt.registry, store: rt.store, tools: rt.registry.list().map((t) => t.schema), guard: rt.guard, cwd: rt.cwd, hooks: rt.hooks, ...(signal ? { signal } : {}) });
    const ids: string[] = [];
    // (1) the surface aborts its controller, then closes the generator — no run_end is ever yielded
    const ac1 = new AbortController();
    const gen1 = agentLoop(def, "cancel-1", {}, cfg, deps(ac1.signal), rt.steering);
    const seen1: string[] = [];
    for await (const ev of gen1) {
      seen1.push(ev.type);
      if (ev.type === "run_start") ids.push(ev.runId);
      if (ev.type === "tool_execution_start") { ac1.abort(); await gen1.return(undefined as never); }
    }
    expect(seen1).not.toContain("run_end");
    await until(() => r.rx.traces().length >= 1, 6_000, "trace of the consumer-closed run"); // MUTATION TARGET: drop `await obs.close()` in agentLoop's finally → never exported
    expect(attr(runSpanOf(r.rx.traces()[0]!.body), "rovecode.run_id")).toBe(ids[0]);
    expect(attr(runSpanOf(r.rx.traces()[0]!.body), "rovecode.status")).toBe("stopped");
    // (2) abort only: the loop yields run_end stopped itself (cmdRun's SIGINT path) — exactly one trace, as before
    const ac2 = new AbortController();
    const seen2: RunEvent[] = [];
    for await (const ev of agentLoop(def, "cancel-2", {}, cfg, deps(ac2.signal), rt.steering)) { seen2.push(ev); if (ev.type === "run_start") ids.push(ev.runId); if (ev.type === "tool_execution_start") ac2.abort(); }
    expect(seen2.at(-1)).toMatchObject({ type: "run_end", status: "stopped" });
    await until(() => r.rx.traces().length >= 2, 6_000, "trace of the aborted run");
    expect(attr(runSpanOf(r.rx.traces()[1]!.body), "rovecode.run_id")).toBe(ids[1]);
    expect(attr(runSpanOf(r.rx.traces()[1]!.body), "rovecode.status")).toBe("stopped");
    // (3) a consumer that just leaves (break → .return()) with no controller of its own
    const gen3 = agentLoop(def, "cancel-3", {}, cfg, deps(), rt.steering);
    for await (const ev of gen3) { if (ev.type === "run_start") ids.push(ev.runId); if (ev.type === "tool_execution_start") break; }
    await until(() => r.rx.traces().length >= 3, 6_000, "trace of the bare-return run");
    expect(attr(runSpanOf(r.rx.traces()[2]!.body), "rovecode.run_id")).toBe(ids[2]);
    expect(attr(runSpanOf(r.rx.traces()[2]!.body), "rovecode.status")).toBe("stopped");
    await rt.hooks.close(); // session_close: nothing left to drain — no fourth trace POST
    expect(r.rx.traces().length).toBe(3);
    expect(new Set(r.rx.traces().map((g) => attr(runSpanOf(g.body), "rovecode.run_id"))).size).toBe(3);
    expect(rt.hooks.warnings).toEqual([]);
  } finally { await teardown(r); }
}, T);

test("serve: a client that disconnects mid-run and a DELETE-cancelled run each export ONE trace with status stopped (real startServer, parked provider turn); stop() adds no duplicate", async () => {
  let parkedTurns = 0;
  const parkedProvider: StreamFn = async function* (_m: ModelRef, _msgs: Message[], opts?: StreamOptions): AsyncGenerator<StreamEvent> {
    const sig = opts?.signal;
    parkedTurns++;
    if (sig && !sig.aborted) await new Promise<void>((res) => sig.addEventListener("abort", () => res(), { once: true }));
    yield { type: "turn", turn: { parts: [], stopReason: "aborted", usage: { input: 0, output: 0 } } };
  };
  const r = rig((rx) => rx.url);
  const srv = startServer({ port: 0, cwd: r.cwd, stream: parkedProvider });
  try {
    const session = async (): Promise<string> => ((await (await fetch(`${srv.url}/session`, { method: "POST" })).json()) as { id: string }).id;
    const prompt = (id: string, signal?: AbortSignal) => fetch(`${srv.url}/session/${id}/prompt`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "park" }), ...(signal ? { signal } : {}) });
    // client disconnect: sseResponse.cancel() aborts the run and .return()s its generator — before this fix, no trace at all
    const idA = await session();
    const ac = new AbortController();
    const resA = await prompt(idA, ac.signal);
    expect(resA.status).toBe(200);
    await until(() => parkedTurns >= 1, 4_000, "run A inside its provider turn");
    ac.abort();
    await until(() => r.rx.traces().length >= 1, 6_000, "trace of the disconnected run"); // MUTATION TARGET: drop the teardown seam → 0 traces for this session
    expect(attr(runSpanOf(r.rx.traces()[0]!.body), "rovecode.session_id")).toBe(idA);
    expect(attr(runSpanOf(r.rx.traces()[0]!.body), "rovecode.status")).toBe("stopped");
    // DELETE-cancel: the loop yields run_end stopped itself — still exactly one trace
    const idB = await session();
    const resB = await prompt(idB);
    await until(() => parkedTurns >= 2, 4_000, "run B inside its provider turn");
    expect(await (await fetch(`${srv.url}/session/${idB}/prompt`, { method: "DELETE" })).json()).toEqual({ cancelled: true });
    expect(await resB.text()).toContain('"status":"stopped"');
    await until(() => r.rx.traces().length >= 2, 6_000, "trace of the DELETE-cancelled run");
    expect(attr(runSpanOf(r.rx.traces()[1]!.body), "rovecode.session_id")).toBe(idB);
    expect(attr(runSpanOf(r.rx.traces()[1]!.body), "rovecode.status")).toBe("stopped");
    await srv.stop(); // session_close per runtime: flush, nothing to drain
    expect(r.rx.traces().length).toBe(2);
  } finally {
    await srv.stop().catch(() => {});
    await teardown(r);
  }
}, T);

test("rovecode.tool_calls = ISSUED calls, the `rovecode run --output json` toolCalls count on the SAME run: a dispatched call, an unknown tool (not_found, never dispatched) and a truncated turn's call (never dispatched) → 3 on both sides; only the dispatched one is a span", async () => {
  const r = rig((rx) => rx.url);
  try {
    const turns: AssistantTurn[] = [
      toolTurn([{ id: "c1", tool: "probe", args: {} }, { id: "c2", tool: "nope", args: {} }]),
      { parts: [{ kind: "tool_call", id: "c3", tool: "probe", args: {} }], stopReason: "length", usage: { input: 0, output: 1 } }, // truncated: failed unexecuted
      textTurn("final"),
    ];
    r.rt = await bootRuntime({ cwd: r.cwd, sessionId: "otel-count", stream: mockStream({ turns }) });
    const rt = r.rt;
    rt.registry.register(probe);
    const model: ModelRef = { provider: "mock", model: "default" };
    const out: string[] = [];
    const sink = createOutputSink("json", { stdout: { write: (c: string) => out.push(c) }, stderr: { write: () => {} }, model, messages: () => rt.store.messages(), onInterrupt: () => () => {} });
    let end: Extract<RunEvent, { type: "run_end" }> | undefined;
    for await (const ev of agentLoop(rt.buildDef(model), "count calls", {}, rt.buildCfg(true), {
      stream: rt.stream!, registry: rt.registry, store: rt.store, tools: rt.registry.list().map((t) => t.schema), guard: rt.guard, cwd: rt.cwd, hooks: rt.hooks,
    }, rt.steering)) { sink.onEvent(ev); if (ev.type === "run_end") end = ev; }
    sink.finish(end);
    const result = JSON.parse(out.join("")) as RunResult;
    expect(result.status).toBe("done");
    expect(result.toolCalls.map((c) => [c.tool, c.ok])).toEqual([["probe", true], ["nope", false], ["probe", false]]);
    await rt.hooks.close();
    expect(r.rx.traces().length).toBe(1);
    const spans = r.rx.traces()[0]!.body.resourceSpans[0]!.scopeSpans[0]!.spans;
    expect(attr(runSpanOf(r.rx.traces()[0]!.body), "rovecode.tool_calls")).toBe(String(result.toolCalls.length)); // MUTATION TARGET: count spans only → "1"
    expect(spans.filter((s) => s.name === "rovecode.tool").length).toBe(1);
    const failedEvents = spans.filter((s) => s.name === "rovecode.turn").flatMap((t) => (t.events ?? []).filter((e) => e.name === "rovecode.tool_call_failed"));
    expect(failedEvents.map((e) => e.attributes.find((a) => a.key === "rovecode.failure_reason")?.value)).toEqual([{ stringValue: "not_found" }, { stringValue: "truncated" }]);
  } finally { await teardown(r); }
}, T);

test("LOW-B (#39): a call id REUSED across turns on the REAL loop (the critic's repro — three consecutive turns each issue `same`): `rovecode run --output json` lists 3 toolCalls with their own ok/ms and rovecode.tool_calls = 3 = toolCalls.length — one tool span per issuing turn (was json 1 vs otel 3)", async () => {
  const r = rig((rx) => rx.url);
  try {
    const turns: AssistantTurn[] = [1, 2, 3].map((n) => toolTurn([{ id: "same", tool: "probe", args: { n } }]));
    turns.push(textTurn("final"));
    r.rt = await bootRuntime({ cwd: r.cwd, sessionId: "otel-reuse", stream: mockStream({ turns }) });
    const rt = r.rt;
    rt.registry.register(probe);
    const model: ModelRef = { provider: "mock", model: "default" };
    const out: string[] = [];
    const sink = createOutputSink("json", { stdout: { write: (c: string) => out.push(c) }, stderr: { write: () => {} }, model, messages: () => rt.store.messages(), onInterrupt: () => () => {} });
    let end: Extract<RunEvent, { type: "run_end" }> | undefined;
    for await (const ev of agentLoop(rt.buildDef(model), "reuse ids", {}, rt.buildCfg(true), {
      stream: rt.stream!, registry: rt.registry, store: rt.store, tools: rt.registry.list().map((t) => t.schema), guard: rt.guard, cwd: rt.cwd, hooks: rt.hooks,
    }, rt.steering)) { sink.onEvent(ev); if (ev.type === "run_end") end = ev; }
    sink.finish(end);
    const result = JSON.parse(out.join("")) as RunResult;
    expect(result.status).toBe("done");
    expect(result.toolCalls.map((c) => [c.tool, c.ok, typeof c.ms])).toEqual([["probe", true, "number"], ["probe", true, "number"], ["probe", true, "number"]]); // MUTATION TARGET: key by callId alone → one entry
    await rt.hooks.close();
    expect(r.rx.traces().length).toBe(1);
    const body = r.rx.traces()[0]!.body;
    const spans = body.resourceSpans[0]!.scopeSpans[0]!.spans;
    expect(attr(runSpanOf(body), "rovecode.tool_calls")).toBe("3");
    expect(attr(runSpanOf(body), "rovecode.tool_calls")).toBe(String(result.toolCalls.length));
    const turnSpans = spans.filter((s) => s.name === "rovecode.turn"), tools = spans.filter((s) => s.name === "rovecode.tool");
    expect(tools.map((t) => t.parentSpanId)).toEqual(turnSpans.slice(0, 3).map((t) => t.spanId)); // one span per issuing turn
    expect(tools.map((t) => attr(t, "rovecode.call_id"))).toEqual(["same", "same", "same"]);
  } finally { await teardown(r); }
}, T);

test("unreachable endpoint: the run completes normally (post_run never waits on the POST) and close() surfaces exactly ONE runner warning naming a signal URL (#82: the traces and the metrics POST both fail → one collapsed note); nothing throws", async () => {
  const dead = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("x") });
  const port = dead.port; dead.stop(true); // a just-freed loopback port: connection refused
  const r = rig(`http://127.0.0.1:${port}`);
  try {
    r.rt = await bootRuntime({ cwd: r.cwd, sessionId: "otel-dead", stream: script() });
    const t0 = Date.now();
    const events = await scriptedRun(r.rt, { provider: "mock", model: "default" });
    expect(events.at(-1)).toMatchObject({ type: "run_end", status: "done" });
    expect(Date.now() - t0).toBeLessThan(4000); // the run did not sit behind the 5s export timeout
    expect(r.rt.hooks.warnings).toEqual([]); // nothing raised inside the run
    await r.rt.hooks.close();
    expect(r.rt.hooks.warnings.length).toBe(1);
    expect(r.rt.hooks.warnings[0]).toMatch(new RegExp(`^otel: session_close hook threw: OTLP export to http://127\\.0\\.0\\.1:${port}/v1/(traces|metrics) failed: .+ \\(2 exports failed\\) — ignored, run continues$`)); // 5xx/network never disables a signal: both POSTs failed, per-export
    expect(r.rx.traces().length).toBe(0);
  } finally { await teardown(r); }
}, T);
