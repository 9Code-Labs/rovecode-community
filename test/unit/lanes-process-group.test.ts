/** PORT #67 fix (critic MED) — the lanes streaming twin (src/lanes/process.ts makeLaneSpawn) pinned
 *  BEHAVIOURALLY under an injected platform with a fake spawn, the way spawn-runner-group.test.ts pins
 *  makeRunner: the box is Windows, so the POSIX branch can only be reached this way, and the pre-fix static
 *  `indexOf` pin let `// killGroup(...)` and a killGroup moved into the win32 branch both pass. Pins (each
 *  names its mutation target):
 *  - linux: the spawn options carry `detached: true` (argv, scrubbed env and stdin pinned too); kill() sends
 *    `kill(-pid, "SIGTERM")` — the GROUP — FIRST, then `proc.kill("SIGTERM")` on the CLI; exited → 143; no
 *    Job Object — mutation: comment the killGroup call out / move it into the win32 branch / swap the order /
 *    drop the groupSpawnOptions spread
 *  - linux, group already gone (kill throws ESRCH): the CLI fallback still runs; kill() is idempotent
 *  - linux interrupt(): SIGINT to the CLI pid ONLY (the live-verified claude/opencode contract) — never a
 *    group signal; false once the CLI has exited
 *  - WIN32 BYTE-IDENTICAL: the five pre-#67 option keys, no `detached`; Job Object assign → kill() terminate →
 *    `taskkill /T /F` sweep through the SAME spawn seam; NO process.kill and NO proc.kill anywhere;
 *    interrupt() false without a signal; a normal exit release()s the job; a null job or a failed assign →
 *    taskkill-only; no sweep for a pid that already exited
 *  The real-process pins (bunLaneSpawn = makeLaneSpawn() with no deps) stay in lanes-process.test.ts. */

import { test, expect } from "bun:test";
import type { SpawnedProc } from "../../src/core/proc-group.ts";
import type { WinJob } from "../../src/core/win-job.ts";
import { makeLaneSpawn, type LaneSpawn, type LaneSpawnOptions } from "../../src/lanes/process.ts";
import type { LaneCommand } from "../../src/lanes/types.ts";

const DEADLINE = Symbol("deadline");
/** every await is bounded by a REF'D timer race (Bun's test timeout needs a woken loop) */
async function within<T>(p: Promise<T>, ms: number): Promise<T | typeof DEADLINE> {
  let t: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<typeof DEADLINE>((r) => { t = setTimeout(() => r(DEADLINE), ms); })]);
  } finally { clearTimeout(t); }
}
const settled = async <T>(p: Promise<T>, ms = 3_000): Promise<T> => {
  const r = await within(p, ms);
  if (r === DEADLINE) throw new Error(`did not settle within ${ms}ms`);
  return r;
};

interface Fake { proc: SpawnedProc; write(s: string): void; writeErr(s: string): void; exit(code: number): void }
/** a CLI whose streams and exit the test drives; every kill lands in `log` as `pid:<signal>` */
function fakeProc(pid: number, log: string[]): Fake {
  const enc = new TextEncoder();
  let outCtl!: ReadableStreamDefaultController<Uint8Array>, errCtl!: ReadableStreamDefaultController<Uint8Array>;
  const stdout = new ReadableStream<Uint8Array>({ start(c) { outCtl = c; } });
  const stderr = new ReadableStream<Uint8Array>({ start(c) { errCtl = c; } });
  let resolveExit!: (code: number) => void;
  const exited = new Promise<number>((r) => { resolveExit = r; });
  let exitCode: number | null = null;
  const proc: SpawnedProc = {
    pid, stdout, stderr, exited,
    get exitCode() { return exitCode; },
    kill(signal) { log.push(`pid:${String(signal ?? "SIGTERM")}`); },
  };
  return {
    proc,
    write: (s) => outCtl.enqueue(enc.encode(s)),
    writeErr: (s) => errCtl.enqueue(enc.encode(s)),
    exit: (code) => { exitCode = code; outCtl.close(); errCtl.close(); resolveExit(code); },
  };
}

