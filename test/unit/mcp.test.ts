/** Port #3 tests: MCP client + lazy tool disclosure.
 *  In-process McpServer over InMemoryTransport (no child processes except the
 *  deliberately-bogus stdio command in the failure-isolation test). */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { loadMcpConfig, McpManager, type McpServerConfig } from "../../src/mcp/client.ts";
import { createMcpTools } from "../../src/mcp/tools.ts";
import type { Tool, ToolContext } from "../../src/core/types.ts";

// ---------- fixtures ----------

const tmpDirs: string[] = [];
function makeTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-mcp-"));
  tmpDirs.push(dir);
  return dir;
}

function ctx(signal?: AbortSignal): ToolContext {
  return {
    sessionId: "test",
    cwd: process.cwd(),
    signal: signal ?? new AbortController().signal,
    permissions: { effect: "allow" },
  };
}

let serverSawAbort = false;

/** > 60 chars on purpose so the DESC_MAX cap test actually exercises truncation. */
const LONG_DESC = "This deliberately verbose description keeps going well past the sixty character index cap to prove truncation.";

function makeToyServer(): McpServer {
  const server = new McpServer({ name: "toy", version: "1.0.0" });
  server.registerTool(
    "echo",
    { description: "Echo text back to the caller", inputSchema: { text: z.string() } },
    async ({ text }) => ({ content: [{ type: "text", text: `echo: ${text}` }] }),
  );
  server.registerTool("verbose", { description: LONG_DESC }, async () => ({ content: [{ type: "text", text: "v" }] }));
  server.registerTool("progressy", { description: "Reports progress then finishes" }, async (extra) => {
    const token = extra._meta?.progressToken;
    if (token !== undefined) {
      await extra.sendNotification({
        method: "notifications/progress",
        params: { progressToken: token, progress: 1, total: 2, message: "halfway" },
      });
    }
    return { content: [{ type: "text", text: "done" }] };
  });
  server.registerTool(
    "add",
    { description: "Add two numbers", inputSchema: { a: z.number(), b: z.number() } },
    async ({ a, b }) => ({ content: [{ type: "text", text: String(a + b) }] }),
  );
  server.registerTool(
    "slow",
    { description: "Sleep for ms milliseconds, then return", inputSchema: { ms: z.number() } },
    async ({ ms }, extra) => {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        extra.signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            serverSawAbort = true;
            resolve();
          },
          { once: true },
        );
      });
      return { content: [{ type: "text", text: "slept" }] };
    },
  );
  return server;
}

let toyServer: McpServer;
/** Each manager gets its own factory so parallel/isolated managers cannot
 *  clobber the shared `toyServer` handle. */
function makeToyFactory(onServer?: (s: McpServer) => void) {
  return async (config: McpServerConfig): Promise<Transport | undefined> => {
    if (config.name !== "toy") return undefined; // others take the real (stdio/http) path
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = makeToyServer();
    onServer?.(server);
    await server.connect(serverTransport);
    return clientTransport;
  };
}

let manager: McpManager;
let houseTools: Tool[];
function mcpList(): Tool {
  const t = houseTools[0];
  if (!t) throw new Error("mcp_list missing");
  return t;
}
function mcpCall(): Tool {
  const t = houseTools[1];
  if (!t) throw new Error("mcp_call missing");
  return t;
}

beforeAll(async () => {
  manager = new McpManager([{ name: "toy", transport: "stdio", command: "unused-inmemory" }], {
    transportFactory: makeToyFactory((s) => {
      toyServer = s;
    }),
  });
  const res = await manager.connect();
  if (res.failed.length > 0) throw new Error(`toy server failed to connect: ${res.failed[0]?.error}`);
  houseTools = createMcpTools(manager);
});

