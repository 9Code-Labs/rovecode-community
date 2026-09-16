/** Repo-map source enumeration (PORT #12). aider maps git-tracked files only
 *  (find_src_files feeds repo.get_tracked_files output, repomap.py L787-795);
 *  we prefer `git ls-files` — tracked + untracked-unignored, so .gitignore is
 *  honored and enumeration is O(index), not O(walk) — and fall back to a
 *  BOUNDED directory walk for non-repos: at most MAX_SRC_FILES files, files
 *  over MAX_SRC_BYTES skipped (a 1.5MB minified bundle costs seconds of parse
 *  for a handful of map tokens). Both paths stay deterministic. */

import { readdirSync, statSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, extname } from "node:path";
import { execFile, spawnSync } from "node:child_process";
import { Lang } from "@ast-grep/napi";

/** extensions extractTags can parse; also gates enumeration + special-file filtering */
export const LANG_BY_EXT: Record<string, Lang> = {
  ".ts": Lang.TypeScript, ".mts": Lang.TypeScript, ".cts": Lang.TypeScript,
  ".tsx": Lang.Tsx,
  ".js": Lang.JavaScript, ".mjs": Lang.JavaScript, ".cjs": Lang.JavaScript, ".jsx": Lang.JavaScript,
};

const SKIP_DIRS = new Set(["node_modules", ".git", ".rovecode", "dist", "build", "out", "coverage", ".cache"]);
/** hard bounds (round-2 F2): enumeration/parse cost is O(cap), not O(repo) */
export const MAX_SRC_FILES = 2000;
export const MAX_SRC_BYTES = 256 * 1024;

export interface SrcScanStats {
  /** true when the MAX_SRC_FILES cap dropped candidates */
  capped: boolean;
  /** enumerated via `git ls-files` (gitignore honored) instead of the walk */
  viaGit: boolean;
}

/** `git ls-files -z --cached --others --exclude-standard` under rootDir:
 *  tracked + untracked-but-not-ignored, NUL-separated, forward slashes.
 *  Bounded timeout; ANY failure (no git binary, not a repo, timeout, output
 *  overflow) returns null and the caller walks instead.
 *  Exported for the port #22 glob/grep tools (files.ts) — same gitignore seam. */
