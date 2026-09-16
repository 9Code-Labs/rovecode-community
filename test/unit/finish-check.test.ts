/** The finish check (core/loop.ts, the "done" exit). Two separate things are pinned here:
 *    REPRESENT — run_end carries `outstanding` (failed tool calls in the last turn, an unanswered ask_user,
 *                edit/write count, open todos, whether the check fired), and outstandingClause says it in one clause;
 *    NUDGE     — when the model goes silent right after a failed tool call or an unanswered question, ONE user-role
 *                turn asks it to finish or say what is left; the next silence ends the run whatever it says.
 *  Also pinned: the nudge is a turn (a spent --max-turns ends as "budget", not "done"); ROVECODE_FINISH_CHECK=0
 *  keeps the representation but never nudges; a permission denial is not a failure; and a clean run that wrote
 *  a file produces a run_end byte-identical to the one before this existed — no `outstanding` key at all.
 *  The first scenario is the fixture that found the bug on 2026-09-06: "Done — I created src/a.ts" after the write
 *  had been rejected (scripted through the real headless path in the session log; here through agentLoop). */

import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { agentLoop, assessOutstanding, finishCheckText, outstandingClause, SteeringQueue } from "../../src/core/loop.ts";
import { SessionStore } from "../../src/core/session.ts";
import { ToolRegistry } from "../../src/core/tools.ts";
import type { AgentDefinition, AssistantTurn, Message, RunConfig, RunEvent, RunOutstanding, StreamFn, Tool } from "../../src/core/types.ts";
import { textTurn, toolTurn } from "../../src/providers/stream.ts";
import { createRuntime } from "../../src/cli/runtime.ts";

const dirs: string[] = [];
function tmp(prefix = "rovecode-finish-"): string { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; }
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
afterEach(() => { delete process.env.ROVECODE_FINISH_CHECK; });

// ---------- a scripted model and tools that fail on purpose ----------
/** `write` fails while its parent directory is missing — the exact shape of the scripted proof */
const WRITE: Tool = {
  kind: "write", schema: { name: "write", description: "write a file", args: { type: "object" } },
  async execute(args) {
    const a = args as { path: string; content: string };
    if (!a.path.startsWith("src/") || !existsDir) return { ok: false, output: `ENOENT: no such directory for ${a.path}\nnothing written` };
    return { ok: true, output: `wrote ${a.path}` };
  },
};
let existsDir = false;
const MKDIR: Tool = { kind: "write", schema: { name: "mkdir", description: "make src/", args: { type: "object" } }, async execute() { existsDir = true; return { ok: true, output: "ok" }; } };
const ASK: Tool = { kind: "read", schema: { name: "ask_user", description: "ask", args: { type: "object" } }, async execute() { return { ok: false, output: "ask_user is unavailable in a headless run; decide with your best judgment" }; } };
const NOOP: Tool = { kind: "read", schema: { name: "noop", description: "nothing", args: { type: "object" } }, async execute() { return { ok: true, output: "ok" }; } };

const def: AgentDefinition = { name: "t", systemPrompt: "test", tools: ["*"] };
const cfg = (over: Partial<RunConfig>): RunConfig => ({ maxTurns: 60, contextBudgetTokens: 100_000, compactionThreshold: 0.8, parallelTools: true, permissionRules: [{ action: "*", resource: "*", effect: "allow" }], ...over });

/** the model: a queue of turns; every request's last user message is recorded so the test can see the nudge on the wire */
function scripted(turns: AssistantTurn[]): { stream: StreamFn; lastUser: string[] } {
  const lastUser: string[] = [];
  let n = 0;
  const stream: StreamFn = async function* (_m, messages: Message[]) {
    const u = [...messages].reverse().find((m) => m.role === "user");
    lastUser.push(u?.parts.map((p) => (p.kind === "text" ? p.text : "")).join("") ?? "");
    yield { type: "turn", turn: turns[Math.min(n++, turns.length - 1)]! };
  };
  return { stream, lastUser };
}

