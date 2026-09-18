import { afterEach, expect, test } from "bun:test";
import type { AssistantTurn, StreamFn } from "../../src/core/types.ts";
import { anthropicStream, anthropicStreaming, openaiCompatStream, openaiCompatStreaming } from "../../src/providers/stream.ts";
import { withToolCallParsing } from "../../src/providers/middleware.ts";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
const opts = { baseUrl: "http://stub.invalid/v1", apiKey: "test" };
const sse = (...events: unknown[]) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
function respond(body: string, contentType = "text/event-stream"): void {
  globalThis.fetch = (async () => new Response(body, { headers: { "content-type": contentType } })) as unknown as typeof fetch;
}
async function turn(stream: StreamFn): Promise<AssistantTurn> {
  for await (const e of stream({ provider: "test", model: "test" }, [], { tools: [{ name: "read", description: "read", args: { type: "object" } }] })) {
    if (e.type === "turn") return e.turn;
  }
  throw new Error("missing turn");
}

test("OpenAI SSE assembles interleaved tool names and args exactly once, ordered by index", async () => {
  respond(sse(
    { choices: [{ delta: { tool_calls: [
      { index: 1, id: "b", function: { name: "gr", arguments: '{"pattern":' } },
      { index: 0, id: "a", function: { name: "read", arguments: '{"path":' } },
    ] } }] },
    { choices: [{ delta: { tool_calls: [
      { index: 0, function: { arguments: '"a.ts"}' } },
      { index: 1, function: { name: "ep", arguments: '"TODO"}' } },
    ] }, finish_reason: "tool_calls" }] },
  ));
  const result = await turn(openaiCompatStreaming(opts));
  expect(result.stopReason).toBe("tool_use");
  expect(result.parts).toEqual([
    { kind: "tool_call", id: "a", tool: "read", args: { path: "a.ts" } },
    { kind: "tool_call", id: "b", tool: "grep", args: { pattern: "TODO" } },
  ]);
});

const openaiCall = { id: "a", type: "function", function: { name: "read", arguments: '{"path":"a.ts"}' } };
const anthropicCall = { type: "tool_use", id: "a", name: "read", input: { path: "a.ts" } };
for (const [name, factory, body, type] of [
  ["OpenAI JSON", openaiCompatStream, JSON.stringify({ choices: [{ message: { content: null, tool_calls: [openaiCall] }, finish_reason: "length" }] }), "application/json"],
  ["OpenAI SSE", openaiCompatStreaming, sse({ choices: [{ delta: { tool_calls: [{ ...openaiCall, index: 0 }] }, finish_reason: "length" }] }), "text/event-stream"],
  ["Anthropic JSON", anthropicStream, JSON.stringify({ content: [anthropicCall], stop_reason: "max_tokens" }), "application/json"],
  ["Anthropic SSE", anthropicStreaming, sse(
    { type: "content_block_start", index: 0, content_block: { ...anthropicCall, input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":"a.ts"}' } },
    { type: "message_delta", delta: { stop_reason: "max_tokens" } },
    { type: "message_stop" },
  ), "text/event-stream"],
] as const) {
  test(`${name}: length limit takes precedence over tool calls (loop must not execute them)`, async () => {
    respond(body, type);
    const result = await turn(factory(opts));
    expect(result.parts.some((p) => p.kind === "tool_call")).toBe(true);
    expect(result.stopReason).toBe("length");
  });
}

for (const stopReason of ["length", "error", "aborted"] as const) {
  test(`text-call middleware must not turn ${stopReason} into executable tool_use`, async () => {
    const original: AssistantTurn = {
      parts: [{ kind: "text", text: '<tool_call>{"name":"read","arguments":{"path":"a.ts"}}</tool_call>' }],
      stopReason, usage: { input: 1, output: 1 }, ...(stopReason === "error" ? { error: "connection lost" } : {}),
    };
    const stream: StreamFn = async function* () { yield { type: "turn", turn: original }; };
    expect(await turn(withToolCallParsing(stream))).toEqual(original);
  });
}
