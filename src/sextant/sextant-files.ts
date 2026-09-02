/** Sextant repo I/O (port #44): the files-panel list, git statuses + branch, bounded file reads for
 *  the code panel and the HEAD-vs-disk hunks the diff view shows. Together with git-status.ts this is
 *  the ONLY I/O behind the surface, and the renderer runs it OFF the frame loop (a setTimeout(0)
 *  scheduled from the tick, never inside a painter — spawnSync must not stall a half-painted frame).
 *  The file list is `git ls-files -z --cached --others --exclude-standard` (the coding/repomap-files.ts
 *  gitListFiles command, issued through the injectable sextant GitRunner so tests never spawn) or a
 *  bounded deterministic walk when git cannot answer. Nothing here throws: null/[] instead. */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { buildHunks, diffOps, opStats, toDiffHunk } from "./engine.ts";
import { gitBranch, gitHeadContent, gitPorcelain, spawnGit, type GitRunner } from "./git-status.ts";
import type { DiffHunk, FileStatus } from "./types.ts";

/** walk bound (coding/repomap-files.ts MAX_SRC_FILES) */
export const MAX_FILES = 2000;
/** a file larger than this is not shown in the code panel (`cannot read`) */
export const MAX_FILE_BYTES = 512 * 1024;
/** git's binary heuristic: a NUL within the first 8000 bytes */
const BINARY_SNIFF = 8000;
const SKIP_DIRS = new Set(["node_modules", ".git", ".aion", "dist", "build", "out", "coverage", ".cache"]);
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

/** tracked + untracked-but-not-ignored paths; null when git cannot run, the cwd is not a repo or the call fails */
export function gitFiles(cwd: string, run: GitRunner = spawnGit): string[] | null {
  try {
    const r = run(["ls-files", "-z", "--cached", "--others", "--exclude-standard"], cwd);
    if (!r || r.status !== 0) return null;
    return r.stdout.split("\0").filter((p) => p.length > 0);
  } catch {
    return null;
  }
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

/** the cheap idle refresh: porcelain only (new untracked files show up as A through the statuses) */
export function statusOnly(cwd: string, run: GitRunner = spawnGit): Map<string, FileStatus> | null {
  return gitPorcelain(cwd, run);
}

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

export interface HeadDiff { hunks: DiffHunk[]; add: number; del: number }

/** Hunks (3 context lines, jsdiff Myers through engine.ts) for a cwd-relative path against its base:
 *  the HEAD content when git has the file; else `before` — the content the renderer captured when the
 *  edit/write started (null = the file did not exist → all adds), so a non-repo still shows the edit;
 *  else, in a repo, "" for a file HEAD never saw (all adds). null when there is no base at all (no git and
 *  nothing captured) or nothing can be read. A deleted file diffs as all deletes. */
export function fileDiff(cwd: string, rel: string, before: string | null | undefined, run: GitRunner = spawnGit): HeadDiff | null {
  const head = gitHeadContent(cwd, rel, run);
  const disk = readFileBounded(cwd, rel);
  const base = head ?? (before !== undefined ? before ?? "" : gitBranch(cwd, run) !== null ? "" : null);
  if (base === null || (base === "" && disk === null)) return null;
  const ops = diffOps(base, disk ?? "");
  const { a, d } = opStats(ops);
  return { hunks: buildHunks(ops, DIFF_CONTEXT).map(toDiffHunk), add: a, del: d };
}

/** the /diff view: HEAD-vs-disk (nothing captured to fall back on) */
export const headDiff = (cwd: string, rel: string, run: GitRunner = spawnGit): HeadDiff | null => fileDiff(cwd, rel, undefined, run);
