/** Port #57 tests: MCP depth — prompts + resources tools, list_changed invalidation for
 *  tools/prompts/resources (the tools half moved here from mcp.test.ts for the 400-line cap),
 *  the shared 10k cap on blobs, capability-less servers as EMPTY lists,
 *  the status text (cache-only vs `connect`; rovecode's /mcp is the market, so no TUI adapter here). In-process
 *  McpServer over InMemoryTransport (toy) plus scripted low-level Servers. */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { z } from "zod";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ListResourcesRequestSchema, ListToolsRequestSchema, ReadResourceRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { McpManager, type McpServerConfig } from "../../src/mcp/client.ts";
import { createMcpTools } from "../../src/mcp/tools.ts";
import { depthFor, renderPromptPart, renderResourceContent } from "../../src/mcp/prompts-resources.ts";
import { clip, connectAndPrefetch, formatMcpStatus } from "../../src/mcp/status.ts";
import type { Tool, ToolContext } from "../../src/core/types.ts";

const ctx = (): ToolContext => ({ sessionId: "test", cwd: process.cwd(), signal: new AbortController().signal, permissions: { effect: "allow" } });
const cfg = (name: string): McpServerConfig => ({ name, transport: "stdio", command: "unused-inmemory" });

/** 40_000 raw bytes → ~53k base64 chars: far past the 10k cap. */
const BLOB_BYTES = 40_000;
const BIG_B64 = Buffer.alloc(BLOB_BYTES, 7).toString("base64");

function makeToy(): McpServer {
  const server = new McpServer({ name: "toy", version: "1.0.0" });
  server.registerTool("echo", { description: "Echo text", inputSchema: { text: z.string() } }, async ({ text }) => ({ content: [{ type: "text", text }] }));
  server.registerPrompt(
    "greet",
    { description: "Greet someone by name", argsSchema: { name: z.string().describe("who to greet"), tone: z.string().optional() } },
    ({ name, tone }) => ({ description: "A greeting", messages: [{ role: "user", content: { type: "text", text: `Hello ${name}${tone ? ` (${tone})` : ""}` } }] }),
  );
  server.registerResource("readme", "file:///readme.txt", { description: "The readme", mimeType: "text/plain" }, async (uri) => ({
    contents: [{ uri: uri.href, text: "hello resource", mimeType: "text/plain" }],
  }));
  server.registerResource("pic", "file:///pic.bin", { description: "a binary", mimeType: "application/octet-stream" }, async (uri) => ({
    contents: [{ uri: uri.href, blob: BIG_B64, mimeType: "application/octet-stream" }],
  }));
  server.registerResource("notes", new ResourceTemplate("notes://{id}", { list: undefined }), { description: "A note by id" }, async (uri, vars) => ({
    contents: [{ uri: uri.href, text: `note ${String(vars.id)}` }],
  }));
  return server;
}

/** Scripted low-level servers: `bare` advertises tools only; `resonly` has resources but no templates handler. */
function scriptedFactory(onToy?: (s: McpServer) => void) {
  return async (config: McpServerConfig): Promise<Transport | undefined> => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    if (config.name === "toy") {
      const toy = makeToy();
      onToy?.(toy);
      await toy.connect(serverTransport);
      return clientTransport;
    }
    if (config.name === "bare") {
      const s = new Server({ name: "bare", version: "1.0.0" }, { capabilities: { tools: {} } });
      s.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "t", description: "d", inputSchema: { type: "object" } }] }));
      await s.connect(serverTransport);
      return clientTransport;
    }
    if (config.name === "resonly") {
      const s = new Server({ name: "resonly", version: "1.0.0" }, { capabilities: { resources: {} } });
      s.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [{ uri: "mem://one", name: "one" }] }));
      s.setRequestHandler(ReadResourceRequestSchema, async (req) => ({ contents: [{ uri: req.params.uri, text: "ONE" }] }));
      await s.connect(serverTransport);
      return clientTransport;
    }
    return undefined;
  };
}

let toyServer: McpServer;
let manager: McpManager;
let tools: Tool[];
const tool = (name: string): Tool => {
  const t = tools.find((x) => x.schema.name === name);
  if (!t) throw new Error(`${name} missing`);
  return t;
};

