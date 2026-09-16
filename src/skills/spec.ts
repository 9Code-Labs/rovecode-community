/** agentskills.io-compatible SKILL.md frontmatter (port #72): the spec field set, a lenient | strict validator and
 *  the skill-specific frontmatter walker. Pattern sources (no code copied): pi packages/coding-agent/src/core/skills.ts
 *  (MIT — validateName :92-115, validateDescription :117-127, warn-and-load :276-345, name → parent-dir fallback :319),
 *  opencode-2026 skill/index.ts:53-59 (MIT — type-only checks; unknown fields ignored, skills.mdx:45), hermes
 *  agent/skill_utils.py:1182-1198 (MIT — the 60-char cut was a PROMPT truncation, never a load rule). The field set
 *  and limits follow the agentskills.io specification (verified 2026-09-04): name ≤ 64, lower-case [a-z0-9] joined by
 *  single hyphens, equal to the parent directory; description 1–1024; compatibility ≤ 500; metadata string → string;
 *  allowed-tools one space-separated string (experimental — parsed as DATA, never enforced). The spec defines NO
 *  archive format and says nothing about unknown keys: rovecode warns once and loads (`version` is its own known key).
 *
 *  Why a second walker beside index.ts parseFrontmatter: that helper drops every colon-less line — core/agents.ts
 *  checkFrontmatterLines and tui/commands.ts depend on exactly that, so it stays byte-identical — and therefore
 *  cannot carry an indented `metadata:` map or a `>` / `|` block-scalar description. parseSkillFrontmatter reads the
 *  flat `key: value` files the old loader read the same way (same quote strip, same body slice) and additionally:
 *  nested pairs under `metadata:` become the metadata map; indented lines under any other key are continuation text
 *  joined by ONE space (`>`, `>-`, `|` scalars read as one line); a colon inside an unquoted value is kept; BOM and
 *  CRLF tolerated; a key whose children are `- item` lines is recorded as a list (allowed-tools must be a string). */

export const NAME_MAX = 64;
export const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const DESCRIPTION_MAX = 1024;
export const COMPATIBILITY_MAX = 500;
/** the spec's six fields + rovecode's own `version` (never warned about) */
export const KNOWN_KEYS: ReadonlySet<string> = new Set(["name", "description", "license", "compatibility", "metadata", "allowed-tools", "version"]);

export type FieldShape = "scalar" | "list" | "map";
export type ValidateMode = "lenient" | "strict";

export interface SkillFrontmatter {
  /** top-level values: inline text, or continuation lines joined by one space; quotes stripped */
  fields: Record<string, string>;
  /** how every top-level key was written (metadata is a map when it has indented children) */
  shapes: Record<string, FieldShape>;
  /** the `metadata:` map, string values only */
  metadata: Record<string, string>;
  /** metadata keys whose value was a nested map, a list or empty — not a string */
  metadataNonString: string[];
  body: string;
}

/** the validated field set of one SKILL.md */
export interface SkillMeta {
  name: string;
  description: string;
  /** top-level `version`, else `metadata.version`, else "" */
  version: string;
  license?: string;
  compatibility?: string;
  metadata: Record<string, string>;
  /** `allowed-tools` whitespace-split — data only */
  allowedTools: string[];
}

export interface Validation {
  meta: SkillMeta;
  /** the file must not load (lenient) / the check fails (strict) */
  errors: string[];
  /** lenient mode: loaded anyway, reported */
  warnings: string[];
  /** strict mode: unknown keys — printed, never a failure */
  notes: string[];
}

