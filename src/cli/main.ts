#!/usr/bin/env bun
/** Rovecode CLI: run / gauntlet / agents / tools / trace / eval surfaces. */

import { agentLoop, SteeringQueue } from "../core/loop.ts";
import { ToolRegistry } from "../core/tools.ts";
import { SessionStore } from "../core/session.ts";
import { readTool, editTool, writeTool, bashTool } from "../coding/hashline.ts";
import { globTool, grepTool, lsTool } from "../coding/files.ts";
import { webFetchTool } from "../tools/webfetch.ts";
import { todoTools } from "../tools/todo.ts";
import { askUserTool } from "../tools/ask-user.ts";
import { TaskManager } from "../core/tasks.ts";
import { createTaskTool, createTaskStatusTool } from "../tools/task.ts";
import { mockStream, textTurn, providerStream, providerStreaming, openaiCompatStreaming, wantsStreaming, resolveProvider } from "../providers/stream.ts";
import { saveCredential, removeCredential, listProviders, credentialsPath, readSecret } from "../providers/auth.ts";
import { ProviderRegistry, formatProviderList, parseAddArgs, ADD_USAGE } from "../providers/registry.ts";
import { isConfigured, providersPathFor } from "../providers/provider-config.ts";
import { providerEditTool, providerListTool } from "../tools/provider.ts";
import { designAuditTool, designDirectionTool } from "../tools/design.ts";
import { loadPlugins, summarizePlugins } from "../plugins/index.ts";
import { runGauntlet, reportResults, providerPreflight, basicTasks, codingTasks, failureTasks, adversarialTasks } from "../eval/gauntlet.ts";
import { liveGauntletTasks, runTask, runTaskLive } from "../eval/gauntlet-runner.ts";
import { profileFor, profileHint } from "../providers/profiles.ts";
import { thinkingReport } from "../providers/thinking.ts";
import { ModelCatalog } from "../providers/catalog.ts";
import { runBenchmarks } from "../eval/bench.ts";
import { resetTurnFailureCount } from "../memory/tools.ts";
import type { PermissionLevel, ModelRef, StreamFn } from "../core/types.ts";
import { parseEffort } from "../core/types.ts";
import { resolvePermission } from "../core/settings.ts";
import { bootRuntime } from "./runtime.ts";
import { SandboxConfigError } from "../core/sandbox-config.ts";
import { runRepl } from "./repl.ts";
import { askLine, runSetup } from "./setup.ts";
import { helpText } from "./help.ts";
import { MOCK_PROVIDER_TEXT } from "../core/voice.ts";
import { runTui } from "../tui/app.ts";
import { pickRenderer } from "../tui/sextant-io.ts";
import { expandSlashPrompt } from "../tui/commands.ts";
import { parseCli } from "./dispatch.ts";
import { parseRunLimits } from "./run-limits.ts";
import { buildRunDeps, createOutputSink, guardStdout, parseOutputMode, runPromptWords } from "./output.ts";
import { join } from "node:path";
import { rmSync } from "node:fs";
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
    // streaming by default (both protocols); ROVECODE_STREAM=off|json falls back to the JSON adapters
    const stream = wantsStreaming({ ROVECODE_STREAM: process.env.ROVECODE_STREAM }) ? providerStreaming(cfg) : providerStream(cfg);
    return { stream, model: { provider: cfg.id, model: process.env.ROVECODE_MODEL ?? cfg.defaultModel ?? "gpt-4o-mini" }, real: true, providerId: cfg.id };
  }
  return {
    stream: mockStream({ turns: [textTurn(MOCK_PROVIDER_TEXT)] }),
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
    console.error(`hint: check ROVECODE_BASE_URL (${process.env.ROVECODE_BASE_URL ?? "not set"}) and ROVECODE_API_KEY; aborting before running tasks.`);
    process.exit(2);
  }
}

