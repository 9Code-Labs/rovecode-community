import { test, expect } from "bun:test";
import { agentLoop, SteeringQueue } from "../../src/core/loop.ts";
import { ToolRegistry } from "../../src/core/tools.ts";
import { SessionStore } from "../../src/core/session.ts";
import { textTurn, toolTurn } from "../../src/providers/stream.ts";
import type { AgentDefinition, RunConfig, Tool, Message, StreamFn, AssistantTurn, ModelRef } from "../../src/core/types.ts";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const allowAll = [{ action: "*", resource: "*", effect: "allow" as const }];

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

/** Stateful per-call script: turns[i] on call i; last repeats (mockStream shape). */
function script(turns: AssistantTurn[]): StreamFn {
  let i = 0;
  return async function* (_model: ModelRef, _messages: Message[]) {
    yield { type: "turn" as const, turn: turns[Math.min(i, turns.length - 1)]! };
    i++;
  };
}

function toolResults(store: SessionStore): Message[] {
  return store.messages().filter((m) => m.role === "tool");
}

test("error stopReason ends run with status error and error text in summary", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-loop-"));
  const store = new SessionStore(dir, randomUUID());
  const reg = new ToolRegistry();
  const stream = script([{ parts: [], stopReason: "error", usage: { input: 0, output: 0 }, error: "boom: provider 500" }]);
  let end: { status: string; summary: string } | null = null;
  for await (const ev of agentLoop(baseDef, "go", {}, cfg(), { stream, registry: reg, store }, new SteeringQueue())) {
    if (ev.type === "run_end") end = { status: ev.status, summary: ev.summary };
  }
  expect(end?.status).toBe("error");
  expect(end?.summary).toContain("boom: provider 500");
  rmSync(dir, { recursive: true, force: true });
});

test("truncated turn appends role:tool message with ok:false tool_result", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-loop-"));
  const store = new SessionStore(dir, randomUUID());
  const reg = new ToolRegistry();
  const stream = script([
    { parts: [{ kind: "tool_call", id: "t1", tool: "echo", args: { x: 1 } }], stopReason: "length", usage: { input: 0, output: 0 } },
    textTurn("recovered"),
  ]);
  for await (const ev of agentLoop(baseDef, "go", {}, cfg(), { stream, registry: reg, store }, new SteeringQueue())) void ev;
  const trs = toolResults(store);
  expect(trs.length).toBe(1);
  const part = trs[0]!.parts[0]!;
  expect(part.kind).toBe("tool_result");
  if (part.kind === "tool_result") {
    expect(part.callId).toBe("t1");
    expect(part.ok).toBe(false);
    expect(part.output).toContain("length limit");
  }
  rmSync(dir, { recursive: true, force: true });
});

test("failed call (not_found) leaves a role:tool ok:false result per call", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-loop-"));
  const store = new SessionStore(dir, randomUUID());
  const reg = new ToolRegistry(); // nothing registered → not_found
  const stream = script([
    toolTurn([
      { id: "n1", tool: "does_not_exist", args: {} },
      { id: "n2", tool: "also_missing", args: {} },
    ]),
    textTurn("after failures"),
  ]);
  const reasons: string[] = [];
  for await (const ev of agentLoop(baseDef, "go", {}, cfg(), { stream, registry: reg, store }, new SteeringQueue())) {
    if (ev.type === "tool_call_failed") reasons.push(ev.reason);
  }
  expect(reasons).toContain("not_found");
  const trs = toolResults(store);
  expect(trs.length).toBe(2);
  for (const m of trs) {
    const part = m.parts[0]!;
    expect(part.kind).toBe("tool_result");
    if (part.kind === "tool_result") { expect(part.ok).toBe(false); expect(part.output.length).toBeGreaterThan(0); }
  }
  rmSync(dir, { recursive: true, force: true });
});

test("permission_denied call produces ok:false tool_result message", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-loop-"));
  const store = new SessionStore(dir, randomUUID());
  const reg = new ToolRegistry();
  const guarded: Tool = {
    schema: { name: "guarded", description: "guarded", args: { type: "object" } },
    kind: "custom", async execute() { return { ok: true, output: "ran" }; },
  };
  reg.register(guarded);
  const rules = [{ action: "tool.guarded", resource: "*", effect: "deny" as const }];
  const stream = script([
    toolTurn([{ id: "g1", tool: "guarded", args: {} }]),
    textTurn("saw denial"),
  ]);
  const reasons: string[] = [];
  for await (const ev of agentLoop(baseDef, "go", {}, cfg({ permissionRules: rules }), { stream, registry: reg, store }, new SteeringQueue())) {
    if (ev.type === "tool_call_failed") reasons.push(ev.reason);
  }
  expect(reasons).toContain("permission_denied");
  const trs = toolResults(store);
  const part = trs[0]?.parts[0];
  expect(part?.kind).toBe("tool_result");
  if (part?.kind === "tool_result") {
    expect(part.ok).toBe(false);
    expect(part.output).toContain("denied");
  }
  rmSync(dir, { recursive: true, force: true });
});

