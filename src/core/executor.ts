/** Executor sandbox ladder (PORT #10): ONE seam for shell execution with
 *  selectable rungs — `direct` | `wsl` | `docker`.
 *
 *  Pattern source: openai/codex, Apache-2.0, Copyright 2025 OpenAI (snapshot
 *  research/source_snapshots/openai-codex @ 379d50be). Ported at pattern
 *  level, no code copied:
 *  - tiered execution selected per platform: SandboxType +
 *    get_platform_sandbox(), codex-rs/sandboxing/src/manager.rs:37,62;
 *  - availability PROBED at runtime by spawning a trial command, as codex
 *    probes bubblewrap with `bwrap … /bin/true`,
 *    codex-rs/sandboxing/src/bwrap.rs:74;
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

/** wsl.exe emits UTF-16LE; drop NULs before quoting output in a detail. */
function probeText(s: string): string {
  return s.replace(/\u0000/g, "").trim().slice(0, 200);
}

export async function probeRung(
  rung: Rung,
  runner: SpawnRunner = bunRunner,
  platform: NodeJS.Platform = process.platform,
): Promise<RungProbe> {
  switch (rung) {
    case "direct":
      return { rung, available: true, detail: "always available — today's in-process bash (blocklist only, NOT a sandbox)" };
    case "wsl": {
      if (platform !== "win32") {
        return { rung, available: false, detail: `wsl rung requires Windows wsl.exe (platform is ${platform})` };
      }
      const r = await runner(["wsl.exe", "--status"], {});
      return r.code === 0
        ? { rung, available: true, detail: "wsl.exe --status ok" }
        : { rung, available: false, detail: `wsl.exe --status exited ${r.code}: ${probeText(r.stderr || r.stdout) || "no output"}` };
    }
    case "docker": {
      // `docker version` (not `--version`) needs a reachable daemon — probes
      // that the rung will actually work, not merely that a CLI exists.
      const r = await runner(["docker", "version", "--format", "{{.Server.Version}}"], {});
      return r.code === 0
        ? { rung, available: true, detail: `docker daemon ${probeText(r.stdout)}` }
        : { rung, available: false, detail: `docker version exited ${r.code}: ${probeText(r.stderr || r.stdout) || "no output"}` };
    }
  }
}

/** Probe every rung (status surfaces; lets a caller CHOOSE, not fall). */
export function probeLadder(
  runner: SpawnRunner = bunRunner,
  platform: NodeJS.Platform = process.platform,
): Promise<RungProbe[]> {
  return Promise.all(RUNGS.map((r) => probeRung(r, runner, platform)));
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
  const probe = await probeRung(rung, runner, opts.platform ?? process.platform);
  if (!probe.available) throw new RungUnavailableError(rung, probe.detail);
  switch (rung) {
    case "direct": return directExecutor(runner);
    case "wsl": return wslExecutor(runner);
    case "docker": return dockerExecutor(runner, opts.dockerImage ?? DEFAULT_DOCKER_IMAGE);
  }
}

// ---------- Session seam (what bashTool calls through) ----------

let current: Executor | null = null;

/** Probe + install the session executor. On an unavailable rung this throws
 *  and the previously installed executor stays in place — the failure is the
 *  caller's to see; the seam never downgrades behind its back. */
export async function configureExecutor(rung: Rung, opts?: ExecutorOptions): Promise<Executor> {
  current = await createExecutor(rung, opts);
  return current;
}

/** Current executor; until configured, the `direct` rung (today's behavior,
 *  the one rung that needs no probe). */
export function getExecutor(): Executor {
  return (current ??= directExecutor(bunRunner));
}

/** Test seam: forget the configured executor. */
export function resetExecutor(): void { current = null; }