async function cmdRun(prompt: string): Promise<void> {
  // port #35: --output is validated FIRST. bootRuntime has side effects (mkdir .rovecode/sessions/<id>
  // + meta.json + memory dir, skills scan, sandbox probe, MCP children) and a usage error is a bare
  // process.exit(2) — parsing after the boot left a stray session dir behind every `--output xml`.
  const mode = parseOutputMode(process.argv);
  // --max-turns N · --max-seconds S|off (ROVECODE_MAX_TURNS / ROVECODE_MAX_SECONDS): parsed before the boot like
  // --output, so a bad value is a bare exit 2 with no stray session dir. Headless runs default to a 20-minute
  // wall clock: a run that keeps verifying after its files are done ends in a result object, not a kill.
  const limits = parseRunLimits(process.argv, process.env, { defaultSeconds: 1200 });
  if ("error" in limits) { console.error(`error: ${limits.error}`); process.exit(2); }
  // port #35 (fix-wave 4 MED-C): json/ndjson stdout is guarded from HERE, before bootRuntime — its
  // session_open hooks (and MCP/sandbox startup) may print, and a guard installed by the sink after
  // the boot left those lines on fd 1. The raw writer is bound FIRST and handed to the sink as its
  // stdout: not process.stdout, so the sink installs no second guard; this one holds until exit
  const rawOut = { write: process.stdout.write.bind(process.stdout) };
  if (mode !== "text") guardStdout(process.stderr);
  const yolo = process.argv.includes("--yolo") || process.env.ROVECODE_YOLO === "1";
  // One-shot runs build the SAME agent as repl/tui (createRuntime: tools incl.
  // MCP/recall/eval-cell, guardrails, config chunk, execpolicy approver seam).
  // ROVECODE_STREAM=sse keeps its meaning: raw SSE adapter, no middleware wrap.
  const providerCfg = resolveProvider();
  const sse = providerCfg && process.env.ROVECODE_STREAM === "sse"
    ? openaiCompatStreaming({ baseUrl: providerCfg.baseUrl, apiKey: providerCfg.apiKey })
    : undefined;
  // port #27: a sandbox misconfig or an unavailable configured rung is a clean one-line
  // startup error (exit 2, like a failed provider preflight) — never a stack trace
  const rt = await bootRuntime(sse ? { stream: sse } : {}).catch((e: unknown): never => {
    if (e instanceof SandboxConfigError) { console.error(`error: ${e.message}`); process.exit(2); }
    throw e;
  });
  const model: ModelRef = rt.provider
    ? { provider: rt.provider.id, model: process.env.ROVECODE_MODEL ?? rt.provider.defaultModel ?? "gpt-4o-mini" }
    : { provider: "mock", model: "default" };
  // no provider configured → the scripted mock (packaging smoke, tests); the registry's own stream would
  // otherwise end the run with a `config:` error turn. noProviderReason() is null for an injected stream.
  const stream = rt.stream !== null && rt.noProviderReason() === null
    ? rt.stream
    : mockStream({ turns: [textTurn(MOCK_PROVIDER_TEXT)] });
  rt.hooks.onWarning((w) => console.error(`hooks: ${w}`)); // port #29: load + runtime hook notes → stderr (stdout stays the transcript)
  rt.plugins.onWarning((w) => console.error(`plugins: ${w}`)); // plugin discovery/activation notes, the same channel
  const pluginLine = summarizePlugins(rt.plugins.found); // one line when there is at least one plugin: what loaded, what stayed off
  if (pluginLine !== null) console.error(pluginLine);
  const exit = async (code: number): Promise<never> => {
    // port #26 (fix-wave MED-1): a one-shot run does not outlive its process — cancel the children
    // still running (their in-flight fetch + subprocess trees die through the run signal) and wait,
    // bounded, for their runs to settle; process.exit alone orphaned live task trees mid-command
    rt.tasks.cancelAll();
    await rt.tasks.drain(2_000);
    await rt.hooks.close(); // port #29: session_close, after in-flight on_event taps settle
    await rt.mcp?.close().catch(() => {});
    return process.exit(code);
  };
  // port #35: --output text|json|ndjson — the sink owns every stdout byte of the run (text mode is
  // byte-identical to the pre-port console.log lines; json/ndjson write through the raw writer bound
  // above the guard and send human progress to stderr) and its signal aborts on SIGINT, so Ctrl-C
  // ends the run "stopped" (exit 130)
  const sink = createOutputSink(mode, { stdout: mode === "text" ? process.stdout : rawOut, stderr: process.stderr, model, messages: () => rt.store.messages() });
  const effortFlag = parseEffort(process.argv[process.argv.indexOf("--effort") + 1]);
  if (effortFlag !== undefined) rt.setEffort(effortFlag); // --effort beats ROVECODE_EFFORT for this run
  rt.setRunLimits(limits); // turns + wall clock → buildCfg below
  // same ladder as the TUI (core/settings.ts): flag → env → project file → user file → "ask"
  const level = resolvePermission(rt.cwd, yolo ? "auto" : process.argv.includes("--accept-edits") ? "accept-edits" : undefined,
    { ROVECODE_PERMISSION: process.env.ROVECODE_PERMISSION, ROVECODE_YOLO: process.env.ROVECODE_YOLO, ROVECODE_ACCEPT_EDITS: process.env.ROVECODE_ACCEPT_EDITS });
  for await (const ev of agentLoop(rt.buildDef(model), prompt, {}, rt.buildCfg(level), buildRunDeps(rt, stream, sink), rt.steering)) { // port #26: runtime queue -> task notes reach the run; cwd threaded like every other surface
    if (ev.type === "turn_start") resetTurnFailureCount();
    sink.onEvent(ev);
    if (ev.type === "run_end") await exit(sink.finish(ev));
  }
  await exit(sink.finish()); // stream ended without run_end (defensive): status "error", exit 1
}

