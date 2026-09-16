/**
 * Project context inheritance (port #8): auto-import instruction files from
 * other coding-agent "harnesses" (Claude, Gemini, Cursor, Copilot, plain
 * AGENTS.md) so rovecode projects don't need to duplicate repo conventions.
 *
 * Pattern + precedence order modeled on oh-my-pi's context-file discovery
 * (research/source_snapshots/can1357-oh-my-pi):
 *   - docs/context-files.md, "Other supported context conventions" and
 *     "Load order and shadowing" tables — the provider-priority idea
 *     (higher priority wins at a shared scope) and the per-tool path
 *     conventions: AGENTS.md, CLAUDE.md / .claude/CLAUDE.md, GEMINI.md,
 *     .cursor/rules/*.mdc + legacy .cursorrules, .github/copilot-instructions.md.
 *   - packages/coding-agent/src/discovery/builtin.ts `getAncestorDirs` — the
 *     cwd-upward ancestor walk with an optional inclusive stop directory.
 *   - packages/coding-agent/src/discovery/cursor.ts — `.cursor/rules/*.mdc`
 *     carries MDC frontmatter that must be separated from the rule body.
 *
 * Discovery + precedence (rovecode's documented spec):
 *   - Ancestor walk: cwd UPWARD via dirname until parent === current (the
 *     filesystem root). The walk additionally stops — INCLUSIVELY — at the
 *     first directory containing `.git` (file or directory; worktrees use a
 *     file), so a repository never inherits context from outside itself.
 *     `opts.stopAt` bounds the walk at an explicit dir (also inclusive).
 *   - Precedence: NEARER directories first (nearest wins); within one
 *     directory, family order rovecode > agents > claude > gemini > cursor >
 *     copilot (the harvest list in `buildCandidates`). Earlier position wins
 *     dedupe and total-cap priority.
 *   - Shadowing (dedupe by depth): the same relative path (e.g. `AGENTS.md`)
 *     found in a nearer directory completely shadows the farther one — the
 *     farther file is never read and never listed.
 *   - Blank files (empty or whitespace-only, after MDC frontmatter stripping)
 *     are skipped entirely: no section, no dedupe registration, no shadowing.
 *   - Byte-identical content across surviving candidates is included once;
 *     the earlier (higher-precedence) occurrence wins and later duplicates
 *     never reach `sources` — unlike total-cap drops, which keep a stub.
 *
 * Budgets (rovecode-specific; OMP has no cap on context-file loading):
 *   - `maxPerFileChars` caps each file's content. Truncation is fence-safe:
 *     cut at the last newline inside the window and close an odd ``` fence
 *     count so the following sections aren't swallowed by an open code block.
 *   - `maxTotalChars` budgets the FULL rendered section string — the
 *     `## From <path>` header included, so `text.length` never exceeds it.
 *   - `maxFiles` bounds how many files are included; further existing
 *     candidate files are counted in `skippedFiles` but never read.
 *
 * Freshness: callers snapshot the result once per runtime (cli/runtime.ts)
 * so the system prompt stays byte-stable for prompt caching (port #5).
 * Mid-session edits to config files are intentionally not picked up —
 * restart rovecode (a new runtime) to refresh.
 *
 * Remaining deliberate deviations from OMP: no provider-priority shadowing
 * table (content dedupe + path shadowing instead); `.cursor/rules/*.mdc`
 * harvested unconditionally as plain text (frontmatter stripped, never
 * parsed/acted on) and restricted to `*.mdc`; the character/file budgets are
 * rovecode's own.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

export interface ContextSource {
  /** Display path relative to cwd, "/"-separated with one "../" segment per
   *  ancestor level — used verbatim in the rendered "## From <path>" header. */
  path: string;
  family: "rovecode" | "agents" | "claude" | "gemini" | "cursor" | "copilot";
  chars: number;
  truncated: boolean;
}

export interface ProjectContext {
  text: string;
  sources: ContextSource[];
  /** Existing candidate files that were NOT read because the `maxFiles`
   *  bound was already reached (surfaced in /status, never silent). */
  skippedFiles: number;
}

