/** Workflow engine (F3, docs/design/sdk-blueprint.md §4).
 *
 *  A workflow is a DAG of steps over the ONE agent loop: an agent step runs through the
 *  runtime's TaskManager (ADR-003/ADR-013 hold — the engine schedules, it never loops), so
 *  every step is visible on the Mission Control agent tree for free. A gate step pauses for
 *  a human answer through the injected askGate.
 *
 *  Durability is "crash-safe, DB'siz": every step transition is appended to
 *  .rovecode/workflows/<runId>.jsonl; resumeWorkflow(runId) reads it and skips finished
 *  steps. Cancellation: the deps signal stops scheduling and cancels running steps; finished
 *  steps stay finished — a resumed run picks up exactly where the killed one left off. */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";import type { TokenUsage } from "../core/types.ts";

// ---------- spec ----------

export interface AgentStep {
  kind: "agent";
  /** TaskManager agent id; default "main" */
  agent?: string;
  goal: string;
  after?: string[];
}

export interface GateStep {
  kind: "gate";
  prompt: string;
  after?: string[];
}

export type WorkflowStep = AgentStep | GateStep;

export interface WorkflowSpec {
  name: string;
  steps: Record<string, WorkflowStep>;
  /** per-step retry; default 1 attempt total (no retry) */
  retry?: { maxAttempts?: number };
  /** run-level ceiling; a run that crosses it stops scheduling and ends "budget" */
  budget?: { maxTokens?: number };
}

/** Identity + validation. A bad spec fails HERE, at definition time, not mid-run. */
export function defineWorkflow(spec: WorkflowSpec): WorkflowSpec {
  if (!spec.name || typeof spec.name !== "string") throw new Error("workflow needs a name");
  const names = Object.keys(spec.steps ?? {});
  if (names.length === 0) throw new Error("workflow needs at least one step");
  for (const [name, step] of Object.entries(spec.steps)) {
    if (step.kind !== "agent" && step.kind !== "gate") throw new Error(`step '${name}': kind must be "agent" | "gate"`);
    if (step.kind === "agent" && (typeof step.goal !== "string" || step.goal.trim() === "")) throw new Error(`step '${name}': agent step needs a goal`);
    for (const dep of step.after ?? []) {
      if (!(dep in spec.steps)) throw new Error(`step '${name}': unknown dependency '${dep}'`);
      if (dep === name) throw new Error(`step '${name}': cannot depend on itself`);
    }
  }
  // cycle check, iterative DFS over `after` edges
  const color = new Map<string, 0 | 1 | 2>(); // 0 white, 1 grey, 2 black
  const visit = (n: string, stack: string[]): void => {
    const c = color.get(n) ?? 0;
    if (c === 2) return;
    if (c === 1) throw new Error(`workflow has a cycle: ${[...stack, n].join(" → ")}`);
    color.set(n, 1);
    for (const d of spec.steps[n]!.after ?? []) visit(d, [...stack, n]);
    color.set(n, 2);
  };
  for (const n of names) visit(n, []);
  return spec;
}

// ---------- events / results ----------

export type WorkflowEvent =
  | { type: "workflow_started"; runId: string; name: string; steps: number }
  | { type: "step_started"; runId: string; step: string; attempt: number }
  | { type: "step_done"; runId: string; step: string; summary: string }
  | { type: "step_failed"; runId: string; step: string; error: string; attempt: number }
  | { type: "gate_waiting"; runId: string; step: string; prompt: string }
  | { type: "workflow_done"; runId: string; status: WorkflowStatus };

export type WorkflowStatus = "done" | "failed" | "cancelled" | "budget";

export interface StepOutcome { status: "done" | "failed" | "skipped"; summary?: string; error?: string; attempts: number }

export interface WorkflowResult {
  runId: string;
  status: WorkflowStatus;
  steps: Record<string, StepOutcome>;
  usage: { input: number; output: number };
}

// ---------- executor seam ----------

