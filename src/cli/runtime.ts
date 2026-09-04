/** Shared runtime construction for CLI surfaces (repl, run, tui): stores, tool
 *  registration, skills/memory indexes, provider resolution, RunConfig defaults.
 *  Extracted from repl.ts/main.ts so every surface builds the same agent. */

import type { AgentDefinition, ApprovalFn, Message, ModelRef, PermissionLevel, RunConfig, StreamFn, ThinkingEffort, Tool } from "../core/types.ts";
import { parseEffort } from "../core/types.ts";
import { SessionStore } from "../core/session.ts";
import { ToolRegistry } from "../core/tools.ts";
import { SkillStore } from "../skills/index.ts";
import { createSkillTools, buildSkillsIndex } from "../skills/tools.ts";
import { BlockStore } from "../memory/blocks.ts";
import { memoryEditTool } from "../memory/tools.ts";
import type { ProviderConfig } from "../providers/stream.ts";
import { ProviderRegistry } from "../providers/registry.ts";
import { providerEditTool, providerListTool } from "../tools/provider.ts";
import { designAuditTool, designDirectionTool } from "../tools/design.ts";
import { designPromptSection } from "../design/rules.ts";
import { withToolCallParsing, toolPromptBlock } from "../providers/middleware.ts";
import { ModelCatalog } from "../providers/catalog.ts";
import { GLM_53_AGENT_CONTRACT, profileFor, profilePromptSection } from "../providers/profiles.ts";
import { loadProjectContext, type ProjectContext } from "../core/config.ts";
import { estimateTokens, type ContextChunk } from "../core/context.ts";
import { parseCompactionStrategy } from "../core/compaction.ts";
import { ToolGuard } from "../core/guardrails.ts";
import { HookRunner } from "../core/hooks.ts";
import { createReflectionHooks, reflectionEnabled } from "../core/reflection.ts";
import { createOtelHooks, otelOptionsFromEnv } from "../telemetry/otel.ts";
import { loadMcpConfig, McpManager } from "../mcp/client.ts";
import { createMcpTools } from "../mcp/tools.ts";
import { activatePlugins, discoverPlugins, loadState as loadPluginState, type DiscoveredPlugin, type LoadedPlugin } from "../plugins/index.ts";
import type { McpServerConfig } from "../mcp/config.ts";
import { trustedPredicate } from "../mcp/trust.ts";
import { rovecodeHome } from "../providers/auth.ts";
import { readTool, editTool, writeTool, bashTool } from "../coding/hashline.ts";
import { globTool, grepTool, lsTool } from "../coding/files.ts";
import { withLspGate, lspGateNote } from "../coding/lsp.ts";
import { buildRepoMapChunk } from "../coding/repomap.ts";
import { anchorEntryId, Checkpoints, MUTATING_KINDS } from "../coding/checkpoints.ts";
import { createRouter, roleTableFromEnv, type Router } from "../providers/router.ts";
import { retryOptionsFromEnv, withRetry } from "../providers/retry.ts";
import { createEvalCellTool } from "../tools/evalcell.ts";
import { webFetchTool } from "../tools/webfetch.ts";
import { askUserTool, type AskFn } from "../tools/ask-user.ts";
import { execPolicyApprover } from "../core/execpolicy.ts";
import { recallTool } from "../memory/recall.ts";
import { configureExecutor, type SpawnRunner } from "../core/executor.ts";
import { loadSandboxConfig, unavailableRungError, type SandboxConfig } from "../core/sandbox-config.ts";
import { loadTodos, planReminder, todoTools } from "../tools/todo.ts";
import { SteeringQueue } from "../core/loop.ts";
import { TaskManager } from "../core/tasks.ts";
import { createTaskTool, createTaskStatusTool } from "../tools/task.ts";
import type { ChildContext, ChildRunnerDeps } from "../core/orchestrator.ts";
import { mkdirSync } from "node:fs";
import { sep, join } from "node:path";
import { randomUUID } from "node:crypto";
import { noModelHint } from "../core/voice.ts";

/** upper bound on the per-model max_tokens buildDef derives from the catalog: enough for a long page or
 *  plan, not the 128K some models advertise — a runaway answer should stop before it costs that much */
export const MAX_OUTPUT_CAP = 32_768;

export interface RuntimeOptions {
  cwd?: string;
  sessionId?: string;
  /** override the provider-derived stream (tests); null forces "no stream" */
  stream?: StreamFn | null;
  /** port #27 test seam: process runner behind the executor rung (probe AND
   *  commands); default Bun.spawn. Tests must never probe a real wsl.exe/docker. */
  spawnRunner?: SpawnRunner;
  /** port #27 test seam: platform the rung probe assumes; default process.platform */
  platform?: NodeJS.Platform;
}

/** port #27: the rung this runtime asked the executor seam for, plus its probe. */
export interface SandboxState extends SandboxConfig {
  /** settles once the rung is probed + installed behind getExecutor(); rejects
   *  with SandboxConfigError (one line). Await it before the first tool call —
   *  bootRuntime does; until then a non-direct rung is "desired, not yet met"
   *  and bashTool would get the seam's RungUnavailableError, never lazy direct. */
  ready: Promise<void>;
}

