/** Shared hermetic support for the gauntlet (gauntlet.ts runner, gauntlet-wave3.ts / gauntlet-wave4.ts
 *  tasks): the per-run scratch root, env scoping, and the trust seeding a wave task needs before it can
 *  believe its own verdict. Pure helpers with no task logic — the task files stay the one place each
 *  guardrail is exercised. Ported 2026-09-07 from the upstream harness's port #29/#31 wave support. */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { trustFile } from "../core/trust.ts";

// ---------- per-run scratch root ----------

/** Name prefix of a run's scratch root, created directly under the OS temp dir. Every task workspace
 *  (`rovecode-g-*`) and runner session dir (`rovecode-cli-g-*`) of the run is made UNDER it, and the leak
 *  check (runGauntlet) lists only its direct children — so two runs overlapping on one machine never see,
 *  count or delete each other's dirs. The whole root is removed when the run ends. */
export const GAUNTLET_ROOT_PREFIX = "rovecode-gauntlet-";

export function createGauntletRoot(): string { return mkdtempSync(join(tmpdir(), GAUNTLET_ROOT_PREFIX)); }

/** Absolute paths of the root's direct children — the leak check's whole world. Empty once the root
 *  is gone; never throws. */
export function rootEntries(root: string): Set<string> {
  try { return new Set(readdirSync(root).map((n) => join(root, n))); } catch { return new Set(); }
}

/** One recursive delete; injected by tests to simulate a dir the OS will not release. */
export type RmTree = (dir: string) => void;
const rmTree: RmTree = (dir) => rmSync(dir, { recursive: true, force: true });

/** Remove the run's root — best-effort and BOUNDED: at most `attempts` tries a short pause apart
 *  (Windows answers EBUSY/ENOTEMPTY while a just-reaped child still holds a cwd). Returns null once
 *  the root is gone, else a one-line report for the caller to print; never throws, never retries
 *  forever, never touches anything outside `root`. */
export function removeGauntletRoot(root: string, o: { attempts?: number; pauseMs?: number; rm?: RmTree } = {}): string | null {
  const attempts = Math.max(1, o.attempts ?? 3);
  const rm = o.rm ?? rmTree;
  let why = "";
  for (let i = 0; i < attempts; i++) {
    try { rm(root); } catch (e) { why = e instanceof Error ? e.message : String(e); }
    if (!existsSync(root)) return null;
    if (i + 1 < attempts) Bun.sleepSync(o.pauseMs ?? 100);
  }
  return `gauntlet root not removed after ${attempts} attempt${attempts === 1 ? "" : "s"} (busy?): ${root}${why ? ` — ${why}` : ""}`;
}

// ---------- env scoping ----------

/** Set env keys for the duration of `fn`, restoring exactly (undefined = delete). Sequential
 *  gauntlet tasks make this safe; every runtime knob a task needs is scoped here. */
export async function withEnv<T>(over: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(over)) saved[k] = process.env[k];
  for (const [k, v] of Object.entries(over)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

// ---------- project hooks under the trust gate ----------

/** The env a wave task boots the real runtime under: its own scratch home, hooks ON, and the two
 *  determinism knobs. Spread into withEnv by the task (never set globally). */
export function waveEnv(home: string): Record<string, string | undefined> {
  return { ROVECODE_HOME: home, ROVECODE_NO_REPOMAP: "1", ROVECODE_NO_CHECKPOINTS: "1", ROVECODE_NO_HOOKS: undefined };
}

/** Write `<cwd>/.rovecode/hooks.ts` AND approve it in `home`'s trust store — both halves, always.
 *
 *  The trust gate (core/trust.ts, 2026-09-07) makes loadHooks skip a project hooks.ts whose bytes this
 *  machine has not approved. A wave task that writes a hook and forgets to trust it does not get a
 *  weaker test — it gets a test of something else entirely: the upstream case that proves "a blanket
 *  `allow` hook cannot un-forbid a command" would still pass with the hook never loaded, because
 *  execpolicy denies the command on its own. That is a case that cannot go red, so the two writes are
 *  one function and the tasks assert the hook is LIVE (rt.hooks.size, plus a positive control) before
 *  believing any verdict. Returns the hooks file path. */
export function writeTrustedHooks(cwd: string, home: string, body: string): string {
  const file = join(cwd, ".rovecode", "hooks.ts");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `export default { version: 1, hooks: {\n${body}\n} };\n`);
  const r = trustFile(home, file);
  if (!r.ok) throw new Error(`gauntlet: could not trust ${file}: ${r.reason}`);
  return file;
}
