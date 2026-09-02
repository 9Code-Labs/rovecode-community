#!/usr/bin/env bun
/** Aion CLI: run / gauntlet / agents / tools / trace / eval surfaces. */

import { agentLoop, SteeringQueue } from "../core/loop.ts";
import { ToolRegistry } from "../core/tools.ts";
import { SessionStore } from "../core/session.ts";
import { readTool, editTool, writeTool, bashTool } from "../coding/hashline.ts";
import { globTool, grepTool, lsTool } from "../coding/files.ts";
import { webFetchTool } from "../tools/webfetch.ts";
import { todoTools } from "../tools/todo.ts";
import { mockStream, textTurn, providerStream, openaiCompatStreaming, resolveProvider, listBuiltinProviders } from "../providers/stream.ts";
import { saveCredential, removeCredential, listProviders, keyNameFor, credentialsPath, readSecret } from "../providers/auth.ts";
import { runGauntlet, reportResults, providerPreflight, basicTasks, codingTasks, failureTasks, adversarialTasks } from "../eval/gauntlet.ts";
import { runTask } from "../eval/gauntlet-runner.ts";
import { runBenchmarks } from "../eval/bench.ts";
import { resetTurnFailureCount } from "../memory/tools.ts";
import type { ModelRef, StreamFn } from "../core/types.ts";
import { bootRuntime } from "./runtime.ts";
import { SandboxConfigError } from "../core/sandbox-config.ts";
import { runRepl } from "./repl.ts";
import { runTui } from "../tui/app.ts";
import { parseCli } from "./dispatch.ts";
import { createOutputSink, parseOutputMode, runPromptWords } from "./output.ts";
import { join } from "node:path";
import pkg from "../../package.json";

const cli = parseCli(process.argv);
const cmd = cli.cmd;

// port #36 (packaging): --version prints the package version and exits. Must
// precede dispatch — parseCli treats a lone flag as cmd "", which would
// otherwise open the TUI. The JSON import is bundled into compiled binaries.
if (process.argv.includes("--version")) {
  console.log(pkg.version);
  process.exit(0);
}

