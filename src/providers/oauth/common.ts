/** OAuth provider seam — shared types and the two message helpers (port #66).
 *
 *  Pattern: pi's `OAuthAuth` interface (earendil-works/pi packages/ai/src/auth/types.ts, MIT): a provider
 *  is {login, refresh, toAuth}; login talks to the terminal only through `notify` (device code + URL,
 *  auth URL, progress) so the CLI renderer (cli/auth-login.ts) and the tests are the only writers of
 *  output, and every network/clock/timer dependency is injected (`OAuthDeps`) so the flows run against
 *  in-process fake servers with no real timers.
 *
 *  Hygiene rule for every module in this directory: no access token, refresh token, GitHub token,
 *  device code, PKCE verifier or authorization code ever reaches a notice, an error message or a thrown
 *  value. `httpFailure` exists so HTTP errors report the status and the JSON `error` code only — never
 *  the raw body. */

import type { StoredOAuthCredential } from "../auth.ts";

/** the stored record (providers/auth.ts owns the shape; pi's OAuthCredential) */
export type OAuthCredential = StoredOAuthCredential;

/** fetch without Bun's extra static members — the injectable network dependency */
export type FetchFn = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface OAuthDeps {
  fetch: FetchFn;
  /** ms since the epoch (expiry arithmetic; tests pin a fixed clock) */
  now: () => number;
  /** abortable delay used by the device-code poller (tests record the requested intervals) */
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** What a login flow tells the terminal. Never carries a token. */
export type OAuthNotice =
  | { type: "device_code"; userCode: string; verificationUri: string; intervalSeconds: number; expiresInSeconds: number }
  | { type: "auth_url"; url: string; callbackUrl: string }
  | { type: "progress"; message: string };

export interface OAuthLoginIO {
  notify: (notice: OAuthNotice) => void;
  /** Ctrl-C in the CLI; aborting rejects the login with `loginCancelled()` */
  signal: AbortSignal;
}

/** What the provider seam sends per request, derived from the current credential. */
export interface OAuthAuth {
  apiKey: string;
  baseUrl: string;
  headers?: Record<string, string>;
  /** port #75: pin the OpenAI wire (the ChatGPT token → "responses"); unset = the seam's default rule (wire-select.ts) */
  wire?: "responses" | "chat";
}

export interface OAuthProvider {
  /** rovecode provider id (github-copilot | openrouter | openai) */
  id: string;
  label: string;
  defaultModel?: string;
  login(io: OAuthLoginIO, deps: OAuthDeps): Promise<OAuthCredential>;
  /** Mint a new access token from `cred.refresh`. Throws a token-free Error on failure. */
  refresh(cred: OAuthCredential, signal: AbortSignal | undefined, deps: OAuthDeps): Promise<OAuthCredential>;
  toAuth(cred: OAuthCredential): OAuthAuth;
}

export const LOGIN_CANCELLED = "login cancelled";

export function loginCancelled(): Error {
  return new Error(LOGIN_CANCELLED);
}

/** `<what> failed (HTTP <status>[: <error code>[ — <description>]])` — the JSON `error` string /
 *  `error.code` and `error_description` are the only body fields ever surfaced. */
export async function httpFailure(what: string, res: Response): Promise<Error> {
  let detail = "";
  try {
    const body = (await res.json()) as { error?: unknown; error_description?: unknown } | null;
    const err = body?.error;
    const code = typeof err === "string" ? err : typeof err === "object" && err !== null && typeof (err as { code?: unknown }).code === "string" ? (err as { code: string }).code : "";
    const description = typeof body?.error_description === "string" ? body.error_description : "";
    if (code) detail = `: ${code.slice(0, 80)}${description ? ` — ${description.slice(0, 160)}` : ""}`;
  } catch {
    // non-JSON body: status alone
  }
  return new Error(`${what} failed (HTTP ${res.status})${detail}`);
}

/** Parse a JSON body into a plain object or throw a token-free error. */
export async function jsonObject(res: Response, what: string): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    throw new Error(`${what}: response is not JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error(`${what}: response is not a JSON object`);
  return parsed as Record<string, unknown>;
}

/** Rethrow a fetch failure as `loginCancelled()` when the login signal fired, else as itself. */
export async function fetchOrCancel(deps: OAuthDeps, url: string, init: RequestInit, signal: AbortSignal | undefined): Promise<Response> {
  if (signal?.aborted) throw loginCancelled();
  try {
    return await deps.fetch(url, { ...init, signal });
  } catch (e) {
    if (signal?.aborted) throw loginCancelled();
    throw e;
  }
}
