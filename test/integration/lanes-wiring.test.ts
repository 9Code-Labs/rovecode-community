/** PORT #47 wiring: external agentic-CLI lanes as TaskManager JOBS, over a FAKE lane process (no CLI is
 *  ever spawned). Pins: `task start {agent:"codex"}` under ROVECODE_LANES_ALLOW=codex → TaskInfo kind
 *  "external" (isolated, agent = adapter id, permissions text), queued → running → done with the CLI's
 *  last message as summary, the lane's worktree diff merged back into the root (the fake writes a file
 *  into its worktree cwd), the worktree removed; the running preview; `/tasks cancel` → cancelled through
 *  the kill path with NO merge-back; the gate (off → clear error, no spawn; claude when only codex is
 *  allowed → error; an adapter id shadows a same-named def); the approval request text carries the
 *  permission summary through the REAL runtime chain (spy approver), yolo asks nothing; the `task` tool
 *  output/description; and the sextant crew board rendering an external lane cell with the adapter id. */

import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskManager, type TaskInfo, type TaskStatus } from "../../src/core/tasks.ts";
import { createTaskStatusTool, createTaskTool } from "../../src/tools/task.ts";
import { SteeringQueue, agentLoop } from "../../src/core/loop.ts";
import { ToolRegistry } from "../../src/core/tools.ts";
import { createRuntime } from "../../src/cli/runtime.ts";
import { textTurn, toolTurn } from "../../src/providers/stream.ts";
import { cmdTasks, type InfoCmdCtx } from "../../src/tui/info-cmd.ts";
import { drawAgents } from "../../src/sextant/draw-agents.ts";
import type { AgentDefinition, ApprovalRequest, Message, ModelRef, RunConfig, RunEvent, StreamEvent, StreamFn, ToolContext } from "../../src/core/types.ts";
import { createIsolation, type ChildRunnerDeps } from "../../src/core/orchestrator.ts";
import type { LaneJobDeps } from "../../src/lanes/job.ts";
import { fakeLaneSpawn, fixtureLines, type FakeScript } from "../helpers/fake-lane.ts";
import { GridScreen, THEME, baseState } from "../helpers/sextant-grid.ts";

const CODEX = fixtureLines(readFileSync(join(import.meta.dir, "..", "fixtures", "lanes", "codex.jsonl"), "utf8"));
const CARD = "spawn codex lane · sandbox workspace-write · approval never · worktree";
const allowAll = [{ action: "*", resource: "*", effect: "allow" as const }];
const cfg: RunConfig = { maxTurns: 6, contextBudgetTokens: 100_000, compactionThreshold: 0.8, parallelTools: false, permissionRules: allowAll };
const worker: AgentDefinition = { name: "worker", systemPrompt: "w", tools: ["*"] };
const idle: StreamFn = async function* () { yield { type: "turn", turn: textTurn("unused") }; };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
function deadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const bomb = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error(`${what}: not settled within ${ms}ms`)), ms); });
  return Promise.race([p, bomb]).finally(() => clearTimeout(t));
}
async function until(pred: () => boolean, ms: number, what: string): Promise<void> {
  const t0 = Date.now();
  while (!pred()) { if (Date.now() - t0 > ms) throw new Error(`${what}: not true within ${ms}ms`); await sleep(15); }
}
function tempGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "aion-lanes-git-"));
  writeFileSync(join(dir, "tracked.txt"), "tracked\n");
  Bun.spawnSync(["git", "init", "-q"], { cwd: dir });
  Bun.spawnSync(["git", "config", "core.autocrlf", "false"], { cwd: dir }); // the merge-back is byte-compared below: the box's autocrlf (Git for Windows installs `true` system-wide) must not rewrite the lane's LF file
  Bun.spawnSync(["git", "add", "."], { cwd: dir });
  Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: dir });
  return dir;
}
const gitOut = (args: string[], cwd: string): string => Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" }).stdout.toString().trim();
const worktrees = (root: string): number => gitOut(["worktree", "list", "--porcelain"], root).split("\n").filter((l) => l.startsWith("worktree ")).length;
/** the fake lane "does its work": a new file in ITS cwd (the worktree) — the merge-back must carry it */
const working = (extra: Partial<FakeScript> = {}): FakeScript => ({ lines: CODEX, onSpawn: (cmd) => writeFileSync(join(cmd.cwd, "lane-note.md"), "from the codex lane\n"), ...extra });