export interface LoadOptions {
  /** Per-file cap in characters. Default 8000. */
  maxPerFileChars?: number;
  /** Total cap on the rendered text (headers included). Default 24000. */
  maxTotalChars?: number;
  /** Max files included across the walk. Default 24. */
  maxFiles?: number;
  /** Inclusive upper bound for the ancestor walk (tests/embedders). */
  stopAt?: string;
}

const DEFAULT_MAX_PER_FILE_CHARS = 8000;
const DEFAULT_MAX_TOTAL_CHARS = 24000;
const DEFAULT_MAX_FILES = 24;
const TRUNCATION_MARKER = "…[truncated]";

type Family = ContextSource["family"];

interface Candidate {
  /** Path relative to its directory, "/"-separated regardless of host OS. */
  relPath: string;
  family: Family;
  /** Strip a leading MDC frontmatter block before treating this as content. */
  mdc: boolean;
}

/** Harvest list for ONE directory, in family precedence order (first =
 *  highest): rovecode > agents > claude > gemini > cursor > copilot. */
function buildCandidates(dir: string): Candidate[] {
  const candidates: Candidate[] = [
    { relPath: ".rovecode/ROVECODE.md", family: "rovecode", mdc: false },
    { relPath: "ROVECODE.md", family: "rovecode", mdc: false },
    { relPath: "AGENTS.md", family: "agents", mdc: false },
    { relPath: "CLAUDE.md", family: "claude", mdc: false },
    { relPath: ".claude/CLAUDE.md", family: "claude", mdc: false },
    { relPath: "GEMINI.md", family: "gemini", mdc: false },
    { relPath: ".cursorrules", family: "cursor", mdc: false },
  ];
  for (const name of listCursorRuleFiles(dir)) {
    candidates.push({ relPath: `.cursor/rules/${name}`, family: "cursor", mdc: true });
  }
  candidates.push({ relPath: ".github/copilot-instructions.md", family: "copilot", mdc: false });
  return candidates;
}

/** cwd upward: dirname until parent === current (filesystem root), stopping
 *  inclusively at `stopAt` or at the first dir containing `.git` (file or
 *  directory — git worktrees use a file). OMP `getAncestorDirs` pattern. */
function ancestorDirs(cwd: string, stopAt?: string): string[] {
  const dirs: string[] = [];
  const stop = stopAt === undefined ? null : resolve(stopAt);
  let current = resolve(cwd);
  for (;;) {
    dirs.push(current);
    if (stop !== null && current === stop) break;
    if (hasGitMarker(current)) break; // repo root — inclusive, never above
    const parent = dirname(current);
    if (parent === current) break;    // filesystem root
    current = parent;
  }
  return dirs;
}

/** `.git` presence, or false on any fs error (permissions, bad path, …). */
function hasGitMarker(dir: string): boolean {
  try {
    return existsSync(join(dir, ".git"));
  } catch {
    return false;
  }
}

/** `.cursor/rules/*.mdc`, sorted by filename. A missing/unreadable directory
 *  yields no entries — silent skip, never a throw. */