const BLOCK_SCALAR = /^[>|][+-]?$/;
/** `key: value` where the key is identifier-shaped — a nested-map line, not a sentence holding a colon */
const MAP_LINE = /^[A-Za-z0-9_-]+:(\s|$)/;
const unquote = (v: string): string => v.trim().replace(/^["']|["']$/g, "");

/** null when the text has no `---` block or the block is unterminated (the two INVALID shapes). */
export function parseSkillFrontmatter(raw: string): SkillFrontmatter | null {
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const firstEnd = text.indexOf("\n");
  if (firstEnd === -1 || text.slice(0, firstEnd).replace(/\r$/, "") !== "---") return null;
  const close = /\r?\n---[ \t]*(?=\r?\n|$)/g;
  close.lastIndex = firstEnd;
  const m = close.exec(text);
  if (m === null) return null;
  const block = text.slice(firstEnd + 1, m.index);
  // past the closing `---` line, then one blank separator line — the parseFrontmatter body slice
  const body = text.slice(m.index + m[0].length).replace(/^\r?\n/, "").replace(/^\r?\n/, "");

  const fields: Record<string, string> = {};
  const shapes: Record<string, FieldShape> = {};
  const metadata: Record<string, string> = {};
  const metadataNonString: string[] = [];
  const markNonString = (k: string): void => { delete metadata[k]; if (!metadataNonString.includes(k)) metadataNonString.push(k); };
  let key: string | undefined; // the open top-level key
  let blockScalar = false;
  let metaKey: string | undefined; // the open metadata sub-key
  let metaIndent = -1;
  for (const line of block.split(/\r?\n/)) {
    const t = line.trim();
    if (t === "" || t.startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 0) {
      const i = line.indexOf(":");
      if (i <= 0) { key = undefined; continue; } // not a `key: value` line — skipped, as parseFrontmatter skips it
      key = line.slice(0, i).trim();
      const rest = line.slice(i + 1).trim();
      metaKey = undefined; metaIndent = -1;
      blockScalar = BLOCK_SCALAR.test(rest);
      if (key === "metadata") { shapes[key] = rest === "" ? "map" : "scalar"; if (rest !== "") fields[key] = unquote(rest); continue; }
      shapes[key] = "scalar";
      fields[key] = blockScalar ? "" : unquote(rest);
      continue;
    }
    if (key === undefined) continue;
    if (key === "metadata" && shapes[key] === "map") {
      if (metaKey !== undefined && indent > metaIndent) { markNonString(metaKey); continue; } // nested map / list under a sub-key
      const i = t.indexOf(":");
      if (t.startsWith("- ") || i <= 0) { shapes[key] = "list"; continue; } // `metadata:` holding a list
      metaKey = t.slice(0, i).trim(); metaIndent = indent;
      const v = t.slice(i + 1).trim();
      if (v === "") markNonString(metaKey); else metadata[metaKey] = unquote(v);
      continue;
    }
    const cont = fields[key] ?? "";
    if (!blockScalar && shapes[key] === "scalar" && cont === "") {
      if (t.startsWith("- ")) shapes[key] = "list"; else if (MAP_LINE.test(t)) shapes[key] = "map";
    }
    fields[key] = cont === "" ? t : `${cont} ${t}`;
  }
  return { fields, shapes, metadata, metadataNonString, body };
}

/** The spec checks. Lenient (the loader): an empty or missing description is the ONE error, everything else a
 *  warning and the file loads (a missing name falls back to the directory name — pi:319). Strict (`validate`,
 *  `pack`): every spec violation is an error; unknown keys are notes in both modes' spirit — never a failure. */
export function validateSkillMeta(fm: SkillFrontmatter, dirBasename: string, mode: ValidateMode): Validation {
  const errors: string[] = [], warnings: string[] = [], notes: string[] = [];
  const flag = (msg: string): void => { (mode === "strict" ? errors : warnings).push(msg); };
  const f = fm.fields;
  const description = f["description"] ?? "";
  if (description === "") errors.push(`description is required (1–${DESCRIPTION_MAX} characters)`);
  else if (description.length > DESCRIPTION_MAX) flag(`description is ${description.length} characters (max ${DESCRIPTION_MAX})`);
  let name = f["name"] ?? "";
  if (name === "") {
    if (mode === "strict") errors.push("name is required");
    else warnings.push(`name missing — using the directory name "${dirBasename}"`);
    name = dirBasename;
  } else {
    if (name.length > NAME_MAX) flag(`name is ${name.length} characters (max ${NAME_MAX})`);
    if (!NAME_RE.test(name)) flag(`name "${name}" must be lower-case letters, digits and single hyphens (no leading, trailing or double hyphen)`);
    if (name !== dirBasename) flag(`name "${name}" does not match its directory "${dirBasename}"`);
  }
  const compatibility = f["compatibility"] || undefined;
  if (compatibility !== undefined && compatibility.length > COMPATIBILITY_MAX) flag(`compatibility is ${compatibility.length} characters (max ${COMPATIBILITY_MAX})`);
  const metaShape = fm.shapes["metadata"];
  if (metaShape !== undefined && metaShape !== "map") flag("metadata must be a map of string keys to string values");
  if (fm.metadataNonString.length > 0) flag(`metadata values must be strings: ${fm.metadataNonString.join(", ")}`);
  const toolsShape = fm.shapes["allowed-tools"];
  if (toolsShape !== undefined && toolsShape !== "scalar") flag("allowed-tools must be one space-separated string");
  const unknown = Object.keys(fm.shapes).filter((k) => !KNOWN_KEYS.has(k));
  if (unknown.length > 0) (mode === "strict" ? notes : warnings).push(`unknown frontmatter keys: ${unknown.join(", ")}`);
  const version = f["version"] || fm.metadata["version"] || "";
  const license = f["license"] || undefined;
  const allowedTools = (f["allowed-tools"] ?? "").split(/\s+/).filter((t) => t !== "");
  const meta: SkillMeta = { name, description, version, metadata: fm.metadata, allowedTools };
  if (license !== undefined) meta.license = license;
  if (compatibility !== undefined) meta.compatibility = compatibility;
  return { meta, errors, warnings, notes };
}
