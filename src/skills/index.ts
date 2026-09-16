/** Skills module (hermes pattern): SKILL.md files with frontmatter index,
 *  mtime+size manifest invalidation, usage sidecars, deterministic staleness.
 *  No LLM consolidation — lifecycle is a pure function of usage age.
 *
 *  agentskills.io shape (port #72): the frontmatter block is still read by parseFrontmatter below — which folds
 *  `>`/`|` block scalars, the form 3 of the 19 anthropics/skills descriptions are written in — and the FIELDS are
 *  then validated by spec.ts validateSkillMeta in LENIENT mode: an unreadable file, a missing block and an
 *  empty/missing description are INVALID (not loaded); every other spec deviation — a description over 1024 chars,
 *  a missing or non-conforming name, name ≠ directory, compatibility over 500, a non-string metadata value, an
 *  unknown key — LOADS with a line in ScanResult.warnings. Before that, such a file either loaded silently wrong or
 *  vanished from the index with nothing said. A missing `name:` falls back to the directory name.
 *
 *  A directory holding SKILL.md is a LEAF: find() does not descend into it, so a skill's own
 *  `references/example/SKILL.md` is not a second indexed skill (it used to be, which let a skill that merely
 *  documents itself inflate the prompt index). Dot-dirs are skipped, which is also what keeps the installer's
 *  `.install-<token>` / `.old-<token>` staging invisible to a concurrent scan (pack.ts).
 *
 *  Trust, stated as a DECISION and not an omission: a project `.rovecode/skills/` is walked whether or not the
 *  checkout is trusted. This repository's trust gate (core/trust.ts) exists to stop a cloned repo from making us
 *  RUN code — hooks, sandbox.json, the command-bearing settings keys, project MCP servers — and a skill is prompt
 *  text, which is a different class of problem. What is still open, and should be written down rather than implied:
 *  a cloned repo's skill DESCRIPTIONS do reach the system prompt through the index, so this is a prompt-injection
 *  path, and `.rovecode/memory/MEMORY.md` is the same path by another route. Both want ONE answer (withhold from the
 *  prompt with a boot note, self-trusting our own writes) rather than two half-answers in one binary, so the seam is
 *  here — SkillStoreOptions.walkProject — and deliberately not wired to anything yet. `allowed-tools` is likewise
 *  parsed and carried as DATA: nothing enforces it, and skills-spec.test.ts pins that, because a field that reads
 *  like a permission is one refactor away from being a security claim we never implemented. */

import {
  existsSync, readFileSync, readdirSync, renameSync, statSync, utimesSync, writeFileSync,
} from "node:fs";
import { rovecodeHome } from "../providers/auth.ts";
import { basename, dirname, join, resolve } from "node:path";
import { parseSkillFrontmatter, validateSkillMeta, type SkillFrontmatter } from "./spec.ts";

/** The spec view of a file parseFrontmatter already read: its flat fields (block scalars folded) with the
 *  shapes and the `metadata:` map that only the spec walker can see. The two readers agree on every flat
 *  key; where they differ — an indented `metadata:` map, a list — the spec walker is the one that knows. */
function specViewOf(fm: Record<string, string>, raw: string): SkillFrontmatter {
  const spec = parseSkillFrontmatter(raw);
  const fields = { ...(spec?.fields ?? {}), ...fm }; // parseFrontmatter wins on flat values (its block-scalar folding)
  return {
    fields,
    shapes: spec?.shapes ?? Object.fromEntries(Object.keys(fm).map((k) => [k, "scalar" as const])),
    metadata: spec?.metadata ?? {},
    metadataNonString: spec?.metadataNonString ?? [],
    body: spec?.body ?? "",
  };
}

export const SKILL_FILE = "SKILL.md";
/** the two per-skill sidecars (usage below; the versioned.ts edit ledger) — never resources, never packed */
export const SIDECAR_SUFFIXES: readonly string[] = [".usage.json", ".versions.jsonl"];
export const isSidecarName = (name: string): boolean => SIDECAR_SUFFIXES.some((x) => name.endsWith(x));
export const MAX_DESCRIPTION_CHARS = 60;
export const STALE_AFTER_MS = 1000 * 60 * 60 * 24 * 90; // 90 days

export type SkillScope = "project" | "global";

export interface Skill {
  name: string;
  /** one line for the system-prompt index: clipped to MAX_DESCRIPTION_CHARS on a word boundary */
  description: string;
  /** the description as written, however long — what `skill_view` and the market show */
  fullDescription: string;
  /** top-level `version`, else `metadata.version`, else "0.0.0" */
  version: string;
  /** absolute path of the SKILL.md */
  path: string;
  /** absolute skill directory — relative paths inside the skill resolve against it */
  dir: string;
  /** content after the frontmatter block */
  body: string;
  scope: SkillScope;
  mtimeMs: number;
  size: number;
  license?: string;
  compatibility?: string;
  /** the `metadata:` map (string → string) */
  metadata: Record<string, string>;
  /** `allowed-tools` whitespace-split — DATA ONLY: nothing enforces it (see the header) */
  allowedTools: string[];
}

