/** Provider adapter wire tests (ports #5+#6): the request BODIES and usage normalization.
 *  globalThis.fetch is stubbed per test (captured + restored in finally) so these drive the
 *  REAL adapters end-to-end: cache boundary wiring (F1), SSE usage normalization (F3), and
 *  cache fields surviving the JSON parsers (the stream.ts cacheRead/Write→undefined mutants). */

import { test, expect } from "bun:test";
import { anthropicStream, openaiCompatStream, openaiCompatStreaming } from "../../src/providers/stream.ts";
import type { AssistantTurn, Message, ModelRef, Role, StreamFn } from "../../src/core/types.ts";

const MODEL: ModelRef = { provider: "test", model: "test-model" };

let seq = 0;
function msg(role: Role, text: string): Message {
  seq += 1;
  return { id: `m${seq}`, role, parts: [{ kind: "text", text }], parentId: null, createdAt: 0 };
}

interface Captured { url: string; body: Record<string, unknown> }

/** Swap globalThis.fetch for a scripted responder; returns captured requests + restore(). */
function stubFetch(respond: () => Response): { calls: Captured[]; restore: () => void } {
  const calls: Captured[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
    return respond();
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = real; } };
}

async function drive(fn: StreamFn, messages: Message[], options?: Parameters<StreamFn>[2]): Promise<{ deltas: string[]; turn: AssistantTurn }> {
  const deltas: string[] = [];
  let turn: AssistantTurn | null = null;
  for await (const ev of fn(MODEL, messages, options)) {
    if (ev.type === "text_delta") deltas.push(ev.text);
    if (ev.type === "turn") turn = ev.turn;
  }
  if (!turn) throw new Error("adapter yielded no turn event");
  return { deltas, turn };
}

// ---------- F1: cache boundary wiring is live in anthropicStream ----------

test("anthropicStream POSTs cache_control markers (system + conversation prefix) over the wire", async () => {
  const system = "You are precise. ".repeat(300); // 5100 chars ≥ the 4096 minChunkChars gate
  const { calls, restore } = stubFetch(() => new Response(JSON.stringify({
    content: [{ type: "text", text: "hi" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 7, cache_creation_input_tokens: 3 },
  }), { status: 200 }));
  try {
    const { turn } = await drive(anthropicStream({ baseUrl: "http://stub.invalid/v1", apiKey: "k" }), [
      msg("system", system),
      msg("user", "u0 opening question"),
      msg("assistant", "a1 reply"),
      msg("user", "u2 latest"),
    ], { tools: [{ name: "read", description: "read a file", args: { type: "object" } }] });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://stub.invalid/v1/messages");
    const body = calls[0]!.body as { system: unknown; messages: { content: unknown }[]; tools: unknown };
    // tools arrive as StreamOptions.tools declares them: bare ToolSchema[] → Anthropic shape
    // (regression: the adapter used to dereference t.schema.* and threw on every tools request)
    expect(body.tools).toEqual([{ name: "read", description: "read a file", input_schema: { type: "object" } }]);
    // system boundary: string converted to a marked text block, text byte-identical
    expect(body.system).toEqual([{ type: "text", text: system, cache_control: { type: "ephemeral" } }]);
    // conversation-prefix boundary: last block of messages[length-3] carries the marker
    expect(body.messages[0]!.content).toEqual([
      { type: "text", text: "u0 opening question", cache_control: { type: "ephemeral" } },
    ]);

    // the anthropic JSON parser keeps cache fields (stream.ts parseAnthropicResponse)
    expect(turn.stopReason).toBe("end_turn");
    expect(turn.usage).toEqual({ input: 10, output: 2, cacheRead: 7, cacheWrite: 3 });
  } finally {
    restore();
  }
});

// ---------- F3: SSE adapter usage goes through normalizeUsage ----------

test("openaiCompatStreaming requests include_usage and normalizes SSE usage (cached share subtracted)", async () => {
  const sse = [
    'data: {"choices":[{"delta":{"content":"hel"}}]}',
    'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}]}',
    'data: {"choices":[],"usage":{"prompt_tokens":1000,"completion_tokens":40,"prompt_tokens_details":{"cached_tokens":600}}}',
    "data: [DONE]",
    "",
  ].join("\n\n");
  const { calls, restore } = stubFetch(() => new Response(sse, { status: 200 }));
  try {
    const { deltas, turn } = await drive(openaiCompatStreaming({ baseUrl: "http://stub.invalid/v1", apiKey: "k" }), [
      msg("user", "hello"),
    ]);

    expect(calls[0]!.body["stream"]).toBe(true);
    expect(calls[0]!.body["stream_options"]).toEqual({ include_usage: true });

    expect(deltas).toEqual(["hel", "lo"]);
    expect(turn.stopReason).toBe("end_turn");
    // 1000 prompt tokens with 600 cached → 400 billed at the base input rate, 600 as cache reads
    expect(turn.usage.input).toBe(400);
    expect(turn.usage.output).toBe(40);
    expect(turn.usage.cacheRead).toBe(600);
  } finally {
    restore();
  }
});

// ---------- JSON adapter: cache fields survive parseOpenAiResponse ----------

test("openaiCompatStream normalizes JSON usage: cacheRead/cacheWrite land on the turn", async () => {
  const { calls, restore } = stubFetch(() => new Response(JSON.stringify({
    choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
    // gateway-style payload: OpenAI spellings plus an Anthropic cache-write passthrough
    usage: { prompt_tokens: 1000, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 600 }, cache_creation_input_tokens: 50 },
  }), { status: 200 }));
  try {
    const { turn } = await drive(openaiCompatStream({ baseUrl: "http://stub.invalid/v1", apiKey: "k" }), [
      msg("user", "hello"),
    ]);
    expect(calls[0]!.url).toBe("http://stub.invalid/v1/chat/completions");
    expect(turn.usage).toEqual({ input: 400, output: 40, cacheRead: 600, cacheWrite: 50 });
  } finally {
    restore();
  }
});
