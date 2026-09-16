/** Custom subagent definitions through a REAL runtime (createRuntime → TaskManager → orchestrator runChild → the ONE
 *  agentLoop). `.rovecode/agents/*.md` load at boot (invalid → warnings on the plugin channel, no crash); `task start
 *  {agent:"<name>"}` runs the child with the definition's MODEL and MODE and a ToolRegistry restricted to its allow-list;
 *  the spy sits on orchestrator.runChild (call-through) so the def and the registry factory the TaskManager actually hands
 *  the child are inspected — same ToolRegistry class, no second registry. Unknown names are refused as data; widening
 *  (names outside the child table) is clamped; a reserved lane id is refused at discovery and `task start codex` stays
 *  the lane. Hermetic: temp cwd, ROVECODE_HOME → scratch, checkpoints off, scripted provider, every wait deadline-bounded. */

import { test, expect, afterEach, spyOn } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime } from "../../src/cli/runtime.ts";
import { agentLoop, SteeringQueue } from "../../src/core/loop.ts";
import { ToolRegistry } from "../../src/core/tools.ts";
import { resetExecutor } from "../../src/core/executor.ts";
import * as orchestrator from "../../src/core/orchestrator.ts";
import { textTurn, toolTurn } from "../../src/providers/stream.ts";
import { planModePromptSection } from "../../src/core/modes.ts";
import type { AssistantTurn, Message, ModelRef, RunEvent, StreamEvent, StreamFn, StreamOptions } from "../../src/core/types.ts";

afterEach(() => resetExecutor());

const ENV_KEYS = ["ROVECODE_HOME", "ROVECODE_NO_CHECKPOINTS", "ROVECODE_SANDBOX", "ROVECODE_TOOL_MIDDLEWARE", "ROVECODE_NO_REPOMAP", "ROVECODE_FINISH_CHECK", "ROVECODE_LANES_ALLOW"];
function envScope(home: string): () => void {
  const saved = new Map(ENV_KEYS.map((k) => [k, process.env[k]] as const));
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.ROVECODE_HOME = home;
  process.env.ROVECODE_NO_CHECKPOINTS = "1";
  process.env.ROVECODE_NO_REPOMAP = "1";
  process.env.ROVECODE_LANES_ALLOW = ""; // lanes are ON by default since 2026-09-07; this file's subject is agent DEFINITIONS, and a real `codex` on the box would otherwise make it spawn one
  process.env.ROVECODE_FINISH_CHECK = "0"; // the children here end on a failed call on purpose (denied write, unknown edit); the finish check would add a turn that is not this test's subject
  return () => { for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
}
function deadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const bomb = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error(`${what}: not settled within ${ms}ms`)), ms); });
  return Promise.race([p, bomb]).finally(() => { if (t !== undefined) clearTimeout(t); });
}

const text = (m: Message): string => m.parts.filter((p) => p.kind === "text").map((p) => (p as { text: string }).text).join("");
const goalOf = (messages: Message[]): string => { const u = messages.find((m) => m.role === "user"); return u ? text(u) : ""; };
const toolResults = (messages: Message[]): string[] =>
  messages.filter((m) => m.role === "tool").flatMap((m) => m.parts.filter((p) => p.kind === "tool_result").map((p) => (p as { output: string }).output));
const turn = (t: AssistantTurn): StreamEvent => ({ type: "turn", turn: t });

/** the two definitions + the invalid files every test writes; returns their paths */
function writeDefinitions(cwd: string): Record<string, string> {
  const dir = join(cwd, ".rovecode", "agents");
  mkdirSync(dir, { recursive: true });
  const paths: Record<string, string> = {};
  const put = (file: string, body: string): void => { paths[file] = join(dir, file); writeFileSync(paths[file]!, body, "utf8"); };
  // allow-list mixes child-table tools (read/grep/glob/write) with names the PARENT registry has but children never get
  // (web_fetch, memory_edit) and one nobody has (mcp_call) — the filter must keep exactly the first four
  put("explore.md", "---\ndescription: Fast codebase explorer\nmodel: mock/scout\nmode: plan\ntools: read, grep, glob, write, web_fetch, memory_edit, mcp_call\n---\nYou are the explorer. Answer in one line.\n");
  put("writer.md", "---\ndescription: Writes files\nmodel: fast\ntools: [read, edit, write]\n---\n"); // bare model id → the parent's provider; empty body → the runtime prompt
  put("broken.md", "---\nmode: turbo\n---\nx\n");
  put("main.md", "---\ndescription: cannot shadow the built-in\n---\nx\n");
  put("codex.md", "---\ndescription: cannot shadow the lane\n---\nx\n");
  return paths;
}