async function cmdGauntlet(): Promise<void> {
  if (process.argv.includes("--live")) return cmdGauntletLive();
  await preflightProvider();
  const tasks = [...basicTasks(), ...codingTasks(), ...failureTasks(), ...adversarialTasks()];
  const results = await runGauntlet({ tasks, runner: (task, workspace) => runTask(task, workspace) });
  console.log(reportResults(results));
  process.exit(results.some((r) => !r.pass) ? 1 : 0);
}

/** `rovecode gauntlet --live [--model provider/model] [--effort e]`: the gauntlet's basic/coding/failure/
 *  adversarial tasks (minus loop-guard) against a REAL model through the real runtime — the product's system
 *  prompt (incl. the model profile, providers/profiles.ts), router/retry/middleware stream, guard. The
 *  instrument for "does this prompt/profile change help model X": run it before and after, compare
 *  pass count, tool calls and tokens. Exit 0 all pass, 1 any fail, 2 no provider / preflight failed. */
async function cmdGauntletLive(): Promise<void> {
  const rt = await bootRuntime().catch((e: unknown): never => {
    if (e instanceof SandboxConfigError) { console.error(`error: ${e.message}`); process.exit(2); }
    throw e;
  });
  const exit = async (code: number): Promise<never> => {
    await rt.hooks.close();
    await rt.mcp?.close().catch(() => {});
    // the live tasks run in their own tmp stores; the boot session under <cwd>/.rovecode/sessions stays empty
    if (rt.store.messages().length === 0) rmSync(join(rt.cwd, ".rovecode", "sessions", rt.sessionId), { recursive: true, force: true });
    return process.exit(code);
  };
  const why = rt.noProviderReason();
  if (why !== null || rt.stream === null || rt.provider === null) { console.error(`error: ${why ?? "no provider configured"}`); await exit(2); }
  const provider = rt.provider!;
  const stream = rt.stream!;
  const selIdx = process.argv.indexOf("--model");
  const sel = selIdx >= 0 ? process.argv[selIdx + 1] : undefined;
  // the selector grammar every interactive surface uses: a leading segment is a provider only when it
  // names one, so `--model zai-org/glm-5.3-flash` stays a model id on the default provider
  const picked = sel ? rt.providers.resolveSelector(sel, provider.id) : { provider: provider.id, model: rt.defaultModel || provider.defaultModel || "" };
  if ("error" in picked) { console.error(`error: ${picked.error}`); await exit(2); }
  const model = picked as ModelRef;
  if (!model.model) { console.error("error: no model — pass --model <provider/model> or set a default (rovecode model use …)"); await exit(2); }
  const effortFlag = parseEffort(process.argv[process.argv.indexOf("--effort") + 1]);
  if (effortFlag !== undefined) rt.setEffort(effortFlag);
  const hint = profileHint();
  if (hint) console.error(`note: ${hint}`);
  try {
    await providerPreflight(stream, model);
  } catch (e) {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    await exit(2);
  }
  const tasks = liveGauntletTasks();
  console.log(`Gauntlet (live): ${model.provider}/${model.model} · effort ${rt.effort} · profile ${profileFor(model)?.id ?? "none"} · ${tasks.length} tasks`);
  const results = await runGauntlet({ tasks, runner: (task, workspace, signal) => runTaskLive(task, workspace, rt, model, signal) });
  console.log(reportResults(results));
  await exit(results.some((r) => !r.pass) ? 1 : 0);
}

