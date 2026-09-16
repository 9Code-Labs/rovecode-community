/** MCP client with LAZY tool disclosure (port #3) and depth (port #57).
 *
 *  Design goal: idle token cost ~0. pi rejected MCP because tool schemas bloat
 *  every prompt (a Playwright server costs ~13.7k tokens idle). Rovecode's answer:
 *  only a handful of tiny house tools are ever advertised — mcp_list/mcp_call
 *  plus the prompt/resource quartet (tools.ts). Real server schemas stay here,
 *  fetched on demand and cached with a TTL that the server's own
 *  `notifications/tools/list_changed` cuts short (port #57; the prompt and
 *  resource caches live in prompts-resources.ts and ride the same seam).
 *
 *  Transports: stdio, streamable HTTP and (port #57) the legacy HTTP+SSE wire —
 *  declared as `transport: "sse"`, or reached by a ONE-shot fallback when a
 *  streamable-HTTP `url` answers the initialize POST with 404/405, the signature
 *  of an SSE-only server (any other failure propagates as-is). Transport construction
 *  and the connect-error text live in transport.ts; port #76 attaches the rovecode
 *  OAuth provider (oauth.ts runtimeAuthProvider — a stored `mcp:<name>` token for THIS url,
 *  never for stdio or over a static Authorization header) to both url wires, so the SDK
 *  sends the bearer and refreshes once on a 401; without a usable token a 401 reads
 *  `needs login — run \`rovecode mcp login <name>\``.
 *
 *  Config loading lives in config.ts; re-exported here as the public surface.
 *
 *  Nothing here imports the SDK at load: it is ~200 ms of module evaluation (zod schemas for every protocol
 *  message) and requiring this file used to pay that inside createRuntime, before the terminal had painted
 *  anything. transport.ts loads it on the connect path (loadSdk); oauth.ts, which imports the SDK's auth module,
 *  is imported dynamically there too. mcp.test.ts pins this. */

import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ServerCapabilities } from "@modelcontextprotocol/sdk/types.js";
import { isRecord, message, type McpServerConfig } from "./config.ts";
import { perCallSignal, renderContent, walkPages, withTimeout } from "./shared.ts";
import { buildTransport, describeError, isSseOnlySignature, loadSdk } from "./transport.ts";

export { loadMcpConfig, mcpConfigPath, type McpServerConfig } from "./config.ts";

const yieldToLoop = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** Commands that fetch the server’s package before running it, so a first launch is a download. */
const PACKAGE_RUNNERS = new Set(["npx", "npx.cmd", "uvx", "uvx.exe", "pipx", "pipx.exe", "bunx", "bunx.exe"]);
/** the budget a runner-launched server gets: enough for a cold fetch on a slow line */
export const RUNNER_CONNECT_MS = 90_000;

/** is this server launched through a package runner rather than an installed binary? */
export function isPackageRunner(config: Pick<McpServerConfig, "transport" | "command">): boolean {
  if (config.transport !== "stdio" || config.command === undefined) return false;
  const base = config.command.split(/[\\/]/).pop() ?? config.command;
  return PACKAGE_RUNNERS.has(base.toLowerCase());
}

/** What a timeout MEANS, said in terms the reader can act on. "Request timed out" is true and useless. */
export function runnerTimeoutMessage(config: Pick<McpServerConfig, "name" | "transport" | "command">, budgetMs: number): string {
  const head = `connect to MCP server "${config.name}" timed out after ${Math.round(budgetMs / 1000)}s`;
  if (!isPackageRunner(config)) return head;
  const runner = (config.command ?? "the runner").split(/[\\/]/).pop();
  return `${head} — ${runner} downloads the server's package on first use. Try again (the download is cached), `
    + `or install it once so it starts without the network: rovecode mcp add ${config.name} --local --force`;
}

// ---------- manager ----------

interface CachedTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** Which cached list a server's list_changed notification drops. */
export type McpListKind = "tools" | "prompts" | "resources";

/** The wire a connected server actually speaks (the fallback can differ from the config). */
export type McpWire = "stdio" | "http" | "sse" | "custom";

