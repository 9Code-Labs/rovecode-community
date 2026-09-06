/** The effort dial on every wire (providers/thinking.ts + the adapters in stream.ts). Pinned: the matrix in
 *  docs/thinking.md row by row (level → exact field, or nothing with the reason); auto sends nothing anywhere;
 *  the catalog's "no reasoning mode" silences every dialect; OpenRouter's unified object wins over the family;
 *  the fields reach the request body through the OpenAI-compatible adapters; the Anthropic shape memory is per
 *  provider+model, bounded to one retry, refuses to oscillate, and ignores 400s that are not about the dial;
 *  the /effort note and `model show` say what the model receives. */

import { afterEach, expect, test } from "bun:test";
import type { Message, ModelRef, ThinkingEffort } from "../../src/core/types.ts";
import { dialectFor, thinkingLine, thinkingPlan, thinkingReport, thinkingTable } from "../../src/providers/thinking.ts";
import { anthropicShapeFor, anthropicStreaming, openaiCompatStream, openaiCompatStreaming, shapeByModel } from "../../src/providers/stream.ts";
import { effortNote } from "../../src/core/voice.ts";

const ref = (model: string, effort?: ThinkingEffort, extra: Partial<ModelRef> = {}): ModelRef => ({ provider: "p", model, ...(effort !== undefined ? { effort } : {}), ...extra });
const fields = (model: string, effort: ThinkingEffort, extra: Partial<ModelRef> = {}): Record<string, unknown> => thinkingPlan(ref(model, effort, extra), "openai").fields;
const says = (model: string, effort: ThinkingEffort, extra: Partial<ModelRef> = {}): string => thinkingPlan(ref(model, effort, extra), "openai").says;

test("auto sends nothing on every wire and every dialect; unset is auto", () => {
  for (const m of ["gpt-5.2", "o3", "glm-5.3", "deepseek-chat", "qwen3-235b", "kimi-k2.5", "gemini-2.5-pro", "grok-4.3", "gpt-oss-120b", "whatever-7b", "claude-opus-5"]) {
    expect(fields(m, "auto")).toEqual({});
    expect(thinkingPlan(ref(m), "openai").fields).toEqual({});
    expect(thinkingPlan(ref(m, "auto"), "anthropic").fields).toEqual({});
    expect(says(m, "auto")).toMatch(/^nothing — auto/);
  }
});

