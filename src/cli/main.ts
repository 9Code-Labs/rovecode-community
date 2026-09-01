/** Aion CLI: run / gauntlet / agents / tools / trace / eval surfaces. */

import { agentLoop, SteeringQueue } from "../core/loop.ts";
import { ToolRegistry } from "../core/tools.ts";
import { SessionStore } from "../core/session.ts";
import { readTool, editTool, writeTool, bashTool } from "../coding/hashline.ts";
import { mockStream, textTurn, providerStream, openaiCompatStreaming, resolveProvider, fetchModels, listBuiltinProviders } from "../providers/stream.ts";
import { runGauntlet, reportResults, providerPreflight, basicTasks, codingTasks, failureTasks, adversarialTasks } from "../eval/gauntlet.ts";
import { runTask } from "../eval/gauntlet-runner.ts";
import { runBenchmarks } from "../eval/bench.ts";
import { SkillStore } from "../skills/index.ts";
import { createSkillTools, buildSkillsIndex } from "../skills/tools.ts";
import { BlockStore } from "../memory/blocks.ts";
import { memoryEditTool, resetTurnFailureCount } from "../memory/tools.ts";
import type { RunConfig, ModelRef, StreamFn } from "../core/types.ts";
import { runRepl } from "./repl.ts";
import { runTui } from "../tui/app.ts";
import { runTuiSmoke } from "../tui/smoke.ts";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const cmd = process.argv[2] ?? "";

/** Permission tiers (omp approval modes): yolo = allow all; default = prompt for writes/exec. */
function defaultConfig(yolo: boolean): RunConfig {
  return {
    maxTurns: 40, contextBudgetTokens: 200_000, compactionThreshold: 0.8,
    parallelTools: true, retry: { maxAttempts: 3, backoffMs: 500 },
    permissionRules: yolo
      ? [{ action: "*", resource: "*", effect: "allow" }]
      : [
          { action: "file.read", resource: "*", effect: "allow" },
          { action: "file.write", resource: "*", effect: "prompt" },
          { action: "shell.exec", resource: "*", effect: "prompt" },
          { action: "spawn", resource: "*", effect: "prompt" },
        ],
  };
}

function resolveStream(): { stream: StreamFn; model: ModelRef; real: boolean; providerId: string } {
  const cfg = resolveProvider();
  if (cfg) {
    const stream = process.env.AION_STREAM === "sse" ? openaiCompatStreaming({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey }) : providerStream(cfg);
    return { stream, model: { provider: cfg.id, model: process.env.AION_MODEL ?? cfg.defaultModel ?? "gpt-4o-mini" }, real: true, providerId: cfg.id };
  }
  return {
    stream: mockStream({ turns: [textTurn("Aion mock provider: set AION_BASE_URL and AION_API_KEY (or a named provider env key) for a real model.")] }),
    model: { provider: "mock", model: "default" }, real: false, providerId: "mock",
  };
}

/** Verify-before-spend (omp-best-of pattern): a broken provider must fail before any task runs. */
async function preflightProvider(): Promise<void> {
  const { stream, model } = resolveStream();
  try {
    await providerPreflight(stream, model);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`error: ${msg}`);
    console.error(`hint: check AION_BASE_URL (${process.env.AION_BASE_URL ?? "not set"}) and AION_API_KEY; aborting before running tasks.`);
    process.exit(2);
  }
}

async function cmdRun(prompt: string): Promise<void> {
  const cwd = process.cwd();
  const stateDir = join(cwd, ".aion", "sessions");
  mkdirSync(stateDir, { recursive: true });
  const store = new SessionStore(stateDir, randomUUID());
  const registry = new ToolRegistry();
  registry.register(readTool, editTool, writeTool, bashTool);
  const skillStore = new SkillStore(cwd);
  skillStore.scan();
  registry.register(...createSkillTools(skillStore));
  const blockStore = new BlockStore(join(stateDir, "memory"));
  registry.register(memoryEditTool(blockStore));
  const skillsIndex = buildSkillsIndex(skillStore);
  const memoryIndex = blockStore.renderForPrompt();
  const yolo = process.argv.includes("--yolo") || process.env.AION_YOLO === "1";
  const cfg = defaultConfig(yolo);
  const { stream, model } = resolveStream();
  const def = {
    name: "main",
    model,
    systemPrompt: `You are Aion, a coding agent in ${cwd}. Use read/edit/write/bash tools. Edits require line hashes from read output.${skillsIndex ? "\n\n# Skills\n" + skillsIndex : ""}${memoryIndex ? "\n\n# Memory\n" + memoryIndex : ""}`,
    tools: ["*"],
  };
  const events: string[] = [];
  for await (const ev of agentLoop(def, prompt, {}, cfg, { stream, registry, store, tools: registry.list().map((t) => t.schema) }, new SteeringQueue())) {
    events.push(ev.type);
    if (ev.type === "turn_start") resetTurnFailureCount();
    if (ev.type === "tool_execution_start") console.log(`→ ${ev.tool}`, JSON.stringify(ev.args).slice(0, 100));
    if (ev.type === "tool_execution_end") console.log(`← ${ev.ok ? "ok" : "FAIL"} ${ev.output.slice(0, 200).replace(/\n/g, " ⏎ ")}`);
    if (ev.type === "run_end") { console.log(`\n${ev.summary}`); process.exit(ev.status === "done" ? 0 : 1); }
  }
}

