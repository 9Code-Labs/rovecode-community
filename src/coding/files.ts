/** First-class glob/grep/ls tools (PORT #22). Ported from opencode (MIT,
 *  snapshot ebece6e): glob/grep tool contracts, limits, and truncation markers
 *  (packages/opencode/src/tool/glob.ts:49-62, grep.ts:80-102) and the per-line
 *  2000-char cap w/ surrogate guard (packages/core/src/ripgrep.ts:267-270).
 *  Bounded-output + ignore semantics follow gemini-cli (Apache-2.0, snapshot
 *  0bd1d43): glob recency-then-alpha sort (packages/core/src/tools/glob.ts:47-70)
 *  and the ls output shape — dirs-first sort, [DIR] markers, "(N ignored)" note
 *  (packages/core/src/tools/ls.ts:191-271). Upstream shells out to ripgrep;
 *  rg is NOT guaranteed on PATH here, so matching is pure Bun/TS over a
 *  gitignore-aware enumeration: `git ls-files` in repos (repomap-files.ts
 *  seam, wave-2), a bounded walk skipping dotfiles/node_modules outside git. */

import { readdirSync, statSync, lstatSync, existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join, basename } from "node:path";
import { toolPath } from "../core/workspace.ts";
import { spawnSync } from "node:child_process";
import type { Tool, ToolOutput } from "../core/types.ts";
import { gitListFiles } from "./repomap-files.ts";

// ---------- bounds (advertised in schemas; args are clamped, never trusted) ----------

export const GLOB_LIMIT_DEFAULT = 100;   // opencode glob.ts:49
export const GREP_LIMIT_DEFAULT = 100;   // opencode grep.ts:67, gemini-cli DEFAULT_TOTAL_MAX_MATCHES
export const LS_LIMIT_DEFAULT = 200;
export const LIMIT_CAP = 1000;           // hard ceiling for maxFiles/maxMatches/maxEntries args
export const SCAN_CAP = 10_000;          // candidate files enumerated per call
export const GREP_LINE_CAP = 2000;       // chars per matching line (opencode ripgrep.ts:268)
export const GREP_FILE_BYTES_CAP = 1024 * 1024; // grep skips larger files
const BINARY_SNIFF_BYTES = 8192;         // NUL within the first 8k → binary, skip (rg default)

/** Exported so the cap CONTRACT is pinnable: ceiling (LIMIT_CAP), floor
 *  (absent / NaN / non-positive → the tool default), integer truncation. */
export function clampLimit(v: number | undefined, dflt: number): number {
  return Number.isFinite(v) && v! > 0 ? Math.min(Math.floor(v!), LIMIT_CAP) : dflt;
}
/** the ladder's own spelling (core/workspace.ts toolPath): `..` collapses lexically BEFORE the open, never through a symlink */
function resolvePath(cwd: string, p: string | undefined): string {
  if (!p) return cwd;
  return toolPath(cwd, p);
}

// ---------- gitignore-aware enumeration ----------

export interface FileListing { rel: string[]; viaGit: boolean; capped: boolean }

/** Relative file paths (forward slashes) under root. Git path: `git ls-files`
 *  (tracked + untracked-unignored → .gitignore honored). Fallback: bounded
 *  per-dir-sorted DFS skipping dot-entries and node_modules (repomap-files.ts
 *  walk rules, generic file filter), lstat-based so symlinks/junctions are
 *  never followed — a directory link back into an ancestor is a cycle, not a
 *  subtree. Both deterministic, both ≤ cap; `cap` is a test seam only. */
export function listFiles(root: string, cap = SCAN_CAP): FileListing {
  const fromGit = gitListFiles(root);
  if (fromGit) {
    const rel = fromGit.slice(0, cap + 1);
    const capped = rel.length > cap;
    if (capped) rel.pop();
    return { rel, viaGit: true, capped };
  }
  const rel: string[] = [];
  let capped = false;
  const walk = (dir: string, prefix: string): void => {
    let names: string[];
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names.sort()) {
      if (capped) return;
      if (name.startsWith(".") || name === "node_modules") continue;
      const full = join(dir, name);
      let st;
      try { st = lstatSync(full); } catch { continue; }
      if (st.isSymbolicLink()) continue; // junction/symlink: never descend (cycle hazard)
      if (st.isDirectory()) walk(full, `${prefix}${name}/`);
      else if (st.isFile()) {
        if (rel.length >= cap) { capped = true; return; }
        rel.push(prefix + name);
      }
    }
  };
  walk(root, "");
  return { rel, viaGit: false, capped };
}

