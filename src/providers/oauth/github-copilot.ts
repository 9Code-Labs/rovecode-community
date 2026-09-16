/** GitHub Copilot OAuth (port #66): the GitHub device-code flow, then the Copilot token exchange.
 *
 *  Ported from pi packages/ai/src/auth/oauth/github-copilot.ts (earendil-works/pi, MIT — Copyright (c)
 *  2025 Mario Zechner; snapshot under research/source_snapshots/earendil-works-pi). Kept as pi has it:
 *  - POST /login/device/code with the Copilot Chat client id + scope read:user → user_code +
 *    verification_uri + interval + expires_in; the verification URI must parse as http(s) (never handed
 *    to an opener otherwise);
 *  - poll POST /login/oauth/access_token (grant urn:ietf:params:oauth:grant-type:device_code) through
 *    pollDeviceCodeFlow, waiting one interval before the first poll; `authorization_pending` → pending,
 *    `slow_down` → the server's new `interval`; a 200 body with `error` is how GitHub reports both;
 *  - the GitHub OAuth token is the long-lived REFRESH credential; GET api.github.com/copilot_internal/
 *    v2/token (Bearer <github token> + the Copilot editor headers) mints the short-lived Copilot
 *    token (`token`, `expires_at` seconds) — stored as `access` with a 5-minute early expiry;
 *  - the chat base URL comes from the Copilot token's `proxy-ep=` field (proxy.X → https://api.X),
 *    default https://api.individual.githubcopilot.com; requests carry the editor headers.
 *  Deviations: enterprise domains are not prompted for (github.com only — follow-up); pi's
 *  /models catalog fetch + per-model policy enabling is not ported (rovecode fetches /models itself
 *  through providers/stream.ts fetchModels); endpoints are injectable for the fake-server tests.
 *  Honesty: the client id is the one the GitHub Copilot Chat VS Code extension uses (pi, opencode and
 *  others sign in with it); the token endpoint is GitHub's internal Copilot API. Not live-verified
 *  on this box (no Copilot account) — see README. */

import { fetchOrCancel, httpFailure, jsonObject, type OAuthCredential, type OAuthDeps, type OAuthLoginIO, type OAuthProvider } from "./common.ts";
import { pollDeviceCodeFlow } from "./device-code.ts";

export interface GitHubCopilotEndpoints {
  deviceCodeUrl: string;
  accessTokenUrl: string;
  copilotTokenUrl: string;
  /** fixed chat base URL (tests; enterprise proxies). Default: derived from the token's proxy-ep. */
  chatBaseUrl?: string;
}

export const GITHUB_COPILOT_ENDPOINTS: GitHubCopilotEndpoints = {
  deviceCodeUrl: "https://github.com/login/device/code",
  accessTokenUrl: "https://github.com/login/oauth/access_token",
  copilotTokenUrl: "https://api.github.com/copilot_internal/v2/token",
};

/** pi: the GitHub Copilot Chat (VS Code extension) OAuth app id, base64 as upstream keeps it */
const CLIENT_ID = atob("SXYxLmI1MDdhMDhjODdlY2ZlOTg=");
const USER_AGENT = "GitHubCopilotChat/0.35.0";
/** the editor headers the Copilot API expects on every request (pi COPILOT_HEADERS) */
export const COPILOT_HEADERS: Readonly<Record<string, string>> = {
  "User-Agent": USER_AGENT,
  "Editor-Version": "vscode/1.107.0",
  "Editor-Plugin-Version": "copilot-chat/0.35.0",
  "Copilot-Integration-Id": "vscode-chat",
};
const DEFAULT_BASE_URL = "https://api.individual.githubcopilot.com";
/** the stored expiry leads the server's by this much, so a request never races the real expiry */
const EXPIRY_SKEW_MS = 5 * 60_000;
export const GITHUB_COPILOT_DEFAULT_MODEL = "gpt-4o";

interface DeviceCode { deviceCode: string; userCode: string; verificationUri: string; interval?: number; expiresIn: number }

/** `tid=…;exp=…;proxy-ep=proxy.individual.githubcopilot.com;…` → https://api.individual.githubcopilot.com */
export function baseUrlFromCopilotToken(token: string): string | null {
  const match = /proxy-ep=([^;]+)/.exec(token);
  if (!match || !match[1]) return null;
  return `https://${match[1].replace(/^proxy\./, "api.")}`;
}

async function postForm(deps: OAuthDeps, url: string, fields: Record<string, string>, signal: AbortSignal | undefined, what: string): Promise<Record<string, unknown>> {
  const res = await fetchOrCancel(deps, url, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded", "User-Agent": USER_AGENT },
    body: new URLSearchParams(fields).toString(),
  }, signal);
  if (!res.ok) throw await httpFailure(what, res);
  return jsonObject(res, what);
}

