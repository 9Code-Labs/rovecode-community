/** PORT #27 boot wiring: createRuntime/bootRuntime select the executor rung
 *  from .rovecode/sandbox.json / ROVECODE_SANDBOX, probe it through an INJECTED runner
 *  (a real wsl.exe/docker is never spawned here), expose rt.sandbox, and turn
 *  an unavailable rung into ONE typed one-line startup error. Entrypoint pins:
 *  the real CLI (`rovecode run` → exit 2 + one stderr line) and `serve` (503 JSON);
 *  the acp pin lives in test/unit/acp.test.ts (rig reuse). The TUI applies the
 *  same bootRuntime catch (app.ts hunk) and renders describeSandbox in /status. */

import { test, expect, afterEach } from "bun:test";
import { createRuntime, bootRuntime, type Runtime } from "../../src/cli/runtime.ts";
import { SandboxConfigError } from "../../src/core/sandbox-config.ts";
import { getExecutor, resetExecutor, RungUnavailableError, type SpawnRunner, type RawResult } from "../../src/core/executor.ts";
import { McpManager } from "../../src/mcp/client.ts";
import { startServer } from "../../src/server/http.ts";
import type { ToolContext } from "../../src/core/types.ts";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { scratchHome, trustProjectFiles, writeTrustedMcpJson } from "../helpers/mcp-trust.ts";

afterEach(() => resetExecutor()); // the seam is module-global — never leak a fake runner or a poisoned desire

// ---------- rig ----------

const ROOT = resolve(import.meta.dir, "..", "..");
const MAIN = join(ROOT, "src", "cli", "main.ts");

/** Sandbox env under test control, checkpoints off (no shadow-git in tmp);
 *  returns the restore fn. */
