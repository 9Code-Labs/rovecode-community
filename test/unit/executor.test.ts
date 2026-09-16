/** PORT #10 executor ladder tests: rung selection, probe-failure paths,
 *  unavailable rung → loud error (never silent fallback DOWN), and direct
 *  rung byte-parity with today's bashTool.
 *
 *  Round-2 pins: probes are trial spawns THROUGH the wrapper (G1/G2) and
 *  time-bounded at 500ms (G3); signal/cwd forwarding is pinned by identity
 *  (G4); direct-rung bytes are ABSOLUTE, not seam-vs-seam (G5); the Git-bash
 *  preference is pinned via argv[0] (G6); a failed configure poisons the
 *  seam instead of degrading (G7). The tool-level spawn-failure pin (G8)
 *  lives with bashTool in hashline.test.ts. Probe/rung tests use fake
 *  runners ONLY — a real wsl.exe/docker spawn is machine-state-dependent
 *  and can hold pipes open long past a kill.
 *
 *  Port #21 HIGH-1 (tail section): a Windows abort kills the whole process
 *  TREE via a Job Object, not just what `taskkill /T` can walk to, and the
 *  runner promise settles inside ABORT_GRACE_MS even when an orphan holds a
 *  pipe end. Port #21 MED (last real-spawn test): an abort that lands after
 *  the LAUNCHER exited, while a child it left behind still holds stdout, still
 *  kills that child and settles. Those tests spawn real msys `sleep` children
 *  on purpose. */

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
  PROBE_TIMEOUT_MS,
  ABORT_GRACE_MS,
  ABORT_TRUNCATED_MARKER,
  bunRunner,
  abortShape,
  type SpawnRunner,
  type RawResult,
} from "../../src/core/executor.ts";
import { overrideWinJobs, winJobsAvailable } from "../../src/core/win-job.ts";
import { groupSpawnOptions, killGroup } from "../../src/core/proc-group.ts";
import { bashTool } from "../../src/coding/hashline.ts";
import type { PermissionDecision } from "../../src/core/types.ts";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

afterEach(() => resetExecutor());

/** Test-local copy of the canonical Git-bash path (deliberately NOT imported:
 *  mutating the module's constant to a nonexistent path makes bashBin() fall
 *  back to "bash" and must MISMATCH this). */
const GIT_BASH = "C:/Program Files/Git/bin/bash.exe";
const CANON_BASH = process.platform === "win32" && existsSync(GIT_BASH) ? GIT_BASH : "bash";

// ---------- fakes ----------

interface Call { argv: string[]; opts: { cwd?: string; signal?: AbortSignal } }
function fakeRunner(script: (argv: readonly string[]) => RawResult): { runner: SpawnRunner; calls: Call[] } {
  const calls: Call[] = [];
  const runner: SpawnRunner = (argv, opts) => {
    calls.push({ argv: [...argv], opts });
    return Promise.resolve(script(argv));
  };
  return { runner, calls };
}
const ok = (stdout = ""): RawResult => ({ code: 0, stdout, stderr: "" });
const fail = (code: number, stderr: string): RawResult => ({ code, stdout: "", stderr });
/** wsl/docker probes are trial spawns of `… bash -c true` through the wrapper. */
const isProbe = (argv: readonly string[]) => argv.at(-3) === "bash" && argv.at(-2) === "-c" && argv.at(-1) === "true";
/** probe calls succeed, executed commands run `exec` */
const probeOkThen = (exec: (argv: readonly string[]) => RawResult) =>
  fakeRunner((argv) => (isProbe(argv) ? ok() : exec(argv)));

// ---------- ladder + rung selection ----------

test("ladder is direct → wsl → docker", () => {
  expect([...RUNGS]).toEqual(["direct", "wsl", "docker"]);
});

test("rung selection: the requested rung is the returned rung, never substituted", async () => {
  const { runner } = fakeRunner(() => ok());
  for (const rung of RUNGS) {
    const ex = await createExecutor(rung, { runner, platform: "win32" });
    expect(ex.rung).toBe(rung);
  }
});

// ---------- probes (G1/G2: trial spawns THROUGH the wrapper; G3: bounded) ----------

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

