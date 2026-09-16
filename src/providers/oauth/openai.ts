/** OpenAI (ChatGPT) OAuth device-code flow (port #66).
 *
 *  Ported from pi packages/ai/src/auth/oauth/openai-codex.ts (earendil-works/pi, MIT — Copyright (c)
 *  2025 Mario Zechner; snapshot under research/source_snapshots/earendil-works-pi), device-code half
 *  only (pi's browser PKCE half on the fixed port 1455 is not ported — follow-up). Kept as pi has it:
 *  - POST auth.openai.com/api/accounts/deviceauth/usercode {client_id} → device_auth_id + user_code +
 *    interval (number or numeric string); the user opens https://auth.openai.com/codex/device;
 *  - poll POST …/deviceauth/token {device_auth_id, user_code}: 200 → authorization_code + the
 *    server-issued code_verifier; 403/404 or error code deviceauth_authorization_pending → pending;
 *    slow_down → slow_down; anything else fails; 15-minute deadline;
 *  - exchange at POST auth.openai.com/oauth/token (grant authorization_code, redirect_uri
 *    …/deviceauth/callback) → access_token + refresh_token + expires_in; refresh = grant
 *    refresh_token at the same URL; the ChatGPT account id is read from the access token's JWT claim
 *    `https://api.openai.com/auth`.chatgpt_account_id and sent as the `chatgpt-account-id` header.
 *  Deviations: a token without the account claim is accepted (pi throws) — accountId is optional;
 *  a 404 on the usercode request is reported as "device code login not enabled" like pi.
 *  Honesty: the client id is the Codex CLI's (pi and opencode sign in with it). The resulting token is a
 *  ChatGPT-subscription token accepted by the Codex Responses backend ONLY, so `toAuth` (port #75) hands the
 *  seam `baseUrl` https://chatgpt.com/backend-api/codex (codex model-provider-info/src/lib.rs:40
 *  CHATGPT_CODEX_BASE_URL; pi openai-codex-responses.ts:45 + resolveCodexUrl :633-639), `wire: "responses"`
 *  (providers/wire-select.ts sends every request through providers/responses.ts — never /chat/completions)
 *  and the headers that backend requires: `chatgpt-account-id` (when the JWT carries the claim),
 *  `OpenAI-Beta: responses=experimental` and `originator: rovecode` (pi openai-codex-responses.ts:1607-1609,
 *  :1622; codex core/src/client.rs:688 adds its own originator). Not live-verified on this box (no ChatGPT
 *  account): the path is pinned against loopback fakes (test/unit/oauth-openai-responses.test.ts) — README. */

import { fetchOrCancel, httpFailure, jsonObject, type OAuthCredential, type OAuthDeps, type OAuthLoginIO, type OAuthProvider } from "./common.ts";
import { pollDeviceCodeFlow } from "./device-code.ts";

export interface OpenAIEndpoints {
  deviceUserCodeUrl: string;
  deviceTokenUrl: string;
  tokenUrl: string;
  deviceVerificationUri: string;
  deviceRedirectUri: string;
  /** the Responses base the token is sent to (…/responses is appended by providers/responses.ts) */
  responsesBaseUrl: string;
}

const AUTH_BASE_URL = "https://auth.openai.com";
export const OPENAI_ENDPOINTS: OpenAIEndpoints = {
  deviceUserCodeUrl: `${AUTH_BASE_URL}/api/accounts/deviceauth/usercode`,
  deviceTokenUrl: `${AUTH_BASE_URL}/api/accounts/deviceauth/token`,
  tokenUrl: `${AUTH_BASE_URL}/oauth/token`,
  deviceVerificationUri: `${AUTH_BASE_URL}/codex/device`,
  deviceRedirectUri: `${AUTH_BASE_URL}/deviceauth/callback`,
  responsesBaseUrl: "https://chatgpt.com/backend-api/codex",
};

/** the two headers the Codex Responses backend expects beside the bearer + account id (pi :1607-1609, :1622) */
export const CODEX_RESPONSES_HEADERS: Readonly<Record<string, string>> = { "OpenAI-Beta": "responses=experimental", originator: "rovecode" };

/** pi: the Codex CLI OAuth client id */
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const DEVICE_CODE_TIMEOUT_SECONDS = 15 * 60;
const JWT_CLAIM = "https://api.openai.com/auth";

interface DeviceAuth { deviceAuthId: string; userCode: string; intervalSeconds: number }
interface DeviceGrant { authorizationCode: string; codeVerifier: string }

/** The ChatGPT account id claim of an access-token JWT; undefined when absent or not a JWT. */
export function accountIdFromJwt(token: string): string | undefined {
  try {
    const parts = token.split(".");
    if (parts.length !== 3 || !parts[1]) return undefined;
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4))) as Record<string, unknown>;
    const claim = payload[JWT_CLAIM];
    const id = typeof claim === "object" && claim !== null ? (claim as { chatgpt_account_id?: unknown }).chatgpt_account_id : undefined;
    return typeof id === "string" && id.length > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

