/** Sandbox rung configuration (PORT #27): makes the port-#10 executor ladder
 *  SELECTABLE in production — closes the #10 G7 residual ("no production
 *  selector; getExecutor() lazily returns direct").
 *
 *  Pattern source: openai/codex, Apache-2.0 (snapshot research/source_snapshots/
 *  openai-codex @ 379d50be), ported at pattern level, no code copied:
 *  - the tier is a CONFIG CHOICE layered as file < override: config.toml
 *    `sandbox_mode = "…"` (app-server/tests/common/config.rs:140) with the
 *    `--sandbox` flag mapped onto the same SandboxMode enum
 *    (utils/cli/src/shared_options.rs:40-41, utils/cli/src/sandbox_mode_cli_arg.rs:14-25).
 *    Here: `.rovecode/sandbox.json` < `ROVECODE_SANDBOX` env (rovecode has no per-run CLI
 *    flag for this; env is the override layer, as for every other ROVECODE_* knob);
 *  - an explicitly requested but unprovidable tier is a HARD ERROR
 *    (sandboxing/src/manager.rs:203-222) — the executor seam already refuses
 *    to fall DOWN the ladder (RungUnavailableError); this module turns that
 *    refusal into a ONE-LINE startup error every entrypoint can print.
 *
 *  Deliberate deviation from the modes.json idiom (src/core/modes.ts
 *  loadModesConfig "config can never crash startup"): a malformed sandbox file
 *  or an unknown rung is an ERROR, not a default. Degrading a misspelt "wsl"
 *  to `direct` would be exactly the silent fallback down the ladder that #10
 *  forbids — the user asked for isolation and would silently not get it.
 *
 *  Rungs are `direct` | `wsl` | `docker` only. bubblewrap/seatbelt are not
 *  rungs on this harness (Windows-first; codex's bwrap tier has no analogue).
 *
 *  Scope: consumed by createRuntime (src/cli/runtime.ts) — the ONE runtime
 *  construction behind tui/run/repl/acp/serve. The gauntlet runner
 *  (src/eval/gauntlet-runner.ts) registers tools directly and never builds a
 *  runtime, so `rovecode gauntlet` stays on the lazy `direct` seam regardless of
 *  the cwd's sandbox config (by design: the eval suite measures the loop, not
 *  the machine's WSL/Docker state). The executor seam is process-wide (#10):
 *  in a multi-session process (serve/acp) the most recently booted session's
 *  rung is the one every bash call uses. */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { rovecodeHome } from "../providers/auth.ts";
import { DEFAULT_DOCKER_IMAGE, RUNGS, RungUnavailableError, type Rung } from "./executor.ts";
import { isTrustedFile, untrustedFileNote } from "./trust.ts";

export type SandboxSource = "default" | "file" | "env";

export interface SandboxConfig {
  rung: Rung;
  /** docker rung image (must contain bash); resolved to DEFAULT_DOCKER_IMAGE for
   *  the docker rung when nothing configures it; a file-provided image is kept
   *  verbatim for other rungs (informational) */
  dockerImage?: string;
  /** where `rung` came from — env beats file beats the direct default */
  source: SandboxSource;
  /** present when a project sandbox.json existed but is not trusted on this machine: it was ignored, this says so */
  note?: string;
}

export interface SandboxTrustOptions {
  /** the user home holding the trust store (default rovecodeHome()) */
  home?: string;
  /** the gate (default core/trust.ts isTrustedFile); tests inject */
  trusted?: (file: string) => boolean;
}

export const SANDBOX_FILE = ".rovecode/sandbox.json";
export const SANDBOX_ENV = "ROVECODE_SANDBOX";
export const SANDBOX_IMAGE_ENV = "ROVECODE_SANDBOX_IMAGE";

const HINT = `fix ${SANDBOX_FILE} or ${SANDBOX_ENV} (default: direct)`;

/** Collapse to ONE line: startup errors are printed verbatim by entrypoints. */
function oneLine(s: string): string {
  return s.replace(/\s*[\r\n]+\s*/g, " ").trim();
}

/** The ONE startup-error class for sandbox selection: bad config (unknown rung,
 *  malformed file, bad image) AND a configured rung the machine cannot provide.
 *  `.message` is always a single actionable line — never a stack. */
export class SandboxConfigError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(oneLine(message), options);
    this.name = "SandboxConfigError";
  }
}

function isRung(v: string): v is Rung {
  return (RUNGS as readonly string[]).includes(v);
}

/** Rung names are trimmed + lower-cased ("WSL" is not a typo worth an error). */
function parseRung(raw: unknown, where: string): Rung {
  const v = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (isRung(v)) return v;
  const shown = typeof raw === "string" ? raw : JSON.stringify(raw);
  return fail(`sandbox rung ${JSON.stringify(String(shown).slice(0, 60))} from ${where} is not a rung — use one of ${RUNGS.join(", ")} (bubblewrap is not a rung on this harness); ${HINT}`);
}

