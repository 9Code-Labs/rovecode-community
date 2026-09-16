/** MCP prompts + resources (port #57), lazy like tools: nothing is fetched until
 *  mcp_prompts / mcp_prompt / mcp_resources / mcp_read asks; then cached per
 *  server with the manager's TTL and dropped early by the server's
 *  prompts/resources list_changed notifications (client.ts onListChanged). A
 *  server WITHOUT the capability yields an EMPTY list, never an error — "no
 *  prompts here" is a fact for the model, not a failure. One index per manager
 *  (depthFor), so the tools and the /mcp status share the caches.
 *  Pattern source (Apache-2.0, PATTERN ONLY — no code copied): gemini-cli
 *  list-mcp-resources.ts / read-mcp-resource.ts — server-scoped listing, text
 *  content verbatim, binary content summarized instead of fed raw.
 *  Rovecode: SDK-free at load (tools.ts pulls this in at createRuntime — method-not-found is a
 *  duck-typed code check, shared.ts), and every request goes through the per-call signal the
 *  tool paths use (shared.ts perCallSignal: the SDK never removes its abort listener). */

import type { McpManager } from "./client.ts";
import { isRecord, message } from "./config.ts";
import { capOutput, isMethodNotFound, walkPages, withCallSignal } from "./shared.ts";

export interface McpPromptArg { name: string; description: string; required: boolean }
export interface McpPromptInfo { server: string; name: string; description: string; arguments: McpPromptArg[] }
export interface McpResourceInfo { server: string; uri: string; name: string; description: string; mimeType?: string }
export interface McpTemplateInfo { server: string; uriTemplate: string; name: string; description: string; mimeType?: string }
export interface McpResourceIndex { resources: McpResourceInfo[]; templates: McpTemplateInfo[] }
/** cache-only counts for /mcp: a key is absent until a listing fetched it (lazy) */
export interface McpDepthCounts { prompts?: number; resources?: number; templates?: number }

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const mime = (v: unknown): { mimeType?: string } => (typeof v === "string" && v.length > 0 ? { mimeType: v } : {});

export class McpDepth {
  private readonly prompts = new Map<string, { at: number; items: McpPromptInfo[] }>();
  private readonly resources = new Map<string, { at: number; index: McpResourceIndex }>();
  /** per kind:server, bumped on list_changed (and on manager close) — a listing that raced the
   *  notification never re-caches its stale page for the TTL (mirrors client.ts toolGen) */
  private readonly gens = new Map<string, number>();

  constructor(private readonly manager: McpManager) {
    manager.onListChanged((server, kind) => {
      if (kind === "tools") return;
      (kind === "prompts" ? this.prompts : this.resources).delete(server);
      this.gens.set(`${kind}:${server}`, this.gen(kind, server) + 1);
    });
  }

  private gen(kind: "prompts" | "resources", server: string): number {
    return this.gens.get(`${kind}:${server}`) ?? 0;
  }

  /** request options for one SDK call — `signal` is the per-call one withCallSignal hands out */
  private opts(signal: AbortSignal): { timeout: number; signal: AbortSignal } {
    return { timeout: this.manager.requestTimeoutMs, signal };
  }

  /** One server's prompts (cached; EMPTY when the server lacks the capability). */
  async promptsOf(server: string, signal?: AbortSignal): Promise<McpPromptInfo[]> {
    const cached = this.prompts.get(server);
    const now = Date.now();
    if (cached && now - cached.at < this.manager.ttlMs) return cached.items;
    const { client, caps } = this.manager.connection(server);
    const gen = this.gen("prompts", server);
    const items = !caps.prompts ? [] : await walkPages<McpPromptInfo>("prompt", server, async (cursor) => {
      const res = await withCallSignal(signal, (sig) => client.listPrompts(cursor === undefined ? undefined : { cursor }, this.opts(sig)));
      return {
        items: res.prompts.map((p) => ({
          server, name: p.name, description: str(p.description),
          arguments: (p.arguments ?? []).map((a) => ({ name: a.name, description: str(a.description), required: a.required === true })),
        })),
        nextCursor: res.nextCursor,
      };
    }, signal);
    if (this.gen("prompts", server) === gen) this.prompts.set(server, { at: now, items }); // a mid-flight list_changed wins
    return items;
  }

