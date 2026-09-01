/** Port #8 HIGH-2: the config chunk flows through assembleContext inside the
 *  ONE agent loop — folded into the single system message when it fits, and
 *  evicted (with a context-drop event) before the system chunk under budget
 *  pressure. No second prompt-assembly path. */

import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentLoop, SteeringQueue } from "../../src/core/loop.ts";
import { ToolRegistry } from "../../src/core/tools.ts";
import { SessionStore } from "../../src/core/session.ts";
import { estimateTokens } from "../../src/core/context.ts";
import { textTurn } from "../../src/providers/stream.ts";
import type { AgentDefinition, Message, RunConfig, RunEvent, StreamFn } from "../../src/core/types.ts";

function cfg(budget: number): RunConfig {
  return {
    maxTurns: 3, contextBudgetTokens: budget, compactionThreshold: 0.8,
    parallelTools: true, retry: { maxAttempts: 1, backoffMs: 1 },
    permissionRules: [{ action: "*", resource: "*", effect: "allow" }],
  };
}

async function runOnce(def: AgentDefinition, budget: number): Promise<{ seen: Message[][]; events: RunEvent[] }> {
  const dir = mkdtempSync(join(tmpdir(), "aion-configchunk-"));
  const seen: Message[][] = [];
  const stream: StreamFn = async function* (_model, messages) {
    seen.push(messages);
    yield { type: "turn", turn: textTurn("ok") };
  };
  const events: RunEvent[] = [];
  const deps = { stream, registry: new ToolRegistry(), store: new SessionStore(dir, "s1"), tools: [] };
  for await (const ev of agentLoop(def, "go", {}, cfg(budget), deps, new SteeringQueue())) events.push(ev);
  rmSync(dir, { recursive: true, force: true });
  return { seen, events };
}

const CONFIG_TEXT = "# Project context\n\n## From AGENTS.md\nRULE-X: always frobnicate";

function defWithConfig(): AgentDefinition {
  return {
    name: "main", systemPrompt: "BASE PROMPT", tools: ["*"],
    contextChunks: [{ name: "config", text: CONFIG_TEXT, priority: 70, tokens: estimateTokens(CONFIG_TEXT) }],
  };
}

test("config chunk is folded into the SINGLE system message sent to the provider", async () => {
  const { seen } = await runOnce(defWithConfig(), 200_000);

  expect(seen.length).toBeGreaterThan(0);
  const first = seen[0]!;
  const systemMsgs = first.filter((m) => m.role === "system");
  expect(systemMsgs).toHaveLength(1); // one prompt-assembly path, one system message
  const sysText = systemMsgs[0]!.parts.map((p) => (p.kind === "text" ? p.text : "")).join("");
  expect(sysText).toBe(`BASE PROMPT\n\n${CONFIG_TEXT}`);
});

test("under budget pressure the config chunk is evicted BEFORE the system chunk, with a context-drop event", async () => {
  const def = defWithConfig();
  // budget fits system ("BASE PROMPT" ~3 tokens) + tiny history, not the config chunk
  const bigConfig = `# Project context\n\n## From AGENTS.md\nRULE-X ${"pad ".repeat(500)}`;
  def.contextChunks = [{ name: "config", text: bigConfig, priority: 70, tokens: estimateTokens(bigConfig) }];

  const { seen, events } = await runOnce(def, 30);

  const first = seen[0]!;
  const systemMsgs = first.filter((m) => m.role === "system");
  expect(systemMsgs).toHaveLength(1);
  const sysText = systemMsgs[0]!.parts.map((p) => (p.kind === "text" ? p.text : "")).join("");
  expect(sysText).toBe("BASE PROMPT");           // config gone, system intact
  expect(sysText).not.toContain("RULE-X");
  expect(events.some((e) => e.type === "compaction" && e.strategy === "context-drop")).toBe(true);
});

test("a definition without contextChunks behaves exactly as before (system text passthrough)", async () => {
  const { seen } = await runOnce({ name: "main", systemPrompt: "PLAIN", tools: ["*"] }, 200_000);
  const sysText = seen[0]!.filter((m) => m.role === "system")[0]!.parts
    .map((p) => (p.kind === "text" ? p.text : "")).join("");
  expect(sysText).toBe("PLAIN");
});