afterAll(async () => {
  await manager.close();
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

// ---------- loadMcpConfig ----------

describe("loadMcpConfig", () => {
  test("merges .mcp.json and .rovecode/mcp.json with ours winning on name clash", () => {
    const dir = makeTmp();
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          dupe: { command: "harvest-cmd" },
          beta: { type: "http", url: "http://localhost:9091/mcp" },
        },
      }),
    );
    mkdirSync(join(dir, ".rovecode"));
    writeFileSync(
      join(dir, ".rovecode", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          dupe: { url: "http://localhost:8080/mcp" },
          alpha: { command: "bun", args: ["run", "srv.ts"], env: { FOO: "1" } },
        },
      }),
    );
    const warnings: string[] = [];
    const configs = loadMcpConfig(dir, warnings);
    expect(warnings).toEqual([]);
    expect(configs.map((c) => c.name).sort()).toEqual(["alpha", "beta", "dupe"]);
    const dupe = configs.find((c) => c.name === "dupe");
    expect(dupe?.transport).toBe("http"); // ours won
    expect(dupe?.url).toBe("http://localhost:8080/mcp");
    const alpha = configs.find((c) => c.name === "alpha");
    expect(alpha?.transport).toBe("stdio");
    expect(alpha?.args).toEqual(["run", "srv.ts"]);
    expect(alpha?.env).toEqual({ FOO: "1" });
    const beta = configs.find((c) => c.name === "beta");
    expect(beta?.transport).toBe("http");
  });

  test("tolerates malformed files and entries: skip + collect warnings; port #57: a legacy sse entry is a CONFIG now, not a skip", () => {
    const dir = makeTmp();
    writeFileSync(join(dir, ".mcp.json"), "{ this is not json");
    mkdirSync(join(dir, ".rovecode"));
    writeFileSync(
      join(dir, ".rovecode", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          bad: {}, // neither command nor url
          good: { command: "bun" },
          legacy: { type: "sse", url: "http://x/sse" },
          ssenourl: { transport: "sse" }, // sse still needs a url
        },
      }),
    );
    const warnings: string[] = [];
    const configs = loadMcpConfig(dir, warnings);
    expect(configs.map((c) => c.name)).toEqual(["good", "legacy"]);
    expect(configs.find((c) => c.name === "legacy")).toEqual({ name: "legacy", transport: "sse", url: "http://x/sse" });
    expect(warnings.length).toBe(3);
    expect(warnings.some((w) => w.includes("invalid JSON"))).toBe(true);
    expect(warnings.some((w) => w.includes("neither command nor url"))).toBe(true);
    expect(warnings.some((w) => w.includes('sse server "ssenourl" is missing url'))).toBe(true);
    expect(warnings.some((w) => w.includes("unsupported"))).toBe(false); // mutation: the old "legacy sse … unsupported; skipped" branch back → fails here AND on the names above
  });

  test("missing files produce an empty config and no warnings", () => {
    const dir = makeTmp();
    const warnings: string[] = [];
    expect(loadMcpConfig(dir, warnings)).toEqual([]);
    expect(warnings).toEqual([]);
  });

  test("http headers survive normalization (auth for remote servers); non-strings dropped like env", () => {
    const dir = makeTmp();
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          remote: { type: "http", url: "http://localhost:9092/mcp", headers: { Authorization: "Bearer tok", "X-Bad": 7 } },
        },
      }),
    );
    const warnings: string[] = [];
    const configs = loadMcpConfig(dir, warnings);
    expect(warnings).toEqual([]);
    expect(configs[0]?.headers).toEqual({ Authorization: "Bearer tok" });
  });

  test("ours also accepts a servers[] array form with enabled flag", () => {
    const dir = makeTmp();
    mkdirSync(join(dir, ".rovecode"));
    writeFileSync(
      join(dir, ".rovecode", "mcp.json"),
      JSON.stringify({ servers: [{ name: "arr", transport: "stdio", command: "bun", enabled: false }] }),
    );
    const configs = loadMcpConfig(dir);
    expect(configs).toEqual([{ name: "arr", transport: "stdio", command: "bun", enabled: false }]);
  });
});

// ---------- connect isolation ----------

describe("McpManager.connect", () => {
  test("a failing server lands in failed[] without breaking the others", async () => {
    const isolated = new McpManager(
      [
        { name: "bogus", transport: "stdio", command: "rovecode-definitely-not-a-real-binary-xyz" },
        { name: "toy", transport: "stdio", command: "unused-inmemory" },
      ],
      { transportFactory: makeToyFactory(), connectTimeoutMs: 5_000 },
    );
    const res = await isolated.connect(); // must not throw
    expect(res.connected).toEqual(["toy"]);
    expect(res.failed.length).toBe(1);
    expect(res.failed[0]?.name).toBe("bogus");
    expect(res.failed[0]?.error.length).toBeGreaterThan(0);
    await isolated.close();
  });

  test("disabled servers are skipped entirely", async () => {
    const isolated = new McpManager([{ name: "off", transport: "stdio", command: "whatever", enabled: false }]);
    const res = await isolated.connect();
    expect(res.connected).toEqual([]);
    expect(res.failed).toEqual([]);
    await isolated.close();
  });
});

