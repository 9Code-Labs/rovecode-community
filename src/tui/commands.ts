/** Custom slash commands (port #30): `.rovecode/commands/*.md` (project) and `~/.rovecode/commands/*.md`
 *  (user scope, ROVECODE_HOME-aware) become `/name` commands in the TUI — autocomplete, /help,
 *  and dispatch through the same user-turn path a typed prompt takes.
 *
 *  Ported from opencode @ ebece6e (MIT), packages/opencode/src unless noted:
 *  - discovery: markdown files under a `command(s)/` dir, name = path sans extension
 *    (config/command.ts:13-39 load, config/entry-name.ts:15-19 configEntryNameFromPath);
 *    the frontmatter is the command's metadata and the markdown body its template
 *    (config/command.ts:26-30 `{ name, ...md.data, template: md.content.trim() }`); fields
 *    description/model (packages/core/src/v1/config/command.ts:5-12 — agent/variant/subtask
 *    have no rovecode counterpart; rovecode adds `mode` for plan/act, port #20).
 *  - precedence: the global config dir is loaded before the project's and later entries
 *    replace earlier ones (config/config.ts:473 mergeDeep) → project shadows user here.
 *  - templating (session/prompt.ts:1372-1395): quote-aware argument split (argsRegex :1594,
 *    quoteTrimRegex :1596), `$N` positional (placeholderRegex :1595), `$ARGUMENTS` = the whole
 *    argument string (:1391), and a template with no placeholder gets the arguments appended
 *    after a blank line (:1393-1395); `hints` (command/index.ts:36-44) lists the placeholders.
 *  - a per-command `model` overrides the session model for THAT prompt only (:1411-1412).
 *  Pattern reference only, no code ported: gemini-cli @ 0bd1d43 packages/cli/src/services/
 *  FileCommandLoader.ts — user dir first, project dir second, "last wins" (:85-90, :204-228),
 *  invalid files skipped with a report, never fatal (:277-298).
 *
 *  Deviations: flat directory (no subdirectory namespaces); names are lowercased and must
 *  match [a-z0-9_-]+; YAML-lite frontmatter (`key: value` lines — skills/index.ts
 *  parseFrontmatter, reused) instead of gray-matter, so an unterminated block, a `mode`
 *  outside plan|act, or an empty body skips the file with a boot warning (never a throw);
 *  substitution is ONE pass, so substituted text is never re-scanned, `$$` is a literal `$`,
 *  and a positional `$N` is exactly one token (upstream's "last placeholder absorbs the rest",
 *  prompt.ts:1387, is not ported); no `!\`shell\`` / `@file` injection (prompt.ts:1397-1408) —
 *  the template reaches the model as plain text; a built-in TUI command always beats a custom
 *  one of the same name (warned at boot); a symlinked *.md counts when it points at a file (a
 *  dangling link is reported unreadable); boot-warning echoes and descriptions are bounded.
 *
 *  TUI semantics (runCustomCommand): `mode` switches through the /plan-/act path and STAYS
 *  switched after the run — the switch is a durable session entry (port #20), and silently
 *  flipping back would desynchronize the status line from the session record; `model` is set
 *  the way /model does and restored after the run unless the user re-pointed it mid-run
 *  (/model is not busy-gated). With planActSeparateModels off, /model mirrors writes into
 *  both slots, so the restore does too — same as typing /model <prev> by hand. */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AgentMode, ModeManager } from "../core/modes.ts";
import { rovecodeHome } from "../providers/auth.ts";
import { parseFrontmatter } from "../skills/index.ts";
import { togglePlanAct, type ModeStateSlice } from "./modes-cmd.ts";
import { expandBuiltinSlash } from "./builtin-prompts.ts"; // port #53: built-in prompt commands beat same-named custom ones
import type { Renderer, SlashCommand } from "./renderer.ts";

export type CommandScope = "project" | "user";

