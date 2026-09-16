/** PORT #82 — metrics + logs + the exporter pipe of the #39 OTel hook set, unit level over the fake fetch
 *  (test/helpers/otel-fixtures.ts): the ExportMetricsServiceRequest shape (CUMULATIVE temporality 2,
 *  monotonic Sums with asInt decimal strings, the pinned duration bounds, count/sum/bucketCounts), the
 *  ExportLogsServiceRequest shape, standardRun → tokens 150/15/5/2 per type + duration count 2 + no retries,
 *  a second run → cumulative totals (never reset), minimalRun → traces only, recordRetry ×2 with an
 *  `HTTP 429: …` reason → retries 2 attributed to the note's model + rovecode.retry.status 429 and the reason
 *  text absent, sibling paths from a full traces URL, a 404 on /v1/metrics → ONE note + traces still POST +
 *  no further /v1/metrics POSTs, a 500 on /v1/logs → the existing per-export warning. Each test names its
 *  mutation target. Lane spans and approval records live in otel-lanes.test.ts / otel-approval.test.ts. */

import { test, expect } from "bun:test";
import { baseOf, signalUrl, type OtlpMetricsRequest, type OtlpLogsRequest } from "../../src/telemetry/otel.ts";
import { AGGREGATION_CUMULATIVE, DURATION_BOUNDS, createMetrics } from "../../src/telemetry/otel-metrics.ts";
import { encodeLogsRequest, SEVERITY_INFO, SEVERITY_WARN } from "../../src/telemetry/otel-logs.ts";
import { createOtlpExporter } from "../../src/telemetry/otel-export.ts";
import { int, str } from "../../src/telemetry/otlp.ts";
import { ctx, ENDPOINT, fakeFetch, make, postsTo, traces, standardRun, minimalRun } from "../helpers/otel-fixtures.ts";

type Metric = OtlpMetricsRequest["resourceMetrics"][0]["scopeMetrics"][0]["metrics"][0];
const metricsOf = (req: OtlpMetricsRequest): Metric[] => req.resourceMetrics[0]!.scopeMetrics[0]!.metrics;
const named = (req: OtlpMetricsRequest, name: string): Metric | undefined => metricsOf(req).find((m) => m.name === name);
const attrOf = (attrs: { key: string; value: Record<string, unknown> }[], key: string): unknown => { const a = attrs.find((x) => x.key === key); return a ? Object.values(a.value)[0] : undefined; };
/** rovecode.tokens points by rovecode.token.type → asInt */
function tokenTotals(req: OtlpMetricsRequest): Record<string, string> {
  const m = named(req, "rovecode.tokens");
  if (!m || !("sum" in m)) return {};
  return Object.fromEntries(m.sum.dataPoints.map((p) => [attrOf(p.attributes, "rovecode.token.type") as string, p.asInt!]));
}
const METRICS = "/v1/metrics", LOGS = "/v1/logs", TRACES = "/v1/traces";

// ---------- encoders ----------

