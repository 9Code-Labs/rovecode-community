/** Integration tests for the headless HTTP server (port #19): real fetch against
 *  a Bun.serve instance on an ephemeral port, with an injected scripted StreamFn
 *  (no provider env needed). Servers are closed in afterAll — no orphan sockets. */

import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, DEFAULT_PORT, DEFAULT_HOSTNAME, type AionServer } from "../../src/server/http.ts";
import type { Message, ModelRef, RunEvent, StreamEvent, StreamFn, StreamOptions } from "../../src/core/types.ts";
import type { SessionSummary } from "../../src/core/session.ts";

// ---------- scripted stream (goal-keyed, order-independent across tests) ----------

function lastUserText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === "user") {
      return m.parts.filter((p) => p.kind === "text").map((p) => (p as { text: string }).text).join("");
    }
  }
  return "";
}

const scripted: StreamFn = async function* (
  _model: ModelRef, messages: Message[], _opts?: StreamOptions,
): AsyncGenerator<StreamEvent> {
  const last = messages[messages.length - 1];
  if (last && last.role === "tool") {
    // a tool batch just ran (or failed) — close the run
    yield { type: "turn", turn: { parts: [{ kind: "text", text: "AFTER-TOOL" }], stopReason: "end_turn", usage: { input: 0, output: 1 } } };
    return;
  }
  const goal = lastUserText(messages);
  if (goal.includes("SLOW")) await new Promise((r) => setTimeout(r, 300));
  if (goal.includes("GATED")) {
    // bash → action shell.exec → default rules say effect "prompt" → over HTTP
    // there is no approver, so the registry must fail the call unexecuted
    yield { type: "turn", turn: { parts: [{ kind: "tool_call", id: "gated-1", tool: "bash", args: { command: "echo gated-test" } }], stopReason: "tool_use", usage: { input: 0, output: 1 } } };
    return;
  }
  yield { type: "text_delta", text: "PONG" };
  yield { type: "turn", turn: { parts: [{ kind: "text", text: "PONG" }], stopReason: "end_turn", usage: { input: 1, output: 1 } } };
};

// ---------- shared server (ephemeral port, tmp cwd) ----------

const cwd = mkdtempSync(join(tmpdir(), "aion-srv-"));
const servers: AionServer[] = [];
const srv = startServer({ port: 0, cwd, stream: scripted });
servers.push(srv);
const base = srv.url;

afterAll(async () => {
  for (const s of servers) await s.stop(); // house rule: no orphan sockets
  rmSync(cwd, { recursive: true, force: true });
});

// ---------- helpers ----------

async function createSession(url = base): Promise<string> {
  const res = await fetch(`${url}/session`, { method: "POST" });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { id: string };
  expect(typeof body.id).toBe("string");
  expect(body.id.length).toBeGreaterThan(0);
  return body.id;
}

interface Frame { name: string; data: RunEvent }

/** Parse a complete SSE body into frames, asserting the bar's exact framing:
 *  `event: <type>\ndata: <json>\n\n`, and event name === data.type. */
function parseFrames(sseBody: string): Frame[] {
  const frames: Frame[] = [];
  for (const chunk of sseBody.split("\n\n")) {
    if (!chunk.trim()) continue;
    const lines = chunk.split("\n");
    expect(lines.length).toBe(2); // exactly one event line + one data line per frame
    expect(lines[0]!.startsWith("event: ")).toBe(true);
    expect(lines[1]!.startsWith("data: ")).toBe(true);
    const name = lines[0]!.slice("event: ".length);
    const data = JSON.parse(lines[1]!.slice("data: ".length)) as RunEvent;
    expect(data.type).toBe(name as RunEvent["type"]); // discriminator matches framing
    frames.push({ name, data });
  }
  return frames;
}