function envScope(set: Record<string, string> = {}): () => void {
  const keys = ["ROVECODE_SANDBOX", "ROVECODE_SANDBOX_IMAGE", "ROVECODE_NO_CHECKPOINTS"];
  const saved = new Map(keys.map((k) => [k, process.env[k]] as const));
  delete process.env.ROVECODE_SANDBOX;
  delete process.env.ROVECODE_SANDBOX_IMAGE;
  process.env.ROVECODE_NO_CHECKPOINTS = "1";
  for (const [k, v] of Object.entries(set)) process.env[k] = v;
  return () => { for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
}

function tmpCwd(): string { return mkdtempSync(join(tmpdir(), "rovecode-rt-sbx-")); }
/** a project sandbox.json, approved as written in the current home (an untrusted one contributes nothing since
 *  2026-09-07 — test/unit/project-trust.test.ts pins that; these tests are about what a TRUSTED file makes the boot do) */
function sandboxFile(cwd: string, cfg: unknown): void {
  mkdirSync(join(cwd, ".rovecode"), { recursive: true });
  writeFileSync(join(cwd, ".rovecode", "sandbox.json"), JSON.stringify(cfg));
  trustProjectFiles(cwd);
}

interface Call { argv: string[]; cwd?: string }
function fakeRunner(script: (argv: readonly string[]) => RawResult): { runner: SpawnRunner; calls: Call[] } {
  const calls: Call[] = [];
  const runner: SpawnRunner = (argv, opts) => { calls.push({ argv: [...argv], cwd: opts.cwd }); return Promise.resolve(script(argv)); };
  return { runner, calls };
}
const ok = (stdout = ""): RawResult => ({ code: 0, stdout, stderr: "" });
const fail = (code: number, stderr: string): RawResult => ({ code, stdout: "", stderr });
/** wsl/docker probes are trial spawns of `… bash -c true` through the wrapper. */
const isProbe = (argv: readonly string[]) => argv.at(-3) === "bash" && argv.at(-2) === "-c" && argv.at(-1) === "true";

/** Dispatch through the REGISTERED bash tool (the runtime's withCheckpoint wrapper),
 *  exactly what the loop calls — not the bare bashTool export. */
async function runBash(rt: Runtime, command: string): Promise<{ ok: boolean; output: string }> {
  const bash = rt.registry.list().find((t) => t.schema.name === "bash");
  expect(bash).toBeDefined();
  const ctx: ToolContext = { sessionId: rt.sessionId, cwd: rt.cwd, signal: new AbortController().signal, permissions: { effect: "allow" } };
  return bash!.execute({ command }, ctx);
}

// ---------- boot wiring via fake runner ----------

test("wsl in .rovecode/sandbox.json + probe FAILS → bootRuntime rejects with SandboxConfigError (one line, probe detail inside); seam poisoned, never lazy direct", async () => {
  const cwd = tmpCwd();
  const restore = envScope();
  try {
    sandboxFile(cwd, { rung: "wsl" });
    const { runner, calls } = fakeRunner(() => fail(1, "<3>WSL (11 - Relay) ERROR: execvpe(bash) failed: No such file or directory"));
    let thrown: unknown;
    try { await bootRuntime({ cwd, stream: null, spawnRunner: runner, platform: "win32" }); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(SandboxConfigError);
    const err = thrown as SandboxConfigError;
    expect(err.name).toBe("SandboxConfigError");
    expect(err.message).toContain('sandbox rung "wsl"');
    expect(err.message).toContain("from .rovecode/sandbox.json");
    expect(err.message).toContain("unavailable");
    expect(err.message).toContain("execvpe(bash) failed"); // the PROBE's own detail rides along
    expect(err.message).toContain("default: direct");      // and the fix
    expect(err.message).not.toMatch(/[\r\n]/);             // ONE line
    expect(err.message).not.toContain("    at ");          // no stack in the message
    expect(err.cause).toBeInstanceOf(RungUnavailableError);
    // the probe was the wrapper's own shape, exactly once
    expect(calls.map((c) => c.argv)).toEqual([["wsl.exe", "--exec", "bash", "-c", "true"]]);
    // #10 G7: the desire is recorded — the seam refuses to hand out direct
    expect(() => getExecutor()).toThrow(RungUnavailableError);
    // the sync construction path carries the same verdict through sandbox.ready
    const rt = createRuntime({ cwd, stream: null, spawnRunner: runner, platform: "win32" });
    expect(rt.sandbox.rung).toBe("wsl");
    expect(rt.sandbox.source).toBe("file");
    await expect(rt.sandbox.ready).rejects.toBeInstanceOf(SandboxConfigError);
  } finally { restore(); rmSync(cwd, { recursive: true, force: true }); }
});

test("wsl in .rovecode/sandbox.json + probe ok → rt.sandbox is wsl/file and the registered bash tool dispatches through `wsl.exe --cd <cwd> --exec bash -c <cmd>`", async () => {
  const cwd = tmpCwd();
  const restore = envScope();
  try {
    sandboxFile(cwd, { rung: "wsl" });
    const { runner, calls } = fakeRunner((argv) => (isProbe(argv) ? ok() : ok("from-wsl\n")));
    const rt = await bootRuntime({ cwd, stream: null, spawnRunner: runner, platform: "win32" });
    expect(rt.sandbox.rung).toBe("wsl");
    expect(rt.sandbox.source).toBe("file");
    expect(rt.sandbox.dockerImage).toBeUndefined();
    expect(calls.map((c) => c.argv)).toEqual([["wsl.exe", "--exec", "bash", "-c", "true"]]); // one probe, wrapper shape
    expect(getExecutor().rung).toBe("wsl");
    const out = await runBash(rt, "echo hi");
    expect(out).toEqual({ ok: true, output: "exit=0\nfrom-wsl\n" });
    expect(calls).toHaveLength(2);
    // the dispatch went THROUGH the wsl wrapper (mutation: drop configureExecutor in
    // createRuntime → the seam stays lazy direct and argv[0] is bash)
    expect(calls[1]!.argv).toEqual(["wsl.exe", "--cd", cwd, "--exec", "bash", "-c", "echo hi"]);
    expect(calls[1]!.cwd).toBe(cwd);
  } finally { restore(); rmSync(cwd, { recursive: true, force: true }); }
});

test("no config → direct from default: the runner is never asked to probe; dispatch is plain bash, no wrapper", async () => {
  const cwd = tmpCwd();
  const restore = envScope();
  try {
    const { runner, calls } = fakeRunner(() => ok("plain\n"));
    const rt = await bootRuntime({ cwd, stream: null, spawnRunner: runner });
    expect(rt.sandbox.rung).toBe("direct");
    expect(rt.sandbox.source).toBe("default");
    expect(rt.sandbox.dockerImage).toBeUndefined();
    expect(calls).toHaveLength(0); // direct is the one rung that never probes
    const out = await runBash(rt, "echo hi");
    expect(out).toEqual({ ok: true, output: "exit=0\nplain\n" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.argv[0]).not.toBe("wsl.exe");
    expect(calls[0]!.argv[0]).toMatch(/bash(\.exe)?$/);
    expect(calls[0]!.argv.slice(1)).toEqual(["-c", "echo hi"]);
    expect(calls[0]!.cwd).toBe(cwd);
  } finally { restore(); rmSync(cwd, { recursive: true, force: true }); }
});

test("env ROVECODE_SANDBOX=docker (+ ROVECODE_SANDBOX_IMAGE) beats a file saying wsl → rt.sandbox docker/env with the image; probe and dispatch use it against the mounted cwd", async () => {
  const cwd = tmpCwd();
  const restore = envScope({ ROVECODE_SANDBOX: "docker", ROVECODE_SANDBOX_IMAGE: "rovecode/dev:1" });
  try {
    sandboxFile(cwd, { rung: "wsl" });
    const { runner, calls } = fakeRunner((argv) => (isProbe(argv) ? ok() : ok("in-container\n")));
    const rt = await bootRuntime({ cwd, stream: null, spawnRunner: runner });
    expect(rt.sandbox.rung).toBe("docker");
    expect(rt.sandbox.dockerImage).toBe("rovecode/dev:1");
    expect(rt.sandbox.source).toBe("env");
    // mutation: env no longer overrides the file → rung wsl, probe argv wsl.exe → fails here
    expect(calls.map((c) => c.argv)).toEqual([["docker", "run", "--rm", "rovecode/dev:1", "bash", "-c", "true"]]);
    const out = await runBash(rt, "ls");
    expect(out).toEqual({ ok: true, output: "exit=0\nin-container\n" });
    expect(calls[1]!.argv).toEqual(["docker", "run", "--rm", "-v", `${cwd}:/workspace`, "-w", "/workspace", "rovecode/dev:1", "bash", "-c", "ls"]);
  } finally { restore(); rmSync(cwd, { recursive: true, force: true }); }
});

test("unknown rung in the file → createRuntime throws SandboxConfigError synchronously, BEFORE any side effect (no sessions dir, no probe, seam untouched)", async () => {
  const cwd = tmpCwd();
  const restore = envScope();
  try {
    sandboxFile(cwd, { rung: "bubblewrap" });
    const { runner, calls } = fakeRunner(() => ok());
    expect(() => createRuntime({ cwd, stream: null, spawnRunner: runner })).toThrow(SandboxConfigError);
    expect(existsSync(join(cwd, ".rovecode", "sessions"))).toBe(false); // mutation: load config after mkdir → a dir appears
    expect(calls).toHaveLength(0);
    expect(getExecutor().rung).toBe("direct"); // no desire was recorded
    // the boot path surfaces the sync throw as the same rejection
    await expect(bootRuntime({ cwd, stream: null, spawnRunner: runner })).rejects.toBeInstanceOf(SandboxConfigError);
  } finally { restore(); rmSync(cwd, { recursive: true, force: true }); }
});

test("a failed boot reaps the MCP children construction spawned (no orphan processes behind a startup error)", async () => {
  const cwd = tmpCwd();
  const restore = envScope();
  const restoreHome = scratchHome(); // the project .mcp.json must be TRUSTED to spawn anything (mcp/trust.ts) — in a scratch home
  const closed: McpManager[] = [];
  const orig = McpManager.prototype.close;
  McpManager.prototype.close = async function (this: McpManager) { closed.push(this); return orig.call(this); };
  try {
    sandboxFile(cwd, { rung: "wsl" });
    writeTrustedMcpJson(cwd, { toy: { command: "rovecode-not-a-real-binary-sbx" } });
    const { runner } = fakeRunner(() => fail(1, "no wsl here"));
    await expect(bootRuntime({ cwd, stream: null, spawnRunner: runner, platform: "win32" })).rejects.toBeInstanceOf(SandboxConfigError);
    expect(closed).toHaveLength(1); // mutation: drop rt.mcp?.close() in bootRuntime → 0
  } finally {
    McpManager.prototype.close = orig;
    restoreHome();
    restore();
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ---------- entrypoints: clean startup failure, deterministic (unknown rung → no probe) ----------

test("serve: POST /session under a broken sandbox config → 503 JSON with the one-line message; server stays up, no half-created session", async () => {
  const cwd = tmpCwd();
  const restore = envScope();
  sandboxFile(cwd, { rung: "bubblewrap" });
  const s = startServer({ port: 0, cwd, stream: null });
  try {
    const res = await fetch(`${s.url}/session`, { method: "POST" });
    expect(res.status).toBe(503); // mutation: drop the SandboxConfigError mapping → never-throw seam 500
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('sandbox rung "bubblewrap"');
    expect(body.error).toContain("default: direct");
    expect(body.error).not.toMatch(/[\r\n]/);
    expect(existsSync(join(cwd, ".rovecode", "sessions"))).toBe(false);
    expect((await fetch(`${s.url}/doc`)).status).toBe(200); // alive
  } finally {
    await s.stop();
    restore();
    rmSync(cwd, { recursive: true, force: true });
  }
});

/** Host env minus ROVECODE_* and provider keys (a host ROVECODE_SANDBOX would override
 *  the file under test; a host key must not steer the CLI onto a real endpoint);
 *  ROVECODE_HOME → the temp cwd so no stored credential is found either. */
function hermeticEnv(home: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || /^ROVECODE_/i.test(k) || /_API_KEY$/i.test(k)) continue;
    env[k] = v;
  }
  env.ROVECODE_HOME = home;
  return env;
}

test("CLI: `rovecode run` in a cwd with an unknown rung → exit 2, exactly one `error:` line on stderr, nothing on stdout", () => {
  const cwd = tmpCwd();
  try {
    sandboxFile(cwd, { rung: "bubblewrap" });
    trustProjectFiles(cwd, cwd); // the child's ROVECODE_HOME is the cwd itself (hermeticEnv): approve the file THERE, or the child ignores it as untrusted and boots fine
    const p = Bun.spawnSync([process.execPath, MAIN, "run", "hi"], { cwd, env: hermeticEnv(cwd), stdout: "pipe", stderr: "pipe" });
    const stderr = p.stderr.toString();
    // mutation: drop the bootRuntime catch in cmdRun → uncaught error: exit 1 + a multi-line stack
    expect(p.exitCode).toBe(2);
    expect(stderr.trim().split("\n")).toHaveLength(1);
    expect(stderr).toMatch(/^error: sandbox rung "bubblewrap" .* \(default: direct\)\r?\n$/);
    expect(stderr).not.toContain("    at ");
    expect(p.stdout.toString()).toBe("");
  } finally { rmSync(cwd, { recursive: true, force: true }); }
}, 30_000);

test("CLI: help documents ROVECODE_SANDBOX and ROVECODE_SANDBOX_IMAGE in the env section", () => {
  const p = Bun.spawnSync([process.execPath, MAIN, "help", "env"], { cwd: ROOT, env: hermeticEnv(ROOT), stdout: "pipe", stderr: "pipe" }); // the env page
  expect(p.exitCode).toBe(0);
  const out = p.stdout.toString();
  expect(out).toMatch(/^\s*ROVECODE_SANDBOX\s+.*direct.*wsl.*docker.*sandbox\.json/m);
  expect(out).toMatch(/^\s*ROVECODE_SANDBOX_IMAGE\s+.*docker rung/m);
}, 30_000);
