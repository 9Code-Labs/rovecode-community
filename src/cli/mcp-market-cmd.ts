/** `rovecode mcp …` — search · info · add · remove · list. The shell face of the MCP market
 *  (mcp/market.ts + mcp/market-install.ts); a pure command function over injected cwd/home/streams/
 *  fetch/prompts so tests drive it without a process or a network. cli/main.ts wires `case "mcp"`.
 *
 *  The rule `add` lives by: the human SEES the exact command/args or URL, the source, the publisher and
 *  the version, then says yes — on a terminal through a y/N prompt, in a script through `--yes`. Without
 *  a TTY and without --yes nothing is written. Secrets are asked by NAME through the masked prompt
 *  (providers/auth.ts readSecret): never echoed, never on the command line, never in a project file. */

import { readSecret } from "../providers/auth.ts";
import { rovecodeHome } from "../providers/auth.ts";
import { installLabel, marketInfo, searchMarket, type MarketDeps, type MarketEntry } from "../mcp/market.ts";
import { configuredServers, describePlan, fillPlan, namesWritten, planInstall, removeServer, serverLine, writeServer, type InstallPlan, type McpScope } from "../mcp/market-install.ts";
import { mcpConfigFiles, parseConfigFile } from "../mcp/config.ts";
import { mcpTrustStatus, projectMcpFiles, trustMcpFile, untrustMcpFile } from "../mcp/trust.ts";
import { createInterface } from "node:readline";

export interface McpCliDeps {
  cwd?: string;
  home?: string;
  out?: (line: string) => void;
  err?: (line: string) => void;
  /** registry access (fetch/offline/registryUrl/now) — tests inject a fixture fetch */
  market?: MarketDeps;
  /** one masked line (default readSecret) */
  secret?: (prompt: string) => Promise<string>;
  /** one plain line (default: readline on stdin) */
  plain?: (prompt: string) => Promise<string>;
  /** default process.stdin.isTTY === true; a pipe is never consumed by a prompt */
  tty?: boolean;
}

export const MCP_USAGE = [
  "usage: rovecode mcp <command>",
  "  search [query]             the curated list, then the MCP registry's name matches (cached a day)",
  "  info <name>                everything about one server: publisher, version, what it runs or connects to, what it asks",
  "  add <name> [--project] [--pick N] [--as <name>] [--yes] [--force]",
  "                             install: shows the exact command/URL + source, asks (masked) for keys by name, then writes",
  "                             ~/.rovecode/mcp.json — or .rovecode/mcp.json with --project (keys stay out of it: ${NAME})",
  "  remove <name> [--project]  delete the entry from that file",
  "  list                       every configured server, by file (user · .mcp.json · project), with the project files' trust",
  "  show --project             each project file's servers — exact command/URL, env NAMES — and whether it is trusted here",
  "  trust · untrust            approve this repo's .rovecode/mcp.json and .mcp.json as they are now (any edit asks again);",
  "                             files you write through `add --project` are trusted as you approve them",
  "restart rovecode after add/remove/trust — servers are read once per process (docs/mcp-market.md)",
];

/** `show --project` — every project file, its trust, its servers (names only for env/headers) */
export function showLines(cwd: string, home: string): string[] {
  const files = projectMcpFiles(cwd);
  if (files.length === 0) return ["no project MCP files here (.rovecode/mcp.json, .mcp.json)"];
  const anySet = new Proxy({}, { get: () => "set" }) as Record<string, string>;
  const out: string[] = [];
  for (const file of files) {
    const status = mcpTrustStatus(home, file);
    out.push(`${file}  — ${status === "trusted" ? "trusted on this machine" : "NOT trusted: nothing in it loads until `rovecode mcp trust`"}`);
    const warnings: string[] = [];
    for (const s of parseConfigFile(file, warnings, anySet)) out.push(`  ${serverLine(s)}`);
    for (const w of warnings) out.push(`  ! ${w}`);
  }
  return out;
}

async function readLine(prompt: string): Promise<string> {
  process.stderr.write(prompt);
  const rl = createInterface({ input: process.stdin });
  return new Promise((resolve) => { rl.once("line", (l) => { rl.close(); resolve(l.trim()); }); rl.once("close", () => resolve("")); });
}

function flag(args: string[], name: string): boolean { return args.includes(name); }
function value(args: string[], name: string): string | undefined { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1]; }
function words(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) { const a = args[i]!; if (a === "--pick" || a === "--as") { i++; continue; } if (!a.startsWith("--")) out.push(a); }
  return out;
}

function row(e: MarketEntry): string {
  const src = e.source === "curated" ? "curated " : "registry";
  const head = [e.title, e.version, e.status ? `[${e.status}]` : undefined].filter((s): s is string => s !== undefined).join(" ");
  return `${e.key.padEnd(40)} ${src}  ${head}${e.description ? `${head ? " — " : ""}${e.description}` : ""}`.trimEnd();
}

