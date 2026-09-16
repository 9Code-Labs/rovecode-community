/** Error-turn shaping for the wire adapters (extracted from stream.ts, port #23). ADR-003: the
 *  seam never throws — failures cross as AssistantTurn{stopReason:"error"|"aborted"}.
 *
 *  Non-2xx responses keep the exact error text the router classifies ("HTTP <status>: <body>",
 *  router.ts classifyStreamError) and additionally record the status + the server's wait hints in a
 *  WeakMap side-channel keyed on the turn object — the same shape as the router's servedBy tag
 *  (router.ts:174-185), because AssistantTurn (core/types.ts) is shared/untouchable (no new turn
 *  field). The tool-call middleware passes error turns through by identity (empty parts → no
 *  rewrite, middleware.ts:352), so withRetry (providers/retry.ts) reads the headers off the very
 *  object the adapter produced.
 *
 *  Also here: fetchFirstByte, the one fetch the adapters use — a request that gets NO response within
 *  the first-byte timeout is a transport failure ("no response from <host> within 60 s"), retryable
 *  because nothing was streamed yet; without it a provider that never answers hung the turn until Ctrl-C
 *  (the run's wall clock is checked only between turns). The timer covers headers only: once the response
 *  starts, the body may take as long as the model talks. */

import type { AssistantTurn } from "../core/types.ts";

export interface HttpErrorMeta {
  status: number;
  /** Raw Retry-After header value when the response carried one (RFC 9110 §10.2.3:
   *  delay-seconds or HTTP-date). Parsing is the consumer's job (retry.ts parseRetryAfter). */
  retryAfter?: string;
  /** OpenAI's `retry-after-ms` — milliseconds, more precise than Retry-After when both are sent */
  retryAfterMs?: string;
  /** Anthropic's `anthropic-ratelimit-requests-reset` / `-tokens-reset` (RFC 3339) — the later of the two */
  resetAt?: string;
}

const HTTP_META = new WeakMap<AssistantTurn, HttpErrorMeta>();

/** Turn for a non-2xx response. Error text and the 300-char body bound are unchanged from the
 *  inline shape the adapters used before the extraction. */
export async function httpErrorTurn(res: Response): Promise<AssistantTurn> {
  const turn: AssistantTurn = { parts: [], stopReason: "error", usage: { input: 0, output: 0 }, error: `HTTP ${res.status}: ${(await res.text()).slice(0, 300)}` };
  const meta: HttpErrorMeta = { status: res.status };
  const retryAfter = res.headers.get("retry-after");
  if (retryAfter !== null) meta.retryAfter = retryAfter;
  const retryAfterMs = res.headers.get("retry-after-ms");
  if (retryAfterMs !== null) meta.retryAfterMs = retryAfterMs;
  const resets = [res.headers.get("anthropic-ratelimit-requests-reset"), res.headers.get("anthropic-ratelimit-tokens-reset")]
    .filter((v): v is string => v !== null && !Number.isNaN(Date.parse(v)))
    .sort((a, b) => Date.parse(b) - Date.parse(a));
  if (resets[0] !== undefined) meta.resetAt = resets[0];
  HTTP_META.set(turn, meta);
  return turn;
}

/** Status + wait hints recorded for an adapter-produced HTTP error turn; undefined for every
 *  other turn (transport failures, aborts, synthesized errors). */
export function httpErrorMeta(turn: AssistantTurn): HttpErrorMeta | undefined {
  return HTTP_META.get(turn);
}

/** the provider's own words out of an "HTTP nnn: <body>" error — a JSON body's message field when
 *  there is one, else the body — capped, for the human-facing give-up line */
export function providerMessage(error: string | undefined, max = 160): string {
  const body = (error ?? "").replace(/^HTTP \d{3}:\s*/, "").trim();
  let text = body;
  try {
    const json: unknown = JSON.parse(body);
    const dig = (o: unknown): string | undefined => {
      if (typeof o === "string") return o;
      if (o && typeof o === "object") { const r = o as Record<string, unknown>; return dig(r.message) ?? dig(r.error) ?? dig(r.detail); }
      return undefined;
    };
    text = dig(json) ?? body;
  } catch { /* not JSON: the body is the message */ }
  text = text.replace(/\s+/g, " ");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Turn for a thrown fetch/stream error. options.signal abort (port #21) → honest "aborted" keeping SSE text already
 *  streamed (tool-call fragments dropped — truncated JSON); other errors keep parts empty (a router re-drive would dup). */
export function failedTurn(e: unknown, signal: AbortSignal | undefined, salvaged = ""): AssistantTurn {
  if (signal?.aborted) return { parts: salvaged ? [{ kind: "text", text: salvaged }] : [], stopReason: "aborted", usage: { input: 0, output: 0 } };
  return { parts: [], stopReason: "error", usage: { input: 0, output: 0 }, error: e instanceof Error ? e.message : String(e) };
}

// ---------- first-byte timeout ----------

export const DEFAULT_FIRST_BYTE_TIMEOUT_MS = 60_000;

/** ROVECODE_FIRST_BYTE_TIMEOUT_MS: how long a request may go without ANY response; junk/unset → 60 s */
export function firstByteTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.ROVECODE_FIRST_BYTE_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_FIRST_BYTE_TIMEOUT_MS;
}

const fmtMs = (ms: number): string => (ms >= 1000 ? `${Math.round(ms / 1000)} s` : `${ms} ms`);

/** fetch with a timer on the wait for headers only. The caller's signal still cancels everything, including
 *  the body read; the timer is cleared the moment a response (any status) arrives. A timeout throws
 *  `no response from <host> within <n> s` — no HTTP prefix, so the router/retry classify it as a
 *  transport failure (retryable: nothing was streamed). */
export async function fetchFirstByte(input: string, init: RequestInit & { signal?: AbortSignal }, opts: { timeoutMs?: number; fetchFn?: typeof fetch } = {}): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? firstByteTimeoutMs();
  const outer = init.signal;
  const ac = new AbortController();
  const follow = (): void => ac.abort(outer?.reason);
  if (outer?.aborted) follow(); else outer?.addEventListener("abort", follow, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ac.abort(new Error("first-byte timeout")); }, timeoutMs);
  try {
    return await (opts.fetchFn ?? globalThis.fetch)(input, { ...init, signal: ac.signal });
  } catch (e) {
    if (timedOut && outer?.aborted !== true) {
      let host = input;
      try { host = new URL(input).host; } catch { /* keep the raw input */ }
      throw new Error(`no response from ${host} within ${fmtMs(timeoutMs)}`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
