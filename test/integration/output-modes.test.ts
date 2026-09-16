/** PORT #35 — `rovecode run --output text|json|ndjson` through the REAL CLI. Hermetic: ROVECODE_* and
 *  *_API_KEY scrubbed, ROVECODE_HOME → an empty temp dir (a stored credential would otherwise steer
 *  the run onto a real endpoint — PORTS.md #6 lesson), cwd → a temp workspace. Provider paths:
 *  the mock cmdRun auto-selects when nothing is configured, and a loopback OpenAI-compatible
 *  server (tool call → text; HTTP 400 → error run). Bar items: one JSON result / NDJSON RunEvent
 *  stream, stdout purity (progress → stderr), meaningful exit codes (0 done · 1 error · 2 usage),
 *  schema pins, text mode unchanged. Critic closes: a usage error exits BEFORE the runtime boots —
 *  a pristine cwd gets no .rovecode at all (MED-1); purity is STRUCTURAL — a project hook's stray
 *  console.log / process.stdout.write mid-run lands on stderr (LOW-1, real fd 1). */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { trustProjectFiles } from "../helpers/mcp-trust.ts";
import type { RunResult } from "../../src/cli/output.ts";
import { ModelCatalog } from "../../src/providers/catalog.ts";
import { costUsd } from "../../src/core/usage.ts";

const ROOT = resolve(import.meta.dir, "..", "..");
const MAIN = join(ROOT, "src", "cli", "main.ts");
const RESULT_KEYS = ["costUsd", "durationMs", "exitCode", "model", "origin", "sessionId", "status", "summary", "toolCalls", "usage"];
/** vendor-prefixed id: the catalog prices it for provider "custom" via VENDOR_PREFIX_MAP (zai) */
const MODEL = "zai-org/glm-5.3-flash";
const T = 60_000;

let work = "", home = "", note = "";
beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "rovecode-out-"));
  home = mkdtempSync(join(tmpdir(), "rovecode-out-home-"));
  note = join(work, "note.txt");
  writeFileSync(note, "hello from note\n");
});
const scratch: string[] = [];
afterAll(() => {
  rmSync(work, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

/** A pristine cwd for tests that assert on what the CLI leaves behind (`work` accumulates .rovecode). */
function fresh(): string {
  const d = mkdtempSync(join(tmpdir(), "rovecode-out-fresh-"));
  scratch.push(d);
  return d;
}

/** Spawn the real CLI with a scrubbed env + empty ROVECODE_HOME; `extra` adds this test's provider.
 *  ASYNC on purpose: the loopback provider below is a Bun.serve in THIS process — a spawnSync
 *  would block the event loop and the child's fetch could never be answered. */
async function cli(args: string[], extra: Record<string, string> = {}, cwd = work): Promise<{ code: number; stdout: string; stderr: string }> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !/^ROVECODE_/i.test(k) && !/_API_KEY$/i.test(k)) env[k] = v;
  }
  env.ROVECODE_HOME = home;
  // the "mock provider" describes in these tests is ASKED FOR, not fallen into: since d80c2f6 a one-shot
  // run with nothing configured is a startup failure (exit 2) rather than a canned reply reported as done.
  // Asked for ONLY when this test configures no provider: since 2026-09-07 ROVECODE_MOCK=1 mocks even with a
  // provider present (a flag named MOCK mocks), so the loopback tests must not carry it
  if (!("ROVECODE_BASE_URL" in extra)) env.ROVECODE_MOCK = "1";
  Object.assign(env, extra);
  const p = Bun.spawn([process.execPath, MAIN, ...args], { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, stdout, stderr };
}

/** stdout must be exactly one JSON object followed by one newline. */
function single(stdout: string): RunResult {
  const lines = stdout.split("\n");
  expect(lines.length).toBe(2);
  expect(lines[1]).toBe("");
  return JSON.parse(lines[0]!) as RunResult;
}

/** every stdout line must parse (JSON.parse throws on any non-JSON byte). */
function ndjson(stdout: string): Record<string, unknown>[] {
  expect(stdout.endsWith("\n")).toBe(true);
  return stdout.slice(0, -1).split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** Loopback OpenAI-compatible provider: request 1 → tool_calls read(note), request 2 → "DONE-42";
 *  records the last user message of every request. `fail` → every request answers that status. */
function fakeProvider(opts: { fail?: number } = {}) {
  let calls = 0;
  const prompts: string[] = [];
  const server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(req) {
      const body = await req.json() as { messages: { role: string; content?: string | null }[] };
      prompts.push(body.messages.filter((m) => m.role === "user").at(-1)?.content ?? "");
      if (opts.fail) return new Response("simulated provider failure", { status: opts.fail });
      if (calls++ === 0) {
        return Response.json({
          choices: [{
            message: { content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: JSON.stringify({ path: note }) } }] },
            finish_reason: "tool_calls",
          }],
          usage: { prompt_tokens: 1000, completion_tokens: 100 },
        });
      }
      return Response.json({ choices: [{ message: { content: "DONE-42" }, finish_reason: "stop" }], usage: { prompt_tokens: 500, completion_tokens: 50 } });
    },
  });
  return {
    env: { ROVECODE_BASE_URL: `http://127.0.0.1:${server.port}`, ROVECODE_API_KEY: "test-key", ROVECODE_MODEL: MODEL },
    prompts,
    stop: () => { server.stop(true); },
  };
}

