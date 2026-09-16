#!/usr/bin/env bun
/** Rovecode CLI: run / gauntlet / agents / tools / trace / eval surfaces. */

// Only module-level necessities — every command handler lazily imports what it needs so that
// `rovecode --help` does not pay for the TUI, eval suite, loop, runtime, or plugin scanner.
import { parseCli } from "./dispatch.ts";
import { parseRunLimits } from "./run-limits.ts";
import { parseEffort } from "../core/types.ts";
import type { PermissionLevel, ModelRef, StreamFn } from "../core/types.ts";
import { helpText } from "./help.ts";
import { join } from "node:path";
import pkg from "../../package.json";

// ROVECODE_TRACE_BOOT=1: process-start timestamp stored here (before any dynamic imports) so
// the runTui trace can compute the full module-load gap.
if (process.env.ROVECODE_TRACE_BOOT === "1") process.env._ROVECODE_BOOT_T0 = String(Date.now());

const cli = parseCli(process.argv);
const cmd = cli.cmd;

if (process.argv.includes("--version")) {
  // The version goes to stdout alone, so `rovecode --version` stays a single parseable word for scripts.
  // The update line goes to STDERR, because this is the one command where asking WAS the point: the
  // startup card is deliberately silent when there is nothing newer, which means a check that could not
  // run — no token, offline, a repository with no releases — would otherwise never be reported anywhere.
  // Cache-only: it reports what is already known and never opens a socket. Awaiting the network here made
  // `rovecode --version` take 3.2 s on a cold cache — for a courtesy line, on the one command scripts call
  // to find out which build they have. The TUI asks on startup; this reads the answer.
  console.log(pkg.version);
  const { checkForUpdate, updateLine } = await import("../core/update-check.ts");
  const line = updateLine(await checkForUpdate(pkg.version, { cacheOnly: true }), true);
  if (line !== null) console.error(line);
  process.exit(0);
}

async function resolveStream(): Promise<{ stream: StreamFn; model: ModelRef; real: boolean; providerId: string }> {
  const { resolveProvider, providerStream, providerStreaming, wantsStreaming } = await import("../providers/stream.ts");
  const { mockStream, textTurn } = await import("../providers/stream.ts");
  const { MOCK_PROVIDER_TEXT } = await import("../core/voice.ts");
  const cfg = resolveProvider();
  if (cfg) {
    const stream = wantsStreaming({ ROVECODE_STREAM: process.env.ROVECODE_STREAM }) ? providerStreaming(cfg) : providerStream(cfg);
    return { stream, model: { provider: cfg.id, model: process.env.ROVECODE_MODEL ?? cfg.defaultModel ?? "gpt-4o-mini" }, real: true, providerId: cfg.id };
  }
  return {
    stream: mockStream({ turns: [textTurn(MOCK_PROVIDER_TEXT)] }),
    model: { provider: "mock", model: "default" }, real: false, providerId: "mock",
  };
}

