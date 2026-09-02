/** Background subagents as jobs (port #26): a bounded FIFO job manager over the ONE
 *  agent loop. Every task runs through orchestrator.ts runChild (ADR-009), which runs
 *  agentLoop (ADR-003) — this file only schedules, collects results and notifies. It is
 *  NOT a second loop generation (research/anti_patterns.md:13; ADR-013 rejects lanes
 *  that are not child sessions/jobs).
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
 *  concurrency (default 3, env AION_TASKS_MAX) and a RUNNING task that waits on a QUEUED
 *  one lends it its slot so nested pools cannot deadlock. Their notification is a new
 *  prompt on the parent session; ours is a push into the parent's SteeringQueue, which
 *  the loop drains before its next model call (loop.ts:136) — the loop stays untouched. */

import { SteeringQueue } from "./loop.ts";
import { DEFAULT_MAX_DEPTH, preflightSpawn, runChild, type ChildRunnerDeps } from "./orchestrator.ts";
import type { SpawnRequest, SpawnResult, TokenUsage } from "./types.ts";

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
}

export const DEFAULT_TASKS_MAX = 3;

/** AION_TASKS_MAX: positive integer, else the default. */
export function tasksMaxFromEnv(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env["AION_TASKS_MAX"] ?? "");
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
  /** detach the owner-abort listener (settle) */
  unbind?: () => void;
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

export class TaskManager {
  readonly maxConcurrent: number;
  readonly maxDepth: number;
  private readonly tasks = new Map<TaskId, TaskRecord>();
  private readonly queue: TaskId[] = [];
  private readonly listeners = new Set<(t: TaskInfo) => void>();
  private readonly run: typeof runChild;
  private sink: SteeringQueue | null = null;
  private runSignal: AbortSignal | null = null;
  private running = 0;
  private seq = 0;

  constructor(private readonly opts: TaskManagerOptions) {
    this.maxConcurrent = Math.max(1, Math.floor(opts.maxConcurrent ?? tasksMaxFromEnv()));
    // fix-wave L4: runChild re-preflights against the orchestrator's DEFAULT_MAX_DEPTH, so a
    // LARGER manager cap would launch a child only to fail it there — clamp, and every depth
    // refusal is start() data. Smaller caps are honored as given.
    this.maxDepth = Math.min(opts.maxDepth ?? DEFAULT_MAX_DEPTH, DEFAULT_MAX_DEPTH);
    this.run = opts.run ?? runChild;
  }

  /** Default notification target: the SAME SteeringQueue the surface hands to agentLoop. */
  attach(steering: SteeringQueue): void { this.sink = steering; }

  /** The surface's per-run controller signal (the one Esc / DELETE / session-cancel
   *  aborts): root tasks started from now on are owned by that run and cancelled when it
   *  aborts. NOT ToolContext.signal — the loop's own controller aborts on EVERY settle,
   *  a normal run end included (loop.ts:91), which would kill background work the moment
   *  the parent finishes its turn. Call before each agentLoop; tasks from earlier runs
   *  keep their own owner. */
  bindRun(signal: AbortSignal): void { this.runSignal = signal; }

  /** Enqueue a child run. Refusals are data, never throws: unknown agent, no provider,
   *  an already-aborted owner, and the orchestrator's own preflight (depth cap, spawn
   *  policy "none"). */
  start(req: SpawnRequest, opts: StartOptions = {}): StartResult {
    const deps = this.opts.deps();
    if (!deps) return { ok: false, reason: "no provider configured" };
    const def = deps.defs.get(req.agent);
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
    const rec: TaskRecord = {
      info: {
        id, label: (opts.label ?? "").trim() || (goal.length > 40 ? goal.slice(0, 39) + "…" : goal || "(no goal)"),
        agent: req.agent, goal: goal.length > 200 ? goal.slice(0, 199) + "…" : goal,
        isolated: req.isolated === true, depth, status: "queued", createdAt: Date.now(),
      },
      req, deps, ac: new AbortController(), notify: opts.notify, done, resolveDone, settled: false,
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
    // the child's registry learns its task id (ChildContext) so a nested `task_status result`
    // can identify its caller for slot lending
    const deps: ChildRunnerDeps = {
      ...t.deps,
      registryFactory: (def, cwd, child) => t.deps.registryFactory(def, cwd, child ? { ...child, taskId: t.info.id } : undefined),
    };
    void this.run(deps, t.req, t.info.depth, t.ac.signal)
      .then((r) => this.finish(t, r), (e: unknown) => this.finish(t, undefined, e))
      .finally(() => { this.running--; this.pump(); });
  }

  private finish(t: TaskRecord, r: SpawnResult | undefined, err?: unknown): void {
    const info = t.info;
    if (info.status === "cancelled") {
      if (r) info.usage = r.usage; // the aborted run's own summary ("run aborted") is not a result
    } else if (r === undefined) {
      info.status = "failed";
      info.error = `child runner threw: ${err instanceof Error ? err.message : String(err)}`;
    } else if (!r.ok) {
      info.status = "failed"; info.error = r.summary; info.usage = r.usage;
    } else {
      info.status = "done"; info.summary = r.summary; info.usage = r.usage;
      if (r.patch !== undefined) info.patchLines = r.patch.trim() === "" ? 0 : r.patch.split("\n").length;
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
    (t.notify ?? this.sink)?.push(taskNote(t.info));
    t.resolveDone();
    this.emit(t);
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
