/** Lane JOB (#47): what core/tasks.ts TaskManager runs for a TaskInfo of kind "external" — the twin
 *  of orchestrator.ts runChild for an isolated child, with the CLI in place of agentLoop: create the
 *  lane's OWN worktree (createIsolation, detached, copy fallback in a non-git root), run the adapter's
 *  command there (lanes/runner.ts), report the log tail as the running preview (throttled, plus ONE
 *  trailing flush so a burst-then-silence CLI never leaves a stale tail on the board), then on `done`
 *  diff the worktree and merge the patch back into the parent tree exactly as isolated children do
 *  (orchestrator applyPatch; a cancelled/failed/timed-out lane's half-done edits never land), and
 *  always clean the worktree up. Two refusals BEFORE anything spawns: no isolation at all (kind "none"
 *  — the worktree AND the copy fallback failed, so the only dir left is the parent tree, where a
 *  cancelled CLI would leave half-done edits) fails the lane, and a cancel that landed while the
 *  worktree was being created ends it cancelled. Returns the SpawnResult shape TaskManager.finish()
 *  already consumes, plus the CLI's session id (resume) and the permission text the card showed. */

import { applyPatch, createIsolation } from "../core/orchestrator.ts";
import type { SpawnResult } from "../core/types.ts";
import type { LaneSpawn } from "./process.ts";
import { ADAPTERS, laneOptsFor, lanePermissions, type Env } from "./registry.ts";
import { filesFromPatch, MAX_TRACKED_FILES, type LaneProgress } from "./progress.ts";
import { runExternalLane } from "./runner.ts";
import type { AdapterId } from "./types.ts";

/** what core/tasks.ts needs from the lane layer, through one import */
export { lanePermissions, laneRefusal } from "./registry.ts";
export { isAdapterId, type AdapterId } from "./types.ts";

export interface LaneJobDeps {
  /** process seam; default bunLaneSpawn (tests: a fake process, never a real CLI) */
  spawn?: LaneSpawn;
  /** gate + option knobs; default process.env */
  env?: Env;
  /** SIGINT → kill grace override (tests) */
  graceMs?: number;
  /** wall-clock override (tests); default ROVECODE_LANE_TIMEOUT_MS / 15 min */
  timeoutMs?: number;
  /** isolation seam; default orchestrator createIsolation (tests: a slow stub, or one that yields kind "none") */
  isolate?: typeof createIsolation;
  /** silence before the waiting note (tests); default SILENT_MS */
  silentMs?: number;
  /** merge-back seam; default orchestrator applyPatch (tests: one that refuses, for the conflict case) */
  apply?: typeof applyPatch;
}

/** a lane that has printed NOTHING for SILENT_MS gets a waiting note as its preview. Live finding
 *  2026-09-03: `opencode run --format json` prints no event while it retries an unreachable provider
 *  (its retries go to its own log file) — 170 s of EMPTY preview until the wall-clock cutter. */
export const SILENT_MS = 30_000;
const fmtMs = (ms: number): string => (ms >= 1_000 ? `${Math.round(ms / 1_000)}s` : `${ms}ms`);

/** the patch's file list, capped the same way the live one is (progress.ts MAX_TRACKED_FILES) */
function withMeasuredFiles(files: readonly string[]): Pick<LaneProgress, "filesWritten" | "filesWrittenTotal"> {
  return { filesWritten: files.slice(0, MAX_TRACKED_FILES), filesWrittenTotal: files.length };
}

export interface LaneJobResult extends SpawnResult {
  sessionId?: string;
  permissions: string;
  /** what the lane did: the CLI's own tool-call count and usage, with `filesWritten` MEASURED from the
   *  worktree diff rather than taken from the stream (progress.ts rule 3) — absent on a refusal, because
   *  nothing ran */
  progress?: LaneProgress;
  /** #82: the CLI's exit code as the runner saw it (null = the process had not exited when the reader gave up); absent on a refusal before any spawn */
  exitCode?: number | null;
  /** #82: the model flag the lane ran with (ROVECODE_LANE_<ID>_MODEL), when set */
  model?: string;
}

/** running-preview updates are coalesced to at most one per PROGRESS_MS; a dropped event arms ONE trailing
 *  flush for the end of the window, cleared when the lane ends — no timer outlives the lane */
export const PROGRESS_MS = 250;

/** How a running lane reports itself. The preview is the log tail this has always sent; `progress` is what
 *  the lane has DONE so far (progress.ts) and is OPTIONAL to read — a caller written before the counters
 *  existed keeps working untouched, which is why the parameter was added rather than the callback replaced. */
export type LaneProgressSink = (preview: string, progress?: LaneProgress) => void;

