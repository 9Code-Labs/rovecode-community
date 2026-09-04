/** MCP server configuration loading (port #3).
 *  Merges `.rovecode/mcp.json` (ours) with `.mcp.json` (harvested, claude-code
 *  format `{ mcpServers: { name: {command,args,env,url,type} } }`); ours wins
 *  on a name clash. Malformed files/entries are skipped with a warning — this
 *  loader never throws. */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

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
export function normalizeEntry(name: string, raw: unknown, file: string, warnings: string[]): McpServerConfig | undefined {
  if (!isRecord(raw)) {
    warnings.push(`${file}: server "${name}" is not an object; skipped`);
    return undefined;
  }
  const command = typeof raw.command === "string" && raw.command.length > 0 ? raw.command : undefined;
  const url = typeof raw.url === "string" && raw.url.length > 0 ? raw.url : undefined;
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
      args = [...raw.args];
    } else {
      warnings.push(`${file}: server "${name}" has non-string args; skipped`);
      return undefined;
    }
  }
  let env: Record<string, string> | undefined;
  if (isRecord(raw.env)) {
    env = {};
    for (const [k, v] of Object.entries(raw.env)) if (typeof v === "string") env[k] = v;
  }
  let headers: Record<string, string> | undefined;
  if (isRecord(raw.headers)) {
    headers = {};
    for (const [k, v] of Object.entries(raw.headers)) if (typeof v === "string") headers[k] = v;
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
function parseConfigFile(path: string, warnings: string[]): McpServerConfig[] {
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
        const cfg = normalizeEntry(name, raw, path, warnings);
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
        const cfg = normalizeEntry(name, raw, path, warnings);
        if (cfg) out.push(cfg);
      }
    } else warnings.push(`${path}: "servers" is not an array; ignored`);
  }
  return out;
}

/** Merge `.rovecode/mcp.json` (ours) with `.mcp.json` (harvest). Ours wins on a
 *  name clash. Pass a `warnings` array to collect human-readable skip reasons. */
export function loadMcpConfig(cwd: string, warnings: string[] = []): McpServerConfig[] {
  const harvest = parseConfigFile(join(cwd, ".mcp.json"), warnings);
  const ours = parseConfigFile(join(cwd, ".rovecode", "mcp.json"), warnings);
  const byName = new Map<string, McpServerConfig>();
  for (const c of harvest) byName.set(c.name, c);
  for (const c of ours) byName.set(c.name, c); // ours wins
  return [...byName.values()];
}