interface Recorded { goal: string; model: ModelRef; system: string; messages: Message[]; tools: string[] }

/** Parent (goal "PARENT <agent>"): T1 `task start {agent}`, T2 `task_status result`, T3 done. Children (goal "CHILD …"):
 *  T1 a write into cwd + an `edit` call, T2 the tool results as text. Records every request (incl. the tool schemas the
 *  request carried). The parent runs share one session store, so a run's identity is the LAST goal-shaped user message. */
function scripted(recorded: Recorded[], cwd: string): StreamFn {
  return async function* (model: ModelRef, allMessages: Message[], o?: StreamOptions): AsyncGenerator<StreamEvent> {
    const start = allMessages.findLastIndex((m) => m.role === "user" && /^(PARENT|CHILD)/.test(text(m)));
    const messages = allMessages.slice(Math.max(0, start));
    const goal = goalOf(messages);
    const sys = allMessages.find((m) => m.role === "system");
    recorded.push({ goal, model, system: sys ? text(sys) : "", messages: messages.map((m) => ({ ...m, parts: [...m.parts] })), tools: (o?.tools ?? []).map((t) => t.name) });
    const tools = messages.filter((m) => m.role === "tool").length;
    if (goal.startsWith("PARENT")) {
      const agent = goal.split(" ")[1]!;
      if (tools === 0) { yield turn(toolTurn([{ id: "p1", tool: "task", args: { action: "start", agent, goal: `CHILD via ${agent}`, label: agent } }])); return; }
      const started = /task (t\d+) \(/.exec(toolResults(messages)[0] ?? "");
      if (tools === 1 && started) { yield turn(toolTurn([{ id: "p2", tool: "task_status", args: { action: "result", id: started[1], timeout_ms: 20_000 } }])); return; }
      yield turn(textTurn(`PARENT-DONE: ${toolResults(messages).at(-1) ?? ""}`)); return;
    }
    if (tools === 0) {
      const file = join(cwd, `${goal.split(" ").at(-1)}.txt`);
      yield turn(toolTurn([{ id: "c1", tool: "write", args: { path: file, content: "child wrote\n" } }, { id: "c2", tool: "edit", args: { path: file, edits: [] } }]));
      return;
    }
    yield turn(textTurn(`CHILD-DONE: ${toolResults(messages).join(" | ")}`));
  };
}

async function runParent(rt: ReturnType<typeof createRuntime>, stream: StreamFn, goal: string): Promise<RunEvent[]> {
  const events: RunEvent[] = [];
  const def = rt.buildDef({ provider: "mock", model: "parent-model" }); // the starting run's model — children of `main` inherit it
  const cfg = rt.buildCfg(true); // yolo: allow-all, so only a definition's plan mode can deny
  for await (const ev of agentLoop(def, goal, {}, cfg, { stream, registry: rt.registry, store: rt.store, tools: rt.registry.list().map((t) => t.schema), guard: rt.guard, cwd: rt.cwd }, rt.steering)) events.push(ev);
  return events;
}
const toolEnd = (events: RunEvent[], callId: string): string => {
  const e = events.find((ev) => ev.type === "tool_execution_end" && ev.callId === callId);
  return e && e.type === "tool_execution_end" ? e.output : "";
};

test("boot: definitions load once into rt.agents (invalid → warnings, no crash), the `task` schema enumerates them, and a defined agent runs with ITS model, mode and a registry restricted to its allow-list — through the real TaskManager and runChild", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-agents-wire-"));
  const home = mkdtempSync(join(tmpdir(), "rovecode-agents-home-"));
  const restore = envScope(home);
  const paths = writeDefinitions(cwd);
  const recorded: Recorded[] = [];
  const stream = scripted(recorded, cwd);
  const runChild = spyOn(orchestrator, "runChild"); // installed BEFORE createRuntime: TaskManager binds the runner at construction
  try {
    const rt = createRuntime({ cwd, stream, sessionId: "agents-wire" });
    try {
      // loaded at boot, with source; the invalid files are warnings, never a throw; the same lines rode the plugin channel
      expect(rt.agents.agents.map((a) => [a.name, a.scope, a.path])).toEqual([["explore", "project", paths["explore.md"]!], ["writer", "project", paths["writer.md"]!]]);
      expect(rt.agents.warnings).toEqual([
        `${paths["broken.md"]}: skipped — mode must be "plan" or "act" (got "turbo")`,
        `${paths["codex.md"]}: skipped — "codex" is a reserved agent name (the codex external lane keeps it; \`task start codex\` runs the lane, never this file)`,
        `${paths["main.md"]}: skipped — "main" is a reserved agent name`,
      ]);
      for (const w of rt.agents.warnings) expect(rt.plugins.warnings).toContain(`agents: ${w}`);
      // the parent's `task` schema enumerates the loaded names
      const task = rt.registry.list().find((t) => t.schema.name === "task")!;
      expect(task.schema.description).toContain("explore — Fast codebase explorer; writer — Writes files");
      expect((task.schema.args["properties"] as Record<string, { description: string }>)["agent"]!.description).toContain("custom: explore, writer");
      // `task start codex` is the lane, not a file. Lanes are ON by default now, so what proves the
      // SHADOWING here is the kill switch this file sets (ROVECODE_LANES_ALLOW=""): the refusal talks
      // about the lane's allow-list, never "unknown agent" — i.e. the reserved id won, and the codex.md
      // that was skipped above did not quietly get run in its place.
      rt.buildDef({ provider: "mock", model: "parent-model" });
      const lane = rt.tasks.start({ agent: "codex", goal: "x" });
      expect(lane.ok).toBe(false);
      if (!lane.ok) { expect(lane.reason).not.toContain("unknown agent"); expect(lane.reason).toContain("external lane 'codex'"); }

      // ---- explore: model mock/scout, mode plan, tools read/grep/glob/write ----
      const events = await deadline(runParent(rt, stream, "PARENT explore"), 20_000, "parent run (explore)");
      expect(events.at(-1)).toMatchObject({ type: "run_end", status: "done" });
      expect(toolEnd(events, "p1")).toContain("task t1 (explore) started");
      expect(rt.tasks.status("t1")).toMatchObject({ status: "done", agent: "explore", depth: 1 });
      // the runner the TaskManager launched: the def it received IS the definition's (mutation: model not applied → parent-model)
      expect(runChild).toHaveBeenCalledTimes(1);
      const [deps, req] = runChild.mock.calls[0]!;
      expect(req.agent).toBe("explore");
      const def = deps.defs.get("explore")!;
      expect(def).toMatchObject({ name: "explore", model: { provider: "mock", model: "scout" }, mode: "plan", tools: ["read", "grep", "glob", "write", "web_fetch", "memory_edit", "mcp_call"] });
      expect(deps.defs.get("main")).toMatchObject({ name: "main", model: { provider: "mock", model: "parent-model" }, tools: ["*"] }); // main untouched beside it
      expect(deps.defs.has("broken")).toBe(false);
      expect(deps.defs.has("codex")).toBe(false);
      // the registry factory the child ran with: the SAME ToolRegistry class, holding exactly allow-list ∩ child table (mutation: filter dropped → edit/bash/ls… appear)
      const childReg = deps.registryFactory(def, cwd, { depth: 1, steering: new SteeringQueue() });
      expect(childReg).toBeInstanceOf(ToolRegistry);
      expect(childReg.list().map((t) => t.schema.name)).toEqual(["read", "write", "glob", "grep"]);
      expect(rt.registry.list().map((t) => t.schema.name)).toEqual(expect.arrayContaining(["web_fetch", "memory_edit"])); // the parent HAS them — the child still does not
      // and what the child actually SAW: its model, the definition's body as system prompt + the plan section, exactly its
      // tools on the wire (the request carried schemas at all — before this fix a child request carried none)
      const child = recorded.filter((r) => r.goal === "CHILD via explore");
      expect(child).toHaveLength(2);
      expect(child[0]!.model).toMatchObject({ provider: "mock", model: "scout" });
      expect(child[0]!.system).toContain("You are the explorer. Answer in one line.");
      expect(child[0]!.system).toContain(planModePromptSection());
      expect(child[0]!.system).not.toContain("You are Rovecode"); // the body REPLACES the runtime prompt
      expect(child[0]!.tools).toEqual(["read", "write", "glob", "grep"]);
      const results = toolResults(child[1]!.messages);
      expect(results[0]).toContain("Permission denied"); // write: in the registry, denied by the plan rules even under a yolo parent (mutation: applyModeRules dropped → the file lands)
      expect(results[1]).toContain("unknown tool 'edit'"); // edit: outside the allow-list → not in the child's registry at all
      expect(existsSync(join(cwd, "explore.txt"))).toBe(false);
      expect(toolEnd(events, "p2")).toContain("CHILD-DONE");

      // ---- writer: bare `model: fast` → the parent's provider; no mode → act; empty body → the runtime prompt; write lands ----
      const events2 = await deadline(runParent(rt, stream, "PARENT writer"), 20_000, "parent run (writer)");
      expect(events2.at(-1)).toMatchObject({ type: "run_end", status: "done" });
      const w = recorded.filter((r) => r.goal === "CHILD via writer");
      expect(w[0]!.model).toMatchObject({ provider: "mock", model: "fast" });
      expect(w[0]!.system).toContain("You are Rovecode");
      expect(w[0]!.system).not.toContain(planModePromptSection()) // the inherited runtime prompt MENTIONS "# Plan Mode" in prose; the SECTION itself is what a plan-mode child gets;
      expect(w[0]!.tools).toEqual(["read", "edit", "write"]);
      expect(existsSync(join(cwd, "writer.txt"))).toBe(true);
      const wdef = runChild.mock.calls[1]![0].defs.get("writer")!;
      expect(wdef.mode).toBeUndefined();
      expect(wdef.tools).toEqual(["read", "edit", "write"]);
      // the parent's ACTIVE model was never re-pointed by a definition's model (buildDef with an agent has no side effect)
      expect(runChild.mock.calls[1]![0].defs.get("main")!.model).toMatchObject({ provider: "mock", model: "parent-model" });
      expect(rt.tasks.list().map((t) => [t.agent, t.status])).toEqual([["explore", "done"], ["writer", "done"]]);
      // a `main` child carries the child table and never a root-only tool
      const mainReg = deps.registryFactory(deps.defs.get("main")!, cwd, { depth: 1, steering: new SteeringQueue() });
      const mainNames = mainReg.list().map((t) => t.schema.name);
      expect(mainNames).toEqual(expect.arrayContaining(["read", "edit", "write", "bash", "glob", "grep", "ls", "task", "task_status"]));
      for (const n of ["web_fetch", "memory_edit", "ask_user", "todo_write"]) expect(mainNames).not.toContain(n);
    } finally {
      rt.tasks.cancelAll();
      await deadline(rt.tasks.drain(3_000), 5_000, "drain");
      await deadline(rt.hooks.close(), 5_000, "hooks close");
    }
  } finally {
    runChild.mockRestore();
    restore();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}, 60_000);

test("an unknown agent name is refused as DATA — the tool output says so, no task record exists, no child stream call, nothing thrown; the same from TaskManager.start directly (a skipped file is not an agent; names are exact)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-agents-unknown-"));
  const home = mkdtempSync(join(tmpdir(), "rovecode-agents-home-"));
  const restore = envScope(home);
  writeDefinitions(cwd);
  const recorded: Recorded[] = [];
  const stream = scripted(recorded, cwd);
  try {
    const rt = createRuntime({ cwd, stream, sessionId: "agents-unknown" });
    try {
      const events = await deadline(runParent(rt, stream, "PARENT nope"), 20_000, "parent run (unknown agent)");
      expect(events.at(-1)).toMatchObject({ type: "run_end", status: "done" });
      // MUTATION TARGET: `deps.defs.get(req.agent) ?? deps.defs.get("main")` in TaskManager.start → a child runs as main
      expect(toolEnd(events, "p1")).toBe("Error: task refused: unknown agent 'nope'");
      expect(rt.tasks.list()).toEqual([]);
      expect(recorded.some((r) => r.goal.startsWith("CHILD"))).toBe(false);
      rt.buildDef({ provider: "mock", model: "m" });
      expect(rt.tasks.start({ agent: "Explore", goal: "case matters" })).toEqual({ ok: false, reason: "unknown agent 'Explore'" });
      expect(rt.tasks.start({ agent: "broken", goal: "a skipped file is not an agent" })).toEqual({ ok: false, reason: "unknown agent 'broken'" });
      expect(rt.tasks.start({ agent: "explore", goal: "the real one starts" })).toMatchObject({ ok: true });
    } finally {
      rt.tasks.cancelAll();
      await deadline(rt.tasks.drain(3_000), 5_000, "drain");
      await deadline(rt.hooks.close(), 5_000, "hooks close");
    }
  } finally {
    restore();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}, 40_000);

