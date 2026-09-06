/** Integration tests for the headless HTTP server (port #19): real fetch against
 *  a Bun.serve instance on an ephemeral port, with an injected scripted StreamFn
 *  (no provider env needed). Servers are closed in afterAll — no orphan sockets. */

import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, DEFAULT_PORT, DEFAULT_HOSTNAME, MAX_BODY_BYTES, type RovecodeServer } from "../../src/server/http.ts";
import type { Message, ModelRef, RunEvent, StreamEvent, StreamFn, StreamOptions } from "../../src/core/types.ts";
import type { SessionSummary } from "../../src/core/session.ts";
import { McpManager } from "../../src/mcp/client.ts";
import { basename } from "node:path";
import { scratchHome, writeTrustedMcpJson } from "../helpers/mcp-trust.ts";

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
  if (goal.includes("PWD")) {
    // cwd-propagation probe: where does the bash tool actually run?
    yield { type: "turn", turn: { parts: [{ kind: "tool_call", id: "pwd-1", tool: "bash", args: { command: "pwd" } }], stopReason: "tool_use", usage: { input: 0, output: 1 } } };
    return;
  }
  if (goal.includes("GATED")) {
    // bash → action shell.exec → default rules say effect "prompt"; `echo` is
    // policy allow-listed, so the port #9 wrapper auto-runs it even approver-less
    yield { type: "turn", turn: { parts: [{ kind: "tool_call", id: "gated-1", tool: "bash", args: { command: "echo gated-test" } }], stopReason: "tool_use", usage: { input: 0, output: 1 } } };
    return;
  }
  if (goal.includes("NEEDS-APPROVAL")) {
    // `git push` is prompt-classified by the exec policy; over HTTP there is no
    // human to ask, so the wrapper fails closed — the call must die unexecuted
    yield { type: "turn", turn: { parts: [{ kind: "tool_call", id: "gated-1", tool: "bash", args: { command: "git push" } }], stopReason: "tool_use", usage: { input: 0, output: 1 } } };
    return;
  }
  if (goal.includes("BACKGROUND")) {
    // port #26: launch a background child (its goal "CHILD ping" answers PONG below)
    yield { type: "turn", turn: { parts: [{ kind: "tool_call", id: "bg-1", tool: "task", args: { action: "start", goal: "CHILD ping", label: "ping" } }], stopReason: "tool_use", usage: { input: 0, output: 1 } } };
    return;
  }
  yield { type: "text_delta", text: "PONG" };
  yield { type: "turn", turn: { parts: [{ kind: "text", text: "PONG" }], stopReason: "end_turn", usage: { input: 1, output: 1 } } };
};

// ---------- shared server (ephemeral port, tmp cwd) ----------

const cwd = mkdtempSync(join(tmpdir(), "rovecode-srv-"));
const servers: RovecodeServer[] = [];
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

