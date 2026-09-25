/** Background subagents as jobs (port #26): a bounded FIFO job manager over the ONE
 *  agent loop. Every task runs through orchestrator.ts runChild (ADR-009), which runs
 *  agentLoop (ADR-003) — this file only schedules, collects results and notifies. It is
 *  NOT a second loop generation (research/anti_patterns.md:13; ADR-013 rejects lanes
 *  that are not child sessions/jobs).
 *
 *  Port #47: an external agentic-CLI lane (claude / codex / opencode / agy) is a JOB HERE TOO, not a
 *  second engine — TaskInfo.kind "external", run by lanes/job.ts in its own worktree, gated by
 *  ROVECODE_LANES_ALLOW, settling through the same finish() as every child. The reason it is worth
 *  saying twice: a nested coding CLI already ran fine through the bash tool, but it ran INVISIBLY —
 *  the approval card could not name it, the directory it worked in, or the account it billed. Made a
 *  job, it inherits all three from machinery that already exists.
 *
 *  BATCHES: bindRun() is called exactly once per run by every surface, so "started under the same
 *  run" is a grouping already present in the data — TaskInfo.batch is stamped there and a crew of
 *  agents settles into ONE note instead of N (noteFor → batchNote). Nothing here guesses at a group:
 *  a time bucket or a shared label prefix would put two unrelated runs a second apart in one card.
 *  The summary exists for the part of a finished crew nobody can reconstruct — two agents that wrote
 *  the SAME file, named with the path, from the patches that were merged back — and it leads with a
 *  failure rather than footnoting one under a count of successes.
 *
 *  Pattern source: opencode packages/core/src/background-job.ts (MIT, snapshot
 *  research/source_snapshots/opencode-2026 @ ebece6e) — a process-local, deliberately
 *  non-durable job registry (:113-119); Status running|completed|error|cancelled (:7);
 *  Info {id,type,title,status,started_at,completed_at,output,error} (:9-19); start forks
 *  the run and settle() derives the terminal status from the exit (:126-171, :202-254);
 *  wait with an optional timeout returns the snapshot on timeout (:292-301); cancel marks
 *  the job and closes its scope (:337-358). Its task tool (packages/opencode/src/tool/
 *  task.ts) injects a synthetic message into the PARENT session when the job settles
 *  (:227-265 inject/notify) and tells the model not to poll (:31-35).
 *  Departures: opencode starts every job at once (no bound); here a FIFO queue bounds
 *  concurrency (default 3, env ROVECODE_TASKS_MAX) and a RUNNING task that waits on a QUEUED
 *  one lends it its slot so nested pools cannot deadlock. Their notification is a new
 *  prompt on the parent session; ours is a push into the parent's SteeringQueue, which
 *  the loop drains before its next model call (loop.ts:136) — the loop stays untouched. */

import { SteeringQueue } from "./loop.ts";
import { DEFAULT_MAX_DEPTH, preflightSpawn, runChild, type ChildRunnerDeps } from "./orchestrator.ts";
import type { SpawnRequest, SpawnResult, TokenUsage } from "./types.ts";
import { isAdapterId, lanePermissions, laneRefusal, runLaneJob, type AdapterId, type LaneJobDeps, type LaneJobResult } from "../lanes/job.ts";
// ONE patch parser and ONE progress shape for the whole codebase: the lane runner already folds
// counters and reads file lists out of a diff, and a second reading of the same patch here is a
// second thing to keep true.
import { filesFromPatch, type LaneProgress } from "../lanes/progress.ts";
// the card's own sentence, so what a lane is ANNOUNCED with cannot drift from the flags it got
import { laneStartNote } from "../lanes/registry.ts";

