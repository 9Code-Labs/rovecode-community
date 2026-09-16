/** `rovecode doctor` — "what is wrong with my setup", answered once, in one pass.
 *
 *  Every check here already existed and already spoke — each at its own moment: the LSP note at boot, the
 *  provider hint when a run fails, the prerequisite row inside an install plan, the MCP loader's skipped-server
 *  warnings, the trust gate's line. A person whose setup is half-wrong met them one at a time, in the order
 *  the day happened to raise them. This runs the same code and lays the answers side by side.
 *
 *  Rules it keeps:
 *  - It invents nothing. Every row is produced by the module that owns that decision (providers/registry.ts,
 *    mcp/config.ts, mcp/market-install.ts, coding/lsp.ts, market/prereq.ts, core/settings.ts). A check that
 *    would need code this repository does not have is listed under `notChecked`, by name.
 *  - It never prints a secret. Provider rows carry ids, scopes and key NAMES; the registry's own redaction is
 *    not even consulted, because nothing here needs the value.
 *  - It makes no provider request: reachability would be a billed call, so it is a listed non-check. MCP
 *    servers ARE connected (that is a local process, and "does it connect" is the question); `--no-connect`
 *    skips it and says so.
 *  - Exit 0 = nothing is broken; 1 = something the person must fix before a run can work as configured. A
 *    fresh install with no provider is a FINDING (exit 0, status "note"), not a failure — nothing is broken,
 *    something is not done yet. `--json` is one document, on every exit. */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { rovecodeHome } from "../providers/auth.ts";
import { ProviderRegistry } from "../providers/registry.ts";
import { isConfigured } from "../providers/provider-config.ts";
import { resolvePermission, settingsPath } from "../core/settings.ts";
import type { PermissionLevel } from "../core/types.ts";
import { checkPrereq, type PrereqEnv } from "../market/prereq.ts";
import { lspAvailabilityNote } from "../coding/lsp.ts";
import { WorkspaceRoots, resolveRoots } from "../core/workspace.ts";
import { parseAddDirs } from "./run-flags.ts";
import { configuredServers } from "../mcp/market-install.ts";
import { loadMcpConfig, placeholderHoles, type McpServerConfig } from "../mcp/config.ts";
import { mcpTrustStatus, trustedPredicate } from "../mcp/trust.ts";
import { projectTrustRows, trustShowLines, untrustedRows } from "../core/project-trust.ts";
import { loadState as loadPluginState } from "../plugins/state.ts";
import { launchesViaNpx, npxOfferLine } from "../mcp/local-package.ts";
import { resolveVerify, VERIFY_BLIND_SPOT, verifyLabelWithCost } from "../core/verify.ts";

export type DoctorStatus = "ok" | "note" | "warn" | "fail";

export interface DoctorCheck {
  id: "home" | "provider" | "permission" | "trust" | "tools" | "verify" | "mcp" | "workspace" | "checkpoints";
  status: DoctorStatus;
  summary: string;
  detail?: string[];
}

export interface DoctorReport {
  ok: boolean;
  exitCode: 0 | 1;
  cwd: string;
  home: string;
  checks: DoctorCheck[];
  /** what this command did NOT look at, by name — so a clean report is never read as "everything is fine" */
  notChecked: string[];
}

export interface DoctorDeps {
  cwd?: string;
  /** the rovecode home; default rovecodeHome() (ROVECODE_HOME or ~/.rovecode) */
  home?: string;
  env?: Record<string, string | undefined>;
  /** PATH lookup for the tools row — tests inject a fixed environment */
  prereqEnv?: PrereqEnv;
  /** the LSP probe — tests inject; default Bun.which */
  which?: (name: string) => string | null;
  /** try to connect every loadable MCP server (default true; `--no-connect` turns it off) */
  connect?: boolean;
  connectTimeoutMs?: number;
  out?: (line: string) => void;
  err?: (line: string) => void;
  /** `--add-dir <dir>` values (absolute; cli/run-flags.ts parseAddDirs) — doctor is its own process, so it can only
   *  describe roots it is told about; the row then names what a session with those roots would and would not cover */
  addDirs?: readonly string[];
}

