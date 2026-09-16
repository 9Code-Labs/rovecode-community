/** Executor sandbox ladder (PORT #10): ONE seam for shell execution with
 *  selectable rungs — `direct` | `wsl` | `docker`.
 *
 *  Pattern source: openai/codex, Apache-2.0, Copyright 2025 OpenAI (snapshot
 *  research/source_snapshots/openai-codex @ 379d50be). Ported at pattern
 *  level, no code copied:
 *  - tiered execution selected per platform: SandboxType +
 *    get_platform_sandbox(), codex-rs/sandboxing/src/manager.rs:37,62;
 *  - availability PROBED at runtime by a trial spawn THROUGH the wrapper
 *    itself — the probe argv is the rung's own run shape with `true` as the
 *    command, exactly as codex probes bubblewrap by running `bwrap … /bin/true`
 *    (codex-rs/sandboxing/src/bwrap.rs:74). Probing anything weaker lies:
 *    `wsl.exe --status` exits 0 on a machine whose default distro has no bash
 *    (e.g. docker-desktop), and `docker version` proves a daemon but not that
 *    the image exists or contains bash;
 *  - probes are TIME-BOUNDED at codex's own 500ms cap (bwrap.rs:36,67);
 *    a probe that cannot answer in time IS unavailable right now;
 *  - an explicitly requested but unprovidable tier is a HARD ERROR
 *    (SandboxTransformError::{SeatbeltUnavailable,…}, manager.rs:203-222,410).
 *  Deliberately NOT ported: codex's silent `unwrap_or(SandboxType::None)`
 *  degrade (manager.rs:305) — codex recovers via its approval layer
 *  (core/src/exec_policy.rs:753-771); rovecode has no compensator at this seam,
 *  so per the bar an unavailable rung is a loud RungUnavailableError and
 *  NEVER a silent fallback DOWN the ladder. The docker rung follows the
 *  OpenHands runtime-boundary shape (execute inside a container with the
 *  workspace mounted) — OpenHands is not snapshotted; provenance gap.
 *
 *  Honesty note (matches README): every rung is DELEGATION, not a native
 *  sandbox. `direct` is today's blocklist-only behavior; `wsl`/`docker`
 *  isolate only as well as the wrapped runtime does. */

import { existsSync } from "node:fs";
import { createWinJob, type WinJob } from "./win-job.ts";
import { groupSpawnOptions, killGroup } from "./proc-group.ts";

// ---------- Ladder ----------

export type Rung = "direct" | "wsl" | "docker";

/** Ladder order, weakest isolation first. Order is informational only —
 *  selection is always explicit, never walked automatically. */
export const RUNGS: readonly Rung[] = ["direct", "wsl", "docker"];

export interface ExecResult { code: number; text: string }

export interface Executor {
  readonly rung: Rung;
  /** Run `cmd` through bash in `cwd`. Result matches today's bashTool
   *  internals: exit code + stdout (+ stderr section), sliced to 10k chars.
   *  `observe` (port #55) streams the bytes and the pid while the command is still running — a
   *  background job's only way to be readable before it finishes. Omitted: nothing is installed. */
  run(cmd: string, cwd: string, signal?: AbortSignal, observe?: SpawnObserver): Promise<ExecResult>;
}

// ---------- Raw process running (injectable so tests cover probe paths) ----------

export interface RawResult {
  code: number; stdout: string; stderr: string;
  /** Windows runs with a signal: "job" (Job Object tree kill + taskkill sweep)
   *  or the fail-safe "taskkill-only" (no bun:ffi/kernel32, or not assignable) */
  treeKill?: "job" | "taskkill-only";
}

/** Taps on a running process (port #55). A foreground run needs neither: it awaits the whole result and
 *  reads the text once. A BACKGROUND job needs both — its output has to be readable while the command is
 *  still running, and its pid is what a `bash_kill` names. Optional everywhere, so a run that does not
 *  observe is byte-identical to what it was: no tap installed, no per-chunk work. */
