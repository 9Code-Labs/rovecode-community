/** The run's AbortSignal is passed to every MCP request, and the SDK adds an abort listener per request
 *  and never removes it (shared/protocol.js:709). Twelve calls into a Playwright session that reached
 *  Node's default limit, and Node printed the emitter it was complaining about — a whole Writable, pages
 *  of it — on stderr, over the TUI's alternate screen. This is the test that keeps that from coming back:
 *  a run signal must come out of a hundred calls with as many listeners as it went in with. */

import { expect, test } from "bun:test";
import { McpManager } from "../../src/mcp/client.ts";

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
function fakeServer() {
  const calls: string[] = [];
  const manager = new McpManager([{ name: "s", transport: "stdio", command: "node" }], {
    transportFactory: () => ({ start: async () => {}, send: async () => {}, close: async () => {} }) as never,
  });
  // the SDK is never reached: the client is planted directly, and it does what the SDK does with a signal
  (manager as unknown as { servers: Map<string, { client: unknown }> }).servers.get("s")!.client = {
    callTool: async (_req: unknown, _schema: unknown, opts: { signal?: AbortSignal }) => {
      calls.push("call");
      opts.signal?.addEventListener("abort", () => {});   // protocol.js:709, never removed
      return { content: [{ type: "text", text: "ok" }] };
    },
    listTools: async (_c: unknown, opts: { signal?: AbortSignal }) => {
      opts.signal?.addEventListener("abort", () => {});
      return { tools: [{ name: "t", description: "d", inputSchema: { type: "object" } }] };
    },
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
  expect(calls.length).toBe(100);
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