function manager(root: string, lanes: LaneJobDeps, defs: Map<string, AgentDefinition> = new Map([["worker", worker]])) {
  const sessions = mkdtempSync(join(tmpdir(), "aion-lanes-sess-"));
  const deps: ChildRunnerDeps = { defs, stream: idle, registryFactory: () => new ToolRegistry(), rootDir: root, sessionsDir: sessions, baseConfig: cfg };
  const tasks = new TaskManager({ deps: () => deps, maxConcurrent: 2, lanes });
  const cleanup = async () => { tasks.cancelAll(); await tasks.drain(3_000); rmSync(sessions, { recursive: true, force: true }); };
  return { tasks, cleanup };
}
const toolCtx = (): ToolContext => ({ sessionId: "s", cwd: process.cwd(), signal: new AbortController().signal, permissions: { effect: "allow" } });

test("lifecycle: `start {agent:\"codex\"}` → kind external / isolated / permissions; queued → running → done; summary = the CLI's last message; the worktree file merges back into the root; worktree removed; note + task_status + crew board", async () => {
  const root = tempGitRepo();
  const { spawn, cmds } = fakeLaneSpawn(working());
  const { tasks, cleanup } = manager(root, { spawn, env: { ROVECODE_LANES_ALLOW: "codex" }, timeoutMs: 5_000 });
  const parent = new SteeringQueue();
  tasks.attach(parent);
  const seen: TaskStatus[] = [];
  tasks.subscribe((t) => seen.push(t.status));
  try {
    const r = tasks.start({ agent: "codex", goal: "write vitest cases for requireAuth" }, { label: "codex lane" });
    expect(r.ok).toBe(true);
    const id = (r as { id: string }).id;
    const q = tasks.status(id)!;
    // mutation targets: kind/permissions/isolated set in start()'s external branch
    expect(q).toMatchObject({ kind: "external", agent: "codex", isolated: true, depth: 1, permissions: CARD, label: "codex lane" });
    const info = await deadline(tasks.result(id, { timeoutMs: 15_000 }), 16_000, "lane settles");
    expect(info?.status).toBe("done");
    expect(info?.summary).toBe("Added 4 vitest cases for requireAuth."); // the CLI's last agent message
    expect(info?.usage).toEqual({ input: 5300, output: 800, cacheRead: 2000 });
    expect(info?.laneSession).toBe("thr-codex-1");
    expect(info?.patchLines ?? 0).toBeGreaterThan(0); // mutation target: drop iso.diff() / the patch on the result
    expect(existsSync(join(root, "lane-note.md"))).toBe(true); // mutation target: skip applyPatch
    expect(readFileSync(join(root, "lane-note.md"), "utf8")).toBe("from the codex lane\n");
    expect(seen[0]).toBe("queued"); expect(seen[1]).toBe("running"); expect(seen.at(-1)).toBe("done");
    expect(seen.slice(1, -1).every((s) => s === "running")).toBe(true); // progress emissions stay "running"
    // the lane ran INSIDE its own worktree under the root, never in the root itself
    expect(cmds).toHaveLength(1);
    const c = cmds[0]!.args.indexOf("-C");
    expect(cmds[0]!.args[c + 1]).toBe(cmds[0]!.cwd);
    expect(cmds[0]!.cwd.startsWith(join(root, ".rovecode", "worktrees"))).toBe(true);
    expect(cmds[0]!.cwd).not.toBe(root);
    expect(worktrees(root)).toBe(1); // cleaned up: the root is the only worktree left
    expect(gitOut(["status", "--porcelain"], root)).toContain("lane-note.md"); // merged as a working-tree change
    // TWO steers, and the order is the contract: a lane ANNOUNCES itself when it starts running (the
    // allow-list is on by default and permission=auto shows no card, so this is the only place the user
    // is told an external CLI is now working in a real tree), and reports when it settles.
    const steers = parent.drainAll();
    expect(steers.length).toBe(2);
    expect(steers[0]).toBe(`task ${id} (codex lane): ${CARD} — started; it works in its own worktree and its diff comes back as a patch`);
    expect(steers[1]).toContain(`task ${id} (codex lane) finished: Added 4 vitest cases`);
    const out = await createTaskStatusTool(tasks).execute({ action: "result", id, timeout_ms: 0 }, toolCtx());
    expect(out.ok).toBe(true);
    expect(out.output).toContain(`task ${id} (codex lane) done — agent codex, isolated`);
    expect(out.output).toMatch(/patch of \d+ lines merged back/);
    // the sextant crew board renders the external lane with its adapter id (read-only use of draw-agents)
    const s = baseState({ crew: [info!], focus: "code" });
    Object.assign(s.code, { mode: "agents" });
    const g = new GridScreen(150, 26, "░");
    drawAgents(g, { x: 3, y: 2, w: 60, h: 20 }, s, THEME, info!.finishedAt! + 1_000);
    const text = g.toText();
    expect(text).toContain("◆ codex lane");
    expect(text).toContain(`${id} · codex · isolated`);
    expect(text).toMatch(/\+\d+ lines merged/);
    expect(text).toContain("done: Added 4 vitest cases for requireAuth.");
  } finally {
    await cleanup();
    rmSync(root, { recursive: true, force: true });
  }
}, 40_000);