function listCursorRuleFiles(dir: string): string[] {
  try {
    const entries = readdirSync(join(dir, ".cursor", "rules"), { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith(".mdc"))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/** Read a file's content, or null on any failure (missing, unreadable, is a
 *  directory, …) — every failure mode is a silent skip, never a throw. */
function tryReadFile(absPath: string): string | null {
  try {
    return readFileSync(absPath, "utf8");
  } catch {
    return null;
  }
}

/** existsSync that can never throw (used only for `skippedFiles` counting). */
function fileExists(absPath: string): boolean {
  try {
    return existsSync(absPath);
  } catch {
    return false;
  }
}

/** Strip a leading `---\n...\n---` MDC frontmatter block, if present. */
function stripMdcFrontmatter(content: string): string {
  const lines = content.split("\n");
  if ((lines[0] ?? "").trim() !== "---") return content;
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if ((lines[i] ?? "").trim() === "---") {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) return content;
  return lines.slice(endIdx + 1).join("\n").replace(/^\n+/, "");
}

/** Fence-safe truncation: cut at the last newline inside the window (whole
 *  lines only; hard cut when the window has no interior newline), close an
 *  odd ``` fence count so following sections aren't swallowed by an open
 *  code block, then append the marker. */
function truncateSafely(full: string, maxChars: number): string {
  const window = full.slice(0, maxChars);
  const nl = window.lastIndexOf("\n");
  const cut = nl > 0 ? window.slice(0, nl) : window;
  const fences = cut.split("\n").filter((l) => l.trimStart().startsWith("```")).length;
  return fences % 2 === 1 ? `${cut}${TRUNCATION_MARKER}\n\`\`\`` : cut + TRUNCATION_MARKER;
}

interface KeptFile {
  /** cwd-relative display path: "../" per ancestor level + relPath. */
  displayPath: string;
  family: Family;
  /** Content after per-file truncation (includes the marker when truncated). */
  content: string;
  truncated: boolean;
}

/**
 * Load and merge instruction files from every supported harness convention
 * found in `cwd` and its ancestors (see module doc for the walk, precedence,
 * shadowing, and budget rules). Deterministic: identical tree contents always
 * produce the same `text` and `sources`, in the same order.
 */
export function loadProjectContext(cwd: string, opts?: LoadOptions): ProjectContext {
  const maxPerFileChars = opts?.maxPerFileChars ?? DEFAULT_MAX_PER_FILE_CHARS;
  const maxTotalChars = opts?.maxTotalChars ?? DEFAULT_MAX_TOTAL_CHARS;
  const maxFiles = opts?.maxFiles ?? DEFAULT_MAX_FILES;

  const seenContent = new Set<string>();
  const shadowed = new Set<string>();   // relPaths claimed by a nearer non-blank file
  const kept: KeptFile[] = [];
  let skippedFiles = 0;

  const dirs = ancestorDirs(cwd, opts?.stopAt);
  for (let depth = 0; depth < dirs.length; depth++) {
    const dir = dirs[depth]!;
    for (const candidate of buildCandidates(dir)) {
      if (shadowed.has(candidate.relPath)) continue;   // nearest wins (dedupe by depth)
      const absPath = join(dir, candidate.relPath);
      if (kept.length >= maxFiles) {
        // file-count bound (HIGH-3): count existing candidates, never read them
        if (fileExists(absPath)) skippedFiles++;
        continue;
      }
      const raw = tryReadFile(absPath);
      if (raw === null) continue; // missing or unreadable — skip silently

      const full = candidate.mdc ? stripMdcFrontmatter(raw) : raw;
      if (full.trim() === "") continue; // blank: no section/dedupe/shadow (LOW-6)
      shadowed.add(candidate.relPath);

      if (seenContent.has(full)) continue; // byte-identical dupe: earlier one won
      seenContent.add(full);

      let content = full;
      let truncated = false;
      if (full.length > maxPerFileChars) {
        content = truncateSafely(full, maxPerFileChars);
        truncated = true;
      }
      kept.push({
        displayPath: "../".repeat(depth) + candidate.relPath,
        family: candidate.family, content, truncated,
      });
    }
  }

  // Total cap enforced in precedence order over the FULL section string —
  // header included, so `text.length <= maxTotalChars` always holds. A file
  // that would exceed the budget is dropped from `text` but stays listed in
  // `sources` as a chars:0/truncated:true stub so callers can see what was
  // cut, and why the surviving text is short.
  const sources: ContextSource[] = [];
  const sections: string[] = [];
  let total = 0;
  for (const file of kept) {
    const section = `\n\n## From ${file.displayPath}\n${file.content}`;
    if (total + section.length <= maxTotalChars) {
      sources.push({ path: file.displayPath, family: file.family, chars: file.content.length, truncated: file.truncated });
      sections.push(section);
      total += section.length;
    } else {
      sources.push({ path: file.displayPath, family: file.family, chars: 0, truncated: true });
    }
  }

  return { text: sections.join(""), sources, skippedFiles };
}
