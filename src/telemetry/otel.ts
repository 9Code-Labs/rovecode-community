/** PORT #39 — OpenTelemetry span export over the port-#29 hook seam (ADR-010: spans exportable as
 *  OTel; per-step token/latency/cost accounting). A consumer of core/hooks.ts, nothing more: it is a
 *  HookSet attached with `hooks.add(set, "otel")`, so the loop/tools/runner stay untouched.
 *
 *  Shape — ONE trace per run: `aion.run` (pre_run → post_run) ⊃ `aion.turn` (turn_start → turn_end,
 *  one per model iteration) ⊃ `aion.tool` (pre_tool → post_tool; parent = the turn that ISSUED the
 *  call). The loop yields turn_end BEFORE it executes the turn's calls (core/loop.ts:232 then :295),
 *  so a tool span starts after its parent turn ended — OTLP permits a child to outlive its parent and
 *  the run span brackets everything; keeping the turn = the model step keeps its latency honest.
 *  Per-step accounting reads the ONE source of usage, the session store (Message.usage/origin — the
 *  tui/cost.ts + cli/output.ts idiom): each turn span carries the tokens/cost of the assistant message
 *  it appended, the run span the sums since the run began; latency is the span itself. Compactions
 *  and calls that never reached pre_tool (policy deny, unknown tool, truncated) become span EVENTS on
 *  the current turn (`aion.compaction`, `aion.tool_call_failed`) — a zero-length "step" is noise as a
 *  span. Attribute policy follows pi (telemetry/README.md:387-389): ids, sizes and outcomes only —
 *  never the goal, tool args/output, headers or credentials (output_bytes, not output).
 *
 *  Export — hand-encoded OTLP/HTTP JSON (ExportTraceServiceRequest; OTLP/JSON mapping: ids as hex,
 *  int64 as decimal strings, enums as integers) POSTed ONCE per run at post_run to <endpoint>/v1/traces
 *  (AION_OTEL_ENDPOINT with or without the suffix; AION_OTEL_HEADERS "k=v,k2=v2" ride along). The POST
 *  is fire-and-forget on a 5s REF'D timer (hooks.ts withTimeout idiom — Bun unrefs AbortSignal.timeout),
 *  tracked so flush() and session_close await the outstanding ones; post_run never blocks the run and
 *  the export path never throws. A failed export is ONE bounded warning: direct consumers pass
 *  onWarning; the runtime wiring has no write access to hooks.warnings, so the set remembers the
 *  failure and raises it from its NEXT lifecycle hook (pre_run of the following run, or session_close),
 *  which the runner's isolation records as exactly one note ("otel: … hook threw: OTLP export to …
 *  failed …") that every surface already streams. The raise happens after that hook's own work.
 *
 *  ZERO OVERHEAD OFF — cli/runtime.ts calls createOtelHooks ONLY when AION_OTEL_ENDPOINT is set; off,
 *  no set is attached and the runner's tap short-circuits (hooks.ts:272). otelDebug.constructed is the
 *  spy the off-path test pins ("exporter never constructed").
 *
 *  Run boundaries (fix-wave 4, #39): post_run is the export trigger, and core/loop.ts fires it for a
 *  run whose CONSUMER closed the generator (serve disconnect, ACP cancel, TUI Esc: hooks.ts
 *  observer.close) with status "stopped" — cancelled runs export and release their RunState;
 *  session_close still drains a leftover state (a generator dropped without .return()) as "stopped"
 *  before its flush. Tool spans are keyed per issuing turn, so a call id a provider reuses across
 *  turns (the SSE adapter's `tc<idx>` fallback, providers/stream.ts) is one span PER TURN.
 *  `aion.tool_calls` counts ISSUED calls — dispatched (spans) plus never-dispatched (tool_call_failed
 *  events) — the same count as `aion run --output json` toolCalls (cli/output.ts keys per issuing turn
 *  too, LOW-B), with ONE residual: a run aborted while a call waited between its pre_tool hook and its
 *  execution (tools.ts:141 returns without an event) has that call as a span but no toolCalls entry —
 *  the hook side saw pre_tool, the event side saw nothing. A guard-stubbed
 *  call (tool events without a pre_tool) carries aion.failure_reason=loop_guard. An endpoint that is
 *  not an absolute http(s) URL (`http://`, `host:4318`) disables export with ONE note instead of a
 *  5 s stall per run against host "v1".
 *
 *  Sources (pi @ 853a80d, MIT — naming/shape reference, no code copied; header credit only):
 *  - packages/agent/src/harness/telemetry.ts:235-256 `pi.harness.run` (outcome attribute; status error
 *    when the run fails), :327-352 `pi.harness.turn` ("one assistant response and its tool batch",
 *    parent run), :399-451 `pi.harness.tool` (parents turn|run; `pi.tool.name`, `pi.tool.call_id`,
 *    `pi.tool.is_error`; status error when execution returns an error) → aion.run / aion.turn /
 *    aion.tool with aion.status, aion.turn, aion.tool, aion.call_id, aion.ok.
 *  - :94-103 `pi.ai.usage.{input,output,cache_read,cache_write}_tokens` + `.cost`, :88-92
 *    `pi.ai.response.stop_reason`, :55-64 `pi.ai.provider`/`pi.ai.model`, :194 `pi.session.id` →
 *    aion.tokens.{input,output,cacheRead,cacheWrite} (NormalizedUsage spelling), aion.cost_usd,
 *    aion.stop_reason, aion.model.provider/model, aion.session_id.
 *  Deviations: pi ships no exporter (telemetry/README.md:11 — adapter-owned) and records no timestamps
 *  (memory.ts:203-218); aion ships the OTLP/HTTP exporter and wall-clock ns times. */