export interface CustomCommand {
  /** `/name`: the filename sans `.md`, lowercased; must match [a-z0-9_-]+ */
  name: string;
  description: string;
  /** frontmatter `model:` — per-run override, applied the way /model does */
  model?: string;
  /** frontmatter `mode:` — the run happens in this plan/act mode */
  mode?: AgentMode;
  /** the markdown body: the prompt template */
  body: string;
  /** placeholders the template uses, for /help — opencode hints(): "$1 $2 $ARGUMENTS" */
  hints: string[];
  path: string;
  scope: CommandScope;
}

export interface ParsedCommandFile { description?: string; model?: string; mode?: AgentMode; body: string }

const NAME_RE = /^[a-z0-9_-]+$/;
/** opencode prompt.ts:1594 minus its `[Image N]` alternative (no image parts reach this path). */
const ARGS_RE = /(?:"[^"]*"|'[^']*'|[^\s"']+)/g;
const QUOTE_TRIM_RE = /^["']|["']$/g;
/** one pass: `$$` (literal), `$ARGUMENTS`, `$1`..`$9` */
const PLACEHOLDER_RE = /\$(\$|ARGUMENTS|[1-9])/g;
/** /help + palette rows stay one line; a 20k-char frontmatter field must not become one */
const MAX_DESCRIPTION_CHARS = 200;

/** Bounded echo (todo.ts `show` idiom): file content quoted back in a warning is clipped. */
function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

// ---------- file format ----------

/** Optional `---` frontmatter + body → command fields. `{ error }` names why a file must be
 *  skipped (unterminated block, `mode` outside plan|act, empty body). Never throws. */
export function parseCommandFile(text: string): ParsedCommandFile | { error: string } {
  let src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // drop a UTF-8 BOM
  let fm: Record<string, string> = {};
  let body = src;
  if (src.startsWith("---")) {
    if (!src.endsWith("\n")) src += "\n"; // parseFrontmatter finds the closing fence by its line end
    const parsed = parseFrontmatter(src);
    if (!parsed) return { error: "unterminated frontmatter (no closing ---)" };
    fm = parsed.fm; body = parsed.body;
  }
  body = body.trim();
  if (body === "") return { error: "empty command body (nothing to send)" };
  const field = (k: string): string | undefined => { const v = fm[k]?.trim(); return v ? v : undefined; };
  const mode = field("mode");
  if (mode !== undefined && mode !== "plan" && mode !== "act") return { error: `mode must be "plan" or "act" (got "${clip(mode, 40)}")` }; // LOW-2: bounded echo
  return { description: field("description"), model: field("model"), mode, body };
}

/** Placeholders a template uses: `$1..$9` sorted, then `$ARGUMENTS` (command/index.ts:36-44).
 *  `$$` escapes are dropped first so `$$1` does not count. */
export function hints(body: string): string[] {
  const src = body.replace(/\$\$/g, "");
  const out = [...new Set(src.match(/\$[1-9]/g) ?? [])].sort();
  if (src.includes("$ARGUMENTS")) out.push("$ARGUMENTS");
  return out;
}

// ---------- discovery ----------

export interface DiscoverOptions {
  /** user-scope rovecode dir; default rovecodeHome() (ROVECODE_HOME → ~/.rovecode). Commands: `<home>/commands` */
  home?: string;
  /** built-in command names — a custom command with one of these names is dropped, with a warning */
  reserved?: readonly string[];
  /** more command folders — a plugin's (src/plugins) — scanned AFTER the folder of the same scope, so
   *  your own `~/.rovecode/commands/x.md` or `.rovecode/commands/x.md` keeps `/x` over a plugin's */
  extraDirs?: readonly { dir: string; scope: CommandScope }[];
}

export interface DiscoveredCommands { commands: CustomCommand[]; warnings: string[] }

/** Scan `<home>/commands` then `<cwd>/.rovecode/commands`; a later (project) entry replaces an
 *  earlier (user) one of the same name. Missing dirs are silent (the common case); every
 *  other problem is a warning for the boot transcript, never a throw. Sorted by name. */
export function discoverCommands(cwd: string, opts: DiscoverOptions = {}): DiscoveredCommands {
  const warnings: string[] = [];
  const reserved = new Set(opts.reserved ?? []);
  const userDir = join(opts.home ?? rovecodeHome(), "commands");
  const projectDir = join(cwd, ".rovecode", "commands");
  const extra = (scope: CommandScope): [CommandScope, string][] => (opts.extraDirs ?? []).filter((e) => e.scope === scope).map((e) => [scope, e.dir]);
  // cwd IS the rovecode home: one directory, scanned once (gemini-cli FileCommandLoader.ts:221-228)
  const dirs: [CommandScope, string][] = resolve(userDir) === resolve(projectDir)
    ? [["project", projectDir], ...extra("user"), ...extra("project")]
    : [["user", userDir], ...extra("user"), ["project", projectDir], ...extra("project")];
  const byName = new Map<string, CustomCommand>();
  for (const [scope, dir] of dirs) {
    for (const cmd of scanCommandDir(dir, scope, warnings)) {
      // the verdict first, the path last: an 80-column terminal wraps a long path mid-line and the
      // sentence must survive at the line start
      if (reserved.has(cmd.name)) { warnings.push(`/${cmd.name} is a built-in command — built-in kept (${cmd.path})`); continue; }
      const prev = byName.get(cmd.name);
      if (prev?.scope === scope) { warnings.push(`${cmd.path}: /${cmd.name} already defined by ${prev.path} — first kept`); continue; }
      byName.set(cmd.name, cmd); // project (scanned second) shadows user
    }
  }
  return { commands: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)), warnings };
}