async function cmdGauntlet(): Promise<void> {
  await preflightProvider();
  const tasks = [...basicTasks(), ...codingTasks(), ...failureTasks(), ...adversarialTasks()];
  const results = await runGauntlet({ tasks, runner: runTask });
  console.log(reportResults(results));
  process.exit(results.some((r) => !r.pass) ? 1 : 0);
}

async function cmdBench(): Promise<void> {
  const results = await runBenchmarks();
  for (const r of results) {
    console.log(`${r.harness.padEnd(8)} ${r.task.padEnd(28)} ${r.pass ? "PASS" : "FAIL"} ${r.durationMs}ms ${r.toolCalls} calls`);
  }
  process.exit(results.some((r) => !r.pass) ? 1 : 0);
}

function cmdTools(): void {
  const registry = new ToolRegistry();
  registry.register(readTool, editTool, writeTool, bashTool);
  for (const t of registry.list()) {
    console.log(`${t.schema.name.padEnd(8)} ${t.kind.padEnd(8)} sequential=${t.sequential !== false}`);
    console.log(`         ${t.schema.description}`);
  }
}

function cmdHelp(): void {
  console.log(`aion — agent harness

commands:
  aion                      interactive TUI chat (pi-tui; --plain for readline REPL)
  aion "prompt"             one-shot task (same as run)
  aion smoke-tui            render check: full pipeline into an 80x24 terminal emulator
  aion run "<prompt>"       run an agent task (--yolo allows all tools; mock provider only if no provider env set)
  aion bench                run cross-harness micro-benchmarks (edits, sessions)
  aion gauntlet             run the adversarial evaluation suite
  aion tools                list registered tools
  aion trace <session-id>   print session tree events (JSONL)
  aion eval                 alias for gauntlet

env:
  AION_BASE_URL   any OpenAI-compatible or Anthropic endpoint
  AION_API_KEY    API key (falls back to OPENAI_API_KEY)
  AION_MODEL      model id (e.g. zai-org/glm-5.3)
  AION_STREAM=sse use SSE streaming
  AION_YOLO=1     allow all tool actions
providers: kaesra openai anthropic deepseek groq openrouter ollama lmstudio
            together mistral cerebras fireworks perplexity xai moondream vllm
            (set <NAME>_API_KEY; AION_BASE_URL/AION_API_KEY always wins)`);
}

async function cmdTrace(sessionId: string): Promise<void> {
  const store = new SessionStore(join(process.cwd(), ".aion", "sessions"), sessionId);
  const corrupt = store.reload();
  if (corrupt.length > 0) console.error(`warning: ${corrupt.length} corruption(s):`, corrupt);
  for (const m of store.messages()) {
    const text = m.parts.filter((p) => p.kind === "text").map((p) => (p as { text: string }).text).join("");
    const calls = m.parts.filter((p) => p.kind === "tool_call").length;
    console.log(`${m.role.padEnd(10)} ${text.slice(0, 120)}${calls ? ` [+${calls} tool call(s)]` : ""}`);
  }
}

const known = new Set(["run", "gauntlet", "eval", "bench", "tools", "trace", "help", "chat", "repl", "smoke-tui"]);
if (cmd === "" || cmd === "chat" || cmd === "repl") {
  // default surface is the pi-tui chat (port #1); --plain keeps the readline REPL
  if (process.argv.includes("--plain")) await runRepl({ yolo: process.argv.includes("--yolo") });
  else await runTui({ yolo: process.argv.includes("--yolo") });
} else if (known.has(cmd)) {
  switch (cmd) {
    case "run": await cmdRun(process.argv.filter((a, i) => i > 2 && !a.startsWith("--")).join(" ") || "hello"); break;
    case "gauntlet": case "eval": await cmdGauntlet(); break;
    case "bench": await cmdBench(); break;
    case "tools": cmdTools(); break;
    case "trace": await cmdTrace(process.argv[3] ?? ""); break;
    case "smoke-tui": await runTuiSmoke(); break;
    default: cmdHelp(); break;
  }
} else {
  // bare prompt: one-shot task
  process.argv.splice(2, 0, "run");
  await cmdRun(process.argv.filter((a, i) => i > 2 && !a.startsWith("--")).join(" "));
}
