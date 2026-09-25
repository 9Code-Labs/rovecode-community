/** `rovecode update [--check] [--channel beta|latest|auto]` — and the flow the TUI's /update and
 *  the autoUpdate boot hook share. The brain is core/update.ts (detect → plan → run); this file is
 *  the surface: spawn glue, the words on the terminal, the exit code.
 *
 *  Rules: never swap the running process (on Windows the files under a live bun are being replaced;
 *  the honest promise is "restart to run it"), never move between channels silently (a beta stays
 *  on beta unless --channel says otherwise), and a binary install gets the release page URL rather
 *  than a half-done self-swap. */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { channelFor, detectInstallMode, planUpdate, runUpdate, type DetectedInstall, type UpdateChannel } from "../core/update.ts";
import { checkForUpdate, updateLine } from "../core/update-check.ts";

const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";

async function spawnCmd(cmd: string[], cwd?: string): Promise<{ code: number; out: string }> {
  const argv = cmd[0] === "npm" ? [npmCmd, ...cmd.slice(1)] : cmd;
  const p = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe" });
  const [o, e] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  return { code, out: o + e };
}

async function npmGlobalPrefix(): Promise<string | undefined> {
  try {
    const p = Bun.spawn([npmCmd, "prefix", "-g"], { stdout: "pipe", stderr: "ignore" });
    const t = (await new Response(p.stdout).text()).trim();
    await p.exited;
    return t.length > 0 ? t : undefined;
  } catch { return undefined; }
}

export interface UpdateFlowOpts {
  version: string;
  /** the running entry module's path (import.meta.path of the CLI entry) */
  entry: string;
  /** every line the flow wants the surface to show (CLI: stdout; TUI: notes) */
  log(line: string): void;
  /** unit-test seam: replace the spawners */
  deps?: { spawn?: typeof spawnCmd; prefix?: typeof npmGlobalPrefix; install?: DetectedInstall };
}

/** The whole job: check → detect → plan → run. Returns the process exit code (0 = fine or already
 *  current, 1 = an update was wanted and did not land, 2 = bad flags). */
export async function updateFlow(words: string[], opts: UpdateFlowOpts): Promise<number> {
  const checkOnly = words.includes("--check");
  const chanWord = words.includes("--channel") ? words[words.indexOf("--channel") + 1] : "auto";
  if (chanWord !== "auto" && chanWord !== "beta" && chanWord !== "latest") {
    opts.log("error: --channel must be beta, latest or auto");
    return 2;
  }
  const status = await checkForUpdate(opts.version, checkOnly ? { cacheOnly: true } : {});
  if (checkOnly) { opts.log(updateLine(status, true) ?? `up to date (${opts.version})`); return 0; }
  if (!status.newer) {
    opts.log(status.latest === undefined
      ? `no newer release is known (${updateLine(status, true) ?? `current: ${opts.version}`})`
      : `up to date (${opts.version})`);
    return 0;
  }
  const install = opts.deps?.install ?? detectInstallMode({ entry: opts.entry });
  const distBuilt = install.mode === "source" && install.root !== undefined && existsSync(join(install.root, "dist", "cli", "main.js"));
  const plan = planUpdate(install, { currentVersion: opts.version, channel: chanWord as UpdateChannel | "auto", distBuilt });
  opts.log(`update available: ${opts.version} → ${status.latest} · this copy is a ${install.mode} install · channel ${plan.channel} (${channelFor(opts.version, chanWord as UpdateChannel | "auto")} follows the running version)`);
  if (plan.commands.length === 0) { opts.log(plan.manual ?? "nothing to run"); return 1; }
  const r = await runUpdate(plan, install, {
    spawn: opts.deps?.spawn ?? spawnCmd,
    npmGlobalPrefix: opts.deps?.prefix ?? npmGlobalPrefix,
    log: opts.log,
  });
  opts.log(r.ok ? r.detail : `update failed: ${r.detail}`);
  return r.ok ? 0 : 1;
}

/** the CLI surface: `rovecode update …` */
export async function cmdUpdate(words: string[], version: string, entry: string): Promise<number> {
  return updateFlow(words, { version, entry, log: (l) => console.log(l) });
}
