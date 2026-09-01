/**
 * Project context inheritance: auto-import instruction files from other
 * coding-agent "harnesses" (Claude, Gemini, Cursor, Copilot, plain AGENTS.md)
 * so aion projects don't need to duplicate repo conventions per tool.
 *
 * Pattern + precedence order modeled on oh-my-pi's context-file discovery
 * (E:\9code\research\source_snapshots\can1357-oh-my-pi):
 *   - docs/context-files.md, "Other supported context conventions" and
 *     "Load order and shadowing" tables — the provider-priority idea
 *     (higher priority wins at a shared scope) and the per-tool path
 *     conventions: AGENTS.md, CLAUDE.md / .claude/CLAUDE.md, GEMINI.md,
 *     .cursor/rules/*.mdc + legacy .cursorrules, .github/copilot-instructions.md.
 *   - packages/coding-agent/src/discovery/cursor.ts — `.cursor/rules/*.mdc`
 *     carries MDC frontmatter that must be separated from the rule body
 *     (`transformMDCRule` / `buildRuleFromMarkdown`).
 *   - packages/coding-agent/src/discovery/github.ts — copilot-instructions.md
 *     lives at a fixed `.github/` path with no ancestor walk-up.
 *
 * Deliberate deviations from OMP (this is a simplified, single-cwd port,
 * not a full port of OMP's discovery system):
 *   - No ancestor walk-up / monorepo "depth" concept — OMP walks from cwd
 *     toward the repo root and tracks a directory depth per file; aion only
 *     looks directly inside `cwd`.
 *   - No provider-priority shadowing ("one file per scope wins"). Instead,
 *     every existing candidate path is loaded, and the only collapsing rule
 *     is byte-identical content dedup (earlier in precedence order wins).
 *     Simpler than OMP's real depth+priority shadowing table.
 *   - OMP's cursor provider treats `.cursor/rules/*.mdc` as conditional
 *     *rules* (globs/alwaysApply/description parsed from frontmatter and
 *     acted on) and does not surface them as context files at all. Here
 *     they are harvested unconditionally as plain context text; frontmatter
 *     is stripped, never parsed/acted on.
 *   - OMP's cursor provider also accepts `.md` alongside `.mdc` under
 *     `.cursor/rules/`; this harvest is restricted to `*.mdc` only, per the
 *     family's own spec.
 *   - The hard character budget (`maxPerFileChars` / `maxTotalChars`) is
 *     aion-specific. OMP has no cap on context-file loading at all; its
 *     only budget concept lives in the unrelated memory subsystem
 *     (docs/memory.md `memories.summaryInjectionTokenLimit`).
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface ContextSource {
  path: string;
  family: "aion" | "agents" | "claude" | "gemini" | "cursor" | "copilot";
  chars: number;
  truncated: boolean;
}

export interface ProjectContext {
  text: string;
  sources: ContextSource[];
}

export interface LoadOptions {
  /** Per-file cap in characters. Default 8000. */
  maxPerFileChars?: number;
  /** Total cap across all included files, in characters. Default 24000. */
  maxTotalChars?: number;
}

const DEFAULT_MAX_PER_FILE_CHARS = 8000;
const DEFAULT_MAX_TOTAL_CHARS = 24000;
const TRUNCATION_MARKER = "…[truncated]";

type Family = ContextSource["family"];

interface Candidate {
  /** Path relative to cwd, "/"-separated regardless of host OS — used
   *  verbatim as ContextSource.path and in the rendered "## From <path>"
   *  header, so output stays deterministic across platforms. */
  relPath: string;
  family: Family;
  /** Strip a leading MDC frontmatter block before treating this as content. */
  mdc: boolean;
}

/**
 * Harvest list in precedence order (first = highest; wins dedupe and total-
 * cap priority): aion > agents > claude > gemini > cursor > copilot. This is
 * aion's own harvest spec, not OMP's real priority table (see module doc).
 */
function buildCandidates(cwd: string): Candidate[] {
  const candidates: Candidate[] = [
    { relPath: ".aion/AION.md", family: "aion", mdc: false },
    { relPath: "AION.md", family: "aion", mdc: false },
    { relPath: "AGENTS.md", family: "agents", mdc: false },
    { relPath: "CLAUDE.md", family: "claude", mdc: false },
    { relPath: ".claude/CLAUDE.md", family: "claude", mdc: false },
    { relPath: "GEMINI.md", family: "gemini", mdc: false },
    { relPath: ".cursorrules", family: "cursor", mdc: false },
  ];
  for (const name of listCursorRuleFiles(cwd)) {
    candidates.push({ relPath: `.cursor/rules/${name}`, family: "cursor", mdc: true });
  }
  candidates.push({ relPath: ".github/copilot-instructions.md", family: "copilot", mdc: false });
  return candidates;
}

/** `.cursor/rules/*.mdc`, sorted by filename. A missing/unreadable directory
 *  yields no entries — silent skip, never a throw. */
function listCursorRuleFiles(cwd: string): string[] {
  try {
    const entries = readdirSync(join(cwd, ".cursor", "rules"), { withFileTypes: true });
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

/** Strip a leading `---\n...\n---` MDC frontmatter block, if present.
 *  Content that doesn't open with a `---` delimiter line, or never closes
 *  one, is returned unchanged. */
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

interface KeptFile {
  relPath: string;
  family: Family;
  /** Content after per-file truncation (includes the marker when truncated). */
  content: string;
  truncated: boolean;
}

/**
 * Load and merge instruction files from every supported harness convention
 * found directly under `cwd`. Deterministic: identical directory contents
 * always produce the same `text` and `sources`, in the same order.
 */
export function loadProjectContext(cwd: string, opts?: LoadOptions): ProjectContext {
  const maxPerFileChars = opts?.maxPerFileChars ?? DEFAULT_MAX_PER_FILE_CHARS;
  const maxTotalChars = opts?.maxTotalChars ?? DEFAULT_MAX_TOTAL_CHARS;

  const seen = new Set<string>();
  const kept: KeptFile[] = [];

  for (const candidate of buildCandidates(cwd)) {
    const raw = tryReadFile(join(cwd, candidate.relPath));
    if (raw === null) continue; // missing or unreadable — skip silently

    const full = candidate.mdc ? stripMdcFrontmatter(raw) : raw;

    // Byte-identical content across families/paths is included once; the
    // earlier (higher-precedence) candidate wins and later duplicates are
    // skipped entirely — they never reach `sources`, unlike total-cap drops
    // below, which keep a stub entry.
    if (seen.has(full)) continue;
    seen.add(full);

    let content = full;
    let truncated = false;
    if (full.length > maxPerFileChars) {
      content = full.slice(0, maxPerFileChars) + TRUNCATION_MARKER;
      truncated = true;
    }
    kept.push({ relPath: candidate.relPath, family: candidate.family, content, truncated });
  }

  // Total cap enforced in precedence order: each kept file is included in
  // full if it still fits the remaining budget; otherwise it is dropped from
  // `text` but stays listed in `sources` as a chars:0/truncated:true stub so
  // callers can see what was cut, and why the surviving text is short.
  const sources: ContextSource[] = [];
  const sections: string[] = [];
  let total = 0;
  for (const file of kept) {
    const chars = file.content.length;
    if (total + chars <= maxTotalChars) {
      sources.push({ path: file.relPath, family: file.family, chars, truncated: file.truncated });
      sections.push(`\n\n## From ${file.relPath}\n${file.content}`);
      total += chars;
    } else {
      sources.push({ path: file.relPath, family: file.family, chars: 0, truncated: true });
    }
  }

  return { text: sections.join(""), sources };
}