interface Harness { log: string[]; spawns: { argv: string[]; options: LaneSpawnOptions }[]; fake: Fake; jobs: number; spawn: LaneSpawn }
/** `opts.log` shares ONE array between the kill log and a fake job so the order across both is pinned */
function harness(platform: NodeJS.Platform, pid = 4242, opts: { killThrows?: boolean; job?: WinJob | null; log?: string[] } = {}): Harness {
  const log: string[] = opts.log ?? [];
  const fake = fakeProc(pid, log);
  const h = { log, spawns: [] as Harness["spawns"], fake, jobs: 0 };
  const spawn = makeLaneSpawn({
    platform,
    spawn: (argv, options) => { h.spawns.push({ argv, options }); return fake.proc; },
    kill: (p, sig) => { log.push(`kill:${p}:${sig}`); if (opts.killThrows) throw new Error("ESRCH"); },
    createJob: () => { h.jobs++; return opts.job === undefined ? null : opts.job; },
  });
  return Object.assign(h, { spawn }); // the SAME object the closures mutate (a spread would freeze `jobs` at 0)
}
const fakeJob = (log: string[], assignOk = true): WinJob => ({
  assign(pid) { log.push(`assign:${pid}`); return assignOk; },
  terminate() { log.push("terminate"); },
  release() { log.push("release"); },
});
const CMD: LaneCommand = { bin: "claude", args: ["-p", "hi", "--output-format", "stream-json"], cwd: "/work", env: { LANE_PROBE_EXTRA: "1" } };
const collect = async (it: AsyncIterable<string>): Promise<string[]> => { const out: string[] = []; for await (const l of it) out.push(l); return out; };
const signalled = (log: string[]): boolean => log.some((l) => l.startsWith("kill:") || l.startsWith("pid:"));

// ---------- the POSIX branch (platform injected) ----------

test("linux: the CLI is spawned detached (own process group) with the scrubbed env and stdin 'ignore'; kill() → kill(-pid, SIGTERM) on the GROUP first, then proc.kill(SIGTERM) on the CLI; 143; idempotent; no Job Object", async () => {
  const h = harness("linux", 4242);
  const had = process.env["CLAUDECODE"];
  process.env["CLAUDECODE"] = "1"; // the host session's marker must not reach the lane (laneChildEnv)
  const p = (() => { try { return h.spawn(CMD); } finally { if (had === undefined) delete process.env["CLAUDECODE"]; else process.env["CLAUDECODE"] = had; } })();
  expect(p.pid).toBe(4242);
  expect(h.spawns).toHaveLength(1);
  expect(h.spawns[0]!.argv).toEqual(["claude", "-p", "hi", "--output-format", "stream-json"]);
  const o = h.spawns[0]!.options;
  // MUTATION TARGET: drop the groupSpawnOptions spread (or spread it on win32 only) → no `detached` key
  expect(Object.keys(o)).toEqual(["cwd", "env", "stdin", "stdout", "stderr", "detached"]);
  expect(o.detached).toBe(true);
  expect({ ...o, env: undefined }).toEqual({ cwd: "/work", env: undefined, stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true });
  expect(o.env!["LANE_PROBE_EXTRA"]).toBe("1"); // cmd.env applied …
  expect("CLAUDECODE" in o.env!).toBe(false); // … over the scrubbed parent env
  expect(h.jobs).toBe(0); // no Job Object off Windows
  const lines = collect(p.lines());
  h.fake.write("partial\n");
  p.kill();
  // MUTATION TARGETS: `// killGroup(...)` or killGroup moved into the win32 branch → no "kill:-4242:SIGTERM";
  // swapping the two calls flips the order; killing the pid instead of the group → "kill:4242:SIGTERM"
  expect(h.log).toEqual(["kill:-4242:SIGTERM", "pid:SIGTERM"]);
  p.kill(); // idempotent: nothing is signalled twice
  expect(h.log).toEqual(["kill:-4242:SIGTERM", "pid:SIGTERM"]);
  h.fake.writeErr("terminated\n");
  h.fake.exit(0); // whatever the CLI reports on the TERM: killed → 143
  expect(await settled(p.exited)).toBe(143);
  expect(await settled(lines)).toEqual(["partial"]);
  expect(p.stderrTail()).toBe("terminated");
});

test("linux stdin travels as a Blob; the group already gone (kill throws ESRCH) still runs the CLI fallback and settles 143", async () => {
  const h = harness("linux", 77, { killThrows: true });
  const p = h.spawn({ ...CMD, stdin: "the prompt" });
  const o = h.spawns[0]!.options;
  expect(o.stdin).toBeInstanceOf(Blob);
  expect(await (o.stdin as Blob).text()).toBe("the prompt");
  expect(o.detached).toBe(true);
  p.kill();
  expect(h.log).toEqual(["kill:-77:SIGTERM", "pid:SIGTERM"]); // the throw is swallowed, the fallback is not skipped
  h.fake.exit(1);
  expect(await settled(p.exited)).toBe(143);
});

