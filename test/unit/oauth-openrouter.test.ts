/** Port #66 — OpenRouter PKCE against an in-process fake: the real `auth login` renderer prints the
 *  authorize URL (callback_url + S256 challenge), the test plays the browser by hitting the loopback
 *  callback with `?code=`, the flow exchanges code + verifier at the fake keys endpoint (the verifier
 *  really hashes to the advertised challenge) and stores the permanent key as kind oauth; a callback
 *  on a DIFFERENT state path is a state mismatch: 400, the login REJECTS, nothing is exchanged, the
 *  server is gone; a stray request (favicon) is a 404 that does not abort; `?error=` aborts; Ctrl-C
 *  cancels. The key is a canary grepped out of every output line. Loopback only. */

import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOAuthCredentials } from "../../src/providers/auth.ts";
import { formatAuthList, runAuthLogin } from "../../src/cli/auth-login.ts";
import type { OAuthNotice } from "../../src/providers/oauth/common.ts";
import { STATE_MISMATCH, openRouterOAuth, type OpenRouterEndpoints } from "../../src/providers/oauth/openrouter.ts";
import { base64url } from "../../src/providers/oauth/pkce.ts";

const OR_KEY = "sk-or-v1-CANARY-openrouter-permanent-key-0123456789abcdef";
let keyHits = 0;
let lastExchange: { code?: string; code_verifier?: string; code_challenge_method?: string } | null = null;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/api/v1/auth/keys" && req.method === "POST") {
      keyHits++;
      lastExchange = (await req.json()) as typeof lastExchange;
      return json({ key: OR_KEY });
    }
    return new Response("not found", { status: 404 });
  },
});
const base = `http://127.0.0.1:${server.port}`;
const endpoints: OpenRouterEndpoints = { authorizeUrl: `${base}/auth`, keysUrl: `${base}/api/v1/auth/keys`, chatBaseUrl: `${base}/api/v1` };
afterAll(() => server.stop(true));

const savedEnv = new Map<string, string | undefined>();
let home = "";
beforeEach(() => {
  for (const k of ["ROVECODE_HOME"]) { savedEnv.set(k, process.env[k]); delete process.env[k]; }
  home = mkdtempSync(join(tmpdir(), "rovecode-oauth-or-"));
  process.env.ROVECODE_HOME = home;
  keyHits = 0; lastExchange = null;
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
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
const deps = () => ({ fetch: (i: string | URL, init?: RequestInit) => fetch(i, init), now: () => Date.now(), sleep: async () => {} });

/** start a bare provider login and hand back the authorize URL notice once it is printed */
function startLogin(signal = new AbortController().signal) {
  const got = deferred<Extract<OAuthNotice, { type: "auth_url" }>>();
  const login = openRouterOAuth(endpoints).login({ notify: (n) => { if (n.type === "auth_url") got.resolve(n); }, signal }, deps());
  login.catch(() => {}); // observed by the test through withDeadline; never unhandled
  return { login, notice: withDeadline(got.promise) };
}
/** connection refused once the callback server is stopped */
async function expectClosed(url: string): Promise<void> {
  await expect(withDeadline(fetch(url))).rejects.toThrow();
}

test("auth login openrouter: prints the authorize URL (callback_url + S256 challenge), the browser callback with ?code= completes the key exchange with the matching verifier, the key is stored as kind oauth (never expires), the server closes; the key never reaches the output", async () => {
  const out: string[] = []; const err: string[] = [];
  const printed = deferred<string>();
  const login = runAuthLogin("openrouter", {
    out: (l) => { out.push(l); if (l.includes("/auth?")) printed.resolve(l); }, err: (l) => err.push(l),
    provider: (id) => (id === "openrouter" ? openRouterOAuth(endpoints) : undefined), oauth: deps(),
  });
  const authorize = new URL((await withDeadline(printed.promise)).trim().replace(/^open\s+/, ""));
  expect(authorize.origin + authorize.pathname).toBe(`${base}/auth`);
  expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
  const challenge = authorize.searchParams.get("code_challenge")!;
  const callbackUrl = authorize.searchParams.get("callback_url")!;
  expect(callbackUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback\/[A-Za-z0-9_-]{43}$/);
  expect(out.join("\n")).toContain(`waiting for the browser to return to ${callbackUrl}`);
  // the browser lands on the callback
  const res = await withDeadline(fetch(`${callbackUrl}?code=CODE-1`));
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("Signed in to OpenRouter");
  expect(await withDeadline(login)).toBe(0);
  expect(err).toEqual([]);
  expect(keyHits).toBe(1);
  expect(lastExchange).toEqual({ code: "CODE-1", code_verifier: lastExchange!.code_verifier, code_challenge_method: "S256" });
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(lastExchange!.code_verifier!)));
  expect(base64url(digest)).toBe(challenge); // PKCE: the verifier sent is the one behind the advertised challenge
  expect(loadOAuthCredentials()["openrouter"]).toEqual({ type: "oauth", access: OR_KEY, refresh: "", expires: Number.MAX_SAFE_INTEGER });
  const text = out.join("\n");
  expect(text).toContain("stored OAuth token for openrouter in");
  expect(text).toContain("(never expires)");
  expect(text).not.toContain(OR_KEY);
  expect(text).not.toContain(lastExchange!.code_verifier!);
  expect(formatAuthList()).toEqual([`openrouter     oauth  oauth token              sk-o…  never expires`]);
  await expectClosed(callbackUrl);
  // toAuth / refresh: a permanent key, refresh is the identity
  const p = openRouterOAuth(endpoints);
  const cred = loadOAuthCredentials()["openrouter"]!;
  expect(p.toAuth(cred)).toEqual({ apiKey: OR_KEY, baseUrl: `${base}/api/v1` });
  expect(await p.refresh(cred, undefined, deps())).toBe(cred);
});

