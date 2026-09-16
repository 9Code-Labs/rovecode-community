/** MCP server OAuth (port #76): the rovecode `OAuthClientProvider` behind the MCP SDK's `authProvider` seam, the
 *  stored record beside the API keys, the `rovecode mcp login <name>` flow and the runtime provider factory.
 *
 *  Design: the SDK does the protocol — bearer injection (client/streamableHttp.js `_commonHeaders`, sse.js alike),
 *  401 → `auth()` (RFC 9728 protected-resource discovery → RFC 8414 AS metadata → RFC 7591 dynamic registration →
 *  PKCE S256 authorization-code flow, or `grant_type=refresh_token` when a refresh token is stored; one retry after
 *  `invalidateCredentials`) and the 401-after-auth circuit breaker. rovecode supplies ONLY persistence, the loopback
 *  redirect (providers/oauth/loopback.ts, the #66 server) and the CLI (cli/mcp-login.ts). Two provider modes:
 *  - LOGIN (`McpLoginAuthProvider`, `rovecode mcp login`): the callback server is bound FIRST so the ephemeral
 *    redirect_uri is known before dynamic registration — pattern: google-gemini/gemini-cli
 *    packages/core/src/mcp/oauth-provider.ts:399-405 "start callback server first to allocate port" (Apache-2.0,
 *    pattern level, no code copied; snapshot research/source_snapshots/google-gemini-gemini-cli @ 0bd1d43);
 *    registration is fresh per login (`token_endpoint_auth_method: "none"`, never a client_secret) unless
 *    `oauth.clientId` is configured; `state` is the callback path nonce; the authorize URL reaches the terminal as the
 *    #66 `auth_url` notice (nothing opens a browser); the accepted code is exchanged through `auth(…, {authorizationCode})`.
 *  - RUNTIME (`McpRuntimeAuthProvider`, a connect): the stored record is the whole session — `clientInformation()` and
 *    `discoveryState()` come from it (no .well-known, no /register in-session), a 401 refreshes ONCE and persists the
 *    new tokens before the retried request, and everything that would need a browser throws `McpNeedsLoginError`,
 *    whose text is the remedy `needs login — run \`rovecode mcp login <name>\``. The SDK registers BEFORE it calls
 *    `saveClientInformation` (client/auth.js authInternal), so a `clientInformation()` that refuses is the guard that
 *    keeps /register at 0; `saveClientInformation` throws too, as the second fence. Refreshes are capped at one per
 *    provider instance (= per connect) — the legacy SSE transport has no circuit breaker of its own.
 *  Record (providers/auth.ts owns the shape): `credentials.json` id `mcp:<name>`, `type: "mcp-oauth"`, fields `url`
 *  (attached only when it EQUALS the configured url), `access`, `refresh`, `expires` (ms), `clientInformation`,
 *  `discovery`. Never for stdio; never when a static `headers.Authorization` is configured — static auth wins. No
 *  token, verifier or code reaches a message: SDK errors are wrapped as `<what> failed (<ErrorClass>[: <oauth error>])`
 *  because a `ServerError` embeds the response body. opencode packages/opencode/src/mcp/oauth-provider.ts (MIT) was
 *  read for the provider-class shape over the same seam; its fixed callback port is deliberately not followed. Not
 *  live-verified against a remote OAuth MCP server (none on this box) — verified against the in-process fake in
 *  test/helpers/mcp-oauth-fixtures.ts. */