/** rg --glob semantics (opencode ripgrep.ts:165): a pattern without "/" matches
 *  file NAMES at any depth; a pattern with "/" matches the root-relative path. */
function makeMatcher(pattern: string): (rel: string) => boolean {
  const glob = new Bun.Glob(pattern);
  if (!pattern.includes("/")) return (rel) => glob.match(basename(rel));
  return (rel) => glob.match(rel);
}

/** Enumeration-cap marker shared by the glob/grep listings and the ls scan
 *  cap; exported so the exact string is pinnable without a 10k-file fixture. */
export const scanCapLine = (cap: number): string =>
  `(File enumeration capped at ${cap} files; results may be incomplete.)`;
const scanCapNote = (capped: boolean, cap: number): string[] => (capped ? ["", scanCapLine(cap)] : []);

// ---------- grep helpers ----------

function isBinary(buf: Buffer): boolean {
  return buf.subarray(0, BINARY_SNIFF_BYTES).includes(0);
}

/** opencode ripgrep.ts:267-270: cap line text, guard a split surrogate pair. */
function capLine(text: string): string {
  return text.length > GREP_LINE_CAP
    ? text.slice(0, GREP_LINE_CAP).replace(/[\uD800-\uDBFF]$/, "") + "..."
    : text;
}

// ---------- ls helpers ----------

/** Names inside root that git ignores (git check-ignore --stdin; bounded).
 *  null = no git / not a repo → caller applies the non-git default excludes. */
function gitIgnoredNames(root: string, names: string[]): Set<string> | null {
  try {
    const res = spawnSync("git", ["-C", root, "check-ignore", "--stdin", "-z"],
      { input: names.join("\0"), timeout: 5000, maxBuffer: 16 * 1024 * 1024, encoding: "utf8", windowsHide: true });
    if (res.error || typeof res.stdout !== "string") return null;
    if (res.status !== 0 && res.status !== 1) return null; // 0 = some ignored, 1 = none; 128 = not a repo
    return new Set(res.stdout.split("\0").filter((s) => s.length > 0));
  } catch {
    return null;
  }
}

/** Builds the three tools over ONE enumeration cap. `scanCap` is a test seam
 *  only (repomap.ts `opts.maxFiles` idiom) so the cap note and the bounded ls
 *  stat sweep are pinnable on 3-file fixtures; every production registration
 *  uses the module-level globTool/grepTool/lsTool built with SCAN_CAP. */
