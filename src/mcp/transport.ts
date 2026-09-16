/** MCP transport construction + connect-error text (ported 2026-09-07 from the upstream harness's port #57/#76
 *  split of client.ts; the move changes no behaviour). `buildTransport` maps a config + wire to the SDK transport:
 *  the stdio child, streamable HTTP, or the legacy HTTP+SSE wire, with the static `headers` on every request and
 *  the rovecode `OAuthClientProvider` when one applies (mcp/oauth.ts runtimeAuthProvider): the SDK injects
 *  `Authorization: Bearer <access>` from it on every GET/POST of both url wires and runs its 401 → auth() pass;
 *  `requestInit.headers` is spread LAST inside the SDK (client/streamableHttp.js _commonHeaders, sse.js alike), and the
 *  factory hands out no provider when an Authorization header is configured, so static auth always wins.
 *  `describeError` turns a connect failure into the failed[] / status-row / mcp_call text: the SDK's StreamableHTTPError
 *  keeps the HTTP status only in `.code`, so a bare "Error POSTing to endpoint: nope" gets "(HTTP 500)" back; a 401 on a
 *  url server (either wire), the SDK's UnauthorizedError and McpNeedsLoginError all become the short remedy
 *  `needs login — run \`rovecode mcp login <name>\`` (≤ 80 chars for a 20-char name, so status.ts's clip keeps it whole) —
 *  a 401 against a configured static Authorization header names that header instead. Never a token.
 *
 *  Lazy SDK (rovecode): this module, like client.ts, imports only TYPES at load. The MCP SDK is ~200 ms of module
 *  evaluation (zod schemas for every protocol message) and used to be paid inside createRuntime, before the terminal
 *  had painted anything; mcp.test.ts pins that importing client.ts pulls in no @modelcontextprotocol module. So the
 *  SDK is loaded here once, on the first connect (`loadSdk`), and the error classes and the list_changed notification
 *  schemas come out of that same load. `describeError` / `isSseOnlySignature` are synchronous: before the SDK has
 *  loaded no SDK error can exist, so `sdkIfLoaded()` being null simply means the plain-message path. */

import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { message, type McpServerConfig } from "./config.ts";
import { McpNeedsLoginError, hasStaticAuthorization, needsLoginText } from "./shared.ts";

/** Everything the manager needs from the SDK, loaded together on the connect path. */
export interface Sdk {
  Client: typeof import("@modelcontextprotocol/sdk/client/index.js").Client;
  StdioClientTransport: typeof import("@modelcontextprotocol/sdk/client/stdio.js").StdioClientTransport;
  getDefaultEnvironment: typeof import("@modelcontextprotocol/sdk/client/stdio.js").getDefaultEnvironment;
  StreamableHTTPClientTransport: typeof import("@modelcontextprotocol/sdk/client/streamableHttp.js").StreamableHTTPClientTransport;
  StreamableHTTPError: typeof import("@modelcontextprotocol/sdk/client/streamableHttp.js").StreamableHTTPError;
  SSEClientTransport: typeof import("@modelcontextprotocol/sdk/client/sse.js").SSEClientTransport;
  SseError: typeof import("@modelcontextprotocol/sdk/client/sse.js").SseError;
  UnauthorizedError: typeof import("@modelcontextprotocol/sdk/client/auth.js").UnauthorizedError;
  ToolListChangedNotificationSchema: typeof import("@modelcontextprotocol/sdk/types.js").ToolListChangedNotificationSchema;
  PromptListChangedNotificationSchema: typeof import("@modelcontextprotocol/sdk/types.js").PromptListChangedNotificationSchema;
  ResourceListChangedNotificationSchema: typeof import("@modelcontextprotocol/sdk/types.js").ResourceListChangedNotificationSchema;
}

let sdkPromise: Promise<Sdk> | null = null;
let loaded: Sdk | null = null;

