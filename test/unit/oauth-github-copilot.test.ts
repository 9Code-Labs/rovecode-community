/** Port #66 — GitHub Copilot: the device-code login against an in-process fake GitHub (device code →
 *  authorization_pending → slow_down with a stated interval → token → Copilot token exchange) through
 *  the real `auth login` renderer, then the provider seam: an EXPIRED stored token is refreshed ONCE
 *  before the chat request (which carries the new token + the editor headers), the refreshed record is
 *  persisted, a second request refreshes nothing, and a failed refresh crosses as a clean error turn
 *  naming the remedy — never a token. The GitHub token, Copilot token and device code are canaries
 *  grepped out of every output line and error. Loopback only; the fake closes in afterAll. */

import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOAuthCredentials, saveOAuthCredential } from "../../src/providers/auth.ts";
import { formatAuthList, runAuthLogin } from "../../src/cli/auth-login.ts";
import { GITHUB_COPILOT_ENDPOINTS, baseUrlFromCopilotToken, githubCopilotOAuth, type GitHubCopilotEndpoints } from "../../src/providers/oauth/github-copilot.ts";
import { oauthStream, resolveOAuthProviderConfig } from "../../src/providers/oauth/seam.ts";
import { openaiCompatStream } from "../../src/providers/stream.ts";
import type { Message, StreamEvent } from "../../src/core/types.ts";

const GH_TOKEN = "gho_CANARY_github_oauth_token_0123456789abcdef";
const COPILOT_TOKEN = "tid=canary;exp=1;proxy-ep=proxy.test.githubcopilot.com;copilot-canary-token-XYZ-";
const EXPIRED_TOKEN = "expired-copilot-token-CANARY-old";
const DEVICE_CODE = "device-code-CANARY-8f1a2b3c";
const NOW = 1_800_000_000_000;

let tokenPolls = 0;
let copilotHits = 0;
let copilotStatus = 200;
let deviceBodies: URLSearchParams[] = [];
let pollBodies: URLSearchParams[] = [];
let chatRequests: { authorization: string; editorVersion: string; integration: string }[] = [];

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/login/device/code" && req.method === "POST") {
      deviceBodies.push(new URLSearchParams(await req.text()));
      return json({ device_code: DEVICE_CODE, user_code: "ABCD-1234", verification_uri: `${url.origin}/login/device`, interval: 5, expires_in: 900 });
    }
    if (url.pathname === "/login/oauth/access_token" && req.method === "POST") {
      pollBodies.push(new URLSearchParams(await req.text()));
      tokenPolls++;
      if (tokenPolls === 1) return json({ error: "authorization_pending", error_description: "The authorization request is still pending." });
      if (tokenPolls === 2) return json({ error: "slow_down", interval: 10 });
      return json({ access_token: GH_TOKEN, token_type: "bearer", scope: "read:user" });
    }
    if (url.pathname === "/copilot_internal/v2/token") {
      copilotHits++;
      if (req.headers.get("authorization") !== `Bearer ${GH_TOKEN}`) return json({ error: "bad_github_token" }, 401);
      if (copilotStatus !== 200) return json({ error: "copilot_unavailable" }, copilotStatus);
      return json({ token: COPILOT_TOKEN + copilotHits, expires_at: Math.floor(NOW / 1000) + 1800 });
    }
    if (url.pathname === "/chat/completions" && req.method === "POST") {
      chatRequests.push({ authorization: req.headers.get("authorization") ?? "", editorVersion: req.headers.get("editor-version") ?? "", integration: req.headers.get("copilot-integration-id") ?? "" });
      return json({ choices: [{ message: { content: "hello from copilot" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 2 } });
    }
    return new Response("not found", { status: 404 });
  },
});
const base = `http://127.0.0.1:${server.port}`;
const endpoints: GitHubCopilotEndpoints = {
  deviceCodeUrl: `${base}/login/device/code`, accessTokenUrl: `${base}/login/oauth/access_token`, copilotTokenUrl: `${base}/copilot_internal/v2/token`, chatBaseUrl: base,
};

afterAll(() => server.stop(true));

