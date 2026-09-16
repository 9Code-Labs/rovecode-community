/** OTLP/HTTP exporter pipe (port #82) — ONE exporter for the three signals the #39 hook set emits:
 *  traces (`<base>/v1/traces`), metrics (`<base>/v1/metrics`) and logs (`<base>/v1/logs`). The base is the
 *  configured ROVECODE_OTEL_ENDPOINT with a trailing `/v1/traces` stripped (so a full traces URL still yields
 *  its siblings), each POST rides the #39 REF'D timeout (Bun unrefs AbortSignal.timeout — hooks.ts idiom)
 *  and is tracked so flush() awaits every outstanding one; the export path never throws.
 *
 *  Failure policy: 5xx / timeout / network stay per-export warnings with the #39 texts byte-identical
 *  (`OTLP export to <url> failed: HTTP 500` / `… timed out after 5000ms` / `… ECONNREFUSED`) and never
 *  disable anything. HTTP 404 / 405 / 501 on a signal mean the collector does not serve that path at all
 *  (an old collector without the logs receiver, a traces-only proxy): THAT signal is disabled for the life
 *  of this exporter (one per runtime: the process's one hook set on the CLI/TUI, one per session under
 *  `rovecode serve`) after ONE note — `OTLP collector <base> does not accept <signal> (HTTP <n>) — <signal>
 *  export disabled` — while the other signals continue. A malformed endpoint (`http://`, `host:4318`) makes
 *  the exporter unusable: no POST is ever attempted (the #39 one-note rule; otel.ts raises it).
 *
 *  Moved verbatim out of otel.ts (post / track / flush / withTimeout / TIMED_OUT / errText / hex /
 *  normalizeEndpoint / validEndpoint) so that file stays under the 400-line cap; otel.ts re-exports the
 *  public names, so `import … from "telemetry/otel.ts"` is unchanged. OTLP/HTTP paths and JSON field names
 *  follow the public opentelemetry-proto spec (hand-encoded; no @opentelemetry dependency). */

import { randomBytes } from "node:crypto";

export const DEFAULT_EXPORT_TIMEOUT_MS = 5000;
export const OTLP_TRACES_PATH = "/v1/traces";
export type OtlpSignal = "traces" | "metrics" | "logs";
export const OTLP_SIGNALS: readonly OtlpSignal[] = ["traces", "metrics", "logs"];
/** HTTP statuses that say "this path is not served here" — the signal is switched off, not retried */
const NOT_SERVED: ReadonlySet<number> = new Set([404, 405, 501]);

/** base URL or full traces URL (either, with or without trailing slashes) → <base>/v1/traces */
export function normalizeEndpoint(endpoint: string): string {
  const base = endpoint.trim().replace(/\/+$/, "");
  return base.endsWith(OTLP_TRACES_PATH) ? base : base + OTLP_TRACES_PATH;
}
/** the collector base: the normalized traces URL minus its `/v1/traces` — the siblings hang off it */
export const baseOf = (endpoint: string): string => normalizeEndpoint(endpoint).slice(0, -OTLP_TRACES_PATH.length);
export const signalUrl = (endpoint: string, signal: OtlpSignal): string => `${baseOf(endpoint)}/v1/${signal}`;

/** an absolute http(s) URL with a host — `http://` does not parse and `host:4318` parses host-less,
 *  and both would normalize to `http:/v1/traces` (host "v1") and stall every export to the timeout */
export function validEndpoint(endpoint: string): boolean {
  try { const u = new URL(endpoint.trim()); return (u.protocol === "http:" || u.protocol === "https:") && u.hostname !== ""; } catch { return false; }
}

export interface OtlpExporterOptions {
  endpoint: string;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** every export note (per-export failures, the one-shot per-signal disable) */
  warn: (note: string) => void;
}
export interface OtlpExporter {
  readonly base: string;
  /** false = malformed endpoint: nothing is ever POSTed (the caller says so once) */
  readonly usable: boolean;
  url(signal: OtlpSignal): string;
  /** POST one encoded request; fire-and-forget, tracked for flush(); never throws */
  post(signal: OtlpSignal, body: string): void;
  /** await every outstanding POST (posts issued while waiting are awaited too) */
  flush(): Promise<void>;
  /** the signal was switched off by a 404/405/501 (diagnostic seam) */
  disabled(signal: OtlpSignal): boolean;
}

export function createOtlpExporter(opts: OtlpExporterOptions): OtlpExporter {
  const base = baseOf(opts.endpoint);
  const usable = validEndpoint(opts.endpoint);
  const headers = { ...(opts.headers ?? {}), "content-type": "application/json" };
  const fetchFn = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_EXPORT_TIMEOUT_MS;
  const pending = new Set<Promise<void>>();
  const off = new Set<OtlpSignal>();
  const url = (signal: OtlpSignal): string => `${base}/v1/${signal}`;
  const send = async (signal: OtlpSignal, body: string): Promise<void> => {
    if (!usable || off.has(signal)) return;
    const target = url(signal);
    const fail = (reason: string): void => opts.warn(`OTLP export to ${target} failed: ${reason}`);
    const ac = new AbortController();
    try {
      const res = await withTimeout(fetchFn(target, { method: "POST", headers, body, signal: ac.signal }), timeoutMs, ac);
      if (res === TIMED_OUT) { fail(`timed out after ${timeoutMs}ms`); return; }
      await res.arrayBuffer().catch(() => undefined); // release the connection; a success body is `{}`
      if (res.ok) return;
      if (NOT_SERVED.has(res.status)) { // one note, then silence for this signal (a second in-flight POST that raced the first says nothing more)
        if (!off.has(signal)) { off.add(signal); opts.warn(`OTLP collector ${base} does not accept ${signal} (HTTP ${res.status}) — ${signal} export disabled`); }
        return;
      }
      fail(`HTTP ${res.status}`);
    } catch (e) { fail(errText(e)); }
  };
  return {
    base, usable, url,
    post(signal, body) { const p = send(signal, body); pending.add(p); void p.then(() => { pending.delete(p); }); },
    async flush() { while (pending.size > 0) await Promise.all([...pending]); },
    disabled: (signal) => off.has(signal),
  };
}

// ---------- helpers (moved from otel.ts) ----------

/** random hex id of `bytes` bytes; the all-zero id is invalid in OTel */
export function hex(bytes: number): string {
  let h: string;
  do h = randomBytes(bytes).toString("hex"); while (/^0+$/.test(h));
  return h;
}
export const TIMED_OUT: unique symbol = Symbol("rovecode.otel.timeout");
/** resolves TIMED_OUT after ms on a REF'D timer and aborts the request's controller (hooks.ts idiom);
 *  the race is independent of the fetch honoring the signal, so a stuck transport still settles */
export function withTimeout<T>(p: Promise<T>, ms: number, ac: AbortController): Promise<T | typeof TIMED_OUT> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ac.abort(); resolve(TIMED_OUT); }, ms);
    (timer as unknown as { ref?: () => void }).ref?.();
    p.then((v) => { clearTimeout(timer); resolve(v); }, (e: unknown) => { clearTimeout(timer); reject(e); });
  });
}
export function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "object" && e !== null && typeof (e as { message?: unknown }).message === "string") return (e as { message: string }).message;
  return String(e);
}
