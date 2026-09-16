/** Background shell jobs (port #55). `bash … run_in_background: true` starts a job here instead of
 *  awaiting it; `bash_list` / `bash_output` / `bash_kill` (tools/bash-bg.ts) read and stop them.
 *
 *  WHAT A JOB IS NOT. It is not an agent. TaskManager (core/tasks.ts) stays the one agent-job registry
 *  and nothing in this file runs a loop. A job is one shell command whose output the run can come back
 *  to — a dev server, a long build, a test suite that takes four minutes — and the reason it exists is
 *  that the alternative is worse in both directions: a foreground `bash` either blocks the whole run
 *  until the command finishes, or gets killed by a timeout and loses whatever it had printed.
 *
 *  SAME DOOR, SAME LOCKS. Every job runs through the SAME executor seam a foreground `bash` uses, so
 *  the configured rung shapes its argv and `kill` is the rung's own tree kill (Windows Job Object +
 *  taskkill sweep; SIGTERM to the process group on POSIX, #67 — a background `npm run dev` that forks
 *  is exactly the case where killing only the launcher leaves the port bound). Policy is upstream:
 *  the permission rules, execpolicy, hooks and the human approval all run before bashTool.execute, so
 *  starting a job in the background is gated exactly like running it in the foreground. It is the same
 *  tool with a flag, deliberately (ADR-005).
 *
 *  BOUNDS, because an unbounded buffer is a memory leak with a feature name:
 *    MAX_JOBS      running at once; the next start is refused AS DATA, never thrown
 *    RING_CHARS    decoded output kept per job; the oldest is dropped and the drop is COUNTED, and a
 *                  read reports how many UNREAD characters it lost rather than silently skipping them
 *    MAX_READ      one read returns at most this much and says `more` when output remains
 *    KEEP_FINISHED finished jobs stay listed until a read has seen their final output; after that only
 *                  the newest few are kept, buffers trimmed to a tail
 *
 *  A finished job posts ONE note through the mechanisms that already exist: a push into the run's
 *  SteeringQueue (the loop drains it before the next model call, like a task note) and one listener
 *  emission for the TUI's transcript. It does not interrupt a turn and it does not poll.
 *
 *  Pattern source (Apache-2.0, PATTERN LEVEL ONLY, no code copied): google-gemini/gemini-cli @ 0bd1d43
 *  — `is_background` as a flag on the ONE shell tool, list rendering pid/status/command/exit code, a
 *  bounded read that refuses a pid outside the session's own history, and a timed-out result that names
 *  the timeout and keeps its partial output. Departures: a per-job cursor (each read returns only NEW
 *  output) instead of a tail snapshot, an in-memory ring instead of a log file, a hard concurrency
 *  bound, and the kill is the executor's tree-kill path rather than a bare signal. */

import { getExecutor, type SpawnObserver } from "../core/executor.ts";
import type { SteeringQueue } from "../core/loop.ts";

export const MAX_JOBS = 4;
export const RING_CHARS = 200_000;
export const MAX_READ = 10_000;
export const KEEP_FINISHED = 8;

export type JobStatus = "running" | "exited" | "killed" | "failed";

export interface JobInfo {
  id: string;
  command: string;
  status: JobStatus;
  startedAt: number;
  finishedAt?: number;
  /** the launcher's pid, once the process exists */
  pid?: number;
  /** the shell's exit code (exited/failed) */
  exitCode?: number;
  /** characters dropped from the ring because the job outran the buffer */
  dropped: number;
  /** true once a read has seen the job's final output — only then may it be reaped */
  drained: boolean;
}

interface JobRecord {
  info: JobInfo;
  buf: string;
  /** how far a reader has consumed `buf`; each read returns only what is new */
  cursor: number;
  ac: AbortController;
  done: Promise<void>;
}

export interface JobManagerOptions {
  /** where a finish note lands — the same queue the loop drains before its next model call */
  notify?: SteeringQueue;
  /** the run's signal: its abort kills every job, so background work never outlives the session */
  owner?: AbortSignal;
}

export class BashJobManager {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly listeners = new Set<(j: JobInfo) => void>();
  private seq = 0;
  private unbind?: () => void;

  constructor(private readonly opts: JobManagerOptions = {}) {
    const owner = opts.owner;
    if (owner) {
      const onAbort = (): void => { this.killAll(); };
      owner.addEventListener("abort", onAbort, { once: true });
      this.unbind = () => owner.removeEventListener("abort", onAbort);
    }
  }

