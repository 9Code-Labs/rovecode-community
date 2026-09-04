/** What happens on the wire when a provider misbehaves — through the REAL adapters (openaiCompatStreaming,
 *  anthropicStreaming) wrapped in withRetry, with a fake fetch and a fake sleep. Pinned, one case each
 *  (docs/wire-failures.md): 429 with Retry-After → the wait honours the header, then 200; 529 twice then
 *  200 → three requests, two notices in the human's words; 500 four times → four requests, the error turn
 *  keeps the provider's text and a give-up note names status + message; a socket reset AFTER the first token
 *  → NO retry, the partial text is kept as the turn's parts and the error says why; abort during the backoff →
 *  the sleep ends at once, nothing is retried; no response before the first byte → a transport failure that
 *  IS retried; the run's deadline → no wait that would overshoot it; anthropic-ratelimit-*-reset is a floor;
 *  the router does not advance its chain after content streamed. */

import { afterEach, expect, test } from "bun:test";
import type { Message, ModelRef, StreamEvent, StreamFn } from "../../src/core/types.ts";
import { anthropicStreaming, openaiCompatStreaming } from "../../src/providers/stream.ts";
import { describeGiveUp, describeRetry, withRetry, type GiveUpNote, type RetryNote } from "../../src/providers/retry.ts";
import { fetchFirstByte, providerMessage } from "../../src/providers/stream-errors.ts";
import { createRouter } from "../../src/providers/router.ts";

const real = globalThis.fetch;
afterEach(() => { globalThis.fetch = real; });

const msg = (text: string): Message => ({ role: "user", parts: [{ kind: "text", text }] } as Message);
const M: ModelRef = { provider: "anthropic", model: "claude-opus-5" };
const O: ModelRef = { provider: "openai", model: "gpt-5.2" };
const SSE_OK = 'data: {"choices":[{"delta":{"content":"hello"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
const ANTHROPIC_OK = [
  'data: {"type":"message_start","message":{"usage":{"input_tokens":3}}}',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}',
  'data: {"type":"content_block_stop","index":0}',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4}}',
  'data: {"type":"message_stop"}', "",
].join("\n\n");
const fail = (status: number, body: string, headers: Record<string, string> = {}) => new Response(body, { status, headers });

