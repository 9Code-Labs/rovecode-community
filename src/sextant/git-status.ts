/** Sextant git status (port #41): the ONLY I/O in the sextant model — branch, porcelain statuses
 *  (M/A/D per cwd-relative posix path) and HEAD file content for the diff view. Replaces the user's
 *  sextant v0.4.0 mock `fileStatus` (app.js:133) with real `git status --porcelain=v1 -z`. Every call
 *  returns null (never throws) when git is missing, times out or the cwd is not a repo; the spawn is
 *  the coding/repomap-files.ts:38-47 spawnSync idiom (5 s timeout, windowsHide). The renderer (#44)
 *  uses the `…Async` twins — same contract over child_process.spawn — so a 200 ms `git status` on a
 *  large repo runs beside the frame loop instead of freezing it; the sync forms stay for the
 *  synchronous callers and as the parity oracle. */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import type { FileStatus } from "./types.ts";

export interface GitResult { status: number | null; stdout: string }
/** `git -C <cwd> <args…>`; null when git cannot run at all (the injectable seam for tests) */
export type GitRunner = (args: readonly string[], cwd: string) => GitResult | null;
/** the async twin: resolves (never rejects) with the same result, off the caller's stack */
/** `signal` (optional): abort kills the child and the promise settles null only once the process is
 *  GONE (its `close`), so a caller awaiting it can safely remove the cwd afterwards — on Windows a live
 *  `git status` holds the directory, and that was the tui-sextant "flake" (EBUSY at rmSync). */
export type GitRunnerAsync = (args: readonly string[], cwd: string, signal?: AbortSignal) => Promise<GitResult | null>;

const TIMEOUT_MS = 5000;
const MAX_BUFFER = 64 * 1024 * 1024;
const PORCELAIN_ARGS: readonly string[] = ["status", "--porcelain=v1", "-z", "--untracked-files=all"];

