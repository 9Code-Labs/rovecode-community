/** Port #66 — OpenAI (ChatGPT) device code against an in-process fake auth server: usercode (a
 *  numeric-string interval) → poll 403 (pending) → slow_down → authorization_code + server-issued
 *  code_verifier → token exchange (PKCE fields + the device redirect_uri) → access/refresh/expiry with
 *  the account id read from the JWT; then the seam: an expired token is refreshed once via the
 *  refresh_token grant, the chat request carries the new token + `chatgpt-account-id`, a failed
 *  refresh is one clean error turn. Tokens, codes and the refresh token are canaries grepped out of
 *  every output line. Loopback only. */

import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOAuthCredentials, saveOAuthCredential } from "../../src/providers/auth.ts";
import { formatAuthList, runAuthLogin } from "../../src/cli/auth-login.ts";
import { accountIdFromJwt, openAIOAuth, type OpenAIEndpoints } from "../../src/providers/oauth/openai.ts";
import { oauthStream, resolveOAuthProviderConfig } from "../../src/providers/oauth/seam.ts";
import { base64url } from "../../src/providers/oauth/pkce.ts";
import { openaiCompatStream } from "../../src/providers/stream.ts";
import type { Message, StreamEvent } from "../../src/core/types.ts";

const NOW = 1_800_000_000_000;
const jwt = (payload: Record<string, unknown>) => `${base64url(new TextEncoder().encode('{"alg":"none"}'))}.${base64url(new TextEncoder().encode(JSON.stringify(payload)))}.sig`;
const ACCESS_1 = jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-canary-42" }, n: 1, marker: "ACCESS-CANARY-ONE" });
const ACCESS_2 = jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-canary-43" }, n: 2, marker: "ACCESS-CANARY-TWO" });
const REFRESH_1 = "rt-CANARY-refresh-one-0123456789";
const REFRESH_2 = "rt-CANARY-refresh-two-0123456789";
const AUTH_CODE = "ac-CANARY-authorization-code";
const CODE_VERIFIER = "cv-CANARY-server-issued-verifier";
const DEVICE_AUTH_ID = "dauth-CANARY-7c1";

