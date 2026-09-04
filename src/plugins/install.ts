/** Plugins: the human's verbs — add, remove, enable, disable, trust. Each is a small filesystem
 *  operation plus a plugins.json edit; none imports plugin code (that is load.ts, at runtime, after
 *  these decisions). `add` takes a folder or a git URL: a URL is cloned shallow into a temp folder and
 *  from there on treated exactly like a folder (validated BEFORE anything is copied into place — a
 *  folder without a usable manifest never lands in ~/.rovecode/plugins). Adding into the project scope
 *  records the folder's digest as trusted: the human ran the command, that is the yes. */

import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pluginRoots, type PluginScope } from "./discover.ts";
import { MANIFEST_FILE, parseManifest, type PluginManifest } from "./manifest.ts";
import { isDir, loadState, pluginDigest, saveState, trustKey } from "./state.ts";

export type Spawn = (cmd: string[], cwd: string) => Promise<{ code: number; stderr: string }>;
export interface InstallOptions {
  cwd: string;
  home: string;
  scope: PluginScope;
  /** replace an existing plugin of the same name */
  force?: boolean;
  /** how `git clone` runs; default Bun.spawn — tests inject one that never touches the network */
  spawn?: Spawn;
}
export type AddResult = { ok: true; name: string; dir: string; scope: PluginScope; manifest: PluginManifest } | { ok: false; error: string };

const GIT_URL_RE = /^(?:https?:\/\/|git@|ssh:\/\/|git:\/\/)|\.git$/i;
export const isGitSource = (s: string): boolean => GIT_URL_RE.test(s) && !existsSync(s);

const defaultSpawn: Spawn = async (cmd, cwd) => {
  const proc = Bun.spawn(cmd, { cwd, stdout: "ignore", stderr: "pipe", stdin: "ignore" });
  const stderr = await new Response(proc.stderr).text();
  return { code: await proc.exited, stderr };
};

/** the folder a scope's plugins live in */
export function scopeRoot(scope: PluginScope, cwd: string, home: string): string {
  return pluginRoots(cwd, home).find(([s]) => s === scope)?.[1] ?? join(home, "plugins");
}

export async function addPlugin(source: string, opts: InstallOptions): Promise<AddResult> {
  let src = source, tmp: string | null = null;
  try {
    if (isGitSource(source)) {
      tmp = mkdtempSync(join(tmpdir(), "rovecode-plugin-"));
      const r = await (opts.spawn ?? defaultSpawn)(["git", "clone", "--depth", "1", "--quiet", source, "src"], tmp);
      if (r.code !== 0) return { ok: false, error: `git clone failed (exit ${r.code})${r.stderr.trim() ? `: ${r.stderr.trim().split("\n").at(-1)}` : ""}` };
      src = join(tmp, "src");
    }
    src = resolve(src);
    if (!isDir(src)) return { ok: false, error: `${source}: not a directory` };
    const file = join(src, MANIFEST_FILE);
    if (!existsSync(file)) return { ok: false, error: `${source}: no ${MANIFEST_FILE} — a plugin is a folder with a manifest` };
    const warnings: string[] = [];
    const manifest = parseManifest(readFileSync(file, "utf8"), file, warnings);
    if (manifest === null) return { ok: false, error: warnings.join("; ") || `${file}: invalid manifest` };
    const root = scopeRoot(opts.scope, opts.cwd, opts.home);
    const dest = join(root, manifest.name);
    if (resolve(dest) === src) return { ok: false, error: `${source} is already the installed copy` };
    if (existsSync(dest)) {
      if (!opts.force) return { ok: false, error: `plugin "${manifest.name}" already exists at ${dest} (use --force to replace)` };
      rmSync(dest, { recursive: true, force: true });
    }
    cpSync(src, dest, { recursive: true, filter: (p) => !/(?:^|[\\/])(?:node_modules|\.git)(?:[\\/]|$)/.test(p) });
    if (opts.scope === "project") { // the human installed it: trust this exact content on this machine
      const state = loadState(opts.home);
      state.trusted[trustKey(dest)] = pluginDigest(dest);
      saveState(opts.home, state);
    }
    return { ok: true, name: manifest.name, dir: dest, scope: opts.scope, manifest };
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }
}

export function removePlugin(name: string, opts: { cwd: string; home: string; scope: PluginScope }): { ok: true; dir: string } | { ok: false; error: string } {
  const dir = join(scopeRoot(opts.scope, opts.cwd, opts.home), name);
  if (!isDir(dir)) return { ok: false, error: `no ${opts.scope} plugin "${name}" at ${dir}` };
  rmSync(dir, { recursive: true, force: true });
  const state = loadState(opts.home);
  delete state.trusted[trustKey(dir)];
  saveState(opts.home, state);
  return { ok: true, dir };
}

export function setPluginEnabled(name: string, enabled: boolean, home: string): string {
  const state = loadState(home);
  state.disabled = state.disabled.filter((n) => n !== name);
  if (!enabled) state.disabled.push(name);
  return saveState(home, state);
}

/** approve a project plugin's CURRENT content; a later change to any file asks again */
export function trustPlugin(name: string, opts: { cwd: string; home: string }): { ok: true; dir: string; digest: string } | { ok: false; error: string } {
  const dir = join(scopeRoot("project", opts.cwd, opts.home), name);
  if (!isDir(dir) || !existsSync(join(dir, MANIFEST_FILE))) return { ok: false, error: `no project plugin "${name}" under ${scopeRoot("project", opts.cwd, opts.home)}` };
  const digest = pluginDigest(dir);
  const state = loadState(opts.home);
  state.trusted[trustKey(dir)] = digest;
  saveState(opts.home, state);
  return { ok: true, dir, digest };
}

export function untrustPlugin(name: string, opts: { cwd: string; home: string }): boolean {
  const dir = join(scopeRoot("project", opts.cwd, opts.home), name);
  const state = loadState(opts.home);
  const had = trustKey(dir) in state.trusted;
  delete state.trusted[trustKey(dir)];
  saveState(opts.home, state);
  return had;
}
