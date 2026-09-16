/** PORT #39 — OpenTelemetry span export over the port-#29 hook seam (ADR-010: spans exportable as
 *  OTel; per-step token/latency/cost accounting). A consumer of core/hooks.ts, nothing more: it is a
 *  HookSet attached with `hooks.add(set, "otel")`, so the loop/tools/runner stay untouched.
 *
 *  Naming: every span, event and attribute is `rovecode.*` and the resource service.name / scope name is
 *  `rovecode`. Ported on 2026-09-07 from the upstream harness's telemetry layer, where the same shapes
 *  carried that harness's own prefix; collectors keyed on those names must be re-pointed (no dual emission).
 *
 *  Shape — ONE trace per run: `rovecode.run` (pre_run → post_run) ⊃ `rovecode.turn` (turn_start → turn_end,
 *  one per model iteration) ⊃ `rovecode.tool` (pre_tool → post_tool; parent = the turn that ISSUED the
 *  call). The loop yields turn_end BEFORE it executes the turn's calls (core/loop.ts:232 then :295),
 *  so a tool span starts after its parent turn ended — OTLP permits a child to outlive its parent and
 *  the run span brackets everything; keeping the turn = the model step keeps its latency honest.
 *  Per-step accounting reads the ONE source of usage, the session store (Message.usage/origin — the
 *  tui/cost.ts + cli/output.ts idiom): each turn span carries the tokens/cost of the assistant message
 *  it appended, the run span the sums since the run began; latency is the span itself. Compactions
 *  and calls that never reached pre_tool (policy deny, unknown tool, truncated) become span EVENTS on
 *  the current turn (`rovecode.compaction`, `rovecode.tool_call_failed`) — a zero-length "step" is noise as a
 *  span. Attribute policy follows pi (telemetry/README.md:387-389): ids, sizes and outcomes only —
 *  never the goal, tool args/output, headers or credentials (output_bytes, not output).
 *
 *  Export — hand-encoded OTLP/HTTP JSON (ids as hex, int64 as decimal strings, enums as integers)
 *  through ONE exporter for three signals (otel-export.ts, port #82): the run's trace is POSTed ONCE at
 *  post_run to <base>/v1/traces (ROVECODE_OTEL_ENDPOINT with or without the suffix; ROVECODE_OTEL_HEADERS
 *  "k=v,k2=v2" ride along), then — same run, same order — the CUMULATIVE metrics to <base>/v1/metrics
 *  when anything was recorded (otel-metrics.ts: rovecode.tokens by type, rovecode.request.duration histogram
 *  per turn, rovecode.request.retries from the provider retry tap, rovecode.cost_usd when priced; totals since
 *  construction, never reset) and the run's approval log records to <base>/v1/logs when there were any
 *  (otel-logs.ts: the EXISTING `approval` member records each card and returns void — the human is still
 *  asked; allow/deny are observed from the tool events, a card still pending at post_run is `unanswered`).
 *  Every external lane (TaskInfo.kind "external", observed through TaskManager.subscribe via observeTasks)
 *  is ONE `rovecode.lane` root span in its own trace, POSTed when the task settles (otel-lanes.ts). Each POST
 *  is fire-and-forget on a 5s REF'D timer, tracked so flush() and session_close await the outstanding
 *  ones; post_run never blocks the run and the export path never throws. A failed export is ONE bounded
 *  warning: direct consumers pass onWarning; the runtime wiring has no write access to hooks.warnings, so
 *  the set remembers the failure and raises it from its NEXT lifecycle hook (pre_run of the following run,
 *  or session_close), which the runner's isolation records as exactly one note ("otel: … hook threw: OTLP
 *  export to … failed …") that every surface already streams. The raise happens after that hook's own
 *  work. A collector answering 404/405/501 on one signal switches THAT signal off after one note (the
 *  others continue); 5xx/timeout/network stay per-export warnings.
 *
 *  ZERO OVERHEAD OFF — cli/runtime.ts calls createOtelHooks ONLY when ROVECODE_OTEL_ENDPOINT is set; off,
 *  no set is attached, the runner's tap short-circuits (hooks.ts:272), TaskManager.subscribe is never
 *  called by telemetry and the retry tap is one null check. otelDebug.constructed is the spy the off-path
 *  test pins ("exporter never constructed"); otelDebug.lanesObserved the same for observeTasks.
 *
 *  Run boundaries (fix-wave 4, #39): post_run is the export trigger, and core/loop.ts fires it for a
 *  run whose CONSUMER closed the generator (serve disconnect, ACP cancel, TUI Esc: hooks.ts
 *  observer.close) with status "stopped" — cancelled runs export and release their RunState;
 *  session_close still drains a leftover state (a generator dropped without .return()) as "stopped"
 *  before its flush. Tool spans are keyed per issuing turn, so a call id a provider reuses across
 *  turns (the SSE adapter's `tc<idx>` fallback, providers/stream.ts) is one span PER TURN.
 *  `rovecode.tool_calls` counts ISSUED calls — dispatched (spans) plus never-dispatched (tool_call_failed
 *  events) — the same count as `rovecode run --output json` toolCalls (cli/output.ts keys per issuing turn
 *  too, LOW-B), with ONE residual: a run aborted while a call waited between its pre_tool hook and its
 *  execution (tools.ts:141 returns without an event) has that call as a span but no toolCalls entry —
 *  the hook side saw pre_tool, the event side saw nothing. A guard-stubbed call (tool events without a
 *  pre_tool) carries rovecode.failure_reason=loop_guard. An endpoint that is not an absolute http(s) URL
 *  (`http://`, `host:4318`) disables export with ONE note instead of a 5 s stall per run against host "v1".
 *
 *  Sources (pi @ 853a80d, MIT — naming/shape reference, no code copied; header credit only):
 *  - packages/agent/src/harness/telemetry.ts:235-256 `pi.harness.run` (outcome attribute; status error
 *    when the run fails), :327-352 `pi.harness.turn` ("one assistant response and its tool batch",
 *    parent run), :399-451 `pi.harness.tool` (parents turn|run; `pi.tool.name`, `pi.tool.call_id`,
 *    `pi.tool.is_error`; status error when execution returns an error) → rovecode.run / rovecode.turn /
 *    rovecode.tool with rovecode.status, rovecode.turn, rovecode.tool, rovecode.call_id, rovecode.ok.
 *  - :94-103 `pi.ai.usage.{input,output,cache_read,cache_write}_tokens` + `.cost`, :88-92
 *    `pi.ai.response.stop_reason`, :55-64 `pi.ai.provider`/`pi.ai.model`, :194 `pi.session.id` →
 *    rovecode.tokens.{input,output,cacheRead,cacheWrite} (NormalizedUsage spelling), rovecode.cost_usd,
 *    rovecode.stop_reason, rovecode.model.provider/model, rovecode.session_id.
 *  Deviations: pi ships no exporter (telemetry/README.md:11 — adapter-owned) and records no timestamps
 *  (memory.ts:203-218); rovecode ships the OTLP/HTTP exporter and wall-clock ns times. The metric and log
 *  families' pattern sources are credited in otel-metrics.ts / otel-logs.ts. */

