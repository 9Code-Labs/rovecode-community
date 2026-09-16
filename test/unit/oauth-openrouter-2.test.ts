/** Port #66 fix wave — OpenRouter loopback-callback hardening against an in-process fake keys endpoint
 *  (loopback only, no network, no real login): a non-GET request or one whose Host is not 127.0.0.1 is a
 *  404 that keeps the login waiting and never exchanges; a genuine callback landing in the response-flush
 *  window right after a forged state-mismatch (or a denial) is a 409 — no key is minted and discarded; the
 *  printed callback URL comes from the BOUND server (pinned to 127.0.0.1, so a 0.0.0.0 bind fails here);
 *  two `?code=` callbacks racing: the first is exchanged (200), the second is a 409 while the exchange is
 *  in flight, ONE keys POST, the login resolves with the first key. The fake keys endpoint can be gated so
 *  the race is deterministic. The existing oauth-openrouter.test.ts is left untouched (splitter in flight). */

import { afterAll, afterEach, expect, test } from "bun:test";
import type { OAuthNotice } from "../../src/providers/oauth/common.ts";
import { CALLBACK_HOST, STATE_MISMATCH, openRouterOAuth, type OpenRouterEndpoints } from "../../src/providers/oauth/openrouter.ts";

const KEY_PREFIX = "sk-or-v1-CANARY-";
let keyHits = 0;
let codes: string[] = [];
/** when set, the fake keys endpoint holds its answer until this settles (bounded by the test's deadline) */
let gate: Promise<void> | null = null;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/api/v1/auth/keys" && req.method === "POST") {
      keyHits++;
      const body = (await req.json()) as { code?: string };
      codes.push(body.code ?? "");
      if (gate) await gate;
      return json({ key: `${KEY_PREFIX}${body.code}` });
    }
    return new Response("not found", { status: 404 });
  },
});
const base = `http://127.0.0.1:${server.port}`;
const endpoints: OpenRouterEndpoints = { authorizeUrl: `${base}/auth`, keysUrl: `${base}/api/v1/auth/keys`, chatBaseUrl: `${base}/api/v1` };
afterAll(() => server.stop(true));
afterEach(() => { keyHits = 0; codes = []; gate = null; });

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
async function waitFor(cond: () => boolean, ms = 10_000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error(`waitFor: condition not met within ${ms} ms`);
    await new Promise((r) => setTimeout(r, 5));
  }
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
/** status of a request that may find the server already gone (the login settled ~20 ms after the outcome) */
const statusOrClosed = (p: Promise<Response>): Promise<number | "closed"> => withDeadline(p).then((r) => r.status, () => "closed" as const);

test("the printed callback URL is built from the BOUND server (127.0.0.1 pinned); a POST/PUT or a foreign-Host GET on the exact callback path is a 404 that keeps waiting and never exchanges; the genuine GET then completes", async () => {
  const { login, notice } = startLogin();
  const n = await notice;
  // MUTATION TARGET (bind 0.0.0.0): server.hostname prints as 0.0.0.0 and this pin fails
  expect(n.callbackUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback\/[A-Za-z0-9_-]{43}$/);
  expect(new URL(n.callbackUrl).hostname).toBe(CALLBACK_HOST);
  expect(new URL(n.url).searchParams.get("callback_url")).toBe(n.callbackUrl);
  const cb = n.callbackUrl;
  const port = new URL(cb).port;
  // MUTATION TARGET (no method check — pi returns 404 for request.method !== "GET"): a POSTed code would be exchanged
  const post = await withDeadline(fetch(`${cb}?code=CODE-POSTED`, { method: "POST" }));
  expect(post.status).toBe(404);
  expect(await post.text()).toContain("Not an OAuth callback");
  expect((await withDeadline(fetch(`${cb}?code=CODE-PUT`, { method: "PUT" }))).status).toBe(404);
  // MUTATION TARGET (no Host check): a DNS-rebinding page's request (Host: evil.example) on the right path would be exchanged
  const foreign = await withDeadline(fetch(`${cb}?code=CODE-EVIL`, { headers: { Host: "evil.example" } }));
  expect(foreign.status).toBe(404);
  expect(await foreign.text()).toContain("Not an OAuth callback");
  expect((await withDeadline(fetch(`${cb}?code=CODE-LOCALHOST`, { headers: { Host: `localhost:${port}` } }))).status).toBe(404);
  expect(keyHits).toBe(0);
  // none of that aborted the login: the server is still up and the genuine redirect completes
  expect((await withDeadline(fetch(`${new URL(cb).origin}/favicon.ico`))).status).toBe(404);
  const ok = await withDeadline(fetch(`${cb}?code=CODE-OK`));
  expect(ok.status).toBe(200);
  const cred = await withDeadline(login);
  expect(cred).toEqual({ type: "oauth", access: `${KEY_PREFIX}CODE-OK`, refresh: "", expires: Number.MAX_SAFE_INTEGER });
  expect(codes).toEqual(["CODE-OK"]);
  await expectClosed(cb);
});

