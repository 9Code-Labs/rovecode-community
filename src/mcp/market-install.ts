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
import { isRecord, mcpConfigFiles, normalizeEntry, parseConfigFile, placeholderHoles, type McpServerConfig } from "./config.ts";
import type { EnvSpec, MarketEntry, MarketInstall } from "./market.ts";
import { installLabel } from "./market.ts";
import { mcpTrustStatus, trustMcpFile } from "./trust.ts";
import { localPlanLines, localPrefix, npxPackage, plannedLaunchLabel, type NpxPackage } from "./local-package.ts";

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
  /** install ONCE (mcp/local-package.ts): the npx package this line would run, and the shared prefix npm
   *  puts it in. Set only when the human asked for it — the default plan is today's npx line. The launch
   *  line written to the file is then `node <bin>`, known after npm has run, so fillPlan takes it as an
   *  argument instead of reading it from `install`. */
  local?: { pkg: NpxPackage; prefix: string };
}

/** the server name a registry key gets in mcp.json: its last path segment, lowercased, unsafe runs → "-" */
export function defaultServerName(key: string): string {
  const tail = key.split("/").pop() ?? key;
  const name = tail.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+/, "").slice(0, 64);
  return name.length > 0 ? name : "server";
}

/** env-variable-safe spelling of a header name: `X-Api-Key` → `X_API_KEY` */
function headerVar(name: string): string { return name.toUpperCase().replace(/[^A-Z0-9_]/g, "_").replace(/^[0-9]/, "_$&"); }

export interface PlanOptions {
  scope: McpScope; cwd: string; home: string;
  /** which of entry.installs (default: the first) */
  pick?: number;
  /** override the mcp.json name */
  name?: string;
  /** install the npx package once and launch it with node (the human said yes to the offer). An error when
   *  the chosen form is not a plain `npx <package>` line — silently falling back to npx would write a plan
   *  the human did not approve. */
  local?: boolean;
}

export function planInstall(entry: MarketEntry, opts: PlanOptions): InstallPlan | { error: string } {
  if (entry.installs.length === 0) return { error: `${entry.key} lists nothing rovecode can launch or connect to (no stdio package, no streamable-http remote)` };
  const ix = opts.pick ?? 0;
  const install = entry.installs[ix];
  if (!install) return { error: `${entry.key} has ${entry.installs.length} install form(s); --pick ${ix} is out of range` };
  const name = opts.name ?? (entry.source === "curated" ? entry.key : defaultServerName(entry.key));
  if (!SERVER_NAME.test(name)) return { error: `"${name}" is not a usable server name (lowercase letters, digits, . _ -)` };
  const files = mcpConfigFiles(opts.cwd, opts.home);
  const file = opts.scope === "project" ? files.project : files.user!;
  let local: InstallPlan["local"];
  if (opts.local === true) {
    // The launch line install-once writes is THIS machine's absolute path under its ROVECODE_HOME. A project
    // file is shared with everyone who clones the repo, so that line would be a server none of them can start
    // — refused with the way out, rather than written and discovered on someone else's machine.
    if (opts.scope === "project") return { error: `${entry.key}: install-once writes this machine's absolute path (node <home>/mcp/…), and a project file is shared with every clone — install it in user scope (drop --project) or keep the npx line` };
    const pkg = npxPackage(install);
    if (pkg === undefined) return { error: `${entry.key} cannot be installed once: its launch line is not a plain \`npx <package>\` (${installLabel(install)}) — drop --local to write it as it is` };
    local = { pkg, prefix: localPrefix(opts.home) };
  }
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
  return { entry, install, scope: opts.scope, file, name, asks, pending: install.kind === "stdio" ? install.pending : [], headerVars, ...(local ? { local } : {}) };
}

/** One `pending` fragment → the argv words it contributes. A fragment is literal words followed by one
 *  `<hole>` — "--root <path>" or "<directory the server may touch>" — so the flag survives whether or not
 *  anybody answered, and the hole is either the answer or the placeholder itself. Written into the file
 *  unanswered it is not a silent failure: mcp/config.ts refuses to launch a server that still carries one
 *  and names the line. Split on the hole rather than on whitespace, because a hole is usually a sentence. */
