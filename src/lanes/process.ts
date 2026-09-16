/** Streaming child-process seam for external lanes (#47). The executor's bunRunner (core/executor.ts)
 *  buffers stdout until exit; a lane needs its JSONL LINE BY LINE while it runs, so this is the
 *  streaming twin riding the SAME kill path: on Windows the launcher goes into a Job Object right after
 *  spawn (core/win-job.ts, KILL_ON_JOB_CLOSE — a rovecode crash takes the tree with it), kill() is
 *  TerminateJobObject plus a `taskkill /T /F` sweep of a live pid, and a normal exit release()s the job
 *  (executor.ts:122-149 choreography); POSIX (#67) spawns the CLI `detached` (its own process group, via
 *  core/proc-group.ts groupSpawnOptions) and kill() is SIGTERM to the GROUP (killGroup, `-pid`) then to the
 *  CLI itself as the fallback — the same choreography as bunRunner's POSIX abort, so a CLI's own tool children
 *  die with it (not live-verified from the Windows box). interrupt() is SIGINT, the "finish the turn"
 *  signal claude/opencode honor — deliverable on POSIX only: Bun's Windows kill() is TerminateProcess
 *  whatever the signal name, so on win32 interrupt() reports false and the runner goes straight to the
 *  tree kill. Lines are bounded (MAX_LINE_BYTES; longer ones are cut) and the reader can be abandoned
 *  when an orphan outside the job keeps the pipe open (executor.ts ABORT_GRACE_MS idiom).
 *  `bunLaneSpawn` is `makeLaneSpawn()` over an injectable `LaneSpawnDeps` (platform, spawn, kill, createJob —
 *  makeRunner's RunnerDeps shape; production passes nothing), so the POSIX branch is pinned BEHAVIOURALLY
 *  under `platform: "linux"` with a fake spawn (test/unit/lanes-process-group.test.ts) while the real-process
 *  pins run the Windows branch. Runner tests inject a fake LaneProcess — never a real CLI. */

import { groupSpawnOptions, killGroup } from "../core/proc-group.ts";
import type { KillFn, SpawnedProc } from "../core/proc-group.ts";
import { createWinJob, type WinJob } from "../core/win-job.ts";
import type { LaneCommand } from "./types.ts";

export interface LaneProcess {
  pid: number;
  /** stdout as lines (newline stripped); ends at EOF or abandon() */
  lines(): AsyncIterable<string>;
  /** resolves with the exit code; 143 when killed */
  exited: Promise<number>;
  /** SIGINT-style "finish the turn": true when delivered, false when not deliverable here */
  interrupt(): boolean;
  /** tree kill (Job Object + taskkill sweep on win32; SIGTERM on POSIX); idempotent */
  kill(): void;
  /** drop our stdout end so lines() ends even if something still holds the pipe */
  abandon(): void;
  /** bounded stderr tail for failure reports */
  stderrTail(): string;
}

export type LaneSpawn = (cmd: LaneCommand) => LaneProcess;

export const MAX_LINE_BYTES = 1 << 20;
const STDERR_TAIL = 2_000;

/** A lane is a NEW top-level CLI session, never a child of the Claude Code session rovecode itself may be
 *  running in. When rovecode is launched from a Claude Code terminal the environment carries `CLAUDECODE=1`
 *  and the parent session's plumbing under `CLAUDE_CODE_*` — verified on 2026-09-03 (claude 2.1.257,
 *  Windows): 25 names including the session id, the host-session id, the host-managed-provider marker +
 *  the name of its auth env var, the messaging socket AND its token, and the child-session marker. A
 *  nested `claude -p` did start under them (no refusal observed), but a lane must never present itself as
 *  the parent session's child nor carry its credentials, so both patterns are dropped (case-insensitive:
 *  Windows env names are) before `cmd.env` is applied. The other CLIs ignore these names — unconditional.
 *  EXCEPT the claude CLI's own DOCUMENTED user knobs, which share the prefix but are the user's
 *  configuration, not the host session's — KEPT_ENV_EXACT is checked before the prefix rule (a lane the
 *  user authenticated the documented token way otherwise got the CLI's "Not logged in" with no hint).
 *  Each name verified 2026-09-03 against `claude --help` (2.1.257) or code.claude.com/docs:
 *    CLAUDE_CODE_OAUTH_TOKEN            docs/en/authentication — `claude setup-token`, the headless/CI login
 *                                       (precedence rank 5; `--bare` never reads it: key-only)
 *    CLAUDE_CODE_USE_BEDROCK / _USE_VERTEX / _USE_FOUNDRY
 *                                       docs/en/authentication — third-party-provider auth (rank 1)
 *    CLAUDE_CODE_SIMPLE                 `--help --bare`: "Sets CLAUDE_CODE_SIMPLE=1"
 *    CLAUDE_CODE_SAFE_MODE              `--help --safe-mode`: "Sets CLAUDE_CODE_SAFE_MODE=1"
 *    CLAUDE_CODE_MAX_OUTPUT_TOKENS      docs/en/env-vars
 *    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC   docs/en/env-vars
 *  None of the 24 names an enclosing session exported on this box is on the list (CLAUDE_CODE_OAUTH_SCOPES,
 *  _HOST_AUTH_ENV_VAR, _SESSION_ID, _MESSAGING_TOKEN, … are plumbing and stay dropped). */
