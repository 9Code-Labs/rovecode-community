/** For tests that need a PROJECT file to actually load: since the trust gate (src/core/trust.ts) a hand-written
 *  .mcp.json / .rovecode/mcp.json, .rovecode/hooks.ts, .rovecode/sandbox.json or a .rovecode/settings.json carrying
 *  verify / lsp / notify_command contributes nothing until approved in the user home's plugins.json. These helpers keep
 *  such tests honest AND hermetic — the approval goes into a scratch ROVECODE_HOME, never the host's. A test that plants
 *  one of those files and wants it to act must call trustProjectFiles(cwd[, home]) after writing it, exactly as a human
 *  would run `rovecode trust --yes`; a test that wants to prove the gate leaves the file untrusted. */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rovecodeHome } from "../../src/providers/auth.ts";
import { trustMcpFile } from "../../src/mcp/trust.ts";
import { trustFile } from "../../src/core/trust.ts";

/** every gated project file present under <cwd>/.rovecode (+ <cwd>/.mcp.json) is approved as it is NOW in `home`
 *  (default: the current ROVECODE_HOME); returns the files trusted. Call it AFTER the last write to those files. */
export function trustProjectFiles(cwd: string, home: string = rovecodeHome()): string[] {
  const files = [".rovecode/settings.json", ".rovecode/hooks.ts", ".rovecode/hooks.js", ".rovecode/sandbox.json", ".rovecode/mcp.json", ".mcp.json"]
    .map((rel) => join(cwd, rel)).filter((p) => existsSync(p));
  for (const f of files) { const r = trustFile(home, f); if (!r.ok) throw new Error(r.reason); }
  return files;
}

/** point ROVECODE_HOME at a fresh temp dir; the returned function restores the env and removes the dir */
export function scratchHome(): () => void {
  const home = mkdtempSync(join(tmpdir(), "rovecode-home-"));
  const saved = process.env.ROVECODE_HOME;
  process.env.ROVECODE_HOME = home;
  return () => { if (saved === undefined) delete process.env.ROVECODE_HOME; else process.env.ROVECODE_HOME = saved; rmSync(home, { recursive: true, force: true }); };
}

/** write `{ mcpServers }` into <cwd>/<file> and approve it in the CURRENT ROVECODE_HOME (call scratchHome first
 *  unless the test already scopes the home) — what a human's `rovecode mcp trust` would do */
export function writeTrustedMcpJson(cwd: string, mcpServers: Record<string, unknown>, file = ".mcp.json"): string {
  const path = join(cwd, file);
  writeFileSync(path, JSON.stringify({ mcpServers }));
  const r = trustMcpFile(rovecodeHome(), path);
  if (!r.ok) throw new Error(r.reason);
  return path;
}