async function cmdBench(): Promise<void> {
  const results = await runBenchmarks();
  for (const r of results) {
    console.log(`${r.harness.padEnd(8)} ${r.task.padEnd(28)} ${r.pass ? "PASS" : "FAIL"} ${r.durationMs}ms ${r.toolCalls} calls`);
  }
  process.exit(results.some((r) => !r.pass) ? 1 : 0);
}

async function cmdTools(): Promise<void> {
  const registry = new ToolRegistry();
  registry.register(readTool, editTool, writeTool, bashTool, globTool, grepTool, lsTool);
  registry.register(webFetchTool); // port #31
  registry.register(...todoTools(join(process.cwd(), ".rovecode", "sessions"))); // port #32: listing only — the root is never touched here
  registry.register(askUserTool(() => undefined)); // port #33: listing only — no asker is bound here
  const tasks = new TaskManager({ deps: () => null }); registry.register(createTaskTool(tasks), createTaskStatusTool(tasks)); // port #26: listing only — no provider, nothing can start
  const providers = new ProviderRegistry(process.cwd()); registry.register(providerListTool(providers), providerEditTool(providers)); // listing only — reads providers.json, writes nothing
  registry.register(designAuditTool(), designDirectionTool()); // listing only — neither is called here
  // plugins: the ACTIVE ones' tools, the way the runtime registers them (a taken name is refused, not replaced);
  // discovery + import only — nothing executes. Notes go to stderr so stdout stays the list.
  const { plugins, warnings } = await loadPlugins(process.cwd());
  const taken = new Set(registry.list().map((t) => t.schema.name));
  for (const p of plugins) for (const t of p.tools) { if (taken.has(t.schema.name)) { warnings.push(`plugin ${p.name}: tool "${t.schema.name}" is already registered — refused`); continue; } taken.add(t.schema.name); registry.register(t); }
  for (const w of warnings) console.error(`plugins: ${w}`);
  for (const t of registry.list()) {
    console.log(`${t.schema.name.padEnd(8)} ${t.kind.padEnd(8)} sequential=${t.sequential !== false}`);
    console.log(`         ${t.schema.description}`);
  }
}

/** `rovecode help [topic]` — short and grouped by default; env / advanced / all hold the reference (cli/help.ts). */
function cmdHelp(topic = ""): void {
  console.log(helpText(topic));
}

/** port #37: provider credential onboarding (`rovecode auth set/list/remove`).
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
      console.log(`no stored credentials (${credentialsPath()}) — run: rovecode auth set <provider>`);
      return;
    }
    for (const e of entries) console.log(`${e.provider.padEnd(12)} ${e.keyName.padEnd(24)} ${e.redacted}`);
    return;
  }
  if (action === "set" && provider !== undefined) {
    // strict on purpose: a credential no provider can consume is a silent onboarding no-op; catch
    // the typo here. Built-ins AND providers.json entries count (providers/registry.ts).
    const reg = new ProviderRegistry(process.cwd());
    const known = reg.get(provider);
    if (known === undefined) {
      console.error(`error: unknown provider "${provider}" — known: ${reg.ids().join(" ")}`);
      console.error(`hint: register a custom endpoint first: rovecode provider add ${provider} <baseUrl>`);
      process.exit(1);
    }
    const name = keyName ?? known.keyEnv;
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
  console.error("usage: rovecode auth set <provider> [--key <name>] | rovecode auth list | rovecode auth remove <provider>");
  process.exit(1);
}

/** argv words after a subcommand, flags INCLUDED — parseCli's `rest` drops flags but keeps their
 *  values, which is useless for flag-driven subcommands; the global boolean flags are removed. */
function argvAfter(command: string): string[] {
  const i = process.argv.indexOf(command);
  return i === -1 ? [] : process.argv.slice(i + 1).filter((a) => a !== "--yolo" && a !== "--plain" && a !== "--classic");
}

/** `rovecode provider list|add|remove|test` over providers.json (providers/registry.ts). Secrets: `--key`
 *  prompts through readSecret (never echoed, never in argv); `--key-env NAME` names an env var instead.
 *  Every change is live for running TUIs/servers on this machine — the registry re-reads on change. */