export type TaskId = string;
export type TaskStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface TaskInfo {
  id: TaskId;
  label: string;
  agent: string;
  /** bounded preview of the goal (≤200 chars) */
  goal: string;
  isolated: boolean;
  /** the child's depth (parent depth + 1; root-started tasks run at 1) */
  depth: number;
  /** the RUNNING task that started this one (StartOptions.caller); absent for
   *  root-started tasks — the sdk/dashboard agent tree hangs on this edge */
  parent?: TaskId;
  status: TaskStatus;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  /** the child's final text (done) — bounded by runChild (≤4000 chars) */
  summary?: string;
  /** failure reason (failed) or "cancelled" */
  error?: string;
  usage?: TokenUsage;
  /** isolated children: line count of the patch merged back into the parent tree */
  patchLines?: number;
  /** #47: "external" when this task is an agentic-CLI lane rather than one of our own agents */
  kind?: "agent" | "external";
  /** #47: the adapter id of an external lane (claude / codex / opencode / agy) */
  lane?: AdapterId;
  /** #47: what the lane was permitted to do, in the same words the approval card used */
  permissions?: string;
  /** #47: the lane CLI's own exit code. Three states, deliberately: a number is what the CLI returned,
   *  `null` is a lane that ended without one (killed, or the process never reported), and absent means
   *  this task is not a lane at all. Collapsing null into absent would make "we could not read it" look
   *  identical to "there was nothing to read". */
  laneExit?: number | null;
  /** #47: the model the lane actually ran with, when the CLI reported one */
  laneModel?: string;
  /** #47: the lane CLI's own session id, for anyone who wants to resume it in that CLI */
  laneSession?: string;
  /** the run this task was started under, stamped from bindRun(): everything started under one
   *  run is ONE batch. The run is the only grouping already in the data — a time bucket or a
   *  shared label prefix would guess, and two unrelated runs a second apart would read as one
   *  piece of work. Absent for a task started before any run was bound. */
  batch?: string;
  /** that run's own label (one line, ≤60 chars — bounded HERE, not by whatever draws it) */
  batchLabel?: string;
  /** what the task has DONE, folded by the runner (lanes/progress.ts): tool calls, confirmed writes,
   *  usage. ABSENT until a runner reports something — an unreported lane must not read as `0 calls`,
   *  which is why this is never defaulted to an empty tally here (its own `usage` keeps the same rule
   *  one level down). Set live while running, replaced at finish by the measured list. */
  progress?: LaneProgress;
  /** repo-relative paths this task changed in the PARENT tree, from its merged patch — the diff is
   *  the tree, so this is measured rather than claimed. Set only when the patch was merged back: a
   *  failed or cancelled child's patch is returned and never applied (orchestrator.ts:185), so it
   *  changed nothing here and cannot collide with anything — and neither did one whose `git apply` was
   *  REJECTED, which is a different thing from failing and is why this is not `patchLines !== undefined`.
   *  Capped like progress.filesWritten. */
  files?: readonly string[];
}

export interface StartOptions {
  label?: string;
  /** depth of the loop starting this task (root = 0); the child runs at depth + 1,
   *  mirroring the loop's own ctx.spawn contract (loop.ts:267) */
  parentDepth?: number;
  /** where the completion note lands; default = the queue attached to the manager */
  notify?: SteeringQueue;
  /** id of the RUNNING task that starts this one (nested) — enables slot lending */
  caller?: TaskId;
  /** the run that OWNS this task: its abort cancels the task (nested: the parent task's
   *  own signal, so cancellation cascades). Default = the signal bound via bindRun(). */
  owner?: AbortSignal;
  /** the WORKING TREE of the loop starting this task (ChildContext.dir → tools/task.ts parentDir).
   *  An external lane builds its worktree from here and merges its patch back here, so a lane
   *  started by an ISOLATED child must be given the child's own tree: with the top-level root it
   *  would diff and patch the user's live repo, and the child's own patch would not show that it
   *  had. Unset = deps.rootDir, which is the truth for a root start and what every existing caller
   *  relies on. */
  parentDir?: string;
  /** the tool names of the registry the STARTING tool serves (nested `task` from a restricted agent) → the child's
   *  ChildContext.parentTools, so a definition's allow-list is transitive (core/agents.ts restrictTools clamps to it) */
  parentTools?: ReadonlySet<string>;
}

/** `childPolicy` (fix-wave MED-2): how the child's rules derive from the starting run's —
 *  "gated" when that config carries a prompt rule (children turn prompt→deny, orchestrator
 *  deriveChildRules: read-only unless allow rules cover an action), "open" otherwise (yolo).
 *  The `task` tool's start output says so, for the approver and the model. */
export type StartResult = { ok: true; id: TaskId; childPolicy: "gated" | "open" } | { ok: false; reason: string };

export interface WaitOptions {
  /** max wait in ms; undefined = until settled (hold an abort signal); 0 = snapshot now */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** the running task doing the waiting — its slot is lent to a queued waited-on task */
  caller?: TaskId;
}

