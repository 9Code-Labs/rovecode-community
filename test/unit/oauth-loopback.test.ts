/** Port #76 — the extracted loopback callback server (providers/oauth/loopback.ts) on its own, the test playing the browser
 *  against 127.0.0.1: GET-only, loopback-Host-only, off-`/callback/` requests are 404s that keep waiting; the path nonce is the
 *  state (400 + reject on a mismatch, onCode never runs); `?state=` is checked ONLY with requireStateParam (the MCP SDK sends
 *  it, OpenRouter does not); `?error=` rejects with the reason; a GET without a code is a 400 that keeps waiting; the ONE
 *  accepted code runs onCode BEFORE the 200 and a second callback is a 409 while it runs (one exchange); a throwing onCode
 *  answers 502; timeout, abort and stop() reject and close the port (connection refused); the callback URL comes from the
 *  BOUND server. No network. */

import { expect, test } from "bun:test";
import { CALLBACK_HOST, startLoopbackCallback, stateMismatchMessage } from "../../src/providers/oauth/loopback.ts";
import { randomState } from "../../src/providers/oauth/pkce.ts";

function withDeadline<T>(p: Promise<T>, ms = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bomb = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`exceeded ${ms} ms`)), ms); });
  return Promise.race([p, bomb]).finally(() => clearTimeout(timer)) as Promise<T>;
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
/** connection refused once the callback server is stopped */
async function expectClosed(url: string): Promise<void> {
  await expect(withDeadline(fetch(url))).rejects.toThrow();
}
const statusOrClosed = (p: Promise<Response>): Promise<number | "closed"> => withDeadline(p).then((r) => r.status, () => "closed" as const);

interface StartOpts { requireStateParam?: boolean; signal?: AbortSignal; timeoutMs?: number; onCode?: (code: string) => Promise<string> }
function start(o: StartOpts = {}) {
  const nonce = randomState();
  const codes: string[] = [];
  const cb = startLoopbackCallback<string>({
    nonce, signal: o.signal ?? new AbortController().signal, what: "Fake", retryHint: "Run rovecode fake again.",
    requireStateParam: o.requireStateParam, timeoutMs: o.timeoutMs,
    onCode: o.onCode ?? (async (code) => { codes.push(code); return `got:${code}`; }),
  });
  return { nonce, cb, codes };
}

test("the callback URL is the BOUND server's (127.0.0.1, ephemeral port, /callback/<43-char nonce>); POST, a foreign Host and an off-prefix GET are 404s that keep waiting; the genuine GET runs onCode BEFORE the 200 and resolves; the port is closed afterwards", async () => {
  const { nonce, cb, codes } = start();
  expect(cb.callbackUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback\/[A-Za-z0-9_-]{43}$/);
  expect(cb.callbackUrl.endsWith(`/callback/${nonce}`)).toBe(true);
  expect(new URL(cb.callbackUrl).hostname).toBe(CALLBACK_HOST);
  const origin = new URL(cb.callbackUrl).origin;
  const post = await withDeadline(fetch(`${cb.callbackUrl}?code=POSTED`, { method: "POST" }));
  expect(post.status).toBe(404);
  expect(await post.text()).toContain("Not an OAuth callback");
  expect((await withDeadline(fetch(`${cb.callbackUrl}?code=EVIL`, { headers: { Host: "evil.example" } }))).status).toBe(404);
  expect((await withDeadline(fetch(`${origin}/favicon.ico`))).status).toBe(404);
  expect(codes).toEqual([]);
  let orderedBeforeResponse = false;
  const { cb: cb2 } = start({ onCode: async (code) => { orderedBeforeResponse = true; return `late:${code}`; } });
  const ok = await withDeadline(fetch(`${cb2.callbackUrl}?code=C-1`));
  expect(ok.status).toBe(200);
  expect(orderedBeforeResponse).toBe(true); // onCode ran before the browser got its page
  expect(await ok.text()).toContain("Signed in to Fake");
  expect(await withDeadline(cb2.result)).toBe("late:C-1");
  await expectClosed(cb2.callbackUrl);
  cb.stop();
  await expectClosed(cb.callbackUrl);
});

