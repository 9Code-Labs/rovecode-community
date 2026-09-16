/** Shadow-git checkpoints (PORT #11, cline port, Apache-2.0 — see THIRD_PARTY_NOTICES).
 *
 *  KNOWN COST, and the design that would remove it — measured 2026-09-06, kept here so the next reader
 *  starts from the answer rather than the question. The shadow git-dir is per SESSION, so every new
 *  session pays `git init` + a full `add` of the workspace inside its FIRST write or bash call: 3.45–3.56 s
 *  in this repository (init+config 160 ms, first add 1.4 s, first commit 1.5 s writing 565 loose objects
 *  on Windows). Later calls in that session are 210–335 ms, of which ~200 ms is git. It does not amortise
 *  across sessions because nothing is shared.
 *
 *  The cut is one shadow repo per REPOSITORY with a ref per session — a new session's first snapshot
 *  becomes an incremental add, ~80 ms measured. cline keeps one shadow repo per TASK because a task is its
 *  unit of restore; ours is the repository, so sessions in one workspace can share an object store and
 *  differ only by ref. It is NOT a configuration change: a shared git-dir means a shared index and a
 *  shared HEAD, and today's `add . && commit` / `reset --hard && clean -fd` would collide on index.lock
 *  (the second writer silently gets no checkpoint) and move HEAD under another session. It has to be
 *  re-done on plumbing: GIT_INDEX_FILE=<shadow>/<session>.index per session, then add → write-tree →
 *  commit-tree -p <that session's last> → update-ref refs/rovecode/<session> (atomic per ref, and the
 *  object store is atomic per object); restore becomes read-tree --reset -u then clean -fd against that
 *  same index, with no HEAD involved. A hash stays a hash, so restoring one session's checkpoint from
 *  another finally works — the case per-session storage never allowed, and the one that needs its own
 *  test, alongside a two-writers concurrency test. Sessions whose old per-session repo exists keep using
 *  it; nothing needs migrating.
 *
 *  A SECOND git repository whose git-dir lives under .rovecode/checkpoints/<session> and whose
 *  work-tree is the WORKSPACE, so the user's own .git is never written. This is cline's
 *  shadow-git design: the @8eb5f3d snapshot's docs still describe it (docs/core-workflows/
 *  checkpoints.mdx:17 "shadow Git repository separate from your project's actual Git
 *  history … Your main Git repository stays untouched"), but its v4 CODE moved to in-repo
 *  `git stash create` + refs/cline/* (sdk/packages/core/src/hooks/checkpoint-hooks.ts:172,
 *  sdk/packages/core/src/session/checkpoint-restore.ts:444-477), which requires a git
 *  workspace and rewrites the user's HEAD — incompatible with this bar. The mechanics here
 *  therefore port cline's last shadow-git implementation, v3.89.2
 *  apps/vscode/src/integrations/checkpoints/:
 *   - `git init` in the checkpoints dir, then core.worktree=<workspace>, commit.gpgSign
 *     off, own identity (CheckpointGitOperations.ts:88-94); git-dir = <dir>/.git and
 *     worktree-mismatch reuse check (CheckpointUtils.ts:20-23, GitOperations.ts:70-73)
 *   - excludes written to <git-dir>/info/exclude, list headed by ".git/"
 *     (CheckpointExclusions.ts:42-46 + 297-301)
 *   - snapshot = `add . --ignore-errors` (CheckpointGitOperations.ts:213) +
 *     `commit --allow-empty --no-verify` (CheckpointTracker.ts:251-253)
 *   - restore = `reset --hard <hash>` (CheckpointTracker.ts:364) + `clean -fd` so files
 *     created after the checkpoint are rewound away while ignored paths (node_modules,
 *     .rovecode, build output) survive — the reset+clean pair of the snapshot's own restore
 *     (checkpoint-restore.ts:458-470)
 *  Deviations from v3.89.2: the shadow repo lives IN-WORKSPACE under .rovecode (bar) so
 *  ".rovecode/" is excluded from itself; the nested-.git rename dance
 *  (CheckpointGitOperations.ts:148-166, 207 ".git_disabled") is NOT ported — renaming the
 *  user's nested .git would violate "user .git never touched", so nested repos become
 *  inert gitlink entries instead (their contents are not checkpointed, never modified);
 *  core.autocrlf=false is set so restores are byte-exact on Windows.
 *
 *  Conversation restore returns the session entryId to branch to — the CALLER feeds it to
 *  SessionStore.branch() (port #2 leaf machinery); this module never imports session.ts. */

