/** Custom subagent definitions (ported from the Nimbus harness, PORT #62): `.rovecode/agents/<name>.md` (project) and
 *  `~/.rovecode/agents/<name>.md` (user scope, ROVECODE_HOME-aware — providers/auth.ts rovecodeHome) become agent
 *  names the `task` tool can start: `task start {agent:"<name>"}` runs the child with the definition's model, mode
 *  and a tool registry RESTRICTED to its allow-list — through the existing TaskManager / child registry (no second
 *  loop, no second registry; the allow-list is a FILTER over the child tool table, never wider than the parent's).
 *  This module is the pure half — file format, discovery, the filter. cli/runtime.ts wires it (discovery at boot,
 *  the defs map beside `main`, the filtered child registry); core/orchestrator.ts honours `mode`.
 *
 *  Pattern source: opencode @ ebece6e (MIT), packages/opencode/src/config/agent.ts — markdown files under an
 *  `agent(s)/` config dir, name = path sans extension, frontmatter = the agent's fields and the body its prompt
 *  (`{ name, ...md.data, prompt: md.content.trim() }`, :23-28); the global config dir is merged before the project's,
 *  so a project entry replaces a user one (config.ts:474-475 mergeDeep). Its field set (description, model, mode,
 *  tools {name: bool}, permission, temperature, steps …) is reduced to the four knobs below; `tools` is a plain
 *  allow-list (permissions come from the parent's rules via orchestrator deriveChildRules and are NOT configurable
 *  per agent).
 *
 *  File format (YAML-lite frontmatter — skills/index.ts parseFrontmatter):
 *    ---
 *    description: Fast codebase explorer            (optional; ≤ 200 chars in listings; default "custom agent (<file>)")
 *    model: openai/gpt-4o-mini                      (optional; "provider/model" = the router grammar, split on the
 *                                                    FIRST slash; a bare id runs on the starting run's provider. A
 *                                                    child streams over the RUN's endpoint, so a provider other than
 *                                                    the configured one cannot be honoured and is refused at
 *                                                    discovery — DiscoverAgentsOptions.validateModel)
 *    mode: plan                                     (optional; plan|act; plan = the plan rule set + prompt section)
 *    tools: read, grep, glob                        (optional allow-list; comma/space separated, [brackets] allowed;
 *                                                    ABSENT or "*" = every tool the child table offers; PRESENT but
 *                                                    empty — `tools:`, `tools: []`, `tools: ''` — is an error, and so
 *                                                    is a YAML block list (`- read` lines): the file is skipped, it
 *                                                    never fails open to every tool)
 *    ---
 *    <body = the child's system prompt; empty → the runtime's own prompt>
 *  Frontmatter lines are `key: value` only (blank and `#` comment lines allowed); any other line is an error. Keys
 *  outside description/model/mode/tools are IGNORED with a warning (the file still loads) — a typo like `tool:` is
 *  never silent. Names: filename sans `.md`, lowercased, [a-z0-9_-]+; `main` (the built-in child) and the external-lane
 *  adapter ids are RESERVED: a `codex.md` is refused with a line naming the file, and `task start codex` stays the
 *  lane — neither is silently preferred. Every problem is a warning (never a throw): unterminated frontmatter, a
 *  `mode` outside plan|act, a malformed `tools` or `model` value, a model the run cannot honour, an unreadable file,
 *  a bad or reserved name. Missing dirs are silent. */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Tool } from "./types.ts";
import { rovecodeHome } from "../providers/auth.ts";
import { parseFrontmatter } from "../skills/index.ts";
import { ADAPTER_IDS } from "../lanes/types.ts";

export type AgentScope = "project" | "user";
export type CustomAgentMode = "plan" | "act";

