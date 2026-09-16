/** The two headless surfaces through the REAL process (Bun.spawn of src/cli/main.ts), the way a deployment
 *  runs them — the guard for the lazy-import boot (main.ts imports on demand, runtime.ts loads MCP/otel
 *  lazily), which no in-process test exercises:
 *  - `rovecode serve`: POST /session → POST /session/:id/prompt streams the six RunEvent frames of a
 *    one-turn run and ends with run_end status "done"; SIGTERM ends the process and its MCP child
 *  - `rovecode acp`: initialize → session/new → session/prompt answers stopReason end_turn with one
 *    agent_message_chunk; an unknown session is -32602; closing stdin exits 0 and reaps the MCP child
 *  The provider is a fake OpenAI-compatible endpoint inside this test (Bun.serve on 127.0.0.1, /models +
 *  /chat/completions as SSE or JSON); the MCP server is a minimal stdio one written into the scratch home,
 *  which records "exited" when its pipe closes — that file is the cross-platform child-reaping probe.
 *  Hermetic like cli-wiring.test.ts: ROVECODE_* and *_API_KEY scrubbed, scratch ROVECODE_HOME and cwd.
 *  Assertions are on shapes, never on timings; the ceilings (15 s on every wait) only bound a hang — a loaded CI box takes seconds, not milliseconds. */

import { test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..", "..");
const MAIN = join(ROOT, "src", "cli", "main.ts");
const T = 30_000;

/** spawning is impossible on some sandboxes — skip cleanly rather than fail there */
const canSpawn = (() => { try { return Bun.spawnSync([process.execPath, "--version"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0; } catch { return false; } })();

// ---------- the fake provider ----------

const FAKE_PREFIX = "fake saw: ";
const providerCalls: string[] = [];
let fake: ReturnType<typeof Bun.serve>;
let home = "", work = "", marker = "";

function lastText(messages: { content: unknown }[]): string {
  const c = messages[messages.length - 1]?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((p) => (p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string" ? (p as { text: string }).text : "")).join("");
  return JSON.stringify(c);
}

const FAKE_MCP = `// minimal MCP stdio server: the SDK handshake + tools/list; records its life in the marker file
const marker = process.argv[2];
require("node:fs").writeFileSync(marker, "started " + process.pid);
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  buf += d; let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id === undefined) continue;
    const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\\n");
    if (msg.method === "initialize") reply({ protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake-mcp", version: "0" } });
    else if (msg.method === "tools/list") reply({ tools: [{ name: "echo", description: "echoes", inputSchema: { type: "object", properties: { s: { type: "string" } } } }] });
    else reply({});
  }
});
const bye = () => { try { require("node:fs").writeFileSync(marker, "exited"); } catch {} process.exit(0); };
process.stdin.on("end", bye); process.stdin.on("close", bye); process.stdin.on("error", bye);
setInterval(() => {}, 60_000);
`;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "rovecode-headless-home-"));
  work = mkdtempSync(join(tmpdir(), "rovecode-headless-cwd-"));
  marker = join(home, "fake-mcp.marker");
  const mcpFile = join(home, "fake-mcp.cjs");
  writeFileSync(mcpFile, FAKE_MCP);
  // the user-level file (~/.rovecode/mcp.json) needs no trust approval — the project files do
  writeFileSync(join(home, "mcp.json"), JSON.stringify({ mcpServers: { fake: { command: process.execPath, args: [mcpFile, marker] } } }));
  fake = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(req) {
      const path = new URL(req.url).pathname;
      providerCalls.push(`${req.method} ${path}`);
      if (path.endsWith("/models")) return Response.json({ data: [{ id: "fake-1", owned_by: "fake" }] });
      if (!path.endsWith("/chat/completions")) return Response.json({ error: "no route" }, { status: 404 });
      const body = (await req.json()) as { stream?: boolean; messages: { content: unknown }[] };
      const reply = FAKE_PREFIX + lastText(body.messages);
      const usage = { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 };
      if (!body.stream) return Response.json({ id: "c1", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }], usage });
      const enc = new TextEncoder();
      const chunks = [
        { id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: reply.slice(0, FAKE_PREFIX.length) }, finish_reason: null }] },
        { id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: reply.slice(FAKE_PREFIX.length) }, finish_reason: null }] },
        { id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage },
      ];
      const stream = new ReadableStream<Uint8Array>({ start(c) { for (const ch of chunks) c.enqueue(enc.encode(`data: ${JSON.stringify(ch)}\n\n`)); c.enqueue(enc.encode("data: [DONE]\n\n")); c.close(); } });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    },
  });
});

