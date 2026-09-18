/** Port #66 fix wave (MED) — the `ROVECODE_STREAM=sse` adapter the CLI builds carries the OAuth provider
 *  headers. main.ts cannot be imported by tests (it dispatches on load), so the CLI's SSE builder is the ONE
 *  helper `providerStreaming` (providers/stream.ts): a structural pin proves main.ts routes BOTH of its
 *  streaming sites (resolveStream, cmdRun) through it and never calls openaiCompatStreaming directly, and a
 *  loopback fake `/chat/completions` SSE server records what the helper sends for the configs the CLI path
 *  resolves (resolveOAuthProviderConfig over injected providers + store, exactly as resolveProvider's last
 *  resort): GitHub Copilot's four editor headers next to the bearer; OpenAI's `chatgpt-account-id` and the codex
 *  headers on /responses (the wire a stored ChatGPT token takes, #75); a headerless config (OpenRouter) sends
 *  the bearer alone to /chat/completions. No network, no real provider, no store on disk. */

import { afterAll, afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Message, StreamEvent } from "../../src/core/types.ts";
import { GITHUB_COPILOT_ENDPOINTS, githubCopilotOAuth } from "../../src/providers/oauth/github-copilot.ts";
import { OPENAI_ENDPOINTS, openAIOAuth } from "../../src/providers/oauth/openai.ts";
import { OPENROUTER_ENDPOINTS, openRouterOAuth } from "../../src/providers/oauth/openrouter.ts";
import { resolveOAuthProviderConfig, type OAuthSeamDeps } from "../../src/providers/oauth/seam.ts";
import { providerStreaming, type ProviderConfig } from "../../src/providers/stream.ts";

const COPILOT_TOKEN = "tid=canary;proxy-ep=proxy.test.githubcopilot.com;copilot-CANARY-token-0123456789";
const OAI_TOKEN = "oai-CANARY-access-token-0123456789";
const OR_KEY = "sk-or-v1-CANARY-permanent-key-0123456789";
type Recorded = { path: string; headers: Record<string, string>; body: { model?: string; stream?: boolean } };
let requests: Recorded[] = [];

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    if ((path !== "/chat/completions" && path !== "/responses") || req.method !== "POST") return new Response("not found", { status: 404 });
    requests.push({ path, headers: Object.fromEntries([...req.headers.entries()]), body: (await req.json()) as Recorded["body"] });
    if (path === "/responses") { // #75: the Responses wire — the same two text deltas as the chat SSE below
      const events = [
        { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1", role: "assistant" } },
        { type: "response.output_text.delta", output_index: 0, delta: "hello " },
        { type: "response.output_text.delta", output_index: 0, delta: "from sse" },
        { type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "hello from sse", annotations: [] }] } },
        { type: "response.completed", response: { id: "r1", status: "completed", usage: { input_tokens: 3, output_tokens: 2 } } },
      ];
      return new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    const chunks = [
      { choices: [{ delta: { content: "hello " }, finish_reason: null }] },
      { choices: [{ delta: { content: "from sse" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2 } },
    ];
    const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  },
});
const base = `http://127.0.0.1:${server.port}`;
afterAll(() => server.stop(true));
afterEach(() => { requests = []; });

function withDeadline<T>(p: Promise<T>, ms = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`exceeded ${ms} ms`)), ms); });
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer)) as Promise<T>;
}
const userMsg = (text: string): Message => ({ id: "m1", role: "user", parts: [{ kind: "text", text }], parentId: null, createdAt: 1 });

/** one turn through the CLI's SSE builder over `cfg`; returns every event. `seam` is what the OAuth refresh wrap
 *  consults (the injected providers + store here — production reads the real registry and credentials.json) */
async function drive(cfg: ProviderConfig, seam: OAuthSeamDeps = {}): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  await withDeadline((async () => { for await (const ev of providerStreaming(cfg, seam)({ provider: cfg.id, model: "m" }, [userMsg("hi")])) events.push(ev); })());
  return events;
}
const textOf = (events: StreamEvent[]) => events.filter((e) => e.type === "text_delta").map((e) => (e as { text: string }).text);
const turnOf = (events: StreamEvent[]) => { const t = events.find((e) => e.type === "turn"); return t && t.type === "turn" ? t.turn : undefined; };

test("providerStreaming over the config the CLI resolves for a stored GitHub Copilot token sends the four editor headers next to the bearer (SSE body, stream: true) — the headers the JSON path already sent", async () => {
  const providers = [githubCopilotOAuth({ ...GITHUB_COPILOT_ENDPOINTS, chatBaseUrl: base })];
  const seam: OAuthSeamDeps = { providers, load: () => ({ "github-copilot": { type: "oauth", access: COPILOT_TOKEN, refresh: "gho_x", expires: Number.MAX_SAFE_INTEGER } }) };
  const cfg = resolveOAuthProviderConfig(seam);
  expect(cfg).toMatchObject({ id: "github-copilot", oauth: true, protocol: "openai", baseUrl: base, apiKey: COPILOT_TOKEN });
  const events = await drive(cfg!, seam);
  expect(textOf(events)).toEqual(["hello ", "from sse"]);
  expect(turnOf(events)?.parts).toEqual([{ kind: "text", text: "hello from sse" }]);
  expect(turnOf(events)?.usage).toMatchObject({ input: 3, output: 2 });
  expect(requests).toHaveLength(1);
  const h = requests[0]!.headers;
  // MUTATION TARGET (drop `...(cfg.headers ? { headers: cfg.headers } : {})` from providerStreaming): the four Copilot headers vanish
  expect(h["editor-version"]).toBe("vscode/1.107.0");
  expect(h["editor-plugin-version"]).toBe("copilot-chat/0.35.0");
  expect(h["copilot-integration-id"]).toBe("vscode-chat");
  expect(h["user-agent"]).toBe("GitHubCopilotChat/0.35.0");
  expect(h["authorization"]).toBe(`Bearer ${COPILOT_TOKEN}`);
  expect(h["content-type"]).toBe("application/json");
  expect(requests[0]!.body).toMatchObject({ model: "m", stream: true });
  expect(requests[0]!.path).toBe("/chat/completions"); // #75: Copilot stays on the chat wire
});