export interface CustomAgent {
  /** the filename sans `.md`, lowercased; matches [a-z0-9_-]+ */
  name: string;
  description: string;
  /** frontmatter `model:` — "provider/model" (router grammar) or a bare model id (the starting run's provider) */
  model?: string;
  /** frontmatter `mode:` — the child runs in this plan/act mode (orchestrator runChild applies it) */
  mode?: CustomAgentMode;
  /** tool allow-list; ["*"] = every tool the child table offers (the default) */
  tools: string[];
  /** the markdown body: the child's system prompt ("" → the runtime's own prompt) */
  body: string;
  path: string;
  scope: AgentScope;
}

export interface ParsedAgentFile {
  description?: string; model?: string; mode?: CustomAgentMode; tools: string[]; body: string;
  /** frontmatter keys outside the four known ones (present only when there are some) — the file loads, discovery warns */
  unknown?: string[];
}

export interface DiscoveredAgents { agents: CustomAgent[]; warnings: string[] }

export interface DiscoverAgentsOptions {
  /** user-scope home; default rovecodeHome() (ROVECODE_HOME → ~/.rovecode). Definitions: `<home>/agents` */
  home?: string;
  /** names a definition may not take; default DEFAULT_RESERVED_AGENT_NAMES */
  reserved?: readonly string[];
  /** false skips the PROJECT dir (an untrusted checkout's definitions never reach the `task` schema); the user dir still
   *  loads. Default true. */
  project?: boolean;
  /** why a `model:` selector cannot be honoured by THIS runtime, or undefined when it can — the runtime knows which
   *  provider the run streams over; a refused file is skipped with the reason (cli/runtime.ts modelProblemFor) */
  validateModel?: (selector: string) => string | undefined;
}

/** the built-in child definition + the external-lane ids (core/tasks.ts treats the lane ids as lanes, never agents) */
export const DEFAULT_RESERVED_AGENT_NAMES: readonly string[] = ["main", ...ADAPTER_IDS];
/** the sub-directory of a state dir that holds the definitions */
export const AGENTS_DIR = "agents";
/** the project state dir the definitions live under */
export const PROJECT_STATE_DIR = ".rovecode";

const NAME_RE = /^[a-z0-9_-]+$/;
const TOOL_NAME_RE = /^[A-Za-z0-9_*-]+$/;
const MAX_DESCRIPTION_CHARS = 200;

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

// ---------- file format ----------

/** `tools:` value → allow-list. Comma/space separated, optional [brackets] and quotes; "*" anywhere = all;
 *  a token outside [A-Za-z0-9_*-]+ is an error (never a silent partial list). Empty → ["*"]. */
