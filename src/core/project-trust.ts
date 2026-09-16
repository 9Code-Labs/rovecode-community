/** What a checkout's gated files WOULD do — the report behind `rovecode trust show`, the doctor's `trust` row and the
 *  approval verb. A person deciding to approve a file needs to see what they are approving: the settings keys with their
 *  values, the hooks file, the sandbox rung and image, the MCP server names and commands — "untrusted file" with no
 *  content is a prompt to type yes. The store and the predicate live in core/trust.ts; this module only READS the files
 *  (never through the gate — readSettingsFile is the ungated reader) and never imports or spawns anything.
 *
 *  Out of scope, on purpose (as core/trust.ts says): .rovecode/commands/*.md and .rovecode/agents/*.md are prompt text,
 *  not executables — a different class of gate. */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { mcpConfigFiles, parseConfigFile } from "../mcp/config.ts";
import { COMMAND_KEYS, readSettingsFile, settingsPath } from "./settings.ts";
import { fileTrustStatus, trustFile, untrustFile, type TrustStatus } from "./trust.ts";

export type TrustKind = "settings" | "hooks" | "sandbox" | "mcp" | "memory";

export interface TrustRow {
  file: string;
  kind: TrustKind;
  status: TrustStatus;
  /** what the file would make rovecode do, one line each — shown before any approval */
  carries: string[];
}

const short = (v: unknown, max = 100): string => { const s = typeof v === "string" ? v : JSON.stringify(v); return s.length > max ? `${s.slice(0, max - 1)}…` : s; };

/** every gated project file that EXISTS in `cwd`, with what it carries; a settings.json without a command-bearing key
 *  is not listed (nothing in it is gated) */
export function projectTrustRows(cwd: string, home: string): TrustRow[] {
  const rows: TrustRow[] = [];
  const settings = settingsPath("project", cwd);
  if (existsSync(settings)) {
    const s = readSettingsFile(settings);
    const carries = COMMAND_KEYS.filter((k) => s[k] !== undefined && !(k === "verify" && s.verify === false)).map((k) => `${k}: ${short(s[k])}`);
    if (carries.length > 0) rows.push({ file: settings, kind: "settings", status: fileTrustStatus(home, settings), carries });
  }
  for (const name of ["hooks.ts", "hooks.js"]) {
    const file = join(cwd, ".rovecode", name);
    if (existsSync(file)) rows.push({ file, kind: "hooks", status: fileTrustStatus(home, file), carries: [`code imported in-process at boot (${lineCount(file)} lines) — read it before approving`] });
  }
  const sandbox = join(cwd, ".rovecode", "sandbox.json");
  if (existsSync(sandbox)) {
    const carries: string[] = [];
    try {
      const raw = JSON.parse(readFileSync(sandbox, "utf8")) as Record<string, unknown>;
      if (raw && typeof raw === "object") { if (raw.rung !== undefined) carries.push(`rung: ${short(raw.rung)}`); if (raw.dockerImage !== undefined) carries.push(`dockerImage: ${short(raw.dockerImage)}`); }
      if (carries.length === 0) carries.push("no rung or image — nothing gated");
    } catch { carries.push("not valid JSON — a boot refuses it either way"); }
    rows.push({ file: sandbox, kind: "sandbox", status: fileTrustStatus(home, sandbox), carries });
  }
  // the project MEMORY block (memory/scope.ts): its text goes into the system prompt, so a copy that came with the
  // repository is withheld until approved. A file we wrote ourselves is self-trusted at the write and never listed.
  const memory = join(cwd, ".rovecode", "memory", "MEMORY.md");
  if (existsSync(memory)) {
    const status = fileTrustStatus(home, memory);
    if (status !== "trusted") rows.push({ file: memory, kind: "memory", status, carries: [`${lineCount(memory)} lines of text placed in front of the model in every run — read it before approving`] });
  }
  const mcp = mcpConfigFiles(cwd);
  for (const file of [mcp.harvest, mcp.project]) {
    if (!existsSync(file)) continue;
    const warnings: string[] = [];
    const servers = parseConfigFile(file, warnings, process.env, { allowPlaceholders: true });
    const carries = servers.map((s) => `${s.name}: ${s.transport === "stdio" ? short([s.command, ...(s.args ?? [])].filter(Boolean).join(" ")) : short(s.url ?? "")}`);
    for (const w of warnings) carries.push(`! ${w}`);
    if (carries.length === 0) carries.push("no servers");
    rows.push({ file, kind: "mcp", status: fileTrustStatus(home, file), carries });
  }
  return rows;
}

function lineCount(file: string): number { try { return readFileSync(file, "utf8").split("\n").length; } catch { return 0; } }

const KIND_LABEL: Record<TrustKind, string> = { settings: "settings — commands this repo asks us to run", hooks: "hooks — code this repo asks us to import", sandbox: "sandbox — the executor this repo asks us to use", mcp: "MCP servers this repo asks us to start", memory: "memory — text this repo asks us to put in the prompt" };

/** the `trust show` lines: one header per file with its status, one indented line per thing it carries */
export function trustShowLines(rows: TrustRow[]): string[] {
  if (rows.length === 0) return ["no gated project files here (.rovecode/settings.json with verify/lsp/notify_command, hooks.ts, sandbox.json, mcp.json, .mcp.json) — nothing to trust"];
  const out: string[] = [];
  for (const r of rows) {
    out.push(`${r.status === "trusted" ? "✓ trusted  " : "· UNTRUSTED"}  ${r.file}  (${KIND_LABEL[r.kind]})`);
    for (const c of r.carries) out.push(`      ${c}`);
  }
  return out;
}

/** approve every row as it is now; returns one line per file */
export function trustRows(home: string, rows: TrustRow[]): string[] {
  return rows.map((r) => { const t = trustFile(home, r.file); return t.ok ? `trusted ${r.file}  (${t.digest.slice(0, 12)}…)` : t.reason; });
}

export function untrustRows(home: string, rows: TrustRow[]): string[] {
  const had = rows.filter((r) => untrustFile(home, r.file));
  return had.length ? had.map((r) => `untrusted ${r.file}`) : ["nothing was trusted here"];
}

/** the boot / doctor summary: which untrusted files carry something */
export function untrustedRows(rows: TrustRow[]): TrustRow[] { return rows.filter((r) => r.status !== "trusted"); }
