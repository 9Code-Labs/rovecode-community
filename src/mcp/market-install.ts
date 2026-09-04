/** From a market entry to a line in mcp.json — in three visible steps, so no install is silent:
 *  planInstall picks the launch form and lists what must be asked; describePlan renders EXACTLY what
 *  will be written (command + args or URL, source, publisher, version, the env NAMES, the file) for the
 *  human to read before answering; fillPlan + writeServer put it on disk. Secrets: asked by name through
 *  the caller's masked prompt, written as values only into the USER file (~/.rovecode/mcp.json, 0o600
 *  where the OS honours it) — a PROJECT file gets `${NAME}` and the loader fills it from the environment
 *  at launch (config.ts expandVars), so a token never lands in a repo. Never on the command line: a
 *  stdio server receives them through `env`, docker through `-e NAME`. */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isRecord, mcpConfigFiles, normalizeEntry, parseConfigFile, type McpServerConfig } from "./config.ts";
import type { EnvSpec, MarketEntry, MarketInstall } from "./market.ts";
import { installLabel } from "./market.ts";

export type McpScope = "user" | "project";
const SERVER_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_-]*)\}/g;

export interface InstallPlan {
  entry: MarketEntry;
  install: MarketInstall;
  scope: McpScope;
  /** the mcp.json this lands in */
  file: string;
  /** the server's name in that file (= the tool prefix the model sees) */
  name: string;
  /** what has to be asked, in order; `secret` ones go through the masked prompt */
  asks: EnvSpec[];
  /** required arguments nobody can fill for the human (a directory, a database URL) */
  pending: string[];
  /** where a header placeholder maps back: variable name → header it belongs to */
  headerVars: Record<string, string>;
}

/** the server name a registry key gets in mcp.json: its last path segment, lowercased, unsafe runs → "-" */
export function defaultServerName(key: string): string {
  const tail = key.split("/").pop() ?? key;
  const name = tail.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+/, "").slice(0, 64);
  return name.length > 0 ? name : "server";
}

/** env-variable-safe spelling of a header name: `X-Api-Key` → `X_API_KEY` */
function headerVar(name: string): string { return name.toUpperCase().replace(/[^A-Z0-9_]/g, "_").replace(/^[0-9]/, "_$&"); }

export interface PlanOptions { scope: McpScope; cwd: string; home: string; /** which of entry.installs (default: the first) */ pick?: number; /** override the mcp.json name */ name?: string }

export function planInstall(entry: MarketEntry, opts: PlanOptions): InstallPlan | { error: string } {
  if (entry.installs.length === 0) return { error: `${entry.key} lists nothing rovecode can launch or connect to (no stdio package, no streamable-http remote)` };
  const ix = opts.pick ?? 0;
  const install = entry.installs[ix];
  if (!install) return { error: `${entry.key} has ${entry.installs.length} install form(s); --pick ${ix} is out of range` };
  const name = opts.name ?? (entry.source === "curated" ? entry.key : defaultServerName(entry.key));
  if (!SERVER_NAME.test(name)) return { error: `"${name}" is not a usable server name (lowercase letters, digits, . _ -)` };
  const files = mcpConfigFiles(opts.cwd, opts.home);
  const file = opts.scope === "project" ? files.project : files.user!;
  const asks: EnvSpec[] = [], headerVars: Record<string, string> = {};
  if (install.kind === "stdio") {
    for (const e of install.env) {
      // a filled default is not a question; an optional plain value without one is left out and named in the preview
      if (e.default !== undefined) continue;
      if (e.secret || e.required) asks.push(e);
    }
  } else {
    for (const h of install.headers) {
      const vars = [...(h.template ?? "").matchAll(PLACEHOLDER)].map((m) => m[1]!);
      if (h.template !== undefined && vars.length === 0) continue; // a literal header, nothing to ask
      for (const v of vars.length ? vars : [headerVar(h.name)]) {
        headerVars[v] = h.name;
        const spec: EnvSpec = { name: v, required: h.required, secret: h.secret };
        if (h.description) spec.description = h.description;
        asks.push(spec);
      }
    }
  }
  return { entry, install, scope: opts.scope, file, name, asks, pending: install.kind === "stdio" ? install.pending : [], headerVars };
}

/** the raw mcp.json entry, with answers in place. Secrets: a value in the USER file, `${NAME}` in a
 *  PROJECT file (and `${NAME}` whenever the answer is empty, so a later `export NAME=…` completes it) */
export function fillPlan(plan: InstallPlan, answers: Record<string, string>): Record<string, unknown> {
  const ref = (spec: EnvSpec): string | undefined => {
    const v = answers[spec.name];
    if (v !== undefined && v.length > 0 && !(spec.secret && plan.scope === "project")) return v;
    if (v === undefined || v.length === 0) { if (!spec.required && !(v !== undefined && spec.secret)) return undefined; }
    return `\${${spec.name}}`;
  };
  const { install } = plan;
  if (install.kind === "stdio") {
    const env: Record<string, string> = {};
    for (const e of install.env) {
      if (e.default !== undefined) { env[e.name] = e.default; continue; }
      const v = ref(e);
      if (v !== undefined) env[e.name] = v;
    }
    return { command: install.command, args: [...install.args], ...(Object.keys(env).length ? { env } : {}) };
  }
  const headers: Record<string, string> = {};
  for (const h of install.headers) {
    if (h.template !== undefined && !PLACEHOLDER.test(h.template)) { headers[h.name] = h.template; PLACEHOLDER.lastIndex = 0; continue; }
    PLACEHOLDER.lastIndex = 0;
    const vars = Object.entries(plan.headerVars).filter(([, hn]) => hn === h.name).map(([v]) => v);
    let value = h.template ?? `{${vars[0] ?? headerVar(h.name)}}`, complete = true;
    for (const v of vars) {
      const spec = plan.asks.find((a) => a.name === v)!;
      const r = ref(spec);
      if (r === undefined) { complete = false; break; }
      value = value.split(`{${v}}`).join(r);
    }
    if (complete) headers[h.name] = value;
  }
  return { type: "http", url: install.url, ...(Object.keys(headers).length ? { headers } : {}) };
}

