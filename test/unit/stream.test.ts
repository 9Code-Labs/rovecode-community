/** Provider adapter wire tests (ports #5+#6): the request BODIES and usage normalization.
 *  globalThis.fetch is stubbed per test (captured + restored in finally) so these drive the
 *  REAL adapters end-to-end: cache boundary wiring (F1), SSE usage normalization (F3), and
 *  cache fields surviving the JSON parsers (the stream.ts cacheRead/Write→undefined mutants). */

import { test, expect } from "bun:test";
import { anthropicStream, anthropicStreaming, anthropicMaxTokens, anthropicThinking, openaiCompatStream, openaiCompatStreaming, thinkingBudget, wantsStreaming } from "../../src/providers/stream.ts";
import type { AssistantTurn, Message, ModelRef, Role, StreamEvent, StreamFn } from "../../src/core/types.ts";

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

async function drive(fn: StreamFn, messages: Message[], options?: Parameters<StreamFn>[2], model: ModelRef = MODEL): Promise<{ deltas: string[]; turn: AssistantTurn }> {
  const deltas: string[] = [];
  let turn: AssistantTurn | null = null;
  for await (const ev of fn(model, messages, options)) {
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

// ---------- anthropic SSE: the streaming twin of anthropicStream ----------

/** one Anthropic Messages SSE stream: a text block, then a tool_use block whose arguments arrive as
 *  input_json_delta fragments, with usage split across message_start and message_delta */
const ANTHROPIC_SSE = [
  'data: {"type":"message_start","message":{"usage":{"input_tokens":30,"cache_read_input_tokens":12,"cache_creation_input_tokens":4}}}',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"he"}}',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"llo"}}',
  'data: {"type":"content_block_stop","index":0}',
  'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tu_1","name":"read_file"}}',
  'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":"}}',
  'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\\"a.ts\\"}"}}',
  'data: {"type":"content_block_stop","index":1}',
  'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":9}}',
  'data: {"type":"message_stop"}',
  "",
].join("\n\n");

test("anthropicStreaming streams text deltas, rebuilds tool args from input_json_delta, and keeps block order", async () => {
  const { calls, restore } = stubFetch(() => new Response(ANTHROPIC_SSE, { status: 200 }));
  try {
    const { deltas, turn } = await drive(anthropicStreaming({ baseUrl: "http://stub.invalid/v1", apiKey: "k" }), [msg("user", "hi")]);
    expect(calls[0]!.url).toBe("http://stub.invalid/v1/messages");
    expect(calls[0]!.body.stream).toBe(true);
    expect(deltas).toEqual(["he", "llo"]); // the prose arrived in pieces, not in one lump
    expect(turn.parts).toEqual([
      { kind: "text", text: "hello" },
      { kind: "tool_call", id: "tu_1", tool: "read_file", args: { path: "a.ts" } },
    ]);
    expect(turn.stopReason).toBe("tool_use");
    // input side from message_start (cache-exclusive: 30 stays 30), output only from message_delta
    expect(turn.usage).toEqual({ input: 30, output: 9, cacheRead: 12, cacheWrite: 4 });
  } finally { restore(); }
});

test("anthropicStreaming asks for an uncompressed body — a decompressor would hold the whole stream", async () => {
  const headers: Record<string, string>[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
    headers.push(init?.headers as Record<string, string>);
    return new Response(ANTHROPIC_SSE, { status: 200 });
  }) as typeof fetch;
  try {
    await drive(anthropicStreaming({ baseUrl: "http://stub.invalid/v1", apiKey: "k" }), [msg("user", "hi")]);
    expect(headers[0]!["accept-encoding"]).toBe("identity");
  } finally { globalThis.fetch = real; }
});

test("anthropicStreaming: a mid-stream error event ends the turn as an error, after the deltas already shown", async () => {
  const partial = [
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"half a "}}',
    'data: {"type":"error","error":{"type":"overloaded_error","message":"overloaded"}}',
    "",
  ].join("\n\n");
  const { restore } = stubFetch(() => new Response(partial, { status: 200 }));
  try {
    const { deltas, turn } = await drive(anthropicStreaming({ baseUrl: "http://stub.invalid/v1", apiKey: "k" }), [msg("user", "hi")]);
    expect(deltas).toEqual(["half a "]); // the UI already showed this much
    // same contract as the OpenAI SSE adapter: a real error is an error turn (only an ABORT keeps
    // the partial text as the turn's content — stream-errors.ts failedTurn)
    expect(turn.stopReason).toBe("error");
    expect(turn.parts).toEqual([]);
    expect(turn.error).toContain("overloaded");
  } finally { restore(); }
});