test("encodeMetricsRequest: CUMULATIVE (aggregationTemporality 2, startTimeUnixNano = the registry's start on every point), monotonic Sums as asInt decimal strings, a double Sum as asDouble, the pinned duration bounds with count/sum/bucketCounts as strings, series keyed on sorted attrs, dirty cleared by encode but totals kept", () => {
  const reg = createMetrics(1_700_000_000_000);
  expect(reg.dirty).toBe(false);
  reg.addSum("rovecode.tokens", "{token}", [["rovecode.token.type", str("input")], ["rovecode.model.provider", str("p")]], 100);
  reg.addSum("rovecode.tokens", "{token}", [["rovecode.model.provider", str("p")], ["rovecode.token.type", str("input")]], 50); // same series, other key order
  reg.addSum("rovecode.tokens", "{token}", [["rovecode.token.type", str("output")], ["rovecode.model.provider", str("p")]], 7);
  reg.addSum("rovecode.cost_usd", "USD", [["rovecode.model.provider", str("p")]], 0.25, true);
  reg.recordHistogram("rovecode.request.duration", "ms", DURATION_BOUNDS, [["rovecode.stop_reason", str("end_turn")]], 120);
  reg.recordHistogram("rovecode.request.duration", "ms", DURATION_BOUNDS, [["rovecode.stop_reason", str("end_turn")]], 99_999);
  reg.recordHistogram("rovecode.request.duration", "ms", DURATION_BOUNDS, [["rovecode.stop_reason", str("end_turn")]], 100); // on the bound → its bucket (inclusive upper)
  expect(reg.dirty).toBe(true);
  const req = reg.encode("rovecode", 1_700_000_000_500);
  expect(reg.dirty).toBe(false);
  expect(req.resourceMetrics[0]!.resource.attributes).toContainEqual({ key: "service.name", value: { stringValue: "rovecode" } });
  expect(req.resourceMetrics[0]!.scopeMetrics[0]!.scope.name).toBe("rovecode");
  const tokens = named(req, "rovecode.tokens")!;
  if (!("sum" in tokens)) throw new Error("tokens is not a sum");
  expect(tokens.unit).toBe("{token}");
  expect(tokens.sum.aggregationTemporality).toBe(2); // MUTATION TARGET: DELTA (1) → fails here and in the two-run test below
  expect(AGGREGATION_CUMULATIVE).toBe(2);
  expect(tokens.sum.isMonotonic).toBe(true);
  expect(tokens.sum.dataPoints.length).toBe(2); // input (100 + 50 merged) + output
  const input = tokens.sum.dataPoints.find((p) => attrOf(p.attributes, "rovecode.token.type") === "input")!;
  expect(input.asInt).toBe("150"); expect(input.asDouble).toBeUndefined();
  expect(input.startTimeUnixNano).toBe("1700000000000000000"); expect(input.timeUnixNano).toBe("1700000000500000000");
  const cost = named(req, "rovecode.cost_usd")!;
  if (!("sum" in cost)) throw new Error("cost is not a sum");
  expect(cost.sum.dataPoints[0]!.asDouble).toBe(0.25); expect(cost.sum.dataPoints[0]!.asInt).toBeUndefined();
  const dur = named(req, "rovecode.request.duration")!;
  if (!("histogram" in dur)) throw new Error("duration is not a histogram");
  expect(dur.unit).toBe("ms");
  expect(dur.histogram.aggregationTemporality).toBe(2);
  const pt = dur.histogram.dataPoints[0]!;
  expect(pt.explicitBounds).toEqual([100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000]); // MUTATION TARGET: drift a bound
  expect(pt.count).toBe("3"); expect(pt.sum).toBe(120 + 99_999 + 100);
  expect(pt.bucketCounts).toEqual(["1", "1", "0", "0", "0", "0", "0", "0", "0", "1"]); // 100 → (−∞,100], 120 → (100,250], 99999 → overflow
  expect(pt.startTimeUnixNano).toBe("1700000000000000000");
  // cumulative: a later encode carries the earlier totals plus the new ones; negative/NaN steps are ignored
  reg.addSum("rovecode.tokens", "{token}", [["rovecode.token.type", str("input")], ["rovecode.model.provider", str("p")]], 1);
  reg.addSum("rovecode.tokens", "{token}", [["rovecode.token.type", str("input")], ["rovecode.model.provider", str("p")]], -5);
  reg.addSum("rovecode.tokens", "{token}", [["rovecode.token.type", str("input")], ["rovecode.model.provider", str("p")]], Number.NaN);
  const again = reg.encode("rovecode", 1_700_000_001_000);
  expect(tokenTotals(again)["input"]).toBe("151"); // MUTATION TARGET: zero the counters after encode → "1"
  expect(named(again, "rovecode.request.duration")).toBeDefined(); // untouched series still ride the cumulative request
  expect(JSON.parse(JSON.stringify(req))).toEqual(req); // plain JSON
});

