/** Preloaded before every `bun test` file (bunfig.toml [test] preload): point ROVECODE_HOME at an empty
 *  temp directory unless the caller already chose one, and clear the environment variables a provider or
 *  the update check would read.
 *
 *  Why this is not optional. rovecodeHome() defaults to ~/.rovecode, so without this the suite reads the
 *  machine it runs on: the developer's installed skills, plugins, MCP servers and credentials. That has
 *  broken the suite twice for reasons that had nothing to do with the change under test — installing the
 *  canvas-design skill failed plugins-runtime.test.ts, and installing two MCP servers failed twenty-five
 *  tests, several by spawning real `npx` servers inside integration timeouts. A test that passes or fails
 *  depending on what the person running it has installed is not testing the code.
 *
 *  The home was only half of it. Provider resolution also reads the environment — `<PROVIDER>_API_KEY`,
 *  ROVECODE_BASE_URL + ROVECODE_API_KEY, ROVECODE_MODEL — so with an empty home and ANTHROPIC_API_KEY exported
 *  in the shell, a headless run on a clean checkout still reached api.anthropic.com and billed a real call
 *  (verified 2026-09-06, $0.078). Every ROVECODE_* knob has the same shape of problem in miniature: a shell
 *  with ROVECODE_SANDBOX=wsl or ROVECODE_PERMISSION=auto exported would change what the tests observe.
 *  scrubProviderEnv() removes them all; what stays is ROVECODE_HOME (set below) and ROVECODE_FUZZ_* (the
 *  docs cleaner's fuzz knobs — a developer sets them ON PURPOSE for one run).
 *
 *  A test that wants a home or a variable of its own still gets one: scratchHome() (test/helpers/mcp-trust.ts)
 *  and every `process.env.ROVECODE_HOME = …` / `process.env.ROVECODE_SANDBOX = …` in the suite run AFTER this
 *  and win; auth.test.ts deletes the variable to check the ~/.rovecode default path. This only supplies the
 *  floor. */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** variables kept even though they match the ROVECODE_ prefix */
const KEEP = new Set(["ROVECODE_HOME", "ROVECODE_FUZZ_SEED", "ROVECODE_FUZZ_ROUNDS"]);

/** Is this a variable the code under test reads to reach a provider, a release check, or a knob? */
export function isProviderEnvName(name: string): boolean {
  if (KEEP.has(name)) return false;
  if (name.startsWith("ROVECODE_")) return true;        // every knob: BASE_URL, API_KEY, MODEL, SANDBOX, PERMISSION, …
  if (name.endsWith("_API_KEY")) return true;           // keyNameFor(): <PROVIDER>_API_KEY, plus models.dev names of that shape
  return name === "GITHUB_TOKEN" || name === "GH_TOKEN"; // core/update-check.ts
}

/** Delete every provider-shaped variable from `env` (process.env by default); returns the names removed. */
export function scrubProviderEnv(env: Record<string, string | undefined> = process.env): string[] {
  const removed: string[] = [];
  for (const name of Object.keys(env)) {
    if (!isProviderEnvName(name)) continue;
    delete env[name];
    removed.push(name);
  }
  return removed.sort();
}

scrubProviderEnv();

if (process.env.ROVECODE_HOME === undefined) {
  const home = mkdtempSync(join(tmpdir(), "rovecode-test-home-"));
  process.env.ROVECODE_HOME = home;
  // best effort: a killed run leaves the directory in the temp folder, which the OS clears
  process.on("exit", () => { try { rmSync(home, { recursive: true, force: true }); } catch { /* going away anyway */ } });
}