async function run(turns: AssistantTurn[], over: Partial<RunConfig> = {}, tools: Tool[] = [WRITE, MKDIR, ASK, NOOP]): Promise<{ events: RunEvent[]; lastUser: string[]; end: Extract<RunEvent, { type: "run_end" }> }> {
  existsDir = false;
  const registry = new ToolRegistry(); for (const t of tools) registry.register(t);
  const store = new SessionStore(tmp(), randomUUID());
  const { stream, lastUser } = scripted(turns);
  const events: RunEvent[] = [];
  for await (const ev of agentLoop(def, "create src/a.ts", {}, cfg(over), { stream, registry, store }, new SteeringQueue())) events.push(ev);
  const end = events.at(-1) as Extract<RunEvent, { type: "run_end" }>;
  expect(end.type).toBe("run_end");
  return { events, lastUser, end };
}

const WRITE_A = toolTurn([{ id: "c1", tool: "write", args: { path: "src/a.ts", content: "export const a = 1;\n" } }]);
const DONE = textTurn("Done — I created src/a.ts.");

// ---------- the fixture: write fails, model says "Done" ----------
test("fixture: a failed write followed by 'Done' is nudged ONCE, naming the tool; the model refusing again ends as done with the failure represented", async () => {
  const { events, lastUser, end } = await run([WRITE_A, DONE, textTurn("I could not create it; the src directory does not exist.")]);
  // three model calls: the write, the "Done", the answer to the check — and no fourth
  expect(lastUser.length).toBe(3);
  expect(lastUser[2]).toContain("<finish-check>");
  expect(lastUser[2]).toContain("a tool call failed and nothing after it recovered from that: write: ENOENT: no such directory for src/a.ts");
  expect(lastUser[2]).toContain("This check runs once per run");
  // the nudge is visible to every surface as a steer event, and is a real user-role message in the transcript
  expect(events.filter((e) => e.type === "steer").length).toBe(1);
  expect(end.status).toBe("done");
  expect(end.summary).toBe("I could not create it; the src directory does not exist.");
  expect(end.outstanding).toEqual({ failed: ["write: ENOENT: no such directory for src/a.ts"], unansweredAsk: false, writes: 0, nudged: true });
  expect(outstandingClause(end.outstanding!)).toBe("1 failed tool call not recovered (write)");
});

test("the proof's exact shape: write fails, todo_write marks the item completed, 'Done' — the failure one turn back is still outstanding", async () => {
  const TODO: Tool = { kind: "memory", schema: { name: "todo_write", description: "t", args: { type: "object" } }, async execute() { return { ok: true, output: "todos: 4 total · 1 completed" }; } };
  const { lastUser, end } = await run([WRITE_A, toolTurn([{ id: "t2", tool: "todo_write", args: { todos: [] } }]), DONE, textTurn("src/a.ts was not created: src/ does not exist.")], {}, [WRITE, TODO]);
  expect(lastUser.length).toBe(4);
  expect(lastUser[3]).toContain("write: ENOENT: no such directory for src/a.ts");
  expect(end.outstanding).toEqual({ failed: ["write: ENOENT: no such directory for src/a.ts"], unansweredAsk: false, writes: 0, nudged: true });
  // a non-file tool that failed earlier is NOT carried: bash exit 1 three turns back, then a clean write → nothing outstanding
  const BASH: Tool = { kind: "execute", schema: { name: "bash", description: "b", args: { type: "object" } }, async execute() { return { ok: false, output: "exit 1" }; } };
  const clean = await run([toolTurn([{ id: "b1", tool: "bash", args: {} }]), toolTurn([{ id: "c2", tool: "mkdir", args: {} }]), toolTurn([{ id: "c3", tool: "write", args: { path: "src/a.ts", content: "x" } }]), textTurn("Done.")], {}, [WRITE, MKDIR, BASH]);
  expect(clean.end).toEqual({ type: "run_end", status: "done", summary: "Done." });
});

test("fixture: the nudged model fixes it — mkdir, write again, 'Done' — and the run ends clean apart from nudged:true", async () => {
  const { lastUser, end } = await run([WRITE_A, DONE, toolTurn([{ id: "c2", tool: "mkdir", args: {} }]), toolTurn([{ id: "c3", tool: "write", args: { path: "src/a.ts", content: "x" } }]), textTurn("Done, for real this time.")]);
  expect(lastUser.length).toBe(5);
  expect(end.status).toBe("done");
  expect(end.outstanding).toEqual({ failed: [], unansweredAsk: false, writes: 1, nudged: true });
  expect(outstandingClause(end.outstanding!)).toBeNull();          // nothing left to say: the clause is for open work only
});

