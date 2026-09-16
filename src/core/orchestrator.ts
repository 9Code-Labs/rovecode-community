/** Subagent orchestration (ADR-009): child sessions, depth caps, spawn policy,
 *  git-worktree isolation with delta patch merge-back (omp structured-subagent + worktree pattern). */

import { randomUUID } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentDefinition, AgentVars, ModelRef, SpawnRequest, SpawnResult, RunConfig, StreamFn, PermissionRule, ToolSchema } from "../core/types.ts";
import { applyModeRules, planModePromptSection } from "./modes.ts";
import { ToolRegistry, type ExtensionHooks } from "../core/tools.ts";
import { ToolGuard } from "../core/guardrails.ts";
import { SessionStore } from "../core/session.ts";
import { agentLoop, SteeringQueue } from "../core/loop.ts";

export const DEFAULT_MAX_DEPTH = 3;

export interface SpawnContext {
  depth: number;          // 0 = root
  maxDepth: number;
  parentSessionId: string;
}

/** Preflight (omp structured-subagent.ts:220-237): depth, spawn policy, recursion block. */
export function preflightSpawn(def: AgentDefinition, ctx: SpawnContext): { ok: boolean; reason?: string } {
  const policy = def.spawns ?? "subtasks";
  if (policy === "none") return { ok: false, reason: `agent '${def.name}' spawn policy is 'none'` };
  if (ctx.depth >= ctx.maxDepth) return { ok: false, reason: `depth cap ${ctx.maxDepth} reached (current ${ctx.depth})` };
  return { ok: true };
}

export interface IsolationWorkspace {
  dir: string;
  kind: "worktree" | "copy" | "none";
  /** produce a git-compatible patch of changes vs baseline */
  diff(): Promise<string>;
  cleanup(): Promise<void>;
}

