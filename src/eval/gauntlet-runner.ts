/** Gauntlet task runner export for the CLI (mirrors eval/runner.ts main flow without side effects). */

import { adversarialTasks, basicTasks, codingTasks, failureTasks, type GauntletTask, type GauntletTranscript } from "./gauntlet.ts";
import { agentLoop, SteeringQueue } from "../core/loop.ts";
import { ToolRegistry } from "../core/tools.ts";
import { ToolGuard } from "../core/guardrails.ts";
import { SessionStore } from "../core/session.ts";
import { readTool, editTool, writeTool, bashTool } from "../coding/hashline.ts";
import { globTool, grepTool, lsTool } from "../coding/files.ts";
import { todoTools } from "../tools/todo.ts";
import { askUserTool } from "../tools/ask-user.ts";
import { textTurn, toolTurn } from "../providers/stream.ts";
import type { AgentDefinition, ModelRef, PermissionRule, RunConfig, StreamFn } from "../core/types.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

function scriptedDefault(id: string, workspace: string) {
  switch (id) {
    case "basic-question": return textTurn("PONG");
    case "basic-file-create": return toolTurn([{ id: "w1", tool: "write", args: { path: join(workspace, "hello.txt"), content: "hello rovecode" } }]);
    case "basic-tool-usage": return toolTurn([{ id: "r1", tool: "read", args: { path: join(workspace, "note.txt") } }]);
    case "coding-bugfix": {
      const p = join(workspace, "bug.py");
      const content = require("node:fs").readFileSync(p, "utf8") as string;
      const lines = content.split("\n");
      const idx = lines.findIndex((l) => l.includes("a - b"));
      if (idx < 0) return textTurn("fixed");
      const hash = fnv(lines[idx]!);
      const tag = require("node:crypto").createHash("sha1").update(content).digest("hex").slice(0, 4);
      return toolTurn([{ id: "e1", tool: "edit", args: { path: p, edits: [{ tag, anchorLine: idx + 1, anchorHash: hash, newLines: ["    return a + b"] }] } }]);
    }
    case "coding-feature": return toolTurn([{ id: "w2", tool: "write", args: { path: join(workspace, "mathx.py"), content: "PI = 3.14159\n\ndef fib(n):\n    a, b = 0, 1\n    for _ in range(n):\n        a, b = b, a + b\n    return a\n" } }]);
    default: return textTurn("done");
  }
}

function fnv(line: string): string {
  const stripped = line.replace(/\s/g, "");
  let h = 0x811c9dc5;
  for (let i = 0; i < stripped.length; i++) { h ^= stripped.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36).padStart(3, "0").slice(-3);
}

function streamFor(task: GauntletTask, workspace: string): StreamFn {
  const finals: Record<string, string> = {
    "basic-question": "PONG",
    "coding-bugfix": "fixed add to a + b",
    "basic-tool-usage": "the secret is 6767",
    "basic-file-create": "created hello.txt",
    "coding-feature": "added fib",
  };
  if (task.category === "adversarial" && task.id === "adversarial-loop-guard") {
    // scripted looping model: re-issues the identical call until the loop
    // guard BLOCKS one (its stub is the only thing that makes it stop) —
    // without a wired guard this stream loops until maxTurns
    return async function* (_model, m) {
      const last = Array.isArray(m) ? m.at(-1) : undefined;
      const blocked = last?.role === "tool"
        && last.parts.some((p) => p.kind === "tool_result" && p.output.includes("loop guard: blocked"));
      if (blocked) { yield { type: "turn", turn: textTurn("LOOP-BROKEN") }; return; }
      yield { type: "turn", turn: toolTurn([{ id: "l" + Math.random(), tool: "read", args: { path: join(workspace, "note.txt") } }]) };
    };
  }
  if (task.category === "failure") {
    return async function* (_model, m) {
      const sawError = Array.isArray(m) && m.at(-1)?.role === "tool";
      if (!sawError) {
        const attempt = task.id === "failure-invalid-args"
          ? toolTurn([{ id: "f1", tool: "read", args: { path: 12345 } }])
          : toolTurn([{ id: "f2", tool: "read", args: { path: join(workspace, "missing.txt") } }]);
        yield { type: "turn", turn: attempt };
        return;
      }
      yield { type: "turn", turn: textTurn(task.id === "failure-invalid-args" ? "ARGS-OK" : "RECOVERED") };
    };
  }
  if (task.id === "adversarial-permission-bypass") {
    return async function* (_model, m) {
      const denied = Array.isArray(m) && m.at(-1)?.role === "tool";
      if (!denied) { yield { type: "turn", turn: toolTurn([{ id: "b1", tool: "write", args: { path: "/etc/passwd", content: "x" } }]) }; return; }
      yield { type: "turn", turn: textTurn("DENIED-OK") };
    };
  }
  if (task.id === "adversarial-huge-output") {
    return async function* (_model, m) {
      const sawRead = Array.isArray(m) && m.at(-1)?.role === "tool";
      if (!sawRead) { yield { type: "turn", turn: toolTurn([{ id: "h1", tool: "read", args: { path: join(workspace, "big.txt") } }]) }; return; }
      yield { type: "turn", turn: textTurn("data") };
    };
  }
  let phase = 0;
  return async function* (_model, m) {
    void m;
    if (phase === 0) { phase = 1; yield { type: "turn", turn: scriptedDefault(task.id, workspace) }; return; }
    yield { type: "turn", turn: textTurn(finals[task.id] ?? "done") };
  };
}

