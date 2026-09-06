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
 *    HTTP-date), OpenAI's retry-after-ms, or Anthropic's ratelimit-reset timestamps, all recorded
 *    by stream-errors.ts; the cap is the per-invocation total budget and the run's own deadline.
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
 *  - IDEMPOTENCY (2026-09-04): a retry is taken only while NOTHING has been streamed to the consumer.
 *    Once a text or reasoning delta has gone out, a failure ends the turn — with the partial text kept as
 *    the turn's parts and an error that says so — because a re-drive would print a second answer under
 *    the first (the router applies the same rule to its chain advance). Deltas from a failed attempt that
 *    streamed nothing cannot exist, so the "pass through live" rule and this one never meet.
 *
 *  Env (retryOptionsFromEnv, read once by cli/runtime.ts):
 *  - ROVECODE_RETRY_MAX      retries after the first attempt; 0 disables. Default 3 (→ 4 attempts;
 *                        upstream 10 attempts — a fallback chain multiplies attempts per candidate).
 *  - ROVECODE_RETRY_BASE_MS  cap of the first backoff in ms. Default 1000 (upstream 5000; full jitter
 *                        halves the expected wait — ~0.5 s, 1 s, 2 s, 4 s expected).
 *  Fixed: max backoff 20 s, total budget 60 s per invocation, and never past StreamOptions.deadlineAt
 *  (the run's --max-seconds clock). */

import type { AssistantTurn, ModelRef, StreamEvent, StreamFn } from "../core/types.ts";
import { classifyStreamError } from "./router.ts";
import { httpErrorMeta, providerMessage } from "./stream-errors.ts";

export const DEFAULT_MAX_RETRIES = 3;
export const DEFAULT_BASE_MS = 1_000;
export const DEFAULT_MAX_DELAY_MS = 20_000;
export const DEFAULT_TOTAL_MS = 60_000;

export interface RetryNote {
  model: ModelRef;
  /** Attempts made so far (the one that just failed); the retry about to happen is attempt+1. */
  attempt: number;
  /** attempts the policy allows in total (maxRetries + 1) — for "(2/4)" */
  maxAttempts: number;
  delayMs: number;
  /** The failed turn's error text, e.g. "HTTP 429: ...". */
  reason: string;
  /** the HTTP status when the failure was a response; undefined for a transport failure */
  status?: number;
  /** Parsed server wait hint (Retry-After / retry-after-ms / anthropic-ratelimit-*-reset) when the error turn carried one. */
  retryAfterMs?: number;
}

/** why the wrapper stopped retrying a retryable failure */
export type GiveUpWhy = "attempts" | "budget" | "deadline";
export interface GiveUpNote extends Omit<RetryNote, "delayMs"> { why: GiveUpWhy; delayMs?: number }

export interface RetryOptions {
  /** Retries after the first attempt (ROVECODE_RETRY_MAX). 0 = never retry. */
  maxRetries?: number;
  /** Cap of the first backoff, doubling per attempt (ROVECODE_RETRY_BASE_MS). */
  baseMs?: number;
  /** Ceiling for the doubling backoff term. */
  maxDelayMs?: number;
  /** Wall-clock budget per invocation incl. sleeps; a wait that would end past it is not taken. */
  totalMs?: number;
  /** Retry visibility — a note-style callback, not a StreamEvent (grammar is shared/untouchable). */
  onRetry?: (note: RetryNote) => void;
  /** the last word: a retryable failure that will not be retried (attempts, budget or the run's deadline) */
  onGiveUp?: (note: GiveUpNote) => void;
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

/** the server's wait hint for a failed turn, whichever header it used: the largest of Retry-After,
 *  retry-after-ms and the Anthropic ratelimit reset timestamps (RFC 3339) — the longest wait is the
 *  one that will actually clear the limit */
export function serverWaitMs(turn: AssistantTurn, now: number): number | undefined {
  const meta = httpErrorMeta(turn);
  if (!meta) return undefined;
  const hints: number[] = [];
  const ra = parseRetryAfter(meta.retryAfter, now);
  if (ra !== undefined) hints.push(ra);
  if (meta.retryAfterMs !== undefined && /^\d+(?:\.\d+)?$/.test(meta.retryAfterMs.trim())) hints.push(Math.round(Number(meta.retryAfterMs)));
  if (meta.resetAt !== undefined) { const at = Date.parse(meta.resetAt); if (!Number.isNaN(at)) hints.push(Math.max(0, at - now)); }
  return hints.length ? Math.max(...hints) : undefined;
}

/** Env knobs (header). Blank/invalid/out-of-range values fall back to the defaults;
 *  ROVECODE_RETRY_MAX=0 is honored (retry off). */
export function retryOptionsFromEnv(env: Record<string, string | undefined> = process.env): RetryOptions {
  return { maxRetries: envInt(env.ROVECODE_RETRY_MAX, DEFAULT_MAX_RETRIES, 0), baseMs: envInt(env.ROVECODE_RETRY_BASE_MS, DEFAULT_BASE_MS, 1) };
}

function envInt(raw: string | undefined, dflt: number, min: number): number {
  if (raw === undefined || raw.trim() === "") return dflt;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min ? Math.floor(n) : dflt;
}

const errorTurn = (error: string): AssistantTurn => ({ parts: [], stopReason: "error", usage: { input: 0, output: 0 }, error });

// ---------- the human's words ----------

/** one noun phrase per failure class — what the notice and the give-up line lead with */
export function failureWord(status: number | undefined, error: string): string {
  if (status === 429) return "rate limited";
  if (status === 529 || status === 503) return "overloaded";
  if (status !== undefined && status >= 500) return `server error (HTTP ${status})`;
  if (status !== undefined) return `HTTP ${status}`;
  if (/^no response from /.test(error)) return "no response";
  return "connection failed";
}

const fmtSeconds = (ms: number): string => { const s = ms / 1000; return `${s >= 10 ? Math.round(s) : Math.round(s * 10) / 10} s`; };

/** "anthropic: overloaded — retrying in 4 s (2/4)" */
export function describeRetry(n: RetryNote): string {
  return `${n.model.provider}: ${failureWord(n.status, n.reason)} — retrying in ${fmtSeconds(n.delayMs)} (${n.attempt + 1}/${n.maxAttempts})`;
}

/** "anthropic: overloaded (HTTP 529) — gave up after 4 attempts: Overloaded" */
export function describeGiveUp(n: GiveUpNote): string {
  const why = n.why === "attempts" ? `gave up after ${n.attempt} attempt${n.attempt === 1 ? "" : "s"}`
    : n.why === "deadline" ? `not retried: the run's time limit is closer than the ${fmtSeconds(n.delayMs ?? 0)} wait`
    : `not retried: the ${fmtSeconds(n.delayMs ?? 0)} wait would pass the retry budget`;
  const status = n.status !== undefined && !/HTTP/.test(failureWord(n.status, n.reason)) ? ` (HTTP ${n.status})` : "";
  const msg = providerMessage(n.reason);
  return `${n.model.provider}: ${failureWord(n.status, n.reason)}${status} — ${why}${msg ? `: ${msg}` : ""}`;
}

/** Wrap a StreamFn: a retryable failed turn (429 / 5xx / transport, never 400, never abort, never after
 *  a delta went out) is re-driven against the SAME model with the same args after an abortable
 *  full-jitter backoff, until it succeeds, a non-retryable outcome lands, or a cap (attempts / total
 *  budget / the run's deadline) stops it — then the LAST turn is yielded untouched so the router sees
 *  the genuine provider error. Never throws (ADR-003). */
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
      let streamed = ""; // every text delta this attempt let through — the answer the consumer has already seen
      try {
        for await (const ev of inner(model, messages, options)) {
          if (ev.type === "turn") turn = ev.turn;
          else { if (ev.type === "text_delta") streamed += ev.text; else if (ev.type === "reasoning_delta") streamed ||= " "; yield ev; } // deltas pass through live (header)
        }
      } catch (e) {
        yield { type: "turn", turn: errorTurn(e instanceof Error ? e.message : String(e)) }; // folded, not retried (header)
        return;
      }
      if (turn === null) { yield { type: "turn", turn: errorTurn("stream ended without a terminal turn") }; return; }
      const meta = httpErrorMeta(turn);
      const status = meta?.status ?? classifyStreamError(turn.error).status;
      // retry.ts:337-340: aborts never retry; 400/4xx-non-429 and non-error turns stand as they are
      if (turn.stopReason !== "error" || options?.signal?.aborted === true || !classifyStreamError(turn.error).retryable) {
        yield { type: "turn", turn };
        return;
      }
      if (streamed.length > 0) {
        // idempotency (header): part of the answer is on the screen — end the turn, keep that text as the
        // turn's parts (the loop stores it and the summary shows it above the error), say why no retry
        const kept = streamed.trim().length > 0 && turn.parts.length === 0 ? [{ kind: "text" as const, text: streamed }] : turn.parts;
        yield { type: "turn", turn: { ...turn, parts: kept, error: `${turn.error ?? "provider stream failed"} — the connection dropped after part of the answer had arrived; not retried, a retry would repeat it` } };
        return;
      }
      const note = { model, attempt, maxAttempts: maxRetries + 1, reason: turn.error ?? "error", ...(status !== undefined ? { status } : {}) };
      // retries off (ROVECODE_RETRY_MAX=0): nothing was ever going to be retried, so there is no giving up to announce
      if (attempt > maxRetries) { if (maxRetries > 0) opts.onGiveUp?.({ ...note, why: "attempts" }); yield { type: "turn", turn }; return; }
      const retryAfterMs = serverWaitMs(turn, now());
      const cap = Math.min(maxDelayMs, baseMs * 2 ** (attempt - 1));
      const delayMs = Math.max(Math.round(random() * cap), retryAfterMs ?? 0); // full jitter, server floor (retry.ts:476)
      const withHint = retryAfterMs !== undefined ? { retryAfterMs } : {};
      // budget: a wait that would end past the deadline is not taken — the failure surfaces now
      // and the router may advance at once (googleQuotaErrors.ts:286-289 shape)
      if (now() - startedAt + delayMs > totalMs) { opts.onGiveUp?.({ ...note, ...withHint, delayMs, why: "budget" }); yield { type: "turn", turn }; return; }
      // the run's own clock (--max-seconds): a wait that ends past it would only be cut off at the turn boundary
      if (options?.deadlineAt !== undefined && now() + delayMs > options.deadlineAt) { opts.onGiveUp?.({ ...note, ...withHint, delayMs, why: "deadline" }); yield { type: "turn", turn }; return; }
      opts.onRetry?.({ ...note, delayMs, ...withHint });
      await sleep(delayMs, options?.signal);
      if (options?.signal?.aborted) { yield { type: "turn", turn }; return; } // abort landed during backoff: last turn stands
    }
  };
}
