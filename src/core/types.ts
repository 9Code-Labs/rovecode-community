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
  /** the run's wall-clock deadline (epoch ms, RunConfig.maxSeconds) — a retry backoff that would end past it
   *  is not taken (providers/retry.ts); unset = no clock */
  deadlineAt?: number;
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
/** `auto` = send NO thinking field and let the provider's own default stand — for the Claude 5 family
 *  that is adaptive thinking at high effort. It is the runtime default: the old default `off` sent an
 *  explicit `thinking: disabled`, which switched OFF the reasoning Opus 5 and Sonnet 5 do on their own
 *  and was a large part of "the model is not performing" (Berkay, 2026-09-04). `off` stays as the
 *  explicit, deliberate choice. */
export type ThinkingEffort = "auto" | "off" | "low" | "medium" | "high";
export const THINKING_EFFORTS: readonly ThinkingEffort[] = ["auto", "off", "low", "medium", "high"];

/** a level from a flag/env word; undefined when it names nothing (the caller keeps its default,
 *  rather than silently reading a typo as "off") */
export function parseEffort(v: string | undefined): ThinkingEffort | undefined {
  const w = (v ?? "").trim().toLowerCase();
  return (THINKING_EFFORTS as readonly string[]).includes(w) ? (w as ThinkingEffort) : undefined;
}

export interface ModelRef {
  provider: string;
  model: string;
  maxTokens?: number;
  effort?: ThinkingEffort;
  /** the catalog's word on whether the model has a reasoning mode (models.dev `reasoning`), stamped by
   *  cli/runtime.ts buildDef; `false` means no thinking field is ever sent (providers/thinking.ts).
   *  Unset = unknown: the dial goes out in the endpoint's dialect and a model that cannot reason ignores it. */
  reasoning?: boolean;
}

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
  /** Policy resource for a tool whose modes differ in what they are ALLOWED to do, where neither a
   *  path, a command nor a URL says which mode this call is. Without it the resource falls back to the
   *  tool NAME, so one rule has to cover every mode — which is how a read-only `design_direction
   *  {"action":"get"}` came to raise an approval card (2026-09-04): it writes nothing, but it shares a
   *  rule with `set`, and a human trained to allow the read hits allow on the write too. Return a short
   *  stable word; a rule then targets it (`tool.design_direction get -> allow`). Never derive it from a
   *  value the model can vary freely — the point is that a rule can name the mode, not that the model
   *  can name its own permissions. */
  resource?(args: unknown): string;
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
  /** set on the workspace-boundary card only (core/workspace.ts, tools.ts dispatch step 2a): the `file.external`
   *  resource the decision is about — `<real containing dir>\*` — so a surface can show and an "always" can remember
   *  the DIRECTORY, not the one file */
  external?: string;
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
  /** the verify gate is running the project's check / has finished it (core/verify-gate.ts); `detail` is one line */
  | { type: "verify"; command: string; state: "running" | "passed" | "failed" | "timeout"; ms?: number; detail?: string }
  /** `outstanding` (status "done" only): what the run left behind when the model stopped talking — absent
   *  when nothing is notable AND at least one file was written, so a clean run's event is exactly what it
   *  always was. "done" alone means "the model produced a turn with no tool call"; this field is how a
   *  surface tells that from "the work is complete" (core/loop.ts assessOutstanding). */
  | { type: "run_end"; status: "done" | "stopped" | "error" | "budget"; summary: string; outstanding?: RunOutstanding };

/** What a run that ended as "done" left behind. Every field is a fact read from the transcript or the
 *  session's own todo list — never an interpretation of the model's words. */
export interface RunOutstanding {
  /** tool calls of the LAST turn that had any, which failed: `write: Write rejected: …` (first line) */
  failed: string[];
  /** that last turn asked the user something and got no answer (headless, declined, or aborted) */
  unansweredAsk: boolean;
  /** successful `edit` + `write` calls over the whole run. `bash` may have changed files too; this counts only the two file tools */
  writes: number;
  /** the model's own todo list, when it kept one: items not completed / all items */
  todosOpen?: number;
  todosTotal?: number;
  /** the finish check (core/loop.ts) asked once for the work to be finished; this run_end is the answer it got */
  nudged: boolean;
  /** the verify gate (core/verify-gate.ts), present when the run wrote files and a gate was wired: did the
   *  project's own check pass after the changes, fail (with the failing part), time out, or was there no check to
   *  run. Absent when nothing was written — and when files changed only through `bash`, which `writes` cannot see. */
  verify?: VerifyState;
}

/** `refused`: what the resolver (core/verify.ts) saw and deliberately did not run, each with its reason — the
 *  argument for trusting the gate. `reason` (unconfigured): why there is nothing to run, in the resolver's words. */
