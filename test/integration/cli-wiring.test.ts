/** Wiring pass through the REAL CLI (Bun.spawn; hermetic env like output-modes.test.ts: ROVECODE_* and
 *  *_API_KEY scrubbed, ROVECODE_HOME → an empty temp dir, cwd → a temp workspace):
 *  - `rovecode help` pins every new env knob, the --output paragraph and the /name expansion note
 *  - `rovecode tools` lists ask_user (port #33 critic LOW-1)
 *  - `rovecode run "/hello …"` expands .rovecode/commands/hello.md on BOTH the `run` and the bare-prompt path:
 *    the session store's first user message is the RENDERED prompt; an unknown /name passes verbatim
 *  - `rovecode serve` banner lists GET /session/:id/tasks (+ DELETE /session/:id/prompt)
 *  - `rovecode --plain` binds ask_user to readline: numbered options print, the typed number answers,
 *    and the next model turn sees `answer: sqlite` */

import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { RunResult } from "../../src/cli/output.ts";
import { SessionStore } from "../../src/core/session.ts";
import { partsText } from "../../src/core/loop.ts";

const ROOT = resolve(import.meta.dir, "..", "..");
const MAIN = join(ROOT, "src", "cli", "main.ts");
const T = 60_000;

let work = "", home = "";
beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "rovecode-cliwire-"));
  home = mkdtempSync(join(tmpdir(), "rovecode-cliwire-home-"));
  mkdirSync(join(work, ".rovecode", "commands"), { recursive: true });
  writeFileSync(join(work, ".rovecode", "commands", "hello.md"), "---\ndescription: Say hello\nmodel: not-applied-headlessly\n---\nSay hi to $ARGUMENTS\n");
});
afterAll(() => {
  rmSync(work, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

function hermeticEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !/^ROVECODE_/i.test(k) && !/_API_KEY$/i.test(k)) env[k] = v;
  }
  env.ROVECODE_HOME = home;
  // the canned provider is ASKED FOR here, not fallen into: a one-shot run with nothing configured is a
  // startup failure (exit 2), and these tests drive the headless path without a key on purpose
  env.ROVECODE_MOCK = "1";
  return Object.assign(env, extra);
}

/** ASYNC spawn (output-modes idiom): a loopback provider below lives in THIS process. */
async function cli(args: string[], extra: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  const p = Bun.spawn([process.execPath, MAIN, ...args], { cwd: work, env: hermeticEnv(extra), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, stdout, stderr };
}

/** The first user message the run stored — what the model was actually asked. */
function firstUserText(sessionId: string): string {
  const m = new SessionStore(join(work, ".rovecode", "sessions"), sessionId).messages().find((x) => x.role === "user");
  return m ? partsText(m.parts) : "";
}

/** Spawn a long-lived CLI child and pump its stdout into a buffer (tui-session-nav CLI idiom:
 *  ONE pump, never a raced read). */
function spawnPumped(args: string[], extra: Record<string, string>, stdin: "pipe" | "ignore") {
  const p = Bun.spawn([process.execPath, MAIN, ...args], { cwd: work, env: hermeticEnv({ NO_COLOR: "1", ...extra }), stdin, stdout: "pipe", stderr: "pipe" });
  const buf = { out: "" };
  const dec = new TextDecoder();
  const pump = (async () => { for await (const chunk of p.stdout) buf.out += dec.decode(chunk, { stream: true }); })().catch(() => {});
  const waitOut = async (pred: (out: string) => boolean, ms = 20_000): Promise<void> => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline && !pred(buf.out)) await new Promise((r) => setTimeout(r, 50));
    if (!pred(buf.out)) throw new Error(`CLI output did not match within ${ms}ms:\n${buf.out.slice(-2000)}`);
  };
  const stop = async (): Promise<void> => { p.kill(); await p.exited.catch(() => {}); await pump; };
  /** write a line to the child's stdin (pipe mode only) and flush it through */
  const type = (line: string): void => { const sink = p.stdin as import("bun").FileSink; sink.write(line); sink.flush(); };
  const closeStdin = (): void => { try { (p.stdin as import("bun").FileSink).end(); } catch { /* already closed */ } };
  return { p, buf, waitOut, stop, type, closeStdin };
}

// ---------- help / tools ----------

