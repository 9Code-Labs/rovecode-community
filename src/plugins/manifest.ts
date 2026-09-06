/** Plugins: the manifest. A plugin is a FOLDER with a `plugin.json` that names what the folder
 *  contributes — an in-process entry module (tools + hooks), a directory of custom commands, a
 *  directory of skills, MCP servers. Nothing here is a new extension API: every contribution lands on
 *  a seam rovecode already has (core/hooks.ts HookSet, core/tools.ts ToolRegistry, tui/commands.ts,
 *  skills/index.ts, mcp/config.ts). The plugin is the package, not the surface (ADR-013: no 1.8k-line
 *  extension API — a small typed set, versioned; the manifest is versioned the same way hooks are).
 *
 *  Pure: text in, manifest or null out, every rejection a warning that names the file and the field.
 *  Paths in the manifest are RELATIVE and may not climb out of the plugin folder — a manifest is data
 *  from a checkout, and "../../.rovecode/hooks.ts" is not a plugin's to name. */

import { isRecord } from "../mcp/config.ts";

export const PLUGIN_API_VERSION = 1;
export const MANIFEST_FILE = "plugin.json";
/** `rovecode plugin list` and the palette show this; a paragraph is not a description */
export const MAX_DESCRIPTION_CHARS = 200;

export interface PluginManifest {
  /** identity: folder-safe, lowercase, unique per scope — `conventional-commits`, `safety-net` */
  name: string;
  version: string;
  description: string;
  /** manifest/API version gate; this rovecode speaks PLUGIN_API_VERSION */
  api: number;
  /** relative path of the in-process module (`export default { api: 1, tools, hooks }`); .ts or .js */
  entry?: string;
  /** relative directory of `*.md` custom commands (tui/commands.ts format) */
  commands?: string;
  /** relative directory walked for SKILL.md files (skills/index.ts format) */
  skills?: string;
  /** MCP servers keyed by name, `.rovecode/mcp.json` entry shape */
  mcp?: Record<string, unknown>;
}

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ENTRY_RE = /\.(?:[cm]?[jt]s)$/i;

/** a relative path that stays inside the plugin: no absolute, no drive, no `..` segment */
export function insidePlugin(p: string): boolean {
  if (p.length === 0 || p.startsWith("/") || p.startsWith("\\") || /^[A-Za-z]:/.test(p)) return false;
  return !p.split(/[\\/]/).some((seg) => seg === "..");
}

/** `plugin.json` text → manifest, or null with the reasons appended to `warnings`. A wrong or missing
 *  `api` is a hard skip (the version gate); everything else that is off is dropped field by field so
 *  a typo in `skills` does not lose the plugin's tools. */
export function parseManifest(text: string, file: string, warnings: string[]): PluginManifest | null {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (e) { warnings.push(`${file}: not valid JSON — ${(e as Error).message}`); return null; }
  if (!isRecord(raw)) { warnings.push(`${file}: must be an object`); return null; }
  const api = raw["api"];
  if (api !== PLUGIN_API_VERSION) {
    const shown = api === undefined ? "missing" : typeof api === "string" ? JSON.stringify(api) : String(api);
    warnings.push(`${file}: plugin API version ${shown} is not supported (this rovecode speaks ${PLUGIN_API_VERSION}) — skipped`);
    return null;
  }
  const name = raw["name"];
  if (typeof name !== "string" || !NAME_RE.test(name)) { warnings.push(`${file}: "name" must match ${NAME_RE} — skipped`); return null; }
  const version = typeof raw["version"] === "string" && raw["version"].trim() ? raw["version"].trim().slice(0, 40) : null;
  if (version === null) { warnings.push(`${file}: "version" must be a non-empty string — skipped`); return null; }
  const m: PluginManifest = { name, version, description: "", api: PLUGIN_API_VERSION };
  if (raw["description"] !== undefined) {
    if (typeof raw["description"] === "string") m.description = raw["description"].replace(/\s+/g, " ").trim().slice(0, MAX_DESCRIPTION_CHARS);
    else warnings.push(`${file}: "description" is not a string — ignored`);
  }
  for (const key of ["entry", "commands", "skills"] as const) {
    const v = raw[key];
    if (v === undefined) continue;
    if (typeof v !== "string" || !insidePlugin(v)) { warnings.push(`${file}: "${key}" must be a relative path inside the plugin — ignored`); continue; }
    if (key === "entry" && !ENTRY_RE.test(v)) { warnings.push(`${file}: "entry" must be a .ts or .js module — ignored`); continue; }
    m[key] = v.replace(/\\/g, "/");
  }
  if (raw["mcp"] !== undefined) {
    if (isRecord(raw["mcp"])) m.mcp = raw["mcp"];
    else warnings.push(`${file}: "mcp" must be an object of servers keyed by name — ignored`);
  }
  for (const key of Object.keys(raw)) {
    if (!["name", "version", "description", "api", "entry", "commands", "skills", "mcp"].includes(key)) warnings.push(`${file}: unknown field "${key}" ignored`);
  }
  return m;
}

/** what a manifest says it brings, for `plugin list` / `plugin show` / the trust prompt */
export function contributions(m: PluginManifest): string[] {
  const out: string[] = [];
  if (m.entry) out.push(`code: ${m.entry}`);
  if (m.commands) out.push(`commands: ${m.commands}/`);
  if (m.skills) out.push(`skills: ${m.skills}/`);
  if (m.mcp) out.push(`mcp: ${Object.keys(m.mcp).join(", ") || "(none)"}`);
  return out;
}