export interface TaskManagerOptions {
  /** child runner deps, resolved at EACH start so defs/config follow the parent's
   *  latest run; null = no provider configured (start refuses) */
  deps: () => ChildRunnerDeps | null;
  /** concurrent children bound; default tasksMaxFromEnv() */
  maxConcurrent?: number;
  maxDepth?: number;
  /** injectable child runner (tests); default orchestrator runChild */
  run?: typeof runChild;
  /** #47: what an external lane needs to run — env for the knobs, spawn seam for tests; {} = defaults */
  lanes?: LaneJobDeps;
}

export const DEFAULT_TASKS_MAX = 3;

/** ROVECODE_TASKS_MAX: positive integer, else the default. */
export function tasksMaxFromEnv(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env["ROVECODE_TASKS_MAX"] ?? "");
  return Number.isInteger(n) && n >= 1 ? n : DEFAULT_TASKS_MAX;
}

interface TaskRecord {
  info: TaskInfo;
  req: SpawnRequest;
  deps: ChildRunnerDeps;
  ac: AbortController;
  notify?: SteeringQueue;
  done: Promise<void>;
  resolveDone: () => void;
  /** true once the child run has RETURNED (status alone is not enough: cancel() flips
   *  status to "cancelled" while the aborted run is still winding down) */
  settled: boolean;
  /** true once this task's outcome has gone out in a note — its own, or a batch summary that
   *  covered it. Keeps a second summary for the same batch (a run that starts more tasks after
   *  the first group settled) from repeating agents already reported. */
  reported: boolean;
  /** detach the owner-abort listener (settle) */
  unbind?: () => void;
  /** #47: set when this record is an external lane rather than a child agent */
  lane?: AdapterId;
  /** the starting loop's working tree (StartOptions.parentDir); a lane runs and merges back HERE */
  parentDir?: string;
}

const TERMINAL: ReadonlySet<TaskStatus> = new Set(["done", "failed", "cancelled"]);
export const isTerminal = (s: TaskStatus): boolean => TERMINAL.has(s);

function brief(text: string | undefined, max = 200): string {
  const one = (text ?? "").split("\n").find((l) => l.trim() !== "")?.trim() ?? "";
  return one.length > max ? one.slice(0, max - 1) + "…" : one || "(no output)";
}

/** The steer the parent sees on its next turn (opencode task.ts:241-249 renders a
 *  <task state> block; ours is one line the model can act on). */
export function taskNote(t: TaskInfo): string {
  const head = `task ${t.id} (${t.label})`;
  if (t.status === "done") return `${head} finished: ${brief(t.summary)} — call task_status result ${t.id} for details`;
  if (t.status === "failed") return `${head} failed: ${brief(t.error)} — call task_status result ${t.id} for details`;
  return `${head} cancelled`;
}

/** One line per task for /tasks and the tool's list action; newest last, ≤50 rows. */
export function formatTaskList(tasks: TaskInfo[], now = Date.now()): string {
  if (tasks.length === 0) return "(no background tasks)";
  const rows = tasks.slice(-50).map((t) => {
    const end = t.finishedAt ?? now;
    const age = t.startedAt !== undefined ? ` ${Math.max(0, Math.round((end - t.startedAt) / 1000))}s` : "";
    const tail = t.status === "failed" ? ` — ${brief(t.error, 80)}` : t.status === "done" ? ` — ${brief(t.summary, 80)}` : "";
    return `${t.id.padEnd(4)} ${t.status.padEnd(9)}${age.padEnd(6)} ${t.label}${tail}`;
  });
  return (tasks.length > 50 ? `(showing 50 of ${tasks.length})\n` : "") + rows.join("\n");
}

/** bindRun's label bound: one line, clipped here so no surface has to. */
export const BATCH_LABEL_MAX = 60;

function oneLine(s: string | undefined, max: number): string {
  const one = (s ?? "").replace(/\s+/g, " ").trim();
  return one.length > max ? one.slice(0, max - 1) + "…" : one;
}

/** Two tasks of one batch that changed the SAME file in the parent tree. */
export interface BatchCollision {
  path: string;
  tasks: TaskId[];
}