test("help: the env block documents the retry / webfetch / compaction / tasks knobs; `rovecode run` documents /name expansion and --output", async () => {
  const r = await cli(["help", "all"]); // the default page is short; `help all` is the full reference
  expect(r.code).toBe(0);
  const out = r.stdout;
  expect(out).toMatch(/^\s*ROVECODE_RETRY_MAX\s+.*default 3.*0 = off/m);
  expect(out).toMatch(/^\s*ROVECODE_RETRY_BASE_MS\s+.*1000.*jitter.*Retry-After/m); // default halved with the wire-failure pass
  expect(out).toMatch(/^\s*ROVECODE_WEBFETCH_TIMEOUT_MS\s+.*30000/m);
  expect(out).toMatch(/^\s*ROVECODE_WEBFETCH_ALLOW_PRIVATE=1\s+.*private/m);
  expect(out).toMatch(/^\s*ROVECODE_COMPACTION\s+.*head-summarize.*keep-window.*provider-native/m);
  expect(out).toMatch(/^\s*ROVECODE_TASKS_MAX\s+.*default 3/m);
  expect(out).toMatch(/^\s*ROVECODE_SANDBOX\s+.*direct.*wsl.*docker/m); // still there
  // --output paragraph under `rovecode run`
  expect(out).toContain("--output <text|json|ndjson>");
  for (const key of ["status", "summary", "sessionId", "origin", "cacheRead", "cacheWrite", "costUsd", "toolCalls", "durationMs", "exitCode"]) expect(out).toContain(key);
  expect(out).toContain('{type:"result"}');
  expect(out).toContain("0 done · 1 error/budget · 2 usage/startup error · 130 aborted");
  // /name expansion note
  expect(out).toContain('"/name args" expands a custom command');
  expect(out).toContain("TUI-only");
}, T);

test("tools: the registry listing includes ask_user (port #33) next to todo_write/todo_read and web_fetch", async () => {
  const r = await cli(["tools"]);
  expect(r.code).toBe(0);
  const names = r.stdout.split("\n").filter((l) => /^\S/.test(l)).map((l) => l.split(/\s+/)[0]);
  expect(names).toContain("ask_user"); // mutation: drop the askUserTool registration in cmdTools → missing
  expect(names).toContain("todo_write");
  expect(names).toContain("todo_read");
  expect(names).toContain("web_fetch");
  expect(r.stdout).toMatch(/^ask_user\s+read\s+sequential=true/m);
  // cmdTools builds its OWN listing-only registry, separate from createRuntime's — so a tool added to
  // one and not the other makes `rovecode tools` lie about what exists. Pinned here and in
  // test/unit/runtime.test.ts so the two cannot drift apart silently.
  expect(names).toContain("design_audit");
  expect(names).toContain("design_direction");
  expect(r.stdout).toMatch(/^design_audit\s+read\s+sequential=false/m);
}, T);

// ---------- rovecode run "/name args" ----------

test("rovecode run \"/hello …\" expands .rovecode/commands/hello.md: the stored first user message is the RENDERED prompt (spaces intact), model: is not applied headlessly; unknown /name passes verbatim; the bare-prompt path expands too", async () => {
  const r = await cli(["run", "/hello big   world", "--output", "json"]);
  expect(r.code).toBe(0);
  const res = JSON.parse(r.stdout.trim()) as RunResult;
  expect(res.status).toBe("done");
  expect(res.model).toEqual({ provider: "mock", model: "default" });      // frontmatter model: is TUI-only
  expect(firstUserText(res.sessionId!)).toBe("Say hi to big   world");  // mutation: drop expandSlashPrompt in `case "run"` → "/hello big   world"

  const r2 = await cli(["run", "/nope stays", "--output", "json"]);
  expect(r2.code).toBe(0);
  expect(firstUserText((JSON.parse(r2.stdout.trim()) as RunResult).sessionId!)).toBe("/nope stays");

  const r3 = await cli(["/hello bare", "--output", "json"]);           // bare prompt (no `run`)
  expect(r3.code).toBe(0);
  expect(firstUserText((JSON.parse(r3.stdout.trim()) as RunResult).sessionId!)).toBe("Say hi to bare"); // mutation: drop the bare-branch expansion → "/hello bare"
}, T);

// ---------- rovecode serve banner ----------

