/** Cumulative OTLP metrics for the #39 hook set (port #82): a tiny in-memory registry of monotonic Sums and
 *  explicit-bucket Histograms plus the ExportMetricsServiceRequest encoder. CUMULATIVE on purpose
 *  (aggregationTemporality 2, startTimeUnixNano = the exporter's construction, every point carries the
 *  total since then): the OTel SDK default, and Prometheus-backed collectors drop DELTA points. Counters are
 *  never reset after a POST — the second run's request carries first + second totals. `dirty` says whether
 *  anything changed since the last encode, so a run with no turns and no retries POSTs nothing.
 *
 *  Families (fed by otel.ts):
 *    rovecode.tokens            Sum {token}   rovecode.token.type ∈ input|output|cacheRead|cacheWrite + provider/model
 *    rovecode.request.duration  Histogram ms  pinned bounds DURATION_BOUNDS; one observation per rovecode.turn (provider/model/stop_reason)
 *    rovecode.request.retries   Sum {retry}   provider/model + rovecode.retry.status (int, when the reason parses) — never the reason text
 *    rovecode.cost_usd          Sum USD (double) provider/model — only when the turn priced
 *  Attribute policy as the traces (pi telemetry/README.md:387-389): ids, sizes and outcomes only.
 *
 *  Pattern sources (family names / shapes only, no code copied): gemini-cli docs/cli/telemetry.md (Apache-2.0,
 *  Copyright 2025 Google LLC; snapshot research/source_snapshots/google-gemini-gemini-cli @ 0bd1d43) —
 *  `gemini_cli.api_response` (:518) carries per-request token counts by type and the request duration, and the
 *  `gemini_cli.tool.call.count` counter family (:959) is keyed by name + outcome; Claude Code's monitoring
 *  docs (proprietary — pattern mention only, nothing copied) publish `claude_code.token.usage` split by a token
 *  `type` attribute and a `cost.usage` counter. rovecode names them `rovecode.*`, keeps the NormalizedUsage
 *  spelling of the token types, and hand-encodes the public OTLP/JSON metrics proto (int64 / fixed64 as
 *  decimal strings, doubles as numbers). */

import { kv, resourceAttrs, scopeOf, unixNano, type OtlpKeyValue, type OtlpValue } from "./otlp.ts";

export const AGGREGATION_CUMULATIVE = 2;
/** rovecode.request.duration explicit bounds in ms — pinned (a dashboard's buckets must not drift) */
export const DURATION_BOUNDS: readonly number[] = [100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000];

export type MetricAttrs = readonly (readonly [string, OtlpValue])[];

// ---------- wire types (OTLP/HTTP JSON, ExportMetricsServiceRequest subset) ----------

export interface OtlpNumberPoint { attributes: OtlpKeyValue[]; startTimeUnixNano: string; timeUnixNano: string; asInt?: string; asDouble?: number }
export interface OtlpHistogramPoint {
  attributes: OtlpKeyValue[]; startTimeUnixNano: string; timeUnixNano: string;
  count: string; sum: number; bucketCounts: string[]; explicitBounds: number[];
}
export type OtlpMetric =
  | { name: string; unit: string; sum: { dataPoints: OtlpNumberPoint[]; aggregationTemporality: number; isMonotonic: boolean } }
  | { name: string; unit: string; histogram: { dataPoints: OtlpHistogramPoint[]; aggregationTemporality: number } };
export interface OtlpMetricsRequest {
  resourceMetrics: { resource: { attributes: OtlpKeyValue[] }; scopeMetrics: { scope: { name: string; version?: string }; metrics: OtlpMetric[] }[] }[];
}

// ---------- registry ----------

interface SumSeries { attrs: Map<string, OtlpValue>; value: number }
interface HistSeries { attrs: Map<string, OtlpValue>; count: number; sum: number; buckets: number[] }
interface SumMetric { kind: "sum"; name: string; unit: string; asDouble: boolean; series: Map<string, SumSeries> }
interface HistMetric { kind: "histogram"; name: string; unit: string; bounds: readonly number[]; series: Map<string, HistSeries> }

