/** Shared runtime construction for CLI surfaces (repl, run, tui): stores, tool
 *  registration, skills/memory indexes, provider resolution, RunConfig defaults.
 *  Extracted from repl.ts/main.ts so every surface builds the same agent. */

import type { AgentDefinition, ApprovalFn, Message, ModelRef, PermissionLevel, RunConfig, StreamFn, ThinkingEffort, TokenUsage, Tool } from "../core/types.ts";
import { parseEffort } from "../core/types.ts";
import { SessionStore } from "../core/session.ts";
import { ToolRegistry } from "../core/tools.ts";
import { SkillStore } from "../skills/index.ts";
import { createSkillTools, buildSkillsIndex } from "../skills/tools.ts";
import { BlockStore } from "../memory/blocks.ts";
import { openScopedMemory } from "../memory/scope.ts";
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
import { settingsTrustNotes } from "../core/settings.ts";
import { createReflectionHooks, reflectionEnabled } from "../core/reflection.ts";
import type { McpManager } from "../mcp/client.ts";
import { activatePlugins, discoverPlugins, loadState as loadPluginState, type DiscoveredPlugin, type LoadedPlugin } from "../plugins/index.ts";
import type { McpServerConfig } from "../mcp/config.ts";
import { trustedPredicate } from "../mcp/trust.ts";
import { positiveInt, positiveUsd, type RunLimits } from "./run-limits.ts";
import { costUsdTiered } from "../core/usage.ts";
import { ratesFor } from "../providers/catalog.ts";
import { contextBudgetFor } from "../core/context-report.ts";
import { tokenScaleFor } from "../core/token-scale.ts";
import { laneApprover } from "../lanes/approval.ts";
import { BashJobManager, installJobManager } from "../tools/bash-jobs.ts";
import { bashJobTools } from "../tools/bash-bg.ts";
import { isAdapterId } from "../lanes/types.ts";
import { createWebSearchTool } from "../tools/websearch.ts";
import type { LaneJobDeps } from "../lanes/job.ts";
import { rovecodeHome } from "../providers/auth.ts";
import { readTool, editTool, writeTool, bashTool } from "../coding/hashline.ts";
import { globTool, grepTool, lsTool } from "../coding/files.ts";
import { withLspGate, lspGateNote, lspAvailabilityNote } from "../coding/lsp.ts";
import { EXTERNAL_ACTION, WorkspaceRoots, resolveRoots } from "../core/workspace.ts"; // --add-dir roots + the file.external boundary
import type { buildRepoMapChunk as BuildRepoMapChunkFn, buildRepoMapChunkAsync as BuildRepoMapChunkAsyncFn } from "../coding/repomap.ts";
import { anchorEntryId, Checkpoints, MUTATING_KINDS } from "../coding/checkpoints.ts";
import { createRouter, parseModelRef, roleTableFromEnv, type Router } from "../providers/router.ts";
import { agentRows, discoverAgents, modelProblemFor, restrictTools, type CustomAgent, type DiscoveredAgents } from "../core/agents.ts";
import { describeGiveUp, describeRetry, retryOptionsFromEnv, withRetry } from "../providers/retry.ts";
import { createEvalCellTool } from "../tools/evalcell.ts";
import { webFetchTool } from "../tools/webfetch.ts";
import { askUserTool, type AskFn } from "../tools/ask-user.ts";
import { execPolicyApprover } from "../core/execpolicy.ts";
import { recallTool } from "../memory/recall.ts";
import { configureExecutor, type SpawnRunner } from "../core/executor.ts";
import { loadSandboxConfig, unavailableRungError, type SandboxConfig } from "../core/sandbox-config.ts";
import { loadTodos, planReminder, todoTools } from "../tools/todo.ts";
import { noteVerifyCost, resolveForGate, runVerify, VERIFY_TIMEOUT_MS, type VerifyResolver } from "../core/verify-gate.ts";
import { SteeringQueue } from "../core/loop.ts";
import { TaskManager } from "../core/tasks.ts";
import { createTaskTool, createTaskStatusTool } from "../tools/task.ts";
import type { ChildContext, ChildRunnerDeps } from "../core/orchestrator.ts";
import { existsSync, mkdirSync } from "node:fs";
import { sep, join } from "node:path";
import { shouldWarmRepoMap } from "./repomap-root.ts";
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
  /** test seam for the verify gate: which check a run that wrote files must pass. Default: core/verify.ts
   *  resolveVerify through verify-gate.ts resolveForGate (settings, then a manifest's unambiguous check script,
   *  never a guess). Returning null or no commands makes the gate report "not verified" instead of running. */
  verifyResolver?: VerifyResolver;
  /** `--add-dir <dir>` values (absolute, or relative to process.cwd()) — extra workspace roots beside the cwd
   *  (core/workspace.ts): visible to every permission decision as `allow file.external <root>\*` (and `allow
   *  file.write <root>\*` under accept-edits), named in the system prompt, each edit under one LSP-diagnosed against
   *  it. Resolved before any side effect; a value that is not a directory or is a filesystem root throws
   *  WorkspaceRootError (the surfaces print it and exit 2). No settings key, no env: a repo must never widen its own roots. */
  addDirs?: readonly string[];
  /** port #27 test seam: platform the rung probe assumes; default process.platform */
  platform?: NodeJS.Platform;
  /** port #47: what an external agentic-CLI lane needs — the env its knobs are read from and the spawn
   *  seam (tests hand in a fake CLI; production spawns the real one). Omitted, lanes stay off, because
   *  the allow-list is read from the environment and an unset list allows nothing. */
  lanes?: LaneJobDeps;
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
  /** the run's definition. `agent` (core/agents.ts): the CHILD definition for that custom agent — its body as the prompt
   *  (empty → the runtime's), its allow-list, its mode — and it MUST NOT re-point the active model; `child`: a task
   *  child's def, left without the non-native tool-calling block (orchestrator runChild renders it from the child's own
   *  registry). Every surface calls buildDef(model) right before its agentLoop. */
  buildDef(model: ModelRef, opts?: { cwd?: string; agent?: CustomAgent; child?: boolean }): AgentDefinition;
  /** Build the repo map on the next turn of the event loop instead of inside the first buildDef. The TUI
   *  calls this right after its first paint: the build took 720–850 ms in this repository (2026-09-06),
   *  all of it on the first request's latency when it ran at submit time. A buildDef that arrives while
   *  the timer is still pending gets a definition WITHOUT the map — the map is not in that prompt, the
   *  request never waits — and every later run has it. Headless callers do not call this and keep the
   *  synchronous build: a one-shot `run` wants the map in its only prompt. Idempotent. */
  warmRepoMap(): void;
  /** Cancel interactive warmup and wait for its file/git handles before the surface closes. */
  stopRepoMapWarmup(): Promise<void>;
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
  /** the two ceilings on a run (cli/run-limits.ts): buildCfg reads them ahead of ROVECODE_MAX_TURNS /
   *  ROVECODE_MAX_SECONDS and the 60-turn default — `rovecode run` sets its flags and headless default here */
  setRunLimits(limits: RunLimits): void;
  /** MCP server manager (port #3); null when no servers were configured at boot AND none has been
   *  installed since — `reloadMcp` creates it on demand. */
  mcp: McpManager | null;
  /** Re-read the MCP files and bring the session in line with them, connecting anything new. What
   *  `market install mcp:<id>` calls so a fresh server is usable in the session that installed it
   *  rather than after a restart. Never throws: a server that will not connect comes back in `failed`
   *  and simply stays unavailable, exactly as at boot. */
  reloadMcp(): Promise<{ added: string[]; removed: string[]; failed: { name: string; error: string }[]; skipped: string[] }>;
  /** port #8 config snapshot (AGENTS.md/CLAUDE.md/… harvested cwd-upward ONCE
   *  at construction, for prompt-cache stability) incl. dropped/truncated
   *  source stubs for /status. Mid-session config edits are intentionally not
   *  picked up — restart rovecode (a new runtime) to refresh. */
  projectContext: ProjectContext;
  /** port #14: role→model router with fallback chains (env ROVECODE_MODEL_<ROLE>). */
  router: Router;
  /** port #14: fallback-advance notes accumulated since the last drain. */
  drainRouterNotes(): string[];
  /** live delivery of the same notes (retry "retrying in 4 s (2/4)", give-up, chain advance): buffered ones replay
   *  first, then each new note arrives as it happens — the TUI shows a notice while the backoff waits, cmdRun prints a
   *  stderr line. With a listener registered, drainRouterNotes has nothing left to drain. */
  onRouterNote(fn: (note: string) => void): void;
  /** port #11: shadow-git checkpoints for a session (lazy; null when git is absent
   *  or ROVECODE_NO_CHECKPOINTS=1). Snapshots land automatically after mutating tools. */
  checkpointsFor(sessionId: string): Promise<Checkpoints | null>;
  /** port #11: point checkpoint entryId capture at the ACTIVE session store after
   *  a TUI session switch (pairs with setBlockStore). */
  setSessionStore(s: SessionStore): void;
  /** port #27: executor rung selected by .rovecode/sandbox.json / ROVECODE_SANDBOX (+ probe) */
  sandbox: SandboxState;
  /** the workspace roots — canonical cwd + the `--add-dir` dirs (deduplicated, nested ones dropped with a note in
   *  `roots.notes`, surfaced as plugin warnings); their ladder rules are already inside buildCfg's permissionRules */
  roots: WorkspaceRoots;
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
  /** port #55: this runtime's background shell jobs — a surface calls dispose() at teardown so no
   *  backgrounded command outlives the session that started it */
  bashJobs: BashJobManager;
  /** the custom subagent definitions loaded at boot (core/agents.ts: `.rovecode/agents/*.md` + `<home>/agents/*.md`);
   *  `warnings` were also sent through the plugin-warning channel as `agents: …` lines */
  agents: DiscoveredAgents;
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