// ---------- mock provider (nothing configured) ----------

describe("output modes: mock provider", () => {
  test("--output json: exit 0; stdout is exactly ONE JSON object with the pinned keys; sessionId names a real store", async () => {
    const r = await cli(["run", "say hi", "--output", "json"]);
    expect(r.code).toBe(0);
    const res = single(r.stdout);
    expect(Object.keys(res).sort()).toEqual(RESULT_KEYS);
    expect(res).toMatchObject({
      status: "done", model: { provider: "mock", model: "default" }, origin: { provider: "mock", model: "default" },
      usage: { input: 0, output: 1, cacheRead: 0, cacheWrite: 0 }, costUsd: null, toolCalls: [], exitCode: 0,
    });
    expect(res.summary).toContain("Rovecode mock provider");
    expect(typeof res.sessionId).toBe("string");
    expect(existsSync(join(work, ".rovecode", "sessions", res.sessionId!, "entries.jsonl"))).toBe(true);
  }, T);

  test("--output ndjson: every stdout line parses; first is run_start, last is the result; the loop's exact event sequence", async () => {
    const r = await cli(["run", "say hi", "--output", "ndjson"]);
    expect(r.code).toBe(0);
    const lines = ndjson(r.stdout);
    expect(lines[0]!["type"]).toBe("run_start");
    expect(typeof lines[0]!["sessionId"]).toBe("string");
    expect(lines.map((l) => l["type"])).toEqual(["run_start", "turn_start", "turn_end", "run_end", "result"]);
    expect(lines.at(-1)).toMatchObject({ type: "result", status: "done", exitCode: 0 });
    expect(Object.keys(lines.at(-1)!).sort()).toEqual([...RESULT_KEYS, "type"].sort());
  }, T);

  test("text mode is unchanged: stdout is '\\n' + summary + '\\n' (the pre-port console.log bytes), exit 0", async () => {
    const json = single((await cli(["run", "say hi", "--output", "json"])).stdout);
    const text = await cli(["run", "say hi"]);
    expect(text.code).toBe(0);
    expect(text.stdout).toBe(`\n${json.summary}\n`);
  }, T);

  test("the --output=<mode> form stays supported end to end: `--output=json` → exit 0, one JSON object, and the token is not a prompt word", async () => {
    const r = await cli(["run", "say hi", "--output=json"]);
    expect(r.code).toBe(0);
    expect(single(r.stdout)).toMatchObject({ status: "done", exitCode: 0 });
  }, T);
});

// ---------- stdout purity is structural (pi core/output-guard.ts takeOverStdout) ----------

