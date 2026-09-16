/** Port #76 fixture: ONE in-process Bun.serve on 127.0.0.1:0 that is BOTH the OAuth-protected MCP resource server and
 *  its authorization server, so every claim of the MCP OAuth port is checked over real HTTP with no network:
 *  - `POST|GET /mcp` (streamable HTTP) and `GET /sse` + `POST /messages` (legacy SSE): 401 with
 *    `WWW-Authenticate: Bearer resource_metadata="…", scope="…"` unless `Authorization: Bearer <a currently valid access
 *    token>`; authorized → a stateless SDK `WebStandardStreamableHTTPServerTransport` (JSON responses; GET answers 405 —
 *    no standalone stream) or the SSE session, over a low-level `Server` with one `ping` tool (the mcp-sse.test.ts server);
 *  - RFC 9728 PRM at `/.well-known/oauth-protected-resource[/mcp]`, RFC 8414 AS metadata at
 *    `/.well-known/oauth-authorization-server` (S256, authorization_code + refresh_token, auth method none, a registration
 *    endpoint), RFC 7591 `POST /register`, `GET /authorize` (never fetched by the SDK — counted so a test can prove it;
 *    the test plays the browser through `mintCode`), `POST /token` verifying S256(code_verifier) == the challenge the code
 *    was minted for plus redirect_uri and client_id (authorization_code, single use) or the current refresh token
 *    (refresh_token — rotates the access canary; knobs: failRefresh, omitRefreshOnRefresh, registerBody);
 *  - per-route counters, every request's method/path/authorization, every /token body, every registration body,
 *    `revoke()` (the current access token stops being accepted until a refresh), `acceptToken()` (a static bearer the
 *    server also honours) and `hooks.onAuthorized` (called with every authorized MCP request before it is handled).
 *  Deadlines are the caller's (`deadline()` below, the mcp-sse.test.ts helper). Every token is a CANARY the tests grep out. */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { base64url } from "../../src/providers/oauth/pkce.ts";

export const ACCESS_PREFIX = "mcp-access-CANARY-";
export const REFRESH_PREFIX = "mcp-refresh-CANARY-";
export const SCOPE = "mcp:tools";

export interface Seen { method: string; path: string; auth: string | null }
export interface MintedCode { challenge: string; redirectUri: string; clientId: string }
export interface FixtureKnobs {
  /** the /token answer to a refresh_token grant: an OAuth error code (400; server_error → 500) */
  failRefresh?: "invalid_grant" | "invalid_client" | "server_error";
  /** a refresh answer without a new refresh_token (the client must keep the old one) */
  omitRefreshOnRefresh?: boolean;
  /** /register answers 500 with this raw body (a ServerError whose message embeds the body) */
  registerBody?: string;
  /** the refreshed access token is rejected too (a 401 AFTER a completed refresh) */
  revokeAfterRefresh?: boolean;
}

export interface McpOAuthFixture {
  base: string;
  mcpUrl: string;
  sseUrl: string;
  /** hits per route: "/mcp", "/sse", "/messages", ".well-known", "/register", "/authorize", "/token" */
  counts: Record<string, number>;
  seen: Seen[];
  tokenRequests: Record<string, string>[];
  registrations: Record<string, unknown>[];
  knobs: FixtureKnobs;
  hooks: { onAuthorized?: (req: Request) => void };
  /** the access / refresh token the server currently honours */
  readonly access: string;
  readonly refresh: string;
  /** the browser's half: an authorization code bound to the authorize URL's challenge / redirect_uri / client_id */
  mintCode(bound: MintedCode): string;
  /** the current access token stops being accepted (revoked / expired) until a refresh mints a new one */
  revoke(): void;
  /** a static bearer the server honours besides its own tokens */
  acceptToken(token: string): void;
  /** the metadata the server publishes for the resource at `path` ("/mcp" | "/sse"), in the SDK's persisted discovery
   *  shape — a hand-built record carrying it needs no .well-known round trip */
  discoveryState(path?: string): Record<string, unknown>;
  count(route: string): number;
  stop(): void;
}

