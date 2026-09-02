/** PORT #39 OTel WIRING tests: the REAL runtime (bootRuntime → createRuntime registers the set only
 *  under AION_OTEL_ENDPOINT) + the real agentLoop (scripted mock stream with a tool call) against a
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
import type { ModelRef, RunEvent, Tool } from "../../src/core/types.ts";
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
  return { got, url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
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
  const cwd = mkdtempSync(join(tmpdir(), "aion-otel-cwd-"));
  const home = mkdtempSync(join(tmpdir(), "aion-otel-home-"));
  const restore = pinEnv({
    AION_OTEL_ENDPOINT: typeof endpoint === "function" ? endpoint(rx) : endpoint, AION_OTEL_HEADERS: headers,
    AION_HOME: home, AION_NO_REPOMAP: "1", AION_NO_CHECKPOINTS: "1", AION_NO_HOOKS: undefined,
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

test("ON: AION_OTEL_ENDPOINT set → the runtime constructs the exporter once and taps on_event; a real run with a tool call reaches the receiver as ONE request (headers ride along) whose tree matches the run (1 run, N turns, 1 tool), token attrs equal the store's sums, cost matches costUsd() for the priced origin; close() flushes; no warnings", async () => {
  const r = rig((rx) => `${rx.url}/`, "authorization=Bearer x=y, x-team=aion");
  try {
    const before = otelDebug.constructed;
    r.rt = await bootRuntime({ cwd: r.cwd, sessionId: "otel-s", stream: script() });
    expect(otelDebug.constructed).toBe(before + 1);
    expect(r.rt.hooks.has("on_event")).toBe(true);
    expect(r.rt.hooks.size).toBe(2); // otel + the built-in port-#28 reflection set
    const events = await scriptedRun(r.rt, { provider: "custom", model: MODEL });
    expect(events.at(-1)).toMatchObject({ type: "run_end", status: "done", summary: "final" });
    await r.rt.hooks.close(); // session_close → flush (the POST is fire-and-forget at post_run)
    expect(r.rx.got.length).toBe(1);
    const { path, headers, body } = r.rx.got[0]!;
    expect(path).toBe("/v1/traces");
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["authorization"]).toBe("Bearer x=y");
    expect(headers["x-team"]).toBe("aion");
    expect(body.resourceSpans.length).toBe(1);
    expect(body.resourceSpans[0]!.resource.attributes).toContainEqual({ key: "service.name", value: { stringValue: "aion" } });
    const spans = body.resourceSpans[0]!.scopeSpans[0]!.spans;
    const runs = spans.filter((s) => s.name === "aion.run"), turns = spans.filter((s) => s.name === "aion.turn"), tools = spans.filter((s) => s.name === "aion.tool");
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
    expect(attr(run, "aion.run_id")).toBe(start.runId);
    expect(attr(run, "aion.session_id")).toBe("otel-s");
    expect(attr(run, "aion.status")).toBe("done");
    expect(run.status).toEqual({ code: 1 });
    // tokens = the store's sums over the run's assistant messages; cost = per-message catalog pricing
    const assistants = r.rt.store.messages().filter((m) => m.role === "assistant");
    expect(assistants.length).toBe(2);
    const sum = (k: "input" | "output" | "cacheRead" | "cacheWrite") => assistants.reduce((n, m) => n + (m.usage?.[k] ?? 0), 0);
    expect(attr(run, "aion.tokens.input")).toBe(String(sum("input")));
    expect(attr(run, "aion.tokens.output")).toBe(String(sum("output")));
    expect(attr(run, "aion.tokens.cacheRead")).toBe(String(sum("cacheRead")));
    expect(attr(run, "aion.tokens.cacheWrite")).toBe(String(sum("cacheWrite")));
    expect(sum("output")).toBe(2);
    const pricing = new ModelCatalog().lookup("custom", MODEL)?.pricing;
    expect(pricing).toBeDefined();
    const expected = assistants.reduce((n, m) => n + costUsd({ input: m.usage!.input, output: m.usage!.output, cacheRead: m.usage!.cacheRead ?? 0, cacheWrite: m.usage!.cacheWrite ?? 0 }, pricing!)!, 0);
    expect(expected).toBeGreaterThan(0);
    expect(attr(run, "aion.cost_usd") as number).toBeCloseTo(expected, 12);
    expect(attr(run, "aion.model.provider")).toBe("custom");
    expect(attr(run, "aion.model.model")).toBe(MODEL);
    expect(turns.map((t) => attr(t, "aion.stop_reason"))).toEqual(["tool_use", "end_turn"]);
    expect(turns.map((t) => attr(t, "aion.turn"))).toEqual(["1", "2"]);
    expect(turns.map((t) => attr(t, "aion.tokens.output"))).toEqual(["1", "1"]);
    const end = events.find((e) => e.type === "tool_execution_end") as Extract<RunEvent, { type: "tool_execution_end" }>;
    expect(attr(tools[0]!, "aion.tool")).toBe("probe");
    expect(attr(tools[0]!, "aion.call_id")).toBe("c1");
    expect(attr(tools[0]!, "aion.ok")).toBe(true);
    expect(attr(tools[0]!, "aion.duration_ms")).toBe(String(end.durationMs));
    expect(attr(tools[0]!, "aion.output_bytes")).toBe(String(Buffer.byteLength("probe-output")));
    expect(tools[0]!.status).toEqual({ code: 1 });
    expect(JSON.stringify(body)).not.toContain("probe-output"); // sizes, never output
    expect(r.rt.hooks.warnings).toEqual([]);
  } finally { await teardown(r); }
}, T);

test("OFF: AION_OTEL_ENDPOINT unset → the exporter is never constructed (module spy unchanged), the runner has no sets and no on_event tap, a full scripted run exports nothing and warns nothing", async () => {
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
    expect(r.rx.got.length).toBe(0);
    expect(otelDebug.constructed).toBe(before);
    expect(r.rt.hooks.warnings).toEqual([]);
  } finally { await teardown(r); }
}, T);

test("unreachable endpoint: the run completes normally (post_run never waits on the POST) and close() surfaces exactly ONE runner warning naming the traces URL; nothing throws", async () => {
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
    expect(r.rt.hooks.warnings[0]).toMatch(new RegExp(`^otel: session_close hook threw: OTLP export to http://127\\.0\\.0\\.1:${port}/v1/traces failed: .+ — ignored, run continues$`));
    expect(r.rx.got.length).toBe(0);
  } finally { await teardown(r); }
}, T);