describe("output modes: stdout guard over the real fd 1", () => {
  test("a project hook that console.logs AND process.stdout.writes mid-run: both strays land on stderr; json stdout stays ONE object, ndjson stays all-JSON (mutation: skip the guard install → the stray lines reach stdout)", async () => {
    const cwd = fresh();
    mkdirSync(join(cwd, ".rovecode"));
    writeFileSync(join(cwd, ".rovecode", "hooks.ts"), 'export default { version: 1, hooks: {\n  pre_run() { console.log("STRAY-LOG"); process.stdout.write("STRAY-WRITE\\n"); },\n} };\n');
    trustProjectFiles(cwd, home); // the child's ROVECODE_HOME is `home`: approve the project hooks file there (core/trust.ts)
    const j = await cli(["run", "say hi", "--output", "json"], {}, cwd);
    expect(j.code).toBe(0);
    expect(single(j.stdout).status).toBe("done");
    expect(j.stderr).toContain("STRAY-LOG\n");
    expect(j.stderr).toContain("STRAY-WRITE\n");
    const n = await cli(["run", "say hi", "--output", "ndjson"], {}, cwd);
    expect(n.code).toBe(0);
    expect(ndjson(n.stdout).at(-1)).toMatchObject({ type: "result", status: "done", exitCode: 0 });
    expect(n.stderr).toContain("STRAY-LOG\n");
    expect(n.stderr).toContain("STRAY-WRITE\n");
  }, T);

  test("MED-C: a session_open hook that prints DURING BOOT (before the sink exists): json stdout is still exactly ONE object, ndjson every line parses — both leaks land on stderr; text mode is untouched (mutation: guard installed by the sink after bootRuntime → 3 stdout lines, whole-stdout JSON.parse throws)", async () => {
    const cwd = fresh();
    mkdirSync(join(cwd, ".rovecode"));
    writeFileSync(join(cwd, ".rovecode", "hooks.ts"), 'export default { version: 1, hooks: {\n  session_open() { console.log("BOOT-LEAK-LOG"); process.stdout.write("BOOT-LEAK-WRITE\\n"); },\n} };\n');
    trustProjectFiles(cwd, home);
    const j = await cli(["run", "say hi", "--output", "json"], {}, cwd);
    expect(j.code).toBe(0);
    expect(() => JSON.parse(j.stdout)).not.toThrow();
    expect(single(j.stdout).status).toBe("done");
    expect(j.stderr).toContain("BOOT-LEAK-LOG\n");
    expect(j.stderr).toContain("BOOT-LEAK-WRITE\n");
    const n = await cli(["run", "say hi", "--output", "ndjson"], {}, cwd);
    expect(n.code).toBe(0);
    const lines = ndjson(n.stdout);
    expect(lines[0]!["type"]).toBe("run_start"); // line 1 is the loop's first event, not the leak
    expect(lines.at(-1)).toMatchObject({ type: "result", status: "done", exitCode: 0 });
    expect(n.stderr).toContain("BOOT-LEAK-LOG\n");
    expect(n.stderr).toContain("BOOT-LEAK-WRITE\n");
    const t = await cli(["run", "say hi"], {}, cwd);
    expect(t.code).toBe(0);
    expect(t.stdout).toContain("BOOT-LEAK-LOG\n"); // text mode installs no guard: the transcript is stdout
  }, T);
});

// ---------- loopback provider: a real tool call ----------

describe("output modes: tool-calling run (loopback provider)", () => {
  test("ROVECODE_MOCK=1 MOCKS even with a provider configured: the loopback receives ZERO requests, the result names provider mock, and a real-looking ANTHROPIC_API_KEY in the environment changes nothing (the condition under which this bit for real: $0.09 on 2026-09-07)", async () => {
    const p = fakeProvider({ fail: 500 }); // would answer every request with a loud 500 — so a single request is a visible failure, not a silent charge
    try {
      const r = await cli(["run", "say hi", "--output", "json"], { ...p.env, ROVECODE_MOCK: "1" }); // the flag, WITH a provider configured
      expect(r.code).toBe(0);
      const res = single(r.stdout);
      expect(res.summary).toContain("Rovecode mock provider");
      expect(res.model).toEqual({ provider: "mock", model: "default" });
      expect(res.costUsd).toBeNull();
      expect(p.prompts.length).toBe(0); // MUTATION: `rt.stream !== null && …` without `!wantsMock` → 1 request, a 500, and with a real key a bill
      const keyed = await cli(["run", "say hi", "--output", "json"], { ...p.env, ROVECODE_MOCK: "1", ANTHROPIC_API_KEY: "sk-ant-not-a-real-key-000000" });
      expect(keyed.code).toBe(0);
      expect(single(keyed.stdout).model).toEqual({ provider: "mock", model: "default" });
      expect(p.prompts.length).toBe(0);
    } finally { p.stop(); }
  }, T);

  test("text mode: '→ read' / '← ok' progress lines and the summary on stdout (pre-port behavior)", async () => {
    const p = fakeProvider();
    try {
      const r = await cli(["run", "read the note"], p.env);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('→ read {"path":');
      expect(r.stdout).toContain("← ok ");
      expect(r.stdout).toContain("hello from note");
      expect(r.stdout.endsWith("\nDONE-42\n")).toBe(true);
    } finally { p.stop(); }
  }, T);

  test("json purity + shape: no progress text on stdout (it is on stderr); one tool call with ms; summed usage; catalog-priced cost; served origin; the post-command --output value is NOT a prompt word", async () => {
    const p = fakeProvider();
    try {
      const r = await cli(["run", "read the note", "--output", "json"], p.env);
      expect(r.code).toBe(0);
      const res = single(r.stdout);
      expect(r.stdout).not.toMatch(/^[→←]/m);
      expect(r.stderr).toContain('→ read {"path":');
      expect(r.stderr).toContain("← ok ");
      expect(res).toMatchObject({
        status: "done", summary: "DONE-42", model: { provider: "custom", model: MODEL }, origin: { provider: "custom", model: MODEL },
        usage: { input: 1500, output: 150, cacheRead: 0, cacheWrite: 0 }, exitCode: 0,
      });
      expect(res.toolCalls).toHaveLength(1);
      expect(res.toolCalls[0]).toMatchObject({ tool: "read", ok: true });
      expect(typeof res.toolCalls[0]!.ms).toBe("number");
      const pricing = new ModelCatalog().lookup("custom", MODEL)?.pricing;
      expect(pricing).toBeDefined();
      const expected = costUsd({ input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 }, pricing!)! + costUsd({ input: 500, output: 50, cacheRead: 0, cacheWrite: 0 }, pricing!)!;
      expect(res.costUsd).toBeCloseTo(expected, 12);
      expect(p.prompts[0]).toBe("read the note"); // runPromptWords: not "read the note json"
    } finally { p.stop(); }
  }, T);

  test("--output before the command (`rovecode --output json run …`): VALUE_FLAGS keeps 'json' from becoming the command, so the provider receives the prompt alone (mutation: drop the entry → cmd 'json', prompt 'json run …' — the mode itself still parses, only the prompt betrays it)", async () => {
    const p = fakeProvider();
    try {
      const r = await cli(["--output", "json", "run", "read the note"], p.env);
      expect(r.code).toBe(0);
      expect(single(r.stdout).status).toBe("done");
      expect(p.prompts[0]).toBe("read the note");
    } finally { p.stop(); }
  }, T);

  test("ndjson with a tool call: tool_execution_start/end lines present, the result lists the call, stderr carries no progress text", async () => {
    const p = fakeProvider();
    try {
      const r = await cli(["run", "read the note", "--output", "ndjson"], p.env);
      expect(r.code).toBe(0);
      const lines = ndjson(r.stdout);
      expect(lines[0]!["type"]).toBe("run_start");
      expect(lines.some((l) => l["type"] === "tool_execution_start" && l["tool"] === "read")).toBe(true);
      expect(lines.some((l) => l["type"] === "tool_execution_end" && l["ok"] === true)).toBe(true);
      const last = lines.at(-1) as unknown as RunResult & { type: string };
      expect(last.type).toBe("result");
      expect(last.toolCalls).toHaveLength(1);
      expect(r.stderr).not.toContain("→");
    } finally { p.stop(); }
  }, T);
});