beforeAll(async () => {
  manager = new McpManager([cfg("toy"), cfg("bare"), cfg("resonly")], { transportFactory: scriptedFactory((s) => { toyServer = s; }) });
  const res = await manager.connect();
  if (res.failed.length > 0) throw new Error(`connect failed: ${JSON.stringify(res.failed)}`);
  tools = createMcpTools(manager);
});
afterAll(async () => { await manager.close(); });

// ---------- prompts ----------

describe("mcp_prompts / mcp_prompt", () => {
  test("lists 'server/name — description (args: a*, b)' with required markers; capability-less servers contribute nothing (no error)", async () => {
    const res = await tool("mcp_prompts").execute({}, ctx());
    expect(res.ok).toBe(true);
    expect(res.output).toContain("toy/greet — Greet someone by name (args: name*, tone)");
    expect(res.output).not.toContain("bare/");
    expect(res.output).not.toContain("note:"); // no per-server failure notes
    expect(res.output).toContain("render with mcp_prompt");
  });

  test("server filter on a server WITHOUT the capability → ok:true empty list, not an error (bar #1)", async () => {
    const res = await tool("mcp_prompts").execute({ server: "bare" }, ctx());
    expect(res.ok).toBe(true);
    expect(res.output).toBe('no prompts advertised by "bare"');
    const ghost = await tool("mcp_prompts").execute({ server: "ghost" }, ctx());
    expect(ghost.ok).toBe(false);
    expect(ghost.output).toContain('"ghost" is not connected');
  });

  test("mcp_prompt renders prompts/get as '[role] text' lines under a description heading", async () => {
    const res = await tool("mcp_prompt").execute({ server: "toy", name: "greet", args: { name: "Ada", tone: "warm" } }, ctx());
    expect(res.ok).toBe(true);
    expect(res.output).toBe("# A greeting\n[user] Hello Ada (warm)");
  });

  test("unknown prompt → ok:false with the server's prompt names; missing fields fail fast; capability-less server is explicit", async () => {
    const nope = await tool("mcp_prompt").execute({ server: "toy", name: "nope" }, ctx());
    expect(nope.ok).toBe(false);
    expect(nope.output).toContain("mcp prompt toy/nope failed");
    expect(nope.output).toContain("Available prompts: greet");
    const missing = await tool("mcp_prompt").execute({ server: "toy" }, ctx());
    expect(missing.ok).toBe(false);
    expect(missing.output).toContain("mcp_prompt requires");
    const bare = await tool("mcp_prompt").execute({ server: "bare", name: "x" }, ctx());
    expect(bare.ok).toBe(false);
    expect(bare.output).toBe('MCP server "bare" advertises no prompts');
    const badArgs = await tool("mcp_prompt").execute({ server: "toy", name: "greet", args: [1] }, ctx());
    expect(badArgs.ok).toBe(false);
    expect(badArgs.output).toContain("must be a JSON object");
  });
});

// ---------- resources ----------