test("negative: a callback on a different state path is a STATE MISMATCH — 400, the login rejects, no code is exchanged, the server is closed", async () => {
  const { login, notice } = startLogin();
  const { callbackUrl } = await notice;
  const forged = callbackUrl.replace(/\/callback\/[^/?]+$/, `/callback/${"x".repeat(43)}`) + "?code=CODE-FORGED";
  expect(forged).not.toBe(callbackUrl);
  const res = await withDeadline(fetch(forged));
  expect(res.status).toBe(400);
  expect(await res.text()).toContain("State mismatch");
  // MUTATION TARGET (skip the state check): the forged code would be exchanged and the login would resolve
  await expect(withDeadline(login)).rejects.toThrow(STATE_MISMATCH);
  expect(keyHits).toBe(0);
  await expectClosed(callbackUrl);
});

test("a stray request off /callback/ (favicon) is a 404 and does NOT abort — the real callback still completes afterwards", async () => {
  const { login, notice } = startLogin();
  const { callbackUrl } = await notice;
  const origin = new URL(callbackUrl).origin;
  expect((await withDeadline(fetch(`${origin}/favicon.ico`))).status).toBe(404);
  expect((await withDeadline(fetch(`${callbackUrl}?code=CODE-2`))).status).toBe(200);
  const cred = await withDeadline(login);
  expect(cred.access).toBe(OR_KEY);
  expect(lastExchange?.code).toBe("CODE-2");
});

test("?error= on the callback aborts with the provider's reason; a callback without a code is a 400 that keeps waiting; Ctrl-C cancels", async () => {
  const a = startLogin();
  const cbA = (await a.notice).callbackUrl;
  expect((await withDeadline(fetch(`${cbA}?error=access_denied&error_description=User+said+no`))).status).toBe(400);
  await expect(withDeadline(a.login)).rejects.toThrow("OpenRouter authorization denied: User said no");
  expect(keyHits).toBe(0);

  const ac = new AbortController();
  const b = startLogin(ac.signal);
  const cbB = (await b.notice).callbackUrl;
  expect((await withDeadline(fetch(cbB))).status).toBe(400); // no code → 400, still listening
  expect((await withDeadline(fetch(`${new URL(cbB).origin}/favicon.ico`))).status).toBe(404); // still up
  ac.abort();
  await expect(withDeadline(b.login)).rejects.toThrow("login cancelled");
  await expectClosed(cbB);
  expect(keyHits).toBe(0);
});

test("a failed key exchange (HTTP error / no key in the body) rejects with a token-free message and closes the server", async () => {
  const failing = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => json({ error: { message: "invalid code" } }, 400) });
  try {
    const p = openRouterOAuth({ ...endpoints, keysUrl: `http://127.0.0.1:${failing.port}/keys` });
    const got = deferred<string>();
    const login = p.login({ notify: (n) => { if (n.type === "auth_url") got.resolve(n.callbackUrl); }, signal: new AbortController().signal }, deps());
    login.catch(() => {});
    const cb = await withDeadline(got.promise);
    expect((await withDeadline(fetch(`${cb}?code=CODE-3`))).status).toBe(502);
    await expect(withDeadline(login)).rejects.toThrow("OpenRouter key exchange failed (HTTP 400)");
    await expectClosed(cb);
  } finally {
    failing.stop(true);
  }
});
