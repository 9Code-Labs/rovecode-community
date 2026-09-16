/** OpenRouter OAuth PKCE (port #66): browser authorization → loopback callback → key exchange.
 *
 *  Ported from pi packages/ai/src/auth/oauth/openrouter.ts (earendil-works/pi, MIT — Copyright (c) 2025
 *  Mario Zechner; snapshot under research/source_snapshots/earendil-works-pi). Kept as pi has it:
 *  - S256 PKCE; the authorize URL is https://openrouter.ai/auth?callback_url=…&code_challenge=…&
 *    code_challenge_method=S256 (OpenRouter has no client registration and no `state` parameter);
 *  - a one-shot loopback HTTP server on an ephemeral port receives `?code=`, POSTs
 *    {code, code_verifier, code_challenge_method} to /api/v1/auth/keys and gets a PERMANENT,
 *    user-controlled API key — stored as `access` with `refresh: ""` and `expires: MAX_SAFE_INTEGER`
 *    (refresh is the identity); `?error=` aborts; a second callback is refused (409);
 *  - the server closes when the login settles (success, error, cancel, or the 5-minute timeout).
 *  The callback server itself — GET-only, loopback-Host-only, the `/callback/<32-byte nonce>` path whose mismatch is
 *  a 400 that ABORTS the login (pi randomizes the path with a UUID as its CSRF defence), the 409 single-use guard
 *  from the moment an outcome is decided, the exchange-before-200 ordering, the URL built from the BOUND server —
 *  lives in loopback.ts since port #76 (the MCP login shares it); every message here is unchanged. No `state` query
 *  parameter is appended to callback_url: whether OpenRouter preserves a query string on the redirect is not
 *  live-verified, and a wrong guess would abort every real login.
 *  Deviations: no manual paste-the-redirect-URL fallback (pi races a prompt — follow-up); the server
 *  is Bun.serve (pi: node:http); nothing opens a browser — the URL is printed.
 *  Not live-verified on this box (no OpenRouter account) — see README. */

import { fetchOrCancel, httpFailure, jsonObject, loginCancelled, type OAuthCredential, type OAuthDeps, type OAuthLoginIO, type OAuthProvider } from "./common.ts";
import { startLoopbackCallback, stateMismatchMessage } from "./loopback.ts";
import { generatePKCE, randomState } from "./pkce.ts";

export { CALLBACK_HOST } from "./loopback.ts";

export interface OpenRouterEndpoints {
  authorizeUrl: string;
  keysUrl: string;
  chatBaseUrl: string;
}

export const OPENROUTER_ENDPOINTS: OpenRouterEndpoints = {
  authorizeUrl: "https://openrouter.ai/auth",
  keysUrl: "https://openrouter.ai/api/v1/auth/keys",
  chatBaseUrl: "https://openrouter.ai/api/v1",
};

export const STATE_MISMATCH = stateMismatchMessage("OpenRouter");

async function exchangeCode(ep: OpenRouterEndpoints, code: string, verifier: string, deps: OAuthDeps, signal: AbortSignal): Promise<string> {
  const res = await fetchOrCancel(deps, ep.keysUrl, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: "S256" }),
  }, signal);
  if (!res.ok) throw await httpFailure("OpenRouter key exchange", res);
  const body = await jsonObject(res, "OpenRouter key exchange");
  if (typeof body.key !== "string" || body.key.length === 0) throw new Error("OpenRouter key exchange: response carries no key");
  return body.key;
}

async function loginOpenRouter(ep: OpenRouterEndpoints, io: OAuthLoginIO, deps: OAuthDeps): Promise<OAuthCredential> {
  if (io.signal.aborted) throw loginCancelled();
  const { verifier, challenge } = await generatePKCE();
  const state = randomState();
  const callback = startLoopbackCallback<OAuthCredential>({
    nonce: state,
    signal: io.signal,
    what: "OpenRouter",
    retryHint: "Run rovecode auth login openrouter again.",
    // the code is exchanged for the permanent key BEFORE the browser gets its 200 (a failure is a 502 page)
    onCode: async (code) => ({ type: "oauth", access: await exchangeCode(ep, code, verifier, deps, io.signal), refresh: "", expires: Number.MAX_SAFE_INTEGER }),
  });
  const authorize = new URL(ep.authorizeUrl);
  authorize.search = new URLSearchParams({ callback_url: callback.callbackUrl, code_challenge: challenge, code_challenge_method: "S256" }).toString();
  try {
    io.notify({ type: "auth_url", url: authorize.toString(), callbackUrl: callback.callbackUrl });
    return await callback.result;
  } finally {
    callback.stop();
  }
}

export function openRouterOAuth(endpoints: OpenRouterEndpoints = OPENROUTER_ENDPOINTS): OAuthProvider {
  return {
    id: "openrouter",
    label: "OpenRouter (PKCE, browser + loopback callback)",
    login: (io, deps) => loginOpenRouter(endpoints, io, deps),
    // OpenRouter issues a permanent key: nothing to refresh (pi returns the credential unchanged)
    async refresh(cred) {
      return cred;
    },
    toAuth(cred) {
      return { apiKey: cred.access, baseUrl: endpoints.chatBaseUrl };
    },
  };
}