export type VerifyState =
  | { state: "unconfigured"; reason?: string; refused?: string[] }
  | { state: "passed"; command: string; ms: number; refused?: string[] }
  | { state: "failed"; command: string; code: number; failure: string; refused?: string[] }
  | { state: "timeout"; command: string; seconds: number; refused?: string[] };

/** RunConfig.verify — wired by the runtime, consumed by the loop's "done" exit. `resolution` is what
 *  core/verify.ts decided (null / no commands = nothing to run → run_end says "not verified"); `run` executes it
 *  bounded by `timeoutMs` and the run's abort (core/verify-gate.ts runVerify). */
export interface VerifyGate {
  resolution: { commands: string[]; refused?: string[]; source?: string; reason?: string } | null;
  timeoutMs: number;
  run: (signal: AbortSignal) => Promise<{ command: string; ok: boolean; code: number; timedOut: boolean; ms: number; failure: string; ran: number }>;
}

// ---------- Agent ----------

export interface AgentDefinition {
  name: string;
  systemPrompt: string | ((ctx: AgentVars) => string);
  tools: string[];        // tool names; "*" = all allowed by policy
  model?: ModelRef;
  /** a custom subagent definition's `mode:` (core/agents.ts): "plan" runs the child under the plan rule set + prompt
   *  section (orchestrator runChild); "act" / absent changes nothing */
  mode?: "plan" | "act";
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
  /** set by TaskManager.start for a NESTED start: the tool names of the registry that started this child, so the child's
   *  registry is clamped to them (core/agents.ts restrictTools — a definition's allow-list is transitive) */
  parentTools?: ReadonlySet<string>;
}

/** `applied` answers "did this child's patch reach the parent tree?", and only that. ABSENT wherever
 *  there was never a merge-back to attempt (no isolation, no patch, a failed or cancelled child), true
 *  when `git apply` took it, false when git REFUSED it — which leaves `ok: true` and is therefore
 *  invisible in every other field. It exists because the alternative was reading a marker out of
 *  `summary`, and `summary` is truncated to 4000 chars: a chatty child that succeeded lost the marker
 *  and read as applied. A caller that ignores the field behaves exactly as before. */
export interface SpawnResult { agent: string; ok: boolean; summary: string; usage: TokenUsage; patch?: string; applied?: boolean }

// ---------- Run configuration ----------

export interface RunConfig {
  maxTurns: number;
  /** wall-clock ceiling for one run, in seconds; checked at every turn boundary (core/loop.ts), so a
   *  verification spiral of many short turns ends in a clean run_end "budget" with what was done so far.
   *  Unset = no clock. `rovecode run` defaults it to 20 minutes; ROVECODE_MAX_SECONDS / --max-seconds set it. */
  maxSeconds?: number;
  /** a spend ceiling for one run, in US dollars, checked at every turn boundary like maxSeconds: the run ends
   *  with status "budget" and what was done so far. Only turns `priceUsd` can price count; an unpriced turn
   *  (a model the catalog does not know) adds nothing and the summary says how many there were. Unset = no cap.
   *  `rovecode run --max-cost D`, ROVECODE_MAX_COST on every surface. */
  maxCostUsd?: number;
  /** what one turn cost, from its usage and the model that SERVED it (router fallback may differ from the one
   *  asked for) — undefined when the catalog has no price. The runtime binds this to its catalog; without it
   *  maxCostUsd can never trip, which is why buildCfg always sets both together. */
  priceUsd?: (usage: TokenUsage, origin: ModelRef) => number | undefined;
  /** The finish check (core/loop.ts, at the "done" exit): when the model stops talking right after a failed
   *  tool call or an unanswered question to the user, ONE continuation turn names what is outstanding and asks
   *  it to finish or say what is left. Default on; `false` (ROVECODE_FINISH_CHECK=0) turns it off. The
   *  representation on run_end (`outstanding`) is unconditional — turning this off only stops the nudge. */
  finishCheck?: boolean;
  /** the model's own todo list for this session, read at the exit: open / total, or null when it kept none.
   *  Represented on run_end; it is NOT a nudge trigger (no session on this machine has ever written one). */
  todoState?: () => { open: number; total: number } | null;
  /** The verify gate (core/verify-gate.ts): after a run that wrote files, run the project's own check before
   *  "done"; a failure goes back to the model ONCE (sharing the finish check's one-nudge budget), then run_end
   *  says how it ended. Absent = off (ROVECODE_VERIFY=0, plan mode, or a surface that wired none): nothing runs,
   *  nothing is added, a run's event is byte-identical to one without the gate. */
  verify?: VerifyGate;
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