test("wsl probe is ONE trial spawn through the wrapper, with a deadline signal (G1/G3)", async () => {
  const { runner, calls } = fakeRunner(() => ok());
  const p = await probeRung("wsl", runner, "win32");
  expect(p.available).toBe(true);
  expect(calls.length).toBe(1);
  expect(calls[0]!.argv).toEqual(["wsl.exe", "--exec", "bash", "-c", "true"]); // bwrap.rs:74 shape
  expect(calls[0]!.opts.signal).toBeInstanceOf(AbortSignal);
});

test("wsl probe: subsystem installed but default distro has no bash → UNAVAILABLE (G1 regression)", async () => {
  // The reference machine's real shape: `wsl.exe --status` exits 0 (docker-desktop
  // distro installed) while every command THROUGH the wrapper exits 1. A --status
  // probe says available and then bashTool fails forever; the trial spawn may not.
  const { runner, calls } = fakeRunner((argv) =>
    argv.includes("--status")
      ? ok("Default Distribution: docker-desktop")
      : fail(1, "<3>WSL (11 - Relay) ERROR: CreateProcessCommon:818: execvpe(bash) failed: No such file or directory"));
  const p = await probeRung("wsl", runner, "win32");
  expect(p.available).toBe(false);
  expect(p.detail).toContain("exited 1");
  expect(p.detail).toContain("execvpe(bash) failed");
  expect(calls.some((c) => c.argv.includes("--status"))).toBe(false); // --status is never consulted
});

test("wsl probe failure detail strips UTF-16LE NULs", async () => {
  const { runner } = fakeRunner(() => fail(1, "W\u0000S\u0000L\u0000 relay error"));
  const p = await probeRung("wsl", runner, "win32");
  expect(p.available).toBe(false);
  expect(p.detail).toContain("WSL relay error");
});

test("docker probe is a trial container run proving daemon+image+bash, not `docker version` (G2)", async () => {
  const { runner, calls } = fakeRunner(() => ok());
  const p = await probeRung("docker", runner, "linux");
  expect(p.available).toBe(true);
  expect(calls[0]!.argv).toEqual(["docker", "run", "--rm", DEFAULT_DOCKER_IMAGE, "bash", "-c", "true"]);
  expect(calls[0]!.opts.signal).toBeInstanceOf(AbortSignal);
  // the trial proves THE image commands will later use
  const custom = fakeRunner(() => ok());
  await probeRung("docker", custom.runner, "linux", { dockerImage: "rovecode/dev:1" });
  expect(custom.calls[0]!.argv).toEqual(["docker", "run", "--rm", "rovecode/dev:1", "bash", "-c", "true"]);
});

test("docker probe: daemon up but image lacks bash → UNAVAILABLE (G2 regression)", async () => {
  const { runner } = fakeRunner((argv) =>
    argv[1] === "version" ? ok("25.0.0") : fail(127, 'exec: "bash": executable file not found in $PATH'));
  const p = await probeRung("docker", runner, "linux");
  expect(p.available).toBe(false);
  expect(p.detail).toContain("executable file not found");
});

test("docker probe: daemon-down and missing-CLI are both unavailable with detail", async () => {
  const daemonDown = fakeRunner(() => fail(1, "Cannot connect to the Docker daemon"));
  const p1 = await probeRung("docker", daemonDown.runner, "linux");
  expect(p1.available).toBe(false);
  expect(p1.detail).toContain("Cannot connect to the Docker daemon");

  const noCli = fakeRunner(() => fail(-1, "spawn failed: ENOENT"));
  const p2 = await probeRung("docker", noCli.runner, "darwin");
  expect(p2.available).toBe(false);
  expect(p2.detail).toContain("ENOENT");
});

test("probes are bounded: a hung wrapper times out → unavailable with a clear detail (G3)", async () => {
  // The never-settling runner has NO OS handle, so nothing else refs the event
  // loop — exactly the shape under which Bun's unref'd AbortSignal.timeout
  // timer never fires. An implementation that races the signal's own 'abort'
  // event instead of a ref'd setTimeout hangs HERE, forever (the original
  // executor.test.ts hang).
  const never: SpawnRunner = () => new Promise<RawResult>(() => {});
  const t0 = Date.now();
  const w = await probeRung("wsl", never, "win32", { timeoutMs: 30 });
  const d = await probeRung("docker", never, "linux", { timeoutMs: 30 });
  expect(Date.now() - t0).toBeLessThan(2_000); // returned at the deadline, not never
  expect(w.available).toBe(false);
  expect(w.detail).toContain("timed out after 30ms");
  expect(d.available).toBe(false);
  expect(d.detail).toContain("timed out after 30ms");
});

