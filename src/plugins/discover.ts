/** Plugins: discovery. Two roots — `~/.rovecode/plugins/<name>/` (user) and `<cwd>/.rovecode/plugins/
 *  <name>/` (project) — each subfolder with a `plugin.json` is a plugin. Sync and filesystem-only:
 *  nothing is imported here, so `rovecode plugin list` can show a hostile plugin without running it.
 *
 *  Status decides what load.ts may do with a plugin:
 *    active     — will be imported and wired
 *    disabled   — the human switched it off (plugins.json)
 *    untrusted  — a PROJECT plugin whose folder digest the human has not approved on this machine;
 *                 listed, never imported (state.ts explains why the record lives in the user home)
 *    broken     — no usable manifest; listed with its reasons so the author can fix it
 *  Same name in both roots: the project copy shadows the user copy (the commands loader's rule) and
 *  says so. ROVECODE_NO_PLUGINS=1 skips discovery the way ROVECODE_NO_HOOKS=1 skips hooks. */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { rovecodeHome } from "../providers/auth.ts";
import { normalizeEntry, type McpServerConfig } from "../mcp/config.ts";
import { MANIFEST_FILE, parseManifest, type PluginManifest } from "./manifest.ts";
import { isDir, isTrusted, loadState, pluginDigest, type PluginState } from "./state.ts";

export type PluginScope = "user" | "project";
export type PluginStatus = "active" | "disabled" | "untrusted" | "broken";

export interface DiscoveredPlugin {
  name: string;
  /** absolute plugin folder */
  dir: string;
  scope: PluginScope;
  manifest: PluginManifest | null;
  status: PluginStatus;
  /** folder digest (state.ts); null when the folder could not be walked */
  digest: string | null;
  /** why it is broken / what the manifest dropped — the author's fix list */
  problems: string[];
  /** the declarative halves, resolved here because they need no code run: the runtime wires them
   *  synchronously at construction (the commands and skills loaders, the MCP config) and only the
   *  entry module waits for load.ts. Filled for every plugin with a manifest; the runtime reads
   *  them for ACTIVE ones only. */
  commandsDir: string | null;
  skillsDir: string | null;
  mcp: McpServerConfig[];
}

export interface DiscoverOptions { home?: string; state?: PluginState }
export interface Discovered { plugins: DiscoveredPlugin[]; warnings: string[] }

/** the two roots, project last so it shadows; one root when cwd IS the home (commands.ts idiom) */
export function pluginRoots(cwd: string, home: string): [PluginScope, string][] {
  const user = join(home, "plugins"), project = join(cwd, ".rovecode", "plugins");
  return resolve(user) === resolve(project) ? [["project", project]] : [["user", user], ["project", project]];
}

export function discoverPlugins(cwd: string, opts: DiscoverOptions = {}): Discovered {
  const out: Discovered = { plugins: [], warnings: [] };
  if (process.env.ROVECODE_NO_PLUGINS === "1") return out;
  const home = opts.home ?? rovecodeHome();
  const state = opts.state ?? loadState(home);
  const byName = new Map<string, DiscoveredPlugin>();
  for (const [scope, root] of pluginRoots(cwd, home)) {
    if (!isDir(root)) continue;
    let names: string[];
    try { names = readdirSync(root).sort(); } catch (e) { out.warnings.push(`${root}: cannot list — ${(e as Error).message}`); continue; }
    for (const folder of names) {
      const dir = join(root, folder);
      if (!isDir(dir) || !existsSync(join(dir, MANIFEST_FILE))) continue; // a stray file or a folder without a manifest is not a plugin
      const p = readPlugin(dir, folder, scope, state);
      const prev = byName.get(p.name);
      if (prev) out.warnings.push(`${dir}: plugin "${p.name}" shadows ${prev.dir} (project over user)`);
      byName.set(p.name, p);
      for (const w of p.problems) out.warnings.push(w);
    }
  }
  out.plugins = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** one folder → its DiscoveredPlugin: manifest, status, digest, and the declarative halves resolved
 *  (a named commands/skills dir must exist; MCP entries go through the same normalizer as mcp.json) */
export function readPlugin(dir: string, folder: string, scope: PluginScope, state: PluginState): DiscoveredPlugin {
  const file = join(dir, MANIFEST_FILE);
  const problems: string[] = [];
  let manifest: PluginManifest | null = null;
  try { manifest = parseManifest(readFileSync(file, "utf8"), file, problems); }
  catch (e) { problems.push(`${file}: cannot read — ${(e as Error).message}`); }
  let digest: string | null = null;
  try { digest = pluginDigest(dir); } catch { digest = null; }
  const name = manifest?.name ?? folder;
  if (manifest && manifest.name !== folder) problems.push(`${file}: name "${manifest.name}" differs from its folder "${folder}" — the manifest name is the plugin's identity`);
  let status: PluginStatus;
  if (manifest === null) status = "broken";
  else if (state.disabled.includes(name)) status = "disabled";
  else if (scope === "project" && (digest === null || !isTrusted(state, dir, digest))) status = "untrusted";
  else status = "active";
  const tag = `plugin ${name}`;
  const commandsDir = manifest ? dirOrProblem(dir, manifest.commands, `${tag}: commands`, problems) : null;
  const skillsDir = manifest ? dirOrProblem(dir, manifest.skills, `${tag}: skills`, problems) : null;
  const mcp: McpServerConfig[] = [];
  if (manifest?.mcp) for (const [n, raw] of Object.entries(manifest.mcp)) { const c = normalizeEntry(n, raw, file, problems); if (c) mcp.push(c); }
  return { name, dir, scope, manifest, status, digest, problems, commandsDir, skillsDir, mcp };
}

function dirOrProblem(base: string, rel: string | undefined, what: string, problems: string[]): string | null {
  if (!rel) return null;
  const p = join(base, rel);
  try { if (statSync(p).isDirectory()) return p; } catch { /* below */ }
  problems.push(`${what} directory "${rel}" does not exist — ignored`);
  return null;
}