async function startDeviceFlow(ep: GitHubCopilotEndpoints, deps: OAuthDeps, signal: AbortSignal): Promise<DeviceCode> {
  const data = await postForm(deps, ep.deviceCodeUrl, { client_id: CLIENT_ID, scope: "read:user" }, signal, "GitHub device code request");
  const { device_code: deviceCode, user_code: userCode, verification_uri: verificationUri, interval, expires_in: expiresIn } = data;
  if (typeof deviceCode !== "string" || typeof userCode !== "string" || typeof verificationUri !== "string"
    || (interval !== undefined && typeof interval !== "number") || typeof expiresIn !== "number") {
    throw new Error("GitHub device code response is missing fields");
  }
  // the verification URI is shown for the user to open — force it to be an http(s) URL (pi)
  let parsed: URL;
  try {
    parsed = new URL(verificationUri);
  } catch {
    throw new Error("GitHub device code response carries an untrusted verification_uri");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("GitHub device code response carries an untrusted verification_uri");
  return { deviceCode, userCode, verificationUri: parsed.href, interval: interval as number | undefined, expiresIn };
}

function pollAccessToken(ep: GitHubCopilotEndpoints, device: DeviceCode, deps: OAuthDeps, signal: AbortSignal): Promise<string> {
  return pollDeviceCodeFlow<string>({
    intervalSeconds: device.interval,
    expiresInSeconds: device.expiresIn,
    waitBeforeFirstPoll: true,
    signal,
    sleep: deps.sleep,
    now: deps.now,
    poll: async () => {
      const raw = await postForm(deps, ep.accessTokenUrl, {
        client_id: CLIENT_ID, device_code: device.deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }, signal, "GitHub device token poll");
      if (typeof raw.access_token === "string" && raw.access_token.length > 0) return { status: "complete", value: raw.access_token };
      if (typeof raw.error === "string") {
        if (raw.error === "authorization_pending") return { status: "pending" };
        if (raw.error === "slow_down") return { status: "slow_down", intervalSeconds: typeof raw.interval === "number" ? raw.interval : undefined };
        return { status: "failed", message: `GitHub device flow failed: ${raw.error}${typeof raw.error_description === "string" ? ` — ${raw.error_description.slice(0, 160)}` : ""}` };
      }
      return { status: "failed", message: "GitHub device token response is missing fields" };
    },
  });
}

/** Bearer <github token> → the Copilot token (`access`) + expiry; the GitHub token stays `refresh`. */
async function exchangeCopilotToken(ep: GitHubCopilotEndpoints, githubToken: string, deps: OAuthDeps, signal: AbortSignal | undefined): Promise<OAuthCredential> {
  const res = await fetchOrCancel(deps, ep.copilotTokenUrl, {
    headers: { Accept: "application/json", Authorization: `Bearer ${githubToken}`, ...COPILOT_HEADERS },
  }, signal);
  if (!res.ok) throw await httpFailure("Copilot token exchange", res);
  const raw = await jsonObject(res, "Copilot token exchange");
  const { token, expires_at: expiresAt } = raw;
  if (typeof token !== "string" || token.length === 0 || typeof expiresAt !== "number") throw new Error("Copilot token response is missing fields");
  return { type: "oauth", access: token, refresh: githubToken, expires: expiresAt * 1000 - EXPIRY_SKEW_MS };
}

export function githubCopilotOAuth(endpoints: GitHubCopilotEndpoints = GITHUB_COPILOT_ENDPOINTS): OAuthProvider {
  return {
    id: "github-copilot",
    label: "GitHub Copilot (device code)",
    defaultModel: GITHUB_COPILOT_DEFAULT_MODEL,
    async login(io: OAuthLoginIO, deps: OAuthDeps): Promise<OAuthCredential> {
      const device = await startDeviceFlow(endpoints, deps, io.signal);
      io.notify({ type: "device_code", userCode: device.userCode, verificationUri: device.verificationUri, intervalSeconds: device.interval ?? 5, expiresInSeconds: device.expiresIn });
      const githubToken = await pollAccessToken(endpoints, device, deps, io.signal);
      io.notify({ type: "progress", message: "authorized — exchanging for a Copilot token" });
      return exchangeCopilotToken(endpoints, githubToken, deps, io.signal);
    },
    refresh(cred, signal, deps) {
      return exchangeCopilotToken(endpoints, cred.refresh, deps, signal);
    },
    toAuth(cred) {
      return { apiKey: cred.access, baseUrl: endpoints.chatBaseUrl ?? baseUrlFromCopilotToken(cred.access) ?? DEFAULT_BASE_URL, headers: { ...COPILOT_HEADERS } };
    },
  };
}
