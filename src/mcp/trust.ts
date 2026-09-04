/** Trust for PROJECT MCP files (.rovecode/mcp.json, .mcp.json) — the same store and the same bar as project
 *  plugins (plugins/state.ts): ~/.rovecode/plugins.json `trusted`, keyed by the file's absolute path, value =
 *  sha256 of its bytes. The store lives in the USER home, so a repo cannot trust itself; any edit to the file
 *  changes the digest and the gate asks again. An untrusted file contributes NOTHING (config.ts loadMcpConfig
 *  skips it with one warning) — absence, not "loaded but marked". Berkay's choice on top of the gate: files
 *  he writes himself through `mcp add --project` / `mcp remove --project` are trusted the moment he approves
 *  them (market-install.ts records the digest right after the write); hand-edited and cloned files ask. */

import { existsSync } from "node:fs";
import { loadState, saveState, trustKey, type PluginState } from "../plugins/state.ts";
import { fileDigest, mcpConfigFiles } from "./config.ts";

export { fileDigest };

/** the predicate loadMcpConfig takes: is THIS content of THIS file approved on this machine */
export function trustedPredicate(state: PluginState): (file: string, digest: string) => boolean {
  return (file, digest) => state.trusted[trustKey(file)] === digest;
}

export type TrustStatus = "trusted" | "untrusted" | "absent";
export function mcpTrustStatus(home: string, file: string): TrustStatus {
  const digest = fileDigest(file);
  if (digest === undefined) return "absent";
  return trustedPredicate(loadState(home))(file, digest) ? "trusted" : "untrusted";
}

/** record the file's CURRENT bytes as approved; an absent file only loses any stale entry */
export function trustMcpFile(home: string, file: string): { ok: true; digest: string } | { ok: false; reason: string } {
  const state = loadState(home);
  const digest = fileDigest(file);
  if (digest === undefined) { delete state.trusted[trustKey(file)]; saveState(home, state); return { ok: false, reason: `${file}: no such file` }; }
  state.trusted[trustKey(file)] = digest;
  saveState(home, state);
  return { ok: true, digest };
}

export function untrustMcpFile(home: string, file: string): boolean {
  const state = loadState(home);
  const had = trustKey(file) in state.trusted;
  delete state.trusted[trustKey(file)];
  saveState(home, state);
  return had;
}

/** the project files that exist in this checkout — what `mcp trust` / `mcp show --project` act on */
export function projectMcpFiles(cwd: string): string[] {
  const f = mcpConfigFiles(cwd);
  return [f.harvest, f.project].filter((p) => existsSync(p));
}
