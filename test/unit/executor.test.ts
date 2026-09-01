/** PORT #10 executor ladder tests: rung selection, probe-failure paths,
 *  unavailable rung → loud error (never silent fallback DOWN), and direct
 *  rung byte-parity with today's bashTool. */

import { test, expect, afterEach } from "bun:test";
import {
  RUNGS,
  probeRung,
  probeLadder,
  createExecutor,
  configureExecutor,
  getExecutor,
  resetExecutor,
  RungUnavailableError,
  DEFAULT_DOCKER_IMAGE,
  bunRunner,
  type SpawnRunner,
  type RawResult,
} from "../../src/core/executor.ts";
import { bashTool } from "../../src/coding/hashline.ts";
import type { PermissionDecision } from "../../src/core/types.ts";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

afterEach(() => resetExecutor());

// ---------- fakes ----------

function fakeRunner(script: (argv: readonly string[]) => RawResult): { runner: SpawnRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: SpawnRunner = (argv) => {
    calls.push([...argv]);
    return Promise.resolve(script(argv));
  };
  return { runner, calls };
}
const ok = (stdout = ""): RawResult => ({ code: 0, stdout, stderr: "" });
const fail = (code: number, stderr: string): RawResult => ({ code, stdout: "", stderr });
/** probe calls succeed, executed commands run `exec` */
const probeOkThen = (exec: (argv: readonly string[]) => RawResult) => fakeRunner((argv) =>
  (argv[0] === "wsl.exe" && argv[1] === "--status") || (argv[0] === "docker" && argv[1] === "version") ? ok("25.0.0") : exec(argv));

// ---------- ladder + rung selection ----------

test("ladder is direct → wsl → docker", () => {
  expect([...RUNGS]).toEqual(["direct", "wsl", "docker"]);
});

test("rung selection: the requested rung is the returned rung, never substituted", async () => {
  const { runner } = fakeRunner(() => ok("25.0.0"));
  for (const rung of RUNGS) {
    const ex = await createExecutor(rung, { runner, platform: "win32" });
    expect(ex.rung).toBe(rung);
  }
});

// ---------- probes ----------

test("direct probe: always available, no process spawned", async () => {
  const { runner, calls } = fakeRunner(() => fail(1, "must not be called"));
  const p = await probeRung("direct", runner, "linux");
  expect(p.available).toBe(true);
  expect(calls.length).toBe(0);
});

test("wsl probe: off-Windows is unavailable with a platform explanation, no spawn", async () => {
  const { runner, calls } = fakeRunner(() => ok());
  const p = await probeRung("wsl", runner, "linux");
  expect(p.available).toBe(false);
  expect(p.detail).toContain("Windows");
  expect(p.detail).toContain("linux");
  expect(calls.length).toBe(0);
});

test("wsl probe: wsl.exe --status failure reported with exit code and output", async () => {
  const { runner, calls } = fakeRunner(() => fail(1, "W\u0000S\u0000L\u0000 is not installed"));
  const p = await probeRung("wsl", runner, "win32");
  expect(p.available).toBe(false);
  expect(p.detail).toContain("exited 1");
  expect(p.detail).toContain("WSL is not installed"); // UTF-16LE NULs stripped
  expect(calls[0]).toEqual(["wsl.exe", "--status"]);
});

test("docker probe: daemon-down and missing-CLI are both unavailable with detail", async () => {
  const daemonDown = fakeRunner(() => fail(1, "Cannot connect to the Docker daemon"));
  const p1 = await probeRung("docker", daemonDown.runner, "linux");
  expect(p1.available).toBe(false);
  expect(p1.detail).toContain("Cannot connect to the Docker daemon");
  expect(daemonDown.calls[0]?.slice(0, 2)).toEqual(["docker", "version"]); // daemon probe, not --version

  const noCli = fakeRunner(() => fail(-1, "spawn failed: ENOENT"));
  const p2 = await probeRung("docker", noCli.runner, "darwin");
  expect(p2.available).toBe(false);
  expect(p2.detail).toContain("ENOENT");
});

test("bunRunner: a missing binary becomes code -1 + stderr, not a crash", async () => {
  const r = await bunRunner(["definitely-not-a-real-binary-p10-xyz"], {});
  expect(r.code).toBe(-1);
  expect(r.stderr).toContain("spawn failed");
});

test("probeLadder reports every rung in ladder order without choosing for you", async () => {
  const { runner } = fakeRunner((argv) => (argv[0] === "docker" ? fail(1, "daemon down") : ok()));
  const probes = await probeLadder(runner, "linux");
  expect(probes.map((p) => p.rung)).toEqual(["direct", "wsl", "docker"]);
  expect(probes.map((p) => p.available)).toEqual([true, false, false]);
});

// ---------- unavailable rung → loud error, never silent fallback DOWN ----------