export const SCRUBBED_ENV_EXACT: readonly string[] = ["CLAUDECODE"];
export const SCRUBBED_ENV_PREFIX = "CLAUDE_CODE_";
/** documented claude knobs under the scrubbed prefix — the user's, not the host session's; pass through */
export const KEPT_ENV_EXACT: readonly string[] = [
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_SIMPLE", "CLAUDE_CODE_SAFE_MODE",
  "CLAUDE_CODE_MAX_OUTPUT_TOKENS", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
];
export function laneChildEnv(parent: Record<string, string | undefined>, extra?: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parent)) {
    if (v === undefined) continue;
    const key = k.toUpperCase();
    if (!KEPT_ENV_EXACT.includes(key) && (SCRUBBED_ENV_EXACT.includes(key) || key.startsWith(SCRUBBED_ENV_PREFIX))) continue;
    out[k] = v;
  }
  return { ...out, ...(extra ?? {}) };
}

/** Split a byte stream into lines; a line over MAX_LINE_BYTES is cut (the rest is dropped). */
export async function* splitLines(reader: ReadableStreamDefaultReader<Uint8Array>): AsyncGenerator<string> {
  const dec = new TextDecoder();
  let buf = "", dropping = false;
  try {
    for (;;) {
      const c = await reader.read();
      if (c.done) break;
      buf += dec.decode(c.value, { stream: true });
      for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
        let line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (dropping) { dropping = false; continue; } // the tail of a line already cut below
        if (line.endsWith("\r")) line = line.slice(0, -1);
        yield line.length > MAX_LINE_BYTES ? line.slice(0, MAX_LINE_BYTES) : line;
      }
      if (buf.length > MAX_LINE_BYTES) { yield buf.slice(0, MAX_LINE_BYTES); buf = ""; dropping = true; }
    }
    buf += dec.decode();
    if (buf && !dropping) yield buf;
  } catch {
    /* cancelled reader (abandon) — end the stream */
  }
}

// ---------- #67: the injectable process seam (makeRunner's RunnerDeps, twinned) ----------

/** The options object handed to spawn — tests pin it byte-for-byte (the Windows shape must never gain a key). */
export interface LaneSpawnOptions {
  cwd?: string; env?: Record<string, string>; stdin?: Blob | "ignore";
  stdout: "pipe" | "ignore"; stderr: "pipe" | "ignore"; detached?: boolean;
}
export type LaneSpawnFn = (argv: string[], options: LaneSpawnOptions) => SpawnedProc;

export interface LaneSpawnDeps {
  /** defaults to process.platform — "win32" selects the Job Object path, anything else the group path */
  platform?: NodeJS.Platform;
  /** defaults to Bun.spawn (the CLI and the win32 taskkill sweep both go through it) */
  spawn?: LaneSpawnFn;
  /** defaults to process.kill (killGroup's own default) — `kill(-pid, signal)` addresses the group */
  kill?: KillFn;
  /** defaults to win-job.ts createWinJob (Windows only) */
  createJob?: () => WinJob | null;
}

const defaultSpawn: LaneSpawnFn = (argv, options) => Bun.spawn(argv, options) as unknown as SpawnedProc;

/** Build the lane seam over `deps` (production: none — `bunLaneSpawn` below); the choreography is the header's. */
export function makeLaneSpawn(deps: LaneSpawnDeps = {}): LaneSpawn {
  const platform = deps.platform ?? process.platform;
  const spawn = deps.spawn ?? defaultSpawn;
  const kill = deps.kill; // undefined → killGroup's default (process.kill)
  const createJob = deps.createJob ?? createWinJob;
  const win = platform === "win32";
  return (cmd) => {
    const proc = spawn([cmd.bin, ...cmd.args], {
      cwd: cmd.cwd,
      env: laneChildEnv(process.env, cmd.env),
      stdin: cmd.stdin !== undefined ? new Blob([cmd.stdin]) : "ignore",
      stdout: "pipe", stderr: "pipe",
      ...groupSpawnOptions(platform), // #67: POSIX `detached: true` (own process group); nothing on win32
    });
    let job: WinJob | null = win ? createJob() : null;
    if (job && !job.assign(proc.pid)) job = null; // fail-safe: taskkill-only, as bunRunner reports "taskkill-only"
    let killed = false, reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let err = "";
    void (async () => {
      const r = proc.stderr.getReader(), dec = new TextDecoder();
      for (let c = await r.read(); !c.done; c = await r.read()) err = (err + dec.decode(c.value, { stream: true })).slice(-STDERR_TAIL);
    })().catch(() => {});
    const exited = proc.exited.then((code) => (killed ? 143 : code)).finally(() => { if (killed) job?.terminate(); else job?.release(); });
    return {
      pid: proc.pid,
      exited,
      lines: () => splitLines((reader = proc.stdout.getReader())),
      interrupt() {
        if (win || proc.exitCode !== null) return false;
        try { proc.kill("SIGINT"); return true; } catch { return false; }
      },
      kill() {
        if (killed) return;
        killed = true;
        if (win) {
          job?.terminate();
          if (proc.exitCode === null) { try { spawn(["taskkill", "/T", "/F", "/PID", String(proc.pid)], { stdout: "ignore", stderr: "ignore" }); } catch { /* best-effort sweep */ } }
        } else {
          killGroup(proc.pid, "SIGTERM", kill); // #67: the whole group first (bunRunner's POSIX abort order) …
          try { proc.kill("SIGTERM"); } catch { /* already gone */ } // … then the CLI itself as the fallback
        }
      },
      abandon() { reader?.cancel().catch(() => {}); },
      stderrTail: () => err.trim(),
    };
  };
}

/** Default seam: the process's own platform, Bun.spawn, process.kill, the real Job Object. */
export const bunLaneSpawn: LaneSpawn = makeLaneSpawn();