async function preflightProvider(): Promise<void> {
  const { providerPreflight } = await import("../eval/gauntlet.ts");
  const { stream, model } = await resolveStream();
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
  const { agentLoop } = await import("../core/loop.ts");
  const { bootRuntime } = await import("./runtime.ts");
  const { SandboxConfigError } = await import("../core/sandbox-config.ts");
  const { WorkspaceRootError } = await import("../core/workspace.ts");
  const { parseAddDirs } = await import("./run-flags.ts");
  const { mockStream, textTurn, resolveProvider, providerStreaming } = await import("../providers/stream.ts");
  const { MOCK_PROVIDER_TEXT } = await import("../core/voice.ts");
  const { summarizePlugins } = await import("../plugins/index.ts");
  const { resolvePermission } = await import("../core/settings.ts");
  const { buildRunDeps, createOutputSink, guardStdout, parseOutputMode, runPromptWords } = await import("./output.ts");
  const { expandSlashPrompt } = await import("../tui/commands.ts");
  const { resetTurnFailureCount } = await import("../memory/tools.ts");

  const mode = parseOutputMode(process.argv);
  const limits = parseRunLimits(process.argv, process.env, { defaultSeconds: 1200 });
  if ("error" in limits) { console.error(`error: ${limits.error}`); process.exit(2); }
  const addDirs = parseAddDirs(process.argv); // --add-dir <dir>: extra workspace roots (core/workspace.ts); a bad value is exit 2 here, before any boot
  const rawOut = { write: process.stdout.write.bind(process.stdout) };
  if (mode !== "text") guardStdout(process.stderr);
  const yolo = process.argv.includes("--yolo") || process.env.ROVECODE_YOLO === "1";
  const providerCfg = resolveProvider();
  // through the ONE streaming builder, so the config's headers (GitHub Copilot's editor headers, a proxy's
  // org id) and an OAuth token's refresh reach this request too — the headerless adapter call used to drop them
  const sse = providerCfg && process.env.ROVECODE_STREAM === "sse"
    ? providerStreaming(providerCfg)
    : undefined;
  const rt = await bootRuntime({ ...(sse ? { stream: sse } : {}), ...(addDirs.length > 0 ? { addDirs } : {}) }).catch((e: unknown): never => {
    if (e instanceof SandboxConfigError || e instanceof WorkspaceRootError) { console.error(`error: ${e.message}`); process.exit(2); }
    throw e;
  });
  // ROVECODE_MOCK=1 means the canned provider, ALWAYS — provider configured or not. Until 2026-09-07 the flag
  // only PERMITTED the mock when nothing was configured and was ignored otherwise, while its comment said it
  // "asks for the scripted mock on purpose": a developer with ANTHROPIC_API_KEY exported ran `ROVECODE_MOCK=1
  // rovecode run "say hi"` to look at a stderr line and paid $0.09 for one real turn. The test suite never saw
  // it because test/helpers/isolate-home.ts scrubs every key before the CLI spawns. A flag named MOCK mocks.
  // Without the flag, a missing provider is refused below rather than quietly answered by a stand-in.
  const wantsMock = process.env.ROVECODE_MOCK === "1";
  const model: ModelRef = rt.provider && !wantsMock
    ? { provider: rt.provider.id, model: process.env.ROVECODE_MODEL ?? rt.provider.defaultModel ?? "gpt-4o-mini" }
    : { provider: "mock", model: "default" };
  const stream = !wantsMock && rt.stream !== null && rt.noProviderReason() === null
    ? rt.stream
    : mockStream({ turns: [textTurn(MOCK_PROVIDER_TEXT)] });
  rt.hooks.onWarning((w) => console.error(`hooks: ${w}`));
  rt.plugins.onWarning((w) => console.error(w)); // the note names its own subsystem (runtime.ts pluginWarn)
  const pluginLine = summarizePlugins(rt.plugins.found);
  if (pluginLine !== null) console.error(pluginLine);
  rt.onRouterNote((n) => console.error(n)); // "anthropic: overloaded — retrying in 4 s (2/4)" while it waits, one stderr line
  const exit = async (code: number): Promise<never> => {
    rt.tasks.cancelAll();
    await rt.tasks.drain(2_000);
    rt.bashJobs.dispose(); // #55: a backgrounded command must not outlive the run that started it
    await rt.hooks.close();
    await rt.mcp?.close().catch(() => {});
    return process.exit(code);
  };
  const sink = createOutputSink(mode, { stdout: mode === "text" ? process.stdout : rawOut, stderr: process.stderr, model, messages: () => rt.store.messages() });
  // No provider is a STARTUP failure, not a run that finished. The mock stream above exists so an
  // interactive session can say "nothing is connected, here is how" instead of crashing — but a one-shot
  // run that answers with the canned mock text and exits 0 is worse than a crash: `rovecode run … --output
  // json` reported {"status":"done"} with the hint as its summary, and a script cannot tell that from a
  // real answer. Exit 2, the usage/startup class, and in a machine mode say so as one document.
  if (rt.noProviderReason() !== null && !wantsMock) {
    const why = rt.noProviderReason()!;
    if (mode === "text") console.error(`error: ${why}`);
    else rawOut.write(`${JSON.stringify({ status: "error", summary: why, error: why, exitCode: 2 })}
`);
    await exit(2);
  }
  const effortFlag = parseEffort(process.argv[process.argv.indexOf("--effort") + 1]);
  if (effortFlag !== undefined) rt.setEffort(effortFlag);
  rt.setRunLimits(limits);
  const level = resolvePermission(rt.cwd, yolo ? "auto" : process.argv.includes("--accept-edits") ? "accept-edits" : undefined,
    { ROVECODE_PERMISSION: process.env.ROVECODE_PERMISSION, ROVECODE_YOLO: process.env.ROVECODE_YOLO, ROVECODE_ACCEPT_EDITS: process.env.ROVECODE_ACCEPT_EDITS });
  for await (const ev of agentLoop(rt.buildDef(model), prompt, {}, rt.buildCfg(level), buildRunDeps(rt, stream, sink), rt.steering)) {
    if (ev.type === "turn_start") resetTurnFailureCount();
    sink.onEvent(ev);
    if (ev.type === "run_end") await exit(sink.finish(ev));
  }
  await exit(sink.finish());
}