test("the matrix, OpenAI-compatible wire: each family's vocabulary, medium rounds UP, off is an explicit disable only where one exists", () => {
  // OpenAI proper
  expect(fields("gpt-5.2", "high")).toEqual({ reasoning_effort: "high" });
  expect(fields("gpt-5.2", "off")).toEqual({ reasoning_effort: "none" });
  expect(fields("gpt-5", "off")).toEqual({ reasoning_effort: "minimal" });
  expect(fields("gpt-5-mini", "medium")).toEqual({ reasoning_effort: "medium" });
  expect(fields("o3", "low")).toEqual({ reasoning_effort: "low" });
  expect(fields("o4-mini", "off")).toEqual({});
  expect(says("o4-mini", "off")).toMatch(/cannot switch reasoning off/);
  expect(fields("gpt-4o", "high")).toEqual({}); // OpenAI rejects reasoning_effort here — a 400, not a downgrade
  expect(says("gpt-4.1", "high")).toMatch(/no reasoning mode and OpenAI rejects reasoning_effort/);
  expect(fields("gpt-oss-120b", "medium")).toEqual({ reasoning_effort: "medium" });
  expect(fields("gpt-oss-20b", "off")).toEqual({});
  // GLM: 5.3 measured (low|high|max, no off); other GLMs have the on/off switch
  expect(fields("glm-5.3", "low")).toEqual({ reasoning_effort: "low" });
  expect(fields("zai-org/glm-5.3-flash", "medium")).toEqual({ reasoning_effort: "high" });
  expect(fields("z-ai/glm-5.3:free", "high")).toEqual({ reasoning_effort: "max" });
  expect(fields("glm-5.3", "off")).toEqual({});
  expect(says("glm-5.3", "off")).toMatch(/cannot switch thinking off/);
  expect(fields("glm-4.6", "high")).toEqual({ thinking: { type: "enabled" } });
  expect(fields("glm-4.7", "off")).toEqual({ thinking: { type: "disabled" } });
  expect(fields("glm-5", "off")).toEqual({ thinking: { type: "disabled" } });
  expect(dialectFor(ref("glm-4.5-air"))).toBe("glm");
  expect(dialectFor(ref("glm-4"))).toBe("openai-compatible default"); // GLM-4 had no thinking switch
  // DeepSeek
  expect(fields("deepseek-chat", "low")).toEqual({ thinking: { type: "enabled" } });
  expect(fields("deepseek-chat", "off")).toEqual({ thinking: { type: "disabled" } });
  expect(fields("deepseek-reasoner", "high")).toEqual({});
  expect(fields("deepseek-reasoner", "off")).toEqual({});
  expect(says("deepseek/deepseek-r1", "off")).toMatch(/always thinks/);
  // Qwen: DashScope's pair; Groq's own words
  expect(fields("qwen3-235b-a22b", "medium")).toEqual({ enable_thinking: true, thinking_budget: 8192 });
  expect(fields("qwen-plus", "off")).toEqual({ enable_thinking: false });
  expect(fields("qwq-32b", "high")).toEqual({ enable_thinking: true, thinking_budget: 24576 });
  expect(thinkingPlan({ provider: "groq", model: "qwen/qwen3-32b", effort: "off" }, "openai").fields).toEqual({ reasoning_effort: "none" });
  expect(thinkingPlan({ provider: "groq", model: "qwen/qwen3-32b", effort: "high" }, "openai").fields).toEqual({ reasoning_effort: "default" });
  // Kimi
  expect(fields("kimi-k2.5", "off")).toEqual({ thinking: { type: "disabled" } });
  expect(fields("moonshotai/kimi-k2.5", "high")).toEqual({ thinking: { type: "enabled" } });
  expect(fields("kimi-k2-thinking", "off")).toEqual({});
  expect(fields("kimi-k2-instruct", "high")).toEqual({});
  // Gemini through Google's OpenAI-compatible layer
  expect(fields("gemini-2.5-pro", "high")).toEqual({ reasoning_effort: "high" });
  expect(fields("gemini-2.5-flash", "off")).toEqual({ extra_body: { google: { thinking_config: { thinking_budget: 0 } } } });
  expect(fields("gemini-2.5-pro", "off")).toEqual({});
  expect(says("gemini-3-pro", "off")).toMatch(/cannot switch thinking off/);
  // xAI (docs.x.ai fetched 2026-09-04): the 4.x line takes none | low | medium | high; retired grok-4 slugs are served by grok-4.3
  expect(fields("grok-3-mini", "low")).toEqual({ reasoning_effort: "low" });
  expect(fields("grok-3-mini", "medium")).toEqual({ reasoning_effort: "high" });
  expect(fields("grok-3-mini", "off")).toEqual({});
  expect(fields("grok-4.3", "high")).toEqual({ reasoning_effort: "high" });
  expect(fields("grok-4.6", "off")).toEqual({ reasoning_effort: "none" });
  expect(fields("grok-4", "medium")).toEqual({ reasoning_effort: "medium" });
  expect(says("grok-4-0709", "off")).toMatch(/retired grok-4 slugs are served by grok-4.3/);
  expect(fields("grok-4-fast-non-reasoning", "high")).toEqual({});
  // always-on families
  expect(fields("magistral-medium-latest", "off")).toEqual({});
  expect(fields("mistral-large-latest", "high")).toEqual({});
  expect(fields("MiniMax-M2", "off")).toEqual({});
  // the floor
  expect(fields("llama-3.3-70b", "high")).toEqual({ reasoning_effort: "high" });
  expect(fields("llama-3.3-70b", "off")).toEqual({});
  expect(says("llama-3.3-70b", "off")).toMatch(/^nothing — off sends nothing here/);
  expect(dialectFor(ref("llama-3.3-70b"))).toBe("openai-compatible default");
});

