/** Port #57 tests: the legacy HTTP+SSE transport against an IN-PROCESS fake SSE server
 *  (Bun.serve): GET <url> opens the event stream and announces the POST endpoint, POST
 *  <endpoint> feeds JSON-RPC to a low-level SDK Server, and POST <url> itself answers like
 *  an SSE-only server would (405 by default). Pins: `transport: "sse"` connects and lists
 *  tools; a streamable-HTTP config whose initialize POST gets 404/405 falls back to SSE
 *  ONCE (a 500 does not); headers reach both the GET and the POSTs; nothing hangs. */

import { afterEach, describe, expect, test } from "bun:test";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { McpManager } from "../../src/mcp/client.ts";
import { formatMcpStatus } from "../../src/mcp/status.ts";

interface Seen { method: string; path: string; auth: string | null }
interface FakeSse { url: string; seen: Seen[]; sessions: number; stop(): void }

/** Bounded await: a hang is a FAILURE here, never a stuck bun process. */
function deadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const bomb = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error(`${what}: not settled within ${ms}ms`)), ms); });
  return Promise.race([p, bomb]).finally(() => clearTimeout(t));
}

function fakeSseServer(opts: { postAtRoot?: number } = {}): FakeSse {
  const seen: Seen[] = [];
  const sessions = new Map<string, Transport>();
  let count = 0;
  const srv = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      seen.push({ method: req.method, path: url.pathname, auth: req.headers.get("authorization") });
      if (url.pathname === "/sse" && req.method === "GET") {
        const id = crypto.randomUUID();
        count += 1;
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
        const server = new Server({ name: "fake-sse", version: "1.0.0" }, { capabilities: { tools: {} } });
        server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "ping", description: "answers pong", inputSchema: { type: "object" } }] }));
        server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: "text", text: "pong" }] }));
        await server.connect(transport);
        write(`event: endpoint\ndata: /messages?sessionId=${id}\n\n`);
        return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
      }
      if (url.pathname === "/messages" && req.method === "POST") {
        const t = sessions.get(url.searchParams.get("sessionId") ?? "");
        if (!t) return new Response("no such session", { status: 404 });
        t.onmessage?.((await req.json()) as JSONRPCMessage);
        return new Response("Accepted", { status: 202 });
      }
      // the SSE url itself, POSTed to (what a streamable-HTTP client does first): SSE-only servers say 405/404
      if (url.pathname === "/sse" && req.method === "POST") return new Response("nope", { status: opts.postAtRoot ?? 405 });
      return new Response("not found", { status: 404 });
    },
  });
  return {
    url: `http://127.0.0.1:${srv.port}/sse`,
    seen,
    get sessions() { return count; },
    stop() { for (const t of sessions.values()) void t.close(); srv.stop(true); },
  };
}

const live: FakeSse[] = [];
const fake = (opts?: { postAtRoot?: number }): FakeSse => { const f = fakeSseServer(opts); live.push(f); return f; };
afterEach(() => { for (const f of live.splice(0)) f.stop(); });

describe("transport: sse", () => {
  test("a `transport: \"sse\"` url server connects over the SDK SSE transport, lists and calls tools; status reports the sse wire", async () => {
    const f = fake();
    const manager = new McpManager([{ name: "legacy", transport: "sse", url: f.url }], { connectTimeoutMs: 5_000 });
    const res = await deadline(manager.connect(), 8_000, "sse connect");
    expect(res.failed).toEqual([]); // mutation: config.ts skips sse again → the manager never sees this server; client.ts without the SSE branch → "sse server has no …"/connect error
    expect(res.connected).toEqual(["legacy"]);
    const tools = await deadline(manager.listTools(), 5_000, "sse listTools");
    expect(tools).toEqual([{ server: "legacy", name: "ping", description: "answers pong" }]);
    const call = await deadline(manager.callTool("legacy", "ping", {}), 5_000, "sse callTool");
    expect(call).toEqual({ ok: true, output: "pong" });
    expect(manager.status()[0]).toMatchObject({ name: "legacy", transport: "sse", state: "connected", wire: "sse", tools: 1 });
    expect(formatMcpStatus(manager, "/p")).toContain("legacy  connected (sse) · tools 1");
    expect(f.seen.some((s) => s.method === "GET" && s.path === "/sse")).toBe(true);
    expect(f.seen.some((s) => s.method === "POST" && s.path === "/messages")).toBe(true);
    await deadline(manager.close(), 5_000, "sse close");
  }, 20_000);

  test("headers ride the SSE GET and every POST (Authorization for remote servers)", async () => {
    const f = fake();
    const manager = new McpManager([{ name: "auth", transport: "sse", url: f.url, headers: { Authorization: "Bearer sekrit" } }], { connectTimeoutMs: 5_000 });
    expect((await deadline(manager.connect(), 8_000, "sse connect")).failed).toEqual([]);
    await deadline(manager.listTools(), 5_000, "listTools");
    const gets = f.seen.filter((s) => s.method === "GET");
    const posts = f.seen.filter((s) => s.method === "POST" && s.path === "/messages");
    expect(gets.length).toBeGreaterThan(0);
    expect(posts.length).toBeGreaterThan(0);
    expect(gets.every((s) => s.auth === "Bearer sekrit")).toBe(true);
    expect(posts.every((s) => s.auth === "Bearer sekrit")).toBe(true);
    await deadline(manager.close(), 5_000, "close");
  }, 20_000);
});