async function cmdGauntlet(): Promise<void> {
  if (process.argv.includes("--live")) return cmdGauntletLive();
  await preflightProvider();
  const { runGauntlet, reportResults, basicTasks, codingTasks, failureTasks, adversarialTasks } = await import("../eval/gauntlet.ts");
  // waves 3/4 carry their own `run` — they drive the REAL runtime instead of the scripted provider
  const { wave3Tasks } = await import("../eval/gauntlet-wave3.ts");
  const { wave4Tasks } = await import("../eval/gauntlet-wave4.ts");
  const { runTask } = await import("../eval/gauntlet-runner.ts");
  const tasks = [...basicTasks(), ...codingTasks(), ...failureTasks(), ...adversarialTasks(), ...wave3Tasks(), ...wave4Tasks()];
  const results = await runGauntlet({ tasks, runner: (task, workspace) => runTask(task, workspace) });
  console.log(reportResults(results));
  process.exit(results.some((r) => !r.pass) ? 1 : 0);
}

async function cmdGauntletLive(): Promise<void> {
  const { bootRuntime } = await import("./runtime.ts");
  const { SandboxConfigError } = await import("../core/sandbox-config.ts");
  const { runGauntlet, reportResults, providerPreflight } = await import("../eval/gauntlet.ts");
  const { liveGauntletTasks, runTaskLive } = await import("../eval/gauntlet-runner.ts");
  const { profileFor, profileHint } = await import("../providers/profiles.ts");
  const { ProviderRegistry } = await import("../providers/registry.ts");
  const { rmSync } = await import("node:fs");

  const rt = await bootRuntime().catch((e: unknown): never => {
    if (e instanceof SandboxConfigError) { console.error(`error: ${e.message}`); process.exit(2); }
    throw e;
  });
  const exit = async (code: number): Promise<never> => {
    rt.bashJobs.dispose(); // #55: a backgrounded command must not outlive the run that started it
    await rt.hooks.close();
    await rt.mcp?.close().catch(() => {});
    if (rt.store.messages().length === 0) rmSync(join(rt.cwd, ".rovecode", "sessions", rt.sessionId), { recursive: true, force: true });
    return process.exit(code);
  };
  const why = rt.noProviderReason();
  if (why !== null || rt.stream === null || rt.provider === null) { console.error(`error: ${why ?? "no provider configured"}`); await exit(2); }
  const provider = rt.provider!;
  const stream = rt.stream!;
  const selIdx = process.argv.indexOf("--model");
  const sel = selIdx >= 0 ? process.argv[selIdx + 1] : undefined;
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
  const { runBenchmarks } = await import("../eval/bench.ts");
  const results = await runBenchmarks();
  for (const r of results) {
    console.log(`${r.harness.padEnd(8)} ${r.task.padEnd(28)} ${r.pass ? "PASS" : "FAIL"} ${r.durationMs}ms ${r.toolCalls} calls`);
  }
  process.exit(results.some((r) => !r.pass) ? 1 : 0);
}