export interface Runtime {
  cwd: string;
  sessionId: string;
  store: SessionStore;
  registry: ToolRegistry;
  skillStore: SkillStore;
  blockStore: BlockStore;
  /** the live provider registry (providers/registry.ts): providers.json (user + project) + stored
   *  credentials + env, hot-reloaded on file change — `rovecode provider add`, `/provider …` in the
   *  TUI and the agent's provider_edit tool all land here and serve the next model call, no restart */
  providers: ProviderRegistry;
  /** the default provider as a stream.ts config — LIVE (re-resolved on every read); null when none */
  provider: ProviderConfig | null;
  /** the registry's dispatching stream (router → retry → middleware → per-provider adapter) or the
   *  opts.stream override; null only when opts.stream was explicitly null */
  stream: StreamFn | null;
  /** env ROVECODE_MODEL ?? providers.json `default` ?? the default provider's model ?? "" — LIVE */
  defaultModel: string;
  /** null when a run can start; else the one-line reason (no provider configured yet). Live: adding
   *  a provider through the CLI, the TUI or the agent flips it back to null without a restart.
   *  Always null when the runtime was built with an injected stream (tests, smoke). */
  noProviderReason(): string | null;
  /** interactive system prompt incl. skills index + memory index (indexes rebuilt per call). `cwdOverride`
   *  names another directory in the identity sentence — the live gauntlet points the model at its scratch
   *  workspace while everything else (indexes, profile override lookup) stays on the runtime's cwd */
  systemPrompt(cwdOverride?: string): string;
  buildDef(model: ModelRef, opts?: { cwd?: string }): AgentDefinition;
  /** `true`/`false` still mean auto/ask — every existing caller keeps working */
  buildCfg(permission: PermissionLevel | boolean, approval?: ApprovalFn): RunConfig;
  /** swap the session-scoped memory store — rebinds the memory tool AND the prompt (port #2 fix) */
  setBlockStore(b: BlockStore): void;
  /** tool-loop guardrails (port #4), one per runtime, thread into LoopDeps.guard */
  guard: ToolGuard;
  /** port #32: the open todo list, re-sent once per turn — thread into LoopDeps.planReminder */
  planReminder: (history: readonly Message[]) => string | null;
  /** How hard the model thinks before answering. Stamped onto every ModelRef buildDef hands out, so
   *  ONE setting reaches every surface (TUI, one-shot, serve, acp) without each threading a flag.
   *  A ref that already names an effort keeps it. */
  effort: ThinkingEffort;
  setEffort(e: ThinkingEffort): void;
  /** MCP server manager (port #3); null when no servers configured */
  mcp: McpManager | null;
  /** port #8 config snapshot (AGENTS.md/CLAUDE.md/… harvested cwd-upward ONCE
   *  at construction, for prompt-cache stability) incl. dropped/truncated
   *  source stubs for /status. Mid-session config edits are intentionally not
   *  picked up — restart rovecode (a new runtime) to refresh. */
  projectContext: ProjectContext;
  /** port #14: role→model router with fallback chains (env ROVECODE_MODEL_<ROLE>). */
  router: Router;
  /** port #14: fallback-advance notes accumulated since the last drain. */
  drainRouterNotes(): string[];
  /** port #11: shadow-git checkpoints for a session (lazy; null when git is absent
   *  or ROVECODE_NO_CHECKPOINTS=1). Snapshots land automatically after mutating tools. */
  checkpointsFor(sessionId: string): Promise<Checkpoints | null>;
  /** port #11: point checkpoint entryId capture at the ACTIVE session store after
   *  a TUI session switch (pairs with setBlockStore). */
  setSessionStore(s: SessionStore): void;
  /** port #27: executor rung selected by .rovecode/sandbox.json / ROVECODE_SANDBOX (+ probe) */
  sandbox: SandboxState;
  /** port #33: bind (or unbind with undefined) the interactive asker behind the ask_user
   *  tool — the TUI hands in its question overlay; headless surfaces (run/serve/acp) never
   *  call this, so the tool fails closed for them. setBlockStore idiom: registered once,
   *  dependency rebound late. */
  setAskUser(fn: AskFn | undefined): void;
  /** port #26: the ONE steering queue for this runtime's runs — hand it to agentLoop
   *  (in place of a fresh SteeringQueue) so background-task completion notes reach the
   *  parent's next turn. Surfaces with their own queue: rt.tasks.attach(queue). */
  steering: SteeringQueue;
  /** port #26: background subagents (bounded FIFO jobs over orchestrator runChild) */
  tasks: TaskManager;
  /** port #29: typed hook set — `.rovecode/hooks.{ts,js}` (+ `~/.rovecode`, ROVECODE_HOME) loaded at construction
   *  (background import; every run() waits for it, so no surface can race the load), session_open
   *  fired once loaded. Thread into LoopDeps.hooks; attach more sets programmatically via hooks.add()
   *  (port #39 OTel); surfaces call hooks.close() at teardown → session_close once. Load + runtime
   *  notes (import failure, wrong version, timeout, throw) land in hooks.warnings / onWarning(). */
  hooks: HookRunner;
  /** plugins (src/plugins, docs/plugins.md): discovered synchronously at construction — manifests and
   *  statuses only, no code run — so an ACTIVE plugin's skills, commands and MCP servers wire in with
   *  their file-based twins; the entry modules (tools + hooks) import in the background and `ready`
   *  joins them (bootRuntime awaits it, so no surface's first prompt can miss a plugin tool). A
   *  PROJECT plugin stays `untrusted` — nothing of it loads — until `rovecode plugin trust`. */
  plugins: RuntimePlugins;
}

