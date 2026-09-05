/** One install entry, three kinds, one order of events — plan, show, ask, write.
 *
 *  The MCP market established the order and it is the whole point of this module: the human sees the exact
 *  command, folder or file list BEFORE anything lands, and the write happens only after a yes. A skill, a
 *  plugin and an MCP server say different things in that preview ("copies one file, runs nothing" vs
 *  "copies a folder whose code rovecode will run"), so the sentences differ per kind — but a caller only
 *  ever calls `planInstall` then `runInstall`, and neither can be skipped by a new kind arriving later.
 *
 *  Delegation, not reimplementation: MCP goes through mcp/market-install.ts (planner, `${NAME}` filling,
 *  trust-recording write), plugins through plugins/install.ts (shallow clone, manifest validation, project
 *  trust). Only skills are written here, because "copy files into a folder" had no installer yet.
 *
 *  Project scope is the trusted scope: a project MCP file or plugin folder installed through this path is
 *  recorded as trusted, because the human just approved the exact content. Skills are files, never code —
 *  they carry no trust gate, and the preview says so. */

import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep, resolve as resolvePath } from "node:path";
import { describePlan, fillPlan, namesWritten, planInstall as planMcp, removeServer, writeServer, type InstallPlan as McpPlan } from "../mcp/market-install.ts";
import { mcpConfigFiles, parseConfigFile } from "../mcp/config.ts";
import { mcpTrustStatus } from "../mcp/trust.ts";
import { addPlugin, removePlugin, scopeRoot, type Spawn } from "../plugins/install.ts";
import { discoverPlugins } from "../plugins/discover.ts";
import type { InstalledState, InstallOutcome, InstallPlanView, MarketItem, MarketRow, MarketScope } from "./types.ts";

export interface PlanOptions {
  scope: MarketScope;
  cwd: string;
  home: string;
  /** which of an MCP entry's install forms (default the first) */
  pick?: number;
  /** override the installed name */
  as?: string;
}

export interface RunDeps {
  /** how `git clone` runs — tests inject one that never touches the network */
  spawn?: Spawn;
  /** replace something already installed under that name */
  force?: boolean;
}

/** The names an item may be installed under. `--as` is human input reaching a path join, so it is checked
 *  like one: `--as "../../../head-pwned"` wrote a skill outside ROVECODE_HOME entirely, `--as ""` targeted
 *  the skills root itself, and `--as "C:/x"` produced a raw ENOENT. Only a plain slug is a name. */
const INSTALL_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
export function validInstallName(name: string): boolean {
  return INSTALL_NAME.test(name) && name !== "." && name !== "..";
}

/** where a skill of this id lives under a scope */
export function skillDir(id: string, opts: { scope: MarketScope; cwd: string; home: string }): string {
  const root = opts.scope === "project" ? join(opts.cwd, ".rovecode", "skills") : join(opts.home, "skills");
  const dir = join(root, id);
  // belt and braces: even a name that slipped past the check cannot land outside the skills root
  if (!resolvePath(dir).startsWith(resolvePath(root) + sep)) throw new Error(`"${id}" is not a usable skill name`);
  return dir;
}

// ---------------------------------------------------------------- planning (writes nothing)

