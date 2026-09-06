/** Plugins: the human's verbs — add, remove, enable, disable, trust. Each is a small filesystem
 *  operation plus a plugins.json edit; none imports plugin code (that is load.ts, at runtime, after
 *  these decisions). `add` takes a folder or a git URL: a URL is cloned shallow into a temp folder and
 *  from there on treated exactly like a folder (validated BEFORE anything is copied into place — a
 *  folder without a usable manifest never lands in ~/.rovecode/plugins). Adding into the project scope
 *  records the folder's digest as trusted: the human ran the command, that is the yes. */

import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { pluginRoots, type PluginScope } from "./discover.ts";
import { MANIFEST_FILE, parseManifest, type PluginManifest } from "./manifest.ts";
import { isDir, loadState, pluginDigest, saveState, trustKey } from "./state.ts";

export type Spawn = (cmd: string[], cwd: string) => Promise<{ code: number; stderr: string }>;
/** the copy step, injectable for one reason: a test cannot otherwise arrange a copy that fails PART WAY
 *  through, which is the only failure the staging directory exists to survive. A real half-copy needs a
 *  full disk or a locked file; a fake one needs three lines. */
export type CopyTree = (from: string, to: string, filter: (path: string) => boolean) => void;
export interface InstallOptions {
  cwd: string;
  home: string;
  scope: PluginScope;
  /** replace an existing plugin of the same name */
  force?: boolean;
  /** the plugin's folder INSIDE the source, when the source is a repository that publishes several.
   *
   *  Every real plugin is one: rovecode's own three live in `plugins/safety-net`, `plugins/notes` and
   *  `plugins/conventional-commits`, and a catalog could not install any of them while `add` only looked
   *  at the clone root. Rejected rather than normalised: an absolute path, a drive letter, or any `..`
   *  segment — a subfolder that climbs out of the clone is an attempt, not a typo. */
  subfolder?: string;
  /** see {@link CopyTree} — real installs never pass this */
  copy?: CopyTree;
  /** Clones already made during THIS command, keyed by `cloneKey`. One monorepo publishes all three
   *  first-party plugins, so installing them today clones the same repository three times — measured at
   *  15.5 s per plugin install, 28.3 s for a project-scope one. The map is opened per command and disposed
   *  with `disposeCloneCache`; nothing here caches across commands, because a clone that outlives the
   *  command it was made for is a stale tree waiting to be installed from. */
  cloneCache?: Map<string, string>;
  /** how `git clone` runs; default Bun.spawn — tests inject one that never touches the network */
  spawn?: Spawn;
}

/** The key a clone is cached under.
 *
 *  `ref` is not something `addPlugin` takes yet — pinning is not implemented — but it is part of the key
 *  from the start, and deliberately so: a cache keyed on the URL alone hands back the wrong tree the day
 *  two refs of one repository are in play, and that bug would appear in a feature far away from here. With
 *  the key in one function, whoever adds pinning changes this and every caller inherits it. */
export const cloneKey = (source: string, ref?: string): string => `${source}#${ref ?? ""}`;

/** Remove every clone a command made. Call it in a `finally`: a half-written clone that outlives its
 *  command is litter in %TEMP% that nobody will ever look at again. */
export function disposeCloneCache(cache: Map<string, string> | undefined): void {
  if (cache === undefined) return;
  for (const dir of cache.values()) rmSync(dir, { recursive: true, force: true });
  cache.clear();
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

/** true for a symbolic link; an entry we cannot stat is treated as one and skipped */
function isSymlink(p: string): boolean {
  try { return lstatSync(p).isSymbolicLink(); } catch { return true; }
}

export async function addPlugin(source: string, opts: InstallOptions): Promise<AddResult> {
  let src = source, tmp: string | null = null;
  const copy: CopyTree = opts.copy ?? ((from, to, filter) => cpSync(from, to, { recursive: true, filter }));
  try {
    if (isGitSource(source)) {
      const key = cloneKey(source);
      const cached = opts.cloneCache?.get(key);
      if (cached !== undefined && isDir(cached)) {
        src = cached;                       // owned by the cache, so `tmp` stays null and nothing is removed
      } else {
        tmp = mkdtempSync(join(tmpdir(), "rovecode-plugin-"));
        const r = await (opts.spawn ?? defaultSpawn)(["git", "clone", "--depth", "1", "--quiet", "--", source, "."], tmp);
        if (r.code !== 0) return { ok: false, error: `git clone failed (exit ${r.code})${r.stderr.trim() ? `: ${r.stderr.trim().split("\n").at(-1)}` : ""}` };
        src = tmp;
        if (opts.cloneCache !== undefined) { opts.cloneCache.set(key, tmp); tmp = null; }   // ownership moves
      }
    }
    src = resolve(src);
    if (opts.subfolder !== undefined && opts.subfolder !== "") {
      const sub = opts.subfolder.split("\\").join("/");
      if (sub.startsWith("/") || /^[A-Za-z]:/.test(sub) || sub.split("/").includes("..")) {
        return { ok: false, error: `subfolder "${opts.subfolder}" escapes the source` };
      }
      const inner = resolve(join(src, sub));
      // resolve() alone is not the check: it happily returns a path outside src for a crafted input
      if (inner !== src && !inner.startsWith(src + sep)) return { ok: false, error: `subfolder "${opts.subfolder}" escapes the source` };
      if (!isDir(inner)) return { ok: false, error: `${source}: no folder "${opts.subfolder}" inside it` };
      src = inner;
    }
    if (!isDir(src)) return { ok: false, error: `${source}: not a directory` };
    const file = join(src, MANIFEST_FILE);
    if (!existsSync(file)) return { ok: false, error: `${source}: no ${MANIFEST_FILE} — a plugin is a folder with a manifest` };
    const warnings: string[] = [];
    const manifest = parseManifest(readFileSync(file, "utf8"), file, warnings);
    if (manifest === null) return { ok: false, error: warnings.join("; ") || `${file}: invalid manifest` };
    const root = scopeRoot(opts.scope, opts.cwd, opts.home);
    const dest = join(root, manifest.name);
    if (resolve(dest) === src) return { ok: false, error: `${source} is already the installed copy` };
    if (existsSync(dest) && !opts.force) return { ok: false, error: `plugin "${manifest.name}" already exists at ${dest} (use --force to replace)` };
    // Copied beside the target and swapped in. `rmSync(dest)` then `cpSync` reads naturally and is wrong:
    // between those two lines the plugin does not exist, and anything that ends the copy early — a full
    // disk, a file another process holds open on Windows, ^C during `market update --all` — has already
    // deleted a working plugin and leaves a half-written folder wearing its name. Rename is the one step
    // the filesystem will not perform half way.
    mkdirSync(root, { recursive: true });
    const staging = mkdtempSync(join(root, `.rovecode-add-${manifest.name}-`));
    try {
      copy(src, staging, (p) => !/(?:^|[\\/])(?:node_modules|\.git)(?:[\\/]|$)/.test(p) && !isSymlink(p));
      if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
      renameSync(staging, dest);
    } catch (e) {
      // a returned error, not a thrown one: every other way this function fails is a value, and `market
      // install a b c` should report which one could not be copied and carry on with the rest
      return { ok: false, error: `could not install "${manifest.name}" into ${dest}: ${e instanceof Error ? e.message : String(e)}` };
    } finally {
      rmSync(staging, { recursive: true, force: true });   // already gone once the rename succeeded
    }
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