  /** Status-transition listener (the TUI's transcript note). Returns the unsubscribe. */
  subscribe(fn: (j: JobInfo) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  list(): JobInfo[] { return [...this.jobs.values()].map((j) => ({ ...j.info })); }

  status(id: string): JobInfo | undefined {
    const j = this.jobs.get(id);
    return j ? { ...j.info } : undefined;
  }

  private get running(): number {
    let n = 0;
    for (const j of this.jobs.values()) if (j.info.status === "running") n++;
    return n;
  }

  /** Start a job. Refusals are DATA — a full pool is a normal condition, not an exception. */
  start(command: string, cwd: string): { ok: true; info: JobInfo } | { ok: false; reason: string } {
    if (this.running >= MAX_JOBS) {
      return { ok: false, reason: `${MAX_JOBS} background jobs already running (bash_list shows them; bash_kill frees a slot) — run this one in the foreground or wait` };
    }
    const id = `b${++this.seq}`;
    const ac = new AbortController();
    const rec: JobRecord = {
      info: { id, command, status: "running", startedAt: Date.now(), dropped: 0, drained: false },
      buf: "", cursor: 0, ac,
      done: Promise.resolve(),
    };
    const dec = new TextDecoder();
    const observe: SpawnObserver = {
      onSpawn: (pid) => { rec.info.pid = pid; },
      onChunk: (_stream, bytes) => { this.append(rec, dec.decode(bytes, { stream: true })); },
    };
    this.jobs.set(id, rec);
    rec.done = getExecutor().run(command, cwd, ac.signal, observe).then(
      (r) => {
        // A killed job's non-zero exit is the kill, not the command's verdict — say which happened.
        if (rec.info.status === "killed") { this.finish(rec); return; }
        rec.info.status = r.code === 0 ? "exited" : "failed";
        rec.info.exitCode = r.code;
        // The observer streamed the bytes; the result's assembled text is the SAME output a foreground
        // run would have returned, so appending it would double every line. Only the tail of a run that
        // produced nothing through the taps (a rung that does not observe) is taken from the result.
        if (rec.buf === "" && r.text !== "") this.append(rec, r.text);
        this.finish(rec);
      },
      (e: unknown) => {
        rec.info.status = "failed";
        this.append(rec, `\n[job runner threw: ${e instanceof Error ? e.message : String(e)}]`);
        this.finish(rec);
      },
    );
    return { ok: true, info: { ...rec.info } };
  }

  private append(rec: JobRecord, text: string): void {
    if (text === "") return;
    rec.buf += text;
    if (rec.buf.length > RING_CHARS) {
      const cut = rec.buf.length - RING_CHARS;
      rec.buf = rec.buf.slice(cut);
      rec.info.dropped += cut;
      // the cursor moves with the window; what a reader has not read yet and lost is reported at read time
      rec.cursor = Math.max(0, rec.cursor - cut);
    }
  }

  private finish(rec: JobRecord): void {
    rec.info.finishedAt = Date.now();
    const info: JobInfo = { ...rec.info };
    for (const l of this.listeners) l(info);
    // ONE note, through the queue the loop already drains — never an interrupt, never a poll
    const how = rec.info.status === "killed" ? "killed" : `exit=${rec.info.exitCode}`;
    this.opts.notify?.push(`background job ${rec.info.id} finished (${how}): ${clip(rec.info.command, 60)} — bash_output ${rec.info.id} reads what it printed`);
    this.reap();
  }

  /** Read only what is NEW since the last read. `lost` is unread output the ring dropped: a reader that
   *  is told "you missed 40k characters" can act on it; one that is silently handed a gap cannot. */
  read(id: string): { ok: false; reason: string } | { ok: true; info: JobInfo; text: string; more: boolean; lost: number } {
    const rec = this.jobs.get(id);
    if (!rec) return { ok: false, reason: `no background job "${id}" in this session (bash_list shows them; a finished job is dropped after its output has been read)` };
    const lostBefore = rec.info.dropped;
    const fresh = rec.buf.slice(rec.cursor);
    const text = fresh.slice(0, MAX_READ);
    rec.cursor += text.length;
    const more = rec.cursor < rec.buf.length;
    if (!more && rec.info.status !== "running") { rec.info.drained = true; this.reap(); }
    return { ok: true, info: { ...rec.info }, text, more, lost: lostBefore };
  }

  /** Kill a job through the executor's own abort path — the tree, not just the launcher. */
  kill(id: string): { ok: boolean; reason?: string; info?: JobInfo } {
    const rec = this.jobs.get(id);
    if (!rec) return { ok: false, reason: `no background job "${id}" in this session` };
    if (rec.info.status !== "running") return { ok: true, info: { ...rec.info } };
    rec.info.status = "killed";
    rec.ac.abort();
    return { ok: true, info: { ...rec.info } };
  }

  killAll(): number {
    let n = 0;
    for (const j of this.jobs.values()) if (j.info.status === "running") { this.kill(j.info.id); n++; }
    return n;
  }

  /** Wait for every job to settle (surface shutdown / tests). */
  async drain(): Promise<void> { await Promise.allSettled([...this.jobs.values()].map((j) => j.done)); }

  dispose(): void { this.killAll(); this.unbind?.(); this.listeners.clear(); }

  /** Drop drained finished jobs beyond KEEP_FINISHED, oldest first. A finished job whose output nobody
   *  has read is NEVER dropped: that output is the only record the command ever ran. */
  private reap(): void {
    const done = [...this.jobs.values()].filter((j) => j.info.status !== "running" && j.info.drained);
    if (done.length <= KEEP_FINISHED) return;
    done.sort((a, b) => (a.info.finishedAt ?? 0) - (b.info.finishedAt ?? 0));
    for (const j of done.slice(0, done.length - KEEP_FINISHED)) this.jobs.delete(j.info.id);
  }
}

const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + "…" : s);

// ---------- the one manager a runtime installs ----------
//
// bashTool has to reach the manager without every call site threading it, and a runtime must be able to
// exist without one (the `tools` listing, the gauntlet, a unit test): so `run_in_background` with no
// manager installed is a refusal that names the surface, never a silent foreground run. A background
// request that quietly ran in the foreground would block the run it was asked not to block.

let installed: BashJobManager | null = null;

export function installJobManager(m: BashJobManager | null): void { installed = m; }
export function hasJobManager(): boolean { return installed !== null; }
export function jobManager(): BashJobManager | null { return installed; }

export function startBashJob(command: string, cwd: string): { ok: true; info: JobInfo } | { ok: false; reason: string } {
  if (!installed) return { ok: false, reason: "background jobs are not available on this surface — run the command in the foreground (drop run_in_background)" };
  return installed.start(command, cwd);
}
