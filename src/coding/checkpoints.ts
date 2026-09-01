/** Shadow-git checkpoints (PORT #11, cline port, Apache-2.0 — see THIRD_PARTY_NOTICES).
 *
 *  A SECOND git repository whose git-dir lives under .aion/checkpoints/<session> and whose
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
 *     .aion, build output) survive — the reset+clean pair of the snapshot's own restore
 *     (checkpoint-restore.ts:458-470)
 *  Deviations from v3.89.2: the shadow repo lives IN-WORKSPACE under .aion (bar) so
 *  ".aion/" is excluded from itself; the nested-.git rename dance
 *  (CheckpointGitOperations.ts:148-166, 207 ".git_disabled") is NOT ported — renaming the
 *  user's nested .git would violate "user .git never touched", so nested repos become
 *  inert gitlink entries instead (their contents are not checkpointed, never modified);
 *  core.autocrlf=false is set so restores are byte-exact on Windows.
 *
 *  Conversation restore returns the session entryId to branch to — the CALLER feeds it to
 *  SessionStore.branch() (port #2 leaf machinery); this module never imports session.ts. */

import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
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
 *  excluded .aion/; spawned children's own write/execute calls hit the same hook. */
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
  /** override the shadow root (default <workspace>/.aion/checkpoints) — tests/global mode */
  shadowRoot?: string;
}

/** Trimmed port of cline's default exclusions (CheckpointExclusions.ts:42-70 keeps a long
 *  media/cache/db list; we keep the structural entries + the bar's node_modules/.aion). */
const EXCLUDES = [
  ".git/",
  ".aion/",            // the shadow repo itself lives here (deviation: in-workspace)
  "node_modules/",
  "dist/",
  "build/",
  "out/",
  ".next/",
  "__pycache__/",
  ".venv/",
  "venv/",
  ".DS_Store",
];

/** `verb` names the failing subcommand in errors; the default suits bare invocations
 *  like ["init"], but --git-dir'd calls must pass it (the first non-dash arg there is
 *  the git-dir PATH — blaming a path instead of the verb misled /restore users). */
function runGit(args: string[], cwd: string, verb = args.find((a) => !a.startsWith("-")) ?? ""): Promise<string> {
  // Explicit env hygiene: a caller's GIT_* vars must not redirect shadow commands
  // at the USER repo (cline relies on simple-git cwd instead — GitOperations.ts:88).
  const env = { ...process.env };
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_COMMON_DIR"]) delete env[k];
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

export class Checkpoints {
  /** history, oldest first (sidecar-backed: survives process restarts) */
  private readonly log: Checkpoint[] = [];

  private constructor(
    readonly workspace: string,
    /** shadow repo GIT DIR: <workspace>/.aion/checkpoints/<session>/.git */
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
    // dot-only ids ("."/"..") survive the charwise filter but escape or collapse the
    // shadow root under join() — fold them (and "") to underscores
    const cleaned = opts.sessionId.replace(/[^A-Za-z0-9._-]/g, "_");
    const session = /^\.*$/.test(cleaned) ? cleaned.replace(/\./g, "_") || "_" : cleaned;
    const shadowDir = join(opts.shadowRoot ?? join(workspace, ".aion", "checkpoints"), session);
    const gitDir = join(shadowDir, ".git"); // cline layout: <checkpointsDir>/.git (CheckpointUtils.ts:20-23)
    mkdirSync(shadowDir, { recursive: true });
    const cp = new Checkpoints(workspace, gitDir, join(shadowDir, "checkpoints.jsonl"));

    if (!existsSync(join(gitDir, "HEAD"))) {
      // plain `git init` in the shadow dir, exactly GitOperations.ts:88
      await runGit(["init"], shadowDir);
      // GitOperations.ts:91-94 config block (identity ours; autocrlf is an aion addition)
      for (const [k, v] of [
        ["core.worktree", workspace],
        ["commit.gpgSign", "false"],
        ["core.autocrlf", "false"],
        ["user.name", "Aion Checkpoint"],
        ["user.email", "checkpoint@aion.local"],
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
    await this.git("commit", "--allow-empty", "--no-verify", "-m", `aion-checkpoint: ${label}`);
    const hash = await this.git("rev-parse", "HEAD");
    const c: Checkpoint = { hash, label, createdAt: Date.now(), ...(entryId !== undefined ? { entryId } : {}) };
    appendFileSync(this.sidecar, JSON.stringify(c) + "\n");
    this.log.push(c);
    return c;
  }

  /** History oldest→newest. */
  list(): Checkpoint[] { return [...this.log]; }

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