test("anthropicStreaming: an HTTP error is one error turn, not a parse crash", async () => {
  const { restore } = stubFetch(() => new Response('{"error":{"message":"bad key"}}', { status: 401 }));
  try {
    const { deltas, turn } = await drive(anthropicStreaming({ baseUrl: "http://stub.invalid/v1", apiKey: "k" }), [msg("user", "hi")]);
    expect(deltas).toEqual([]);
    expect(turn.stopReason).toBe("error");
  } finally { restore(); }
});

test("wantsStreaming: on by default, off only for the explicit spellings", () => {
  expect(wantsStreaming({})).toBe(true);
  expect(wantsStreaming({ ROVECODE_STREAM: "sse" })).toBe(true); // the old opt-IN spelling still means "stream"
  for (const v of ["off", "json", "0", "false", "none", "OFF", " Json "]) expect(wantsStreaming({ ROVECODE_STREAM: v })).toBe(false);
});

// ---------- thinking effort: the two Anthropic shapes + the OpenAI word ----------

test("thinkingBudget/anthropicMaxTokens: the ceiling rises with the budget, never below what the caller asked", () => {
  expect(thinkingBudget(undefined)).toBeNull();
  expect(thinkingBudget("off")).toBeNull();
  expect([thinkingBudget("low"), thinkingBudget("medium"), thinkingBudget("high")]).toEqual([2048, 8192, 24576]);
  // the endpoint rejects max_tokens <= budget_tokens, so an unraised ceiling is a 400, not a downgrade
  expect(anthropicMaxTokens({ provider: "a", model: "m" })).toBe(8192); // the floor when buildDef found no catalog maxOutput (was a flat 4096 that truncated long answers)
  expect(anthropicMaxTokens({ provider: "a", model: "m", effort: "high" })).toBe(24576 + 4096);
  expect(anthropicMaxTokens({ provider: "a", model: "m", maxTokens: 64000, effort: "low" })).toBe(64000); // caller wins when larger
});

test("anthropicThinking: effort shape vs budget shape, and off is an explicit disable", () => {
  expect(anthropicThinking(undefined, "effort")).toEqual({});                       // unset leaves the model's default alone
  expect(anthropicThinking("off", "effort")).toEqual({ thinking: { type: "disabled" } });
  expect(anthropicThinking("off", "budget")).toEqual({ thinking: { type: "disabled" } });
  expect(anthropicThinking("high", "effort")).toEqual({ output_config: { effort: "high" } });
  expect(anthropicThinking("high", "budget")).toEqual({ thinking: { type: "enabled", budget_tokens: 24576 } });
});

test("anthropicStreaming learns the model's shape from a wrong-shape 400 and retries once", async () => {
  const bodies: Record<string, unknown>[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    bodies.push(body);
    // an old-generation model: the effort shape is refused, the budget shape works
    if (body.output_config !== undefined) {
      return new Response(JSON.stringify({ error: { message: "This model does not support the effort parameter." } }), { status: 400, headers: { "content-type": "application/json" } });
    }
    return new Response(ANTHROPIC_SSE, { status: 200 });
  }) as typeof fetch;
  try {
    const fn = anthropicStreaming({ baseUrl: "http://stub.invalid/v1", apiKey: "k" });
    const first = await drive(fn, [msg("user", "hi")], undefined, { provider: "a", model: "old-gen-model", effort: "medium" });
    expect(first.turn.stopReason).toBe("tool_use");
    expect(bodies.length).toBe(2);                                        // one wasted round trip, once
    expect(bodies[0]!.output_config).toEqual({ effort: "medium" });       // the newer shape is tried first
    expect(bodies[1]!.thinking).toEqual({ type: "enabled", budget_tokens: 8192 });
    // the answer is remembered: the second call goes straight to the budget shape
    await drive(fn, [msg("user", "again")], undefined, { provider: "a", model: "old-gen-model", effort: "medium" });
    expect(bodies.length).toBe(3);
    expect(bodies[2]!.thinking).toEqual({ type: "enabled", budget_tokens: 8192 });
    expect(bodies[2]!.output_config).toBeUndefined();
  } finally { globalThis.fetch = real; }
});

test("a 400 that is NOT about the shape is not retried — it becomes one error turn", async () => {
  let calls = 0;
  const real = globalThis.fetch;
  globalThis.fetch = (async () => { calls++; return new Response(JSON.stringify({ error: { message: "credit balance is too low" } }), { status: 400, headers: { "content-type": "application/json" } }); }) as unknown as typeof fetch;
  try {
    const { turn } = await drive(anthropicStreaming({ baseUrl: "http://stub.invalid/v1", apiKey: "k" }), [msg("user", "hi")], undefined, { provider: "a", model: "billing-model", effort: "high" });
    expect(calls).toBe(1);
    expect(turn.stopReason).toBe("error");
  } finally { globalThis.fetch = real; }
});

