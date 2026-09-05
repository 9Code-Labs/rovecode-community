/** Port #23 tests: same-model retry with exponential backoff, composed INSIDE the router. Each
 *  test names the mutation it kills (M#, see the port report). Seam facts pinned here:
 *  - retryable failures re-drive the SAME model with identical args; success ends the loop
 *  - full-jitter schedule U[0,1)·min(max, base·2ⁿ), pinned through injected random/sleep
 *  - Retry-After (delta-seconds + HTTP-date) is a floor on the sleep; beyond the budget → no wait
 *  - attempt cap and total-ms cap each stop retrying; 400 never; 5xx/transport yes
 *  - aborts never retry, and a REAL backoff sleep wakes on abort at once (ref'd timer cleared)
 *  - per-invocation state; the adapters record status + Retry-After (stream-errors.ts) and the
 *    side-channel survives the tool-call middleware
 *  - exhaust-then-advance when composed inside the router (module-level twin of the wiring test) */

import { test, expect } from "bun:test";
import {
  DEFAULT_BASE_MS, DEFAULT_MAX_RETRIES, parseRetryAfter, retryOptionsFromEnv, sleepMs, withRetry, type RetryNote,
} from "../../src/providers/retry.ts";
import { failedTurn, httpErrorMeta, httpErrorTurn } from "../../src/providers/stream-errors.ts";
import { anthropicStream, openaiCompatStream, openaiCompatStreaming, textTurn } from "../../src/providers/stream.ts";
import { withToolCallParsing } from "../../src/providers/middleware.ts";
import { createRouter, type RouterNote } from "../../src/providers/router.ts";
import type { AssistantTurn, Message, ModelRef, StreamEvent, StreamFn, StreamOptions } from "../../src/core/types.ts";

const MODEL: ModelRef = { provider: "p", model: "m" };
const messages: Message[] = [{ id: "u1", role: "user", parts: [{ kind: "text", text: "hi" }], parentId: null, createdAt: 0 }];
const err = (msg: string): AssistantTurn => ({ parts: [], stopReason: "error", usage: { input: 0, output: 0 }, error: msg });
const ok = textTurn("served");

interface Call { model: ModelRef; messages: Message[]; options: StreamOptions | undefined }

/** Scripted inner seam: yields turns in order (last repeats), records every call's args. */
function scripted(turns: AssistantTurn[]): { stream: StreamFn; calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  const stream: StreamFn = async function* (model, msgs, options): AsyncGenerator<StreamEvent> {
    calls.push({ model, messages: msgs, options });
    yield { type: "turn", turn: turns[Math.min(i++, turns.length - 1)]! };
  };
  return { stream, calls };
}

/** Recording sleep: never actually waits (schedule assertions read `delays`). */
function fakeSleep(): { delays: number[]; sleep: (ms: number) => Promise<void> } {
  const delays: number[] = [];
  return { delays, sleep: async (ms) => { delays.push(ms); } };
}

async function run(fn: StreamFn, options?: StreamOptions, model: ModelRef = MODEL): Promise<{ events: StreamEvent[]; turn: AssistantTurn }> {
  const events: StreamEvent[] = [];
  let turn: AssistantTurn | null = null;
  for await (const ev of fn(model, messages, options)) {
    events.push(ev);
    if (ev.type === "turn") turn = ev.turn;
  }
  expect(turn).not.toBeNull(); // the wrapper always yields a terminal turn, never throws
  return { events, turn: turn! };
}

/** 429 turn built by the REAL adapter helper (so the Retry-After side-channel is attached). */
const rateLimited = (retryAfter?: string): Promise<AssistantTurn> =>
  httpErrorTurn(new Response("rate limited", { status: 429, headers: retryAfter === undefined ? {} : { "retry-after": retryAfter } }));

/** Bounded await (acp.test.ts idiom): a hang-shaped mutant fails here instead of hanging bun. */
function deadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const bomb = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error(`${what}: not settled within ${ms}ms`)), ms); });
  return Promise.race([p, bomb]).finally(() => clearTimeout(t));
}

/** Poll with ref'd timers (never a bare unsettled await). */
async function until(pred: () => boolean, ms = 1_000): Promise<void> {
  const start = performance.now();
  while (!pred()) {
    if (performance.now() - start > ms) throw new Error(`condition not met within ${ms}ms`);
    await new Promise<void>((r) => setTimeout(r, 1));
  }
}