// ---------- exit codes ----------

describe("output modes: exit codes", () => {
  test("an error run (provider HTTP 400, non-retryable) → exit 1; json result status error / exitCode 1; text mode prints the same summary and exits 1", async () => {
    const p = fakeProvider({ fail: 400 });
    try {
      const j = await cli(["run", "boom", "--output", "json"], p.env);
      expect(j.code).toBe(1);
      const res = single(j.stdout);
      expect(res).toMatchObject({ status: "error", exitCode: 1, toolCalls: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, costUsd: 0 });
      expect(res.summary.startsWith("error: HTTP 400")).toBe(true);
      const t = await cli(["run", "boom"], p.env);
      expect(t.code).toBe(1);
      expect(t.stdout).toBe(`\n${res.summary}\n`);
    } finally { p.stop(); }
  }, T);

  test("invalid --output value → exit 2, empty stdout, exactly one stderr line naming the value — validated BEFORE the runtime boots: a pristine cwd gets NO .rovecode (no sessions dir, meta.json or memory dir) (mutation: parse after bootRuntime → .rovecode/sessions/<id> exists)", async () => {
    const cwd = fresh();
    const r = await cli(["run", "hi", "--output", "xml"], {}, cwd);
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr.trimEnd().split("\n")).toHaveLength(1);
    expect(r.stderr).toContain('unknown --output mode "xml"');
    expect(existsSync(join(cwd, ".rovecode", "sessions"))).toBe(false);
    expect(existsSync(join(cwd, ".rovecode"))).toBe(false);
  }, T);

  test("help documents exit 2 as usage/startup error with NOTHING on stdout, and the --output=<mode> form (DOC item; mutation: drop the sentence)", async () => {
    const r = await cli(["help", "all"]); // the full reference page
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^\s*exit 2 = usage\/startup error .*:\s*$/m);
    expect(r.stdout).toContain("one stderr line, nothing on stdout; --output=<mode> is accepted as well");
  }, T);

  test("dangling --output (end of argv, or followed by a flag) → exit 2 with a one-line usage error (never a silent default), and no .rovecode left behind", async () => {
    for (const args of [["run", "hi", "--output"], ["run", "hi", "--output", "--yolo"]]) {
      const cwd = fresh();
      const r = await cli(args, {}, cwd);
      expect(r.code).toBe(2);
      expect(r.stdout).toBe("");
      expect(r.stderr.trimEnd().split("\n")).toHaveLength(1);
      expect(r.stderr).toContain("--output needs a value");
      expect(existsSync(join(cwd, ".rovecode"))).toBe(false);
    }
  }, T);
});
