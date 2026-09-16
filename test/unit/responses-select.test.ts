/** Port #75 — the wire selector and the two production factories: cfg.wire > ROVECODE_OPENAI_WIRE (junk ignored) >
 *  `openai` + the ModelRef's reasoning stamp, else the catalog, true/unknown → responses, else chat (M6 M7);
 *  providerStream AND providerStreaming return ONE StreamFn that picks the wire PER CALL (gpt-5 → /responses then
 *  gpt-4o → /chat/completions against one stubbed fetch); the chat body for openai/gpt-4o and custom/gpt-5 is
 *  deep-equal to openaiCompatStream's own (byte-identical to before the port); openAiWire hands the same opts to
 *  either adapter; the knob is named in the help text and the README, next to the replay gap. No network. */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { openAiWire, parseWire, selectOpenAiWire, OPENAI_WIRES, OPENAI_WIRE_ENV } from "../../src/providers/wire-select.ts";
import { openaiCompatStream, openaiCompatStreaming, providerStreaming, providerStream, type ProviderConfig } from "../../src/providers/stream.ts";
import { openaiResponsesStream } from "../../src/providers/responses.ts";
import type { Message, ModelRef, StreamEvent, StreamFn } from "../../src/core/types.ts";

const ROOT = resolve(import.meta.dir, "..", "..");
const ref = (provider: string, model: string): ModelRef => ({ provider, model });
const user: Message = { id: "m1", role: "user", parts: [{ kind: "text", text: "hi" }], parentId: null, createdAt: 0 };
const OPENAI: ProviderConfig = { id: "openai", baseUrl: "https://api.openai.com/v1", apiKey: "k", protocol: "openai" };
const CUSTOM: ProviderConfig = { id: "custom", baseUrl: "http://gateway.invalid/v1", apiKey: "k", protocol: "openai" };