const savedEnv = new Map<string, string | undefined>();
let home = "";
beforeEach(() => {
  for (const k of ["ROVECODE_HOME"]) { savedEnv.set(k, process.env[k]); delete process.env[k]; }
  home = mkdtempSync(join(tmpdir(), "rovecode-oauth-gh-"));
  process.env.ROVECODE_HOME = home;
  tokenPolls = 0; copilotHits = 0; copilotStatus = 200; deviceBodies = []; pollBodies = []; chatRequests = [];
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
const CANARIES = [GH_TOKEN, "copilot-canary-token", DEVICE_CODE, EXPIRED_TOKEN];
function expectNoCanary(text: string): void {
  for (const c of CANARIES) expect(text).not.toContain(c);
}

test("auth login github-copilot: prints the code + URL, polls pending → slow_down(10) → token with the documented waits, exchanges the Copilot token, stores kind oauth with expiry + the GitHub token as refresh; no token reaches the output", async () => {
  const out: string[] = []; const err: string[] = []; const sleeps: number[] = [];
  const code = await withDeadline(runAuthLogin("github-copilot", {
    out: (l) => out.push(l), err: (l) => err.push(l),
    provider: (id) => (id === "github-copilot" ? githubCopilotOAuth(endpoints) : undefined),
    oauth: { now: () => NOW, sleep: async (ms) => { sleeps.push(ms); } },
  }));
  expect(err).toEqual([]);
  expect(code).toBe(0);
  const text = out.join("\n");
  expect(text).toContain(`open   ${base}/login/device`);
  expect(text).toContain("enter  ABCD-1234");
  expect(text).toContain("polling every 5s, up to 15 min");
  expect(text).toContain(`stored OAuth token for github-copilot in ${join(home, "credentials.json")}`);
  expect(text).toContain("expires 2027-"); // NOW + 1800 s − 5 min skew, ISO
  expectNoCanary(text);
  // RFC 8628 waits: one interval before the first poll, the interval after pending, the SERVER's 10 s after slow_down
  expect(sleeps).toEqual([5000, 5000, 10000]);
  expect(tokenPolls).toBe(3);
  expect(deviceBodies[0]!.get("scope")).toBe("read:user");
  expect(pollBodies[0]!.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");
  expect(pollBodies[0]!.get("device_code")).toBe(DEVICE_CODE);
  expect(copilotHits).toBe(1);
  const stored = loadOAuthCredentials()["github-copilot"];
  expect(stored).toEqual({ type: "oauth", access: COPILOT_TOKEN + "1", refresh: GH_TOKEN, expires: (Math.floor(NOW / 1000) + 1800) * 1000 - 5 * 60_000 });
  // `auth list` shows kind + expiry and never the tokens
  const rows = formatAuthList(undefined, NOW);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatch(/^github-copilot oauth {2}oauth token {14}tid=… {2}expires 2027-/);
  expectNoCanary(rows.join("\n"));
});

test("toAuth: the chat base URL comes from the token's proxy-ep (proxy.X → https://api.X), the editor headers ride along; the fixed override wins", () => {
  expect(baseUrlFromCopilotToken(COPILOT_TOKEN)).toBe("https://api.test.githubcopilot.com");
  expect(baseUrlFromCopilotToken("no-proxy-ep-here")).toBeNull();
  const cred = { type: "oauth" as const, access: COPILOT_TOKEN, refresh: GH_TOKEN, expires: NOW + 60_000 };
  const derived = githubCopilotOAuth(GITHUB_COPILOT_ENDPOINTS).toAuth(cred);
  expect(derived.baseUrl).toBe("https://api.test.githubcopilot.com");
  expect(derived.apiKey).toBe(COPILOT_TOKEN);
  expect(derived.headers?.["Editor-Version"]).toBe("vscode/1.107.0");
  expect(githubCopilotOAuth(GITHUB_COPILOT_ENDPOINTS).toAuth({ ...cred, access: "opaque" }).baseUrl).toBe("https://api.individual.githubcopilot.com");
  expect(githubCopilotOAuth(endpoints).toAuth(cred).baseUrl).toBe(base);
});

test("seam: an expired stored token is refreshed ONCE before the request — the chat call carries the new token + editor headers, the store is updated, the next request refreshes nothing", async () => {
  saveOAuthCredential("github-copilot", { type: "oauth", access: EXPIRED_TOKEN, refresh: GH_TOKEN, expires: NOW - 1 });
  const providers = [githubCopilotOAuth(endpoints)];
  const cfg = resolveOAuthProviderConfig({ providers });
  expect(cfg).toMatchObject({ id: "github-copilot", oauth: true, protocol: "openai", baseUrl: base, apiKey: EXPIRED_TOKEN, defaultModel: "gpt-4o" });
  expect(cfg!.headers?.["Copilot-Integration-Id"]).toBe("vscode-chat");
  const stream = oauthStream(cfg!, openaiCompatStream, { providers, now: () => NOW });
  const turn = await withDeadline(lastTurn(stream({ provider: "github-copilot", model: "gpt-4o" }, [userMsg("hi")])));
  expect(turn.stopReason).toBe("end_turn");
  expect(turn.parts).toEqual([{ kind: "text", text: "hello from copilot" }]);
  // MUTATION TARGET (skip refresh): the request would carry the expired token and the store would keep it
  expect(copilotHits).toBe(1);
  expect(chatRequests).toEqual([{ authorization: `Bearer ${COPILOT_TOKEN}1`, editorVersion: "vscode/1.107.0", integration: "vscode-chat" }]);
  expect(loadOAuthCredentials()["github-copilot"]).toEqual({ type: "oauth", access: COPILOT_TOKEN + "1", refresh: GH_TOKEN, expires: (Math.floor(NOW / 1000) + 1800) * 1000 - 5 * 60_000 });
  // second request: the stored token is now fresh → no second exchange
  await withDeadline(lastTurn(stream({ provider: "github-copilot", model: "gpt-4o" }, [userMsg("again")])));
  expect(copilotHits).toBe(1);
  expect(chatRequests).toHaveLength(2);
  expect(chatRequests[1]!.authorization).toBe(`Bearer ${COPILOT_TOKEN}1`);
});

test("seam: a fresh stored token is sent as-is (no exchange); a failed refresh is ONE attempt that crosses as an error turn naming the remedy — no request is sent and no token is echoed", async () => {
  saveOAuthCredential("github-copilot", { type: "oauth", access: COPILOT_TOKEN + "fresh", refresh: GH_TOKEN, expires: NOW + 60_000 });
  const providers = [githubCopilotOAuth(endpoints)];
  const stream = oauthStream(resolveOAuthProviderConfig({ providers })!, openaiCompatStream, { providers, now: () => NOW });
  await withDeadline(lastTurn(stream({ provider: "github-copilot", model: "gpt-4o" }, [userMsg("hi")])));
  expect(copilotHits).toBe(0);
  expect(chatRequests[0]!.authorization).toBe(`Bearer ${COPILOT_TOKEN}fresh`);

  saveOAuthCredential("github-copilot", { type: "oauth", access: EXPIRED_TOKEN, refresh: GH_TOKEN, expires: NOW - 1 });
  copilotStatus = 503;
  const turn = await withDeadline(lastTurn(stream({ provider: "github-copilot", model: "gpt-4o" }, [userMsg("hi")])));
  expect(turn.stopReason).toBe("error");
  expect(turn.error).toBe("github-copilot: OAuth token expired and the refresh failed (Copilot token exchange failed (HTTP 503): copilot_unavailable) — run `rovecode auth login github-copilot`");
  expectNoCanary(turn.error ?? "");
  expect(copilotHits).toBe(1); // exactly one attempt
  expect(chatRequests).toHaveLength(1); // the failed refresh sent no chat request
  expect(loadOAuthCredentials()["github-copilot"]!.access).toBe(EXPIRED_TOKEN); // nothing overwritten
});

test("login error paths are token-free: a malformed device-code response, an HTTP failure and a denied poll each abort with a clean message", async () => {
  const bad = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(req) {
      const p = new URL(req.url).pathname;
      if (p === "/missing") return json({ user_code: "X" });
      if (p === "/http") return json({ error: "server_error", error_description: "temporarily unavailable" }, 500);
      if (p === "/denied/code") return json({ device_code: DEVICE_CODE, user_code: "ABCD", verification_uri: "https://example.test/d", interval: 1, expires_in: 60 });
      if (p === "/denied/token") return json({ error: "access_denied", error_description: "The user denied the request." });
      return new Response("nf", { status: 404 });
    },
  });
  try {
    const b = `http://127.0.0.1:${bad.port}`;
    const deps = { fetch: (i: string | URL, init?: RequestInit) => fetch(i, init), now: () => NOW, sleep: async () => {} };
    const io = () => ({ notify: () => {}, signal: new AbortController().signal });
    await expect(withDeadline(githubCopilotOAuth({ ...endpoints, deviceCodeUrl: `${b}/missing` }).login(io(), deps))).rejects.toThrow("GitHub device code response is missing fields");
    await expect(withDeadline(githubCopilotOAuth({ ...endpoints, deviceCodeUrl: `${b}/http` }).login(io(), deps))).rejects.toThrow("GitHub device code request failed (HTTP 500): server_error — temporarily unavailable");
    await expect(withDeadline(githubCopilotOAuth({ ...endpoints, deviceCodeUrl: `${b}/denied/code`, accessTokenUrl: `${b}/denied/token` }).login(io(), deps))).rejects.toThrow("GitHub device flow failed: access_denied — The user denied the request.");
  } finally {
    bad.stop(true);
  }
});