test("encodeLogsRequest: one resourceLogs/scopeLogs, per record timeUnixNano = observedTimeUnixNano, severity 9/INFO vs 13/WARN, body stringValue, attributes, trace/span ids only when present", () => {
  const attrs = new Map([["rovecode.tool", str("bash")], ["rovecode.decision", str("allow")]]);
  const req: OtlpLogsRequest = encodeLogsRequest("rovecode", [
    { time: 1_700_000_000_000.5, severityNumber: SEVERITY_INFO, severityText: "INFO", body: "rovecode.approval", attrs, traceId: "a".repeat(32), spanId: "b".repeat(16) },
    { time: 1_700_000_000_001, severityNumber: SEVERITY_WARN, severityText: "WARN", body: "rovecode.approval", attrs: new Map([["rovecode.decision", str("deny")], ["rovecode.retry.status", int(429)]]) },
  ]);
  expect(req.resourceLogs.length).toBe(1);
  expect(req.resourceLogs[0]!.resource.attributes).toContainEqual({ key: "service.name", value: { stringValue: "rovecode" } });
  const [a, b] = req.resourceLogs[0]!.scopeLogs[0]!.logRecords;
  expect(a).toEqual({
    timeUnixNano: "1700000000000500000", observedTimeUnixNano: "1700000000000500000", severityNumber: 9, severityText: "INFO",
    body: { stringValue: "rovecode.approval" }, attributes: [{ key: "rovecode.tool", value: { stringValue: "bash" } }, { key: "rovecode.decision", value: { stringValue: "allow" } }],
    traceId: "a".repeat(32), spanId: "b".repeat(16),
  });
  expect(b!.severityNumber).toBe(13); expect(b!.severityText).toBe("WARN");
  expect("traceId" in b!).toBe(false); expect("spanId" in b!).toBe(false);
  expect(b!.attributes).toContainEqual({ key: "rovecode.retry.status", value: { intValue: "429" } });
});

// ---------- the hook set: metrics per run ----------

test("standardRun → ONE /v1/traces POST then ONE /v1/metrics POST: rovecode.tokens 150/15/5/2 by type attributed to the served provider/model, rovecode.request.duration count 2 with the stop reasons, rovecode.cost_usd priced, NO rovecode.request.retries; startTimeUnixNano = construction (before the run span), points stamped after it", async () => {
  const { set, ff, msgs, warnings } = make();
  await standardRun(set, ctx("r1"), msgs);
  await set.flush();
  expect(warnings).toEqual([]);
  expect(ff.posts.map((p) => new URL(p.url).pathname)).toEqual([TRACES, METRICS]); // MUTATION TARGET: metrics before traces, or no metrics at all
  const m = postsTo<OtlpMetricsRequest>(ff, METRICS)[0]!;
  expect(m.headers["content-type"]).toBe("application/json");
  const req = m.body;
  expect(tokenTotals(req)).toEqual({ input: "150", output: "15", cacheRead: "5", cacheWrite: "2" });
  const tokens = named(req, "rovecode.tokens")!;
  if (!("sum" in tokens)) throw new Error("tokens");
  for (const p of tokens.sum.dataPoints) { expect(attrOf(p.attributes, "rovecode.model.provider")).toBe("p"); expect(attrOf(p.attributes, "rovecode.model.model")).toBe("m"); }
  const dur = named(req, "rovecode.request.duration")!;
  if (!("histogram" in dur)) throw new Error("duration");
  expect(dur.histogram.dataPoints.map((p) => [attrOf(p.attributes, "rovecode.stop_reason"), p.count]).sort()).toEqual([["end_turn", "1"], ["tool_use", "1"]]);
  expect(dur.histogram.dataPoints.reduce((n, p) => n + Number(p.count), 0)).toBe(2); // one observation per rovecode.turn
  for (const p of dur.histogram.dataPoints) { expect(p.sum).toBeGreaterThan(0); expect(attrOf(p.attributes, "rovecode.model.provider")).toBe("p"); }
  const cost = named(req, "rovecode.cost_usd")!;
  if (!("sum" in cost)) throw new Error("cost");
  expect(cost.unit).toBe("USD"); expect(cost.sum.dataPoints[0]!.asDouble).toBeGreaterThan(0);
  expect(named(req, "rovecode.request.retries")).toBeUndefined();
  const runSpan = traces(ff)[0]!.body.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
  const start = BigInt(tokens.sum.dataPoints[0]!.startTimeUnixNano);
  expect(start < BigInt(runSpan.startTimeUnixNano)).toBe(true); // the cumulative window opened at construction
  expect(BigInt(tokens.sum.dataPoints[0]!.timeUnixNano) > BigInt(runSpan.endTimeUnixNano)).toBe(true);
  expect(JSON.stringify(req)).not.toContain('"g"'); // never the goal
});

