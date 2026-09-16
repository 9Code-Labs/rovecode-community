/** Plugins (the package, not the surface). A plugin is a folder with a `plugin.json` that bundles what
 *  rovecode can already be extended with — an in-process module of tools and hooks, custom commands,
 *  skills, MCP servers — so one `rovecode plugin add` installs all of it, `plugin list` shows all of it,
 *  and a project can ship its own under `.rovecode/plugins/` behind a per-machine trust step.
 *
 *  Module map: manifest.ts (plugin.json → PluginManifest) · state.ts (~/.rovecode/plugins.json:
 *  disabled + trusted digests) · discover.ts (the two roots → DiscoveredPlugin with a status, no code
 *  run) · load.ts (import + validate the active ones → typed contributions) · install.ts (the human's
 *  verbs) · cli.ts (`rovecode plugin …`). `loadPlugins` is the one call the runtime makes. */

import { rovecodeHome } from "../providers/auth.ts";
import { discoverPlugins, type DiscoveredPlugin } from "./discover.ts";
import { activatePlugins, type LoadedPlugin } from "./load.ts";
import { loadState } from "./state.ts";

export type { PluginManifest } from "./manifest.ts";
export { PLUGIN_API_VERSION, MANIFEST_FILE, parseManifest, contributions } from "./manifest.ts";
export type { PluginState } from "./state.ts";
export { loadState, saveState, statePath, pluginDigest, pluginFiles } from "./state.ts";
export type { DiscoveredPlugin, PluginScope, PluginStatus } from "./discover.ts";
export { discoverPlugins, pluginRoots } from "./discover.ts";
export type { LoadedPlugin, PluginModule, PluginCtx } from "./load.ts";
export { activatePlugins, DEFAULT_PLUGIN_TIMEOUT_MS } from "./load.ts";
export { addPlugin, removePlugin, setPluginEnabled, trustPlugin, untrustPlugin, scopeRoot, isGitSource } from "./install.ts";
export { cmdPlugin, PLUGIN_USAGE } from "./cli.ts";

export interface LoadPluginsOptions { home?: string; timeoutMs?: number }
export interface LoadedPlugins {
  /** every discovered plugin, active ones carrying their contributions */
  plugins: LoadedPlugin[];
  /** discovery + activation notes, in order — for the boot transcript */
  warnings: string[];
}

/** discover, then activate the active ones; the runtime's single entry point */
export async function loadPlugins(cwd: string, opts: LoadPluginsOptions = {}): Promise<LoadedPlugins> {
  const home = opts.home ?? rovecodeHome();
  const found = discoverPlugins(cwd, { home, state: loadState(home) });
  const act = await activatePlugins(found.plugins, { cwd, home, ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}) });
  return { plugins: act.plugins, warnings: [...found.warnings, ...act.warnings] };
}

/** one line per plugin the boot transcript can echo: `plugins: 2 active (safety-net, notes) · 1 untrusted (acme)` */
export function summarizePlugins(p: readonly Pick<DiscoveredPlugin, "name" | "status">[]): string | null {
  if (p.length === 0) return null;
  const by = (s: DiscoveredPlugin["status"]): string[] => p.filter((x) => x.status === s).map((x) => x.name);
  const parts: string[] = [];
  for (const s of ["active", "untrusted", "disabled", "broken"] as const) { const n = by(s); if (n.length) parts.push(`${n.length} ${s} (${n.join(", ")})`); }
  return `plugins: ${parts.join(" · ")}`;
}