const DOCTOR_USAGE = [
  "usage: rovecode doctor [--json] [--no-connect] [--add-dir <dir>]…",
  "  one pass over the setup: home · provider · permission level · tools on PATH · the verify check · MCP servers · workspace roots (with --add-dir) · checkpoints",
  "  --no-connect   do not start the MCP servers to see whether they answer (they are otherwise connected and closed)",
  "  --json         one document on stdout; exit 0 = nothing broken, 1 = something to fix (a missing provider is a note, not a failure)",
];

const PERMISSIONS: readonly string[] = ["ask", "accept-edits", "auto"];
/** the size at which a shadow repository becomes worth mentioning: 14e9118 measured 232 MB as the bad case */
const CHECKPOINTS_WARN_BYTES = 200 * 1024 * 1024;

function userHome(env: Record<string, string | undefined>): string {
  return (process.platform === "win32" ? env.USERPROFILE : env.HOME) || homedir();
}

function dirSize(root: string): { bytes: number; files: number } {
  let bytes = 0, files = 0;
  const walk = (d: string): void => {
    let names: string[];
    try { names = readdirSync(d); } catch { return; }
    for (const n of names) {
      const p = join(d, n);
      try {
        const st = statSync(p);
        if (st.isDirectory()) walk(p); else { bytes += st.size; files++; }
      } catch { /* vanished mid-walk: the number is a snapshot, not a ledger */ }
    }
  };
  walk(root);
  return { bytes, files };
}

const mb = (bytes: number): string => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

/** the permission level in effect and WHERE it came from — the same ladder core/settings.ts resolvePermission
 *  walks, re-read here only to name the rung; the level itself is resolvePermission's answer */
function permissionCheck(cwd: string, env: Record<string, string | undefined>): DoctorCheck {
  const level = resolvePermission(cwd, undefined, { ROVECODE_PERMISSION: env.ROVECODE_PERMISSION, ROVECODE_YOLO: env.ROVECODE_YOLO, ROVECODE_ACCEPT_EDITS: env.ROVECODE_ACCEPT_EDITS });
  const fileLevel = (scope: "user" | "project"): PermissionLevel | undefined => {
    try {
      const raw = JSON.parse(readFileSync(settingsPath(scope, cwd), "utf8")) as { permission?: unknown };
      return typeof raw.permission === "string" && PERMISSIONS.includes(raw.permission) ? raw.permission as PermissionLevel : undefined;
    } catch { return undefined; }
  };
  const named = (env.ROVECODE_PERMISSION ?? "").trim().toLowerCase();
  const source = PERMISSIONS.includes(named) ? "ROVECODE_PERMISSION"
    : env.ROVECODE_YOLO === "1" ? "ROVECODE_YOLO=1"
    : env.ROVECODE_ACCEPT_EDITS === "1" ? "ROVECODE_ACCEPT_EDITS=1"
    : fileLevel("project") !== undefined ? settingsPath("project", cwd)
    : fileLevel("user") !== undefined ? settingsPath("user", cwd)
    : "the default";
  const words = level === "auto" ? "auto — never asks (deny rules and plan mode still hold)"
    : level === "accept-edits" ? "accept edits — writes inside this folder do not ask; shell, subagents, network and writes outside it do"
    : "ask first — every write, shell command and subagent asks";
  return { id: "permission", status: level === "auto" ? "note" : "ok", summary: `${words} · from ${source}`,
    ...(level === "auto" ? { detail: ["a one-shot run adds --yolo per run; the TUI's /yolo --save is what made it stick if this surprises you"] } : {}) };
}

