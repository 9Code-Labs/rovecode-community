/** The run's AbortSignal is passed to every MCP request, and the SDK adds an abort listener per request
 *  and never removes it (shared/protocol.js:709). Twelve calls into a Playwright session that reached
 *  Node's default limit, and Node printed the emitter it was complaining about — a whole Writable, pages
 *  of it — on stderr, over the TUI's alternate screen. This is the test that keeps that from coming back:
 *  a run signal must come out of a hundred calls with as many listeners as it went in with — through the
 *  tool paths (client.ts) AND the five depth paths of port #57 (prompts-resources.ts: prompts/list,
 *  prompts/get, resources/list, resources/templates/list, resources/read), every one of which hands the
 *  SDK a signal. */

import { expect, test } from "bun:test";
import { McpManager } from "../../src/mcp/client.ts";
import { depthFor } from "../../src/mcp/prompts-resources.ts";

/** count the abort listeners on a signal — getEventListeners is not available here, so the signal is
 *  wrapped and every add/remove is recorded */
function countingSignal(): { signal: AbortSignal; live: () => number } {
  const ac = new AbortController();
  let live = 0;
  const add = ac.signal.addEventListener.bind(ac.signal);
  const remove = ac.signal.removeEventListener.bind(ac.signal);
  Object.defineProperty(ac.signal, "addEventListener", { value: (t: string, l: EventListener, o?: AddEventListenerOptions) => { if (t === "abort") live += 1; add(t, l, o); } });
  Object.defineProperty(ac.signal, "removeEventListener", { value: (t: string, l: EventListener) => { if (t === "abort") live -= 1; remove(t, l); } });
  return { signal: ac.signal, live: () => live };
}

/** a server that answers every request in-process: no child, no socket, no SDK */
function fakeServer(ttlMs = 60_000) {
  const calls: string[] = [];
  const manager = new McpManager([{ name: "s", transport: "stdio", command: "node" }], {
    toolTtlMs: ttlMs,
    transportFactory: () => ({ start: async () => {}, send: async () => {}, close: async () => {} }) as never,
  });
  // the SDK is never reached: the client is planted directly, and it does what the SDK does with a signal
  const leaky = (what: string) => (_a: unknown, opts: { signal?: AbortSignal } = {}) => {
    calls.push(what);
    opts.signal?.addEventListener("abort", () => {});   // protocol.js:709, never removed
  };
  const listen = leaky("list");
  (manager as unknown as { servers: Map<string, { client: unknown }> }).servers.get("s")!.client = {
    getServerCapabilities: () => ({ tools: {}, prompts: {}, resources: {} }),
    callTool: async (_req: unknown, _schema: unknown, opts: { signal?: AbortSignal }) => {
      leaky("call")(undefined, opts);
      return { content: [{ type: "text", text: "ok" }] };
    },
    listTools: async (c: unknown, opts: { signal?: AbortSignal }) => { listen(c, opts); return { tools: [{ name: "t", description: "d", inputSchema: { type: "object" } }] }; },
    listPrompts: async (c: unknown, opts: { signal?: AbortSignal }) => { listen(c, opts); return { prompts: [{ name: "p", description: "d", arguments: [] }] }; },
    listResources: async (c: unknown, opts: { signal?: AbortSignal }) => { listen(c, opts); return { resources: [{ uri: "mem://r", name: "r" }] }; },
    listResourceTemplates: async (c: unknown, opts: { signal?: AbortSignal }) => { listen(c, opts); return { resourceTemplates: [] }; },
    getPrompt: async (c: unknown, opts: { signal?: AbortSignal }) => { leaky("prompt")(c, opts); return { messages: [{ role: "user", content: { type: "text", text: "hi" } }] }; },
    readResource: async (c: unknown, opts: { signal?: AbortSignal }) => { leaky("read")(c, opts); return { contents: [{ uri: "mem://r", text: "x" }] }; },
    close: async () => {},
  };
  return { manager, calls };
}

test("a hundred tool calls leave the run's signal with no listeners of theirs", async () => {
  const { manager, calls } = fakeServer();
  const outer = countingSignal();
  for (let i = 0; i < 100; i++) {
    const r = await manager.callTool("s", "t", {}, outer.signal);
    expect(r.ok).toBe(true);
  }
  expect(calls.filter((c) => c === "call").length).toBe(100);
  expect(outer.live()).toBe(0);   // was 100 before: one per call, and Node shouts at 11
});

test("the run can still abort a call in flight, and a finished call does not abort the run", async () => {
  const { manager } = fakeServer();
  const ac = new AbortController();
  // a call whose signal is already aborted is refused by the SDK's own check, so abort propagates
  ac.abort(new Error("user pressed Esc"));
  const aborted = await manager.callTool("s", "t", {}, ac.signal);
  expect(aborted.ok).toBe(false);

  // and a normal call leaves the outer signal untouched
  const fresh = new AbortController();
  await manager.callTool("s", "t", {}, fresh.signal);
  expect(fresh.signal.aborted).toBe(false);
});

test("the five depth paths (#57): a hundred prompt renders, resource reads and cold listings leave the run's signal with no listeners of theirs", async () => {
  const { manager, calls } = fakeServer(0); // ttl 0: every listing is a request, nothing is served from cache
  const depth = depthFor(manager);
  const outer = countingSignal();
  for (let i = 0; i < 100; i++) {
    expect((await depth.getPrompt("s", "p", {}, outer.signal)).ok).toBe(true);
    expect((await depth.readResource("s", "mem://r", outer.signal)).ok).toBe(true);
    expect((await depth.promptsOf("s", outer.signal)).length).toBe(1);
    const index = await depth.resourcesOf("s", outer.signal); // resources/list + resources/templates/list
    expect(index.resources.length).toBe(1);
  }
  expect(calls.filter((c) => c === "prompt").length).toBe(100);
  expect(calls.filter((c) => c === "read").length).toBe(100);
  expect(calls.filter((c) => c === "list").length).toBe(300);
  expect(outer.live()).toBe(0);   // MUTATION TARGET: pass `signal` straight to the SDK in prompts-resources.ts → 500
});