afterAll(() => {
  fake?.stop(true);
  rmSync(home, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

// ---------- helpers ----------

function hermeticEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !/^ROVECODE_/i.test(k) && !/_API_KEY$/i.test(k)) env[k] = v;
  }
  return Object.assign(env, {
    ROVECODE_HOME: home, NO_COLOR: "1",
    ROVECODE_BASE_URL: `http://127.0.0.1:${fake.port}/v1`, ROVECODE_API_KEY: "fake-key", ROVECODE_MODEL: "fake-1",
  }, extra);
}

/** a port nobody is listening on right now (bound and released; the child binds it next) */
function freePort(): number {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = probe.port!;
  probe.stop(true);
  return port;
}

async function until(pred: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !pred()) await new Promise((r) => setTimeout(r, 25));
  if (!pred()) throw new Error(`${what} did not happen within ${ms}ms`);
}

/** spawn the CLI with ONE stdout pump (never a raced read); stderr collected for the failure message */
function spawnCli(args: string[], stdin: "pipe" | "ignore", extra: Record<string, string> = {}) {
  const p = Bun.spawn([process.execPath, MAIN, ...args], { cwd: work, env: hermeticEnv(extra), stdin, stdout: "pipe", stderr: "pipe" });
  const buf = { out: "", err: "" };
  const dec = new TextDecoder();
  const pumpOut = (async () => { for await (const c of p.stdout) buf.out += dec.decode(c, { stream: true }); })().catch(() => {});
  const pumpErr = (async () => { for await (const c of p.stderr) buf.err += dec.decode(c, { stream: true }); })().catch(() => {});
  const exitedWithin = async (ms: number): Promise<number> => {
    const code = await Promise.race([p.exited, new Promise<"hang">((r) => setTimeout(() => r("hang"), ms))]);
    if (code === "hang") { p.kill(); throw new Error(`process still alive after ${ms}ms\nstderr:\n${buf.err.slice(-1500)}`); }
    await Promise.all([pumpOut, pumpErr]);
    return code;
  };
  return { p, buf, exitedWithin };
}

const markerText = (): string => (existsSync(marker) ? readFileSync(marker, "utf8") : "");
const childStarted = (): boolean => markerText().startsWith("started ");
/** the child is gone: it wrote "exited" on its pipe closing, or its pid no longer exists (signal 0 probes without killing) */
function childReaped(): boolean {
  const m = markerText();
  if (m === "exited") return true;
  const pid = Number(m.split(" ")[1]);
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return false; } catch { return true; }
}

// ---------- serve ----------