const STUB = { baseUrl: "http://stub.invalid/v1", apiKey: "k" };
const okJson = (content: string): Response =>
  Response.json({ choices: [{ message: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } });

// ---------- same model, same args; success ends the loop ----------

test("429, 429, 200 → three inner calls with identical args; the success turn is yielded (M1: never retry → 1 call)", async () => {
  const { stream, calls } = scripted([err("HTTP 429: a"), err("HTTP 429: b"), ok]);
  const { delays, sleep } = fakeSleep();
  const notes: RetryNote[] = [];
  const options: StreamOptions = { tools: [{ name: "read", description: "", args: {} }] };
  const { turn } = await run(withRetry(stream, { sleep, random: () => 0.5, baseMs: 1000, onRetry: (n) => notes.push(n) }), options);
  expect(turn).toBe(ok);
  expect(calls).toHaveLength(3);
  for (const c of calls) { expect(c.model).toBe(MODEL); expect(c.messages).toBe(messages); expect(c.options).toBe(options); }
  expect(delays).toEqual([500, 1000]);
  expect(notes.map((n) => [n.attempt, n.delayMs, n.reason, n.retryAfterMs])).toEqual([[1, 500, "HTTP 429: a", undefined], [2, 1000, "HTTP 429: b", undefined]]);
});

// ---------- backoff schedule ----------

test("backoff schedule: full jitter U·min(max, base·2ⁿ), pinned with an injected random (M2: no backoff → all zeros)", async () => {
  const cases: [number, number[]][] = [[0.5, [500, 1000, 1500, 1500, 1500]], [0.25, [250, 500, 750, 750, 750]], [0, [0, 0, 0, 0, 0]]];
  for (const [r, want] of cases) {
    const { stream } = scripted([err("HTTP 503: overloaded")]);
    const { delays, sleep } = fakeSleep();
    await run(withRetry(stream, { sleep, random: () => r, baseMs: 1000, maxDelayMs: 3000, maxRetries: 5, totalMs: 1e9 }));
    expect(delays).toEqual(want);
  }
  // upper edge: random just below 1 never exceeds min(maxDelayMs, base·2ⁿ)
  const { stream } = scripted([err("HTTP 503: overloaded")]);
  const { delays, sleep } = fakeSleep();
  await run(withRetry(stream, { sleep, random: () => 0.999, baseMs: 1000, maxDelayMs: 3000, maxRetries: 4, totalMs: 1e9 }));
  const caps = [1000, 2000, 3000, 3000];
  expect(delays).toHaveLength(4);
  delays.forEach((d, i) => { expect(d).toBeLessThanOrEqual(caps[i]!); expect(d).toBeGreaterThan(caps[i]! * 0.99); });
});

// ---------- Retry-After ----------

test("Retry-After delta-seconds: a floor over the jittered backoff, honored exactly (M3: ignored → 500)", async () => {
  const t429 = await rateLimited("7");
  expect(httpErrorMeta(t429)).toEqual({ status: 429, retryAfter: "7" });
  const { stream, calls } = scripted([t429, ok]);
  const { delays, sleep } = fakeSleep();
  const notes: RetryNote[] = [];
  const { turn } = await run(withRetry(stream, { sleep, random: () => 0.5, baseMs: 1000, onRetry: (n) => notes.push(n) }));
  expect(turn).toBe(ok);
  expect(calls).toHaveLength(2);
  expect(delays).toEqual([7000]);
  expect(notes[0]?.retryAfterMs).toBe(7000);
  // a floor, not a replacement: a larger jittered backoff still wins (retry.ts:476 max semantics)
  const small = await rateLimited("1");
  const s2 = scripted([small, small, ok]);
  const f2 = fakeSleep();
  await run(withRetry(s2.stream, { sleep: f2.sleep, random: () => 0.9, baseMs: 4000 }));
  expect(f2.delays).toEqual([3600, 7200]);
});

test("Retry-After HTTP-date: honored relative to the injected clock; a past date adds nothing", async () => {
  const T0 = Date.UTC(2026, 8, 2, 12, 0, 0); // whole second — HTTP-dates carry no ms
  const future = await rateLimited(new Date(T0 + 12_000).toUTCString());
  const s1 = scripted([future, ok]);
  const f1 = fakeSleep();
  await run(withRetry(s1.stream, { sleep: f1.sleep, random: () => 0, baseMs: 1000, now: () => T0 }));
  expect(f1.delays).toEqual([12_000]);
  const past = await rateLimited(new Date(T0 - 60_000).toUTCString());
  const s2 = scripted([past, ok]);
  const f2 = fakeSleep();
  await run(withRetry(s2.stream, { sleep: f2.sleep, random: () => 0.5, baseMs: 1000, now: () => T0 }));
  expect(f2.delays).toEqual([500]);
});

test("Retry-After beyond the total budget: no wait, the failure surfaces at once (googleQuotaErrors.ts:286-289 shape)", async () => {
  const t429 = await rateLimited("3600");
  const { stream, calls } = scripted([t429, ok]);
  const { delays, sleep } = fakeSleep();
  const { turn } = await run(withRetry(stream, { sleep, random: () => 0.5, baseMs: 1000, totalMs: 60_000 }));
  expect(turn).toBe(t429); // yielded untouched — the router classifies the genuine 429 and may advance now
  expect(calls).toHaveLength(1);
  expect(delays).toEqual([]);
});

test("parseRetryAfter: delay-seconds, fractional, HTTP-date, past date, garbage", () => {
  const now = Date.UTC(2026, 8, 2, 12, 0, 0);
  expect(parseRetryAfter("7", now)).toBe(7000);
  expect(parseRetryAfter(" 0 ", now)).toBe(0);
  expect(parseRetryAfter("1.5", now)).toBe(1500);
  expect(parseRetryAfter(new Date(now + 30_000).toUTCString(), now)).toBe(30_000);
  expect(parseRetryAfter(new Date(now - 30_000).toUTCString(), now)).toBe(0);
  expect(parseRetryAfter("soon", now)).toBeUndefined();
  expect(parseRetryAfter("", now)).toBeUndefined();
  expect(parseRetryAfter(undefined, now)).toBeUndefined();
});

// ---------- caps ----------

test("attempt cap: maxRetries N → N+1 inner calls, then the last failure surfaces untouched; 0 disables", async () => {
  const s = scripted([err("HTTP 429: still")]);
  const f = fakeSleep();
  const { turn } = await run(withRetry(s.stream, { sleep: f.sleep, random: () => 0.5, baseMs: 1000, maxRetries: 2 }));
  expect(s.calls).toHaveLength(3);
  expect(f.delays).toEqual([500, 1000]);
  expect(turn.stopReason).toBe("error");
  expect(turn.error).toBe("HTTP 429: still");
  const off = scripted([err("HTTP 429: still"), ok]);
  const f0 = fakeSleep();
  const r0 = await run(withRetry(off.stream, { sleep: f0.sleep, maxRetries: 0 }));
  expect(off.calls).toHaveLength(1);
  expect(f0.delays).toEqual([]);
  expect(r0.turn.error).toBe("HTTP 429: still");
});

test("total-ms cap: a backoff that would end past the deadline is not taken (clock advanced by the fake sleep)", async () => {
  let t = 1_000_000;
  const delays: number[] = [];
  const sleep = async (ms: number): Promise<void> => { delays.push(ms); t += ms; };
  const s = scripted([err("HTTP 502: bad gateway")]);
  const { turn } = await run(withRetry(s.stream, { sleep, random: () => 1, baseMs: 1000, maxRetries: 10, totalMs: 2500, now: () => t }));
  // 1000 (ends at 1000 ≤ 2500) is taken; 2000 would end at 3000 > 2500 → stop with the failure
  expect(delays).toEqual([1000]);
  expect(s.calls).toHaveLength(2);
  expect(turn.error).toBe("HTTP 502: bad gateway");
});

// ---------- classification: only 429 / 5xx / transport ----------

test("400 and every other non-429 4xx are never retried — one call, no sleep, even with Retry-After (M4: retry on 400 → 2 calls)", async () => {
  for (const status of [400, 401, 403, 404, 422]) {
    const t = await httpErrorTurn(new Response("nope", { status, headers: { "retry-after": "1" } }));
    const s = scripted([t, ok]);
    const f = fakeSleep();
    const { turn } = await run(withRetry(s.stream, { sleep: f.sleep }));
    expect(turn).toBe(t);
    expect(s.calls).toHaveLength(1);
    expect(f.delays).toEqual([]);
  }
});

test("5xx and transport failures are retried; a REAL adapter's thrown-fetch turn counts as transport", async () => {
  const firsts = [err("HTTP 500: boom"), err("HTTP 502: bad gateway"), err("HTTP 503: overloaded"), err("HTTP 529: overloaded"), err("fetch failed"), err("Unable to connect")];
  for (const first of firsts) {
    const s = scripted([first, ok]);
    const f = fakeSleep();
    const { turn } = await run(withRetry(s.stream, { sleep: f.sleep, random: () => 0.5, baseMs: 1000 }));
    expect(turn).toBe(ok);
    expect(s.calls).toHaveLength(2);
    expect(f.delays).toEqual([500]);
  }
  const real = globalThis.fetch;
  let n = 0;
  globalThis.fetch = (async () => { if (n++ === 0) throw new TypeError("fetch failed"); return okJson("up again"); }) as unknown as typeof fetch;
  try {
    const f = fakeSleep();
    const { turn } = await run(withRetry(openaiCompatStream(STUB), { sleep: f.sleep, random: () => 0.5, baseMs: 1000 }));
    expect(turn.stopReason).toBe("end_turn");
    expect(turn.parts).toEqual([{ kind: "text", text: "up again" }]);
    expect(f.delays).toEqual([500]);
    expect(n).toBe(2);
  } finally { globalThis.fetch = real; }
});

test("non-error turns are never re-driven: end_turn / tool_use / length / aborted pass through once", async () => {
  const turns: AssistantTurn[] = [ok, { ...ok, stopReason: "tool_use" }, { ...ok, stopReason: "length" }, { parts: [], stopReason: "aborted", usage: { input: 0, output: 0 } }];
  for (const t of turns) {
    const s = scripted([t, err("HTTP 429: never seen")]);
    const f = fakeSleep();
    const { turn } = await run(withRetry(s.stream, { sleep: f.sleep }));
    expect(turn).toBe(t);
    expect(s.calls).toHaveLength(1);
    expect(f.delays).toEqual([]);
  }
});

// ---------- abort ----------

test("aborted signal: a retryable failure is yielded untouched — no sleep, no second call (M5: retry after abort)", async () => {
  const ac = new AbortController();
  ac.abort();
  const s = scripted([err("HTTP 429: limited"), ok]);
  const f = fakeSleep();
  const { turn } = await run(withRetry(s.stream, { sleep: f.sleep }), { signal: ac.signal });
  expect(turn.error).toBe("HTTP 429: limited");
  expect(s.calls).toHaveLength(1);
  expect(f.delays).toEqual([]);
});

test("abort DURING the real backoff sleep wakes it at once and nothing is retried (M5 twin; M6: unabortable sleep → deadline)", async () => {
  const t429 = await rateLimited("30"); // 30s server floor — only the abort can end the wait inside the deadline
  const s = scripted([t429, ok]);
  const ac = new AbortController();
  const notes: RetryNote[] = [];
  const done = run(withRetry(s.stream, { onRetry: (n) => notes.push(n) }), { signal: ac.signal }); // REAL sleepMs
  // wait for the 429 to have LANDED, not for 30 ms of wall clock: under a loaded suite the note had not
  // been recorded yet and the test failed in 120 ms — a claim about the machine, not about the wrapper
  await until(() => notes.length === 1, 5_000); // the wrapper is now inside its sleep (ref'd timer)
  expect(notes).toHaveLength(1);
  expect(notes[0]?.delayMs).toBe(30_000);
  const abortedAt = performance.now();
  ac.abort();
  const { turn } = await deadline(done, 2_000, "retry wrapper after abort");
  // woke through the abort listener, not through the 30 s timer. The whole distinction is 30_000 against
  // "at once", so the bound only has to be far below the delay it is separating from — 50 ms was measuring
  // how quickly this machine gets back to the event loop.
  expect(performance.now() - abortedAt).toBeLessThan(1_000);
  expect(turn).toBe(t429); // the last provider outcome stands (router: aborted → no advance)
  expect(s.calls).toHaveLength(1);
});

test("sleepMs: abort clears the ref'd timer; a natural wake removes the abort listener; pre-aborted resolves at once", async () => {
  const realClear = globalThis.clearTimeout;
  let cleared = 0;
  globalThis.clearTimeout = ((t: Parameters<typeof clearTimeout>[0]) => { cleared++; realClear(t); }) as typeof clearTimeout;
  let p: Promise<void>;
  let clearedByAbort: number;
  try {
    const ac = new AbortController();
    p = sleepMs(60_000, ac.signal);
    ac.abort(); // the abort listener settles synchronously: timer cleared right here
    clearedByAbort = cleared;
  } finally { globalThis.clearTimeout = realClear; }
  await deadline(p, 1_000, "sleepMs after abort");
  expect(clearedByAbort).toBe(1);

  const ac2 = new AbortController();
  let removed = 0;
  const orig = ac2.signal.removeEventListener.bind(ac2.signal);
  ac2.signal.removeEventListener = ((...a: Parameters<AbortSignal["removeEventListener"]>) => { removed++; orig(...a); }) as AbortSignal["removeEventListener"];
  await deadline(sleepMs(1, ac2.signal), 1_000, "sleepMs natural wake");
  expect(removed).toBe(1);

  const ac3 = new AbortController();
  ac3.abort();
  await deadline(sleepMs(60_000, ac3.signal), 100, "sleepMs pre-aborted");
});

// ---------- per-invocation state ----------

test("per-invocation isolation: an invocation starting while another is mid-backoff neither resets nor inflates its attempt count (M7: shared counter → a 3rd backoff)", async () => {
  const gates: (() => void)[] = []; // each sleep parks until the test releases it — deterministic interleaving
  const sleep = (): Promise<void> => new Promise((r) => { gates.push(r); });
  const calls: string[] = [];
  const inner: StreamFn = async function* (model): AsyncGenerator<StreamEvent> {
    calls.push(model.model);
    yield { type: "turn", turn: model.model === "a" ? err("HTTP 429: a limited") : textTurn("b served") };
  };
  const notes: RetryNote[] = [];
  const wrapped = withRetry(inner, { sleep, random: () => 0.5, baseMs: 1000, maxRetries: 2, onRetry: (n) => notes.push(n) });
  const a = run(wrapped, undefined, { provider: "p", model: "a" });
  await until(() => gates.length === 1); // a#1 failed — first backoff pending
  gates[0]!();
  await until(() => gates.length === 2); // a#2 failed — second backoff pending, `a` sits at attempt 2
  // a fresh invocation on the same wrapper starts and finishes while `a` is parked
  const b = await deadline(run(wrapped, undefined, { provider: "p", model: "b" }), 1_000, "b while a is mid-backoff");
  expect(b.turn.parts).toEqual([{ kind: "text", text: "b served" }]);
  gates[1]!();
  // a#3 fails → its OWN cap (1 + 2 retries) is reached → the failure surfaces; a shared counter reset by b's
  // start would read 2 here, take a third backoff (gate 3) and never settle inside the deadline
  const ra = await deadline(a, 1_000, "a after its two retries");
  expect(ra.turn.error).toBe("HTTP 429: a limited");
  expect(calls).toEqual(["a", "a", "b", "a"]);
  expect(gates).toHaveLength(2);
  expect(notes.map((n) => [n.model.model, n.attempt])).toEqual([["a", 1], ["a", 2]]);
});

// ---------- seam-contract violations + pass-through ----------

test("a throwing inner stream is folded into an error turn — never retried, never thrown; so is a stream with no terminal turn", async () => {
  let calls = 0;
  const boom: StreamFn = async function* (): AsyncGenerator<StreamEvent> { calls++; throw new Error("adapter bug"); };
  const f = fakeSleep();
  const { turn } = await run(withRetry(boom, { sleep: f.sleep }));
  expect(turn).toMatchObject({ stopReason: "error", error: "adapter bug" });
  expect(calls).toBe(1);
  expect(f.delays).toEqual([]);
  let calls2 = 0;
  const silent: StreamFn = async function* (): AsyncGenerator<StreamEvent> { calls2++; };
  const r2 = await run(withRetry(silent, { sleep: f.sleep }));
  expect(r2.turn.error).toBe("stream ended without a terminal turn");
  expect(calls2).toBe(1);
});

test("idempotency: an attempt that already streamed a delta is NOT retried — the delta stands once, the turn keeps it as its parts, the error says why (2026-09-04; before this a retry re-streamed the answer)", async () => {
  let n = 0;
  const inner: StreamFn = async function* (): AsyncGenerator<StreamEvent> {
    n++;
    yield { type: "text_delta", text: `d${n}` };
    yield { type: "turn", turn: n === 1 ? err("HTTP 503: overloaded") : ok };
  };
  const f = fakeSleep();
  const { events, turn } = await run(withRetry(inner, { sleep: f.sleep, random: () => 0 }));
  expect(events.map((e) => (e.type === "text_delta" ? e.text : e.type))).toEqual(["d1", "turn"]);
  expect(n).toBe(1);
  expect(f.delays).toEqual([]);
  expect(turn.stopReason).toBe("error");
  expect(turn.parts).toEqual([{ kind: "text", text: "d1" }]);
  expect(turn.error).toBe("HTTP 503: overloaded — the connection dropped after part of the answer had arrived; not retried, a retry would repeat it");
  // nothing streamed before the failure → the retry goes ahead and the deltas of the success are the only ones
  let m = 0;
  const quiet: StreamFn = async function* (): AsyncGenerator<StreamEvent> {
    m++;
    if (m === 1) { yield { type: "turn", turn: err("HTTP 503: overloaded") }; return; }
    yield { type: "text_delta", text: "d2" };
    yield { type: "turn", turn: ok };
  };
  const g = fakeSleep();
  const r2 = await run(withRetry(quiet, { sleep: g.sleep, random: () => 0 }));
  expect(r2.events.map((e) => (e.type === "text_delta" ? e.text : e.type))).toEqual(["d2", "turn"]);
  expect(r2.turn).toBe(ok);
});

// ---------- env knobs ----------

test("retryOptionsFromEnv: defaults, parsing, 0 honored (off), invalid/blank → default", () => {
  expect(retryOptionsFromEnv({})).toEqual({ maxRetries: DEFAULT_MAX_RETRIES, baseMs: DEFAULT_BASE_MS });
  expect(retryOptionsFromEnv({ ROVECODE_RETRY_MAX: "0", ROVECODE_RETRY_BASE_MS: "250" })).toEqual({ maxRetries: 0, baseMs: 250 });
  expect(retryOptionsFromEnv({ ROVECODE_RETRY_MAX: "7.9", ROVECODE_RETRY_BASE_MS: " 40 " })).toEqual({ maxRetries: 7, baseMs: 40 });
  expect(retryOptionsFromEnv({ ROVECODE_RETRY_MAX: "abc", ROVECODE_RETRY_BASE_MS: "0" })).toEqual({ maxRetries: DEFAULT_MAX_RETRIES, baseMs: DEFAULT_BASE_MS });
  expect(retryOptionsFromEnv({ ROVECODE_RETRY_MAX: "-1", ROVECODE_RETRY_BASE_MS: "" })).toEqual({ maxRetries: DEFAULT_MAX_RETRIES, baseMs: DEFAULT_BASE_MS });
  expect(DEFAULT_MAX_RETRIES).toBe(3);
  expect(DEFAULT_BASE_MS).toBe(1000); // 2026-09-04: ~1 s base, 20 s cap (docs/wire-failures.md)
});

// ---------- stream-errors: adapters record status + Retry-After; abort semantics unchanged ----------

test("stream-errors: all three REAL adapters record status + Retry-After on HTTP error turns, text unchanged; 2xx carries no meta", async () => {
  const real = globalThis.fetch;
  const respond = (init: ResponseInit, body: string): void => { globalThis.fetch = (async () => new Response(body, init)) as unknown as typeof fetch; };
  try {
    const adapters: [string, StreamFn][] = [
      ["openai", openaiCompatStream(STUB)],
      ["sse", openaiCompatStreaming(STUB)],
      ["anthropic", anthropicStream(STUB)],
    ];
    for (const [name, fn] of adapters) {
      respond({ status: 429, headers: { "Retry-After": "12" } }, "rate limited");
      const { turn } = await run(fn);
      expect([name, turn.stopReason, turn.error]).toEqual([name, "error", "HTTP 429: rate limited"]);
      expect(httpErrorMeta(turn)).toEqual({ status: 429, retryAfter: "12" });
      respond({ status: 503 }, "overloaded");
      const { turn: t503 } = await run(fn);
      expect([name, t503.error]).toEqual([name, "HTTP 503: overloaded"]);
      expect(httpErrorMeta(t503)).toEqual({ status: 503 });
    }
    globalThis.fetch = (async () => okJson("fine")) as unknown as typeof fetch;
    const { turn: fine } = await run(openaiCompatStream(STUB));
    expect(fine.stopReason).toBe("end_turn");
    expect(httpErrorMeta(fine)).toBeUndefined();
  } finally { globalThis.fetch = real; }
});

test("failedTurn (moved to stream-errors.ts): aborted signal → 'aborted' keeping salvaged text; otherwise 'error' with the message", () => {
  const ac = new AbortController();
  ac.abort();
  expect(failedTurn(new Error("The operation was aborted"), ac.signal, "partial")).toEqual({ parts: [{ kind: "text", text: "partial" }], stopReason: "aborted", usage: { input: 0, output: 0 } });
  expect(failedTurn(new Error("The operation was aborted"), ac.signal)).toEqual({ parts: [], stopReason: "aborted", usage: { input: 0, output: 0 } });
  expect(failedTurn(new TypeError("fetch failed"), new AbortController().signal, "partial")).toEqual({ parts: [], stopReason: "error", usage: { input: 0, output: 0 }, error: "fetch failed" });
  expect(failedTurn("plain string", undefined)).toEqual({ parts: [], stopReason: "error", usage: { input: 0, output: 0 }, error: "plain string" });
});

test("the Retry-After side-channel survives the tool-call middleware: withRetry(withToolCallParsing(adapter)) honors it", async () => {
  const real = globalThis.fetch;
  let n = 0;
  globalThis.fetch = (async () => (n++ === 0 ? new Response("rate limited", { status: 429, headers: { "retry-after": "3" } }) : okJson("recovered"))) as unknown as typeof fetch;
  try {
    const f = fakeSleep();
    const { turn } = await run(withRetry(withToolCallParsing(openaiCompatStream(STUB)), { sleep: f.sleep, random: () => 0 }));
    expect(turn.parts).toEqual([{ kind: "text", text: "recovered" }]);
    expect(f.delays).toEqual([3000]);
    expect(n).toBe(2);
  } finally { globalThis.fetch = real; }
});

// ---------- router interplay (module-level twin of retry-wiring.test.ts) ----------

test("inside the router: retries exhaust on candidate N, THEN the chain advances — one note; the swapped order advances at once (M8)", async () => {
  const A: ModelRef = { provider: "p", model: "A" };
  const B: ModelRef = { provider: "p", model: "B" };
  const calls: string[] = [];
  const inner: StreamFn = async function* (model): AsyncGenerator<StreamEvent> {
    calls.push(model.model);
    yield { type: "turn", turn: model.model === "A" ? err("HTTP 429: A limited") : textTurn("B served") };
  };
  const notes: RouterNote[] = [];
  const f = fakeSleep();
  const retryOpts = { sleep: f.sleep, random: () => 0.5, baseMs: 1000, maxRetries: 2 };
  const router = createRouter({ roles: { default: [A, B] }, onNote: (n) => notes.push(n) });
  const { turn } = await run(router.wrap(withRetry(inner, retryOpts)), undefined, A);
  expect(calls).toEqual(["A", "A", "A", "B"]); // exhaust (1 + 2 retries) THEN advance
  expect(turn.parts).toEqual([{ kind: "text", text: "B served" }]);
  expect(notes).toEqual([{ chain: "default", from: A, to: B, reason: "HTTP 429: A limited" }]);
  expect(f.delays).toEqual([500, 1000]);

  calls.length = 0; notes.length = 0; f.delays.length = 0;
  const router2 = createRouter({ roles: { default: [A, B] }, onNote: (n) => notes.push(n) });
  await run(withRetry(router2.wrap(inner), retryOpts), undefined, A);
  expect(calls).toEqual(["A", "B"]); // retry OUTSIDE the router never retries A: the router advanced on the first 429
  expect(f.delays).toEqual([]);
  expect(notes).toHaveLength(1);
});
