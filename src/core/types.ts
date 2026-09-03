/** Rovecode core type contracts. Single source of truth for the runtime. */

import type { ContextChunk } from "./context.ts";
import type { CompactionStrategy, CompactionTrigger } from "./compaction.ts";

// ---------- Messages (harness-level; converted to provider form only at the seam) ----------

export type Role = "system" | "user" | "assistant" | "tool";

export interface TextPart { kind: "text"; text: string }
export interface ToolCallPart { kind: "tool_call"; id: string; tool: string; args: unknown }
export interface ToolResultPart { kind: "tool_result"; callId: string; ok: boolean; output: string }
/** The four raster types both wire protocols accept (Anthropic image source media_type;
 *  OpenAI image_url data URL) — decided by magic bytes, never by file extension (core/images.ts). */
export type ImageMime = "image/png" | "image/jpeg" | "image/gif" | "image/webp";
/** port #34: an image attached to a user message. Exactly one carrier is set — `bytes` (base64,
 *  the in-memory / transport form: TUI /attach, ACP image blocks) or `path` (the sidecar file the
 *  session store wrote under `<session>/attachments/`; session-relative in entries.jsonl,
 *  resolved to absolute on load). Adapters read either through core/images.ts imageData(). */
export interface ImagePart {
  kind: "image";
  mime: ImageMime;
  bytes?: string;
  path?: string;
  width?: number;
  height?: number;
  /** display name (the attached file's basename) — transcript chip + non-vision placeholder */
  name?: string;
}
export type MessagePart = TextPart | ToolCallPart | ToolResultPart | ImagePart;

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
  /** a slice of the model's reasoning (Anthropic thinking_delta): counted for the live status
   *  line, never part of the answer — the terminal turn's parts carry text and tool calls only */
  | { type: "reasoning_delta"; text: string }
  | { type: "tool_call_delta"; id: string; tool: string; argsDelta: string }
  | { type: "turn"; turn: AssistantTurn };

/** How hard the model is asked to think before it answers. `off` is the plain request; the three
 *  levels map to each protocol's own dial — an Anthropic thinking budget in tokens, an OpenAI
 *  `reasoning_effort` string (providers/stream.ts thinkingBudget). A model with no reasoning mode
 *  ignores it: the field is sent, the endpoint drops it. */
export type ThinkingEffort = "off" | "low" | "medium" | "high";
export const THINKING_EFFORTS: readonly ThinkingEffort[] = ["off", "low", "medium", "high"];

/** a level from a flag/env word; undefined when it names nothing (the caller keeps its default,
 *  rather than silently reading a typo as "off") */
export function parseEffort(v: string | undefined): ThinkingEffort | undefined {
  const w = (v ?? "").trim().toLowerCase();
  return (THINKING_EFFORTS as readonly string[]).includes(w) ? (w as ThinkingEffort) : undefined;
}

export interface ModelRef { provider: string; model: string; maxTokens?: number; effort?: ThinkingEffort }

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
  /** port #29: the run this call belongs to (hook ctx, tracing); unset for bare registry use */
  runId?: string;
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

/** How much the human is asked. `ask` prompts for every write, command and subagent; `accept-edits`
 *  stops asking for writes INSIDE the workspace (shell, spawn, network and writes outside it still
 *  ask); `auto` never asks. Deny rules, plan mode and the execpolicy forbidden-argv stop hold at
 *  every level — this dial only moves the prompt branch. */
export type PermissionLevel = "ask" | "accept-edits" | "auto";

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
  /** the provider turn is reasoning: `tokens` = estimated reasoning tokens so far this turn,
   *  CUMULATIVE (a dropped event costs nothing). Only the count leaves the loop — the reasoning text
   *  is not the answer and neither the transcript nor a client should carry it. */
  | { type: "reasoning_update"; messageId: string; tokens: number }
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
  /** port #25: history compaction strategy (core/compaction.ts; env ROVECODE_COMPACTION); default head-summarize */
  compactionStrategy?: CompactionStrategy;
  /** port #25 keep-window: user turns kept BEFORE the current one (default 2; an emergency keeps 0) */
  compactionKeepTurns?: number;
  parallelTools: boolean;
  permissionRules: PermissionRule[];
  approval?: ApprovalFn;
}
