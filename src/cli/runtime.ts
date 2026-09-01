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
  const blockStore = new BlockStore(join(sessionsDir, sessionId, "memory"));
  registry.register(memoryEditTool(blockStore));

  const provider = resolveProvider();
  const stream = opts.stream !== undefined ? opts.stream : provider ? providerStream(provider) : null;
  const defaultModel = provider?.defaultModel ?? process.env.AION_MODEL ?? "";

  const systemPrompt = (): string => {
    const skillsIndex = buildSkillsIndex(skillStore);
    const memoryIndex = blockStore.renderForPrompt();
    return `You are Aion, an interactive coding agent in ${cwd}. Use read/edit/write/bash tools. Edits require line hashes from read output. Be concise.${skillsIndex ? "\n\n# Skills\n" + skillsIndex : ""}${memoryIndex ? "\n\n# Memory\n" + memoryIndex : ""}`;
  };

  return {
    cwd, sessionId, store, registry, skillStore, blockStore,
    provider, stream, defaultModel, systemPrompt,
    buildDef: (model: ModelRef): AgentDefinition => ({
      name: "main", model, systemPrompt: systemPrompt(), tools: ["*"],
    }),
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
            { action: "file.write", resource: "*", effect: "prompt" },
            { action: "shell.exec", resource: "*", effect: "prompt" },
            { action: "spawn", resource: "*", effect: "prompt" },
          ],
      approval: yolo ? undefined : approval,
    }),
  };
}
