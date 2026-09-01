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
import { ToolGuard } from "../core/guardrails.ts";
import { loadMcpConfig, McpManager } from "../mcp/client.ts";
import { createMcpTools } from "../mcp/tools.ts";
import { readTool, editTool, writeTool, bashTool } from "../coding/hashline.ts";
import { withLspGate, lspGateNote } from "../coding/lsp.ts";
import { buildRepoMapChunk } from "../coding/repomap.ts";
import { anchorEntryId, Checkpoints, MUTATING_KINDS } from "../coding/checkpoints.ts";
import { createRouter, roleTableFromEnv, type Router } from "../providers/router.ts";
import { createEvalCellTool } from "../tools/evalcell.ts";
import { execPolicyApprover } from "../core/execpolicy.ts";
import { recallTool } from "../memory/recall.ts";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export interface RuntimeOptions {
  cwd?: string;
  sessionId?: string;
  /** override the provider-derived stream (tests); null forces "no stream" */
  stream?: StreamFn | null;
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
}

export function createRuntime(opts: RuntimeOptions = {}): Runtime {
  const cwd = opts.cwd ?? process.cwd();
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
  const guard = new ToolGuard(); // port #4: loop signatures + duplicate-result stubs

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
    onNote: (n) => routerNotes.push(
      `router: ${n.chain} ${n.from.provider}/${n.from.model} → ${n.to ? `${n.to.provider}/${n.to.model}` : "chain exhausted"} (${n.reason})`),
  });
  // port #7: provider streams get the non-native tool-call parser (strict-gated passthrough
  // for native turns); injected test streams stay untouched. Kill switch: AION_NO_TOOL_MIDDLEWARE=1
  // port #14: the router wraps OUTERMOST (chain advance re-drives the whole turn).
  const rawStream = provider ? providerStream(provider) : null;
  const middlewared = rawStream && process.env.AION_NO_TOOL_MIDDLEWARE !== "1" ? withToolCallParsing(rawStream) : rawStream;
  const stream = opts.stream !== undefined ? opts.stream : middlewared ? router.wrap(middlewared) : null;
  const catalog = new ModelCatalog(); // offline models.dev snapshot (port #6)

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

  return {
    cwd, sessionId, store, registry, skillStore,
    get blockStore() { return blocks; },
    setBlockStore(b: BlockStore) { blocks = b; registry.register(memoryEditTool(b)); },
    guard, mcp, projectContext, router,
    drainRouterNotes: () => routerNotes.splice(0),
    checkpointsFor,
    setSessionStore(s: SessionStore) { activeStore = s; },
    provider, stream, defaultModel, systemPrompt,
    buildDef: (model: ModelRef): AgentDefinition => {
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
    },
    buildCfg: (yolo: boolean, approval?: ApprovalFn): RunConfig => ({
      maxTurns: 60, contextBudgetTokens: 200_000, compactionThreshold: 0.8,
      parallelTools: true, retry: { maxAttempts: 3, backoffMs: 400 },
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
          ],
      // port #9: execpolicy refines the PROMPT branch only (allow-listed argv →
      // "once", forbidden → deny before any human); rules above stay the outer gate.
      approval: yolo ? undefined : approval ? execPolicyApprover(approval) : undefined,
    }),
  };
}