function resolveStream(): { stream: StreamFn; model: ModelRef; real: boolean; providerId: string } {
  const cfg = resolveProvider();
  if (cfg) {
    const stream = process.env.AION_STREAM === "sse" ? openaiCompatStreaming({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey }) : providerStream(cfg);
    return { stream, model: { provider: cfg.id, model: process.env.AION_MODEL ?? cfg.defaultModel ?? "gpt-4o-mini" }, real: true, providerId: cfg.id };
  }
  return {
    stream: mockStream({ turns: [textTurn("Aion mock provider: run `aion auth set <provider>`, or set AION_BASE_URL and AION_API_KEY (or a <NAME>_API_KEY env var), for a real model.")] }),
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
  // port #27: a sandbox misconfig or an unavailable configured rung is a clean one-line
  // startup error (exit 2, like a failed provider preflight) — never a stack trace
  const rt = await bootRuntime(sse ? { stream: sse } : {}).catch((e: unknown): never => {
    if (e instanceof SandboxConfigError) { console.error(`error: ${e.message}`); process.exit(2); }
    throw e;
  });
  const model: ModelRef = rt.provider
    ? { provider: rt.provider.id, model: process.env.AION_MODEL ?? rt.provider.defaultModel ?? "gpt-4o-mini" }
    : { provider: "mock", model: "default" };
  const stream = rt.stream ?? mockStream({ turns: [textTurn("Aion mock provider: run `aion auth set <provider>`, or set AION_BASE_URL and AION_API_KEY (or a <NAME>_API_KEY env var), for a real model.")] });
  const exit = async (code: number): Promise<never> => {
    await rt.mcp?.close().catch(() => {});
    return process.exit(code);
  };
  // port #35: --output text|json|ndjson — the sink owns every stdout byte of the run (text mode is
  // byte-identical to the pre-port console.log lines; json/ndjson guard stdout and send human
  // progress to stderr) and its signal aborts on SIGINT, so Ctrl-C ends the run "stopped" (exit 130)
  const sink = createOutputSink(parseOutputMode(process.argv), { stdout: process.stdout, stderr: process.stderr, model, messages: () => rt.store.messages() });
  for await (const ev of agentLoop(rt.buildDef(model), prompt, {}, rt.buildCfg(yolo), { stream, registry: rt.registry, store: rt.store, tools: rt.registry.list().map((t) => t.schema), guard: rt.guard, cwd: rt.cwd, signal: sink.signal }, rt.steering)) { // port #26: runtime queue -> task notes reach the run; cwd threaded like every other surface
    if (ev.type === "turn_start") resetTurnFailureCount();
    sink.onEvent(ev);
    if (ev.type === "run_end") await exit(sink.finish(ev));
  }
  await exit(sink.finish()); // stream ended without run_end (defensive): status "error", exit 1
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
  registry.register(readTool, editTool, writeTool, bashTool, globTool, grepTool, lsTool);
  registry.register(webFetchTool); // port #31
  registry.register(...todoTools(join(process.cwd(), ".aion", "sessions"))); // port #32: listing only — the root is never touched here
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
  aion smoke-tui            render check: full pipeline into an 80x24 terminal emulator (dev-only)
  aion run "<prompt>"       run an agent task (--yolo allows all tools; mock provider only if no provider env set)
  aion bench                run cross-harness micro-benchmarks (edits, sessions)
  aion gauntlet             run the adversarial evaluation suite
  aion tools                list registered tools
  aion auth set <provider> [--key <name>]  store an API key (prompts on stdin; ~/.aion/credentials.json)
  aion auth list            stored providers + key names (values redacted)
  aion auth remove <provider>  delete a stored credential
  aion trace <session-id>   print session tree events (JSONL)
  aion export <session>     write a session as markdown (--json: raw JSONL copy; --out <path>; --force)
  aion eval                 alias for gauntlet
  aion acp                  Agent Client Protocol v1 endpoint over stdio (Zed/JetBrains)
  aion serve                headless HTTP server (AION_PORT, default 4100; loopback-only)

env:
  AION_BASE_URL   any OpenAI-compatible or Anthropic endpoint
  AION_API_KEY    API key (falls back to OPENAI_API_KEY)
  AION_MODEL      model id (e.g. zai-org/glm-5.3)
  AION_MODEL_<ROLE>  role fallback chain, comma-separated provider/model list; on 429/5xx
                  the next candidate serves. Roles: DEFAULT SMOL PLAN COMMIT TASK
                  (e.g. AION_MODEL_DEFAULT=kaesra/zai-org/glm-5.3-flash,openai/gpt-4o-mini)
  AION_STREAM=sse use SSE streaming
  AION_YOLO=1     allow all tool actions
  AION_SANDBOX    executor rung for bash: direct (default) | wsl | docker; beats .aion/sandbox.json {"rung","dockerImage"}
  AION_SANDBOX_IMAGE  image for the docker rung (default debian:stable-slim; must contain bash)
providers: kaesra openai anthropic deepseek groq openrouter ollama lmstudio
            together mistral cerebras fireworks perplexity xai moondream vllm
            (aion auth set <name>, or set <NAME>_API_KEY — stored creds beat env;
            AION_BASE_URL/AION_API_KEY always wins)`);
}

/** port #37: provider credential onboarding (`aion auth set/list/remove`).
 *  Secrets are NEVER printed: list shows key NAMES plus a redacted prefix, set/remove
 *  messages and errors never embed the value. */
async function cmdAuth(rest: string[]): Promise<void> {
  const action = rest[0] ?? "";
  // --key <name>: value flag, parsed positionally like --resume below (parseCli flags are
  // boolean-only and its `rest` keeps flag VALUES — drop ours from the positionals)
  const kIx = process.argv.indexOf("--key");
  const kArg = kIx !== -1 ? process.argv[kIx + 1] : undefined;
  const keyName = kArg !== undefined && !kArg.startsWith("-") ? kArg : undefined;
  const args = rest.slice(1).filter((a) => a !== keyName);
  const provider = args[0];
  if (action === "list") {
    const entries = listProviders();
    if (entries.length === 0) {
      console.log(`no stored credentials (${credentialsPath()}) — run: aion auth set <provider>`);
      return;
    }
    for (const e of entries) console.log(`${e.provider.padEnd(12)} ${e.keyName.padEnd(24)} ${e.redacted}`);
    return;
  }
  if (action === "set" && provider !== undefined) {
    const ids = listBuiltinProviders().map((p) => p.id);
    if (!ids.includes(provider)) {
      // strict on purpose: a credential resolveProvider can never consume is a silent
      // onboarding no-op; catch the typo here instead
      console.error(`error: unknown provider "${provider}" — known: ${ids.join(" ")}`);
      process.exit(1);
    }
    const name = keyName ?? keyNameFor(provider);
    const secret = await readSecret(`${name} for ${provider}: `);
    if (secret.length === 0) {
      console.error("error: empty secret — nothing stored");
      process.exit(1);
    }
    saveCredential(provider, secret, keyName);
    console.log(`stored ${name} for ${provider} in ${credentialsPath()}`);
    return;
  }
  if (action === "remove" && provider !== undefined) {
    if (!removeCredential(provider)) {
      console.error(`error: no stored credential for ${provider}`);
      process.exit(1);
    }
    console.log(`removed credential for ${provider}`);
    return;
  }
  console.error("usage: aion auth set <provider> [--key <name>] | aion auth list | aion auth remove <provider>");
  process.exit(1);
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

const known = new Set(["run", "gauntlet", "eval", "bench", "tools", "auth", "trace", "help", "chat", "repl", "smoke-tui", "acp", "serve", "export"]);
// --resume <id>: TUI-only value flag, parsed here (parseCli skips its value when locating the
// command but returns no flag values); its value must not be mistaken for a one-shot prompt
const rIx = process.argv.indexOf("--resume");
const rArg = rIx !== -1 ? process.argv[rIx + 1] : undefined;
const resumeId = rArg !== undefined && !rArg.startsWith("-") ? rArg : undefined;
if (cmd === "" || cmd === "chat" || cmd === "repl") {
  // default surface is the pi-tui chat (port #1); --plain keeps the readline REPL
  if (cli.plain) await runRepl({ yolo: cli.yolo });
  else await runTui({ yolo: cli.yolo, sessionId: resumeId });
} else if (known.has(cmd)) {
  switch (cmd) {
    case "run": await cmdRun(runPromptWords(cli, process.argv).join(" ") || "hello"); break; // port #35: drops a post-command --output value
    case "gauntlet": case "eval": await cmdGauntlet(); break;
    case "bench": await cmdBench(); break;
    case "tools": cmdTools(); break;
    case "auth": await cmdAuth(cli.rest); break;
    case "trace": await cmdTrace(cli.rest[0] ?? ""); break;
    // port #38: session export (markdown transcript or raw JSONL copy) — local only.
    // Hand-parses its own argv: --out takes a value, and parseCli flags are boolean-only.
    case "export": (await import("./export.ts")).cmdExport(process.argv); break;
    // dynamic import: smoke pulls in @xterm/headless (a devDependency) — it must
    // not load on ordinary CLI startup, and it is ABSENT from an npm-installed
    // tree, so a failed RESOLUTION is reported as dev-only instead of a stack
    // trace. Resolution only (Bun's ResolveMessage, code ERR_MODULE_NOT_FOUND —
    // not an Error instance): smoke.ts imports the live TUI modules, so any other
    // import failure is a real module-init bug and must propagate as itself.
    case "smoke-tui": {
      const smoke = await import("../tui/smoke.ts").catch((e: unknown) => {
        if ((e as { code?: unknown } | null)?.code === "ERR_MODULE_NOT_FOUND") return null;
        throw e;
      });
      if (smoke === null) {
        console.error("smoke-tui is dev-only — run from a source checkout with devDependencies installed");
        process.exit(1);
      }
      await smoke.runTuiSmoke();
      break;
    }
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
  // bare prompt: one-shot task (port #35: a post-command --output value is not a prompt word)
  await cmdRun(runPromptWords(cli, process.argv).join(" "));
}