async function cmdTools(): Promise<void> {
  const { ToolRegistry } = await import("../core/tools.ts");
  const { readTool, editTool, writeTool, bashTool } = await import("../coding/hashline.ts");
  const { globTool, grepTool, lsTool } = await import("../coding/files.ts");
  const { webFetchTool } = await import("../tools/webfetch.ts");
  const { webSearchTool } = await import("../tools/websearch.ts");
  const { todoTools } = await import("../tools/todo.ts");
  const { askUserTool } = await import("../tools/ask-user.ts");
  const { TaskManager } = await import("../core/tasks.ts");
  const { createTaskTool, createTaskStatusTool } = await import("../tools/task.ts");
  const { ProviderRegistry } = await import("../providers/registry.ts");
  const { providerListTool, providerEditTool } = await import("../tools/provider.ts");
  const { designAuditTool, designDirectionTool } = await import("../tools/design.ts");
  const { loadPlugins } = await import("../plugins/index.ts");

  const registry = new ToolRegistry();
  registry.register(readTool, editTool, writeTool, bashTool, globTool, grepTool, lsTool);
  registry.register(webFetchTool, webSearchTool);
  registry.register(...todoTools(join(process.cwd(), ".rovecode", "sessions")));
  registry.register(askUserTool(() => undefined));
  const tasks = new TaskManager({ deps: () => null }); registry.register(createTaskTool(tasks), createTaskStatusTool(tasks));
  const providers = new ProviderRegistry(process.cwd()); registry.register(providerListTool(providers), providerEditTool(providers));
  registry.register(designAuditTool(), designDirectionTool());
  const { plugins, warnings } = await loadPlugins(process.cwd());
  const taken = new Set(registry.list().map((t) => t.schema.name));
  for (const p of plugins) for (const t of p.tools) { if (taken.has(t.schema.name)) { warnings.push(`plugin ${p.name}: tool "${t.schema.name}" is already registered — refused`); continue; } taken.add(t.schema.name); registry.register(t); }
  for (const w of warnings) console.error(`plugins: ${w}`);
  for (const t of registry.list()) {
    console.log(`${t.schema.name.padEnd(8)} ${t.kind.padEnd(8)} sequential=${t.sequential !== false}`);
    console.log(`         ${t.schema.description}`);
  }
}

function cmdHelp(topic = ""): void {
  console.log(helpText(topic));
}

