/** Port #34 wire tests: image parts through the REAL adapters (globalThis.fetch stubbed, request
 *  body captured, restored in finally) — the exact block shapes each protocol receives, the vision
 *  gate (models.dev catalog) that swaps an image for placeholder text on a model without image
 *  input, part ordering, sidecar reads at lowering time, and the unchanged text-only shapes. */

import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { anthropicStream, openaiCompatStream, openaiCompatStreaming, toOpenAiMessages, toAnthropicMessages } from "../../src/providers/stream.ts";
import { supportsImages } from "../../src/providers/catalog.ts";
import { imageFromBytes } from "../../src/core/images.ts";
import type { ImagePart, Message, ModelRef, Role, StreamFn } from "../../src/core/types.ts";
import { PNG_1x1, PNG_1x1_B64, GIF_2x3 } from "../fixtures/images.ts";

// models.dev snapshot (@opencode-ai/models): modalities.input carries "image" for the first two,
// only "text" for deepseek-v4-pro; test/test-model is not in the catalog at all
const VISION_ANTHROPIC: ModelRef = { provider: "anthropic", model: "claude-haiku-4-5" };
const VISION_OPENAI: ModelRef = { provider: "openai", model: "gpt-4o" };
const TEXT_ONLY: ModelRef = { provider: "deepseek", model: "deepseek-v4-pro" };
const UNKNOWN: ModelRef = { provider: "test", model: "test-model" };

type Block = Record<string, unknown>;
const PNG_BLOCK_ANTHROPIC = { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_1x1_B64 } };
const PNG_BLOCK_OPENAI = { type: "image_url", image_url: { url: `data:image/png;base64,${PNG_1x1_B64}`, detail: "auto" } };
const PLACEHOLDER = "[image: dot.png, 1x1, 70 B — model has no vision]";

function png(name = "dot.png"): ImagePart { const r = imageFromBytes(PNG_1x1, { name }); if ("error" in r) throw new Error(r.error); return r; }
function gif(name = "tiny.gif"): ImagePart { const r = imageFromBytes(GIF_2x3, { name }); if ("error" in r) throw new Error(r.error); return r; }
const text = (t: string) => ({ kind: "text" as const, text: t });
let seq = 0;
function msg(role: Role, parts: Message["parts"]): Message { seq += 1; return { id: `m${seq}`, role, parts, parentId: null, createdAt: 0 }; }

/** Swap globalThis.fetch for a scripted responder; returns captured request bodies + restore(). */
function stubFetch(respond: () => Response): { bodies: Record<string, unknown>[]; restore: () => void } {
  const bodies: Record<string, unknown>[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    return respond();
  }) as typeof fetch;
  return { bodies, restore: () => { globalThis.fetch = real; } };
}

/** Drive an adapter to completion and hand back the ONE request body it POSTed. */
async function requestBody(fn: StreamFn, model: ModelRef, messages: Message[], respond: () => Response): Promise<Record<string, unknown>> {
  const { bodies, restore } = stubFetch(respond);
  try {
    for await (const _ev of fn(model, messages)) { /* drain */ }
  } finally {
    restore();
  }
  expect(bodies).toHaveLength(1);
  return bodies[0]!;
}

