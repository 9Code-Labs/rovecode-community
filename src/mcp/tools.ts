/** The lazy-disclosure seam (port #3 + #57): a handful of TINY house tools are
 *  advertised to the model, regardless of how many MCP servers/tools exist.
 *  mcp_list returns a compact one-line-per-tool index (schemas on demand via a
 *  {schema:true} flag); mcp_call executes. Port #57 adds the same shape for
 *  prompts (mcp_prompts / mcp_prompt) and resources (mcp_resources / mcp_read).
 *  Full server schemas never enter the system prompt — that is the ~0
 *  idle-token invariant (mcp.test.ts pins the COMBINED schema size). SDK-free at
 *  load: the runtime requires this file at createRuntime. */

import type { Tool, ToolContext, ToolOutput } from "../core/types.ts";
import type { McpManager } from "./client.ts";
import { message } from "./config.ts";
import { depthFor, type McpPromptInfo, type McpResourceIndex } from "./prompts-resources.ts";

const DESC_MAX = 60;
const SCHEMA_MAX = 1_500;

/** First line of a description, hard-capped for the index. */
function compact(desc: string): string {
  const line = (desc.split("\n", 1)[0] ?? "").trim();
  return line.length <= DESC_MAX ? line : `${line.slice(0, DESC_MAX - 1)}…`;
}

function renderSchema(schema: object): string {
  const rendered = JSON.stringify(schema);
  return rendered.length > SCHEMA_MAX ? `${rendered.slice(0, SCHEMA_MAX)}…` : rendered;
}