export interface InvalidSkill { path: string; reason: string }
/** a skill that LOADED with a spec deviation (lenient mode) */
export interface SkillWarning { path: string; reason: string }

export interface SkillUsage {
  viewCount: number;
  lastViewedAt: number;
}

export interface ScanChanges {
  added: string[];
  removed: string[];
  changed: string[];
}

const IGNORED_DIRS: Record<string, true> = { node_modules: true, ".git": true };
export interface ScanResult {
  skills: Skill[];
  invalid: InvalidSkill[];
  /** loaded-with-warning files of this scan (added / changed only, like `invalid`) */
  warnings: SkillWarning[];
  changes: ScanChanges;
}

/** The skills dir of a scope: `<cwd>/.rovecode/skills` or `<user home>/skills` (ROVECODE_HOME honoured).
 *  The ONE place the two joins live, so the CLI and the store cannot disagree (mcpConfigPath precedent). */
export function skillsDir(cwd: string, scope: SkillScope): string {
  return scope === "project" ? join(cwd, ".rovecode", "skills") : join(rovecodeHome(), "skills");
}

export interface SkillStoreOptions {
  /** project skills dir (default: <cwd>/.rovecode/skills) */
  projectDir?: string;
  /** global skills dir; null disables (default: ~/.rovecode/skills) */
  globalDir?: string | null;
  /** max directory depth when walking for SKILL.md (default 3) */
  maxDepth?: number;
  /** the seam named in the header: false leaves the project dir out of every scan. Nothing sets it today —
   *  skills are prompt text, and the trust gate is about running code. Default true. */
  walkProject?: boolean;
  /** more roots — a plugin's skills folder (src/plugins) — walked like the two above, tagged with the
   *  scope the plugin itself has (a project plugin's skills win a name clash as the project's own would) */
  extraDirs?: readonly { dir: string; scope: SkillScope }[];
}

// ---------- Frontmatter ----------

/** Split `---\nkey: value` frontmatter from body. Returns null when no block.
 *
 *  Values may be a plain scalar, or a YAML block scalar — `key: >` / `|` / `>-` / `|-` followed by
 *  more-indented lines, which real SKILL.md files use for anything longer than a phrase. Measured on
 *  anthropics/skills (2026-09-05): 3 of 19 skills write their description that way, and reading only
 *  the header line gave `description: ">"` — not an error, just a skill whose one-line summary is a
 *  punctuation mark, with its continuation lines mistaken for keys of their own. That is worse than
 *  rejecting it, because nothing says anything went wrong. Folded (`>`) joins its lines with a space,
 *  literal (`|`) keeps the newlines, a trailing `-` strips the final newline. The rest of YAML —
 *  anchors, nested maps, lists — is still out of scope: this is a frontmatter reader, not a parser. */
