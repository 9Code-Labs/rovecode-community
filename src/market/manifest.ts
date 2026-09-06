/** Where an installed thing CAME FROM. The disk stays the source of truth for whether something is
 *  installed — `installedState` looks for the folder or the config entry, so a skill deleted by hand stops
 *  being installed the moment it is gone, which no record file could guarantee. This file carries only what
 *  the disk cannot know: which catalog row it was, which source, which commit that resolved to, and when.
 *
 *  Three rules, each of which exists because the alternative reads as a bug to whoever hits it:
 *   - A MISSING record is not an error. Anything installed before this file existed, or copied into place
 *     by hand, has no record; `list` says its origin is unknown rather than pretending it is not installed.
 *   - An EXTRA record is not an error either. A record whose thing is gone from disk is ignored, and the
 *     next write drops it, so orphans cannot pile up.
 *   - SECRETS never land here. A clone URL carrying a token (`https://user:token@host/repo.git`) is
 *     scrubbed before it is written, and an MCP install records the PATH of its mcp.json, never the
 *     contents — the file itself already keeps secrets out by writing `${NAME}`.
 *
 *  One file per scope: `~/.rovecode/installed.json` for user installs, `<cwd>/.rovecode/installed.json`
 *  for the project's. The project one is committed with the repo, which is the other reason a token in a
 *  URL would be a real leak rather than a tidiness problem. */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { MarketItem, MarketKind, MarketScope, MarketSource } from "./types.ts";

export const MANIFEST_VERSION = 1;

export interface InstallRecord {
  kind: MarketKind;
  id: string;
  /** which shelf the row came from, so "curated" and "someone's git URL" are never confused */
  source: MarketSource;
  scope: MarketScope;
  /** ISO-8601, UTC */
  installedAt: string;
  /** which surface wrote it. `mcp add` records too, but only when it installed a PACKAGE (install-once):
   *  that record carries the integrity hash, and a plain config line still has nothing to record. */
  installedBy: "market" | "mcp add";
  /** where it landed: the folder, or the mcp.json that holds the entry */
  target: string;
  /** the catalog row's own version at the time, when it stated one */
  catalogVersion?: string;
  /** what landed on disk, hashed at install — see digest.ts. `--ref` pins what was ASKED for; this is
   *  what arrived, and it is the part that can still be checked later. Absent for an MCP entry, which
   *  is a line inside a shared file rather than a folder of its own. */
  digest?: { algo: "sha256"; value: string; files: number };
  /** for anything cloned: the URL as it was fetched (scrubbed) and the commit it resolved to */
  git?: {
    source: string; sha?: string; ref?: string;
    /** which command produced the tree — so "was that ref a branch or a commit?" has an answer */
    resolvedBy?: "branch" | "commit" | "default";
  };
  /** an MCP server installed ONCE as an npm package (mcp/local-package.ts) instead of `npx -y` at every
   *  start: what npm put on disk. `integrity` is npm's hash for the tarball, from the lockfile; when the
   *  lockfile could not supply it, `missing` says so in words rather than the field being silently absent.
   *  This is the record an `npx` line never has — it runs whatever "latest" is and leaves nothing behind. */
  package?: {
    name: string;
    version: string;
    /** the shared prefix it was installed into (~/.rovecode/mcp) */
    prefix: string;
    /** the bin `node` launches, absolute */
    bin: string;
    integrity?: string;
    resolved?: string;
    /** what could not be recorded and why; absent when everything above is filled */
    missing?: string[];
  };
}

interface ManifestFile { version: number; installs: InstallRecord[] }

export function manifestPath(scope: MarketScope, cwd: string, home: string): string {
  return scope === "project" ? join(cwd, ".rovecode", "installed.json") : join(home, "installed.json");
}

/** A URL with its credentials removed. `https://someone:ghp_xxx@github.com/o/r.git` becomes
 *  `https://github.com/o/r.git` — the record is about provenance, and a token is not provenance. */
export function scrubUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.username || u.password) { u.username = ""; u.password = ""; return u.toString(); }
    return url;
  } catch {
    // not a URL (an ssh spec like git@host:owner/repo.git, or a local path): strip an inline
    // `user:secret@` if one is there, and otherwise leave it alone
    return url.replace(/^([a-z+]+:\/\/)?[^/@\s]*:[^/@\s]+@/i, "$1");
  }
}

/** Read a scope's manifest. A missing, unreadable or malformed file is an EMPTY manifest, never a throw:
 *  provenance is a nice-to-have and must not be able to stop an install. */