async function readTokenResponse(res: Response, what: string, now: () => number): Promise<OAuthCredential> {
  if (!res.ok) throw await httpFailure(what, res);
  const json = await jsonObject(res, what);
  const { access_token: access, refresh_token: refresh, expires_in: expiresIn } = json;
  if (typeof access !== "string" || access.length === 0 || typeof refresh !== "string" || typeof expiresIn !== "number") throw new Error(`${what}: response is missing fields`);
  const accountId = accountIdFromJwt(access);
  return { type: "oauth", access, refresh, expires: now() + expiresIn * 1000, ...(accountId !== undefined ? { accountId } : {}) };
}

async function startDeviceAuth(ep: OpenAIEndpoints, deps: OAuthDeps, signal: AbortSignal): Promise<DeviceAuth> {
  const res = await fetchOrCancel(deps, ep.deviceUserCodeUrl, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_id: CLIENT_ID }),
  }, signal);
  if (res.status === 404) throw new Error("OpenAI device code login is not enabled for this server (HTTP 404)");
  if (!res.ok) throw await httpFailure("OpenAI device code request", res);
  const json = await jsonObject(res, "OpenAI device code request");
  const { device_auth_id: deviceAuthId, user_code: userCode, interval } = json;
  const intervalSeconds = typeof interval === "string" ? Number(interval.trim()) : interval;
  if (typeof deviceAuthId !== "string" || !deviceAuthId || typeof userCode !== "string" || !userCode
    || typeof intervalSeconds !== "number" || !Number.isFinite(intervalSeconds) || intervalSeconds < 0) {
    throw new Error("OpenAI device code response is missing fields");
  }
  return { deviceAuthId, userCode, intervalSeconds };
}

function pollDeviceAuth(ep: OpenAIEndpoints, device: DeviceAuth, deps: OAuthDeps, signal: AbortSignal): Promise<DeviceGrant> {
  return pollDeviceCodeFlow<DeviceGrant>({
    intervalSeconds: device.intervalSeconds,
    expiresInSeconds: DEVICE_CODE_TIMEOUT_SECONDS,
    signal,
    sleep: deps.sleep,
    now: deps.now,
    poll: async () => {
      const res = await fetchOrCancel(deps, ep.deviceTokenUrl, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device_auth_id: device.deviceAuthId, user_code: device.userCode }),
      }, signal);
      if (res.ok) {
        const json = await jsonObject(res, "OpenAI device token poll");
        const { authorization_code: authorizationCode, code_verifier: codeVerifier } = json;
        if (typeof authorizationCode !== "string" || !authorizationCode || typeof codeVerifier !== "string" || !codeVerifier) {
          return { status: "failed", message: "OpenAI device token response is missing fields" };
        }
        return { status: "complete", value: { authorizationCode, codeVerifier } };
      }
      if (res.status === 403 || res.status === 404) return { status: "pending" };
      let errorCode: unknown;
      try {
        const json = (await res.json()) as { error?: string | { code?: string } } | null;
        errorCode = typeof json?.error === "object" ? json.error?.code : json?.error;
      } catch {
        // non-JSON error body: reported by status below
      }
      if (errorCode === "deviceauth_authorization_pending") return { status: "pending" };
      if (errorCode === "slow_down") return { status: "slow_down" };
      return { status: "failed", message: `OpenAI device authorization failed (HTTP ${res.status})${typeof errorCode === "string" ? `: ${errorCode.slice(0, 80)}` : ""}` };
    },
  });
}

async function postToken(ep: OpenAIEndpoints, fields: Record<string, string>, deps: OAuthDeps, signal: AbortSignal | undefined, what: string): Promise<OAuthCredential> {
  const res = await fetchOrCancel(deps, ep.tokenUrl, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString(),
  }, signal);
  return readTokenResponse(res, what, deps.now);
}

export function openAIOAuth(endpoints: OpenAIEndpoints = OPENAI_ENDPOINTS): OAuthProvider {
  return {
    id: "openai",
    label: "OpenAI / ChatGPT (device code)",
    async login(io: OAuthLoginIO, deps: OAuthDeps): Promise<OAuthCredential> {
      const device = await startDeviceAuth(endpoints, deps, io.signal);
      io.notify({ type: "device_code", userCode: device.userCode, verificationUri: endpoints.deviceVerificationUri, intervalSeconds: device.intervalSeconds, expiresInSeconds: DEVICE_CODE_TIMEOUT_SECONDS });
      const grant = await pollDeviceAuth(endpoints, device, deps, io.signal);
      io.notify({ type: "progress", message: "authorized — exchanging the authorization code" });
      return postToken(endpoints, {
        grant_type: "authorization_code", client_id: CLIENT_ID, code: grant.authorizationCode, code_verifier: grant.codeVerifier, redirect_uri: endpoints.deviceRedirectUri,
      }, deps, io.signal, "OpenAI token exchange");
    },
    refresh(cred, signal, deps) {
      return postToken(endpoints, { grant_type: "refresh_token", refresh_token: cred.refresh, client_id: CLIENT_ID }, deps, signal, "OpenAI token refresh");
    },
    toAuth(cred) {
      return { apiKey: cred.access, baseUrl: endpoints.responsesBaseUrl, wire: "responses", headers: { ...(cred.accountId ? { "chatgpt-account-id": cred.accountId } : {}), ...CODEX_RESPONSES_HEADERS } };
    },
  };
}
