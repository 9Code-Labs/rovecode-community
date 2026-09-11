/** The RFC 8628 client (`rovecode login`): the code request, the poll loop, slow_down, denial, expiry and
 *  the manual-token path — all against an injected fetch and clock, so no server and no real waiting. */

import { beforeEach, expect, test } from "bun:test";
import { createAccountKey } from "../../src/account/keys.ts";
import { linkWithToken, runDeviceLogin } from "../../src/account/login.ts";
import { accountPath, clearAccount, loadAccount } from "../../src/account/store.ts";

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const CODE_BODY = { device_code: "dc_1", user_code: "ABCD-1234", verification_uri: "http://site/cli-auth", expires_in: 600, interval: 0 };
const TOKEN = `rc_live_${"a".repeat(32)}`;

interface Rig {
  fetchImpl: typeof fetch;
  urls: string[];
}

/** a fetch that answers with each queued response in turn (the last repeats), recording the URLs it saw */
function rig(...responses: (Response | (() => Response))[]): Rig {
  const urls: string[] = [];
  let i = 0;
  const fetchImpl = (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    const r = responses[Math.min(i, responses.length - 1)]!;
    i++;
    return typeof r === "function" ? r() : r;
  }) as unknown as typeof fetch;
  return { fetchImpl, urls };
}

beforeEach(() => {
  clearAccount();
});

test("a pending code then an approval links the account and saves it", async () => {
  const { fetchImpl, urls } = rig(
    json(CODE_BODY),
    json({ error: "authorization_pending" }, 400),
    json({ access_token: TOKEN, user: { id: "u1", email: "berkay@rovecode.dev", name: "Berkay" } }),
  );
  const seen: string[] = [];
  const result = await runDeviceLogin({ apiBase: "http://api.test", fetchImpl, sleep: async () => {}, now: () => 1000, onCode: (c) => seen.push(c.userCode) });

  expect(result.ok).toBe(true);
  if (result.ok) expect(result.account.email).toBe("berkay@rovecode.dev");
  expect(seen).toEqual(["ABCD-1234"]);
  expect(urls[0]).toBe("http://api.test/api/auth/device/code");
  expect(urls[1]).toBe("http://api.test/api/auth/device/token");
  expect(loadAccount()?.token).toBe(TOKEN);
});

test("a denial ends the flow with reason denied", async () => {
  const { fetchImpl } = rig(json(CODE_BODY), json({ error: "access_denied" }, 400));
  const result = await runDeviceLogin({ apiBase: "http://api.test", fetchImpl, sleep: async () => {}, now: () => 0 });
  expect(result).toEqual({ ok: false, reason: "denied" });
  expect(loadAccount()).toBeNull();
});

test("an expired token ends the flow with reason expired", async () => {
  const { fetchImpl } = rig(json(CODE_BODY), json({ error: "expired_token" }, 400));
  const result = await runDeviceLogin({ apiBase: "http://api.test", fetchImpl, sleep: async () => {}, now: () => 0 });
  expect(result).toEqual({ ok: false, reason: "expired" });
});

test("a fast poll answers slow_down, the interval grows, and the flow still finishes", async () => {
  const { fetchImpl } = rig(json(CODE_BODY), json({ error: "slow_down" }, 400), json({ access_token: TOKEN, user: { id: "u1", email: "a@b.c" } }));
  const waits: number[] = [];
  const result = await runDeviceLogin({ apiBase: "http://api.test", fetchImpl, sleep: async (ms) => void waits.push(ms), now: () => 0 });
  expect(result.ok).toBe(true);
  expect(waits).toEqual([0, 5000]); // interval 0, then 0 + 5 s after slow_down
});

test("an unreachable endpoint is a network failure", async () => {
  const fetchImpl = (async () => {
    throw new Error("connection refused");
  }) as unknown as typeof fetch;
  const result = await runDeviceLogin({ apiBase: "http://api.test", fetchImpl, sleep: async () => {} });
  expect(result).toEqual({ ok: false, reason: "network" });
});

test("a zero-lifetime code expires without polling", async () => {
  const { fetchImpl, urls } = rig(json({ ...CODE_BODY, expires_in: 0 }));
  const result = await runDeviceLogin({ apiBase: "http://api.test", fetchImpl, sleep: async () => {}, now: () => 0 });
  expect(result).toEqual({ ok: false, reason: "expired" });
  expect(urls).toEqual(["http://api.test/api/auth/device/code"]);
});

test("linkWithToken saves a valid token and refuses a rejected one", async () => {
  const keys = createAccountKey(); // in-memory: the default would write ~/.rovecode/account-key.json
  const good = (async () => json({ user: { id: "u2", email: "x@y.z", name: "X" } })) as unknown as typeof fetch;
  const okAccount = await linkWithToken("http://api.test", TOKEN, good, keys);
  expect(okAccount?.email).toBe("x@y.z");
  expect(loadAccount()?.email).toBe("x@y.z");

  clearAccount();
  const bad = (async () => json({ error: "invalid_token" }, 401)) as unknown as typeof fetch;
  expect(await linkWithToken("http://api.test", "nope", bad, keys)).toBeNull();
  expect(loadAccount()).toBeNull();
});

test("accountPath lives under the rovecode home", () => {
  expect(accountPath().endsWith("account.json")).toBe(true);
});
