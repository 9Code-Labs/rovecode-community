/** Shared runtime construction for CLI surfaces (repl, run, tui): stores, tool
 *  registration, skills/memory indexes, provider resolution, RunConfig defaults.
 *  Extracted from repl.ts/main.ts so every surface builds the same agent. */

import type { AgentDefinition, ApprovalFn, ModelRef, RunConfig, StreamFn, Tool } from "../core/types.ts";
import { SessionStore } from "../core/session.ts";
import { ToolRegistry } from "../core/tools.ts";
import { SkillStore } from "../skills/index.ts";
import { createSkillTools, buildSkillsIndex } from "../skills/tools.ts";
import { BlockStore } from "../memory/blocks.ts";
import { memoryEditTool } from "../memory/tools.ts";
import { resolveProvider, providerStream, type ProviderConfig } from "../providers/stream.ts";
import { withToolCallParsing, toolPromptBlock } from "../providers/middleware.ts";
import { ModelCatalog } from "../providers/catalog.ts";
import { loadProjectContext, type ProjectContext } from "../core/config.ts";
import { estimateTokens, type ContextChunk } from "../core/context.ts";
import { parseCompactionStrategy } from "../core/compaction.ts";
import { ToolGuard } from "../core/guardrails.ts";
import { HookRunner } from "../core/hooks.ts";
import { createReflectionHooks, reflectionEnabled } from "../core/reflection.ts";
import { createOtelHooks, otelOptionsFromEnv } from "../telemetry/otel.ts";
import { loadMcpConfig, McpManager } from "../mcp/client.ts";
import { createMcpTools } from "../mcp/tools.ts";
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
import { todoTools } from "../tools/todo.ts";
import { SteeringQueue } from "../core/loop.ts";
import { TaskManager } from "../core/tasks.ts";
import { createTaskTool } from "../tools/task.ts";
import type { ChildContext, ChildRunnerDeps } from "../core/orchestrator.ts";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

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
  /** resolveProvider() result (null if unconfigured) */
  provider: ProviderConfig | null;
  /** providerStream(provider) or opts.stream override; null when neither */
  stream: StreamFn | null;
  /** provider?.defaultModel ?? env AION_MODEL ?? "" */
  defaultModel: string;
  /** interactive system prompt incl. skills index + memory index (indexes rebuilt per call) */
  systemPrompt(): string;
  buildDef(model: ModelRef): AgentDefinition;
  buildCfg(yolo: boolean, approval?: ApprovalFn): RunConfig;
  /** swap the session-scoped memory store — rebinds the memory tool AND the prompt (port #2 fix) */
  setBlockStore(b: BlockStore): void;
  /** tool-loop guardrails (port #4), one per runtime, thread into LoopDeps.guard */
  guard: ToolGuard;
  /** MCP server manager (port #3); null when no servers configured */
  mcp: McpManager | null;
  /** port #8 config snapshot (AGENTS.md/CLAUDE.md/… harvested cwd-upward ONCE
   *  at construction, for prompt-cache stability) incl. dropped/truncated
   *  source stubs for /status. Mid-session config edits are intentionally not
   *  picked up — restart aion (a new runtime) to refresh. */
  projectContext: ProjectContext;
  /** port #14: role→model router with fallback chains (env AION_MODEL_<ROLE>). */
  router: Router;
  /** port #14: fallback-advance notes accumulated since the last drain. */
  drainRouterNotes(): string[];
  /** port #11: shadow-git checkpoints for a session (lazy; null when git is absent
   *  or AION_NO_CHECKPOINTS=1). Snapshots land automatically after mutating tools. */
  checkpointsFor(sessionId: string): Promise<Checkpoints | null>;
  /** port #11: point checkpoint entryId capture at the ACTIVE session store after
   *  a TUI session switch (pairs with setBlockStore). */
  setSessionStore(s: SessionStore): void;
  /** port #27: executor rung selected by .aion/sandbox.json / AION_SANDBOX (+ probe) */
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
  /** port #29: typed hook set — `.aion/hooks.{ts,js}` (+ `~/.aion`, AION_HOME) loaded at construction
   *  (background import; every run() waits for it, so no surface can race the load), session_open
   *  fired once loaded. Thread into LoopDeps.hooks; attach more sets programmatically via hooks.add()
   *  (port #39 OTel); surfaces call hooks.close() at teardown → session_close once. Load + runtime
   *  notes (import failure, wrong version, timeout, throw) land in hooks.warnings / onWarning(). */
  hooks: HookRunner;
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
  const sessionsDir = join(cwd, ".aion", "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  const sessionId = opts.sessionId ?? randomUUID();
  const store = new SessionStore(sessionsDir, sessionId);

  // port #11: shadow-git checkpoints — one repo per session under .aion/checkpoints/,
  // snapshot after every SUCCESSFUL mutating tool call (kinds write/execute). Lazy
  // per-session init; git absent or AION_NO_CHECKPOINTS=1 → silently off.
  const cpBySession = new Map<string, Promise<Checkpoints | null>>();
  const checkpointsFor = (sid: string): Promise<Checkpoints | null> => {
    if (process.env.AION_NO_CHECKPOINTS === "1") return Promise.resolve(null);
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
  // port #13: successful edits/writes get LSP diagnostics appended within a ≤2s
  // settle window (typescript-language-server on PATH; absent → silently off).
  const lspNote = (p: string): Promise<string> => lspGateNote(p, cwd);
  registry.register(readTool, withCheckpoint(withLspGate(editTool, lspNote)), withCheckpoint(withLspGate(writeTool, lspNote)), withCheckpoint(bashTool));
  registry.register(globTool, grepTool, lsTool); // port #22: bounded, gitignore-aware search/list (kind read → file.read auto-allow; non-mutating, no checkpoint)
  registry.register(webFetchTool); // port #31: kind network → net.fetch, PROMPT by default (rule below); SSRF-guarded, bounded; no checkpoint
  const skillStore = new SkillStore(cwd);
  skillStore.scan();
  registry.register(...createSkillTools(skillStore));
  let blocks = new BlockStore(join(sessionsDir, sessionId, "memory"));
  registry.register(memoryEditTool(blocks));
  // port #18: persistent eval cell — registered ONLY when AION_EVAL_CELL=1
  const evalCell = createEvalCellTool();
  if (evalCell) registry.register(withCheckpoint(evalCell));
  // port #17: cross-session recall (kind read → file.read gate; pure transcript search)
  registry.register(recallTool(sessionsDir));
  registry.register(...todoTools(sessionsDir)); // port #32: per-session todo list at <session>/todos.json (todo_write kind memory → memory.write allow; todo_read kind read)
  // port #33: ask_user on EVERY surface (kind read → auto-runs under gated/plan rules); only an
  // interactive surface binds an asker via setAskUser — unbound, the tool fails closed
  let askUser: AskFn | undefined;
  registry.register(askUserTool(() => askUser));
  const guard = new ToolGuard(); // port #4: loop signatures + duplicate-result stubs
  // port #29: hooks v2 — the runner exists synchronously (createRuntime stays sync); open() imports
  // .aion/hooks.{ts,js} (+ user scope) in the background and fires session_open; run() awaits it
  const hooks = new HookRunner({ cwd, sessionId });
  void hooks.open(cwd);

  // port #3: MCP servers from .aion/mcp.json + harvested .mcp.json; two lazy tools only.
  // connect() is fire-and-forget; tool executes await first-connect before dispatching.
  const mcpConfigs = loadMcpConfig(cwd);
  let mcp: McpManager | null = null;
  if (mcpConfigs.length > 0) {
    const manager = new McpManager(mcpConfigs);
    mcp = manager;
    const ready = manager.connect().then(() => undefined, () => undefined);
    for (const t of createMcpTools(manager)) {
      registry.register({ ...t, execute: async (a, c) => { await ready; return t.execute(a, c); } });
    }
  }

  const provider = resolveProvider();
  const defaultModel = provider?.defaultModel ?? process.env.AION_MODEL ?? "";
  // port #14: role router + fallback chains (env AION_MODEL_DEFAULT/SMOL/PLAN/COMMIT/TASK,
  // comma-separated provider/model chains). Model-level fallback shares THIS provider's
  // wire — a chain entry naming another provider resolves but streams over the same endpoint.
  const routerNotes: string[] = [];
  const fallbackRef: ModelRef = { provider: provider?.id ?? "mock", model: defaultModel || "default" };
  const router = createRouter({
    roles: roleTableFromEnv(fallbackRef),
    // MED-3: an explicitly configured default chain is the fallback pool even for models
    // outside it (requested model prepended as primary); the synthesized single-model
    // default (env unset) must NOT capture loose models — hence the env gate.
    looseFallback: (process.env.AION_MODEL_DEFAULT ?? "").trim().length > 0,
    onNote: (n) => routerNotes.push(
      `router: ${n.chain} ${n.from.provider}/${n.from.model} → ${n.to ? `${n.to.provider}/${n.to.model}` : "chain exhausted"} (${n.reason})`),
  });
  // port #7: provider streams get the non-native tool-call parser (strict-gated passthrough
  // for native turns); injected test streams stay untouched. Kill switch: AION_NO_TOOL_MIDDLEWARE=1
  // port #14: the router wraps OUTERMOST (chain advance re-drives the whole turn).
  // port #23: same-model retry sits INSIDE the router — backoff retries exhaust on candidate N
  // before the chain advances (AION_RETRY_MAX / AION_RETRY_BASE_MS; providers/retry.ts header).
  const rawStream = provider ? providerStream(provider) : null;
  const middlewared = rawStream && process.env.AION_NO_TOOL_MIDDLEWARE !== "1" ? withToolCallParsing(rawStream) : rawStream;
  const stream = opts.stream !== undefined ? opts.stream : middlewared ? router.wrap(withRetry(middlewared, { ...retryOptionsFromEnv(), onRetry: (n) => routerNotes.push(`retry: ${n.model.provider}/${n.model.model} attempt ${n.attempt} in ${n.delayMs}ms (${n.reason})`) })) : null; // retries surface as router-style notes (drainRouterNotes)
  const catalog = new ModelCatalog(); // offline models.dev snapshot (port #6)
  // port #39: OTel span export rides the hook seam — attached ONLY when AION_OTEL_ENDPOINT is set (off:
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
  // first buildDef() and memoized — createRuntime stays sync-cheap (`aion tools`,
  // ACP session setup pay nothing) and per-file tags persist under
  // .aion/cache/repomap.json, so warm launches skip extraction. Frozen after
  // the first build, like config, for prompt-cache stability. AION_NO_REPOMAP=1
  // disables; budget override via AION_REPOMAP_TOKENS (default 1024, aider's).
  let extraChunksMemo: ContextChunk[] | null = null;
  const extraChunks = (): ContextChunk[] => {
    if (extraChunksMemo !== null) return extraChunksMemo;
    let repoMapChunk: ContextChunk | null = null;
    if (process.env.AION_NO_REPOMAP !== "1") {
      const budget = Number(process.env.AION_REPOMAP_TOKENS ?? "") || 1024;
      try { repoMapChunk = buildRepoMapChunk(cwd, budget); } catch { repoMapChunk = null; }
    }
    extraChunksMemo = [configChunk, repoMapChunk].filter((c): c is ContextChunk => c !== null);
    return extraChunksMemo;
  };

  const systemPrompt = (): string => {
    const skillsIndex = buildSkillsIndex(skillStore);
    const memoryIndex = blocks.renderForPrompt();
    return `You are Aion, an interactive coding agent in ${cwd}. Use read/edit/write/bash tools. Edits require line hashes from read output. Be concise.${skillsIndex ? "\n\n# Skills\n" + skillsIndex : ""}${memoryIndex ? "\n\n# Memory\n" + memoryIndex : ""}`;
  };

  const buildDef = (model: ModelRef): AgentDefinition => {
    activeModel = model; // port #26: children run the model of the run that started them
    // models the catalog knows CANNOT do native tool calling get the senpi-format
    // prompt block (port #7); unknown models attempt native first. Force: AION_TOOL_MIDDLEWARE=1
    const info = catalog.lookup(model.provider, model.model);
    const nonNative = info?.supportsTools === false || process.env.AION_TOOL_MIDDLEWARE === "1";
    const base = systemPrompt();
    return {
      name: "main", model, tools: ["*"],
      systemPrompt: nonNative
        ? `${base}\n\n# Tool calling\n${toolPromptBlock(registry.list().map((t) => t.schema))}`
        : base,
      ...(extraChunks().length > 0 ? { contextChunks: extraChunks() } : {}),
    };
  };
  const buildCfg = (yolo: boolean, approval?: ApprovalFn): RunConfig => (activeCfg = {
    maxTurns: 60, contextBudgetTokens: 200_000, compactionThreshold: 0.8,
    compactionStrategy: parseCompactionStrategy(process.env.AION_COMPACTION) ?? "head-summarize", // port #25: AION_COMPACTION=head-summarize|keep-window|provider-native
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
          // port #31: resource = canonical host (lowercased, no trailing dot), so `allow
          // net.fetch <host>` auto-runs THAT host only; web_fetch stops at a redirect to
          // another host and reports it, so the new host gets its own decision here
          { action: "net.fetch", resource: "*", effect: "prompt" },
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

  // port #26: background subagents. Children run through orchestrator runChild (the ONE
  // agentLoop) with deps resolved at each start: the def/config of the run that STARTED
  // the task (buildDef/buildCfg record them — every surface calls both right before its
  // agentLoop, so a child inherits its parent's model and policy; deriveChildRules turns
  // prompt→deny). ONE SteeringQueue per runtime: surfaces hand it to agentLoop and
  // completion notes land in the parent's next turn (loop.ts:136). Children get the core
  // coding/search/skill tools (no MCP/memory/eval-cell/checkpoints in v1) plus a nested
  // `task` tool bound to THEIR depth + steering queue, so the depth cap governs nesting.
  let activeCfg: RunConfig | null = null;
  let activeModel: ModelRef | null = null;
  const steering = new SteeringQueue();
  const childRegistry = (_def: AgentDefinition, _cwd: string, child?: ChildContext): ToolRegistry => {
    const reg = new ToolRegistry();
    reg.register(readTool, editTool, writeTool, bashTool, globTool, grepTool, lsTool, ...createSkillTools(skillStore), recallTool(sessionsDir));
    if (child) reg.register(createTaskTool(tasks, { parentDepth: child.depth, notify: child.steering, caller: child.taskId, owner: child.signal }));
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
  // port #28: built-in reflection set (core/reflection.ts) — a failed edit/write (or an LSP-diagnosed one) nudges the model once via steering, capped per run (AION_REFLECTION_MAX); AION_REFLECTION=0 disables
  if (reflectionEnabled()) hooks.add(createReflectionHooks({ steering }), "reflection");
  registry.register(createTaskTool(tasks, { parentDepth: 0 })); // kind spawn → gated rules prompt, yolo allows

  return {
    cwd, sessionId, store, registry, skillStore,
    get blockStore() { return blocks; },
    setBlockStore(b: BlockStore) { blocks = b; registry.register(memoryEditTool(b)); },
    guard, mcp, projectContext, router,
    drainRouterNotes: () => routerNotes.splice(0),
    checkpointsFor,
    setSessionStore(s: SessionStore) { activeStore = s; },
    sandbox,
    setAskUser(fn: AskFn | undefined) { askUser = fn; },
    hooks,
    provider, stream, defaultModel, systemPrompt,
    buildDef, buildCfg,
    steering, tasks,
  };
}

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
  } catch (e) {
    await rt.mcp?.close().catch(() => {});
    throw e;
  }
  return rt;
}