export interface RuntimePlugins {
  /** every plugin found at construction, with its status (`rovecode plugin list` shows the same) */
  found: readonly DiscoveredPlugin[];
  /** settles when the active entry modules are imported and their tools/hooks attached */
  ready: Promise<void>;
  /** the plugins as activated — empty until `ready` */
  readonly loaded: readonly LoadedPlugin[];
  /** discovery + activation notes; a listener gets the buffered ones first (hooks.onWarning idiom) */
  readonly warnings: readonly string[];
  onWarning(fn: (note: string) => void): void;
}

export function createRuntime(opts: RuntimeOptions = {}): Runtime {
  const cwd = opts.cwd ?? process.cwd();
  // port #27: sandbox rung selection comes FIRST — a config error throws before any
  // side effect (no sessions dir, no MCP children). The probe (wsl/docker trial
  // spawn, 500ms cap) runs concurrently with the rest of construction; its verdict
  // is `sandbox.ready`. The seam records the DESIRED rung synchronously (#10 G7),
  // so an unmet wsl/docker desire is loud at bashTool, never a silent direct.
  const sandboxCfg = loadSandboxConfig(cwd);
  const ready = configureExecutor(sandboxCfg.rung, {
    runner: opts.spawnRunner, dockerImage: sandboxCfg.dockerImage, platform: opts.platform,
  }).then(() => undefined, (e: unknown) => { throw unavailableRungError(sandboxCfg, e); });
  void ready.catch(() => {}); // verdict is read via bootRuntime / await — never an unhandled rejection
  const sandbox: SandboxState = { ...sandboxCfg, ready };
  const sessionsDir = join(cwd, ".rovecode", "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  const sessionId = opts.sessionId ?? randomUUID();
  const store = new SessionStore(sessionsDir, sessionId);

  // port #11: shadow-git checkpoints — one repo per session under .rovecode/checkpoints/,
  // snapshot after every SUCCESSFUL mutating tool call (kinds write/execute). Lazy
  // per-session init; git absent or ROVECODE_NO_CHECKPOINTS=1 → silently off.
  const cpBySession = new Map<string, Promise<Checkpoints | null>>();
  const checkpointsFor = (sid: string): Promise<Checkpoints | null> => {
    if (process.env.ROVECODE_NO_CHECKPOINTS === "1") return Promise.resolve(null);
    let p = cpBySession.get(sid);
    if (!p) { p = Checkpoints.init({ workspace: cwd, sessionId: sid }).then((c) => c, () => null); cpBySession.set(sid, p); }
    return p;
  };
  let activeStore = store; // TUI session switches re-point it via setSessionStore
  const withCheckpoint = (t: Tool): Tool => !MUTATING_KINDS.has(t.kind) ? t : {
    ...t,
    execute: async (a, c) => {
      const out = await t.execute(a, c);
      if (out.ok) {
        const cp = await checkpointsFor(c.sessionId);
        // conversation-restore anchor: last USER message (HIGH-2 — the tail entry is the
        // assistant message that ISSUED this very tool call; branching there strands its
        // tool_calls with no replies -> provider 400), when the active store IS this session
        const entryId = activeStore.id === c.sessionId ? anchorEntryId(activeStore.messages()) : undefined;
        await cp?.snapshot(t.schema.name, entryId).catch(() => {});
      }
      return out;
    },
  };

  const registry = new ToolRegistry();
  // plugins (src/plugins, docs/plugins.md): discovery runs no code — manifests, statuses, digests — so
  // it can happen here, synchronously, and the ACTIVE plugins' declarative halves (skills dirs,
  // command dirs, MCP servers) join their file-based twins below as if they had been in .rovecode/.
  // The entry modules import after construction (see the activation block after hooks.open).
  const pluginHome = rovecodeHome();
  const pluginState = loadPluginState(pluginHome); // one trust store for project plugins AND project MCP files
  const pluginsFound = discoverPlugins(cwd, { home: pluginHome, state: pluginState });
  const pluginWarnings: string[] = [...pluginsFound.warnings];
  const pluginListeners: ((note: string) => void)[] = [];
  const pluginWarn = (note: string): void => { pluginWarnings.push(note); for (const l of pluginListeners) l(note); };
  const activePlugins = pluginsFound.plugins.filter((p) => p.status === "active"); // untrusted/disabled/broken contribute NOTHING
  // port #13: successful edits/writes get LSP diagnostics appended within a ≤2s
  // settle window (typescript-language-server on PATH; absent → silently off).
  const lspNote = (p: string): Promise<string> => lspGateNote(p, cwd);
  registry.register(readTool, withCheckpoint(withLspGate(editTool, lspNote)), withCheckpoint(withLspGate(writeTool, lspNote)), withCheckpoint(bashTool));
  registry.register(globTool, grepTool, lsTool); // port #22: bounded, gitignore-aware search/list (kind read → file.read auto-allow; non-mutating, no checkpoint)
  registry.register(webFetchTool); // port #31: kind network → net.fetch, PROMPT by default (rule below); SSRF-guarded, bounded; no checkpoint
  // a plugin's skills dir joins the store as one more root: a user plugin's as global, a project
  // plugin's as project (the same precedence its own files would have had)
  const skillStore = new SkillStore(cwd, { extraDirs: activePlugins.flatMap((p) => (p.skillsDir ? [{ dir: p.skillsDir, scope: p.scope === "project" ? "project" as const : "global" as const }] : [])) });
  skillStore.scan();
  registry.register(...createSkillTools(skillStore));
  let blocks = new BlockStore(join(sessionsDir, sessionId, "memory"));
  registry.register(memoryEditTool(blocks));
  // port #18: persistent eval cell — registered ONLY when ROVECODE_EVAL_CELL=1
  const evalCell = createEvalCellTool();
  if (evalCell) registry.register(withCheckpoint(evalCell));
  // port #17: cross-session recall (kind read → file.read gate; pure transcript search)
  registry.register(recallTool(sessionsDir));
  registry.register(...todoTools(sessionsDir)); // port #32: per-session todo list at <session>/todos.json (todo_write kind memory → memory.write allow; todo_read kind read)

  /** LoopDeps.planReminder: while a plan is open, re-send it as the LAST thing in the request. Read
   *  from disk every turn, so the agent's own todo_write (and a /todos edit, and a second surface on
   *  the same session) are all reflected. Skipped when the model just wrote the list — it is already
   *  looking at that tool result, and a copy right under it teaches nothing. */
  const planReminderFor = (history: readonly Message[]): string | null => {
    const last = history.at(-1);
    if (last?.parts.some((p) => p.kind === "tool_result" && p.output.startsWith("todos:"))) return null;
    const dir = join(sessionsDir, store.id);
    try { return planReminder(loadTodos(dir).items); } catch { return null; } // a missing/corrupt list never blocks a turn
  };
  // providers: ONE live registry per runtime (providers/registry.ts) — providers.json (user + project),
  // stored credentials and env, re-read when a source file changes. provider_list is kind read (always
  // allowed); provider_edit is kind custom → tool.provider_edit, PROMPT under the gated rules below
  const providers = new ProviderRegistry(cwd);
  registry.register(providerListTool(providers), providerEditTool(providers));
  // design protocol (design/rules.ts): design_audit is kind read (free, never prompts -- checking your
  // own work must cost nothing); design_direction is kind custom -> tool.design_direction, PROMPT under
  // the gated rules, because it records the project's design identity and is asked once per project.
  registry.register(designAuditTool(), designDirectionTool());
  // port #33: ask_user on EVERY surface (kind read → auto-runs under gated/plan rules); only an
  // interactive surface binds an asker via setAskUser — unbound, the tool fails closed
  let askUser: AskFn | undefined;
  registry.register(askUserTool(() => askUser));
  const guard = new ToolGuard(); // port #4: loop signatures + duplicate-result stubs
  // port #29: hooks v2 — the runner exists synchronously (createRuntime stays sync); open() imports
  // .rovecode/hooks.{ts,js} (+ user scope) in the background and fires session_open; run() awaits it
  const hooks = new HookRunner({ cwd, sessionId });
  void hooks.open(cwd);

  // plugin entry modules: imported in the background like the hook files, joined by bootRuntime through
  // plugins.ready. Tools land on THIS registry (the same permission path as every built-in: kind → action)
  // and are refused loudly when the name is taken — a plugin cannot replace `bash`. Hooks join the runner
  // after the hook files (they miss session_open; pre_run is theirs). Activation failures are notes.
  let loadedPlugins: LoadedPlugin[] = [];
  const pluginsReady = activatePlugins(pluginsFound.plugins, { cwd, home: pluginHome }).then((a) => {
    for (const w of a.warnings) pluginWarn(w);
    const taken = new Set(registry.list().map((t) => t.schema.name));
    for (const p of a.plugins) {
      if (p.status !== "active") continue;
      for (const t of p.tools) {
        if (taken.has(t.schema.name)) { pluginWarn(`plugin ${p.name}: tool "${t.schema.name}" is already registered — refused (a plugin cannot replace a built-in or another plugin's tool)`); continue; }
        taken.add(t.schema.name);
        registry.register(t);
      }
      if (p.hooks) hooks.add(p.hooks, `plugin:${p.name}`);
    }
    loadedPlugins = a.plugins;
  }, (e: unknown) => { pluginWarn(`plugins: activation failed — ${e instanceof Error ? e.message : String(e)}`); });
  const plugins: RuntimePlugins = {
    found: pluginsFound.plugins,
    ready: pluginsReady,
    get loaded() { return loadedPlugins; },
    warnings: pluginWarnings,
    onWarning(fn) { for (const w of pluginWarnings) fn(w); pluginListeners.push(fn); },
  };

  // port #3: MCP servers from .rovecode/mcp.json + harvested .mcp.json; two lazy tools only.
  // connect() is fire-and-forget; tool executes await first-connect before dispatching.
  // plugin MCP servers first, then the project's own files — .rovecode/mcp.json keeps the last word on a name
  const mcpByName = new Map<string, McpServerConfig>();
  for (const p of activePlugins) for (const c of p.mcp) {
    if (mcpByName.has(c.name)) { pluginWarn(`plugin ${p.name}: MCP server "${c.name}" is also declared by another plugin — first kept`); continue; }
    mcpByName.set(c.name, c);
  }
  // the user file (~/.rovecode/mcp.json — where `rovecode mcp add` writes) is the lowest of the three layers.
  // Project files (.rovecode/mcp.json, .mcp.json) pass the same trust gate as project plugins (mcp/trust.ts):
  // unapproved on this machine → nothing of theirs loads, one `mcp: …` note names the file and the command.
  const mcpWarnings: string[] = [];
  for (const c of loadMcpConfig(cwd, mcpWarnings, { home: pluginHome, trusted: trustedPredicate(pluginState) })) { if (mcpByName.has(c.name)) pluginWarn(`mcp.json server "${c.name}" overrides a plugin's entry of the same name`); mcpByName.set(c.name, c); }
  for (const w of mcpWarnings) pluginWarn(`mcp: ${w}`);
  const mcpConfigs = [...mcpByName.values()];
  let mcp: McpManager | null = null;
  if (mcpConfigs.length > 0) {
    const manager = new McpManager(mcpConfigs);
    mcp = manager;
    const ready = manager.connect().then(() => undefined, () => undefined);
    for (const t of createMcpTools(manager)) {
      registry.register({ ...t, execute: async (a, c) => { await ready; return t.execute(a, c); } });
    }
  }

  // boot-time view of the default provider — only the router's role table is pinned to it; every
  // other reader goes through the LIVE getters on the returned Runtime (provider / defaultModel)
  const bootDefault = providers.defaultRef();
  // port #14: role router + fallback chains (env ROVECODE_MODEL_DEFAULT/SMOL/PLAN/COMMIT/TASK,
  // comma-separated provider/model chains). The registry's dispatcher routes every candidate to
  // ITS OWN provider's endpoint, so a cross-provider chain really fails over.
  const routerNotes: string[] = [];
  const fallbackRef: ModelRef = { provider: bootDefault?.provider ?? "mock", model: bootDefault?.model || "default" };
  const router = createRouter({
    roles: roleTableFromEnv(fallbackRef),
    // MED-3: an explicitly configured default chain is the fallback pool even for models
    // outside it (requested model prepended as primary); the synthesized single-model
    // default (env unset) must NOT capture loose models — hence the env gate.
    looseFallback: (process.env.ROVECODE_MODEL_DEFAULT ?? "").trim().length > 0,
    onNote: (n) => routerNotes.push(
      `router: ${n.chain} ${n.from.provider}/${n.from.model} → ${n.to ? `${n.to.provider}/${n.to.model}` : "chain exhausted"} (${n.reason})`),
  });
  // port #7: provider streams get the non-native tool-call parser (strict-gated passthrough
  // for native turns); injected test streams stay untouched. Kill switch: ROVECODE_NO_TOOL_MIDDLEWARE=1
  // port #14: the router wraps OUTERMOST (chain advance re-drives the whole turn).
  // port #23: same-model retry sits INSIDE the router — backoff retries exhaust on candidate N
  // before the chain advances (ROVECODE_RETRY_MAX / ROVECODE_RETRY_BASE_MS; providers/retry.ts header).
  // The raw stream is the registry's DISPATCHER: it resolves model.provider on every call against the
  // live snapshot, so the wrapped stream below never needs rebuilding when providers change. With
  // nothing configured it yields a `config:` error turn (non-retryable) — surfaces consult
  // noProviderReason() first and cmdRun keeps its mock fallback.
  const rawStream = providers.stream();
  const middlewared = process.env.ROVECODE_NO_TOOL_MIDDLEWARE !== "1" ? withToolCallParsing(rawStream) : rawStream;
  const stream = opts.stream !== undefined ? opts.stream : router.wrap(withRetry(middlewared, { ...retryOptionsFromEnv(), onRetry: (n) => routerNotes.push(`retry: ${n.model.provider}/${n.model.model} attempt ${n.attempt} in ${n.delayMs}ms (${n.reason})`) })); // retries surface as router-style notes (drainRouterNotes)
  const catalog = new ModelCatalog(); // offline models.dev snapshot (port #6)
  // port #39: OTel span export rides the hook seam — attached ONLY when ROVECODE_OTEL_ENDPOINT is set (off:
  // nothing constructed, no on_event tap → zero cost); export failures surface through hooks.warnings
  const otel = otelOptionsFromEnv();
  if (otel) hooks.add(createOtelHooks({ ...otel, pricing: catalog, messages: () => activeStore.messages() }), "otel");

  // port #8: harvest AGENTS.md / CLAUDE.md / .cursor / copilot instructions
  // cwd-UPWARD (OMP ancestor-walk pattern) ONCE per runtime — a snapshot, like
  // BlockStore, so the system prompt stays byte-stable for prompt caching
  // (MED-4). It reaches the model as an ADR-007 "config" chunk (priority 70)
  // via buildDef → assembleContext, never a second prompt-assembly path.
  const projectContext = loadProjectContext(cwd);
  const configText = `# Project context${projectContext.text}`;
  const configChunk: ContextChunk | null = projectContext.text
    ? { name: "config", text: configText, priority: 70, tokens: estimateTokens(configText) }
    : null;

  // port #12: repo-map fills the reserved ADR-007 chunk (priority 80, set by the
  // module: system>files>repo-map>skills/config>history). Built LAZILY at the
  // first buildDef() and memoized — createRuntime stays sync-cheap (`rovecode tools`,
  // ACP session setup pay nothing) and per-file tags persist under
  // .rovecode/cache/repomap.json, so warm launches skip extraction. Frozen after
  // the first build, like config, for prompt-cache stability. ROVECODE_NO_REPOMAP=1
  // disables; budget override via ROVECODE_REPOMAP_TOKENS (default 1024, aider's).
  let extraChunksMemo: ContextChunk[] | null = null;
  const extraChunks = (): ContextChunk[] => {
    if (extraChunksMemo !== null) return extraChunksMemo;
    let repoMapChunk: ContextChunk | null = null;
    if (process.env.ROVECODE_NO_REPOMAP !== "1") {
      const budget = Number(process.env.ROVECODE_REPOMAP_TOKENS ?? "") || 1024;
      try { repoMapChunk = buildRepoMapChunk(cwd, budget); } catch { repoMapChunk = null; }
    }
    extraChunksMemo = [configChunk, repoMapChunk].filter((c): c is ContextChunk => c !== null);
    return extraChunksMemo;
  };

  const systemPrompt = (cwdOverride?: string): string => {
    const skillsIndex = buildSkillsIndex(skillStore);
    const memoryIndex = blocks.renderForPrompt();
    return `You are Rovecode, an interactive coding agent in ${cwdOverride ?? cwd}. Use read/edit/write/bash tools. Edits require line hashes from read output. Match the length of an answer to the task: a line for a lookup, the full thing for a plan, a design or a review — never pad, never truncate work that was asked for.${skillsIndex ? "\n\n# Skills\n" + skillsIndex : ""}${memoryIndex ? "\n\n# Memory\n" + memoryIndex : ""}`;
  };

  // ROVECODE_EFFORT is the boot default; /effort and --effort move it at runtime
  // default "auto": no thinking field on the wire, the provider's own default stands (Claude 5: adaptive,
  // high). The old default "off" sent an explicit `thinking: disabled` and switched off the reasoning the
  // model does by itself — most of "we are not getting the model's real performance" (Berkay, 2026-09-04).
  let effort: ThinkingEffort = parseEffort(process.env.ROVECODE_EFFORT) ?? "auto";

  const buildDef = (model: ModelRef, opts: { cwd?: string } = {}): AgentDefinition => {
    if (model.effort === undefined) model = { ...model, effort }; // one dial, every surface
    activeModel = model; // port #26: children run the model of the run that started them
    // models the catalog knows CANNOT do native tool calling get the senpi-format
    // prompt block (port #7); unknown models attempt native first. Force: ROVECODE_TOOL_MIDDLEWARE=1
    const info = catalog.lookup(model.provider, model.model);
    // the answer's room comes from the catalog (models.dev maxOutput), capped: the old flat 4096 default
    // truncated long outputs — a whole page of UI, a long plan — mid-sentence, and the model was blamed
    if (model.maxTokens === undefined && info?.maxOutput) model = { ...model, maxTokens: Math.min(info.maxOutput, MAX_OUTPUT_CAP) };
    // the catalog's word on a reasoning mode rides with the ref: thinking.ts sends no dial to a model listed without one
    if (model.reasoning === undefined && info?.supportsReasoning !== undefined) model = { ...model, reasoning: info.supportsReasoning };
    const nonNative = info?.supportsTools === false || process.env.ROVECODE_TOOL_MIDDLEWARE === "1";
    // model profile (providers/profiles.ts): a per-family behavioral section rides AFTER the base prompt
    // and its indexes and BEFORE the tool-calling block — one string for the whole run (prompt cache);
    // .rovecode/profiles/<id>.md replaces the built-in text, ROVECODE_PROFILE=off drops it
    const profile = profileFor(model);
    // A model WITHOUT a profile gets the working agreement too (profile-glm53.ts names no model or vendor
    // — it is the harness's contract: read before edit, verify before "done", parallel calls, scope).
    // Until now only GLM received it and Claude/GPT got one sentence; that asymmetry cost quality.
    const section = profile === null ? GLM_53_AGENT_CONTRACT : profilePromptSection(profile, cwd); // "" = an empty override file: no section, no separator
    // design protocol (design/rules.ts): the ban list plus this project's recorded direction, read
    // once per run start like the profile so the system prefix stays byte-stable (prompt cache).
    // ROVECODE_DESIGN=off drops it for a run that has nothing to do with interfaces.
    const design = process.env.ROVECODE_DESIGN === "off" ? "" : designPromptSection(opts.cwd ?? cwd);
    const base = [systemPrompt(opts.cwd), section, design].filter((p) => p.length > 0).join("\n\n");
    return {
      name: "main", model, tools: ["*"],
      systemPrompt: nonNative
        ? `${base}\n\n# Tool calling\n${toolPromptBlock(registry.list().map((t) => t.schema))}`
        : base,
      ...(extraChunks().length > 0 ? { contextChunks: extraChunks() } : {}),
    };
  };
  /** the workspace as a rule resource: every path resource is absolute (tools.ts describeResource),
   *  so `<cwd><sep>*` is "inside this repository" and nothing else — a sibling directory whose name
   *  merely STARTS with the cwd (…/repo-backup) does not match, because the separator is in the glob. */
  const insideCwd = `${cwd.replace(/[\/]$/, "")}${sep}*`;

  const buildCfg = (permission: PermissionLevel | boolean, approval?: ApprovalFn): RunConfig => {
    const level: PermissionLevel = permission === true ? "auto" : permission === false ? "ask" : permission;
    const yolo = level === "auto";
    return (activeCfg = {
    maxTurns: 60, contextBudgetTokens: 200_000, compactionThreshold: 0.8,
    compactionStrategy: parseCompactionStrategy(process.env.ROVECODE_COMPACTION) ?? "head-summarize", // port #25: ROVECODE_COMPACTION=head-summarize|keep-window|provider-native
    parallelTools: true,
    permissionRules: yolo
      ? [{ action: "*", resource: "*", effect: "allow" }]
      : [
          { action: "file.read", resource: "*", effect: "allow" },
          { action: "memory.write", resource: "*", effect: "allow" },
          { action: "tool.skill_view", resource: "*", effect: "allow" },
          { action: "tool.skills_list", resource: "*", effect: "allow" },
          // mcp_list is kind:"read" → action "file.read"; the allow above already covers it
          { action: "file.write", resource: "*", effect: "prompt" },
          { action: "shell.exec", resource: "*", effect: "prompt" },
          { action: "spawn", resource: "*", effect: "prompt" },
          { action: "tool.mcp_call", resource: "*", effect: "prompt" },
          // provider_edit (tools/provider.ts) rewrites providers.json / the default model: ask first.
          // provider_list is kind read → covered by the file.read allow above
          { action: "tool.provider_edit", resource: "*", effect: "prompt" },
          // design_direction writes .rovecode/design.json -- the once-per-project design identity
          { action: "tool.design_direction", resource: "*", effect: "prompt" },
          // port #31: resource = canonical host (lowercased, no trailing dot), so `allow
          // net.fetch <host>` auto-runs THAT host only; web_fetch stops at a redirect to
          // another host and reports it, so the new host gets its own decision here
          { action: "net.fetch", resource: "*", effect: "prompt" },
          // accept-edits: writing INSIDE the workspace stops asking. Placed last of the file.write
          // rules because the last match wins (tools.ts evaluatePermissions) — a write outside the
          // repo still hits the prompt rule above, and any deny rule a surface appends still wins.
          ...(level === "accept-edits" ? [{ action: "file.write", resource: insideCwd, effect: "allow" as const }] : []),
        ],
    // port #9: execpolicy refines the PROMPT branch only (allow-listed argv →
    // "once", forbidden → deny before any human); rules above stay the outer gate.
    // The wrap is UNCONDITIONAL on gated configs (R2 #9 LOW-3): headless surfaces
    // (run/serve pass no approver) get allow-list auto-run + forbidden hard-stop,
    // and prompt-classified argv fails closed instead of "no approver connected".
    // yolo stays approver-free — its allow-all rules never reach the prompt branch.
    // port #29: the approval hook sits INSIDE the wrap, where the human would — a
    // forbidden argv never reaches a hook, an allow-listed one never asks (hooks.ts).
    approval: yolo ? undefined : execPolicyApprover(hooks.approver(approval)),
    });
  };

  // port #26: background subagents. Children run through orchestrator runChild (the ONE
  // agentLoop) with deps resolved at each start: the def/config of the run that STARTED
  // the task (buildDef/buildCfg record them — every surface calls both right before its
  // agentLoop, so a child inherits its parent's model and policy; deriveChildRules turns
  // prompt→deny). ONE SteeringQueue per runtime: surfaces hand it to agentLoop and
  // completion notes land in the parent's next turn (loop.ts:136). Children get the core
  // coding/search/skill tools (no MCP/memory/eval-cell/checkpoints in v1) plus nested
  // `task` (kind spawn, bound to THEIR depth + steering queue, so the depth cap governs
  // nesting) and `task_status` (kind read: a child collects ITS children's results without
  // a prompt nobody could answer — MED-2 split, tools/task.ts header).
  let activeCfg: RunConfig | null = null;
  let activeModel: ModelRef | null = null;
  const steering = new SteeringQueue();
  const childRegistry = (_def: AgentDefinition, _cwd: string, child?: ChildContext): ToolRegistry => {
    const reg = new ToolRegistry();
    reg.register(readTool, editTool, writeTool, bashTool, globTool, grepTool, lsTool, ...createSkillTools(skillStore), recallTool(sessionsDir));
    if (child) reg.register(createTaskTool(tasks, { parentDepth: child.depth, notify: child.steering, caller: child.taskId, owner: child.signal }), createTaskStatusTool(tasks, { caller: child.taskId }));
    return reg;
  };
  const tasks = new TaskManager({
    deps: (): ChildRunnerDeps | null => stream ? {
      defs: new Map([["main", buildDef(activeModel ?? fallbackRef)]]),
      stream, registryFactory: childRegistry, rootDir: cwd, sessionsDir,
      baseConfig: activeCfg ?? buildCfg(false),
      hooks, // port #29: children run under the runtime's hooks (a veto cannot be dodged by delegation)
    } : null,
  });
  tasks.attach(steering);
  // port #28: built-in reflection set (core/reflection.ts) — a failed edit/write (or an LSP-diagnosed one) nudges the model once via steering, capped per run (ROVECODE_REFLECTION_MAX); ROVECODE_REFLECTION=0 disables.
  // owns: the ACTIVE session's runs only — a task child (own store id, same hooks) must neither nudge nor sweep this queue (#26 MED-A)
  if (reflectionEnabled()) hooks.add(createReflectionHooks({ steering, owns: (c) => c.sessionId === activeStore.id }), "reflection");
  registry.register(createTaskTool(tasks, { parentDepth: 0 }), createTaskStatusTool(tasks)); // task: kind spawn → gated rules prompt once per start, yolo allows; task_status: kind read → allowed everywhere

  return {
    cwd, sessionId, store, registry, skillStore,
    get blockStore() { return blocks; },
    setBlockStore(b: BlockStore) { blocks = b; registry.register(memoryEditTool(b)); },
    guard, planReminder: planReminderFor, mcp, projectContext, router,
    get effort() { return effort; },
    setEffort(e: ThinkingEffort) { effort = e; },
    drainRouterNotes: () => routerNotes.splice(0),
    checkpointsFor,
    setSessionStore(s: SessionStore) { activeStore = s; },
    sandbox,
    setAskUser(fn: AskFn | undefined) { askUser = fn; },
    hooks,
    plugins,
    providers,
    get provider() { return providers.defaultConfig(); },
    stream,
    get defaultModel() { return providers.defaultRef()?.model ?? process.env.ROVECODE_MODEL ?? ""; },
    noProviderReason: () => (opts.stream === undefined && !providers.configured() ? NO_PROVIDER_HINT : null),
    systemPrompt,
    buildDef, buildCfg,
    steering, tasks,
  };
}

/** The one sentence every surface shows when nothing is configured (Runtime.noProviderReason). */
export const NO_PROVIDER_HINT = noModelHint("cli");

/** port #27: construct + await the sandbox probe — the boot path for every
 *  entrypoint that must fail CLEANLY at startup (run/repl/tui/acp/serve).
 *  createRuntime stays sync (its many callers/tests build synchronously); this
 *  is the one place the async verdict is joined. Throws SandboxConfigError
 *  (one actionable line) for a bad config or a configured rung the machine
 *  cannot provide; MCP children spawned during construction are reaped first,
 *  so a failed boot leaves no processes behind. */
export async function bootRuntime(opts: RuntimeOptions = {}): Promise<Runtime> {
  const rt = createRuntime(opts);
  try {
    await rt.sandbox.ready;
    await rt.hooks.ready; // port #29: hook files + session_open joined here too (notes recorded before the first prompt)
    await rt.plugins.ready; // plugin entry modules imported, their tools and hooks attached — before any surface's first prompt
  } catch (e) {
    await rt.mcp?.close().catch(() => {});
    throw e;
  }
  return rt;
}
