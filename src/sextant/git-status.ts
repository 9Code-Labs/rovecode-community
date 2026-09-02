/** Sextant git status (port #41): the ONLY I/O in the sextant model — branch, porcelain statuses
 *  (M/A/D per cwd-relative posix path) and HEAD file content for the diff view. Replaces the user's
 *  sextant v0.4.0 mock `fileStatus` (app.js:133) with real `git status --porcelain=v1 -z`. Every call
 *  returns null (never throws) when git is missing, times out or the cwd is not a repo; the spawn is
 *  the coding/repomap-files.ts:38-47 spawnSync idiom (5 s timeout, windowsHide). */

import { spawnSync } from "node:child_process";
import type { FileStatus } from "./types.ts";

export interface GitResult { status: number | null; stdout: string }
/** `git -C <cwd> <args…>`; null when git cannot run at all (the injectable seam for tests) */
export type GitRunner = (args: readonly string[], cwd: string) => GitResult | null;

const TIMEOUT_MS = 5000;
const MAX_BUFFER = 64 * 1024 * 1024;

export const spawnGit: GitRunner = (args, cwd) => {
  try {
    const res = spawnSync("git", ["-C", cwd, ...args], { timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    if (res.error || typeof res.stdout !== "string") return null;
    return { status: res.status, stdout: res.stdout };
  } catch {
    return null;
  }
};

function ok(run: GitRunner, args: readonly string[], cwd: string): string | null {
  try {
    const r = run(args, cwd);
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
  const text = ok(run, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], cwd);
  return text === null ? null : parsePorcelain(text);
}

/** The committed (HEAD) content of a cwd-relative path; null when git is unavailable, the path is
 *  not in HEAD (new file) or the content cannot be read. */
export function gitHeadContent(cwd: string, path: string, run: GitRunner = spawnGit): string | null {
  const rel = norm(path);
  if (!rel || rel.startsWith("../")) return null;
  return ok(run, ["show", `HEAD:./${rel}`], cwd);
}