  /** One server's resources + URI templates (cached; EMPTY without the capability; a
   *  resources-capable server that answers templates/list with method-not-found simply
   *  has no templates). */
  async resourcesOf(server: string, signal?: AbortSignal): Promise<McpResourceIndex> {
    const cached = this.resources.get(server);
    const now = Date.now();
    if (cached && now - cached.at < this.manager.ttlMs) return cached.index;
    const { client, caps } = this.manager.connection(server);
    const gen = this.gen("resources", server);
    const index: McpResourceIndex = { resources: [], templates: [] };
    if (caps.resources) {
      index.resources = await walkPages<McpResourceInfo>("resource", server, async (cursor) => {
        const res = await withCallSignal(signal, (sig) => client.listResources(cursor === undefined ? undefined : { cursor }, this.opts(sig)));
        return {
          items: res.resources.map((r) => ({ server, uri: r.uri, name: str(r.name), description: str(r.description), ...mime(r.mimeType) })),
          nextCursor: res.nextCursor,
        };
      }, signal);
      try {
        index.templates = await walkPages<McpTemplateInfo>("resource template", server, async (cursor) => {
          const res = await withCallSignal(signal, (sig) => client.listResourceTemplates(cursor === undefined ? undefined : { cursor }, this.opts(sig)));
          return {
            items: res.resourceTemplates.map((t) => ({ server, uriTemplate: t.uriTemplate, name: str(t.name), description: str(t.description), ...mime(t.mimeType) })),
            nextCursor: res.nextCursor,
          };
        }, signal);
      } catch (err) {
        if (!isMethodNotFound(err)) throw err;
      }
    }
    if (this.gen("resources", server) === gen) this.resources.set(server, { at: now, index }); // a mid-flight list_changed wins
    return index;
  }

  /** Every connected server's prompts; one failing server is a note, never a poisoned list. */
  async listPrompts(signal?: AbortSignal): Promise<{ prompts: McpPromptInfo[]; notes: string[] }> {
    const prompts: McpPromptInfo[] = [];
    const notes: string[] = [];
    for (const server of this.manager.connectedNames()) {
      try {
        prompts.push(...(await this.promptsOf(server, signal)));
      } catch (err) {
        notes.push(`${server}: ${message(err)}`);
      }
    }
    return { prompts, notes };
  }

  /** Every connected server's resources + templates, same isolation. */
  async listResources(signal?: AbortSignal): Promise<{ index: McpResourceIndex; notes: string[] }> {
    const index: McpResourceIndex = { resources: [], templates: [] };
    const notes: string[] = [];
    for (const server of this.manager.connectedNames()) {
      try {
        const one = await this.resourcesOf(server, signal);
        index.resources.push(...one.resources);
        index.templates.push(...one.templates);
      } catch (err) {
        notes.push(`${server}: ${message(err)}`);
      }
    }
    return { index, notes };
  }

  /** Render one prompt (prompts/get) as `[role] text` lines. Never throws; an
   *  unknown name comes back with the server's prompt names for self-correction. */
  async getPrompt(server: string, name: string, args: unknown, signal?: AbortSignal): Promise<{ ok: boolean; output: string }> {
    if (args !== undefined && args !== null && !isRecord(args)) {
      return { ok: false, output: `args for prompt ${server}/${name} must be a JSON object (got ${Array.isArray(args) ? "array" : typeof args})` };
    }
    let conn: ReturnType<McpManager["connection"]>;
    try {
      conn = this.manager.connection(server);
    } catch (err) {
      return { ok: false, output: message(err) };
    }
    if (!conn.caps.prompts) return { ok: false, output: `MCP server "${server}" advertises no prompts` };
    // prompt arguments are strings on the wire — non-strings travel as JSON
    const argv: Record<string, string> = {};
    for (const [k, v] of Object.entries(args ?? {})) argv[k] = typeof v === "string" ? v : JSON.stringify(v);
    try {
      const res = await withCallSignal(signal, (sig) => conn.client.getPrompt({ name, ...(Object.keys(argv).length > 0 ? { arguments: argv } : {}) }, this.opts(sig)));
      const lines: string[] = [];
      if (str(res.description)) lines.push(`# ${res.description}`);
      for (const m of res.messages) lines.push(`[${m.role}] ${renderPromptPart(m.content)}`);
      return { ok: true, output: capOutput(lines.join("\n"), "mcp prompt") };
    } catch (err) {
      let hint = "";
      try {
        const known = (await this.promptsOf(server, signal)).map((p) => p.name);
        if (!known.includes(name)) hint = `. Available prompts: ${known.length > 0 ? known.join(", ") : "(none)"}`;
      } catch {
        /* keep the raw error */
      }
      return { ok: false, output: `mcp prompt ${server}/${name} failed: ${message(err)}${hint}` };
    }
  }