export interface BatchSummary {
  batch: string;
  label?: string;
  /** the batch's tasks, in start order */
  tasks: TaskInfo[];
  done: number;
  failed: number;
  cancelled: number;
  /** every file more than one task wrote, path first — the one thing nobody can work out
   *  from a note that just counts finished agents */
  collisions: BatchCollision[];
}

const andList = (xs: string[]): string =>
  xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;

/** `tasks` are the ones this summary REPORTS; `peers` is the whole batch it belongs to, which is
 *  wider when part of the batch has already been reported (a run that started one agent, waited, then
 *  started two more). Collisions are looked for across the whole batch and kept when they involve
 *  someone in this group — an overlap with an agent announced ten minutes ago is still an overlap,
 *  and reporting only within the group is how it would go unsaid. */
export function summariseBatch(tasks: TaskInfo[], peers: TaskInfo[] = tasks): BatchSummary {
  const mine = new Set(tasks.map((t) => t.id));
  const writers = new Map<string, TaskId[]>();
  for (const t of peers) {
    for (const f of t.files ?? []) writers.set(f, [...(writers.get(f) ?? []), t.id]);
  }
  const collisions = [...writers]
    .filter(([, ids]) => ids.length > 1 && ids.some((id) => mine.has(id)))
    .map(([path, ids]) => ({ path, tasks: ids }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const count = (s: TaskStatus): number => tasks.reduce((n, t) => n + (t.status === s ? 1 : 0), 0);
  const label = tasks.find((t) => t.batchLabel !== undefined)?.batchLabel;
  return {
    batch: tasks[0]?.batch ?? "",
    ...(label !== undefined ? { label } : {}),
    tasks, done: count("done"), failed: count("failed"), cancelled: count("cancelled"),
    collisions,
  };
}

/** ONE steer for a whole batch, in place of one note per agent. Two rules it exists to keep:
 *  a batch with a failure says so in its FIRST words (a failed agent is not a footnote on a
 *  success), and a file two agents both wrote is named, with its path, above the per-agent
 *  rows — it is the only part of this a person cannot reconstruct from the diff themselves. */
export function batchNote(s: BatchSummary): string {
  const parts: string[] = [];
  if (s.failed > 0) parts.push(`${s.failed} FAILED`);
  if (s.cancelled > 0) parts.push(`${s.cancelled} cancelled`);
  if (s.done > 0) parts.push(`${s.done} done`);
  const n = s.tasks.length;
  const head = `batch ${s.batch}${s.label !== undefined ? ` (${s.label})` : ""}: ${n} agent${n === 1 ? "" : "s"} — ${parts.join(", ")}`;
  const lines = [head];
  for (const c of s.collisions) lines.push(`COLLISION: ${c.path} — ${andList(c.tasks)} both changed this file`);
  for (const t of s.tasks) {
    const secs = t.startedAt !== undefined && t.finishedAt !== undefined
      ? ` ${Math.max(0, Math.round((t.finishedAt - t.startedAt) / 1000))}s` : "";
    const state = t.status === "failed" ? "FAILED" : t.status;
    const files = t.files !== undefined && t.files.length > 0 ? ` [${t.files.length} file${t.files.length === 1 ? "" : "s"}]` : "";
    const what = t.status === "done" ? brief(t.summary, 80) : t.status === "failed" ? brief(t.error, 80) : "";
    lines.push(`  ${t.id} ${t.agent}${secs} ${state}${files}${what !== "" ? ` — ${what}` : ""}`);
  }
  lines.push(`call task_status result <id> for any of them`);
  return lines.join("\n");
}

export class TaskManager {
  readonly maxConcurrent: number;
  readonly maxDepth: number;
  private readonly tasks = new Map<TaskId, TaskRecord>();
  private readonly queue: TaskId[] = [];
  private readonly listeners = new Set<(t: TaskInfo) => void>();
  private readonly run: typeof runChild;
  private sink: SteeringQueue | null = null;
  private runSignal: AbortSignal | null = null;
  private batch: { id: string; label?: string } | null = null;
  private running = 0;
  private seq = 0;
  private runSeq = 0;

  constructor(private readonly opts: TaskManagerOptions) {
    this.maxConcurrent = Math.max(1, Math.floor(opts.maxConcurrent ?? tasksMaxFromEnv()));
    // fix-wave L4: runChild re-preflights against the orchestrator's DEFAULT_MAX_DEPTH, so a
    // LARGER manager cap would launch a child only to fail it there — clamp, and every depth
    // refusal is start() data. Smaller caps are honored as given.
    this.maxDepth = Math.min(opts.maxDepth ?? DEFAULT_MAX_DEPTH, DEFAULT_MAX_DEPTH);
    this.run = opts.run ?? runChild;
  }

  /** #47: the lane deps, defaulted — a manager built without them still refuses every lane, because
   *  the allow-list is read from the environment and an unset list allows nothing. */
  private get lanes(): LaneJobDeps { return this.opts.lanes ?? {}; }

  /** Default notification target: the SAME SteeringQueue the surface hands to agentLoop. */
  attach(steering: SteeringQueue): void { this.sink = steering; }

  /** The surface's per-run controller signal (the one Esc / DELETE / session-cancel
   *  aborts): root tasks started from now on are owned by that run and cancelled when it
   *  aborts. NOT ToolContext.signal — the loop's own controller aborts on EVERY settle,
   *  a normal run end included (loop.ts:91), which would kill background work the moment
   *  the parent finishes its turn. Call before each agentLoop; tasks from earlier runs
   *  keep their own owner.
   *
   *  It is also the BATCH seam: every task started under this run carries the same
   *  TaskInfo.batch, because "started under the same run" is the only grouping the data
   *  already has (all four surfaces call this exactly once per run). `batch.id` defaults to
   *  a counter, so a caller that passes nothing still gets one distinct batch per run rather
   *  than every run sharing an empty group; the label is one-lined and clipped HERE. */
  bindRun(signal: AbortSignal, batch?: { id?: string; label?: string }): void {
    this.runSignal = signal;
    const label = oneLine(batch?.label, BATCH_LABEL_MAX);
    this.batch = { id: batch?.id?.trim() || `r${++this.runSeq}`, ...(label !== "" ? { label } : {}) };
  }

  /** Enqueue a child run. Refusals are data, never throws: unknown agent, no provider,
   *  an already-aborted owner, and the orchestrator's own preflight (depth cap, spawn
   *  policy "none"). */
  start(req: SpawnRequest, opts: StartOptions = {}): StartResult {
    const deps = this.opts.deps();
    if (!deps) return { ok: false, reason: "no provider configured" };
    // #47: the four adapter ids are RESERVED — `task start claude` is an external lane, never an agent
    // definition that happens to share the name. The allow-list gate refuses here, before any record
    // exists, so a refused lane leaves nothing behind to explain: no task row, no worktree, no process.
    const lane = isAdapterId(req.agent) ? req.agent : null;
    const refused = lane ? laneRefusal(lane, this.lanes.env) : null;
    if (refused) return { ok: false, reason: refused };
    const def = lane ? { name: lane, systemPrompt: "", tools: [] } : deps.defs.get(req.agent);
    if (!def) return { ok: false, reason: `unknown agent '${req.agent}'` };
    const owner = opts.owner ?? this.runSignal ?? undefined;
    if (owner?.aborted) return { ok: false, reason: "parent run aborted" };
    const depth = (opts.parentDepth ?? 0) + 1;
    const gate = preflightSpawn(def, { depth, maxDepth: this.maxDepth, parentSessionId: opts.caller ?? "" });
    if (!gate.ok) return { ok: false, reason: gate.reason ?? "spawn refused" };
    const childPolicy = deps.baseConfig.permissionRules.some((r) => r.effect === "prompt") ? "gated" : "open";
    const id: TaskId = `t${++this.seq}`;
    let resolveDone: () => void = () => {};
    const done = new Promise<void>((r) => { resolveDone = r; });
    const goal = req.goal.replace(/\s+/g, " ").trim();
    // a NESTED task belongs to its CALLER's batch, not to whatever run is bound now: a long task
    // that spawns a child after the next run has been bound would otherwise land in a batch it has
    // nothing to do with. A caller without a batch falls back to the current run.
    const inherited = opts.caller !== undefined ? this.tasks.get(opts.caller)?.info : undefined;
    const batch = inherited?.batch !== undefined
      ? { id: inherited.batch, ...(inherited.batchLabel !== undefined ? { label: inherited.batchLabel } : {}) }
      : this.batch;
    const rec: TaskRecord = {
      info: {
        id, label: (opts.label ?? "").trim() || (goal.length > 40 ? goal.slice(0, 39) + "…" : goal || "(no goal)"),
        agent: req.agent, goal: goal.length > 200 ? goal.slice(0, 199) + "…" : goal,
        // a lane is ALWAYS isolated: it works in its own worktree and its diff comes back as a patch
        isolated: lane !== null || req.isolated === true, depth, status: "queued", createdAt: Date.now(),
        ...(opts.caller !== undefined ? { parent: opts.caller } : {}),
        ...(lane ? { kind: "external" as const, permissions: lanePermissions(lane, this.lanes.env) } : {}),
        ...(batch ? { batch: batch.id, ...(batch.label !== undefined ? { batchLabel: batch.label } : {}) } : {}),
      },
      req: opts.parentTools ? { ...req, parentTools: opts.parentTools } : req,
      deps, ...(lane ? { lane } : {}), ...(opts.parentDir !== undefined ? { parentDir: opts.parentDir } : {}),
      ac: new AbortController(), notify: opts.notify, done, resolveDone,
      settled: false, reported: false,
    };
    if (owner) {
      // a parent-run abort reaches its children: cancel() aborts the child's own controller
      const onAbort = (): void => { this.cancel(id); };
      owner.addEventListener("abort", onAbort, { once: true });
      rec.unbind = () => owner.removeEventListener("abort", onAbort);
    }
    this.tasks.set(id, rec);
    this.queue.push(id);
    this.emit(rec);
    this.pump();
    return { ok: true, id, childPolicy };
  }

  status(id: TaskId): TaskInfo | undefined {
    const t = this.tasks.get(id);
    return t ? { ...t.info } : undefined;
  }

  /** All tasks, oldest first. */
  list(): TaskInfo[] { return [...this.tasks.values()].map((t) => ({ ...t.info })); }

  counts(): Record<TaskStatus, number> {
    const c: Record<TaskStatus, number> = { queued: 0, running: 0, done: 0, failed: 0, cancelled: 0 };
    for (const t of this.tasks.values()) c[t.info.status]++;
    return c;
  }

  /** Wait for a task to settle (bounded/abortable), then return its snapshot — on a
   *  timeout or abort the snapshot still reports the live status. A cancelled task is
   *  "settled" only once its aborted run has returned. Unknown id → undefined. */
  async result(id: TaskId, opts: WaitOptions = {}): Promise<TaskInfo | undefined> {
    const t = this.tasks.get(id);
    if (!t) return undefined;
    if (t.settled) return { ...t.info };
    // slot lending: the waiter holds a slot but generates no load while it waits — under
    // a full pool a parent waiting on its queued child would otherwise sit until the
    // deadline (nested-pool deadlock). Promote the waited-on task now; `running` may
    // exceed the bound by exactly the number of blocked waiters.
    if (t.info.status === "queued" && opts.caller !== undefined && this.tasks.get(opts.caller)?.info.status === "running") {
      this.dequeue(id);
      this.launch(t);
    }
    await waitFor(t.done, opts.timeoutMs, opts.signal);
    return { ...t.info };
  }

  /** Cancel: a queued task never runs; a running one has its child run aborted (the
   *  signal threads runChild → agentLoop → fetch/tools) and settles when it returns.
   *  Returns the snapshot (status already "cancelled"); unknown id → undefined. */
  cancel(id: TaskId): TaskInfo | undefined {
    const t = this.tasks.get(id);
    if (!t) return undefined;
    if (isTerminal(t.info.status)) return { ...t.info };
    if (t.info.status === "queued") {
      this.dequeue(id);
      t.info.status = "cancelled"; t.info.error = "cancelled";
      this.settle(t);
    } else {
      t.info.status = "cancelled"; t.info.error = "cancelled";
      t.ac.abort(); // finish() → settle() runs (one terminal emission) when runChild returns
    }
    return { ...t.info };
  }

  /** Cancel every non-terminal task (surface shutdown); returns how many were live. */
  cancelAll(): number {
    let n = 0;
    for (const t of this.tasks.values()) {
      if (!isTerminal(t.info.status)) { this.cancel(t.info.id); n++; }
    }
    return n;
  }

  /** Resolve when nothing is queued or running (or the deadline passes → false). */
  async drain(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (this.running > 0 || this.queue.length > 0) {
      if (Date.now() >= deadline) return false;
      await new Promise<void>((r) => setTimeout(r, 10));
    }
    return true;
  }

  /** Status-transition listener (TUI live notes, tests). Returns the unsubscribe. */
  subscribe(fn: (t: TaskInfo) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private dequeue(id: TaskId): void {
    const i = this.queue.indexOf(id);
    if (i >= 0) this.queue.splice(i, 1);
  }

  private pump(): void {
    while (this.running < this.maxConcurrent && this.queue.length > 0) {
      const t = this.tasks.get(this.queue.shift()!);
      if (t && t.info.status === "queued") this.launch(t);
    }
  }

  private launch(t: TaskRecord): void {
    t.info.status = "running"; t.info.startedAt = Date.now();
    this.running++;
    this.emit(t);
    // An external CLI is about to work in a real tree. With the lane allow-list on by default there is
    // no approval card left to say so, and under permission=auto there never was one — so the START is
    // stated here, at every permission level, and here is also the only place that knows the lane is
    // RUNNING rather than queued behind the concurrency bound. Once per task: launch() runs once per
    // record. The id is on it because four lanes at a time make an unattributed sentence useless.
    if (t.lane) (t.notify ?? this.sink)?.push(`task ${t.info.id} (${t.info.label}): ${laneStartNote(t.lane, this.lanes.env)}`);
    // the child's registry learns its task id (ChildContext) so a nested `task_status result`
    // can identify its caller for slot lending
    const deps: ChildRunnerDeps = {
      ...t.deps,
      registryFactory: (def, cwd, child) => t.deps.registryFactory(def, cwd, child ? { ...child, taskId: t.info.id } : undefined),
    };
    // #47: an external lane runs its CLI in its own worktree (lanes/job.ts) — same slot, same finish().
    // It is cut from, and merged back into, the tree of the loop that STARTED it: a lane started by an
    // isolated child belongs to that child's worktree, not to the user's live repo.
    const run: Promise<SpawnResult | LaneJobResult> = t.lane
      ? runLaneJob(this.lanes, t.lane, t.req.goal, t.parentDir ?? t.deps.rootDir, t.ac.signal, (preview, counters) => this.progress(t, preview, counters))
      : this.run(deps, t.req, t.info.depth, t.ac.signal);
    void run
      .then((r) => this.finish(t, r), (e: unknown) => this.finish(t, undefined, e))
      .finally(() => { this.running--; this.pump(); });
  }

  /** #47: a running lane's log tail is its live summary preview — finish() replaces it with the result.
   *  A lane can run for minutes with nothing to show otherwise, and a job that shows nothing is one a
   *  person has no way to tell from a job that hung.
   *  The runner's counters ride the same call and are OPTIONAL: a lane that has reported nothing
   *  countable leaves `progress` undefined instead of showing a zeroed tally, because "we have read
   *  nothing yet" and "it has done nothing" are different facts about a running job. */
  private progress(t: TaskRecord, preview: string, counters?: LaneProgress): void {
    if (t.info.status !== "running") return;
    t.info.summary = preview;
    if (counters) {
      t.info.progress = counters;
      if (counters.usage) t.info.usage = counters.usage;
    }
    this.emit(t);
  }

  private finish(t: TaskRecord, r: SpawnResult | LaneJobResult | undefined, err?: unknown): void {
    const info = t.info;
    // #47: a lane's own facts, recorded whatever the outcome — a cancelled lane that already reported
    // its exit code and session id still has both, and they are how anyone resumes it in its own CLI
    if (r && "permissions" in r) {
      if (r.sessionId) info.laneSession = r.sessionId;
      info.laneExit = r.exitCode;
      if (r.model) info.laneModel = r.model;
      // the runner's final tally replaces the live one (its file list is measured from the diff);
      // a refusal carries none, and then the live one — or nothing at all — is what we know
      if (r.progress) info.progress = r.progress;
    }
    if (info.status === "cancelled") {
      if (r) info.usage = r.usage; // the aborted run's own summary ("run aborted") is not a result
    } else if (r === undefined) {
      info.status = "failed";
      info.error = `child runner threw: ${err instanceof Error ? err.message : String(err)}`;
    } else if (!r.ok) {
      info.status = "failed"; info.error = r.summary; info.usage = r.usage;
    } else {
      info.status = "done"; info.summary = r.summary; info.usage = r.usage;
      if (r.patch !== undefined) {
        info.patchLines = r.patch.trim() === "" ? 0 : r.patch.split("\n").length;
        // only a merged-back patch changed the parent tree, and only such a patch can collide with
        // another task's — a failed or cancelled child's is returned but never applied
        // (orchestrator.ts:185). A lane's runner has already measured the same list from the same
        // diff; take it rather than reading the patch twice.
        // …and only when it ACTUALLY LANDED. A rejected `git apply` still leaves ok:true (job.ts:127,
        // orchestrator.ts:192 both only append a marker to the summary), and the patch most likely to be
        // rejected is the SECOND one to touch a file — precisely the case the collision line is about.
        // Claiming those paths would turn the one thing this summary exists to say into the one thing it
        // gets wrong: the task that LOST the race named as a writer of the file it never wrote.
        //
        // Both paths carry the fact as a BOOLEAN, so neither is read out of prose: a lane reports it as
        // progress.applied, a child agent as SpawnResult.applied (set in orchestrator.ts beside the
        // applyPatch call that knows the answer). This used to sniff the marker out of `r.summary`, which
        // over-claimed in one direction nobody expected — the marker is appended and the summary is THEN
        // sliced to 4000 chars, so a child verbose enough to describe its own diff lost the marker and
        // read as applied. Absent means there was no merge-back to attempt at all (no isolation, no
        // patch), and that keeps its old meaning: nothing to apply, so nothing failed.
        const landed = info.progress?.applied ?? r.applied ?? true;
        const files = info.progress?.filesWritten ?? filesFromPatch(r.patch);
        if (landed && files.length > 0) info.files = files;
      }
    }
    this.settle(t);
  }

  /** Terminal tail shared by finish() and queued-cancel: stamp, notify the parent
   *  (steer — queued BEFORE waiters wake, so a `result` waiter's next turn sees it),
   *  release waiters, tell listeners. */
  private settle(t: TaskRecord): void {
    t.settled = true;
    t.unbind?.();
    t.info.finishedAt = Date.now();
    const note = this.noteFor(t);
    if (note !== null) (t.notify ?? this.sink)?.push(note);
    t.resolveDone();
    this.emit(t);
  }

  /** What this settle says, and to whom. A task outside any batch, or the only one of its batch,
   *  pushes its own note exactly as before. When a batch has several tasks the note is held until
   *  the LAST of them settles and then ONE summary goes out for all of them — three agents finishing
   *  used to mean three notes and no statement about whether they had written over each other.
   *
   *  Grouping is by batch AND by notification target: a nested task inherits its caller's batch but
   *  steers the caller's own queue (orchestrator ChildContext), so summarising across queues would
   *  put a child's outcome in a queue that never asked for it and take it away from the one that did. */
  private noteFor(t: TaskRecord): string | null {
    const batch = t.info.batch;
    if (batch === undefined) { t.reported = true; return taskNote(t.info); }
    const q = t.notify ?? this.sink;
    const peers = [...this.tasks.values()].filter((o) => o.info.batch === batch && (o.notify ?? this.sink) === q);
    if (peers.some((o) => !o.settled)) return null; // the batch is still running; t waits for the summary
    const group = peers.filter((o) => !o.reported);
    for (const o of group) o.reported = true;
    const s = summariseBatch(group.map((o) => ({ ...o.info })), peers.map((o) => ({ ...o.info })));
    // one task and nothing to say about it that its own note does not: the old wording, unchanged.
    // A collision is something new to say, so it earns the summary even for a single agent —
    // otherwise a run that started its agents one at a time would never hear about an overlap.
    if (s.tasks.length <= 1 && s.collisions.length === 0) return taskNote(t.info);
    return batchNote(s);
  }

  private emit(t: TaskRecord): void {
    for (const fn of this.listeners) {
      try { fn({ ...t.info }); } catch { /* listeners never break the manager */ }
    }
  }
}

/** Resolve when `p` settles, the deadline passes, or `signal` aborts — whichever is
 *  first; the timer and listener are always released (a pending timer would hold the
 *  process; a parked promise with no timer hangs the Bun runner). */
function waitFor(p: Promise<void>, timeoutMs: number | undefined, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    if (signal?.aborted) { finish(); return; }
    if (timeoutMs !== undefined) timer = setTimeout(finish, Math.max(0, timeoutMs));
    signal?.addEventListener("abort", finish, { once: true });
    void p.then(finish, finish);
  });
}
