/** Aion CLI: run / gauntlet / agents / tools / trace / eval surfaces. */

import { agentLoop, SteeringQueue } from "../core/loop.ts";
import { ToolRegistry } from "../core/tools.ts";
import { SessionStore } from "../core/session.ts";
import { readTool, editTool, writeTool, bashTool } from "../coding/hashline.ts";
import { mockStream, textTurn, providerStream, openaiCompatStreaming, resolveProvider } from "../providers/stream.ts";
import { runGauntlet, reportResults, providerPreflight, basicTasks, codingTasks, failureTasks, adversarialTasks } from "../eval/gauntlet.ts";
import { runTask } from "../eval/gauntlet-runner.ts";
import { runBenchmarks } from "../eval/bench.ts";
import { resetTurnFailureCount } from "../memory/tools.ts";
import type { ModelRef, StreamFn } from "../core/types.ts";
import { createRuntime } from "./runtime.ts";
import { runRepl } from "./repl.ts";
import { runTui } from "../tui/app.ts";
import { parseCli } from "./dispatch.ts";
import { join } from "node:path";

const cli = parseCli(process.argv);
const cmd = cli.cmd;

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
  const yolo = process.argv.includes("--yolo") || process.env.AION_YOLO === "1";
  // One-shot runs build the SAME agent as repl/tui (createRuntime: tools incl.
  // MCP/recall/eval-cell, guardrails, config chunk, execpolicy approver seam).
  // AION_STREAM=sse keeps its meaning: raw SSE adapter, no middleware wrap.
  const providerCfg = resolveProvider();
  const sse = providerCfg && process.env.AION_STREAM === "sse"
    ? openaiCompatStreaming({ baseUrl: providerCfg.baseUrl, apiKey: providerCfg.apiKey })
    : undefined;
  const rt = createRuntime(sse ? { stream: sse } : {});
  const model: ModelRef = rt.provider
    ? { provider: rt.provider.id, model: process.env.AION_MODEL ?? rt.provider.defaultModel ?? "gpt-4o-mini" }
    : { provider: "mock", model: "default" };
  const stream = rt.stream ?? mockStream({ turns: [textTurn("Aion mock provider: set AION_BASE_URL and AION_API_KEY (or a named provider env key) for a real model.")] });
  const exit = async (code: number): Promise<never> => {
    await rt.mcp?.close().catch(() => {});
    return process.exit(code);
  };
  for await (const ev of agentLoop(rt.buildDef(model), prompt, {}, rt.buildCfg(yolo), { stream, registry: rt.registry, store: rt.store, tools: rt.registry.list().map((t) => t.schema), guard: rt.guard }, new SteeringQueue())) {
    if (ev.type === "turn_start") resetTurnFailureCount();
    if (ev.type === "tool_execution_start") console.log(`→ ${ev.tool}`, JSON.stringify(ev.args).slice(0, 100));
    if (ev.type === "tool_execution_end") console.log(`← ${ev.ok ? "ok" : "FAIL"} ${ev.output.slice(0, 200).replace(/\n/g, " ⏎ ")}`);
    if (ev.type === "run_end") { console.log(`\n${ev.summary}`); await exit(ev.status === "done" ? 0 : 1); }
  }
  await exit(1); // stream ended without run_end (defensive)
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
  aion --resume <id>        open the TUI resuming a session (full id or unique prefix)
  aion "prompt"             one-shot task (same as run)
  aion smoke-tui            render check: full pipeline into an 80x24 terminal emulator
  aion run "<prompt>"       run an agent task (--yolo allows all tools; mock provider only if no provider env set)
  aion bench                run cross-harness micro-benchmarks (edits, sessions)
  aion gauntlet             run the adversarial evaluation suite
  aion tools                list registered tools
  aion trace <session-id>   print session tree events (JSONL)
  aion eval                 alias for gauntlet
  aion acp                  Agent Client Protocol v1 endpoint over stdio (Zed/JetBrains)
  aion serve                headless HTTP server (AION_PORT, default 4100; loopback-only)

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

const known = new Set(["run", "gauntlet", "eval", "bench", "tools", "trace", "help", "chat", "repl", "smoke-tui", "acp", "serve"]);
// --resume <id>: TUI-only value flag, parsed here (parseCli flags are boolean-only);
// its value must not be mistaken for a one-shot prompt
const rIx = process.argv.indexOf("--resume");
const rArg = rIx !== -1 ? process.argv[rIx + 1] : undefined;
const resumeId = rArg !== undefined && !rArg.startsWith("-") ? rArg : undefined;
if (cmd === "" || cmd === "chat" || cmd === "repl" || (resumeId !== undefined && cmd === resumeId)) {
  // default surface is the pi-tui chat (port #1); --plain keeps the readline REPL
  if (cli.plain) await runRepl({ yolo: cli.yolo });
  else await runTui({ yolo: cli.yolo, sessionId: resumeId });
} else if (known.has(cmd)) {
  switch (cmd) {
    case "run": await cmdRun(cli.rest.join(" ") || "hello"); break;
    case "gauntlet": case "eval": await cmdGauntlet(); break;
    case "bench": await cmdBench(); break;
    case "tools": cmdTools(); break;
    case "trace": await cmdTrace(cli.rest[0] ?? ""); break;
    // dynamic import: smoke pulls in @xterm/headless (devDependency) — must not
    // load on ordinary CLI startup
    case "smoke-tui": await (await import("../tui/smoke.ts")).runTuiSmoke(); break;
    // port #15: ACP v1 endpoint over stdio (Zed/JetBrains). Dynamic import keeps
    // the ACP SDK off ordinary CLI startup.
    case "acp": await (await import("../acp/server.ts")).runAcpStdio({ yolo: cli.yolo }); break;
    // port #19: headless HTTP server (loopback by default; approvals are
    // policy-only over HTTP — see GET /doc). Bun.serve keeps the process alive.
    case "serve": {
      const { startServer } = await import("../server/http.ts");
      const port = Number(process.env.AION_PORT ?? "") || undefined;
      const srv = startServer({ ...(port !== undefined ? { port } : {}), yolo: cli.yolo });
      console.log(`aion server listening on ${srv.url} — POST /session · POST /session/:id/prompt (SSE) · GET /sessions · GET /doc`);
      break;
    }
    default: cmdHelp(); break;
  }
} else {
  // bare prompt: one-shot task
  await cmdRun([cmd, ...cli.rest].join(" "));
}
