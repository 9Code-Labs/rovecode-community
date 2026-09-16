/** PORT #47 — the REAL process seam (src/lanes/process.ts bunLaneSpawn) with a `bun -e` child standing
 *  in for the CLI (never an agentic CLI: none is installed here and they would need keys). Pins: stdout
 *  streams line by line, the exit code and stderr tail come back, a non-exiting child is tree-killed on
 *  the runner's timeout (exit 143, settles fast, nothing lingers), a crashing child is a failed lane with
 *  its stderr, and splitLines handles CRLF + the per-line byte cap. */

import { test, expect } from "bun:test";
import { tmpdir } from "node:os";
import { codexAdapter } from "../../src/lanes/codex.ts";
import { bunLaneSpawn, KEPT_ENV_EXACT, laneChildEnv, MAX_LINE_BYTES, SCRUBBED_ENV_EXACT, SCRUBBED_ENV_PREFIX, splitLines, type LaneSpawn } from "../../src/lanes/process.ts";
import { runExternalLane, type KillStep } from "../../src/lanes/runner.ts";
import type { LaneCommand } from "../../src/lanes/types.ts";

const BUN = process.execPath;
const child = (js: string): LaneCommand => ({ bin: BUN, args: ["-e", js], cwd: tmpdir() });
/** the adapter's command is replaced by a bun child that prints the given JSONL script */
const standIn = (js: string): LaneSpawn => (cmd) => bunLaneSpawn({ ...cmd, bin: BUN, args: ["-e", js] });
const THREAD = JSON.stringify({ type: "thread.started", thread_id: "real-1" });
/** two JSONL lines (a real newline between them — the child prints both) */
const DONE = JSON.stringify({ type: "item.completed", item: { id: "i1", type: "agent_message", text: "hello from a real child" } }) + "\n" + JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 2 } });

function deadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const bomb = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error(`${what}: not settled within ${ms}ms`)), ms); });
  return Promise.race([p, bomb]).finally(() => clearTimeout(t));
}

test("bunLaneSpawn: stdout arrives line by line, the exit code and the stderr tail come back, the job is released on a normal exit", async () => {
  const p = bunLaneSpawn(child(`process.stdout.write(${JSON.stringify(THREAD)} + "\\r\\n"); console.log(${JSON.stringify(DONE)}); console.error("warn: quota low"); process.exit(0);`));
  expect(p.pid).toBeGreaterThan(0);
  const lines: string[] = [];
  for await (const l of p.lines()) lines.push(l);
  expect(lines).toEqual([THREAD, ...DONE.split("\n")]); // CRLF stripped, one entry per line
  expect(await deadline(p.exited, 5_000, "exit")).toBe(0);
  expect(p.stderrTail()).toBe("warn: quota low");
  expect(p.interrupt()).toBe(false); // an exited process cannot be interrupted (and win32 never can)
  p.kill(); // idempotent no-op after exit
}, 20_000);

test("runExternalLane over the real seam: a printing child → done with usage; a hanging child is tree-killed at the timeout (143) and settles well inside the grace", async () => {
  const ok = await deadline(runExternalLane(codexAdapter, { goal: "g" }, { cwd: tmpdir(), timeoutMs: 15_000 }, { spawn: standIn(`console.log(${JSON.stringify(THREAD)}); console.log(${JSON.stringify(DONE)});`) }), 15_000, "real done lane");
  expect(ok.status).toBe("done");
  expect(ok.summary).toBe("hello from a real child");
  expect(ok.usage).toEqual({ input: 1, output: 2 });
  expect(ok.sessionId).toBe("real-1");
  expect(ok.exitCode).toBe(0);
  const t0 = Date.now();
  const hung = await deadline(runExternalLane(codexAdapter, { goal: "g" }, { cwd: tmpdir(), timeoutMs: 400 }, { spawn: standIn(`console.log(${JSON.stringify(THREAD)}); setInterval(() => {}, 1000);`) }), 15_000, "hung lane");
  expect(hung.status).toBe("failed");
  expect(hung.error).toBe("timed out after 400ms");
  expect(hung.exitCode).toBe(143); // mutation target: process.ts `killed ? 143 : code`
  expect(hung.log).toEqual(["thread real-1"]);
  expect(Date.now() - t0).toBeLessThan(6_000);
}, 40_000);

