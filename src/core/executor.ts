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
 *  (core/src/exec_policy.rs:753-771); aion has no compensator at this seam,
 *  so per the bar an unavailable rung is a loud RungUnavailableError and
 *  NEVER a silent fallback DOWN the ladder. The docker rung follows the
 *  OpenHands runtime-boundary shape (execute inside a container with the
 *  workspace mounted) — OpenHands is not snapshotted; provenance gap.
 *
 *  Honesty note (matches README): every rung is DELEGATION, not a native
 *  sandbox. `direct` is today's blocklist-only behavior; `wsl`/`docker`
 *  isolate only as well as the wrapped runtime does. */

import { existsSync } from "node:fs";

// ---------- Ladder ----------

export type Rung = "direct" | "wsl" | "docker";

/** Ladder order, weakest isolation first. Order is informational only —
 *  selection is always explicit, never walked automatically. */
export const RUNGS: readonly Rung[] = ["direct", "wsl", "docker"];

export interface ExecResult { code: number; text: string }

export interface Executor {
  readonly rung: Rung;
  /** Run `cmd` through bash in `cwd`. Result matches today's bashTool
   *  internals: exit code + stdout (+ stderr section), sliced to 10k chars. */
  run(cmd: string, cwd: string, signal?: AbortSignal): Promise<ExecResult>;
}

// ---------- Raw process running (injectable so tests cover probe paths) ----------

export interface RawResult { code: number; stdout: string; stderr: string }

export type SpawnRunner = (
  argv: readonly string[],
  opts: { cwd?: string; signal?: AbortSignal },
) => Promise<RawResult>;

/** Default runner: Bun.spawn, stdout/stderr piped. A spawn failure (missing
 *  binary) is returned as code -1 with the message in stderr, so probes can
 *  report "not installed" instead of crashing. */
export const bunRunner: SpawnRunner = async (argv, opts) => {
  try {
    const proc = Bun.spawn([...argv], { cwd: opts.cwd, signal: opts.signal, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const code = await proc.exited;
    return { code, stdout, stderr };
  } catch (e) {
    return { code: -1, stdout: "", stderr: `spawn failed: ${e instanceof Error ? e.message : String(e)}` };
  }
};

/** Byte-compatible with hashline runOnce text assembly: stdout, then an
 *  optional `\nstderr:\n…` section, sliced to 10k chars. */
function assemble(stdout: string, stderr: string): string {
  return (stdout + (stderr ? `\nstderr:\n${stderr}` : "")).slice(0, 10_000);
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
    async run(cmd, cwd, signal) {
      // Byte-compatible with hashline runOnce: same argv, cwd, signal, assembly.
      const r = await runner([bashBin(), "-c", cmd], { cwd, signal });
      return { code: r.code, text: assemble(r.stdout, r.stderr) };
    },
  };
}

function wslExecutor(runner: SpawnRunner): Executor {
  return {
    rung: "wsl",
    async run(cmd, cwd, signal) {
      // --cd translates the Windows cwd into the distro mount; --exec runs
      // bash directly with argv boundaries intact (no double-shell quoting).
      const r = await runner(["wsl.exe", "--cd", cwd, "--exec", "bash", "-c", cmd], { cwd, signal });
      return { code: r.code, text: assemble(r.stdout, r.stderr) };
    },
  };
}

function dockerExecutor(runner: SpawnRunner, image: string): Executor {
  return {
    rung: "docker",
    async run(cmd, cwd, signal) {
      // Workspace mounted read-write at /workspace; container removed after
      // the run. The container is the boundary (OpenHands runtime shape).
      const argv = ["docker", "run", "--rm", "-v", `${cwd}:/workspace`, "-w", "/workspace", image, "bash", "-c", cmd];
      const r = await runner(argv, { cwd, signal });
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