/** A non-empty string argument, or undefined (tolerates non-object rawArgs). */
function strArg(raw: unknown, key: string): string | undefined {
  const v = (raw as Record<string, unknown> | null | undefined)?.[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function notConnected(manager: McpManager, server: string): ToolOutput {
  const connected = manager.connectedNames();
  return { ok: false, output: `MCP server "${server}" is not connected. Connected: ${connected.length > 0 ? connected.join(", ") : "(none)"}` };
}

interface McpListArgs {
  server?: string;
  tool?: string;
  schema?: boolean;
}

interface McpCallArgs {
  server?: string;
  tool?: string;
  args?: unknown;
}

/** Build the house tools bound to a manager: [mcp_list, mcp_call, mcp_prompts, mcp_prompt, mcp_resources, mcp_read]. */
export function createMcpTools(manager: McpManager): Tool[] {
  const list: Tool = {
    schema: {
      name: "mcp_list",
      description:
        "List tools on connected MCP servers as 'server/tool — description'. " +
        "With {server, tool, schema:true} returns that one tool's full JSON input schema.",
      args: {
        type: "object",
        properties: {
          server: { type: "string", description: "only list this server" },
          tool: { type: "string", description: "tool name (for schema lookup)" },
          schema: { type: "boolean", description: "return the full input schema for server+tool" },
        },
        additionalProperties: false,
      },
    },
    kind: "read",
    sequential: false,
    async execute(rawArgs: unknown, ctx: ToolContext): Promise<ToolOutput> {
      const a = (rawArgs ?? {}) as McpListArgs;
      const server = typeof a.server === "string" && a.server.length > 0 ? a.server : undefined;
      const tool = typeof a.tool === "string" && a.tool.length > 0 ? a.tool : undefined;

      // schema mode: full JSON schema for exactly one tool, on demand
      if (a.schema === true || tool !== undefined) {
        if (server === undefined || tool === undefined) {
          return { ok: false, output: "schema lookup needs both server and tool, e.g. {server:\"x\", tool:\"y\", schema:true}" };
        }
        const schema = await manager.toolSchema(server, tool, ctx.signal);
        if (schema === undefined) {
          return { ok: false, output: `no schema for "${tool}" on "${server}" (unknown tool or server not connected); run mcp_list first` };
        }
        return { ok: true, output: `input schema for ${server}/${tool}: ${renderSchema(schema)}`, data: schema };
      }

      // index mode: compact one-liners only
      const tools = await manager.listTools(false, ctx.signal);
      const filtered = server === undefined ? tools : tools.filter((t) => t.server === server);
      if (filtered.length === 0) {
        const connected = manager.connectedNames();
        if (server !== undefined && !connected.includes(server)) {
          return { ok: false, output: `MCP server "${server}" is not connected. Connected: ${connected.length > 0 ? connected.join(", ") : "(none)"}` };
        }
        return { ok: true, output: connected.length === 0 ? "no MCP servers connected" : "no tools advertised by connected MCP servers" };
      }
      const lines = filtered.map((t) => `${t.server}/${t.name} — ${compact(t.description)}`);
      lines.push("", "call with mcp_call {server, tool, args}; arg schema via mcp_list {server, tool, schema:true}");
      return { ok: true, output: lines.join("\n"), data: filtered };
    },
  };

  const call: Tool = {
    schema: {
      name: "mcp_call",
      description:
        "Call a tool on a connected MCP server. Discover names with mcp_list; " +
        "on argument errors the tool's input schema is included so you can retry.",
      args: {
        type: "object",
        properties: {
          server: { type: "string", description: "MCP server name" },
          tool: { type: "string", description: "tool name on that server" },
          args: { type: "object", description: "arguments matching the tool's input schema" },
        },
        required: ["server", "tool"],
        additionalProperties: false,
      },
    },
    kind: "custom", // policy maps this to action "tool.mcp_call" (prompt-gated by default)
    interruptible: true,
    async execute(rawArgs: unknown, ctx: ToolContext): Promise<ToolOutput> {
      const a = (rawArgs ?? {}) as McpCallArgs;
      const server = typeof a.server === "string" && a.server.length > 0 ? a.server : undefined;
      const tool = typeof a.tool === "string" && a.tool.length > 0 ? a.tool : undefined;
      if (server === undefined || tool === undefined) {
        return { ok: false, output: 'mcp_call requires string "server" and "tool" (discover them with mcp_list)' };
      }

      const res = await manager.callTool(server, tool, a.args, ctx.signal, ctx.onUpdate);
      if (res.ok) return { ok: true, output: res.output };

      // validation-error path: attach the input schema (cache-hot after the call
      // above) so the model can self-correct without a discovery round-trip.
      let output = res.output;
      if (!ctx.signal.aborted) {
        const schema = await manager.toolSchema(server, tool, ctx.signal);
        if (schema !== undefined) output += `\n\ninput schema for ${server}/${tool}: ${renderSchema(schema)}`;
      }
      return { ok: false, output };
    },
  };

  const depth = depthFor(manager);
  const serverOpt = { server: { type: "string", description: "only list this server" } };

  const prompts: Tool = {
    schema: {
      name: "mcp_prompts",
      description: "List prompts on connected MCP servers as 'server/name — description (args: a, b*)', * = required. Render one with mcp_prompt.",
      args: { type: "object", properties: serverOpt, additionalProperties: false },
    },
    kind: "read",
    sequential: false,
    async execute(rawArgs: unknown, ctx: ToolContext): Promise<ToolOutput> {
      const server = strArg(rawArgs, "server");
      let rows: McpPromptInfo[];
      const notes: string[] = [];
      if (server !== undefined) {
        if (!manager.connectedNames().includes(server)) return notConnected(manager, server);
        try {
          rows = await depth.promptsOf(server, ctx.signal);
        } catch (err) {
          return { ok: false, output: `failed to list prompts on "${server}": ${message(err)}` };
        }
      } else {
        const r = await depth.listPrompts(ctx.signal);
        rows = r.prompts;
        notes.push(...r.notes);
      }
      const lines = rows.map((p) => {
        const args = p.arguments.map((a) => (a.required ? `${a.name}*` : a.name)).join(", ");
        return `${p.server}/${p.name} — ${compact(p.description)}${args ? ` (args: ${args})` : ""}`;
      });
      if (lines.length === 0) {
        lines.push(manager.connectedNames().length === 0 ? "no MCP servers connected" : `no prompts advertised by ${server === undefined ? "connected MCP servers" : `"${server}"`}`);
      } else lines.push("", "render with mcp_prompt {server, name, args}");
      return { ok: true, output: [...lines, ...notes.map((n) => `note: ${n}`)].join("\n"), data: rows };
    },
  };

  const prompt: Tool = {
    schema: {
      name: "mcp_prompt",
      description: "Render a prompt from an MCP server (prompts/get) as '[role] text' lines. Names and args via mcp_prompts.",
      args: {
        type: "object",
        properties: {
          server: { type: "string", description: "MCP server name" },
          name: { type: "string", description: "prompt name on that server" },
          args: { type: "object", description: "prompt arguments (string values)" },
        },
        required: ["server", "name"],
        additionalProperties: false,
      },
    },
    kind: "read",
    interruptible: true,
    async execute(rawArgs: unknown, ctx: ToolContext): Promise<ToolOutput> {
      const server = strArg(rawArgs, "server");
      const name = strArg(rawArgs, "name");
      if (server === undefined || name === undefined) {
        return { ok: false, output: 'mcp_prompt requires string "server" and "name" (discover them with mcp_prompts)' };
      }
      return depth.getPrompt(server, name, (rawArgs as { args?: unknown } | null | undefined)?.args, ctx.signal);
    },
  };

  const resources: Tool = {
    schema: {
      name: "mcp_resources",
      description: "List resources (and URI templates) on connected MCP servers as 'server uri — name: description [mime]'. Read one with mcp_read.",
      args: { type: "object", properties: serverOpt, additionalProperties: false },
    },
    kind: "read",
    sequential: false,
    async execute(rawArgs: unknown, ctx: ToolContext): Promise<ToolOutput> {
      const server = strArg(rawArgs, "server");
      let index: McpResourceIndex;
      const notes: string[] = [];
      if (server !== undefined) {
        if (!manager.connectedNames().includes(server)) return notConnected(manager, server);
        try {
          index = await depth.resourcesOf(server, ctx.signal);
        } catch (err) {
          return { ok: false, output: `failed to list resources on "${server}": ${message(err)}` };
        }
      } else {
        const r = await depth.listResources(ctx.signal);
        index = r.index;
        notes.push(...r.notes);
      }
      const tail = (name: string, desc: string, mime: string | undefined): string =>
        `${name || "(unnamed)"}${desc ? `: ${compact(desc)}` : ""}${mime ? ` [${mime}]` : ""}`;
      const lines = [
        ...index.resources.map((r) => `${r.server} ${r.uri} — ${tail(r.name, r.description, r.mimeType)}`),
        ...index.templates.map((t) => `${t.server} template ${t.uriTemplate} — ${tail(t.name, t.description, t.mimeType)}`),
      ];
      if (lines.length === 0) {
        lines.push(manager.connectedNames().length === 0 ? "no MCP servers connected" : `no resources advertised by ${server === undefined ? "connected MCP servers" : `"${server}"`}`);
      } else lines.push("", "read with mcp_read {server, uri} (fill a template's {variables} first)");
      return { ok: true, output: [...lines, ...notes.map((n) => `note: ${n}`)].join("\n"), data: index };
    },
  };

  const read: Tool = {
    schema: {
      name: "mcp_read",
      description: "Read one MCP resource by uri (resources/read): text as-is, binary as an annotated base64 blob; output capped at 10k chars.",
      args: {
        type: "object",
        properties: {
          server: { type: "string", description: "MCP server name" },
          uri: { type: "string", description: "resource uri (from mcp_resources)" },
        },
        required: ["server", "uri"],
        additionalProperties: false,
      },
    },
    kind: "read",
    interruptible: true,
    async execute(rawArgs: unknown, ctx: ToolContext): Promise<ToolOutput> {
      const server = strArg(rawArgs, "server");
      const uri = strArg(rawArgs, "uri");
      if (server === undefined || uri === undefined) {
        return { ok: false, output: 'mcp_read requires string "server" and "uri" (discover them with mcp_resources)' };
      }
      return depth.readResource(server, uri, ctx.signal);
    },
  };

  return [list, call, prompts, prompt, resources, read];
}
