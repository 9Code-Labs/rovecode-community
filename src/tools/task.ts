/** `task` tool (port #26): the model's door to background subagents — actions
 *  start|status|result|cancel|list over core/tasks.ts TaskManager. Children run through
 *  orchestrator.ts runChild (the ONE agentLoop); this tool never runs a loop itself.
 *
 *  Source shape: opencode packages/opencode/src/tool/task.ts (MIT, snapshot
 *  research/source_snapshots/opencode-2026 @ ebece6e) — parameters description/prompt/
 *  subagent_type + background flag (:43-62), "started" text that tells the model NOT to
 *  poll and to keep working or end its turn (:31-35), depth walk refusal (:104-117),
 *  result rendered as a tagged block with the child's final text (:64-79, :341-345).
 *  Departures: one tool with an `action` arg instead of background:true on a foreground
 *  tool; `result` is an explicit bounded wait; refusals come from the orchestrator's
 *  preflight (depth cap / spawn policy) as tool output, never exceptions.
 *
 *  Policy: kind "spawn" → action "spawn" (core/tools.ts actionFor). The default gated
 *  rules PROMPT for it (cli/runtime.ts buildCfg); yolo allows; children derive
 *  prompt→deny (orchestrator deriveChildRules), so nested tasks exist only under an
 *  allow rule. Plan mode denies spawn (core/modes.ts). */

import type { Tool, ToolContext, ToolOutput } from "../core/types.ts";
import { formatTaskList, isTerminal, type TaskId, type TaskInfo, type TaskManager } from "../core/tasks.ts";
import type { SteeringQueue } from "../core/loop.ts";

export const DEFAULT_WAIT_MS = 60_000;
export const MAX_WAIT_MS = 600_000;

export interface TaskToolOptions {
  /** depth of the loop this tool serves (root = 0); children start at depth + 1 */
  parentDepth?: number;
  /** completion notes for tasks started here (default: the manager's attached queue) */
  notify?: SteeringQueue;
  /** the task id of the child this tool serves (nested); enables slot lending */
  caller?: TaskId;
  /** owner signal for tasks started here (nested: the serving task's own run signal, so
   *  cancelling a task cancels its children). Root tools leave it unset — the manager's
   *  bindRun() signal owns root tasks; ToolContext.signal is NOT usable (loop.ts:91). */
  owner?: AbortSignal;
  /** agent name used when `agent` is omitted */
  defaultAgent?: string;
}

const NOT_POLLING =
  "You will be notified in this conversation when it finishes — do NOT poll or sleep: " +
  "continue other non-overlapping work or end your turn. Use `result` to wait for it when you need its output.";

interface Args {
  action?: unknown; goal?: unknown; agent?: unknown; isolated?: unknown; label?: unknown; id?: unknown; timeout_ms?: unknown;
}

const err = (output: string): ToolOutput => ({ ok: false, output: `Error: ${output}` });

function describe(t: TaskInfo, now: number): string {
  const secs = t.startedAt !== undefined ? Math.max(0, Math.round(((t.finishedAt ?? now) - t.startedAt) / 1000)) : 0;
  const usage = t.usage ? `, tokens ${t.usage.input}in/${t.usage.output}out` : "";
  return `task ${t.id} (${t.label}) ${t.status} — agent ${t.agent}, ${t.isolated ? "isolated, " : ""}${secs}s${usage}`;
}

function renderResult(t: TaskInfo, now: number): ToolOutput {
  const head = describe(t, now);
  if (t.status === "done") {
    const patch = t.patchLines !== undefined ? `\n[isolated: ${t.patchLines === 0 ? "no file changes" : `patch of ${t.patchLines} lines merged back`}]` : "";
    return { ok: true, output: `${head}${patch}\n${t.summary ?? "(no output)"}`, data: t };
  }
  if (t.status === "failed") return { ok: false, output: `${head}\n${t.error ?? "unknown error"}`, data: t };
  if (t.status === "cancelled") return { ok: false, output: head, data: t };
  return { ok: true, output: `${head}. ${NOT_POLLING}`, data: t };
}

function clampInt(v: unknown, min: number, max: number, dflt: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : dflt;
  return Math.min(max, Math.max(min, n));
}

