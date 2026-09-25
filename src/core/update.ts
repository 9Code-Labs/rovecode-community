/** Self-update: how THIS installation gets to the newer release the update-check named.
 *
 *  Rovecode ships three ways and each updates differently, so the first job is honest detection
 *  (core/update.ts detectInstallMode): an npm install (the published tarball — `npm install -g
 *  rovecode@<channel>`), a source checkout (git pull + bun install, and build:cli when a dist was
 *  built), or a compiled single binary (no self-swap yet: the release page's artifact is the answer,
 *  said plainly rather than attempted and half-done). Detection is path arithmetic, injected and
 *  testable; nothing here guesses from the version string alone.
 *
 *  The channel follows the running version unless told otherwise: a prerelease (0.4.0-beta.1) stays
 *  on `beta`, a release stays on `latest` — an auto-update must never silently move someone between
 *  channels.
 *
 *  `autoUpdate` (settings.json / ROVECODE_AUTO_UPDATE=1) runs the plan in the BACKGROUND at TUI
 *  boot when the cached update-check says a newer version exists. It never blocks the session and
 *  never swaps the running process: on Windows a live executable's files are being replaced under
 *  it, so the honest promise is "updated — restart to run it", which is what the note says. */

import { existsSync } from "node:fs";
import { join, sep } from "node:path";

export type InstallMode = "npm" | "source" | "binary" | "unknown";
export type UpdateChannel = "beta" | "latest";

export interface DetectedInstall {
  mode: InstallMode;
  /** the package root (npm: the rovecode dir under node_modules; source: the repo root) when known */
  root?: string;
  /** npm: the install sits under npm's global prefix (decides -g) */
  npmGlobal?: boolean;
}

/** bun's compiled binaries run their modules from a virtual FS whose path starts with this */
const BUNFS = "/$bunfs/";

/** Where does the running entry live? `entry` is the main module's path (import.meta.path of the
 *  CLI entry), `exec` the runtime's own (process.execPath), `npmGlobalPrefix` the answer of
 *  `npm prefix -g` when the caller already has it (undefined = decide later, at run time). */
export function detectInstallMode(paths: { entry: string; exec?: string; npmGlobalPrefix?: string }): DetectedInstall {
  const entry = paths.entry.replace(/\\/g, "/");
  if (entry.includes(BUNFS) || (paths.exec !== undefined && paths.exec.replace(/\\/g, "/").includes(BUNFS))) {
    return { mode: "binary" };
  }
  const nm = entry.lastIndexOf("/node_modules/");
  if (nm >= 0) {
    // the package root is node_modules/<name> (a scoped name adds one segment)
    const after = entry.slice(nm + "/node_modules/".length);
    const segs = after.split("/");
    const pkgSegs = after.startsWith("@") ? segs.slice(0, 2) : segs.slice(0, 1);
    const root = entry.slice(0, nm) + "/node_modules/" + pkgSegs.join("/");
    const prefix = paths.npmGlobalPrefix?.replace(/\\/g, "/").replace(/\/$/, "");
    const npmGlobal = prefix !== undefined
      ? root.toLowerCase().startsWith((prefix + "/node_modules/").toLowerCase())
      : undefined;
    return { mode: "npm", root, ...(npmGlobal !== undefined ? { npmGlobal } : {}) };
  }
  // a source checkout: the entry is src/cli/main.ts (or bin/…) inside a git repo
  for (const cand of sourceRootCandidates(paths.entry)) {
    if (existsSync(join(cand, ".git"))) return { mode: "source", root: cand };
  }
  return { mode: "unknown" };
}