async function cmdProvider(words: string[]): Promise<void> {
  const reg = new ProviderRegistry(process.cwd());
  const [action, ...rest] = words;
  if (action === undefined || action === "list") { console.log(formatProviderList(reg, { all: rest.includes("--all") })); return; }
  if (action === "add") {
    const parsed = parseAddArgs(rest);
    if ("error" in parsed) { console.error(`error: ${parsed.error}`); process.exit(2); }
    const r = reg.add(parsed.spec, parsed.scope);
    if ("error" in r) { console.error(`error: ${r.error}`); process.exit(1); }
    console.log(`added ${r.id} (${r.protocol}, ${r.baseUrl}) to ${providersPathFor(parsed.scope, process.cwd())}`);
    if (parsed.promptKey) {
      const secret = await readSecret(`${r.keyEnv} for ${r.id}: `);
      if (secret.length === 0) { console.error("error: empty secret — provider kept, no key stored"); process.exit(1); }
      saveCredential(r.id, secret, r.keyEnv);
      console.log(`stored ${r.keyEnv} for ${r.id} in ${credentialsPath()}`);
    } else if (!isConfigured(r)) {
      console.log(`no key yet: rovecode auth set ${r.id}   (or set ${r.keyEnv}; picked up live, no restart)`);
    }
    if (reg.refresh() && reg.defaultRef()?.provider !== r.id) console.log(`make it the default: rovecode model use ${r.id}/${r.defaultModel ?? "<model>"}`);
    return;
  }
  if (action === "remove" && rest[0] !== undefined) {
    const r = reg.remove(rest[0]);
    if ("error" in r) { console.error(`error: ${r.error}`); process.exit(1); }
    console.log(r.removed.length > 0 ? `removed ${rest[0]} from the ${r.removed.join(" and ")} providers.json` : `${rest[0]} was not in any providers.json`);
    return;
  }
  if (action === "test" && rest[0] !== undefined) {
    const r = await reg.probe(rest[0], rest[1]);
    console.log(`${rest[0]}/${r.model}: ${r.detail}`);
    process.exit(r.ok ? 0 : 1);
  }
  console.error(`usage: rovecode provider list [--all] | rovecode provider ${ADD_USAGE} [--key] | rovecode provider remove <id> | rovecode provider test <id> [model]`);
  process.exit(2);
}

/** `rovecode model list [provider] | use <provider/model> [--project]` — the persisted default. */
async function cmdModel(words: string[]): Promise<void> {
  const reg = new ProviderRegistry(process.cwd());
  const pos = words.filter((w) => !w.startsWith("-"));
  const [action, arg] = pos;
  if (action === "list") {
    const id = arg ?? reg.defaultRef()?.provider;
    if (id === undefined) { console.error("error: no provider configured — rovecode provider add <id> <baseUrl>"); process.exit(1); }
    const r = await reg.models(id);
    if (!r.ok) { console.error(`error: ${r.error}`); process.exit(1); }
    const cur = reg.defaultRef();
    if (r.models.length === 0) console.log(`${id}: the endpoint listed no models (no /models route?) — pass one directly: rovecode model use ${id}/<model>`);
    for (const m of r.models) console.log(`${cur?.provider === id && cur.model === m ? "*" : " "} ${id}/${m}`);
    return;
  }
  // `rovecode model` / `rovecode model use` with nothing to use: pick from a numbered menu instead of
  // making the human go find an id first. TTY only — a pipe must not be consumed by a prompt, and a
  // script that meant to pass an id gets the usage line below.
  if ((action === undefined || (action === "use" && arg === undefined)) && process.stdin.isTTY === true) {
    const chosen = await pickModelInteractively(reg);
    if (chosen === null) return;
    const r = reg.setDefault(chosen, words.includes("--project") ? "project" : "user");
    if ("error" in r) { console.error(`error: ${r.error}`); process.exit(1); }
    console.log(`default → ${r.provider}/${r.model} (${providersPathFor(words.includes("--project") ? "project" : "user", process.cwd())}; running TUIs switch live)`);
    return;
  }
  if (action === "use" && arg !== undefined) {
    const scope = words.includes("--project") ? "project" : "user";
    const r = reg.setDefault(arg, scope);
    if ("error" in r) { console.error(`error: ${r.error}`); process.exit(1); }
    console.log(`default → ${r.provider}/${r.model} (${providersPathFor(scope, process.cwd())}; running TUIs switch live)`);
    const p = reg.get(r.provider);
    if (p !== undefined && !isConfigured(p)) console.log(reg.keyHint(p));
    return;
  }
  // `rovecode model show [provider/model]`: the model, its protocol, and — level by level — the exact thinking
  // field its endpoint receives (providers/thinking.ts; docs/thinking.md). Reads the same catalog flag buildDef
  // stamps, so what it prints is what a run sends.
  if (action === "show") {
    const ref = arg !== undefined ? reg.resolveSelector(arg, reg.defaultRef()?.provider ?? "") : reg.defaultRef();
    if (ref === null) { console.error("error: no default model — rovecode model use <provider/model>"); process.exit(1); }
    if ("error" in ref) { console.error(`error: ${ref.error}`); process.exit(1); }
    const p = reg.get(ref.provider);
    const info = new ModelCatalog().lookup(ref.provider, ref.model);
    const model: ModelRef = { ...ref, effort: parseEffort(process.env.ROVECODE_EFFORT) ?? "auto", ...(info?.supportsReasoning !== undefined ? { reasoning: info.supportsReasoning } : {}) };
    for (const l of thinkingReport(model, p?.protocol ?? "openai", { source: arg !== undefined ? "as named" : "the default" })) console.log(l);
    return;
  }
  console.error("usage: rovecode model list [provider] | rovecode model use <provider/model> [--project] | rovecode model show [provider/model]");
  process.exit(2);
}