test("a genuine callback landing right after a forged state-mismatch callback (inside the response-flush window) is a 409 and is NOT exchanged — no key is minted and discarded; the login rejects with the mismatch", async () => {
  const { login, notice } = startLogin();
  const { callbackUrl } = await notice;
  const forged = callbackUrl.replace(/\/callback\/[^/?]+$/, `/callback/${"x".repeat(43)}`) + "?code=CODE-FORGED";
  expect((await withDeadline(fetch(forged))).status).toBe(400);
  // the outcome is decided but `settled` waits ~20 ms so the browser gets its page — the genuine redirect lands inside that window
  // MUTATION TARGET (no synchronous `closing` flag): the genuine code is exchanged here (keyHits 1) and the key discarded
  const late = await statusOrClosed(fetch(`${callbackUrl}?code=CODE-GENUINE`));
  expect([409, "closed"]).toContain(late);
  await expect(withDeadline(login)).rejects.toThrow(STATE_MISMATCH);
  expect(keyHits).toBe(0);
  expect(codes).toEqual([]);
  await expectClosed(callbackUrl);
});

test("same window after a denial: `?error=` then `?code=` — the code is a 409 (or the server is already gone), nothing is exchanged, the login rejects with the denial", async () => {
  const { login, notice } = startLogin();
  const { callbackUrl } = await notice;
  expect((await withDeadline(fetch(`${callbackUrl}?error=access_denied&error_description=User+said+no`))).status).toBe(400);
  const late = await statusOrClosed(fetch(`${callbackUrl}?code=CODE-AFTER-DENIAL`));
  expect([409, "closed"]).toContain(late);
  await expect(withDeadline(login)).rejects.toThrow("OpenRouter authorization denied: User said no");
  expect(keyHits).toBe(0);
  await expectClosed(callbackUrl);
});

test("single use: two ?code= callbacks racing — the first is exchanged (200), the second is a 409 while that exchange is in flight, ONE keys POST, the login resolves with the FIRST key", async () => {
  const { login, notice } = startLogin();
  const { callbackUrl } = await notice;
  const hold = deferred<void>();
  gate = withDeadline(hold.promise, 10_000).catch(() => {}); // the fake keys endpoint answers only once released
  const first = withDeadline(fetch(`${callbackUrl}?code=CODE-FIRST`));
  await waitFor(() => keyHits === 1); // the exchange for the first code is now in flight
  const second = await withDeadline(fetch(`${callbackUrl}?code=CODE-SECOND`));
  // MUTATION TARGET (drop the `settled || claimed || closing` guard): the second code is exchanged too — 200 and keyHits 2
  expect(second.status).toBe(409);
  expect(await second.text()).toContain("already been used");
  expect(keyHits).toBe(1);
  hold.resolve();
  const r1 = await first;
  expect(r1.status).toBe(200);
  expect(await r1.text()).toContain("Signed in to OpenRouter");
  const cred = await withDeadline(login);
  expect(cred.access).toBe(`${KEY_PREFIX}CODE-FIRST`);
  expect(codes).toEqual(["CODE-FIRST"]);
  expect(keyHits).toBe(1);
  await expectClosed(callbackUrl);
});
