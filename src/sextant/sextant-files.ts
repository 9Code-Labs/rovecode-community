/** Sextant repo I/O (port #44): the files-panel list, git statuses + branch, bounded file reads for
 *  the code panel and the hunks the diff view shows. Together with git-status.ts this is the ONLY I/O
 *  behind the surface, and the renderer runs it OFF the frame loop (sextant-repo.ts: a setTimeout(0)
 *  scheduled from the tick, then the `…Async` forms here so git runs beside the loop — a spawnSync
 *  must not stall a half-painted frame). The file list is `git ls-files -z --cached --others
 *  --exclude-standard` (the coding/repomap-files.ts gitListFiles command, issued through the injectable
 *  sextant GitRunner so tests never spawn) or a bounded deterministic walk when git cannot answer.
 *  Nothing here throws: null/[] instead. The sync forms stay for synchronous callers and as the parity
 *  oracle of the async ones. */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { buildHunks, diffOps, opStats, toDiffHunk } from "./engine.ts";
import {
  gitBranch, gitBranchAsync, gitHeadContent, gitHeadContentAsync, gitPorcelain, gitPorcelainAsync, spawnGit, spawnGitAsync,
  type GitRunner, type GitRunnerAsync,
} from "./git-status.ts";
import { reconstructBefore, type HashlineOp } from "./sextant-diff-base.ts";
import type { DiffHunk, FileStatus } from "./types.ts";

/** walk bound (coding/repomap-files.ts MAX_SRC_FILES) */
export const MAX_FILES = 2000;
/** a file larger than this is not shown in the code panel (`cannot read`) */
export const MAX_FILE_BYTES = 512 * 1024;
/** git's binary heuristic: a NUL within the first 8000 bytes */
const BINARY_SNIFF = 8000;
const SKIP_DIRS = new Set(["node_modules", ".git", ".rovecode", "dist", "build", "out", "coverage", ".cache"]);
const DIFF_CONTEXT = 3;

export interface RepoSnapshot {
  /** cwd-relative posix paths (tracked + untracked-unignored, or the walk) */
  paths: string[];
  /** porcelain M/A/D; null = no git */
  statuses: Map<string, FileStatus> | null;
  branch: string | null;
  /** the list came from git (a non-repo walks and never polls statuses) */
  git: boolean;
}

const LS_FILES: readonly string[] = ["ls-files", "-z", "--cached", "--others", "--exclude-standard"];
const splitZ = (r: { status: number | null; stdout: string } | null): string[] | null => (!r || r.status !== 0 ? null : r.stdout.split("\0").filter((p) => p.length > 0));

/** tracked + untracked-but-not-ignored paths; null when git cannot run, the cwd is not a repo or the call fails */
export function gitFiles(cwd: string, run: GitRunner = spawnGit): string[] | null {
  try { return splitZ(run(LS_FILES, cwd)); } catch { return null; }
}
/** gitFiles, awaited */
export async function gitFilesAsync(cwd: string, run: GitRunnerAsync = spawnGitAsync): Promise<string[] | null> {
  try { return splitZ(await run(LS_FILES, cwd)); } catch { return null; }
}

/** bounded deterministic walk for non-repos: per-dir sorted DFS, SKIP_DIRS and dot-dirs skipped, at most `max` files */
export function walkFiles(cwd: string, max = MAX_FILES): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string): void => {
    let names: string[];
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names.sort()) {
      if (out.length >= max) return;
      const full = join(dir, name), r = rel ? `${rel}/${name}` : name;
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) { if (!SKIP_DIRS.has(name) && !name.startsWith(".")) walk(full, r); }
      else if (st.isFile()) out.push(r);
    }
  };
  walk(cwd, "");
  return out;
}

/** the full snapshot: list (git or walk) + statuses + branch — three spawns, so the renderer calls it
 *  at start and after a write/edit/bash; the idle poll uses statusOnly() */
export function scanRepo(cwd: string, run: GitRunner = spawnGit): RepoSnapshot {
  const fromGit = gitFiles(cwd, run);
  return { paths: fromGit ?? walkFiles(cwd), statuses: gitPorcelain(cwd, run), branch: gitBranch(cwd, run), git: fromGit !== null };
}
/** scanRepo, awaited — the three read-only git calls run concurrently */
export async function scanRepoAsync(cwd: string, run: GitRunnerAsync = spawnGitAsync): Promise<RepoSnapshot> {
  const [fromGit, statuses, branch] = await Promise.all([gitFilesAsync(cwd, run), gitPorcelainAsync(cwd, run), gitBranchAsync(cwd, run)]);
  return { paths: fromGit ?? walkFiles(cwd), statuses, branch, git: fromGit !== null };
}