test("follow-up queue drains at stop: run continues instead of ending", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-loop-"));
  const store = new SessionStore(dir, randomUUID());
  const reg = new ToolRegistry();
  const followUps = new SteeringQueue();
  followUps.push("what else?");
  let answeredFollowUp = false;
  const stream: StreamFn = async function* (_model, messages) {
    const sawFollowUp = messages.some((m) => m.role === "user" && m.parts.some((p) => p.kind === "text" && (p as { text: string }).text.includes("what else?")));
    if (sawFollowUp) { answeredFollowUp = true; yield { type: "turn", turn: textTurn("follow-up handled") }; return; }
    yield { type: "turn", turn: textTurn("first answer") };
  };
  let status = ""; let summary = "";
  let steerEvents = 0;
  for await (const ev of agentLoop(baseDef, "q", {}, cfg(), { stream, registry: reg, store }, new SteeringQueue(), 0, followUps)) {
    if (ev.type === "run_end") { status = ev.status; summary = ev.summary; }
    if (ev.type === "steer") steerEvents++;
  }
  expect(status).toBe("done");
  expect(answeredFollowUp).toBe(true);
  expect(summary).toContain("follow-up handled");
  expect(steerEvents).toBe(1);
  expect(followUps.size).toBe(0);
  rmSync(dir, { recursive: true, force: true });
});

function spawnTool(): Tool {
  return {
    schema: { name: "spawn_child", description: "spawn", args: { type: "object" } },
    kind: "spawn", async execute(args: unknown, ctx) {
      const req = args as { agent: string; goal: string };
      if (!ctx.spawn) return { ok: false, output: "no spawn" };
      const r = await ctx.spawn({ agent: req.agent, goal: req.goal });
      return { ok: r.ok, output: r.summary };
    },
  };
}

test("depth threads into childRunner as depth + 1 (contract #1)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-loop-"));
  const store = new SessionStore(dir, randomUUID());
  const reg = new ToolRegistry();
  reg.register(spawnTool());
  const seenDepths: number[] = [];
  const stream = script([
    toolTurn([{ id: "s1", tool: "spawn_child", args: { agent: "child", goal: "sub" } }]),
    textTurn("spawned"),
  ]);
  for await (const ev of agentLoop(baseDef, "go", {}, cfg(), {
    stream, registry: reg, store,
    childRunner: async (agent, goal, _vars, d) => {
      void agent; void goal; seenDepths.push(d);
      return { ok: true, summary: "child done", usage: { input: 1, output: 1 } };
    },
  }, new SteeringQueue(), 2)) void ev;
  expect(seenDepths).toEqual([3]);
  rmSync(dir, { recursive: true, force: true });
});

test("default depth 0 threads as 1 into childRunner", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-loop-"));
  const store = new SessionStore(dir, randomUUID());
  const reg = new ToolRegistry();
  reg.register(spawnTool());
  let childDepth = -1;
  const stream = script([
    toolTurn([{ id: "s1", tool: "spawn_child", args: { agent: "child", goal: "sub" } }]),
    textTurn("spawned"),
  ]);
  for await (const ev of agentLoop(baseDef, "go", {}, cfg(), {
    stream, registry: reg, store,
    childRunner: async (_agent, _goal, _vars, d) => {
      childDepth = d;
      return { ok: true, summary: "child done", usage: { input: 1, output: 1 } };
    },
  }, new SteeringQueue())) void ev;
  expect(childDepth).toBe(1);
  rmSync(dir, { recursive: true, force: true });
});

test("text_delta streams surface as message_update events", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-loop-"));
  const store = new SessionStore(dir, randomUUID());
  const reg = new ToolRegistry();
  const stream: StreamFn = async function* () {
    yield { type: "text_delta", text: "Hello " };
    yield { type: "text_delta", text: "world" };
    yield { type: "turn", turn: textTurn("Hello world") };
  };
  const updates: { messageId: string; delta: string }[] = [];
  for await (const ev of agentLoop(baseDef, "hi", {}, cfg(), { stream, registry: reg, store }, new SteeringQueue())) {
    if (ev.type === "message_update") updates.push({ messageId: ev.messageId, delta: ev.delta });
  }
  expect(updates.map((u) => u.delta).join("")).toBe("Hello world");
  const ids = new Set(updates.map((u) => u.messageId));
  expect(ids.size).toBe(1);
  rmSync(dir, { recursive: true, force: true });
});