test("OpenAI: the stored accountId rides as chatgpt-account-id on the streaming request — which is /responses with the codex headers (#75); OpenRouter (no extra headers) sends the bearer alone to /chat/completions — nothing Copilot-shaped leaks across providers; a plain config with headers goes through the same builder unchanged", async () => {
  const oai = [openAIOAuth({ ...OPENAI_ENDPOINTS, responsesBaseUrl: base })];
  const oaiSeam: OAuthSeamDeps = { providers: oai, load: () => ({ openai: { type: "oauth", access: OAI_TOKEN, refresh: "rt", expires: Number.MAX_SAFE_INTEGER, accountId: "acct-CANARY-42" } }) };
  const oaiCfg = resolveOAuthProviderConfig(oaiSeam);
  expect(oaiCfg?.headers).toEqual({ "chatgpt-account-id": "acct-CANARY-42", "OpenAI-Beta": "responses=experimental", originator: "rovecode" });
  expect(oaiCfg?.wire).toBe("responses");
  expect(textOf(await drive(oaiCfg!, oaiSeam))).toEqual(["hello ", "from sse"]);
  expect(requests[0]!.path).toBe("/responses"); // #75: a ChatGPT token never reaches /chat/completions
  expect(requests[0]!.headers["originator"]).toBe("rovecode");
  expect(requests[0]!.headers["chatgpt-account-id"]).toBe("acct-CANARY-42");
  expect(requests[0]!.headers["authorization"]).toBe(`Bearer ${OAI_TOKEN}`);
  expect(requests[0]!.headers["editor-version"]).toBeUndefined();

  const or = [openRouterOAuth({ ...OPENROUTER_ENDPOINTS, chatBaseUrl: base })];
  const seam: OAuthSeamDeps = { providers: or, load: () => ({ openrouter: { type: "oauth", access: OR_KEY, refresh: "", expires: Number.MAX_SAFE_INTEGER } }) };
  const orCfg = resolveOAuthProviderConfig(seam);
  expect(orCfg?.headers).toBeUndefined();
  expect(textOf(await drive(orCfg!, seam))).toEqual(["hello ", "from sse"]);
  expect(requests).toHaveLength(2);
  expect(requests[1]!.path).toBe("/chat/completions");
  expect(requests[1]!.headers["authorization"]).toBe(`Bearer ${OR_KEY}`);
  expect(requests[1]!.headers["chatgpt-account-id"]).toBeUndefined();
  expect(requests[1]!.headers["editor-version"]).toBeUndefined();
  // a plain (non-oauth) config with headers goes through the same builder unchanged
  const plain: ProviderConfig = { id: "custom", baseUrl: base, apiKey: "k-0123456789", protocol: "openai", headers: { "x-extra": "1" } };
  await drive(plain);
  expect(requests[2]!.headers["x-extra"]).toBe("1");
  expect(requests[2]!.headers["authorization"]).toBe("Bearer k-0123456789");
});

test("structural pin: resolveStream uses providerStreaming; cmdRun keeps the runtime's wrapped provider chain", () => {
  const src = readFileSync(resolve(import.meta.dir, "..", "..", "src", "cli", "main.ts"), "utf8");
  const code = src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).map((l) => l.replace(/\/\/.*$/, ""));
  // MUTATION TARGET (a site reverted to openaiCompatStreaming({ baseUrl, apiKey }) — the headerless call): caught here
  expect(code.filter((l) => l.includes("openaiCompatStreaming"))).toEqual([]);
  expect(code.filter((l) => l.includes("providerStreaming(")).length).toBe(1);
  const cmdRun = src.slice(src.indexOf("async function cmdRun("), src.indexOf("async function cmdGauntlet("));
  expect(cmdRun).toContain("await bootRuntime(");
  expect(cmdRun).not.toContain("stream: sse");
  expect(cmdRun).not.toContain("providerStreaming(");
  // the helper itself is the one place the streaming adapter is given the config's headers (and the oauth wrap)
  const stream = readFileSync(resolve(import.meta.dir, "..", "..", "src", "providers", "stream.ts"), "utf8");
  expect(stream).toContain("export function providerStreaming(cfg: ProviderConfig, oauth: OAuthSeamDeps = {}): StreamFn");
  expect(stream).toContain("if (cfg.oauth) return oauthStream(cfg, openAiWire(cfg, openaiCompatStreaming, openaiResponsesStream), oauth);");
});
