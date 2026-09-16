/** Lane runner (#47): ONE external CLI process → LaneResult. Spawns through the injected LaneSpawn
 *  (default lanes/process.ts bunLaneSpawn = the executor's tree-kill path), reads stdout line by line,
 *  feeds the adapter's parse(), keeps a bounded log ring (the running preview), reports every event to
 *  the caller, enforces the wall-clock budget, and cancels in the order the CLIs want: SIGINT first for
 *  the ones that finish their turn on it (claude/opencode), the tree kill after a grace — or at once for
 *  the others — then the reader is abandoned after ABORT_GRACE_MS so an orphan holding the pipe cannot
 *  park the job. Every event also folds into the run's counters (lanes/progress.ts) — tool calls, confirmed
 *  file writes, usage — which ride along with each onEvent so a surface can show what the lane has DONE
 *  while it is still doing it, not just its last log line. Every timer is cleared on the way out (a pending timer would hold the process; a parked
 *  promise with no timer hangs the Bun runner). A signal that is ALREADY aborted when the runner is called
 *  spawns nothing at all (the job awaited its worktree meanwhile; executor.ts bunRunner's pre-aborted pin).
 *  The verdict: cancelled > timed out > the CLI's own fail/done event > exit-code fallback (≠0 → fail;
 *  0 without a result event → fail, honestly). */

import { ABORT_GRACE_MS } from "../core/executor.ts";
import type { TokenUsage } from "../core/types.ts";
import { addUsage, renderEvent } from "./events.ts";
import { LaneTally, type LaneProgress } from "./progress.ts";
import { bunLaneSpawn, type LaneProcess, type LaneSpawn } from "./process.ts";
import { newParseState, type AgentAdapter, type LaneEvent, type LaneOpts, type LaneResult, type LaneTask } from "./types.ts";

/** rendered event lines kept while a lane runs (the preview + the failure context) */
export const LOG_RING = 200;
/** SIGINT → tree kill grace for interruptFirst adapters (docs/test.md §3.6: dead within 5 s) */
export const INTERRUPT_GRACE_MS = 3_000;

export type KillStep = "interrupt" | "kill" | "abandon";

export interface LaneRunnerDeps {
  spawn?: LaneSpawn;
  /** cancel: the TaskManager's per-task controller */
  signal?: AbortSignal;
  /** every parsed event, with the current log tail (≤3 lines) and the running counters — what the
   *  lane has DONE so far (progress.ts), so a surface can show more than one log line */
  onEvent?: (ev: LaneEvent, tail: readonly string[], progress: LaneProgress) => void;
  graceMs?: number;
  /** the kill choreography, appended as it happens (tests pin the order) */
  steps?: KillStep[];
}

export class LogRing {
  private lines: string[] = [];
  constructor(readonly cap: number) {}
  push(line: string): void {
    this.lines.push(line);
    if (this.lines.length > this.cap) this.lines.splice(0, this.lines.length - this.cap);
  }
  tail(n = this.cap): string[] { return this.lines.slice(-n); }
  get length(): number { return this.lines.length; }
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export async function runExternalLane(adapter: AgentAdapter, task: LaneTask, opts: LaneOpts, deps: LaneRunnerDeps = {}): Promise<LaneResult> {
  // cancelled before the spawn (the job was still creating its worktree): nothing starts — executor.ts:110 idiom
  if (deps.signal?.aborted) return { status: "cancelled", summary: "", error: "cancelled", exitCode: null, log: [], garbage: 0, progress: new LaneTally().snapshot() };
  const cmd = opts.resume && adapter.resume ? adapter.resume(opts.resume, task.goal, opts) : adapter.command(task, opts);
  const ring = new LogRing(LOG_RING);
  const tally = new LaneTally();
  const st = newParseState();
  let proc: LaneProcess;
  try {
    proc = (deps.spawn ?? bunLaneSpawn)(cmd);
  } catch (e) {
    return { status: "failed", summary: "", error: `spawn failed: ${cmd.bin}: ${msg(e)}`, exitCode: null, log: [], garbage: 0, progress: tally.snapshot() };
  }
  let done: Extract<LaneEvent, { kind: "done" }> | undefined, fail: Extract<LaneEvent, { kind: "fail" }> | undefined;
  let usage: TokenUsage | undefined;
  let timedOut = false, cancelled = false, stopping = false;
  // every timer lands here and is cleared in finally — so a SIGINT that ends the turn inside the grace
  // (the runner returns) never fires the pending kill, and no timer outlives the lane
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const later = (fn: () => void, ms: number): void => {
    const t = setTimeout(() => { timers.delete(t); fn(); }, ms);
    timers.add(t);
  };
  const step = (s: KillStep): void => { deps.steps?.push(s); };
  const killNow = (): void => {
    step("kill"); proc.kill();
    later(() => { step("abandon"); proc.abandon(); }, ABORT_GRACE_MS);
  };
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    if (adapter.interruptFirst && proc.interrupt()) { step("interrupt"); later(killNow, deps.graceMs ?? INTERRUPT_GRACE_MS); }
    else killNow();
  };
  const onAbort = (): void => { cancelled = true; stop(); };
  try {
    deps.signal?.addEventListener("abort", onAbort, { once: true }); // not aborted: checked above, and the spawn is synchronous
    later(() => { timedOut = true; stop(); }, Math.max(0, opts.timeoutMs));
    for await (const raw of proc.lines()) {
      const line = raw.trimEnd();
      if (!line) continue;
      let events: LaneEvent[];
      try { events = adapter.parse(line, st); } catch { st.garbage++; continue; }
      for (const ev of events) {
        ring.push(renderEvent(ev));
        tally.add(ev); // the counters and the log line come off the SAME event — nothing is parsed twice
        if (ev.kind === "done") done = ev;
        else if (ev.kind === "fail") fail = ev;
        else if (ev.kind === "usage") usage = addUsage(usage, ev.usage);
        deps.onEvent?.(ev, ring.tail(3), tally.snapshot());
      }
    }
    // EOF: the process is gone or about to be — never wait on it unbounded (an abandoned pipe may
    // belong to a launcher that is still alive)
    let waitTimer: ReturnType<typeof setTimeout> | undefined;
    const code = await Promise.race([proc.exited, new Promise<null>((r) => { waitTimer = setTimeout(() => r(null), ABORT_GRACE_MS); })]);
    clearTimeout(waitTimer);
    const sessionId = done?.sessionId ?? fail?.sessionId ?? st.sessionId;
    const base = { exitCode: code, log: ring.tail(), garbage: st.garbage, progress: tally.snapshot(), ...(usage ? { usage } : {}), ...(sessionId ? { sessionId } : {}) };
    if (cancelled) return { ...base, status: "cancelled", summary: "", error: "cancelled" };
    if (timedOut) return { ...base, status: "failed", summary: "", error: `timed out after ${opts.timeoutMs}ms` };
    if (fail) return { ...base, status: "failed", summary: "", error: fail.error };
    if (done) return { ...base, status: "done", summary: done.summary || st.lastText || "" };
    const err = proc.stderrTail();
    if (code !== 0) return { ...base, status: "failed", summary: "", error: `${cmd.bin} exited with code ${code ?? "?"} without a result${err ? `: ${err.slice(-300)}` : ""}` };
    return { ...base, status: "failed", summary: "", error: `${cmd.bin} exited 0 without a result event${err ? `: ${err.slice(-300)}` : ""}` };
  } finally {
    deps.signal?.removeEventListener("abort", onAbort);
    for (const t of timers) clearTimeout(t);
  }
}