export function planInstall(item: MarketItem, opts: PlanOptions): InstallPlanView | { error: string } {
  const { install } = item;
  // checked BEFORE any path is built from it, for every kind
  if (opts.as !== undefined && !validInstallName(opts.as)) {
    return { error: `"${opts.as}" is not a usable name — letters, digits, dot, dash and underscore only, and it must not be a path` };
  }
  if (install.kind === "mcp") {
    const inner = planMcp(install.entry, {
      scope: opts.scope, cwd: opts.cwd, home: opts.home,
      ...(opts.pick !== undefined ? { pick: opts.pick } : {}), ...(opts.as !== undefined ? { name: opts.as } : {}),
    });
    if ("error" in inner) return inner;
    const view: InstallPlanView = {
      item, target: inner.file, scope: opts.scope,
      preview: [...describePlan(inner, opts.scope === "project" ? "env" : "prompt"), ...(item.planNote ?? [])],
      asks: inner.asks.map((a) => ({ ...a })), pending: [...inner.pending],
    };
    const existing = existingMcpNames(opts.cwd, opts.home, opts.scope);
    if (existing.includes(inner.name)) view.replaces = `${inner.name} in ${inner.file}`;
    return view;
  }

  const id = opts.as ?? item.id;
  if (install.kind === "plugin") {
    // `--as` cannot be honoured here and must not be accepted silently: addPlugin writes under the name in
    // the plugin's own manifest, so a rename would put the folder somewhere the preview did not say.
    if (opts.as !== undefined) return { error: `--as does not apply to a plugin: it installs under the name in its own manifest` };
    const dir = join(scopeRoot(opts.scope, opts.cwd, opts.home), item.id);
    const preview = [
      `${item.title}${item.version ? ` ${item.version}` : ""}`,
      `  kind       plugin — a folder of CODE that rovecode loads and RUNS in this process`,
      `  source     ${install.git ? `git clone --depth 1 ${install.source}` : `copy of the folder ${install.source}`}${install.subfolder ? ` (subfolder ${install.subfolder})` : ""}`,
      `  publisher  ${item.publisher}`,
      ...(item.license ? [`  licence    ${item.license}`] : []),
      ...(item.repository ? [`  repo       ${item.repository}`] : []),
      `  writes     ${dir}${install.git ? "  (the folder is named by the plugin's manifest; this is the expected name)" : ""}`,
      opts.scope === "project"
        ? `  trust      installed into this repo — approving here records this exact content as trusted on this machine`
        : `  trust      user scope (~/.rovecode/plugins): loaded in every project you open`,
      `  a plugin can add tools, hooks, commands, skills and MCP servers. Install one only from a publisher you trust.`,
      ...(item.planNote ?? []),
    ];
    return { item, target: dir, scope: opts.scope, preview, asks: item.env.map((e) => ({ ...e })), pending: [],
      ...(existsSync(dir) ? { replaces: dir } : {}) };
  }

  const dir = skillDir(id, opts);
  const fileList = install.files ?? [];
  // a skill IS a folder with a SKILL.md — without one nothing would ever find it again: installedState
  // looks for exactly that file, so it would install and then read as "not installed" forever
  if (install.source === undefined && !fileList.some((f) => f.path.replace(/\\/g, "/").toLowerCase() === "skill.md")) {
    return { error: `${item.id} carries no SKILL.md — a skill is a folder with a SKILL.md, and rovecode would never see this one` };
  }
  const preview = [
    `${item.title}${item.version ? ` ${item.version}` : ""}`,
    `  kind       skill — instructions the model reads. Files only: nothing here is executed on install.`,
    install.source
      ? `  source     git clone --depth 1 ${install.source.git}${install.source.subfolder ? ` (subfolder ${install.source.subfolder})` : ""}`
      : `  source     ${fileList.length} file${fileList.length === 1 ? "" : "s"} from rovecode's catalog`,
    `  publisher  ${item.publisher}`,
    ...(item.license ? [`  licence    ${item.license}`] : []),
    ...(item.repository ? [`  repo       ${item.repository}`] : []),
    `  writes     ${dir}`,
    ...fileList.slice(0, 8).map((f) => `             ${f.path}`),
    ...(fileList.length > 8 ? [`             … and ${fileList.length - 8} more`] : []),
    ...(item.planNote ?? []),
  ];
  return { item, target: dir, scope: opts.scope, preview, asks: item.env.map((e) => ({ ...e })), pending: [],
    ...(existsSync(dir) ? { replaces: dir } : {}) };
}

// ---------------------------------------------------------------- writing (only after a yes)

