import { test, expect } from "bun:test";
import { agentLoop, SteeringQueue, partsTokenText } from "../../src/core/loop.ts";
import { ToolRegistry } from "../../src/core/tools.ts";
import { SessionStore, type Entry } from "../../src/core/session.ts";
import { mockStream, textTurn, toolTurn } from "../../src/providers/stream.ts";
import { readTool, writeTool } from "../../src/coding/hashline.ts";
import { exportSession } from "../../src/cli/export.ts";
import type { AgentDefinition, RunConfig, RunEvent, Tool } from "../../src/core/types.ts";
import type { Message, ModelRef, StreamEvent, StreamFn } from "../../src/core/types.ts";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const allowAll = [
  { action: "*", resource: "*", effect: "allow" as const },
];

function cfg(over: Partial<RunConfig> = {}): RunConfig {
  return {
    maxTurns: 8, contextBudgetTokens: 100_000, compactionThreshold: 0.8,
    parallelTools: true,
    permissionRules: allowAll, ...over,
  };
}

const baseDef: AgentDefinition = {
  name: "t", systemPrompt: "test agent", tools: ["*"], maxTurns: 8,
};

test("loop completes a plain turn", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-loop-"));
  const store = new SessionStore(dir, randomUUID());
  const events: string[] = [];
  for await (const ev of agentLoop(baseDef, "hi", {}, cfg(), {
    stream: mockStream({ turns: [textTurn("PONG")] }),
    registry: new ToolRegistry(),
    store,
  }, new SteeringQueue())) {
    events.push(ev.type);
  }
  expect(events[0]).toBe("run_start");
  expect(events.at(-1)).toBe("run_end");
  const end = events.filter((e) => e === "turn_end").length;
  expect(end).toBe(1);
  rmSync(dir, { recursive: true, force: true });
});

test("loop executes tool then finishes (multi-turn)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-loop-"));
  const ws = join(dir, "ws"); writeFileSync(join(ws + ".txt", ""), ""); // noop
  writeFileSync(join(dir, "note.txt"), "value=42");
  const store = new SessionStore(dir, randomUUID());
  const reg = new ToolRegistry();
  reg.register(readTool);
  const stream = mockStream({
    turns: [
      toolTurn([{ id: "c1", tool: "read", args: { path: join(dir, "note.txt") } }]),
      textTurn("the value is 42"),
    ],
  });
  let finalText = "";
  for await (const ev of agentLoop({ ...baseDef }, "read note", {}, cfg(), {
    stream, registry: reg, store,
  }, new SteeringQueue())) {
    if (ev.type === "run_end") finalText = ev.summary;
  }
  expect(finalText).toContain("42");
  rmSync(dir, { recursive: true, force: true });
});

test("truncated stopReason fails tool calls unexecuted", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-loop-"));
  const store = new SessionStore(dir, randomUUID());
  const reg = new ToolRegistry();
  let executed = 0;
  const countingTool: Tool = {
    schema: { name: "count", description: "count", args: { type: "object" } },
    kind: "custom", async execute() { executed++; return { ok: true, output: "ok" }; },
  };
  reg.register(countingTool);
  const stream = mockStream({
    turns: [
      { parts: [{ kind: "tool_call", id: "t1", tool: "count", args: {} }], stopReason: "length", usage: { input: 0, output: 0 } },
      textTurn("done after truncation"),
    ],
  });
  const failures: string[] = [];
  for await (const ev of agentLoop(baseDef, "go", {}, cfg(), { stream, registry: reg, store }, new SteeringQueue())) {
    if (ev.type === "tool_call_failed") failures.push(ev.reason);
  }
  expect(failures).toContain("truncated");
  expect(executed).toBe(0);
  rmSync(dir, { recursive: true, force: true });
});

test("budget stop when maxTurns exceeded", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-loop-"));
  const store = new SessionStore(dir, randomUUID());
  const reg = new ToolRegistry();
  const echoTool: Tool = {
    schema: { name: "echo", description: "echo", args: { type: "object" } },
    kind: "custom", async execute() { return { ok: true, output: "echoed" }; },
  };
  reg.register(echoTool);
  let status = "";
  for await (const ev of agentLoop(baseDef, "loop", {}, cfg({ maxTurns: 3 }), {
    stream: mockStream({ turns: [toolTurn([{ id: "x", tool: "echo", args: {} }])] }),
    registry: reg, store,
  }, new SteeringQueue())) {
    if (ev.type === "run_end") status = ev.status;
  }
  expect(status).toBe("budget");
  rmSync(dir, { recursive: true, force: true });
});