test("the catalog's word silences every dialect; OpenRouter's unified object wins over the family; a provider-agnostic family is the same under any prefix", () => {
  for (const m of ["gpt-5.2", "glm-5.3", "deepseek-chat", "qwen3-8b", "llama-3.3-70b"]) {
    expect(fields(m, "high", { reasoning: false })).toEqual({});
    expect(says(m, "high", { reasoning: false })).toMatch(/the catalog lists .* without a reasoning mode/);
    expect(fields(m, "off", { reasoning: false })).toEqual({});
  }
  expect(fields("gpt-5.2", "high", { reasoning: true })).toEqual({ reasoning_effort: "high" }); // true changes nothing: the family decides
  for (const m of ["anthropic/claude-sonnet-5", "z-ai/glm-5.3", "deepseek/deepseek-chat", "qwen/qwen3-235b-a22b"]) {
    const or = (e: ThinkingEffort) => thinkingPlan({ provider: "openrouter", model: m, effort: e }, "openai").fields;
    expect(or("medium")).toEqual({ reasoning: { effort: "medium" } });
    expect(or("off")).toEqual({ reasoning: { enabled: false } });
    expect(or("auto")).toEqual({});
  }
  expect(thinkingPlan({ provider: "openrouter", model: "gpt-4o", effort: "high", reasoning: false }, "openai").fields).toEqual({}); // the catalog still wins
  expect(dialectFor(ref("kaesra/whatever/deepseek-v3.2"))).toBe("deepseek");
  expect(dialectFor(ref("fireworks/accounts/fireworks/models/qwen3-235b"))).toBe("qwen");
});

test("Anthropic: the effort shape, the budget shape, off, auto — with the sentence naming the shape", () => {
  const a = (e: ThinkingEffort, shape: "effort" | "budget") => thinkingPlan(ref("claude-opus-5", e), "anthropic", { shape });
  expect(a("high", "effort").fields).toEqual({ output_config: { effort: "high" } });
  expect(a("high", "effort").says).toBe('output_config: {effort: "high"} (the effort shape — learned from the endpoint, kept per model)');
  expect(a("medium", "budget").fields).toEqual({ thinking: { type: "enabled", budget_tokens: 8192 } });
  expect(a("medium", "budget").says).toContain("budget_tokens: 8192");
  expect(a("off", "budget").fields).toEqual({ thinking: { type: "disabled" } });
  expect(a("off", "effort").says).toMatch(/explicit off/);
  expect(a("auto", "budget").fields).toEqual({});
  expect(thinkingTable(ref("claude-sonnet-5"), "anthropic").map((r) => r.level)).toEqual(["auto", "off", "low", "medium", "high"]);
});

// ---------- through the adapters ----------

type Sent = { url: string; body: Record<string, unknown> };
function stubFetch(answer: (body: Record<string, unknown>) => Response): { sent: Sent[]; restore: () => void } {
  const sent: Sent[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (u: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    sent.push({ url: String(u), body });
    return answer(body);
  }) as typeof fetch;
  return { sent, restore: () => { globalThis.fetch = real; } };
}
const msg = (text: string): Message => ({ role: "user", parts: [{ kind: "text", text }] } as Message);
async function drive(fn: ReturnType<typeof openaiCompatStreaming>, model: ModelRef): Promise<string> {
  let stop = "";
  for await (const ev of fn(model, [msg("hi")], {})) if (ev.type === "turn") stop = ev.turn.stopReason;
  return stop;
}
const SSE_TEXT = 'data: {"choices":[{"delta":{"content":"x"},"finish_reason":"stop"}]}\n\n';
const JSON_TEXT = JSON.stringify({ choices: [{ message: { content: "x" }, finish_reason: "stop" }] });
const ANTHROPIC_SSE = [
  'data: {"type":"message_start","message":{"usage":{"input_tokens":3}}}',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}',
  'data: {"type":"content_block_stop","index":0}',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4}}',
  'data: {"type":"message_stop"}', "",
].join("\n\n");
const wrongShape = () => new Response(JSON.stringify({ error: { message: "thinking.type: enabled is not supported for this model" } }), { status: 400, headers: { "content-type": "application/json" } });