let polls = 0;
let refreshes = 0;
let refreshStatus = 200;
let exchangeBodies: URLSearchParams[] = [];
let chatRequests: { authorization: string; accountId: string }[] = [];

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/api/accounts/deviceauth/usercode") {
      const body = (await req.json()) as { client_id?: string };
      if (body.client_id !== "app_EMoamEEZ73f0CkXaXp7hrann") return json({ error: "invalid_client" }, 400);
      return json({ device_auth_id: DEVICE_AUTH_ID, user_code: "WXYZ-9876", interval: "5" });
    }
    if (url.pathname === "/api/accounts/deviceauth/token") {
      const body = (await req.json()) as { device_auth_id?: string; user_code?: string };
      if (body.device_auth_id !== DEVICE_AUTH_ID || body.user_code !== "WXYZ-9876") return json({ error: "invalid_request" }, 400);
      polls++;
      if (polls === 1) return new Response("", { status: 403 });
      if (polls === 2) return json({ error: { code: "slow_down" } }, 400);
      return json({ authorization_code: AUTH_CODE, code_verifier: CODE_VERIFIER });
    }
    if (url.pathname === "/oauth/token") {
      const form = new URLSearchParams(await req.text());
      if (form.get("grant_type") === "authorization_code") {
        exchangeBodies.push(form);
        return json({ access_token: ACCESS_1, refresh_token: REFRESH_1, expires_in: 3600 });
      }
      if (form.get("grant_type") === "refresh_token") {
        refreshes++;
        if (refreshStatus !== 200) return json({ error: "invalid_grant", error_description: "refresh token revoked" }, refreshStatus);
        if (form.get("refresh_token") !== REFRESH_1) return json({ error: "invalid_grant" }, 401);
        return json({ access_token: ACCESS_2, refresh_token: REFRESH_2, expires_in: 3600 });
      }
      return json({ error: "unsupported_grant_type" }, 400);
    }
    if (url.pathname.endsWith("/chat/completions")) { // the two seam tests below inject openaiCompatStream explicitly (#75: the base is now …/codex)
      chatRequests.push({ authorization: req.headers.get("authorization") ?? "", accountId: req.headers.get("chatgpt-account-id") ?? "" });
      return json({ choices: [{ message: { content: "hello from openai" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 2 } });
    }
    if (url.pathname === "/codex/responses") { // #75: the wire the stored token takes in production (driven in oauth-openai-responses.test.ts)
      const ev = (e: Record<string, unknown>) => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`;
      return new Response(ev({ type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "hello from codex", annotations: [] }] } }) + ev({ type: "response.completed", response: { id: "r1", status: "completed", usage: { input_tokens: 1, output_tokens: 2 } } }), { status: 200, headers: { "content-type": "text/event-stream" } });
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

const savedEnv = new Map<string, string | undefined>();
let home = "";
beforeEach(() => {
  for (const k of ["ROVECODE_HOME"]) { savedEnv.set(k, process.env[k]); delete process.env[k]; }
  home = mkdtempSync(join(tmpdir(), "rovecode-oauth-oai-"));
  process.env.ROVECODE_HOME = home;
  polls = 0; refreshes = 0; refreshStatus = 200; exchangeBodies = []; chatRequests = [];
});
afterEach(() => {
  for (const [k, v] of savedEnv) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(home, { recursive: true, force: true });
});

function withDeadline<T>(p: Promise<T>, ms = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`exceeded ${ms} ms`)), ms); });
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer)) as Promise<T>;
}
function userMsg(text: string): Message {
  return { id: "m1", role: "user", parts: [{ kind: "text", text }], parentId: null, createdAt: NOW };
}
async function lastTurn(events: AsyncIterable<StreamEvent>) {
  let turn: Extract<StreamEvent, { type: "turn" }>["turn"] | undefined;
  for await (const ev of events) if (ev.type === "turn") turn = ev.turn;
  if (!turn) throw new Error("no turn");
  return turn;
}
const CANARIES = [ACCESS_1, ACCESS_2, REFRESH_1, REFRESH_2, AUTH_CODE, CODE_VERIFIER, DEVICE_AUTH_ID, "CANARY"];
function expectNoCanary(text: string): void {
  for (const c of CANARIES) expect(text).not.toContain(c);
}

test("auth login openai: prints the code + verification URL, polls 403 → slow_down → grant with the documented waits, exchanges with PKCE + the device redirect_uri, stores kind oauth with expiry, refresh token and the JWT account id; nothing secret reaches the output", async () => {
  const out: string[] = []; const err: string[] = []; const sleeps: number[] = [];
  const code = await withDeadline(runAuthLogin("openai", {
    out: (l) => out.push(l), err: (l) => err.push(l),
    provider: (id) => (id === "openai" ? openAIOAuth(endpoints) : undefined),
    oauth: { now: () => NOW, sleep: async (ms) => { sleeps.push(ms); } },
  }));
  expect(err).toEqual([]);
  expect(code).toBe(0);
  const text = out.join("\n");
  expect(text).toContain(`open   ${base}/codex/device`);
  expect(text).toContain("enter  WXYZ-9876");
  expect(text).toContain("polling every 5s, up to 15 min");
  expect(text).toContain("stored OAuth token for openai in");
  expect(text).toContain("expires 2027-");
  expectNoCanary(text);
  expect(sleeps).toEqual([5000, 10000]); // no wait before the first poll (pi); +5 s after slow_down
  expect(polls).toBe(3);
  const ex = exchangeBodies[0]!;
  expect(ex.get("code")).toBe(AUTH_CODE);
  expect(ex.get("code_verifier")).toBe(CODE_VERIFIER);
  expect(ex.get("redirect_uri")).toBe(`${base}/deviceauth/callback`);
  expect(ex.get("client_id")).toBe("app_EMoamEEZ73f0CkXaXp7hrann");
  expect(loadOAuthCredentials()["openai"]).toEqual({ type: "oauth", access: ACCESS_1, refresh: REFRESH_1, expires: NOW + 3_600_000, accountId: "acct-canary-42" });
  const rows = formatAuthList(undefined, NOW);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatch(/^openai {9}oauth {2}oauth token {14}eyJh… {2}expires 2027-/);
  expectNoCanary(rows.join("\n").replace("eyJh…", ""));
});

test("accountIdFromJwt / toAuth: the claim becomes the chatgpt-account-id header; a non-JWT or claim-less token has no account header (#75: the codex base URL, wire:responses and the two codex headers ride on every token)", () => {
  expect(accountIdFromJwt(ACCESS_1)).toBe("acct-canary-42");
  expect(accountIdFromJwt("opaque-token")).toBeUndefined();
  expect(accountIdFromJwt(jwt({ sub: "x" }))).toBeUndefined();
  const p = openAIOAuth(endpoints);
  expect(p.toAuth({ type: "oauth", access: ACCESS_1, refresh: REFRESH_1, expires: NOW, accountId: "acct-canary-42" })).toEqual({ apiKey: ACCESS_1, baseUrl: `${base}/codex`, wire: "responses", headers: { "chatgpt-account-id": "acct-canary-42", "OpenAI-Beta": "responses=experimental", originator: "rovecode" } });
  expect(p.toAuth({ type: "oauth", access: "opaque", refresh: "", expires: NOW })).toEqual({ apiKey: "opaque", baseUrl: `${base}/codex`, wire: "responses", headers: { "OpenAI-Beta": "responses=experimental", originator: "rovecode" } });
});

test("seam: an expired token is refreshed ONCE (refresh_token grant) — the chat request carries the new token + account id, the store holds the rotated refresh token, the next request refreshes nothing", async () => {
  saveOAuthCredential("openai", { type: "oauth", access: "expired-CANARY-access", refresh: REFRESH_1, expires: NOW - 1, accountId: "acct-canary-42" });
  const providers = [openAIOAuth(endpoints)];
  const cfg = resolveOAuthProviderConfig({ providers });
  expect(cfg).toMatchObject({ id: "openai", oauth: true, wire: "responses", baseUrl: `${base}/codex`, headers: { "chatgpt-account-id": "acct-canary-42", "OpenAI-Beta": "responses=experimental", originator: "rovecode" } }); // #75
  const stream = oauthStream(cfg!, openaiCompatStream, { providers, now: () => NOW });
  const turn = await withDeadline(lastTurn(stream({ provider: "openai", model: "gpt-5" }, [userMsg("hi")])));
  expect(turn.stopReason).toBe("end_turn");
  // MUTATION TARGET (skip refresh): the request would carry the expired token
  expect(refreshes).toBe(1);
  expect(chatRequests).toEqual([{ authorization: `Bearer ${ACCESS_2}`, accountId: "acct-canary-43" }]);
  expect(loadOAuthCredentials()["openai"]).toEqual({ type: "oauth", access: ACCESS_2, refresh: REFRESH_2, expires: NOW + 3_600_000, accountId: "acct-canary-43" });
  await withDeadline(lastTurn(stream({ provider: "openai", model: "gpt-5" }, [userMsg("again")])));
  expect(refreshes).toBe(1);
  expect(chatRequests).toHaveLength(2);
});

test("seam: a failed refresh is one attempt → error turn with the remedy, no chat request, no token in the text; a missing credential is the same shape", async () => {
  saveOAuthCredential("openai", { type: "oauth", access: "expired-CANARY-access", refresh: REFRESH_1, expires: NOW - 1 });
  refreshStatus = 401;
  const providers = [openAIOAuth(endpoints)];
  const stream = oauthStream(resolveOAuthProviderConfig({ providers })!, openaiCompatStream, { providers, now: () => NOW });
  const turn = await withDeadline(lastTurn(stream({ provider: "openai", model: "gpt-5" }, [userMsg("hi")])));
  expect(turn.stopReason).toBe("error");
  expect(turn.error).toBe("openai: OAuth token expired and the refresh failed (OpenAI token refresh failed (HTTP 401): invalid_grant — refresh token revoked) — run `rovecode auth login openai`");
  expectNoCanary(turn.error ?? "");
  expect(refreshes).toBe(1);
  expect(chatRequests).toHaveLength(0);
  expect(loadOAuthCredentials()["openai"]!.refresh).toBe(REFRESH_1);

  rmSync(join(home, "credentials.json"));
  const gone = await withDeadline(lastTurn(oauthStream({ id: "openai", baseUrl: `${base}/codex`, apiKey: "x", protocol: "openai", oauth: true, wire: "responses" }, openaiCompatStream, { providers, now: () => NOW })({ provider: "openai", model: "gpt-5" }, [userMsg("hi")])));
  expect(gone.stopReason).toBe("error");
  expect(gone.error).toBe("openai: no stored OAuth credential — run `rovecode auth login openai`");
});

test("login error paths: a 404 on the usercode endpoint says device login is not enabled; a failed poll and a bad exchange abort with token-free messages", async () => {
  const bad = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(req) {
      const p = new URL(req.url).pathname;
      if (p === "/nf") return new Response("", { status: 404 });
      if (p === "/usercode") return json({ device_auth_id: DEVICE_AUTH_ID, user_code: "WXYZ", interval: 0 });
      if (p === "/poll-fail") return json({ error: "access_denied" }, 400);
      if (p === "/poll-ok") return json({ authorization_code: AUTH_CODE, code_verifier: CODE_VERIFIER });
      if (p === "/exchange-fail") return json({ error: "invalid_grant", error_description: "authorization code expired" }, 400);
      return new Response("nf", { status: 404 });
    },
  });
  try {
    const b = `http://127.0.0.1:${bad.port}`;
    const deps = { fetch: (i: string | URL, init?: RequestInit) => fetch(i, init), now: () => NOW, sleep: async () => {} };
    const io = () => ({ notify: () => {}, signal: new AbortController().signal });
    await expect(withDeadline(openAIOAuth({ ...endpoints, deviceUserCodeUrl: `${b}/nf` }).login(io(), deps))).rejects.toThrow("OpenAI device code login is not enabled for this server (HTTP 404)");
    await expect(withDeadline(openAIOAuth({ ...endpoints, deviceUserCodeUrl: `${b}/usercode`, deviceTokenUrl: `${b}/poll-fail` }).login(io(), deps))).rejects.toThrow("OpenAI device authorization failed (HTTP 400): access_denied");
    const e = await withDeadline(openAIOAuth({ ...endpoints, deviceUserCodeUrl: `${b}/usercode`, deviceTokenUrl: `${b}/poll-ok`, tokenUrl: `${b}/exchange-fail` }).login(io(), deps).then(() => null, (x: Error) => x));
    expect(e?.message).toBe("OpenAI token exchange failed (HTTP 400): invalid_grant — authorization code expired");
  } finally {
    bad.stop(true);
  }
});
