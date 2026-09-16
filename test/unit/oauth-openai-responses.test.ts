/** Port #75 — the stored ChatGPT token takes the Responses wire, and the `openai` login is no longer refused BECAUSE
 *  of it. The whole path in one file: `auth login openai` against a fake device-code server stores the token in a
 *  scratch home → resolveProvider() (the REAL registry — openai is back in it) resolves the stored token as the
 *  provider with wire:"responses", the codex base URL and the three headers → providerStreaming over that config
 *  POSTs /codex/responses with the bearer and account id while the fake counts ZERO /chat/completions hits (M12).
 *  Then the seam alone: an expired token is refreshed ONCE and the request carries the NEW bearer; a claim-less
 *  token sends no account id but both codex headers; providerStreaming(cfg) hits /codex/responses; a failed refresh
 *  is one error turn with the remedy and no request; no token / account id in any turn or event text. The
 *  factories' wire composition is pinned structurally. Loopback only; no real timers. */

import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runAuthLogin } from "../../src/cli/auth-login.ts";
import { loadOAuthCredentials } from "../../src/providers/auth.ts";
import type { OAuthCredential } from "../../src/providers/oauth/common.ts";
import { CODEX_RESPONSES_HEADERS, openAIOAuth, type OpenAIEndpoints } from "../../src/providers/oauth/openai.ts";
import { base64url } from "../../src/providers/oauth/pkce.ts";
import { OAUTH_PROVIDER_IDS, OAUTH_REFUSED } from "../../src/providers/oauth/registry.ts";
import { oauthStream, resolveOAuthProviderConfig, type OAuthSeamDeps } from "../../src/providers/oauth/seam.ts";
import { openaiCompatStream, providerStreaming, resolveProvider, type ProviderConfig } from "../../src/providers/stream.ts";
import { openaiResponsesStream } from "../../src/providers/responses.ts";
import { openAiWire } from "../../src/providers/wire-select.ts";
import type { Message, StreamEvent, StreamFn } from "../../src/core/types.ts";

const NOW = 1_800_000_000_000;
const jwt = (payload: Record<string, unknown>) => `${base64url(new TextEncoder().encode('{"alg":"none"}'))}.${base64url(new TextEncoder().encode(JSON.stringify(payload)))}.sig`;
const ACCESS_1 = jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-canary-42" }, marker: "ACCESS-CANARY-ONE" });
const ACCESS_2 = jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-canary-43" }, marker: "ACCESS-CANARY-TWO" });
const NO_CLAIM = jwt({ sub: "x", marker: "ACCESS-CANARY-BARE" });
const REFRESH_1 = "rt-CANARY-refresh-one";
const REFRESH_2 = "rt-CANARY-refresh-two";
const AUTH_CODE = "ac-CANARY-authorization-code";
const CODE_VERIFIER = "cv-CANARY-server-issued-verifier";
const DEVICE_AUTH_ID = "dauth-CANARY-7c1";
const CANARIES = [ACCESS_1, ACCESS_2, NO_CLAIM, REFRESH_1, REFRESH_2, AUTH_CODE, CODE_VERIFIER, DEVICE_AUTH_ID, "acct-canary", "CANARY"];

type Recorded = { path: string; headers: Record<string, string>; body: Record<string, unknown> };
let responsesRequests: Recorded[] = [];
let chatHits = 0;
let refreshes = 0;
let refreshStatus = 200;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const SSE = [
  { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1", role: "assistant" } },
  { type: "response.output_text.delta", output_index: 0, delta: "hello from codex" },
  { type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "hello from codex", annotations: [] }] } },
  { type: "response.completed", response: { id: "r1", status: "completed", usage: { input_tokens: 10, output_tokens: 4 } } },
].map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const path = new URL(req.url).pathname;
    // the device-code login (oauth-openai.test.ts drives its edge cases; here it is the front door of the whole path)
    if (path === "/api/accounts/deviceauth/usercode") return json({ device_auth_id: DEVICE_AUTH_ID, user_code: "WXYZ-9876", interval: "5" });
    if (path === "/api/accounts/deviceauth/token") return json({ authorization_code: AUTH_CODE, code_verifier: CODE_VERIFIER });
    if (path === "/oauth/token") {
      const form = new URLSearchParams(await req.text());
      if (form.get("grant_type") === "authorization_code") return json({ access_token: ACCESS_1, refresh_token: REFRESH_1, expires_in: 3600 });
      refreshes++;
      if (refreshStatus !== 200) return json({ error: "invalid_grant", error_description: "refresh token revoked" }, refreshStatus);
      if (form.get("grant_type") !== "refresh_token" || form.get("refresh_token") !== REFRESH_1) return json({ error: "invalid_grant" }, 401);
      return json({ access_token: ACCESS_2, refresh_token: REFRESH_2, expires_in: 3600 });
    }
    if (path.endsWith("/chat/completions")) { chatHits++; return new Response("wrong wire", { status: 404 }); }
    if (path === "/codex/responses" && req.method === "POST") {
      responsesRequests.push({ path, headers: Object.fromEntries([...req.headers.entries()]), body: (await req.json()) as Record<string, unknown> });
      return new Response(SSE, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    return new Response("not found", { status: 404 });
  },
});
const base = `http://127.0.0.1:${server.port}`;
const endpoints: OpenAIEndpoints = {
  deviceUserCodeUrl: `${base}/api/accounts/deviceauth/usercode`, deviceTokenUrl: `${base}/api/accounts/deviceauth/token`, tokenUrl: `${base}/oauth/token`,
  deviceVerificationUri: `${base}/codex/device`, deviceRedirectUri: `${base}/deviceauth/callback`, responsesBaseUrl: `${base}/codex`,
};
afterAll(() => server.stop(true));