/** walk up from the entry file to the plausible repo roots (bounded: an entry deep in a monorepo) */
function sourceRootCandidates(entry: string): string[] {
  const out: string[] = [];
  let dir = entry.includes(sep) || entry.includes("/") ? entry.replace(/\\/g, "/").split("/").slice(0, -1).join("/") : ".";
  for (let i = 0; i < 6 && dir.length > 0; i++) {
    out.push(dir.replace(/\//g, sep));
    const up = dir.split("/").slice(0, -1).join("/");
    if (up === dir) break;
    dir = up;
  }
  return out;
}

export interface UpdatePlan {
  mode: InstallMode;
  channel: UpdateChannel;
  /** the commands to run, in order; empty for binary/unknown (manual carries the words) */
  commands: string[][];
  cwd?: string;
  /** what a human does when there is no command to run */
  manual?: string;
}

/** The channel: explicit wins; otherwise a prerelease stays on beta, a release stays on latest. */
export function channelFor(currentVersion: string, explicit?: UpdateChannel | "auto"): UpdateChannel {
  if (explicit === "beta" || explicit === "latest") return explicit;
  return currentVersion.includes("-") ? "beta" : "latest";
}

export function planUpdate(install: DetectedInstall, opts: { currentVersion: string; channel?: UpdateChannel | "auto"; distBuilt?: boolean }): UpdatePlan {
  const channel = channelFor(opts.currentVersion, opts.channel);
  switch (install.mode) {
    case "npm": {
      const spec = `rovecode@${channel}`;
      // -g when the install is global; a local (project) install updates in its project root.
      // npmGlobal undefined = the caller did not resolve `npm prefix -g` yet: runUpdate decides.
      if (install.npmGlobal === false && install.root) {
        const root = install.root.replace(/\\/g, "/");
        const i = root.lastIndexOf("/node_modules/");
        const project = i > 0 ? root.slice(0, i).replace(/\//g, sep) : undefined;
        return { mode: "npm", channel, commands: [["npm", "install", spec]], ...(project ? { cwd: project } : {}) };
      }
      return { mode: "npm", channel, commands: [["npm", "install", "-g", spec]] };
    }
    case "source": {
      const cmds: string[][] = [["git", "pull", "--ff-only"], ["bun", "install"]];
      if (opts.distBuilt === true) cmds.push(["bun", "run", "build:cli"]);
      return { mode: "source", channel, commands: cmds, ...(install.root ? { cwd: install.root } : {}) };
    }
    case "binary":
      return { mode: "binary", channel, commands: [], manual: "a compiled binary does not replace itself yet — download the new artifact from the releases page (https://github.com/9Code-Labs/rovecode-community/releases) and swap the file" };
    default:
      return { mode: "unknown", channel, commands: [], manual: "cannot tell how this copy was installed — update it the way you installed it (npm: `npm install -g rovecode@" + channel + "`; source: `git pull && bun install`)" };
  }
}

export interface RunUpdateDeps {
  /** run one command, stream-free: returns the exit code and the merged tail of its output */
  spawn(cmd: string[], cwd?: string): Promise<{ code: number; out: string }>;
  /** npm only, and only when the plan did not pre-decide: resolve `npm prefix -g` */
  npmGlobalPrefix?(): Promise<string | undefined>;
  log?(line: string): void;
}

export interface UpdateResult { ok: boolean; detail: string; ran: string[] }

/** Run the plan's commands in order; the first failure stops and reports. Never throws. */
export async function runUpdate(plan: UpdatePlan, install: DetectedInstall, deps: RunUpdateDeps): Promise<UpdateResult> {
  const ran: string[] = [];
  if (plan.commands.length === 0) return { ok: false, detail: plan.manual ?? "nothing to run", ran };
  let commands = plan.commands;
  // an npm plan whose -g question was left open: answer it now, once, from `npm prefix -g`
  if (plan.mode === "npm" && install.npmGlobal === undefined && install.root && deps.npmGlobalPrefix) {
    const prefix = (await deps.npmGlobalPrefix())?.replace(/\\/g, "/").replace(/\/$/, "");
    if (prefix) {
      const global = install.root.replace(/\\/g, "/").toLowerCase().startsWith((prefix + "/node_modules/").toLowerCase());
      const spec = plan.commands[0]![plan.commands[0]!.length - 1]!;
      commands = global ? [["npm", "install", "-g", spec]] : [["npm", "install", spec]];
    }
  }
  for (const cmd of commands) {
    deps.log?.(`$ ${cmd.join(" ")}`);
    let r: { code: number; out: string };
    try { r = await deps.spawn(cmd, plan.cwd); }
    catch (e) { return { ok: false, detail: `${cmd[0]} failed to start: ${e instanceof Error ? e.message : String(e)}`, ran }; }
    ran.push(cmd.join(" "));
    if (r.code !== 0) return { ok: false, detail: `${cmd.join(" ")} exited ${r.code}: ${tail(r.out)}`, ran };
  }
  return { ok: true, detail: "updated — restart rovecode to run the new version", ran };
}

function tail(s: string, max = 400): string {
  const t = s.trim();
  return t.length > max ? "…" + t.slice(-max) : t;
}