test("write tool actually writes through the pipeline", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-loop-"));
  const store = new SessionStore(dir, randomUUID());
  const reg = new ToolRegistry();
  reg.register(writeTool);
  for await (const ev of agentLoop(baseDef, "write", {}, cfg(), {
    stream: mockStream({ turns: [toolTurn([{ id: "w1", tool: "write", args: { path: join(dir, "out.txt"), content: "written" } }]), textTurn("written")] }),
    registry: reg, store,
  }, new SteeringQueue())) { void ev; }
  expect(readFileSync(join(dir, "out.txt"), "utf8")).toBe("written");
  rmSync(dir, { recursive: true, force: true });
});

// regression (port #6 (b)): the compaction trigger counts ALL parts — a tool-result-heavy
// history whose PROSE is tiny must still trip it (text-only counting reads ~0 forever)
test("compaction triggers on tool-result-heavy history, not just prose", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-loop-"));
  const store = new SessionStore(dir, randomUUID());
  const reg = new ToolRegistry();
  const bigTool: Tool = {
    schema: { name: "big", description: "big output", args: { type: "object" } },
    kind: "custom", async execute() { return { ok: true, output: "R".repeat(400) }; },
  };
  const smallTool: Tool = {
    schema: { name: "small", description: "small output", args: { type: "object" } },
    kind: "custom", async execute() { return { ok: true, output: "ok" }; },
  };
  reg.register(bigTool, smallTool);
  // turn 1: bare tool call (zero prose) → 400-char tool_result lands in history;
  // turn 2 start: text-only tokens ≈ 3 (goal only), all-parts tokens ≈ 105 — only the
  // all-parts counter crosses budget(100) × threshold(0.5). The oversized result is the LAST
  // message there, so that compaction keeps it with its call (a tail is never empty — port #25);
  // turn 2's small call pushes it into the head and turn 3's compaction hands it to the summarizer
  const summarizeInputs: string[][] = [];
  let compactions = 0;
  for await (const ev of agentLoop(baseDef, "go", {}, cfg({ contextBudgetTokens: 100, compactionThreshold: 0.5 }), {
    stream: mockStream({ turns: [toolTurn([{ id: "c1", tool: "big", args: {} }]), toolTurn([{ id: "c2", tool: "small", args: {} }]), textTurn("done")] }),
    registry: reg, store,
    summarize: async (texts) => { summarizeInputs.push(texts); return "SUMMARY"; },
  }, new SteeringQueue())) {
    if (ev.type === "compaction" && ev.strategy === "head-summarize") compactions++;
  }
  expect(compactions).toBeGreaterThanOrEqual(1);
  // the summarizer saw the tool traffic, not empty prose
  expect(summarizeInputs.flat().join("\n")).toContain("R".repeat(400));
  // and the forced-kept tail never orphaned the persisted chain (the summary is not a store entry)
  expect(new SessionStore(dir, store.id).reload()).toEqual([]);
  rmSync(dir, { recursive: true, force: true });
});

