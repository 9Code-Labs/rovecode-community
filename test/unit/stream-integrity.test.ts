import { afterEach, expect, test } from "bun:test";
import type { AssistantTurn, StreamFn, StreamOptions } from "../../src/core/types.ts";
import { anthropicStream, anthropicStreaming, openaiCompatStream, openaiCompatStreaming } from "../../src/providers/stream.ts";
import { withRetry } from "../../src/providers/retry.ts";
import { sseData, streamIdleTimeoutMs } from "../../src/providers/sse.ts";

const original = globalThis.fetch;
const savedTimeout = process.env.ROVECODE_STREAM_IDLE_TIMEOUT_MS;
afterEach(() => {
  globalThis.fetch = original;
  if (savedTimeout === undefined) delete process.env.ROVECODE_STREAM_IDLE_TIMEOUT_MS;
  else process.env.ROVECODE_STREAM_IDLE_TIMEOUT_MS = savedTimeout;
});
const opts = { baseUrl: "http://stub.invalid/v1", apiKey: "test" };
const sse = (...events: unknown[]) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
function respond(body: string | ReadableStream<Uint8Array>, contentType = "text/event-stream") {
  globalThis.fetch = (async () => new Response(body, { headers: { "content-type": contentType } })) as unknown as typeof fetch;
}
async function drive(stream: StreamFn, options?: StreamOptions): Promise<{ turn: AssistantTurn; text: string }> {
  let text = "";
  let turn: AssistantTurn | undefined;
  for await (const ev of stream({ provider: "test", model: "test" }, [], options)) {
    if (ev.type === "text_delta") text += ev.text;
    if (ev.type === "turn") turn = ev.turn;
  }
  if (!turn) throw new Error("no terminal turn");
  return { turn, text };
}
const openCall = (args: string) => ({ index: 0, id: "c1", function: { name: "read", arguments: args } });

for (const [name, factory, prefix] of [
  ["OpenAI", openaiCompatStreaming, sse({ choices: [{ delta: { tool_calls: [openCall('{"path":"a"}')] } }] })],
  ["Anthropic", anthropicStreaming, sse(
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "c1", name: "read" } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":"a"}' } },
  )],
] as const) {
  for (const body of ["", prefix]) test(`${name}: EOF without a finish reason is an error, never executable tools`, async () => {
    respond(body);
    const { turn } = await drive(factory(opts));
    expect(turn.stopReason).toBe("error");
    expect(turn.error).toContain("finish reason");
    expect(turn.parts.some((p) => p.kind === "tool_call")).toBe(false);
  });
}

test("OpenAI: HTTP 200 SSE error envelope is surfaced with the provider message", async () => {
  respond(sse({ error: { message: "quota exhausted", type: "insufficient_quota" } }));
  const { turn } = await drive(openaiCompatStreaming(opts));
  expect(turn.stopReason).toBe("error");
  expect(turn.error).toContain("quota exhausted");
});

for (const factory of [openaiCompatStream, anthropicStream, openaiCompatStreaming, anthropicStreaming]) {
  test(`${factory.name}: malformed HTTP 200 JSON is not an empty success`, async () => {
    respond(JSON.stringify({ error: { message: "provider rejected request" } }), "application/json");
    const { turn } = await drive(factory(opts));
    expect(turn.stopReason).toBe("error");
    expect(turn.error).toContain("provider rejected request");
  });
}

for (const args of ['{"path":', "null", "[]", '"oops"']) {
  for (const factory of [openaiCompatStream, openaiCompatStreaming]) test(`${factory.name}: invalid tool arguments ${args} fail closed`, async () => {
    respond(factory === openaiCompatStream
      ? JSON.stringify({ choices: [{ message: { content: null, tool_calls: [openCall(args)] }, finish_reason: "tool_calls" }] })
      : sse({ choices: [{ delta: { tool_calls: [openCall(args)] }, finish_reason: "tool_calls" }] }),
      factory === openaiCompatStream ? "application/json" : "text/event-stream");
    const { turn } = await drive(factory(opts));
    expect(turn.stopReason).toBe("error");
    expect(turn.error).toContain("tool arguments");
    expect(turn.parts.some((p) => p.kind === "tool_call")).toBe(false);
  });
}

for (const calls of [
  [{ ...openCall("{}"), id: "" }],
  [{ ...openCall("{}"), function: { name: "", arguments: "{}" } }],
  [openCall("{}"), { ...openCall("{}"), index: 1 }],
  [],
]) test("OpenAI: missing/duplicate tool identities or empty tool_use are rejected", async () => {
  respond(sse({ choices: [{ delta: { tool_calls: calls }, finish_reason: "tool_calls" }] }));
  const { turn } = await drive(openaiCompatStreaming(opts));
  expect(turn.stopReason).toBe("error");
  expect(turn.parts).toEqual([]);
});