// ---------- lazy disclosure invariant ----------

describe("createMcpTools", () => {
  test("exactly six house tools (#3 pair + #57 quartet) with tiny schemas (< 4500 chars combined)", () => {
    expect(houseTools.map((t) => t.schema.name)).toEqual(["mcp_list", "mcp_call", "mcp_prompts", "mcp_prompt", "mcp_resources", "mcp_read"]);
    expect(mcpList().kind).toBe("read");
    expect(mcpCall().kind).toBe("custom");
    expect(houseTools.slice(2).every((t) => t.kind === "read")).toBe(true); // prompts/resources ride the file.read allow
    const combined = JSON.stringify(houseTools.map((t) => t.schema));
    expect(combined.length).toBeLessThan(4_500); // the lazy-disclosure invariant: six tools, still ~1k tokens, never a server schema
    expect(JSON.stringify([mcpList().schema, mcpCall().schema]).length).toBeLessThan(2_000); // the #3 pair keeps its own bound
  });
});

// ---------- mcp_list ----------

describe("mcp_list", () => {
  test("compact index: server/tool — description, capped at 60 chars", async () => {
    const res = await mcpList().execute({}, ctx());
    expect(res.ok).toBe(true);
    expect(res.output).toContain("toy/echo — Echo text back to the caller");
    expect(res.output).toContain("toy/add — Add two numbers");
    // the fixture really exceeds the cap, and the cap really bites (59 chars + ellipsis)
    expect(LONG_DESC.length).toBeGreaterThan(60);
    const verbose = res.output.split("\n").find((l) => l.startsWith("toy/verbose — ")) ?? "";
    const desc = verbose.slice(verbose.indexOf(" — ") + 3);
    expect(desc).toBe(`${LONG_DESC.slice(0, 59)}…`);
    expect(desc.length).toBe(60);
    for (const line of res.output.split("\n")) {
      const sep = line.indexOf(" — ");
      if (sep >= 0) expect(line.length - sep - 3).toBeLessThanOrEqual(60);
    }
  });

  test("schema mode returns the full JSON input schema for one tool", async () => {
    const res = await mcpList().execute({ server: "toy", tool: "add", schema: true }, ctx());
    expect(res.ok).toBe(true);
    expect(res.output).toContain('"a"');
    expect(res.output).toContain('"b"');
    expect(res.output).toContain("toy/add");
  });

  test("unknown server filter reports connected servers", async () => {
    const res = await mcpList().execute({ server: "ghost" }, ctx());
    expect(res.ok).toBe(false);
    expect(res.output).toContain('"ghost" is not connected');
    expect(res.output).toContain("toy");
  });
});

// ---------- manager schema lookup ----------

describe("McpManager.toolSchema", () => {
  test("returns the schema on demand; undefined for unknowns", async () => {
    const schema = await manager.toolSchema("toy", "echo");
    expect(schema).toBeDefined();
    expect(JSON.stringify(schema)).toContain('"text"');
    expect(await manager.toolSchema("toy", "missing-tool")).toBeUndefined();
    expect(await manager.toolSchema("ghost", "echo")).toBeUndefined();
  });
});

// ---------- mcp_call ----------

