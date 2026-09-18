import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentLoop, SteeringQueue } from "../../src/core/loop.ts";
import { SessionStore } from "../../src/core/session.ts";
import { ToolRegistry } from "../../src/core/tools.ts";
import type { RunConfig, RunEvent, StreamFn } from "../../src/core/types.ts";

const cfg: RunConfig = { maxTurns: 3, contextBudgetTokens: 100_000, compactionThreshold: 0.8, parallelTools: true, permissionRules: [{ action: "*", resource: "*", effect: "allow" }] };
async function run(stream: StreamFn, check: (events: RunEvent[], store: SessionStore, executed: number) => void) {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-loop-integrity-"));
  try {
    const store = new SessionStore(dir, crypto.randomUUID());
    let executed = 0;
    const registry = new ToolRegistry();
    registry.register({ schema: { name: "count", description: "count", args: { type: "object" } }, kind: "read", async execute() { executed++; return { ok: true, output: "counted" }; } });
    const events: RunEvent[] = [];
    for await (const ev of agentLoop({ name: "test", tools: ["*"], systemPrompt: "test" }, "go", {}, cfg, { store, registry, stream }, new SteeringQueue())) events.push(ev);
    check(events, store, executed);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

for (const throws of [false, true]) test(`provider ${throws ? "throws" : "ends"} without terminal turn: error with visible text preserved`, async () => {
  const stream: StreamFn = async function* () {
    yield { type: "text_delta", text: "partial answer" };
    if (throws) throw new Error("broken transport");
  };
  await run(stream, (events, store) => {
    expect(events.at(-1)).toMatchObject({ type: "run_end", status: "error" });
    expect(store.messages().at(-1)?.parts).toEqual([{ kind: "text", text: "partial answer" }]);
  });
});

test("error turn with tool calls never executes and persists a failed result for each call", async () => {
  const stream: StreamFn = async function* () {
    yield { type: "turn", turn: { parts: [{ kind: "tool_call", id: "c1", tool: "count", args: {} }], stopReason: "error", error: "provider failed", usage: { input: 1, output: 1 } } };
  };
  await run(stream, (events, store, executed) => {
    expect(executed).toBe(0);
    expect(events.at(-1)).toMatchObject({ type: "run_end", status: "error" });
    expect(store.messages().at(-1)?.parts[0]).toMatchObject({ kind: "tool_result", callId: "c1", ok: false });
  });
});

test("tool_use with no calls cannot silently finish done", async () => {
  const stream: StreamFn = async function* () { yield { type: "turn", turn: { parts: [], stopReason: "tool_use", usage: { input: 0, output: 0 } } }; };
  await run(stream, (events) => expect(events.at(-1)).toMatchObject({ type: "run_end", status: "error" }));
});

test("provider budget stop never executes the accompanying tool call", async () => {
  const stream: StreamFn = async function* () { yield { type: "turn", turn: { parts: [{ kind: "tool_call", id: "c1", tool: "count", args: {} }], stopReason: "budget", usage: { input: 0, output: 0 } } }; };
  await run(stream, (events, store, executed) => {
    expect(executed).toBe(0);
    expect(events.at(-1)).toMatchObject({ type: "run_end", status: "budget" });
    expect(store.messages().at(-1)?.parts[0]).toMatchObject({ kind: "tool_result", callId: "c1", ok: false });
  });
});