/** port #57: one server's row for status text — a snapshot, no network. */
export interface McpServerStatus {
  name: string;
  /** configured transport */
  transport: McpServerConfig["transport"];
  /** disabled (enabled:false) · pending (never attempted, or a connect in flight) · connected · failed */
  state: "disabled" | "pending" | "connected" | "failed";
  /** wire in use once connected; fellBack marks the 404/405 → sse retry */
  wire?: McpWire;
  fellBack?: boolean;
  error?: string;
  /** cached tool count — absent until the first mcp_list/mcp_call fetched them (lazy) */
  tools?: number;
}

interface ServerEntry {
  config: McpServerConfig;
  client: Client | null;
  /** in-flight open, shared by concurrent connect() calls (the first-use connect + a `connect` verb) */
  connecting?: Promise<void>;
  attempted: boolean;
  wire?: McpWire;
  fellBack?: boolean;
  lastError?: string;
}

export interface McpManagerOptions {
  /** list cache lifetime — tools here, prompts/resources in prompts-resources.ts (default 60s) */
  toolTtlMs?: number;
  /** per-server connect budget (default 10s) */
  connectTimeoutMs?: number;
  /** per-call budget; progress notifications reset it (default 120s) */
  callTimeoutMs?: number;
  /** seam for tests/extensions: return a Transport for a config, or undefined for the default */
  transportFactory?: (config: McpServerConfig) => Transport | undefined | Promise<Transport | undefined>;
  /** port #76: the OAuth provider a url server's transport gets (both wires; called per attempt), or undefined
   *  for none — default oauth.ts runtimeAuthProvider (the stored `mcp:<name>` record for this url), loaded lazily */
  authProvider?: (config: McpServerConfig) => OAuthClientProvider | undefined | Promise<OAuthClientProvider | undefined>;
}

/** the default provider factory: oauth.ts imports the SDK's auth module, so it is loaded on the connect path only */
const defaultAuthProvider = async (config: McpServerConfig): Promise<OAuthClientProvider | undefined> =>
  (await import("./oauth.ts")).runtimeAuthProvider(config);

export class McpManager {
  private readonly servers = new Map<string, ServerEntry>();
  private readonly toolCache = new Map<string, { at: number; tools: CachedTool[] }>();
  /** bumped per tools list_changed, so a fetch that raced the notification never re-caches a stale page */
  private readonly toolGen = new Map<string, number>();
  private readonly listeners = new Set<(server: string, kind: McpListKind) => void>();
  private readonly ttl: number;
  private readonly connectTimeout: number;
  private readonly callTimeout: number;
  private readonly transportFactory: McpManagerOptions["transportFactory"];
  private readonly authProvider: NonNullable<McpManagerOptions["authProvider"]>;

  constructor(configs: McpServerConfig[], options: McpManagerOptions = {}) {
    this.ttl = options.toolTtlMs ?? 60_000;
    this.connectTimeout = options.connectTimeoutMs ?? 10_000;
    this.callTimeout = options.callTimeoutMs ?? 120_000;
    this.transportFactory = options.transportFactory;
    this.authProvider = options.authProvider ?? defaultAuthProvider;
    for (const config of configs) {
      if (!this.servers.has(config.name)) this.servers.set(config.name, { config, client: null, attempted: false });
    }
  }

  serverNames(): string[] {
    return [...this.servers.keys()];
  }

  connectedNames(): string[] {
    return [...this.servers.values()].filter((e) => e.client !== null).map((e) => e.config.name);
  }

  /** Cache lifetime and per-request budget, shared with the prompt/resource indexes. */
  get ttlMs(): number { return this.ttl; }
  get requestTimeoutMs(): number { return this.connectTimeout; }

  /** the connected client for one server, or the unknown / not-connected line every tool path reports */
  private clientOf(server: string): Client {
    const entry = this.servers.get(server);
    if (!entry) throw new Error(`unknown MCP server "${server}"`);
    if (!entry.client) throw new Error(`MCP server "${server}" is not connected${entry.lastError ? ` (${entry.lastError})` : ""}`);
    return entry.client;
  }

  /** Connected client + negotiated capabilities for one server (prompts-resources.ts decides
   *  "no prompts here" from the caps); same unknown / not-connected lines as the tool paths. */
  connection(server: string): { client: Client; caps: ServerCapabilities } {
    const client = this.clientOf(server);
    return { client, caps: client.getServerCapabilities() ?? {} };
  }

