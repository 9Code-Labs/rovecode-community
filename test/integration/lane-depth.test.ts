/** Lane-within-lane depth (#47, Berkay's 2026-09-07 ask): a lane started from INSIDE another task must
 *  work where its starter works, not where the manager's root is.
 *
 *  WHY THIS FILE EXISTS. `runLaneJob(deps, id, goal, rootDir, …)` builds the lane's worktree from
 *  `rootDir` and ends with `applyPatch(patch, rootDir)`. tasks.ts used to pass `deps.rootDir` for every
 *  lane — the TOP-LEVEL repo — so an ISOLATED child, which is itself confined to a worktree, could start
 *  an external CLI whose diff landed in the user's live tree. The child could not write there; the lane
 *  it started could. Nothing in the child's own patch recorded it, because the write never went through
 *  the child. That is the leak these tests hold shut, and the assertion that matters most is the negative
 *  one: the root repo is BYTE-FOR-BYTE unchanged.
 *
 *  Everything here drives the real TaskManager over the real git worktree ladder (createIsolation) with
 *  only the CLI process faked — the merge-back is what is under test, and a fake isolation seam would
 *  hide exactly the part that was wrong. */

import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskManager } from "../../src/core/tasks.ts";
import { ToolRegistry } from "../../src/core/tools.ts";
import { createIsolation, type ChildRunnerDeps } from "../../src/core/orchestrator.ts";
import { textTurn } from "../../src/providers/stream.ts";
import type { AgentDefinition, RunConfig, StreamFn } from "../../src/core/types.ts";
import type { LaneJobDeps } from "../../src/lanes/job.ts";
import { fakeLaneSpawn, fixtureLines, type FakeScript } from "../helpers/fake-lane.ts";

const CODEX = fixtureLines(readFileSync(join(import.meta.dir, "..", "fixtures", "lanes", "codex.jsonl"), "utf8"));
const allowAll = [{ action: "*", resource: "*", effect: "allow" as const }];
const cfg: RunConfig = { maxTurns: 6, contextBudgetTokens: 100_000, compactionThreshold: 0.8, parallelTools: false, permissionRules: allowAll };
const worker: AgentDefinition = { name: "worker", systemPrompt: "w", tools: ["*"] };
const idle: StreamFn = async function* () { yield { type: "turn", turn: textTurn("unused") }; };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function until(pred: () => boolean, ms: number, what: string): Promise<void> {
  const t0 = Date.now();
  while (!pred()) { if (Date.now() - t0 > ms) throw new Error(`${what}: not true within ${ms}ms`); await sleep(15); }
}

function tempGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "rove-lane-depth-"));
  writeFileSync(join(dir, "tracked.txt"), "tracked\n");
  Bun.spawnSync(["git", "init", "-q"], { cwd: dir });
  Bun.spawnSync(["git", "config", "core.autocrlf", "false"], { cwd: dir }); // the merge-back is byte-compared: the box's system-wide autocrlf must not rewrite the lane's LF file
  Bun.spawnSync(["git", "add", "."], { cwd: dir });
  Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: dir });
  return dir;
}

/** the fake CLI "does its work": one new file in ITS OWN cwd (the lane's worktree) */
const working = (name = "lane-note.md"): FakeScript => ({
  lines: CODEX,
  onSpawn: (cmd) => writeFileSync(join(cmd.cwd, name), "from the codex lane\n"),
});

function manager(root: string, lanes: LaneJobDeps) {
  const sessions = mkdtempSync(join(tmpdir(), "rove-lane-depth-sess-"));
  const deps: ChildRunnerDeps = { defs: new Map([["worker", worker]]), stream: idle, registryFactory: () => new ToolRegistry(), rootDir: root, sessionsDir: sessions, baseConfig: cfg };
  const tasks = new TaskManager({ deps: () => deps, maxConcurrent: 2, lanes });
  const cleanup = async () => { tasks.cancelAll(); await tasks.drain(3_000); rmSync(sessions, { recursive: true, force: true }); };
  return { tasks, cleanup };
}

/** Tracked-content changes in `root`. `-uno` on purpose: `createIsolation` parks worktrees under
 *  `<root>/.rovecode/worktrees/`, so that directory appearing untracked is the isolation scaffolding
 *  working, not the lane's output arriving. What must not change is the tree's CONTENT. */
const dirty = (root: string): string =>
  Bun.spawnSync(["git", "status", "--porcelain", "-uno"], { cwd: root, stdout: "pipe", stderr: "pipe" }).stdout.toString().trim();