async function cmdAuth(rest: string[]): Promise<void> {
  const { saveCredential, removeCredential, listProviders, credentialsPath, readSecret } = await import("../providers/auth.ts");
  const { ProviderRegistry } = await import("../providers/registry.ts");
  const { isConfigured } = await import("../providers/provider-config.ts");

  const action = rest[0] ?? "";
  const kIx = process.argv.indexOf("--key");
  const kArg = kIx !== -1 ? process.argv[kIx + 1] : undefined;
  const keyName = kArg !== undefined && !kArg.startsWith("-") ? kArg : undefined;
  const args = rest.slice(1).filter((a) => a !== keyName);
  const provider = args[0];
  if (action === "list") {
    const entries = listProviders();
    // --json was ACCEPTED and ignored here, so a script asking for a document got prose and exit 0. The
    // redacted form is what goes in it — the whole point of this listing is that the value never leaves.
    // process.argv, not `rest`: dispatch strips flags out of cli.rest, which is why --key is read the
    // same way two lines above. Reading `rest` here made the flag look accepted and do nothing.
    if (process.argv.includes("--json")) {
      console.log(JSON.stringify({ path: credentialsPath(), credentials: entries.map((e) => ({ provider: e.provider, kind: e.kind, keyName: e.keyName, redacted: e.redacted, ...(e.expires !== undefined ? { expires: e.expires } : {}) })) }, null, 2));
      return;
    }
    (await import("./auth-login.ts")).printAuthList(); // kind + expiry columns; body in auth-login.ts
    return;
  }
  if (action === "login") { // OAuth device-code / PKCE login; body in auth-login.ts
    process.exitCode = await (await import("./auth-login.ts")).cmdAuthLogin(args);
    return;
  }
  if (action === "set" && provider !== undefined) {
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
  const { AUTH_LOGIN_USAGE } = await import("./auth-login.ts");
  console.error(`usage: rovecode auth set <provider> [--key <name>] | rovecode auth list | rovecode auth remove <provider> | ${AUTH_LOGIN_USAGE.replace(/^usage: /, "")}`);
  process.exit(1);
}

function argvAfter(command: string): string[] {
  const i = process.argv.indexOf(command);
  return i === -1 ? [] : process.argv.slice(i + 1).filter((a) => a !== "--yolo" && a !== "--plain" && a !== "--classic");
}

async function cmdProvider(words: string[]): Promise<void> {
  const { ProviderRegistry, formatProviderList, parseAddArgs, ADD_USAGE } = await import("../providers/registry.ts");
  const { isConfigured, providersPathFor } = await import("../providers/provider-config.ts");
  const { saveCredential, credentialsPath, readSecret } = await import("../providers/auth.ts");

  const reg = new ProviderRegistry(process.cwd());
  const [action, ...rest] = words;
  if (action === undefined || action === "list") {
    if (rest.includes("--json")) {
      const dflt = reg.defaultRef();
      // the same filter formatProviderList applies: without --all, only what is configured or not built in
      const showAll = rest.includes("--all");
      const rows = reg.list().filter((p) => showAll || isConfigured(p) || p.scope !== "builtin").map((p) => ({
        id: p.id, protocol: p.protocol, baseUrl: p.baseUrl, keyEnv: p.keyEnv,
        defaultModel: p.defaultModel ?? null, configured: isConfigured(p), scope: p.scope ?? null,
      }));
      console.log(JSON.stringify({ default: dflt ?? null, providers: rows, warnings: reg.warnings() }, null, 2));
      return;
    }
    console.log(formatProviderList(reg, { all: rest.includes("--all") }));
    return;
  }
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

async function cmdModel(words: string[]): Promise<void> {
  const { ProviderRegistry } = await import("../providers/registry.ts");
  const { isConfigured, providersPathFor } = await import("../providers/provider-config.ts");

  const reg = new ProviderRegistry(process.cwd());
  const pos = words.filter((w) => !w.startsWith("-"));
  const [action, arg] = pos;
  if (action === "list") {
    const id = arg ?? reg.defaultRef()?.provider;
    if (id === undefined) { console.error("error: no provider configured — rovecode provider add <id> <baseUrl>"); process.exit(1); }
    const r = await reg.models(id);
    if (!r.ok) { console.error(`error: ${r.error}`); process.exit(1); }
    const cur = reg.defaultRef();
    // --json: `market` has promised this on every subcommand for a while and a caller reasonably tries
    // it here too. It was accepted and ignored, which is the worst of the three options — a script got
    // prose where it asked for data, with no error to notice. The `*` the terminal draws is `default`
    // here, so the two surfaces carry the same fact rather than one of them carrying less.
    if (words.includes("--json")) {
      console.log(JSON.stringify({
        provider: id,
        models: r.models.map((m) => ({ id: m, ref: `${id}/${m}`, default: cur?.provider === id && cur.model === m })),
      }, null, 2));
      return;
    }
    if (r.models.length === 0) console.log(`${id}: the endpoint listed no models (no /models route?) — pass one directly: rovecode model use ${id}/<model>`);
    for (const m of r.models) console.log(`${cur?.provider === id && cur.model === m ? "*" : " "} ${id}/${m}`);
    return;
  }
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
  if (action === "show") {
    const { ModelCatalog, describePricing } = await import("../providers/catalog.ts");
    const { thinkingReport } = await import("../providers/thinking.ts");
    const ref = arg !== undefined ? reg.resolveSelector(arg, reg.defaultRef()?.provider ?? "") : reg.defaultRef();
    if (ref === null) { console.error("error: no default model — rovecode model use <provider/model>"); process.exit(1); }
    if ("error" in ref) { console.error(`error: ${ref.error}`); process.exit(1); }
    const p = reg.get(ref.provider);
    const info = new ModelCatalog().lookup(ref.provider, ref.model);
    const model: ModelRef = { ...ref, effort: parseEffort(process.env.ROVECODE_EFFORT) ?? "auto", ...(info?.supportsReasoning !== undefined ? { reasoning: info.supportsReasoning } : {}) };
    const catalogLine = info === undefined ? "unpriced — not in models.dev, not in rovecode's own table (/cost shows tokens only)"
      : info.source === "local" ? `priced from rovecode's own table, not models.dev (${info.sourceNote})` : "models.dev";
    for (const l of thinkingReport(model, p?.protocol ?? "openai", { source: arg !== undefined ? "as named" : "the default", catalog: catalogLine })) console.log(l);
    // the numbers themselves, and anything that changes them: a prompt-size threshold, a dated increase
    if (info !== undefined) for (const l of describePricing(info)) console.log(`            ${l}`);
    return;
  }
  console.error("usage: rovecode model list [provider] | rovecode model use <provider/model> [--project] | rovecode model show [provider/model]");
  process.exit(2);
}

async function cmdConnect(words: string[]): Promise<number> {
  const { ProviderRegistry } = await import("../providers/registry.ts");
  const { askLine, runSetup } = await import("./setup.ts");
  const registry = new ProviderRegistry(process.cwd());
  if (words.length === 0) return runSetup({ registry });
  const { parseConnectArgs, runConnect } = await import("./connect.ts");
  const parsed = parseConnectArgs(words);
  if ("error" in parsed) { console.error(`error: ${parsed.error}`); return 2; }
  return runConnect(parsed, { registry });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function pickModelInteractively(reg: any): Promise<string | null> {
  const { isConfigured } = await import("../providers/provider-config.ts");
  const { askLine } = await import("./setup.ts");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ids: string[] = reg.list().filter(isConfigured).map((p: any) => p.id as string);
  if (ids.length === 0) { console.error("error: no provider is configured yet — run: rovecode connect"); process.exit(1); }
  console.log(`fetching models from ${ids.length} provider${ids.length === 1 ? "" : "s"}…`);
  const results = await Promise.all(ids.map(async (id: string) => ({ id, r: await reg.models(id) })));
  const cur = reg.defaultRef();
  const rows: string[] = [];
  for (const { id, r } of results) {
    if (!r.ok) { console.log(`  (${id}: ${r.error})`); continue; }
    for (const m of r.models) rows.push(`${id}/${m}`);
  }
  if (rows.length === 0) { console.error("error: no models to choose from"); process.exit(1); }
  const currentSel = cur ? `${cur.provider}/${cur.model}` : null;
  rows.sort((a, b) => Number(b === currentSel) - Number(a === currentSel));
  rows.forEach((sel, i) => console.log(`  ${String(i + 1).padStart(2)}  ${sel === currentSel ? "* " : "  "}${sel}`));
  const answer = (await askLine(`Which one? [1-${rows.length}, empty = cancel]: `)).trim();
  if (answer.length === 0) { console.log("cancelled — nothing changed"); return null; }
  const n = Number(answer);
  if (!Number.isInteger(n) || n < 1 || n > rows.length) { console.error(`error: "${answer}" is not one of 1-${rows.length}`); process.exit(2); }
  return rows[n - 1]!;
}

async function cmdTrace(sessionId: string): Promise<void> {
  const { SessionStore } = await import("../core/session.ts");
  const store = new SessionStore(join(process.cwd(), ".rovecode", "sessions"), sessionId);
  const corrupt = store.reload();
  if (corrupt.length > 0) console.error(`warning: ${corrupt.length} corruption(s):`, corrupt);
  for (const m of store.messages()) {
    const text = m.parts.filter((p) => p.kind === "text").map((p) => (p as { text: string }).text).join("");
    const calls = m.parts.filter((p) => p.kind === "tool_call").length;
    console.log(`${m.role.padEnd(10)} ${text.slice(0, 120)}${calls ? ` [+${calls} tool call(s)]` : ""}`);
  }
}

const known = new Set(["run", "gauntlet", "eval", "bench", "tools", "plugin", "skills", "mcp", "market", "context", "doctor", "auth", "provider", "model", "models", "setup", "connect", "trace", "help", "chat", "repl", "smoke-tui", "acp", "serve", "export", "sessions", "trust"]);
if (cmd === "" || cmd === "chat" || cmd === "repl") {
  // The intro covers actual preparation, not only module imports. Plain chat loads no TUI graph.
  await (await import("./start-chat.ts")).startChat(cli);
} else if (known.has(cmd)) {
  switch (cmd) {
    case "run": {
      const { expandSlashPrompt } = await import("../tui/commands.ts");
      const { runPromptWords, readPipedStdin, withPipedInput } = await import("./output.ts");
      // Piped stdin rides along as a fenced block under the prompt — `git diff | rovecode run "review this"` —
      // which is what makes a one-shot run composable with every other tool on the machine. Never read from a
      // terminal, skipped with --no-stdin, and an open pipe that sends nothing is given up on with a note rather
      // than waited on forever (output.ts readPipedStdin). The words stay the prompt's head; with none, the
      // block is introduced as "Here is the input:" so the model is not handed a bare fence.
      const words = runPromptWords(cli, process.argv).join(" ");
      const piped = process.argv.includes("--no-stdin") ? "" : await readPipedStdin(process.stdin, { note: (l) => console.error(l) });
      await cmdRun(expandSlashPrompt(withPipedInput(words, piped) || "hello", process.cwd()));
      break;
    }
    case "gauntlet": case "eval": await cmdGauntlet(); break;
    case "bench": await cmdBench(); break;
    case "tools": await cmdTools(); break;
    case "plugin": process.exitCode = await (await import("../plugins/cli.ts")).cmdPlugin(argvAfter("plugin")); break;
    case "mcp": process.exitCode = await (await import("./mcp-market-cmd.ts")).cmdMcp(argvAfter("mcp")); break;
    case "trust": process.exitCode = await (await import("./trust-cmd.ts")).cmdTrust(argvAfter("trust"), process.cwd()); break; // approve this repo's gated files (core/trust.ts)
    case "market": process.exitCode = await (await import("./market-cmd.ts")).cmdMarket(argvAfter("market")); break;
    case "skills": process.exitCode = await (await import("./skills-cmd.ts")).cmdSkills(argvAfter("skills"), process.cwd()); break; // list · validate · pack · install (cli/skills-cmd.ts)
    case "context": process.exitCode = await (await import("./context-cmd.ts")).cmdContext(argvAfter("context")); break;
    case "doctor": process.exitCode = await (await import("./doctor.ts")).cmdDoctor(argvAfter("doctor")); break;
    case "setup": {
      const { runSetup } = await import("./setup.ts");
      const { ProviderRegistry } = await import("../providers/registry.ts");
      process.exitCode = await runSetup({ registry: new ProviderRegistry(process.cwd()) });
      break;
    }
    case "connect": process.exitCode = await cmdConnect(argvAfter("connect")); break;
    case "help": cmdHelp(cli.rest[0] ?? ""); break;
    case "auth": await cmdAuth(cli.rest); break;
    case "provider": await cmdProvider(argvAfter("provider")); break;
    case "model": await cmdModel(argvAfter("model")); break;
    case "models": await cmdModel(["list", ...argvAfter("models")]); break;
    // an id is required: without one this built a store on the empty id, printed nothing and exited 0 —
    // a silent success a reader takes for "this session has no messages"
    case "trace": {
      // the one session-id gate (cli/session-arg.ts): a missing, invalid, unknown or ambiguous id is exit 2 with one
      // stderr line — the store used to be built on whatever was typed (`trace ../x` joined a path outside the root)
      const { resolveSessionArg } = await import("./session-arg.ts");
      await cmdTrace(resolveSessionArg("rovecode trace", join(process.cwd(), ".rovecode", "sessions"), cli.rest[0])); break;
    }
    case "export": (await import("./export.ts")).cmdExport(process.argv); break;
    case "sessions": process.exitCode = (await import("./sessions-cmd.ts")).cmdSessions(process.argv, process.cwd()); break; // list · rename · delete · fork · search (cli/sessions-cmd.ts)
    case "smoke-tui": {
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
    case "acp": await (await import("../acp/server.ts")).runAcpStdio({ yolo: cli.yolo }); break;
    case "serve": {
      const { startServer } = await import("../server/http.ts");
      const port = Number(process.env.ROVECODE_PORT ?? "") || undefined;
      const srv = startServer({ ...(port !== undefined ? { port } : {}), yolo: cli.yolo });
      // an orderly stop on SIGTERM/SIGINT (systemd, Ctrl-C on a POSIX host): session_close hooks, MCP close and
      // task cancelAll run instead of the default kill. On Windows a signal is TerminateProcess — no handler runs.
      for (const sig of ["SIGTERM", "SIGINT"] as const) process.once(sig, () => { void Promise.resolve(srv.stop()).then(() => process.exit(0), () => process.exit(1)); });
      console.log(`rovecode server listening on ${srv.url} — POST /session · POST /session/:id/prompt (SSE) · DELETE /session/:id/prompt · GET /session/:id/tasks · GET /sessions · GET /doc`);
      break;
    }
    default: cmdHelp(); break;
  }
} else {
  // An unknown first word is a one-shot prompt — and a prompt is billed. A word shaped like a PATH
  // (./x, C:\x, foo.ts, a name that exists on disk) is far more often a mistyped or misplaced argument
  // than a prompt, so it is not sent silently: a person at a terminal is asked, a script is refused with
  // exit 2 (the usage class), and `rovecode run <word>` is the explicit way to send it regardless.
  // Sentences are never guarded — only the single path-shaped word (dispatch.ts pathShaped).
  const { pathShaped } = await import("./dispatch.ts");
  if (pathShaped(cmd)) {
    const words = process.argv.slice(process.argv.indexOf(cmd)).map((w) => (/\s/.test(w) ? JSON.stringify(w) : w)).join(" ");
    const why = `"${cmd}" looks like a path, not a prompt. A bare prompt is sent to your provider and billed; for a command see \`rovecode help\`, to send it as a prompt anyway: rovecode run ${words}`;
    if (!process.stdin.isTTY || !process.stderr.isTTY) { console.error(`error: ${why}`); process.exit(2); }
    const { askLine } = await import("./setup.ts");
    const answer = (await askLine(`${why}\nSend it as a prompt? [y/N] `)).trim().toLowerCase();
    if (answer !== "y" && answer !== "yes") { console.error("nothing sent"); process.exit(2); }
  }
  const { expandSlashPrompt } = await import("../tui/commands.ts");
  const { runPromptWords, readPipedStdin, withPipedInput } = await import("./output.ts");
  // the bare form is "the same as run" (help.ts), piped stdin included
  const piped = process.argv.includes("--no-stdin") ? "" : await readPipedStdin(process.stdin, { note: (l) => console.error(l) });
  await cmdRun(expandSlashPrompt(withPipedInput(runPromptWords(cli, process.argv).join(" "), piped), process.cwd()));
}
