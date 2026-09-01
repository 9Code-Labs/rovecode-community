/** Shared runtime construction for CLI surfaces (repl, run, tui): stores, tool
 *  registration, skills/memory indexes, provider resolution, RunConfig defaults.
 *  Extracted from repl.ts/main.ts so every surface builds the same agent. */

import type { AgentDefinition, ApprovalFn, ModelRef, RunConfig, StreamFn } from "../core/types.ts";
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
}

export function createRuntime(opts: RuntimeOptions = {}): Runtime {
  const cwd = opts.cwd ?? process.cwd();
  const sessionsDir = join(cwd, ".aion", "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  const sessionId = opts.sessionId ?? randomUUID();
  const store = new SessionStore(sessionsDir, sessionId);

  const registry = new ToolRegistry();
  // port #13: successful edits/writes get LSP diagnostics appended within a ≤2s
  // settle window (typescript-language-server on PATH; absent → silently off).
  const lspNote = (p: string): Promise<string> => lspGateNote(p, cwd);
  registry.register(readTool, withLspGate(editTool, lspNote), withLspGate(writeTool, lspNote), bashTool);
  const skillStore = new SkillStore(cwd);
  skillStore.scan();
  registry.register(...createSkillTools(skillStore));
  let blocks = new BlockStore(join(sessionsDir, sessionId, "memory"));
  registry.register(memoryEditTool(blocks));
  // port #18: persistent eval cell — registered ONLY when AION_EVAL_CELL=1
  const evalCell = createEvalCellTool();
  if (evalCell) registry.register(evalCell);
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
  // port #7: provider streams get the non-native tool-call parser (strict-gated passthrough
  // for native turns); injected test streams stay untouched. Kill switch: AION_NO_TOOL_MIDDLEWARE=1
  const rawStream = provider ? providerStream(provider) : null;
  const stream = opts.stream !== undefined
    ? opts.stream
    : rawStream && process.env.AION_NO_TOOL_MIDDLEWARE !== "1" ? withToolCallParsing(rawStream) : rawStream;
  const defaultModel = provider?.defaultModel ?? process.env.AION_MODEL ?? "";
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

  const systemPrompt = (): string => {
    const skillsIndex = buildSkillsIndex(skillStore);
    const memoryIndex = blocks.renderForPrompt();
    return `You are Aion, an interactive coding agent in ${cwd}. Use read/edit/write/bash tools. Edits require line hashes from read output. Be concise.${skillsIndex ? "\n\n# Skills\n" + skillsIndex : ""}${memoryIndex ? "\n\n# Memory\n" + memoryIndex : ""}`;
  };

  return {
    cwd, sessionId, store, registry, skillStore,
    get blockStore() { return blocks; },
    setBlockStore(b: BlockStore) { blocks = b; registry.register(memoryEditTool(b)); },
    guard, mcp, projectContext,
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
        ...(configChunk ? { contextChunks: [configChunk] } : {}),
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