describe("mcp_call", () => {
  test("happy path: echo and add", async () => {
    const echo = await mcpCall().execute({ server: "toy", tool: "echo", args: { text: "hi" } }, ctx());
    expect(echo.ok).toBe(true);
    expect(echo.output).toBe("echo: hi");
    const add = await mcpCall().execute({ server: "toy", tool: "add", args: { a: 2, b: 3 } }, ctx());
    expect(add.ok).toBe(true);
    expect(add.output).toBe("5");
  });

  test("unknown tool: ok:false listing what is available", async () => {
    const res = await mcpCall().execute({ server: "toy", tool: "nope", args: {} }, ctx());
    expect(res.ok).toBe(false);
    expect(res.output).toContain('unknown tool "nope"');
    expect(res.output).toContain("echo");
  });

  test("unknown server: ok:false listing known servers", async () => {
    const res = await mcpCall().execute({ server: "ghost", tool: "echo", args: {} }, ctx());
    expect(res.ok).toBe(false);
    expect(res.output).toContain('unknown MCP server "ghost"');
    expect(res.output).toContain("toy");
  });

  test("missing/invalid required fields fail fast", async () => {
    const res = await mcpCall().execute({ tool: "echo" }, ctx());
    expect(res.ok).toBe(false);
    expect(res.output).toContain("mcp_call requires");
  });

  test("non-object args: error path includes the input schema for self-correction", async () => {
    const res = await mcpCall().execute({ server: "toy", tool: "echo", args: 42 }, ctx());
    expect(res.ok).toBe(false);
    expect(res.output).toContain("must be a JSON object");
    expect(res.output).toContain("input schema for toy/echo");
    expect(res.output).toContain('"text"');
  });

  test("abort signal propagates: rejects fast and reaches the server handler", async () => {
    const ac = new AbortController();
    const started = Date.now();
    const pending = mcpCall().execute({ server: "toy", tool: "slow", args: { ms: 8_000 } }, ctx(ac.signal));
    setTimeout(() => ac.abort(), 50);
    const res = await pending;
    const elapsed = Date.now() - started;
    expect(res.ok).toBe(false);
    expect(elapsed).toBeLessThan(3_000); // way below the 8s sleep
    await Bun.sleep(100); // let the cancellation notification land server-side
    expect(serverSawAbort).toBe(true);
  });

  test("server progress notifications surface via ctx.onUpdate (arms resetTimeoutOnProgress)", async () => {
    const notes: string[] = [];
    const c: ToolContext = { ...ctx(), onUpdate: (n) => notes.push(n) };
    const res = await mcpCall().execute({ server: "toy", tool: "progressy", args: {} }, c);
    expect(res.ok).toBe(true);
    expect(res.output).toBe("done");
    expect(notes).toContain("halfway"); // onprogress wired → SDK sent a progress token
  });
});

// ---------- tool index cache (last: mutates the toy server) ----------

describe("McpManager.listTools cache", () => {
  test("serves from cache within ttl; refresh picks up new tools", async () => {
    const before = await manager.listTools();
    expect(before.map((t) => `${t.server}/${t.name}`)).toContain("toy/echo");
    toyServer.registerTool("extra", { description: "registered after connect" }, async () => ({
      content: [{ type: "text", text: "x" }],
    }));
    const cached = await manager.listTools();
    expect(cached.map((t) => t.name)).not.toContain("extra"); // ttl cache still fresh
    const refreshed = await manager.listTools(true);
    expect(refreshed.map((t) => t.name)).toContain("extra");
  });
});


/** a linked in-memory MCP server that lists one tool — enough for connect() to succeed */
async function linked(name: string): Promise<Transport> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = new McpServer({ name, version: "1.0.0" });
  server.registerTool("ping", { description: "d", inputSchema: {} }, async () => ({ content: [{ type: "text", text: "pong" }] }));
  await server.connect(serverTransport);
  return clientTransport;
}

/** `sync` is what lets an install be usable in the session that installed it, instead of ending in
 *  "restart rovecode". The rules it has to keep: a running server is not disturbed, a vanished one is
 *  closed, and a new one is added disconnected so `connect()` picks it up. */
describe("sync: adding a server to a live manager", () => {
  const cfg = (name: string): McpServerConfig => ({ name, transport: "stdio", command: "unused-inmemory" });

  test("a server added after connect() joins the session, and the one already running is untouched", async () => {
    let firstOpens = 0;
    const m = new McpManager([cfg("first")], {
      transportFactory: async (c) => {
        if (c.name === "first") firstOpens += 1;
        return linked(c.name);
      },
    });
    await m.connect();
    expect(m.connectedNames()).toEqual(["first"]);
    expect(firstOpens).toBe(1);

    const { added, removed } = await m.sync([cfg("first"), cfg("second")]);
    expect(added).toEqual(["second"]);
    expect(removed).toEqual([]);
    expect(m.connectedNames()).toEqual(["first"]);   // not connected until connect() is called

    await m.connect();
    expect(m.connectedNames().sort()).toEqual(["first", "second"]);
    // the point of leaving known servers alone: re-adding one must not drop and reopen a live connection
    expect(firstOpens).toBe(1);
    await m.close();
  });

  test("a server that disappeared from the files is closed and forgotten", async () => {
    const m = new McpManager([cfg("a"), cfg("b")], { transportFactory: async (c) => linked(c.name) });
    await m.connect();
    expect(m.connectedNames().sort()).toEqual(["a", "b"]);

    const { added, removed } = await m.sync([cfg("a")]);
    expect(removed).toEqual(["b"]);
    expect(added).toEqual([]);
    expect(m.serverNames()).toEqual(["a"]);
    expect(m.connectedNames()).toEqual(["a"]);
    await m.close();
  });

  test("syncing to nothing empties the manager without throwing", async () => {
    const m = new McpManager([cfg("only")], { transportFactory: async (c) => linked(c.name) });
    await m.connect();
    await m.sync([]);
    expect(m.serverNames()).toEqual([]);
    expect(m.connectedNames()).toEqual([]);
    await m.close();
  });
});

