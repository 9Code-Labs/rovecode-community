/** Plugins: what the human decided about them — `~/.rovecode/plugins.json`. Two facts only:
 *  which plugins are switched off, and which PROJECT plugins this machine trusts, by folder and by a
 *  digest of the folder's contents.
 *
 *  Why a digest and why in the USER home: a project plugin lives in a checkout, and a checkout is
 *  data from the network. Recording "trusted: true" inside `<cwd>/.rovecode/settings.json` would let the
 *  repository trust itself; recording it here, keyed by the plugin's absolute folder and the hash of
 *  every file in it, means the human said yes to THIS code on THIS machine, and a `git pull` that
 *  changes the plugin asks again. User-scope plugins need no record: `rovecode plugin add` copying a
 *  folder into `~/.rovecode/plugins` IS the human's yes.
 *
 *  A missing, unreadable or malformed file reads as "nothing decided" — never an error. */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

export interface PluginState {
  /** plugin names switched off in every scope */
  disabled: string[];
  /** absolute project-plugin folder → digest the human approved */
  trusted: Record<string, string>;
}

export const STATE_FILE = "plugins.json";
export const statePath = (home: string): string => join(home, STATE_FILE);

const SKIP_DIRS = new Set(["node_modules", ".git"]);

export function loadState(home: string): PluginState {
  const out: PluginState = { disabled: [], trusted: {} };
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(statePath(home), "utf8")); } catch { return out; }
  if (typeof raw !== "object" || raw === null) return out;
  const r = raw as Record<string, unknown>;
  if (Array.isArray(r["disabled"])) out.disabled = r["disabled"].filter((v): v is string => typeof v === "string");
  if (typeof r["trusted"] === "object" && r["trusted"] !== null && !Array.isArray(r["trusted"])) {
    for (const [k, v] of Object.entries(r["trusted"] as Record<string, unknown>)) if (typeof v === "string") out.trusted[k] = v;
  }
  return out;
}

export function saveState(home: string, state: PluginState): string {
  const path = statePath(home);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ disabled: [...state.disabled].sort(), trusted: state.trusted }, null, 2) + "\n");
  return path;
}

/** every regular file under the plugin folder (node_modules/.git skipped), sorted, relative posix paths */
export function pluginFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    let entries: import("node:fs").Dirent[];
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.push(relative(dir, p).replace(/\\/g, "/"));
    }
  };
  walk(dir);
  return out.sort();
}

/** sha256 over `<relative path>\0<bytes>\0` for every file — the same folder gives the same digest on
 *  every machine, and one changed byte in one file changes it */
export function pluginDigest(dir: string): string {
  const h = createHash("sha256");
  for (const rel of pluginFiles(dir)) {
    h.update(rel); h.update("\0");
    try { h.update(readFileSync(join(dir, rel))); } catch { /* vanished mid-walk: the digest still moves */ }
    h.update("\0");
  }
  return h.digest("hex");
}

export const trustKey = (dir: string): string => resolve(dir).replace(/\\/g, "/");
export function isTrusted(state: PluginState, dir: string, digest: string): boolean { return state.trusted[trustKey(dir)] === digest; }

/** a folder exists and is a directory */
export function isDir(p: string): boolean { try { return statSync(p).isDirectory(); } catch { return false; } }
