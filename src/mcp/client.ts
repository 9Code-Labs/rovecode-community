/** MCP client with LAZY tool disclosure (port #3).
 *
 *  Design goal: idle token cost ~0. pi rejected MCP because tool schemas bloat
 *  every prompt (a Playwright server costs ~13.7k tokens idle). Aion's answer:
 *  exactly TWO house tools are ever advertised — mcp_list and mcp_call (tools.ts).
 *  Real server schemas stay here, fetched on demand and cached with a TTL.
 *
 *  Config loading lives in config.ts; re-exported here as the public surface. */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { isRecord, message, type McpServerConfig } from "./config.ts";

export { loadMcpConfig, type McpServerConfig } from "./config.ts";

// ---------- manager ----------

interface CachedTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface ServerEntry {
  config: McpServerConfig;
  client: Client | null;
  lastError?: string;
}

export interface McpManagerOptions {
  /** tool index cache lifetime (default 60s) */
  toolTtlMs?: number;
  /** per-server connect budget (default 10s) */
  connectTimeoutMs?: number;
  /** per-call budget; progress notifications reset it (default 120s) */
  callTimeoutMs?: number;
  /** seam for tests/extensions: return a Transport for a config, or undefined for the default */
  transportFactory?: (config: McpServerConfig) => Transport | undefined | Promise<Transport | undefined>;
}

export class McpManager {
  private readonly servers = new Map<string, ServerEntry>();
  private readonly toolCache = new Map<string, { at: number; tools: CachedTool[] }>();
  private readonly ttl: number;
  private readonly connectTimeout: number;
  private readonly callTimeout: number;
  private readonly transportFactory: McpManagerOptions["transportFactory"];

  constructor(configs: McpServerConfig[], options: McpManagerOptions = {}) {
    this.ttl = options.toolTtlMs ?? 60_000;
    this.connectTimeout = options.connectTimeoutMs ?? 10_000;
    this.callTimeout = options.callTimeoutMs ?? 120_000;
    this.transportFactory = options.transportFactory;
    for (const config of configs) {
      if (!this.servers.has(config.name)) this.servers.set(config.name, { config, client: null });
    }
  }

  serverNames(): string[] {
    return [...this.servers.keys()];
  }

  connectedNames(): string[] {
    return [...this.servers.values()].filter((e) => e.client !== null).map((e) => e.config.name);
  }

  /** Connect every enabled server. Lazy-friendly: failures never throw — they
   *  come back in `failed` and the server simply stays unavailable. */
  async connect(): Promise<{ connected: string[]; failed: { name: string; error: string }[] }> {
    const failed: { name: string; error: string }[] = [];
    const attempts = [...this.servers.values()]
      .filter((e) => e.config.enabled !== false && e.client === null)
      .map(async (entry) => {
        try {
          entry.client = await this.open(entry.config);
          delete entry.lastError;
        } catch (err) {
          entry.lastError = message(err);
          failed.push({ name: entry.config.name, error: entry.lastError });
        }
      });
    await Promise.all(attempts);
    return { connected: this.connectedNames(), failed };
  }

  private async open(config: McpServerConfig): Promise<Client> {
    const transport = await this.buildTransport(config);
    const client = new Client({ name: "aion", version: "0.1.0" });
    try {
      await withTimeout(
        client.connect(transport, { timeout: this.connectTimeout }),
        this.connectTimeout + 2_000,
        `connect to MCP server "${config.name}" timed out`,
      );
    } catch (err) {
      await client.close().catch(() => {});
      throw err;
    }
    return client;
  }

