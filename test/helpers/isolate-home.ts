/** Preloaded before every `bun test` file (bunfig.toml [test] preload): point ROVECODE_HOME at an empty
 *  temp directory unless the caller already chose one.
 *
 *  Why this is not optional. rovecodeHome() defaults to ~/.rovecode, so without this the suite reads the
 *  machine it runs on: the developer's installed skills, plugins, MCP servers and credentials. That has
 *  broken the suite twice for reasons that had nothing to do with the change under test — installing the
 *  canvas-design skill failed plugins-runtime.test.ts, and installing two MCP servers failed twenty-five
 *  tests, several by spawning real `npx` servers inside integration timeouts. A test that passes or fails
 *  depending on what the person running it has installed is not testing the code.
 *
 *  A test that wants a home of its own still gets one: scratchHome() (test/helpers/mcp-trust.ts) and every
 *  `process.env.ROVECODE_HOME = …` in the suite overwrite this, and auth.test.ts deletes the variable to
 *  check the ~/.rovecode default path. This only supplies the floor. */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (process.env.ROVECODE_HOME === undefined) {
  const home = mkdtempSync(join(tmpdir(), "rovecode-test-home-"));
  process.env.ROVECODE_HOME = home;
  // best effort: a killed run leaves the directory in the temp folder, which the OS clears
  process.on("exit", () => { try { rmSync(home, { recursive: true, force: true }); } catch { /* going away anyway */ } });
}