export function infoLines(e: MarketEntry): string[] {
  const lines = [`${e.key}${e.title ? `  (${e.title})` : ""}${e.version ? `  v${e.version}` : ""}${e.status ? `  [${e.status}]` : ""}`, `  ${e.description}`,
    `  source     ${e.source === "curated" ? "curated list" : "MCP registry"}`, `  publisher  ${e.publisher ?? "unknown"}`];
  if (e.repository) lines.push(`  repo       ${e.repository}`);
  if (e.homepage) lines.push(`  home       ${e.homepage}`);
  if (e.installs.length === 0) lines.push("  install    nothing rovecode can launch (no stdio package, no streamable-http remote)");
  e.installs.forEach((i, ix) => {
    lines.push(`  install ${ix}  ${i.kind === "stdio" ? `runs     ${installLabel(i)}` : `connects ${i.url}`}`);
    if (i.kind === "stdio") { for (const v of i.env) lines.push(`             env ${v.name}${v.secret ? " (secret)" : ""}${v.required ? "" : " optional"}${v.description ? ` — ${v.description}` : ""}`); for (const p of i.pending) lines.push(`             needs ${p}`); }
    else for (const h of i.headers) lines.push(`             header ${h.name}${h.template ? `: ${h.template}` : ""}${h.secret ? " (secret)" : ""}${h.required ? "" : " optional"}`);
  });
  if (e.installs.length > 1) lines.push(`  pick one with: rovecode mcp add ${e.key} --pick N`);
  return lines;
}

/** ask every plan question in order; secrets masked, the rest plain. Returns null when a required
 *  answer cannot be obtained (no TTY) — the caller stops without writing. */
export async function askPlan(plan: InstallPlan, deps: { secret: (p: string) => Promise<string>; plain: (p: string) => Promise<string>; tty: boolean; err: (l: string) => void }): Promise<Record<string, string> | null> {
  const answers: Record<string, string> = {};
  for (const a of plan.asks) {
    if (!deps.tty) {
      if (a.required && !(a.secret && plan.scope === "project")) { deps.err(`${a.name} is required and there is no terminal to ask on — export ${a.name} and re-run, or run this on a terminal`); return null; }
      continue; // written as ${NAME}: the environment supplies it at launch
    }
    const label = `${a.name}${a.description ? ` (${a.description})` : ""}${a.required ? "" : " [optional, enter to skip]"}: `;
    answers[a.name] = a.secret ? await deps.secret(label) : await deps.plain(label);
    if (a.required && answers[a.name]!.length === 0 && !(a.secret && plan.scope === "project")) { deps.err(`${a.name} is required`); return null; }
  }
  return answers;
}

