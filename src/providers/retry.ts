/** Same-model retry with exponential backoff (port #23). A StreamFn wrapper — NO second agent
 *  loop (ADR-003): bounded re-invocations of the SAME (model, messages, options) inside one
 *  stream invocation, the way the router makes one bounded pass over chain candidates. Wired
 *  INSIDE the router (`router.wrap(withRetry(stream))`, cli/runtime.ts) so retries exhaust on
 *  candidate N before the chain advances to N+1, and the router's notes stay one-per-ADVANCE.
 *
 *  Source: gemini-cli (Apache-2.0 @0bd1d43 — research/source_snapshots/google-gemini-gemini-cli,
 *  packages/core/src/utils):
 *  - retryWithBackoff loop shape: attempt counter vs maxAttempts, delay doubling up to
 *    maxDelayMs (retry.ts:296-310, :494-501, :517-524); defaults 10 attempts / 5s initial /
 *    30s max (retry.ts:20, :42-47).
 *  - Retryable set: 429 and 5xx; "Explicitly do not retry 400" (retry.ts:193-199); transport
 *    failures without a status are retryable (retry.ts:49-62, :174-189). Shared with the router
 *    through classifyStreamError (router.ts) — one classifier, two consumers (gemini-cli's 499
 *    is excluded there, documented deviation).
 *  - Aborts pass through untouched (retry.ts:337-340); the backoff sleep itself is abortable
 *    (delay.ts:22-48: timeout + abort listener, both cleared on settle).
 *  - A server-suggested delay is a FLOOR on the next sleep (retry.ts:472-476
 *    `Math.max(currentDelay, retryDelayMs)`); a suggestion beyond the cap is terminal — no wait,
 *    immediate fallback (googleQuotaErrors.ts:120 MAX_RETRYABLE_DELAY_SECONDS, :286-289). Here
 *    the suggestion is the HTTP Retry-After header (RFC 9110 §10.2.3: delay-seconds or
 *    HTTP-date) recorded by stream-errors.ts, and the cap is the per-invocation total budget.
 *  - Deviations: FULL jitter — delay = U[0,1) × min(max, base·2ⁿ) (AWS "Exponential Backoff And
 *    Jitter") instead of gemini-cli's ±30% around the current delay (retry.ts:494-495) or +20%
 *    over the server floor (:478): fewer synchronized retries, and the schedule is pinnable with
 *    an injected random. A total wall-clock cap per invocation (gemini-cli has none): with a
 *    fallback chain every candidate pays the retry budget, so it is kept short. No content-based
 *    retry (:314-328), no quota classification / fallback dialog (:342-420) — the router owns
 *    model fallback. A thrown inner stream is folded into an error turn (never-throw) but NOT
 *    retried: a seam-contract violation is a harness bug, not a provider outcome.
 *  - Per-invocation state only: attempt counter and deadline live inside one generator run;
 *    nothing is remembered across calls (unlike the router's sticky switch).
 *  - Deltas from a failed attempt pass through live, exactly as the router forwards them
 *    (router.ts header, mid-stream failure note): canonical content is the terminal turn only.
 *
 *  Env (retryOptionsFromEnv, read once by cli/runtime.ts):
 *  - AION_RETRY_MAX      retries after the first attempt; 0 disables. Default 3 (→ 4 attempts;
 *                        upstream 10 attempts — a fallback chain multiplies attempts per candidate).
 *  - AION_RETRY_BASE_MS  cap of the first backoff in ms. Default 2000 (upstream 5000; full jitter
 *                        halves the expected wait, so 2s ≈ a 1s expected first pause).
 *  Fixed: max backoff 30s (upstream verbatim), total budget 60s per invocation. */

import type { AssistantTurn, ModelRef, StreamEvent, StreamFn } from "../core/types.ts";
import { classifyStreamError } from "./router.ts";
import { httpErrorMeta } from "./stream-errors.ts";

export const DEFAULT_MAX_RETRIES = 3;
export const DEFAULT_BASE_MS = 2_000;
export const DEFAULT_MAX_DELAY_MS = 30_000; // retry.ts:45
export const DEFAULT_TOTAL_MS = 60_000;

export interface RetryNote {
  model: ModelRef;
  /** Attempts made so far (the one that just failed); the retry about to happen is attempt+1. */
  attempt: number;
  delayMs: number;
  /** The failed turn's error text, e.g. "HTTP 429: ...". */
  reason: string;
  /** Parsed Retry-After when the error turn carried one. */
  retryAfterMs?: number;
}