export function gitListFiles(rootDir: string): string[] | null {
  try {
    const res = spawnSync("git", ["-C", rootDir, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { timeout: 5000, maxBuffer: 64 * 1024 * 1024, encoding: "utf8", windowsHide: true });
    if (res.error || res.status !== 0 || typeof res.stdout !== "string") return null;
    return res.stdout.split("\0").filter((p) => p.length > 0);
  } catch {
    return null;
  }
}

/** gitListFiles without blocking the event loop (the TUI's warm build, repomap.ts buildRepoMapChunkAsync):
 *  same argv, same bounds, same null-on-any-failure contract. */
export function gitListFilesAsync(rootDir: string): Promise<string[] | null> {
  return new Promise((resolve) => {
    try {
      execFile("git", ["-C", rootDir, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
        { timeout: 5000, maxBuffer: 64 * 1024 * 1024, encoding: "utf8", windowsHide: true },
        (err, stdout) => { resolve(err || typeof stdout !== "string" ? null : stdout.split("\0").filter((p) => p.length > 0)); });
    } catch {
      resolve(null);
    }
  });
}

/** keep = regular file within the size bound (stat failure = tracked-but-deleted etc.) */
function keepFile(full: string): boolean {
  try {
    const st = statSync(full);
    return st.isFile() && st.size <= MAX_SRC_BYTES;
  } catch {
    return false;
  }
}

/** Source files under root, capped and size-bounded. Git path: sorted
 *  candidates, first `maxFiles` valid ones. Walk path: per-dir sorted DFS
 *  (deterministic) that STOPS as soon as the cap is exceeded, skipping
 *  SKIP_DIRS and dot-dirs like before. `stats` reports capping + which path
 *  ran; `maxFiles` is overridable for tests only. */
export function findSrcFiles(rootDir: string, stats?: SrcScanStats, maxFiles = MAX_SRC_FILES): string[] {
  const out: string[] = [];
  const fromGit = gitListFiles(rootDir);
  if (fromGit) {
    if (stats) stats.viaGit = true;
    const candidates = fromGit
      .filter((p) => LANG_BY_EXT[extname(p).toLowerCase()] !== undefined)
      // mirror the walk's dir rules on path segments (vendored node_modules, dot-dirs)
      .filter((p) => !p.split("/").slice(0, -1).some((seg) => SKIP_DIRS.has(seg) || seg.startsWith(".")))
      .sort();
    for (const p of candidates) {
      if (out.length > maxFiles) break; // one extra collected to detect capping
      const full = join(rootDir, p);
      if (keepFile(full)) out.push(full);
    }
  } else {
    const walk = (dir: string) => {
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        return;
      }
      for (const name of names.sort()) {
        if (out.length > maxFiles) return; // cap exceeded — unwind the whole DFS
        const full = join(dir, name);
        let st;
        try {
          st = statSync(full);
        } catch {
          continue;
        }
        if (st.isDirectory()) {
          if (!SKIP_DIRS.has(name) && !name.startsWith(".")) walk(full);
        } else if (LANG_BY_EXT[extname(name).toLowerCase()] !== undefined && st.size <= MAX_SRC_BYTES) {
          out.push(full);
        }
      }
    };
    walk(rootDir);
  }
  if (out.length > maxFiles) {
    if (stats) stats.capped = true;
    out.pop();
  }
  return out;
}

/** the source file `name` under `dir` when it is a regular file within the size bound, else null */
async function keepFileAsync(full: string): Promise<boolean> {
  try {
    const st = await stat(full);
    return st.isFile() && st.size <= MAX_SRC_BYTES;
  } catch {
    return false;
  }
}

/** findSrcFiles for the TUI's warm build: the SAME list, in the SAME order, with the same cap and size rules,
 *  but every directory read, stat and the git listing are awaited — the event loop keeps turning, so a
 *  frame loop paints and reads keys while a cold repo (or a home directory: an unbounded stat walk before
 *  the cap is hit) is enumerated. The synchronous findSrcFiles blocked for 7 s on a home directory. */
export async function findSrcFilesAsync(rootDir: string, stats?: SrcScanStats, maxFiles = MAX_SRC_FILES, signal?: AbortSignal): Promise<string[]> {
  signal?.throwIfAborted();
  const out: string[] = [];
  // Await the child's actual exit even on cancellation: on Windows a live git holds its cwd open.
  const fromGit = await gitListFilesAsync(rootDir);
  signal?.throwIfAborted();
  if (fromGit) {
    if (stats) stats.viaGit = true;
    const candidates = fromGit
      .filter((p) => LANG_BY_EXT[extname(p).toLowerCase()] !== undefined)
      .filter((p) => !p.split("/").slice(0, -1).some((seg) => SKIP_DIRS.has(seg) || seg.startsWith(".")))
      .sort();
    for (const p of candidates) {
      if (out.length > maxFiles) break;
      const full = join(rootDir, p);
      if (await keepFileAsync(full)) out.push(full);
      signal?.throwIfAborted();
    }
  } else {
    const walk = async (dir: string): Promise<void> => {
      signal?.throwIfAborted();
      let entries: import("node:fs").Dirent[];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const ent of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
        signal?.throwIfAborted();
        if (out.length > maxFiles) return;
        const name = ent.name;
        const full = join(dir, name);
        // a symlink is followed like statSync does; a broken one is skipped like a failed stat
        let isDir = ent.isDirectory(), isFile = ent.isFile();
        if (ent.isSymbolicLink()) {
          try { const st = await stat(full); isDir = st.isDirectory(); isFile = st.isFile(); } catch { continue; }
        }
        if (isDir) {
          if (!SKIP_DIRS.has(name) && !name.startsWith(".")) await walk(full);
        } else if (isFile && LANG_BY_EXT[extname(name).toLowerCase()] !== undefined) {
          if (await keepFileAsync(full)) out.push(full);
        }
      }
    };
    await walk(rootDir);
  }
  if (out.length > maxFiles) {
    if (stats) stats.capped = true;
    out.pop();
  }
  return out;
}