const anthropicOk = () => new Response(JSON.stringify({ content: [{ type: "text", text: "a dot" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 });
const openaiOk = () => new Response(JSON.stringify({ choices: [{ message: { content: "a dot" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 });
const sseOk = () => new Response(['data: {"choices":[{"delta":{"content":"a dot"},"finish_reason":"stop"}]}', "data: [DONE]", ""].join("\n\n"), { status: 200 });

const A = anthropicStream({ baseUrl: "http://stub.invalid/v1", apiKey: "k" });
const O = openaiCompatStream({ baseUrl: "http://stub.invalid/v1", apiKey: "k" });
const OS = openaiCompatStreaming({ baseUrl: "http://stub.invalid/v1", apiKey: "k" });

// ---------- byte-shape pins through the real adapters ----------

test("anthropicStream: a vision model gets the image as a base64 source block after the text — exact wire shape", async () => {
  const body = await requestBody(A, VISION_ANTHROPIC, [msg("user", [text("what is this?"), png()])], anthropicOk);
  expect(body.model).toBe("claude-haiku-4-5");
  expect(body.messages).toEqual([{ role: "user", content: [{ type: "text", text: "what is this?" }, PNG_BLOCK_ANTHROPIC] }]);
});

test("openaiCompatStream: a vision model gets the image as an image_url data URL with detail auto — exact wire shape", async () => {
  const body = await requestBody(O, VISION_OPENAI, [msg("user", [text("what is this?"), png()])], openaiOk);
  expect(body.messages).toEqual([{ role: "user", content: [{ type: "text", text: "what is this?" }, PNG_BLOCK_OPENAI] }]);
});

test("openaiCompatStreaming (SSE) lowers images through the same path — identical shape", async () => {
  const body = await requestBody(OS, VISION_OPENAI, [msg("user", [text("what is this?"), png()])], sseOk);
  expect(body.stream).toBe(true);
  expect(body.messages).toEqual([{ role: "user", content: [{ type: "text", text: "what is this?" }, PNG_BLOCK_OPENAI] }]);
});

// ---------- vision gate ----------

test("non-vision model (deepseek-v4-pro, modalities.input = text): BOTH adapters send the placeholder text instead — no image block, no base64 anywhere in the body", async () => {
  const messages = [msg("user", [text("what is this?"), png()])];
  const a = await requestBody(A, TEXT_ONLY, messages, anthropicOk);
  expect(a.messages).toEqual([{ role: "user", content: `what is this?\n${PLACEHOLDER}` }]);
  expect(JSON.stringify(a)).not.toContain(PNG_1x1_B64);
  const o = await requestBody(O, TEXT_ONLY, messages, openaiOk);
  expect(o.messages).toEqual([{ role: "user", content: `what is this?\n${PLACEHOLDER}` }]);
  expect(JSON.stringify(o)).not.toContain("image_url");
  const os = await requestBody(OS, TEXT_ONLY, messages, sseOk);
  expect(os.messages).toEqual([{ role: "user", content: `what is this?\n${PLACEHOLDER}` }]);
});

test("unknown model (not in the catalog): the image IS sent — a wrong guess fails loudly at the provider instead of silently dropping it", async () => {
  const o = await requestBody(O, UNKNOWN, [msg("user", [text("hi"), png()])], openaiOk);
  expect((o.messages as { content: Block[] }[])[0]!.content[1]).toEqual(PNG_BLOCK_OPENAI);
  const a = await requestBody(A, UNKNOWN, [msg("user", [text("hi"), png()])], anthropicOk);
  expect((a.messages as { content: Block[] }[])[0]!.content[1]).toEqual(PNG_BLOCK_ANTHROPIC);
});

test("supportsImages: models.dev modalities.input decides — vision true, text-only false, unknown undefined, a vendor-prefixed aggregator id resolves through the prefix map", () => {
  expect(supportsImages(VISION_ANTHROPIC)).toBe(true);
  expect(supportsImages(VISION_OPENAI)).toBe(true);
  expect(supportsImages(TEXT_ONLY)).toBe(false);
  expect(supportsImages({ provider: "groq", model: "llama-3.1-8b-instant" })).toBe(false);
  expect(supportsImages(UNKNOWN)).toBeUndefined();
  expect(supportsImages({ provider: "ollama", model: "llava" })).toBeUndefined(); // no bare "ollama" key in the snapshot
  expect(supportsImages({ provider: "kaesra", model: "zai-org/glm-5.3-flash" })).toBe(true);
});

// ---------- ordering + unchanged text shapes (direct lowering) ----------

test("mixed parts [image, text, image] keep their order in both lowerings; the two images keep their own mimes", () => {
  const m = msg("user", [gif(), text("between"), png()]);
  const oa = toOpenAiMessages([m]);
  const oaBlocks = oa[0]!.content as { type: string; image_url?: { url: string } }[];
  expect(oaBlocks.map((b) => b.type)).toEqual(["image_url", "text", "image_url"]);
  expect(oaBlocks[0]!.image_url!.url.startsWith("data:image/gif;base64,")).toBe(true);
  expect(oaBlocks[2]!.image_url!.url.startsWith("data:image/png;base64,")).toBe(true);
  const an = toAnthropicMessages([m]);
  const anBlocks = an[0]!.content as { type: string; source?: { media_type: string } }[];
  expect(anBlocks.map((b) => b.type)).toEqual(["image", "text", "image"]);
  expect(anBlocks.map((b) => b.source?.media_type)).toEqual(["image/gif", undefined, "image/png"]);
  // no vision: one placeholder line per image, text glued exactly as partsText would, order kept
  expect(toOpenAiMessages([m], { vision: false })[0]!.content).toBe(`[image: tiny.gif, 2x3, 20 B — model has no vision]\nbetween\n${PLACEHOLDER}`);
  expect(toAnthropicMessages([m], { vision: false })[0]!.content).toBe(`[image: tiny.gif, 2x3, 20 B — model has no vision]\nbetween\n${PLACEHOLDER}`);
});

test("image-free histories are byte-identical to the pre-#34 lowering: plain-string content, system/assistant/tool shapes untouched", () => {
  const history = [
    msg("system", [text("be terse")]),
    msg("user", [text("hi")]),
    msg("assistant", [text("calling"), { kind: "tool_call", id: "t1", tool: "read", args: { path: "a" } }]),
    msg("tool", [{ kind: "tool_result", callId: "t1", ok: true, output: "A" }]),
    msg("assistant", [text("done")]),
  ];
  expect(toOpenAiMessages(history)).toEqual([
    { role: "system", content: "be terse" },
    { role: "user", content: "hi" },
    { role: "assistant", content: "calling", tool_calls: [{ id: "t1", type: "function", function: { name: "read", arguments: '{"path":"a"}' } }] },
    { role: "tool", tool_call_id: "t1", content: "A" },
    { role: "assistant", content: "done" },
  ]);
  expect(toAnthropicMessages(history)).toEqual([
    { role: "user", content: "hi" },
    { role: "assistant", content: [{ type: "text", text: "calling" }, { type: "tool_use", id: "t1", name: "read", input: { path: "a" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "A", is_error: false }] },
    { role: "assistant", content: "done" },
  ]);
  // an empty user message is still skipped (an image-only one is not)
  expect(toOpenAiMessages([msg("user", [text("")])])).toEqual([]);
  expect(toAnthropicMessages([msg("user", [text(""), png()])])).toEqual([{ role: "user", content: [PNG_BLOCK_ANTHROPIC] }]);
});

test("sidecar parts: an absolute path is read lazily at lowering time; a missing file lowers to a placeholder and a relative path is never read — no throw either way", () => {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-wire-"));
  const file = join(dir, "dot.png");
  writeFileSync(file, PNG_1x1);
  const onDisk: ImagePart = { kind: "image", mime: "image/png", path: file, name: "dot.png" };
  const gone: ImagePart = { kind: "image", mime: "image/png", path: join(dir, "gone.png"), name: "gone.png" };
  const content = toOpenAiMessages([msg("user", [text("see"), onDisk, gone])])[0]!.content as Block[];
  expect(content).toEqual([
    { type: "text", text: "see" },
    PNG_BLOCK_OPENAI,
    { type: "text", text: "[image: gone.png — file unavailable]" },
  ]);
  const relative: ImagePart = { kind: "image", mime: "image/png", path: "attachments/x.png", name: "x.png" };
  expect(toAnthropicMessages([msg("user", [relative])])[0]!.content).toEqual([{ type: "text", text: "[image: x.png — file unavailable]" }]);
  // an image on an assistant message is not something this harness produces: placeholder, not a block
  expect(toAnthropicMessages([msg("assistant", [text("look"), png()])])[0]!.content).toBe(`look\n[image: dot.png, 1x1, 70 B — file unavailable]`);
  rmSync(dir, { recursive: true, force: true });
});