test("running preview + `/tasks cancel <id>`: the log tail shows as the summary while running; cancel goes through the kill path, the lane settles cancelled and its worktree edits are NOT merged back", async () => {
  const root = tempGitRepo();
  const { spawn, procs } = fakeLaneSpawn(working({ lines: CODEX.slice(0, 5), hold: true, delayMs: 20 }));
  const { tasks, cleanup } = manager(root, { spawn, env: { ROVECODE_LANES_ALLOW: "codex" }, timeoutMs: 20_000, graceMs: 50 });
  const notes: string[] = [];
  const ctx = { rt: { tasks }, renderer: { addSystemNote: (s: string) => { notes.push(s); } } } as unknown as InfoCmdCtx;
  try {
    const r = tasks.start({ agent: "codex", goal: "long lane" }, { label: "held lane" });
    expect(r.ok).toBe(true);
    const id = (r as { id: string }).id;
    // mutation target: TaskManager.progress() not writing the preview → summary stays undefined
    await deadline(until(() => tasks.status(id)?.status === "running" && (tasks.status(id)?.summary ?? "").includes("thread thr-codex-1"), 5_000, "running preview"), 6_000, "preview");
    expect(worktrees(root)).toBe(2); // the lane's worktree exists while it runs
    expect(existsSync(join(root, "lane-note.md"))).toBe(false); // nothing merged mid-run
    cmdTasks(ctx, `cancel ${id}`);
    expect(notes).toEqual([`cancelling task ${id} (held lane)`]);
    const info = await deadline(tasks.result(id, { timeoutMs: 5_000 }), 6_000, "cancelled lane settles");
    expect(info?.status).toBe("cancelled");
    expect(info?.error).toBe("cancelled");
    expect(info?.finishedAt).toBeDefined();
    expect(procs[0]!.steps).toEqual(["kill"]); // codex: straight tree kill (no SIGINT contract); mutation target: signal not threaded to the runner → the fake never dies, deadline trips
    expect(procs[0]!.alive).toBe(false);
    expect(existsSync(join(root, "lane-note.md"))).toBe(false); // mutation target: merging regardless of status
    expect(worktrees(root)).toBe(1); // worktree cleaned up after the cancel
    cmdTasks(ctx, `cancel ${id}`);
    expect(notes.at(-1)).toBe(`task ${id} already cancelled`);
  } finally {
    await cleanup();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test("agy soft-deny cross-check: a SUCCESS result with an EMPTY worktree diff is done with patchLines 0 plus the soft-deny note; no dangerous flag was passed", async () => {
  const root = tempGitRepo();
  const AGY = fixtureLines(readFileSync(join(import.meta.dir, "..", "fixtures", "lanes", "agy.jsonl"), "utf8"));
  const { spawn, cmds } = fakeLaneSpawn({ lines: AGY }); // no onSpawn: the "lane" changes nothing
  const { tasks, cleanup } = manager(root, { spawn, env: { ROVECODE_LANES_ALLOW: "agy" }, timeoutMs: 5_000 });
  try {
    const r = tasks.start({ agent: "agy", goal: "add a comment to README" }, { label: "agy lane" });
    expect(r.ok).toBe(true);
    const id = (r as { id: string }).id;
    expect(tasks.status(id)?.permissions).toBe("spawn agy lane · soft-deny (tools needing approval are refused, exit 0 — diff is cross-checked) · worktree");
    const info = await deadline(tasks.result(id, { timeoutMs: 15_000 }), 16_000, "agy lane");
    expect(info?.status).toBe("done");
    expect(info?.patchLines).toBe(0); // the diff cross-check (mutation target: drop iso.diff() → undefined)
    expect(info?.summary?.startsWith("Added a comment to README.")).toBe(true);
    expect(info?.summary).toContain("note: agy reported SUCCESS but the lane's worktree has no changes"); // mutation target: the emptyDiffNote branch
    expect(info?.summary).toContain("--dangerously-skip-permissions");
    expect(cmds[0]!.args).not.toContain("--dangerously-skip-permissions"); // default = soft-deny path
    expect(cmds[0]!.args.slice(0, 1)).toEqual(["-p"]);
    const out = await createTaskStatusTool(tasks).execute({ action: "result", id, timeout_ms: 0 }, toolCtx());
    expect(out.output).toContain("[isolated: no file changes]");
    expect(worktrees(root)).toBe(1);
  } finally {
    await cleanup();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test("gate ON by default: `ROVECODE_LANES_ALLOW=` is the kill switch (refusal, NO spawn, no record); a narrowed list refuses by naming ITSELF; a missing CLI is refused before any worktree; an adapter id shadows a same-named def; a real unknown agent is still 'unknown agent'", async () => {
  const root = tempGitRepo();
  const off = fakeLaneSpawn(working());
  const shadow: AgentDefinition = { ...worker, name: "codex" };
  // The kill switch, end to end through TaskManager.start — the empty string is the ONLY way to turn
  // every lane off now that unset means all four, so it is the case that has to hold at this level.
  const m1 = manager(root, { spawn: off.spawn, env: { ROVECODE_LANES_ALLOW: "" } }, new Map([["worker", worker], ["codex", shadow]]));
  const m2 = manager(root, { spawn: off.spawn, env: { ROVECODE_LANES_ALLOW: "codex" } });
  // No knob at all, but a PATH with nothing on it: the lane is ALLOWED and still must not spawn, because
  // the CLI is not installed. This is the refusal that replaces the old off-by-default one as the common
  // case, and it has to land here — before a worktree exists, not as an ENOENT after one was built.
  const m3 = manager(root, { spawn: off.spawn, env: { PATH: join(root, "no-such-bin-dir") } });
  try {
    const r = m1.tasks.start({ agent: "codex", goal: "x" });
    expect(r.ok).toBe(false);
    // mutation target: the laneRefusal gate in start() → a record + a spawned fake.
    // It also proves the id still SHADOWS the same-named definition: m1 HAS an agent called "codex",
    // and the answer is a lane refusal rather than that definition quietly being run instead.
    if (!r.ok) expect(r.reason).toBe("external lane 'codex' is not in ROVECODE_LANES_ALLOW (currently allowed: none) — add it, or unset ROVECODE_LANES_ALLOW to allow all of claude,codex,opencode,agy");
    expect(off.cmds).toHaveLength(0);
    expect(m1.tasks.list()).toHaveLength(0);
    await sleep(50);
    expect(off.cmds).toHaveLength(0); // still nothing spawned
    const c = m2.tasks.start({ agent: "claude", goal: "x" });
    expect(c.ok).toBe(false);
    if (!c.ok) expect(c.reason).toContain("external lane 'claude' is not in ROVECODE_LANES_ALLOW");
    if (!c.ok) expect(c.reason).toContain("currently allowed: codex");
    const missing = m3.tasks.start({ agent: "codex", goal: "x" });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toContain("needs the 'codex' CLI, which is not on PATH");
    expect(m3.tasks.list()).toHaveLength(0);
    await sleep(50);
    expect(off.cmds).toHaveLength(0);      // no worktree, no process, nothing to clean up
    const u = m2.tasks.start({ agent: "ghost", goal: "x" });
    expect(u.ok).toBe(false);
    if (!u.ok) expect(u.reason).toBe("unknown agent 'ghost'");
    expect(m2.tasks.list()).toHaveLength(0);
    // the task tool surfaces the same refusal as data, and its description lists the ids + the gate
    const tool = createTaskTool(m1.tasks);
    const out = await tool.execute({ action: "start", agent: "codex", goal: "x" }, toolCtx());
    expect(out.ok).toBe(false);
    expect(out.output).toContain("task refused: external lane 'codex' is not in ROVECODE_LANES_ALLOW");
    expect(tool.schema.description).toContain("claude | codex | opencode | agy");
    expect(tool.schema.description).toContain("ROVECODE_LANES_ALLOW");
    const props = tool.schema.args["properties"] as Record<string, { description: string }>;
    expect(props["agent"]!.description).toContain("claude | codex | opencode | agy");
  } finally {
    await m1.cleanup();
    await m2.cleanup();
    await m3.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);

// ---------- critic fixes: never the parent tree · cancel during isolation · burst-then-silence preview ----------

test("MED-1: createIsolation kind \"none\" (no worktree, no copy) → the lane FAILS before any spawn with `isolation unavailable — an external lane never runs in the parent tree`; the root is untouched, no worktree", async () => {
  const root = tempGitRepo();
  const { spawn, cmds } = fakeLaneSpawn(working());
  const isolate: LaneJobDeps["isolate"] = async (dir) => ({ dir, kind: "none", diff: async () => "", cleanup: async () => {} });
  const { tasks, cleanup } = manager(root, { spawn, env: { ROVECODE_LANES_ALLOW: "codex" }, timeoutMs: 5_000, isolate });
  try {
    const r = tasks.start({ agent: "codex", goal: "x" }, { label: "no-iso lane" });
    expect(r.ok).toBe(true);
    const id = (r as { id: string }).id;
    const info = await deadline(tasks.result(id, { timeoutMs: 5_000 }), 6_000, "refused lane settles");
    expect(info?.status).toBe("failed");
    // mutation target: the kind "none" guard → the fake runs with cwd === root, writes lane-note.md there, ends done
    expect(info?.error).toBe("isolation unavailable — an external lane never runs in the parent tree");
    expect(cmds).toHaveLength(0);
    expect(existsSync(join(root, "lane-note.md"))).toBe(false);
    expect(gitOut(["status", "--porcelain"], root)).toBe("");
    expect(worktrees(root)).toBe(1);
    const out = await createTaskStatusTool(tasks).execute({ action: "result", id, timeout_ms: 0 }, toolCtx());
    expect(out.ok).toBe(false);
    expect(out.output).toContain("isolation unavailable — an external lane never runs in the parent tree");
  } finally {
    await cleanup();
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);

test("LOW-1: cancel while the lane's worktree is still being created → the fake seam spawned 0 commands, the task settles cancelled, the worktree the slow isolation created is removed", async () => {
  const root = tempGitRepo();
  const { spawn, cmds } = fakeLaneSpawn(working({ hold: true }));
  let isolating = 0;
  const isolate: LaneJobDeps["isolate"] = async (dir, o) => { isolating++; await sleep(80); return createIsolation(dir, o); };
  const { tasks, cleanup } = manager(root, { spawn, env: { ROVECODE_LANES_ALLOW: "codex" }, timeoutMs: 20_000, isolate });
  try {
    const r = tasks.start({ agent: "codex", goal: "x" }, { label: "early cancel" });
    expect(r.ok).toBe(true);
    const id = (r as { id: string }).id;
    await until(() => isolating === 1 && tasks.status(id)?.status === "running", 1_000, "isolation in flight");
    expect(tasks.cancel(id)?.status).toBe("cancelled");
    const info = await deadline(tasks.result(id, { timeoutMs: 5_000 }), 6_000, "early-cancelled lane settles");
    expect(info?.status).toBe("cancelled");
    expect(info?.error).toBe("cancelled");
    // mutation target: the job's post-isolation abort check AND the runner's pre-spawn check → a spawn followed by a kill
    expect(cmds).toHaveLength(0);
    expect(worktrees(root)).toBe(1); // the worktree the slow isolation created was removed
    expect(existsSync(join(root, "lane-note.md"))).toBe(false);
  } finally {
    await cleanup();
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);

test("LOW-2: a burst-then-silence lane (two events 1 ms apart, then quiet) → the running preview shows the SECOND line within the throttle window, not the stale first one for the lane's whole life", async () => {
  const root = tempGitRepo();
  const { spawn } = fakeLaneSpawn({ lines: [CODEX[1]!, CODEX[3]!], hold: true, delayMs: 1 });
  const { tasks, cleanup } = manager(root, { spawn, env: { ROVECODE_LANES_ALLOW: "codex" }, timeoutMs: 20_000 });
  try {
    const r = tasks.start({ agent: "codex", goal: "burst" }, { label: "burst lane" });
    expect(r.ok).toBe(true);
    const id = (r as { id: string }).id;
    await until(() => (tasks.status(id)?.summary ?? "").includes("thread thr-codex-1"), 5_000, "first preview");
    const t0 = Date.now();
    // mutation target: no trailing flush → the preview stays on the first line while the lane is held
    await until(() => (tasks.status(id)?.summary ?? "").includes("Look at the guard first."), 2_000, "second line in the preview");
    expect(Date.now() - t0).toBeLessThan(1_500);
    expect(tasks.status(id)).toMatchObject({ status: "running", summary: "thread thr-codex-1\nthinking: Look at the guard first." });
    tasks.cancel(id);
    const info = await deadline(tasks.result(id, { timeoutMs: 5_000 }), 6_000, "burst lane settles");
    expect(info?.status).toBe("cancelled");
    expect(worktrees(root)).toBe(1);
  } finally {
    await cleanup();
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);

// ---------- the approval card through the REAL runtime chain ----------

const goalOf = (messages: Message[]): string => { const u = messages.find((m) => m.role === "user"); return u ? u.parts.filter((p) => p.kind === "text").map((p) => (p as { text: string }).text).join("") : ""; };
const toolEnd = (events: RunEvent[], callId: string) => { const e = events.find((ev) => ev.type === "tool_execution_end" && ev.callId === callId); return e && e.type === "tool_execution_end" ? e : undefined; };
/** PARENT: `task start` (agent per goal word), then `task_status result`, then done; CHILD: one text */
const script: StreamFn = async function* (_m: ModelRef, messages: Message[]): AsyncGenerator<StreamEvent> {
  const goal = goalOf(messages);
  const tools = messages.filter((m) => m.role === "tool").length;
  if (goal.startsWith("CHILD")) { yield { type: "turn", turn: textTurn("CHILD-DONE") }; return; }
  const agent = goal.includes("codex") ? "codex" : "main";
  if (tools === 0) { yield { type: "turn", turn: toolTurn([{ id: "p1", tool: "task", args: { action: "start", agent, goal: agent === "codex" ? "write vitest cases" : "CHILD quick", label: `${agent} lane` } }]) }; return; }
  if (tools === 1) { yield { type: "turn", turn: toolTurn([{ id: "p2", tool: "task_status", args: { action: "result", id: "t1", timeout_ms: 20_000 } }]) }; return; }
  yield { type: "turn", turn: textTurn("PARENT-DONE") };
};

async function runLoop(cwd: string, lanes: LaneJobDeps, goal: string, yolo: boolean, spy?: (req: ApprovalRequest) => void) {
  const rt = createRuntime({ cwd, stream: script, lanes });
  const reqs: ApprovalRequest[] = [];
  const cfg = rt.buildCfg(yolo, yolo ? undefined : async (req) => { reqs.push(req); spy?.(req); return "once"; });
  const def = rt.buildDef({ provider: "mock", model: "default" });
  const events: RunEvent[] = [];
  for await (const ev of agentLoop(def, goal, {}, cfg, { stream: script, registry: rt.registry, store: rt.store, tools: rt.registry.list().map((t) => t.schema), guard: rt.guard, cwd: rt.cwd }, rt.steering)) events.push(ev);
  return { rt, events, reqs };
}

test("approval: the spy approver sees the lane's permission summary as the request `reason` and as the FIRST key of revisedArgs (the card's 140-char preview) BEFORE the lane starts; a child start keeps the generic reason; yolo asks nothing", async () => {
  const cwd = tempGitRepo();
  const { spawn, cmds } = fakeLaneSpawn(working());
  const lanes: LaneJobDeps = { spawn, env: { ROVECODE_LANES_ALLOW: "codex" }, timeoutMs: 10_000 };
  try {
    let spawnedAtApproval = -1;
    const { rt, events, reqs } = await runLoop(cwd, lanes, "PARENT run a codex lane", false, () => { spawnedAtApproval = cmds.length; });
    expect(events.at(-1)).toMatchObject({ type: "run_end", status: "done", summary: "PARENT-DONE" });
    expect(reqs).toHaveLength(1);
    expect(reqs[0]!.tool).toBe("task");
    expect(reqs[0]!.reason).toBe(CARD); // mutation target: laneApprover not in the runtime chain → "permission required for spawn task"
    const revised = reqs[0]!.revisedArgs as Record<string, unknown>;
    expect(Object.keys(revised)[0]).toBe("lane"); // first, so the classic card's JSON.stringify(...).slice(0, 140) shows it
    expect(revised["lane"]).toBe(CARD);
    expect(JSON.stringify(reqs[0]!.revisedArgs).slice(0, 140)).toContain("spawn codex lane · sandbox workspace-write");
    expect(revised["agent"]).toBe("codex"); expect(revised["action"]).toBe("start");
    expect(reqs[0]!.args).toMatchObject({ action: "start", agent: "codex" }); // the original args are untouched
    expect(spawnedAtApproval).toBe(0); // the card came BEFORE any process (mutation target: approving after execute)
    expect(cmds).toHaveLength(1);
    const started = toolEnd(events, "p1");
    expect(started?.ok).toBe(true);
    expect(started?.output).toContain("task t1 (codex lane) started");
    expect(started?.output).toContain(`External codex lane — permissions: ${CARD}`);
    expect(toolEnd(events, "p2")?.output).toContain("Added 4 vitest cases for requireAuth.");
    expect(rt.tasks.status("t1")).toMatchObject({ kind: "external", status: "done", agent: "codex" });
    expect(existsSync(join(cwd, "lane-note.md"))).toBe(true);
    // a plain child start: the generic prompt, no lane key
    const child = await runLoop(cwd, lanes, "PARENT run a child", false);
    expect(child.reqs).toHaveLength(1);
    expect(child.reqs[0]!.reason).toBe("permission required for spawn task");
    expect("lane" in (child.reqs[0]!.revisedArgs as Record<string, unknown>)).toBe(false);
    expect(toolEnd(child.events, "p1")?.output).toContain("read-only");
    // yolo: no approver, no card — the lane still starts and finishes
    const y = await runLoop(cwd, lanes, "PARENT run a codex lane", true);
    expect(y.reqs).toHaveLength(0);
    expect(y.rt.tasks.status("t1")).toMatchObject({ kind: "external", status: "done" });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}, 60_000);

test("crew board: an external lane cell shows `id · adapter · isolated` while running and its permissions never leak into the goal row", () => {
  const now = 1_700_000_000_000;
  const t: TaskInfo = { id: "t3", label: "agy lane", agent: "agy", goal: "add a comment to README", isolated: true, depth: 1, status: "running", createdAt: now - 9_000, startedAt: now - 8_000, kind: "external", permissions: "spawn agy lane · soft-deny … · worktree", summary: "init · model gemini" };
  const s = baseState({ crew: [t], focus: "code" });
  Object.assign(s.code, { mode: "agents" });
  const g = new GridScreen(150, 26, "░");
  drawAgents(g, { x: 3, y: 2, w: 60, h: 20 }, s, THEME, now);
  const text = g.toText();
  expect(text).toContain("agy lane");
  expect(text).toContain("t3 · agy · isolated"); // the adapter id is the agent column
  expect(text).toContain("add a comment to README");
  expect(text).not.toContain("soft-deny");
  expect(text).toContain("running");
});