/** every path git can see, tracked or not, so a stray file cannot hide behind `-uno` */
const seen = (root: string): string =>
  Bun.spawnSync(["git", "status", "--porcelain"], { cwd: root, stdout: "pipe", stderr: "pipe" }).stdout.toString();

test("a lane started with parentDir merges into THAT tree, and the root repo is left byte-for-byte clean", async () => {
  const root = tempGitRepo();
  const child = await createIsolation(root, { prefer: "worktree" });   // stands in for an isolated child's workspace
  expect(child.kind).toBe("worktree");
  const { spawn, cmds } = fakeLaneSpawn(working());
  const { tasks, cleanup } = manager(root, { spawn, env: { ROVECODE_LANES_ALLOW: "codex" }, timeoutMs: 5_000 });
  try {
    const r = tasks.start({ agent: "codex", goal: "write the note", background: true }, { parentDir: child.dir });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    await until(() => tasks.status(r.id)?.status === "done", 10_000, "nested lane done");
    // the lane's worktree was cut from the CHILD's tree, not the root
    expect(cmds).toHaveLength(1);
    expect(cmds[0]!.cwd.startsWith(child.dir)).toBe(true);
    // …and its patch landed in the CHILD's tree
    expect(existsSync(join(child.dir, "lane-note.md"))).toBe(true);
    expect(readFileSync(join(child.dir, "lane-note.md"), "utf8")).toBe("from the codex lane\n");
    // THE ASSERTION THIS FILE IS FOR: the user's live tree never saw it. A lane that writes here has
    // walked straight through the isolation its parent is held to, and the parent's own patch — the
    // only record the user reads — says nothing about it.
    expect(existsSync(join(root, "lane-note.md"))).toBe(false);
    expect(dirty(root)).toBe("");                       // no tracked file in the live tree changed
    expect(seen(root)).not.toContain("lane-note");      // and the lane's file is nowhere in it, tracked or not
  } finally {
    await cleanup();
    await child.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);

test("without parentDir a lane still works in the root — a ROOT start genuinely lives there, and that default must not change", async () => {
  // The default is the part every existing caller depends on. A change that made `parentDir` mandatory,
  // or that defaulted it to anything other than deps.rootDir, would move every root lane's output.
  const root = tempGitRepo();
  const { spawn, cmds } = fakeLaneSpawn(working());
  const { tasks, cleanup } = manager(root, { spawn, env: { ROVECODE_LANES_ALLOW: "codex" }, timeoutMs: 5_000 });
  try {
    const r = tasks.start({ agent: "codex", goal: "write the note", background: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    await until(() => tasks.status(r.id)?.status === "done", 10_000, "root lane done");
    expect(cmds[0]!.cwd.startsWith(root)).toBe(true);
    expect(existsSync(join(root, "lane-note.md"))).toBe(true);
  } finally {
    await cleanup();
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);

test("depth is still counted through a lane: a nested lane obeys the cap rather than being exempt from it", async () => {
  // A lane is a job, not a loop, so it is easy for it to fall outside the accounting that stops runaway
  // nesting. `parentDepth` is what `task start` passes down, and the cap has to bite at the same number
  // for a lane as for an agent child — otherwise "delegate to codex" is a way around the cap.
  const root = tempGitRepo();
  const { spawn, cmds } = fakeLaneSpawn(working());
  const { tasks, cleanup } = manager(root, { spawn, env: { ROVECODE_LANES_ALLOW: "codex" }, timeoutMs: 5_000 });
  try {
    // cap 3, checked as `depth >= maxDepth` on the CHILD's depth (parentDepth + 1): 2 is the last that runs
    const deep = tasks.start({ agent: "codex", goal: "too deep", background: true }, { parentDepth: 2 });
    expect(deep.ok).toBe(false);
    if (!deep.ok) expect(deep.reason).toBe("depth cap 3 reached (current 3)");
    expect(cmds).toHaveLength(0);          // refused before any worktree or process
    expect(tasks.list()).toHaveLength(0);  // and with no record left behind to explain
    const ok = tasks.start({ agent: "codex", goal: "deep enough", background: true }, { parentDepth: 1 });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(tasks.status(ok.id)?.depth).toBe(2);
    await until(() => cmds.length === 1, 10_000, "lane at the last allowed depth ran");
  } finally {
    await cleanup();
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);
