/** OTLP/HTTP JSON wire shapes + encoder for the port-#39 exporter (telemetry/otel.ts): the
 *  ExportTraceServiceRequest subset rovecode emits, the mutable in-memory span record it fills while a
 *  run is live, and the OTLP/JSON mapping rules — ids as hex, fixed64 times and int64 attributes as
 *  decimal strings, enums as integers. Pure: no I/O, no clock, no state. Split out of otel.ts at the
 *  400-line cap (fix-wave 4); otel.ts re-exports everything here, so its public surface is unchanged.
 *  `kv`, `resourceAttrs` and `scopeOf` are exported so the metrics (otel-metrics.ts) and logs (otel-logs.ts)
 *  encoders share ONE resource/attribute encoding with the traces below. */

import pkg from "../../package.json";

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

/** one recorded span; mutable until its run is exported (events arrive out of order — otel.ts header) */
export interface OtelSpan {
  traceId: string; spanId: string; parentSpanId?: string; name: string;
  start: number; end?: number;
  attrs: Map<string, OtlpValue>;
  events: { name: string; time: number; attrs: Map<string, OtlpValue> }[];
  status: { code: 0 | 1 | 2; message?: string };
}

export const str = (v: string): OtlpValue => ({ stringValue: v });
export const int = (v: number): OtlpValue => ({ intValue: String(Math.trunc(v)) });
export const dbl = (v: number): OtlpValue => ({ doubleValue: v });
export const bool = (v: boolean): OtlpValue => ({ boolValue: v });

// ---------- encoding ----------

/** attribute map/tuples → the OTLP KeyValue list (shared by the three signal encoders) */
export const kv = (m: Iterable<[string, OtlpValue]>): OtlpKeyValue[] => [...m].map(([key, value]) => ({ key, value }));
/** the ONE resource every signal carries: service.name (default "rovecode") + service.version */
export const resourceAttrs = (serviceName: string): OtlpKeyValue[] => kv([["service.name", str(serviceName)], ["service.version", str(pkg.version)]]);
/** the ONE instrumentation scope every signal carries */
export const scopeOf = (): { name: string; version: string } => ({ name: "rovecode", version: pkg.version });

/** OTLP/JSON: ids hex (already), fixed64 times + int64 attrs as decimal strings, enums as integers */
export function encodeTraceRequest(serviceName: string, spans: readonly OtelSpan[]): OtlpTraceRequest {
  return {
    resourceSpans: [{
      resource: { attributes: resourceAttrs(serviceName) },
      scopeSpans: [{
        scope: scopeOf(),
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