  /** Read one resource (resources/read): text as-is, a blob as an annotation line
   *  (uri, mime, byte size) plus its base64 — the whole thing under the shared 10k
   *  cap, so a binary resource can never flood the conversation. Never throws. */
  async readResource(server: string, uri: string, signal?: AbortSignal): Promise<{ ok: boolean; output: string }> {
    let conn: ReturnType<McpManager["connection"]>;
    try {
      conn = this.manager.connection(server);
    } catch (err) {
      return { ok: false, output: message(err) };
    }
    if (!conn.caps.resources) return { ok: false, output: `MCP server "${server}" advertises no resources` };
    try {
      const res = await withCallSignal(signal, (sig) => conn.client.readResource({ uri }, this.opts(sig)));
      const text = res.contents.map((c) => renderResourceContent(c)).join("\n");
      return { ok: true, output: capOutput(text, "mcp resource") || `(empty resource ${uri})` };
    } catch (err) {
      return { ok: false, output: `mcp read ${server} ${uri} failed: ${message(err)}` };
    }
  }

  /** Cache-only counts for /mcp (a key is absent until fetched — lazy). */
  counts(server: string): McpDepthCounts {
    const out: McpDepthCounts = {};
    const p = this.prompts.get(server);
    if (p) out.prompts = p.items.length;
    const r = this.resources.get(server);
    if (r) {
      out.resources = r.index.resources.length;
      out.templates = r.index.templates.length;
    }
    return out;
  }

  /** `/mcp connect`: warm every list on the connected servers; per-server failures are notes. */
  async prefetch(signal?: AbortSignal): Promise<string[]> {
    await this.manager.listTools(false, signal);
    return [...(await this.listPrompts(signal)).notes, ...(await this.listResources(signal)).notes];
  }
}

/** A resources/read content entry: text verbatim; a blob becomes an annotation
 *  line plus its base64 (the caller caps the total). */
export function renderResourceContent(c: unknown): string {
  if (!isRecord(c)) return "";
  if (typeof c.text === "string") return c.text;
  if (typeof c.blob === "string") {
    const b64 = c.blob;
    const bytes = Math.floor((b64.length * 3) / 4) - (b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0);
    return `[blob ${str(c.uri)} ${str(c.mimeType) || "application/octet-stream"} ${bytes} bytes, base64 follows]\n${b64}`;
  }
  return `[resource ${str(c.uri)}: no text or blob content]`;
}

/** One prompt message content part: text verbatim, everything else a marker (an
 *  embedded resource keeps its text/blob rendering under the marker). */
export function renderPromptPart(part: unknown): string {
  if (!isRecord(part)) return "";
  switch (part.type) {
    case "text": return str(part.text);
    case "resource": return `[embedded resource]\n${renderResourceContent(part.resource)}`;
    case "resource_link": return `[resource_link ${str(part.uri)}${str(part.name) ? ` ${str(part.name)}` : ""}]`;
    case "image": case "audio": return `[${part.type} ${str(part.mimeType)}]`;
    default: return typeof part.type === "string" ? `[${part.type} content]` : "";
  }
}

const depths = new WeakMap<McpManager, McpDepth>();

/** The ONE index per manager — tools.ts and the /mcp status share its caches. */
export function depthFor(manager: McpManager): McpDepth {
  let d = depths.get(manager);
  if (!d) {
    d = new McpDepth(manager);
    depths.set(manager, d);
  }
  return d;
}