test("a second standardRun → the second /v1/metrics POST carries FIRST + SECOND totals (300/30/10/4, duration count 4) — never reset; a minimalRun (no turns, no retries) POSTs traces only; the metrics POST count equals the runs that recorded something", async () => {
  const { set, ff, msgs } = make();
  await standardRun(set, ctx("r1"), msgs);
  await standardRun(set, ctx("r2"), msgs);
  await minimalRun(set, ctx("r3"));
  await set.flush();
  expect(traces(ff).length).toBe(3);
  const ms = postsTo<OtlpMetricsRequest>(ff, METRICS);
  expect(ms.length).toBe(2); // MUTATION TARGET: POST metrics on every post_run → 3
  expect(tokenTotals(ms[0]!.body)).toEqual({ input: "150", output: "15", cacheRead: "5", cacheWrite: "2" });
  expect(tokenTotals(ms[1]!.body)).toEqual({ input: "300", output: "30", cacheRead: "10", cacheWrite: "4" }); // MUTATION TARGET: reset after a POST (delta) → 150/15/5/2 again
  const dur = named(ms[1]!.body, "rovecode.request.duration")!;
  if (!("histogram" in dur)) throw new Error("duration");
  expect(dur.histogram.dataPoints.reduce((n, p) => n + Number(p.count), 0)).toBe(4);
  const s0 = named(ms[0]!.body, "rovecode.tokens")!, s1 = named(ms[1]!.body, "rovecode.tokens")!;
  if (!("sum" in s0) || !("sum" in s1)) throw new Error("tokens");
  expect(s1.sum.dataPoints[0]!.startTimeUnixNano).toBe(s0.sum.dataPoints[0]!.startTimeUnixNano); // one window since construction
  expect(BigInt(s1.sum.dataPoints[0]!.timeUnixNano) > BigInt(s0.sum.dataPoints[0]!.timeUnixNano)).toBe(true);
  // a set that only ever saw minimalRuns never POSTs metrics
  const idle = make();
  await minimalRun(idle.set, ctx("a")); await minimalRun(idle.set, ctx("b"));
  await idle.set.session_close!(ctx("b"));
  expect(postsTo(idle.ff, METRICS).length).toBe(0);
  expect(traces(idle.ff).length).toBe(2);
});

test("recordRetry ×2 (the provider retry tap) → rovecode.request.retries asInt \"2\" attributed to the note's provider/model with rovecode.retry.status 429 (classifyStreamError on the reason), a non-HTTP reason has no status attr, the reason text is NEVER in the payload; retries recorded with no run land at the next post_run (or session_close)", async () => {
  const { set, ff, msgs } = make();
  const model = { provider: "custom", model: "alpha" };
  set.recordRetry({ model, attempt: 1, maxAttempts: 3, delayMs: 5, reason: "HTTP 429: rate limited — slow down SECRET-REASON" });
  set.recordRetry({ model, attempt: 2, maxAttempts: 3, delayMs: 10, reason: "HTTP 429: rate limited — slow down SECRET-REASON", retryAfterMs: 10 });
  set.recordRetry({ model: { provider: "custom", model: "beta" }, attempt: 1, maxAttempts: 3, delayMs: 1, reason: "fetch failed: ECONNRESET" });
  await set.flush();
  expect(ff.posts.length).toBe(0); // nothing POSTs without a run boundary
  await standardRun(set, ctx("r1"), msgs);
  await set.flush();
  const req = postsTo<OtlpMetricsRequest>(ff, METRICS)[0]!.body;
  const retries = named(req, "rovecode.request.retries")!;
  if (!("sum" in retries)) throw new Error("retries");
  expect(retries.unit).toBe("{retry}"); expect(retries.sum.isMonotonic).toBe(true); expect(retries.sum.aggregationTemporality).toBe(2);
  const alpha = retries.sum.dataPoints.find((p) => attrOf(p.attributes, "rovecode.model.model") === "alpha")!;
  expect(alpha.asInt).toBe("2"); // MUTATION TARGET: drop the tap → no metric at all
  expect(attrOf(alpha.attributes, "rovecode.model.provider")).toBe("custom");
  expect(alpha.attributes.find((a) => a.key === "rovecode.retry.status")?.value).toEqual({ intValue: "429" });
  const beta = retries.sum.dataPoints.find((p) => attrOf(p.attributes, "rovecode.model.model") === "beta")!;
  expect(beta.asInt).toBe("1");
  expect(beta.attributes.some((a) => a.key === "rovecode.retry.status")).toBe(false);
  const raw = JSON.stringify(req);
  expect(raw).not.toContain("SECRET-REASON"); expect(raw).not.toContain("rate limited"); expect(raw).not.toContain("ECONNRESET");
  // a retry after the last run: session_close POSTs the leftover metrics once
  set.recordRetry({ model, attempt: 1, maxAttempts: 3, delayMs: 5, reason: "HTTP 503: down" });
  await set.session_close!(ctx("r1"));
  const ms = postsTo<OtlpMetricsRequest>(ff, METRICS);
  expect(ms.length).toBe(2);
  const late = named(ms[1]!.body, "rovecode.request.retries")!;
  if (!("sum" in late)) throw new Error("retries");
  expect(late.sum.dataPoints.reduce((n, p) => n + Number(p.asInt), 0)).toBe(4); // 2 + 1 + 1, cumulative
});

