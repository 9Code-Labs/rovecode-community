/** The repeating-proxy regressions (found on kaesra dash, 2026-09-19): a proxy family repeats the
 *  tool NAME in every SSE delta — the old accumulator seeded the name in its initializer AND
 *  appended per delta, so the first chunk alone produced "lsls"/"bashbash" and every run died on
 *  `unknown tool`. The same family repeats the whole ARGUMENTS object, which lands in the buffer as
 *  "{…}{…}": an exact repeat of a parseable leading object is rescued, anything else stays `_raw`. */

import { afterEach, expect, test } from "bun:test";
import type { AssistantTurn, StreamFn } from "../../src/core/types.ts";
import { openaiCompatStreaming } from "../../src/providers/stream.ts";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
const opts = { baseUrl: "http://stub.invalid/v1", apiKey: "test" };
const sse = (...events: unknown[]) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
function respond(body: string): void {
  globalThis.fetch = (async () => new Response(body, { headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch;
}
async function turn(stream: StreamFn): Promise<AssistantTurn> {
  for await (const e of stream({ provider: "test", model: "test" }, [], { tools: [{ name: "read", description: "read", args: { type: "object" } }] })) {
    if (e.type === "turn") return e.turn;
  }
  throw new Error("missing turn");
}

test("a name in the FIRST delta is not doubled by the initializer + append (the 'lsls' bug)", async () => {
  respond(sse(
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "a", function: { name: "ls", arguments: '{"pa' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"."}' } }] }, finish_reason: "tool_calls" }] },
  ));
  const result = await turn(openaiCompatStreaming(opts));
  expect(result.stopReason).toBe("tool_use");
  expect(result.parts).toEqual([{ kind: "tool_call", id: "a", tool: "ls", args: { path: "." } }]);
});

test("a proxy that REPEATS the full tool name in every delta does not duplicate it", async () => {
  respond(sse(
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "a", function: { name: "bash", arguments: '{"com' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "a", function: { name: "bash", arguments: 'mand":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "bash", arguments: '"ls"}' } }] }, finish_reason: "tool_calls" }] },
  ));
  const result = await turn(openaiCompatStreaming(opts));
  expect(result.parts).toEqual([{ kind: "tool_call", id: "a", tool: "bash", args: { command: "ls" } }]);
});

test("genuine name FRAGMENTS still concatenate (gr + ep = grep)", async () => {
  respond(sse(
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "b", function: { name: "gr", arguments: '{"pattern":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "ep", arguments: '"TODO"}' } }] }, finish_reason: "tool_calls" }] },
  ));
  const result = await turn(openaiCompatStreaming(opts));
  expect(result.parts).toEqual([{ kind: "tool_call", id: "b", tool: "grep", args: { pattern: "TODO" } }]);
});

test("the whole arguments object repeated per delta is rescued ('{…}{…}'), a near-miss stays _raw", async () => {
  respond(sse(
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "a", function: { name: "read", arguments: '{"path":"a.ts"}' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "read", arguments: '{"path":"a.ts"}' } }] }, finish_reason: "tool_calls" }] },
  ));
  const result = await turn(openaiCompatStreaming(opts));
  expect(result.parts).toEqual([{ kind: "tool_call", id: "a", tool: "read", args: { path: "a.ts" } }]);

  respond(sse(
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "c", function: { name: "read", arguments: '{"path":"a.ts"}' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "read", arguments: '{"path":"b.ts"}' } }] }, finish_reason: "tool_calls" }] },
  ));
  const near = await turn(openaiCompatStreaming(opts));
  const call = near.parts.find((p) => p.kind === "tool_call");
  expect(call && "args" in call ? call.args : null).toEqual({ _raw: '{"path":"a.ts"}{"path":"b.ts"}' });
});