export interface MetricsRegistry {
  /** the cumulative window start (ms) — every point's startTimeUnixNano */
  readonly startMs: number;
  /** something was recorded since the last encode() */
  readonly dirty: boolean;
  /** add `delta` (≥ 0) to a monotonic Sum series; `asDouble` picks the double point encoding (cost) */
  addSum(name: string, unit: string, attrs: MetricAttrs, delta: number, asDouble?: boolean): void;
  /** one observation into an explicit-bucket Histogram series */
  recordHistogram(name: string, unit: string, bounds: readonly number[], attrs: MetricAttrs, value: number): void;
  /** the whole cumulative state as ONE request (all points stamped `nowMs`); clears `dirty`, never the totals */
  encode(serviceName: string, nowMs: number): OtlpMetricsRequest;
}

/** series key: the attribute tuples sorted by key (so insertion order never splits a series) */
const seriesKey = (attrs: MetricAttrs): string => JSON.stringify([...attrs].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

export function createMetrics(startMs: number): MetricsRegistry {
  const metrics = new Map<string, SumMetric | HistMetric>();
  let dirty = false;
  const sumOf = (name: string, unit: string, asDouble: boolean): SumMetric => {
    let m = metrics.get(name);
    if (!m) { m = { kind: "sum", name, unit, asDouble, series: new Map() }; metrics.set(name, m); }
    if (m.kind !== "sum") throw new Error(`metric ${name} is a ${m.kind}`);
    return m;
  };
  const histOf = (name: string, unit: string, bounds: readonly number[]): HistMetric => {
    let m = metrics.get(name);
    if (!m) { m = { kind: "histogram", name, unit, bounds, series: new Map() }; metrics.set(name, m); }
    if (m.kind !== "histogram") throw new Error(`metric ${name} is a ${m.kind}`);
    return m;
  };
  return {
    startMs,
    get dirty() { return dirty; },
    addSum(name, unit, attrs, delta, asDouble = false) {
      if (!(delta >= 0) || !Number.isFinite(delta)) return; // monotonic: never a negative or NaN step
      const m = sumOf(name, unit, asDouble);
      const k = seriesKey(attrs);
      const s = m.series.get(k) ?? { attrs: new Map(attrs), value: 0 };
      s.value += delta;
      m.series.set(k, s);
      dirty = true;
    },
    recordHistogram(name, unit, bounds, attrs, value) {
      if (!Number.isFinite(value)) return;
      const m = histOf(name, unit, bounds);
      const k = seriesKey(attrs);
      const s = m.series.get(k) ?? { attrs: new Map(attrs), count: 0, sum: 0, buckets: new Array<number>(bounds.length + 1).fill(0) };
      s.count++; s.sum += value;
      let i = 0;
      while (i < bounds.length && value > bounds[i]!) i++; // bucket i holds (bounds[i-1], bounds[i]]; the last is the overflow
      s.buckets[i]!++;
      m.series.set(k, s);
      dirty = true;
    },
    encode(serviceName, nowMs) {
      dirty = false;
      return encodeMetricsRequest(serviceName, [...metrics.values()], startMs, nowMs);
    },
  };
}

// ---------- encoding ----------

function encodeMetricsRequest(serviceName: string, metrics: readonly (SumMetric | HistMetric)[], startMs: number, nowMs: number): OtlpMetricsRequest {
  const start = unixNano(startMs), now = unixNano(nowMs);
  const stamp = (attrs: Map<string, OtlpValue>) => ({ attributes: kv(attrs), startTimeUnixNano: start, timeUnixNano: now });
  const out: OtlpMetric[] = metrics.map((m) => m.kind === "sum"
    ? {
      name: m.name, unit: m.unit,
      sum: {
        dataPoints: [...m.series.values()].map((s) => ({ ...stamp(s.attrs), ...(m.asDouble ? { asDouble: s.value } : { asInt: String(Math.trunc(s.value)) }) })),
        aggregationTemporality: AGGREGATION_CUMULATIVE, isMonotonic: true,
      },
    }
    : {
      name: m.name, unit: m.unit,
      histogram: {
        dataPoints: [...m.series.values()].map((s) => ({ ...stamp(s.attrs), count: String(s.count), sum: s.sum, bucketCounts: s.buckets.map(String), explicitBounds: [...m.bounds] })),
        aggregationTemporality: AGGREGATION_CUMULATIVE,
      },
    });
  return { resourceMetrics: [{ resource: { attributes: resourceAttrs(serviceName) }, scopeMetrics: [{ scope: scopeOf(), metrics: out }] }] };
}