test("once only: a second failure after the nudge is accepted — represented, never nudged again", async () => {
  // write fails → "Done" → nudge → write fails AGAIN → "Done" → the run ends; no second check
  const { lastUser, events, end } = await run([WRITE_A, DONE, WRITE_A, DONE]);
  expect(lastUser.length).toBe(4);
  expect(events.filter((e) => e.type === "steer").length).toBe(1);
  expect(end.status).toBe("done");
  expect(end.outstanding).toMatchObject({ failed: ["write: ENOENT: no such directory for src/a.ts"], nudged: true });
});

test("the nudge is a turn: --max-turns 2 spent on write+'Done' ends as budget, not done, and the check is not asked", async () => {
  const { lastUser, end } = await run([WRITE_A, DONE, DONE], { maxTurns: 2 });
  expect(lastUser.length).toBe(2);                                   // the third call would have been the nudge; the cap is checked first
  expect(end.status).toBe("budget");
  expect(end.summary).toBe("max turns (2) reached");
  expect("outstanding" in end).toBe(false);                          // only the "done" exit represents
});

test("an unanswered ask_user is the other trigger: nudged once, then represented as 'its question to you went unanswered'", async () => {
  const { lastUser, end } = await run([toolTurn([{ id: "q1", tool: "ask_user", args: { question: "black or white?" } }]), textTurn("Let me know which you prefer."), textTurn("I will go with black — but I need your answer to proceed.")]);
  expect(lastUser.length).toBe(3);
  expect(lastUser[2]).toContain("your question to the user was not answered");
  expect(end.status).toBe("done");
  expect(end.outstanding).toEqual({ failed: [], unansweredAsk: true, writes: 0, nudged: true });
  expect(outstandingClause(end.outstanding!)).toBe("its question to you went unanswered");
});

test("byte-identical: a clean run that wrote a file ends exactly as before — no outstanding key, no steer", async () => {
  const { events, end } = await run([toolTurn([{ id: "c2", tool: "mkdir", args: {} }]), toolTurn([{ id: "c3", tool: "write", args: { path: "src/a.ts", content: "x" } }]), textTurn("Created src/a.ts.")]);
  expect(end).toEqual({ type: "run_end", status: "done", summary: "Created src/a.ts." });
  expect(events.some((e) => e.type === "steer")).toBe(false);
});

test("prose on a run that changed nothing is NOT a nudge and NOT a finding: 'what MCPs are configured' ends byte-identical to before", async () => {
  const { events, end } = await run([toolTurn([{ id: "n1", tool: "noop", args: {} }]), textTurn("You have two MCP servers configured.")]);
  expect(events.some((e) => e.type === "steer")).toBe(false);
  expect(end).toEqual({ type: "run_end", status: "done", summary: "You have two MCP servers configured." });
});

test("scope: a failed call from the PREVIOUS run on the same session is not this run's failure", async () => {
  const store = new SessionStore(tmp(), randomUUID());
  const registry = new ToolRegistry(); registry.register(WRITE); registry.register(NOOP);
  const go = async (turns: AssistantTurn[]) => { const ev: RunEvent[] = []; existsDir = false; for await (const e of agentLoop(def, "go", {}, cfg({}), { stream: scripted(turns).stream, registry, store }, new SteeringQueue())) ev.push(e); return ev; };
  const first = await go([WRITE_A, DONE, textTurn("could not")]);
  expect(first.filter((e) => e.type === "steer").length).toBe(1);
  const second = await go([textTurn("hello again")]);
  expect(second.some((e) => e.type === "steer")).toBe(false);
  expect(second.at(-1)).toEqual({ type: "run_end", status: "done", summary: "hello again" });
});

test("the loop guard's stub and an abort are harness verdicts, not failures: no nudge", async () => {
  const STUB: Tool = { kind: "read", schema: { name: "probe", description: "p", args: { type: "object" } }, async execute() { return { ok: false, output: "[rovecode loop guard: blocked probe — this is the 6th consecutive call]" }; } };
  const { events, end } = await run([toolTurn([{ id: "p1", tool: "probe", args: {} }]), textTurn("LOOP-BROKEN")], {}, [STUB]);
  expect(events.some((e) => e.type === "steer")).toBe(false);
  expect(end).toEqual({ type: "run_end", status: "done", summary: "LOOP-BROKEN" });
});

