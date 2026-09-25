/** Plugins: activation. For every ACTIVE plugin, import its entry module (Bun runs TypeScript natively:
 *  `await import()`, no build step — the .rovecode/hooks.ts idiom, the same trust class), validate the
 *  default export, and resolve the declarative contributions (commands dir, skills dir, MCP servers).
 *  The result is a set of already-typed things the runtime drops onto existing seams:
 *    tools → ToolRegistry.register (the same policy path as built-ins: kind → action, deny-default)
 *    hooks → HookRunner.add(set, source) (timeout-bounded and isolated by the runner, like hook files)
 *    commandsDir / skillsDir → the commands and skills loaders' extra roots
 *    mcp → appended to loadMcpConfig's servers
 *  A module that fails, hangs or lies about its version costs ONE warning and that plugin's code
 *  contributions — never a throw, never the other plugins. Disabled/untrusted/broken plugins are
 *  returned with empty contributions so `plugin list` can still show them. */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { HOOK_NAMES, type HookSet } from "../core/hooks.ts";
import type { Tool, ToolContext, ToolKind, ToolOutput } from "../core/types.ts";
import { isRecord } from "../mcp/config.ts";
import type { DiscoveredPlugin } from "./discover.ts";
import { PLUGIN_API_VERSION } from "./manifest.ts";

/** what the entry module receives when `tools` is a function */
export interface PluginCtx { cwd: string; home: string; pluginDir: string }

/** the entry module's default export */
export interface PluginModule {
  api: number;
  tools?: Tool[] | ((ctx: PluginCtx) => Tool[] | Promise<Tool[]>);
  hooks?: HookSet;
}

/** a discovered plugin plus what its entry module contributed (empty unless status is active) */
export interface LoadedPlugin extends DiscoveredPlugin {
  tools: Tool[];
  hooks: HookSet | null;
}

export interface ActivateOptions { cwd: string; home: string; /** import + tools() budget per plugin (default: ROVECODE_PLUGIN_TIMEOUT_MS, else 5000) */ timeoutMs?: number }
export const DEFAULT_PLUGIN_TIMEOUT_MS = 5000;
/** ROVECODE_PLUGIN_TIMEOUT_MS: blank/invalid/< 1 → default (the hooks.ts hookTimeoutMs rule) */
export function pluginTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.ROVECODE_PLUGIN_TIMEOUT_MS);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_PLUGIN_TIMEOUT_MS;
}

const KINDS: readonly ToolKind[] = ["read", "write", "execute", "spawn", "memory", "network", "custom"];
const TOOL_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;

/** kind → policy action, the same table core/tools.ts actionFor uses. `tool.<name>` has no
 *  declaration: a plugin's OWN name is its identity, not a capability. */
const KIND_ACTION: Partial<Record<ToolKind, string>> = {
  read: "file.read", write: "file.write", execute: "shell.exec", spawn: "spawn", memory: "memory.write", network: "net.fetch",
};

/** Permission declaration (manifest.permissions, sdk-blueprint.md §6.5): a plugin that declares
 *  permissions gets each tool wrapped — a call whose kind-action the manifest did not declare is
 *  refused BEFORE execute, with a message naming the plugin and the missing declaration. The user
 *  reads the declaration at install time (plugin show / market info); this wrap makes the promise
 *  true at run time. No declaration = legacy unrestricted (no wrap). */
function wrapPermissions(tool: Tool, declared: string[] | undefined, tag: string): Tool {
  if (declared === undefined) return tool;
  const action = KIND_ACTION[tool.kind];
  if (action === undefined) return tool; // custom `tool.<name>` — no capability to declare
  if (declared.includes(action) || declared.includes("*")) return tool;
  return {
    ...tool,
    execute: async (_args: unknown, _ctx: ToolContext): Promise<ToolOutput> => ({
      ok: false,
      output: `Permission denied: plugin '${tag}' did not declare '${action}' — add it to the manifest's "permissions" and re-install, or remove this tool`,
    }),
  };
}
const TIMED_OUT = Symbol("timed-out");

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const timer = new Promise<typeof TIMED_OUT>((r) => { t = setTimeout(() => r(TIMED_OUT), ms); });
  try { return await Promise.race([p, timer]); } finally { if (t !== undefined) clearTimeout(t); }
}
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export async function activatePlugins(found: readonly DiscoveredPlugin[], opts: ActivateOptions): Promise<{ plugins: LoadedPlugin[]; warnings: string[] }> {
  const warnings: string[] = [];
  const plugins: LoadedPlugin[] = [];
  for (const p of found) plugins.push(await activateOne(p, opts, warnings));
  return { plugins, warnings };
}