import { randomBytes } from "node:crypto";
import type { HookCtx, HookSet, HookToolCall, RunResult } from "../core/hooks.ts";
import type { Message, RunEvent, ToolOutput } from "../core/types.ts";
import { costUsd, type PricingRow } from "../core/usage.ts";
import { ModelCatalog } from "../providers/catalog.ts";
import { bool, dbl, encodeTraceRequest, int, str, type OtelSpan, type OtlpValue } from "./otlp.ts";

// wire types + encoder live in otlp.ts (pure); re-exported so this stays the module consumers import
export { encodeTraceRequest, unixNano, type OtelSpan, type OtlpKeyValue, type OtlpSpan, type OtlpTraceRequest, type OtlpValue } from "./otlp.ts";

export const DEFAULT_EXPORT_TIMEOUT_MS = 5000;
export const OTLP_TRACES_PATH = "/v1/traces";
/** test spy: exporters constructed in this process — the off-path bar is "never constructed" */
export const otelDebug = { constructed: 0 };

/** ModelCatalog.lookup's shape (cli/output.ts PricingSource); tests inject fixed pricing */
export interface PricingSource { lookup(provider: string, model: string): { pricing?: PricingRow } | undefined }

export interface OtelOptions {
  /** collector base URL (…/v1/traces is appended) or the full traces URL */
  endpoint: string;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
  /** wall clock in ms (fractions kept); default performance.timeOrigin + performance.now() */
  now?: () => number;
  /** resource service.name; default "aion" */
  serviceName?: string;
  /** live view of the session store — usage/origin per assistant message */
  messages: () => Message[];
  /** per-message pricing (Message.origin → row); default: a ModelCatalog built at the first export */
  pricing?: PricingSource;
  timeoutMs?: number;
  /** export failures for direct consumers; absent → raised through the runner (header) */
  onWarning?: (note: string) => void;
}
export interface OtelHooks extends HookSet {
  flush(): Promise<void>;
  /** runs recorded but not yet exported — 0 once every run reached post_run (diagnostic seam) */
  openRuns(): number;
}

// ---------- per-run state ----------

interface RunState {
  run: OtelSpan; spans: OtelSpan[]; turn?: OtelSpan; lastTurn?: OtelSpan;
  /** tool spans by `<issuing turn spanId>:<callId>` — a reused id is a new span in a new turn */
  tools: Map<string, OtelSpan>;
  /** issued calls: dispatched (spans) + never-dispatched (tool_call_failed events) */
  calls: number;
  /** store length at pre_run (run totals) and at the last turn_end (per-turn usage) */
  baseline: number; seen: number;
}