/** the cheap idle refresh: porcelain only (new untracked files show up as A through the statuses) */
export function statusOnly(cwd: string, run: GitRunner = spawnGit): Map<string, FileStatus> | null {
  return gitPorcelain(cwd, run);
}
/** statusOnly, awaited */
export const statusOnlyAsync = (cwd: string, run: GitRunnerAsync = spawnGitAsync): Promise<Map<string, FileStatus> | null> => gitPorcelainAsync(cwd, run);

/** utf8 content of a cwd-relative path; null when missing, not a file, binary or over `maxBytes` */
export function readFileBounded(cwd: string, rel: string, maxBytes = MAX_FILE_BYTES): string | null {
  try {
    const full = join(cwd, rel);
    const st = statSync(full);
    if (!st.isFile() || st.size > maxBytes) return null;
    const buf = readFileSync(full);
    const n = Math.min(buf.length, BINARY_SNIFF);
    for (let i = 0; i < n; i++) if (buf[i] === 0) return null;
    return buf.toString("utf8");
  } catch {
    return null;
  }
}

export interface HeadDiff {
  hunks: DiffHunk[]; add: number; del: number;
  /** present when the base is git HEAD (no pre-edit content captured or rebuilt): the hunks are
   *  cumulative — every uncommitted change of the file, not just the edit that landed */
  base?: "head";
}

/** The base an edit/write is diffed against, best first: the pre-edit content the renderer captured at
 *  approval (`before`; null = the file did not exist → all adds); the pre-edit content REBUILT from the
 *  hashline ops when the call was not gated (yolo / always — sextant-diff-base.ts, TAG-verified); the
 *  HEAD content (cumulative, flagged); null when only the repo question is left (the caller answers it:
 *  "" flagged head for a file HEAD never saw, no base at all outside git). */
function chooseBase(before: string | null | undefined, ops: readonly HashlineOp[] | undefined, disk: string | null, head: string | null): { base: string; head: boolean } | null {
  if (before !== undefined) return { base: before ?? "", head: false };
  const rebuilt = ops?.length && disk !== null ? reconstructBefore(disk, ops, head) : null;
  if (rebuilt !== null) return { base: rebuilt, head: false };
  return head !== null ? { base: head, head: true } : null;
}
const NEW_IN_REPO = { base: "", head: true };

/** hunks (3 context lines, jsdiff Myers through engine.ts) of `disk` over `base`; null when both are nothing */
function diffAgainst(b: { base: string; head: boolean }, disk: string | null): HeadDiff | null {
  if (b.base === "" && disk === null) return null;
  const ops = diffOps(b.base, disk ?? "");
  const { a, d } = opStats(ops);
  const out: HeadDiff = { hunks: buildHunks(ops, DIFF_CONTEXT).map(toDiffHunk), add: a, del: d };
  if (b.head) out.base = "head";
  return out;
}

/** The diff view's hunks for a cwd-relative path that an edit/write just changed: the disk content
 *  against chooseBase() — the captured or rebuilt pre-edit content (edit-only, so a dirty file shows
 *  the ONE change that landed), else HEAD (`base: "head"`), else "" inside a repo whose HEAD never saw
 *  the file (all adds, flagged). null outside git with nothing captured, or when nothing can be read.
 *  A deleted file diffs as all deletes. `ops` = the edit call's hashline ops (editOpsOf). */
export function fileDiff(cwd: string, rel: string, before: string | null | undefined, run: GitRunner = spawnGit, ops?: readonly HashlineOp[]): HeadDiff | null {
  const disk = readFileBounded(cwd, rel);
  const b = chooseBase(before, ops, disk, gitHeadContent(cwd, rel, run)) ?? (gitBranch(cwd, run) !== null ? NEW_IN_REPO : null);
  return b ? diffAgainst(b, disk) : null;
}
/** fileDiff, awaited (the renderer's path — sextant-repo.ts) */
export async function fileDiffAsync(cwd: string, rel: string, before: string | null | undefined, run: GitRunnerAsync = spawnGitAsync, ops?: readonly HashlineOp[]): Promise<HeadDiff | null> {
  const disk = readFileBounded(cwd, rel);
  const b = chooseBase(before, ops, disk, await gitHeadContentAsync(cwd, rel, run)) ?? ((await gitBranchAsync(cwd, run)) !== null ? NEW_IN_REPO : null);
  return b ? diffAgainst(b, disk) : null;
}

/** the /diff view: HEAD-vs-disk (nothing captured to fall back on), so always `base: "head"` */
export const headDiff = (cwd: string, rel: string, run: GitRunner = spawnGit): HeadDiff | null => fileDiff(cwd, rel, undefined, run);
export const headDiffAsync = (cwd: string, rel: string, run: GitRunnerAsync = spawnGitAsync): Promise<HeadDiff | null> => fileDiffAsync(cwd, rel, undefined, run);