import type { HookCtx, HookSet, HookToolCall, RunResult } from "../core/hooks.ts";
import type { ApprovalRequest, Message, RunEvent, ToolOutput } from "../core/types.ts";
import { costUsd, type PricingRow } from "../core/usage.ts";
import { ModelCatalog } from "../providers/catalog.ts";
import type { RetryNote } from "../providers/retry.ts";
import { classifyStreamError } from "../providers/router.ts";
import { createOtlpExporter, hex, validEndpoint } from "./otel-export.ts";
import { observeLanes, type LaneSource } from "./otel-lanes.ts";
import { argsFingerprint, createApprovalLedger, encodeLogsRequest, type ApprovalIds } from "./otel-logs.ts";
import { createMetrics, DURATION_BOUNDS, type MetricAttrs } from "./otel-metrics.ts";
import { bool, dbl, encodeTraceRequest, int, str, type OtelSpan, type OtlpValue } from "./otlp.ts";

// wire types + encoder live in otlp.ts (pure), the pipe in otel-export.ts; re-exported so this stays the module consumers import
export { encodeTraceRequest, unixNano, type OtelSpan, type OtlpKeyValue, type OtlpSpan, type OtlpTraceRequest, type OtlpValue } from "./otlp.ts";
export { DEFAULT_EXPORT_TIMEOUT_MS, OTLP_TRACES_PATH, baseOf, normalizeEndpoint, signalUrl, validEndpoint, type OtlpSignal } from "./otel-export.ts";
export type { OtlpMetricsRequest } from "./otel-metrics.ts";
export type { OtlpLogsRequest } from "./otel-logs.ts";