test("probe deadline pinned at 500ms — upstream's own bwrap cap (bwrap.rs:36,67); timeout ⇒ unavailable, never a hang", () => {
  expect(PROBE_TIMEOUT_MS).toBe(500);
});

test("bunRunner: a missing binary becomes code -1 + stderr, not a crash", async () => {
  const r = await bunRunner(["definitely-not-a-real-binary-p10-xyz"], {});
  expect(r.code).toBe(-1);
  expect(r.stderr).toContain("spawn failed");
});

test("bunRunner forwards the AbortSignal to the OS process: pre-aborted → nothing runs (G4)", async () => {
  const c = new AbortController();
  c.abort();
  const r = await bunRunner([CANON_BASH, "-c", "echo ran-anyway"], { signal: c.signal });
  expect(r.code).not.toBe(0); // killed at spawn (measured exit 143 in 9ms); dropping `signal:` runs it → code 0
  expect(r.stdout).not.toContain("ran-anyway");
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

test("failed configure poisons the seam: getExecutor() throws for the desired rung, no silent direct (G7)", async () => {
  expect(getExecutor().rung).toBe("direct"); // default before any configure
  const { runner } = fakeRunner(() => fail(1, "no wsl here"));
  let thrown: unknown;
  try {
    await configureExecutor("wsl", { runner, platform: "win32" });
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeInstanceOf(RungUnavailableError);
  // the DESIRED rung is recorded: the seam refuses to hand out anything else
  let got: unknown;
  try {
    getExecutor();
  } catch (e) {
    got = e;
  }
  expect(got).toBeInstanceOf(RungUnavailableError);
  expect((got as RungUnavailableError).rung).toBe("wsl");
  expect((got as RungUnavailableError).message).toContain("no wsl here"); // carries the configure failure
  // a later successful configure clears the fault; reset restores the default
  const good = fakeRunner(() => ok());
  await configureExecutor("wsl", { runner: good.runner, platform: "win32" });
  expect(getExecutor().rung).toBe("wsl");
  resetExecutor();
  expect(getExecutor().rung).toBe("direct");
});

test("a previously installed rung does not mask a failed configure (G7)", async () => {
  const good = fakeRunner(() => ok());
  await configureExecutor("wsl", { runner: good.runner, platform: "win32" });
  expect(getExecutor().rung).toBe("wsl");
  const bad = fakeRunner(() => fail(1, "daemon down"));
  try {
    await configureExecutor("docker", { runner: bad.runner, platform: "linux" });
  } catch { /* expected */ }
  expect(() => getExecutor()).toThrow(RungUnavailableError); // NOT the stale wsl executor
});

test("configureExecutor installs the probed rung behind the seam", async () => {
  const { runner } = fakeRunner(() => ok());
  const ex = await configureExecutor("wsl", { runner, platform: "win32" });
  expect(ex.rung).toBe("wsl");
  expect(getExecutor().rung).toBe("wsl");
  resetExecutor();
  expect(getExecutor().rung).toBe("direct");
});

// ---------- rung command construction + forwarding ----------

test("wsl rung wraps through wsl.exe: --cd <cwd> --exec bash -c <cmd>", async () => {
  const { runner, calls } = probeOkThen(() => ok("hi\n"));
  const ex = await createExecutor("wsl", { runner, platform: "win32" });
  const r = await ex.run('echo "a b"', "D:\\ws", new AbortController().signal);
  expect(calls[1]!.argv).toEqual(["wsl.exe", "--cd", "D:\\ws", "--exec", "bash", "-c", 'echo "a b"']);
  expect(r).toEqual({ code: 0, text: "hi\n" });
});

test("docker rung runs the container against the mounted workspace", async () => {
  const { runner, calls } = probeOkThen(() => ok("out"));
  const ex = await createExecutor("docker", { runner, platform: "linux" });
  const r = await ex.run("ls -la", "/repo");
  expect(calls[1]!.argv).toEqual([
    "docker", "run", "--rm", "-v", "/repo:/workspace", "-w", "/workspace", DEFAULT_DOCKER_IMAGE, "bash", "-c", "ls -la",
  ]);
  expect(r).toEqual({ code: 0, text: "out" });

  const custom = probeOkThen(() => ok());
  const ex2 = await createExecutor("docker", { runner: custom.runner, dockerImage: "rovecode/dev:1", platform: "linux" });
  await ex2.run("pwd", "/repo");
  expect(custom.calls[1]!.argv[7]).toBe("rovecode/dev:1");
});

test("every rung forwards the caller's signal and cwd to the runner BY IDENTITY (G4)", async () => {
  const sig = new AbortController().signal;
  const d = fakeRunner(() => ok());
  const dex = await createExecutor("direct", { runner: d.runner });
  await dex.run("echo x", "D:\\ws", sig);
  expect(d.calls[0]!.opts.signal).toBe(sig); // deleting `signal:` in the rung fails this
  expect(d.calls[0]!.opts.cwd).toBe("D:\\ws");

  const w = probeOkThen(() => ok());
  const wex = await createExecutor("wsl", { runner: w.runner, platform: "win32" });
  await wex.run("echo x", "D:\\ws", sig);
  expect(w.calls[0]!.opts.signal).not.toBe(sig); // probe uses its own deadline signal
  expect(w.calls[1]!.opts.signal).toBe(sig);
  expect(w.calls[1]!.opts.cwd).toBe("D:\\ws");

  const k = probeOkThen(() => ok());
  const kex = await createExecutor("docker", { runner: k.runner, platform: "linux" });
  await kex.run("echo x", "/repo", sig);
  expect(k.calls[1]!.opts.signal).toBe(sig);
  expect(k.calls[1]!.opts.cwd).toBe("/repo");
});

test("direct rung prefers Git bash on Windows: argv[0] pinned to the canonical path (G6)", async () => {
  const { runner, calls } = fakeRunner(() => ok());
  const ex = await createExecutor("direct", { runner });
  await ex.run("echo x", "D:\\ws");
  // CANON_BASH is this file's OWN copy of the path: pointing the module's
  // constant at a nonexistent path falls back to "bash" and mismatches here.
  expect(calls[0]!.argv[0]).toBe(CANON_BASH);
  expect(calls[0]!.argv.slice(1)).toEqual(["-c", "echo x"]);
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
  expect(r2.text).toBe("x".repeat(10_000)); // constant pinned by content, not just length
});

// ---------- direct rung parity (real spawns; ABSOLUTE bytes, then bashTool) ----------

function makeCtx(cwd: string): { sessionId: string; cwd: string; signal: AbortSignal; permissions: PermissionDecision } {
  return { sessionId: "s", cwd, signal: new AbortController().signal, permissions: { effect: "allow" } };
}

test("direct rung parity: ABSOLUTE bytes pinned per case, and bashTool emits exit=<code>\\n<text> (G5)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-exec-"));
  writeFileSync(join(dir, "marker.txt"), "from-cwd");
  const ctx = makeCtx(dir);
  const ex = getExecutor(); // unconfigured seam = direct = today's behavior
  expect(ex.rung).toBe("direct");
  // expected bytes are written out LITERALLY (not derived from another run of
  // the same code): mutating the assembly or the 10_000 slice fails these
  const cases: [cmd: string, code: number, text: string][] = [
    ["echo hello", 0, "hello\n"],
    ["echo out; echo err 1>&2", 0, "out\n\nstderr:\nerr\n"],
    ["printf 'no-trailing-newline'", 0, "no-trailing-newline"],
    ["cat marker.txt", 0, "from-cwd"],                                          // cwd propagation
    ["exit 7", 7, ""],                                                          // deterministic failure (retry yields same bytes)
    ["for i in $(seq 1 1500); do echo abcdefgh; done", 0, "abcdefgh\n".repeat(1500).slice(0, 10_000)],
  ];
  expect("abcdefgh\n".repeat(1500).length).toBe(13_500); // the truncation case genuinely overflows 10k
  expect(cases[5]![2].length).toBe(10_000);
  for (const [command, code, text] of cases) {
    const viaSeam = await ex.run(command, ctx.cwd, ctx.signal);
    expect(viaSeam.code).toBe(code);
    expect(viaSeam.text).toBe(text);
    const viaTool = await bashTool.execute({ command }, ctx);
    expect(viaTool.output).toBe(`exit=${code}\n${text}`);
    expect(viaTool.ok).toBe(code === 0);
  }
  rmSync(dir, { recursive: true, force: true });
}, 30_000);