export function fileTools(scanCap = SCAN_CAP): { globTool: Tool; grepTool: Tool; lsTool: Tool } {
  // ---------- glob ----------

  const globTool: Tool = {
    schema: {
      name: "glob",
      description: "Find files by glob pattern (e.g. \"**/*.ts\", \"src/**/*.test.ts\"; a pattern without \"/\" matches file names at any depth). Honors .gitignore in git repos; skips dotfiles and node_modules elsewhere. Returns absolute paths, most recently modified first, at most maxFiles (default 100, cap 1000) with a truncation note when more matched.",
      args: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "glob pattern to match files against" },
          path: { type: "string", description: "directory to search (default: session cwd)" },
          maxFiles: { type: "integer", description: `max paths returned (default ${GLOB_LIMIT_DEFAULT}, cap ${LIMIT_CAP})` },
        },
        required: ["pattern"],
      },
    },
    kind: "read",
    sequential: false,
    execute(args, ctx): Promise<ToolOutput> {
      const a = args as { pattern: string; path?: string; maxFiles?: number };
      const root = resolvePath(ctx.cwd, a.path);
      if (!existsSync(root)) return Promise.resolve({ ok: false, output: `directory not found: ${root}` });
      if (!statSync(root).isDirectory()) return Promise.resolve({ ok: false, output: `glob path must be a directory: ${root}` });
      const limit = clampLimit(a.maxFiles, GLOB_LIMIT_DEFAULT);
      let match: (rel: string) => boolean;
      try { match = makeMatcher(a.pattern); } catch (e) {
        return Promise.resolve({ ok: false, output: `invalid glob pattern: ${e instanceof Error ? e.message : String(e)}` });
      }
      const listing = listFiles(root, scanCap);
      // stat for the recency sort; stat failure = deleted-but-tracked etc. → drop
      const hits: { abs: string; mtimeMs: number }[] = [];
      for (const rel of listing.rel) {
        if (!match(rel)) continue;
        const abs = join(root, rel);
        try { hits.push({ abs, mtimeMs: statSync(abs).mtimeMs }); } catch { /* skip */ }
      }
      // gemini-cli glob.ts:47-70: files touched within 24h first (newest→oldest), rest alphabetical
      const now = Date.now();
      const oneDayMs = 24 * 60 * 60 * 1000;
      hits.sort((x, y) => {
        const xr = now - x.mtimeMs < oneDayMs, yr = now - y.mtimeMs < oneDayMs;
        if (xr && yr) return y.mtimeMs - x.mtimeMs;
        if (xr) return -1;
        if (yr) return 1;
        return x.abs.localeCompare(y.abs);
      });
      const truncated = hits.length > limit;
      const shown = truncated ? hits.slice(0, limit) : hits;
      const output: string[] = [];
      if (shown.length === 0) output.push("No files found");
      else {
        output.push(...shown.map((h) => h.abs));
        if (truncated) {
          output.push("", `(Results are truncated: showing first ${limit} results. Consider using a more specific path or pattern.)`);
        }
      }
      output.push(...scanCapNote(listing.capped, scanCap));
      return Promise.resolve({ ok: true, output: output.join("\n"), data: { count: shown.length, truncated } });
    },
  };

  // ---------- grep ----------

  const grepTool: Tool = {
    schema: {
      name: "grep",
      description: "Search file contents with a JS regular expression (e.g. \"log.*Error\", \"function\\s+\\w+\"). Optional glob filters files (\"*.ts\", \"src/**/*.tsx\"). Honors .gitignore in git repos; skips dotfiles/node_modules elsewhere, plus binary files and files over 1MB. Output is `path:line: text` matches, at most maxMatches (default 100, cap 1000), each line capped at 2000 chars, with truncation notes.",
      args: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "regex to search for in file contents" },
          path: { type: "string", description: "directory (or single file) to search (default: session cwd)" },
          glob: { type: "string", description: "file filter glob, e.g. \"*.ts\" (names at any depth) or \"src/**/*.ts\"" },
          maxMatches: { type: "integer", description: `max matches returned (default ${GREP_LIMIT_DEFAULT}, cap ${LIMIT_CAP})` },
        },
        required: ["pattern"],
      },
    },
    kind: "read",
    sequential: false,
    async execute(args, ctx): Promise<ToolOutput> {
      const a = args as { pattern: string; path?: string; glob?: string; maxMatches?: number };
      let rx: RegExp;
      try { rx = new RegExp(a.pattern); } catch (e) {
        return { ok: false, output: `invalid regex: ${e instanceof Error ? e.message : String(e)}` };
      }
      const root = resolvePath(ctx.cwd, a.path);
      if (!existsSync(root)) return { ok: false, output: `path not found: ${root}` };
      const limit = clampLimit(a.maxMatches, GREP_LIMIT_DEFAULT);
      let filter: ((rel: string) => boolean) | null = null;
      if (a.glob) {
        try { filter = makeMatcher(a.glob); } catch (e) {
          return { ok: false, output: `invalid glob filter: ${e instanceof Error ? e.message : String(e)}` };
        }
      }
      if (ctx.signal.aborted) return { ok: false, output: "grep aborted" }; // pre-aborted: enumerate nothing
      // single-file target scans just that file (opencode grep.ts:62)
      const singleFile = statSync(root).isFile();
      const listing: FileListing = singleFile
        ? { rel: [basename(root)], viaGit: false, capped: false }
        : listFiles(root, scanCap);
      const base = singleFile ? join(root, "..") : root;
      const candidates = listing.rel.filter((rel) => (filter ? filter(rel) : true)).sort();

      const matches: { abs: string; line: number; text: string }[] = [];
      let truncated = false;
      outer: for (const rel of candidates) {
        // reads are awaited, so the loop yields per file and an abort that lands
        // MID-scan is observed here — a synchronous scan could never see one
        if (ctx.signal.aborted) return { ok: false, output: "grep aborted" };
        const abs = singleFile ? root : join(base, rel);
        let buf: Buffer;
        try {
          if ((await stat(abs)).size > GREP_FILE_BYTES_CAP) continue;
          buf = await readFile(abs);
        } catch { continue; }
        if (isBinary(buf)) continue;
        const lines = buf.toString("utf8").split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          if (!rx.test(lines[i]!)) continue;
          if (matches.length >= limit) { truncated = true; break outer; }
          matches.push({ abs, line: i + 1, text: capLine(lines[i]!) });
        }
      }
      if (matches.length === 0) {
        return { ok: true, output: ["No matches found", ...scanCapNote(listing.capped, scanCap)].join("\n"), data: { matches: 0, truncated: false } };
      }
      const output = [`Found ${matches.length} matches${truncated ? " (more matches available)" : ""}`];
      output.push(...matches.map((m) => `${m.abs}:${m.line}: ${m.text}`));
      if (truncated) output.push("", "(Results truncated. Consider using a more specific path or pattern.)");
      output.push(...scanCapNote(listing.capped, scanCap));
      return { ok: true, output: output.join("\n"), data: { matches: matches.length, truncated } };
    },
  };

  // ---------- ls ----------

  const lsTool: Tool = {
    schema: {
      name: "ls",
      description: "List a directory (non-recursive). Directories first as `[DIR] name`, files as `name (N bytes)`, alphabetical. Gitignored entries are hidden and counted in git repos; dotfiles and node_modules are hidden elsewhere. At most maxEntries rows (default 200, cap 1000) with a truncation note.",
      args: {
        type: "object",
        properties: {
          path: { type: "string", description: "directory to list (default: session cwd)" },
          maxEntries: { type: "integer", description: `max entries returned (default ${LS_LIMIT_DEFAULT}, cap ${LIMIT_CAP})` },
        },
      },
    },
    kind: "read",
    sequential: false,
    execute(args, ctx): Promise<ToolOutput> {
      const a = args as { path?: string; maxEntries?: number };
      const root = resolvePath(ctx.cwd, a.path);
      if (!existsSync(root)) return Promise.resolve({ ok: false, output: `directory not found: ${root}` });
      if (!statSync(root).isDirectory()) return Promise.resolve({ ok: false, output: `Path is not a directory: ${root}` });
      const limit = clampLimit(a.maxEntries, LS_LIMIT_DEFAULT);

      const names = readdirSync(root).filter((n) => n !== ".git");
      const ignored = gitIgnoredNames(root, names);
      let kept: string[];
      let ignoredCount: number;
      if (ignored) {
        kept = names.filter((n) => !ignored.has(n));
        ignoredCount = names.length - kept.length;
      } else {
        // outside git: dotfile/node_modules default excludes (gemini-cli filters via
        // its FileDiscoveryService; we approximate with the walk rules)
        kept = names.filter((n) => !n.startsWith(".") && n !== "node_modules");
        ignoredCount = names.length - kept.length;
      }
      if (kept.length === 0) {
        const note = ignoredCount > 0 ? `\n\n(${ignoredCount} ignored)` : "";
        return Promise.resolve({ ok: true, output: `Directory ${root} is empty.${note}`, data: { entries: 0, truncated: false } });
      }

      // the per-entry stat sweep is bounded by the scan cap: alphabetical slice
      // FIRST, then stat only the survivors (a 30k-entry dir with maxEntries 5
      // used to stat all 30k before truncating). Dirs-first ordering therefore
      // holds within the scanned slice; the cap note flags what was left out.
      const scanCapped = kept.length > scanCap;
      const scanned = scanCapped ? kept.sort((x, y) => x.localeCompare(y)).slice(0, scanCap) : kept;
      const entries: { name: string; isDir: boolean; size: number }[] = [];
      for (const name of scanned) {
        try {
          const st = statSync(join(root, name));
          entries.push({ name, isDir: st.isDirectory(), size: st.isDirectory() ? 0 : st.size });
        } catch { /* unreadable entry → drop */ }
      }
      // gemini-cli ls.ts:253-257: directories first, then alphabetical
      entries.sort((x, y) => {
        if (x.isDir && !y.isDir) return -1;
        if (!x.isDir && y.isDir) return 1;
        return x.name.localeCompare(y.name);
      });
      const truncated = entries.length > limit;
      const shown = truncated ? entries.slice(0, limit) : entries;
      const body = shown.map((e) => (e.isDir ? `[DIR] ${e.name}` : `${e.name} (${e.size} bytes)`)).join("\n");
      let output = `Directory listing for ${root}:\n${body}`;
      if (truncated) output += `\n\n(Results truncated: showing first ${limit} of ${entries.length} entries.)`;
      if (ignoredCount > 0) output += `\n\n(${ignoredCount} ignored)`;
      if (scanCapped) output += `\n\n${scanCapLine(scanCap)}`;
      return Promise.resolve({ ok: true, output, data: { entries: shown.length, truncated } });
    },
  };

  return { globTool, grepTool, lsTool };
}

export const { globTool, grepTool, lsTool } = fileTools();