export interface RetryOptions {
  /** Retries after the first attempt (AION_RETRY_MAX). 0 = never retry. */
  maxRetries?: number;
  /** Cap of the first backoff, doubling per attempt (AION_RETRY_BASE_MS). */
  baseMs?: number;
  /** Ceiling for the doubling backoff term. */
  maxDelayMs?: number;
  /** Wall-clock budget per invocation incl. sleeps; a wait that would end past it is not taken. */
  totalMs?: number;
  /** Retry visibility — a note-style callback, not a StreamEvent (grammar is shared/untouchable). */
  onRetry?: (note: RetryNote) => void;
  /** Test seams: abortable sleep, jitter source, clock (epoch ms — also anchors HTTP-date). */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  now?: () => number;
}

/** Abortable sleep (delay.ts:22-48 shape) on a REF'D setTimeout — Bun unrefs AbortSignal.timeout
 *  timers, so a sleep built on one could not hold the process/test runner — plus an abort
 *  listener; whichever settles first clears the other. Resolves (never rejects) on abort: the
 *  caller re-checks signal.aborted. */
export function sleepMs(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    const settle = (): void => { clearTimeout(timer); signal?.removeEventListener("abort", settle); resolve(); };
    const timer = setTimeout(settle, ms);
    signal?.addEventListener("abort", settle, { once: true });
  });
}

/** RFC 9110 §10.2.3 Retry-After: delay-seconds (non-negative; a fractional value is tolerated)
 *  or an HTTP-date, converted to ms from `now` (a past date → 0). Unparseable → undefined. */
export function parseRetryAfter(value: string | undefined, now: number): number | undefined {
  const v = value?.trim();
  if (!v) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(v)) return Math.round(Number(v) * 1000);
  const at = Date.parse(v);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/** Env knobs (header). Blank/invalid/out-of-range values fall back to the defaults;
 *  AION_RETRY_MAX=0 is honored (retry off). */
export function retryOptionsFromEnv(env: Record<string, string | undefined> = process.env): RetryOptions {
  return { maxRetries: envInt(env.AION_RETRY_MAX, DEFAULT_MAX_RETRIES, 0), baseMs: envInt(env.AION_RETRY_BASE_MS, DEFAULT_BASE_MS, 1) };
}

function envInt(raw: string | undefined, dflt: number, min: number): number {
  if (raw === undefined || raw.trim() === "") return dflt;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min ? Math.floor(n) : dflt;
}

const errorTurn = (error: string): AssistantTurn => ({ parts: [], stopReason: "error", usage: { input: 0, output: 0 }, error });

/** Wrap a StreamFn: a retryable failed turn (429 / 5xx / transport, never 400, never abort) is
 *  re-driven against the SAME model with the same args after an abortable full-jitter backoff,
 *  until it succeeds, a non-retryable outcome lands, or a cap (attempts / total budget) stops
 *  it — then the LAST turn is yielded untouched so the router sees the genuine provider error.
 *  Never throws (ADR-003). */
export function withRetry(inner: StreamFn, opts: RetryOptions = {}): StreamFn {
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseMs = opts.baseMs ?? DEFAULT_BASE_MS;
  const maxDelayMs = opts.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const totalMs = opts.totalMs ?? DEFAULT_TOTAL_MS;
  const sleep = opts.sleep ?? sleepMs;
  const random = opts.random ?? Math.random;
  const now = opts.now ?? Date.now;
  return async function* (model, messages, options): AsyncGenerator<StreamEvent> {
    const startedAt = now();
    for (let attempt = 1; ; attempt++) {
      let turn: AssistantTurn | null = null;
      try {
        for await (const ev of inner(model, messages, options)) {
          if (ev.type === "turn") turn = ev.turn;
          else yield ev; // deltas pass through live (header)
        }
      } catch (e) {
        yield { type: "turn", turn: errorTurn(e instanceof Error ? e.message : String(e)) }; // folded, not retried (header)
        return;
      }
      if (turn === null) { yield { type: "turn", turn: errorTurn("stream ended without a terminal turn") }; return; }
      // retry.ts:337-340: aborts never retry; 400/4xx-non-429 and non-error turns stand as they are
      if (turn.stopReason !== "error" || options?.signal?.aborted === true || !classifyStreamError(turn.error).retryable || attempt > maxRetries) {
        yield { type: "turn", turn };
        return;
      }
      const retryAfterMs = parseRetryAfter(httpErrorMeta(turn)?.retryAfter, now());
      const cap = Math.min(maxDelayMs, baseMs * 2 ** (attempt - 1));
      const delayMs = Math.max(Math.round(random() * cap), retryAfterMs ?? 0); // full jitter, server floor (retry.ts:476)
      // budget: a wait that would end past the deadline is not taken — the failure surfaces now
      // and the router may advance at once (googleQuotaErrors.ts:286-289 shape)
      if (now() - startedAt + delayMs > totalMs) { yield { type: "turn", turn }; return; }
      opts.onRetry?.({ model, attempt, delayMs, reason: turn.error ?? "error", ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) });
      await sleep(delayMs, options?.signal);
      if (options?.signal?.aborted) { yield { type: "turn", turn }; return; } // abort landed during backoff: last turn stands
    }
  };
}