describe("streamable HTTP → SSE fallback", () => {
  test("a `url` (streamable-HTTP) server whose initialize POST answers 405 is retried ONCE over SSE and connects; status says so", async () => {
    const f = fake({ postAtRoot: 405 });
    const manager = new McpManager([{ name: "auto", transport: "http", url: f.url }], { connectTimeoutMs: 5_000 });
    const res = await deadline(manager.connect(), 10_000, "fallback connect");
    expect(res.failed).toEqual([]); // mutation: drop the isSseOnlySignature retry → failed with "Streamable HTTP error: … 405"
    expect(res.connected).toEqual(["auto"]);
    expect(await deadline(manager.listTools(), 5_000, "listTools")).toEqual([{ server: "auto", name: "ping", description: "answers pong" }]);
    expect(manager.status()[0]).toMatchObject({ transport: "http", wire: "sse", fellBack: true, state: "connected" });
    expect(formatMcpStatus(manager, "/p")).toContain("auto  connected (http → sse fallback)");
    expect(f.seen.filter((s) => s.method === "POST" && s.path === "/sse").length).toBe(1); // exactly one streamable attempt
    expect(f.sessions).toBe(1); // exactly one SSE stream opened
    await deadline(manager.close(), 5_000, "close");
  }, 20_000);

  test("404 on the initialize POST also triggers the fallback", async () => {
    const f = fake({ postAtRoot: 404 });
    const manager = new McpManager([{ name: "auto404", transport: "http", url: f.url }], { connectTimeoutMs: 5_000 });
    const res = await deadline(manager.connect(), 10_000, "fallback connect");
    expect(res.failed).toEqual([]);
    expect(manager.status()[0]).toMatchObject({ wire: "sse", fellBack: true });
    await deadline(manager.close(), 5_000, "close");
  }, 20_000);

  test("any OTHER failure (500) does NOT fall back: the server stays failed with the HTTP error, and no SSE stream is opened", async () => {
    const f = fake({ postAtRoot: 500 });
    const manager = new McpManager([{ name: "broken", transport: "http", url: f.url }], { connectTimeoutMs: 5_000 });
    const res = await deadline(manager.connect(), 10_000, "connect");
    expect(res.connected).toEqual([]);
    expect(res.failed.length).toBe(1);
    expect(res.failed[0]?.error).toContain("(HTTP 500)"); // the SDK message alone omits the status; describeError restores it
    expect(f.sessions).toBe(0); // mutation: fall back on every error → 1
    expect(manager.status()[0]).toMatchObject({ state: "failed", transport: "http" });
    expect(manager.status()[0]?.error).toContain("(HTTP 500)");
    expect(formatMcpStatus(manager, "/p")).toContain("broken  failed (http): Streamable HTTP error: Error POSTing to endpoint: nope (HTTP 500)");
    expect(manager.status()[0]?.wire).toBeUndefined();
    await manager.close();
  }, 20_000);

  test("an explicit `transport: \"sse\"` never tries streamable HTTP first (no POST to the url)", async () => {
    const f = fake({ postAtRoot: 500 }); // a streamable attempt would fail hard here
    const manager = new McpManager([{ name: "direct", transport: "sse", url: f.url }], { connectTimeoutMs: 5_000 });
    expect((await deadline(manager.connect(), 8_000, "connect")).failed).toEqual([]);
    expect(f.seen.filter((s) => s.method === "POST" && s.path === "/sse").length).toBe(0);
    await deadline(manager.close(), 5_000, "close");
  }, 20_000);
});