test("a failure the model already recovered from is not outstanding: write fails, write succeeds, 'Done' → clean", async () => {
  const { events, end } = await run([WRITE_A, toolTurn([{ id: "c2", tool: "mkdir", args: {} }]), toolTurn([{ id: "c3", tool: "write", args: { path: "src/a.ts", content: "x" } }]), textTurn("Done.")]);
  expect(events.some((e) => e.type === "steer")).toBe(false);
  expect(end).toEqual({ type: "run_end", status: "done", summary: "Done." });
});

test("finishCheck:false keeps the representation and never nudges", async () => {
  const { lastUser, events, end } = await run([WRITE_A, DONE], { finishCheck: false });
  expect(lastUser.length).toBe(2);
  expect(events.some((e) => e.type === "steer")).toBe(false);
  expect(end.outstanding).toEqual({ failed: ["write: ENOENT: no such directory for src/a.ts"], unansweredAsk: false, writes: 0, nudged: false });
});

test("a permission denial is the user's decision, not a failure: no nudge, not in failed", async () => {
  const DENY: Tool = { kind: "write", schema: { name: "write", description: "w", args: { type: "object" } }, async execute() { return { ok: true, output: "unreachable" }; } };
  const { events, end } = await run([WRITE_A, textTurn("Understood, I will not write that.")], { permissionRules: [{ action: "*", resource: "*", effect: "deny" }] }, [DENY]);
  expect(events.some((e) => e.type === "steer")).toBe(false);
  expect(end).toEqual({ type: "run_end", status: "done", summary: "Understood, I will not write that." });
});

// ---------- the pieces on their own ----------
test("assessOutstanding reads the transcript: last tool-bearing turn only, edit/write counted over the whole run, todos attached when present", () => {
  const m = (role: Message["role"], parts: Message["parts"]): Message => ({ id: randomUUID(), role, parts, parentId: null, createdAt: 0 });
  const history: Message[] = [
    m("user", [{ kind: "text", text: "go" }]),
    m("assistant", [{ kind: "tool_call", id: "a", tool: "edit", args: {} }, { kind: "tool_call", id: "b", tool: "bash", args: {} }]),
    m("tool", [{ kind: "tool_result", callId: "a", ok: true, output: "edited" }, { kind: "tool_result", callId: "b", ok: false, output: "exit 1\nstack…" }]),
    m("assistant", [{ kind: "text", text: "done" }]),
  ];
  const o = assessOutstanding(history, { open: 3, total: 4 }, false);
  expect(o).toEqual({ failed: ["bash: exit 1"], unansweredAsk: false, writes: 1, todosOpen: 3, todosTotal: 4, nudged: false });
  expect(outstandingClause(o)).toBe("1 failed tool call not recovered (bash) · 3 of 4 items still open");
  expect(finishCheckText(o)).toContain("your own todo list still has 3 of 4 items open");
  // an empty todo list is not attached, and all-complete is attached but silent in the clause
  expect(assessOutstanding(history, { open: 0, total: 0 }, false)).not.toHaveProperty("todosTotal");
  expect(outstandingClause(assessOutstanding(history.slice(0, 1), { open: 0, total: 2 }, false))).toBeNull();
});

test("runtime.buildCfg: the check is on by default, ROVECODE_FINISH_CHECK=0 turns it off, and todoState reads this session's todos.json", () => {
  const cwd = tmp("rovecode-finish-cwd-");
  const rt = createRuntime({ cwd, sessionId: "sess-fc", stream: null });
  const on = rt.buildCfg(true);
  expect(on.finishCheck).toBe(true);
  expect(on.todoState?.()).toBeNull();                               // no todos.json yet
  const dir = join(cwd, ".rovecode", "sessions", "sess-fc"); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "todos.json"), JSON.stringify({ version: 1, items: [{ id: "t1", content: "a", status: "completed" }, { id: "t2", content: "b", status: "pending" }, { id: "t3", content: "c", status: "in_progress" }] }));
  expect(on.todoState?.()).toEqual({ open: 2, total: 3 });
  process.env.ROVECODE_FINISH_CHECK = "0";
  expect(createRuntime({ cwd, sessionId: "sess-fc2", stream: null }).buildCfg(true).finishCheck).toBe(false);
});

// silence the unused-import check for the type we only use in a cast above
export type _O = RunOutstanding;