test("GET /doc: parseable OpenAPI 3.1 with exactly the five routes + honesty note", async () => {
  const res = await fetch(`${base}/doc`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("application/json");
  const doc = (await res.json()) as {
    openapi: string;
    info: { description: string };
    servers: { url: string }[];
    paths: Record<string, Record<string, { description?: string }>>;
    components: { schemas: { RunEvent: { properties: { type: { enum: string[] } } }; TaskInfo?: { properties: { status: { enum: string[] } } } } };
  };
  expect(doc.openapi).toStartWith("3.1");
  expect(Object.keys(doc.paths).sort()).toEqual(["/doc", "/session", "/session/{id}/prompt", "/session/{id}/tasks", "/sessions"]);
  expect(doc.paths["/session"]!.post).toBeDefined();
  expect(doc.paths["/session/{id}/prompt"]!.post).toBeDefined();
  expect(doc.paths["/session/{id}/prompt"]!.delete).toBeDefined(); // port #21: cancel is documented
  expect(doc.paths["/session/{id}/tasks"]!.get).toBeDefined();     // port #26: background tasks are documented
  expect(doc.components.schemas.TaskInfo?.properties.status.enum).toEqual(["queued", "running", "done", "failed", "cancelled"]);
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

test("gated tool without approver: prompt-classified argv surfaces as FAILED tool call, never executes; allow-listed argv auto-runs (policy-only approvals, R2 #9 LOW-3)", async () => {
  const id = await createSession();
  const { frames } = await promptSse(id, "NEEDS-APPROVAL run the tool");

  // the call failed at the permission seam (the port #9 wrapper fails closed headless)…
  const failed = frames.find((f) => f.data.type === "tool_call_failed");
  expect(failed).toBeDefined();
  if (failed && failed.data.type === "tool_call_failed") {
    expect(failed.data.callId).toBe("gated-1");
    expect(failed.data.reason).toBe("permission_denied");
    expect(failed.data.detail).toContain("denied");
  }
  // …and the tool NEVER started executing
  expect(frames.some((f) => f.data.type === "tool_execution_start")).toBe(false);
  expect(frames.some((f) => f.data.type === "tool_execution_end")).toBe(false);
  // the run survives the failure and terminates normally
  const last = frames[frames.length - 1]!.data;
  expect(last.type).toBe("run_end");
  if (last.type === "run_end") expect(last.status).toBe("done");

  // the flip side of policy-only approvals: an allow-listed argv runs with no human
  const id2 = await createSession();
  const ran = await promptSse(id2, "GATED run the tool");
  expect(ran.frames.some((f) => f.data.type === "tool_call_failed")).toBe(false);
  const end = ran.frames.find((f) => f.data.type === "tool_execution_end");
  expect(end).toBeDefined();
  if (end && end.data.type === "tool_execution_end") expect(end.data.output).toContain("gated-test");
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

// ---------- wave-2 fix tests (FW2-M) ----------

/** Stream that parks inside the provider turn until the test releases it —
 *  deterministic control over WHEN a run settles. */
function gatedStream(): { stream: StreamFn; release: () => void; reached: Promise<void> } {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let sawGate!: () => void;
  const reached = new Promise<void>((r) => { sawGate = r; });
  const stream: StreamFn = async function* (_m: ModelRef, messages: Message[]): AsyncGenerator<StreamEvent> {
    if (lastUserText(messages).includes("HOLD")) { sawGate(); await gate; }
    yield { type: "turn", turn: { parts: [{ kind: "text", text: "released" }], stopReason: "end_turn", usage: { input: 0, output: 1 } } };
  };
  return { stream, release, reached };
}

const promptReq = (url: string, id: string, text: string, signal?: AbortSignal) =>
  fetch(`${url}/session/${id}/prompt`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }), ...(signal ? { signal } : {}),
  });

test("MED-F1: client disconnect does NOT free the session until the run actually settles", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-srv-f1-"));
  const { stream, release, reached } = gatedStream();
  const s = startServer({ port: 0, cwd: dir, stream });
  try {
    const id = await createSession(s.url);
    const ac = new AbortController();
    const res1 = await promptReq(s.url, id, "HOLD this run", ac.signal);
    expect(res1.status).toBe(200);
    await reached;            // the run is inside the provider turn
    ac.abort();               // client hangs up mid-run
    await new Promise((r) => setTimeout(r, 75)); // let the server observe the disconnect
    // the aborted generator still owns the session: 409, NOT a second live run
    // (mutation: re-adding settle() to sseResponse's cancel() turns this 200)
    const res2 = await promptReq(s.url, id, "second");
    expect(res2.status).toBe(409);
    await res2.text();
    release();                // the run reaches its boundary and truly settles
    let status = 0;
    for (let i = 0; i < 200 && status !== 200; i++) {
      const r = await promptReq(s.url, id, "third");
      status = r.status;
      await r.text(); // drain (SSE body when 200, JSON otherwise)
      if (status !== 200) await new Promise((rr) => setTimeout(rr, 20));
    }
    expect(status).toBe(200); // session usable once the run settled
  } finally {
    release();
    await s.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stop() with an in-flight SSE run: resolves promptly, sockets close (runs finish at their boundary)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-srv-stop-"));
  const { stream, release, reached } = gatedStream();
  const s = startServer({ port: 0, cwd: dir, stream });
  try {
    const id = await createSession(s.url);
    const res = await promptReq(s.url, id, "HOLD forever");
    expect(res.status).toBe(200);
    await reached;
    await s.stop(); // must resolve with the run still live (honest semantics)
    // socket is closed: reading the body settles instead of hanging the test
    try { await res.text(); } catch { /* aborted body is fine — it must not hang */ }
  } finally {
    release();
    await s.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MED-F3: stop() closes every session runtime's MCP manager", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-srv-mcp-"));
  const restoreHome = scratchHome(); // a project .mcp.json loads only once trusted (mcp/trust.ts) — approve it in a scratch home
  writeTrustedMcpJson(dir, { toy: { command: "rovecode-not-a-real-binary-srv" } });
  const closed: McpManager[] = [];
  const orig = McpManager.prototype.close;
  McpManager.prototype.close = async function (this: McpManager) { closed.push(this); return orig.call(this); };
  try {
    const s = startServer({ port: 0, cwd: dir, stream: scripted });
    await createSession(s.url);
    await createSession(s.url); // one manager (→ child set) per POST /session
    expect(closed.length).toBe(0);
    await s.stop();
    expect(closed.length).toBe(2);          // ALL sessions reaped, not just one
    expect(new Set(closed).size).toBe(2);   // two distinct managers
  } finally {
    McpManager.prototype.close = orig;
    restoreHome();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("LOW-MED-F4: oversized request body → 413; server stays healthy", async () => {
  const id = await createSession();
  const res = await fetch(`${base}/session/${id}/prompt`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "x".repeat(MAX_BODY_BYTES + 1024) }),
  });
  expect(res.status).toBe(413);
  expect(((await res.json()) as { error: string }).error).toContain("too large");
  // a normal-size prompt on the SAME session still round-trips
  const { frames } = await promptSse(id, "small after big");
  expect(frames[frames.length - 1]!.data.type).toBe("run_end");
});

// ---------- port #21: DELETE /session/:id/prompt cancels the in-flight run ----------

/** Bounded await: bun's per-test timeout only fires when something wakes the
 *  event loop — a test parked on a promise with no timer pending hangs the
 *  runner indefinitely (measured here: default, explicit arg and --timeout all
 *  hang). This timer is what bounds a hang-shaped mutant: the deadline rejects
 *  (below bun's 5s so the message is ours), the finally still runs. */
function deadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const bomb = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error(`${what}: not settled within ${ms}ms`)), ms); });
  return Promise.race([p, bomb]).finally(() => clearTimeout(t));
}