test("linux interrupt(): SIGINT to the CLI pid ONLY (claude/opencode finish the turn on it) — never a group signal; false once the CLI exited; a plain exit keeps its code", async () => {
  const h = harness("linux", 31);
  const p = h.spawn(CMD);
  expect(p.interrupt()).toBe(true);
  // MUTATION TARGET: interrupt() routed through killGroup, or made unconditionally false off win32
  expect(h.log).toEqual(["pid:SIGINT"]);
  h.fake.exit(130);
  expect(await settled(p.exited)).toBe(130); // not killed → the CLI's own code
  expect(p.interrupt()).toBe(false); // an exited CLI cannot be interrupted
  expect(h.log).toEqual(["pid:SIGINT"]);
  expect(h.jobs).toBe(0);
});

// ---------- Windows: byte-identical to the pre-#67 twin ----------

test("win32: the five pre-#67 option keys and no `detached`; Job Object assign → kill() terminate → taskkill sweep through the SAME spawn seam; NO process.kill / proc.kill; interrupt() false; 143", async () => {
  const log: string[] = []; // shared by the kill log and the fake job so the ORDER across both is pinned
  const h = harness("win32", 4242, { job: fakeJob(log), log });
  const p = h.spawn({ ...CMD, cwd: "C:/w" });
  expect(h.spawns).toHaveLength(1);
  // MUTATION TARGET: `detached` on win32 (spreading groupSpawnOptions unconditionally) adds a sixth key
  expect(Object.keys(h.spawns[0]!.options)).toEqual(["cwd", "env", "stdin", "stdout", "stderr"]);
  expect("detached" in h.spawns[0]!.options).toBe(false);
  expect({ ...h.spawns[0]!.options, env: undefined }).toEqual({ cwd: "C:/w", env: undefined, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  expect(h.jobs).toBe(1);
  expect(log).toEqual(["assign:4242"]);
  expect(p.interrupt()).toBe(false); // Bun's Windows kill() is TerminateProcess whatever the name: not deliverable
  expect(log).toEqual(["assign:4242"]);
  h.fake.write("x\n");
  p.kill();
  // MUTATION TARGET: killGroup moved out of the else-branch (or the else dropped) → a "kill:" entry here
  expect(log).toEqual(["assign:4242", "terminate"]);
  expect(h.spawns).toHaveLength(2);
  expect(h.spawns[1]).toEqual({ argv: ["taskkill", "/T", "/F", "/PID", "4242"], options: { stdout: "ignore", stderr: "ignore" } });
  h.fake.exit(1);
  expect(await settled(p.exited)).toBe(143);
  expect(log).toEqual(["assign:4242", "terminate", "terminate"]); // finally: terminate again (idempotent), never release
  expect(signalled(log)).toBe(false);
});

test("win32: a normal exit release()s the job; no job (createJob null) or a failed assign → taskkill-only, no terminate; a CLI that already exited gets no sweep", async () => {
  const log: string[] = [];
  const done = harness("win32", 10, { job: fakeJob(log), log });
  const p = done.spawn(CMD);
  done.fake.exit(0);
  expect(await settled(p.exited)).toBe(0);
  expect(log).toEqual(["assign:10", "release"]);
  expect(done.spawns).toHaveLength(1); // no sweep without a kill
  p.kill(); // after the exit: terminate on the released job (a no-op there), NO taskkill of a reusable pid
  expect(log).toEqual(["assign:10", "release", "terminate"]);
  expect(done.spawns).toHaveLength(1);
  expect(signalled(log)).toBe(false);

  const nojob = harness("win32", 9); // createJob → null (no bun:ffi / kernel32)
  const q = nojob.spawn(CMD);
  q.kill();
  expect(nojob.jobs).toBe(1);
  expect(nojob.spawns.map((s) => s.argv[0])).toEqual(["claude", "taskkill"]);
  expect(nojob.log).toEqual([]);
  nojob.fake.exit(1);
  expect(await settled(q.exited)).toBe(143);

  const bad: string[] = [];
  const unassigned = harness("win32", 11, { job: fakeJob(bad, false), log: bad });
  const r = unassigned.spawn(CMD);
  r.kill();
  expect(bad).toEqual(["assign:11"]); // the job is dropped: never terminated, never released
  expect(unassigned.spawns.map((s) => s.argv[0])).toEqual(["claude", "taskkill"]);
  unassigned.fake.exit(0);
  expect(await settled(r.exited)).toBe(143);
  expect(bad).toEqual(["assign:11"]);
});