/** `rovecode connect [<id> [<baseUrl>]] [flags]` — the one-shot form; bare, it hands over to the wizard. */
async function cmdConnect(words: string[]): Promise<number> {
  const registry = new ProviderRegistry(process.cwd());
  if (words.length === 0) return runSetup({ registry });
  const { parseConnectArgs, runConnect } = await import("./connect.ts");
  const parsed = parseConnectArgs(words);
  if ("error" in parsed) { console.error(`error: ${parsed.error}`); return 2; }
  return runConnect(parsed, { registry });
}

/** The numbered menu behind a bare `rovecode model`. Every CONFIGURED provider is asked for its
 *  models concurrently; one that is down or keyless prints its reason and is skipped rather than
 *  taking the whole list down with it. Returns the "provider/model" selector, or null when the
 *  human cancels or there is nothing to choose from. */
async function pickModelInteractively(reg: ProviderRegistry): Promise<string | null> {
  const ids = reg.list().filter(isConfigured).map((p) => p.id);
  if (ids.length === 0) { console.error("error: no provider is configured yet — run: rovecode connect"); process.exit(1); }
  console.log(`fetching models from ${ids.length} provider${ids.length === 1 ? "" : "s"}…`);
  const results = await Promise.all(ids.map(async (id) => ({ id, r: await reg.models(id) })));
  const cur = reg.defaultRef();
  const rows: string[] = [];
  for (const { id, r } of results) {
    if (!r.ok) { console.log(`  (${id}: ${r.error})`); continue; }
    for (const m of r.models) rows.push(`${id}/${m}`);
  }
  if (rows.length === 0) { console.error("error: no models to choose from"); process.exit(1); }
  const currentSel = cur ? `${cur.provider}/${cur.model}` : null;
  rows.sort((a, b) => Number(b === currentSel) - Number(a === currentSel)); // the one you are on, first
  rows.forEach((sel, i) => console.log(`  ${String(i + 1).padStart(2)}  ${sel === currentSel ? "* " : "  "}${sel}`));
  const answer = (await askLine(`Which one? [1-${rows.length}, empty = cancel]: `)).trim();
  if (answer.length === 0) { console.log("cancelled — nothing changed"); return null; }
  const n = Number(answer);
  if (!Number.isInteger(n) || n < 1 || n > rows.length) { console.error(`error: "${answer}" is not one of 1-${rows.length}`); process.exit(2); }
  return rows[n - 1]!;
}

async function cmdTrace(sessionId: string): Promise<void> {
  const store = new SessionStore(join(process.cwd(), ".rovecode", "sessions"), sessionId);
  const corrupt = store.reload();
  if (corrupt.length > 0) console.error(`warning: ${corrupt.length} corruption(s):`, corrupt);
  for (const m of store.messages()) {
    const text = m.parts.filter((p) => p.kind === "text").map((p) => (p as { text: string }).text).join("");
    const calls = m.parts.filter((p) => p.kind === "tool_call").length;
    console.log(`${m.role.padEnd(10)} ${text.slice(0, 120)}${calls ? ` [+${calls} tool call(s)]` : ""}`);
  }
}