import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface Checkpoint {
  hash: string;          // shadow commit hash
  label: string;         // e.g. the mutating tool's name
  entryId?: string;      // session entry to branch to on conversation restore
  createdAt: number;
}

export type RestoreMode = "files" | "conversation" | "both";

export type RestoreResult =
  | { ok: true; mode: RestoreMode; checkpoint: Checkpoint; entryId?: string }
  | { ok: false; error: string };

/** ToolKind values whose calls mutate the workspace → snapshot after each (bar:
 *  "snapshot commit after every mutating tool call"). memory writes land under the
 *  excluded .rovecode/; spawned children's own write/execute calls hit the same hook. */
export const MUTATING_KINDS: ReadonlySet<string> = new Set(["write", "execute"]);

/** Conversation-restore anchor for a snapshot: the LAST role:"user" message on the
 *  active path. At snapshot time the tail entry is the assistant message that ISSUED
 *  the in-flight tool call (the loop appends it pre-dispatch), so anchoring the tail
 *  branches to a history ending in tool_calls with no tool replies → provider 400.
 *  cline anchors the user run message instead (checkpoint-restore.ts:217-250).
 *  Wiring contract (like MUTATING_KINDS): runtime.ts withCheckpoint computes
 *  `anchorEntryId(activeStore.messages())`. */
export function anchorEntryId(messages: ReadonlyArray<{ id: string; role: string }>): string | undefined {
  return messages.findLast((m) => m.role === "user")?.id;
}

export interface CheckpointsInit {
  workspace: string;
  sessionId: string;
  /** override the shadow root (default <workspace>/.rovecode/checkpoints) — tests/global mode */
  shadowRoot?: string;
}

/** cline's default exclusions (CheckpointExclusions.ts:42-70), structural entries first, then the media /
 *  archive / binary categories. The first port kept only the structural entries, and the snapshot's
 *  `git add .` then hashed every file the WORKSPACE tracks: in a repo carrying 165 MB of tracked video
 *  (site/media-src) the first mutating tool call of every session took 26–35 s and left a 232 MB shadow
 *  repo under .rovecode/checkpoints/<session> (measured 2026-09-06, scripts/probe-turn.ts). A checkpoint
 *  exists to restore what the agent changed, and the agent does not edit videos, screenshots, archives or
 *  compiled binaries — those are excluded by extension, like cline does. With videos alone excluded the
 *  same repo still took 10.7 s and 79 MB: 82 MB of site/screenshots/*.png. Text of any size is still
 *  snapshotted, and so is SVG (text a designer or the agent writes). */
const EXCLUDES = [
  ".git/",
  ".rovecode/",            // the shadow repo itself lives here (deviation: in-workspace)
  "node_modules/",
  "dist/",
  "build/",
  "out/",
  ".next/",
  "__pycache__/",
  ".venv/",
  "venv/",
  ".DS_Store",
  // media (cline getMediaFilePatterns): video, audio, raster images — not SVG
  "*.mp4", "*.m4v", "*.mov", "*.avi", "*.mkv", "*.webm", "*.wmv", "*.flv", "*.mpg", "*.mpeg",
  "*.mp3", "*.m4a", "*.wav", "*.flac", "*.ogg", "*.aac", "*.wma",
  "*.png", "*.jpg", "*.jpeg", "*.gif", "*.bmp", "*.ico", "*.webp", "*.tif", "*.tiff", "*.heic", "*.avif", "*.psd",
  // archives and disk images (getLargeDataFilePatterns)
  "*.zip", "*.tar", "*.gz", "*.tgz", "*.bz2", "*.xz", "*.7z", "*.rar", "*.iso", "*.dmg",
  // compiled binaries and native libraries
  "*.exe", "*.dll", "*.so", "*.dylib", "*.node", "*.wasm", "*.o", "*.a", "*.class", "*.jar", "*.pyc",
  // databases and caches (getDatabaseFilePatterns / getCacheFilePatterns)
  "*.sqlite", "*.sqlite3", "*.db", "*.mdb", "*.log",
];

