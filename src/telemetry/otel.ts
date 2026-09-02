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
import pkg from "../../package.json";
import type { HookCtx, HookSet, HookToolCall, RunResult } from "../core/hooks.ts";
import type { Message, RunEvent, ToolOutput } from "../core/types.ts";
import { costUsd, type PricingRow } from "../core/usage.ts";
import { ModelCatalog } from "../providers/catalog.ts";

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
export interface OtelHooks extends HookSet { flush(): Promise<void> }

// ---------- wire types (OTLP/HTTP JSON, ExportTraceServiceRequest) ----------

export type OtlpValue = { stringValue: string } | { intValue: string } | { doubleValue: number } | { boolValue: boolean };
export interface OtlpKeyValue { key: string; value: OtlpValue }
export interface OtlpSpan {
  traceId: string; spanId: string; parentSpanId?: string; name: string; kind: number;
  startTimeUnixNano: string; endTimeUnixNano: string;
  attributes: OtlpKeyValue[];
  events?: { name: string; timeUnixNano: string; attributes: OtlpKeyValue[] }[];
  status: { code: number; message?: string };
}
export interface OtlpTraceRequest {
  resourceSpans: {
    resource: { attributes: OtlpKeyValue[] };
    scopeSpans: { scope: { name: string; version?: string }; spans: OtlpSpan[] }[];
  }[];
}

/** one recorded span; mutable until its run is exported (events arrive out of order — header) */
export interface OtelSpan {
  traceId: string; spanId: string; parentSpanId?: string; name: string;
  start: number; end?: number;
  attrs: Map<string, OtlpValue>;
  events: { name: string; time: number; attrs: Map<string, OtlpValue> }[];
  status: { code: 0 | 1 | 2; message?: string };
}
interface RunState {
  run: OtelSpan; spans: OtelSpan[]; turn?: OtelSpan; lastTurn?: OtelSpan; tools: Map<string, OtelSpan>;
  /** store length at pre_run (run totals) and at the last turn_end (per-turn usage) */
  baseline: number; seen: number;
}

const str = (v: string): OtlpValue => ({ stringValue: v });
const int = (v: number): OtlpValue => ({ intValue: String(Math.trunc(v)) });
const dbl = (v: number): OtlpValue => ({ doubleValue: v });
const bool = (v: boolean): OtlpValue => ({ boolValue: v });
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
  /** the tool span for a call — opened by whichever of pre_tool / tool_execution_start arrives first
   *  (the loop-guard stub path emits the events without ever reaching pre_tool) */
  const openTool = (st: RunState, callId: string, tool?: string): OtelSpan => {
    let s = st.tools.get(callId);
    if (!s) {
      s = attach(st, "aion.tool", st.lastTurn ?? st.run);
      s.attrs.set("aion.call_id", str(callId));
      st.tools.set(callId, s);
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
  const fail = (reason: string): void => {
    const note = `OTLP export to ${url} failed: ${reason}`;
    if (opts.onWarning) { opts.onWarning(note); return; }
    failed++; lastFailure = note;
  };
  /** deferred failure → thrown from a lifecycle hook → one runner warning (header); no-op with onWarning */
  const raise = (): void => {
    if (failed === 0) return;
    const n = failed; failed = 0;
    throw new Error(n === 1 ? lastFailure : `${lastFailure} (${n} exports failed)`);
  };
  const post = async (body: string): Promise<void> => {
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

  return {
    flush,
    pre_run(ctx) {
      if (ctx.runId === undefined) return;
      const run: OtelSpan = { traceId: hex(16), spanId: hex(8), name: "aion.run", start: now(), attrs: new Map(), events: [], status: { code: 0 } };
      run.attrs.set("aion.session_id", str(ctx.sessionId)); run.attrs.set("aion.run_id", str(ctx.runId));
      const len = opts.messages().length;
      runs.set(ctx.runId, { run, spans: [run], tools: new Map(), baseline: len, seen: len });
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
        case "tool_execution_start": openTool(st, ev.callId, ev.tool); break;
        case "tool_execution_end": {
          const s = openTool(st, ev.callId);
          s.attrs.set("aion.duration_ms", int(ev.durationMs)); // the dispatcher's own measure (tools.ts:170)
          settleTool(s, ev.ok, ev.output);
          break;
        }
        case "tool_call_failed": {
          const s = st.tools.get(ev.callId);
          if (s) { s.attrs.set("aion.ok", bool(false)); s.attrs.set("aion.failure_reason", str(ev.reason)); end(s, ERROR(ev.reason)); }
          else event(st.turn ?? st.lastTurn ?? st.run, "aion.tool_call_failed", [["aion.call_id", str(ev.callId)], ["aion.failure_reason", str(ev.reason)]]);
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
      const t = now();
      for (const s of st.spans) if (s.end === undefined && s !== st.run) s.end = t; // unfinished turn/tool: closed here, status UNSET
      st.run.attrs.set("aion.status", str(result.status));
      st.run.attrs.set("aion.turns", int(st.spans.filter((s) => s.name === "aion.turn").length));
      st.run.attrs.set("aion.tool_calls", int(st.tools.size));
      account(st.run, opts.messages().slice(st.baseline).filter((m) => m.role === "assistant"));
      st.run.end = t;
      st.run.status = result.status === "done" || result.status === "stopped" ? OK : ERROR(result.status); // budget/error did not complete
      track(post(JSON.stringify(encodeTraceRequest(service, st.spans))));
    },
    async session_close() { await flush(); raise(); },
  };
}

// ---------- encoding ----------

/** OTLP/JSON: ids hex (already), fixed64 times + int64 attrs as decimal strings, enums as integers */
export function encodeTraceRequest(serviceName: string, spans: readonly OtelSpan[]): OtlpTraceRequest {
  const kv = (m: Iterable<[string, OtlpValue]>): OtlpKeyValue[] => [...m].map(([key, value]) => ({ key, value }));
  return {
    resourceSpans: [{
      resource: { attributes: kv([["service.name", str(serviceName)], ["service.version", str(pkg.version)]]) },
      scopeSpans: [{
        scope: { name: "aion", version: pkg.version },
        spans: spans.map((s) => ({
          traceId: s.traceId, spanId: s.spanId, ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
          name: s.name, kind: 1, // SPAN_KIND_INTERNAL
          startTimeUnixNano: unixNano(s.start), endTimeUnixNano: unixNano(s.end ?? s.start),
          attributes: kv(s.attrs),
          ...(s.events.length > 0 ? { events: s.events.map((e) => ({ name: e.name, timeUnixNano: unixNano(e.time), attributes: kv(e.attrs) })) } : {}),
          status: s.status.message !== undefined ? { code: s.status.code, message: s.status.message } : { code: s.status.code },
        })),
      }],
    }],
  };
}

/** ms since epoch (fractions allowed) → exact unix-nano decimal string (no float rounding at 1e18) */
export function unixNano(ms: number): string {
  const whole = Math.floor(ms);
  return (BigInt(whole) * 1_000_000n + BigInt(Math.round((ms - whole) * 1e6))).toString();
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
