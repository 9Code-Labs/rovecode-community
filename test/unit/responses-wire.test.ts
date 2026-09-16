/** Port #75 — the Responses request BODY, pinned through the REAL adapter (globalThis.fetch stubbed, request captured,
 *  restored in finally) and the lowering functions: URL, store:false / stream:true, NO include (nothing here replays
 *  reasoning, so nothing asks for encrypted content), system → instructions, user input_text + input_image under the
 *  #34 vision gate, assistant message ids, function_call WITHOUT id, function_call_output + the empty-output
 *  placeholder, FLAT tools, the max_output_tokens floor and its codex-backend omission, and the reasoning spelling of
 *  rovecode's one thinking dial (ModelRef.effort through thinkingPlan). Mutation targets are named inline. No network. */

import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openaiResponsesStream, responsesReasoning, responsesRequest, RESPONSES_MIN_OUTPUT_TOKENS } from "../../src/providers/responses.ts";
import { toResponsesInput, toResponsesTools, NO_TOOL_OUTPUT } from "../../src/providers/wire-responses.ts";
import { imageFromBytes } from "../../src/core/images.ts";
import type { Message, MessagePart, ModelRef, Role, StreamFn, StreamOptions } from "../../src/core/types.ts";
import { PNG_1x1, PNG_1x1_B64 } from "../fixtures/images.ts";

const GPT5: ModelRef = { provider: "openai", model: "gpt-5" };
const GPT4O: ModelRef = { provider: "openai", model: "gpt-4o" };
const TEXT_ONLY: ModelRef = { provider: "deepseek", model: "deepseek-v4-pro" }; // models.dev modalities.input = text
const API = { baseUrl: "https://api.openai.com/v1", apiKey: "k-CANARY-0123" };
const CODEX = { baseUrl: "https://chatgpt.com/backend-api/codex", apiKey: "k-CANARY-0123" };

let seq = 0;
function msg(role: Role, parts: MessagePart[] | string, extra: Partial<Message> = {}): Message {
  seq += 1;
  return { id: `m${seq}`, role, parts: typeof parts === "string" ? [{ kind: "text", text: parts }] : parts, parentId: null, createdAt: 0, ...extra };
}
type Rec = Record<string, unknown>;
interface Captured { url: string; headers: Record<string, string>; body: Rec }
const DONE = 'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r","status":"completed","usage":{"input_tokens":1,"output_tokens":1}}}\n\n';
function stubFetch(): { calls: Captured[]; restore: () => void } {
  const calls: Captured[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string>, body: JSON.parse(String(init?.body ?? "{}")) as Rec });
    return new Response(DONE, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = real; } };
}
/** one call through the real adapter; the captured request */
async function send(fn: StreamFn, model: ModelRef, messages: Message[], options?: StreamOptions): Promise<Captured> {
  const { calls, restore } = stubFetch();
  try { for await (const _ of fn(model, messages, options)) { /* drain */ } } finally { restore(); }
  expect(calls).toHaveLength(1);
  return calls[0]!;
}
const input = (c: Captured): Rec[] => c.body.input as Rec[];

test("URL + envelope: POST <base>/responses with store:false and stream:true, NO include (M1 M13); system → instructions, never an input item (M14); user → input_text; no reasoning key at effort auto; Bearer + accept text/event-stream; no codex headers on api.openai.com", async () => {
  const c = await send(openaiResponsesStream(API), GPT5, [msg("system", "Be terse."), msg("user", "hi")]);
  expect(c.url).toBe("https://api.openai.com/v1/responses");
  expect(c.body.model).toBe("gpt-5");
  expect(c.body.store).toBe(false);
  expect(c.body.stream).toBe(true);
  expect("include" in c.body).toBe(false); // nothing replays reasoning here, so nothing asks for encrypted content
  expect(c.body.instructions).toBe("Be terse.");
  expect(input(c)).toEqual([{ role: "user", content: [{ type: "input_text", text: "hi" }] }]);
  expect(JSON.stringify(c.body)).not.toContain('"role":"system"');
  expect(JSON.stringify(c.body)).not.toContain('"role":"developer"');
  expect("reasoning" in c.body).toBe(false);
  expect("max_output_tokens" in c.body).toBe(false);
  expect("tools" in c.body).toBe(false);
  expect(c.headers.authorization).toBe("Bearer k-CANARY-0123");
  expect(c.headers.accept).toBe("text/event-stream");
  expect(c.headers["content-type"]).toBe("application/json");
  expect(c.headers["OpenAI-Beta"]).toBeUndefined();
  expect(c.headers.originator).toBeUndefined();
});