/** LOW-3: a symlinked `*.md` counts when its target is a file (a link to a directory is skipped
 *  like any directory); a DANGLING link stays in the list so the read below reports it unreadable. */
function linksToFile(path: string): boolean {
  try { return statSync(path).isFile(); } catch { return true; }
}

/** One directory's `*.md` files (top level only, sorted), each parsed or warned about. */
function scanCommandDir(dir: string, scope: CommandScope, warnings: string[]): CustomCommand[] {
  let files: string[];
  try {
    files = readdirSync(dir, { withFileTypes: true })
      .filter((e) => /\.md$/i.test(e.name) && (e.isFile() || (e.isSymbolicLink() && linksToFile(join(dir, e.name)))))
      .map((e) => e.name).sort();
  } catch {
    return []; // no such directory — silent, like the skills store
  }
  const out: CustomCommand[] = [];
  for (const file of files) {
    const path = join(dir, file);
    const name = file.slice(0, -3).toLowerCase();
    if (!NAME_RE.test(name)) { warnings.push(`${path}: skipped — command name "${name}" must match [a-z0-9_-]+`); continue; }
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (e) {
      warnings.push(`${path}: skipped — unreadable (${e instanceof Error ? e.message : String(e)})`);
      continue;
    }
    const parsed = parseCommandFile(text);
    if ("error" in parsed) { warnings.push(`${path}: skipped — ${parsed.error}`); continue; }
    out.push({
      name, description: clip(parsed.description ?? `custom command (${file})`, MAX_DESCRIPTION_CHARS), model: parsed.model, mode: parsed.mode,
      body: parsed.body, hints: hints(parsed.body), path, scope,
    });
  }
  return out;
}

// ---------- templating ----------

/** Template → prompt. `$ARGUMENTS` = the whole argument string, `$1..$9` = one quote-aware token
 *  each ("" when missing), `$$` = a literal `$`. One pass, so substituted text is never
 *  re-scanned. A template without placeholders gets the arguments appended after a blank line
 *  (prompt.ts:1393-1395) so nothing the user typed is silently dropped. */
export function renderCommand(cmd: Pick<CustomCommand, "body">, argString: string): string {
  const raw = argString.trim();
  const args = (raw.match(ARGS_RE) ?? []).map((a) => a.replace(QUOTE_TRIM_RE, ""));
  let placeholder = false;
  const out = cmd.body.replace(PLACEHOLDER_RE, (_m, tok: string) => {
    if (tok === "$") return "$";
    placeholder = true;
    return tok === "ARGUMENTS" ? raw : (args[Number(tok) - 1] ?? "");
  });
  return placeholder || raw === "" ? out : `${out}\n\n${raw}`;
}