afterEach(() => shapeByModel.clear());

test("the OpenAI-compatible adapters put the dialect's fields in the body (streaming and one-shot), and nothing for auto/off where nothing is the answer", async () => {
  const s = stubFetch(() => new Response(SSE_TEXT, { status: 200 }));
  try {
    const fn = openaiCompatStreaming({ baseUrl: "http://stub.invalid/v1", apiKey: "k" });
    await drive(fn, { provider: "deepseek", model: "deepseek-chat", effort: "off" });
    expect(s.sent[0]!.body.thinking).toEqual({ type: "disabled" });
    expect(s.sent[0]!.body.reasoning_effort).toBeUndefined();
    await drive(fn, { provider: "openrouter", model: "anthropic/claude-sonnet-5", effort: "low" });
    expect(s.sent[1]!.body.reasoning).toEqual({ effort: "low" });
    await drive(fn, { provider: "dashscope", model: "qwen3-235b-a22b", effort: "high" });
    expect(s.sent[2]!.body).toMatchObject({ enable_thinking: true, thinking_budget: 24576 });
    await drive(fn, { provider: "xai", model: "grok-4-fast-non-reasoning", effort: "high" });
    expect(s.sent[3]!.body.reasoning_effort).toBeUndefined();
    await drive(fn, { provider: "openai", model: "gpt-4o", effort: "high", reasoning: false });
    expect(Object.keys(s.sent[4]!.body)).not.toContain("reasoning_effort");
    await drive(fn, { provider: "openai", model: "gpt-5.2", effort: "auto" });
    expect(s.sent[5]!.body.reasoning_effort).toBeUndefined();
  } finally { s.restore(); }
  const j = stubFetch(() => new Response(JSON_TEXT, { status: 200, headers: { "content-type": "application/json" } }));
  try {
    await drive(openaiCompatStream({ baseUrl: "http://stub.invalid/v1", apiKey: "k" }), { provider: "openai", model: "gpt-5.2", effort: "off" });
    expect(j.sent[0]!.body.reasoning_effort).toBe("none");
    expect(j.sent[0]!.body.stream).toBe(false);
  } finally { j.restore(); }
});