export function createTaskTool(tasks: TaskManager, opts: TaskToolOptions = {}): Tool {
  const defaultAgent = opts.defaultAgent ?? "main";
  return {
    schema: {
      name: "task",
      description:
        "Run subagents as background tasks. `start` launches a child agent session on `goal` and returns " +
        "at once with a task id; the child works while you continue, and a note lands in this conversation " +
        "when it finishes (do not poll). `result` waits (bounded) and returns the child's final output; " +
        "`status`/`list` show state; `cancel` aborts a task. Children see only `goal` (write it " +
        `self-contained). At most ${tasks.maxConcurrent} run concurrently; extra starts queue FIFO. ` +
        "`isolated` runs the child in a git worktree copy and merges its file changes back as a patch on success.",
      args: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["start", "status", "result", "cancel", "list"] },
          goal: { type: "string", description: "start: the child's task, self-contained (it has no access to this conversation)" },
          agent: { type: "string", description: `start: agent definition to run (default "${defaultAgent}")` },
          isolated: { type: "boolean", description: "start: run in an isolated worktree copy; file changes merge back as a patch when the task finishes ok" },
          label: { type: "string", description: "start: short label (3-5 words) shown in task lists and completion notes" },
          id: { type: "string", description: "status/result/cancel: task id (e.g. t1)" },
          timeout_ms: { type: "integer", description: `result: max wait in ms (default ${DEFAULT_WAIT_MS}, max ${MAX_WAIT_MS}); 0 = report the current state at once` },
        },
        required: ["action"],
      },
    },
    kind: "spawn",
    sequential: true,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolOutput> {
      const a = (args ?? {}) as Args;
      const now = Date.now();
      const id = typeof a.id === "string" ? a.id.trim() : "";
      const need = (what: string): ToolOutput => err(`task ${what} requires a string \`id\` (see \`list\`)`);
      switch (a.action) {
        case "start": {
          if (typeof a.goal !== "string" || a.goal.trim() === "") return err("task start requires a non-empty string `goal`");
          const agent = typeof a.agent === "string" && a.agent.trim() !== "" ? a.agent.trim() : defaultAgent;
          const r = tasks.start(
            { agent, goal: a.goal, isolated: a.isolated === true, background: true },
            { label: typeof a.label === "string" ? a.label : undefined, parentDepth: opts.parentDepth ?? 0, notify: opts.notify, caller: opts.caller, owner: opts.owner },
          );
          if (!r.ok) return err(`task refused: ${r.reason}`);
          const t = tasks.status(r.id)!;
          const state = t.status === "running" ? "running" : `queued (${tasks.counts().running} running, bound ${tasks.maxConcurrent})`;
          return { ok: true, output: `task ${t.id} (${t.label}) started: ${state}. ${NOT_POLLING}`, data: t };
        }
        case "status": {
          if (id === "") return need("status");
          const t = tasks.status(id);
          return t ? { ok: true, output: describe(t, now), data: t } : err(`unknown task '${id}'`);
        }
        case "result": {
          if (id === "") return need("result");
          if (!tasks.status(id)) return err(`unknown task '${id}'`);
          const timeoutMs = clampInt(a.timeout_ms, 0, MAX_WAIT_MS, DEFAULT_WAIT_MS);
          const t = await tasks.result(id, { timeoutMs, signal: ctx.signal, caller: opts.caller });
          if (!t) return err(`unknown task '${id}'`);
          if (!isTerminal(t.status) && ctx.signal.aborted) return err(`wait for task ${id} aborted`);
          if (!isTerminal(t.status)) return { ok: true, output: `${describe(t, Date.now())} — still running after ${Math.round(timeoutMs / 1000)}s. ${NOT_POLLING}`, data: t };
          return renderResult(t, Date.now());
        }
        case "cancel": {
          if (id === "") return need("cancel");
          const before = tasks.status(id);
          if (!before) return err(`unknown task '${id}'`);
          if (isTerminal(before.status)) return { ok: true, output: `task ${id} already ${before.status}`, data: before };
          const t = tasks.cancel(id)!;
          return { ok: true, output: `task ${t.id} (${t.label}) cancelled`, data: t };
        }
        case "list":
          return { ok: true, output: formatTaskList(tasks.list(), now), data: tasks.counts() };
        default:
          return err(`task requires action start|status|result|cancel|list (got ${JSON.stringify(a.action ?? null)})`);
      }
    },
  };
}