async function activateOne(p: DiscoveredPlugin, opts: ActivateOptions, warnings: string[]): Promise<LoadedPlugin> {
  const out: LoadedPlugin = { ...p, tools: [], hooks: null };
  if (p.status !== "active" || p.manifest === null) return out; // untrusted / disabled / broken: nothing of theirs runs
  const m = p.manifest, tag = `plugin ${p.name}`;
  if (!m.entry) return out;
  const entry = join(p.dir, m.entry);
  if (!existsSync(entry)) { warnings.push(`${tag}: entry ${m.entry} does not exist — no tools or hooks loaded`); return out; }
  const ms = opts.timeoutMs ?? pluginTimeoutMs();
  let mod: unknown;
  try { mod = await withTimeout(import(pathToFileURL(entry).href), ms); }
  catch (e) { warnings.push(`${tag}: ${m.entry} failed to load — ${errText(e)}`); return out; }
  if (mod === TIMED_OUT) { warnings.push(`${tag}: ${m.entry} load timed out after ${ms}ms (top-level await?) — skipped`); return out; }
  const dflt: unknown = isRecord(mod) ? mod["default"] : undefined;
  if (!isRecord(dflt)) { warnings.push(`${tag}: ${m.entry} must \`export default { api: ${PLUGIN_API_VERSION}, tools?, hooks? }\` — skipped`); return out; }
  if (dflt["api"] !== PLUGIN_API_VERSION) { warnings.push(`${tag}: ${m.entry} declares api ${String(dflt["api"])}; this rovecode speaks ${PLUGIN_API_VERSION} — skipped`); return out; }
  for (const key of Object.keys(dflt)) if (!["api", "tools", "hooks"].includes(key)) warnings.push(`${tag}: ${m.entry} exports unknown member "${key}" — ignored`);
  // tools: an array, or a factory that gets the plugin's ctx (its own folder for data files, the cwd, the home)
  if (dflt["tools"] !== undefined) {
    let list: unknown;
    try {
      const raw = dflt["tools"];
      list = typeof raw === "function" ? await withTimeout(Promise.resolve((raw as (c: PluginCtx) => unknown)({ cwd: opts.cwd, home: opts.home, pluginDir: p.dir })), ms) : raw;
    } catch (e) { warnings.push(`${tag}: tools() threw — ${errText(e)}`); list = []; }
    if (list === TIMED_OUT) { warnings.push(`${tag}: tools() timed out after ${ms}ms — no tools loaded`); list = []; }
    if (!Array.isArray(list)) { warnings.push(`${tag}: "tools" must be an array (or a function returning one) — ignored`); list = []; }
    const seen = new Set<string>();
    for (const t of list as unknown[]) {
      const ok = validateTool(t, tag, warnings);
      if (!ok) continue;
      if (seen.has(ok.schema.name)) { warnings.push(`${tag}: tool "${ok.schema.name}" declared twice — first kept`); continue; }
      seen.add(ok.schema.name); out.tools.push(wrapPermissions(ok, m.permissions, tag));
    }
  }
  // hooks: the HookSet shape hooks.ts validates for files — unknown names and non-functions dropped, the rest kept
  if (dflt["hooks"] !== undefined) {
    if (!isRecord(dflt["hooks"])) warnings.push(`${tag}: "hooks" must be an object of hook functions — ignored`);
    else {
      const set: Record<string, unknown> = {};
      for (const [name, fn] of Object.entries(dflt["hooks"])) {
        if (!(HOOK_NAMES as readonly string[]).includes(name)) { warnings.push(`${tag}: unknown hook "${name}" ignored (known: ${HOOK_NAMES.join(", ")})`); continue; }
        if (typeof fn !== "function") { warnings.push(`${tag}: hook "${name}" is not a function — ignored`); continue; }
        set[name] = fn;
      }
      if (Object.keys(set).length) out.hooks = set as HookSet;
    }
  }
  return out;
}

/** a Tool as core/types.ts defines it; anything else is named and dropped */
function validateTool(t: unknown, tag: string, warnings: string[]): Tool | null {
  if (!isRecord(t) || !isRecord(t["schema"])) { warnings.push(`${tag}: a tool without a schema was dropped`); return null; }
  const s = t["schema"];
  const name = s["name"];
  if (typeof name !== "string" || !TOOL_NAME_RE.test(name)) { warnings.push(`${tag}: tool name ${JSON.stringify(name)} must match ${TOOL_NAME_RE} — dropped`); return null; }
  if (typeof s["description"] !== "string" || !s["description"].trim()) { warnings.push(`${tag}: tool "${name}" needs a description — dropped`); return null; }
  if (!isRecord(s["args"])) { warnings.push(`${tag}: tool "${name}" needs a JSON-Schema "args" object — dropped`); return null; }
  if (!KINDS.includes(t["kind"] as ToolKind)) { warnings.push(`${tag}: tool "${name}" kind ${JSON.stringify(t["kind"])} is not one of ${KINDS.join("|")} — dropped (the kind is its permission class)`); return null; }
  if (typeof t["execute"] !== "function") { warnings.push(`${tag}: tool "${name}" has no execute() — dropped`); return null; }
  return t as unknown as Tool;
}
