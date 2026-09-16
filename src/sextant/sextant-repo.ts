/** Sextant repo watcher (port #44 fix wave): the renderer's git + fs work — the files-panel scan (full
 *  after a mutating tool, porcelain-only while idle), the post-edit diff and the /diff view — scheduled
 *  OFF the frame loop (a setTimeout(0) from the tick, never inside a painter) and run ASYNC through the
 *  git-status.ts `…Async` forms (child processes; results applied on completion + a repaint), so a
 *  200 ms `git status` on a large repo never freezes the spinner, the pet or the keys. One scan is in
 *  flight at a time: a request that arrives meanwhile runs on the first tick after it settles; stop()
 *  drops every pending timer and ignores results that land afterwards. Extracted from
 *  sextant-renderer.ts (ADR-002 line budget); the renderer owns the state, this class only writes
 *  s.files / s.repo.branch / s.code.diff and the tool row's landed counts. */

import type { GitRunnerAsync } from "./git-status.ts";
import { setFiles } from "./model.ts";
import type { HashlineOp } from "./sextant-diff-base.ts";
import { fileDiffAsync, headDiffAsync, scanRepoAsync, statusOnlyAsync, type HeadDiff } from "./sextant-files.ts";
import type { SextantState, ToolRow } from "./types.ts";

/** while idle, the porcelain statuses are re-read at most this often */
export const IDLE_SCAN_MS = 5000;

export interface RepoWatcherDeps {
  state: SextantState;
  clock: () => number;
  git: GitRunnerAsync;
  /** request a repaint (the frame loop's markDirty) */
  dirty: () => void;
}

export class RepoWatcher {
  private wanted: "full" | "status" | null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly deferred = new Set<ReturnType<typeof setTimeout>>();
  private inFlight = false;
  private lastScanAt = -Infinity;
  private hasGit = false;
  private stopped = false;
  /** aborts the git children of a scan in flight when stop() is called (git-status.ts runner signal) */
  private readonly ac = new AbortController();
  /** the scan in flight, so stop() can wait for its children to be GONE, not merely killed */
  private live: Promise<void> | null = null;

  /** `scan` false disables the repo scan entirely (pure unit tests) */
  constructor(private readonly d: RepoWatcherDeps, scan: boolean) { this.wanted = scan ? "full" : null; }

  /** a mutating tool (edit / write / remove / run) landed: list + statuses + branch again — repos only,
   *  but while the first scan is still in flight the answer is unknown, so the request is kept */
  afterMutation(): void { if (this.wanted !== null || this.hasGit || this.inFlight) this.wanted = "full"; }
  /** attach() re-pointed the cwd: a fresh full scan unless scanning is off */
  afterAttach(): void { if (this.wanted !== null || this.lastScanAt !== -Infinity) this.wanted = "full"; }
  /** a scan is running in the background (tests) */
  get scanning(): boolean { return this.inFlight; }

  /** First file snapshot under the intro, before revealing an apparently empty files panel.
   *  This is called off the paint path. stop() owns/drains the same promise on cancellation. */
  prepare(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (!this.live) this.live = this.scan();
    return this.live;
  }

  /** from the frame loop's tick: arm the idle poll, then schedule whatever is wanted (once) */
  onTick(now: number, running: boolean): void {
    if (this.wanted === null && this.hasGit && !running && now - this.lastScanAt >= IDLE_SCAN_MS) this.wanted = "status";
    if (this.wanted !== null && !this.inFlight && !this.timer && !this.stopped) this.timer = setTimeout(() => { this.timer = null; this.live = this.scan(); }, 0);
  }

  /** only reached through onTick's timer, which is armed when no scan is in flight */
  private async scan(): Promise<void> {
    if (this.stopped || this.wanted === null) return;
    const kind = this.wanted, s = this.d.state;
    this.wanted = null; this.lastScanAt = this.d.clock(); this.inFlight = true;
    // every git child of this scan is bound to the watcher's abort signal: stop() kills them and the
    // runner settles only when they are gone, so `live` resolving means "no child holds the cwd"
    const git: GitRunnerAsync = (a, c) => this.d.git(a, c, this.ac.signal);
    try {
      if (kind === "full") {
        const snap = await scanRepoAsync(s.cwd, git);
        if (this.stopped) return;
        setFiles(s, snap.paths, snap.statuses); s.repo.branch = snap.branch; this.hasGit = snap.git;
      } else {
        const st = await statusOnlyAsync(s.cwd, git);
        if (this.stopped) return;
        if (st) setFiles(s, s.files.paths, st);
      }
      this.d.dirty();
    } finally { this.inFlight = false; }
  }

  /** The #41 diffFor seam, deferred and async: the hunks for the file an edit/write just changed →
   *  s.code.diff + the diff view. `before` = the pre-edit content captured at approval (undefined when
   *  the call was not gated), `ops` = the edit's hashline ops (the base is rebuilt from them when
   *  nothing was captured). The row's `+a −b` is overwritten only by an edit-only diff — a HEAD base
   *  is cumulative, so the row keeps the reducer's args-derived counts and the view says `vs HEAD`. */
  scheduleDiff(row: ToolRow, file: string, before: string | null | undefined, ops: readonly HashlineOp[]): void {
    this.defer(async () => {
      const d = await fileDiffAsync(this.d.state.cwd, file, before, this.d.git, ops);
      if (this.stopped || !d) return;
      if (d.base !== "head") { row.add = d.add; row.del = d.del; }
      this.show(file, d, true);
    });
  }

  /** the /diff view (⌃d, /diff, ←/→ into diff mode): HEAD vs disk for the file, flagged as such; the
   *  mode is already diff (keys.ts wrote it before the hook fired) and is not forced back if the user
   *  moved on while git ran */
  loadDiff(file: string): void {
    this.defer(async () => {
      const d = await headDiffAsync(this.d.state.cwd, file, this.d.git);
      if (this.stopped) return;
      if (d) this.show(file, d, false); else { this.d.state.code.diff = null; this.d.dirty(); }
    });
  }

  private show(file: string, d: HeadDiff, flip: boolean): void {
    const s = this.d.state;
    s.code.diff = { file, hunks: d.hunks, add: d.add, del: d.del, ...(d.base ? { base: d.base } : {}) };
    if (flip) s.code.mode = "diff";
    this.d.dirty();
  }

  private defer(work: () => Promise<void>): void {
    if (this.stopped) return;
    const t = setTimeout(() => { this.deferred.delete(t); if (!this.stopped) void work(); }, 0);
    this.deferred.add(t);
  }

  /** clear every pending timer, KILL the git children of a scan in flight (their results are dropped),
   *  and resolve once those children are gone — the caller can then remove the cwd. Idempotent: a second
   *  stop() returns the same settled promise. Before this, stop() only dropped results and left the child
   *  running; on Windows a live `git status` holds the directory and every tui-sextant test's quit()
   *  failed at rmSync with EBUSY, a different test each run. */
  stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    for (const t of this.deferred) clearTimeout(t);
    this.deferred.clear();
    this.ac.abort();
    return this.live ?? Promise.resolve();
  }
}
