/** Subagent orchestration (ADR-009): child sessions, depth caps, spawn policy,
 *  git-worktree isolation with delta patch merge-back (omp structured-subagent + worktree pattern). */

import { randomUUID } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentDefinition, AgentVars, SpawnRequest, SpawnResult, RunConfig, StreamFn, PermissionRule } from "../core/types.ts";
import { ToolRegistry } from "../core/tools.ts";
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
    if (git(["worktree", "add", "-b", `aion/task/${id}`, dir], rootDir).code === 0) {
      return {
        dir, kind: "worktree",
        diff: async () => git(["diff", "HEAD"], dir).out,
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
    // strip the baseline//work/ path roots so the patch applies at repo-relative paths
    diff: async () => {
      const d = git(["diff", "--no-index", "baseline", "work"], dir);
      return d.code <= 1 ? d.out.replace(/^([-+]{3} [ab]\/)(baseline|work)\//gm, "$1").replace(/^(diff --git a\/)baseline(\/\S+ b\/)work(\/\S+)/gm, "$1$2$3") : "";
    },
    cleanup: async () => { rmSync(dir, { recursive: true, force: true }); },
  };
}

export interface ChildRunnerDeps {
  defs: Map<string, AgentDefinition>;
  stream: StreamFn;
  registryFactory: (def: AgentDefinition, cwd: string) => ToolRegistry;
  rootDir: string;
  sessionsDir: string;
  baseConfig: RunConfig;
}

/** Runs a child agent in its own session (+ optional isolation), returns summary + patch.
 *  `depth` = this child's depth (root spawn = 0); grandchildren receive depth + 1 via agentLoop. */
export async function runChild(deps: ChildRunnerDeps, req: SpawnRequest, depth = 0): Promise<SpawnResult> {
  const fail = (summary: string): SpawnResult => ({ agent: req.agent, ok: false, summary, usage: { input: 0, output: 0 } });
  const def = deps.defs.get(req.agent);
  if (!def) return fail(`unknown agent '${req.agent}'`);
  const gate = preflightSpawn(def, { depth, maxDepth: DEFAULT_MAX_DEPTH, parentSessionId: "" });
  if (!gate.ok) return fail(gate.reason ?? "spawn refused");

  const iso = req.isolated ? await createIsolation(deps.rootDir, { prefer: "worktree" }) : await createIsolation(deps.rootDir, { prefer: "none" });
  try {
    const store = new SessionStore(deps.sessionsDir, randomUUID());
    const registry = deps.registryFactory(def, iso.dir);
    const steering = new SteeringQueue();
    const cfg: RunConfig = {
      ...deps.baseConfig,
      // children get their own permission set derived from parent policy (opencode task.ts:160)
      permissionRules: deriveChildRules(deps.baseConfig.permissionRules, iso.dir, iso.kind !== "none"),
    };
    for await (const ev of agentLoop(def, req.goal, req.vars ?? {}, cfg, {
      // port #4: children get their own loop guard — subagents loop too
      stream: deps.stream, registry, store, guard: new ToolGuard(),
    }, steering, depth + 1)) {
      void ev;
    }
    let input = 0, output = 0;
    for (const m of store.messages()) {
      if (m.usage) { input += m.usage.input; output += m.usage.output; }
    }
    const patch = iso.kind === "none" ? undefined : await iso.diff();
    let summary = lastText(store) || "(no output)";
    if (patch && !applyPatch(patch, deps.rootDir)) summary += `\npatch-apply-failed`;
    return { agent: req.agent, ok: true, summary: summary.slice(0, 4_000), usage: { input, output }, patch };
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
 *  - deny-rest terminator: any unlisted action defaults to deny for children
 */
export function deriveChildRules(rules: PermissionRule[], isoDir?: string, isolated = false): PermissionRule[] {
  const out = rules.map((r): PermissionRule => {
    if (r.effect === "prompt") return { ...r, effect: "deny" };
    if (isolated && isoDir && r.effect === "allow" && isPathResource(r)) return { ...r, resource: join(isoDir, r.resource) };
    return { ...r };
  });
  out.push({ action: "*", resource: "*", effect: "deny" });
  return out;
}

/** Path-shaped resources ("src/**", "**\/*.ts"); "rm *" (space-separated) is a command resource. */
function isPathResource(r: PermissionRule): boolean {
  if (r.resource === "*" || r.resource.includes(" ")) return false;
  return r.action.startsWith("file.") || r.resource.includes("/");
}