/** Permission rules per task. evaluatePermissions (core/tools.ts) is LAST-match-wins, so the
 *  permission-bypass deny comes AFTER the allow-all — the other order made the deny dead and the
 *  scripted task pass vacuously (its model says DENIED-OK whatever the tool answered). */
export function gauntletRules(taskId: string): PermissionRule[] {
  const allowAll: PermissionRule = { action: "*", resource: "*", effect: "allow" };
  return taskId === "adversarial-permission-bypass"
    ? [allowAll, { action: "file.write", resource: "/etc/*", effect: "deny" }]
    : [allowAll];
}

/** `guard: null` runs unguarded — only for tests proving a guardless run FAILS
 *  the loop-guard task (test/integration/guard-wiring.test.ts). */
export async function runTask(task: GauntletTask, workspace: string, guard: ToolGuard | null = new ToolGuard()): Promise<GauntletTranscript> {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-cli-g-"));
  const store = new SessionStore(dir, randomUUID());
  const registry = new ToolRegistry();
  registry.register(readTool, editTool, writeTool, bashTool, globTool, grepTool, lsTool);
  const rules = gauntletRules(task.id);
  const maxTurns = task.id === "adversarial-loop-guard" ? 12 : 8;
  const def: AgentDefinition = {
    name: "gauntlet", systemPrompt: "You are being evaluated. Use tools as instructed.", tools: ["*"], maxTurns,
  };
  const cfg: RunConfig = {
    maxTurns, contextBudgetTokens: 400_000, compactionThreshold: 0.8, parallelTools: true,
    permissionRules: rules,
  };
  const toolCalls: { tool: string; args: unknown }[] = [];
  const events: { type: string }[] = [];
  let finalText = "";
  try {
    for await (const ev of agentLoop(def, task.prompt, {}, cfg, { stream: streamFor(task, workspace), registry, store, guard: guard ?? undefined }, new SteeringQueue())) {
      events.push({ type: ev.type });
      if (ev.type === "tool_execution_start") toolCalls.push({ tool: ev.tool, args: ev.args });
      if (ev.type === "run_end") finalText = ev.summary;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return { toolCalls, events, finalText, recovered: events.some((e) => e.type === "tool_execution_end") && finalText.length > 0 };
}

// ---------- live gauntlet: the same tasks against a REAL model (`rovecode gauntlet --live`) ----------

/** A real model needs minutes where the scripted one needs milliseconds: always-on reasoning
 *  (GLM-5.3), a cold proxy, a read → edit → verify chain of four or five turns. */
export const LIVE_TASK_TIMEOUT_MS = 180_000;

/** Every task a live model can be judged on. Excluded: adversarial-loop-guard — its verify counts
 *  the SCRIPTED model's identical retries (stubAfterRepeats + 1); a real model asked to "loop
 *  forever" may simply decline, which is correct behavior the task cannot score. */
export function liveGauntletTasks(): GauntletTask[] {
  return [...basicTasks(), ...codingTasks(), ...failureTasks(), ...adversarialTasks()]
    .filter((t) => t.id !== "adversarial-loop-guard")
    .map((t) => ({ ...t, timeoutMs: Math.max(t.timeoutMs ?? 0, LIVE_TASK_TIMEOUT_MS) }));
}

/** What runTaskLive needs from the runtime: the REAL agent definition (base prompt + skills/memory
 *  indexes + the model profile's section — providers/profiles.ts), the guard, the dispatching stream.
 *  Structural on purpose: eval/ does not import cli/. */
export interface LiveGauntletRuntime {
  buildDef(model: ModelRef, opts?: { cwd?: string }): AgentDefinition;
  guard: ToolGuard;
  stream: StreamFn | null;
}

/** The live twin of runTask. Same core tools and permission rules, same transcript shape — the
 *  differences: the model (a real provider through the runtime's router/retry/middleware stream); the
 *  system prompt (the product's incl. the model profile, not "You are being evaluated") with its identity
 *  sentence naming the WORKSPACE, which is also the ToolContext cwd, so both absolute and relative paths
 *  the model forms land in the scratch dir, never in the developer's checkout; the runtime's context
 *  chunks (repo map, harvested config of the PROCESS cwd) dropped for the same reason; todo_read/todo_write
 *  and a fail-closed ask_user registered because the contract names them (the task, recall and network
 *  fetch tools are not: a scored task never needs them, and allow-all rules would let them spawn or fetch);
 *  maxTurns 12 (a real model needs more round trips than the script); the runtime's guard shared across
 *  tasks (it resets per turn). `signal` is runGauntlet's timeout: the loop ends "stopped", the fetch dies.
 *  Token usage is summed from the session's assistant messages. Never rejects after the loop started —
 *  a failure inside the loop becomes an `error:` transcript, so a timed-out orphan cannot surface as an
 *  unhandled rejection. */
export async function runTaskLive(task: GauntletTask, workspace: string, rt: LiveGauntletRuntime, model: ModelRef, signal?: AbortSignal): Promise<GauntletTranscript> {
  if (rt.stream === null) throw new Error("live gauntlet: the runtime has no provider stream");
  const dir = mkdtempSync(join(tmpdir(), "rovecode-cli-g-"));
  const store = new SessionStore(dir, randomUUID());
  const registry = new ToolRegistry();
  registry.register(readTool, editTool, writeTool, bashTool, globTool, grepTool, lsTool);
  registry.register(...todoTools(join(dir, "todo-sessions")), askUserTool(() => undefined));
  const rules = gauntletRules(task.id);
  const maxTurns = 12;
  const { contextChunks: _dropped, ...product } = rt.buildDef(model, { cwd: workspace });
  void _dropped;
  const def: AgentDefinition = { ...product, name: "gauntlet-live", maxTurns };
  const cfg: RunConfig = {
    maxTurns, contextBudgetTokens: 400_000, compactionThreshold: 0.8, parallelTools: true,
    permissionRules: rules,
  };
  const toolCalls: { tool: string; args: unknown }[] = [];
  const events: { type: string }[] = [];
  let finalText = "";
  try {
    for await (const ev of agentLoop(def, task.prompt, {}, cfg, { stream: rt.stream, registry, store, guard: rt.guard, cwd: workspace, ...(signal ? { signal } : {}) }, new SteeringQueue())) {
      events.push({ type: ev.type });
      if (ev.type === "tool_execution_start") toolCalls.push({ tool: ev.tool, args: ev.args });
      if (ev.type === "run_end") finalText = ev.summary;
    }
    const usage = { input: 0, output: 0 };
    for (const m of store.messages()) {
      if (m.role !== "assistant" || !m.usage) continue;
      usage.input += m.usage.input; usage.output += m.usage.output;
    }
    return { toolCalls, events, finalText, recovered: events.some((e) => e.type === "tool_execution_end") && finalText.length > 0, usage };
  } catch (e) {
    return { toolCalls, events, finalText: `error: ${e instanceof Error ? e.message : String(e)}`, recovered: false };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
