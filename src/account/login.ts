/** RFC 8628 device authorization grant, client side — the half `rovecode login` runs.
 *
 *  The CLI asks the site's API for a code, shows the human where to approve it, and polls until a token
 *  appears. `fetch`, `sleep` and `now` are injectable so the whole loop is unit-testable without a server
 *  or a real clock. */

import { loadOrCreateAccountKey, signProof, type AccountKey } from "./keys.ts";
import { saveAccount, type LinkedAccount } from "./store";

export interface DeviceCodeInfo {
  userCode: string;
  verificationUri: string;
  expiresIn: number;
}

export interface DeviceLoginOptions {
  apiBase: string;
  clientId?: string;
  scope?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** the machine's PoP key; defaults to ~/.rovecode/account-key.json (created on first use) */
  keys?: AccountKey;
  /** called once with the code and URL to show the human */
  onCode?: (info: DeviceCodeInfo) => void;
}

export type LoginResult = { ok: true; account: LinkedAccount } | { ok: false; reason: "denied" | "expired" | "invalid" | "network" };

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Probe {
  status: number;
  body: Record<string, unknown>;
}

async function postJson(doFetch: typeof fetch, url: string, body: unknown): Promise<Probe | null> {
  try {
    const res = await doFetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, body: await readJson(res) };
  } catch {
    return null;
  }
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  try {
    const text = await res.text();
    return text.trim() ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export async function runDeviceLogin(opts: DeviceLoginOptions): Promise<LoginResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? (() => Date.now());
  const base = opts.apiBase.replace(/\/+$/, "");

  const keys = opts.keys ?? loadOrCreateAccountKey();
  const start = await postJson(doFetch, `${base}/api/auth/device/code`, {
    client_id: opts.clientId ?? "rovecode-cli",
    scope: opts.scope,
    public_jwk: keys.publicJwk,
  });
  if (!start || start.status !== 200) return { ok: false, reason: "network" };
  const deviceCode = typeof start.body.device_code === "string" ? start.body.device_code : "";
  const userCode = typeof start.body.user_code === "string" ? start.body.user_code : "";
  if (!deviceCode || !userCode) return { ok: false, reason: "network" };

  const expiresIn = typeof start.body.expires_in === "number" ? start.body.expires_in : 600;
  let interval = typeof start.body.interval === "number" ? start.body.interval : 5;
  const verificationUri = typeof start.body.verification_uri === "string" ? start.body.verification_uri : `${base}/cli-auth`;
  opts.onCode?.({ userCode, verificationUri, expiresIn });

  const deadline = now() + expiresIn * 1000;
  while (now() < deadline) {
    await sleep(interval * 1000);
    const poll = await postJson(doFetch, `${base}/api/auth/device/token`, { device_code: deviceCode });
    if (!poll) return { ok: false, reason: "network" };

    if (poll.status === 200) {
      const token = typeof poll.body.access_token === "string" ? poll.body.access_token : "";
      if (!token) return { ok: false, reason: "network" };
      const user = (poll.body.user ?? {}) as { id?: unknown; email?: unknown; name?: unknown };
      const apiKey = typeof poll.body.api_key === "string" ? poll.body.api_key : "";
      const account: LinkedAccount = {
        token,
        userId: typeof user.id === "string" ? user.id : "",
        email: typeof user.email === "string" ? user.email : "",
        name: typeof user.name === "string" ? user.name : "",
        apiBase: base,
        linkedAt: new Date(now()).toISOString(),
        ...(apiKey ? { apiKey } : {}),
      };
      saveAccount(account);
      return { ok: true, account };
    }

    switch (poll.body.error) {
      case "authorization_pending":
        continue;
      case "slow_down":
        interval += 5;
        continue;
      case "access_denied":
        return { ok: false, reason: "denied" };
      case "expired_token":
        return { ok: false, reason: "expired" };
      case "invalid_grant":
        return { ok: false, reason: "invalid" };
      default:
        return { ok: false, reason: "network" };
    }
  }
  return { ok: false, reason: "expired" };
}

/** Verify a hand-pasted `rc_live_…` token against /api/auth/me. A proof signed with this machine's key goes
 *  along: a bound token answers only when the keys match (i.e. the token was issued to this machine); an
 *  unbound legacy token still passes on bearer alone — the documented fallback. */
export async function linkWithToken(
  apiBase: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
  keys: AccountKey = loadOrCreateAccountKey(),
  now: () => number = () => Date.now(),
): Promise<LinkedAccount | null> {
  const base = apiBase.replace(/\/+$/, "");
  token = token.trim();
  if (!token) return null;
  const meUrl = `${base}/api/auth/me`;
  try {
    const res = await fetchImpl(meUrl, {
      headers: {
        authorization: `Bearer ${token}`,
        dpop: signProof(keys, { htm: "GET", htu: meUrl, iat: Math.floor(now() / 1000), accessToken: token }),
      },
    });
    if (!res.ok) return null;
    const body = await readJson(res);
    const user = (body.user ?? {}) as { id?: unknown; email?: unknown; name?: unknown };
    const account: LinkedAccount = {
      token,
      userId: typeof user.id === "string" ? user.id : "",
      email: typeof user.email === "string" ? user.email : "",
      name: typeof user.name === "string" ? user.name : "",
      apiBase: base,
      linkedAt: new Date().toISOString(),
    };
    saveAccount(account);
    return account;
  } catch {
    return null;
  }
}