/** `verb` names the failing subcommand in errors; the default suits bare invocations
 *  like ["init"], but --git-dir'd calls must pass it (the first non-dash arg there is
 *  the git-dir PATH — blaming a path instead of the verb misled /restore users). */
function runGit(args: string[], cwd: string, verb = args.find((a) => !a.startsWith("-")) ?? "", extra: Record<string, string> = {}): Promise<string> {
  // Explicit env hygiene: a caller's GIT_* vars must not redirect shadow commands
  // at the USER repo (cline relies on simple-git cwd instead — GitOperations.ts:88).
  // `extra` is OUR explicit override (position()'s scratch GIT_INDEX_FILE), applied after the scrub.
  const env = { ...process.env };
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_COMMON_DIR"]) delete env[k];
  Object.assign(env, extra);
  return new Promise((res, rej) => {
    execFile("git", args, { cwd, env, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) rej(new Error(`git ${verb} failed: ${stderr.trim() || err.message}`));
      else res(stdout.trim());
    });
  });
}

/** Canonical form for workspace-identity compares: realpath fixes case/8.3 aliases of
 *  EXISTING paths (C:\foo vs c:\foo reopened the shadow repo as "another workspace"
 *  and silently disabled checkpoints); the case-fold below covers paths realpath
 *  cannot resolve, on the case-insensitive platform only. */
function canonPath(p: string): string {
  let r = p;
  try { r = (realpathSync.native ?? realpathSync)(p); } catch { /* nonexistent: compare as given */ }
  return process.platform === "win32" ? r.toLowerCase() : r;
}

/** The ONE spelling of a session's shadow directory, `<workspace>/.rovecode/checkpoints/<sanitised id>`: the id is
 *  folded charwise to [A-Za-z0-9._-] and dot-only ids ("."/"..", which survive the charwise filter but escape or
 *  collapse the shadow root under join()) and "" become underscores. init() creates it; `rovecode sessions delete`
 *  (core/session-ops.ts) removes it — both through here, so a delete never builds the path a second way. */
export function checkpointShadowDir(workspace: string, sessionId: string, shadowRoot?: string): string {
  const cleaned = sessionId.replace(/[^A-Za-z0-9._-]/g, "_");
  const session = /^\.*$/.test(cleaned) ? cleaned.replace(/\./g, "_") || "_" : cleaned;
  return join(shadowRoot ?? join(workspace, ".rovecode", "checkpoints"), session);
}

export class Checkpoints {
  /** history, oldest first (sidecar-backed: survives process restarts) */
  private readonly log: Checkpoint[] = [];

  private constructor(
    readonly workspace: string,
    /** shadow repo GIT DIR: <workspace>/.rovecode/checkpoints/<session>/.git */
    readonly gitDir: string,
    private readonly sidecar: string,
  ) {}

  /** Every shadow command names its git-dir and work-tree explicitly, so no cwd or
   *  environment state can ever point one at the user's repo. */
  private git(...args: string[]): Promise<string> {
    return runGit(["--git-dir", this.gitDir, "--work-tree", this.workspace, ...args], this.workspace, args[0]);
  }