/** Parks the FIRST provider turn until its own options.signal aborts — only a
 *  real controller abort releases it (a bare generator .return() cannot: the
 *  loop is suspended inside the provider await). Later calls answer at once. */
function abortAwareStream(): { stream: StreamFn; seen: Promise<AbortSignal>; reached: Promise<void> } {
  let seenR!: (s: AbortSignal) => void;
  const seen = new Promise<AbortSignal>((r) => { seenR = r; });
  let reachedR!: () => void;
  const reached = new Promise<void>((r) => { reachedR = r; });
  let calls = 0;
  const stream: StreamFn = async function* (_m: ModelRef, _msgs: Message[], opts?: StreamOptions): AsyncGenerator<StreamEvent> {
    if (++calls > 1) {
      yield { type: "turn", turn: { parts: [{ kind: "text", text: "resumed" }], stopReason: "end_turn", usage: { input: 0, output: 1 } } };
      return;
    }
    const sig = opts!.signal!;
    seenR(sig); reachedR();
    if (!sig.aborted) await new Promise<void>((r) => sig.addEventListener("abort", () => r(), { once: true }));
    yield { type: "turn", turn: { parts: [], stopReason: "aborted", usage: { input: 0, output: 0 } } };
  };
  return { stream, seen, reached };
}