test("openaiCompatStreaming sends reasoning_effort as a word, and nothing when off", async () => {
  for (const [effort, expected] of [["high", "high"], ["off", undefined], [undefined, undefined]] as const) {
    const { calls, restore } = stubFetch(() => new Response('data: {"choices":[{"delta":{"content":"x"},"finish_reason":"stop"}]}\n\n', { status: 200 }));
    try {
      await drive(openaiCompatStreaming({ baseUrl: "http://stub.invalid/v1", apiKey: "k" }), [msg("user", "hi")], undefined,
        { provider: "o", model: "m", ...(effort !== undefined ? { effort } : {}) });
      expect(calls[0]!.body.reasoning_effort).toBe(expected as never);
    } finally { restore(); }
  }
});

// ---------- reasoning: thinking_delta → reasoning_delta, never a part ----------

/** the same shape with a thinking block first: thinking_delta slices and a signature_delta, then the prose */
const ANTHROPIC_THINKING_SSE = [
  'data: {"type":"message_start","message":{"usage":{"input_tokens":30}}}',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Let me consider"}}',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" the auth flow."}}',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"EqQBCgIYAhIM"}}',
  'data: {"type":"content_block_stop","index":0}',
  'data: {"type":"content_block_start","index":1,"content_block":{"type":"text"}}',
  'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"hello"}}',
  'data: {"type":"content_block_stop","index":1}',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":40}}',
  'data: {"type":"message_stop"}',
  "",
].join("\n\n");

test("anthropicStreaming surfaces thinking_delta as reasoning_delta events (counted for the live line) — the turn's parts carry the prose only, signature_delta is dropped", async () => {
  const { restore } = stubFetch(() => new Response(ANTHROPIC_THINKING_SSE, { status: 200 }));
  try {
    const events: StreamEvent[] = [];
    for await (const ev of anthropicStreaming({ baseUrl: "http://stub.invalid/v1", apiKey: "k" })(MODEL, [msg("user", "hi")])) events.push(ev);
    expect(events.map((e) => e.type)).toEqual(["reasoning_delta", "reasoning_delta", "text_delta", "turn"]);
    expect(events.flatMap((e) => (e.type === "reasoning_delta" ? [e.text] : []))).toEqual(["Let me consider", " the auth flow."]);
    const last = events.at(-1)!;
    if (last.type !== "turn") throw new Error("no turn");
    expect(last.turn.parts).toEqual([{ kind: "text", text: "hello" }]); // reasoning is not the answer
    expect(JSON.stringify(last.turn)).not.toContain("auth flow");
    expect(last.turn.stopReason).toBe("end_turn");
    expect(last.turn.usage).toEqual({ input: 30, output: 40 });
  } finally { restore(); }
});

// ---------- model profiles (providers/profiles.ts): the GLM-5.3 request fields ----------

const GLM: ModelRef = { provider: "kaesra", model: "zai-org/glm-5.3-flash" };
const SSE_ONE_WORD = 'data: {"choices":[{"delta":{"content":"x"},"finish_reason":"stop"}]}\n\n';
const JSON_ONE_WORD = () => new Response(JSON.stringify({ choices: [{ message: { content: "x" }, finish_reason: "stop" }] }), { status: 200, headers: { "content-type": "application/json" } });

/** the profile tests must not depend on the ambient ROVECODE_PROFILE (a developer's shell may set it) */
async function withProfileEnv(value: string | undefined, run: () => Promise<void>): Promise<void> {
  const prev = process.env.ROVECODE_PROFILE;
  if (value === undefined) delete process.env.ROVECODE_PROFILE; else process.env.ROVECODE_PROFILE = value;
  try { await run(); } finally { if (prev === undefined) delete process.env.ROVECODE_PROFILE; else process.env.ROVECODE_PROFILE = prev; }
}

test("openaiCompatStreaming: a GLM-5.3 id carries the profile fields (thinking enabled, tool_stream, temperature 1, top_p 0.95) and GLM's effort word — high→max, medium→high, low→low, off/unset→nothing", () => withProfileEnv(undefined, async () => {
  for (const [effort, expected] of [["high", "max"], ["medium", "high"], ["low", "low"], ["off", undefined], [undefined, undefined]] as const) {
    const { calls, restore } = stubFetch(() => new Response(SSE_ONE_WORD, { status: 200 }));
    try {
      await drive(openaiCompatStreaming({ baseUrl: "http://stub.invalid/v1", apiKey: "k" }), [msg("user", "hi")], undefined, { ...GLM, ...(effort !== undefined ? { effort } : {}) });
      const body = calls[0]!.body;
      expect(body.reasoning_effort).toBe(expected as never);
      expect(body.thinking).toEqual({ type: "enabled", clear_thinking: false });
      expect(body.tool_stream).toBe(true);
      expect(body.temperature).toBe(1);
      expect(body.top_p).toBe(0.95);
      expect(body.stream).toBe(true);
    } finally { restore(); }
  }
}));