/** test spy: exporters constructed / TaskManagers observed in this process — the off-path bar is "never" */
export const otelDebug = { constructed: 0, lanesObserved: 0 };

/** ModelCatalog.lookup's shape (cli/output.ts PricingSource); tests inject fixed pricing */
export interface PricingSource { lookup(provider: string, model: string): { pricing?: PricingRow } | undefined }

export interface OtelOptions {
  /** collector base URL (…/v1/traces is appended) or the full traces URL */
  endpoint: string;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
  /** wall clock in ms (fractions kept); default performance.timeOrigin + performance.now() */
  now?: () => number;
  /** resource service.name; default "rovecode" */
  serviceName?: string;
  /** live view of the session store — usage/origin per assistant message */
  messages: () => Message[];
  /** per-message pricing (Message.origin → row); default: a ModelCatalog built at the first export */
  pricing?: PricingSource;
  timeoutMs?: number;
  /** export failures for direct consumers; absent → raised through the runner (header) */
  onWarning?: (note: string) => void;
  /** the lane seam (#47 external agentic-CLI lanes): is this `task start` agent value an external lane's adapter
   *  id? The approval record carries it as rovecode.lane. Default: nothing is a lane — a plain child agent must
   *  never be tagged as one — until the runtime injects src/lanes/types.ts isAdapterId (a follow-up outside this
   *  module, so neither side waits on the other to typecheck). */
  isLane?: (agent: unknown) => agent is string;
}
export interface OtelHooks extends HookSet {
  flush(): Promise<void>;
  /** runs recorded but not yet exported — 0 once every run reached post_run (diagnostic seam) */
  openRuns(): number;
  /** #82: one `rovecode.lane` root span per external lane that ran (TaskManager.subscribe); returns the unsubscribe */
  observeTasks(tasks: LaneSource): () => void;
  /** #82: the provider retry tap (boot-provider.ts onRetry) → rovecode.request.retries */
  recordRetry(note: RetryNote): void;
}

// ---------- per-run state ----------

interface RunState {
  run: OtelSpan; spans: OtelSpan[]; turn?: OtelSpan; lastTurn?: OtelSpan;
  /** tool spans by `<issuing turn spanId>:<callId>` — a reused id is a new span in a new turn */
  tools: Map<string, OtelSpan>;
  /** #82: spans opened by pre_tool that have not executed yet → their args fingerprint (approval correlation) */
  awaiting: Map<OtelSpan, string | null>;
  /** issued calls: dispatched (spans) + never-dispatched (tool_call_failed events) */
  calls: number;
  /** store length at pre_run (run totals) and at the last turn_end (per-turn usage) */
  baseline: number; seen: number;
}

const OK: OtelSpan["status"] = { code: 1 };
const ERROR = (message: string): OtelSpan["status"] => ({ code: 2, message });
const TOKEN_TYPES = ["input", "output", "cacheRead", "cacheWrite"] as const;

// ---------- env / endpoint / headers ----------