let home = "";
let savedHome: string | undefined;
beforeEach(() => {
  responsesRequests = []; chatHits = 0; refreshes = 0; refreshStatus = 200;
  savedHome = process.env.ROVECODE_HOME;
  home = mkdtempSync(join(tmpdir(), "rovecode-oauth-resp-"));
  process.env.ROVECODE_HOME = home;
});
afterEach(() => {
  if (savedHome === undefined) delete process.env.ROVECODE_HOME; else process.env.ROVECODE_HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
});

/** an in-memory credential store (the seam's load/save deps) — nothing touches the real home */
function memStore(initial?: OAuthCredential) {
  const store: Record<string, OAuthCredential> = initial ? { openai: initial } : {};
  return { store, load: () => store, save: (id: string, c: OAuthCredential) => { store[id] = c; } };
}
const userMsg = (text: string): Message => ({ id: "m1", role: "user", parts: [{ kind: "text", text }], parentId: null, createdAt: NOW });
function withDeadline<T>(p: Promise<T>, ms = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`exceeded ${ms} ms`)), ms); });
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer)) as Promise<T>;
}
async function collect(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> { const out: StreamEvent[] = []; for await (const e of events) out.push(e); return out; }
const turnOf = (events: StreamEvent[]) => { const t = events.find((e) => e.type === "turn"); if (!t || t.type !== "turn") throw new Error("no turn"); return t.turn; };
const textOf = (events: StreamEvent[]) => events.filter((e): e is Extract<StreamEvent, { type: "text_delta" }> => e.type === "text_delta").map((e) => e.text);
function expectNoCanary(text: string): void { for (const c of CANARIES) expect(text).not.toContain(c); }
/** providerStream's oauth composition (stream.ts) with the seam deps injected — the production path minus the real registry */
const wired = (cfg: ProviderConfig, deps: OAuthSeamDeps): StreamFn => oauthStream(cfg, openAiWire(cfg, openaiCompatStream, openaiResponsesStream), deps);

test("THE WHOLE PATH — the flip is not a deletion: openai is in the registry and no longer refused; `auth login openai` (fake device flow) stores the token in the home; resolveProvider() — the real registry, no injection — resolves it as the provider with wire:responses, the codex base URL and the headers; providerStreaming over that config POSTs /codex/responses with the bearer + account id and hits /chat/completions ZERO times", async () => {
  expect([...OAUTH_PROVIDER_IDS]).toEqual(["github-copilot", "openrouter", "openai"]);
  expect(OAUTH_REFUSED["openai"]).toBeUndefined();
  expect(resolveProvider()).toBeNull(); // the scratch home is empty and the preload scrubbed every key
  const out: string[] = []; const err: string[] = [];
  const code = await withDeadline(runAuthLogin("openai", {
    out: (l) => out.push(l), err: (l) => err.push(l),
    provider: (id) => (id === "openai" ? openAIOAuth(endpoints) : undefined),
    oauth: { now: () => NOW, sleep: async () => {} },
  }));
  expect(err).toEqual([]);
  expect(code).toBe(0);
  expect(out.join("\n")).toContain("stored OAuth token for openai in");
  expectNoCanary(out.join("\n"));
  expect(loadOAuthCredentials()["openai"]).toEqual({ type: "oauth", access: ACCESS_1, refresh: REFRESH_1, expires: NOW + 3_600_000, accountId: "acct-canary-42" });
  // the real registry (production endpoints) resolves the stored token — this is what the refusal used to prevent
  const cfg = resolveProvider();
  expect(cfg).toMatchObject({ id: "openai", protocol: "openai", oauth: true, wire: "responses", apiKey: ACCESS_1, baseUrl: "https://chatgpt.com/backend-api/codex", headers: { "chatgpt-account-id": "acct-canary-42", "OpenAI-Beta": "responses=experimental", originator: "rovecode" } });
  // and the request over it goes out on the Responses wire (the fake endpoints stand in for chatgpt.com; the store is the real scratch home)
  const events = await withDeadline(collect(providerStreaming(cfg!, { providers: [openAIOAuth(endpoints)], now: () => NOW })({ provider: "openai", model: "gpt-5" }, [userMsg("hi")])));
  expect(turnOf(events).parts).toEqual([{ kind: "text", text: "hello from codex" }]);
  expect(textOf(events)).toEqual(["hello from codex"]);
  expect(responsesRequests).toHaveLength(1);
  expect(responsesRequests[0]!.headers.authorization).toBe(`Bearer ${ACCESS_1}`);
  expect(responsesRequests[0]!.headers["chatgpt-account-id"]).toBe("acct-canary-42");
  expect(responsesRequests[0]!.headers.originator).toBe("rovecode");
  expect(responsesRequests[0]!.body).toMatchObject({ model: "gpt-5", store: false, stream: true });
  expect("include" in responsesRequests[0]!.body).toBe(false);
  expect(chatHits).toBe(0);
  expect(refreshes).toBe(0);
  expectNoCanary(JSON.stringify(events));
});

test("resolveOAuthProviderConfig: the stored ChatGPT token becomes an openai config with oauth:true, wire:\"responses\", the codex base URL and the three headers", () => {
  const providers = [openAIOAuth(endpoints)];
  const cfg = resolveOAuthProviderConfig({ providers, load: () => ({ openai: { type: "oauth", access: ACCESS_1, refresh: REFRESH_1, expires: NOW + 1, accountId: "acct-canary-42" } }) });
  expect(cfg).toMatchObject({ id: "openai", baseUrl: `${base}/codex`, apiKey: ACCESS_1, protocol: "openai", oauth: true, wire: "responses", headers: { "chatgpt-account-id": "acct-canary-42", "OpenAI-Beta": "responses=experimental", originator: "rovecode" } });
  expect(CODEX_RESPONSES_HEADERS).toEqual({ "OpenAI-Beta": "responses=experimental", originator: "rovecode" });
});

test("seam: an expired token is refreshed ONCE, then the request goes to /codex/responses with the NEW bearer + account id + originator + OpenAI-Beta; /chat/completions is hit ZERO times (M12); the rotated refresh token is saved; the next call (a chat-catalog model!) refreshes nothing and stays on /codex/responses", async () => {
  const providers = [openAIOAuth(endpoints)];
  const mem = memStore({ type: "oauth", access: "expired-CANARY-access", refresh: REFRESH_1, expires: NOW - 1, accountId: "acct-canary-42" });
  const cfg = resolveOAuthProviderConfig({ providers, load: mem.load })!;
  const stream = wired(cfg, { providers, load: mem.load, save: mem.save, now: () => NOW });
  const events = await withDeadline(collect(stream({ provider: "openai", model: "gpt-5" }, [userMsg("hi")])));
  const turn = turnOf(events);
  expect(turn.stopReason).toBe("end_turn");
  expect(turn.parts).toEqual([{ kind: "text", text: "hello from codex" }]);
  expect(textOf(events)).toEqual(["hello from codex"]);
  expect(turn.usage).toEqual({ input: 10, output: 4 });
  // MUTATION TARGETS: skip the refresh → the expired token rides; route through openaiCompatStream (M12) → chatHits 1, responsesRequests 0
  expect(refreshes).toBe(1);
  expect(chatHits).toBe(0);
  expect(responsesRequests).toHaveLength(1);
  const h = responsesRequests[0]!.headers;
  expect(h.authorization).toBe(`Bearer ${ACCESS_2}`);
  expect(h["chatgpt-account-id"]).toBe("acct-canary-43");
  expect(h.originator).toBe("rovecode");
  expect(h["openai-beta"]).toBe("responses=experimental");
  expect(h.accept).toBe("text/event-stream");
  expect(responsesRequests[0]!.body).toMatchObject({ model: "gpt-5", store: false, stream: true });
  expect(mem.store.openai).toEqual({ type: "oauth", access: ACCESS_2, refresh: REFRESH_2, expires: NOW + 3_600_000, accountId: "acct-canary-43" });
  expectNoCanary(JSON.stringify(events));
  await withDeadline(collect(stream({ provider: "openai", model: "gpt-4o" }, [userMsg("again")]))); // cfg.wire pins the wire even for a model the catalog would send to chat
  expect(refreshes).toBe(1);
  expect(responsesRequests).toHaveLength(2);
  expect(responsesRequests[1]!.body.model).toBe("gpt-4o");
  expect(chatHits).toBe(0);
});

test("a token without the account claim sends no chatgpt-account-id but still both codex headers and the bearer", async () => {
  const providers = [openAIOAuth(endpoints)];
  const mem = memStore({ type: "oauth", access: NO_CLAIM, refresh: REFRESH_1, expires: NOW + 1 });
  const cfg = resolveOAuthProviderConfig({ providers, load: mem.load })!;
  expect(cfg.headers).toEqual({ "OpenAI-Beta": "responses=experimental", originator: "rovecode" });
  await withDeadline(collect(wired(cfg, { providers, load: mem.load, save: mem.save, now: () => NOW })({ provider: "openai", model: "gpt-5" }, [userMsg("hi")])));
  expect(refreshes).toBe(0);
  expect(responsesRequests).toHaveLength(1);
  const h = responsesRequests[0]!.headers;
  expect(h["chatgpt-account-id"]).toBeUndefined();
  expect(h.originator).toBe("rovecode");
  expect(h["openai-beta"]).toBe("responses=experimental");
  expect(h.authorization).toBe(`Bearer ${NO_CLAIM}`);
  expect(chatHits).toBe(0);
});

test("providerStreaming(cfg, seam) over the resolved config hits /codex/responses too (the streaming factory refreshes as well — here the token is fresh, so no refresh), never /chat/completions", async () => {
  const providers = [openAIOAuth(endpoints)];
  const seam: OAuthSeamDeps = { providers, load: () => ({ openai: { type: "oauth", access: ACCESS_1, refresh: REFRESH_1, expires: Number.MAX_SAFE_INTEGER, accountId: "acct-canary-42" } }), now: () => NOW };
  const cfg = resolveOAuthProviderConfig(seam)!;
  const events = await withDeadline(collect(providerStreaming(cfg, seam)({ provider: "openai", model: "gpt-4o" }, [userMsg("hi")])));
  expect(textOf(events)).toEqual(["hello from codex"]);
  expect(responsesRequests).toHaveLength(1);
  expect(responsesRequests[0]!.headers.authorization).toBe(`Bearer ${ACCESS_1}`);
  expect(responsesRequests[0]!.headers["chatgpt-account-id"]).toBe("acct-canary-42");
  expect(responsesRequests[0]!.headers.originator).toBe("rovecode");
  expect(chatHits).toBe(0);
  expect(refreshes).toBe(0);
});

test("a failed refresh is ONE attempt → error turn with the remedy, no request on either wire, no token or account id in the text", async () => {
  refreshStatus = 401;
  const providers = [openAIOAuth(endpoints)];
  const mem = memStore({ type: "oauth", access: "expired-CANARY-access", refresh: REFRESH_1, expires: NOW - 1, accountId: "acct-canary-42" });
  const cfg = resolveOAuthProviderConfig({ providers, load: mem.load })!;
  const events = await withDeadline(collect(wired(cfg, { providers, load: mem.load, save: mem.save, now: () => NOW })({ provider: "openai", model: "gpt-5" }, [userMsg("hi")])));
  const turn = turnOf(events);
  expect(turn.stopReason).toBe("error");
  expect(turn.error).toBe("openai: OAuth token expired and the refresh failed (OpenAI token refresh failed (HTTP 401): invalid_grant — refresh token revoked) — run `rovecode auth login openai`");
  expectNoCanary(JSON.stringify(events));
  expect(refreshes).toBe(1);
  expect(responsesRequests).toHaveLength(0);
  expect(chatHits).toBe(0);
  expect(mem.store.openai!.refresh).toBe(REFRESH_1);
});

test("structural pin (M12): both factories' oauth branches wrap openAiWire(cfg, <adapter>, openaiResponsesStream) — never the bare chat adapter — and the plain OpenAI-protocol branches dispatch through openAiWire too", () => {
  const src = readFileSync(resolve(import.meta.dir, "..", "..", "src", "providers", "stream.ts"), "utf8");
  expect(src).toContain("if (cfg.oauth) return oauthStream(cfg, openAiWire(cfg, openaiCompatStream, openaiResponsesStream), oauth);");
  expect(src).toContain("if (cfg.oauth) return oauthStream(cfg, openAiWire(cfg, openaiCompatStreaming, openaiResponsesStream), oauth);");
  expect(src).not.toContain("oauthStream(cfg, openaiCompatStream,");
  expect(src).not.toContain("oauthStream(cfg, openaiCompatStreaming,");
  expect(src).toContain("openAiWire(cfg, openaiCompatStream, openaiResponsesStream)(optsOf(cfg))");
  expect(src).toContain("openAiWire(cfg, openaiCompatStreaming, openaiResponsesStream)(optsOf(cfg))");
});
