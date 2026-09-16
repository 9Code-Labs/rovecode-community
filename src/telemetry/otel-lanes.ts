/** Lane spans for the #39 hook set (port #82): every external agentic-CLI lane (core/tasks.ts TaskInfo.kind
 *  "external" — claude / codex / opencode / agy, port #47) that reached `running` yields exactly ONE
 *  `rovecode.lane` span in its OWN trace, built from TaskInfo snapshots alone (TaskManager.subscribe,
 *  tasks.ts:304) and emitted ONCE when the task settles. It is a root span on purpose: TaskInfo carries no
 *  runId, and under `rovecode serve` or concurrent runs the run that started the lane would be a guess — a
 *  span parented to the wrong trace is worse than a separate one (the run's own `rovecode.tool` span for the
 *  `task` call already sits in the run's trace). Child tasks (kind absent) trace themselves through the
 *  runtime's hooks (cli/boot-tasks.ts:97) and are skipped here, never counted twice; a task cancelled while
 *  still queued never ran and yields nothing; a running lane's progress re-emits (tasks.ts:341) open nothing.
 *
 *  start / end are the snapshot's own startedAt / finishedAt (unixNano-equal — not the observer's clock).
 *  Attributes (ids, sizes and outcomes only — never the goal, label, summary, error, log tail or card text):
 *  rovecode.task_id · rovecode.lane (the adapter id) · rovecode.status ∈ done|failed|cancelled · rovecode.depth ·
 *  rovecode.exit_code (int; OMITTED when the runner reported null — abandoned pipe — or the lane was refused
 *  before any spawn) · rovecode.lane.model (only when ROVECODE_LANE_<ID>_MODEL set it) · rovecode.tokens.{input,
 *  output,cacheRead,cacheWrite} (only when the CLI reported usage: lanes/job.ts:87 defaults a silent CLI to
 *  {0,0}, so an all-zero usage is treated as "nothing came back") · rovecode.patch_lines (when the merge-back
 *  measured one) · rovecode.lane.resumable (bool: a CLI session id came back). Status code 1 for done AND
 *  cancelled (the #39 "stopped" rule), 2 / "lane failed" for failed.
 *
 *  Pattern source: pi packages/agent/src/harness/telemetry.ts (MIT @ 853a80d, header credit only — naming/shape
 *  reference, no code copied): `pi.harness.run` as one span per unit of work with outcome + usage attributes
 *  (:235-256) → rovecode.lane; the attribute policy of packages/telemetry/README.md:385-391. */

import { isTerminal, type TaskStatus } from "../core/tasks.ts";
import { hex } from "./otel-export.ts";
import { bool, int, str, type OtelSpan } from "./otlp.ts";

/** The lane seam (#47): the TaskInfo snapshot fields this module reads, and nothing else — a structural
 *  type so TaskManager (core/tasks.ts, whose TaskInfo gains `kind` / `laneExit` / `laneModel` / `laneSession`
 *  with the lanes port) satisfies `LaneSource` with no change here. `kind` other than "external" = a child
 *  agent task, traced through the runtime's hooks and skipped by this observer. */
export interface LaneTaskInfo {
  id: string;
  /** the adapter id of an external lane ("claude" | "codex" | "opencode" | "agy"), or a child agent's name */
  agent: string;
  status: TaskStatus;
  depth: number;
  kind?: "agent" | "external";
  startedAt?: number;
  finishedAt?: number;
  /** the lane CLI's exit code; null = never observed (abandoned pipe); absent = refused before any spawn */
  laneExit?: number | null;
  /** only when ROVECODE_LANE_<ID>_MODEL chose the model */
  laneModel?: string;
  /** only what the CLI reported — an all-zero usage is treated as "nothing came back", never as zero tokens */
  usage?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
  patchLines?: number;
  /** a CLI session id came back (the lane is resumable) */
  laneSession?: string;
}
export interface LaneSource { subscribe(fn: (t: LaneTaskInfo) => void): () => void }

/** subscribe to `tasks`; `emit` receives each finished lane span exactly once; returns the unsubscribe */
export function observeLanes(tasks: LaneSource, emit: (span: OtelSpan) => void, now: () => number = Date.now): () => void {
  const open = new Map<string, OtelSpan>();
  return tasks.subscribe((t) => {
    if (t.kind !== "external") return;
    if (t.status === "running") {
      if (open.has(t.id)) return; // a progress re-emit
      const s: OtelSpan = { traceId: hex(16), spanId: hex(8), name: "rovecode.lane", start: t.startedAt ?? now(), attrs: new Map(), events: [], status: { code: 0 } };
      s.attrs.set("rovecode.task_id", str(t.id)); s.attrs.set("rovecode.lane", str(t.agent)); s.attrs.set("rovecode.depth", int(t.depth));
      open.set(t.id, s);
      return;
    }
    if (!isTerminal(t.status)) return;
    const s = open.get(t.id);
    if (!s) return; // queued → cancelled: it never ran
    open.delete(t.id);
    emit(finishLane(s, t));
  });
}

/** the terminal snapshot's data onto the span (TaskInfo only — nothing derived from text) */
export function finishLane(s: OtelSpan, t: LaneTaskInfo): OtelSpan {
  s.attrs.set("rovecode.status", str(t.status));
  if (typeof t.laneExit === "number") s.attrs.set("rovecode.exit_code", int(t.laneExit));
  if (t.laneModel) s.attrs.set("rovecode.lane.model", str(t.laneModel));
  const u = t.usage;
  if (u && (u.input !== 0 || u.output !== 0 || (u.cacheRead ?? 0) !== 0 || (u.cacheWrite ?? 0) !== 0)) {
    s.attrs.set("rovecode.tokens.input", int(u.input)); s.attrs.set("rovecode.tokens.output", int(u.output));
    s.attrs.set("rovecode.tokens.cacheRead", int(u.cacheRead ?? 0)); s.attrs.set("rovecode.tokens.cacheWrite", int(u.cacheWrite ?? 0));
  }
  if (t.patchLines !== undefined) s.attrs.set("rovecode.patch_lines", int(t.patchLines));
  s.attrs.set("rovecode.lane.resumable", bool(t.laneSession !== undefined && t.laneSession !== ""));
  s.end = t.finishedAt ?? Date.now();
  s.status = t.status === "failed" ? { code: 2, message: "lane failed" } : { code: 1 };
  return s;
}
