/** Port #15 tests: ACP v1 agent over an in-process duplex, driven by the SDK's
 *  own client side (ClientSideConnection) against mock/scripted StreamFns.
 *  Covers: handshake, prompt round-trip (message chunks), tool-call mapping,
 *  permission mapping (allow / deny / cancelled / unsupported), stop reasons. */

import { test, expect } from "bun:test";
import {
  ClientSideConnection, ndJsonStream, PROTOCOL_VERSION,
  type Client, type SessionNotification,
  type RequestPermissionRequest, type RequestPermissionResponse,
} from "@zed-industries/agent-client-protocol";
import { serveAcp, promptText, updateForEvent, kindFor, titleFor, type AcpOptions, type AionAcpAgent } from "../../src/acp/server.ts";
import type { StreamEvent, StreamFn } from "../../src/core/types.ts";
import { textTurn, toolTurn } from "../../src/providers/stream.ts";
import { McpManager } from "../../src/mcp/client.ts";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

// ---------- rig ----------

class TestClient implements Client {
  updates: SessionNotification[] = [];
  permissionRequests: RequestPermissionRequest[] = [];
  answer: (req: RequestPermissionRequest) => Promise<RequestPermissionResponse> =
    async () => ({ outcome: { outcome: "selected", optionId: "allow-once" } });

  async sessionUpdate(n: SessionNotification): Promise<void> { this.updates.push(n); }
  async requestPermission(req: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    this.permissionRequests.push(req);
    return this.answer(req);
  }

  ofType<K extends SessionNotification["update"]["sessionUpdate"]>(kind: K): Extract<SessionNotification["update"], { sessionUpdate: K }>[] {
    return this.updates.map((u) => u.update)
      .filter((u): u is Extract<SessionNotification["update"], { sessionUpdate: K }> => u.sessionUpdate === kind);
  }
}

/** In-process duplex: agent and client each get an ndJsonStream over two pipes. */
function connect(opts: AcpOptions): { conn: ClientSideConnection; client: TestClient; agent: AionAcpAgent } {
  const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
  const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
  const { agent } = serveAcp(ndJsonStream(agentToClient.writable, clientToAgent.readable), opts);
  const client = new TestClient();
  const conn = new ClientSideConnection(() => client, ndJsonStream(clientToAgent.writable, agentToClient.readable));
  return { conn, client, agent };
}

/** Per-prompt-turn script: call N of the stream yields script[N] (last repeats). */
function scriptedStream(script: StreamEvent[][]): StreamFn {
  let i = 0;
  return async function* () { yield* script[Math.min(i++, script.length - 1)]!; };
}

function tmpCwd(): string { return mkdtempSync(join(tmpdir(), "aion-acp-")); }

async function handshake(conn: ClientSideConnection, cwd: string): Promise<string> {
  const init = await conn.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
  expect(init.protocolVersion).toBe(PROTOCOL_VERSION);
  const s = await conn.newSession({ cwd, mcpServers: [] });
  return s.sessionId;
}

const textPrompt = (sessionId: string, text: string) =>
  ({ sessionId, prompt: [{ type: "text" as const, text }] });

// ---------- handshake ----------