test("a GET on a different /callback/<nonce> path is a STATE MISMATCH: 400 with the retry hint, the result rejects with stateMismatchMessage(what), onCode never runs, the port closes", async () => {
  const { cb, codes } = start();
  const forged = cb.callbackUrl.replace(/\/callback\/[^/?]+$/, `/callback/${"x".repeat(43)}`) + "?code=FORGED";
  const res = await withDeadline(fetch(forged));
  expect(res.status).toBe(400);
  expect(await res.text()).toContain("State mismatch — this login was aborted. Run rovecode fake again.");
  // MUTATION TARGET (skip the path comparison): the forged code would reach onCode and the result would resolve
  await expect(withDeadline(cb.result)).rejects.toThrow(stateMismatchMessage("Fake"));
  expect(stateMismatchMessage("Fake")).toBe("Fake OAuth: state mismatch on the callback — login aborted");
  expect(codes).toEqual([]);
  await expectClosed(cb.callbackUrl);
});

test("`?state=` is ignored without requireStateParam (OpenRouter sends none) and ENFORCED with it (the MCP SDK sends it): a missing or wrong state is the same 400 + reject, a matching state completes", async () => {
  const lax = start();
  expect((await withDeadline(fetch(`${lax.cb.callbackUrl}?code=C&state=whatever`))).status).toBe(200);
  expect(await withDeadline(lax.cb.result)).toBe("got:C");

  const missing = start({ requireStateParam: true });
  const r1 = await withDeadline(fetch(`${missing.cb.callbackUrl}?code=C`));
  expect(r1.status).toBe(400);
  expect(await r1.text()).toContain("State mismatch");
  await expect(withDeadline(missing.cb.result)).rejects.toThrow(stateMismatchMessage("Fake"));
  expect(missing.codes).toEqual([]);

  const wrong = start({ requireStateParam: true });
  // MUTATION TARGET m1 (drop the ?state= comparison): this forged state would be accepted — 200 and onCode runs
  expect((await withDeadline(fetch(`${wrong.cb.callbackUrl}?code=C&state=${"y".repeat(43)}`))).status).toBe(400);
  await expect(withDeadline(wrong.cb.result)).rejects.toThrow(stateMismatchMessage("Fake"));
  expect(wrong.codes).toEqual([]);
  await expectClosed(wrong.cb.callbackUrl);

  const strict = start({ requireStateParam: true });
  expect((await withDeadline(fetch(`${strict.cb.callbackUrl}?code=C-OK&state=${strict.nonce}`))).status).toBe(200);
  expect(await withDeadline(strict.cb.result)).toBe("got:C-OK");
  expect(strict.codes).toEqual(["C-OK"]);
});

test("`?error=` rejects with the provider's reason (400 page); a GET without a code is a 400 that keeps waiting", async () => {
  const a = start();
  const denied = await withDeadline(fetch(`${a.cb.callbackUrl}?error=access_denied&error_description=User+said+no`));
  expect(denied.status).toBe(400);
  expect(await denied.text()).toContain("Fake authorization was denied.");
  await expect(withDeadline(a.cb.result)).rejects.toThrow("Fake authorization denied: User said no");
  expect(a.codes).toEqual([]);
  await expectClosed(a.cb.callbackUrl);

  const b = start();
  const noCode = await withDeadline(fetch(b.cb.callbackUrl));
  expect(noCode.status).toBe(400);
  expect(await noCode.text()).toContain("Fake returned no authorization code.");
  expect((await withDeadline(fetch(`${new URL(b.cb.callbackUrl).origin}/favicon.ico`))).status).toBe(404); // still up
  expect((await withDeadline(fetch(`${b.cb.callbackUrl}?code=C-2`))).status).toBe(200);
  expect(await withDeadline(b.cb.result)).toBe("got:C-2");
});