// G8 (tool-level spawn failure through the seam) is pinned in
// test/unit/hashline.test.ts, next to bashTool's other behavior tests.

// ---------- port #21 HIGH-1: a Windows abort kills the TREE, and the runner settles ----------
// Real spawns on purpose — the finding is about msys2 process topology. The
// long-lived child is msys `sleep` (Cygwin runtime: after its exec the forked
// stub is gone, so taskkill /T cannot reach it; a native child such as bun.exe
// stays reachable and would NOT discriminate the job object from taskkill),
// tagged with a unique fractional duration so Win32_Process can find it.
// Every wait is bounded by a REF'D timer race; every test kills its own
// survivors so a red run leaves no stray sleep.exe behind.

const isWin = process.platform === "win32";
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const sleepTag = () => "600." + String(Math.floor(Math.random() * 1e9)).padStart(9, "0");

/** pids of live processes named `name` carrying `tag` on their command line */
async function tagged(name: string, tag: string): Promise<number[]> {
  const ps = Bun.spawn(["powershell", "-NoProfile", "-Command",
    `(Get-CimInstance Win32_Process -Filter "Name='${name}' AND CommandLine LIKE '%${tag}%'").ProcessId`],
    { stdout: "pipe", stderr: "pipe" });
  const text = await new Response(ps.stdout).text();
  await ps.exited;
  return text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).map(Number);
}
/** live msys sleep.exe processes carrying `tag` */
const taggedSleeps = (tag: string) => tagged("sleep.exe", tag);
async function killTagged(tag: string): Promise<void> {
  for (const pid of await taggedSleeps(tag)) await Bun.spawn(["taskkill", "/F", "/PID", String(pid)], { stdout: "ignore", stderr: "ignore" }).exited;
}
/** Wait inside ONE powershell instead of spawning one per sample.
 *
 *  Every sample costs a powershell start: measured on this machine, 1.5–3.7 s each, on an idle machine.
 *  A JS poll loop around it therefore spent most of a test's 20 s budget asking the question rather than
 *  waiting for the answer, and under a full suite these tests timed out — not because a process refused
 *  to die, but because the instrument was slower than the thing it measured. The loop moves into the
 *  query: one start, then a sample every 100 ms until the condition holds or the deadline passes. The
 *  pids are printed either way, so a timeout still reports the survivors. */