  /** Create or reopen the shadow repo for a session. Works whether or not the workspace
   *  is a git repo — the shadow git-dir is entirely separate (non-git workspaces bar). */
  static async init(opts: CheckpointsInit): Promise<Checkpoints> {
    const workspace = resolve(opts.workspace);
    const shadowDir = checkpointShadowDir(workspace, opts.sessionId, opts.shadowRoot);
    const gitDir = join(shadowDir, ".git"); // cline layout: <checkpointsDir>/.git (CheckpointUtils.ts:20-23)
    mkdirSync(shadowDir, { recursive: true });
    const cp = new Checkpoints(workspace, gitDir, join(shadowDir, "checkpoints.jsonl"));

    if (!existsSync(join(gitDir, "HEAD"))) {
      // plain `git init` in the shadow dir, exactly GitOperations.ts:88
      await runGit(["init"], shadowDir);
      // GitOperations.ts:91-94 config block (identity ours; autocrlf is an rovecode addition)
      for (const [k, v] of [
        ["core.worktree", workspace],
        ["commit.gpgSign", "false"],
        ["core.autocrlf", "false"],
        ["user.name", "Rovecode Checkpoint"],
        ["user.email", "checkpoint@rovecode.local"],
      ] as const) await cp.git("config", k, v);
    } else {
      // reuse check: refuse a shadow repo whose recorded worktree is another path
      // (GitOperations.ts:70-73 "Checkpoints can only be used in the original workspace").
      // Compared canonically — a case-variant reopen (C:\foo vs c:\foo) is the SAME dir.
      const wt = await cp.git("config", "core.worktree").catch(() => "");
      if (canonPath(resolve(wt)) !== canonPath(workspace)) throw new Error(`checkpoints: shadow repo belongs to ${wt}, not ${workspace}`);
    }
    // (re)write excludes into the shadow git-dir every init (CheckpointExclusions.ts:297-301)
    mkdirSync(join(gitDir, "info"), { recursive: true });
    writeFileSync(join(gitDir, "info", "exclude"), EXCLUDES.join("\n") + "\n");
    cp.loadSidecar();
    return cp;
  }

  private loadSidecar(): void {
    if (!existsSync(this.sidecar)) return;
    for (const line of readFileSync(this.sidecar, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const c = JSON.parse(line) as Checkpoint;
        if (typeof c.hash === "string" && typeof c.label === "string") this.log.push(c);
      } catch { /* corrupt sidecar line: skip, never throw (session.ts reload pattern) */ }
    }
  }

  /** Snapshot the whole workspace: stage-all + allow-empty commit
   *  (GitOperations.ts:213 + CheckpointTracker.ts:251-253). Call after every mutating
   *  tool call; `entryId` is the session entry a conversation restore should branch to. */
  async snapshot(label: string, entryId?: string): Promise<Checkpoint> {
    await this.git("add", ".", "--ignore-errors");
    await this.git("commit", "--allow-empty", "--no-verify", "-m", `rovecode-checkpoint: ${label}`);
    const hash = await this.git("rev-parse", "HEAD");
    const c: Checkpoint = { hash, label, createdAt: Date.now(), ...(entryId !== undefined ? { entryId } : {}) };
    appendFileSync(this.sidecar, JSON.stringify(c) + "\n");
    this.log.push(c);
    return c;
  }

  /** History oldest→newest. */
  list(): Checkpoint[] { return [...this.log]; }