test("single use: two ?code= callbacks racing — the first runs onCode (200), the second is a 409 while that exchange is in flight, onCode ran ONCE; a replay after the outcome is 409 or refused", async () => {
  const hold = deferred<void>();
  let calls = 0;
  const { cb } = start({ onCode: async (code) => { calls++; await withDeadline(hold.promise); return `got:${code}`; } });
  const first = withDeadline(fetch(`${cb.callbackUrl}?code=FIRST`));
  await waitFor(() => calls === 1);
  const second = await withDeadline(fetch(`${cb.callbackUrl}?code=SECOND`));
  // MUTATION TARGET m8 (drop the `settled || claimed || closing` guard): the second code reaches onCode too — 200 and calls 2
  expect(second.status).toBe(409);
  expect(await second.text()).toContain("already been used");
  expect(calls).toBe(1);
  hold.resolve();
  expect((await first).status).toBe(200);
  const replay = await statusOrClosed(fetch(`${cb.callbackUrl}?code=THIRD`));
  expect([409, "closed"]).toContain(replay);
  expect(await withDeadline(cb.result)).toBe("got:FIRST");
  expect(calls).toBe(1);
  await expectClosed(cb.callbackUrl);
});

test("a genuine callback landing right after a forged mismatch (inside the response-flush window) is a 409 — the synchronous `closing` flag, not the delayed settle", async () => {
  const { cb, codes } = start();
  const forged = cb.callbackUrl.replace(/\/callback\/[^/?]+$/, `/callback/${"x".repeat(43)}`) + "?code=FORGED";
  expect((await withDeadline(fetch(forged))).status).toBe(400);
  const late = await statusOrClosed(fetch(`${cb.callbackUrl}?code=GENUINE`));
  expect([409, "closed"]).toContain(late);
  await expect(withDeadline(cb.result)).rejects.toThrow(stateMismatchMessage("Fake"));
  expect(codes).toEqual([]);
});

test("a throwing onCode answers 502 (`<what> <exchange> failed`) and the result rejects with that error; the port closes", async () => {
  const { cb } = start({ onCode: async () => { throw new Error("exchange failed (HTTP 400)"); } });
  const res = await withDeadline(fetch(`${cb.callbackUrl}?code=BAD`));
  expect(res.status).toBe(502);
  expect(await res.text()).toContain("Fake key exchange failed — see the rovecode terminal.");
  await expect(withDeadline(cb.result)).rejects.toThrow("exchange failed (HTTP 400)");
  await expectClosed(cb.callbackUrl);
});

test("timeout: the result rejects `<what> OAuth login timed out (…)` and the port closes; the default budget is 5 minutes", async () => {
  const { cb } = start({ timeoutMs: 150 });
  await expect(withDeadline(cb.result)).rejects.toThrow("Fake OAuth login timed out (150 ms)");
  await expectClosed(cb.callbackUrl);
  const { DEFAULT_LOGIN_TIMEOUT_MS } = await import("../../src/providers/oauth/loopback.ts");
  expect(DEFAULT_LOGIN_TIMEOUT_MS).toBe(5 * 60_000);
});

test("abort: the result rejects `login cancelled` and the port closes; an already-aborted signal rejects at once; stop() early rejects `aborted`, closes, and is idempotent", async () => {
  const ac = new AbortController();
  const a = start({ signal: ac.signal });
  expect((await withDeadline(fetch(`${new URL(a.cb.callbackUrl).origin}/favicon.ico`))).status).toBe(404); // listening
  ac.abort();
  await expect(withDeadline(a.cb.result)).rejects.toThrow("login cancelled");
  await expectClosed(a.cb.callbackUrl);

  const pre = new AbortController();
  pre.abort();
  const b = start({ signal: pre.signal });
  await expect(withDeadline(b.cb.result)).rejects.toThrow("login cancelled");
  await expectClosed(b.cb.callbackUrl);

  const c = start();
  c.cb.stop();
  c.cb.stop();
  await expect(withDeadline(c.cb.result)).rejects.toThrow("Fake OAuth login aborted");
  await expectClosed(c.cb.callbackUrl);
});