test("openaiCompatStream (one-shot JSON) sends the GLM fields WITHOUT tool_stream; a non-GLM model gets none of them and keeps the plain effort word", () => withProfileEnv(undefined, async () => {
  const a = stubFetch(JSON_ONE_WORD);
  try {
    await drive(openaiCompatStream({ baseUrl: "http://stub.invalid/v1", apiKey: "k" }), [msg("user", "hi")], undefined, { ...GLM, effort: "high" });
    const body = a.calls[0]!.body;
    expect(body.thinking).toEqual({ type: "enabled", clear_thinking: false });
    expect(body.tool_stream).toBeUndefined();
    expect(body.reasoning_effort).toBe("max");
    expect(body.stream).toBe(false);
  } finally { a.restore(); }
  const b = stubFetch(JSON_ONE_WORD);
  try {
    await drive(openaiCompatStream({ baseUrl: "http://stub.invalid/v1", apiKey: "k" }), [msg("user", "hi")], undefined, { provider: "openai", model: "gpt-5", effort: "high" });
    const body = b.calls[0]!.body;
    expect(body.thinking).toBeUndefined();
    expect(body.tool_stream).toBeUndefined();
    expect(body.temperature).toBeUndefined();
    expect(body.top_p).toBeUndefined();
    expect(body.reasoning_effort).toBe("high");
  } finally { b.restore(); }
}));

test("ROVECODE_PROFILE=off strips the GLM fields from the request and restores the plain effort word", () => withProfileEnv("off", async () => {
  const { calls, restore } = stubFetch(() => new Response(SSE_ONE_WORD, { status: 200 }));
  try {
    await drive(openaiCompatStreaming({ baseUrl: "http://stub.invalid/v1", apiKey: "k" }), [msg("user", "hi")], undefined, { ...GLM, effort: "high" });
    const body = calls[0]!.body;
    expect(body.thinking).toBeUndefined();
    expect(body.tool_stream).toBeUndefined();
    expect(body.reasoning_effort).toBe("high");
  } finally { restore(); }
}));

test("ROVECODE_PROFILE=glm-5.3 forced onto gpt-5 changes the PROMPT only: the request body stays plain — no thinking/tool_stream/temperature, reasoning_effort keeps rovecode's word", () => withProfileEnv("glm-5.3", async () => {
  const { calls, restore } = stubFetch(() => new Response(SSE_ONE_WORD, { status: 200 }));
  try {
    await drive(openaiCompatStreaming({ baseUrl: "http://stub.invalid/v1", apiKey: "k" }), [msg("user", "hi")], undefined, { provider: "openai", model: "gpt-5", effort: "high" });
    const body = calls[0]!.body;
    expect(body.thinking).toBeUndefined();
    expect(body.tool_stream).toBeUndefined();
    expect(body.temperature).toBeUndefined();
    expect(body.reasoning_effort).toBe("high");
    // …while a real GLM under the same forced id still gets its fields (the wire follows the model id)
    await drive(openaiCompatStreaming({ baseUrl: "http://stub.invalid/v1", apiKey: "k" }), [msg("user", "hi")], undefined, { ...GLM, effort: "high" });
    expect(calls[1]!.body.thinking).toEqual({ type: "enabled", clear_thinking: false });
    expect(calls[1]!.body.reasoning_effort).toBe("max");
  } finally { restore(); }
}));

test("openaiCompatStreaming surfaces delta.reasoning_content as reasoning_delta events — never text, never a part", async () => {
  const sse = [
    'data: {"choices":[{"delta":{"reasoning_content":"Let me check"},"finish_reason":null}]}',
    'data: {"choices":[{"delta":{"reasoning_content":" the file."},"finish_reason":null}]}',
    'data: {"choices":[{"delta":{"content":"hello"},"finish_reason":"stop"}]}',
    "",
  ].join("\n\n");
  const { restore } = stubFetch(() => new Response(sse, { status: 200 }));
  try {
    const reasoning: string[] = []; const text: string[] = []; let turn: AssistantTurn | null = null;
    for await (const ev of openaiCompatStreaming({ baseUrl: "http://stub.invalid/v1", apiKey: "k" })(GLM, [msg("user", "hi")])) {
      if (ev.type === "reasoning_delta") reasoning.push(ev.text);
      if (ev.type === "text_delta") text.push(ev.text);
      if (ev.type === "turn") turn = ev.turn;
    }
    expect(reasoning).toEqual(["Let me check", " the file."]);
    expect(text).toEqual(["hello"]);
    expect(turn!.parts).toEqual([{ kind: "text", text: "hello" }]);
  } finally { restore(); }
});