export interface WorkflowExecutor {
  /** run one agent step to completion; the TaskManager adapter doubles as the
   *  Mission Control feed (the step appears in the agent tree while it runs) */
  runAgent(step: AgentStep & { name: string }): Promise<{ ok: boolean; summary: string; usage?: TokenUsage }>;
  /** a gate's question; false = rejected, the workflow fails that step */
  askGate(prompt: string): Promise<boolean>;
  /** cancel a running step (engine shutdown) */
  cancelAgent?(name: string): void;
}

export interface RunWorkflowOptions {
  runId?: string;
  signal?: AbortSignal;
  maxConcurrency?: number;
  /** checkpoint file; default <cwd>/.rovecode/workflows/<runId>.jsonl */
  dir?: string;
  emit?: (e: WorkflowEvent) => void;
}

// ---------- checkpoint ----------

interface CkLine { v: 1; type: "step"; step: string; status: "done" | "failed"; summary?: string; error?: string }

function checkpointPath(dir: string, runId: string): string { return join(dir, `${runId}.jsonl`); }

/** step names the checkpoint records as done — resume skips exactly these */
export function readCheckpoint(path: string): Map<string, string> {
  const done = new Map<string, string>();
  if (!existsSync(path)) return done;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      const l = JSON.parse(line) as CkLine;
      if (l.type === "step" && l.status === "done") done.set(l.step, l.summary ?? "");
    } catch { /* a torn tail line (killed mid-append) is ignored, never fatal */ }
  }
  return done;
}

// ---------- engine ----------

