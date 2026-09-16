/** `rovecode mcp login <name>` (port #76) — the CLI half of MCP server OAuth. The flow is mcp/oauth.ts
 *  runMcpLoginFlow; the notices are rendered by cli/auth-login.ts describeNotice (the #66 `auth_url` notice:
 *  `open <url>` / `waiting for the browser to return to <callbackUrl>`). Mirror of auth-login.ts runAuthLogin/cmdAuthLogin.
 *  Order: the project mcp.json is parsed first (unparsable → exit 2: the user asked about THIS file), then the merged
 *  config is searched THROUGH THE TRUST GATE — the same loadMcpConfig({ trusted }) call the runtime makes (mcp/trust.ts,
 *  Berkay's 2026-09-04 decision): a server in an unapproved .rovecode/mcp.json or .mcp.json does not exist here either,
 *  so a login can never POST to a URL nobody approved. Unknown name, a stdio server or `enabled:false`
 *  → one stderr line, exit 1; the flow runs (probe → discovery → registration → browser → token exchange); the record
 *  lands under `mcp:<name>`; a verification connect through the ordinary McpManager (whose runtime provider finds the
 *  record: 1 authorized initialize, no further /token) proves the token works; the final line is
 *  `stored OAuth token for MCP server "<name>" in <credentialsPath()> (<expiryText>) — connected`.
 *  Exit codes: 0 stored + connected · 1 unknown/stdio/disabled/not-401/denied/flow or verification failure · 2 unparsable
 *  project config · 130 Ctrl-C (the loopback is closed). Tokens never reach stdout/stderr: notices carry none by
 *  construction (oauth/common.ts), flow errors are token-free (mcp/oauth.ts) and the only credential value echoed is
 *  the expiry. */

import { McpManager } from "../mcp/client.ts";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord, loadMcpConfig, mcpConfigPath, message, type McpServerConfig } from "../mcp/config.ts";
import { runMcpLoginFlow, type McpOAuthRecord } from "../mcp/oauth.ts";
import { trustedPredicate } from "../mcp/trust.ts";
import { loadState } from "../plugins/state.ts";
import { credentialsPath, rovecodeHome } from "../providers/auth.ts";
import type { OAuthDeps } from "../providers/oauth/common.ts";
import { defaultOAuthDeps } from "../providers/oauth/registry.ts";
import { describeNotice, expiryText } from "./auth-login.ts";

export const MCP_LOGIN_USAGE = "usage: rovecode mcp login <name>  — a url server from ~/.rovecode/mcp.json or a TRUSTED .rovecode/mcp.json / .mcp.json";

export interface McpCmdIo { out(line: string): void; err(line: string): void; /** the user home (default rovecodeHome()) */ home?: string }

/** The project file must parse before anything else happens (the user asked about THIS file): null when absent;
 *  throws with the reason when unparsable — the same refusal `mcp add` gives, nothing is rewritten. */
function checkProjectFile(path: string): void {
  if (!existsSync(path)) return;
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`${path}: invalid JSON (${message(err)}) — fix or remove it by hand; refusing to overwrite`);
  }
  if (!isRecord(json)) throw new Error(`${path}: root is not an object — fix or remove it by hand; refusing to overwrite`);
}

export interface McpLoginDeps {
  out: (line: string) => void;
  err: (line: string) => void;
  /** Ctrl-C */
  signal?: AbortSignal;
  /** network/clock overrides for the flow (tests) */
  oauth?: Partial<OAuthDeps>;
  /** loopback wait budget (default 5 minutes) */
  timeoutMs?: number;
  /** verification connect budget (default 10 s) */
  connectTimeoutMs?: number;
  /** the user home: the user mcp.json and the trust store live there (default rovecodeHome()) */
  home?: string;
}

/** Run one login. Returns the exit code: 0 stored + connected · 1 refused/failed · 2 unparsable project config · 130 cancelled. */
export async function runMcpLogin(name: string, cwd: string, deps: McpLoginDeps): Promise<number> {
  if (name.length === 0) {
    deps.err(MCP_LOGIN_USAGE);
    return 1;
  }
  const path = mcpConfigPath(cwd);
  try {
    checkProjectFile(path); // unparsable → exit 2 here: the user asked about THIS file
  } catch (err) {
    deps.err(`error: ${message(err)}`);
    return 2;
  }
  const home = deps.home ?? rovecodeHome();
  const warnings: string[] = [];
  // the runtime's own gate: an unapproved project file contributes nothing (its one warning names the approval command)
  const config = loadMcpConfig(cwd, warnings, { home, trusted: trustedPredicate(loadState(home)) }).find((c) => c.name === name);
  for (const w of warnings) deps.err(`warning: ${w}`);
  if (!config) {
    deps.err(`error: no MCP server "${name}" in ${path}, .mcp.json (trusted files only — rovecode mcp trust) or ${join(home, "mcp.json")}`);
    return 1;
  }
  if (config.transport === "stdio" || config.url === undefined) {
    deps.err(`error: MCP server "${name}" is a stdio server — OAuth login applies to url servers only`);
    return 1;
  }
  if (config.enabled === false) {
    deps.err(`error: MCP server "${name}" is disabled (enabled: false) — enable it first`);
    return 1;
  }
  const signal = deps.signal ?? new AbortController().signal;
  const oauth: OAuthDeps = { ...defaultOAuthDeps(), ...deps.oauth };
  deps.out(`rovecode mcp login ${name} — ${config.transport} ${config.url}`);
  let record: McpOAuthRecord;
  try {
    record = await runMcpLoginFlow(
      config,
      { notify: (n) => { for (const line of describeNotice(n)) deps.out(`  ${line}`); }, signal },
      { ...oauth, ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}) },
    );
  } catch (e) {
    if (signal.aborted) {
      deps.err("login cancelled");
      return 130;
    }
    deps.err(`error: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  const stored = `stored OAuth token for MCP server "${name}" in ${credentialsPath()} (${expiryText(record.expires, oauth.now())})`;
  const failure = await verifyConnect(config, deps.connectTimeoutMs);
  if (failure === undefined) {
    deps.out(`${stored} — connected`);
    return 0;
  }
  deps.out(stored);
  deps.err(`error: verification connect failed: ${failure}`);
  return 1;
}

/** One ordinary connect (the runtime provider picks the record up) — the failed[] text, or undefined when connected. */
async function verifyConnect(config: McpServerConfig, timeoutMs = 10_000): Promise<string | undefined> {
  const manager = new McpManager([config], { connectTimeoutMs: timeoutMs });
  try {
    const res = await manager.connect();
    return res.failed[0]?.error ?? (res.connected.includes(config.name) ? undefined : "not connected");
  } finally {
    await manager.close();
  }
}

/** argv entry (mcp-market-cmd.ts `login`): the words after `login`; SIGINT → abort. */
export async function cmdMcpLogin(args: string[], cwd: string, io: McpCmdIo): Promise<number> {
  const ac = new AbortController();
  const onSigint = (): void => ac.abort();
  process.once("SIGINT", onSigint);
  try {
    return await runMcpLogin(args[0] ?? "", cwd, { out: (l) => io.out(l), err: (l) => io.err(l), signal: ac.signal, ...(io.home !== undefined ? { home: io.home } : {}) });
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
}