import { auth, extractWWWAuthenticateParams, type OAuthClientProvider, type OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import { OAuthError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { isMcpOAuthRecord, readEntry, writeEntry, type StoredMcpOAuthRecord } from "../providers/auth.ts";
import { LOGIN_CANCELLED, fetchOrCancel, loginCancelled, type OAuthDeps, type OAuthLoginIO } from "../providers/oauth/common.ts";
import { startLoopbackCallback } from "../providers/oauth/loopback.ts";
import { randomState } from "../providers/oauth/pkce.ts";
import type { McpServerConfig } from "./config.ts";
import { McpNeedsLoginError, hasStaticAuthorization, needsLoginText } from "./shared.ts";
import pkg from "../../package.json";

export type McpOAuthRecord = StoredMcpOAuthRecord;
type ClientInfo = NonNullable<McpOAuthRecord["clientInformation"]>;

/** the credentials.json id of a server's record */
export function mcpOAuthId(name: string): string {
  return `mcp:${name}`;
}

// needsLoginText / McpNeedsLoginError / hasStaticAuthorization live in shared.ts (SDK-free, so transport.ts can
// name the remedy without loading this module); re-exported here because this is where callers look for them.
export { McpNeedsLoginError, hasStaticAuthorization, needsLoginText };

/** The stored record for `name`, or undefined when absent, malformed, or bound to a different url. */
export function loadMcpOAuth(name: string, url: string | undefined): McpOAuthRecord | undefined {
  const raw = readEntry(mcpOAuthId(name));
  if (url === undefined || !isMcpOAuthRecord(raw) || raw.url !== url) return undefined;
  return raw;
}

export function saveMcpOAuth(name: string, record: McpOAuthRecord): void {
  writeEntry(mcpOAuthId(name), record);
}

function expiresAt(tokens: OAuthTokens, now: number): number {
  return typeof tokens.expires_in === "number" && Number.isFinite(tokens.expires_in) ? now + Math.max(0, tokens.expires_in) * 1000 : Number.MAX_SAFE_INTEGER;
}

/** a configured `oauth.clientId` beats whatever registration produced */
function knownClient(config: McpServerConfig, stored: ClientInfo | undefined): ClientInfo | undefined {
  const id = config.oauth?.clientId;
  return id ? { client_id: id } : stored;
}

/** what of a registration answer is kept: the id plus a DCR-issued secret and its dates when the server sent them */
function pickClientInfo(info: OAuthClientInformationMixed): ClientInfo {
  const out: ClientInfo = { client_id: info.client_id };
  if (typeof info.client_secret === "string") out.client_secret = info.client_secret;
  if (typeof info.client_id_issued_at === "number") out.client_id_issued_at = info.client_id_issued_at;
  if (typeof info.client_secret_expires_at === "number") out.client_secret_expires_at = info.client_secret_expires_at;
  return out;
}

function clientMetadataFor(redirectUri: string, scope: string | undefined): OAuthClientMetadata {
  return {
    client_name: "rovecode", redirect_uris: [redirectUri], grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"], token_endpoint_auth_method: "none", ...(scope ? { scope } : {}),
  };
}

function discoveryOf(record: McpOAuthRecord): OAuthDiscoveryState | undefined {
  const d = record.discovery;
  return d !== undefined && typeof d.authorizationServerUrl === "string" ? (d as unknown as OAuthDiscoveryState) : undefined;
}

/** truthy so the SDK never takes its non-interactive (client_credentials) branch; never sent — the runtime provider
 *  throws before any redirect could carry it */
const RUNTIME_REDIRECT = "http://127.0.0.1/callback/needs-login";

/** Runtime mode: the stored record, refresh once, everything else is `needs login`. */
export class McpRuntimeAuthProvider implements OAuthClientProvider {
  private refreshes = 0;
  constructor(private readonly config: McpServerConfig, private record: McpOAuthRecord, private readonly now: () => number = Date.now) {}
  get redirectUrl(): string { return RUNTIME_REDIRECT; }
  get clientMetadata(): OAuthClientMetadata { return clientMetadataFor(RUNTIME_REDIRECT, this.config.oauth?.scope); }
  /** the configured or registered client — refusing HERE (before the SDK's registerClient) keeps /register at 0 */
  clientInformation(): OAuthClientInformationMixed {
    const info = knownClient(this.config, this.record.clientInformation);
    if (!info) throw new McpNeedsLoginError(this.config.name);
    return info;
  }
  saveClientInformation(): never { throw new McpNeedsLoginError(this.config.name); }
  discoveryState(): OAuthDiscoveryState | undefined { return discoveryOf(this.record); }
  saveDiscoveryState(state: OAuthDiscoveryState): void { this.persist({ ...this.record, discovery: state as unknown as Record<string, unknown> }); }
  tokens(): OAuthTokens | undefined {
    const { access, refresh, expires } = this.record;
    if (access.length === 0) return undefined;
    const t: OAuthTokens = { access_token: access, token_type: "Bearer" };
    // ONE refresh per connect: afterwards the SDK sees no refresh token, asks for a browser, and gets the remedy
    if (refresh.length > 0 && this.refreshes === 0) t.refresh_token = refresh;
    if (expires < Number.MAX_SAFE_INTEGER) t.expires_in = Math.max(0, Math.floor((expires - this.now()) / 1000));
    return t;
  }
  /** the refreshed tokens — persisted BEFORE the SDK retries the request; the refresh token is kept when none came back */
  saveTokens(tokens: OAuthTokens): void {
    this.refreshes += 1;
    this.persist({ ...this.record, access: tokens.access_token, refresh: tokens.refresh_token ?? this.record.refresh, expires: expiresAt(tokens, this.now()) });
  }
  redirectToAuthorization(): never { throw new McpNeedsLoginError(this.config.name); }
  saveCodeVerifier(): void { /* the SDK calls this right before redirectToAuthorization, which throws */ }
  codeVerifier(): never { throw new McpNeedsLoginError(this.config.name); }
  /** field-level: 'tokens' keeps the client and discovery so the SDK's own retry never registers; `url` always stays */
  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    const next: McpOAuthRecord = { ...this.record };
    if (scope === "all" || scope === "tokens") { next.access = ""; next.refresh = ""; next.expires = 0; }
    if (scope === "all" || scope === "client") delete next.clientInformation;
    if (scope === "all" || scope === "discovery") delete next.discovery;
    this.persist(next);
  }
  private persist(next: McpOAuthRecord): void {
    this.record = next;
    saveMcpOAuth(this.config.name, next);
  }
}

/** Login mode: in-memory registration + verifier, the bound callback as redirect, the notice as the redirect. */
export class McpLoginAuthProvider implements OAuthClientProvider {
  private registered: ClientInfo | undefined;
  private verifier: string | undefined;
  private discovery: OAuthDiscoveryState | undefined;
  /** the record saveTokens wrote (the flow returns it) */
  stored: McpOAuthRecord | undefined;
  constructor(private readonly config: McpServerConfig, private readonly callbackUrl: string, private readonly nonce: string, private readonly io: OAuthLoginIO, private readonly now: () => number) {}
  get redirectUrl(): string { return this.callbackUrl; }
  get clientMetadata(): OAuthClientMetadata { return clientMetadataFor(this.callbackUrl, this.config.oauth?.scope); }
  state(): string { return this.nonce; }
  clientInformation(): OAuthClientInformationMixed | undefined { return knownClient(this.config, this.registered); }
  /** memory only: registration is fresh per login because the ephemeral redirect port changes */
  saveClientInformation(info: OAuthClientInformationMixed): void { this.registered = pickClientInfo(info); }
  discoveryState(): OAuthDiscoveryState | undefined { return this.discovery; }
  saveDiscoveryState(state: OAuthDiscoveryState): void { this.discovery = state; }
  /** a login always starts the browser flow */
  tokens(): undefined { return undefined; }
  saveTokens(tokens: OAuthTokens): void {
    const info = this.clientInformation();
    const record: McpOAuthRecord = {
      type: "mcp-oauth", url: this.config.url ?? "", access: tokens.access_token, refresh: tokens.refresh_token ?? "", expires: expiresAt(tokens, this.now()),
      ...(info ? { clientInformation: pickClientInfo(info) } : {}),
      ...(this.discovery ? { discovery: this.discovery as unknown as Record<string, unknown> } : {}),
    };
    saveMcpOAuth(this.config.name, record);
    this.stored = record;
  }
  redirectToAuthorization(url: URL): void { this.io.notify({ type: "auth_url", url: url.toString(), callbackUrl: this.callbackUrl }); }
  saveCodeVerifier(verifier: string): void { this.verifier = verifier; }
  codeVerifier(): string {
    if (this.verifier === undefined) throw new Error("no PKCE verifier for this login");
    return this.verifier;
  }
}

/** `<what> failed (<ErrorClass>[: <oauth error code>])` — an OAuthError's message may embed the response body
 *  (ServerError), so only its class and code are surfaced; other errors are SDK-built and token-free, clipped. */
function wrapSdkError(what: string, err: unknown): Error {
  if (err instanceof McpNeedsLoginError || (err instanceof Error && err.message === LOGIN_CANCELLED)) return err;
  if (err instanceof OAuthError) return new Error(`${what} failed (${err.name}: ${err.errorCode})`);
  const detail = err instanceof Error ? `${err.constructor.name}: ${err.message.slice(0, 200)}` : String(err).slice(0, 200);
  return new Error(`${what} failed (${detail})`);
}

const PROBE_BODY = JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "rovecode", version: pkg.version } } });