// regression: plan.keep projections must be mapped back to real messages (loop.ts compaction)
test("compaction rebuilds history from real messages, not projections", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-loop-"));
  const store = new SessionStore(dir, randomUUID());
  // pre-seed long user/assistant history so the first token reduce exceeds budget * threshold
  let parent: string | null = null;
  for (let i = 0; i < 4; i++) {
    const m: Message = {
      id: randomUUID(), role: i % 2 === 0 ? "user" : "assistant",
      parts: [{ kind: "text", text: "x".repeat(200) }], parentId: parent, createdAt: Date.now(),
    };
    store.append(m); parent = m.id;
  }
  const reg = new ToolRegistry();
  const echoTool: Tool = {
    schema: { name: "echo", description: "echo", args: { type: "object" } },
    kind: "custom", async execute() { return { ok: true, output: "echoed" }; },
  };
  reg.register(echoTool);
  // stream stub: records every messages array it receives; first turn is a long
  // text + tool call (forces a second provider call), later turns end the run
  const recorded: Message[][] = [];
  let call = 0;
  const stream: StreamFn = async function* (_model: ModelRef, messages: Message[]): AsyncGenerator<StreamEvent> {
    recorded.push([...messages]);
    call++;
    if (call === 1) {
      yield { type: "turn", turn: { parts: [{ kind: "text", text: "y".repeat(300) }, { kind: "tool_call", id: "c1", tool: "echo", args: {} }], stopReason: "tool_use", usage: { input: 0, output: 1 } } };
    } else {
      yield { type: "turn", turn: textTurn("done") };
    }
  };
  const events: string[] = [];
  let status = "";
  let compactions = 0;
  for await (const ev of agentLoop(baseDef, "compact this run", {}, cfg({ contextBudgetTokens: 60, compactionThreshold: 0.5 }), {
    stream, registry: reg, store, summarize: async () => "SUMMARY",
  }, new SteeringQueue())) {
    events.push(ev.type);
    if (ev.type === "compaction") compactions++;
    if (ev.type === "run_end") status = ev.status;
  }
  // (1) a compaction event was yielded, and another provider call happened after it
  //     (compaction is emitted at turn start, before that turn's provider call)
  expect(compactions).toBeGreaterThanOrEqual(1);
  expect(recorded.length).toBeGreaterThanOrEqual(2);
  // (2) every message in every provider call is a real Message: role string + parts array
  //     (the {id,tokens,text} projections from planCompaction have neither)
  for (const msgs of recorded) {
    for (const m of msgs) {
      expect(typeof m.role).toBe("string");
      expect(Array.isArray(m.parts)).toBe(true);
    }
  }
  // (3) the run completes with run_end
  expect(status).toBe("done");
  expect(events.at(-1)).toBe("run_end");
  rmSync(dir, { recursive: true, force: true });
});

/** Two long user/assistant turns (4 × 50 tokens) so a 60-token window compacts at turn 1. */
function seedLongHistory(store: SessionStore): void {
  let parent: string | null = null;
  for (let i = 0; i < 4; i++) {
    const m: Message = { id: randomUUID(), role: i % 2 === 0 ? "user" : "assistant", parts: [{ kind: "text", text: "x".repeat(200) }], parentId: parent, createdAt: Date.now() };
    store.append(m); parent = m.id;
  }
}

// port #25: the compaction event names strategy + trigger, and a REAL session carries the marker —
// persisted as an event entry annotating the leaf, on the active path after reload, rendered by export
test("compaction event carries strategy+trigger; the marker is persisted, survives reload, and `rovecode export` renders it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-loop-"));
  const sid = randomUUID();
  const store = new SessionStore(dir, sid);
  seedLongHistory(store);
  const events: RunEvent[] = [];
  for await (const ev of agentLoop(baseDef, "compact this run", {}, cfg({ contextBudgetTokens: 60, compactionThreshold: 0.5 }), {
    stream: mockStream({ turns: [textTurn("done")] }), registry: new ToolRegistry(), store, summarize: async () => "SUMMARY",
  }, new SteeringQueue())) events.push(ev);
  const comp = events.filter((e) => e.type === "compaction");
  expect(comp.length).toBe(1);
  expect(comp[0]).toMatchObject({ strategy: "head-summarize", trigger: "speculative" });
  // persisted right after the goal message (the leaf at compaction time); the reply chains on the goal — no fork
  const path = store.path();
  const idx = path.findIndex((e) => "kind" in e && e.kind === "event");
  expect(idx).toBeGreaterThan(0);
  expect((path[idx] as Extract<Entry, { kind: "event" }>).event).toEqual(comp[0]!);
  expect(path[idx - 1]).toMatchObject({ role: "user" });
  expect(path[idx + 1]).toMatchObject({ role: "assistant" });
  // reload: identical path, no corruption, and the loop-facing messages() is unchanged
  const re = new SessionStore(dir, sid);
  expect(re.reload()).toEqual([]);
  expect(re.path().map((e) => e.id)).toEqual(path.map((e) => e.id));
  expect(re.messages().length).toBe(6); // 4 seeded + goal + reply
  const out = mkdtempSync(join(tmpdir(), "rovecode-loop-export-"));
  const res = exportSession(dir, sid, { cwd: out });
  const c0 = comp[0] as { tokensBefore: number; tokensAfter: number };
  expect(readFileSync(res.path, "utf8")).toContain(`> compacted (head-summarize): ${c0.tokensBefore} → ${c0.tokensAfter} tokens`);
  rmSync(dir, { recursive: true, force: true }); rmSync(out, { recursive: true, force: true });
});

