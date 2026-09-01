import { test, expect } from "bun:test";
import { agentLoop, SteeringQueue } from "../../src/core/loop.ts";
import { ToolRegistry } from "../../src/core/tools.ts";
import { SessionStore } from "../../src/core/session.ts";
import { mockStream, textTurn, toolTurn } from "../../src/providers/stream.ts";
import { readTool, writeTool } from "../../src/coding/hashline.ts";
import type { AgentDefinition, RunConfig, Tool } from "../../src/core/types.ts";
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
    parallelTools: true, retry: { maxAttempts: 2, backoffMs: 10 },
    permissionRules: allowAll, ...over,
  };
}

const baseDef: AgentDefinition = {
  name: "t", systemPrompt: "test agent", tools: ["*"], maxTurns: 8,
};

test("loop completes a plain turn", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aion-loop-"));
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
  const dir = mkdtempSync(join(tmpdir(), "aion-loop-"));
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
  const dir = mkdtempSync(join(tmpdir(), "aion-loop-"));
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
  const dir = mkdtempSync(join(tmpdir(), "aion-loop-"));
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
  const dir = mkdtempSync(join(tmpdir(), "aion-loop-"));
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

// regression: plan.keep projections must be mapped back to real messages (loop.ts compaction)
test("compaction rebuilds history from real messages, not projections", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aion-loop-"));
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