export interface SpawnObserver {
  /** the launcher's pid, once, right after spawn */
  onSpawn?(pid: number): void;
  /** raw bytes as they arrive, per stream — decoding is the observer's business, not the runner's */
  onChunk?(stream: "stdout" | "stderr", bytes: Uint8Array): void;
}

export type SpawnRunner = (
  argv: readonly string[],
  opts: { cwd?: string; signal?: AbortSignal; observe?: SpawnObserver },
) => Promise<RawResult>;

/** Post-abort grace (port #21 HIGH-1b): the runner waits this long for pipes +
 *  exit, then settles with the bytes so far + ABORT_TRUNCATED_MARKER, code 143.
 *  Only a process outside the job can hold a pipe end past the kill (the
 *  taskkill-only fallback measured an msys `sleep` holding stdout — and the
 *  runner promise — for its whole duration). REF'D timer, deliberately: Bun's
 *  AbortSignal.timeout timers are not, and an idle loop never fires them. */
export const ABORT_GRACE_MS = 500;
export const ABORT_TRUNCATED_MARKER = "[output truncated: process tree terminated on abort]";

/** Incremental pipe reader: bytes so far are readable at any moment, and the
 *  read is cancellable (drops our end) when an orphan holds the other.
 *  Decodes like Response.text(): UTF-8, leading BOM stripped. */
function collect(stream: ReadableStream<Uint8Array>, tap?: (bytes: Uint8Array) => void): { done: Promise<void>; text(): string; cancel(): void } {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  const done = (async () => {
    for (let c = await reader.read(); !c.done; c = await reader.read()) if (c.value) { chunks.push(c.value); tap?.(c.value); }
  })().catch(() => {});
  return { done, text: () => new TextDecoder().decode(Buffer.concat(chunks)), cancel: () => { reader.cancel().catch(() => {}); } };
}

/** Default runner: Bun.spawn, stdout/stderr piped. A spawn failure (missing
 *  binary) is returned as code -1 with the message in stderr, so probes can
 *  report "not installed" instead of crashing.
 *  Windows abort = TREE kill (port #21). Bun's own signal handling
 *  TerminateProcess-es only the DIRECT child, and `taskkill /T` walks live
 *  parent links that msys2's exec breaks (win-job.ts) — measured with taskkill
 *  alone, the `sleep` inside `a; sleep N; b`, `bash -c 'sleep N'` and
 *  `sleep N & sleep N & wait` survived 3/3 and held stdout so the runner hung
 *  3/3. So on Windows the signal is NOT handed to Bun.spawn: the launcher goes
 *  into a Job Object right after spawn; abort fires TerminateJobObject (every
 *  descendant, connected or not) plus `taskkill /T /F` as a sweep; a box
 *  without job objects keeps taskkill alone and says so in `treeKill`.
 *  POSIX abort = GROUP kill (port #67, ported from the aion harness with the
 *  lanes). Bun's signal passthrough SIGTERMs the DIRECT child only: the shell
 *  never runs its next statement, but a forked grandchild (`sleep`/`npm` inside
 *  a compound command, anything behind `&`) is orphaned, finishes on its own and
 *  keeps stdout open while it does — which hung the runner, not just leaked the
 *  process. So the signal is kept from Bun.spawn here too; the child is spawned
 *  `detached` (its own session and process group, pgid = pid) and abort sends
 *  SIGTERM to `-pid` — shell, grandchildren and backgrounded members alike —
 *  then SIGTERM to the launcher as a fallback, then SIGKILL to the group if the
 *  grace expires with a pipe still held. A run WITHOUT a signal is spawned
 *  exactly as before on both platforms: nothing can cancel it, so nothing needs
 *  a group. HONESTY, unchanged from the note this replaces: the reference box is
 *  Windows-only, so the POSIX path is exercised here by its decision function
 *  and its spawn options, not by a killed grandchild. What is measured is the
 *  harness this came from; what is pinned here is that win32 options stay
 *  byte-identical and that a pre-aborted signal never spawns on either path. */