export async function runLaneJob(
  deps: LaneJobDeps, id: AdapterId, goal: string, rootDir: string, signal: AbortSignal,
  onProgress: LaneProgressSink,
): Promise<LaneJobResult> {
  const adapter = ADAPTERS[id];
  const env = deps.env ?? process.env;
  const permissions = lanePermissions(id, env);
  const refuse = (summary: string): LaneJobResult => ({ agent: id, ok: false, usage: { input: 0, output: 0 }, permissions, summary });
  const iso = await (deps.isolate ?? createIsolation)(rootDir, { prefer: "worktree" });
  let trailing: ReturnType<typeof setTimeout> | undefined, silent: ReturnType<typeof setTimeout> | undefined;
  try {
    // kind "none": the worktree AND the copy fallback failed, so iso.dir IS the parent tree — refuse; a
    // `codex --sandbox workspace-write -C <live tree>` that gets cancelled would leave half-done edits there
    if (iso.kind === "none") return refuse("isolation unavailable — an external lane never runs in the parent tree");
    // cancelled while the worktree was being created: nothing spawns (finally removes the worktree)
    if (signal.aborted) return refuse("cancelled before the lane started");
    const opts = laneOptsFor(id, iso.dir, env, deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {});
    let last = 0, pending: readonly string[] | undefined, seen = false;
    let latest: LaneProgress | undefined;
    const flush = (tail: readonly string[]): void => { last = Date.now(); pending = undefined; onProgress(tail.join("\n"), latest); };
    const silentMs = deps.silentMs ?? SILENT_MS;
    silent = setTimeout(() => { if (!seen) onProgress(`no output from ${id} after ${fmtMs(silentMs)} — still waiting (lane timeout ${fmtMs(opts.timeoutMs)})`); }, silentMs);
    const r = await runExternalLane(adapter, { goal }, opts, {
      spawn: deps.spawn, signal, graceMs: deps.graceMs,
      onEvent: (_ev, tail, progress) => {
        seen = true;
        latest = progress; // the newest counters ride the next flush, coalesced with the preview
        const elapsed = Date.now() - last;
        if (elapsed >= PROGRESS_MS) { flush(tail); return; }
        pending = tail; // dropped: the trailing flush shows it once the window closes
        if (trailing === undefined) trailing = setTimeout(() => { trailing = undefined; if (pending) flush(pending); }, PROGRESS_MS - elapsed);
      },
    });
    const patch = await iso.diff();
    const usage = r.usage ?? { input: 0, output: 0 };
    // THE MEASURED FILE LIST: the diff is the tree, so it names what actually changed — a claude lane whose
    // last write failed silently, and an agy lane that confirms nothing at all, both end up honest here.
    const measured: LaneProgress = { ...r.progress, ...withMeasuredFiles(filesFromPatch(patch)) };
    const base = { agent: id, usage, permissions, patch, exitCode: r.exitCode, ...(r.sessionId ? { sessionId: r.sessionId } : {}), ...(opts.model ? { model: opts.model } : {}) };
    if (r.status !== "done") {
      const tail = r.log.slice(-3).join("\n");
      // progress.applied: false — this patch is returned for inspection and never merged back, so its
      // measured files are real writes into a worktree the `finally` below is about to delete. The
      // RESULT-level `applied` stays absent here on purpose: SpawnResult documents absent as "there was
      // never a merge-back to attempt", which is exactly this case, and a cancelled child reports the
      // same way. tasks.ts reads progress first, so the gate still closes.
      return { ...base, progress: { ...measured, applied: false }, ok: false, summary: `${r.error ?? r.status}${tail ? `\nlast output: ${tail}` : ""}` };
    }
    let summary = r.summary || "(no output)";
    if (patch.trim() === "" && adapter.emptyDiffNote) summary += `\nnote: ${adapter.emptyDiffNote}`;
    if (iso.kind === "copy") summary += `\n[isolation: copy — ${rootDir} is not a git repo]`;
    // the merge-back is the ONLY thing that makes these files true of the parent tree, and it can fail on
    // a lane that otherwise succeeded (a concurrent task touched the same lines) — so the boolean goes into
    // progress rather than only into the summary text, where no surface could read it
    const applied = (deps.apply ?? applyPatch)(patch, rootDir);
    if (!applied) summary += "\npatch-apply-failed";
    // BOTH flags, from the ONE variable: `applied` on the result answers core/types.ts SpawnResult's
    // question ("did the merge-back succeed", absent where none was attempted), `progress.applied`
    // answers the surface's ("are these files in your tree", false for a lane that never merged back).
    // They differ only for a lane that did not finish, and never contradict each other, because neither
    // is computed twice — read the note on the non-done return for why that one carries only the second.
    return { ...base, applied, progress: { ...measured, applied }, ok: true, summary: summary.slice(0, 4_000) };
  } finally {
    clearTimeout(trailing); clearTimeout(silent); // the result replaces the preview: no flush or note after the lane
    await iso.cleanup();
  }
}
