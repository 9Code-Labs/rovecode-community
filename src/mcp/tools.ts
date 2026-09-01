/** The lazy-disclosure seam (port #3): exactly TWO house tools are ever
 *  advertised to the model, regardless of how many MCP servers/tools exist.
 *  mcp_list returns a compact one-line-per-tool index (schemas on demand via a
 *  {schema:true} flag); mcp_call executes. Full server schemas never enter the
 *  system prompt — that is the ~0 idle-token invariant. */

import type { Tool, ToolContext, ToolOutput } from "../core/types.ts";
import type { McpManager } from "./client.ts";

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

/** Build the two house tools bound to a manager. Always exactly [mcp_list, mcp_call]. */
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
    async execute(rawArgs: unknown, _ctx: ToolContext): Promise<ToolOutput> {
      const a = (rawArgs ?? {}) as McpListArgs;
      const server = typeof a.server === "string" && a.server.length > 0 ? a.server : undefined;
      const tool = typeof a.tool === "string" && a.tool.length > 0 ? a.tool : undefined;

      // schema mode: full JSON schema for exactly one tool, on demand
      if (a.schema === true || tool !== undefined) {
        if (server === undefined || tool === undefined) {
          return { ok: false, output: "schema lookup needs both server and tool, e.g. {server:\"x\", tool:\"y\", schema:true}" };
        }
        const schema = await manager.toolSchema(server, tool);
        if (schema === undefined) {
          return { ok: false, output: `no schema for "${tool}" on "${server}" (unknown tool or server not connected); run mcp_list first` };
        }
        return { ok: true, output: `input schema for ${server}/${tool}: ${renderSchema(schema)}`, data: schema };
      }

      // index mode: compact one-liners only
      const tools = await manager.listTools();
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

      const res = await manager.callTool(server, tool, a.args, ctx.signal);
      if (res.ok) return { ok: true, output: res.output };

      // validation-error path: attach the input schema (cache-hot after the call
      // above) so the model can self-correct without a discovery round-trip.
      let output = res.output;
      if (!ctx.signal.aborted) {
        const schema = await manager.toolSchema(server, tool);
        if (schema !== undefined) output += `\n\ninput schema for ${server}/${tool}: ${renderSchema(schema)}`;
      }
      return { ok: false, output };
    },
  };

  return [list, call];
}
