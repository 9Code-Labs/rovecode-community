/** Install-once for MCP servers the market would otherwise launch with `npx -y <package>`.
 *
 *  Why this exists, in numbers (Windows 11, node 24, npm 11, the memory and filesystem servers, medians of
 *  3–5 runs through McpManager, measured 2026-09-06): a warm `npx -y` takes 1.8–2.1 s from spawn to the
 *  initialize handshake; the same package installed once and launched with `node <its bin>` takes
 *  0.35–0.47 s. The difference is npx itself — `npx --version` alone is 0.6 s, and every warm launch still
 *  asks registry.npmjs.org to revalidate the package (0.3–1.3 s, and no network means a timeout path). A
 *  cold cache is 7 s and a 47 MB download, repeated whenever upstream publishes, because `-y <package>`
 *  means "latest". The one-time install is ~6 s and ~30 MB for two servers sharing one SDK copy.
 *
 *  What it is NOT: silent, or the only path. The human is asked, in the plan they approve, and "no" leaves
 *  the npx line exactly as it is today. Installing code is a bigger act than writing a config line, and
 *  the plan says so in those words. The record in installed.json carries the package name, the version
 *  that landed and npm's integrity hash from the lockfile — an install that is recorded is auditable; an
 *  `npx -y` that runs whatever "latest" is at every start is not.
 *
 *  Where: one shared prefix, `~/.rovecode/mcp/`, with its own package.json so npm never mistakes a parent
 *  folder for the project. N servers share one node_modules and one SDK copy. The launch line is `node`
 *  plus the ABSOLUTE path of the package's bin — never the .cmd shim (it means cmd.exe and its quoting),
 *  and the path survives a space because it is one argv entry, not a shell string. */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { McpServerConfig } from "./config.ts";
import type { MarketInstall } from "./market.ts";

export type Spawn = (cmd: string[], cwd: string) => Promise<{ code: number; stderr: string }>;

/** the package an `npx …` launch line runs, taken apart */
export interface NpxPackage {
  /** the package name, `@scope/name` or `name` */
  name: string;
  /** what npx was given: name, or `name@version` when the catalog pinned one */
  spec: string;
  /** the pinned version, when the spec carried one */
  version?: string;
  /** the arguments the SERVER receives — everything after the package spec */
  rest: string[];
}

const NPX_FLAGS_NO_VALUE = new Set(["-y", "--yes", "-q", "--quiet", "--no-install", "--prefer-offline", "--prefer-online"]);
/** `@scope/name`, `name`, optionally `@version` — a registry package and nothing else (no git URL, no tarball, no path) */
const PACKAGE_SPEC = /^(@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)(?:@([^@\s/]+))?$/;

/** The package a stdio `npx` launch runs, or undefined when the line is not a plain `npx [flags] <package>
 *  [args]` — an `npx -p x cmd`, a git URL or a tarball is left to npx, since we cannot say what we would be
 *  installing. Undefined means "no offer", never an error: the npx line still works. */
export function npxPackage(install: MarketInstall): NpxPackage | undefined {
  if (install.kind !== "stdio" || install.runtime !== "npx" || install.command !== "npx") return undefined;
  let i = 0;
  while (i < install.args.length && install.args[i]!.startsWith("-")) {
    if (!NPX_FLAGS_NO_VALUE.has(install.args[i]!)) return undefined; // a flag with a value (-p, --package, -c): not our shape
    i += 1;
  }
  const spec = install.args[i];
  if (spec === undefined) return undefined;
  const m = PACKAGE_SPEC.exec(spec);
  if (!m) return undefined;
  const out: NpxPackage = { name: m[1]!, spec, rest: install.args.slice(i + 1) };
  if (m[2] !== undefined) out.version = m[2];
  return out;
}

/** the shared prefix every install-once server lives in */
export function localPrefix(home: string): string { return join(home, "mcp"); }

/** what landed on disk, read back after npm finished — the record's source of truth */
export interface LocalPackage {
  name: string;
  version: string;
  /** ABSOLUTE path of the package's bin script — what `node` runs */
  bin: string;
  /** npm's integrity hash for the tarball, from package-lock.json */
  integrity?: string;
  /** the tarball URL npm resolved, from package-lock.json */
  resolved?: string;
  /** what could not be recorded and why — an empty list is the normal case. Written into installed.json
   *  as it is, so a record with a hole says where the hole is instead of leaving a field silently absent. */
  missing: string[];
}

