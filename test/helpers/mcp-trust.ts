/** For tests that need a PROJECT mcp.json to actually load: since the trust gate (src/mcp/trust.ts) a hand-written
 *  .mcp.json / .rovecode/mcp.json contributes nothing until approved in the user home's plugins.json. These two
 *  helpers keep such tests honest AND hermetic — the approval goes into a scratch ROVECODE_HOME, never the host's. */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rovecodeHome } from "../../src/providers/auth.ts";
import { trustMcpFile } from "../../src/mcp/trust.ts";

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