function parseImage(raw: unknown, where: string): string {
  if (typeof raw === "string" && raw.trim() !== "") return raw.trim();
  return fail(`sandbox dockerImage from ${where} must be a non-empty string (e.g. "${DEFAULT_DOCKER_IMAGE}"); ${HINT}`);
}

function fail(message: string): never {
  throw new SandboxConfigError(message);
}

/** Raw file fields; values are validated only where SELECTED (an env override
 *  makes the file's rung irrelevant), but a file that cannot be parsed at all
 *  is always an error — intent is unreadable, and "fix or delete" is one step. */
interface FileFields { rung?: unknown; dockerImage?: unknown; path: string }

function readSandboxFile(cwd: string): FileFields | null {
  const path = join(cwd, ".rovecode", "sandbox.json");
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; // no file = default rung
    return fail(`sandbox config ${path} cannot be read (${e instanceof Error ? e.message : String(e)}) — ${HINT}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return fail(`sandbox config ${path} is not valid JSON (${e instanceof Error ? e.message : String(e)}) — fix or delete it; ${HINT}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return fail(`sandbox config ${path} must be a JSON object like {"rung":"wsl"} or {"rung":"docker","dockerImage":"${DEFAULT_DOCKER_IMAGE}"}; ${HINT}`);
  }
  const o = raw as Record<string, unknown>;
  return { rung: o.rung, dockerImage: o.dockerImage, path };
}

/** Resolve the sandbox rung for `cwd`: `ROVECODE_SANDBOX` (rung name) beats
 *  `<cwd>/.rovecode/sandbox.json` `{ rung, dockerImage }` beats the `direct`
 *  default; `ROVECODE_SANDBOX_IMAGE` beats the file's dockerImage. Throws
 *  SandboxConfigError (one line) on an unknown rung, a malformed file, or a
 *  bad dockerImage — never degrades silently. */
export function loadSandboxConfig(cwd: string, env: Record<string, string | undefined> = process.env, opts: SandboxTrustOptions = {}): SandboxConfig {
  let file = readSandboxFile(cwd);
  let note: string | undefined;
  // THE TRUST GATE (core/trust.ts, 2026-09-07): a repo file choosing the executor rung and the docker image every bash
  // command runs in is a stranger choosing the executor. Untrusted → the file contributes NOTHING (rung AND image fall to
  // the env / the default) and one note says so. A malformed file is still an error above: intent is unreadable either way.
  if (file !== null) {
    const trusted = opts.trusted ?? ((f: string) => isTrustedFile(opts.home ?? rovecodeHome(), f));
    if (!trusted(file.path)) { note = untrustedFileNote(file.path, "its sandbox rung and docker image are ignored (a repo file would choose the executor every bash command runs in)"); file = null; }
  }
  const envRung = env[SANDBOX_ENV]?.trim() ?? "";
  const envImage = env[SANDBOX_IMAGE_ENV]?.trim() ?? "";
  let rung: Rung = "direct";
  let source: SandboxSource = "default";
  if (envRung !== "") {
    rung = parseRung(envRung, SANDBOX_ENV);
    source = "env";
  } else if (file && file.rung !== undefined) {
    rung = parseRung(file.rung, file.path);
    source = "file";
  }
  let dockerImage: string | undefined;
  if (envImage !== "") dockerImage = envImage;
  else if (file && file.dockerImage !== undefined) dockerImage = parseImage(file.dockerImage, file.path);
  else if (rung === "docker") dockerImage = DEFAULT_DOCKER_IMAGE;
  return { rung, source, ...(dockerImage !== undefined ? { dockerImage } : {}), ...(note !== undefined ? { note } : {}) };
}

/** Wrap a failed configureExecutor(cfg.rung) into the startup error class:
 *  the probe detail (why the wrapper could not run `bash -c true`) plus the
 *  fix, on one line. The original error rides along as `cause`. */
export function unavailableRungError(cfg: SandboxConfig, cause: unknown): SandboxConfigError {
  const detail = cause instanceof RungUnavailableError ? cause.detail
    : cause instanceof Error ? cause.message : String(cause);
  return new SandboxConfigError(
    `sandbox rung "${cfg.rung}" (from ${originOf(cfg)}) unavailable: ${detail} — ${HINT}`,
    { cause },
  );
}

function originOf(cfg: SandboxConfig): string {
  return cfg.source === "env" ? SANDBOX_ENV : cfg.source === "file" ? SANDBOX_FILE : "default";
}

/** One-line human form for /status: `direct (default)`, `wsl (.rovecode/sandbox.json)`,
 *  `docker debian:stable-slim (ROVECODE_SANDBOX)`. */
export function describeSandbox(cfg: SandboxConfig): string {
  const image = cfg.rung === "docker" ? ` ${cfg.dockerImage ?? DEFAULT_DOCKER_IMAGE}` : "";
  return `${cfg.rung}${image} (${originOf(cfg)})`;
}