export function parseToolList(value: string | undefined): string[] | { error: string } {
  const raw = (value ?? "").trim().replace(/^\[|\]$/g, "").trim();
  if (raw === "") return ["*"];
  const names = raw.split(/[\s,]+/).map((t) => t.replace(/^["']|["']$/g, "")).filter((t) => t !== "");
  const bad = names.find((n) => !TOOL_NAME_RE.test(n));
  if (bad !== undefined) return { error: `tools: "${clip(bad, 40)}" is not a tool name (letters, digits, _ - or *)` };
  if (names.includes("*")) return ["*"];
  return [...new Set(names)];
}

/** Optional `---` frontmatter + body → agent fields. `{ error }` names why a file must be skipped. Never throws. */
export function parseAgentFile(text: string): ParsedAgentFile | { error: string } {
  let src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // drop a UTF-8 BOM
  let fm: Record<string, string> = {};
  let body = src;
  if (src.startsWith("---")) {
    if (!src.endsWith("\n")) src += "\n"; // parseFrontmatter finds the closing fence by its line end
    const parsed = parseFrontmatter(src);
    if (!parsed) return { error: "unterminated frontmatter (no closing ---)" };
    // parseFrontmatter silently DROPS lines without a colon — a YAML block list (`tools:` + `- read` lines) or a
    // multi-line value would leave `tools` empty and fail OPEN to "*"; reject the file instead (blank / `#` lines are fine)
    const shape = checkFrontmatterLines(src.slice(4, src.indexOf("\n---", 3)));
    if (shape !== undefined) return { error: shape };
    fm = parsed.fm; body = parsed.body;
  }
  const field = (k: string): string | undefined => { const v = fm[k]?.trim(); return v ? v : undefined; };
  const mode = field("mode");
  if (mode !== undefined && mode !== "plan" && mode !== "act") return { error: `mode must be "plan" or "act" (got "${clip(mode, 40)}")` };
  const model = field("model");
  if (model !== undefined && /\s/.test(model)) return { error: `model must be one selector ("provider/model" or a model id; got "${clip(model, 40)}")` };
  // a PRESENT `tools:` with nothing in it (`tools:`, `tools: []`, `tools: ''`) is an error — only an ABSENT key means "*"
  if (fm["tools"] !== undefined && fm["tools"].trim().replace(/^\[|\]$/g, "").trim() === "") return { error: "tools: empty value (write `tools: *` for every tool, or list names — `tools:` alone never means all)" };
  const tools = parseToolList(fm["tools"]);
  if (!Array.isArray(tools)) return { error: tools.error };
  const unknown = Object.keys(fm).filter((k) => !KNOWN_KEYS.has(k));
  return { description: field("description"), model, mode, tools, body: body.trim(), ...(unknown.length > 0 ? { unknown } : {}) };
}

const KNOWN_KEYS: ReadonlySet<string> = new Set(["description", "model", "mode", "tools"]);

/** Every non-blank, non-comment frontmatter line must be `key: value`; the first offender names the reason. */
function checkFrontmatterLines(block: string): string | undefined {
  for (const line of block.split(/\r?\n/)) {
    const t = line.trim();
    if (t === "" || t.startsWith("#")) continue;
    if (/^-(\s|$)/.test(t)) return `frontmatter uses a YAML block list ("${clip(t, 30)}") — not supported: write \`tools: read, grep\` on one line`;
    if (t.indexOf(":") === -1) return `frontmatter line is not \`key: value\` ("${clip(t, 30)}")`;
  }
  return undefined;
}

/** The runtime's model check (DiscoverAgentsOptions.validateModel): a `provider/model` selector whose provider is not the
 *  one this session streams over cannot be honoured — every child runs on the run's endpoint. A bare id, or the same
 *  provider, is fine; an unknown model ID is not judged here (the catalog is advisory everywhere else). `configured` =
 *  the run's provider id, or null when nothing is configured (then nothing is refused on this ground). */
export function modelProblemFor(configured: string | null): (selector: string) => string | undefined {
  return (selector) => {
    const slash = selector.indexOf("/");
    if (slash <= 0 || configured === null) return undefined;
    const provider = selector.slice(0, slash);
    return provider === configured ? undefined : `model "${clip(selector, 60)}" names provider "${provider}" but this session streams over "${configured}" — a child cannot switch providers; write the bare model id, or "${configured}/<model>"`;
  };
}

// ---------- discovery ----------

/** Scan `<home>/agents` then `<cwd>/.rovecode/agents`; a later (project) entry replaces an earlier (user) one of the
 *  same name. Missing dirs are silent; every other problem is a warning for the boot transcript, never a throw.
 *  Sorted by name. */
export function discoverAgents(cwd: string, opts: DiscoverAgentsOptions = {}): DiscoveredAgents {
  const warnings: string[] = [];
  const reserved = new Set(opts.reserved ?? DEFAULT_RESERVED_AGENT_NAMES);
  const userDir = join(opts.home ?? rovecodeHome(), AGENTS_DIR);
  const projectDir = join(cwd, PROJECT_STATE_DIR, AGENTS_DIR);
  // the project state dir IS the user home: one directory, scanned once; untrusted → the user dir only
  const dirs: [AgentScope, string][] = opts.project === false ? [["user", userDir]]
    : resolve(userDir) === resolve(projectDir) ? [["project", projectDir]]
    : [["user", userDir], ["project", projectDir]];
  const byName = new Map<string, CustomAgent>();
  for (const [scope, dir] of dirs) {
    for (const a of scanAgentDir(dir, scope, warnings, opts.validateModel)) {
      if (reserved.has(a.name)) { warnings.push(`${a.path}: skipped — "${a.name}" is a reserved agent name${ADAPTER_IDS.includes(a.name as (typeof ADAPTER_IDS)[number]) ? ` (the ${a.name} external lane keeps it; \`task start ${a.name}\` runs the lane, never this file)` : ""}`); continue; }
      const prev = byName.get(a.name);
      if (prev?.scope === scope) { warnings.push(`${a.path}: agent "${a.name}" already defined by ${prev.path} — first kept`); continue; }
      byName.set(a.name, a); // project (scanned second) shadows user
    }
  }
  return { agents: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)), warnings };
}

/** a symlinked `*.md` counts when its target is a file; a dangling link stays so the read reports it */
function linksToFile(path: string): boolean {
  try { return statSync(path).isFile(); } catch { return true; }
}

/** One directory's `*.md` files (top level only, sorted), each parsed or warned about. */
function scanAgentDir(dir: string, scope: AgentScope, warnings: string[], validateModel?: (selector: string) => string | undefined): CustomAgent[] {
  let files: string[];
  try {
    files = readdirSync(dir, { withFileTypes: true })
      .filter((e) => /\.md$/i.test(e.name) && (e.isFile() || (e.isSymbolicLink() && linksToFile(join(dir, e.name)))))
      .map((e) => e.name).sort();
  } catch {
    return []; // no such directory — silent, like the skills store and custom commands
  }
  const out: CustomAgent[] = [];
  for (const file of files) {
    const path = join(dir, file);
    const name = file.slice(0, -3).toLowerCase();
    if (!NAME_RE.test(name)) { warnings.push(`${path}: skipped — agent name "${name}" must match [a-z0-9_-]+`); continue; }
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (e) {
      warnings.push(`${path}: skipped — unreadable (${e instanceof Error ? e.message : String(e)})`);
      continue;
    }
    const parsed = parseAgentFile(text);
    if ("error" in parsed) { warnings.push(`${path}: skipped — ${parsed.error}`); continue; }
    // a model this runtime cannot honour is refused HERE, with the file named — not at run time inside a child
    const modelProblem = parsed.model !== undefined && validateModel ? validateModel(parsed.model) : undefined;
    if (modelProblem !== undefined) { warnings.push(`${path}: skipped — ${modelProblem}`); continue; }
    // unknown keys load fine but are never silent (a `tool:` typo would otherwise grant every tool without a word)
    if (parsed.unknown) warnings.push(`${path}: loaded — ignored unknown frontmatter key${parsed.unknown.length > 1 ? "s" : ""} ${parsed.unknown.map((k) => `"${clip(k, 30)}"`).join(", ")} (known: description, model, mode, tools)`);
    out.push({
      name, description: clip(parsed.description ?? `custom agent (${file})`, MAX_DESCRIPTION_CHARS),
      ...(parsed.model !== undefined ? { model: parsed.model } : {}), ...(parsed.mode !== undefined ? { mode: parsed.mode } : {}),
      tools: parsed.tools, body: parsed.body, path, scope,
    });
  }
  return out;
}

// ---------- the child registry filter ----------

/** The tools a child may be given: the candidate table filtered by the definition's allow-list ("*" keeps it
 *  all) AND clamped to names the PARENT registry holds — a definition can never widen a child beyond its
 *  parent's set, and a name outside the child table (mcp_call, web_fetch, memory_edit …) is simply dropped.
 *  Pure; the caller registers the result into the ONE child ToolRegistry it constructs (cli/runtime.ts). */
export function restrictTools(table: readonly Tool[], allow: readonly string[], parentNames: ReadonlySet<string>): Tool[] {
  const all = allow.includes("*");
  const wanted = new Set(allow);
  return table.filter((t) => (all || wanted.has(t.schema.name)) && parentNames.has(t.schema.name));
}

/** `name — description` rows for the `task` tool's schema (tools/task.ts enumerates the loaded definitions). */
export function agentRows(d: DiscoveredAgents): { name: string; description: string }[] {
  return d.agents.map((a) => ({ name: a.name, description: a.description }));
}