// ---------- the pipe: sibling paths, per-signal disable, per-export warnings ----------

test("sibling paths: a full …/v1/traces endpoint (or one with trailing slashes) still yields /v1/metrics and /v1/logs on the same base; headers ride every signal", async () => {
  expect(baseOf("http://h:4318/v1/traces/")).toBe("http://h:4318");
  expect(baseOf(" http://h:4318// ")).toBe("http://h:4318");
  expect(baseOf("https://otlp.example.com/api/otlp")).toBe("https://otlp.example.com/api/otlp");
  expect(signalUrl("http://h:4318/v1/traces", "metrics")).toBe("http://h:4318/v1/metrics");
  expect(signalUrl("http://h:4318", "logs")).toBe("http://h:4318/v1/logs");
  const { set, ff, msgs } = make({ endpoint: `${ENDPOINT}/v1/traces`, headers: { authorization: "Bearer t" } });
  await standardRun(set, ctx("r1"), msgs);
  await set.flush();
  expect(ff.posts.map((p) => p.url)).toEqual([`${ENDPOINT}/v1/traces`, `${ENDPOINT}/v1/metrics`]); // MUTATION TARGET: append /v1/metrics to the full traces URL → …/v1/traces/v1/metrics
  for (const p of ff.posts) expect(p.headers["authorization"]).toBe("Bearer t");
});