test("port #21: DELETE aborts the in-flight run — SSE ends with run_end stopped, 409 clears on settle, idle DELETE is idempotent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-srv-del-"));
  const { stream, seen, reached } = abortAwareStream();
  const s = startServer({ port: 0, cwd: dir, stream });
  try {
    const id = await createSession(s.url);
    const res = await promptReq(s.url, id, "park me");
    expect(res.status).toBe(200);
    await reached;                    // the run is inside the provider turn
    const del = await fetch(`${s.url}/session/${id}/prompt`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ cancelled: true });
    // the run's own stream ends promptly with run_end "stopped" — without the
    // abort (mutation: drop entry.abort?.abort()) the parked turn never
    // releases and this res.text() would hang; the deadline makes that a red
    const frames = parseFrames(await deadline(res.text(), 4_000, "SSE body after DELETE"));
    const last = frames[frames.length - 1]!.data;
    expect(last.type).toBe("run_end");
    if (last.type === "run_end") expect(last.status).toBe("stopped");
    expect((await seen).aborted).toBe(true); // the controller REALLY fired
    // the session frees once the generator settled — next prompt round-trips
    let status = 0;
    for (let i = 0; i < 100 && status !== 200; i++) {
      const r = await promptReq(s.url, id, "again");
      status = r.status;
      await r.text();
      if (status !== 200) await new Promise((rr) => setTimeout(rr, 20));
    }
    expect(status).toBe(200);
    // idle cancel: idempotent no-op; unknown session: 404
    const idle = await fetch(`${s.url}/session/${id}/prompt`, { method: "DELETE" });
    expect(idle.status).toBe(200);
    expect(await idle.json()).toEqual({ cancelled: false });
    expect((await fetch(`${s.url}/session/nope/prompt`, { method: "DELETE" })).status).toBe(404);
  } finally {
    await s.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("prompt route id refuses multi-segment / traversal ids (pin against ([^/]+) → (.+) loosening)", async () => {
  // raw extra segment must die at the ROUTER ("no route"), never reach the
  // session layer — a loosened id pattern would match and shift the error
  const multi = await promptReq(base, "a/b", "x");
  expect(multi.status).toBe(404);
  expect(((await multi.json()) as { error: string }).error).toContain("no route");
  // encoded slash / dot-dot variants stay ONE opaque id segment: clean session-level
  // 404 (no decode-then-route, no 500, no fs contact) across encodings
  for (const id of ["a%2Fb", "..%2F..%2Fetc", "%2E%2E%2F%2E%2E"]) {
    const r = await promptReq(base, id, "x");
    expect(r.status).toBe(404);
    expect(((await r.json()) as { error: string }).error).toContain("unknown session");
  }
});

test("session cwd reaches tools over HTTP: bash pwd lands in the server cwd, not the process dir", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-srv-cwd-"));
  const s = startServer({ port: 0, cwd: dir, stream: scripted, yolo: true });
  try {
    const id = await createSession(s.url);
    const { frames } = await promptSse(id, "PWD where am i", s.url);
    const end = frames.find((f) => f.data.type === "tool_execution_end");
    expect(end).toBeDefined();
    if (end && end.data.type === "tool_execution_end") {
      expect(end.data.ok).toBe(true);
      // mkdtemp basename is unique — provably the session cwd, not process.cwd()
      expect(end.data.output).toContain(basename(dir));
      expect(basename(process.cwd())).not.toBe(basename(dir));
    }
  } finally {
    await s.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- port #26: GET /session/:id/tasks + completion steer across prompts ----------

test("port #26: GET /session/:id/tasks lists the session's background tasks; unknown session 404; wrong method 404", async () => {
  const id = await createSession();
  const empty = await fetch(`${base}/session/${id}/tasks`);
  expect(empty.status).toBe(200);
  expect(empty.headers.get("content-type")).toBe("application/json");
  expect(await empty.json()).toEqual([]);
  expect((await fetch(`${base}/session/nope/tasks`)).status).toBe(404);
  expect((await fetch(`${base}/session/${id}/tasks`, { method: "POST" })).status).toBe(404);
  expect((await fetch(`${base}/session/${id}/tasks/t1`)).status).toBe(404); // no sub-routes
});

test("port #26: a yolo prompt that starts a background task shows it in GET /tasks (running → done), and the NEXT prompt on the session receives the completion steer", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-srv-tasks-"));
  const s = startServer({ port: 0, cwd: dir, stream: scripted, yolo: true });
  try {
    const id = await createSession(s.url);
    const { frames } = await promptSse(id, "BACKGROUND go", s.url);
    const started = frames.find((f) => f.data.type === "tool_execution_end");
    expect(started).toBeDefined();
    if (started && started.data.type === "tool_execution_end") {
      expect(started.data.ok).toBe(true);
      expect(started.data.output).toContain("task t1 (ping) started");
    }
    // the child is a REAL child session running through runChild; poll the route until done
    let tasks: { id: string; status: string; summary?: string; depth: number }[] = [];
    for (let i = 0; i < 200; i++) {
      const r = await fetch(`${s.url}/session/${id}/tasks`);
      expect(r.status).toBe(200);
      tasks = (await r.json()) as typeof tasks;
      if (tasks[0]?.status === "done") break;
      await new Promise((rr) => setTimeout(rr, 25));
    }
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ id: "t1", status: "done", depth: 1, summary: "PONG" });
    // the completion note waits in the SESSION's steering queue (rt.steering, the one the
    // prompt route hands to agentLoop) and is drained by the next prompt — mutation target:
    // prompt() passing a fresh SteeringQueue → no steer frame here
    const next = await promptSse(id, "after the background work", s.url);
    const steer = next.frames.find((f) => f.data.type === "steer");
    expect(steer).toBeDefined();
    if (steer && steer.data.type === "steer") expect(steer.data.text).toContain("task t1 (ping) finished: PONG");
    // another session on the same server has its own (empty) task list
    const other = await createSession(s.url);
    expect(await (await fetch(`${s.url}/session/${other}/tasks`)).json()).toEqual([]);
  } finally {
    await s.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);

test("port #26: DELETE /session/:id/prompt also cancels the background tasks that run started (bindRun on the run's controller)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-srv-tasks-del-"));
  const parked: string[] = [];
  const stream: StreamFn = async function* (_m: ModelRef, messages: Message[], opts?: StreamOptions): AsyncGenerator<StreamEvent> {
    const goal = lastUserText(messages);
    if (goal.includes("BACKGROUND-HOLD") && !messages.some((m) => m.role === "tool")) {
      yield { type: "turn", turn: { parts: [{ kind: "tool_call", id: "bgh-1", tool: "task", args: { action: "start", goal: "CHILD HOLD", label: "held" } }], stopReason: "tool_use", usage: { input: 0, output: 1 } } };
      return;
    }
    // parent's second turn AND the child: park until the run's own signal aborts
    parked.push(goal);
    const sig = opts!.signal!;
    if (!sig.aborted) await new Promise<void>((r) => sig.addEventListener("abort", () => r(), { once: true }));
    yield { type: "turn", turn: { parts: [], stopReason: "aborted", usage: { input: 0, output: 0 } } };
  };
  const s = startServer({ port: 0, cwd: dir, stream, yolo: true });
  try {
    const id = await createSession(s.url);
    const res = await promptReq(s.url, id, "BACKGROUND-HOLD");
    expect(res.status).toBe(200);
    for (let i = 0; i < 200 && !(parked.includes("CHILD HOLD") && parked.includes("BACKGROUND-HOLD")); i++) await new Promise((r) => setTimeout(r, 25));
    expect(parked).toContain("CHILD HOLD"); // the child is a live run parked in its provider turn
    let tasks = (await (await fetch(`${s.url}/session/${id}/tasks`)).json()) as { id: string; status: string }[];
    expect(tasks).toEqual([expect.objectContaining({ id: "t1", status: "running" })]);
    const del = await fetch(`${s.url}/session/${id}/prompt`, { method: "DELETE" });
    expect(await del.json()).toEqual({ cancelled: true });
    const frames = parseFrames(await deadline(res.text(), 4_000, "SSE body after DELETE"));
    expect(frames[frames.length - 1]!.data).toMatchObject({ type: "run_end", status: "stopped" });
    // the run's background task was cancelled too (mutation target: drop rt.tasks.bindRun in prompt())
    for (let i = 0; i < 160; i++) {
      tasks = (await (await fetch(`${s.url}/session/${id}/tasks`)).json()) as typeof tasks;
      if (tasks[0]?.status === "cancelled" && (tasks[0] as { finishedAt?: number }).finishedAt !== undefined) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(tasks[0]).toMatchObject({ id: "t1", status: "cancelled" });
    expect((tasks[0] as { finishedAt?: number }).finishedAt).toBeDefined();
  } finally {
    await s.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);

test("wiring pass (port #26): stop() cancels every session's live background tasks — the parked child's run signal aborts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-srv-tasks-stop-"));
  const childSignals: AbortSignal[] = [];
  const stream: StreamFn = async function* (_m: ModelRef, messages: Message[], opts?: StreamOptions): AsyncGenerator<StreamEvent> {
    const goal = lastUserText(messages);
    if (goal.includes("BACKGROUND-STOP")) {
      if (!messages.some((m) => m.role === "tool")) {
        yield { type: "turn", turn: { parts: [{ kind: "tool_call", id: "bgs-1", tool: "task", args: { action: "start", goal: "CHILD HOLD-STOP", label: "held" } }], stopReason: "tool_use", usage: { input: 0, output: 1 } } };
        return;
      }
      yield { type: "turn", turn: { parts: [{ kind: "text", text: "parent done" }], stopReason: "end_turn", usage: { input: 0, output: 1 } } };
      return;
    }
    // the child parks until ITS run signal aborts (cancel → runChild → agentLoop → this)
    const sig = opts!.signal!;
    childSignals.push(sig);
    if (!sig.aborted) await new Promise<void>((r) => sig.addEventListener("abort", () => r(), { once: true }));
    yield { type: "turn", turn: { parts: [], stopReason: "aborted", usage: { input: 0, output: 0 } } };
  };
  const s = startServer({ port: 0, cwd: dir, stream, yolo: true });
  try {
    const id = await createSession(s.url);
    const { frames } = await promptSse(id, "BACKGROUND-STOP", s.url);
    expect(frames[frames.length - 1]!.data).toMatchObject({ type: "run_end", status: "done" }); // the parent ended normally…
    for (let i = 0; i < 200 && childSignals.length === 0; i++) await new Promise((r) => setTimeout(r, 25));
    expect(childSignals).toHaveLength(1);
    expect(childSignals[0]!.aborted).toBe(false); // …and its task outlives the run
    expect(await (await fetch(`${s.url}/session/${id}/tasks`)).json()).toEqual([expect.objectContaining({ id: "t1", status: "running" })]);
    await s.stop();
    // mutation: drop runtime.tasks.cancelAll() in stop() → the child stays parked forever
    for (let i = 0; i < 160 && !childSignals[0]!.aborted; i++) await new Promise((r) => setTimeout(r, 25));
    expect(childSignals[0]!.aborted).toBe(true);
  } finally {
    await s.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);

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
