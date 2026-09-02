/** `task` + `task_status` tools (port #26): the model's door to background subagents over
 *  core/tasks.ts TaskManager. Children run through orchestrator.ts runChild (the ONE
 *  agentLoop); these tools never run a loop themselves.
 *
 *  Source shape: opencode packages/opencode/src/tool/task.ts (MIT, snapshot
 *  research/source_snapshots/opencode-2026 @ ebece6e) — parameters description/prompt/
 *  subagent_type + background flag (:43-62), "started" text that tells the model NOT to
 *  poll and to keep working or end its turn (:31-35), depth walk refusal (:104-117),
 *  result rendered as a tagged block with the child's final text (:64-79, :341-345).
 *  Departures: TWO tools split by policy class instead of background:true on a foreground
 *  tool — `task` (kind spawn: start|cancel — creating a child, or destroying its work) and
 *  `task_status` (kind read: status|result|list — registry reads; `result` is an explicit
 *  bounded wait). Refusals come from the orchestrator's preflight (depth cap / spawn
 *  policy) as tool output, never exceptions.
 *
 *  Policy: `task` kind "spawn" → action "spawn" (core/tools.ts actionFor): the default gated
 *  rules PROMPT for it (cli/runtime.ts buildCfg) — once per start, since "once" is never
 *  cached — yolo allows, plan mode denies (core/modes.ts); children derive prompt→deny
 *  (orchestrator deriveChildRules), so nested starts exist only under an allow rule.
 *  `task_status` kind "read" → action "file.read", which the gated rules ALLOW: collecting a
 *  result never prompts, headless surfaces (run/serve/acp) and children read it, plan mode
 *  keeps it. Its schema declares no path/command/url, so the policy resource is the tool
 *  NAME and a smuggled `path` cannot re-aim a `deny file.read task_status` rule (tools.ts
 *  describeResource honors declared keys only). Fix-wave MED-2: one action-agnostic
 *  spawn-kind tool prompted for status/result/list too (≥2 prompts per task) and failed
 *  them closed on headless surfaces. */

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

export interface TaskStatusToolOptions {
  /** the task id of the child this tool serves (nested): a `result` wait lends its slot to
   *  the waited-on queued task (TaskManager.result slot lending) */
  caller?: TaskId;
}

const NOT_POLLING =
  "You will be notified in this conversation when it finishes — do NOT poll or sleep: " +
  "continue other non-overlapping work or end your turn. Use `task_status result` to wait for it when you need its output.";
/** one-shot policy (cli/main.ts cmdRun exit): tasks never outlive the process that started them */
const ONE_SHOT =
  "In a one-shot run (`aion run`) background tasks do not outlive the run: collect what you need with " +
  "`task_status result` before ending your turn.";

interface Args {
  action?: unknown; goal?: unknown; agent?: unknown; isolated?: unknown; label?: unknown; id?: unknown; timeout_ms?: unknown;
}

const err = (output: string): ToolOutput => ({ ok: false, output: `Error: ${output}` });
const need = (tool: string, what: string): ToolOutput => err(`${tool} ${what} requires a string \`id\` (see \`task_status list\`)`);

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

/** `timeout_ms`: numbers and numeric strings ("5000" — models quote integers) clamp to
 *  [0, MAX_WAIT_MS]; absent → the default; anything else is a clear error, never a silent
 *  default (fix-wave L6: a quoted "5000" used to become the 60s default). */
function parseTimeout(v: unknown): number | { error: string } {
  if (v === undefined || v === null) return DEFAULT_WAIT_MS;
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return { error: `task_status result: \`timeout_ms\` must be a number of milliseconds (got ${JSON.stringify(v) ?? String(v)})` };
  return Math.min(MAX_WAIT_MS, Math.max(0, Math.floor(n)));
}

/** kind spawn: `start` (a new child) and `cancel` (destroys the child's work) — the two
 *  actions a gated policy should ask about. Reads live on `task_status`. */