describe("mcp_resources / mcp_read", () => {
  test("lists resources AND uri templates; a resources-capable server without templates/list is tolerated (method-not-found → no templates)", async () => {
    const res = await tool("mcp_resources").execute({}, ctx());
    expect(res.ok).toBe(true);
    expect(res.output).toContain("toy file:///readme.txt — readme: The readme [text/plain]");
    expect(res.output).toContain("toy template notes://{id} — notes: A note by id");
    expect(res.output).toContain("resonly mem://one — one");
    expect(res.output).not.toContain("note:"); // resonly's missing templates/list is NOT reported as a failure
    expect(res.output).toContain("read with mcp_read");
    const bare = await tool("mcp_resources").execute({ server: "bare" }, ctx());
    expect(bare.ok).toBe(true);
    expect(bare.output).toBe('no resources advertised by "bare"');
  });

  test("mcp_read returns text AS-IS (byte-exact), templates resolve by concrete uri", async () => {
    const res = await tool("mcp_read").execute({ server: "toy", uri: "file:///readme.txt" }, ctx());
    expect(res.ok).toBe(true);
    expect(res.output).toBe("hello resource");
    const note = await tool("mcp_read").execute({ server: "toy", uri: "notes://42" }, ctx());
    expect(note.ok).toBe(true);
    expect(note.output).toBe("note 42");
    const one = await tool("mcp_read").execute({ server: "resonly", uri: "mem://one" }, ctx());
    expect(one.output).toBe("ONE");
  });

  test("a blob is annotated (uri, mime, byte size) and the base64 is CAPPED at the shared 10k limit", async () => {
    expect(BIG_B64.length).toBeGreaterThan(50_000);
    const res = await tool("mcp_read").execute({ server: "toy", uri: "file:///pic.bin" }, ctx());
    expect(res.ok).toBe(true);
    expect(res.output.startsWith(`[blob file:///pic.bin application/octet-stream ${BLOB_BYTES} bytes, base64 follows]\n`)).toBe(true);
    expect(res.output.length).toBeLessThan(10_200); // 10k + the annotation/marker lines; mutation: drop capOutput → 53k
    expect(res.output).toContain(`[mcp resource truncated: showing 10000 of ${BIG_B64.length + res.output.indexOf("\n") + 1} chars]`);
  });

  test("errors: unknown uri → ok:false; capability-less server explicit; missing fields fail fast", async () => {
    const nope = await tool("mcp_read").execute({ server: "toy", uri: "file:///nope" }, ctx());
    expect(nope.ok).toBe(false);
    expect(nope.output).toContain("mcp read toy file:///nope failed");
    const bare = await tool("mcp_read").execute({ server: "bare", uri: "x://y" }, ctx());
    expect(bare.ok).toBe(false);
    expect(bare.output).toBe('MCP server "bare" advertises no resources');
    const missing = await tool("mcp_read").execute({ server: "toy" }, ctx());
    expect(missing.ok).toBe(false);
    expect(missing.output).toContain("mcp_read requires");
  });

  test("render helpers: text verbatim, blob annotated, other prompt parts as markers", () => {
    expect(renderResourceContent({ uri: "a", text: "T" })).toBe("T");
    expect(renderResourceContent({ uri: "a", blob: "QUJD", mimeType: "x/y" })).toBe("[blob a x/y 3 bytes, base64 follows]\nQUJD");
    expect(renderResourceContent({ uri: "a" })).toBe("[resource a: no text or blob content]");
    expect(renderPromptPart({ type: "text", text: "hi" })).toBe("hi");
    expect(renderPromptPart({ type: "image", data: "…", mimeType: "image/png" })).toBe("[image image/png]");
    expect(renderPromptPart({ type: "resource_link", uri: "u", name: "n" })).toBe("[resource_link u n]");
    expect(renderPromptPart({ type: "resource", resource: { uri: "u", text: "body" } })).toBe("[embedded resource]\nbody");
  });
});

// ---------- status text + TUI adapter ----------

