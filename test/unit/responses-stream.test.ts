/** Port #75 — the Responses SSE state machine through the REAL adapter (globalThis.fetch stubbed with `event:` +
 *  `data:` bodies, restored in finally): text deltas and the authoritative item.done text, refusals, reasoning deltas
 *  as reasoning_delta ONLY (M3), summary_part.done, interleaved function_call argument streams assembled by
 *  output_index, bad JSON → {_raw}, the reasoning item → ReasoningPart{text, signature = the item JSON}, usage through
 *  normalizeUsage (M4), the stop mapping, response.failed / error events, the missing-terminal-event rule (M5),
 *  HTTP 429 + Retry-After meta, an abort mid-stream, the codex headers and token-free error texts. No network. */

import { expect, test } from "bun:test";
import { openaiResponsesStream, NO_TERMINAL_EVENT, type ResponsesAdapterOptions } from "../../src/providers/responses.ts";
import { httpErrorMeta } from "../../src/providers/stream-errors.ts";
import type { AssistantTurn, Message, ModelRef, StreamEvent, StreamOptions } from "../../src/core/types.ts";

const GPT5: ModelRef = { provider: "openai", model: "gpt-5" };
const KEY = "k-CANARY-0123456789";
const API: ResponsesAdapterOptions = { baseUrl: "https://api.openai.com/v1", apiKey: KEY };
const user: Message = { id: "m1", role: "user", parts: [{ kind: "text", text: "hi" }], parentId: null, createdAt: 0 };
type Rec = Record<string, unknown>;
const ev = (e: Rec): string => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`;
const sse = (events: Rec[]): string => events.map(ev).join("");
const added = (i: number, item: Rec): Rec => ({ type: "response.output_item.added", output_index: i, item });
const done = (i: number, item: Rec): Rec => ({ type: "response.output_item.done", output_index: i, item });
const completed = (usage?: Rec): Rec => ({ type: "response.completed", response: { id: "r1", status: "completed", ...(usage ? { usage } : {}) } });
const message = (text: string): Rec => done(0, { type: "message", id: "m", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] });
const USAGE = { input_tokens: 1000, input_tokens_details: { cached_tokens: 600 }, output_tokens: 50, output_tokens_details: { reasoning_tokens: 7 } };

type TextDelta = Extract<StreamEvent, { type: "text_delta" }>;
type ThinkDelta = Extract<StreamEvent, { type: "reasoning_delta" }>;
type ToolDelta = Extract<StreamEvent, { type: "tool_call_delta" }>;
interface Driven { events: StreamEvent[]; text: string[]; think: string[]; turn: AssistantTurn; headers: Record<string, string> }
/** stub fetch with `respond`, drive the adapter to its ONE turn, restore */
async function drive(respond: () => Response, options?: StreamOptions, opts = API): Promise<Driven> {
  const real = globalThis.fetch;
  let headers: Record<string, string> = {};
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => { headers = (init?.headers ?? {}) as Record<string, string>; return respond(); }) as typeof fetch;
  const events: StreamEvent[] = [];
  try { for await (const e of openaiResponsesStream(opts)(GPT5, [user], options)) events.push(e); } finally { globalThis.fetch = real; }
  const turns = events.filter((e): e is Extract<StreamEvent, { type: "turn" }> => e.type === "turn");
  expect(turns).toHaveLength(1);
  expect(events.at(-1)?.type).toBe("turn");
  return {
    events, headers, turn: turns[0]!.turn,
    text: events.filter((e): e is TextDelta => e.type === "text_delta").map((e) => e.text),
    think: events.filter((e): e is ThinkDelta => e.type === "reasoning_delta").map((e) => e.text),
  };
}
const body = (events: Rec[]) => () => new Response(sse(events), { status: 200, headers: { "content-type": "text/event-stream" } });

test("text: output_text deltas stream as text_delta; the item.done content is the turn text (authoritative, not the concatenation); completed → end_turn; the event: line is ignored — data.type names the event", async () => {
  const item = { type: "message", id: "msg_1", role: "assistant" };
  const d = await drive(body([
    { type: "response.created", response: { id: "r1" } },
    added(0, item),
    { type: "response.output_text.delta", output_index: 0, delta: "Hel" },
    { type: "response.output_text.delta", output_index: 0, delta: "lo" },
    done(0, { ...item, status: "completed", content: [{ type: "output_text", text: "Hello!", annotations: [] }] }),
    completed({ input_tokens: 3, output_tokens: 2 }),
  ]));
  expect(d.text).toEqual(["Hel", "lo"]);
  expect(d.think).toEqual([]);
  expect(d.turn.parts).toEqual([{ kind: "text", text: "Hello!" }]);
  expect(d.turn.stopReason).toBe("end_turn");
  expect(d.turn.usage).toEqual({ input: 3, output: 2 });
  expect(d.turn.error).toBeUndefined();
});

test("refusal.delta streams as text and the refusal content is the turn text", async () => {
  const d = await drive(body([added(0, { type: "message", id: "m", role: "assistant" }), { type: "response.refusal.delta", output_index: 0, delta: "I cannot" }, done(0, { type: "message", id: "m", role: "assistant", status: "completed", content: [{ type: "refusal", refusal: "I cannot help." }] }), completed()]));
  expect(d.text).toEqual(["I cannot"]);
  expect(d.turn.parts).toEqual([{ kind: "text", text: "I cannot help." }]);
  expect(d.turn.stopReason).toBe("end_turn");
});

test("reasoning: summary / text deltas are reasoning_delta ONLY — never text_delta, never a text part (M3); summary_part.done → one paragraph break; the reasoning ITEM finalises to nothing (no reasoning MessagePart in this build — wire-responses.ts header) and nothing of it reaches the turn", async () => {
  const rs = { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "thought A" }, { type: "summary_text", text: "thought B" }], encrypted_content: "ENC-1" };
  const d = await drive(body([
    added(0, { type: "reasoning", id: "rs_1", summary: [] }),
    { type: "response.reasoning_summary_text.delta", output_index: 0, delta: "thinking hard" },
    { type: "response.reasoning_summary_part.done", output_index: 0 },
    { type: "response.reasoning_text.delta", output_index: 0, delta: "raw chain" },
    done(0, rs),
    added(1, { type: "message", id: "msg_1", role: "assistant" }),
    { type: "response.output_text.delta", output_index: 1, delta: "Hello" },
    done(1, { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Hello", annotations: [] }] }),
    completed(),
  ]));
  expect(d.think).toEqual(["thinking hard", "\n\n", "raw chain"]);
  expect(d.text).toEqual(["Hello"]);
  expect(d.turn.parts).toEqual([{ kind: "text", text: "Hello" }]);
  const dumped = JSON.stringify(d.turn);
  for (const s of ["thinking hard", "raw chain", "thought A", "ENC-1", "reasoning"]) expect(dumped).not.toContain(s);
  const item = { type: "reasoning", id: "rs_2", summary: [], content: [{ type: "reasoning_text", text: "c1" }, { type: "reasoning_text", text: "c2" }] };
  const c = await drive(body([done(0, item), completed()]));
  expect(c.turn.parts).toEqual([]);
  expect(c.turn.stopReason).toBe("end_turn");
});

test("tool calls: two interleaved function_call argument streams assemble by output_index into tool_call parts with id = call_id (tool_call_delta events carry id + tool); an item.done without arguments uses the accumulated slot; bad JSON → {_raw}; completed with a tool call → tool_use", async () => {
  const fcA = { type: "function_call", id: "fc_a", call_id: "call_a", name: "read", arguments: "" };
  const fcB = { type: "function_call", id: "fc_b", call_id: "call_b", name: "grep", arguments: "" };
  const d = await drive(body([
    added(0, fcA), added(1, fcB),
    { type: "response.function_call_arguments.delta", output_index: 0, delta: '{"pa' },
    { type: "response.function_call_arguments.delta", output_index: 1, delta: '{"pat' },
    { type: "response.function_call_arguments.delta", output_index: 0, delta: 'th":"x"}' },
    { type: "response.function_call_arguments.delta", output_index: 1, delta: 'tern":"y"}' },
    { type: "response.function_call_arguments.done", output_index: 0, arguments: '{"path":"x"}' },
    done(1, { ...fcB, arguments: '{"pattern":"y"}', status: "completed" }), // B finalises first — parts still follow output_index
    done(0, { type: "function_call", id: "fc_a", call_id: "call_a", name: "read", status: "completed" }), // no arguments on the item → the slot's
    completed(),
  ]));
  expect(d.turn.stopReason).toBe("tool_use");
  expect(d.turn.parts).toEqual([{ kind: "tool_call", id: "call_a", tool: "read", args: { path: "x" } }, { kind: "tool_call", id: "call_b", tool: "grep", args: { pattern: "y" } }]);
  const deltas = d.events.filter((e): e is ToolDelta => e.type === "tool_call_delta");
  expect(deltas.map((e) => [e.id, e.tool, e.argsDelta])).toEqual([["call_a", "read", '{"pa'], ["call_b", "grep", '{"pat'], ["call_a", "read", 'th":"x"}'], ["call_b", "grep", 'tern":"y"}']]);
  expect(d.text).toEqual([]);
  const bad = await drive(body([done(0, { type: "function_call", id: "fc", call_id: "call_x", name: "read", arguments: "{oops" }), completed()]));
  expect(bad.turn.parts).toEqual([{ kind: "tool_call", id: "call_x", tool: "read", args: { _raw: "{oops" } }]);
  expect(bad.turn.stopReason).toBe("tool_use");
});

test("usage: response.completed usage {1000 input, 600 cached, 50 output, 7 reasoning} → {input 400, cacheRead 600, output 50} through normalizeUsage (M4: the cached share is subtracted from the inclusive count; reasoning_tokens have no TokenUsage field here and are not invented)", async () => {
  const d = await drive(body([message("ok"), completed(USAGE)]));
  expect(d.turn.usage).toEqual({ input: 400, output: 50, cacheRead: 600 });
  expect(d.turn.usage.cacheWrite).toBeUndefined();
  const plain = await drive(body([message("ok"), completed({ input_tokens: 12, output_tokens: 3 })]));
  expect(plain.turn.usage).toEqual({ input: 12, output: 3 });
});

test("stop mapping: incomplete/max_output_tokens → length (parts + usage kept); incomplete/content_filter → error naming the reason; response.failed → \"<code>: <message>\"; error event → \"<code>: <message>\"; no key in any error text", async () => {
  const len = await drive(body([message("partial"), { type: "response.incomplete", response: { id: "r", status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, usage: { input_tokens: 5, output_tokens: 9 } } }]));
  expect(len.turn.stopReason).toBe("length");
  expect(len.turn.parts).toEqual([{ kind: "text", text: "partial" }]);
  expect(len.turn.usage).toEqual({ input: 5, output: 9 });
  const filt = await drive(body([message("partial"), { type: "response.incomplete", response: { id: "r", status: "incomplete", incomplete_details: { reason: "content_filter" } } }]));
  expect(filt.turn).toMatchObject({ stopReason: "error", error: "Response incomplete: content_filter", parts: [] });
  const failed = await drive(body([message("partial"), { type: "response.failed", response: { id: "r", status: "failed", error: { code: "server_error", message: "boom" } } }]));
  expect(failed.turn).toMatchObject({ stopReason: "error", error: "server_error: boom", parts: [] });
  const err = await drive(body([{ type: "error", code: "rate_limit_exceeded", message: "slow down" }]));
  expect(err.turn).toMatchObject({ stopReason: "error", error: "rate_limit_exceeded: slow down", parts: [] });
  for (const t of [filt, failed, err]) expect(t.turn.error).not.toContain(KEY);
});

test("a stream that ends with NO terminal event is an error turn, never end_turn (M5) — even with text streamed (the deltas were shown; the turn says why it is not trusted)", async () => {
  const d = await drive(body([added(0, { type: "message", id: "m", role: "assistant" }), { type: "response.output_text.delta", output_index: 0, delta: "half" }]));
  expect(d.text).toEqual(["half"]);
  expect(d.turn.stopReason).toBe("error");
  expect(d.turn.error).toBe(NO_TERMINAL_EVENT);
  expect(d.turn.parts).toEqual([]);
  const empty = await drive(() => new Response("", { status: 200 }));
  expect(empty.turn.stopReason).toBe("error");
});

test("HTTP 429 + Retry-After: the same error-turn shape the router classifies (\"HTTP 429: …\") and httpErrorMeta {status, retryAfter}; the key is not in the text; a plain 500 carries the status alone", async () => {
  const d = await drive(() => new Response("rate limited", { status: 429, headers: { "retry-after": "7" } }));
  expect(d.turn.stopReason).toBe("error");
  expect(d.turn.error).toBe("HTTP 429: rate limited");
  expect(httpErrorMeta(d.turn)).toEqual({ status: 429, retryAfter: "7" });
  expect(d.turn.error).not.toContain(KEY);
  expect(d.events).toHaveLength(1);
  const e5 = await drive(() => new Response("upstream down", { status: 502 }));
  expect(e5.turn.error).toBe("HTTP 502: upstream down");
  expect(httpErrorMeta(e5.turn)).toEqual({ status: 502 });
});

test("abort mid-stream: the turn is `aborted` with the streamed TEXT salvaged, zero tool_call fragments and no reasoning text in the turn (M3 again: the salvage buffer holds text deltas only)", async () => {
  const ac = new AbortController();
  const chunks = [
    ev(added(0, { type: "reasoning", id: "rs", summary: [] })), ev({ type: "response.reasoning_summary_text.delta", output_index: 0, delta: "secret thought" }),
    ev(added(1, { type: "message", id: "m", role: "assistant" })), ev({ type: "response.output_text.delta", output_index: 1, delta: "partial " }), ev({ type: "response.output_text.delta", output_index: 1, delta: "text" }),
    ev(added(2, { type: "function_call", id: "fc", call_id: "call_1", name: "read", arguments: "" })), ev({ type: "response.function_call_arguments.delta", output_index: 2, delta: '{"pa' }),
  ];
  let i = 0;
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) { controller.enqueue(enc.encode(chunks[i++]!)); return; }
      ac.abort(); // Esc while the tool arguments are still streaming: the fetch body dies with AbortError
      controller.error(new DOMException("The operation was aborted.", "AbortError"));
    },
  });
  const d = await drive(() => new Response(stream, { status: 200 }), { signal: ac.signal });
  expect(d.turn.stopReason).toBe("aborted");
  expect(d.turn.parts).toEqual([{ kind: "text", text: "partial text" }]);
  expect(d.think).toEqual(["secret thought"]);
  expect(d.text).toEqual(["partial ", "text"]);
  expect(JSON.stringify(d.turn)).not.toContain("secret thought");
  expect(JSON.stringify(d.turn)).not.toContain("call_1");
});

test("headers: Bearer + accept text/event-stream everywhere; OpenAI-Beta + originator ONLY for a chatgpt.com/backend-api base; the config's extra headers (chatgpt-account-id) ride along", async () => {
  const plain = await drive(body([completed()]));
  expect(plain.headers).toEqual({ "content-type": "application/json", accept: "text/event-stream", authorization: `Bearer ${KEY}` });
  const codex = await drive(body([completed()]), undefined, { baseUrl: "https://chatgpt.com/backend-api/codex", apiKey: KEY, headers: { "chatgpt-account-id": "acct-1" } });
  expect(codex.headers).toEqual({ "content-type": "application/json", accept: "text/event-stream", "OpenAI-Beta": "responses=experimental", originator: "rovecode", "chatgpt-account-id": "acct-1", authorization: `Bearer ${KEY}` });
  expect(codex.turn.stopReason).toBe("end_turn");
  expect(codex.turn.parts).toEqual([]);
});