export function createTaskTool(tasks: TaskManager, opts: TaskToolOptions = {}): Tool {
  const defaultAgent = opts.defaultAgent ?? "main";
  return {
    schema: {
      name: "task",
      description:
        "Run subagents as background tasks. `start` launches a child agent session on `goal` and returns " +
        "at once with a task id; the child works while you continue, and a note lands in this conversation " +
        "when it finishes (do not poll). Read its state or output with the `task_status` tool (status/result/list " +
        "— never prompts); `cancel` aborts a task. Children see only `goal` (write it self-contained). " +
        `At most ${tasks.maxConcurrent} run concurrently; extra starts queue FIFO. ` +
        "`isolated` runs the child in a git worktree copy and merges its file changes back as a patch on success. " +
        "Policy: under gated rules each `start` needs approval and the child runs read-only (prompt-gated actions " +
        "are denied for children) unless allow rules cover them; under yolo it inherits allow-all. " + ONE_SHOT,
      args: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["start", "cancel"] },
          goal: { type: "string", description: "start: the child's task, self-contained (it has no access to this conversation)" },
          agent: { type: "string", description: `start: agent definition to run (default "${defaultAgent}")` },
          isolated: { type: "boolean", description: "start: run in an isolated worktree copy; file changes merge back as a patch when the task finishes ok" },
          label: { type: "string", description: "start: short label (3-5 words) shown in task lists and completion notes" },
          id: { type: "string", description: "cancel: task id (e.g. t1)" },
        },
        required: ["action"],
      },
    },
    kind: "spawn",
    sequential: true,
    async execute(args: unknown): Promise<ToolOutput> {
      const a = (args ?? {}) as Args;
      const id = typeof a.id === "string" ? a.id.trim() : "";
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
          // the approver/model must know what the child CAN do (deriveChildRules: prompt → deny)
          const policy = r.childPolicy === "gated"
            ? "Policy: gated — the child runs read-only (prompt-gated actions are DENIED for children) unless allow rules cover them."
            : "Policy: the child inherits your allow rules.";
          return { ok: true, output: `task ${t.id} (${t.label}) started: ${state}. ${policy} ${NOT_POLLING}`, data: t };
        }
        case "cancel": {
          if (id === "") return need("task", "cancel");
          const before = tasks.status(id);
          if (!before) return err(`unknown task '${id}'`);
          if (isTerminal(before.status)) return { ok: true, output: `task ${id} already ${before.status}`, data: before };
          const t = tasks.cancel(id)!;
          return { ok: true, output: `task ${t.id} (${t.label}) cancelled`, data: t };
        }
        default:
          return err(`task requires action start|cancel (got ${JSON.stringify(a.action ?? null)}); status|result|list live on task_status`);
      }
    },
  };
}

/** kind read: `status` | `result` (bounded wait, aborts with the run) | `list`. Auto-allowed by
 *  the gated rules (file.read) and plan mode; no path/command/url in the schema, so the policy
 *  resource is always the tool name. */
export function createTaskStatusTool(tasks: TaskManager, opts: TaskStatusToolOptions = {}): Tool {
  return {
    schema: {
      name: "task_status",
      description:
        "Read background tasks started with `task` (never prompts, never mutates). `status` shows one task's " +
        "state; `result` waits (bounded by `timeout_ms`, default 60s) for a task to finish and returns the " +
        "child's final output — call it when you need the output, otherwise wait for the completion note; " +
        "`list` shows every task. " + ONE_SHOT,
      args: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["status", "result", "list"] },
          id: { type: "string", description: "status/result: task id (e.g. t1)" },
          timeout_ms: { type: "integer", description: `result: max wait in ms (default ${DEFAULT_WAIT_MS}, max ${MAX_WAIT_MS}); 0 = report the current state at once` },
        },
        required: ["action"],
      },
    },
    kind: "read",
    sequential: true,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolOutput> {
      const a = (args ?? {}) as Args;
      const now = Date.now();
      const id = typeof a.id === "string" ? a.id.trim() : "";
      switch (a.action) {
        case "status": {
          if (id === "") return need("task_status", "status");
          const t = tasks.status(id);
          return t ? { ok: true, output: describe(t, now), data: t } : err(`unknown task '${id}'`);
        }
        case "result": {
          if (id === "") return need("task_status", "result");
          if (!tasks.status(id)) return err(`unknown task '${id}'`);
          const timeoutMs = parseTimeout(a.timeout_ms);
          if (typeof timeoutMs !== "number") return err(timeoutMs.error);
          const t = await tasks.result(id, { timeoutMs, signal: ctx.signal, caller: opts.caller });
          if (!t) return err(`unknown task '${id}'`);
          if (!isTerminal(t.status) && ctx.signal.aborted) return err(`wait for task ${id} aborted`);
          if (!isTerminal(t.status)) return { ok: true, output: `${describe(t, Date.now())} — still running after ${Math.round(timeoutMs / 1000)}s. ${NOT_POLLING}`, data: t };
          return renderResult(t, Date.now());
        }
        case "list":
          return { ok: true, output: formatTaskList(tasks.list(), now), data: tasks.counts() };
        default:
          return err(`task_status requires action status|result|list (got ${JSON.stringify(a.action ?? null)}); start|cancel live on task`);
      }
    },
  };
}