const OK: OtelSpan["status"] = { code: 1 };
const ERROR = (message: string): OtelSpan["status"] => ({ code: 2, message });

// ---------- env / endpoint / headers ----------

/** null unless AION_OTEL_ENDPOINT is set (blank = unset) — the runtime constructs nothing on null */
export function otelOptionsFromEnv(env: Record<string, string | undefined> = process.env): Pick<OtelOptions, "endpoint" | "headers"> | null {
  const endpoint = (env["AION_OTEL_ENDPOINT"] ?? "").trim();
  return endpoint ? { endpoint, headers: parseOtelHeaders(env["AION_OTEL_HEADERS"]) } : null;
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

/** base URL or full traces URL (either, with or without trailing slashes) → <base>/v1/traces */
export function normalizeEndpoint(endpoint: string): string {
  const base = endpoint.trim().replace(/\/+$/, "");
  return base.endsWith(OTLP_TRACES_PATH) ? base : base + OTLP_TRACES_PATH;
}

/** an absolute http(s) URL with a host — `http://` does not parse and `host:4318` parses host-less,
 *  and both would normalize to `http:/v1/traces` (host "v1") and stall every export to the timeout */
export function validEndpoint(endpoint: string): boolean {
  try { const u = new URL(endpoint.trim()); return (u.protocol === "http:" || u.protocol === "https:") && u.hostname !== ""; } catch { return false; }
}

// ---------- the hook set ----------

export function createOtelHooks(opts: OtelOptions): OtelHooks {
  otelDebug.constructed++;
  const url = normalizeEndpoint(opts.endpoint);
  const headers = { ...(opts.headers ?? {}), "content-type": "application/json" };
  const fetchFn = opts.fetch ?? fetch;
  const now = opts.now ?? defaultNow;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_EXPORT_TIMEOUT_MS;
  const service = opts.serviceName ?? "aion";
  let pricing: PricingSource | undefined = opts.pricing;
  const runs = new Map<string, RunState>();
  const pending = new Set<Promise<void>>();
  let failed = 0, lastFailure = "";

  const stateOf = (ctx: HookCtx): RunState | undefined => (ctx.runId === undefined ? undefined : runs.get(ctx.runId));
  const attach = (st: RunState, name: string, parent: OtelSpan): OtelSpan => {
    const s: OtelSpan = { traceId: st.run.traceId, spanId: hex(8), parentSpanId: parent.spanId, name, start: now(), attrs: new Map(), events: [], status: { code: 0 } };
    st.spans.push(s);
    return s;
  };
  const end = (s: OtelSpan, status: OtelSpan["status"]): void => { if (s.end === undefined) { s.end = now(); s.status = status; } };
  const event = (s: OtelSpan, name: string, attrs: [string, OtlpValue][]): void => { s.events.push({ name, time: now(), attrs: new Map(attrs) }); };
  /** a call's parent = the turn that issued it (turn_end precedes the turn's tool events — header) */
  const issuer = (st: RunState): OtelSpan => st.lastTurn ?? st.run;
  const toolKey = (st: RunState, callId: string): string => `${issuer(st).spanId}:${callId}`;
  /** the tool span for a call — opened by whichever of pre_tool / tool_execution_start arrives first;
   *  a span the START event has to open never saw pre_tool: the loop-guard stub path (tools.ts:88-93) */
  const openTool = (st: RunState, callId: string, tool?: string, fromStart = false): OtelSpan => {
    const key = toolKey(st, callId);
    let s = st.tools.get(key);
    if (!s) {
      s = attach(st, "aion.tool", issuer(st));
      s.attrs.set("aion.call_id", str(callId));
      if (fromStart) s.attrs.set("aion.failure_reason", str("loop_guard"));
      st.tools.set(key, s);
      st.calls++;
    }
    if (tool !== undefined && !s.attrs.has("aion.tool")) s.attrs.set("aion.tool", str(tool));
    return s;
  };
  const settleTool = (s: OtelSpan, ok: boolean, output: string): void => {
    if (s.end !== undefined) return; // post_tool already settled it; tool_execution_end only adds duration
    s.attrs.set("aion.ok", bool(ok));
    s.attrs.set("aion.output_bytes", int(Buffer.byteLength(output, "utf8")));
    const name = s.attrs.get("aion.tool");
    end(s, ok ? OK : ERROR(`tool ${name && "stringValue" in name ? name.stringValue : "call"} failed`));
  };
  /** tokens summed + cost priced PER MESSAGE at Message.origin (cli/output.ts summarize): any
   *  usage-bearing message without catalog pricing → cost unknown → attribute omitted, never 0 */
  const account = (s: OtelSpan, msgs: Message[]): void => {
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
    s.attrs.set("aion.tokens.input", int(u.input)); s.attrs.set("aion.tokens.output", int(u.output));
    s.attrs.set("aion.tokens.cacheRead", int(u.cacheRead)); s.attrs.set("aion.tokens.cacheWrite", int(u.cacheWrite));
    if (cost !== null) s.attrs.set("aion.cost_usd", dbl(cost));
    const served = msgs.at(-1)?.origin; // the model that SERVED (router fallback may differ from the request)
    if (served) { s.attrs.set("aion.model.provider", str(served.provider)); s.attrs.set("aion.model.model", str(served.model)); }
  };

  // --- export ---
  const warn = (note: string): void => {
    if (opts.onWarning) { opts.onWarning(note); return; }
    failed++; lastFailure = note;
  };
  const fail = (reason: string): void => warn(`OTLP export to ${url} failed: ${reason}`);
  const usable = validEndpoint(opts.endpoint); // ONE note at construction (raised by the first lifecycle hook), then no POSTs
  if (!usable) warn(`AION_OTEL_ENDPOINT ${JSON.stringify(opts.endpoint)} is not an absolute http(s) URL — OTel export disabled`);
  /** deferred failure → thrown from a lifecycle hook → one runner warning (header); no-op with onWarning */
  const raise = (): void => {
    if (failed === 0) return;
    const n = failed; failed = 0;
    throw new Error(n === 1 ? lastFailure : `${lastFailure} (${n} exports failed)`);
  };
  const post = async (body: string): Promise<void> => {
    if (!usable) return;
    const ac = new AbortController();
    try {
      const res = await withTimeout(fetchFn(url, { method: "POST", headers, body, signal: ac.signal }), timeoutMs, ac);
      if (res === TIMED_OUT) { fail(`timed out after ${timeoutMs}ms`); return; }
      await res.arrayBuffer().catch(() => undefined); // release the connection; a success body is `{}`
      if (!res.ok) fail(`HTTP ${res.status}`);
    } catch (e) { fail(errText(e)); }
  };
  const track = (p: Promise<void>): void => { pending.add(p); void p.then(() => { pending.delete(p); }); };
  const flush = async (): Promise<void> => { while (pending.size > 0) await Promise.all([...pending]); };
  /** the run's end: open turn/tool spans close here (status UNSET), totals + status land on the run
   *  span, ONE POST — from post_run, or from session_close for a state no post_run ever released */
  const finish = (st: RunState, status: RunResult["status"]): void => {
    const t = now();
    for (const s of st.spans) if (s.end === undefined && s !== st.run) s.end = t;
    st.run.attrs.set("aion.status", str(status));
    st.run.attrs.set("aion.turns", int(st.spans.filter((s) => s.name === "aion.turn").length));
    st.run.attrs.set("aion.tool_calls", int(st.calls));
    account(st.run, opts.messages().slice(st.baseline).filter((m) => m.role === "assistant"));
    st.run.end = t;
    st.run.status = status === "done" || status === "stopped" ? OK : ERROR(status); // budget/error did not complete
    track(post(JSON.stringify(encodeTraceRequest(service, st.spans))));
  };

  return {
    flush,
    openRuns: () => runs.size,
    pre_run(ctx) {
      if (ctx.runId === undefined) return;
      const run: OtelSpan = { traceId: hex(16), spanId: hex(8), name: "aion.run", start: now(), attrs: new Map(), events: [], status: { code: 0 } };
      run.attrs.set("aion.session_id", str(ctx.sessionId)); run.attrs.set("aion.run_id", str(ctx.runId));
      const len = opts.messages().length;
      runs.set(ctx.runId, { run, spans: [run], tools: new Map(), calls: 0, baseline: len, seen: len });
      raise();
    },
    on_event(ctx, ev: RunEvent) {
      const st = stateOf(ctx);
      if (!st) return;
      switch (ev.type) {
        case "turn_start": {
          if (st.turn) end(st.turn, st.turn.status); // defensive: the loop never nests turns
          st.turn = st.lastTurn = attach(st, "aion.turn", st.run);
          st.turn.attrs.set("aion.turn", int(ev.turn));
          break;
        }
        case "turn_end": {
          const t = st.turn ?? st.lastTurn;
          if (!t) break;
          t.attrs.set("aion.stop_reason", str(ev.stopReason));
          const msgs = opts.messages();
          account(t, msgs.slice(st.seen).filter((m) => m.role === "assistant"));
          st.seen = msgs.length;
          end(t, ev.stopReason === "error" ? ERROR("error") : OK);
          st.turn = undefined;
          break;
        }
        case "tool_execution_start": openTool(st, ev.callId, ev.tool, true); break;
        case "tool_execution_end": {
          const s = openTool(st, ev.callId);
          s.attrs.set("aion.duration_ms", int(ev.durationMs)); // the dispatcher's own measure (tools.ts:170)
          settleTool(s, ev.ok, ev.output);
          break;
        }
        case "tool_call_failed": {
          const s = st.tools.get(toolKey(st, ev.callId));
          if (s) { s.attrs.set("aion.ok", bool(false)); s.attrs.set("aion.failure_reason", str(ev.reason)); end(s, ERROR(ev.reason)); }
          else { st.calls++; event(st.turn ?? st.lastTurn ?? st.run, "aion.tool_call_failed", [["aion.call_id", str(ev.callId)], ["aion.failure_reason", str(ev.reason)]]); }
          break;
        }
        case "compaction":
          event(st.turn ?? st.run, "aion.compaction", [
            ["aion.compaction.strategy", str(ev.strategy)], ...(ev.trigger ? [["aion.compaction.trigger", str(ev.trigger)] as [string, OtlpValue]] : []),
            ["aion.compaction.tokens_before", int(ev.tokensBefore)], ["aion.compaction.tokens_after", int(ev.tokensAfter)],
          ]);
          break;
        default: break; // run_start/run_end ride pre_run/post_run; deltas, progress notes and steers are not spans
      }
    },
    pre_tool(ctx, call: HookToolCall) { const st = stateOf(ctx); if (st) openTool(st, call.id, call.tool); },
    post_tool(ctx, call: HookToolCall, result: ToolOutput) { const st = stateOf(ctx); if (st) settleTool(openTool(st, call.id, call.tool), result.ok, result.output); },
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
      await flush(); raise();
    },
  };
}

// ---------- helpers ----------

const defaultNow = (): number => performance.timeOrigin + performance.now();
/** random hex id of `bytes` bytes; the all-zero id is invalid in OTel */
function hex(bytes: number): string {
  let h: string;
  do h = randomBytes(bytes).toString("hex"); while (/^0+$/.test(h));
  return h;
}
const TIMED_OUT: unique symbol = Symbol("aion.otel.timeout");
/** resolves TIMED_OUT after ms on a REF'D timer and aborts the request's controller (hooks.ts idiom);
 *  the race is independent of the fetch honoring the signal, so a stuck transport still settles */
function withTimeout<T>(p: Promise<T>, ms: number, ac: AbortController): Promise<T | typeof TIMED_OUT> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ac.abort(); resolve(TIMED_OUT); }, ms);
    (timer as unknown as { ref?: () => void }).ref?.();
    p.then((v) => { clearTimeout(timer); resolve(v); }, (e: unknown) => { clearTimeout(timer); reject(e); });
  });
}
function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "object" && e !== null && typeof (e as { message?: unknown }).message === "string") return (e as { message: string }).message;
  return String(e);
}