test("serve: the startup banner lists GET /session/:id/tasks and DELETE /session/:id/prompt", async () => {
  // a free port, released for the child (ROVECODE_PORT=0 would read as "default 4100" in main.ts)
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = probe.port!;
  await probe.stop(true);
  const child = spawnPumped(["serve"], { ROVECODE_PORT: String(port) }, "ignore");
  try {
    await child.waitOut((o) => o.includes("rovecode server listening"));
  } finally {
    await child.stop();
  }
  expect(child.buf.out).toContain(`rovecode server listening on http://127.0.0.1:${port}`);
  expect(child.buf.out).toContain("GET /session/:id/tasks");
  expect(child.buf.out).toContain("DELETE /session/:id/prompt");
}, T);

// ---------- rovecode --plain: ask_user over readline ----------

test("--plain binds ask_user to readline: the question and numbered options print, the typed number answers, and the next model turn sees `answer: sqlite`", async () => {
  let calls = 0;
  const server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(req) {
      const body = await req.json() as { messages: { role: string; content?: string | null }[] };
      if (calls++ === 0) {
        return Response.json({
          choices: [{
            message: { content: null, tool_calls: [{ id: "ask_1", type: "function", function: { name: "ask_user", arguments: JSON.stringify({ question: "Which database?", options: ["postgres", "sqlite"] }) } }] },
            finish_reason: "tool_calls",
          }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        });
      }
      const toolMsg = body.messages.filter((m) => m.role === "tool").at(-1);
      return Response.json({ choices: [{ message: { content: `MODEL-SAW ${toolMsg?.content ?? "(no tool result)"}` }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    },
  });
  const child = spawnPumped(["--plain"], { ROVECODE_BASE_URL: `http://127.0.0.1:${server.port}`, ROVECODE_API_KEY: "test-key", ROVECODE_MODEL: "m", ROVECODE_NO_REPOMAP: "1" }, "pipe");
  try {
    await child.waitOut((o) => o.includes("rovecode>"));
    child.type("pick a db\n");
    await child.waitOut((o) => o.includes("2) sqlite"));            // the asker printed the numbered options (mutation: no setAskUser → "ask_user unavailable")
    expect(child.buf.out).toContain("question: Which database?");
    expect(child.buf.out).toContain("1) postgres");
    child.type("2\n");                                                 // the typed number picks sqlite
    await child.waitOut((o) => o.includes("MODEL-SAW"));
    expect(child.buf.out).toContain("MODEL-SAW answer: sqlite");
    expect(child.buf.out).not.toContain("ask_user unavailable");
  } finally {
    child.closeStdin();
    await child.stop();
    server.stop(true);
  }
}, T);

// ---------- no provider is a startup failure, not a finished run ----------

test("with nothing configured a one-shot run refuses instead of answering as the mock: exit 2, one JSON document in --json, the hint on stderr in text mode", async () => {
  // The regression this pins: cmdRun fell back to the canned provider whenever no key was configured, so
  // `rovecode run "hi" --output json` printed {"status":"done"} whose summary was the "no model is
  // connected" hint, and exited 0. A script cannot tell that from a real answer — it is the one failure
  // mode a machine-readable mode exists to prevent. The mock is still reachable, but only when asked for
  // by name (ROVECODE_MOCK=1), which is what hermeticEnv does for every other test in this file.
  const bare = { ROVECODE_MOCK: "" };
  const j = await cli(["run", "hi", "--output", "json"], bare);
  expect(j.code).toBe(2);
  const doc = JSON.parse(j.stdout.trim()) as { status: string; error: string; exitCode: number };
  expect(doc.status).toBe("error");
  expect(doc.exitCode).toBe(2);
  expect(doc.error).toMatch(/no provider configured/);
  expect(j.stdout.trim().split("\n")).toHaveLength(1);          // one document, not prose plus a document

  const t = await cli(["run", "hi"], bare);
  expect(t.code).toBe(2);
  expect(t.stdout).toBe("");                                     // nothing on stdout: there is no answer
  expect(t.stderr).toMatch(/no provider configured/);
  expect(t.stderr).toMatch(/rovecode setup/);                    // and it says how to fix it

  // asked for by name, the canned provider still works — that is what the rest of this file relies on
  const m = await cli(["run", "hi", "--output", "json"]);
  expect(m.code).toBe(0);
  expect((JSON.parse(m.stdout.trim()) as { status: string }).status).toBe("done");
}, T);