async function promptSse(sessionId: string, text: string, url = base): Promise<{ res: Response; frames: Frame[] }> {
  const res = await fetch(`${url}/session/${sessionId}/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("text/event-stream");
  // res.text() resolving proves the stream CLOSED (bar: closes on run_end)
  const frames = parseFrames(await res.text());
  return { res, frames };
}

// ---------- bar tests ----------

test("defaults: port 4100, loopback hostname", () => {
  expect(DEFAULT_PORT).toBe(4100);
  expect(DEFAULT_HOSTNAME).toBe("127.0.0.1");
  expect(srv.hostname).toBe("127.0.0.1");
  expect(srv.port).toBeGreaterThan(0); // ephemeral port actually bound
});

test("POST /session creates a session and returns {id}", async () => {
  const id = await createSession();
  // a second create returns a DIFFERENT session
  const id2 = await createSession();
  expect(id2).not.toBe(id);
});

test("prompt round-trip: SSE stream of typed RunEvents, run_start…run_end, closes", async () => {
  const id = await createSession();
  const { frames } = await promptSse(id, "hello server");

  expect(frames.length).toBeGreaterThanOrEqual(4);
  const first = frames[0]!.data;
  expect(first.type).toBe("run_start");
  if (first.type === "run_start") {
    expect(first.goal).toBe("hello server");
    expect(first.sessionId).toBe(id); // the run uses THIS session's store
  }
  // streaming deltas made it through as typed events
  const upd = frames.find((f) => f.data.type === "message_update");
  expect(upd).toBeDefined();
  if (upd && upd.data.type === "message_update") expect(upd.data.delta).toBe("PONG");
  expect(frames.some((f) => f.data.type === "turn_start")).toBe(true);
  expect(frames.some((f) => f.data.type === "turn_end")).toBe(true);
  // terminal frame is run_end and NOTHING follows it
  const last = frames[frames.length - 1]!.data;
  expect(last.type).toBe("run_end");
  if (last.type === "run_end") {
    expect(last.status).toBe("done");
    expect(last.summary).toContain("PONG");
  }
  expect(frames.filter((f) => f.data.type === "run_end").length).toBe(1);
});

test("GET /sessions lists created sessions with previews", async () => {
  const id = await createSession();
  await promptSse(id, "list me please");
  const res = await fetch(`${base}/sessions`);
  expect(res.status).toBe(200);
  const list = (await res.json()) as SessionSummary[];
  const mine = list.find((s) => s.id === id);
  expect(mine).toBeDefined();
  expect(mine!.preview).toBe("list me please"); // first user message surfaced
  expect(mine!.entryCount).toBeGreaterThanOrEqual(2); // user + assistant persisted
  expect(mine!.updatedAt).toBeGreaterThanOrEqual(mine!.createdAt);
});

test("GET /doc: parseable OpenAPI 3.1 with exactly the four routes + honesty note", async () => {
  const res = await fetch(`${base}/doc`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("application/json");
  const doc = (await res.json()) as {
    openapi: string;
    info: { description: string };
    servers: { url: string }[];
    paths: Record<string, Record<string, { description?: string }>>;
    components: { schemas: { RunEvent: { properties: { type: { enum: string[] } } } } };
  };
  expect(doc.openapi).toStartWith("3.1");
  expect(Object.keys(doc.paths).sort()).toEqual(["/doc", "/session", "/session/{id}/prompt", "/sessions"]);
  expect(doc.paths["/session"]!.post).toBeDefined();
  expect(doc.paths["/session/{id}/prompt"]!.post).toBeDefined();
  expect(doc.paths["/sessions"]!.get).toBeDefined();
  expect(doc.paths["/doc"]!.get).toBeDefined();
  expect(doc.servers[0]!.url).toBe(base); // doc reflects the actually-bound URL
  // honesty note: policy-only approvals, in the top-level description AND on the prompt op
  expect(doc.info.description).toContain("policy-only");
  expect(doc.info.description).toContain("no interactive approver");
  expect(doc.paths["/session/{id}/prompt"]!.post!.description).toContain("policy-only");
  // RunEvent enum matches the loop's discriminators we rely on
  const evTypes = doc.components.schemas.RunEvent.properties.type.enum;
  for (const t of ["run_start", "message_update", "tool_call_failed", "run_end"]) {
    expect(evTypes).toContain(t);
  }
});

test("gated tool without approver: prompt-effect rule surfaces as FAILED tool call, never executes", async () => {
  const id = await createSession();
  const { frames } = await promptSse(id, "GATED run the tool");

  // the call failed at the permission seam…
  const failed = frames.find((f) => f.data.type === "tool_call_failed");
  expect(failed).toBeDefined();
  if (failed && failed.data.type === "tool_call_failed") {
    expect(failed.data.callId).toBe("gated-1");
    expect(failed.data.reason).toBe("permission_denied");
    expect(failed.data.detail).toContain("no approver");
  }
  // …and the tool NEVER started executing
  expect(frames.some((f) => f.data.type === "tool_execution_start")).toBe(false);
  expect(frames.some((f) => f.data.type === "tool_execution_end")).toBe(false);
  // the run survives the failure and terminates normally
  const last = frames[frames.length - 1]!.data;
  expect(last.type).toBe("run_end");
  if (last.type === "run_end") expect(last.status).toBe("done");
});

test("yolo server executes the same gated tool (policy is the only difference)", async () => {
  const yoloSrv = startServer({ port: 0, cwd, stream: scripted, yolo: true });
  servers.push(yoloSrv);
  const id = await createSession(yoloSrv.url);
  const { frames } = await promptSse(id, "GATED run the tool", yoloSrv.url);
  expect(frames.some((f) => f.data.type === "tool_call_failed")).toBe(false);
  const end = frames.find((f) => f.data.type === "tool_execution_end");
  expect(end).toBeDefined();
  if (end && end.data.type === "tool_execution_end") {
    expect(end.data.ok).toBe(true);
    expect(end.data.output).toContain("gated-test");
  }
});

// ---------- error-path tests (never-throw seam) ----------

test("prompt on unknown session → 404 JSON, server stays up", async () => {
  const res = await fetch(`${base}/session/nope/prompt`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "x" }),
  });
  expect(res.status).toBe(404);
  expect(((await res.json()) as { error: string }).error).toContain("unknown session");
});

test("malformed / wrong-shape bodies → 400", async () => {
  const id = await createSession();
  const bad = await fetch(`${base}/session/${id}/prompt`, { method: "POST", body: "{not json" });
  expect(bad.status).toBe(400);
  const noText = await fetch(`${base}/session/${id}/prompt`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: 42 }),
  });
  expect(noText.status).toBe(400);
});

test("unknown route and wrong method → 404", async () => {
  expect((await fetch(`${base}/nope`)).status).toBe(404);
  expect((await fetch(`${base}/session`, { method: "GET" })).status).toBe(404);
  expect((await fetch(`${base}/doc`, { method: "POST" })).status).toBe(404);
});

test("concurrent prompt on the same session → 409; session usable after the run ends", async () => {
  const id = await createSession();
  const p1 = fetch(`${base}/session/${id}/prompt`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "SLOW one" }),
  });
  const res1 = await p1; // headers arrive immediately; body streams for ~300ms
  expect(res1.status).toBe(200);
  const res2 = await fetch(`${base}/session/${id}/prompt`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "second" }),
  });
  expect(res2.status).toBe(409);
  const frames = parseFrames(await res1.text()); // drain the first run to completion
  expect(frames[frames.length - 1]!.data.type).toBe("run_end");
  const after = await promptSse(id, "third");
  expect(after.frames[after.frames.length - 1]!.data.type).toBe("run_end");
});

test("stream: null server refuses prompts with 503, still serves /doc", async () => {
  const noStream = startServer({ port: 0, cwd, stream: null });
  servers.push(noStream);
  const id = await createSession(noStream.url);
  const res = await fetch(`${noStream.url}/session/${id}/prompt`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "hi" }),
  });
  expect(res.status).toBe(503);
  expect(((await res.json()) as { error: string }).error).toContain("no provider");
  expect((await fetch(`${noStream.url}/doc`)).status).toBe(200);
});
