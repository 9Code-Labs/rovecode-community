/** Port #57 fix tests: the MCP list caches under RACES and RECONNECT. A `list_changed` that lands
 *  while a listing is in flight must not leave the stale page cached for the TTL (generation
 *  counters: client.ts toolGen for tools, prompts-resources.ts gens for prompts/resources), and
 *  close()+connect() on ONE manager must drop the depth caches so a reconnect serves a FRESH page,
 *  never the pre-close one. Scripted low-level Servers over InMemoryTransport: every listing counts
 *  its calls and carries the count in the page (t1/p1/r1 …); the FIRST call of each kind awaits a
 *  gate the test releases after firing the notification. Sibling of mcp-depth.test.ts (400-line cap). */

import { describe, expect, test } from "bun:test";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ListPromptsRequestSchema, ListResourcesRequestSchema, ListResourceTemplatesRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { McpManager, type McpServerConfig } from "../../src/mcp/client.ts";
import { depthFor } from "../../src/mcp/prompts-resources.ts";

const cfg: McpServerConfig = { name: "s", transport: "stdio", command: "unused-inmemory" };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Bounded await: Bun's test timeout only fires when something wakes the event loop. */
function deadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const bomb = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error(`${what}: not settled within ${ms}ms`)), ms); });
  return Promise.race([p, bomb]).finally(() => { if (t !== undefined) clearTimeout(t); });
}
async function until(pred: () => boolean, what: string, ms = 5_000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) { if (Date.now() - t0 > ms) throw new Error(`${what}: not true within ${ms}ms`); await sleep(5); }
}

type Kind = "tools" | "prompts" | "resources";
interface Scripted {
  calls: Record<Kind, number>;
  /** the FIRST listing of every kind parks here until release() */
  release(): void;
  /** the server instance behind the CURRENT connection (a reconnect gets a new one) */
  server?: Server;
}
const srv = (s: Scripted): Server => { if (!s.server) throw new Error("scripted server not connected"); return s.server; };

/** Transport factory: a fresh Server per connect() sharing ONE call log + gate; page content = call number. */
function scripted(): { state: Scripted; factory: (c: McpServerConfig) => Promise<Transport> } {
  let release!: () => void;
  const open = new Promise<void>((r) => { release = r; });
  const state: Scripted = { calls: { tools: 0, prompts: 0, resources: 0 }, release };
  const count = async (kind: Kind): Promise<number> => {
    const n = ++state.calls[kind];
    if (n === 1) await open;
    return n;
  };
  const factory = async (): Promise<Transport> => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = new Server({ name: "s", version: "1.0.0" }, { capabilities: { tools: {}, prompts: {}, resources: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: `t${await count("tools")}`, description: "d", inputSchema: { type: "object" } }] }));
    server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [{ name: `p${await count("prompts")}` }] }));
    server.setRequestHandler(ListResourcesRequestSchema, async () => {
      const n = await count("resources");
      return { resources: [{ uri: `mem://r${n}`, name: `r${n}` }] };
    });
    server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: [] }));
    await server.connect(serverTransport);
    state.server = server;
    return clientTransport;
  };
  return { state, factory };
}