/** a fetch that answers from a queue of responses (or throws when the entry is an Error); counts calls */
function queue(answers: (Response | Error | ((init: RequestInit) => Promise<Response>))[]): { calls: number } {
  const state = { calls: 0 };
  globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
    const a = answers[Math.min(state.calls, answers.length - 1)]!;
    state.calls++;
    if (a instanceof Error) throw a;
    if (typeof a === "function") return a(init ?? {});
    return a.clone();
  }) as typeof fetch;
  return state;
}
/** a body that streams one chunk then dies mid-stream */
const resetAfterFirstToken = (): Response => new Response(new ReadableStream<Uint8Array>({
  start(c) { c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial "},"finish_reason":null}]}\n\n')); setTimeout(() => c.error(new Error("socket reset by peer")), 5); },
}), { status: 200, headers: { "content-type": "text/event-stream" } });

const sleeps: number[] = [];
const fakeSleep = async (ms: number, signal?: AbortSignal): Promise<void> => { sleeps.push(ms); if (signal?.aborted) return; };
afterEach(() => { sleeps.length = 0; });

async function drive(fn: StreamFn, model: ModelRef, options: { signal?: AbortSignal; deadlineAt?: number } = {}): Promise<{ events: StreamEvent[]; turn: Extract<StreamEvent, { type: "turn" }>["turn"] }> {
  const events: StreamEvent[] = [];
  for await (const ev of fn(model, [msg("hi")], options)) events.push(ev);
  const t = events.find((e): e is Extract<StreamEvent, { type: "turn" }> => e.type === "turn")!;
  return { events, turn: t.turn };
}
const wrap = (inner: StreamFn, notes: RetryNote[], gaveUp: GiveUpNote[], extra: Record<string, unknown> = {}): StreamFn =>
  withRetry(inner, { sleep: fakeSleep, random: () => 0.5, now: () => 1_000_000, onRetry: (n) => notes.push(n), onGiveUp: (n) => gaveUp.push(n), ...extra });

test("429 with Retry-After: the wait honours the header (a floor over the jittered backoff), then the retry succeeds; the notice is in the human's words", async () => {
  const q = queue([fail(429, '{"error":{"message":"Rate limit reached"}}', { "retry-after": "3" }), new Response(SSE_OK, { status: 200 })]);
  const notes: RetryNote[] = [], gaveUp: GiveUpNote[] = [];
  const { turn } = await drive(wrap(openaiCompatStreaming({ baseUrl: "http://stub.invalid/v1", apiKey: "k" }), notes, gaveUp), O);
  expect(q.calls).toBe(2);
  expect(sleeps).toEqual([3000]);
  expect(turn.stopReason).toBe("end_turn");
  expect(notes).toHaveLength(1);
  expect(notes[0]).toMatchObject({ attempt: 1, maxAttempts: 4, delayMs: 3000, status: 429, retryAfterMs: 3000 });
  expect(describeRetry(notes[0]!)).toBe("openai: rate limited — retrying in 3 s (2/4)");
  expect(gaveUp).toEqual([]);
});

test("529 overloaded twice, then 200: three requests, two notices, the answer arrives once", async () => {
  const q = queue([fail(529, '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'), fail(529, "Overloaded"), new Response(ANTHROPIC_OK, { status: 200 })]);
  const notes: RetryNote[] = [], gaveUp: GiveUpNote[] = [];
  const { events, turn } = await drive(wrap(anthropicStreaming({ baseUrl: "http://stub.invalid/v1", apiKey: "k" }), notes, gaveUp), M);
  expect(q.calls).toBe(3);
  expect(turn.stopReason).toBe("end_turn");
  expect(events.filter((e) => e.type === "text_delta").length).toBe(1); // no duplicate answer
  expect(notes.map(describeRetry)).toEqual(["anthropic: overloaded — retrying in 0.5 s (2/4)", "anthropic: overloaded — retrying in 1 s (3/4)"]); // full jitter at 0.5 × 1 s, 2 s
});

test("500 four times: four requests, then the error turn keeps the provider's exact text and the give-up note names status and message", async () => {
  const q = queue([fail(500, '{"error":{"message":"The server had an error while processing your request."}}')]);
  const notes: RetryNote[] = [], gaveUp: GiveUpNote[] = [];
  const { turn } = await drive(wrap(openaiCompatStreaming({ baseUrl: "http://stub.invalid/v1", apiKey: "k" }), notes, gaveUp), O);
  expect(q.calls).toBe(4);
  expect(sleeps).toEqual([500, 1000, 2000]);
  expect(turn.stopReason).toBe("error");
  expect(turn.error).toBe('HTTP 500: {"error":{"message":"The server had an error while processing your request."}}');
  expect(gaveUp).toHaveLength(1);
  expect(describeGiveUp(gaveUp[0]!)).toBe("openai: server error (HTTP 500) — gave up after 4 attempts: The server had an error while processing your request.");
  expect(providerMessage('HTTP 529: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}')).toBe("Overloaded");
  expect(providerMessage("HTTP 502: <html>bad gateway</html>")).toBe("<html>bad gateway</html>");
});

test("a socket reset AFTER the first token: no retry, the partial text survives as the turn's parts, the error says why", async () => {
  const q = queue([resetAfterFirstToken()]);
  const notes: RetryNote[] = [], gaveUp: GiveUpNote[] = [];
  const { events, turn } = await drive(wrap(openaiCompatStreaming({ baseUrl: "http://stub.invalid/v1", apiKey: "k" }), notes, gaveUp), O);
  expect(q.calls).toBe(1); // idempotency: never re-driven after content reached the consumer
  expect(events.filter((e) => e.type === "text_delta").map((e) => (e as { text: string }).text)).toEqual(["partial "]);
  expect(turn.stopReason).toBe("error");
  expect(turn.parts).toEqual([{ kind: "text", text: "partial " }]); // the loop stores this and shows it above the error row
  expect(turn.error).toMatch(/socket reset by peer — the connection dropped after part of the answer had arrived; not retried, a retry would repeat it$/);
  expect(notes).toEqual([]);
  expect(gaveUp).toEqual([]);
});

test("abort during the backoff: the sleep ends at once, nothing is retried, the last failure stands", async () => {
  const q = queue([fail(503, "busy", { "retry-after": "30" })]);
  const ac = new AbortController();
  const notes: RetryNote[] = [], gaveUp: GiveUpNote[] = [];
  const abortingSleep = async (ms: number, signal?: AbortSignal): Promise<void> => { sleeps.push(ms); ac.abort(); void signal; };
  const { turn } = await drive(wrap(openaiCompatStreaming({ baseUrl: "http://stub.invalid/v1", apiKey: "k" }), notes, gaveUp, { sleep: abortingSleep }), O, { signal: ac.signal });
  expect(q.calls).toBe(1);
  expect(sleeps).toEqual([30_000]);
  expect(turn.stopReason).toBe("error");
  expect(turn.error).toBe("HTTP 503: busy");
});

test("no response before the first byte: a transport failure named after the host, retried because nothing was streamed; the caller's own abort still wins", async () => {
  // a fetch that answers only by rejecting when its signal aborts — (url, init) like the real one; `queue` hands it the init alone
  const neverFetch = ((_u: unknown, init?: RequestInit) => new Promise<Response>((_, rej) => init?.signal?.addEventListener("abort", () => rej(new Error("aborted by signal"))))) as unknown as typeof fetch;
  const never = (init: RequestInit): Promise<Response> => neverFetch("", init);
  await expect(fetchFirstByte("http://stub.invalid/v1/x", { method: "POST" }, { timeoutMs: 20, fetchFn: neverFetch })).rejects.toThrow("no response from stub.invalid within 20 ms");
  const ac = new AbortController();
  const p = fetchFirstByte("http://stub.invalid/v1/x", { method: "POST", signal: ac.signal }, { timeoutMs: 10_000, fetchFn: neverFetch });
  ac.abort();
  await expect(p).rejects.toThrow("aborted by signal"); // the outer abort is not reported as a timeout
  // through the adapter: first attempt hangs → timeout → retry → 200
  const saved = process.env.ROVECODE_FIRST_BYTE_TIMEOUT_MS;
  process.env.ROVECODE_FIRST_BYTE_TIMEOUT_MS = "20";
  try {
    const q = queue([never, new Response(SSE_OK, { status: 200 })]);
    const notes: RetryNote[] = [], gaveUp: GiveUpNote[] = [];
    const { turn } = await drive(wrap(openaiCompatStreaming({ baseUrl: "http://stub.invalid/v1", apiKey: "k" }), notes, gaveUp), O);
    expect(q.calls).toBe(2);
    expect(turn.stopReason).toBe("end_turn");
    expect(notes[0]).toMatchObject({ reason: "no response from stub.invalid within 20 ms" });
    expect(describeRetry(notes[0]!)).toBe("openai: no response — retrying in 0.5 s (2/4)");
  } finally { if (saved === undefined) delete process.env.ROVECODE_FIRST_BYTE_TIMEOUT_MS; else process.env.ROVECODE_FIRST_BYTE_TIMEOUT_MS = saved; }
});

test("the run's deadline (--max-seconds): a wait that would end past it is not taken — the failure surfaces with a give-up note that says so; anthropic-ratelimit-*-reset is a floor like Retry-After", async () => {
  queue([fail(529, "Overloaded", { "anthropic-ratelimit-requests-reset": new Date(1_000_000 + 8_000).toISOString() })]);
  const notes: RetryNote[] = [], gaveUp: GiveUpNote[] = [];
  const { turn } = await drive(wrap(anthropicStreaming({ baseUrl: "http://stub.invalid/v1", apiKey: "k" }), notes, gaveUp), M, { deadlineAt: 1_000_000 + 5_000 });
  expect(sleeps).toEqual([]);
  expect(turn.error).toBe("HTTP 529: Overloaded");
  expect(gaveUp).toHaveLength(1);
  expect(gaveUp[0]).toMatchObject({ why: "deadline", delayMs: 8000, retryAfterMs: 8000, status: 529 });
  expect(describeGiveUp(gaveUp[0]!)).toBe("anthropic: overloaded (HTTP 529) — not retried: the run's time limit is closer than the 8 s wait: Overloaded");
  // with room before the deadline the same header is simply the floor
  queue([fail(529, "Overloaded", { "anthropic-ratelimit-tokens-reset": new Date(1_000_000 + 8_000).toISOString() }), new Response(ANTHROPIC_OK, { status: 200 })]);
  const n2: RetryNote[] = [];
  await drive(wrap(anthropicStreaming({ baseUrl: "http://stub.invalid/v1", apiKey: "k" }), n2, [], {}), M, { deadlineAt: 1_000_000 + 60_000 });
  expect(sleeps).toEqual([8000]);
  expect(n2[0]!.retryAfterMs).toBe(8000);
});

test("the router does not advance its chain after content streamed: the failure stands, no second answer under the first", async () => {
  let calls = 0;
  const flaky: StreamFn = async function* (model) {
    calls++;
    if (model.model === "a") { yield { type: "text_delta", text: "first words" }; yield { type: "turn", turn: { parts: [], stopReason: "error", usage: { input: 0, output: 0 }, error: "socket reset by peer" } }; return; }
    yield { type: "text_delta", text: "second answer" }; yield { type: "turn", turn: { parts: [{ kind: "text", text: "second answer" }], stopReason: "end_turn", usage: { input: 0, output: 1 } } };
  };
  const router = createRouter({ roles: { default: [{ provider: "p", model: "a" }, { provider: "p", model: "b" }] } as never });
  const { events, turn } = await drive(router.wrap(flaky), { provider: "p", model: "a" });
  expect(calls).toBe(1);
  expect(events.filter((e) => e.type === "text_delta").length).toBe(1);
  expect(turn.stopReason).toBe("error");
});
