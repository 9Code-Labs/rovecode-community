/** POSIX process GROUPS: the two calls that make a spawned child killable as a tree on a platform that
 *  has no Job Object. Ported from the aion harness (port #67) together with the external lanes, which
 *  are the first thing here that spawns a process it does not itself wait on.
 *
 *  Why a module of its own. Windows already has one answer (core/win-job.ts: membership is recorded at
 *  CreateProcess time and TerminateJobObject reaches every descendant). POSIX has a different one, and
 *  it is only two lines — but both spawn sites need the SAME two lines or the platforms drift: a child
 *  spawned `detached` gets its own session and process group whose pgid equals its pid, and `kill(-pid)`
 *  then addresses shell, grandchildren and backgrounded `&` members alike. Measured in the harness this
 *  came from: without it, `sleep` inside a compound command, inside `bash -c` and behind `&` survived
 *  the kill 3/3 and held stdout open, so the runner hung waiting on a pipe nobody would ever close.
 *
 *  NOTE: rovecode's own executor (core/executor.ts) does NOT use these yet — its POSIX abort still hands
 *  the signal to Bun.spawn, which reaches the direct child only. That is the same leak, one seam over.
 *  It is deliberately not changed in the commit that lands the lanes: it is a behaviour change to the
 *  path every bash tool call takes, and it deserves its own commit and its own measurement. */

/** The extra spawn options that put a POSIX child in its own process group (`detached` → setsid, pgid =
 *  pid); EMPTY on win32, so Windows spawn options stay byte-identical to what they were. */
export function groupSpawnOptions(platform: NodeJS.Platform): { detached: true } | Record<never, never> {
  return platform === "win32" ? {} : { detached: true };
}

/** `kill(pid, signal)` — injectable so tests never signal a real process. */
export type KillFn = (pid: number, signal: NodeJS.Signals) => void;

const defaultKill: KillFn = (pid, signal) => { process.kill(pid, signal); };

/** Signal the child's whole process group (pgid = pid under a detached spawn): `kill(-pid, signal)`.
 *  Best effort — false when the group is already gone (ESRCH) or the pid is not usable; the caller then
 *  falls back to signalling the launcher itself. Never called on win32: there are no process groups
 *  there, and the Job Object is the tree. */
export function killGroup(pid: number, signal: NodeJS.Signals, kill: KillFn = defaultKill): boolean {
  if (!(pid > 0)) return false;
  try { kill(-pid, signal); return true; } catch { return false; }
}

/** The parts of a Bun subprocess the lane runner touches. Structural on purpose: the production spawn is
 *  `Bun.spawn`, a test's is an object literal, and neither needs to name Bun's type. */
export interface SpawnedProc {
  readonly pid: number;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  /** null while the child is still running — the lane runner reads it to tell "exited 0" from "not done" */
  readonly exitCode: number | null;
  kill(signal?: NodeJS.Signals | number): void;
}