function git(args: string[], cwd: string, stdin?: string): { code: number; out: string } {
  const p = Bun.spawnSync(["git", ...args], { cwd, stdin: stdin === undefined ? "ignore" : new Blob([stdin]), stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode ?? -1, out: p.stdout.toString() };
}

/** COW-ish isolation: prefer `git worktree`, fall back to plain copy (omp pi-iso ladder).
 *  Windows-safe: git for worktree/diff, node fs.cpSync/rmSync for copy/cleanup (no POSIX cp/rm/diff). */
export async function createIsolation(rootDir: string, opts: { prefer: "worktree" | "copy" | "none" }): Promise<IsolationWorkspace> {
  if (opts.prefer === "none") {
    return { dir: rootDir, kind: "none", diff: async () => "", cleanup: async () => {} };
  }
  const id = randomUUID().slice(0, 8);
  if (opts.prefer === "worktree") {
    const dir = join(rootDir, ".rovecode", "worktrees", id);
    // --detach (fix-wave L3): `-b rovecode/task/<id>` left one branch per isolated task behind in
    // the root repo after `worktree remove`; a detached checkout at HEAD leaves only the
    // worktree, which cleanup removes
    if (git(["worktree", "add", "--detach", dir], rootDir).code === 0) {
      return {
        dir, kind: "worktree",
        // intent-to-add first: `git diff HEAD` never shows UNTRACKED files, so a child's
        // new files would silently miss the merge-back (port #26 isolation fix)
        diff: async () => { git(["add", "-A", "-N"], dir); return git(["diff", "HEAD"], dir).out; },
        cleanup: async () => { git(["worktree", "remove", "--force", dir], rootDir); },
      };
    }
  }
  // copy fallback: work/ is the live copy the child mutates; baseline/ is the pristine snapshot
  // (node fs.cpSync/fs.rmSync — POSIX `cp -r`/`rm -rf` don't exist on Windows)
  const dir = mkdtempSync(join(tmpdir(), "rovecode-iso-"));
  try {
    mkdirSync(join(dir, "baseline"));
    cpSync(rootDir, join(dir, "baseline"), { recursive: true });
    cpSync(rootDir, join(dir, "work"), { recursive: true });
  } catch {
    rmSync(dir, { recursive: true, force: true });
    return { dir: rootDir, kind: "none", diff: async () => "", cleanup: async () => {} };
  }
  return {
    dir: join(dir, "work"), kind: "copy",
    // git diff --no-index (POSIX `diff -ru` doesn't exist on Windows and isn't a git patch);
    // strip the baseline//work/ path roots so the patch applies at repo-relative paths.
    // The header names EITHER root on either side (modify: a/baseline b/work; create:
    // a/work b/work; delete: a/baseline b/baseline) — strip both, or `git apply` rejects
    // creations with "inconsistent new filename" (port #26 isolation fix).
    diff: async () => {
      const d = git(["diff", "--no-index", "baseline", "work"], dir);
      return d.code <= 1 ? d.out.replace(/^([-+]{3} [ab]\/)(baseline|work)\//gm, "$1").replace(/^(diff --git a\/)(?:baseline|work)\/(\S+ b\/)(?:baseline|work)\/(\S+)/gm, "$1$2$3") : "";
    },
    cleanup: async () => { rmSync(dir, { recursive: true, force: true }); },
  };
}

/** Per-child context handed to registryFactory (port #26): a child's registry can
 *  bind nested tools (the `task` tool) to THIS child's depth, its own steering
 *  queue (nested completion notes land in the child's next turn, not the root's)
 *  and its run signal. `taskId` is set by TaskManager when the child IS a
 *  background task (enables slot lending); plain runChild callers leave it unset. */
export interface ChildContext {
  depth: number;
  steering: SteeringQueue;
  signal?: AbortSignal;
  taskId?: string;
  /** the tool names of the registry that STARTED this child (a nested start: the spawning child's own, restricted set) —
   *  the registry factory clamps the child's table to it, so a definition's allow-list is transitive down the chain
   *  (a restricted agent cannot widen via `main`). Absent for a root start: the root registry's names apply. */
  parentTools?: ReadonlySet<string>;
  /** This child's OWN working tree — `iso.dir`, which for an isolated child is its worktree and for a
   *  plain one is the root. It is here so that what this child starts in turn works where THIS child
   *  works: an external lane builds its worktree from `dir` and merges its patch back into `dir`, so a
   *  nested lane's result travels up the same chain of patches as everything else the child did. Left
   *  unset it defaults to the manager's rootDir, which for an isolated child is the USER'S live tree —
   *  the lane would then write straight past the isolation its parent was given. */
  dir?: string;
}

export interface ChildRunnerDeps {
  defs: Map<string, AgentDefinition>;
  stream: StreamFn;
  registryFactory: (def: AgentDefinition, cwd: string, child?: ChildContext) => ToolRegistry;
  /** the non-native tool-calling prompt block for `model` over `tools` ("" for a model that calls tools natively) —
   *  rendered HERE from the child's own restricted registry, never from the root's list (cli/runtime.ts buildDef leaves
   *  a child definition bare for this reason) */
  toolPrompt?: (model: ModelRef, tools: ToolSchema[]) => string;
  rootDir: string;
  sessionsDir: string;
  baseConfig: RunConfig;
  /** port #29: the parent runtime's hook set — a child runs under the same hooks (pre_tool vetoes,
   *  post_tool, pre_run/post_run/on_event via the observer), so delegation cannot dodge a hook */
  hooks?: ExtensionHooks;
}

/** Runs a child agent in its own session (+ optional isolation), returns summary + patch.
 *  `depth` = this child's depth (root spawn = 0); grandchildren receive depth + 1 via agentLoop.
 *  `signal` (port #26): aborting it cancels the child's run — agentLoop's own controller
 *  follows deps.signal (port #21), so the in-flight fetch and tool subprocesses die.
 *  ok = the child's run ended "done"; error/budget/stopped runs return ok:false with
 *  the run_end summary (a background job needs a truthful failed status). An isolated
 *  child's patch is merged back ONLY when ok — a cancelled or errored child's
 *  half-done edits never land in the parent tree (the patch is still returned). */
export async function runChild(deps: ChildRunnerDeps, req: SpawnRequest, depth = 0, signal?: AbortSignal): Promise<SpawnResult> {
  const fail = (summary: string): SpawnResult => ({ agent: req.agent, ok: false, summary, usage: { input: 0, output: 0 } });
  const def = deps.defs.get(req.agent);
  if (!def) return fail(`unknown agent '${req.agent}'`);
  const gate = preflightSpawn(def, { depth, maxDepth: DEFAULT_MAX_DEPTH, parentSessionId: "" });
  if (!gate.ok) return fail(gate.reason ?? "spawn refused");

  const iso = req.isolated ? await createIsolation(deps.rootDir, { prefer: "worktree" }) : await createIsolation(deps.rootDir, { prefer: "none" });
  try {
    const store = new SessionStore(deps.sessionsDir, randomUUID());
    const steering = new SteeringQueue();
    const registry = deps.registryFactory(def, iso.dir, { depth, steering, signal, dir: iso.dir, ...(req.parentTools ? { parentTools: req.parentTools } : {}) });
    // a plan-mode definition (AgentDefinition.mode, core/agents.ts) runs under the plan rule set — appended to the PARENT's
    // rules before the child derivation, so last-match-wins denies write/shell/spawn/memory even under a yolo parent (the
    // TUI's meaning of plan mode) — and gets the plan prompt section; "act"/absent changes nothing
    const parentRules = applyModeRules(def.mode ?? "act", deps.baseConfig.permissionRules);
    const cfg: RunConfig = {
      ...deps.baseConfig,
      // children get their own permission set derived from parent policy (opencode task.ts:160)
      permissionRules: deriveChildRules(parentRules, iso.dir, iso.kind !== "none"),
    };
    // the child's request carries ITS registry's schemas. Every root surface passes `tools`; runChild never did, so a
    // native-tool-calling model got a request with no tools and could call nothing, whatever the registry held — the
    // scripted streams in the tests ignore `tools`, which is why nobody saw it (found porting #62, 2026-09-07)
    const schemas = registry.list().map((t) => t.schema);
    // the non-native tool-calling block is rendered from the SAME restricted set (a root-registry block would advertise
    // tools the child cannot call)
    const toolBlock = def.model && deps.toolPrompt ? deps.toolPrompt(def.model, schemas) : "";
    const sections = [def.mode === "plan" ? planModePromptSection() : "", toolBlock ? `# Tool calling\n${toolBlock}` : ""].filter((s) => s !== "");
    const runDef: AgentDefinition = sections.length > 0
      ? { ...def, systemPrompt: (v: AgentVars) => [typeof def.systemPrompt === "function" ? def.systemPrompt(v) : def.systemPrompt, ...sections].join("\n\n") }
      : def;
    let end: { status: string; summary: string } | undefined;
    for await (const ev of agentLoop(runDef, req.goal, req.vars ?? {}, cfg, {
      // port #4: children get their own loop guard — subagents loop too
      stream: deps.stream, registry, store, guard: new ToolGuard(), tools: schemas,
      // tools resolve relative paths / run shells in the ISOLATION dir, not the process cwd
      cwd: iso.dir,
      signal,
      hooks: deps.hooks, // port #29: the parent's hooks govern the child too
    }, steering, depth + 1)) {
      if (ev.type === "run_end") end = { status: ev.status, summary: ev.summary };
    }
    let input = 0, output = 0;
    for (const m of store.messages()) {
      if (m.usage) { input += m.usage.input; output += m.usage.output; }
    }
    const patch = iso.kind === "none" ? undefined : await iso.diff();
    const ok = end?.status === "done";
    const text = lastText(store);
    let summary = ok
      ? (text || "(no output)")
      : `${end?.summary ?? "child run ended without run_end"}${text ? `\nlast output: ${text}` : ""}`;
    // Whether the merge-back LANDED is a fact, and it now travels as one. `git apply` refusing leaves
    // ok:true, so the marker below was the only trace — and it is appended to a summary that is then
    // sliced to 4000 chars, which means a child verbose enough to describe its own diff lost the marker
    // and read as applied. The reader downstream is the collision summary, and the patch git refuses is
    // usually the SECOND one to touch a file: exactly the task that must not be named as its writer.
    // Absent when there was no merge-back to attempt, so every existing path keeps its meaning.
    const applied = ok && patch ? applyPatch(patch, deps.rootDir) : undefined;
    if (applied === false) summary += `\npatch-apply-failed`;   // kept: human-readable text, no longer load-bearing
    return { agent: req.agent, ok, summary: summary.slice(0, 4_000), usage: { input, output }, patch, ...(applied !== undefined ? { applied } : {}) };
  } finally {
    await iso.cleanup();
  }
}

function lastText(store: SessionStore): string {
  const last = [...store.messages()].reverse().find((m) => m.role === "assistant");
  return last ? last.parts.filter((p) => p.kind === "text").map((p) => (p as { text: string }).text).join("") : "";
}

/** Best-effort merge-back into the parent tree (omp worktree → git apply). */
export function applyPatch(patch: string, parentDir: string): boolean {
  if (!patch.trim()) return true; // nothing changed
  // -c core.autocrlf=false: apply the patch byte-exact — Git for Windows' system-level autocrlf=true
  // would rewrite every patched file to CRLF, even in a non-repo parent dir (measured on the copy rung)
  return git(["-c", "core.autocrlf=false", "apply", "--whitespace=nowarn", "-"], parentDir, patch).code === 0;
}

/** Children never exceed parent grants:
 *  - "prompt" rules become "deny": children are non-interactive, nobody can answer a prompt
 *  - isolated children: path-glob allow resources are re-rooted under the isolation dir
 *  - non-isolated children keep allow breadth unchanged (resources are action-shaped globs like
 *    "src/**" or "rm *"; prefixing them with an absolute path would break shell-command matching)
 *  - deny-rest DEFAULT, placed FIRST: evaluatePermissions is LAST-match-wins
 *    (tools.ts), so the catch-all must sit at the lowest priority for the
 *    parent-derived rules after it to override — an unlisted action falls
 *    through to it and is denied. Appending it LAST was bug FW2-P: the
 *    catch-all matched everything as the final word and overrode every
 *    parent allow, denying ALL child tool calls even under an allow-all parent.
 */
export function deriveChildRules(rules: PermissionRule[], isoDir?: string, isolated = false): PermissionRule[] {
  const out: PermissionRule[] = [{ action: "*", resource: "*", effect: "deny" }];
  for (const r of rules) {
    if (r.effect === "prompt") out.push({ ...r, effect: "deny" });
    else if (isolated && isoDir && r.effect === "allow" && isPathResource(r)) out.push({ ...r, resource: join(isoDir, r.resource) });
    else out.push({ ...r });
  }
  return out;
}

/** Path-shaped resources ("src/**", "**\/*.ts"); "rm *" (space-separated) is a command resource. */
function isPathResource(r: PermissionRule): boolean {
  if (r.resource === "*" || r.resource.includes(" ")) return false;
  return r.action.startsWith("file.") || r.resource.includes("/");
}