/** Which cancellation shape a spawn gets. Exported because it is the only part of the POSIX path a
 *  Windows box can pin: `grouped` decides both the spawn options and the abort order, and a run with no
 *  signal must come out false on BOTH platforms — an uncancellable run keeps the plain spawn it always had. */
export function abortShape(platform: NodeJS.Platform, hasSignal: boolean): { treeKill: boolean; grouped: boolean } {
  if (!hasSignal) return { treeKill: false, grouped: false };
  return platform === "win32" ? { treeKill: true, grouped: false } : { treeKill: false, grouped: true };
}

export const bunRunner: SpawnRunner = async (argv, opts) => {
  const signal = opts.signal;
  const { treeKill, grouped } = abortShape(process.platform, signal !== undefined);
  // pre-aborted (G4 pin): never spawn at all — a kill would race a fast
  // command and lose; 143 matches the killed-at-spawn shape the pin measured.
  // #67 extends this to POSIX: a listener added to an ALREADY-aborted signal
  // never fires, so a spawn there would run to completion uncancelled — the
  // one case where "we handed it the signal" and "it can be stopped" differ.
  if ((treeKill || grouped) && signal?.aborted) return { code: 143, stdout: "", stderr: "aborted before spawn" };
  let onAbort: (() => void) | undefined;
  let job: WinJob | null = null;
  let killed = false;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const proc = Bun.spawn([...argv], {
      cwd: opts.cwd,
      signal: (treeKill || grouped) ? undefined : signal,
      stdout: "pipe", stderr: "pipe",
      // #67: `detached: true` on POSIX when there is something to cancel; EMPTY on win32 and empty for an
      // uncancellable run, so those two option objects are byte-identical to what they were
      ...(grouped ? groupSpawnOptions(process.platform) : {}),
    });
    opts.observe?.onSpawn?.(proc.pid);
    const ob = opts.observe;
    const out = collect(proc.stdout, ob?.onChunk ? (b) => ob.onChunk!("stdout", b) : undefined);
    const err = collect(proc.stderr, ob?.onChunk ? (b) => ob.onChunk!("stderr", b) : undefined);
    const finished = Promise.all([out.done, err.done, proc.exited]).then(() => "done" as const);
    let graceUp!: () => void;
    const grace = new Promise<"grace">((r) => { graceUp = () => r("grace"); });
    if (signal) {
      if (treeKill) { job = createWinJob(); if (job && !job.assign(proc.pid)) job = null; } // null → taskkill-only
      onAbort = () => {
        // a dead launcher may have left a child holding a pipe end (`sleep N & echo x`): the job
        // is still armed (the RUNNER has not settled) — terminate regardless; taskkill only a LIVE pid (reuse)
        const launcherAlive = proc.exitCode === null;
        killed = treeKill || grouped;
        if (treeKill) {
          job?.terminate();
          if (launcherAlive) { try { Bun.spawn(["taskkill", "/T", "/F", "/PID", String(proc.pid)], { stdout: "ignore", stderr: "ignore" }); } catch { /* best-effort */ } }
        }
        if (grouped) {
          // the GROUP first — the orphan holding stdout is in it and the launcher is not its only member
          killGroup(proc.pid, "SIGTERM");
          if (launcherAlive) { try { proc.kill("SIGTERM"); } catch { /* already gone */ } }
        }
        graceTimer = setTimeout(graceUp, ABORT_GRACE_MS);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      void finished.then(() => { if (onAbort) signal.removeEventListener("abort", onAbort); }, () => {});
    }
    const won = await Promise.race([finished, grace]);
    // #67: the grace expired with a pipe still held — something in the group ignored SIGTERM. Escalate to
    // the group, not to the launcher: the launcher is usually already gone and is never what is holding on.
    if (won === "grace" && grouped) killGroup(proc.pid, "SIGKILL");
    if (won === "grace") { out.cancel(); err.cancel(); }
    const code = (killed || won === "grace") ? 143 : await proc.exited;
    let stderr = err.text();
    if (won === "grace") stderr += (stderr ? "\n" : "") + ABORT_TRUNCATED_MARKER;
    const r: RawResult = { code, stdout: out.text(), stderr };
    if (treeKill) r.treeKill = job ? "job" : "taskkill-only";
    return r;
  } catch (e) {
    return { code: -1, stdout: "", stderr: `spawn failed: ${e instanceof Error ? e.message : String(e)}` };
  } finally {
    clearTimeout(graceTimer);
    if (killed) job?.terminate(); else job?.release(); // both no-ops once the abort path closed the job
    // the signal is the RUN's (long-lived): drop this spawn's listener or a
    // multi-bash run accumulates one dead closure per command
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
};

/** The cap assemble() slices a command's output to. Exported for the git commands (tui/git-cmds.ts):
 *  a diff this long is a PREFIX, and both the draft prompt and the approval card must say so. */
export const OUTPUT_CAP_CHARS = 10_000;

/** Byte-compatible with hashline runOnce text assembly: stdout, then an
 *  optional `\nstderr:\n…` section, sliced to 10k chars. */
function assemble(stdout: string, stderr: string): string {
  return (stdout + (stderr ? `\nstderr:\n${stderr}` : "")).slice(0, OUTPUT_CAP_CHARS);
}

/** Byte-compatible with hashline bashBin(): on Windows prefer Git bash —
 *  System32 bash.exe is the WSL relay and breaks on non-WSL machines. */
let bashCache: string | null = null;
function bashBin(): string {
  if (bashCache !== null) return bashCache;
  if (process.platform !== "win32") return (bashCache = "bash");
  const git = "C:/Program Files/Git/bin/bash.exe";
  bashCache = existsSync(git) ? git : "bash";
  return bashCache;
}

// ---------- Probes (availability is checked, never assumed) ----------

export interface RungProbe { rung: Rung; available: boolean; detail: string }

/** Probe deadline: 500ms, upstream's own bwrap cap (bwrap.rs:36,67). Known
 *  tradeoff, accepted deliberately: a COLD `wsl.exe --exec bash -c true`
 *  (utility-VM boot) measured 2842ms on the reference machine vs 197ms warm —
 *  a cold probe times out and the rung reports unavailable with a detail that
 *  says to warm it and retry. That is the contract: timeout ⇒ unavailable NOW,
 *  never a probe that hangs the session. */
export const PROBE_TIMEOUT_MS = 500;

export interface ProbeOptions {
  /** docker rung: image the trial (and later every command) runs in */
  dockerImage?: string;
  /** probe deadline override (tests); defaults to PROBE_TIMEOUT_MS */
  timeoutMs?: number;
}

/** wsl.exe emits UTF-16LE; drop NULs before quoting output in a detail. */
function probeText(s: string): string {
  return s.replace(/\u0000/g, "").trim().slice(0, 200);
}

/** One bounded trial spawn. The AbortSignal kills the trial process at the
 *  deadline; a separate REF'D setTimeout resolves the race. Two reasons the
 *  race must NOT wait on the signal's own 'abort' event: (a) the killed
 *  wrapper's children can keep the stdout pipe open past the kill — measured
 *  on Windows: a 300ms abort delivered exit 143 but the runner promise only
 *  settled ~5s later when the orphaned grandchild released the pipe; (b) Bun's
 *  AbortSignal.timeout timer is UNREF'D — on an otherwise idle event loop it
 *  never fires at all (this hung the whole test run before it was caught). */
async function trialSpawn(
  runner: SpawnRunner,
  argv: string[],
  timeoutMs: number,
): Promise<{ r: RawResult; timedOut: boolean }> {
  const deadline: RawResult = { code: -1, stdout: "", stderr: `probe timed out after ${timeoutMs}ms` };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onDeadline = new Promise<RawResult>((resolve) => { timer = setTimeout(() => resolve(deadline), timeoutMs); });
  try {
    const r = await Promise.race([runner(argv, { signal: AbortSignal.timeout(timeoutMs) }), onDeadline]);
    return { r, timedOut: r === deadline };
  } finally {
    clearTimeout(timer);
  }
}

/** Probe verdicts come from spawning `bash -c true` THROUGH the rung's own
 *  wrapper (bwrap.rs:74 shape) — the exact failure a real command would hit
 *  (missing wsl.exe, bash-less default distro, dead daemon, unpulled or
 *  bash-less image) is the failure the probe reports. */
export async function probeRung(
  rung: Rung,
  runner: SpawnRunner = bunRunner,
  platform: NodeJS.Platform = process.platform,
  opts: ProbeOptions = {},
): Promise<RungProbe> {
  const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS;
  switch (rung) {
    case "direct":
      return { rung, available: true, detail: "always available — today's in-process bash (blocklist only, NOT a sandbox)" };
    case "wsl": {
      if (platform !== "win32") {
        return { rung, available: false, detail: `wsl rung requires Windows wsl.exe (platform is ${platform})` };
      }
      // Trial spawn through the wrapper, NOT `wsl.exe --status`: --status exits
      // 0 whenever the subsystem is installed, even when the default distro has
      // no bash (docker-desktop) and every real command would exit 1.
      const shape = "wsl.exe --exec bash -c true";
      const { r, timedOut } = await trialSpawn(runner, ["wsl.exe", "--exec", "bash", "-c", "true"], timeoutMs);
      if (timedOut) {
        return { rung, available: false, detail: `wsl trial (${shape}) timed out after ${timeoutMs}ms — wrapper did not answer (a cold WSL utility-VM boot exceeds this cap); warm it with the same command and reconfigure` };
      }
      return r.code === 0
        ? { rung, available: true, detail: `wsl trial (${shape}) ok` }
        : { rung, available: false, detail: `wsl trial (${shape}) exited ${r.code}: ${probeText(r.stderr || r.stdout) || "no output"}` };
    }
    case "docker": {
      // Trial container run, NOT `docker version`: the version handshake proves
      // a daemon but not that the image is present or contains bash.
      const image = opts.dockerImage ?? DEFAULT_DOCKER_IMAGE;
      const shape = `docker run --rm ${image} bash -c true`;
      const { r, timedOut } = await trialSpawn(runner, ["docker", "run", "--rm", image, "bash", "-c", "true"], timeoutMs);
      if (timedOut) {
        return { rung, available: false, detail: `docker trial (${shape}) timed out after ${timeoutMs}ms — daemon wedged or pulling the image; pre-pull it and retry` };
      }
      return r.code === 0
        ? { rung, available: true, detail: `docker trial (${shape}) ok` }
        : { rung, available: false, detail: `docker trial (${shape}) exited ${r.code}: ${probeText(r.stderr || r.stdout) || "no output"}` };
    }
  }
}

/** Probe every rung (status surfaces; lets a caller CHOOSE, not fall). */
export function probeLadder(
  runner: SpawnRunner = bunRunner,
  platform: NodeJS.Platform = process.platform,
  opts: ProbeOptions = {},
): Promise<RungProbe[]> {
  return Promise.all(RUNGS.map((r) => probeRung(r, runner, platform, opts)));
}

// ---------- Unavailable rung = loud error (never fall DOWN the ladder) ----------

export class RungUnavailableError extends Error {
  readonly rung: Rung;
  readonly detail: string;
  constructor(rung: Rung, detail: string) {
    super(
      `executor rung '${rung}' is unavailable: ${detail}. ` +
      `Refusing to fall back down the ladder — pick an available rung explicitly ` +
      `(probeLadder() reports availability) or make '${rung}' usable and retry.`,
    );
    this.name = "RungUnavailableError";
    this.rung = rung;
    this.detail = detail;
  }
}

// ---------- Rung constructors ----------

/** Must contain bash; override per-project via ExecutorOptions.dockerImage. */
export const DEFAULT_DOCKER_IMAGE = "debian:stable-slim";

export interface ExecutorOptions {
  runner?: SpawnRunner;
  /** docker rung: image the command runs in (must provide bash) */
  dockerImage?: string;
  /** test seam: platform used by probes (defaults to process.platform) */
  platform?: NodeJS.Platform;
}

function directExecutor(runner: SpawnRunner): Executor {
  return {
    rung: "direct",
    async run(cmd, cwd, signal, observe) {
      // Byte-compatible with hashline runOnce: same argv, cwd, signal, assembly.
      const r = await runner([bashBin(), "-c", cmd], { cwd, signal, ...(observe ? { observe } : {}) });
      return { code: r.code, text: assemble(r.stdout, r.stderr) };
    },
  };
}

function wslExecutor(runner: SpawnRunner): Executor {
  return {
    rung: "wsl",
    async run(cmd, cwd, signal, observe) {
      // --cd translates the Windows cwd into the distro mount; --exec runs
      // bash directly with argv boundaries intact (no double-shell quoting).
      const r = await runner(["wsl.exe", "--cd", cwd, "--exec", "bash", "-c", cmd], { cwd, signal, ...(observe ? { observe } : {}) });
      return { code: r.code, text: assemble(r.stdout, r.stderr) };
    },
  };
}

function dockerExecutor(runner: SpawnRunner, image: string): Executor {
  return {
    rung: "docker",
    async run(cmd, cwd, signal, observe) {
      // Workspace mounted read-write at /workspace; container removed after
      // the run. The container is the boundary (OpenHands runtime shape).
      const argv = ["docker", "run", "--rm", "-v", `${cwd}:/workspace`, "-w", "/workspace", image, "bash", "-c", cmd];
      const r = await runner(argv, { cwd, signal, ...(observe ? { observe } : {}) });
      return { code: r.code, text: assemble(r.stdout, r.stderr) };
    },
  };
}

/** Probe `rung`, then construct its executor. Unavailable → throws
 *  RungUnavailableError. The requested rung is always the returned rung —
 *  no substitution, in either direction. */
export async function createExecutor(rung: Rung, opts: ExecutorOptions = {}): Promise<Executor> {
  const runner = opts.runner ?? bunRunner;
  const probe = await probeRung(rung, runner, opts.platform ?? process.platform, { dockerImage: opts.dockerImage });
  if (!probe.available) throw new RungUnavailableError(rung, probe.detail);
  switch (rung) {
    case "direct": return directExecutor(runner);
    case "wsl": return wslExecutor(runner);
    case "docker": return dockerExecutor(runner, opts.dockerImage ?? DEFAULT_DOCKER_IMAGE);
  }
}

// ---------- Session seam (what bashTool calls through) ----------

/** The seam tracks the DESIRED rung, not just the installed executor: a
 *  failed configure must never silently degrade to whatever was installed
 *  before (or to lazy `direct`). Until the desire is met, getExecutor()
 *  throws — the same loud RungUnavailableError contract as createExecutor. */
let current: Executor | null = null;
let desired: Rung = "direct";
let lastConfigureFailure: string | null = null;

/** Probe + install the session executor. The requested rung becomes the
 *  seam's DESIRED rung before probing: if the probe fails, this throws AND
 *  every later getExecutor() throws too, until a configure succeeds or
 *  resetExecutor() restores the direct default. The seam never hands out a
 *  rung other than the one last asked for. */
export async function configureExecutor(rung: Rung, opts?: ExecutorOptions): Promise<Executor> {
  desired = rung;
  try {
    current = await createExecutor(rung, opts);
    lastConfigureFailure = null;
    return current;
  } catch (e) {
    lastConfigureFailure = e instanceof RungUnavailableError ? e.detail
      : e instanceof Error ? e.message : String(e);
    throw e;
  }
}

/** Current executor. Until configured, the `direct` rung (today's behavior,
 *  the one rung that needs no probe). After a FAILED configure this throws
 *  RungUnavailableError for the desired rung — no silent fallback. */
export function getExecutor(): Executor {
  if (current?.rung === desired) return current;
  if (desired === "direct") return (current = directExecutor(bunRunner));
  throw new RungUnavailableError(
    desired,
    lastConfigureFailure ?? `configureExecutor('${desired}') has not succeeded; the seam refuses to substitute another rung`,
  );
}

/** Test seam: forget the configured executor and the desired rung. */
export function resetExecutor(): void { current = null; desired = "direct"; lastConfigureFailure = null; }
