/** MCP server configuration loading (port #3).
 *  Merges `.rovecode/mcp.json` (ours) with `.mcp.json` (harvested, claude-code
 *  format `{ mcpServers: { name: {command,args,env,url,type} } }`); ours wins
 *  on a name clash. With a `home`, the USER file `<home>/mcp.json` is the lowest
 *  layer under both (that is where `rovecode mcp add` writes by default).
 *  `${NAME}` in args, env, headers or url is filled from the environment — so a
 *  project file can name a secret without holding it; an unset name skips the
 *  entry with a warning rather than launching a server with an empty key.
 *  Malformed files/entries are skipped with a warning — this loader never throws. */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** where each scope's file lives; the market's `add`/`remove` write exactly these */
export function mcpConfigFiles(cwd: string, home?: string): { user?: string; harvest: string; project: string } {
  return { ...(home !== undefined ? { user: join(home, "mcp.json") } : {}), harvest: join(cwd, ".mcp.json"), project: join(cwd, ".rovecode", "mcp.json") };
}

const VAR_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
/** `${NAME}` → env value; every missing name lands in `missing` (the caller decides that it is fatal) */
export function expandVars(text: string, env: Record<string, string | undefined>, missing: string[]): string {
  return text.replace(VAR_REF, (_m, name: string) => { const v = env[name]; if (v === undefined) { missing.push(name); return ""; } return v; });
}

export interface McpServerConfig {
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  /** extra HTTP headers (auth tokens etc.) for http transports */
  headers?: Record<string, string>;
  enabled?: boolean;
}

/** Shared narrow helper (also used by the manager in client.ts). */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Shared error-to-string helper (also used by the manager in client.ts). */
export function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Normalize one server entry (claude-code `.mcp.json` style or ours). Returns
 *  undefined (and records a warning) when the entry cannot produce a usable config. */
export function normalizeEntry(name: string, raw: unknown, file: string, warnings: string[], envSource: Record<string, string | undefined> = process.env): McpServerConfig | undefined {
  if (!isRecord(raw)) {
    warnings.push(`${file}: server "${name}" is not an object; skipped`);
    return undefined;
  }
  const missing: string[] = [];
  const fill = (s: string): string => expandVars(s, envSource, missing);
  const command = typeof raw.command === "string" && raw.command.length > 0 ? raw.command : undefined;
  const url = typeof raw.url === "string" && raw.url.length > 0 ? fill(raw.url) : undefined;
  const declared = typeof raw.transport === "string" ? raw.transport : typeof raw.type === "string" ? raw.type : undefined;

  let transport: "stdio" | "http" | undefined;
  if (declared === "stdio") transport = "stdio";
  else if (declared === "http" || declared === "streamable-http" || declared === "streamable_http") transport = "http";
  else if (declared === "sse") {
    warnings.push(`${file}: server "${name}" uses legacy sse transport (unsupported); skipped`);
    return undefined;
  } else if (declared !== undefined) {
    warnings.push(`${file}: server "${name}" has unknown transport "${declared}"; skipped`);
    return undefined;
  } else transport = url !== undefined ? "http" : command !== undefined ? "stdio" : undefined;

  if (transport === undefined) {
    warnings.push(`${file}: server "${name}" has neither command nor url; skipped`);
    return undefined;
  }
  if (transport === "stdio" && command === undefined) {
    warnings.push(`${file}: stdio server "${name}" is missing command; skipped`);
    return undefined;
  }
  if (transport === "http") {
    if (url === undefined) {
      warnings.push(`${file}: http server "${name}" is missing url; skipped`);
      return undefined;
    }
    try {
      new URL(url);
    } catch {
      warnings.push(`${file}: http server "${name}" has invalid url "${url}"; skipped`);
      return undefined;
    }
  }

  let args: string[] | undefined;
  if (raw.args !== undefined) {
    if (Array.isArray(raw.args) && raw.args.every((x): x is string => typeof x === "string")) {
      args = raw.args.map(fill);
    } else {
      warnings.push(`${file}: server "${name}" has non-string args; skipped`);
      return undefined;
    }
  }
  let env: Record<string, string> | undefined;
  if (isRecord(raw.env)) {
    env = {};
    for (const [k, v] of Object.entries(raw.env)) if (typeof v === "string") env[k] = fill(v);
  }
  let headers: Record<string, string> | undefined;
  if (isRecord(raw.headers)) {
    headers = {};
    for (const [k, v] of Object.entries(raw.headers)) if (typeof v === "string") headers[k] = fill(v);
  }
  if (missing.length > 0) {
    // an empty key would launch a server that fails on its first call; naming the variable is the fix
    warnings.push(`${file}: server "${name}" needs ${[...new Set(missing)].map((m) => `\${${m}}`).join(", ")} set in the environment; skipped`);
    return undefined;
  }

  const out: McpServerConfig = { name, transport };
  if (command !== undefined) out.command = command;
  if (args !== undefined) out.args = args;
  if (env !== undefined) out.env = env;
  if (url !== undefined) out.url = url;
  if (headers !== undefined) out.headers = headers;
  if (typeof raw.enabled === "boolean") out.enabled = raw.enabled;
  return out;
}

/** Parse one config file. Accepts the claude-code map form
 *  `{ mcpServers: { name: {...} } }` and, additionally (ours), a
 *  `{ servers: McpServerConfig[] }` array form. */
export function parseConfigFile(path: string, warnings: string[], envSource: Record<string, string | undefined> = process.env): McpServerConfig[] {
  if (!existsSync(path)) return [];
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    warnings.push(`${path}: unreadable (${message(err)}); file skipped`);
    return [];
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    warnings.push(`${path}: invalid JSON (${message(err)}); file skipped`);
    return [];
  }
  if (!isRecord(json)) {
    warnings.push(`${path}: root is not an object; file skipped`);
    return [];
  }
  const out: McpServerConfig[] = [];
  if (json.mcpServers !== undefined) {
    if (isRecord(json.mcpServers)) {
      for (const [name, raw] of Object.entries(json.mcpServers)) {
        const cfg = normalizeEntry(name, raw, path, warnings, envSource);
        if (cfg) out.push(cfg);
      }
    } else warnings.push(`${path}: "mcpServers" is not an object; ignored`);
  }
  if (json.servers !== undefined) {
    if (Array.isArray(json.servers)) {
      for (const raw of json.servers) {
        const name = isRecord(raw) && typeof raw.name === "string" && raw.name.length > 0 ? raw.name : undefined;
        if (name === undefined) {
          warnings.push(`${path}: servers[] entry without a name; skipped`);
          continue;
        }
        const cfg = normalizeEntry(name, raw, path, warnings, envSource);
        if (cfg) out.push(cfg);
      }
    } else warnings.push(`${path}: "servers" is not an array; ignored`);
  }
  return out;
}

/** Merge the user file (`<home>/mcp.json`, only when a home is given) under `.mcp.json` (harvest)
 *  under `.rovecode/mcp.json` (ours). The most local wins on a name clash. Pass a `warnings` array
 *  to collect human-readable skip reasons. */
export function loadMcpConfig(cwd: string, warnings: string[] = [], opts: { home?: string; env?: Record<string, string | undefined> } = {}): McpServerConfig[] {
  const files = mcpConfigFiles(cwd, opts.home);
  const byName = new Map<string, McpServerConfig>();
  for (const path of [files.user, files.harvest, files.project]) {
    if (path === undefined) continue;
    for (const c of parseConfigFile(path, warnings, opts.env)) byName.set(c.name, c); // later layers win
  }
  return [...byName.values()];
}