test("transitive allow-list: a child started FROM a restricted agent's nested `task` is clamped to that agent's set — `main` started by `narrow` (tools: read, task, task_status) gets read only, never write/bash", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-agents-nested-"));
  const home = mkdtempSync(join(tmpdir(), "rovecode-agents-home-"));
  const restore = envScope(home);
  mkdirSync(join(cwd, ".rovecode", "agents"), { recursive: true });
  writeFileSync(join(cwd, ".rovecode", "agents", "narrow.md"), "---\ndescription: narrow\ntools: read, task, task_status\n---\nNarrow.\n", "utf8");
  const recorded: Recorded[] = [];
  // PARENT → task start narrow; narrow child → task start main (nested); main grandchild → a write (must be unknown to it)
  const stream: StreamFn = async function* (model: ModelRef, allMessages: Message[], o?: StreamOptions): AsyncGenerator<StreamEvent> {
    const start = allMessages.findLastIndex((m) => m.role === "user" && /^(PARENT|CHILD|GRAND)/.test(text(m)));
    const messages = allMessages.slice(Math.max(0, start));
    const goal = goalOf(messages);
    recorded.push({ goal, model, system: "", messages: [], tools: (o?.tools ?? []).map((t) => t.name) });
    const tools = messages.filter((m) => m.role === "tool").length;
    const started = /task (t\d+) \(/.exec(toolResults(messages)[0] ?? "");
    if (goal.startsWith("PARENT")) {
      if (tools === 0) { yield turn(toolTurn([{ id: "p1", tool: "task", args: { action: "start", agent: "narrow", goal: "CHILD narrow", label: "narrow" } }])); return; }
      if (tools === 1 && started) { yield turn(toolTurn([{ id: "p2", tool: "task_status", args: { action: "result", id: started[1], timeout_ms: 20_000 } }])); return; }
      yield turn(textTurn(`PARENT-DONE: ${toolResults(messages).at(-1) ?? ""}`)); return;
    }
    if (goal.startsWith("CHILD")) {
      if (tools === 0) { yield turn(toolTurn([{ id: "n1", tool: "task", args: { action: "start", agent: "main", goal: "GRAND main", label: "grand" } }])); return; }
      if (tools === 1 && started) { yield turn(toolTurn([{ id: "n2", tool: "task_status", args: { action: "result", id: started[1], timeout_ms: 20_000 } }])); return; }
      yield turn(textTurn(`CHILD-DONE: ${toolResults(messages).at(-1) ?? ""}`)); return;
    }
    if (tools === 0) { yield turn(toolTurn([{ id: "g1", tool: "write", args: { path: join(cwd, "grand.txt"), content: "x" } }])); return; }
    yield turn(textTurn(`GRAND-DONE: ${toolResults(messages).join(" | ")}`));
  };
  try {
    const rt = createRuntime({ cwd, stream, sessionId: "agents-nested" });
    try {
      const events = await deadline(runParent(rt, stream, "PARENT go"), 30_000, "parent run (nested)");
      expect(events.at(-1)).toMatchObject({ type: "run_end", status: "done" });
      const grand = recorded.filter((r) => r.goal === "GRAND main");
      expect(grand.length).toBeGreaterThan(0);
      expect(grand[0]!.tools).toEqual(["read", "task", "task_status"]); // main's "*" ∩ the child table ∩ narrow's own set; MUTATION: parentTools not threaded → the full child table (write, bash, …)
      expect(existsSync(join(cwd, "grand.txt"))).toBe(false);
      expect(toolEnd(events, "p2")).toContain("unknown tool 'write'");
      const narrow = recorded.filter((r) => r.goal === "CHILD narrow");
      expect(narrow[0]!.tools).toEqual(["read", "task", "task_status"]);
    } finally {
      rt.tasks.cancelAll();
      await deadline(rt.tasks.drain(3_000), 5_000, "drain");
      await deadline(rt.hooks.close(), 5_000, "hooks close");
    }
  } finally {
    restore();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}, 60_000);