/** `rovecode run "/name args"` hook (main.ts call sites — see the port notes): a leading `/name`
 *  that names a discovered command renders to its prompt; anything else passes through
 *  verbatim. `model`/`mode` are TUI semantics and are not applied here. */
export function expandSlashPrompt(prompt: string, cwd: string, opts: DiscoverOptions = {}): string {
  // port #53: the built-in prompt commands (/init) are consulted FIRST — a built-in beats a
  // same-named custom command, as in the TUI (aion commands.ts:216). Order matters: reversed, a
  // repo file named init.md would silently swallow rovecode run "/init".
  const builtin = expandBuiltinSlash(prompt, cwd);
  if (builtin !== undefined) return builtin;
  const m = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(prompt.trim());
  if (!m) return prompt;
  const cmd = discoverCommands(cwd, opts).commands.find((c) => c.name === m[1]!.toLowerCase());
  return cmd ? renderCommand(cmd, m[2] ?? "") : prompt;
}

// ---------- TUI surface ----------

/** Entries for Renderer.setCommands (editor autocomplete) — appended after the built-ins. */
export function commandsForPalette(list: readonly CustomCommand[]): SlashCommand[] {
  return list.map((c) => ({ name: c.name, description: c.description }));
}

/** `/help` tail: "" when there are none, else a "custom:" section (name, hints, description, scope). */
export function helpForCommands(list: readonly CustomCommand[]): string {
  if (list.length === 0) return "";
  return "\ncustom:\n" + list
    .map((c) => `/${c.name}${c.hints.length > 0 ? " " + c.hints.join(" ") : ""} — ${c.description} (${c.scope})`)
    .join("\n");
}

/** What the TUI hands the dispatcher (app.ts builds it once; state is read live). */
export interface CustomCommandCtx {
  renderer: Renderer;
  modes: ModeManager;
  state: ModeStateSlice;
  pushStatus: () => void;
  /** the plain user-turn path (app.ts `submit`): echo, flush a pending mode switch, start the run */
  submit: (text: string) => Promise<void>;
}

/** handleSlash `default:` hook: false when `name` is not a custom command (the caller reports
 *  "unknown command"); true after kicking off the run — fire-and-forget, the same shape as the
 *  other async slash commands. */
export function dispatchCustomCommand(ctx: CustomCommandCtx, list: readonly CustomCommand[], name: string, arg: string): boolean {
  const cmd = list.find((c) => c.name === name);
  if (!cmd) return false;
  void runCustomCommand(ctx, cmd, arg);
  return true;
}

/** Busy-gated like /plan and /checkpoints — a rendered prompt with a model/mode attached cannot
 *  be queued as steering. `mode` → togglePlanAct (stays); `model` → setModel like /model,
 *  restored after the run unless the user re-pointed it meanwhile (header: TUI semantics). */
export async function runCustomCommand(ctx: CustomCommandCtx, cmd: CustomCommand, arg: string): Promise<void> {
  if (ctx.state.busy) { ctx.renderer.addSystemNote("finish or interrupt the run first (Esc)", "warn"); return; }
  if (cmd.mode !== undefined && cmd.mode !== ctx.modes.mode) togglePlanAct(ctx.modes, cmd.mode, ctx.state, ctx.renderer, ctx.pushStatus);
  const prev = ctx.modes.modelFor().model;
  const override = cmd.model !== undefined && cmd.model !== prev;
  if (override) {
    ctx.modes.setModel({ model: cmd.model });
    ctx.state.model = ctx.modes.modelFor().model;
    ctx.renderer.addSystemNote(`model → ${cmd.model} for /${cmd.name} (restored after the run)`);
    ctx.pushStatus();
  }
  try {
    await ctx.submit(renderCommand(cmd, arg));
  } finally {
    if (override && ctx.modes.modelFor().model === cmd.model) {
      ctx.modes.setModel({ model: prev }); ctx.state.model = prev; ctx.pushStatus();
    }
  }
}