for (const factory of [anthropicStream, anthropicStreaming]) test(`${factory.name}: non-object tool input is rejected`, async () => {
  const block = { type: "tool_use", id: "c1", name: "read", input: [] };
  respond(factory === anthropicStream ? JSON.stringify({ content: [block], stop_reason: "tool_use" }) : sse(
    { type: "content_block_start", index: 0, content_block: block },
    { type: "message_delta", delta: { stop_reason: "tool_use" } },
    { type: "message_stop" },
  ), factory === anthropicStream ? "application/json" : "text/event-stream");
  const { turn } = await drive(factory(opts));
  expect(turn.stopReason).toBe("error");
  expect(turn.error).toContain("tool arguments");
});

test("Anthropic preserves initial text/input blocks and stops reading at message_stop", async () => {
  let cancelled = false;
  respond(new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(new TextEncoder().encode(sse(
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "checking" } },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "c1", name: "read", input: { path: "a" } } },
      { type: "message_delta", delta: { stop_reason: "tool_use" } },
      { type: "message_stop" },
    ))); },
    cancel() { cancelled = true; },
  }));
  const { turn, text } = await drive(anthropicStreaming(opts));
  expect(text).toBe("checking");
  expect(turn.parts).toEqual([{ kind: "text", text: "checking" }, { kind: "tool_call", id: "c1", tool: "read", args: { path: "a" } }]);
  expect(turn.stopReason).toBe("tool_use");
  expect(cancelled).toBe(true);
});

test("SSE framing: multi-line data, CRLF, byte-split Unicode, comments, final line without newline", async () => {
  const data = ': heartbeat\r\nevent: message\r\ndata: {"choices":[\r\ndata: {"delta":{"content":"İyi ☁"},"finish_reason":"stop"}]}\r\n\r\ndata: [DONE]';
  const bytes = new TextEncoder().encode(data);
  respond(new ReadableStream({ start(c) { for (const b of bytes) c.enqueue(new Uint8Array([b])); c.close(); } }));
  const { turn, text } = await drive(openaiCompatStreaming(opts));
  expect(turn.stopReason).toBe("end_turn");
  expect(text).toBe("İyi ☁");
});

test("SSE final data frame at EOF is not lost when the last newline is absent", async () => {
  respond('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}');
  const { turn, text } = await drive(openaiCompatStreaming(opts));
  expect(turn.stopReason).toBe("end_turn");
  expect(text).toBe("ok");
});

test("stream idle timeout configuration rejects invalid values", () => {
  for (const value of [undefined, "", "0", "-1", "oops", "Infinity", "0.5"]) {
    expect(streamIdleTimeoutMs({ ROVECODE_STREAM_IDLE_TIMEOUT_MS: value })).toBe(120_000);
  }
  expect(streamIdleTimeoutMs({ ROVECODE_STREAM_IDLE_TIMEOUT_MS: "5000" })).toBe(5000);
});

test("closing the SSE consumer cancels the body and releases its lock", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(new TextEncoder().encode('data: {"x":1}\n\n')); },
    cancel() { cancelled = true; },
  });
  const gen = sseData(body);
  expect((await gen.next()).value).toBe('{"x":1}');
  await gen.return(undefined);
  expect(cancelled).toBe(true);
  expect(body.locked).toBe(false);
});

test("SSE idle timeout ends the turn and cancels the response reader", async () => {
  process.env.ROVECODE_STREAM_IDLE_TIMEOUT_MS = "20";
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  respond(body);
  const { turn } = await drive(openaiCompatStreaming(opts));
  expect(turn.stopReason).toBe("error");
  expect(turn.error).toContain("idle timeout");
  expect(cancelled).toBe(true);
  expect(body.locked).toBe(false);
});

test("SSE abort interrupts a stalled reader even when fetch ignores its signal", async () => {
  const ac = new AbortController();
  let cancelled = false;
  respond(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }));
  const timer = setTimeout(() => ac.abort(), 20);
  try {
    const { turn } = await drive(anthropicStreaming(opts), { signal: ac.signal });
    expect(turn.stopReason).toBe("aborted");
    expect(cancelled).toBe(true);
  } finally { clearTimeout(timer); }
});

test("run deadline bounds stream reads even when idle timeout is much longer", async () => {
  process.env.ROVECODE_STREAM_IDLE_TIMEOUT_MS = "60000";
  respond(new ReadableStream<Uint8Array>());
  const { turn } = await drive(openaiCompatStreaming(opts), { deadlineAt: Date.now() + 20 });
  expect(turn.stopReason).toBe("error");
  expect(turn.error).toContain("deadline");
});

test("[DONE] stops reading and cancels an otherwise never-closing response", async () => {
  let cancelled = false;
  respond(new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(new TextEncoder().encode(sse({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }) + 'data: [DONE]\n\n')); },
    cancel() { cancelled = true; },
  }));
  const { turn } = await drive(openaiCompatStreaming(opts));
  expect(turn.stopReason).toBe("end_turn");
  expect(cancelled).toBe(true);
});

test("truncated text stream preserves visible text through retry without repeating the request", async () => {
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return new Response(sse({ choices: [{ delta: { content: "partial answer" } }] })); }) as unknown as typeof fetch;
  const { turn } = await drive(withRetry(openaiCompatStreaming(opts), { sleep: async () => {} }));
  expect(calls).toBe(1);
  expect(turn.stopReason).toBe("error");
  expect(turn.parts).toEqual([{ kind: "text", text: "partial answer" }]);
});
