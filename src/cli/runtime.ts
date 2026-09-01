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
import { loadProjectContext } from "../core/config.ts";
import { ToolGuard } from "../core/guardrails.ts";
import { loadMcpConfig, McpManager } from "../mcp/client.ts";
import { createMcpTools } from "../mcp/tools.ts";
import { readTool, editTool, writeTool, bashTool } from "../coding/hashline.ts";
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
}

export function createRuntime(opts: RuntimeOptions = {}): Runtime {
  const cwd = opts.cwd ?? process.cwd();
  const sessionsDir = join(cwd, ".aion", "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  const sessionId = opts.sessionId ?? randomUUID();
  const store = new SessionStore(sessionsDir, sessionId);

  const registry = new ToolRegistry();
  registry.register(readTool, editTool, writeTool, bashTool);
  const skillStore = new SkillStore(cwd);
  skillStore.scan();
  registry.register(...createSkillTools(skillStore));
  let blocks = new BlockStore(join(sessionsDir, sessionId, "memory"));
  registry.register(memoryEditTool(blocks));
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

  const systemPrompt = (): string => {
    const skillsIndex = buildSkillsIndex(skillStore);
    const memoryIndex = blocks.renderForPrompt();
    // port #8: harvest AGENTS.md / CLAUDE.md / .cursor / copilot instructions (OMP pattern)
    const project = loadProjectContext(cwd);
    return `You are Aion, an interactive coding agent in ${cwd}. Use read/edit/write/bash tools. Edits require line hashes from read output. Be concise.${project.text ? "\n\n# Project context\n" + project.text : ""}${skillsIndex ? "\n\n# Skills\n" + skillsIndex : ""}${memoryIndex ? "\n\n# Memory\n" + memoryIndex : ""}`;
  };

  return {
    cwd, sessionId, store, registry, skillStore,
    get blockStore() { return blocks; },
    setBlockStore(b: BlockStore) { blocks = b; registry.register(memoryEditTool(b)); },
    guard, mcp,
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
            { action: "tool.mcp_list", resource: "*", effect: "allow" },
            { action: "file.write", resource: "*", effect: "prompt" },
            { action: "shell.exec", resource: "*", effect: "prompt" },
            { action: "spawn", resource: "*", effect: "prompt" },
            { action: "tool.mcp_call", resource: "*", effect: "prompt" },
          ],
      approval: yolo ? undefined : approval,
    }),
  };
}