export function pendingWords(fragment: string, answer?: string): string[] {
  const m = /^(.*?)\s*(<[^<>]*>)\s*$/.exec(fragment);
  const filled = answer !== undefined && answer.length > 0;
  if (!m) return [filled ? answer : fragment];          // no hole at all: an older catalog's bare hint
  const lead = m[1]!.length > 0 ? m[1]!.split(/\s+/) : [];
  return [...lead, filled ? answer : m[2]!];
}

/** the raw mcp.json entry, with answers in place. Secrets: a value in the USER file, `${NAME}` in a
 *  PROJECT file (and `${NAME}` whenever the answer is empty, so a later `export NAME=…` completes it).
 *  `launch` replaces the entry's own command + args — the install-once path passes `node <bin>` here once
 *  npm has put the bin on disk (local-package.ts localLaunch); a plan without `local` never sets it. */
export function fillPlan(plan: InstallPlan, answers: Record<string, string>, launch?: { command: string; args: string[] }): Record<string, unknown> {
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
    // `pending` is the entry's required positional arguments — the filesystem server's directory, say.
    // They go into args either as the human's answer or, when nobody could be asked (the TUI has no
    // prompt, `--yes` did not stop), as the placeholder itself. Dropping them, which is what this did
    // first, wrote a server that could never start and a note pointing at a line that was not there.
    const positional = install.pending.flatMap((p) => pendingWords(p, answers[p]));
    const line = launch ?? { command: install.command, args: install.args };
    return { command: line.command, args: [...line.args, ...positional], ...(Object.keys(env).length ? { env } : {}) };
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

/** the asks whose `${NAME}` the filled entry actually carries — what the closing note tells the human to set.
 *  An optional ask nobody answered is left out of the entry (fillPlan), so naming it would send them to set a
 *  variable nothing reads. */
export function namesWritten(plan: InstallPlan, raw: Record<string, unknown>): string[] {
  const text = JSON.stringify(raw);
  return plan.asks.filter((a) => text.includes(`\${${a.name}}`)).map((a) => a.name);
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
  // install-once: the launch line the file will hold is `node <bin>`, and the rows under it say — in so many
  // words — that a package manager runs and code lands on this machine. That is the plan being approved.
  if (plan.local) lines.push(`  runs       ${plannedLaunchLabel(plan.local.pkg, plan.local.prefix)}`, ...localPlanLines(plan.local.pkg, plan.local.prefix));
  else lines.push(install.kind === "stdio" ? `  runs       ${installLabel(install)}` : `  connects   ${install.url}`);
  const envNames = install.kind === "stdio" ? install.env : [];
  for (const e of envNames) {
    const how = e.default !== undefined ? `= ${e.default}` : plan.asks.includes(e) ? asked(e.secret).replace("NAME", e.name) : "(optional, left unset)";
    lines.push(`  env        ${e.name} ${how}${e.required ? "" : "  optional"}`);
  }
  if (install.kind === "http") for (const h of install.headers) {
    const vars = Object.entries(plan.headerVars).filter(([, hn]) => hn === h.name).map(([v]) => v);
    lines.push(`  header     ${h.name}: ${vars.length ? `${h.template ?? `{${vars[0]}}`}  ← ${vars.join(", ")} ${asked(h.secret).replace("NAME", vars[0]!)}` : h.template ?? ""}${h.required ? "" : "  optional"}`);
  }
  for (const p of plan.pending) lines.push(`  needs      ${p} — ${asking === "env" ? "written as the placeholder; fill it in and the server connects" : "asked here; unanswered it is written as the placeholder"}`);
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
 *  runtime is guaranteed to accept what was written. Returns the loader's view of it. `trustHome`: the
 *  human just approved this exact content on a card/prompt, so a PROJECT file is recorded as trusted in
 *  that home's store right after the write (mcp/trust.ts) — the "trust my own" half of the gate. */
export function writeServer(file: string, name: string, raw: Record<string, unknown>, opts: { replace?: boolean; trustHome?: string } = {}): McpServerConfig & { trusted?: boolean } {
  const warnings: string[] = [];
  // allowPlaceholders: this validates the SHAPE of an entry the human just approved, and an unanswered
  // `pending` hole is part of that entry by design — writing it is how the human gets a line to edit. The
  // loader (parseConfigFile) applies the same check without the exemption, so the server is named and
  // skipped until it is filled rather than launched into an argument error.
  const cfg = normalizeEntry(name, raw, file, warnings, new Proxy({}, { get: () => "set" }) as Record<string, string>, { allowPlaceholders: true });
  if (!cfg) throw new Error(warnings.join("; ") || `${name}: not a valid server entry`);
  const shape = readShape(file);
  if (shape.servers[name] !== undefined && !opts.replace) throw new Error(`${file} already has a server named "${name}" — remove it first, or add --force`);
  // the human approved THIS entry. The rest of the file is approved only if it already was (or there was
  // no file): adding to a cloned, unapproved file must not quietly bless the strangers already in it.
  const mayTrust = opts.trustHome !== undefined && (!existsSync(file) || Object.keys(shape.servers).filter((k) => k !== name).length === 0 || mcpTrustStatus(opts.trustHome, file) === "trusted");
  shape.servers[name] = raw;
  const secret = JSON.stringify(raw).includes("env") || JSON.stringify(raw).includes("headers");
  writeShape(file, shape, secret);
  if (opts.trustHome === undefined) return cfg;
  if (mayTrust) trustMcpFile(opts.trustHome, file);
  return { ...cfg, trusted: mayTrust };
}

/** delete one server; with `trustHome` the file's new bytes stay approved when the file was approved
 *  before (a removal is the human's edit too) — an unapproved file stays unapproved */
export function removeServer(file: string, name: string, opts: { trustHome?: string } = {}): boolean {
  if (!existsSync(file)) return false;
  const wasTrusted = opts.trustHome !== undefined && mcpTrustStatus(opts.trustHome, file) === "trusted";
  const shape = readShape(file);
  if (shape.servers[name] === undefined) return false;
  delete shape.servers[name];
  writeShape(file, shape, false);
  if (wasTrusted) trustMcpFile(opts.trustHome!, file);
  return true;
}

/** one configured server on one line, NAMES of env/headers only — never their values (they may be keys) */
export function serverLine(s: McpServerConfig): string {
  const what = s.transport === "stdio" ? [s.command, ...(s.args ?? [])].join(" ") : s.url ?? "";
  const env = s.env && Object.keys(s.env).length ? `  env ${Object.keys(s.env).join(", ")}` : "";
  const headers = s.headers && Object.keys(s.headers).length ? `  headers ${Object.keys(s.headers).join(", ")}` : "";
  // an entry the loader will skip until a hand edits it says so on its own line — it is configured, not launchable
  const holes = placeholderHoles(s);
  const fill = holes.length ? `  (fill in ${holes.join(", ")})` : "";
  return `${s.name.padEnd(24)} ${s.transport.padEnd(5)} ${what}${env}${headers}${fill}${s.enabled === false ? "  (disabled)" : ""}`;
}

/** every configured server with the scope it comes from, most local last — what the files SAY, which is
 *  more than what the runtime would load: an entry still carrying a `<…>` placeholder is kept (serverLine
 *  marks it), because the person who was told "fill in the directory after the install" and typed the
 *  command the docs point at must not be told they have nothing. The loader's own view (skipping such an
 *  entry with a warning) is loadMcpConfig. `warnings` collects what parsing had to say — an unreadable
 *  file, invalid JSON, a nameless entry — for the caller to show; it used to be discarded here. */
export function configuredServers(cwd: string, home: string, warnings: string[] = []): { scope: McpScope | "harvest"; file: string; server: McpServerConfig }[] {
  const files = mcpConfigFiles(cwd, home);
  const all = new Proxy({}, { get: () => "set" }) as Record<string, string>; // list what is configured, not what is launchable right now
  const out: { scope: McpScope | "harvest"; file: string; server: McpServerConfig }[] = [];
  for (const [scope, file] of [["user", files.user!], ["harvest", files.harvest], ["project", files.project]] as const) {
    for (const server of parseConfigFile(file, warnings, all, { allowPlaceholders: true })) out.push({ scope, file, server });
  }
  return out;
}

/** The `pending` fragments of a plan whose placeholder is STILL in the written entry — nobody answered for
 *  them at the prompt (no terminal, or an empty answer). What the closing line of an install must name, and
 *  only that: a question answered at the prompt must not leave the install telling you to go and edit a line
 *  that now holds your answer. */
export function unfilledPending(plan: InstallPlan, raw: Record<string, unknown>): string[] {
  const args = Array.isArray(raw.args) ? (raw.args as unknown[]) : [];
  return plan.pending.filter((p) => pendingWords(p).some((w) => /^<.*>$/.test(w) && args.includes(w)));
}