test("instructions: absent without a system message; several system messages join with a newline; a trailing slash on the base URL is trimmed", () => {
  expect("instructions" in toResponsesInput([msg("user", "x")], { model: GPT5 })).toBe(false);
  expect(toResponsesInput([msg("system", "A"), msg("system", "B"), msg("user", "x")], { model: GPT5 }).instructions).toBe("A\nB");
  const r = responsesRequest({ ...API, baseUrl: "https://api.openai.com/v1/" }, GPT5, [msg("user", "x")]);
  expect(r.url).toBe("https://api.openai.com/v1/responses");
  expect("instructions" in r.body).toBe(false);
});

test("user images under the #34 vision gate: gpt-4o (vision) gets input_image data URLs with detail auto in part order; deepseek-v4-pro (text-only) gets ONE input_text with the placeholder and no base64; an unreadable sidecar lowers to a placeholder — never a throw", () => {
  const png = imageFromBytes(PNG_1x1, { name: "dot.png" });
  if ("error" in png) throw new Error(png.error);
  const parts: MessagePart[] = [{ kind: "text", text: "look" }, png, { kind: "text", text: "now" }];
  const vision = responsesRequest(API, GPT4O, [msg("user", parts)]).body.input as Rec[];
  expect(vision).toEqual([{ role: "user", content: [{ type: "input_text", text: "look" }, { type: "input_image", detail: "auto", image_url: `data:image/png;base64,${PNG_1x1_B64}` }, { type: "input_text", text: "now" }] }]);
  const blind = responsesRequest(API, TEXT_ONLY, [msg("user", parts)]).body.input as Rec[];
  expect(blind).toEqual([{ role: "user", content: [{ type: "input_text", text: "look\n[image: dot.png, 1x1, 70 B — model has no vision]\nnow" }] }]);
  expect(JSON.stringify(blind)).not.toContain(PNG_1x1_B64);
  const dir = mkdtempSync(join(tmpdir(), "rovecode-p75-wire-"));
  try {
    const gone: MessagePart = { kind: "image", mime: "image/png", path: join(dir, "missing.png"), name: "missing.png" };
    expect(toResponsesInput([msg("user", [gone])], { model: GPT5, vision: true }).input).toEqual([{ role: "user", content: [{ type: "input_text", text: "[image: missing.png — file unavailable]" }] }]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("assistant + tool lowering: message {type, role, status completed, id msg_rovecode_<i> ≤ 64 chars, output_text + annotations []} then function_call {call_id, name, arguments} with NO id (M2); tool results → function_call_output; empty output → \"(no tool output)\"; an empty assistant turn adds nothing", () => {
  const history = [
    msg("system", "sys"),
    msg("user", "read it"),
    msg("assistant", [{ kind: "text", text: "Reading." }, { kind: "tool_call", id: "call_1", tool: "read", args: { path: "a.txt" } }]),
    msg("tool", [{ kind: "tool_result", callId: "call_1", ok: true, output: "line 1" }, { kind: "tool_result", callId: "call_2", ok: false, output: "" }]),
    msg("assistant", []),
    msg("assistant", "Done."),
  ];
  const { input: items } = toResponsesInput(history, { model: GPT5 });
  expect(items).toEqual([
    { role: "user", content: [{ type: "input_text", text: "read it" }] },
    { type: "message", role: "assistant", status: "completed", id: "msg_rovecode_2", content: [{ type: "output_text", text: "Reading.", annotations: [] }] },
    { type: "function_call", call_id: "call_1", name: "read", arguments: '{"path":"a.txt"}' },
    { type: "function_call_output", call_id: "call_1", output: "line 1" },
    { type: "function_call_output", call_id: "call_2", output: NO_TOOL_OUTPUT },
    { type: "message", role: "assistant", status: "completed", id: "msg_rovecode_5", content: [{ type: "output_text", text: "Done.", annotations: [] }] },
  ]);
  expect("id" in items[2]!).toBe(false); // M2: the API pairs fc_ ids with reasoning items it issued — rovecode never stores one
  for (const it of items) if (typeof it.id === "string") expect(it.id.length).toBeLessThanOrEqual(64);
  expect(JSON.stringify(items)).not.toContain('"type":"reasoning"'); // no reasoning replay in this build (wire-responses.ts header)
});

test("tools are FLAT {type: function, name, description, parameters} — never nested under `function` (M8); a {schema} wrapper is tolerated; the body carries `tools` only when non-empty", async () => {
  const tool = { name: "read", description: "read a file", args: { type: "object", properties: { path: { type: "string" } } } };
  expect(toResponsesTools([tool, { schema: tool }])).toEqual([
    { type: "function", name: "read", description: "read a file", parameters: tool.args },
    { type: "function", name: "read", description: "read a file", parameters: tool.args },
  ]);
  const c = await send(openaiResponsesStream(API), GPT5, [msg("user", "hi")], { tools: [tool] });
  const wired = c.body.tools as Rec[];
  expect(wired).toEqual([{ type: "function", name: "read", description: "read a file", parameters: tool.args }]);
  expect("function" in wired[0]!).toBe(false);
  expect("tools" in responsesRequest(API, GPT5, [msg("user", "hi")], { tools: [] }).body).toBe(false);
});

test("max_output_tokens = max(ModelRef.maxTokens, 16) on api.openai.com — 5 → 16, 100 → 100, no cap → absent — and ABSENT on the codex backend (M9), which gets OpenAI-Beta + originator rovecode", async () => {
  expect(RESPONSES_MIN_OUTPUT_TOKENS).toBe(16);
  const body = (o: typeof API, m: ModelRef): Rec => responsesRequest(o, m, [msg("user", "hi")]).body;
  expect(body(API, { ...GPT5, maxTokens: 5 }).max_output_tokens).toBe(16);
  expect(body(API, { ...GPT5, maxTokens: 100 }).max_output_tokens).toBe(100);
  expect("max_output_tokens" in body(API, GPT5)).toBe(false);
  const codex = responsesRequest(CODEX, { ...GPT5, maxTokens: 5 }, [msg("user", "hi")]);
  expect(codex.url).toBe("https://chatgpt.com/backend-api/codex/responses");
  expect("max_output_tokens" in codex.body).toBe(false);
  expect("include" in codex.body).toBe(false);
  expect(codex.headers["OpenAI-Beta"]).toBe("responses=experimental");
  expect(codex.headers.originator).toBe("rovecode");
  const c = await send(openaiResponsesStream(CODEX), { ...GPT5, maxTokens: 5 }, [msg("user", "hi")]);
  expect("max_output_tokens" in c.body).toBe(false);
  expect(c.headers.originator).toBe("rovecode");
});

test("reasoning is the ONE thinking dial in the Responses spelling: gpt-5 at effort high → {effort: high, summary: auto}; off → minimal (gpt-5's floor); auto → nothing; gpt-4o at high → nothing (the gpt-4 class has no reasoning mode); a catalog `reasoning: false` stamp → nothing; the adapter itself never re-routes", async () => {
  const on = await send(openaiResponsesStream(API), { ...GPT5, effort: "high" }, [msg("user", "hi")]);
  expect(on.body.reasoning).toEqual({ effort: "high", summary: "auto" });
  expect(responsesReasoning({ ...GPT5, effort: "off" })).toEqual({ reasoning: { effort: "minimal", summary: "auto" } });
  expect(responsesReasoning({ ...GPT5, effort: "auto" })).toEqual({});
  expect(responsesReasoning(GPT5)).toEqual({});
  const off = await send(openaiResponsesStream(API), { ...GPT4O, effort: "high" }, [msg("user", "hi")]);
  expect("reasoning" in off.body).toBe(false);
  expect(off.url).toBe("https://api.openai.com/v1/responses"); // wire-select.ts decides the wire, not this adapter
  expect(responsesReasoning({ ...GPT5, effort: "high", reasoning: false })).toEqual({});
  // OpenRouter's unified object is the same dial: its effort word becomes the Responses spelling when the wire is forced there
  expect(responsesReasoning({ provider: "openrouter", model: "openai/gpt-5", effort: "low" })).toEqual({ reasoning: { effort: "low", summary: "auto" } });
});