describe("a list_changed that lands MID-LISTING is never lost (generation counters)", () => {
  test("tools: first tools/list gated → sendToolListChanged → release: the page comes back, and the NEXT plain listTools refetches (handler count 2) instead of serving the raced page for the TTL", async () => {
    const { state, factory } = scripted();
    const m = new McpManager([cfg], { transportFactory: factory });
    await m.connect();
    const first = m.listTools(); // parks inside the gated handler
    await until(() => state.calls.tools === 1, "gated tools/list reached the server");
    await srv(state).sendToolListChanged(); // lands while the page is in flight
    await sleep(20); // the client's notification handler runs on a microtask after delivery
    state.release();
    expect((await deadline(first, 5_000, "gated listTools")).map((t) => t.name)).toEqual(["t1"]); // the in-flight result is still delivered
    expect((await m.listTools()).map((t) => t.name)).toEqual(["t2"]); // mutation: unconditional toolCache.set in fetchTools → ["t1"] from cache
    expect(state.calls.tools).toBe(2);
    expect(m.status()[0]?.tools).toBe(1); // the refetched page is what /mcp reads
    await m.close();
  });

  test("prompts: same race through promptsOf → the NEXT promptsOf refetches (handler count 2)", async () => {
    const { state, factory } = scripted();
    const m = new McpManager([cfg], { transportFactory: factory });
    await m.connect();
    const depth = depthFor(m);
    const first = depth.promptsOf("s");
    await until(() => state.calls.prompts === 1, "gated prompts/list reached the server");
    await srv(state).sendPromptListChanged();
    await sleep(20);
    state.release();
    expect((await deadline(first, 5_000, "gated promptsOf")).map((p) => p.name)).toEqual(["p1"]);
    expect((await depth.promptsOf("s")).map((p) => p.name)).toEqual(["p2"]); // mutation: unconditional this.prompts.set → ["p1"] until the TTL
    expect(state.calls.prompts).toBe(2);
    expect(depth.counts("s")).toEqual({ prompts: 1 });
    await m.close();
  });

  test("resources: same race through resourcesOf → the NEXT resourcesOf refetches (handler count 2)", async () => {
    const { state, factory } = scripted();
    const m = new McpManager([cfg], { transportFactory: factory });
    await m.connect();
    const depth = depthFor(m);
    const first = depth.resourcesOf("s");
    await until(() => state.calls.resources === 1, "gated resources/list reached the server");
    await srv(state).sendResourceListChanged();
    await sleep(20);
    state.release();
    expect((await deadline(first, 5_000, "gated resourcesOf")).resources.map((r) => r.name)).toEqual(["r1"]);
    expect((await depth.resourcesOf("s")).resources.map((r) => r.name)).toEqual(["r2"]); // mutation: unconditional this.resources.set → ["r1"] until the TTL
    expect(state.calls.resources).toBe(2);
    expect(depth.counts("s")).toEqual({ resources: 1, templates: 0 });
    await m.close();
  });
});

describe("close() drops the depth caches (reconnect on the same manager)", () => {
  test("close + connect → the first promptsOf / resourcesOf / listTools inside the TTL hit the NEW server (fresh page), never the pre-close lists; counts() is empty after close", async () => {
    const { state, factory } = scripted();
    state.release(); // no gating here
    const m = new McpManager([cfg], { transportFactory: factory });
    await m.connect();
    const depth = depthFor(m);
    expect((await depth.promptsOf("s")).map((p) => p.name)).toEqual(["p1"]);
    expect((await depth.resourcesOf("s")).resources.map((r) => r.name)).toEqual(["r1"]);
    expect((await m.listTools()).map((t) => t.name)).toEqual(["t1"]);
    expect(depth.counts("s")).toEqual({ prompts: 1, resources: 1, templates: 0 });
    const before = srv(state);
    await m.close();
    expect(depth.counts("s")).toEqual({}); // mutation: close() without the depth notify → still {prompts:1, resources:1, templates:0}
    expect(m.status()[0]).toMatchObject({ state: "pending" });
    expect(m.status()[0]?.tools).toBeUndefined();
    await m.connect();
    expect(srv(state)).not.toBe(before); // a NEW server instance answers the reconnect
    expect((await depth.promptsOf("s")).map((p) => p.name)).toEqual(["p2"]); // mutation: → ["p1"] (the pre-close page, still inside the TTL)
    expect((await depth.resourcesOf("s")).resources.map((r) => r.name)).toEqual(["r2"]);
    expect((await m.listTools()).map((t) => t.name)).toEqual(["t2"]);
    expect(state.calls).toEqual({ tools: 2, prompts: 2, resources: 2 });
    await m.close();
  });
});