export interface InstallLocalDeps {
  /** how `npm install` runs — tests inject one that writes a fake node_modules and never touches the network */
  spawn?: Spawn;
}

const defaultSpawn: Spawn = async (cmd, cwd) => {
  const p = Bun.spawn(cmd, { cwd, stdout: "ignore", stderr: "pipe", stdin: "ignore" });
  return { code: await p.exited, stderr: await new Response(p.stderr).text() };
};

/** the exact argv `installLocalPackage` runs — exported so the plan can show it verbatim */
export function npmInstallArgv(pkg: NpxPackage, prefix: string): string[] {
  return ["npm", "install", "--prefix", prefix, "--save", "--no-fund", "--no-audit", "--loglevel=error", pkg.spec];
}

/** Run `npm install` for one package into the shared prefix, then read back what landed. Never throws for
 *  an npm failure — the caller shows the error and nothing has been written to mcp.json yet. */
export async function installLocalPackage(pkg: NpxPackage, prefix: string, deps: InstallLocalDeps = {}): Promise<{ ok: true; pkg: LocalPackage } | { ok: false; error: string }> {
  const spawn = deps.spawn ?? defaultSpawn;
  try {
    mkdirSync(prefix, { recursive: true });
    // a package.json of its own, so npm treats the prefix as the project: without one it can walk up and
    // install into whatever package.json it finds above ~/.rovecode
    const manifest = join(prefix, "package.json");
    if (!existsSync(manifest)) {
      writeFileSync(manifest, JSON.stringify({ name: "rovecode-mcp-servers", private: true, description: "MCP servers installed once by rovecode's market — launched with node, not npx (docs/mcp-market.md)" }, null, 2) + "\n");
    }
    const r = await spawn(npmInstallArgv(pkg, prefix), prefix);
    if (r.code !== 0) return { ok: false, error: `npm install ${pkg.spec} failed (exit ${r.code})${r.stderr.trim() ? `: ${r.stderr.trim().split("\n").slice(-3).join(" · ")}` : ""}` };
  } catch (e) {
    return { ok: false, error: `npm install ${pkg.spec} could not run: ${e instanceof Error ? e.message : String(e)}` };
  }
  return readLocalPackage(pkg.name, prefix);
}

/** What is on disk for one package under the prefix: version and bin from its package.json, integrity from
 *  the lockfile. `ok: false` when the package or its bin is not there — then there is nothing to launch. */
export function readLocalPackage(name: string, prefix: string): { ok: true; pkg: LocalPackage } | { ok: false; error: string } {
  const dir = join(prefix, "node_modules", ...name.split("/"));
  const manifestPath = join(dir, "package.json");
  if (!existsSync(manifestPath)) return { ok: false, error: `npm reported success but ${manifestPath} is not there` };
  let manifest: Record<string, unknown>;
  try { manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>; }
  catch (e) { return { ok: false, error: `${manifestPath}: ${e instanceof Error ? e.message : String(e)}` }; }
  const version = typeof manifest.version === "string" ? manifest.version : undefined;
  if (version === undefined) return { ok: false, error: `${manifestPath} states no version` };
  const binRel = binOf(name, manifest.bin);
  if (binRel === undefined) return { ok: false, error: `${name} declares no bin — there is nothing for node to run; npx would have failed the same way` };
  const bin = resolve(dir, binRel);
  if (!existsSync(bin)) return { ok: false, error: `${name}'s bin ${bin} is not on disk` };
  const missing: string[] = [];
  const lock = lockEntry(prefix, name, missing);
  const pkg: LocalPackage = { name, version, bin, missing };
  if (lock?.integrity !== undefined) pkg.integrity = lock.integrity;
  if (lock?.resolved !== undefined) pkg.resolved = lock.resolved;
  return { ok: true, pkg };
}