export function parseFrontmatter(text: string): { fm: Record<string, string>; body: string } | null {
  if (!text.startsWith("---")) return null;
  const end = text.indexOf("\n---", 3);
  if (end === -1) return null;
  const closeEnd = end + 1 + text.slice(end + 1).indexOf("\n") + 1; // past the closing `---` line
  const block = text.slice(4, end); // skip leading `---\n`
  const body = text.slice(closeEnd).replace(/^\r?\n/, "");
  const fm: Record<string, string> = {};
  const lines = block.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (/^\s/.test(line)) continue;                 // an orphan continuation is not a key of its own
    const c = line.indexOf(":");
    if (c === -1) continue;
    const k = line.slice(0, c).trim();
    if (!k) continue;
    const rest = line.slice(c + 1).trim();
    const m = /^([|>])([+-]?)$/.exec(rest);
    if (m === null) { fm[k] = rest.replace(/^["']|["']$/g, ""); continue; }
    const folded = m[1] === ">";
    const owned: string[] = [];
    while (i + 1 < lines.length) {
      const next = lines[i + 1] as string;
      if (next.trim() !== "" && !/^\s/.test(next)) break;   // back to column 0: the block ended
      owned.push(next.replace(/^\s+/, ""));
      i++;
    }
    while (owned.length > 0 && owned[owned.length - 1] === "") owned.pop();
    fm[k] = folded ? owned.join(" ").replace(/\s+/g, " ").trim() : owned.join("\n");
  }
  return { fm, body };
}

/** Clip to the index budget on a word boundary, with an ellipsis so a reader can tell it was cut. */
export function clipDescription(text: string): string {
  const one = text.replace(/\s+/g, " ").trim();
  if (one.length <= MAX_DESCRIPTION_CHARS) return one;
  const cut = one.slice(0, MAX_DESCRIPTION_CHARS - 1);
  const sp = cut.lastIndexOf(" ");
  return `${(sp > MAX_DESCRIPTION_CHARS / 2 ? cut.slice(0, sp) : cut).replace(/[,;:.]$/, "")}…`;
}

/** Lenient load: `invalid` only for an unreadable file, a missing block or an empty description; every other
 *  spec deviation is a warning and the skill loads (see the header). */
function parseSkillFile(path: string, scope: SkillScope): { skill: Skill; warnings: string[] } | { invalid: InvalidSkill } {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    return { invalid: { path, reason: `unreadable: ${(e as Error).message}` } };
  }
  const parsed = parseFrontmatter(text);
  if (!parsed) return { invalid: { path, reason: "missing frontmatter block" } };
  const dir = dirname(path);
  // the spec field set over the SAME reader as before: parseFrontmatter's flat map plus its block scalars,
  // spec.ts's `metadata:` walk for the nested map, then the lenient checks
  const v = validateSkillMeta(specViewOf(parsed.fm, text), basename(dir), "lenient");
  if (v.errors.length > 0) return { invalid: { path, reason: v.errors.join("; ") } };
  const description = v.meta.description;
  // A long description is CLIPPED for the index, never a reason to reject the skill. The cap exists to
  // protect the system prompt (50 skills x a 950-char description is 47 KB of prefix), and clipping
  // protects it just as well while a hard reject throws away a working skill for being wordy. Measured
  // on anthropics/skills (2026-09-05): 16 of 19 real skills are over the cap, median 319 chars, longest
  // 950 — the whole public corpus would have been unusable. The two other places rovecode reads a
  // description already clip (plugins/manifest.ts, tui/commands.ts); this was the outlier.
  const st = statSync(path);
  return {
    skill: {
      name: v.meta.name,
      description: clipDescription(description),
      fullDescription: description,
      version: v.meta.version || "0.0.0",
      path, dir, body: parsed.body, scope,
      mtimeMs: st.mtimeMs, size: st.size,
      ...(v.meta.license !== undefined ? { license: v.meta.license } : {}),
      ...(v.meta.compatibility !== undefined ? { compatibility: v.meta.compatibility } : {}),
      metadata: v.meta.metadata,
      allowedTools: v.meta.allowedTools,
    },
    warnings: v.warnings,
  };
}

// ---------- Usage sidecar ----------

export function usagePath(skillFile: string): string {
  return skillFile + ".usage.json";
}

export function readUsage(skillFile: string): SkillUsage | undefined {
  const p = usagePath(skillFile);
  if (!existsSync(p)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<SkillUsage>;
    return {
      viewCount: typeof raw.viewCount === "number" ? raw.viewCount : 0,
      lastViewedAt: typeof raw.lastViewedAt === "number" ? raw.lastViewedAt : 0,
    };
  } catch {
    return undefined; // corrupt sidecar → treat as never used
  }
}

/** Atomic write: temp file + rename, so a concurrent reader never sees a partial sidecar. */
export function writeUsageAtomic(skillFile: string, usage: SkillUsage): void {
  const p = usagePath(skillFile);
  const tmp = p + ".tmp";
  writeFileSync(tmp, JSON.stringify(usage, null, 2));
  renameSync(tmp, p);
}

// ---------- Lifecycle ----------

/** Deterministic: stale when last view (or, never viewed, file mtime) is older than 90d. */
export function skillLifecycle(
  skill: Pick<Skill, "mtimeMs">,
  usage: SkillUsage | undefined,
  now: number,
): "active" | "stale" {
  const lastActivity = usage && usage.viewCount > 0 ? usage.lastViewedAt : skill.mtimeMs;
  return now - lastActivity > STALE_AFTER_MS ? "stale" : "active";
}

// ---------- Store ----------

export class SkillStore {
  private readonly projectDir: string;
  private readonly globalDir: string | null;
  private readonly maxDepth: number;
  /** path → parsed skill (cache valid while manifest matches) */
  private cache = new Map<string, Skill>();
  /** path → `mtimeMs:size` (hermes manifest invalidation) */
  private manifest = new Map<string, string>();

  constructor(readonly cwd: string, opts: SkillStoreOptions = {}) {
    this.projectDir = resolve(cwd, opts.projectDir ?? join(".rovecode", "skills"));
    this.globalDir = opts.globalDir === null
      ? null
      // rovecodeHome(), not homedir(): ROVECODE_HOME is how every other part of rovecode finds its
      // config — hooks, settings, plugins, credentials — and skills were the one that ignored it. So a
      // user who set it read skills from a directory nothing else used, and every test that isolates
      // itself with a scratch home silently indexed the DEVELOPER's real skills instead. That is how
      // this was found: installing one skill into a real home broke a plugin test that never touches
      // skills, and the failure named a skill the test had never heard of.
      : resolve(opts.globalDir ?? join(rovecodeHome(), "skills"));
    this.maxDepth = opts.maxDepth ?? 3;
    this.walkProject = opts.walkProject !== false;
    this.extraDirs = (opts.extraDirs ?? []).map(({ dir, scope }) => [resolve(cwd, dir), scope]);
  }
  private readonly extraDirs: Array<[string, SkillScope]>;
  private readonly walkProject: boolean;

  private dirs(): Array<[string, SkillScope]> {
    const d: Array<[string, SkillScope]> = this.walkProject ? [[this.projectDir, "project"]] : [];
    if (this.globalDir && existsSync(this.globalDir)) d.push([this.globalDir, "global"]);
    for (const [dir, scope] of this.extraDirs) if (existsSync(dir)) d.push([dir, scope]);
    return d;
  }

  private find(root: string, dir: string = root, depth: number = 0): string[] {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    // A dir holding SKILL.md is a LEAF: its sub-dirs are that skill's own resources, never skills of their own.
    if (entries.some((e) => e.isFile() && e.name === SKILL_FILE)) return [join(dir, SKILL_FILE)];
    const found: string[] = [];
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isFile() && e.name === SKILL_FILE) found.push(p);
      else if (e.isDirectory() && depth < this.maxDepth && !IGNORED_DIRS[e.name] && !e.name.startsWith(".")) {
        found.push(...this.find(root, p, depth + 1));
      }
    }
    return found;
  }

  /** Rescan: stat every SKILL.md, diff the manifest, reparse only added/changed files. */
  scan(): ScanResult {
    const next = new Map<string, string>();
    const scopeOf = new Map<string, SkillScope>(); // by root, not by path prefix: a plugin's project skills live outside <cwd>/.rovecode/skills
    for (const [dir, scope] of this.dirs()) {
      for (const p of this.find(dir)) {
        try {
          const st = statSync(p);
          next.set(p, `${st.mtimeMs}:${st.size}`);
          if (!scopeOf.has(p)) scopeOf.set(p, scope);
        } catch { /* vanished between readdir and stat */ }
      }
    }
    const changes: ScanChanges = { added: [], removed: [], changed: [] };
    for (const [p, sig] of next) {
      if (!this.manifest.has(p)) changes.added.push(p);
      else if (this.manifest.get(p) !== sig) changes.changed.push(p);
    }
    for (const p of this.manifest.keys()) if (!next.has(p)) changes.removed.push(p);

    const invalid: InvalidSkill[] = [];
    const warnings: SkillWarning[] = [];
    for (const p of [...changes.added, ...changes.changed]) {
      const scope = scopeOf.get(p) ?? (p.startsWith(this.projectDir) ? "project" : "global");
      const r = parseSkillFile(p, scope);
      if ("skill" in r) {
        this.cache.set(p, r.skill);
        for (const reason of r.warnings) warnings.push({ path: p, reason });
      } else { this.cache.delete(p); invalid.push(r.invalid); }
    }
    for (const p of changes.removed) this.cache.delete(p);
    this.manifest = next;
    return { skills: this.list(), invalid, warnings, changes };
  }

  /** Project scope wins on name collisions with the global dir. */
  list(): Skill[] {
    const byName = new Map<string, Skill>();
    for (const s of this.cache.values()) {
      const prev = byName.get(s.name);
      if (!prev || (prev.scope === "global" && s.scope === "project")) byName.set(s.name, s);
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string): Skill | undefined {
    return this.list().find((s) => s.name === name);
  }

  usage(name: string): SkillUsage | undefined {
    const s = this.get(name);
    return s ? readUsage(s.path) : undefined;
  }

  /** Record one view. Returns the updated sidecar contents. */
  bumpUsage(skill: Skill, now: number = Date.now()): SkillUsage {
    const prev = readUsage(skill.path);
    const usage: SkillUsage = { viewCount: (prev?.viewCount ?? 0) + 1, lastViewedAt: now };
    writeUsageAtomic(skill.path, usage);
    return usage;
  }
}

/** Touch a skill file's mtime (same size) so manifest invalidation is observable in tests. */
export function touchSkillFile(path: string, at: Date = new Date()): void {
  utimesSync(path, at, at);
}