/** The SDK, loaded once (all six modules together) — the first connect pays it, nothing at boot does. */
export function loadSdk(): Promise<Sdk> {
  sdkPromise ??= Promise.all([
    import("@modelcontextprotocol/sdk/client/index.js"),
    import("@modelcontextprotocol/sdk/client/stdio.js"),
    import("@modelcontextprotocol/sdk/client/streamableHttp.js"),
    import("@modelcontextprotocol/sdk/client/sse.js"),
    import("@modelcontextprotocol/sdk/client/auth.js"),
    import("@modelcontextprotocol/sdk/types.js"),
  ]).then(([index, stdio, http, sse, auth, types]) => {
    loaded = {
      Client: index.Client,
      StdioClientTransport: stdio.StdioClientTransport,
      getDefaultEnvironment: stdio.getDefaultEnvironment,
      StreamableHTTPClientTransport: http.StreamableHTTPClientTransport,
      StreamableHTTPError: http.StreamableHTTPError,
      SSEClientTransport: sse.SSEClientTransport,
      SseError: sse.SseError,
      UnauthorizedError: auth.UnauthorizedError,
      ToolListChangedNotificationSchema: types.ToolListChangedNotificationSchema,
      PromptListChangedNotificationSchema: types.PromptListChangedNotificationSchema,
      ResourceListChangedNotificationSchema: types.ResourceListChangedNotificationSchema,
    };
    return loaded;
  });
  return sdkPromise;
}

/** The SDK once loadSdk() has resolved; null before (and then no SDK-built error can exist yet). */
export function sdkIfLoaded(): Sdk | null {
  return loaded;
}

/** The initialize POST hitting an SSE-only server: 404 (no such route) or 405 (GET-only route). */
export function isSseOnlySignature(err: unknown): boolean {
  const sdk = loaded;
  return sdk !== null && err instanceof sdk.StreamableHTTPError && (err.code === 404 || err.code === 405);
}

/** a 401 from either url wire: StreamableHTTPError / SseError carry it in `.code`; the SSE POST path only in its text */
function isUnauthorized(err: unknown): boolean {
  const sdk = loaded;
  if (sdk !== null && (err instanceof sdk.StreamableHTTPError || err instanceof sdk.SseError)) return err.code === 401;
  return err instanceof Error && /\(HTTP 401\)/.test(err.message);
}

/** Error text for failed[] / status rows / mcp_call (see the header). */
export function describeError(err: unknown, config: Pick<McpServerConfig, "name" | "headers">): string {
  if (err instanceof McpNeedsLoginError) return err.message;
  const sdk = loaded;
  if ((sdk !== null && err instanceof sdk.UnauthorizedError) || isUnauthorized(err)) {
    return hasStaticAuthorization(config) ? "HTTP 401 — the configured Authorization header was rejected" : needsLoginText(config.name);
  }
  const text = message(err);
  return sdk !== null && err instanceof sdk.StreamableHTTPError && typeof err.code === "number" && err.code > 0 && !text.includes(String(err.code)) ? `${text} (HTTP ${err.code})` : text;
}

/** The SDK transport for one config on one wire (the http → sse fallback calls this twice). */
export async function buildTransport(config: McpServerConfig, wire: McpServerConfig["transport"], authProvider?: OAuthClientProvider): Promise<Transport> {
  const sdk = await loadSdk();
  if (wire === "http" || wire === "sse") {
    if (config.url === undefined) throw new Error(`${wire} server "${config.name}" has no url`);
    // headers (auth tokens etc.) ride on every request via fetch's RequestInit — the SSE transport applies them to
    // the GET stream and to each POST alike; the provider (port #76) is the SDK's own bearer + 401-refresh seam
    const opts = {
      ...(config.headers ? { requestInit: { headers: config.headers } } : {}),
      ...(authProvider ? { authProvider } : {}),
    };
    const url = new URL(config.url);
    return wire === "http" ? new sdk.StreamableHTTPClientTransport(url, opts) : new sdk.SSEClientTransport(url, opts);
  }
  if (config.command === undefined) throw new Error(`stdio server "${config.name}" has no command`);
  return new sdk.StdioClientTransport({
    command: config.command,
    args: config.args ?? [],
    env: { ...sdk.getDefaultEnvironment(), ...(config.env ?? {}) },
    stderr: "ignore",
  });
}