export async function cmdMcp(args: string[], deps: McpCliDeps = {}): Promise<number> {
  const cwd = deps.cwd ?? process.cwd(), home = deps.home ?? rovecodeHome();
  const out = deps.out ?? console.log, err = deps.err ?? console.error;
  const market: MarketDeps = { home, ...deps.market };
  const tty = deps.tty ?? process.stdin.isTTY === true;
  const secret = deps.secret ?? ((p: string) => readSecret(p));
  const plain = deps.plain ?? readLine;
  const [cmd, ...rest] = args;
  // every flag a subcommand takes; anything else is a usage error (exit 2), not a silently ignored word —
  // `mcp show --project` used to pass only because unknown flags were filtered out
  const KNOWN_FLAGS: Record<string, readonly string[]> = {
    search: [], info: [], add: ["--project", "--pick", "--as", "--yes", "--force"], remove: ["--project"], list: [],
    show: ["--project"], trust: ["--yes", "--project"], untrust: [], help: [],
  };
  if (cmd !== undefined && cmd in KNOWN_FLAGS) {
    const valued = new Set(["--pick", "--as"]);
    let skip = false;
    for (const a of rest) {
      if (skip) { skip = false; continue; }
      if (a.startsWith("--")) {
        if (!KNOWN_FLAGS[cmd]!.includes(a)) { err(`unknown flag ${a} for "rovecode mcp ${cmd}" — see: rovecode mcp help`); return 2; }
        if (valued.has(a)) skip = true;
      }
    }
  }
  const names = words(rest);
  const scope: McpScope = flag(rest, "--project") ? "project" : "user";
  switch (cmd) {
    case undefined: case "help": case "--help": case "-h": for (const l of MCP_USAGE) out(l); return cmd === undefined ? 2 : 0;
    case "search": {
      const r = await searchMarket(names.join(" "), market);
      for (const n of r.notes) err(`note: ${n}`);
      if (r.entries.length === 0) { out(`nothing matches "${names.join(" ")}"`); return 0; }
      for (const e of r.entries) out(row(e));
      out(`→ rovecode mcp info <name> · rovecode mcp add <name>${r.fromCache ? "   (registry results from cache)" : ""}`);
      return 0;
    }
    case "info": {
      if (!names[0]) { err("usage: rovecode mcp info <name>"); return 2; }
      const r = await marketInfo(names[0], market);
      for (const n of r.notes) err(`note: ${n}`);
      if (!r.entry) return 1;
      for (const l of infoLines(r.entry)) out(l);
      return 0;
    }
    case "add": {
      if (!names[0]) { err("usage: rovecode mcp add <name> [--project] [--pick N] [--as <name>] [--yes] [--force]"); return 2; }
      const r = await marketInfo(names[0], market);
      for (const n of r.notes) err(`note: ${n}`);
      if (!r.entry) return 1;
      const pickRaw = value(rest, "--pick");
      const pick = pickRaw === undefined ? undefined : Number(pickRaw);
      if (pick !== undefined && (!Number.isInteger(pick) || pick < 0)) { err(`--pick wants a whole number, not "${pickRaw}"`); return 2; }
      const as = value(rest, "--as");
      const plan = planInstall(r.entry, { scope, cwd, home, ...(pick !== undefined ? { pick } : {}), ...(as !== undefined ? { name: as } : {}) });
      if ("error" in plan) { err(plan.error); return 1; }
      // the human sees everything first — then the questions, then the yes
      for (const l of describePlan(plan)) out(l);
      if (!flag(rest, "--yes")) {
        if (!tty) { err("nothing written: no terminal to confirm on — re-run with --yes after reading the lines above"); return 1; }
        const a = (await plain("install? [y/N] ")).toLowerCase();
        if (a !== "y" && a !== "yes") { out("nothing written"); return 1; }
      }
      const answers = await askPlan(plan, { secret, plain, tty, err });
      if (answers === null) { out("nothing written"); return 1; }
      let trusted: boolean | undefined;
      const raw = fillPlan(plan, answers);
      try {
        // a project file the human just approved is trusted as written (mcp/trust.ts); the user file is never gated
        trusted = writeServer(plan.file, plan.name, raw, { replace: flag(rest, "--force"), ...(scope === "project" ? { trustHome: home } : {}) }).trusted;
      } catch (e) { err(e instanceof Error ? e.message : String(e)); return 1; }
      out(`added "${plan.name}" → ${plan.file}${trusted === true ? "  (trusted on this machine as written)" : ""}`);
      if (trusted === false) out(`NOT trusted yet: that file already held servers you have not approved — rovecode mcp show, then rovecode mcp trust`);
      if (plan.pending.length) out(`fill in before use: ${plan.pending.join(", ")} (edit the args in that file)`);
      const named = namesWritten(plan, raw); // only what the file now refers to (a project file's secrets, an unanswered required value)
      if (named.length) out(`set ${named.join(", ")} in your environment — the file only names them`);
      out("restart rovecode to connect (servers are read once per process)");
      return 0;
    }
    case "remove": {
      if (!names[0]) { err("usage: rovecode mcp remove <name> [--project]"); return 2; }
      const files = mcpConfigFiles(cwd, home);
      const file = scope === "project" ? files.project : files.user!;
      try {
        if (!removeServer(file, names[0], scope === "project" ? { trustHome: home } : {})) { err(`${file} has no server named "${names[0]}"${scope === "user" ? " (project entries: add --project)" : ""}`); return 1; }
      } catch (e) { err(e instanceof Error ? e.message : String(e)); return 1; }
      out(`removed "${names[0]}" from ${file}`);
      return 0;
    }
    case "list": {
      const rows = configuredServers(cwd, home);
      if (rows.length === 0) { out("no MCP servers configured — rovecode mcp search <query>"); return 0; }
      for (const r of rows) {
        const gate = r.scope === "user" ? "" : mcpTrustStatus(home, r.file) === "trusted" ? "" : "  (file not trusted — off; rovecode mcp trust)";
        out(`${r.scope.padEnd(8)} ${serverLine(r.server)}${gate}`);
      }
      return 0;
    }
    case "show": { for (const l of showLines(cwd, home)) out(l); return 0; }
    case "trust": {
      const files = projectMcpFiles(cwd);
      if (files.length === 0) { out("no project MCP files here (.rovecode/mcp.json, .mcp.json) — nothing to trust"); return 1; }
      for (const l of showLines(cwd, home)) out(l);
      if (!flag(rest, "--yes")) {
        if (!tty) { err("nothing trusted: no terminal to confirm on — re-run with --yes after reading the lines above"); return 1; }
        const a = (await plain("trust these files as they are now? [y/N] ")).toLowerCase();
        if (a !== "y" && a !== "yes") { out("nothing trusted"); return 1; }
      }
      for (const f of files) { const r = trustMcpFile(home, f); out(r.ok ? `trusted ${f}  (${r.digest.slice(0, 12)}…)` : r.reason); }
      out("restart rovecode to connect — an edit to either file asks again");
      return 0;
    }
    case "untrust": {
      const files = [mcpConfigFiles(cwd).harvest, mcpConfigFiles(cwd).project];
      const had = files.filter((f) => untrustMcpFile(home, f));
      out(had.length ? `untrusted ${had.join(", ")}` : "nothing was trusted here");
      return 0;
    }
    default: err(`unknown mcp command "${cmd}"`); for (const l of MCP_USAGE) err(l); return 2;
  }
}
