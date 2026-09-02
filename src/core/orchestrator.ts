/** Subagent orchestration (ADR-009): child sessions, depth caps, spawn policy,
 *  git-worktree isolation with delta patch merge-back (omp structured-subagent + worktree pattern). */

import { randomUUID } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentDefinition, AgentVars, SpawnRequest, SpawnResult, RunConfig, StreamFn, PermissionRule } from "../core/types.ts";
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
    const dir = join(rootDir, ".aion", "worktrees", id);
    // --detach (fix-wave L3): `-b aion/task/<id>` left one branch per isolated task behind in
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
  const dir = mkdtempSync(join(tmpdir(), "aion-iso-"));
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
}

export interface ChildRunnerDeps {
  defs: Map<string, AgentDefinition>;
  stream: StreamFn;
  registryFactory: (def: AgentDefinition, cwd: string, child?: ChildContext) => ToolRegistry;
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
    const registry = deps.registryFactory(def, iso.dir, { depth, steering, signal });
    const cfg: RunConfig = {
      ...deps.baseConfig,
      // children get their own permission set derived from parent policy (opencode task.ts:160)
      permissionRules: deriveChildRules(deps.baseConfig.permissionRules, iso.dir, iso.kind !== "none"),
    };
    let end: { status: string; summary: string } | undefined;
    for await (const ev of agentLoop(def, req.goal, req.vars ?? {}, cfg, {
      // port #4: children get their own loop guard — subagents loop too
      stream: deps.stream, registry, store, guard: new ToolGuard(),
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
    if (ok && patch && !applyPatch(patch, deps.rootDir)) summary += `\npatch-apply-failed`;
    return { agent: req.agent, ok, summary: summary.slice(0, 4_000), usage: { input, output }, patch };
  } finally {
    await iso.cleanup();
  }
}

function lastText(store: SessionStore): string {
  const last = [...store.messages()].reverse().find((m) => m.role === "assistant");
  return last ? last.parts.filter((p) => p.kind === "text").map((p) => (p as { text: string }).text).join("") : "";
}

/** Best-effort merge-back into the parent tree (omp worktree → git apply). */
function applyPatch(patch: string, parentDir: string): boolean {
  if (!patch.trim()) return true; // nothing changed
  return git(["apply", "--whitespace=nowarn", "-"], parentDir, patch).code === 0;
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