  /** Where the workspace sits in the snapshot history (port #65 /undo). `at` — the NEWEST checkpoint whose tree
   *  equals the work tree as it is now (staged into a SCRATCH index under the shadow git-dir, so the real index —
   *  and changedSince's untracked list — stay untouched); null when no snapshot matches (the workspace drifted).
   *  `previous` — the nearest ANCESTOR of `at` whose content differs (the pre-edit state; re-snapshots of an
   *  unchanged tree are stepped over; after a restore the shadow history forks, so the parent chain is followed,
   *  not the list order); null when nothing older differs. The git-call count does not grow with the history
   *  (rev-parse takes the hashes in batches); any git failure degrades to `{ at: null, previous: null }`, which a
   *  caller treats as a drifted workspace. */
  async position(): Promise<{ at: Checkpoint | null; previous: Checkpoint | null }> {
    const none = { at: null, previous: null };
    if (this.log.length === 0) return none;
    const scratch = join(this.gitDir, "rovecode-undo-index");
    const base = ["--git-dir", this.gitDir, "--work-tree", this.workspace];
    try {
      rmSync(scratch, { force: true });
      await runGit([...base, "add", ".", "--ignore-errors"], this.workspace, "add", { GIT_INDEX_FILE: scratch });
      const tree = await runGit([...base, "write-tree"], this.workspace, "write-tree", { GIT_INDEX_FILE: scratch });
      const trees: string[] = [];
      for (let i = 0; i < this.log.length; i += 200) {
        trees.push(...(await this.git("rev-parse", ...this.log.slice(i, i + 200).map((c) => `${c.hash}^{tree}`))).split("\n").map((s) => s.trim()));
      }
      const atIdx = trees.lastIndexOf(tree);
      if (atIdx < 0) return none;
      const at = this.log[atIdx]!;
      for (const h of (await this.git("rev-list", at.hash)).split("\n").slice(1)) {
        const i = this.log.findLastIndex((c) => c.hash === h.trim());
        if (i >= 0 && trees[i] !== tree) return { at, previous: this.log[i]! };
      }
      return { at, previous: null };
    } catch { return none; }
    finally { rmSync(scratch, { force: true }); }
  }

  /** What a "files" restore of `hash` would touch (port #65 /undo's confirmation card): tracked paths whose
   *  work-tree content differs from the snapshot (`diff --name-status <hash>`: M rewritten, D recreated) plus
   *  the untracked, non-excluded paths `clean -fd` would remove (`?`). Read-only; null when git fails, so a
   *  caller falls back to a generic card instead of a wrong list. */
  async changedSince(hash: string): Promise<{ path: string; status: string }[] | null> {
    try {
      const out: { path: string; status: string }[] = [];
      for (const line of (await this.git("diff", "--name-status", hash)).split("\n")) {
        const m = /^([A-Z])\S*\t(.+)$/.exec(line.trim());
        if (m) out.push({ status: m[1]!, path: m[2]!.split("\t").at(-1)! });
      }
      for (const p of (await this.git("ls-files", "--others", "--exclude-standard")).split("\n")) if (p.trim()) out.push({ status: "?", path: p.trim() });
      return out;
    } catch { return null; }
  }

  /** Restore a checkpoint by full hash or unique prefix.
   *  - "files": worktree → checkpoint state (reset --hard + clean -fd; ignored paths survive)
   *  - "conversation": NO file changes; returns the entryId for SessionStore.branch()
   *  - "both": files restored AND entryId returned
   *  Never throws — bad refs/modes AND shadow-git failures (a stale index.lock used to
   *  escape here and kill the TUI on unhandled rejection) come back structured, the
   *  error naming the failing verb (reset/clean). */
  async restore(ref: string, mode: RestoreMode): Promise<RestoreResult> {
    const hits = this.log.filter((c) => c.hash === ref || c.hash.startsWith(ref));
    // duplicate hashes (identical content re-snapshotted) are ONE candidate — the
    // LATEST entry wins so its (newer) conversation anchor is the one restored
    const target = hits.at(-1);
    if (!target || ref.length < 4) return { ok: false, error: `no checkpoint matches ${ref}` };
    if (new Set(hits.map((h) => h.hash)).size > 1) return { ok: false, error: `ambiguous checkpoint prefix ${ref}` };
    // conversation restore needs a recorded entryId — reject BEFORE touching any file,
    // so "both" can never half-apply
    if (mode !== "files" && target.entryId === undefined) {
      return { ok: false, error: `checkpoint ${target.hash.slice(0, 8)} has no session entryId` };
    }
    if (mode !== "conversation") {
      try {
        await this.git("reset", "--hard", target.hash);        // CheckpointTracker.ts:364
        // remove files created after the checkpoint; single -f spares nested git repos,
        // no -x spares ignored/excluded paths (checkpoint-restore.ts:458-470)
        await this.git("clean", "-fd");
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    }
    return {
      ok: true, mode, checkpoint: target,
      ...(mode !== "files" && target.entryId !== undefined ? { entryId: target.entryId } : {}),
    };
  }
}
