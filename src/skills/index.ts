/** Skills module (hermes pattern): SKILL.md files with frontmatter index,
 *  mtime+size manifest invalidation, usage sidecars, deterministic staleness.
 *  No LLM consolidation — lifecycle is a pure function of usage age. */

import {
  existsSync, readFileSync, readdirSync, renameSync, statSync, utimesSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const SKILL_FILE = "SKILL.md";
export const MAX_DESCRIPTION_CHARS = 60;
export const STALE_AFTER_MS = 1000 * 60 * 60 * 24 * 90; // 90 days

export type SkillScope = "project" | "global";

export interface Skill {
  name: string;
  description: string;
  version: string;
  /** absolute path of the SKILL.md */
  path: string;
  /** content after the frontmatter block */
  body: string;
  scope: SkillScope;
  mtimeMs: number;
  size: number;
}

export interface InvalidSkill { path: string; reason: string }

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
  changes: ScanChanges;
}

export interface SkillStoreOptions {
  /** project skills dir (default: <cwd>/.rovecode/skills) */
  projectDir?: string;
  /** global skills dir; null disables (default: ~/.rovecode/skills) */
  globalDir?: string | null;
  /** max directory depth when walking for SKILL.md (default 3) */
  maxDepth?: number;
  /** more roots — a plugin's skills folder (src/plugins) — walked like the two above, tagged with the
   *  scope the plugin itself has (a project plugin's skills win a name clash as the project's own would) */
  extraDirs?: readonly { dir: string; scope: SkillScope }[];
}

// ---------- Frontmatter ----------

/** Split `---\nkey: value` frontmatter from body. Returns null when no block. */
export function parseFrontmatter(text: string): { fm: Record<string, string>; body: string } | null {
  if (!text.startsWith("---")) return null;
  const end = text.indexOf("\n---", 3);
  if (end === -1) return null;
  const closeEnd = end + 1 + text.slice(end + 1).indexOf("\n") + 1; // past the closing `---` line
  const block = text.slice(4, end); // skip leading `---\n`
  const body = text.slice(closeEnd).replace(/^\r?\n/, "");
  const fm: Record<string, string> = {};
  for (const line of block.split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i === -1) continue;
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    if (k) fm[k] = v;
  }
  return { fm, body };
}

function parseSkillFile(path: string, scope: SkillScope): { skill: Skill } | { invalid: InvalidSkill } {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    return { invalid: { path, reason: `unreadable: ${(e as Error).message}` } };
  }
  const parsed = parseFrontmatter(text);
  if (!parsed) return { invalid: { path, reason: "missing frontmatter block" } };
  const name = parsed.fm["name"] ?? "";
  const description = parsed.fm["description"] ?? "";
  if (!name) return { invalid: { path, reason: "frontmatter missing name" } };
  if (!description) return { invalid: { path, reason: "frontmatter missing description" } };
  if (description.length > MAX_DESCRIPTION_CHARS) {
    return { invalid: { path, reason: `description is ${description.length} chars (max ${MAX_DESCRIPTION_CHARS})` } };
  }
  const st = statSync(path);
  return {
    skill: {
      name, description,
      version: parsed.fm["version"] ?? "0.0.0",
      path, body: parsed.body, scope,
      mtimeMs: st.mtimeMs, size: st.size,
    },
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
      : resolve(opts.globalDir ?? join(homedir(), ".rovecode", "skills"));
    this.maxDepth = opts.maxDepth ?? 3;
    this.extraDirs = (opts.extraDirs ?? []).map(({ dir, scope }) => [resolve(cwd, dir), scope]);
  }
  private readonly extraDirs: Array<[string, SkillScope]>;

  private dirs(): Array<[string, SkillScope]> {
    const d: Array<[string, SkillScope]> = [[this.projectDir, "project"]];
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
    const found: string[] = [];
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isFile() && e.name === SKILL_FILE) found.push(p);
      else if (e.isDirectory() && depth < this.maxDepth && !IGNORED_DIRS[e.name]) {
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
    for (const p of [...changes.added, ...changes.changed]) {
      const scope = scopeOf.get(p) ?? (p.startsWith(this.projectDir) ? "project" : "global");
      const r = parseSkillFile(p, scope);
      if ("skill" in r) this.cache.set(p, r.skill);
      else { this.cache.delete(p); invalid.push(r.invalid); }
    }
    for (const p of changes.removed) this.cache.delete(p);
    this.manifest = next;
    return { skills: this.list(), invalid, changes };
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