/** the bin a package declares: a string, or a map — the entry named like the package, else the only one */
function binOf(name: string, bin: unknown): string | undefined {
  if (typeof bin === "string") return bin;
  if (typeof bin !== "object" || bin === null) return undefined;
  const entries = Object.entries(bin as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string");
  if (entries.length === 0) return undefined;
  const short = name.split("/").pop()!;
  return (entries.find(([k]) => k === short) ?? entries[0]!)[1];
}

/** package-lock.json (lockfileVersion 2/3) → the entry for `node_modules/<name>`. Every way it can fall
 *  short is written into `missing` in words, because a silent undefined here becomes a record that looks
 *  complete and is not. */
function lockEntry(prefix: string, name: string, missing: string[]): { integrity?: string; resolved?: string } | undefined {
  const lockPath = join(prefix, "package-lock.json");
  if (!existsSync(lockPath)) { missing.push(`integrity: ${lockPath} was not written by npm`); return undefined; }
  let lock: unknown;
  try { lock = JSON.parse(readFileSync(lockPath, "utf8")); }
  catch { missing.push(`integrity: ${lockPath} is not valid JSON`); return undefined; }
  const packages = typeof lock === "object" && lock !== null ? (lock as { packages?: unknown }).packages : undefined;
  if (typeof packages !== "object" || packages === null) { missing.push(`integrity: ${lockPath} has no "packages" map (lockfileVersion 1?)`); return undefined; }
  const entry = (packages as Record<string, unknown>)[`node_modules/${name}`];
  if (typeof entry !== "object" || entry === null) { missing.push(`integrity: ${lockPath} has no entry for node_modules/${name}`); return undefined; }
  const e = entry as { integrity?: unknown; resolved?: unknown };
  const out: { integrity?: string; resolved?: string } = {};
  if (typeof e.integrity === "string") out.integrity = e.integrity; else missing.push(`integrity: the lockfile entry for ${name} carries no integrity field`);
  if (typeof e.resolved === "string") out.resolved = e.resolved;
  return out;
}

/** the mcp.json launch line for an installed package: `node` + the bin's absolute path + the server's own
 *  arguments. One argv entry per item — a path with a space in it is still one argument, because nothing
 *  here goes through a shell (mcp/client.ts spawns with shell: false). */
export function localLaunch(pkg: LocalPackage, rest: string[]): { command: "node"; args: string[] } {
  return { command: "node", args: [pkg.bin, ...rest] };
}

/** the launch line as the plan can show it BEFORE the install: the bin's exact filename is read from the
 *  package after npm has put it there, so the preview names the folder and marks the file as pending */
export function plannedLaunchLabel(pkg: NpxPackage, prefix: string): string {
  return ["node", `${join(prefix, "node_modules", ...pkg.name.split("/"))}${process.platform === "win32" ? "\\" : "/"}<its bin, read after the install>`, ...pkg.rest].join(" ");
}

/** the plan rows that say what installing once means — every word the human should read before the yes */
export function localPlanLines(pkg: NpxPackage, prefix: string): string[] {
  return [
    `  installs   ${npmInstallArgv(pkg, prefix).join(" ")}`,
    `             rovecode runs a package manager for you here. npm downloads ${pkg.spec} and everything it depends`,
    `             on and puts their CODE on this machine, under ${prefix} — typically 20–30 MB and a few seconds, once.`,
    `             In return the server starts in ~0.4 s instead of ~2 s and needs no network to start.`,
    `             Requires npm (it comes with Node.js, as npx does).`,
    `  records    package name, version and npm's integrity hash in installed.json — what ran is on record`,
    `             (an npx line runs whatever "latest" is at every start, and records nothing)`,
  ];
}

/** a configured server that still launches through npx — the rows `mcp list` may offer the install-once line for */
export function launchesViaNpx(server: McpServerConfig): boolean {
  return server.transport === "stdio" && server.command === "npx" && server.enabled !== false;
}

/** the one-line offer `mcp list` prints under the rows when some of them start through npx. Says what
 *  changes, what it costs and that nothing happens until the human runs the command — no config is
 *  rewritten by a listing. */
export function npxOfferLine(names: string[]): string | undefined {
  if (names.length === 0) return undefined;
  const n = names.length;
  // `<catalog name>`, not the server name the row shows: `mcp add` takes the name you installed it by (a
  // registry server is `io.github.acme/widgets`, its row is `widgets`), and a renamed one needs its `--as` back
  return `${n} server${n === 1 ? "" : "s"} start${n === 1 ? "s" : ""} through npx, which re-resolves the package at every start (~2 s each): ${names.join(", ")}. `
    + `To start in ~0.4 s, reinstall with \`rovecode mcp add <catalog name> --local --force\` (the name you installed it by; add \`--as <server name>\` if you renamed it; installs the package once, ~25 MB). Nothing changes until you do.`;
}
