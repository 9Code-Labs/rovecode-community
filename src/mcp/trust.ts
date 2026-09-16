/** Trust for PROJECT MCP files (.rovecode/mcp.json, .mcp.json) — since 2026-09-07 one name for the general project
 *  trust store in core/trust.ts (the same store and the same bar as project plugins: ~/.rovecode/plugins.json `trusted`,
 *  keyed by the file's absolute path, value = sha256 of its bytes). The store lives in the USER home, so a repo cannot
 *  trust itself; any edit to the file changes the digest and the gate asks again. An untrusted file contributes NOTHING
 *  (config.ts loadMcpConfig skips it with one warning) — absence, not "loaded but marked". Berkay's choice on top of the
 *  gate: files he writes himself through `mcp add --project` / `mcp remove --project` are trusted the moment he approves
 *  them (market-install.ts records the digest right after the write); hand-edited and cloned files ask.
 *  `rovecode mcp trust` acts on the MCP files only; `rovecode trust` (cli/trust-cmd.ts) on every gated project file. */

import { existsSync } from "node:fs";
import { fileDigest, fileTrustStatus, trustFile, trustedPredicate, untrustFile, type TrustStatus } from "../core/trust.ts";
import { mcpConfigFiles } from "./config.ts";

export { fileDigest, trustedPredicate };
export type { TrustStatus };

export const mcpTrustStatus = fileTrustStatus;
export const trustMcpFile = trustFile;
export const untrustMcpFile = untrustFile;

/** the project files that exist in this checkout — what `mcp trust` / `mcp show` act on */
export function projectMcpFiles(cwd: string): string[] {
  const f = mcpConfigFiles(cwd);
  return [f.harvest, f.project].filter((p) => existsSync(p));
}