test("Anthropic shape memory: keyed per provider+model, bounded to ONE retry, no memory when both shapes are refused (no oscillation), and a 400 that is not about the dial is never retried; auto never learns", async () => {
  // (1) provider A's model learns "budget"; the same model id under provider B starts fresh with "effort"
  const learn = stubFetch((body) => body.output_config !== undefined ? wrongShape() : new Response(ANTHROPIC_SSE, { status: 200 }));
  try {
    const fn = anthropicStreaming({ baseUrl: "http://stub.invalid/v1", apiKey: "k" });
    expect(await drive(fn, { provider: "a", model: "m", effort: "high" })).toBe("end_turn");
    expect(learn.sent.length).toBe(2);
    expect(anthropicShapeFor({ provider: "a", model: "m" })).toBe("budget");
    expect(anthropicShapeFor({ provider: "b", model: "m" })).toBe("effort"); // per provider+model, not per model id
    await drive(fn, { provider: "b", model: "m", effort: "high" });
    expect(learn.sent.length).toBe(4);
    expect(learn.sent[2]!.body.output_config).toEqual({ effort: "high" }); // b tried the default shape first
    expect(shapeByModel.get("b/m")).toBe("budget");
  } finally { learn.restore(); }
  // (2) a model that refuses BOTH shapes: two sends, an error turn, and NO memory — the next request costs the same two, not a flip-flop
  const both = stubFetch(() => wrongShape());
  try {
    const fn = anthropicStreaming({ baseUrl: "http://stub.invalid/v1", apiKey: "k" });
    expect(await drive(fn, { provider: "c", model: "neither", effort: "low" })).toBe("error");
    expect(both.sent.length).toBe(2);
    expect(shapeByModel.has("c/neither")).toBe(false);
    await drive(fn, { provider: "c", model: "neither", effort: "low" });
    expect(both.sent.length).toBe(4);
    expect(both.sent[2]!.body.output_config).toEqual({ effort: "low" }); // still starts from the default shape
  } finally { both.restore(); }
  // (3) "not supported for this model" about something ELSE (an image, a tool) does not touch the shape
  const other = stubFetch(() => new Response(JSON.stringify({ error: { message: "image input is not supported for this model" } }), { status: 400 }));
  try {
    const fn = anthropicStreaming({ baseUrl: "http://stub.invalid/v1", apiKey: "k" });
    expect(await drive(fn, { provider: "d", model: "m", effort: "high" })).toBe("error");
    expect(other.sent.length).toBe(1);
    expect(shapeByModel.has("d/m")).toBe(false);
  } finally { other.restore(); }
  // (4) auto and off carry no shape: a 400 is returned as is, nothing learned
  const auto = stubFetch(() => wrongShape());
  try {
    const fn = anthropicStreaming({ baseUrl: "http://stub.invalid/v1", apiKey: "k" });
    await drive(fn, { provider: "e", model: "m", effort: "auto" });
    await drive(fn, { provider: "e", model: "m", effort: "off" });
    expect(auto.sent.length).toBe(2);
    expect(auto.sent[0]!.body.thinking).toBeUndefined();
    expect(auto.sent[1]!.body.thinking).toEqual({ type: "disabled" });
    expect(shapeByModel.has("e/m")).toBe(false);
  } finally { auto.restore(); }
});

test("the human sees it: the /effort note's second line and `model show` name the exact field for THIS model", () => {
  const line = thinkingLine({ provider: "deepseek", model: "deepseek-chat", effort: "high" }, "openai");
  expect(line).toBe('deepseek/deepseek-chat receives: thinking: { type: "enabled" } (DeepSeek has an on/off switch, no levels)');
  expect(effortNote("high", line)).toBe(`thinking: high — I reason before answering. It costs output tokens and delays the first word.\n  ${line}`);
  expect(effortNote("high")).not.toContain("\n");
  const report = thinkingReport({ provider: "openai", model: "gpt-4o", effort: "medium", reasoning: false }, "openai", { source: "the default" });
  expect(report[0]).toBe("openai/gpt-4o  (the default)");
  expect(report[1]).toBe("  protocol  openai");
  expect(report[2]).toBe("  dialect   catalog: no reasoning mode  — the catalog lists no reasoning mode");
  expect(report[3]).toBe("  effort    medium  (ROVECODE_EFFORT / --effort / /effort)");
  expect(report[6]).toMatch(/^ {4}low {5}nothing — the catalog lists gpt-4o without a reasoning mode/);
  expect(report[7]).toMatch(/^  \* medium {2}nothing/);
  const claude = thinkingReport({ provider: "anthropic", model: "claude-opus-5", effort: "auto" }, "anthropic", { shape: "budget" });
  expect(claude[2]).toBe("  dialect   anthropic (budget shape)");
  expect(claude[8]).toBe('    high    thinking: {type: "enabled", budget_tokens: 24576} (the budget shape — learned from the endpoint, kept per model)');
});