export async function runInstall(plan: InstallPlanView, answers: Record<string, string>, opts: PlanOptions, deps: RunDeps = {}): Promise<InstallOutcome> {
  const { item } = plan;
  const { install } = item;
  try {
    if (install.kind === "mcp") {
      const inner = planMcp(install.entry, {
        scope: opts.scope, cwd: opts.cwd, home: opts.home,
        ...(opts.pick !== undefined ? { pick: opts.pick } : {}), ...(opts.as !== undefined ? { name: opts.as } : {}),
      });
      if ("error" in inner) return { ok: false, error: inner.error };
      const raw = fillPlan(inner, answers);
      const written = writeServer(inner.file, inner.name, raw, {
        ...(deps.force === true ? { replace: true } : {}),
        ...(opts.scope === "project" ? { trustHome: opts.home } : {}),
      });
      return {
        ok: true, item, target: inner.file, scope: opts.scope, envNames: namesWritten(inner, raw),
        ...(written.trusted !== undefined ? { trusted: written.trusted } : {}),
        next: "restart rovecode — MCP servers are read once per process",
      };
    }

    if (install.kind === "plugin") {
      // a monorepo plugin lives in plugins/<name>; plugins/install.ts validates the subfolder again
      const r = await addPlugin(install.source, {
        cwd: opts.cwd, home: opts.home, scope: opts.scope,
        ...(deps.force === true ? { force: true } : {}), ...(deps.spawn ? { spawn: deps.spawn } : {}),
        ...(install.subfolder !== undefined ? { subfolder: install.subfolder } : {}),
      });
      if (!r.ok) return { ok: false, error: r.error };
      return {
        ok: true, item, target: r.dir, scope: opts.scope, envNames: item.env.filter((e) => e.required).map((e) => e.name),
        ...(opts.scope === "project" ? { trusted: true } : {}),
        next: "restart rovecode — plugins are loaded once at startup",
      };
    }

    const dir = plan.target;
    if (existsSync(dir) && deps.force !== true) return { ok: false, error: `${dir} already exists (use --force to replace)` };
    if (install.source) {
      const r = await cloneSkill(install.source, dir, deps);
      if (!r.ok) return { ok: false, error: r.error };
    } else {
      // Build the whole thing beside the target and swap at the end. Writing in place meant deleting the
      // installed copy FIRST and then failing half way through the loop — the caller saw a clean
      // {ok:false} while the previous version was already gone and a partial one sat in its place.
      mkdirSync(dirname(dir), { recursive: true });   // the scope's skills/ folder may not exist yet
      const staging = mkdtempSync(join(dirname(dir), `.rovecode-skill-${item.id}-`));
      try {
        for (const f of install.files ?? []) {
          const dest = join(staging, f.path);
          // checked BEFORE anything is removed, not after — the catalog reader is the first lock, this the second
          if (!resolvePath(dest).startsWith(resolvePath(staging) + sep) ) return { ok: false, error: `${f.path} escapes the skill's folder` };
          mkdirSync(dirname(dest), { recursive: true });
          writeFileSync(dest, f.text);
        }
        if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
        renameSync(staging, dir);
      } finally {
        rmSync(staging, { recursive: true, force: true }); // no-op once it has been renamed into place
      }
    }
    return {
      ok: true, item, target: dir, scope: opts.scope, envNames: [],
      next: "restart rovecode — skills are indexed at startup",
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** true for a symbolic link (never throws: an unreadable entry is not copied either) */
function isLink(p: string): boolean {
  try { return lstatSync(p).isSymbolicLink(); } catch { return true; }
}

async function cloneSkill(source: { git: string; subfolder?: string }, dir: string, deps: RunDeps): Promise<{ ok: true } | { ok: false; error: string }> {
  const tmp = mkdtempSync(join(tmpdir(), "rovecode-skill-"));
  try {
    const spawn: Spawn = deps.spawn ?? (async (cmd, cwd) => {
      const p = Bun.spawn(cmd, { cwd, stdout: "ignore", stderr: "pipe", stdin: "ignore" });
      return { code: await p.exited, stderr: await new Response(p.stderr).text() };
    });
    const r = await spawn(["git", "clone", "--depth", "1", "--quiet", source.git, "src"], tmp);
    if (r.code !== 0) return { ok: false, error: `git clone failed (exit ${r.code})${r.stderr.trim() ? `: ${r.stderr.trim().split("\n").at(-1)}` : ""}` };
    const from = source.subfolder ? join(tmp, "src", source.subfolder) : join(tmp, "src");
    if (!resolvePath(from).startsWith(resolvePath(join(tmp, "src")))) return { ok: false, error: `subfolder escapes the clone` };
    if (!existsSync(join(from, "SKILL.md"))) return { ok: false, error: `no SKILL.md in ${source.subfolder ?? "the repository root"} — a skill is a folder with a SKILL.md` };
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    mkdirSync(dirname(dir), { recursive: true });
    cpSync(from, dir, { recursive: true, filter: (p) => !/(?:^|[\\/])\.git(?:[\\/]|$)/.test(p) });
    return { ok: true };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- what is installed here

function existingMcpNames(cwd: string, home: string, scope: MarketScope): string[] {
  const files = mcpConfigFiles(cwd, home);
  const file = scope === "project" ? files.project : files.user;
  if (file === undefined || !existsSync(file)) return [];
  const anySet = new Proxy({}, { get: () => "set" }) as Record<string, string>;
  return parseConfigFile(file, [], anySet).map((s) => s.name);
}

/** Local truth for one item: is it on disk, where, and does the version differ from the catalog's. */
export function installedState(item: MarketItem, cwd: string, home: string, only?: MarketScope): InstalledState | undefined {
  const scopes: readonly MarketScope[] = only ? [only] : ["project", "user"];
  if (item.kind === "mcp") {
    const files = mcpConfigFiles(cwd, home);
    const byScope: Record<MarketScope, string | undefined> = { project: files.project, user: files.user };
    for (const scope of scopes) {
      const file = byScope[scope];
      if (file === undefined || !existsSync(file)) continue;
      const anySet = new Proxy({}, { get: () => "set" }) as Record<string, string>;
      const hit = parseConfigFile(file, [], anySet).find((s) => s.name === item.id);
      if (hit) {
        const state: InstalledState = { path: file, scope };
        if (scope === "project") state.trusted = mcpTrustStatus(home, file) === "trusted";
        return state;
      }
    }
    return undefined;
  }
  if (item.kind === "plugin") {
    const found = discoverPlugins(cwd, { home }).plugins.find((p) => p.name === item.id && (only === undefined || p.scope === only));
    if (!found) return undefined;
    const state: InstalledState = { path: found.dir, scope: found.scope };
    const version = found.manifest?.version;
    if (version !== undefined) {
      state.version = version;
      if (item.version !== undefined && item.version !== version) state.updateAvailable = true;
    }
    if (found.scope === "project") state.trusted = found.status !== "untrusted";
    return state;
  }
  for (const scope of scopes) {
    const dir = skillDir(item.id, { scope, cwd, home });
    if (!existsSync(join(dir, "SKILL.md"))) continue;
    const state: InstalledState = { path: dir, scope };
    const version = skillVersion(join(dir, "SKILL.md"));
    if (version !== undefined) {
      state.version = version;
      if (item.version !== undefined && item.version !== version) state.updateAvailable = true;
    }
    return state;
  }
  return undefined;
}

function skillVersion(file: string): string | undefined {
  try {
    const head = readFileSync(file, "utf8").slice(0, 2000);
    return /^version:\s*(.+)$/m.exec(head)?.[1]?.trim().slice(0, 64);
  } catch { return undefined; }
}

/** Attach local state to every item — what a UI renders. */
export function withInstalled(items: readonly MarketItem[], cwd: string, home: string): MarketRow[] {
  return items.map((item) => {
    const installed = installedState(item, cwd, home);
    return installed ? { ...item, installed } : { ...item };
  });
}

/** `market remove <kind:id>` — undo an install, whichever kind it is. */
export function removeItem(item: MarketItem, cwd: string, home: string, scope?: MarketScope): { ok: true; path: string } | { ok: false; error: string } {
  const state = installedState(item, cwd, home, scope);
  if (state === undefined) return { ok: false, error: `${item.kind} "${item.id}" is not installed here${scope ? ` in ${scope} scope` : ""}` };
  if (item.kind === "mcp") {
    // `trustHome` is not optional bookkeeping: removeServer re-records the file's trust after the edit, and
    // without it every OTHER server in a project file silently drops to "not approved" for having changed.
    const ok = removeServer(state.path, item.id, { trustHome: home });
    return ok ? { ok: true, path: state.path } : { ok: false, error: `no server "${item.id}" in ${state.path}` };
  }
  if (item.kind === "plugin") {
    // through the plugin remover, which also drops the folder's trust entry — a plain rmSync leaves a
    // recorded digest pointing at a directory that no longer exists, and the next install is compared to it
    const r = removePlugin(item.id, { cwd, home, scope: state.scope });
    return r.ok ? { ok: true, path: r.dir } : { ok: false, error: r.error };
  }
  rmSync(state.path, { recursive: true, force: true });
  return { ok: true, path: state.path };
}

export type { McpPlan };