export function readManifest(scope: MarketScope, cwd: string, home: string): InstallRecord[] {
  const path = manifestPath(scope, cwd, home);
  if (!existsSync(path)) return [];
  try {
    const json: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof json !== "object" || json === null) return [];
    const installs = (json as ManifestFile).installs;
    if (!Array.isArray(installs)) return [];
    return installs.filter(isRecord);
  } catch { return []; }
}

function isRecord(v: unknown): v is InstallRecord {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Partial<InstallRecord>;
  return typeof r.id === "string" && (r.kind === "mcp" || r.kind === "skill" || r.kind === "plugin")
    && (r.scope === "user" || r.scope === "project") && typeof r.target === "string";
}

const sameItem = (a: { kind: MarketKind; id: string }, b: { kind: MarketKind; id: string }): boolean =>
  a.kind === b.kind && a.id === b.id;

export interface WriteOptions {
  cwd: string;
  home: string;
  /** which records still describe something on disk; orphans are dropped on every write */
  stillInstalled?: (r: InstallRecord) => boolean;
}

function save(scope: MarketScope, records: InstallRecord[], opts: WriteOptions): void {
  const path = manifestPath(scope, opts.cwd, opts.home);
  const keep = opts.stillInstalled ? records.filter(opts.stillInstalled) : records;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ version: MANIFEST_VERSION, installs: keep }, null, 2) + "\n");
  } catch { /* a read-only home must not fail an install that already succeeded */ }
}

/** Record one install, replacing any earlier record for the same kind+id in that scope. */
export function recordInstall(record: InstallRecord, opts: WriteOptions): void {
  const others = readManifest(record.scope, opts.cwd, opts.home).filter((r) => !sameItem(r, record));
  save(record.scope, [...others, record], opts);
}

/** Drop the record for one item, if there is one. */
export function forgetInstall(kind: MarketKind, id: string, scope: MarketScope, opts: WriteOptions): void {
  const records = readManifest(scope, opts.cwd, opts.home);
  const left = records.filter((r) => !sameItem(r, { kind, id }));
  if (left.length !== records.length) save(scope, left, opts);
}

/** The record for one item, from whichever scope it is installed in. */
export function recordFor(item: Pick<MarketItem, "kind" | "id">, scope: MarketScope, cwd: string, home: string): InstallRecord | undefined {
  return readManifest(scope, cwd, home).find((r) => sameItem(r, item));
}

/** Build the record for an install that just happened. `sha` is filled by the caller when a clone
 *  resolved one; nothing here invents it, because an unverified commit id is worse than no commit id. */
export function buildRecord<T extends Pick<MarketItem, "kind" | "id" | "source" | "version">>(item: T, opts: {
  scope: MarketScope; target: string; now?: () => Date;
  digest?: { algo: "sha256"; value: string; files: number };
  git?: { source: string; sha?: string; ref?: string; resolvedBy?: "branch" | "commit" | "default" };
  package?: NonNullable<InstallRecord["package"]>;
  installedBy?: InstallRecord["installedBy"];
}): InstallRecord {
  const record: InstallRecord = {
    kind: item.kind, id: item.id, source: item.source, scope: opts.scope,
    installedAt: (opts.now ? opts.now() : new Date()).toISOString(),
    installedBy: opts.installedBy ?? "market", target: opts.target,
  };
  if (item.version !== undefined) record.catalogVersion = item.version;
  if (opts.digest) record.digest = opts.digest;
  if (opts.package) {
    // `missing` is kept only when it says something: an empty list would read as "checked, nothing missing"
    // to one reader and as noise to the next, and the absent field already means the former
    const { missing, ...rest } = opts.package;
    record.package = { ...rest, ...(missing !== undefined && missing.length > 0 ? { missing } : {}) };
  }
  if (opts.git) {
    record.git = { source: scrubUrl(opts.git.source),
      ...(opts.git.sha !== undefined ? { sha: opts.git.sha } : {}),
      ...(opts.git.ref !== undefined ? { ref: opts.git.ref } : {}),
      ...(opts.git.resolvedBy !== undefined ? { resolvedBy: opts.git.resolvedBy } : {}) };
  }
  return record;
}

/** One line about where something came from, for `market list`. Absent record → the honest sentence
 *  rather than silence, because "installed, origin unknown" is a real and common state. */
export function originLine(r: InstallRecord | undefined): string {
  if (r === undefined) return "origin unknown — installed before rovecode kept a record, or by hand";
  const when = r.installedAt.slice(0, 10);
  if (r.git) {
    const pin = r.git.ref !== undefined ? ` (${r.git.resolvedBy === "commit" ? "commit" : "branch/tag"} ${r.git.ref})` : "";
    return `${r.git.source}${pin}${r.git.sha ? ` @ ${r.git.sha.slice(0, 12)}` : ""} · ${when}`;
  }
  return `${r.source} · ${when}`;
}