export interface McpLoginFlowDeps extends OAuthDeps {
  /** loopback wait budget (default 5 minutes) */
  timeoutMs?: number;
}

/** The whole login: bind the callback → probe once (must be 401) → SDK auth() to the redirect → the browser's code →
 *  SDK auth() exchange → the stored record. Throws token-free Errors; loginCancelled() when `io.signal` fired. */
export async function runMcpLoginFlow(config: McpServerConfig, io: OAuthLoginIO, deps: McpLoginFlowDeps): Promise<McpOAuthRecord> {
  const name = config.name;
  if (config.transport === "stdio" || config.url === undefined) throw new Error(`MCP server "${name}" is a stdio server — OAuth login applies to url servers only`);
  if (io.signal.aborted) throw loginCancelled();
  const url = config.url;
  const what = `MCP server "${name}"`;
  const nonce = randomState();
  let provider: McpLoginAuthProvider | undefined;
  let seed: { resourceMetadataUrl?: URL; scope?: string } = {};
  // bound FIRST: dynamic registration needs the real redirect_uri (gemini-cli oauth-provider.ts:399-405)
  const callback = startLoopbackCallback<McpOAuthRecord>({
    nonce, signal: io.signal, what, retryHint: `Run rovecode mcp login ${name} again.`, exchange: "token exchange", requireStateParam: true,
    ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
    onCode: async (code) => {
      if (!provider) throw new Error(`${what} token exchange failed (callback before the authorization request)`);
      const result = await auth(provider, { serverUrl: url, authorizationCode: code, resourceMetadataUrl: seed.resourceMetadataUrl, scope: seed.scope, fetchFn: deps.fetch })
        .catch((e: unknown) => { throw wrapSdkError(`${what} token exchange`, e); });
      if (result !== "AUTHORIZED" || !provider.stored) throw new Error(`${what} token exchange failed (no tokens were issued)`);
      return provider.stored;
    },
  });
  try {
    // ONE probe — an initialize POST: anything but 401 means the server does not gate on OAuth
    let res: Response;
    try {
      res = await fetchOrCancel(deps, url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: PROBE_BODY }, io.signal);
    } catch (e) {
      throw e instanceof Error && e.message === LOGIN_CANCELLED ? e : new Error(`${what} probe failed (${e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200)})`);
    }
    await res.body?.cancel().catch(() => {});
    if (res.status !== 401) throw new Error(`server does not require OAuth (HTTP ${res.status})`);
    seed = extractWWWAuthenticateParams(res);
    provider = new McpLoginAuthProvider(config, callback.callbackUrl, nonce, io, deps.now);
    const first = await auth(provider, { serverUrl: url, resourceMetadataUrl: seed.resourceMetadataUrl, scope: seed.scope, fetchFn: deps.fetch })
      .catch((e: unknown) => { throw wrapSdkError(`${what} authorization`, e); });
    if (first !== "REDIRECT") throw new Error(`${what} authorization failed (expected a browser redirect, got ${first})`);
    return await callback.result;
  } finally {
    callback.stop();
  }
}

/** The provider a connect attaches: stdio → none; a static Authorization header → none (static auth wins); no valid
 *  record for THIS url → none (a 401 then surfaces as the SDK's 401 error, which transport.ts maps to the remedy). */
export function runtimeAuthProvider(config: McpServerConfig): OAuthClientProvider | undefined {
  if (config.transport === "stdio" || config.url === undefined) return undefined;
  if (hasStaticAuthorization(config)) return undefined;
  const record = loadMcpOAuth(config.name, config.url);
  return record ? new McpRuntimeAuthProvider(config, record) : undefined;
}