/** the confirmation text — everything the human must see before anything is written. `asking` says how
 *  the plan's questions get answered: "prompt" (the CLI asks, secrets masked) or "env" (the TUI has no
 *  masked input, so every asked value is written as `${NAME}` and read from the environment at launch) */
export function describePlan(plan: InstallPlan, asking: "prompt" | "env" = "prompt"): string[] {
  const { entry, install } = plan;
  const asked = (secret: boolean): string => asking === "env" ? "(${NAME} — from your environment)" : secret ? "(asked, masked, never shown)" : "(asked)";
  const lines = [
    `${entry.title ?? entry.key}${entry.version ? ` ${entry.version}` : ""}${entry.status ? `  [${entry.status}]` : ""}`,
    `  source     ${entry.source === "curated" ? "curated list (built into rovecode)" : "MCP registry (registry.modelcontextprotocol.io)"}`,
    `  publisher  ${entry.publisher ?? "unknown"}`,
  ];
  if (entry.repository) lines.push(`  repo       ${entry.repository}`);
  lines.push(install.kind === "stdio" ? `  runs       ${installLabel(install)}` : `  connects   ${install.url}`);
  const envNames = install.kind === "stdio" ? install.env : [];
  for (const e of envNames) {
    const how = e.default !== undefined ? `= ${e.default}` : plan.asks.includes(e) ? asked(e.secret).replace("NAME", e.name) : "(optional, left unset)";
    lines.push(`  env        ${e.name} ${how}${e.required ? "" : "  optional"}`);
  }
  if (install.kind === "http") for (const h of install.headers) {
    const vars = Object.entries(plan.headerVars).filter(([, hn]) => hn === h.name).map(([v]) => v);
    lines.push(`  header     ${h.name}: ${vars.length ? `${h.template ?? `{${vars[0]}}`}  ← ${vars.join(", ")} ${asked(h.secret).replace("NAME", vars[0]!)}` : h.template ?? ""}${h.required ? "" : "  optional"}`);
  }
  for (const p of plan.pending) lines.push(`  needs      ${p} — add it to args in the file after installing`);
  lines.push(`  writes     ${plan.file}  as "${plan.name}"${asking === "prompt" && plan.scope === "project" && plan.asks.some((a) => a.secret) ? "  (secrets stay out of this file: ${NAME} is read from your environment)" : ""}`);
  return lines;
}

// ------------------------------------------------------------------ the file

interface FileShape { json: Record<string, unknown>; servers: Record<string, unknown> }
function readShape(file: string): FileShape {
  if (!existsSync(file)) return { json: {}, servers: {} };
  const json: unknown = JSON.parse(readFileSync(file, "utf8")); // a broken file is the human's to fix; we do not overwrite it
  if (!isRecord(json)) throw new Error(`${file}: root is not an object`);
  const servers = isRecord(json.mcpServers) ? json.mcpServers : {};
  return { json, servers };
}
function writeShape(file: string, shape: FileShape, secret: boolean): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ ...shape.json, mcpServers: shape.servers }, null, 2) + "\n", { mode: 0o600 });
  if (secret && process.platform !== "win32") chmodSync(file, 0o600);
}

/** add or replace one server; the entry is normalized first (every `${NAME}` counted as set) so the
 *  runtime is guaranteed to accept what was written. Returns the loader's view of it. */
export function writeServer(file: string, name: string, raw: Record<string, unknown>, opts: { replace?: boolean } = {}): McpServerConfig {
  const warnings: string[] = [];
  const cfg = normalizeEntry(name, raw, file, warnings, new Proxy({}, { get: () => "set" }) as Record<string, string>);
  if (!cfg) throw new Error(warnings.join("; ") || `${name}: not a valid server entry`);
  const shape = readShape(file);
  if (shape.servers[name] !== undefined && !opts.replace) throw new Error(`${file} already has a server named "${name}" — remove it first, or add --force`);
  shape.servers[name] = raw;
  const secret = JSON.stringify(raw).includes("env") || JSON.stringify(raw).includes("headers");
  writeShape(file, shape, secret);
  return cfg;
}

export function removeServer(file: string, name: string): boolean {
  if (!existsSync(file)) return false;
  const shape = readShape(file);
  if (shape.servers[name] === undefined) return false;
  delete shape.servers[name];
  writeShape(file, shape, false);
  return true;
}

/** every configured server with the scope it comes from, most local last (what the runtime would load) */
export function configuredServers(cwd: string, home: string): { scope: McpScope | "harvest"; file: string; server: McpServerConfig }[] {
  const files = mcpConfigFiles(cwd, home);
  const warnings: string[] = [];
  const all = new Proxy({}, { get: () => "set" }) as Record<string, string>; // list what is configured, not what is launchable right now
  const out: { scope: McpScope | "harvest"; file: string; server: McpServerConfig }[] = [];
  for (const [scope, file] of [["user", files.user!], ["harvest", files.harvest], ["project", files.project]] as const) {
    for (const server of parseConfigFile(file, warnings, all)) out.push({ scope, file, server });
  }
  return out;
}