test("a crashing child is a failed lane carrying its exit code and stderr", async () => {
  const r = await deadline(runExternalLane(codexAdapter, { goal: "g" }, { cwd: tmpdir(), timeoutMs: 15_000 }, { spawn: standIn(`console.error("boom: not logged in"); process.exit(3);`) }), 15_000, "crashing lane");
  expect(r.status).toBe("failed");
  expect(r.exitCode).toBe(3);
  expect(r.error).toBe("codex exited with code 3 without a result: boom: not logged in");
}, 20_000);

function stream(chunks: string[]): ReadableStreamDefaultReader<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({ start(c) { for (const ch of chunks) c.enqueue(enc.encode(ch)); c.close(); } }).getReader();
}
async function all(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string[]> { const out: string[] = []; for await (const l of splitLines(reader)) out.push(l); return out; }

test("splitLines: lines across chunk boundaries, CRLF, a final unterminated line; a line over MAX_LINE_BYTES is cut and its remainder dropped", async () => {
  expect(await all(stream(["a\r\nb", "c\nd"]))).toEqual(["a", "bc", "d"]);
  expect(await all(stream(["", "\n\n", "x\n"]))).toEqual(["", "", "x"]);
  const long = "x".repeat(MAX_LINE_BYTES + 10);
  const one = await all(stream([long + "\nok\n"]));
  expect(one.map((l) => l.length)).toEqual([MAX_LINE_BYTES, 2]); // mutation target: the in-loop cut
  const spanning = await all(stream([long.slice(0, MAX_LINE_BYTES + 5), long.slice(MAX_LINE_BYTES + 5) + "\nok\n"]));
  expect(spanning.map((l) => l.length)).toEqual([MAX_LINE_BYTES, 2]); // cut while spanning, the tail dropped at its newline
});

// ---------- live-machine findings 2026-09-03 (claude 2.1.257 / opencode 1.18.23 on Windows) ----------

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(pred: () => boolean, ms: number, what: string): Promise<void> {
  const t0 = Date.now();
  while (!pred()) { if (Date.now() - t0 > ms) throw new Error(`${what}: not true within ${ms}ms`); await sleep(25); }
}
/** signal 0 = existence probe (Windows too) */
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("env scrub: CLAUDECODE and every CLAUDE_CODE_* name (any case) never reach the child EXCEPT the CLI's documented knobs (KEPT_ENV_EXACT) — pure laneChildEnv and the REAL seam; everything else and cmd.env survive", async () => {
  expect(SCRUBBED_ENV_EXACT).toEqual(["CLAUDECODE"]); expect(SCRUBBED_ENV_PREFIX).toBe("CLAUDE_CODE_");
  // mutation target: the prefix/exact checks (a lane inheriting the parent Claude Code session's id, messaging token, host-auth marker)
  expect(laneChildEnv({ CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "s", claude_code_messaging_token: "t", CLAUDE_PID: "7", PATH: "p", GONE: undefined }, { EXTRA: "1" }))
    .toEqual({ CLAUDE_PID: "7", PATH: "p", EXTRA: "1" });
  expect(laneChildEnv({ A: "1" })).toEqual({ A: "1" });
  // the CLI's DOCUMENTED knobs share the prefix but are the user's configuration (the token login of `claude
  // setup-token`, the 3P-provider switches, …): kept, any case; the session's plumbing beside them still goes
  // (mutation target: the KEPT_ENV_EXACT check before the prefix rule — a token-authenticated lane got "Not logged in")
  expect(KEPT_ENV_EXACT).toEqual(["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "CLAUDE_CODE_SIMPLE", "CLAUDE_CODE_SAFE_MODE", "CLAUDE_CODE_MAX_OUTPUT_TOKENS", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"]);
  expect(laneChildEnv({ CLAUDE_CODE_OAUTH_TOKEN: "tok", claude_code_use_bedrock: "1", CLAUDE_CODE_OAUTH_SCOPES: "plumbing", CLAUDE_CODE_SESSION_ID: "s", CLAUDECODE: "1" }))
    .toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "tok", claude_code_use_bedrock: "1" });
  for (const k of KEPT_ENV_EXACT) expect(laneChildEnv({ [k]: "v", CLAUDE_CODE_ENTRYPOINT: "cli" })).toEqual({ [k]: "v" });
  const had = process.env["CLAUDECODE"], hadTok = process.env["CLAUDE_CODE_OAUTH_TOKEN"];
  process.env["CLAUDECODE"] = "1"; process.env["CLAUDE_CODE_LANE_PROBE"] = "x"; process.env["ROVECODE_LANE_PROBE_KEEP"] = "keep"; process.env["CLAUDE_CODE_OAUTH_TOKEN"] = "lane-probe-token";
  try {
    // the kept names present in THIS process (the probe token + whatever this box sets) are exactly what the child may see
    const kept = Object.keys(process.env).filter((k) => KEPT_ENV_EXACT.includes(k.toUpperCase())).map((k) => k.toUpperCase()).sort();
    expect(kept).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    const p = bunLaneSpawn({ bin: BUN, args: ["-e", `console.log(JSON.stringify({ cc: process.env.CLAUDECODE ?? null, names: Object.keys(process.env).filter((k) => /^CLAUDE_CODE_/i.test(k)).map((k) => k.toUpperCase()).sort(), tok: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null, keep: process.env.ROVECODE_LANE_PROBE_KEEP ?? null, extra: process.env.LANE_PROBE_EXTRA ?? null }))`], cwd: tmpdir(), env: { LANE_PROBE_EXTRA: "1" } });
    const lines: string[] = [];
    for await (const l of p.lines()) lines.push(l);
    expect(await deadline(p.exited, 5_000, "exit")).toBe(0);
    // mutation targets: `{ ...process.env, ...cmd.env }` back in bunLaneSpawn (names gains LANE_PROBE + the host's plumbing); KEPT_ENV_EXACT dropped (tok null)
    expect(JSON.parse(lines[0]!)).toEqual({ cc: null, names: kept, tok: "lane-probe-token", keep: "keep", extra: "1" });
  } finally {
    delete process.env["CLAUDE_CODE_LANE_PROBE"]; delete process.env["ROVECODE_LANE_PROBE_KEEP"];
    if (had === undefined) delete process.env["CLAUDECODE"]; else process.env["CLAUDECODE"] = had;
    if (hadTok === undefined) delete process.env["CLAUDE_CODE_OAUTH_TOKEN"]; else process.env["CLAUDE_CODE_OAUTH_TOKEN"] = hadTok;
  }
}, 20_000);