export async function runDoctor(deps: DoctorDeps = {}): Promise<DoctorReport> {
  const cwd = deps.cwd ?? process.cwd();
  const env = deps.env ?? process.env;
  const home = deps.home ?? rovecodeHome();
  const which = deps.which ?? ((n: string) => Bun.which(n));
  const checks: DoctorCheck[] = [];
  const notChecked: string[] = [
    "whether the provider answers — a request would be billed; `rovecode provider test <id>` makes one small call on purpose",
    "plugins — `rovecode plugin list` shows each one's state",
    "the bash sandbox rung (wsl/docker) — probed at session start, not here",
    "hooks — loaded at session start; a broken one is reported there",
  ];

  // ---- home
  {
    const explicit = env.ROVECODE_HOME !== undefined;
    const legacy = join(userHome(env), ".cumulus");
    const legacyThere = existsSync(legacy);
    const detail: string[] = [];
    if (legacyThere) detail.push(explicit
      ? `a legacy ${legacy} is still on this machine; an explicit ROVECODE_HOME is never filled from it (only the default home inherits, once, and says so)`
      : `a legacy ${legacy} is still on this machine; the default home was copied from it once and both are kept — delete the old one when you are sure`);
    checks.push({ id: "home", status: existsSync(home) ? "ok" : "note",
      summary: `${home}${explicit ? " (ROVECODE_HOME)" : ""}${existsSync(home) ? "" : " — does not exist yet; the first thing you store creates it"}`,
      ...(detail.length ? { detail } : {}) });
  }

  // ---- provider (ids, scopes and key NAMES only — never a value)
  {
    const reg = new ProviderRegistry(cwd, { env });
    const def = reg.defaultRef();
    const configured = reg.list().filter(isConfigured);
    const warnings = reg.warnings();
    const detail = configured.map((p) => `${p.id} (${p.scope}${p.noKey ? ", no key needed" : `, key from ${p.keySource === "env" ? `env ${p.keyEnv}` : p.keySource}`})`);
    for (const w of warnings) detail.push(`providers.json: ${w}`);
    if (def === null) {
      checks.push({ id: "provider", status: warnings.length ? "warn" : "note",
        summary: "no provider configured yet — nothing is broken, nothing is connected: `rovecode connect` (or provider add + auth set)", ...(detail.length ? { detail } : {}) });
    } else {
      checks.push({ id: "provider", status: warnings.length ? "warn" : "ok",
        summary: `default ${def.provider}/${def.model || "(no model — rovecode model use <provider/model>)"} · ${configured.length} provider${configured.length === 1 ? "" : "s"} configured`, ...(detail.length ? { detail } : {}) });
    }
  }

  // ---- permission
  checks.push(permissionCheck(cwd, env));

  // ---- trust: the project files that could make rovecode run or import something (core/trust.ts), each with what it
  // carries — an untrusted one contributes nothing until `rovecode trust`. A repo with none is a repo with none.
  {
    const rows = projectTrustRows(cwd, home);
    const off = untrustedRows(rows);
    const detail = trustShowLines(rows);
    const summary = rows.length === 0 ? "no gated project files here"
      : off.length === 0 ? `${rows.length} gated project file${rows.length === 1 ? "" : "s"}, all trusted on this machine`
      : `${off.length} of ${rows.length} gated project file${rows.length === 1 ? "" : "s"} NOT trusted — contributing nothing until \`rovecode trust\` (read \`rovecode trust show\` first)`;
    checks.push({ id: "trust", status: off.length ? "note" : "ok", summary, ...(rows.length ? { detail } : {}) });
  }

  // ---- MCP: what the files say, what the loader takes, what actually answers
  const parseWarnings: string[] = [];
  const rows = configuredServers(cwd, home, parseWarnings);
  const loadWarnings: string[] = [];
  const loaded = loadMcpConfig(cwd, loadWarnings, { home, env, trusted: trustedPredicate(loadPluginState(home)) });
  const needsNpx = rows.some((r) => r.server.transport === "stdio" && /^npx(\.cmd)?$/i.test(r.server.command ?? ""));
  const needsUvx = rows.some((r) => r.server.transport === "stdio" && /^uvx(\.exe)?$/i.test(r.server.command ?? ""));
  {
    const detail: string[] = [];
    let status: DoctorStatus = "ok";
    const raise = (s: DoctorStatus): void => { const rank = { ok: 0, note: 1, warn: 2, fail: 3 }; if (rank[s] > rank[status]) status = s; };
    for (const w of parseWarnings) { detail.push(`✗ ${w}`); raise("fail"); }
    const loadedNames = new Set(loaded.map((c) => c.name));
    let connected = new Set<string>(); const failed = new Map<string, string>();
    if (deps.connect !== false && loaded.length > 0) {
      const { McpManager } = await import("../mcp/client.ts");
      const mgr = new McpManager(loaded, deps.connectTimeoutMs !== undefined ? { connectTimeoutMs: deps.connectTimeoutMs } : {});
      const r = await mgr.connect();
      connected = new Set(r.connected);
      for (const f of r.failed) failed.set(f.name, f.error);
      await mgr.close().catch(() => {});
    } else if (deps.connect === false && loaded.length > 0) {
      notChecked.push("whether the MCP servers answer (--no-connect)");
    }
    for (const row of rows) {
      const s: McpServerConfig = row.server;
      const where = `${row.scope}${row.scope === "user" ? "" : ` ${row.file}`}`;
      const trust = row.scope === "user" ? "trusted" : mcpTrustStatus(home, row.file);
      const holes = placeholderHoles(s);
      const skipped = loadWarnings.find((w) => w.includes(`server "${s.name}"`));
      if (s.enabled === false) { detail.push(`· ${s.name} — disabled in ${where}`); continue; }
      if (trust !== "trusted") { detail.push(`· ${s.name} — off: its file is not trusted on this machine (${row.file}) — rovecode mcp show, then rovecode mcp trust`); raise("note"); continue; }
      if (holes.length) { detail.push(`! ${s.name} — skipped: still has ${holes.join(", ")} to fill in — edit the args in ${row.file}`); raise("warn"); continue; }
      if (skipped !== undefined && !loadedNames.has(s.name)) { detail.push(`! ${s.name} — skipped: ${skipped.replace(/^.*?server "[^"]+" /, "")}`); raise("warn"); continue; }
      if (!loadedNames.has(s.name)) { detail.push(`! ${s.name} — not loaded (${where})`); raise("warn"); continue; }
      if (failed.has(s.name)) { detail.push(`✗ ${s.name} — did not connect: ${failed.get(s.name)}`); raise("fail"); continue; }
      if (connected.has(s.name)) { detail.push(`✓ ${s.name} — connected (${where})`); continue; }
      detail.push(`· ${s.name} — loads (${where}); not connected in this pass`);
    }
    const npx = rows.filter((r) => launchesViaNpx(r.server) && loadedNames.has(r.server.name)).map((r) => r.server.name);
    const offer = npxOfferLine(npx);
    if (offer !== undefined) detail.push(offer);
    // "load" = would start: a disabled entry is kept by the loader (so `mcp list` can show it) but never launched
    const starting = loaded.filter((c) => c.enabled !== false).length;
    const summary = rows.length === 0 ? "no MCP servers configured — rovecode mcp search <query>"
      : `${rows.length} configured · ${starting} load${deps.connect === false ? "" : ` · ${connected.size} connected · ${failed.size} failed`}`;
    checks.push({ id: "mcp", status, summary, ...(detail.length ? { detail } : {}) });
  }

  // ---- tools on PATH: what an install plan would say, all at once — and what each absence costs HERE
  {
    const detail: string[] = [];
    let status: DoctorStatus = "ok";
    const raise = (s: DoctorStatus): void => { const rank = { ok: 0, note: 1, warn: 2, fail: 3 }; if (rank[s] > rank[status]) status = s; };
    const want: { program: string; needed: boolean; why?: string }[] = [
      { program: "git", needed: true, why: "checkpoints (undo without touching your repo) and plugin/skill installs need it" },
      { program: "node", needed: needsNpx, why: "an MCP server here starts through npx" },
      { program: "npm", needed: needsNpx, why: "an MCP server here starts through npx (install-once uses npm)" },
      { program: "npx", needed: needsNpx, why: "an MCP server here starts through npx" },
      { program: "uvx", needed: needsUvx, why: "an MCP server here starts through uvx" },
    ];
    for (const w of want) {
      const p = checkPrereq(w.program, deps.prereqEnv ?? {});
      if (p.found) { detail.push(`✓ ${w.program}`); continue; }
      const cost = w.needed ? ` — ${w.why}` : ` — nothing configured here needs it${w.program === "git" ? "" : " yet"}`;
      detail.push(`${w.needed ? "✗" : "·"} ${w.program} not on PATH${cost}${p.hint ? ` (${p.hint})` : ""}`);
      raise(w.needed ? (w.program === "git" ? "warn" : "fail") : "note");
    }
    const lsp = lspAvailabilityNote(cwd, which);
    if (lsp !== null) { detail.push(`! ${lsp.replace(/^lsp: /, "")}`); raise("warn"); }
    else if (existsSync(join(cwd, "tsconfig.json"))) detail.push("✓ typescript-language-server — edits and writes come back with diagnostics");
    else detail.push("· typescript-language-server — not a TypeScript project here (no tsconfig.json), so the gate does not apply");
    checks.push({ id: "tools", status, summary: detail.filter((l) => l.startsWith("✓")).length + " of " + detail.length + " present", detail });
  }

  // ---- verify: the check the loop runs before "done" (core/verify.ts) — the same kind of fact as `tools` and
  // `permission`: what this project WOULD run, or that nothing is configured and why nothing was inferred. Never a
  // failure: a project with no gate is a project with no gate. The refusals are the row's detail on purpose — that
  // list is how a person decides, once, whether to turn the gate on with the `verify` key.
  {
    const plan = resolveVerify(cwd);
    const summary = plan.source === "settings" ? `${verifyLabelWithCost(cwd, plan)} · from ${plan.reason}`
      : plan.source === "inferred" ? `${verifyLabelWithCost(cwd, plan)} · ${plan.reason} — set \`verify\` in .rovecode/settings.json to pin or replace it`
      : `none · ${plan.reason}`;
    const detail = plan.refused.map((r) => `not inferred: ${r}`);
    if (plan.commands.length > 0) detail.push(VERIFY_BLIND_SPOT);
    checks.push({ id: "verify", status: plan.source === "settings" ? "ok" : "note", summary, ...(detail.length ? { detail } : {}) });
  }

  // ---- workspace: the roots a session started with `--add-dir` would have, and the limit that comes with them
  if (deps.addDirs !== undefined && deps.addDirs.length > 0) {
    try {
      const roots = new WorkspaceRoots(cwd, resolveRoots(cwd, deps.addDirs));
      const detail = [...roots.notes, ...(roots.dirs.length > 0 ? [roots.checkpointNote(), "the boundary covers the file tools (read, edit, write, glob, grep, ls); bash is judged as a command, not a path"] : [])];
      checks.push({ id: "workspace", status: roots.dirs.length > 0 ? "note" : "ok",
        summary: roots.dirs.length > 0 ? `${cwd} ${roots.describe()} — ${roots.dirs.length} extra root${roots.dirs.length === 1 ? "" : "s"}` : `${cwd} — every --add-dir value was already inside it`,
        ...(detail.length ? { detail } : {}) });
    } catch (e) {
      checks.push({ id: "workspace", status: "fail", summary: e instanceof Error ? e.message : String(e) });
    }
  }

  // ---- checkpoints: the shadow repositories under this workspace
  {
    const root = join(cwd, ".rovecode", "checkpoints");
    if (!existsSync(root)) checks.push({ id: "checkpoints", status: "ok", summary: "no shadow repository here yet (the first change of a session creates one)" });
    else {
      let sessions = 0; try { sessions = readdirSync(root).length; } catch { /* unreadable: size says 0 */ }
      const { bytes, files } = dirSize(root);
      const big = bytes >= CHECKPOINTS_WARN_BYTES;
      checks.push({ id: "checkpoints", status: big ? "warn" : "ok",
        summary: `${sessions} session${sessions === 1 ? "" : "s"} · ${mb(bytes)} in ${files} files under .rovecode/checkpoints`,
        ...(big ? { detail: [
          "that is large: something big under this folder is being snapshotted before every change (untracked files are included; media, archives and binaries are excluded by pattern, other large files are not)",
          "delete .rovecode/checkpoints to reclaim it — nothing of yours lives there — or ROVECODE_NO_CHECKPOINTS=1 turns snapshots off",
        ] } : {}) });
      notChecked.push("which files the NEXT snapshot would hash — there is no dry run for that");
    }
  }

  const exitCode = checks.some((c) => c.status === "fail") ? 1 : 0;
  return { ok: exitCode === 0, exitCode, cwd, home, checks, notChecked };
}