// the host's knob must not steer these tests (the preload scrubs ROVECODE_*, but a test below sets it and must restore)
const saved = new Map<string, string | undefined>();
beforeEach(() => { for (const k of [OPENAI_WIRE_ENV]) { saved.set(k, process.env[k]); delete process.env[k]; } });
afterEach(() => { for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

test("selectOpenAiWire table (M6 M7): cfg.wire always wins; then the knob (junk falls through); then openai + the ModelRef's reasoning stamp, else the catalog, true/unknown → responses; gpt-4o / gpt-4.1 / custom / every other provider → chat", () => {
  const none = {};
  expect(OPENAI_WIRES).toEqual(["responses", "chat"]);
  expect(OPENAI_WIRE_ENV).toBe("ROVECODE_OPENAI_WIRE");
  // 1. cfg.wire — whatever the model or the knob
  expect(selectOpenAiWire({ id: "custom", wire: "responses" }, ref("custom", "gpt-4o"), none)).toBe("responses");
  expect(selectOpenAiWire({ id: "openai", wire: "chat" }, ref("openai", "gpt-5"), none)).toBe("chat");
  expect(selectOpenAiWire({ id: "openai", wire: "responses" }, ref("openai", "gpt-4o"), { ROVECODE_OPENAI_WIRE: "chat" })).toBe("responses");
  // 2. the knob
  expect(selectOpenAiWire({ id: "custom" }, ref("custom", "gpt-5"), { ROVECODE_OPENAI_WIRE: "responses" })).toBe("responses");
  expect(selectOpenAiWire({ id: "openai" }, ref("openai", "gpt-5"), { ROVECODE_OPENAI_WIRE: "chat" })).toBe("chat");
  expect(selectOpenAiWire({ id: "openai" }, ref("openai", "gpt-4o"), { ROVECODE_OPENAI_WIRE: "foo" })).toBe("chat");
  expect(selectOpenAiWire({ id: "openai" }, ref("openai", "gpt-5"), { ROVECODE_OPENAI_WIRE: "foo" })).toBe("responses");
  // 3. the catalog rule for provider `openai`: true or UNKNOWN → responses
  for (const m of ["gpt-5", "o3", "gpt-5.3-codex", "gpt-5-codex", "gpt-5-mini"]) expect([m, selectOpenAiWire({ id: "openai" }, ref("openai", m), none)]).toEqual([m, "responses"]);
  for (const m of ["gpt-4o", "gpt-4.1", "gpt-4o-mini"]) expect([m, selectOpenAiWire({ id: "openai" }, ref("openai", m), none)]).toEqual([m, "chat"]);
  // the runtime's stamp on the ModelRef (cli/runtime.ts buildDef) is stronger than the offline catalog
  expect(selectOpenAiWire({ id: "openai" }, { ...ref("openai", "gpt-5"), reasoning: false }, none)).toBe("chat");
  expect(selectOpenAiWire({ id: "openai" }, { ...ref("openai", "gpt-4o"), reasoning: true }, none)).toBe("responses");
  // 4. everything else stays chat — even a reasoning model behind a gateway (M7)
  expect(selectOpenAiWire({ id: "custom" }, ref("custom", "gpt-5"), none)).toBe("chat");
  for (const id of ["groq", "deepseek", "openrouter", "ollama", "mock", "kaesra", "github-copilot"]) expect([id, selectOpenAiWire({ id }, ref(id, "gpt-5"), none)]).toEqual([id, "chat"]);
  expect(parseWire(" Chat ")).toBe("chat");
  expect(parseWire("RESPONSES")).toBe("responses");
  expect(parseWire("foo")).toBeUndefined();
  expect(parseWire(undefined)).toBeUndefined();
});

interface Captured { url: string; headers: Record<string, string>; body: Record<string, unknown> }
const CHAT_JSON = JSON.stringify({ choices: [{ message: { content: "chat" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
const CHAT_SSE = 'data: {"choices":[{"delta":{"content":"chat"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\ndata: [DONE]\n\n';
const RESP_SSE = 'event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":0,"item":{"type":"message","id":"m","role":"assistant","status":"completed","content":[{"type":"output_text","text":"resp","annotations":[]}]}}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"id":"r","status":"completed","usage":{"input_tokens":1,"output_tokens":1}}}\n\n';
/** answers /responses with a Responses SSE, /chat/completions with JSON or chat SSE by the body's `stream` flag */
function stubFetch(): { calls: Captured[]; restore: () => void } {
  const calls: Captured[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ url: u, headers: (init?.headers ?? {}) as Record<string, string>, body });
    if (u.endsWith("/responses")) return new Response(RESP_SSE, { status: 200 });
    return new Response(body.stream === true ? CHAT_SSE : CHAT_JSON, { status: 200 });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = real; } };
}
async function turnOf(fn: StreamFn, model: ModelRef): Promise<Extract<StreamEvent, { type: "turn" }>["turn"]> {
  let t: Extract<StreamEvent, { type: "turn" }> | undefined;
  for await (const e of fn(model, [user])) if (e.type === "turn") t = e;
  if (!t) throw new Error("no turn");
  return t.turn;
}

test("providerStream(cfg) is ONE StreamFn that picks the wire PER CALL: gpt-5 → /responses, then gpt-4o → /chat/completions against the same stubbed fetch; both turns are clean", async () => {
  const { calls, restore } = stubFetch();
  try {
    const fn = providerStream(OPENAI);
    const a = await turnOf(fn, ref("openai", "gpt-5"));
    const b = await turnOf(fn, ref("openai", "gpt-4o"));
    expect(calls.map((c) => c.url)).toEqual(["https://api.openai.com/v1/responses", "https://api.openai.com/v1/chat/completions"]);
    expect(calls[0]!.body.store).toBe(false);
    expect(calls[1]!.body.stream).toBe(false);
    expect(a.stopReason).toBe("end_turn");
    expect(a.parts).toEqual([{ kind: "text", text: "resp" }]);
    expect(b.stopReason).toBe("end_turn");
    expect(b.parts).toEqual([{ kind: "text", text: "chat" }]);
  } finally { restore(); }
});

test("providerStreaming(cfg) picks per call too: gpt-5 → /responses, gpt-4o → /chat/completions with stream:true (the Responses wire is the same SSE adapter on both factories)", async () => {
  const { calls, restore } = stubFetch();
  try {
    const fn = providerStreaming({ ...OPENAI, headers: { "x-extra": "1" } });
    const a = await turnOf(fn, ref("openai", "gpt-5"));
    const b = await turnOf(fn, ref("openai", "gpt-4o"));
    expect(calls.map((c) => c.url)).toEqual(["https://api.openai.com/v1/responses", "https://api.openai.com/v1/chat/completions"]);
    expect(calls[1]!.body.stream).toBe(true);
    expect(calls[0]!.headers["x-extra"]).toBe("1"); // the config's extra headers reach both wires
    expect(calls[1]!.headers["x-extra"]).toBe("1");
    expect(a.parts).toEqual([{ kind: "text", text: "resp" }]);
    expect(b.parts).toEqual([{ kind: "text", text: "chat" }]);
  } finally { restore(); }
});

test("byte-identical chat bodies: openai/gpt-4o and custom/gpt-5 through providerStream deep-equal openaiCompatStream's own body and URL (the port changed nothing there, M7); the knob flips custom to /responses and openai/gpt-5 to chat", async () => {
  const { calls, restore } = stubFetch();
  try {
    await turnOf(providerStream(OPENAI), ref("openai", "gpt-4o"));
    await turnOf(openaiCompatStream({ baseUrl: OPENAI.baseUrl, apiKey: OPENAI.apiKey }), ref("openai", "gpt-4o"));
    expect(calls[0]!.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(calls[0]!.url).toBe(calls[1]!.url);
    expect(calls[0]!.body).toEqual(calls[1]!.body);
    expect(calls[0]!.headers).toEqual(calls[1]!.headers);
    await turnOf(providerStream(CUSTOM), ref("custom", "gpt-5"));
    await turnOf(openaiCompatStream({ baseUrl: CUSTOM.baseUrl, apiKey: CUSTOM.apiKey }), ref("custom", "gpt-5"));
    expect(calls[2]!.url).toBe("http://gateway.invalid/v1/chat/completions");
    expect(calls[2]!.body).toEqual(calls[3]!.body);
    await turnOf(providerStreaming(CUSTOM), ref("custom", "gpt-5"));
    await turnOf(openaiCompatStreaming({ baseUrl: CUSTOM.baseUrl, apiKey: CUSTOM.apiKey }), ref("custom", "gpt-5"));
    expect(calls[4]!.url).toBe("http://gateway.invalid/v1/chat/completions");
    expect(calls[4]!.body).toEqual(calls[5]!.body);
    process.env.ROVECODE_OPENAI_WIRE = "responses";
    await turnOf(providerStream(CUSTOM), ref("custom", "gpt-5"));
    expect(calls[6]!.url).toBe("http://gateway.invalid/v1/responses");
    process.env.ROVECODE_OPENAI_WIRE = "chat";
    await turnOf(providerStream(OPENAI), ref("openai", "gpt-5"));
    expect(calls[7]!.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(calls.filter((c) => c.url.endsWith("/responses"))).toHaveLength(1);
  } finally { restore(); }
});

test("openAiWire hands the SAME opts (base URL, key, headers) to whichever adapter serves the call; a cfg.wire pin holds for every model", async () => {
  const { calls, restore } = stubFetch();
  try {
    const make = openAiWire({ id: "openai" }, openaiCompatStream, openaiResponsesStream)({ baseUrl: "https://api.openai.com/v1", apiKey: "k-1", headers: { "chatgpt-account-id": "acct-1" } });
    await turnOf(make, ref("openai", "gpt-5"));
    await turnOf(make, ref("openai", "gpt-4o"));
    for (const c of calls) { expect(c.headers.authorization).toBe("Bearer k-1"); expect(c.headers["chatgpt-account-id"]).toBe("acct-1"); }
    expect(calls.map((c) => c.url.split("/v1/")[1])).toEqual(["responses", "chat/completions"]);
    const pinned = openAiWire({ id: "custom", wire: "responses" }, openaiCompatStream, openaiResponsesStream)({ baseUrl: "http://gateway.invalid/v1", apiKey: "k" });
    await turnOf(pinned, ref("custom", "gpt-4o"));
    expect(calls[2]!.url).toBe("http://gateway.invalid/v1/responses");
  } finally { restore(); }
});

test("docs: the env page and the README name ROVECODE_OPENAI_WIRE with the selection rule AND the replay gap (what is not happening, and what it would take) — the gap is a capability hole a person must be able to read, not only a commit message", () => {
  const help = readFileSync(join(ROOT, "src", "cli", "help.ts"), "utf8");
  expect(help).toContain("ROVECODE_OPENAI_WIRE  responses | chat");
  expect(help).toContain("reasoning items are NOT sent back to it on the next turn");
  expect(help).toContain("needs a reasoning part in");
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  expect(readme).toContain("`ROVECODE_OPENAI_WIRE=responses|chat`");
  expect(readme).toContain("`originator: rovecode`");
  expect(readme).toContain("reasoning items are not replayed to the model on the next turn");
  // and the help entry for the login names the wire the token takes
  expect(help).toContain("openai (ChatGPT device code; the token is sent over the Codex Responses wire only");
  expect(help).not.toContain("refused until this build has the Codex Responses wire");
});