test("HTTP 404 on /v1/metrics → ONE note `OTLP collector <base> does not accept metrics (HTTP 404) — metrics export disabled`, traces still POST on every run, and NO further /v1/metrics POST is attempted (405/501 the same; a 500 stays a per-export warning and never disables)", async () => {
  const ff = fakeFetch((_n, url) => new Response("no such route", { status: url.endsWith(METRICS) ? 404 : 200 }));
  const { set, msgs, warnings } = make({ fetch: ff.fn });
  await standardRun(set, ctx("r1"), msgs);
  await set.flush();
  expect(warnings).toEqual([`OTLP collector ${ENDPOINT} does not accept metrics (HTTP 404) — metrics export disabled`]);
  expect(postsTo(ff, METRICS).length).toBe(1);
  await standardRun(set, ctx("r2"), msgs);
  await standardRun(set, ctx("r3"), msgs);
  await set.flush();
  expect(traces(ff).length).toBe(3); // the other signal continues
  expect(postsTo(ff, METRICS).length).toBe(1); // MUTATION TARGET: drop the auto-disable → 3 POSTs and 3 notes
  expect(warnings.length).toBe(1);
  for (const status of [405, 501]) {
    const f2 = fakeFetch((_n, url) => new Response("", { status: url.endsWith(METRICS) ? status : 200 }));
    const m2 = make({ fetch: f2.fn });
    await standardRun(m2.set, ctx("a"), m2.msgs); await standardRun(m2.set, ctx("b"), m2.msgs);
    await m2.set.flush();
    expect(m2.warnings).toEqual([`OTLP collector ${ENDPOINT} does not accept metrics (HTTP ${status}) — metrics export disabled`]);
    expect(postsTo(f2, METRICS).length).toBe(1);
  }
  // 500: the #39 per-export text, every run again, nothing disabled
  const f5 = fakeFetch((_n, url) => new Response("", { status: url.endsWith(METRICS) ? 500 : 200 }));
  const m5 = make({ fetch: f5.fn });
  await standardRun(m5.set, ctx("a"), m5.msgs); await standardRun(m5.set, ctx("b"), m5.msgs);
  await m5.set.flush();
  expect(m5.warnings).toEqual([`OTLP export to ${ENDPOINT}/v1/metrics failed: HTTP 500`, `OTLP export to ${ENDPOINT}/v1/metrics failed: HTTP 500`]);
  expect(postsTo(f5, METRICS).length).toBe(2);
  // the exporter alone: disabled() per signal, a 404 on traces leaves metrics/logs untouched
  const notes: string[] = [];
  const f4 = fakeFetch((_n, url) => new Response("", { status: url.endsWith(TRACES) ? 404 : 200 }));
  const ex = createOtlpExporter({ endpoint: ENDPOINT, fetch: f4.fn, warn: (n) => notes.push(n) });
  ex.post("traces", "{}"); ex.post("traces", "{}"); ex.post("metrics", "{}"); ex.post("logs", "{}");
  await ex.flush();
  ex.post("traces", "{}"); ex.post("metrics", "{}");
  await ex.flush();
  expect(ex.disabled("traces")).toBe(true); expect(ex.disabled("metrics")).toBe(false); expect(ex.disabled("logs")).toBe(false);
  expect(f4.posts.map((p) => new URL(p.url).pathname)).toEqual([TRACES, TRACES, METRICS, LOGS, METRICS]); // the two in-flight traces POSTs raced; nothing after the note
  expect(notes).toEqual([`OTLP collector ${ENDPOINT} does not accept traces (HTTP 404) — traces export disabled`]);
});

test("HTTP 500 on /v1/logs → the existing per-export warning text for the logs URL (the deferred-warning path is the same one #39 raises from the next lifecycle hook); a timeout on /v1/metrics names its URL; flush() awaits all three signals", async () => {
  const ff = fakeFetch((_n, url) => new Response("", { status: url.endsWith(LOGS) ? 500 : 200 }));
  const { set, msgs, warnings } = make({ fetch: ff.fn });
  const c = ctx("r1");
  await set.pre_run!(c);
  await set.on_event!(c, { type: "turn_start", turn: 1 });
  await set.on_event!(c, { type: "turn_end", turn: 1, stopReason: "tool_use" });
  await set.pre_tool!(c, { id: "c1", tool: "bash", args: { command: "ls" } });
  await set.approval!({ cwd: "/w", sessionId: "s1" }, { tool: "bash", args: { command: "ls" }, revisedArgs: { command: "ls" }, reason: "permission required" });
  await set.post_run!(c, { status: "stopped", summary: "run aborted" }); // the card was still up: one unanswered record → /v1/logs
  await set.flush();
  expect(ff.posts.map((p) => new URL(p.url).pathname)).toEqual([TRACES, METRICS, LOGS]);
  expect(warnings).toEqual([`OTLP export to ${ENDPOINT}/v1/logs failed: HTTP 500`]);
  const slow = fakeFetch((_n, url) => url.endsWith(METRICS) ? new Promise<Response>(() => {}) : new Response("{}"));
  const m = make({ fetch: slow.fn, timeoutMs: 40 });
  await standardRun(m.set, ctx("r1"), msgs);
  const t0 = Date.now();
  await m.set.flush();
  expect(Date.now() - t0).toBeGreaterThanOrEqual(35);
  expect(m.warnings).toEqual([`OTLP export to ${ENDPOINT}/v1/metrics failed: timed out after 40ms`]);
  expect(postsTo(slow, METRICS).length).toBe(1);
});