export async function runWorkflow(spec: WorkflowSpec, exec: WorkflowExecutor, opts: RunWorkflowOptions = {}): Promise<WorkflowResult> {
  defineWorkflow(spec); // a hand-built spec gets the same validation
  const runId = opts.runId ?? `wf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const dir = opts.dir ?? join(process.cwd(), ".rovecode", "workflows");
  mkdirSync(dir, { recursive: true });
  const ckPath = checkpointPath(dir, runId);
  const resumed = readCheckpoint(ckPath);
  const emit = (e: WorkflowEvent): void => { opts.emit?.(e); };
  const maxConc = Math.max(1, opts.maxConcurrency ?? 3);
  const maxAttempts = Math.max(1, spec.retry?.maxAttempts ?? 1);
  const maxTokens = spec.budget?.maxTokens;

  const steps = new Map(Object.entries(spec.steps));
  const outcomes: Record<string, StepOutcome> = {};
  const done = new Set<string>();
  const failed = new Set<string>();
  const running = new Set<string>();
  const usage = { input: 0, output: 0 };
  let spent = 0;

  for (const [name, summary] of resumed) {
    done.add(name);
    outcomes[name] = { status: "done", summary, attempts: 0 };
  }

  emit({ type: "workflow_started", runId, name: spec.name, steps: steps.size });

  const depsDone = (s: WorkflowStep): boolean => (s.after ?? []).every((d) => done.has(d));
  const depsFailed = (s: WorkflowStep): boolean => (s.after ?? []).some((d) => failed.has(d));

  const record = (l: CkLine): void => {
    try { appendFileSync(ckPath, JSON.stringify(l) + "\n"); } catch { /* checkpoint is best-effort; the run continues */ }
  };

  const runStep = async (name: string, step: WorkflowStep): Promise<void> => {
    running.add(name);
    try {
      if (step.kind === "gate") {
        emit({ type: "gate_waiting", runId, step: name, prompt: step.prompt });
        const yes = opts.signal?.aborted ? false : await exec.askGate(step.prompt);
        if (yes) {
          done.add(name); outcomes[name] = { status: "done", summary: "approved", attempts: 1 };
          record({ v: 1, type: "step", step: name, status: "done", summary: "approved" });
          emit({ type: "step_done", runId, step: name, summary: "approved" });
        } else {
          failed.add(name); outcomes[name] = { status: "failed", error: "gate rejected", attempts: 1 };
          emit({ type: "step_failed", runId, step: name, error: "gate rejected", attempt: 1 });
        }
        return;
      }
      let attempt = 0;
      let lastErr = "unknown";
      while (attempt < maxAttempts) {
        attempt++;
        if (opts.signal?.aborted) { exec.cancelAgent?.(name); failed.add(name); outcomes[name] = { status: "failed", error: "cancelled", attempts: attempt }; return; }
        emit({ type: "step_started", runId, step: name, attempt });
        const r = await exec.runAgent({ ...step, name });
        if (r.usage) { usage.input += r.usage.input; usage.output += r.usage.output; spent += r.usage.input + r.usage.output; }
        if (r.ok) {
          done.add(name); outcomes[name] = { status: "done", summary: r.summary, attempts: attempt };
          record({ v: 1, type: "step", step: name, status: "done", summary: r.summary });
          emit({ type: "step_done", runId, step: name, summary: r.summary });
          return;
        }
        lastErr = r.summary;
        emit({ type: "step_failed", runId, step: name, error: r.summary, attempt });
      }
      failed.add(name); outcomes[name] = { status: "failed", error: lastErr, attempts: attempt };
      record({ v: 1, type: "step", step: name, status: "failed", error: lastErr });
    } finally {
      running.delete(name);
    }
  };

  // scheduler loop: launch every dep-satisfied step up to the concurrency bound,
  // until nothing can start and nothing runs
  const inFlight = new Set<Promise<void>>();
  let status: WorkflowStatus = "done";
  for (;;) {
    if (opts.signal?.aborted) status = "cancelled";
    if (maxTokens !== undefined && spent >= maxTokens) status = "budget";
    const terminal = status !== "done";
    let launched = false;
    if (!terminal && failed.size === 0) {
      for (const [name, step] of steps) {
        if (done.has(name) || failed.has(name) || running.has(name) || outcomes[name] !== undefined) continue;
        if (!depsDone(step)) continue;
        if (running.size >= maxConc) break;
        const p = runStep(name, step);
        inFlight.add(p);
        void p.finally(() => inFlight.delete(p));
        launched = true;
      }
    }
    if (failed.size > 0) {
      // fail-fast: mark never-launched dependents skipped, let in-flight finish
      for (const [name, step] of steps) {
        if (outcomes[name] === undefined && !running.has(name) && (depsFailed(step) || !depsDone(step))) {
          if ((step.after ?? []).length > 0) { outcomes[name] = { status: "skipped", error: "upstream failed", attempts: 0 }; }
        }
      }
    }
    if (inFlight.size === 0) {
      if (!launched) break;
    } else {
      await Promise.race(inFlight);
    }
  }

  for (const [name] of steps) {
    if (outcomes[name] === undefined) outcomes[name] = { status: "skipped", error: status === "done" ? "dependency failed" : status, attempts: 0 };
  }
  if (failed.size > 0 && status === "done") status = "failed";
  emit({ type: "workflow_done", runId, status });
  return { runId, status, steps: outcomes, usage };
}

/** Resume: point at the same dir/runId — checkpointed steps are skipped, the rest run. */
export async function resumeWorkflow(runId: string, spec: WorkflowSpec, exec: WorkflowExecutor, opts: Omit<RunWorkflowOptions, "runId"> = {}): Promise<WorkflowResult> {
  return runWorkflow(spec, exec, { ...opts, runId });
}

/** Known workflow runs in a dir (for `rovecode workflow list`): each checkpoint file
 *  with the steps it records as done. A torn tail line is ignored (readCheckpoint). */
export function listWorkflowRuns(dir: string): { runId: string; done: string[] }[] {
  if (!existsSync(dir)) return [];
  let files: string[] = [];
  try { files = readdirSync(dir); } catch { return []; }
  return files
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => ({ runId: f.slice(0, -".jsonl".length), done: [...readCheckpoint(join(dir, f)).keys()] }))
    .sort((a, b) => a.runId.localeCompare(b.runId));
}
