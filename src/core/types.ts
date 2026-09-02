/** Aion core type contracts. Single source of truth for the runtime. */

import type { ContextChunk } from "./context.ts";
import type { CompactionStrategy, CompactionTrigger } from "./compaction.ts";

// ---------- Messages (harness-level; converted to provider form only at the seam) ----------

export type Role = "system" | "user" | "assistant" | "tool";

export interface TextPart { kind: "text"; text: string }
export interface ToolCallPart { kind: "tool_call"; id: string; tool: string; args: unknown }
export interface ToolResultPart { kind: "tool_result"; callId: string; ok: boolean; output: string }
export type MessagePart = TextPart | ToolCallPart | ToolResultPart;

export interface Message {
  id: string;
  role: Role;
  parts: MessagePart[];
  parentId: string | null;
  createdAt: number;
  /** provider+model that produced this message, when applicable */
  origin?: { provider: string; model: string };
  usage?: TokenUsage;
}

export interface TokenUsage { input: number; output: number; cacheRead?: number; cacheWrite?: number; costUsd?: number }

// ---------- Provider seam (ADR-003: never throws; errors are stopReasons) ----------

export type StopReason =
  | "end_turn" | "tool_use" | "length" | "aborted" | "error" | "budget";

export interface AssistantTurn {
  parts: MessagePart[];
  stopReason: StopReason;
  usage: TokenUsage;
  error?: string;
}

export interface StreamOptions {
  signal?: AbortSignal;
  /** tool schemas advertised to the provider for native function calling */
  tools?: ToolSchema[];
}

export interface StreamFn {
  (model: ModelRef, messages: Message[], options?: StreamOptions): AsyncIterable<StreamEvent>;
}

export type StreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call_delta"; id: string; tool: string; argsDelta: string }
  | { type: "turn"; turn: AssistantTurn };

export interface ModelRef { provider: string; model: string; maxTokens?: number }

// ---------- Tools (ADR-005: validate → revise → policy → approve → sandbox → execute) ----------

export interface ToolSchema {
  name: string;
  description: string;
  /** JSON Schema for args */
  args: Record<string, unknown>;
}

export type ToolKind = "read" | "write" | "execute" | "spawn" | "memory" | "network" | "custom";

export interface ToolContext {
  sessionId: string;
  cwd: string;
  signal: AbortSignal;
  /** emit progress updates surfaced as tool_execution_update events */
  onUpdate?: (note: string) => void;
  /** spawn a child agent (multi-agent path) */
  spawn?: (req: SpawnRequest) => Promise<SpawnResult>;
  permissions: PermissionDecision;
}

export interface Tool {
  schema: ToolSchema;
  kind: ToolKind;
  /** false → run concurrently with siblings in the same batch */
  sequential?: boolean;
  interruptible?: boolean;
  execute(args: unknown, ctx: ToolContext): Promise<ToolOutput>;
}

export interface ToolOutput { ok: boolean; output: string; data?: unknown }

// ---------- Permissions ----------

export type PermissionEffect = "allow" | "deny" | "prompt";

export interface PermissionRule {
  action: string;       // e.g. "file.write", "shell.exec", "spawn", "*"
  resource: string;     // glob, e.g. "src/**", "rm *", "*"
  effect: PermissionEffect;
}

export type PermissionDecision =
  | { effect: "allow" }
  | { effect: "deny"; reason: string }
  | { effect: "prompt"; prompt: string };

export type ApprovalFn = (req: ApprovalRequest) => Promise<"once" | "always" | "deny">;

export interface ApprovalRequest {
  tool: string;
  args: unknown;
  revisedArgs: unknown;
  reason: string;
}

// ---------- Events (loop output; also the durability + observability unit) ----------

export type RunEvent =
  | { type: "run_start"; runId: string; sessionId: string; goal: string }
  | { type: "turn_start"; turn: number }
  | { type: "message_update"; messageId: string; delta: string }
  | { type: "tool_execution_start"; callId: string; tool: string; args: unknown }
  | { type: "tool_execution_update"; callId: string; note: string }
  | { type: "tool_execution_end"; callId: string; ok: boolean; output: string; durationMs: number }
  | { type: "tool_call_failed"; callId: string; reason: "truncated" | "invalid_args" | "permission_denied" | "not_found"; detail: string }
  /** strategy = the one that RAN (core/compaction.ts seam, or "context-drop" for ADR-007 chunk
   *  eviction); trigger (port #25) is set on history compactions only: "speculative" = estimate
   *  crossed the threshold, "emergency" = the provider rejected the request as an overflow */
  | { type: "compaction"; strategy: string; trigger?: CompactionTrigger; tokensBefore: number; tokensAfter: number }
  | { type: "turn_end"; turn: number; stopReason: StopReason }
  | { type: "steer"; text: string }
  | { type: "run_end"; status: "done" | "stopped" | "error" | "budget"; summary: string };

// ---------- Agent ----------

export interface AgentDefinition {
  name: string;
  systemPrompt: string | ((ctx: AgentVars) => string);
  tools: string[];        // tool names; "*" = all allowed by policy
  model?: ModelRef;
  maxTurns?: number;      // finite always (reject swarm's infinity)
  spawns?: "none" | "siblings" | "subtasks";
  memory?: { task?: boolean; episodic?: boolean; semantic?: boolean };
  /** extra non-history ADR-007 chunks (port #8: harvested project config,
   *  name "config", priority 70) folded into the system message via
   *  assembleContext — droppable under budget pressure, unlike systemPrompt */
  contextChunks?: ContextChunk[];
}

export interface AgentVars { [key: string]: unknown }

export interface SpawnRequest {
  agent: string;
  goal: string;
  vars?: AgentVars;
  isolated?: boolean;     // COW/git worktree when writing
  background?: boolean;
}

export interface SpawnResult { agent: string; ok: boolean; summary: string; usage: TokenUsage; patch?: string }

// ---------- Run configuration ----------

export interface RunConfig {
  maxTurns: number;
  contextBudgetTokens: number;
  compactionThreshold: number;   // fraction of budget triggering compaction
  /** port #25: history compaction strategy (core/compaction.ts; env AION_COMPACTION); default head-summarize */
  compactionStrategy?: CompactionStrategy;
  /** port #25 keep-window: user turns kept BEFORE the current one (default 2; an emergency keeps 0) */
  compactionKeepTurns?: number;
  parallelTools: boolean;
  permissionRules: PermissionRule[];
  approval?: ApprovalFn;
}