test("cancel over the REAL seam: abort → the launcher AND the grandchild it forked die (Job Object tree kill on win32), the lane settles cancelled with 143 well inside the grace", async () => {
  // the child forks a grandchild that would outlive a plain launcher kill, prints its pid as the thread id, then parks
  const child = `const g = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdout: "ignore", stderr: "ignore" }); console.log(JSON.stringify({ type: "thread.started", thread_id: String(g.pid) })); setInterval(() => {}, 1000);`;
  const ac = new AbortController();
  const steps: KillStep[] = [];
  const pids: number[] = [];
  const spawn: LaneSpawn = (cmd) => { const p = bunLaneSpawn({ ...cmd, bin: BUN, args: ["-e", child] }); pids.push(p.pid); return p; };
  const t0 = Date.now();
  const r = await deadline(runExternalLane(codexAdapter, { goal: "g" }, { cwd: tmpdir(), timeoutMs: 30_000 }, { spawn, signal: ac.signal, steps, onEvent: () => ac.abort() }), 15_000, "cancelled real lane");
  expect(r.status).toBe("cancelled"); expect(r.error).toBe("cancelled");
  expect(r.exitCode).toBe(143); // mutation target: process.ts `killed ? 143 : code`
  expect(r.log).toEqual([`thread ${r.sessionId}`]);
  expect(steps[0]).toBe("kill"); // codex: no SIGINT contract; and win32 could not deliver one anyway
  expect(Date.now() - t0).toBeLessThan(8_000);
  const grandchild = Number(r.sessionId);
  expect(grandchild).toBeGreaterThan(0);
  await until(() => !alive(pids[0]!), 5_000, "launcher dead");
  // POSIX orphans a forked grandchild (executor.ts documents it); the Job Object takes the whole tree on win32
  if (process.platform === "win32") await until(() => !alive(grandchild), 5_000, "grandchild dead (job object)"); // mutation target: job?.terminate() dropped from kill()
  else { try { process.kill(grandchild, "SIGKILL"); } catch { /* already gone */ } }
}, 30_000);