// ---------- boot cost: the SDK is not the price of knowing a server exists ----------

/** Requiring client.ts used to evaluate the whole MCP SDK (~200 ms of zod schemas) inside createRuntime,
 *  ahead of the first painted frame. A fresh process is the only honest way to check: this test file has
 *  the SDK loaded already (it hosts a toy McpServer), so the module graph is inspected in a child. */
describe("mcp/client.ts loads without the SDK", () => {
  test("importing the module pulls in no @modelcontextprotocol module; the first connect() does", async () => {
    const dir = makeTmp();
    const script = join(dir, "probe.ts");
    const clientPath = join(process.cwd(), "src", "mcp", "client.ts").replace(/\\/g, "/");
    writeFileSync(script, [
      `const mod = await import(${JSON.stringify(clientPath)});`,
      `const sdk = () => Object.keys(require.cache).filter((k) => k.includes("modelcontextprotocol")).length;`,
      `const before = sdk();`,
      // a command that cannot exist: the connect fails, but only after the SDK (Client, StdioClientTransport) is loaded
      `const m = new mod.McpManager([{ name: "nope", transport: "stdio", command: "rovecode-definitely-not-a-real-binary-probe" }], { connectTimeoutMs: 2_000 });`,
      `await m.connect();`,
      `console.log(JSON.stringify({ before, after: sdk() }));`,
    ].join("\n"));
    const proc = Bun.spawn([process.execPath, "run", script], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    expect(await proc.exited).toBe(0);
    const lines = out.trim().split("\n");
    const r = JSON.parse(lines[lines.length - 1] ?? "{}") as { before: number; after: number };
    expect(r.before).toBe(0);               // mutation: a top-level `import { Client } from "@modelcontextprotocol/sdk/..."` → > 0
    expect(r.after).toBeGreaterThan(0);     // and the lazy path really does load it (the probe is not vacuous)
    expect(err).not.toContain("error:");
  }, 20_000);
});

// ---------- connect(): parallel waiting, staggered starting ----------

describe("connect() starts one server per event-loop turn", () => {
  const cfg = (name: string): McpServerConfig => ({ name, transport: "stdio", command: "unused-inmemory" });

  test("the second transport is built in a later timer turn than the first, and both still connect", async () => {
    // a zero timer armed BEFORE connect() fires before any timer connect() arms itself (same delay → FIFO):
    // the first server's transport must be built ahead of it, the second one only after it
    const turnsSeen: Record<string, boolean> = {};
    let timerFired = false;
    const m = new McpManager([cfg("a"), cfg("b")], {
      transportFactory: async (c) => { turnsSeen[c.name] = timerFired; return linked(c.name); },
    });
    setTimeout(() => { timerFired = true; }, 0);
    const res = await m.connect();
    expect(res.connected.sort()).toEqual(["a", "b"]);
    expect(turnsSeen).toEqual({ a: false, b: true }); // mutation: drop the yield between starts → { a: false, b: false }
    await m.close();
  });

  test("one server starts at once — no yield in front of the first (an idle turn would delay every single-server boot)", async () => {
    let timerFired = false;
    let seen: boolean | undefined;
    const m = new McpManager([cfg("solo")], { transportFactory: async (c) => { seen = timerFired; return linked(c.name); } });
    setTimeout(() => { timerFired = true; }, 0);
    await m.connect();
    expect(seen).toBe(false);
    await m.close();
  });
});