describe("formatMcpStatus / connectAndPrefetch", () => {
  test("null or empty manager → hint with the config path; never connects", () => {
    expect(formatMcpStatus(null, "/p/mcp.json")).toContain("no MCP servers configured");
    expect(formatMcpStatus(null, "/p/mcp.json")).toContain("/p/mcp.json");
    expect(formatMcpStatus(new McpManager([]), "/p/mcp.json")).toContain("no MCP servers configured");
  });

  test("lazy: a never-connected server is 'not connected yet'; a connected one with cold caches says 'not fetched yet'; `connect` fills real counts", async () => {
    const m = new McpManager([cfg("toy"), { name: "off", transport: "stdio", command: "x", enabled: false }], { transportFactory: scriptedFactory() });
    const cold = formatMcpStatus(m, "/p/mcp.json");
    expect(cold).toContain("MCP servers: 2 configured, 0 connected");
    expect(cold).toContain("toy  not connected yet (stdio) — /mcp connect");
    expect(cold).toContain("off  disabled (stdio)");
    await m.connect();
    const connected = formatMcpStatus(m, "/p/mcp.json");
    expect(connected).toContain("2 configured, 1 connected");
    expect(connected).toContain("toy  connected (stdio) · tools/prompts/resources not fetched yet — /mcp connect"); // status is cache-only: mutation that fetches here changes this line
    const notes = await connectAndPrefetch(m);
    expect(notes).toEqual([]);
    const warm = formatMcpStatus(m, "/p/mcp.json");
    expect(warm).toContain("toy  connected (stdio) · tools 1 · prompts 1 · resources 2 (+1 template)");
    await m.close();
  });

  test("a failed server shows the error clipped to one line ≤ 80 chars", async () => {
    const m = new McpManager([{ name: "bogus", transport: "stdio", command: "rovecode-definitely-not-a-real-binary-p57" }], { connectTimeoutMs: 5_000 });
    const res = await m.connect();
    expect(res.failed.length).toBe(1);
    const text = formatMcpStatus(m, "/p/mcp.json");
    const row = text.split("\n").find((l) => l.startsWith("bogus  failed (stdio): ")) ?? "";
    expect(row.length).toBeGreaterThan("bogus  failed (stdio): ".length);
    expect(row.length).toBeLessThanOrEqual("bogus  failed (stdio): ".length + 80);
    expect(m.status()[0]?.state).toBe("failed");
    await m.close();
    expect(clip("a\n\n b   c", 80)).toBe("a b c");
    expect(clip("x".repeat(100), 80).length).toBe(80);
    expect(clip("x".repeat(100), 80).endsWith("…")).toBe(true);
  });
});

// ---------- list_changed for tools + prompts + resources (last: mutates the toy server) ----------

describe("tools/prompts/resources list_changed invalidation", () => {
  test("tools: after a first mcp_list, registerTool on the server makes the NEXT plain mcp_list show the new tool (no refresh flag, no TTL wait) and mcp_call resolves it", async () => {
    const before = await tool("mcp_list").execute({ server: "toy" }, ctx());
    expect(before.output).toContain("toy/echo");
    expect(before.output).not.toContain("toy/extra");
    // McpServer.registerTool after connect emits notifications/tools/list_changed itself
    toyServer.registerTool("extra", { description: "registered after connect" }, async () => ({ content: [{ type: "text", text: "x" }] }));
    await Bun.sleep(20); // the notification handler runs on a microtask after delivery
    const next = await tool("mcp_list").execute({ server: "toy" }, ctx()); // plain index call — NO refresh flag
    expect(next.ok).toBe(true);
    expect(next.output).toContain("toy/extra — registered after connect"); // mutation: drop armNotifications → the 60s TTL cache still serves the old index
    const call = await tool("mcp_call").execute({ server: "toy", tool: "extra", args: {} }, ctx());
    expect(call).toMatchObject({ ok: true, output: "x" });
    expect(manager.status().find((s) => s.name === "toy")?.tools).toBe(2); // /mcp reads the refreshed cache
  });

  test("prompts/resources: after a first listing, registerPrompt/registerResource on the server make the NEXT listing show the new entries (no TTL wait)", async () => {
    const depth = depthFor(manager);
    expect((await depth.promptsOf("toy")).map((p) => p.name)).toEqual(["greet"]);
    expect((await depth.resourcesOf("toy")).resources.map((r) => r.uri)).toEqual(["file:///readme.txt", "file:///pic.bin"]);
    // McpServer emits notifications/prompts/list_changed + notifications/resources/list_changed for these
    toyServer.registerPrompt("bye", { description: "Say goodbye" }, () => ({ messages: [{ role: "user", content: { type: "text", text: "Bye" } }] }));
    toyServer.registerResource("extra", "file:///extra.txt", { description: "late" }, async (uri) => ({ contents: [{ uri: uri.href, text: "late text" }] }));
    await Bun.sleep(20); // handlers run on a microtask after delivery
    const prompts = await tool("mcp_prompts").execute({ server: "toy" }, ctx());
    expect(prompts.output).toContain("toy/bye — Say goodbye"); // mutation: drop the prompts handler → 60s TTL keeps the stale list
    const resources = await tool("mcp_resources").execute({ server: "toy" }, ctx());
    expect(resources.output).toContain("toy file:///extra.txt — extra: late");
    expect(depth.counts("toy")).toEqual({ prompts: 2, resources: 3, templates: 1 });
  });
});