test.if(canSpawn)("serve: the real process boots, streams one run over SSE (six frames, run_end done), lists the session, and SIGTERM ends it with its MCP child", async () => {
  rmSync(marker, { force: true });
  providerCalls.length = 0;
  const port = freePort();
  const { p: srv, buf, exitedWithin } = spawnCli(["serve"], "ignore", { ROVECODE_PORT: String(port) });
  try {
    await until(() => buf.out.includes("listening on"), 20_000, "the listening line");
    const url = `http://127.0.0.1:${port}`;
    expect(buf.out).toContain(`listening on ${url}`);

    const created = await fetch(`${url}/session`, { method: "POST" });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    expect(typeof id).toBe("string");
    await until(childStarted, 10_000, "the MCP child's start"); // POST /session spawned it

    const res = await fetch(`${url}/session/${id}/prompt`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "say hello over sse" }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const frames = (await res.text()).split("\n\n").filter(Boolean).map((f) => ({ event: /^event: (.*)$/m.exec(f)?.[1], data: JSON.parse(/^data: (.*)$/m.exec(f)?.[1] ?? "null") as { type: string; status?: string; summary?: string } }));
    expect(frames.map((f) => f.event)).toEqual(["run_start", "turn_start", "message_update", "message_update", "turn_end", "run_end"]);
    for (const f of frames) expect(f.event).toBe(f.data.type); // the event name IS the RunEvent type
    expect(frames[5]!.data).toMatchObject({ type: "run_end", status: "done", summary: `${FAKE_PREFIX}say hello over sse` });
    expect(providerCalls.filter((c) => c.endsWith("/chat/completions"))).toHaveLength(1);

    const list = (await (await fetch(`${url}/sessions`)).json()) as { id: string; preview: string }[];
    expect(list.map((s) => s.id)).toContain(id);
    expect(list.find((s) => s.id === id)!.preview).toBe("say hello over sse");
    // the run settled: the same session takes the next prompt (no stuck 409 latch)
    const again = await fetch(`${url}/session/${id}/prompt`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "again" }) });
    expect(again.status).toBe(200);
    await again.text();
  } finally {
    srv.kill("SIGTERM");
  }
  await exitedWithin(15_000); // SIGTERM ends the process: via srv.stop() on POSIX, by TerminateProcess on Windows — the exit code is the platform's, what matters is that it is gone
  expect(await fetch(`http://127.0.0.1:${port}/sessions`).then(() => "answers", () => "gone")).toBe("gone");
  await until(childReaped, 15_000, "the MCP child's exit after its parent died"); // reaped — not orphaned
}, T);

// ---------- acp ----------

test.if(canSpawn)("acp: initialize → session/new → session/prompt answers end_turn with one agent_message_chunk; unknown session is -32602; stdin close exits 0 and reaps the MCP child", async () => {
  rmSync(marker, { force: true });
  const { p, buf, exitedWithin } = spawnCli(["acp", "--yolo"], "pipe");
  const stdin = p.stdin as import("bun").FileSink;
  const lines = (): { id?: number; method?: string; params?: { sessionId?: string; update?: { sessionUpdate?: string; content?: { text?: string } } }; result?: Record<string, unknown>; error?: { code: number; data?: unknown } }[] =>
    buf.out.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l));
  let nextId = 1;
  const call = async (method: string, params: unknown) => {
    const id = nextId++;
    stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    await stdin.flush();
    await until(() => lines().some((m) => m.id === id), 20_000, `a response to ${method}`);
    return lines().find((m) => m.id === id)!;
  };
  try {
    const init = await call("initialize", { protocolVersion: 1, clientCapabilities: {} });
    expect(init.result).toMatchObject({ protocolVersion: 1, agentCapabilities: { loadSession: false, promptCapabilities: { image: true } } });
    const created = await call("session/new", { cwd: work, mcpServers: [] });
    const sessionId = created.result?.sessionId as string;
    expect(typeof sessionId).toBe("string");
    await until(childStarted, 10_000, "the MCP child's start"); // session/new spawned it
    const answered = await call("session/prompt", { sessionId, prompt: [{ type: "text", text: "hello acp" }] });
    expect(answered.result).toEqual({ stopReason: "end_turn" });
    const updates = lines().filter((m) => m.method === "session/update");
    expect(updates.length).toBeGreaterThanOrEqual(1);
    for (const u of updates) expect(u.params?.sessionId).toBe(sessionId);
    const chunks = updates.filter((u) => u.params?.update?.sessionUpdate === "agent_message_chunk").map((u) => u.params!.update!.content!.text);
    expect(chunks.join("")).toBe(`${FAKE_PREFIX}hello acp`);
    const unknown = await call("session/prompt", { sessionId: "no-such-session", prompt: [{ type: "text", text: "x" }] });
    expect(unknown.error).toMatchObject({ code: -32602, data: { sessionId: "no-such-session" } });
    // stdout carried protocol frames only — every line parsed as JSON above; nothing else may print there
    expect(lines().every((m) => m.id !== undefined || m.method !== undefined)).toBe(true);
  } finally {
    await stdin.end();
  }
  expect(await exitedWithin(15_000)).toBe(0);
  await until(childReaped, 15_000, "the MCP child's exit after stdin closed"); // reaped — not orphaned
}, T);