test("initialize negotiates v1 and advertises capabilities honestly", async () => {
  const cwd = tmpCwd();
  try {
    const { conn } = connect({ stream: scriptedStream([[{ type: "turn", turn: textTurn("hi") }]]) });
    const init = await conn.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    expect(init.protocolVersion).toBe(1);
    expect(init.agentCapabilities?.loadSession).toBe(false);
    expect(init.agentCapabilities?.promptCapabilities).toEqual({ image: false, audio: false, embeddedContext: true });
    expect(init.authMethods).toEqual([]);
    const s1 = await conn.newSession({ cwd, mcpServers: [] });
    const s2 = await conn.newSession({ cwd, mcpServers: [] });
    expect(s1.sessionId.length).toBeGreaterThan(0);
    expect(s2.sessionId).not.toBe(s1.sessionId);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("session/new without a provider fails auth_required (-32000)", async () => {
  const cwd = tmpCwd();
  try {
    const { conn } = connect({ stream: null }); // explicit null: no provider stream
    await conn.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    expect.assertions(2);
    try {
      await conn.newSession({ cwd, mcpServers: [] });
    } catch (e) {
      const err = e as { code: number; data?: { details?: string } };
      expect(err.code).toBe(-32000);
      expect(String(err.data?.details)).toContain("no provider configured");
    }
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("prompt on an unknown session is rejected with invalid params", async () => {
  const { conn } = connect({ stream: scriptedStream([[{ type: "turn", turn: textTurn("hi") }]]) });
  await conn.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
  expect.assertions(1);
  try {
    await conn.prompt(textPrompt("no-such-session", "hello"));
  } catch (e) {
    expect((e as { code: number }).code).toBe(-32602);
  }
});

// ---------- prompt round-trip ----------

test("prompt round-trip: text deltas stream as agent_message_chunk, stop is end_turn", async () => {
  const cwd = tmpCwd();
  try {
    const stream = scriptedStream([[
      { type: "text_delta", text: "hello " },
      { type: "text_delta", text: "world" },
      { type: "turn", turn: textTurn("hello world") },
    ]]);
    const { conn, client } = connect({ stream });
    const sessionId = await handshake(conn, cwd);
    const resp = await conn.prompt(textPrompt(sessionId, "greet me"));
    expect(resp.stopReason).toBe("end_turn");
    const chunks = client.ofType("agent_message_chunk");
    expect(chunks.map((c) => (c.content as { text: string }).text)).toEqual(["hello ", "world"]);
    for (const u of client.updates) expect(u.sessionId).toBe(sessionId);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

// ---------- tool-call mapping ----------

test("tool calls surface as tool_call create (in_progress) then tool_call_update (completed)", async () => {
  const cwd = tmpCwd();
  try {
    const file = join(cwd, "notes.txt");
    writeFileSync(file, "acp file body");
    const stream = scriptedStream([
      [{ type: "turn", turn: toolTurn([{ id: "call-1", tool: "read", args: { path: file } }]) }],
      [{ type: "turn", turn: textTurn("done") }],
    ]);
    const { conn, client } = connect({ stream }); // gated mode: file.read is allowed, no prompt
    const sessionId = await handshake(conn, cwd);
    const resp = await conn.prompt(textPrompt(sessionId, "read my notes"));
    expect(resp.stopReason).toBe("end_turn");

    const creates = client.ofType("tool_call");
    expect(creates).toHaveLength(1);
    const create = creates[0]! as Extract<SessionNotification["update"], { sessionUpdate: "tool_call" }>;
    expect(create.toolCallId).toBe("call-1");
    expect(create.status).toBe("in_progress");
    expect(create.kind).toBe("read");
    expect(create.title).toBe(`read: ${file}`);
    expect((create.rawInput as { path: string }).path).toBe(file);

    const ups = client.ofType("tool_call_update");
    expect(ups).toHaveLength(1);
    const up = ups[0]! as Extract<SessionNotification["update"], { sessionUpdate: "tool_call_update" }>;
    expect(up.toolCallId).toBe("call-1");
    expect(up.status).toBe("completed");
    expect(String((up.rawOutput as { output: string }).output)).toContain("acp file body");

    // ordering: create strictly before its update
    const kinds = client.updates.map((u) => u.update.sessionUpdate);
    expect(kinds.indexOf("tool_call")).toBeLessThan(kinds.indexOf("tool_call_update"));
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

// ---------- permission mapping ----------

function writeScript(out: string): StreamFn {
  return scriptedStream([
    [{ type: "turn", turn: toolTurn([{ id: "w1", tool: "write", args: { path: out, content: "acp wrote this" } }]) }],
    [{ type: "turn", turn: textTurn("finished") }],
  ]);
}

test("approval maps to session/request_permission; allow-once executes the tool", async () => {
  const cwd = tmpCwd();
  try {
    const out = join(cwd, "out.txt");
    const { conn, client } = connect({ stream: writeScript(out) });
    client.answer = async () => ({ outcome: { outcome: "selected", optionId: "allow-once" } });
    const sessionId = await handshake(conn, cwd);
    const resp = await conn.prompt(textPrompt(sessionId, "write the file"));
    expect(resp.stopReason).toBe("end_turn");

    expect(client.permissionRequests).toHaveLength(1);
    const req = client.permissionRequests[0]!;
    expect(req.sessionId).toBe(sessionId);
    expect(req.options.map((o) => o.kind)).toEqual(["allow_once", "allow_always", "reject_once"]);
    expect(req.toolCall.toolCallId).toMatch(/^perm-\d+$/);
    expect(req.toolCall.kind).toBe("edit"); // house write → ACP edit
    expect((req.toolCall.rawInput as { path: string }).path).toBe(out);

    expect(existsSync(out)).toBe(true);
    expect(readFileSync(out, "utf8")).toBe("acp wrote this");
    const up = client.ofType("tool_call_update")[0]! as Extract<SessionNotification["update"], { sessionUpdate: "tool_call_update" }>;
    expect(up.toolCallId).toBe("w1");
    expect(up.status).toBe("completed");
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

const denials: Array<[string, (req: RequestPermissionRequest) => Promise<RequestPermissionResponse>]> = [
  ["reject-once selected", async () => ({ outcome: { outcome: "selected", optionId: "reject-once" } })],
  ["cancelled outcome", async () => ({ outcome: { outcome: "cancelled" } })],
  ["unsupported client (request errors)", async () => { throw new Error("permission UI unavailable"); }],
];

for (const [label, answer] of denials) {
  test(`permission ${label} → deny: tool never runs, call surfaces as failed`, async () => {
    const cwd = tmpCwd();
    try {
      const out = join(cwd, "out.txt");
      const { conn, client } = connect({ stream: writeScript(out) });
      client.answer = answer;
      const sessionId = await handshake(conn, cwd);
      const resp = await conn.prompt(textPrompt(sessionId, "write the file"));
      expect(resp.stopReason).toBe("end_turn"); // run continues after the deny
      expect(existsSync(out)).toBe(false);      // the write never executed

      const creates = client.ofType("tool_call") as Extract<SessionNotification["update"], { sessionUpdate: "tool_call" }>[];
      expect(creates).toHaveLength(1);
      expect(creates[0]!.toolCallId).toBe("w1");
      expect(creates[0]!.status).toBe("failed");
      expect(creates[0]!.title).toBe("tool call failed (permission_denied)");
      expect(client.ofType("tool_call_update")).toHaveLength(0); // failed create, nothing to update
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
}

test("yolo mode never asks the client for permission", async () => {
  const cwd = tmpCwd();
  try {
    const out = join(cwd, "out.txt");
    const { conn, client } = connect({ stream: writeScript(out), yolo: true });
    client.answer = async () => { throw new Error("must not be called"); };
    const sessionId = await handshake(conn, cwd);
    const resp = await conn.prompt(textPrompt(sessionId, "write the file"));
    expect(resp.stopReason).toBe("end_turn");
    expect(client.permissionRequests).toHaveLength(0);
    expect(existsSync(out)).toBe(true);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

// ---------- stop-reason mapping ----------

test("run_end error maps to a JSON-RPC internal error carrying the summary", async () => {
  const cwd = tmpCwd();
  try {
    const stream = scriptedStream([[
      { type: "turn", turn: { parts: [], stopReason: "error", usage: { input: 0, output: 0 }, error: "provider exploded" } },
    ]]);
    const { conn } = connect({ stream });
    const sessionId = await handshake(conn, cwd);
    expect.assertions(3);
    try {
      await conn.prompt(textPrompt(sessionId, "boom"));
    } catch (e) {
      const err = e as { code: number; data?: { details?: string } };
      expect(err.code).toBe(-32603);
      expect(String(err.data?.details)).toContain("provider exploded");
    }
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("max-turns budget maps to stopReason max_turn_requests", async () => {
  const cwd = tmpCwd();
  try {
    const file = join(cwd, "f.txt");
    writeFileSync(file, "x");
    // every turn calls a tool → the loop never ends on its own → budget stop at maxTurns
    const stream = scriptedStream([
      [{ type: "turn", turn: toolTurn([{ id: "c", tool: "read", args: { path: file } }]) }],
    ]);
    const { conn } = connect({ stream });
    const sessionId = await handshake(conn, cwd);
    const resp = await conn.prompt(textPrompt(sessionId, "loop forever"));
    expect(resp.stopReason).toBe("max_turn_requests");
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

// ---------- wave-2 fix tests (FW2-L) ----------

/** Stream whose FIRST call parks inside the provider turn (after one delta)
 *  until released — deterministic control over run timing. Later calls answer
 *  immediately. */
function gatedTextStream(): { stream: StreamFn; release: () => void; reached: Promise<void> } {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let sawGate!: () => void;
  const reached = new Promise<void>((r) => { sawGate = r; });
  let calls = 0;
  const stream: StreamFn = async function* (): AsyncGenerator<StreamEvent> {
    if (++calls === 1) {
      yield { type: "text_delta", text: "before-cancel" };
      sawGate();
      await gate;
    }
    yield { type: "turn", turn: textTurn("done") };
  };
  return { stream, release, reached };
}

test("active-guard pin: second prompt while one runs → -32600; session usable after", async () => {
  const cwd = tmpCwd();
  const { stream, release, reached } = gatedTextStream();
  try {
    const { conn } = connect({ stream });
    const sessionId = await handshake(conn, cwd);
    const p1 = conn.prompt(textPrompt(sessionId, "first"));
    await reached; // run 1 is inside its provider turn
    let code = 0;
    try { await conn.prompt(textPrompt(sessionId, "second")); } catch (e) { code = (e as { code: number }).code; }
    expect(code).toBe(-32600); // invalid request: a prompt is already running
    release();
    expect((await p1).stopReason).toBe("end_turn");
    // the guard cleared: a third prompt round-trips
    expect((await conn.prompt(textPrompt(sessionId, "third"))).stopReason).toBe("end_turn");
  } finally { release(); rmSync(cwd, { recursive: true, force: true }); }
});

test("HIGH-G2: session/cancel interrupts an outstanding request_permission → deny; session NOT wedged", async () => {
  const cwd = tmpCwd();
  try {
    const out = join(cwd, "out.txt");
    const { conn, client } = connect({ stream: writeScript(out) });
    let askSeen!: () => void;
    const asked = new Promise<void>((r) => { askSeen = r; });
    // the popup is never answered (client crashed / user closed it)
    client.answer = () => { askSeen(); return new Promise(() => {}); };
    const sessionId = await handshake(conn, cwd);
    const p = conn.prompt(textPrompt(sessionId, "write the file"));
    await asked;                       // the permission request is in flight
    await conn.cancel({ sessionId });  // ← without the race fix, p never resolves (test times out)
    const resp = await p;
    expect(resp.stopReason).toBe("cancelled");
    expect(existsSync(out)).toBe(false); // cancel mapped to deny: the write never ran
    // the session is usable again — not permanently "already running"
    const again = await conn.prompt(textPrompt(sessionId, "carry on"));
    expect(again.stopReason).toBe("end_turn");
    expect(client.permissionRequests).toHaveLength(1); // only the interrupted ask ever happened
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("session/cancel mid-run → stopReason cancelled; nothing forwarded after cancel", async () => {
  const cwd = tmpCwd();
  const { stream, release, reached } = gatedTextStream();
  try {
    const { conn, client } = connect({ stream });
    const sessionId = await handshake(conn, cwd);
    const p = conn.prompt(textPrompt(sessionId, "run"));
    await reached;                     // run parked inside the provider turn
    await conn.cancel({ sessionId });
    release();
    const resp = await p;
    expect(resp.stopReason).toBe("cancelled"); // pin: cancelled, not end_turn
    // cancelled-break pin: the buffered "before-cancel" delta must NOT be
    // forwarded once cancel landed (delete the break → this leaks through)
    expect(client.ofType("agent_message_chunk")).toHaveLength(0);
  } finally { release(); rmSync(cwd, { recursive: true, force: true }); }
});

test("HIGH-G1: session cwd reaches tools — bash pwd runs in the SESSION cwd, not the agent process dir", async () => {
  const cwd = tmpCwd();
  try {
    const stream = scriptedStream([
      [{ type: "turn", turn: toolTurn([{ id: "b1", tool: "bash", args: { command: "pwd" } }]) }],
      [{ type: "turn", turn: textTurn("done") }],
    ]);
    const { conn, client } = connect({ stream, yolo: true }); // no permission round-trip
    const sessionId = await handshake(conn, cwd);
    const resp = await conn.prompt(textPrompt(sessionId, "where am i"));
    expect(resp.stopReason).toBe("end_turn");
    const up = client.ofType("tool_call_update").find((u) => u.toolCallId === "b1") as
      Extract<SessionNotification["update"], { sessionUpdate: "tool_call_update" }> | undefined;
    expect(up).toBeDefined();
    expect(up!.status).toBe("completed");
    const outText = String((up!.rawOutput as { output: string }).output);
    // mkdtemp basename is unique — provably the session cwd, not process.cwd()
    expect(outText).toContain(basename(cwd));
    expect(basename(process.cwd())).not.toBe(basename(cwd));
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("MED-G3: shutdown() closes every session runtime's MCP manager (stdin-close reap seam)", async () => {
  const cwd = tmpCwd();
  writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { toy: { command: "aion-not-a-real-binary-acp" } } }));
  const closed: McpManager[] = [];
  const orig = McpManager.prototype.close;
  McpManager.prototype.close = async function (this: McpManager) { closed.push(this); return orig.call(this); };
  try {
    const { conn, agent } = connect({ stream: scriptedStream([[{ type: "turn", turn: textTurn("hi") }]]) });
    const s1 = await handshake(conn, cwd);        // session runtime with a non-null mcp
    const s2 = await conn.newSession({ cwd, mcpServers: [] });
    expect(s2.sessionId).not.toBe(s1);
    expect(closed.length).toBe(0);
    await agent.shutdown();
    expect(closed.length).toBe(2);                // BOTH sessions reaped
    expect(new Set(closed).size).toBe(2);
  } finally {
    McpManager.prototype.close = orig;
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ---------- pure translation helpers ----------

test("promptText flattens baseline blocks and marks unsupported ones", () => {
  expect(promptText([
    { type: "text", text: "fix the bug" },
    { type: "resource_link", uri: "file:///a.ts", name: "a.ts" },
    { type: "resource", resource: { uri: "file:///b.ts", text: "const b = 1;" } },
    { type: "image", data: "AAAA", mimeType: "image/png" },
  ])).toBe([
    "fix the bug",
    "[resource: file:///a.ts]",
    '<context uri="file:///b.ts">\nconst b = 1;\n</context>',
    "[unsupported image content omitted]",
  ].join("\n"));
});

test("lifecycle-only RunEvents have no ACP counterpart", () => {
  expect(updateForEvent({ type: "run_start", runId: "r", sessionId: "s", goal: "g" })).toBeNull();
  expect(updateForEvent({ type: "turn_start", turn: 1 })).toBeNull();
  expect(updateForEvent({ type: "turn_end", turn: 1, stopReason: "end_turn" })).toBeNull();
  expect(updateForEvent({ type: "steer", text: "t" })).toBeNull();
  expect(updateForEvent({ type: "compaction", strategy: "s", tokensBefore: 2, tokensAfter: 1 })).toBeNull();
  expect(updateForEvent({ type: "run_end", status: "done", summary: "" })).toBeNull();
});

test("tool kind and title mapping", () => {
  expect(kindFor("read")).toBe("read");
  expect(kindFor("edit")).toBe("edit");
  expect(kindFor("write")).toBe("edit");
  expect(kindFor("bash")).toBe("execute");
  expect(kindFor("mystery")).toBe("other");
  expect(titleFor("bash", { command: "ls -la" })).toBe("bash: ls -la");
  expect(titleFor("read", { path: "/a/b.txt" })).toBe("read: /a/b.txt");
  expect(titleFor("skills_list", {})).toBe("skills_list");
});

test("tool_execution_update maps to a content-only tool_call_update", () => {
  const u = updateForEvent({ type: "tool_execution_update", callId: "c9", note: "step 2 of 5" });
  expect(u).toEqual({
    sessionUpdate: "tool_call_update", toolCallId: "c9",
    content: [{ type: "content", content: { type: "text", text: "step 2 of 5" } }],
  });
});
