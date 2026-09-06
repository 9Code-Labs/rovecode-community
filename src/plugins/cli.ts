/** `rovecode plugin …` — list · add · remove · enable · disable · trust · untrust · show. A pure
 *  command function over injected cwd/home/output so tests drive it without a process; cli/main.ts
 *  wires `case "plugin"` to it with process.cwd() and rovecodeHome(). Nothing here imports plugin
 *  code: `show` and `list` read manifests and folder digests only, so an untrusted project plugin can
 *  be inspected before it is ever run — that inspection is what `trust` asks the human to do. */

import { relative } from "node:path";
import { rovecodeHome } from "../providers/auth.ts";
import { discoverPlugins, type DiscoveredPlugin, type PluginScope } from "./discover.ts";
import { addPlugin, removePlugin, scopeRoot, setPluginEnabled, trustPlugin, untrustPlugin, type Spawn } from "./install.ts";
import { contributions } from "./manifest.ts";
import { pluginFiles, statePath } from "./state.ts";

export interface PluginCliDeps {
  cwd?: string;
  home?: string;
  out?: (line: string) => void;
  err?: (line: string) => void;
  spawn?: Spawn;
}

export const PLUGIN_USAGE = [
  "usage: rovecode plugin <command>",
  "  list                       every plugin in ~/.rovecode/plugins and .rovecode/plugins, with its status",
  "  add <folder|git-url> [--project] [--force]",
  "                             copy (or shallow-clone) a plugin into the user scope, or this repo's .rovecode/plugins",
  "  remove <name> [--project]  delete the installed copy",
  "  enable <name> · disable <name>",
  "                             switch a plugin off/on in every scope (~/.rovecode/plugins.json)",
  "  trust <name>               approve a PROJECT plugin's current files on this machine — until they change",
  "  untrust <name>             withdraw that approval",
  "  show <name>                manifest, files and what it contributes, without running any of it",
  "status: active · disabled · untrusted (project plugin not yet approved here) · broken (see problems)",
].join("\n");

const flag = (args: string[], name: string): boolean => args.includes(name);
const words = (args: string[]): string[] => args.filter((a) => !a.startsWith("--"));

export async function cmdPlugin(args: string[], deps: PluginCliDeps = {}): Promise<number> {
  const cwd = deps.cwd ?? process.cwd(), home = deps.home ?? rovecodeHome();
  const out = deps.out ?? ((l) => console.log(l)), err = deps.err ?? ((l) => console.error(l));
  const [sub = "list", ...rest] = args;
  const scope: PluginScope = flag(rest, "--project") ? "project" : "user";
  const name = words(rest)[0];
  switch (sub) {
    case "list": case "ls": {
      const { plugins, warnings } = discoverPlugins(cwd, { home });
      if (plugins.length === 0) { out(`no plugins. add one: rovecode plugin add <folder|git-url>   (user: ${scopeRoot("user", cwd, home)}, project: ${relative(cwd, scopeRoot("project", cwd, home)) || "."})`); }
      for (const p of plugins) out(row(p));
      for (const w of warnings) err(`warning: ${w}`);
      return 0;
    }
    case "add": {
      const src = name;
      if (!src) { err(PLUGIN_USAGE); return 2; }
      const r = await addPlugin(src, { cwd, home, scope, force: flag(rest, "--force"), ...(deps.spawn ? { spawn: deps.spawn } : {}) });
      if (!r.ok) { err(`plugin add: ${r.error}`); return 1; }
      out(`added ${r.name}@${r.manifest.version} (${r.scope}) → ${r.dir}`);
      for (const c of contributions(r.manifest)) out(`  ${c}`);
      if (r.scope === "project") out(`  trusted on this machine (recorded in ${statePath(home)}); a change to its files will ask again`);
      out("restart rovecode to load it — plugins are read once per process, like hooks");
      return 0;
    }
    case "remove": case "rm": {
      if (!name) { err(PLUGIN_USAGE); return 2; }
      const r = removePlugin(name, { cwd, home, scope });
      if (!r.ok) { err(`plugin remove: ${r.error}`); return 1; }
      out(`removed ${name} (${scope}) from ${r.dir}`);
      return 0;
    }
    case "enable": case "disable": {
      if (!name) { err(PLUGIN_USAGE); return 2; }
      const known = discoverPlugins(cwd, { home }).plugins.some((p) => p.name === name);
      if (!known) err(`warning: no installed plugin named "${name}" — the setting is recorded anyway`);
      const path = setPluginEnabled(name, sub === "enable", home);
      out(`${name} ${sub}d (${path})`);
      return 0;
    }
    case "trust": {
      if (!name) { err(PLUGIN_USAGE); return 2; }
      const p = discoverPlugins(cwd, { home }).plugins.find((x) => x.name === name && x.scope === "project");
      if (!p) { err(`plugin trust: no project plugin "${name}" under ${scopeRoot("project", cwd, home)}`); return 1; }
      if (p.manifest === null) { err(`plugin trust: "${name}" is broken — fix it first:`); for (const w of p.problems) err(`  ${w}`); return 1; }
      const r = trustPlugin(name, { cwd, home });
      if (!r.ok) { err(`plugin trust: ${r.error}`); return 1; }
      out(`trusted ${name}@${p.manifest.version} — ${pluginFiles(p.dir).length} files, digest ${r.digest.slice(0, 12)}…`);
      for (const c of contributions(p.manifest)) out(`  ${c}`);
      out("it loads on the next start; `rovecode plugin show " + name + "` lists every file it brings");
      return 0;
    }
    case "untrust": {
      if (!name) { err(PLUGIN_USAGE); return 2; }
      out(untrustPlugin(name, { cwd, home }) ? `untrusted ${name}` : `${name} was not trusted`);
      return 0;
    }
    case "show": case "info": {
      if (!name) { err(PLUGIN_USAGE); return 2; }
      const p = discoverPlugins(cwd, { home }).plugins.find((x) => x.name === name);
      if (!p) { err(`plugin show: no plugin "${name}"`); return 1; }
      out(row(p));
      out(`  folder:  ${p.dir}`);
      if (p.digest) out(`  digest:  ${p.digest}`);
      if (p.manifest) for (const c of contributions(p.manifest)) out(`  ${c}`);
      for (const f of pluginFiles(p.dir)) out(`  - ${f}`);
      for (const w of p.problems) out(`  ! ${w}`);
      if (p.status === "untrusted") out(`  run \`rovecode plugin trust ${p.name}\` after reading the files above`);
      return 0;
    }
    case "help": case "--help": case "-h": out(PLUGIN_USAGE); return 0;
    default: err(`unknown plugin command "${sub}"\n${PLUGIN_USAGE}`); return 2;
  }
}

/** one list row: `name@version  scope  status  — description` */
export function row(p: DiscoveredPlugin): string {
  const v = p.manifest ? `@${p.manifest.version}` : "";
  const desc = p.manifest?.description ? ` — ${p.manifest.description}` : "";
  return `${(p.name + v).padEnd(28)} ${p.scope.padEnd(8)} ${p.status.padEnd(9)}${desc}`.trimEnd();
}