test("consumer .return() aborts the in-flight tool batch signal", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-loop-"));
  const store = new SessionStore(dir, randomUUID());
  const reg = new ToolRegistry();
  let observed: AbortSignal | undefined;
  let abortedInTool = false;
  const slowTool: Tool = {
    schema: { name: "slow", description: "slow", args: { type: "object" } },
    kind: "custom", async execute(_args: unknown, ctx) {
      observed = ctx.signal;
      // self-settling: resolve on the abort signal itself (no external release needed)
      await new Promise<void>((resolve) => {
        if (ctx.signal.aborted) { abortedInTool = true; resolve(); return; }
        ctx.signal.addEventListener("abort", () => { abortedInTool = true; resolve(); }, { once: true });
      });
      return { ok: true, output: "released by abort" };
    },
  };
  reg.register(slowTool);
  const stream = script([
    toolTurn([{ id: "z1", tool: "slow", args: {} }]),
    textTurn("late"),
  ]);
  const gen = agentLoop(baseDef, "go", {}, cfg(), { stream, registry: reg, store }, new SteeringQueue());
  let sawStart = false;
  for await (const ev of gen) {
    if (ev.type === "tool_execution_start") { sawStart = true; break; } // for-await break = .return() mid-batch
  }
  expect(sawStart).toBe(true);
  // the tool's promise ONLY settles on abort — if .return() didn't run the
  // finally block, this test would hang instead of complete. Completion is the proof.
  expect(observed).toBeDefined();
  expect(observed!.aborted).toBe(true);
  expect(abortedInTool).toBe(true);
  rmSync(dir, { recursive: true, force: true });
});

test("over-budget context drops system and reports it via compaction event", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-loop-"));
  const store = new SessionStore(dir, randomUUID());
  const reg = new ToolRegistry();
  const tinyBudget = cfg({ contextBudgetTokens: 8, compactionThreshold: 0.8 });
  const stream = script([textTurn("ok")]);
  const drops: { strategy: string; before: number; after: number }[] = [];
  for await (const ev of agentLoop(baseDef, "hello world this is long", {}, tinyBudget, { stream, registry: reg, store }, new SteeringQueue())) {
    if (ev.type === "compaction") drops.push({ strategy: ev.strategy, before: ev.tokensBefore, after: ev.tokensAfter });
  }
  expect(drops.length).toBe(1);
  expect(drops[0]!.strategy).toBe("context-drop");
  expect(drops[0]!.before).toBeGreaterThan(drops[0]!.after);
  rmSync(dir, { recursive: true, force: true });
});

test("deltas are LIVE: a message_update reaches the consumer while the provider stream is still open (not flushed after the turn)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-loop-"));
  const store = new SessionStore(dir, randomUUID());
  let consumerSawDelta = false;
  let liveWhenTurnBuilt = false;
  const stream: StreamFn = async function* () {
    yield { type: "text_delta", text: "Hi" };
    await Promise.resolve();
    liveWhenTurnBuilt = consumerSawDelta; // the old shape awaited the whole turn first: this was always false
    yield { type: "turn", turn: textTurn("Hi") };
  };
  for await (const ev of agentLoop(baseDef, "hi", {}, cfg(), { stream, registry: new ToolRegistry(), store }, new SteeringQueue())) {
    if (ev.type === "message_update") consumerSawDelta = true;
  }
  expect(liveWhenTurnBuilt).toBe(true);
  rmSync(dir, { recursive: true, force: true });
});

test("reasoning_delta streams surface as CUMULATIVE reasoning_update counts between turn_start and the first message_update; the thinking text never reaches the store", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-loop-"));
  const store = new SessionStore(dir, randomUUID());
  const SECRET = "the-user-cannot-see-this-reasoning"; // 34 chars → estimateTokens 9
  const stream: StreamFn = async function* () {
    yield { type: "reasoning_delta", text: SECRET };
    yield { type: "reasoning_delta", text: " and more of it here" }; // +20 → 54 chars → 14 (cumulative, not 9 + 5)
    yield { type: "text_delta", text: "Hello" };
    yield { type: "turn", turn: textTurn("Hello") };
  };
  const seen: string[] = [];
  const counts: number[] = [];
  const ids = new Set<string>();
  for await (const ev of agentLoop(baseDef, "hi", {}, cfg(), { stream, registry: new ToolRegistry(), store }, new SteeringQueue())) {
    seen.push(ev.type);
    if (ev.type === "reasoning_update") { counts.push(ev.tokens); ids.add(ev.messageId); }
    if (ev.type === "message_update") ids.add(ev.messageId);
  }
  expect(counts).toEqual([9, 14]);
  expect(ids.size).toBe(1); // the count names the message the answer will stream into
  expect(seen.indexOf("reasoning_update")).toBeGreaterThan(seen.indexOf("turn_start"));
  expect(seen.lastIndexOf("reasoning_update")).toBeLessThan(seen.indexOf("message_update"));
  expect(seen.indexOf("message_update")).toBeLessThan(seen.indexOf("turn_end"));
  expect(JSON.stringify(store.messages())).not.toContain(SECRET);
  const files = readdirSync(dir, { recursive: true }).map(String).filter((f) => statSync(join(dir, f)).isFile());
  expect(files.length).toBeGreaterThan(0);
  for (const f of files) expect(readFileSync(join(dir, f), "utf8")).not.toContain(SECRET);
  rmSync(dir, { recursive: true, force: true });
});