/** null unless ROVECODE_OTEL_ENDPOINT is set (blank = unset) — the runtime constructs nothing on null */
export function otelOptionsFromEnv(env: Record<string, string | undefined> = process.env): Pick<OtelOptions, "endpoint" | "headers"> | null {
  const endpoint = (env["ROVECODE_OTEL_ENDPOINT"] ?? "").trim();
  return endpoint ? { endpoint, headers: parseOtelHeaders(env["ROVECODE_OTEL_HEADERS"]) } : null;
}

/** "k=v,k2=v2" (OTEL_EXPORTER_OTLP_HEADERS shape): first "=" splits, so values may contain "=";
 *  blank or key-less entries are skipped; values are taken raw (no percent-decoding). */
export function parseOtelHeaders(text: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (text ?? "").split(",")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    if (key) out[key] = part.slice(eq + 1).trim();
  }
  return out;
}

// ---------- the hook set ----------

export function createOtelHooks(opts: OtelOptions): OtelHooks {
  otelDebug.constructed++;
  const now = opts.now ?? defaultNow;
  const service = opts.serviceName ?? "rovecode";
  const isLane = opts.isLane ?? ((_agent: unknown): _agent is string => false);
  let pricing: PricingSource | undefined = opts.pricing;
  const runs = new Map<string, RunState>();
  let failed = 0, lastFailure = "";
  const warn = (note: string): void => {
    if (opts.onWarning) { opts.onWarning(note); return; }
    failed++; lastFailure = note;
  };
  const exporter = createOtlpExporter({ endpoint: opts.endpoint, headers: opts.headers, fetch: opts.fetch, timeoutMs: opts.timeoutMs, warn });
  const metrics = createMetrics(now()); // the cumulative window starts at construction (never reset)
  const ledger = createApprovalLedger();
  const unobserve: (() => void)[] = [];
  // ONE note at construction (raised by the first lifecycle hook), then no POSTs
  if (!validEndpoint(opts.endpoint)) warn(`ROVECODE_OTEL_ENDPOINT ${JSON.stringify(opts.endpoint)} is not an absolute http(s) URL — OTel export disabled`);

  const stateOf = (ctx: HookCtx): RunState | undefined => (ctx.runId === undefined ? undefined : runs.get(ctx.runId));
  const attach = (st: RunState, name: string, parent: OtelSpan): OtelSpan => {
    const s: OtelSpan = { traceId: st.run.traceId, spanId: hex(8), parentSpanId: parent.spanId, name, start: now(), attrs: new Map(), events: [], status: { code: 0 } };
    st.spans.push(s);
    return s;
  };
  const end = (s: OtelSpan, status: OtelSpan["status"]): void => { if (s.end === undefined) { s.end = now(); s.status = status; } };
  const event = (s: OtelSpan, name: string, attrs: [string, OtlpValue][]): void => { s.events.push({ name, time: now(), attrs: new Map(attrs) }); };
  const strAttr = (s: OtelSpan, key: string): string | undefined => { const v = s.attrs.get(key); return v && "stringValue" in v ? v.stringValue : undefined; };
  /** a call's parent = the turn that issued it (turn_end precedes the turn's tool events — header) */
  const issuer = (st: RunState): OtelSpan => st.lastTurn ?? st.run;
  const toolKey = (st: RunState, callId: string): string => `${issuer(st).spanId}:${callId}`;
  /** the tool span for a call — opened by whichever of pre_tool / tool_execution_start arrives first;
   *  a span the START event has to open never saw pre_tool: the loop-guard stub path (tools.ts:88-93) */
  const openTool = (st: RunState, callId: string, tool?: string, fromStart = false): OtelSpan => {
    const key = toolKey(st, callId);
    let s = st.tools.get(key);
    if (!s) {
      s = attach(st, "rovecode.tool", issuer(st));
      s.attrs.set("rovecode.call_id", str(callId));
      if (fromStart) s.attrs.set("rovecode.failure_reason", str("loop_guard"));
      st.tools.set(key, s);
      st.calls++;
    }
    if (tool !== undefined && !s.attrs.has("rovecode.tool")) s.attrs.set("rovecode.tool", str(tool));
    return s;
  };
  const settleTool = (s: OtelSpan, ok: boolean, output: string): void => {
    if (s.end !== undefined) return; // post_tool already settled it; tool_execution_end only adds duration
    s.attrs.set("rovecode.ok", bool(ok));
    s.attrs.set("rovecode.output_bytes", int(Buffer.byteLength(output, "utf8")));
    end(s, ok ? OK : ERROR(`tool ${strAttr(s, "rovecode.tool") ?? "call"} failed`));
  };
  /** tokens summed + cost priced PER MESSAGE at Message.origin (cli/output.ts summarize): any
   *  usage-bearing message without catalog pricing → cost unknown → attribute omitted, never 0 */
  const account = (s: OtelSpan, msgs: Message[]) => {
    const u = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    let cost: number | null = 0;
    for (const m of msgs) {
      if (!m.usage) continue;
      const n = { input: m.usage.input, output: m.usage.output, cacheRead: m.usage.cacheRead ?? 0, cacheWrite: m.usage.cacheWrite ?? 0 };
      u.input += n.input; u.output += n.output; u.cacheRead += n.cacheRead; u.cacheWrite += n.cacheWrite;
      if (cost === null || (n.input === 0 && n.output === 0 && n.cacheRead === 0 && n.cacheWrite === 0)) continue;
      const row = m.origin ? (pricing ??= new ModelCatalog()).lookup(m.origin.provider, m.origin.model)?.pricing : undefined;
      const c = row ? costUsd(n, row) : undefined;
      cost = c === undefined ? null : cost + c;
    }
    for (const k of TOKEN_TYPES) s.attrs.set(`rovecode.tokens.${k}`, int(u[k]));
    if (cost !== null) s.attrs.set("rovecode.cost_usd", dbl(cost));
    const served = msgs.at(-1)?.origin; // the model that SERVED (router fallback may differ from the request)
    if (served) { s.attrs.set("rovecode.model.provider", str(served.provider)); s.attrs.set("rovecode.model.model", str(served.model)); }
    return { u, cost, served };
  };
  const modelAttrs = (m: { provider: string; model: string } | undefined): MetricAttrs => (m ? [["rovecode.model.provider", str(m.provider)], ["rovecode.model.model", str(m.model)]] : []);
  /** #82 metrics: the turn's usage/cost into the cumulative Sums, its latency into the duration histogram */
  const feedTurn = (t: OtelSpan, acc: ReturnType<typeof account>, stopReason: string): void => {
    const model = modelAttrs(acc.served);
    for (const k of TOKEN_TYPES) metrics.addSum("rovecode.tokens", "{token}", [["rovecode.token.type", str(k)], ...model], acc.u[k]);
    if (acc.cost !== null) metrics.addSum("rovecode.cost_usd", "USD", model, acc.cost, true);
    metrics.recordHistogram("rovecode.request.duration", "ms", DURATION_BOUNDS, [...model, ["rovecode.stop_reason", str(stopReason)]], (t.end ?? now()) - t.start);
  };
  // --- #82 approval correlation (otel-logs.ts header): pre_tool ran before the card, so the call's span is "awaiting" ---
  const awaitingFor = (tool: string): number => { let n = 0; for (const st of runs.values()) for (const s of st.awaiting.keys()) if (strAttr(s, "rovecode.tool") === tool) n++; return n; };
  /** the span executed (allow) or was refused (deny): answer the oldest matching card; ids only for a lone candidate */
  const settleApproval = (st: RunState, s: OtelSpan, decision: "allow" | "deny"): void => {
    const fp = st.awaiting.get(s);
    if (fp === undefined) return; // not awaiting: already resolved, or opened by the start event (loop guard)
    const tool = strAttr(s, "rovecode.tool");
    if (tool === undefined || ledger.pendingFor(tool) === 0) { st.awaiting.delete(s); return; }
    const lone = awaitingFor(tool) === 1; // this span is the ONLY same-tool span still awaiting execution
    st.awaiting.delete(s);
    const ids: ApprovalIds | undefined = lone ? { traceId: s.traceId, spanId: s.spanId, callId: strAttr(s, "rovecode.call_id") ?? "" } : undefined;
    ledger.resolve(tool, fp, decision, now(), ids);
  };

  // --- export ---
  /** deferred failure → thrown from a lifecycle hook → one runner warning (header); no-op with onWarning */
  const raise = (): void => {
    if (failed === 0) return;
    const n = failed; failed = 0;
    throw new Error(n === 1 ? lastFailure : `${lastFailure} (${n} exports failed)`);
  };
  const postMetrics = (): void => { if (metrics.dirty) exporter.post("metrics", JSON.stringify(metrics.encode(service, now()))); };
  const postLogs = (): void => { const recs = ledger.take(); if (recs.length > 0) exporter.post("logs", JSON.stringify(encodeLogsRequest(service, recs))); };
  /** the run's end: open turn/tool spans close here (status UNSET), totals + status land on the run
   *  span, ONE traces POST — then metrics (if anything was recorded) and the run's approval records */
  const finish = (st: RunState, status: RunResult["status"]): void => {
    const t = now();
    for (const s of st.spans) if (s.end === undefined && s !== st.run) s.end = t;
    st.run.attrs.set("rovecode.status", str(status));
    st.run.attrs.set("rovecode.turns", int(st.spans.filter((s) => s.name === "rovecode.turn").length));
    st.run.attrs.set("rovecode.tool_calls", int(st.calls));
    account(st.run, opts.messages().slice(st.baseline).filter((m) => m.role === "assistant"));
    st.run.end = t;
    st.run.status = status === "done" || status === "stopped" ? OK : ERROR(status); // budget/error did not complete
    exporter.post("traces", JSON.stringify(encodeTraceRequest(service, st.spans)));
    ledger.drain(t); // a card still up when the run ended → unanswered (tools.ts:141: no event follows)
    postMetrics(); postLogs();
  };

  return {
    flush: () => exporter.flush(),
    openRuns: () => runs.size,
    observeTasks(tasks) {
      otelDebug.lanesObserved++;
      const off = observeLanes(tasks, (s) => exporter.post("traces", JSON.stringify(encodeTraceRequest(service, [s]))), now);
      unobserve.push(off);
      return off;
    },
    recordRetry(note) {
      const status = classifyStreamError(note.reason).status; // the status only — never the reason text
      metrics.addSum("rovecode.request.retries", "{retry}", [...modelAttrs(note.model), ...(status !== undefined ? [["rovecode.retry.status", int(status)] as const] : [])], 1);
    },
    pre_run(ctx) {
      if (ctx.runId === undefined) return;
      const run: OtelSpan = { traceId: hex(16), spanId: hex(8), name: "rovecode.run", start: now(), attrs: new Map(), events: [], status: { code: 0 } };
      run.attrs.set("rovecode.session_id", str(ctx.sessionId)); run.attrs.set("rovecode.run_id", str(ctx.runId));
      const len = opts.messages().length;
      runs.set(ctx.runId, { run, spans: [run], tools: new Map(), awaiting: new Map(), calls: 0, baseline: len, seen: len });
      raise();
    },
    on_event(ctx, ev: RunEvent) {
      const st = stateOf(ctx);
      if (!st) return;
      switch (ev.type) {
        case "turn_start": {
          if (st.turn) end(st.turn, st.turn.status); // defensive: the loop never nests turns
          st.turn = st.lastTurn = attach(st, "rovecode.turn", st.run);
          st.turn.attrs.set("rovecode.turn", int(ev.turn));
          break;
        }
        case "turn_end": {
          const t = st.turn ?? st.lastTurn;
          if (!t) break;
          t.attrs.set("rovecode.stop_reason", str(ev.stopReason));
          const msgs = opts.messages();
          const acc = account(t, msgs.slice(st.seen).filter((m) => m.role === "assistant"));
          st.seen = msgs.length;
          end(t, ev.stopReason === "error" ? ERROR("error") : OK);
          feedTurn(t, acc, ev.stopReason);
          st.turn = undefined;
          break;
        }
        case "tool_execution_start": settleApproval(st, openTool(st, ev.callId, ev.tool, true), "allow"); break;
        case "tool_execution_end": {
          const s = openTool(st, ev.callId);
          st.awaiting.delete(s);
          s.attrs.set("rovecode.duration_ms", int(ev.durationMs)); // the dispatcher's own measure (tools.ts:170)
          settleTool(s, ev.ok, ev.output);
          break;
        }
        case "tool_call_failed": {
          const s = st.tools.get(toolKey(st, ev.callId));
          if (s) {
            if (ev.reason === "permission_denied") settleApproval(st, s, "deny"); else st.awaiting.delete(s);
            s.attrs.set("rovecode.ok", bool(false)); s.attrs.set("rovecode.failure_reason", str(ev.reason)); end(s, ERROR(ev.reason));
          } else { st.calls++; event(st.turn ?? st.lastTurn ?? st.run, "rovecode.tool_call_failed", [["rovecode.call_id", str(ev.callId)], ["rovecode.failure_reason", str(ev.reason)]]); }
          break;
        }
        case "compaction":
          event(st.turn ?? st.run, "rovecode.compaction", [
            ["rovecode.compaction.strategy", str(ev.strategy)], ...(ev.trigger ? [["rovecode.compaction.trigger", str(ev.trigger)] as [string, OtlpValue]] : []),
            ["rovecode.compaction.tokens_before", int(ev.tokensBefore)], ["rovecode.compaction.tokens_after", int(ev.tokensAfter)],
          ]);
          break;
        default: break; // run_start/run_end ride pre_run/post_run; deltas, progress notes and steers are not spans
      }
    },
    pre_tool(ctx, call: HookToolCall) {
      const st = stateOf(ctx);
      if (!st) return;
      const s = openTool(st, call.id, call.tool);
      if (s.end === undefined && !s.attrs.has("rovecode.ok")) st.awaiting.set(s, argsFingerprint(call.args)); // awaiting execution until an event says otherwise
    },
    post_tool(ctx, call: HookToolCall, result: ToolOutput) {
      const st = stateOf(ctx);
      if (!st) return;
      const s = openTool(st, call.id, call.tool);
      settleApproval(st, s, "allow"); // the tool ran, so its card (if any) was allowed — post_tool precedes the buffered start event
      settleTool(s, result.ok, result.output);
    },
    /** #82: records the card and returns void — the human (or the next set) still decides; the decision is observed from the events */
    approval(ctx, req: ApprovalRequest) {
      const args = req.revisedArgs;
      const agent = req.tool === "task" && typeof args === "object" && args !== null ? (args as Record<string, unknown>)["agent"] : undefined;
      const fp = argsFingerprint(req.args);
      const known = fp !== null && [...runs.values()].some((st) => [...st.awaiting].some(([s, f]) => f === fp && strAttr(s, "rovecode.tool") === req.tool));
      ledger.request({ tool: req.tool, sessionId: ctx.sessionId, ...(isLane(agent) ? { lane: agent } : {}), fp: known ? fp : null, at: now() });
    },
    post_run(ctx, result: RunResult) {
      const st = stateOf(ctx);
      if (!st) return;
      runs.delete(ctx.runId!);
      finish(st, result.status);
    },
    async session_close() {
      // belt and braces (#39 MED-1): a run whose generator was dropped without .return() never reached
      // post_run — export what it recorded as "stopped" (open spans close UNSET) instead of leaking it
      for (const [id, st] of runs) { runs.delete(id); finish(st, "stopped"); }
      for (const off of unobserve.splice(0)) off();
      ledger.drain(now()); postMetrics(); postLogs(); // leftovers: retries after the last run, cards no run closed
      await exporter.flush(); raise();
    },
  };
}

const defaultNow = (): number => performance.timeOrigin + performance.now();
