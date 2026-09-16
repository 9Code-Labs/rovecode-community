/** Port #3 hardening tests: scripted MISBEHAVING servers (low-level Server so
 *  handlers can violate the protocol on purpose). Covers pagination bounds
 *  (repeated cursor, page cap, abort), list-time failure isolation, and the
 *  tool-output size cap. */

import { describe, expect, test } from "bun:test";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { McpManager, type McpServerConfig } from "../../src/mcp/client.ts";

type ListPage = {
  tools: { name: string; description?: string; inputSchema: { type: "object" } }[];
  nextCursor?: string;
};
type Script = {
  onList: (cursor: string | undefined) => ListPage | Promise<ListPage>;
  onCall?: (name: string) => { content: { type: "text"; text: string }[] };
};

const tool = (name: string): ListPage["tools"][number] => ({ name, description: "d", inputSchema: { type: "object" } });

/** Transport factory serving scripted low-level servers by config name. */
function scripted(scripts: Record<string, Script>) {
  return async (config: McpServerConfig): Promise<Transport | undefined> => {
    const script = scripts[config.name];
    if (!script) return undefined;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = new Server({ name: config.name, version: "1.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async (req) => script.onList(req.params?.cursor));
    if (script.onCall) {
      const onCall = script.onCall;
      server.setRequestHandler(CallToolRequestSchema, async (req) => onCall(req.params.name));
    }
    await server.connect(serverTransport);
    return clientTransport;
  };
}

function stdioCfg(name: string): McpServerConfig {
  return { name, transport: "stdio", command: "unused-inmemory" };
}

describe("pagination bounds (misbehaving servers)", () => {
  test("constant nextCursor: stops promptly with a repeated-cursor error", async () => {
    let calls = 0;
    const manager = new McpManager([stdioCfg("loopy")], {
      transportFactory: scripted({ loopy: { onList: () => { calls++; return { tools: [tool("t")], nextCursor: "same" }; } } }),
    });
    expect((await manager.connect()).failed).toEqual([]);
    const started = Date.now();
    const res = await manager.callTool("loopy", "t", {});
    expect(Date.now() - started).toBeLessThan(3_000); // 5M+ pages used to hang forever
    expect(res.ok).toBe(false);
    expect(res.output).toContain("repeated pagination cursor");
    expect(calls).toBe(2); // page 1 issues "same", page 2 repeats it → stop
    await manager.close();
  });

  test("endless fresh cursors: hard page cap stops the walk", async () => {
    let calls = 0;
    const manager = new McpManager([stdioCfg("endless")], {
      transportFactory: scripted({ endless: { onList: () => { calls++; return { tools: [tool(`t${calls}`)], nextCursor: `c${calls}` }; } } }),
    });
    await manager.connect();
    const res = await manager.callTool("endless", "t1", {});
    expect(res.ok).toBe(false);
    expect(res.output).toContain("50 pages");
    expect(calls).toBeLessThanOrEqual(51);
    await manager.close();
  });

  test("abort lands IN-FLIGHT: one slow page aborts sub-500ms (between-page checks can't save this)", async () => {
    // ONE page slower than the whole bound: the loop's between-page
    // `signal?.aborted` check only runs after a page RETURNS, so a mutation
    // that drops the in-flight `signal` from the listTools request options
    // (client.ts fetchTools) waits the full page (~1.2s) and fails the bound.
    const PAGE_MS = 1_200;
    const manager = new McpManager([stdioCfg("slowlist")], {
      transportFactory: scripted({
        slowlist: {
          onList: async () => {
            await Bun.sleep(PAGE_MS);
            return { tools: [tool("t")] }; // final page — pagination isn't the brake here
          },
        },
      }),
    });
    await manager.connect();
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    const started = Date.now();
    const res = await manager.callTool("slowlist", "t", {}, ac.signal);
    const elapsed = Date.now() - started;
    expect(res.ok).toBe(false);
    expect(elapsed).toBeLessThan(500); // in-flight cancellation, not page-boundary cleanup
    await Bun.sleep(PAGE_MS + 100 - elapsed); // let the in-flight server handler drain before close
    await manager.close();
  });
});

describe("list-time failure isolation", () => {
  test("a connected server whose listTools throws never poisons the others", async () => {
    const manager = new McpManager([stdioCfg("good"), stdioCfg("evil")], {
      transportFactory: scripted({
        good: { onList: () => ({ tools: [tool("echo")] }) },
        evil: { onList: () => { throw new Error("listTools exploded"); } },
      }),
    });
    const res = await manager.connect();
    expect(res.connected.sort()).toEqual(["evil", "good"]); // both connect fine
    const tools = await manager.listTools();
    expect(tools.map((t) => `${t.server}/${t.name}`)).toEqual(["good/echo"]);
    await manager.close();
  });
});

describe("tool output cap", () => {
  test("multi-MB-style results are truncated to ~10k chars with a marker", async () => {
    const manager = new McpManager([stdioCfg("bigmouth")], {
      transportFactory: scripted({
        bigmouth: {
          onList: () => ({ tools: [tool("huge")] }),
          onCall: () => ({ content: [{ type: "text", text: "x".repeat(50_000) }] }),
        },
      }),
    });
    await manager.connect();
    const res = await manager.callTool("bigmouth", "huge", {});
    expect(res.ok).toBe(true);
    expect(res.output.length).toBeLessThan(10_100); // 10k cap + one marker line
    expect(res.output.startsWith("xxx")).toBe(true);
    expect(res.output).toContain("[mcp output truncated: showing 10000 of 50000 chars]");
    await manager.close();
  });
});