  /** port #57: observe list_changed notifications (any server, any kind); returns the unsubscribe. */
  onListChanged(fn: (server: string, kind: McpListKind) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private invalidate(server: string, kind: McpListKind): void {
    if (kind === "tools") {
      this.toolCache.delete(server);
      this.toolGen.set(server, (this.toolGen.get(server) ?? 0) + 1);
    }
    for (const fn of this.listeners) {
      try { fn(server, kind); } catch { /* one listener never breaks the others */ }
    }
  }

  /** Connect every enabled server. Lazy-friendly: failures never throw — they
   *  come back in `failed` and the server simply stays unavailable.
   *
   *  The servers wait in parallel (an `npx` server spends ~2 s resolving its package and booting node;
   *  two of them must not take 4 s), but they are STARTED one per event-loop turn. Spawning a stdio
   *  server is the one synchronous cost here — cross-spawn's PATH walk plus a cmd.exe wrapper on
   *  Windows, ~40 ms each — and back to back those stalls added up into one long freeze of a renderer
   *  that repaints every 40 ms. Staggered, no single frame loses more than one spawn.
   *
   *  Re-entrant (port #57): a second call while an open is in flight (a `connect` verb during the
   *  first-use connect) joins that open instead of spawning a second child/session. */
  async connect(): Promise<{ connected: string[]; failed: { name: string; error: string }[] }> {
    const failed: { name: string; error: string }[] = [];
    const pending = [...this.servers.values()].filter((e) => e.config.enabled !== false && e.client === null);
    const attempts: Promise<void>[] = [];
    for (const entry of pending) {
      if (attempts.length > 0 && entry.connecting === undefined) await yieldToLoop();
      entry.connecting ??= this.open(entry).finally(() => { entry.connecting = undefined; });
      attempts.push(entry.connecting.catch((err: unknown) => { failed.push({ name: entry.config.name, error: describeError(err, entry.config) }); }));
    }
    await Promise.all(attempts);
    return { connected: this.connectedNames(), failed };
  }

  private async open(entry: ServerEntry): Promise<void> {
    const { config } = entry;
    entry.attempted = true;
    try {
      const custom = this.transportFactory ? await this.transportFactory(config) : undefined;
      let wire: McpWire = custom ? "custom" : config.transport;
      let fellBack = false;
      let client: Client;
      try {
        client = await this.handshake(config, custom ?? await buildTransport(config, config.transport, await this.authProvider(config)));
      } catch (err) {
        // port #57: streamable HTTP met an SSE-only server → retry ONCE over the legacy wire (a fresh provider: one refresh per attempt)
        if (custom !== undefined || config.transport !== "http" || !isSseOnlySignature(err)) throw err;
        client = await this.handshake(config, await buildTransport(config, "sse", await this.authProvider(config)));
        wire = "sse";
        fellBack = true;
      }
      await this.armNotifications(config.name, client);
      entry.client = client;
      entry.wire = wire;
      entry.fellBack = fellBack;
      delete entry.lastError;
    } catch (err) {
      entry.lastError = describeError(err, config);
      throw err;
    }
  }

  private async handshake(config: McpServerConfig, transport: Transport): Promise<Client> {
    const client = new (await loadSdk()).Client({ name: "rovecode", version: "0.1.0" });
    // A package runner downloads before it runs, and a download is not a hang. Measured on this machine:
    // a first-ever `uvx mcp-server-time` took over 10 s and lost to the default budget — the user saw
    // "Request timed out" for a server that was working perfectly, and would have seen it again on the
    // next start because nothing had finished caching. `npx -y` is the same shape (7 s cold, 47 MB).
    const budget = isPackageRunner(config) ? Math.max(this.connectTimeout, RUNNER_CONNECT_MS) : this.connectTimeout;
    try {
      await withTimeout(
        client.connect(transport, { timeout: budget }),
        budget + 2_000,
        runnerTimeoutMessage(config, budget),
      );
    } catch (err) {
      await client.close().catch(() => {});
      throw err;
    }
    return client;
  }

  /** port #57: a server's list_changed drops the matching cached list, so the next
   *  mcp_list / mcp_prompts / mcp_resources refetches instead of waiting out the TTL. */
  private async armNotifications(name: string, client: Client): Promise<void> {
    const sdk = await loadSdk();
    client.setNotificationHandler(sdk.ToolListChangedNotificationSchema, () => this.invalidate(name, "tools"));
    client.setNotificationHandler(sdk.PromptListChangedNotificationSchema, () => this.invalidate(name, "prompts"));
    client.setNotificationHandler(sdk.ResourceListChangedNotificationSchema, () => this.invalidate(name, "resources"));
  }

  /** Fetch (and cache) a server's tools, following list pagination under the shared
   *  bounds (shared.ts walkPages): a misbehaving server (repeated cursor, endless
   *  pages) throws instead of hanging the agent; the abort signal cancels between
   *  and inside pages — each page request under its own per-call signal (the SDK's
   *  listener leak, shared.ts perCallSignal). */
  private async fetchTools(server: string, force = false, signal?: AbortSignal): Promise<CachedTool[]> {
    const client = this.clientOf(server);
    const cached = this.toolCache.get(server);
    const now = Date.now();
    if (!force && cached && now - cached.at < this.ttl) return cached.tools;
    const gen = this.toolGen.get(server) ?? 0;
    const tools = await walkPages<CachedTool>("tool", server, async (cursor) => {
      const per = perCallSignal(signal);   // listTools is a request like any other
      let res;
      try {
        res = await client.listTools(cursor === undefined ? undefined : { cursor }, { timeout: this.connectTimeout, signal: per.signal });
      } finally { per.dispose(); }
      return {
        items: res.tools.map((t) => ({ name: t.name, description: typeof t.description === "string" ? t.description : "", inputSchema: t.inputSchema })),
        nextCursor: res.nextCursor,
      };
    }, signal);
    if ((this.toolGen.get(server) ?? 0) === gen) this.toolCache.set(server, { at: now, tools }); // a mid-flight list_changed wins
    return tools;
  }

  /** Compact index across all connected servers. Cached per server with a TTL;
   *  pass refresh=true to bypass the cache. One broken server never hides the rest. */
  async listTools(refresh = false, signal?: AbortSignal): Promise<{ server: string; name: string; description: string }[]> {
    const out: { server: string; name: string; description: string }[] = [];
    for (const [name, entry] of this.servers) {
      if (entry.client === null) continue;
      try {
        for (const t of await this.fetchTools(name, refresh, signal)) {
          out.push({ server: name, name: t.name, description: t.description });
        }
      } catch {
        /* isolate per-server list failures */
      }
    }
    return out;
  }

  /** Full JSON input schema for one tool, on demand (the lazy-disclosure payoff). */
  async toolSchema(server: string, tool: string, signal?: AbortSignal): Promise<object | undefined> {
    try {
      let found = (await this.fetchTools(server, false, signal)).find((t) => t.name === tool);
      if (!found) found = (await this.fetchTools(server, true, signal)).find((t) => t.name === tool);
      return found?.inputSchema;
    } catch {
      return undefined;
    }
  }

  /** Execute a tool. Never throws: unknown server/tool, transport errors and
   *  aborts all come back as { ok: false }. `onProgress` surfaces server progress
   *  notifications (and makes the call-timeout reset on each one). */
  async callTool(server: string, tool: string, args: unknown, signal?: AbortSignal, onProgress?: (note: string) => void): Promise<{ ok: boolean; output: string }> {
    const entry = this.servers.get(server);
    if (!entry) {
      const known = this.serverNames();
      return { ok: false, output: `unknown MCP server "${server}". Known servers: ${known.length > 0 ? known.join(", ") : "(none configured)"}` };
    }
    const client = entry.client;
    if (!client) return { ok: false, output: `MCP server "${server}" is not connected${entry.lastError ? `: ${entry.lastError}` : ""}` };
    if (args !== undefined && args !== null && !isRecord(args)) {
      return { ok: false, output: `args for ${server}/${tool} must be a JSON object (got ${Array.isArray(args) ? "array" : typeof args})` };
    }

    let known: CachedTool[];
    try {
      known = await this.fetchTools(server, false, signal);
    } catch (err) {
      return { ok: false, output: `failed to list tools on "${server}": ${message(err)}` };
    }
    if (!known.some((t) => t.name === tool)) {
      try {
        known = await this.fetchTools(server, true, signal); // maybe stale cache — refresh once
      } catch {
        /* keep the stale list for the error message */
      }
      if (!known.some((t) => t.name === tool)) {
        const available = known.map((t) => t.name).join(", ");
        return { ok: false, output: `unknown tool "${tool}" on server "${server}". Available: ${available.length > 0 ? available : "(none)"}` };
      }
    }

    const per = perCallSignal(signal);
    try {
      // an onprogress handler makes the SDK request a progress token, which is what
      // arms resetTimeoutOnProgress — without it that option is a no-op.
      const result = await client.callTool(
        { name: tool, arguments: (args ?? undefined) as Record<string, unknown> | undefined },
        undefined,
        {
          signal: per.signal,
          timeout: this.callTimeout,
          resetTimeoutOnProgress: true,
          onprogress: (p) => onProgress?.(
            typeof p.message === "string" && p.message.length > 0
              ? p.message
              : `progress ${p.progress}${typeof p.total === "number" ? `/${p.total}` : ""}`,
          ),
        },
      );
      const text = renderContent(result.content, result.structuredContent);
      if (result.isError === true) return { ok: false, output: text.length > 0 ? text : `tool "${tool}" reported an error` };
      return { ok: true, output: text };
    } catch (err) {
      return { ok: false, output: `mcp call ${server}/${tool} failed: ${message(err)}` };
    } finally {
      per.dispose();
    }
  }

  /** port #57: per-server snapshot for status text. No network — the tool count comes from
   *  the cache, so an idle session reports "not fetched" rather than connecting. */
  status(): McpServerStatus[] {
    return [...this.servers.values()].map((e) => {
      const s: McpServerStatus = {
        name: e.config.name,
        transport: e.config.transport,
        state: e.config.enabled === false ? "disabled" : e.client ? "connected" : e.attempted && !e.connecting ? "failed" : "pending",
      };
      if (e.wire !== undefined) s.wire = e.wire;
      if (e.fellBack) s.fellBack = true;
      if (e.lastError !== undefined) s.error = e.lastError;
      const cached = this.toolCache.get(e.config.name);
      if (cached) s.tools = cached.tools.length;
      return s;
    });
  }

  /** Bring the manager's server list in line with `configs`, without touching what is already running.
   *
   *  This is what lets `market install mcp:<id>` be usable in the session that installed it, instead of
   *  ending in "restart rovecode". A server the manager already knows is left exactly as it is —
   *  connected, cached tools and all — because re-adding it would drop a working connection to change
   *  nothing. A server that has disappeared from the files is closed and forgotten (its depth caches
   *  dropped through the list_changed listeners). New names are added disconnected; `connect()` then
   *  picks them up, since it only attempts entries whose client is null.
   *
   *  Config changes to an EXISTING name are deliberately not applied here: swapping the command under a
   *  live connection is a different operation with its own failure modes, and pretending otherwise would
   *  make this quietly unreliable. Removing and re-adding does it, and says what it is doing. */
  async sync(configs: readonly McpServerConfig[]): Promise<{ added: string[]; removed: string[] }> {
    const wanted = new Map(configs.map((c) => [c.name, c]));
    const added: string[] = [];
    const removed: string[] = [];
    for (const [name, entry] of [...this.servers]) {
      if (wanted.has(name)) continue;
      removed.push(name);
      this.servers.delete(name);
      for (const kind of ["tools", "prompts", "resources"] as const) this.invalidate(name, kind);
      if (entry.client) await entry.client.close().catch(() => {});
    }
    for (const [name, config] of wanted) {
      if (this.servers.has(name)) continue;
      this.servers.set(name, { config, client: null, attempted: false });
      added.push(name);
    }
    return { added, removed };
  }

  /** Close all clients (errors swallowed) and drop EVERY cache: tools here, prompts and
   *  resources through the list_changed listeners (port #57 fix — a close()+connect() on
   *  one manager must never serve the pre-close lists inside the TTL; the generation bump
   *  also stops a listing still in flight from re-caching). Configs are kept, so connect()
   *  can be called again. */
  async close(): Promise<void> {
    const closing: Promise<unknown>[] = [];
    for (const entry of this.servers.values()) {
      if (entry.client) {
        closing.push(entry.client.close().catch(() => {}));
        entry.client = null;
      }
      entry.attempted = false;
      delete entry.wire;
      delete entry.fellBack;
      for (const kind of ["tools", "prompts", "resources"] as const) this.invalidate(entry.config.name, kind);
    }
    await Promise.all(closing);
  }
}