const MARK: Record<DoctorStatus, string> = { ok: "✓", note: "·", warn: "!", fail: "✗" };

export function renderDoctor(r: DoctorReport): string[] {
  const lines: string[] = [];
  for (const c of r.checks) {
    lines.push(`${MARK[c.status]} ${c.id.padEnd(12)} ${c.summary}`);
    for (const d of c.detail ?? []) lines.push(`               ${d}`);
  }
  lines.push("");
  lines.push("not checked:");
  for (const n of r.notChecked) lines.push(`  - ${n}`);
  lines.push("");
  lines.push(r.exitCode === 0
    ? (r.checks.some((c) => c.status === "warn" || c.status === "note") ? "nothing is broken; the lines marked ! and · are things to know or finish" : "everything checked is in order")
    : "something is broken — the lines marked ✗ say what");
  return lines;
}

/** `rovecode doctor [--json] [--no-connect]` — exit 0 nothing broken · 1 something to fix · 2 usage */
export async function cmdDoctor(args: string[], deps: DoctorDeps = {}): Promise<number> {
  const out = deps.out ?? ((l: string) => console.log(l));
  const err = deps.err ?? ((l: string) => console.error(l));
  const json = args.includes("--json");
  // --add-dir: validated exactly as a session would (a bad value is the same one-line usage error, exit 2)
  let addDirs: string[] | undefined;
  try { addDirs = parseAddDirs(["", "", ...args], (msg) => { throw new Error(msg); }); }
  catch (e) { const msg = e instanceof Error ? e.message : String(e); err(msg); if (json) out(JSON.stringify({ ok: false, error: msg, usage: DOCTOR_USAGE }, null, 2)); return 2; }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--add-dir") { i++; continue; }
    if (a.startsWith("--add-dir=")) continue;
    if (!a.startsWith("-")) continue;
    if (a === "--json" || a === "--no-connect") continue;
    const msg = `unknown flag ${a}`;
    err(msg); err(DOCTOR_USAGE.join("\n"));
    if (json) out(JSON.stringify({ ok: false, error: msg, usage: DOCTOR_USAGE }, null, 2));
    return 2;
  }
  const report = await runDoctor({ ...deps, ...(args.includes("--no-connect") ? { connect: false } : {}), ...(addDirs.length > 0 ? { addDirs } : {}) });
  if (json) out(JSON.stringify(report, null, 2));
  else for (const l of renderDoctor(report)) out(l);
  return report.exitCode;
}