  private async buildTransport(config: McpServerConfig): Promise<Transport> {
    if (this.transportFactory) {
      const custom = await this.transportFactory(config);
      if (custom) return custom;
    }
    if (config.transport === "http") {
      if (config.url === undefined) throw new Error(`http server "${config.name}" has no url`);
      return new StreamableHTTPClientTransport(new URL(config.url));
    }
    if (config.command === undefined) throw new Error(`stdio server "${config.name}" has no command`);
    return new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      env: { ...getDefaultEnvironment(), ...(config.env ?? {}) },
      stderr: "ignore",
    });
  }

  /** Fetch (and cache) a server's tools, following list pagination. */
  private async fetchTools(server: string, force = false): Promise<CachedTool[]> {
    const entry = this.servers.get(server);
    if (!entry) throw new Error(`unknown MCP server "${server}"`);
    const client = entry.client;
    if (!client) throw new Error(`MCP server "${server}" is not connected${entry.lastError ? ` (${entry.lastError})` : ""}`);
    const cached = this.toolCache.get(server);
    const now = Date.now();
    if (!force && cached && now - cached.at < this.ttl) return cached.tools;

    const tools: CachedTool[] = [];
    let cursor: string | undefined;
    do {
      const res = await client.listTools(cursor === undefined ? undefined : { cursor }, { timeout: this.connectTimeout });
      for (const t of res.tools) {
        tools.push({
          name: t.name,
          description: typeof t.description === "string" ? t.description : "",
          inputSchema: t.inputSchema,
        });
      }
      cursor = typeof res.nextCursor === "string" ? res.nextCursor : undefined;
    } while (cursor !== undefined);
    this.toolCache.set(server, { at: now, tools });
    return tools;
  }

  /** Compact index across all connected servers. Cached per server with a TTL;
   *  pass refresh=true to bypass the cache. One broken server never hides the rest. */
  async listTools(refresh = false): Promise<{ server: string; name: string; description: string }[]> {
    const out: { server: string; name: string; description: string }[] = [];
    for (const [name, entry] of this.servers) {
      if (entry.client === null) continue;
      try {
        for (const t of await this.fetchTools(name, refresh)) {
          out.push({ server: name, name: t.name, description: t.description });
        }
      } catch {
        /* isolate per-server list failures */
      }
    }
    return out;
  }

  /** Full JSON input schema for one tool, on demand (the lazy-disclosure payoff). */
  async toolSchema(server: string, tool: string): Promise<object | undefined> {
    try {
      let found = (await this.fetchTools(server)).find((t) => t.name === tool);
      if (!found) found = (await this.fetchTools(server, true)).find((t) => t.name === tool);
      return found?.inputSchema;
    } catch {
      return undefined;
    }
  }

  /** Execute a tool. Never throws: unknown server/tool, transport errors and
   *  aborts all come back as { ok: false }. */
  async callTool(server: string, tool: string, args: unknown, signal?: AbortSignal): Promise<{ ok: boolean; output: string }> {
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
      known = await this.fetchTools(server);
    } catch (err) {
      return { ok: false, output: `failed to list tools on "${server}": ${message(err)}` };
    }
    if (!known.some((t) => t.name === tool)) {
      try {
        known = await this.fetchTools(server, true); // maybe stale cache — refresh once
      } catch {
        /* keep the stale list for the error message */
      }
      if (!known.some((t) => t.name === tool)) {
        const available = known.map((t) => t.name).join(", ");
        return { ok: false, output: `unknown tool "${tool}" on server "${server}". Available: ${available.length > 0 ? available : "(none)"}` };
      }
    }

    try {
      const result = await client.callTool(
        { name: tool, arguments: (args ?? undefined) as Record<string, unknown> | undefined },
        undefined,
        { signal, timeout: this.callTimeout, resetTimeoutOnProgress: true },
      );
      const text = renderContent(result.content, result.structuredContent);
      if (result.isError === true) return { ok: false, output: text.length > 0 ? text : `tool "${tool}" reported an error` };
      return { ok: true, output: text };
    } catch (err) {
      return { ok: false, output: `mcp call ${server}/${tool} failed: ${message(err)}` };
    }
  }

  /** Close all clients (errors swallowed) and drop caches. Configs are kept, so
   *  connect() can be called again. */
  async close(): Promise<void> {
    const closing: Promise<unknown>[] = [];
    for (const entry of this.servers.values()) {
      if (entry.client) {
        closing.push(entry.client.close().catch(() => {}));
        entry.client = null;
      }
    }
    this.toolCache.clear();
    await Promise.all(closing);
  }
}

// ---------- helpers ----------

/** Flatten an MCP content array to text; non-text parts become markers. Falls
 *  back to structuredContent JSON when there is no text at all. */
function renderContent(content: unknown, structured: unknown): string {
  const parts: string[] = [];
  if (Array.isArray(content)) {
    for (const item of content) {
      if (!isRecord(item)) continue;
      if (item.type === "text" && typeof item.text === "string") parts.push(item.text);
      else if (typeof item.type === "string") parts.push(`[${item.type} content]`);
    }
  }
  if (parts.length === 0 && structured !== undefined) {
    try {
      parts.push(JSON.stringify(structured));
    } catch {
      /* unserializable structured content */
    }
  }
  return parts.join("\n");
}

async function withTimeout<T>(p: Promise<T>, ms: number, note: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const gate = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(note)), ms);
  });
  try {
    return await Promise.race([p, gate]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