test("unavailable rung: createExecutor throws RungUnavailableError naming the rung", async () => {
  const { runner } = fakeRunner(() => fail(1, "daemon down"));
  let thrown: unknown;
  try {
    await createExecutor("docker", { runner, platform: "linux" });
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeInstanceOf(RungUnavailableError);
  const err = thrown as RungUnavailableError;
  expect(err.rung).toBe("docker");
  expect(err.message).toContain("'docker' is unavailable");
  expect(err.message).toContain("daemon down");
  expect(err.message).toContain("fall back"); // states the no-fallback contract
});

test("failed configure is loud and leaves the seam unchanged (no fallback DOWN)", async () => {
  expect(getExecutor().rung).toBe("direct"); // default before any configure
  const { runner } = fakeRunner(() => fail(1, "no wsl here"));
  let thrown: unknown;
  try {
    await configureExecutor("wsl", { runner, platform: "win32" });
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeInstanceOf(RungUnavailableError);
  expect(getExecutor().rung).toBe("direct"); // unchanged, and the caller SAW the error
});

test("configureExecutor installs the probed rung behind the seam", async () => {
  const { runner } = fakeRunner(() => ok());
  const ex = await configureExecutor("wsl", { runner, platform: "win32" });
  expect(ex.rung).toBe("wsl");
  expect(getExecutor().rung).toBe("wsl");
  resetExecutor();
  expect(getExecutor().rung).toBe("direct");
});

// ---------- rung command construction ----------

test("wsl rung wraps through wsl.exe: --cd <cwd> --exec bash -c <cmd>", async () => {
  const { runner, calls } = probeOkThen(() => ok("hi\n"));
  const ex = await createExecutor("wsl", { runner, platform: "win32" });
  const r = await ex.run('echo "a b"', "D:\\ws", new AbortController().signal);
  expect(calls[1]).toEqual(["wsl.exe", "--cd", "D:\\ws", "--exec", "bash", "-c", 'echo "a b"']);
  expect(r).toEqual({ code: 0, text: "hi\n" });
});

test("docker rung runs the container against the mounted workspace", async () => {
  const { runner, calls } = probeOkThen(() => ok("out"));
  const ex = await createExecutor("docker", { runner, platform: "linux" });
  const r = await ex.run("ls -la", "/repo");
  expect(calls[1]).toEqual([
    "docker", "run", "--rm", "-v", "/repo:/workspace", "-w", "/workspace", DEFAULT_DOCKER_IMAGE, "bash", "-c", "ls -la",
  ]);
  expect(r).toEqual({ code: 0, text: "out" });

  const custom = probeOkThen(() => ok());
  const ex2 = await createExecutor("docker", { runner: custom.runner, dockerImage: "aion/dev:1", platform: "linux" });
  await ex2.run("pwd", "/repo");
  expect(custom.calls[1]?.[7]).toBe("aion/dev:1");
});

test("non-direct rungs assemble stderr and truncate at 10k exactly like today's format", async () => {
  const mixed = probeOkThen(() => ({ code: 3, stdout: "out\n", stderr: "err\n" }));
  const ex = await createExecutor("wsl", { runner: mixed.runner, platform: "win32" });
  const r = await ex.run("anything", "D:\\ws");
  expect(r.code).toBe(3);
  expect(r.text).toBe("out\n\nstderr:\nerr\n");

  const long = probeOkThen(() => ({ code: 0, stdout: "x".repeat(11_000), stderr: "" }));
  const ex2 = await createExecutor("wsl", { runner: long.runner, platform: "win32" });
  const r2 = await ex2.run("anything", "D:\\ws");
  expect(r2.text.length).toBe(10_000);
});

// ---------- direct rung parity (real spawns, vs the real bashTool) ----------

function makeCtx(cwd: string): { sessionId: string; cwd: string; signal: AbortSignal; permissions: PermissionDecision } {
  return { sessionId: "s", cwd, signal: new AbortController().signal, permissions: { effect: "allow" } };
}

test("direct rung parity: byte-identical to bashTool across success/stderr/failure/cwd/truncation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aion-exec-"));
  writeFileSync(join(dir, "marker.txt"), "from-cwd");
  const ctx = makeCtx(dir);
  const ex = getExecutor(); // unconfigured seam = direct = today's behavior
  expect(ex.rung).toBe("direct");
  const cases = [
    "echo hello",
    "echo out; echo err 1>&2",
    "printf 'no-trailing-newline'",
    "cat marker.txt",                                   // cwd propagation
    "exit 7",                                           // deterministic failure (bashTool retry yields same bytes)
    "for i in $(seq 1 1500); do echo abcdefgh; done",   // >10k output → both truncate at 10k
  ];
  for (const command of cases) {
    const viaTool = await bashTool.execute({ command }, ctx);
    const viaSeam = await ex.run(command, ctx.cwd, ctx.signal);
    expect(`exit=${viaSeam.code}\n${viaSeam.text}`).toBe(viaTool.output);
    expect(viaSeam.code === 0).toBe(viaTool.ok);
  }
  rmSync(dir, { recursive: true, force: true });
}, 30_000);