test("cfg.compactionStrategy=keep-window compacts without a summarizer: deterministic marker on the wire, seeded head gone, event names the strategy", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-loop-"));
  const store = new SessionStore(dir, randomUUID());
  seedLongHistory(store);
  const recorded: Message[][] = [];
  const stream: StreamFn = async function* (_model: ModelRef, messages: Message[]): AsyncGenerator<StreamEvent> {
    recorded.push([...messages]);
    yield { type: "turn", turn: textTurn("done") };
  };
  const events: RunEvent[] = [];
  for await (const ev of agentLoop(baseDef, "compact this run", {}, cfg({ contextBudgetTokens: 60, compactionThreshold: 0.5, compactionStrategy: "keep-window", compactionKeepTurns: 0 }), {
    stream, registry: new ToolRegistry(), store, // no summarize: keep-window needs none
  }, new SteeringQueue())) events.push(ev);
  expect(events.find((e) => e.type === "compaction")).toMatchObject({ strategy: "keep-window", trigger: "speculative" });
  const wire = recorded[0]!.map((m) => partsTokenText(m.parts)).join("\n");
  expect(wire).not.toContain("x".repeat(200));
  expect(wire).toContain("[context compacted (keep-window): 4 earlier messages");
  expect(wire).toContain("compact this run");
  expect(events.at(-1)).toMatchObject({ type: "run_end", status: "done" });
  expect(store.path().some((e) => "kind" in e && e.kind === "event")).toBe(true);
  rmSync(dir, { recursive: true, force: true });
});

// ---------- port #32: the plan reminder rides the request, not the transcript ----------

test("planReminder is appended to EVERY request as the last message, is never stored, and a null keeps the request untouched", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-loop-plan-"));
  const store = new SessionStore(dir, randomUUID());
  const sent: Message[][] = [];
  const capture: StreamFn = async function* (_m: ModelRef, msgs: Message[]): AsyncGenerator<StreamEvent> {
    sent.push(msgs);
    yield { type: "turn", turn: textTurn("done") };
  };
  let calls = 0;
  const seenHistories: number[] = [];
  for await (const _ev of agentLoop(baseDef, "go", {}, cfg(), {
    stream: capture,
    registry: new ToolRegistry(),
    store,
    planReminder: (h) => { calls++; seenHistories.push(h.length); return "<plan-reminder>\n[ ] a: ship it\n</plan-reminder>"; },
  }, new SteeringQueue())) { /* drain */ }

  expect(calls).toBe(1);
  expect(seenHistories[0]).toBeGreaterThan(0); // it sees the history that is about to be sent
  const last = sent[0]!.at(-1)!;
  expect(last.role).toBe("user");
  expect(last.parts).toEqual([{ kind: "text", text: "<plan-reminder>\n[ ] a: ship it\n</plan-reminder>" }]);
  // the user's actual goal is still the message BEFORE it — the reminder does not displace it
  expect(sent[0]!.at(-2)!.parts).toEqual([{ kind: "text", text: "go" }]);
  // and it never reaches the session store: the transcript has no copy of the plan
  expect(store.messages().some((m) => m.parts.some((p) => p.kind === "text" && p.text.includes("plan-reminder")))).toBe(false);

  // a runtime with no open plan returns null, and the request is exactly the history
  const store2 = new SessionStore(dir, randomUUID());
  const sent2: Message[][] = [];
  const capture2: StreamFn = async function* (_m: ModelRef, msgs: Message[]): AsyncGenerator<StreamEvent> {
    sent2.push(msgs);
    yield { type: "turn", turn: textTurn("done") };
  };
  for await (const _ev of agentLoop(baseDef, "go", {}, cfg(), {
    stream: capture2, registry: new ToolRegistry(), store: store2, planReminder: () => null,
  }, new SteeringQueue())) { /* drain */ }
  expect(sent2[0]!.at(-1)!.parts).toEqual([{ kind: "text", text: "go" }]);
  rmSync(dir, { recursive: true, force: true });
});