/** Bounded await: a hang is a FAILURE here, never a stuck bun process. */
export function deadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const bomb = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error(`${what}: not settled within ${ms}ms`)), ms); });
  return Promise.race([p, bomb]).finally(() => clearTimeout(t));
}

export async function s256(verifier: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

function pingServer(): Server {
  const server = new Server({ name: "fake-oauth-mcp", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "ping", description: "answers pong", inputSchema: { type: "object" } }] }));
  server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: "text", text: "pong" }] }));
  return server;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

export function startMcpOAuthFixture(): McpOAuthFixture {
  const counts: Record<string, number> = {};
  const bump = (k: string): void => { counts[k] = (counts[k] ?? 0) + 1; };
  const seen: Seen[] = [];
  const tokenRequests: Record<string, string>[] = [];
  const registrations: Record<string, unknown>[] = [];
  const codes = new Map<string, MintedCode>();
  const statics = new Set<string>();
  const sessions = new Map<string, Transport>();
  const knobs: FixtureKnobs = {};
  const hooks: McpOAuthFixture["hooks"] = {};
  let serial = 0;
  let access = `${ACCESS_PREFIX}${serial}`;
  let refresh = `${REFRESH_PREFIX}${serial}`;
  let revoked = false;
  const mintAccess = (): void => { serial += 1; access = `${ACCESS_PREFIX}${serial}`; revoked = false; };
  const authorized = (req: Request): boolean => {
    const h = req.headers.get("authorization");
    if (!h?.startsWith("Bearer ")) return false;
    const t = h.slice(7);
    return statics.has(t) || (!revoked && t === access);
  };
  // RFC 9728: the PRM is per resource path (`/.well-known/oauth-protected-resource/mcp` describes `<base>/mcp`)
  const challenge = (base: string, path: string): Response =>
    json({ error: "unauthorized" }, 401, { "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource${path}", scope="${SCOPE}"` });
  const prm = (base: string, resourcePath: string): Record<string, unknown> => ({ resource: `${base}${resourcePath}`, authorization_servers: [base], scopes_supported: [SCOPE] });
  const asMetadata = (base: string): Record<string, unknown> => ({
    issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`,
    response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"], scopes_supported: [SCOPE],
  });

  const sseStream = (): Response => {
    const id = crypto.randomUUID();
    const enc = new TextEncoder();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(c) { controller = c; },
      cancel() { sessions.get(id)?.onclose?.(); sessions.delete(id); },
    });
    const write = (chunk: string): void => { try { controller.enqueue(enc.encode(chunk)); } catch { /* stream gone */ } };
    const transport: Transport = {
      async start() {},
      async send(message) { write(`event: message\ndata: ${JSON.stringify(message)}\n\n`); },
      async close() { try { controller.close(); } catch { /* already closed */ } sessions.delete(id); },
    };
    sessions.set(id, transport);
    void pingServer().connect(transport).then(() => write(`event: endpoint\ndata: /messages?sessionId=${id}\n\n`));
    return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
  };

  const srv = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const base = url.origin;
      const path = url.pathname;
      seen.push({ method: req.method, path, auth: req.headers.get("authorization") });
      if (path === "/mcp") {
        bump("/mcp");
        if (!authorized(req)) return challenge(base, "/mcp");
        hooks.onAuthorized?.(req);
        if (req.method === "GET") return new Response("no standalone stream", { status: 405 });
        const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        await pingServer().connect(transport);
        return transport.handleRequest(req);
      }
      if (path === "/sse") {
        bump("/sse");
        if (!authorized(req)) return challenge(base, "/sse");
        hooks.onAuthorized?.(req);
        if (req.method !== "GET") return new Response("nope", { status: 405 });
        return sseStream();
      }
      if (path === "/messages") {
        bump("/messages");
        if (!authorized(req)) return challenge(base, "/sse");
        hooks.onAuthorized?.(req);
        const t = sessions.get(url.searchParams.get("sessionId") ?? "");
        if (!t) return new Response("no such session", { status: 404 });
        t.onmessage?.((await req.json()) as JSONRPCMessage);
        return new Response("Accepted", { status: 202 });
      }
      if (path.startsWith("/.well-known/")) {
        bump(".well-known");
        if (path.startsWith("/.well-known/oauth-protected-resource")) return json(prm(base, path.slice("/.well-known/oauth-protected-resource".length)));
        if (path === "/.well-known/oauth-authorization-server") return json(asMetadata(base));
        return new Response("not found", { status: 404 });
      }
      if (path === "/register" && req.method === "POST") {
        bump("/register");
        if (knobs.registerBody !== undefined) return new Response(knobs.registerBody, { status: 500, headers: { "content-type": "text/plain" } });
        const body = (await req.json()) as Record<string, unknown>;
        registrations.push(body);
        return json({ client_id: `dcr-${registrations.length}`, client_id_issued_at: 1_700_000_000, ...body }, 201);
      }
      if (path === "/authorize") {
        bump("/authorize");
        return new Response("the test plays the browser — this endpoint is never fetched", { status: 400 });
      }
      if (path === "/token" && req.method === "POST") {
        bump("/token");
        const params = Object.fromEntries(new URLSearchParams(await req.text())) as Record<string, string>;
        tokenRequests.push(params);
        if (params.grant_type === "authorization_code") {
          const bound = codes.get(params.code ?? "");
          if (!bound) return json({ error: "invalid_grant", error_description: "unknown or used code" }, 400);
          codes.delete(params.code!); // single use
          if (bound.clientId !== params.client_id || bound.redirectUri !== params.redirect_uri) return json({ error: "invalid_grant", error_description: "client_id or redirect_uri mismatch" }, 400);
          if ((await s256(params.code_verifier ?? "")) !== bound.challenge) return json({ error: "invalid_grant", error_description: "PKCE verifier mismatch" }, 400);
          mintAccess();
          refresh = `${REFRESH_PREFIX}${serial}`;
          return json({ access_token: access, refresh_token: refresh, token_type: "Bearer", expires_in: 3600, scope: SCOPE });
        }
        if (params.grant_type === "refresh_token") {
          if (knobs.failRefresh !== undefined) return json({ error: knobs.failRefresh, error_description: "fixture knob" }, knobs.failRefresh === "server_error" ? 500 : 400);
          if (params.refresh_token !== refresh) return json({ error: "invalid_grant", error_description: "unknown refresh token" }, 400);
          mintAccess();
          if (knobs.revokeAfterRefresh) revoked = true;
          if (knobs.omitRefreshOnRefresh) return json({ access_token: access, token_type: "Bearer", expires_in: 3600 });
          refresh = `${REFRESH_PREFIX}${serial}`;
          return json({ access_token: access, refresh_token: refresh, token_type: "Bearer", expires_in: 3600 });
        }
        return json({ error: "unsupported_grant_type" }, 400);
      }
      return new Response("not found", { status: 404 });
    },
  });

  const base = `http://127.0.0.1:${srv.port}`;
  return {
    base, mcpUrl: `${base}/mcp`, sseUrl: `${base}/sse`, counts, seen, tokenRequests, registrations, knobs, hooks,
    get access() { return access; },
    get refresh() { return refresh; },
    mintCode(bound) {
      const code = `code-CANARY-${crypto.randomUUID()}`;
      codes.set(code, bound);
      return code;
    },
    revoke() { revoked = true; },
    acceptToken(token) { statics.add(token); },
    discoveryState(path = "/mcp") {
      return { authorizationServerUrl: base, resourceMetadataUrl: `${base}/.well-known/oauth-protected-resource${path}`, resourceMetadata: prm(base, path), authorizationServerMetadata: asMetadata(base) };
    },
    count(route) { return counts[route] ?? 0; },
    stop() { for (const t of sessions.values()) void t.close(); srv.stop(true); },
  };
}