const known = new Set(["run", "gauntlet", "eval", "bench", "tools", "plugin", "mcp", "auth", "provider", "model", "models", "setup", "connect", "trace", "help", "chat", "repl", "smoke-tui", "acp", "serve", "export"]);
// --resume <id>: TUI-only value flag, parsed here (parseCli skips its value when locating the
// command but returns no flag values); its value must not be mistaken for a one-shot prompt
const rIx = process.argv.indexOf("--resume");
const rArg = rIx !== -1 ? process.argv[rIx + 1] : undefined;
const resumeId = rArg !== undefined && !rArg.startsWith("-") ? rArg : undefined;
if (cmd === "" || cmd === "chat" || cmd === "repl") {
  // default surface (port #44): the sextant renderer on a colour TTY of ≥ 100×30 — truecolor, or 256 through
  // the quantizer (ROVECODE_TUI / --classic
  // override — sextant-io.ts chooseSurface), else the pi-tui chat (port #1); --plain keeps the readline REPL
  if (cli.plain) await runRepl({ yolo: cli.yolo });
  else await runTui({ yolo: cli.yolo, acceptEdits: cli.acceptEdits, ...(cli.effort !== undefined ? { effort: cli.effort } : {}), sessionId: resumeId, renderer: pickRenderer(cli, process.env, process.stdout), ...(cli.pet !== undefined ? { pet: cli.pet } : {}) });
} else if (known.has(cmd)) {
  switch (cmd) {
    // port #35: runPromptWords drops a post-command --output value; port #30: a leading /name expands a custom command
    case "run": await cmdRun(expandSlashPrompt(runPromptWords(cli, process.argv).join(" ") || "hello", process.cwd())); break;
    case "gauntlet": case "eval": await cmdGauntlet(); break;
    case "bench": await cmdBench(); break;
    case "tools": await cmdTools(); break;
    // plugins (src/plugins, docs/plugins.md): list/add/remove/enable/disable/trust/untrust/show — filesystem + plugins.json only, never imports a plugin
    case "plugin": process.exitCode = await (await import("../plugins/cli.ts")).cmdPlugin(argvAfter("plugin")); break;
    // the MCP market (src/mcp/market*.ts, docs/mcp-market.md): search/info/add/remove/list over ~/.rovecode/mcp.json and .rovecode/mcp.json
    case "mcp": process.exitCode = await (await import("./mcp-market-cmd.ts")).cmdMcp(argvAfter("mcp")); break;
    case "setup": process.exitCode = await runSetup({ registry: new ProviderRegistry(process.cwd()) }); break; // connect a model step by step (cli/setup.ts)
    // `connect` is the one-line form of setup: bare it IS the wizard, with an id it takes the answers
    // from argv (cli/connect.ts) so a README or a CI step can do it without a terminal
    case "connect": process.exitCode = await cmdConnect(argvAfter("connect")); break;
    case "help": cmdHelp(cli.rest[0] ?? ""); break; // short by default; help env | advanced | all
    case "auth": await cmdAuth(cli.rest); break;
    case "provider": await cmdProvider(argvAfter("provider")); break; // providers.json: list/add/remove/test
    case "model": await cmdModel(argvAfter("model")); break;          // persisted default model: list/use
    // `rovecode models` reads better than `model list` and is what people type; same command
    case "models": await cmdModel(["list", ...argvAfter("models")]); break;
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
      // port #44: `--sextant` drives the sextant surface through the real pipeline over an in-memory
      // terminal — no @xterm/headless involved, so it also runs from an installed tree or the binary
      if (process.argv.includes("--sextant")) { await (await import("../tui/sextant-smoke.ts")).runSextantSmoke(); break; }
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
      const port = Number(process.env.ROVECODE_PORT ?? "") || undefined;
      const srv = startServer({ ...(port !== undefined ? { port } : {}), yolo: cli.yolo });
      console.log(`rovecode server listening on ${srv.url} — POST /session · POST /session/:id/prompt (SSE) · DELETE /session/:id/prompt · GET /session/:id/tasks · GET /sessions · GET /doc`);
      break;
    }
    default: cmdHelp(); break;
  }
} else {
  // bare prompt: one-shot task (port #35: a post-command --output value is not a prompt word; port #30: /name expands)
  await cmdRun(expandSlashPrompt(runPromptWords(cli, process.argv).join(" "), process.cwd()));
}
