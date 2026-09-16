/** Project trust — ONE store and ONE predicate for every file a checkout can use to make rovecode EXECUTE something.
 *
 *  A repository is data from the network. Berkay's 2026-09-04 decision put project MCP files and project plugins behind
 *  a digest gate: nothing of theirs loads until this machine approved THIS content of THIS file. Three more project files
 *  had walked in beside them without being asked — found in the 2026-09-07 survey — and this module is where the same
 *  gate now covers all of them:
 *    .rovecode/hooks.ts | hooks.js   imported IN-PROCESS at boot with the person's privileges (core/hooks.ts) — the worst
 *                                    of the five: no spawn to classify, no execpolicy to consult
 *    .rovecode/sandbox.json          the executor rung and the docker image every bash command runs in (core/sandbox-config.ts)
 *    .rovecode/settings.json         when it carries a COMMAND-BEARING key — verify (a shell string), lsp (an argv table),
 *                                    notify_command (an argv) — core/settings.ts COMMAND_KEYS, enforced inside loadSettings
 *                                    so no consumer can forget
 *    .rovecode/mcp.json, .mcp.json   servers (mcp/config.ts loadMcpConfig, since 2026-09-04)
 *    .rovecode/plugins/<name>        by folder digest (plugins/state.ts, since 2026-09-04)
 *  Out of scope, on purpose: .rovecode/commands/*.md and .rovecode/agents/*.md are prompt text, not executables — a
 *  different class of gate (prompt injection), not this one.
 *
 *  The store is plugins/state.ts's `trusted` map in the USER home (~/.rovecode/plugins.json): absolute path → sha256 of
 *  the bytes the person approved. In the user home so a repo cannot trust itself; a digest so a `git pull` that changes
 *  the file asks again; one map so `rovecode trust` and `rovecode mcp trust` are two names for the same yes.
 *
 *  Cost: loadSettings runs per boot and per run (verify, lsp) and the gate adds a stat + sha256 per call. Digests and the
 *  state file are memoised on path + mtimeMs + size, so a hot call is two stats and a Map lookup (measured in
 *  test/unit/project-trust.test.ts). A rewrite that keeps the size within the same mtime tick is not seen until the next
 *  tick — acceptable for a file a human edits, and no test writes that fast without changing the size. */

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { loadState, saveState, statePath, trustKey, type PluginState } from "../plugins/state.ts";

export type TrustStatus = "trusted" | "untrusted" | "absent";

interface Stamp { mtimeMs: number; size: number }
const same = (a: Stamp, b: Stamp): boolean => a.mtimeMs === b.mtimeMs && a.size === b.size;
const stamp = (path: string): Stamp | undefined => { try { const s = statSync(path); return s.isFile() ? { mtimeMs: s.mtimeMs, size: s.size } : undefined; } catch { return undefined; } };

const digests = new Map<string, Stamp & { digest: string }>();
/** sha256 (hex) of a file's bytes — the trust key for a project file; undefined when absent or unreadable */
export function fileDigest(file: string): string | undefined {
  const st = stamp(file);
  if (st === undefined) { digests.delete(file); return undefined; }
  const hit = digests.get(file);
  if (hit !== undefined && same(hit, st)) return hit.digest;
  let digest: string;
  try { digest = createHash("sha256").update(readFileSync(file)).digest("hex"); } catch { return undefined; }
  digests.set(file, { ...st, digest });
  return digest;
}

const states = new Map<string, Stamp & { state: PluginState }>();
/** the trust store, memoised on the state file's stamp (an absent file is "nothing decided" and is not cached) */
export function trustState(home: string): PluginState {
  const path = statePath(home);
  const st = stamp(path);
  if (st === undefined) { states.delete(path); return loadState(home); }
  const hit = states.get(path);
  if (hit !== undefined && same(hit, st)) return hit.state;
  const state = loadState(home);
  states.set(path, { ...st, state });
  return state;
}

/** the predicate the loaders take: is THIS content of THIS file approved on this machine */
export function trustedPredicate(state: PluginState): (file: string, digest: string) => boolean {
  return (file, digest) => state.trusted[trustKey(file)] === digest;
}

export function fileTrustStatus(home: string, file: string): TrustStatus {
  const digest = fileDigest(file);
  if (digest === undefined) return "absent";
  return trustedPredicate(trustState(home))(file, digest) ? "trusted" : "untrusted";
}

/** the one question every gate asks; an absent file is not trusted (there is nothing to trust) */
export function isTrustedFile(home: string, file: string): boolean { return fileTrustStatus(home, file) === "trusted"; }

/** record the file's CURRENT bytes as approved; an absent file only loses any stale entry */
export function trustFile(home: string, file: string): { ok: true; digest: string } | { ok: false; reason: string } {
  const state = loadState(home);
  const digest = fileDigest(file);
  if (digest === undefined) { delete state.trusted[trustKey(file)]; saveState(home, state); return { ok: false, reason: `${file}: no such file` }; }
  state.trusted[trustKey(file)] = digest;
  saveState(home, state);
  return { ok: true, digest };
}

export function untrustFile(home: string, file: string): boolean {
  const state = loadState(home);
  const had = trustKey(file) in state.trusted;
  delete state.trusted[trustKey(file)];
  saveState(home, state);
  return had;
}

/** The hint every untrusted-file note ends with. It names BOTH spellings on purpose: the CLI verb and
 *  the TUI command do the same thing, and a note that names only `rovecode trust` tells a person sitting
 *  in the TUI to quit their session to answer a question the TUI can ask. Telling someone to leave in
 *  order to approve something is how a gate gets switched off instead of answered. */
export const TRUST_HINT = "Review: rovecode trust show (in the TUI: /trust show) · approve: rovecode trust (or /trust)";

/** the one line an untrusted project file gets: the file, what stays off and why, the review and the approval command */
export function untrustedFileNote(file: string, what: string): string {
  return `${file}: not trusted on this machine — ${what}. ${TRUST_HINT}`;
}