async function awaitTagged(name: string, tag: string, ms: number, want: "appears" | "gone"): Promise<number[]> {
  const cond = want === "appears" ? "$p.Count -gt 0" : "$p.Count -eq 0";
  const script = [
    `$deadline = (Get-Date).AddMilliseconds(${ms})`,
    "while ($true) {",
    `  $p = @((Get-CimInstance Win32_Process -Filter "Name='${name}' AND CommandLine LIKE '%${tag}%'").ProcessId)`,
    `  if (${cond}) { $p -join ' '; exit 0 }`,
    "  if ((Get-Date) -ge $deadline) { $p -join ' '; exit 1 }",
    "  Start-Sleep -Milliseconds 100",
    "}",
  ].join("\n");
  const ps = Bun.spawn(["powershell", "-NoProfile", "-Command", script], { stdout: "pipe", stderr: "pipe" });
  const text = await new Response(ps.stdout).text();
  await ps.exited;
  return text.split(/\s+/).map((x) => x.trim()).filter(Boolean).map(Number);
}
/** the pids still alive after waiting (≤ms) for every tagged sleep to go */
const survivors = (tag: string, ms: number) => awaitTagged("sleep.exe", tag, ms, "gone");
/** the child must be RUNNING before the abort — a kill landing before the fork would pass vacuously */
async function untilRunning(tag: string): Promise<void> {
  expect((await awaitTagged("sleep.exe", tag, 8000, "appears")).length).toBeGreaterThan(0);
}
const DEADLINE = Symbol("deadline");
async function within<T>(p: Promise<T>, ms: number): Promise<T | typeof DEADLINE> {
  let t: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<typeof DEADLINE>((r) => { t = setTimeout(() => r(DEADLINE), ms); })]);
  } finally {
    clearTimeout(t);
  }
}

