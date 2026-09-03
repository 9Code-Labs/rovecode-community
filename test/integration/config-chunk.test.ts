/** Port #8 HIGH-2: the config chunk flows through assembleContext inside the
 *  ONE agent loop — folded into the single system message when it fits, and
 *  evicted (with a context-drop event) before the system chunk under budget
 *  pressure. No second prompt-assembly path.
 *
 *  Tail test (FW2-Q): the /status source-provenance branches — "(dropped)"
 *  for total-cap stubs and "+N skipped (file cap)" — through the real TUI. */

import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { agentLoop, SteeringQueue } from "../../src/core/loop.ts";
import { ToolRegistry } from "../../src/core/tools.ts";
import { SessionStore } from "../../src/core/session.ts";
import { estimateTokens } from "../../src/core/context.ts";
import { textTurn, mockStream } from "../../src/providers/stream.ts";
import { runTui } from "../../src/tui/app.ts";
import type { AgentDefinition, Message, RunConfig, RunEvent, StreamFn } from "../../src/core/types.ts";
import type { Renderer, RendererHooks } from "../../src/tui/renderer.ts";

function cfg(budget: number): RunConfig {
  return {
    maxTurns: 3, contextBudgetTokens: budget, compactionThreshold: 0.8,
    parallelTools: true,
    permissionRules: [{ action: "*", resource: "*", effect: "allow" }],
  };
}

async function runOnce(def: AgentDefinition, budget: number): Promise<{ seen: Message[][]; events: RunEvent[] }> {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-configchunk-"));
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

// ── FW2-Q: /status source provenance — the "(dropped)" and "+N skipped" branches ──

/** Note-capturing Renderer stub (only what /status touches matters). */
class NoteRenderer implements Renderer {
  hooks!: RendererHooks;
  notes: string[] = [];
  start(h: RendererHooks): void { this.hooks = h; }
  stop(): void {}
  setCommands(): void {}
  addUser(): void {}
  addSystemNote(text: string): void { this.notes.push(text); }
  beginAssistant() { return { append() {}, done() {} }; }
  toolStart(): void {}
  toolUpdate(): void {}
  toolEnd(): void {}
  async askApproval(): Promise<"deny"> { return "deny"; }
  async askQuestion(): Promise<null> { return null; } // port #33 seam: no-op stub (declines)
  async pickOne(): Promise<null> { return null; }
  clearTranscript(): void {}
  prefillEditor(): void {}
  setBusy(): void {}
  setStatus(): void {}
}

test("/status lists a total-cap-dropped source as '(dropped)' and file-cap skips as '+N skipped'", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-status-prov-"));
  mkdirSync(join(cwd, ".git")); // hermetic: stop the ancestor walk at the tmp dir
  const write = (rel: string, content: string) => {
    const abs = join(cwd, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
  };
  // Default budgets (8000/24000/24). Three 8000-char files: sections are
  // 8020 chars each, so AGENTS+CLAUDE fit (16040) and GEMINI would land at
  // 24060 > 24000 → total-cap DROPPED stub (chars 0). 25 rule files on top
  // of the 3 push existing candidates past maxFiles=24 → 4 counted skipped.
  write("AGENTS.md", "a".repeat(8000));
  write("CLAUDE.md", "c".repeat(8000));
  write("GEMINI.md", "g".repeat(8000));
  for (let i = 0; i < 25; i++) {
    write(`.cursor/rules/r${String(i).padStart(2, "0")}.mdc`, `rule ${i}`); // unique tiny bodies (dodge dedupe)
  }

  const fake = new NoteRenderer();
  const app = runTui({ renderer: fake, stream: mockStream({ turns: [textTurn("x")] }), cwd, yolo: true, exitOnClose: false, model: "scripted" });
  fake.hooks.onSubmit("/status");
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && !fake.notes.some((n) => n.includes("config:"))) {
    await new Promise((r) => setTimeout(r, 10));
  }
  fake.hooks.onExit();
  await app;

  const status = fake.notes.find((n) => n.includes("config:"));
  expect(status).toBeDefined();
  expect(status).toContain("GEMINI.md (dropped)");        // total-cap stub branch
  expect(status).toContain("+4 skipped (file cap)");      // maxFiles branch
  expect(status).toContain("AGENTS.md, CLAUDE.md");       // included files render bare (no suffix)
  expect(status).not.toContain("AGENTS.md (");
  rmSync(cwd, { recursive: true, force: true });
}, 20_000);