export const spawnGit: GitRunner = (args, cwd) => {
  try {
    const res = spawnSync("git", ["-C", cwd, ...args], { timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    if (res.error || typeof res.stdout !== "string") return null;
    return { status: res.status, stdout: res.stdout };
  } catch {
    return null;
  }
};

export interface AsyncRunnerOptions {
  /** the child is killed and the call yields null after this long (default 5 s, like spawnGit) */
  timeoutMs?: number;
  /** executable + argv to spawn (default `git -C <cwd> <args…>`); tests point it at a sleeper or a missing binary */
  argv?: (args: readonly string[], cwd: string) => string[];
}

/** child_process.spawn under the spawnGit contract: stdin ignored, stderr dropped, stdout collected up to
 *  MAX_BUFFER, the child killed at the timeout (spawn's own `timeout`/`killSignal`, so this module still
 *  starts no timer of its own). Resolves null — never rejects — when the binary is missing, the call times
 *  out, overflows or dies by signal; a non-zero exit is an ordinary `{ status, stdout }`. */
export function gitRunnerAsync(o: AsyncRunnerOptions = {}): GitRunnerAsync {
  const timeout = o.timeoutMs ?? TIMEOUT_MS;
  const argv = o.argv ?? ((args: readonly string[], cwd: string): string[] => ["git", "-C", cwd, ...args]);
  return (args, cwd, signal) => new Promise<GitResult | null>((resolve) => {
    if (signal?.aborted) { resolve(null); return; } // already stopping: never spawn
    let done = false;
    const finish = (r: GitResult | null): void => { if (!done) { done = true; signal?.removeEventListener("abort", onAbort); resolve(r); } };
    let child: ChildProcess;
    // abort = kill, but settle from `close` below: the promise resolves only once the process is gone
    const onAbort = (): void => { child?.kill("SIGKILL"); };
    try {
      const [exe, ...rest] = argv(args, cwd);
      child = spawn(exe ?? "git", rest, { timeout, killSignal: "SIGKILL", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    } catch { finish(null); return; }
    signal?.addEventListener("abort", onAbort, { once: true });
    const chunks: Buffer[] = [];
    let size = 0;
    child.stdout?.on("data", (b: Buffer) => { size += b.length; if (size > MAX_BUFFER) { child.kill("SIGKILL"); } else chunks.push(b); });
    child.on("error", () => finish(null));
    child.on("close", (code, sig) => finish(code === null || sig !== null || size > MAX_BUFFER ? null : { status: code, stdout: Buffer.concat(chunks).toString("utf8") }));
  });
}
export const spawnGitAsync: GitRunnerAsync = gitRunnerAsync();

/** a sync runner (a test fake, or spawnGit) as an async one — a throwing runner becomes a null result */
export const toAsync = (run: GitRunner | GitRunnerAsync): GitRunnerAsync => (args, cwd) => Promise.resolve().then(() => run(args, cwd));

function ok(run: GitRunner, args: readonly string[], cwd: string): string | null {
  try {
    const r = run(args, cwd);
    return r && r.status === 0 ? r.stdout : null;
  } catch {
    return null;
  }
}
async function okAsync(run: GitRunnerAsync, args: readonly string[], cwd: string): Promise<string | null> {
  try {
    const r = await run(args, cwd);
    return r && r.status === 0 ? r.stdout : null;
  } catch {
    return null;
  }
}

/** Current branch; a detached HEAD reports the short commit id. null = no git / not a repo. */
export function gitBranch(cwd: string, run: GitRunner = spawnGit): string | null {
  const ref = ok(run, ["rev-parse", "--abbrev-ref", "HEAD"], cwd)?.trim();
  if (!ref) {
    // an empty repo (no commits) still has a symbolic HEAD
    const sym = ok(run, ["symbolic-ref", "--short", "-q", "HEAD"], cwd)?.trim();
    return sym || null;
  }
  if (ref !== "HEAD") return ref;
  const sha = ok(run, ["rev-parse", "--short", "HEAD"], cwd)?.trim();
  return sha || "HEAD";
}
/** gitBranch, awaited */
export async function gitBranchAsync(cwd: string, run: GitRunnerAsync = spawnGitAsync): Promise<string | null> {
  const ref = (await okAsync(run, ["rev-parse", "--abbrev-ref", "HEAD"], cwd))?.trim();
  if (!ref) {
    const sym = (await okAsync(run, ["symbolic-ref", "--short", "-q", "HEAD"], cwd))?.trim();
    return sym || null;
  }
  if (ref !== "HEAD") return ref;
  const sha = (await okAsync(run, ["rev-parse", "--short", "HEAD"], cwd))?.trim();
  return sha || "HEAD";
}

/** C-style unquoting for the non -z porcelain form (`"path with\ttab"`); octal escapes are UTF-8
 *  BYTES (git quotes `café.ts` as `"caf\303\251.ts"`), so the result is decoded as a byte string. */
export function unquotePath(p: string): string {
  if (p.length < 2 || !p.startsWith("\"") || !p.endsWith("\"")) return p;
  const body = p.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c !== "\\") { bytes.push(...Buffer.from(c, "utf8")); continue; }
    const n = body[i + 1] ?? "";
    if (/[0-7]/.test(n)) {
      const oct = /^[0-7]{1,3}/.exec(body.slice(i + 1))![0];
      bytes.push(parseInt(oct, 8) & 255); i += oct.length; continue;
    }
    bytes.push(n === "n" ? 10 : n === "t" ? 9 : n === "r" ? 13 : (n.charCodeAt(0) || 92)); i++;
  }
  return Buffer.from(bytes).toString("utf8");
}

const norm = (p: string): string => p.replace(/\\/g, "/").replace(/^\.\/+/, "");

function classify(x: string, y: string): FileStatus | null {
  if (x === "!" && y === "!") return null;      // ignored
  if (x === "?" && y === "?") return "A";       // untracked
  if (x === "D" || y === "D") return "D";
  if (x === "A") return "A";
  return "M";                                   // M/T/U/R/C and index-vs-worktree mixes
}

/** Parse porcelain v1 output — the -z form (NUL-separated, rename = `R  new\0old\0`) or the plain
 *  newline form (`R  old -> new`, quoted paths). Renames/copies map to M on the NEW path, `??` to A,
 *  any D to D, everything else to M; ignored entries and paths above cwd (`../`) are dropped. */
export function parsePorcelain(text: string): Map<string, FileStatus> {
  const out = new Map<string, FileStatus>();
  const zForm = text.includes("\0");
  const fields = zForm ? text.split("\0") : text.split(/\r?\n/);
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i]!;
    if (f.length < 4) continue;
    const x = f[0]!, y = f[1]!;
    let path = f.slice(3);
    if (x === "R" || y === "R" || x === "C" || y === "C") {
      if (zForm) i++;                                   // the ORIGINAL path follows as its own field
      else { const arrow = path.indexOf(" -> "); if (arrow >= 0) path = path.slice(arrow + 4); }
    }
    if (!zForm) path = unquotePath(path);
    path = norm(path);
    if (!path || path.startsWith("../")) continue;
    const st = classify(x, y);
    if (st) out.set(path, st);
  }
  return out;
}

/** cwd-relative posix path → M/A/D for every changed file; null when git is unavailable or the
 *  cwd is not inside a repository (NEVER throws). */
export function gitPorcelain(cwd: string, run: GitRunner = spawnGit): Map<string, FileStatus> | null {
  const text = ok(run, PORCELAIN_ARGS, cwd);
  return text === null ? null : parsePorcelain(text);
}
/** gitPorcelain, awaited */
export async function gitPorcelainAsync(cwd: string, run: GitRunnerAsync = spawnGitAsync): Promise<Map<string, FileStatus> | null> {
  const text = await okAsync(run, PORCELAIN_ARGS, cwd);
  return text === null ? null : parsePorcelain(text);
}

/** the `HEAD:./<rel>` spec for a cwd-relative path; null for an empty path or one above cwd */
function headSpec(path: string): string | null {
  const rel = norm(path);
  return !rel || rel.startsWith("../") ? null : `HEAD:./${rel}`;
}

/** The committed (HEAD) content of a cwd-relative path; null when git is unavailable, the path is
 *  not in HEAD (new file) or the content cannot be read. */
export function gitHeadContent(cwd: string, path: string, run: GitRunner = spawnGit): string | null {
  const spec = headSpec(path);
  return spec === null ? null : ok(run, ["show", spec], cwd);
}
/** gitHeadContent, awaited */
export async function gitHeadContentAsync(cwd: string, path: string, run: GitRunnerAsync = spawnGitAsync): Promise<string | null> {
  const spec = headSpec(path);
  return spec === null ? null : okAsync(run, ["show", spec], cwd);
}