const treeShapes: [shape: string, mk: (hold: string, dir: string) => string][] = [
  ["compound+redirect", (hold, dir) => `echo x > "${dir}/f1"; ${hold}; echo y > "${dir}/f2"`],
  ["nested bash -c", (hold) => `bash -c '${hold}'`],
  ["background &+wait", (hold) => `${hold} & ${hold} & wait`],
];
for (const [shape, mk] of treeShapes) {
  test.skipIf(!isWin)(`Windows abort kills the whole tree (${shape}): the msys sleep is gone ≤3s, the runner settled ≤1s, nothing truncated`, async () => {
    const tag = sleepTag();
    const dir = mkdtempSync(join(tmpdir(), "rovecode-tree-"));
    try {
      const ac = new AbortController();
      const run = bunRunner([CANON_BASH, "-c", mk(`sleep ${tag}`, dir.replace(/\\/g, "/"))], { cwd: dir, signal: ac.signal });
      await untilRunning(tag);
      const tAbort = Date.now();
      ac.abort();
      const r = await within(run, 3000);
      if (r === DEADLINE) throw new Error("runner did not settle within 3s of abort");
      expect(Date.now() - tAbort).toBeLessThan(1000);
      expect(r.treeKill).toBe("job");
      expect(r.code).toBe(143);
      // the pipes closed because EVERY holder died. Mutations: skip
      // AssignProcessToJobObject or TerminateJobObject → the orphaned sleep
      // keeps stdout open past the grace → the marker appears AND it survives
      expect(r.stderr).not.toContain(ABORT_TRUNCATED_MARKER);
      expect(await survivors(tag, 3000)).toEqual([]);
    } finally {
      await killTagged(tag);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 40_000);
}

test.skipIf(!isWin)("fail-safe without job objects: the abort still SETTLES inside the grace — bytes so far + truncation marker, code 143, treeKill taskkill-only", async () => {
  expect(winJobsAvailable()).toBe(true); // the seam below is the ONLY reason the job is missing here
  overrideWinJobs(false);
  const tag = sleepTag();
  try {
    const ac = new AbortController();
    const run = bunRunner([CANON_BASH, "-c", `echo first; sleep ${tag}; echo never`], { signal: ac.signal });
    await untilRunning(tag);
    const tAbort = Date.now();
    ac.abort();
    // taskkill /T /F kills bash + its stub; the sleep (dead parent) survives and
    // holds stdout — the shape that hung the runner forever before the bounded read
    const r = await within(run, 3000);
    if (r === DEADLINE) throw new Error("runner did not settle within 3s of abort: an unbounded read waits for the orphan to release stdout");
    expect(Date.now() - tAbort).toBeLessThan(ABORT_GRACE_MS + 1000);
    expect(r.treeKill).toBe("taskkill-only");
    expect(r.code).toBe(143);
    expect(r.stdout).toBe("first\n"); // collected before the kill, kept
    expect(r.stderr).toContain(ABORT_TRUNCATED_MARKER);
  } finally {
    overrideWinJobs(null);
    await killTagged(tag); // the orphan the fallback cannot reach — the very leak the job object closes
  }
}, 40_000);

test.skipIf(!isWin)("a command that completes on its own keeps a child it deliberately left behind: the job is released, not killed, at a normal settle", async () => {
  const tag = sleepTag();
  try {
    const r = await within(bunRunner([CANON_BASH, "-c", `sleep ${tag} > /dev/null 2>&1 & echo started`], { signal: new AbortController().signal }), 5000);
    if (r === DEADLINE) throw new Error("runner did not settle: the backgrounded child kept a pipe end open");
    expect(r).toMatchObject({ code: 0, stdout: "started\n", treeKill: "job" });
    await wait(300);
    expect((await taggedSleeps(tag)).length).toBe(1); // KILL_ON_JOB_CLOSE cleared before CloseHandle (mutation: close without clearing → 0)
  } finally {
    await killTagged(tag);
  }
}, 40_000);

test.skipIf(!isWin)("Windows abort AFTER the launcher exited (`sleep N & echo started`, the child still holds stdout): the job kill reaches the child, the runner settles ≤1s with code 143, the daemon is gone ≤3s", async () => {
  const tag = sleepTag();
  try {
    const ac = new AbortController();
    const run = bunRunner([CANON_BASH, "-c", `sleep ${tag} & echo started`], { signal: ac.signal });
    await untilRunning(tag);
    // the launcher (`bash -c "sleep <tag> & …"`: its -c string carries the tag, as does
    // its fork stub) must be GONE before the abort — while it lives this is the tree
    // case above, and the mutation below would pass vacuously
    expect(await awaitTagged("bash.exe", tag, 8000, "gone")).toEqual([]);
    const tAbort = Date.now();
    ac.abort();
    // MUTATION: `if (proc.exitCode !== null) return;` at the top of onAbort → the abort is
    // ignored (no job terminate, no grace timer): the runner promise, both pipe readers and
    // the still-armed job handle wait on the daemon's stdout end for its whole 600 s, and
    // the daemon the user pressed Esc on keeps running
    const r = await within(run, 1000);
    if (r === DEADLINE) throw new Error("runner did not settle within 1s of abort: a dead launcher turned the abort into a no-op while its child held stdout");
    expect(Date.now() - tAbort).toBeLessThan(1000);
    expect(r).toMatchObject({ code: 143, stdout: "started\n", treeKill: "job" });
    expect(r.stderr).not.toContain(ABORT_TRUNCATED_MARKER); // stdout closed because the job kill reached the child, not because the grace ran out
    expect(await survivors(tag, 3000)).toEqual([]);
  } finally {
    await killTagged(tag);
  }
}, 40_000);

test("abort grace pinned at 500ms (ref'd timer); truncation marker text pinned", () => {
  expect(ABORT_GRACE_MS).toBe(500);
  expect(ABORT_TRUNCATED_MARKER).toBe("[output truncated: process tree terminated on abort]");
});

// ---------- #67: the POSIX process-group half of tree-kill ----------
//
// The reference box is Windows-only. What can be pinned here is the DECISION and the spawn options —
// the two places a mistake would silently change behaviour on both platforms — plus the guarantee that
// nothing about the Windows path or an uncancellable run moved. The kill itself (a grandchild surviving
// SIGTERM to the launcher) is exercised where it can be: the harness this was ported from, on POSIX.

test("#67 abortShape: POSIX with a signal is grouped, win32 with a signal is a job-object tree kill, and NO signal is neither on either platform", () => {
  expect(abortShape("linux", true)).toEqual({ treeKill: false, grouped: true });
  expect(abortShape("darwin", true)).toEqual({ treeKill: false, grouped: true });
  expect(abortShape("win32", true)).toEqual({ treeKill: true, grouped: false });
  // an uncancellable run keeps the plain spawn it always had — the options object must not grow a
  // `detached` it never had, and Windows must not build a Job Object for a run nothing can abort
  expect(abortShape("linux", false)).toEqual({ treeKill: false, grouped: false });
  expect(abortShape("win32", false)).toEqual({ treeKill: false, grouped: false });
});

test("#67 groupSpawnOptions: adds `detached` on POSIX and NOTHING on win32, so the Windows spawn options stay byte-identical", () => {
  expect(groupSpawnOptions("linux")).toEqual({ detached: true });
  expect(groupSpawnOptions("darwin")).toEqual({ detached: true });
  expect(groupSpawnOptions("win32")).toEqual({});
  // spread into a real options object: win32 must produce the same keys it did before #67
  const win = { cwd: "C:/p", stdout: "pipe", stderr: "pipe", ...groupSpawnOptions("win32") };
  expect(Object.keys(win).sort()).toEqual(["cwd", "stderr", "stdout"]);
});

test("#67 killGroup addresses the GROUP (-pid), reports failure instead of throwing, and refuses a pid it cannot use", () => {
  const calls: [number, string][] = [];
  expect(killGroup(4321, "SIGTERM", (pid, sig) => { calls.push([pid, sig as string]); })).toBe(true);
  expect(calls).toEqual([[-4321, "SIGTERM"]]); // the negative pid IS the feature — shell, grandchildren, `&` members
  // a group that is already gone (ESRCH) is not an error the caller can act on: false, then the
  // caller falls back to the launcher. Throwing here would abort a cleanup path mid-way.
  expect(killGroup(4321, "SIGKILL", () => { throw new Error("ESRCH"); })).toBe(false);
  expect(killGroup(0, "SIGTERM", () => { throw new Error("must not be called"); })).toBe(false);
  expect(killGroup(-1, "SIGTERM", () => { throw new Error("must not be called"); })).toBe(false);
});