// lazy module helpers — loaded on first use so boot pays nothing for features that are not configured
type OtelMod = typeof import("../telemetry/otel.ts");
let _otelMod: OtelMod | null = null;
function lazyOtel(): OtelMod | null {
  if (!process.env.ROVECODE_OTEL_ENDPOINT) return null;
  if (_otelMod === null) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    _otelMod = require("../telemetry/otel.ts") as OtelMod;
  }
  return _otelMod;
}

type McpClientMod = typeof import("../mcp/client.ts");
type McpToolsMod = typeof import("../mcp/tools.ts");
let _mcpMod: { client: McpClientMod; tools: McpToolsMod } | null = null;
function lazyMcp(): { client: McpClientMod; tools: McpToolsMod } {
  if (_mcpMod === null) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    _mcpMod = {
      client: require("../mcp/client.ts") as McpClientMod,
      tools: require("../mcp/tools.ts") as McpToolsMod,
    };
  }
  return _mcpMod;
}

export function createRuntime(opts: RuntimeOptions = {}): Runtime {
  const cwd = opts.cwd ?? process.cwd();
  // port #27: sandbox rung selection comes FIRST — a config error throws before any
  // side effect (no sessions dir, no MCP children). The probe (wsl/docker trial
  // spawn, 500ms cap) runs concurrently with the rest of construction; its verdict
  // is `sandbox.ready`. The seam records the DESIRED rung synchronously (#10 G7),
  // so an unmet wsl/docker desire is loud at bashTool, never a silent direct.
  const sandboxCfg = loadSandboxConfig(cwd, process.env, { home: rovecodeHome() }); // an UNTRUSTED project sandbox.json contributes nothing (core/trust.ts); its note is pushed once pluginWarn exists
  const ready = configureExecutor(sandboxCfg.rung, {
    runner: opts.spawnRunner, dockerImage: sandboxCfg.dockerImage, platform: opts.platform,
  }).then(() => undefined, (e: unknown) => { throw unavailableRungError(sandboxCfg, e); });
  void ready.catch(() => {}); // verdict is read via bootRuntime / await — never an unhandled rejection
  const sandbox: SandboxState = { ...sandboxCfg, ready };
  // the `--add-dir` roots (core/workspace.ts): canonical, deduplicated (nested / in-cwd values dropped with a note); a
  // value that is not a directory or is a filesystem root throws WorkspaceRootError HERE — before the sessions mkdir
  // and every other side effect, the same startup-error class as a bad sandbox config (exit 2 on every surface)
  const roots = new WorkspaceRoots(cwd, resolveRoots(cwd, opts.addDirs ?? []));
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
  // ONE startup-note channel, not a plugin channel. It began as the plugins' own and kept the name
  // while lsp, workspace roots, agents and mcp all started pushing into it — and every consumer was
  // prefixing "plugins: " on the way out, so an agent file's problem reached stderr as
  // "plugins: agents: explore.md: skipped …". Three sessions reported it in one night and none owned
  // it. Now each note carries its OWN subsystem word at the push site and consumers print it as-is.
  const pluginWarnings: string[] = pluginsFound.warnings.map((w) => `plugins: ${w}`);
  const pluginListeners: ((note: string) => void)[] = [];
  const pluginWarn = (note: string): void => { pluginWarnings.push(note); for (const l of pluginListeners) l(note); };
  const activePlugins = pluginsFound.plugins.filter((p) => p.status === "active"); // untrusted/disabled/broken contribute NOTHING
  // port #13: successful edits/writes get LSP diagnostics appended within a ≤2s
  // settle window (typescript-language-server on PATH; absent → silently off).
  const lspNote = (p: string): Promise<string> => lspGateNote(p, roots.rootOf(p) ?? cwd); // an edit under an added root is diagnosed against THAT root (its own tsconfig)
  // "absent → silently off" is right for the tool result and wrong for the person: say once, at boot, that the
  // diagnostics loop is not running here (TypeScript projects only — coding/lsp.ts lspAvailabilityNote)
  const lspGap = lspAvailabilityNote(cwd);
  if (lspGap !== null) pluginWarn(lspGap);
  // the roots, said once on the same channel (TUI warn note / headless stderr): dropped --add-dir values, and the limit
  // that comes with roots — checkpoints snapshot the cwd only (core/workspace.ts checkpointNote; also the doctor row)
  for (const n of roots.notes) pluginWarn(n);
  if (roots.dirs.length > 0) pluginWarn(roots.checkpointNote());
  registry.register(readTool, withCheckpoint(withLspGate(editTool, lspNote)), withCheckpoint(withLspGate(writeTool, lspNote)), withCheckpoint(bashTool));
  registry.register(globTool, grepTool, lsTool); // port #22: bounded, gitignore-aware search/list (kind read → file.read auto-allow; non-mutating, no checkpoint)
  registry.register(webFetchTool, createWebSearchTool({ apiKey: process.env.EXA_API_KEY })); // port #31 web_fetch + #56 web_search: kind network → net.fetch, PROMPT by default (rule below); SSRF-guarded, bounded; no checkpoint. The key is read HERE and nowhere else — the module never touches process.env, and every URL it echoes back has its query string dropped
  // a plugin's skills dir joins the store as one more root: a user plugin's as global, a project
  // plugin's as project (the same precedence its own files would have had)
  const skillStore = new SkillStore(cwd, { extraDirs: activePlugins.flatMap((p) => (p.skillsDir ? [{ dir: p.skillsDir, scope: p.scope === "project" ? "project" as const : "global" as const }] : [])) });
  skillStore.scan();
  registry.register(...createSkillTools(skillStore));
  // memory is PROJECT-scoped, not per-session (memory/scope.ts): MEMORY under <cwd>/.rovecode/memory, USER under the
  // user home. Until 2026-09-07 both lived in <sessions>/<id>/memory, so every fact died with the session id and the
  // USER block — preferences meant to follow the person across projects — was written inside the repository. The
  // one-time copy-forward of a legacy store happens here, before the boot snapshot, so a resumed session keeps its text.
  const scopedMemory = openScopedMemory({ cwd, sessionsDir, sessionId, home: pluginHome });
  let blocks = scopedMemory.blocks;
  if (scopedMemory.note !== null) for (const line of scopedMemory.note.split("\n")) pluginWarn(line);
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
  // custom subagent definitions (core/agents.ts): scanned ONCE at boot; every file that cannot be honoured is refused
  // here with a line naming it (never at run time inside a child) — a reserved name, a bad mode, a model on another
  // provider than the one this session streams over, a YAML list or an empty `tools:`. The lines ride the plugin-
  // warning channel like the LSP and roots notes (TUI warn note / headless stderr).
  const agents = discoverAgents(cwd, { validateModel: modelProblemFor(providers.defaultConfig()?.id ?? null) });
  for (const w of agents.warnings) pluginWarn(`agents: ${w}`);
  const agentRowsList = agentRows(agents);
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
    for (const w of a.warnings) pluginWarn(`plugins: ${w}`);
    const taken = new Set(registry.list().map((t) => t.schema.name));
    for (const p of a.plugins) {
      if (p.status !== "active") continue;
      for (const t of p.tools) {
        if (taken.has(t.schema.name)) { pluginWarn(`plugins: plugin ${p.name}: tool "${t.schema.name}" is already registered — refused (a plugin cannot replace a built-in or another plugin's tool)`); continue; }
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
    if (mcpByName.has(c.name)) { pluginWarn(`plugins: plugin ${p.name}: MCP server "${c.name}" is also declared by another plugin — first kept`); continue; }
    mcpByName.set(c.name, c);
  }
  // the user file (~/.rovecode/mcp.json — where `rovecode mcp add` writes) is the lowest of the three layers.
  // Project files (.rovecode/mcp.json, .mcp.json) pass the same trust gate as project plugins (mcp/trust.ts):
  // unapproved on this machine → nothing of theirs loads, one `mcp: …` note names the file and the command.
  const mcpWarnings: string[] = [];
  const hasMcpFiles = existsSync(join(pluginHome, "mcp.json"))
    || existsSync(join(cwd, ".rovecode", "mcp.json"))
    || existsSync(join(cwd, ".mcp.json"));
  if (hasMcpFiles) {
    for (const c of lazyMcp().client.loadMcpConfig(cwd, mcpWarnings, { home: pluginHome, trusted: trustedPredicate(pluginState) })) { if (mcpByName.has(c.name)) pluginWarn(`mcp: mcp.json server "${c.name}" overrides a plugin's entry of the same name`); mcpByName.set(c.name, c); }
  }
  for (const w of mcpWarnings) pluginWarn(`mcp: ${w}`);
  // the trust gate's other two boot lines (core/trust.ts): a project settings.json whose command-bearing keys were
  // dropped, and a project sandbox.json that was ignored — hooks.ts says its own through hooks.warnings
  for (const n of settingsTrustNotes(cwd, pluginHome)) pluginWarn(`trust: ${n}`);
  if (sandboxCfg.note !== undefined) pluginWarn(`trust: ${sandboxCfg.note}`);
  // Reading the three files is its own function because it happens twice: once here, and again whenever
  // something installs a server and wants it usable without a restart (reloadMcp below).
  // `warn` is an OUT parameter rather than a swallowed local: a server that is skipped — an unset ${NAME},
  // an unfilled <placeholder>, an untrusted project file — is the one thing the human most needs to hear
  // after installing something, and dropping the reason here is what made a failed install look like a
  // successful one that simply did nothing.
  const readMcpConfigs = (warn: string[] = []): McpServerConfig[] => {
    const byName = new Map<string, McpServerConfig>();
    for (const p of activePlugins) for (const c of p.mcp) if (!byName.has(c.name)) byName.set(c.name, c);
    const files = existsSync(join(pluginHome, "mcp.json"))
      || existsSync(join(cwd, ".rovecode", "mcp.json"))
      || existsSync(join(cwd, ".mcp.json"));
    // the trust gate is re-read too: a project file approved since boot starts counting from now on,
    // and one whose contents changed is untrusted again, exactly as it would be on a fresh start
    if (files) for (const c of lazyMcp().client.loadMcpConfig(cwd, warn, { home: pluginHome, trusted: trustedPredicate(loadPluginState(pluginHome)) })) byName.set(c.name, c);
    return [...byName.values()];
  };

  const mcpConfigs = [...mcpByName.values()];
  let mcp: McpManager | null = null;
  let mcpReady: Promise<void> = Promise.resolve();
  /** mcp_list/mcp_call bound to a manager, behind the first-connect gate. Shared by the root registry
   *  and every child's (childRegistry): ONE manager, one set of server processes for the whole session. */
  const mcpToolsFor = (manager: McpManager): Tool[] =>
    lazyMcp().tools.createMcpTools(manager).map((t) => ({ ...t, execute: async (a, c) => { await mcpReady; return t.execute(a, c); } }));
  /** register them once PER REGISTRY; they dispatch by server name, so a new server needs no new tool */
  const registerMcpTools = (manager: McpManager, reg: ToolRegistry = registry): void => {
    for (const t of mcpToolsFor(manager)) reg.register(t);
  };
  if (mcpConfigs.length > 0) {
    const mcpMod = lazyMcp();
    const manager = new mcpMod.client.McpManager(mcpConfigs);
    mcp = manager;
    // The connect starts on the NEXT turn of the event loop, not here: runTui is synchronous from
    // createRuntime through renderer.start(), which paints the first frame, and connect()'s first
    // step is loading the MCP SDK (~200 ms of module evaluation). Kicked off inline that load ran on
    // the first microtask — still ahead of the first paint. A zero timer puts it behind it. Nothing
    // at boot awaits mcpReady; mcp_list/mcp_call do (registerMcpTools), so a tool call may wait —
    // the terminal must not. Measured: two npx servers, createRuntime 254 ms → 30 ms.
    // The result is not discarded: a server the loader accepted but that never answers (a command that does not
    // exist, a package npx cannot resolve) is counted on the startup card as configured, and until it is named
    // here the only sign of it was a tool call that found nothing. Same channel as the loader's own "skipped"
    // lines (pluginWarn → the TUI's warn notes, stderr headless), same shape as reloadMcp's `failed`.
    mcpReady = new Promise<void>((resolve) => {
      setTimeout(() => {
        manager.connect().then(
          (r) => { for (const f of r.failed) pluginWarn(`mcp: server "${f.name}" did not connect — ${f.error}`); resolve(); },
          () => resolve(),
        );
      }, 0);
    });
    registerMcpTools(manager);
  }

  /** Pick up mcp.json changes in a live session — what `market install mcp:<id>` calls so the answer is
   *  "ready" instead of "restart rovecode".
   *
   *  Two cases, and the second is the one that matters most: when a session started with NO servers there
   *  is no manager and `mcp_list`/`mcp_call` were never registered, so installing your first server used
   *  to leave the model with no way to reach it at all. Here the manager is created and the two tools are
   *  registered at that moment. Servers already connected are left alone (see McpManager.sync). */
  const reloadMcp = async (): Promise<{ added: string[]; removed: string[]; failed: { name: string; error: string }[]; skipped: string[] }> => {
    const skipped: string[] = [];
    const configs = readMcpConfigs(skipped);
    if (mcp === null) {
      if (configs.length === 0) return { added: [], removed: [], failed: [], skipped };
      const manager = new (lazyMcp().client.McpManager)(configs);
      mcp = manager;
      registerMcpTools(manager);
      const r = await manager.connect();
      mcpReady = Promise.resolve();
      return { added: configs.map((c) => c.name), removed: [], failed: r.failed, skipped };
    }
    const { added, removed } = await mcp.sync(configs);
    const r = added.length > 0 ? await mcp.connect() : { failed: [] as { name: string; error: string }[] };
    return { added, removed, failed: r.failed, skipped };
  };

  // boot-time view of the default provider — only the router's role table is pinned to it; every
  // other reader goes through the LIVE getters on the returned Runtime (provider / defaultModel)
  const bootDefault = providers.defaultRef();
  // port #14: role router + fallback chains (env ROVECODE_MODEL_DEFAULT/SMOL/PLAN/COMMIT/TASK,
  // comma-separated provider/model chains). The registry's dispatcher routes every candidate to
  // ITS OWN provider's endpoint, so a cross-provider chain really fails over.
  const routerNotes: string[] = [];
  const routerListeners: ((note: string) => void)[] = [];
  /** a note goes to every live listener at once (the TUI's notice, cmdRun's stderr line); with no listener it
   *  waits in the buffer for drainRouterNotes — so a retry is visible WHILE it waits, not after the run */
  const pushRouterNote = (note: string): void => { if (routerListeners.length === 0) routerNotes.push(note); else for (const fn of routerListeners) fn(note); };
  const fallbackRef: ModelRef = { provider: bootDefault?.provider ?? "mock", model: bootDefault?.model || "default" };
  const router = createRouter({
    roles: roleTableFromEnv(fallbackRef),
    // MED-3: an explicitly configured default chain is the fallback pool even for models
    // outside it (requested model prepended as primary); the synthesized single-model
    // default (env unset) must NOT capture loose models — hence the env gate.
    looseFallback: (process.env.ROVECODE_MODEL_DEFAULT ?? "").trim().length > 0,
    onNote: (n) => pushRouterNote(
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
  // retries and give-ups surface as notes in the human's words (providers/retry.ts describeRetry/describeGiveUp):
  // "anthropic: overloaded — retrying in 4 s (2/4)" — live to onRouterNote listeners, else buffered for drainRouterNotes
  const stream = opts.stream !== undefined ? opts.stream : router.wrap(withRetry(middlewared, { ...retryOptionsFromEnv(), onRetry: (n) => pushRouterNote(describeRetry(n)), onGiveUp: (n) => pushRouterNote(describeGiveUp(n)) }));
  const catalog = new ModelCatalog(); // offline models.dev snapshot (port #6)
  // port #39: OTel span export rides the hook seam — attached ONLY when ROVECODE_OTEL_ENDPOINT is set (off:
  // nothing constructed, no on_event tap → zero cost); export failures surface through hooks.warnings
  const otelMod = lazyOtel();
  // held so the TaskManager below can be handed to it: lane spans need the manager, which does not
  // exist yet here, and the hook set is the only thing that knows how to open and close them
  let otelHooks: ReturnType<OtelMod["createOtelHooks"]> | null = null;
  if (otelMod) {
    const otel = otelMod.otelOptionsFromEnv();
    if (otel) {
      // #47 × #39: isAdapterId is what makes a task a LANE on the dashboard. The default is "nothing is
      // a lane" on purpose — with a looser predicate every ordinary subagent would be exported as an
      // external CLI, which is a lie a dashboard cannot be talked out of once it has drawn it.
      otelHooks = otelMod.createOtelHooks({ ...otel, pricing: catalog, messages: () => activeStore.messages(), isLane: isAdapterId });
      hooks.add(otelHooks, "otel");
    }
  }

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
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { buildRepoMapChunk } = require("../coding/repomap.ts") as { buildRepoMapChunk: typeof BuildRepoMapChunkFn };
        repoMapChunk = buildRepoMapChunk(cwd, budget);
      } catch { repoMapChunk = null; }
    }
    extraChunksMemo = [configChunk, repoMapChunk].filter((c): c is ContextChunk => c !== null);
    return extraChunksMemo;
  };
  // warmRepoMap (Runtime interface): the map builds behind the TUI's first frame — COOPERATIVELY
  // (repomap.ts buildRepoMapChunkAsync: awaited enumeration, sliced extraction, a yield per budget-search
  // step), so the frame loop keeps painting, reading keys and following resizes while it runs. The
  // synchronous build here used to block the event loop for 10 s in a 650-file repo with a cold tags cache
  // (a home directory: far longer) and the sextant sat frozen at its first reveal step. While the build is
  // pending, buildDef hands out the cheap chunks only — "the map is not in this prompt", never "the request
  // waits" — and does NOT memoize, so the warm build's result is the one that freezes the map.
  let warmPending = false;
  const warmAbort = new AbortController();
  let warmTask: Promise<void> | null = null;
  const stopRepoMapWarmup = async (): Promise<void> => { warmAbort.abort(); await warmTask; };
  const warmRepoMap = (): void => {
    if (extraChunksMemo !== null || warmPending || warmAbort.signal.aborted) return;
    warmPending = true;
    const settle = (repoMapChunk: ContextChunk | null): void => {
      warmPending = false;
      if (extraChunksMemo === null) extraChunksMemo = [configChunk, repoMapChunk].filter((c): c is ContextChunk => c !== null);
    };
    if (process.env.ROVECODE_NO_REPOMAP === "1" || !shouldWarmRepoMap(cwd)) { settle(null); return; }
    const budget = Number(process.env.ROVECODE_REPOMAP_TOKENS ?? "") || 1024;
    let build: Promise<ContextChunk | null>;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { buildRepoMapChunkAsync } = require("../coding/repomap.ts") as { buildRepoMapChunkAsync: typeof BuildRepoMapChunkAsyncFn };
      build = buildRepoMapChunkAsync(cwd, budget, { signal: warmAbort.signal });
    } catch { build = Promise.resolve(null); }
    // A background failure is a cache miss, not a reason to freeze the next interactive submit.
    // Headless runtimes that never warm still build synchronously in extraChunks().
    warmTask = build.then(settle, () => settle(null));
  };
  const chunksForDef = (): ContextChunk[] => extraChunksMemo ?? (warmPending ? [configChunk].filter((c): c is ContextChunk => c !== null) : extraChunks());

  const systemPrompt = (cwdOverride?: string): string => {
    const skillsIndex = buildSkillsIndex(skillStore);
    const memoryIndex = blocks.renderForPrompt();
    // Configured MCP servers are NAMED in the prompt: mcp_list/mcp_call look generic in a tool
    // list, and a model never told the environment exists does not discover it on its own — the
    // servers were connected but the agent behaved as if they were not (Berkay, 2026-09-19).
    // No servers → no section → the zero idle-token invariant of the lazy disclosure stands.
    const mcpNames = mcp?.serverNames() ?? [];
    const mcpIndex = mcpNames.length > 0
      ? `# MCP\nMCP servers configured for this session: ${mcpNames.join(", ")}. mcp_list returns their tools and which are connected; mcp_call {server, tool, args} runs one (argument schema: mcp_list {server, tool, schema:true}). When a task fits one of these servers, use it rather than working around it.`
      : "";
    return `You are Rovecode, an interactive coding agent in ${cwdOverride ?? cwd}. Use read/edit/write/bash tools. Edits require line hashes from read output. Match the length of an answer to the task: a line for a lookup, the full thing for a plan, a design or a review — never pad, never truncate work that was asked for.${skillsIndex ? "\n\n# Skills\n" + skillsIndex : ""}${memoryIndex ? "\n\n# Memory\n" + memoryIndex : ""}${mcpIndex ? "\n\n" + mcpIndex : ""}${roots.promptLine()}`;
  };

  // ROVECODE_EFFORT is the boot default; /effort and --effort move it at runtime
  // default "auto": no thinking field on the wire, the provider's own default stands (Claude 5: adaptive,
  // high). The old default "off" sent an explicit `thinking: disabled` and switched off the reasoning the
  // model does by itself — most of "we are not getting the model's real performance" (Berkay, 2026-09-04).
  let effort: ThinkingEffort = parseEffort(process.env.ROVECODE_EFFORT) ?? "auto";

  /** models the catalog knows CANNOT do native tool calling get the senpi-format prompt block (port #7); unknown models
   *  attempt native first. Force: ROVECODE_TOOL_MIDDLEWARE=1. One rule for the root def and for a child's (runChild). */
  const nonNativeFor = (m: ModelRef): boolean => catalog.lookup(m.provider, m.model)?.supportsTools === false || process.env.ROVECODE_TOOL_MIDDLEWARE === "1";
  const buildDef = (model: ModelRef, opts: { cwd?: string; agent?: CustomAgent; child?: boolean } = {}): AgentDefinition => {
    if (model.effort === undefined) model = { ...model, effort }; // one dial, every surface
    if (!opts.agent) activeModel = model; // port #26: children run the model of the run that started them — a custom agent's own model never re-points it
    // models the catalog knows CANNOT do native tool calling get the senpi-format
    // prompt block (port #7); unknown models attempt native first. Force: ROVECODE_TOOL_MIDDLEWARE=1
    const info = catalog.lookup(model.provider, model.model);
    // the answer's room comes from the catalog (models.dev maxOutput), capped: the old flat 4096 default
    // truncated long outputs — a whole page of UI, a long plan — mid-sentence, and the model was blamed
    if (model.maxTokens === undefined && info?.maxOutput) model = { ...model, maxTokens: Math.min(info.maxOutput, MAX_OUTPUT_CAP) };
    // the catalog's word on a reasoning mode rides with the ref: thinking.ts sends no dial to a model listed without one
    if (model.reasoning === undefined && info?.supportsReasoning !== undefined) model = { ...model, reasoning: info.supportsReasoning };
    const nonNative = nonNativeFor(model);
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
    // a custom definition's body IS its system prompt (core/agents.ts); an empty body inherits the runtime's whole prompt
    const base = opts.agent?.body || [systemPrompt(opts.cwd), section, design].filter((p) => p.length > 0).join("\n\n");
    return {
      name: opts.agent?.name ?? "main", model, tools: opts.agent ? [...opts.agent.tools] : ["*"], ...(opts.agent?.mode !== undefined ? { mode: opts.agent.mode } : {}),
      // a child def stays bare: orchestrator runChild appends the block from the CHILD's own registry, never the root's list
      systemPrompt: nonNative && !opts.child
        ? `${base}\n\n# Tool calling\n${toolPromptBlock(registry.list().map((t) => t.schema))}`
        : base,
      ...(chunksForDef().length > 0 ? { contextChunks: chunksForDef() } : {}),
    };
  };
  /** the workspace as a rule resource: every path resource is absolute (tools.ts describeResource),
   *  so `<cwd><sep>*` is "inside this repository" and nothing else — a sibling directory whose name
   *  merely STARTS with the cwd (…/repo-backup) does not match, because the separator is in the glob. */
  const insideCwd = `${cwd.replace(/[\/]$/, "")}${sep}*`;

  // run ceilings (cli/run-limits.ts): a surface's explicit limits, else the environment, else 60 turns and no
  // clock — the TUI and serve/acp get the env knobs for free, `rovecode run` adds its flags + a 20-minute default
  let runLimits: RunLimits = {};
  const buildCfg = (permission: PermissionLevel | boolean, approval?: ApprovalFn): RunConfig => {
    const level: PermissionLevel = permission === true ? "auto" : permission === false ? "ask" : permission;
    const yolo = level === "auto";
    const maxSeconds = runLimits.maxSeconds ?? positiveInt(process.env.ROVECODE_MAX_SECONDS);
    const maxCostUsd = runLimits.maxCostUsd ?? positiveUsd(process.env.ROVECODE_MAX_COST);
    // the same arithmetic /cost and the headless result use (tui/cost.ts, cli/output.ts): the catalog's price
    // for the model that served the turn, tiered by the prompt the turn actually carried; no price → undefined
    const priceUsd = (usage: TokenUsage, origin: ModelRef): number | undefined => {
      const info = catalog.lookup(origin.provider, origin.model);
      if (!info?.pricing) return undefined;
      const n = { input: usage.input, output: usage.output, cacheRead: usage.cacheRead ?? 0, cacheWrite: usage.cacheWrite ?? 0 };
      return costUsdTiered(n, ratesFor(info, n.input + n.cacheRead + n.cacheWrite));
    };
    // the finish check (core/loop.ts "done" exit): on by default, ROVECODE_FINISH_CHECK=0 is the escape hatch;
    // the todo state is read from disk at the exit so a list the model wrote this run is what gets reported
    const todoState = (): { open: number; total: number } | null => {
      try {
        const items = loadTodos(join(sessionsDir, activeStore.id)).items;
        return items.length === 0 ? null : { open: items.filter((i) => i.status !== "completed").length, total: items.length };
      } catch { return null; }
    };
    // the verify gate (core/verify-gate.ts): OFF unless ROVECODE_VERIFY=1. Measured 2026-09-06 (nimbus-6f): the
    // projects actually edited with rovecode have no check command at all (23 of 23 edits), and where one exists it
    // costs 3 s to 170 s — a gate that spends three minutes on a six-line CSS edit gets turned off and never comes
    // back. The default lives in this ONE comparison so flipping it later is editing this line. The check is
    // resolved per run (a key added to settings mid-session counts next run); ROVECODE_VERIFY_TIMEOUT=<seconds>
    // bounds one command, default 120.
    const verifyOn = process.env.ROVECODE_VERIFY === "1";
    const verifyTimeoutMs = (positiveInt(process.env.ROVECODE_VERIFY_TIMEOUT) ?? VERIFY_TIMEOUT_MS / 1000) * 1000;
    const verifyGate = (): RunConfig["verify"] => {
      const resolution = (opts.verifyResolver ?? resolveForGate)(cwd);
      return {
        resolution, timeoutMs: verifyTimeoutMs,
        run: async (signal) => { const o = await runVerify(resolution ?? { commands: [] }, cwd, { signal, timeoutMs: verifyTimeoutMs }); noteVerifyCost(cwd, o); return o; },
      };
    };
    return (activeCfg = {
    maxTurns: runLimits.maxTurns ?? positiveInt(process.env.ROVECODE_MAX_TURNS) ?? 60,
    ...(verifyOn ? { verify: verifyGate() } : {}),
    ...(maxSeconds !== undefined ? { maxSeconds } : {}),
    ...(maxCostUsd !== undefined ? { maxCostUsd, priceUsd } : {}),
    finishCheck: process.env.ROVECODE_FINISH_CHECK !== "0",
    todoState,
    // the history budget follows the model's window: a flat 200k spent a fifth of a 1M window and
    // overflowed a 128k one. ROVECODE_CONTEXT_BUDGET overrides; an unknown window keeps the old default.
    contextBudgetTokens: (() => {
      const ref = activeModel ?? fallbackRef;
      const cur = catalog.lookup(ref.provider, ref.model);
      return contextBudgetFor({
        ...(cur?.contextWindow !== undefined ? { window: cur.contextWindow } : {}),
        ...(cur?.maxOutput !== undefined ? { maxOutput: cur.maxOutput } : {}),
        ...(positiveInt(process.env.ROVECODE_CONTEXT_BUDGET) !== undefined ? { override: positiveInt(process.env.ROVECODE_CONTEXT_BUDGET) as number } : {}),
        // our estimator is not this model's tokenizer, so a budget taken at face value compacts too
        // late and the request that follows is rejected. charScale, not scale: what this budget is
        // compared against is estimateTokens (chars/4) in loop.ts and compaction.ts, never countTokens.
        scale: tokenScaleFor(ref).charScale,
      });
    })(),
    compactionThreshold: 0.8,
    compactionStrategy: parseCompactionStrategy(process.env.ROVECODE_COMPACTION) ?? "head-summarize", // port #25: ROVECODE_COMPACTION=head-summarize|keep-window|provider-native
    parallelTools: true,
    permissionRules: yolo
      ? [{ action: "*", resource: "*", effect: "allow" }]
      : [
          { action: "file.read", resource: "*", effect: "allow" },
          // the workspace boundary (core/workspace.ts; tools.ts dispatch step 2a): a file tool aimed OUTSIDE the cwd
          // asks once per directory, on a card that names the path, the cwd, the roots and the remedy. Inside the cwd
          // this rule is never consulted, so a person who stays in their project cannot tell it exists. The
          // `--add-dir` roots follow as allows, so nothing under a root reaches the card.
          { action: EXTERNAL_ACTION, resource: "*", effect: "prompt" },
          ...roots.rules(),
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
          // design_direction set writes .rovecode/design.json -- the once-per-project design identity,
          // and that ONE card is the point: it is where the human sees what is recorded for them.
          // `get` only reads that file, so it is allowed (last match wins): making the human approve
          // the read costs an interruption before every UI task AND trains them to allow the card
          // reflexively, which is the card that matters. The two modes are told apart by the tool's
          // own resource() (tools/design.ts), not by the tool name.
          { action: "tool.design_direction", resource: "*", effect: "prompt" },
          { action: "tool.design_direction", resource: "get", effect: "allow" },
          // port #31: resource = canonical host (lowercased, no trailing dot), so `allow
          // net.fetch <host>` auto-runs THAT host only; web_fetch stops at a redirect to
          // another host and reports it, so the new host gets its own decision here
          { action: "net.fetch", resource: "*", effect: "prompt" },
          // accept-edits: writing INSIDE the workspace stops asking. Placed last of the file.write
          // rules because the last match wins (tools.ts evaluatePermissions) — a write outside the
          // repo still hits the prompt rule above, and any deny rule a surface appends still wins.
          ...(level === "accept-edits" ? [{ action: "file.write", resource: insideCwd, effect: "allow" as const }, ...roots.acceptEditsRules()] : []), // a root is inside the workspace here too
        ],
    // port #9: execpolicy refines the PROMPT branch only (allow-listed argv →
    // "once", forbidden → deny before any human); rules above stay the outer gate.
    // The wrap is UNCONDITIONAL on gated configs (R2 #9 LOW-3): headless surfaces
    // (run/serve pass no approver) get allow-list auto-run + forbidden hard-stop,
    // and prompt-classified argv fails closed instead of "no approver connected".
    // yolo stays approver-free — its allow-all rules never reach the prompt branch.
    // port #29: the approval hook sits INSIDE the wrap, where the human would — a
    // forbidden argv never reaches a hook, an allow-listed one never asks (hooks.ts).
    // port #47: outermost, laneApprover turns a `task start` naming an external CLI lane into the card
    // text BEFORE it starts — the flags that lane will run with, named where a person can still say no
    approval: yolo ? undefined : laneApprover(execPolicyApprover(hooks.approver(approval)), opts.lanes?.env),
    });
  };

  // port #26: background subagents. Children run through orchestrator runChild (the ONE
  // agentLoop) with deps resolved at each start: the def/config of the run that STARTED
  // the task (buildDef/buildCfg record them — every surface calls both right before its
  // agentLoop, so a child inherits its parent's model and policy; deriveChildRules turns
  // prompt→deny). ONE SteeringQueue per runtime: surfaces hand it to agentLoop and
  // completion notes land in the parent's next turn (loop.ts:136). Children get the core
  // coding/search/skill tools, the SAME MCP environment through the SAME manager (a subagent
  // that cannot see the environment is not a subagent; policy still decides reach — under gated
  // rules mcp_call's prompt becomes a deny for children while mcp_list stays a read), and nested
  // `task` (kind spawn, bound to THEIR depth + steering queue, so the depth cap governs
  // nesting) and `task_status` (kind read: a child collects ITS children's results without
  // a prompt nobody could answer — MED-2 split, tools/task.ts header).
  let activeCfg: RunConfig | null = null;
  let activeModel: ModelRef | null = null;
  const steering = new SteeringQueue();
  const childRegistry = (def: AgentDefinition, childCwd: string, child?: ChildContext): ToolRegistry => {
    const reg = new ToolRegistry();
    const table: Tool[] = [readTool, editTool, writeTool, bashTool, globTool, grepTool, lsTool, ...createSkillTools(skillStore), recallTool(sessionsDir)];
    // a nested `task` reports THIS registry's names (lazily — it is filled below) so a grandchild is clamped to them
    // `parentDir` is this child's own working tree: an external lane it starts must build its worktree
    // there and merge back there, or an isolated child's lane writes into the user's live tree past the
    // isolation the child itself is held to. ChildContext.dir is the same value runChild passed as cwd.
    if (child) table.push(createTaskTool(tasks, { parentDepth: child.depth, notify: child.steering, caller: child.taskId, owner: child.signal, agents: agentRowsList, parentDir: child.dir ?? childCwd, parentTools: () => new Set(reg.list().map((t) => t.schema.name)) }), createTaskStatusTool(tasks, { caller: child.taskId }));
    if (mcp) table.push(...mcpToolsFor(mcp)); // the child reaches the parent's servers; restrictTools below still filters by the definition's allow-list
    // the definition's allow-list is a FILTER over this table ∩ the STARTING registry's names — never wider (main's "*" keeps
    // the table). The starting registry is the root's for a root start, the spawning CHILD's for a nested one
    // (ChildContext.parentTools): a restricted agent that has `task` cannot hand `main` — or any definition — a wider set than its own.
    reg.register(...restrictTools(table, def.tools, child?.parentTools ?? new Set(registry.list().map((t) => t.schema.name))));
    return reg;
  };
  /** the definitions a task may start, built beside `main` from the SAME buildDef at each start: a definition inherits the
   *  starting run's prompt/model unless it names its own ("provider/model" = the router grammar; a bare id runs on the
   *  starting run's provider). `child: true` leaves them without the root's tool block (runChild renders the child's). */
  const defsFor = (parent: ModelRef): Map<string, AgentDefinition> => {
    const defs = new Map<string, AgentDefinition>([["main", buildDef(parent, { child: true })]]);
    for (const a of agents.agents) defs.set(a.name, buildDef(a.model !== undefined ? parseModelRef(a.model, parent.provider) : parent, { agent: a, child: true }));
    return defs;
  };
  const tasks = new TaskManager({
    deps: (): ChildRunnerDeps | null => stream ? {
      defs: defsFor(activeModel ?? fallbackRef),
      stream, registryFactory: childRegistry, rootDir: cwd, sessionsDir,
      toolPrompt: (m, tools) => (nonNativeFor(m) ? toolPromptBlock(tools) : ""), // the child's own restricted set, never the root's list
      baseConfig: activeCfg ?? buildCfg(false),
      hooks, // port #29: children run under the runtime's hooks (a veto cannot be dodged by delegation)
    } : null,
    lanes: opts.lanes, // port #47: external CLI lanes are jobs of this same manager
  });
  tasks.attach(steering);
  // #39: finished external lanes become their own spans (open on "running", closed on the terminal
  // transition). Off unless OTel is configured — with no endpoint nothing above was constructed.
  otelHooks?.observeTasks(tasks);
  // port #28: built-in reflection set (core/reflection.ts) — a failed edit/write (or an LSP-diagnosed one) nudges the model once via steering, capped per run (ROVECODE_REFLECTION_MAX); ROVECODE_REFLECTION=0 disables.
  // owns: the ACTIVE session's runs only — a task child (own store id, same hooks) must neither nudge nor sweep this queue (#26 MED-A)
  if (reflectionEnabled()) hooks.add(createReflectionHooks({ steering, owns: (c) => c.sessionId === activeStore.id }), "reflection");
  registry.register(createTaskTool(tasks, { parentDepth: 0, agents: agentRowsList }), createTaskStatusTool(tasks)); // task: kind spawn → gated rules prompt once per start, yolo allows; task_status: kind read → allowed everywhere

  // port #55: ONE background-shell-job manager per runtime, installed where bashTool can reach it
  // without every call site threading it. Notes land in the SAME steering queue task completions use,
  // so a finished job is drained before the next model call instead of interrupting a turn. It is
  // installed process-wide because bashTool is a module-level constant shared by every surface; a
  // second runtime replaces it, which is what a second runtime should mean.
  const bashJobs = new BashJobManager({ notify: steering });
  installJobManager(bashJobs);
  registry.register(...bashJobTools); // bash_list / bash_output (kind read) · bash_kill (kind execute)

  return {
    cwd, sessionId, store, registry, skillStore,
    get blockStore() { return blocks; },
    setBlockStore(b: BlockStore) { blocks = b; registry.register(memoryEditTool(b)); },
    guard, planReminder: planReminderFor, get mcp() { return mcp; }, reloadMcp, projectContext, router, roots, agents,
    get effort() { return effort; },
    setEffort(e: ThinkingEffort) { effort = e; },
    setRunLimits(l: RunLimits) { runLimits = l; },
    drainRouterNotes: () => routerNotes.splice(0),
    onRouterNote(fn) { for (const n of routerNotes.splice(0)) fn(n); routerListeners.push(fn); },
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
    buildDef, buildCfg, warmRepoMap, stopRepoMapWarmup,
    steering, tasks, bashJobs,
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
