/** Compaction strategy seam + adaptive trigger (port #25; ADR-007 history compaction).
 *
 *  Strategies — oh-my-pi compaction/compaction.ts:167-231 @ 65f79e7 (MIT) keeps a strategy enum
 *  on the settings object and decides provider-native vs local per model; same split here:
 *    head-summarize   the pre-#25 path, byte-for-byte: summarize the head with the weak model,
 *                     keep the tail under half budget (aider history.py:41 via context.ts).
 *    keep-window      deterministic, NO model call: keep the last N user turns + everything
 *                     since the last user message, under a token cap; tool_call/tool_result
 *                     pairs leave or stay TOGETHER (senpi deterministic-fallback.ts:28-33
 *                     @ a0f26a6 rejects an "atomic-tool-chain-cut"; opencode message-v2.ts:
 *                     349-360 — every tool_use needs its tool_result on the wire). When the
 *                     current turn alone overflows, the user's request survives and the cut
 *                     lands inside its tool traffic (opencode compaction.ts:340-356 replays
 *                     the last user message after an overflow compaction).
 *    provider-native  delegate to a server-side compaction capability when the active provider
 *                     advertises one (oh-my-pi :222-231 shouldUseProviderNativeCompaction;
 *                     :1264-1281 local summary when remote is off/unsupported). HONESTY: none
 *                     of rovecode's adapters advertise it today — the seam (LoopDeps.compactNative)
 *                     and a test double ship; absent or declining → head-summarize fallback.
 *
 *  Trigger (senpi a0f26a6): "speculative" when the ESTIMATE crosses budget × threshold, before
 *  the provider call (compaction-settings.ts:22-24 speculativeFraction; agent-session.ts:5874
 *  "Threshold: compact, NO auto-retry"). "emergency" when the provider REJECTS the request as
 *  a context overflow (agent-session.ts:5873 "Overflow: LLM returned context overflow error …
 *  compact, auto-retry"; :6061-6080 exactly ONE compact-and-retry; opencode processor.ts:
 *  607-617 ContextOverflowError → needsCompaction → prompt.ts:1320-1327 create({overflow}) →
 *  the loop restarts the turn). Emergency plans against the OBSERVED size, not the configured
 *  window — the estimator just proved optimistic.
 *
 *  Pure over Messages. The loop owns token accounting (ctx.tokenText = partsTokenText, so the
 *  numbers match its trigger) and persistence (SessionStore.appendEvent). No loop import here:
 *  loop.ts imports this module. Without a summarizer, speculative compaction stays off exactly
 *  as before #25; an emergency still shrinks via the deterministic window (senpi deterministic-
 *  fallback.ts:111 createRequiredCompactionFallback — a required compaction never wedges). */

import { randomUUID } from "node:crypto";
import type { Message, ModelRef, RunConfig } from "./types.ts";
import { estimateTokens, planCompaction as planHeadTail } from "./context.ts";
import { safeHead } from "./tool-output-budget.ts";

export type CompactionStrategy = "head-summarize" | "keep-window" | "provider-native";
export type CompactionTrigger = "speculative" | "emergency";

export const COMPACTION_STRATEGIES: readonly CompactionStrategy[] = ["head-summarize", "keep-window", "provider-native"];
export const DEFAULT_COMPACTION_STRATEGY: CompactionStrategy = "head-summarize";
/** keep-window: user turns retained BEFORE the current one when RunConfig.compactionKeepTurns is unset */
export const DEFAULT_KEEP_TURNS = 2;

/** `ROVECODE_COMPACTION=<strategy>`, case-insensitive — unset/blank → undefined (the caller applies the
 *  default). An unknown name is ALSO undefined (→ default) plus ONE stderr note per process and value:
 *  createRuntime has no warnings channel, and buildCfg re-parses the env before every run. */
const unknownStrategyNoted = new Set<string>();
export function parseCompactionStrategy(raw: string | undefined): CompactionStrategy | undefined {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "") return undefined;
  if ((COMPACTION_STRATEGIES as readonly string[]).includes(v)) return v as CompactionStrategy;
  if (!unknownStrategyNoted.has(v)) {
    unknownStrategyNoted.add(v);
    console.error(`rovecode: unknown ROVECODE_COMPACTION "${(raw ?? "").trim()}" — using ${DEFAULT_COMPACTION_STRATEGY} (known: ${COMPACTION_STRATEGIES.join(", ")})`);
  }
  return undefined;
}

/** Server-side compaction capability. Resolve to the replacement history, or null to decline
 *  (unsupported model, endpoint error) — the seam then falls back locally. Contract: the
 *  returned history's LAST message must be one the store already holds (the loop parents the
 *  next message on it). */
export type NativeCompactor = (
  history: Message[],
  opts: { model?: ModelRef; budgetTokens: number; trigger: CompactionTrigger; signal?: AbortSignal },
) => Promise<Message[] | null>;

export interface CompactionCtx {
  trigger: CompactionTrigger;
  /** token-bearing text of ONE message, all parts (loop.ts partsTokenText) — tokens = estimateTokens(tokenText) */
  tokenText: (m: Message) => string;
  summarize?: (texts: string[]) => Promise<string>;
  native?: NativeCompactor;
  model?: ModelRef;
  signal?: AbortSignal;
}

export interface CompactionPlan {
  strategy: CompactionStrategy;
  /** the configured strategy when it could not run and `strategy` is its fallback */
  fallbackFrom?: CompactionStrategy;
  keep: Message[];
  drop: Message[];
  /** head-summarize: a summarizer call is required before the history can be rebuilt */
  summaryNeeded: boolean;
  tokensBefore: number;
  /** planning budget in force: the window (speculative) or half the observed size (emergency) */
  budgetTokens: number;
}

export interface CompactionOutcome { history: Message[]; strategy: CompactionStrategy; fallbackFrom?: CompactionStrategy }

// ---------- trigger ----------

/** Adaptive trigger. Strictly GREATER than budget × threshold: AT the threshold nothing fires
 *  (pinned). A provider overflow rejection is an emergency whatever the estimate says. */
export function compactionTrigger(histTokens: number, cfg: RunConfig, overflow: boolean): CompactionTrigger | null {
  if (overflow) return "emergency";
  return histTokens > cfg.contextBudgetTokens * cfg.compactionThreshold ? "speculative" : null;
}

/** Provider phrasings of "the prompt does not fit" — opencode-2026 llm/provider-error.ts:4-38
 *  @ ebece6e (MIT), minus the throttling exclusions; plus HTTP 413 (provider/error.ts:175).
 *  rovecode error text is "HTTP <status>: <body>" (stream-errors.ts httpErrorTurn; router.ts
 *  classifyStreamError reads the same prefix) or a bare transport message. 429/5xx are the
 *  retry classes (port #23) and never an overflow, whatever their body says. */
const OVERFLOW_PATTERNS = [
  /prompt is too long/i, /request_too_large/i, /input is too long for requested model/i,
  /exceeds the context window/i, /maximum context length/i, /context[_ ]length[_ ]exceeded/i,
  /input token count.*exceeds the maximum/i, /tokens in request more than max tokens allowed/i,
  /maximum prompt length is \d+/i, /reduce the length of the messages/i, /request entity too large/i,
  /model_context_window_exceeded/i, /too many tokens/i, /token limit exceeded/i,
  /exceeds the available context size/i, /greater than the context length/i,
];
const OVERFLOW_EXCLUSIONS = [/rate limit/i, /too many requests/i, /throttling/i, /service unavailable/i];

export function isContextOverflow(error: string | undefined): boolean {
  if (!error || OVERFLOW_EXCLUSIONS.some((p) => p.test(error))) return false;
  // the status may sit behind the router's exhausted-chain rewrite ("model chain 'x' exhausted
  // (N candidates failed); last: HTTP 500: …", router.ts) — a 5xx body that mentions tokens is
  // still a 5xx, never an overflow
  const status = /(?:^|last: )HTTP (\d{3})\b/.exec(error)?.[1];
  if (status === "413") return true;
  if (status === "429" || status?.startsWith("5")) return false;
  return OVERFLOW_PATTERNS.some((p) => p.test(error));
}

// ---------- planning ----------

/** Speculative plans against the window. Emergency halves the smaller of window and OBSERVED
 *  history, so the kept tail lands ≤ a quarter of what just overflowed (senpi shrinks the
 *  summarization input geometrically per overflow retry — overflow-retry-bound.test.ts:126-142;
 *  we get ONE retry, so one aggressive step). */
export function planningBudget(cfg: RunConfig, observedTokens: number, trigger: CompactionTrigger): number {
  if (trigger === "speculative") return cfg.contextBudgetTokens;
  return Math.max(1, Math.floor(Math.min(cfg.contextBudgetTokens, observedTokens) / 2));
}

function resolveStrategy(requested: CompactionStrategy, ctx: CompactionCtx): CompactionStrategy | null {
  if (requested === "keep-window") return "keep-window";
  if (requested === "provider-native" && ctx.native) return "provider-native";
  if (ctx.summarize) return "head-summarize";
  // no summarizer: speculative stays off (pre-#25 gate); an emergency must still shrink
  return ctx.trigger === "emergency" ? "keep-window" : null;
}

export function planCompaction(history: Message[], cfg: RunConfig, ctx: CompactionCtx): CompactionPlan | null {
  const requested = cfg.compactionStrategy ?? DEFAULT_COMPACTION_STRATEGY;
  const strategy = resolveStrategy(requested, ctx);
  if (!strategy) return null;
  const tokens = (m: Message) => estimateTokens(ctx.tokenText(m));
  const tokensBefore = history.reduce((n, m) => n + tokens(m), 0);
  const budgetTokens = planningBudget(cfg, tokensBefore, ctx.trigger);
  const base = { strategy, tokensBefore, budgetTokens, ...(strategy !== requested ? { fallbackFrom: requested } : {}) };
  if (strategy === "provider-native") return { ...base, keep: history, drop: [], summaryNeeded: false };
  if (strategy === "keep-window") {
    const turns = ctx.trigger === "emergency" ? 0 : (cfg.compactionKeepTurns ?? DEFAULT_KEEP_TURNS);
    return { ...base, ...keepWindow(history, tokens, budgetTokens, turns), summaryNeeded: false };
  }
  // head-summarize: the aider head/tail plan over {id,tokens,text} projections, mapped back to
  // the real messages (loop.test.ts "rebuilds history from real messages, not projections")
  const plan = planHeadTail(history.map((m) => ({ id: m.id, tokens: tokens(m), text: ctx.tokenText(m) })), budgetTokens);
  const keepIds = new Set(plan.keep.map((k) => k.id));
  // never an empty tail: the summary message is working-history only (never persisted), so the next
  // assistant must parent on a REAL message or the store reloads with an orphan chain. When the last
  // message alone exceeds half the budget the aider plan keeps nothing — keep it anyway, and when it
  // is a tool result keep the assistant that issued the call too (over cap accepted over an orphan,
  // exactly keepWindow's alignCut rule; the plan's ordinary cut stays prose-oriented, as before)
  if (keepIds.size === 0 && history.length > 0) {
    let i = history.length - 1;
    while (i > 0 && history[i]!.role === "tool") i--;
    for (const m of history.slice(i)) keepIds.add(m.id);
  }
  return { ...base, keep: history.filter((m) => keepIds.has(m.id)), drop: history.filter((m) => !keepIds.has(m.id)), summaryNeeded: true };
}

/** Deterministic window. Turn-level cuts land on user messages; when the current turn alone
 *  exceeds the cap (half the planning budget), the user's request is kept and the cut moves
 *  through its tool traffic one assistant+results group at a time (alignCut). */
export function keepWindow(history: Message[], tokens: (m: Message) => number, budgetTokens: number, keepTurns: number): { keep: Message[]; drop: Message[] } {
  const cap = Math.floor(budgetTokens / 2);
  const sum = (ms: Message[]) => ms.reduce((n, m) => n + tokens(m), 0);
  const userIdx = history.flatMap((m, i) => (m.role === "user" ? [i] : []));
  let ui = Math.max(0, userIdx.length - 1 - Math.max(0, keepTurns));
  let start = userIdx.length > 0 ? userIdx[ui]! : 0;
  while (sum(history.slice(start)) > cap && ui < userIdx.length - 1) start = userIdx[++ui]!;
  const lastUser = userIdx.at(-1);
  if (lastUser !== undefined && start === lastUser && sum(history.slice(start)) > cap) {
    // the current turn alone overflows: keep the request, cut inside the traffic after it
    let inner = lastUser + 1;
    while (inner < history.length && tokens(history[lastUser]!) + sum(history.slice(inner)) > cap) {
      const next = alignCut(history, inner + 1);
      if (next <= inner || next >= history.length) break;
      inner = next;
    }
    return { keep: [history[lastUser]!, ...history.slice(inner)], drop: [...history.slice(0, lastUser), ...history.slice(lastUser + 1, inner)] };
  }
  if (userIdx.length === 0) {
    // no user turn at all (foreign history): plain message-level cut, pairs still intact
    while (sum(history.slice(start)) > cap) {
      const next = alignCut(history, start + 1);
      if (next <= start || next >= history.length) break;
      start = next;
    }
  }
  return { keep: history.slice(start), drop: history.slice(0, start) };
}

/** A cut on a tool message would orphan results whose call sits in the dropped head: advance
 *  past the result run so call + results leave together. Returns history.length when only
 *  results remain — the caller stops there and keeps the calling assistant with them. */
function alignCut(history: Message[], i: number): number {
  let j = i;
  while (j < history.length && history[j]!.role === "tool") j++;
  return j;
}

// ---------- prune (P0-2, view-only) ----------
//
// OpenCode's prune (opencode dev session/compaction.ts:271-294, erişim 2026-09-14): walk the
// history backwards, protect the last user turn plus PRUNE_PROTECT tokens of tool traffic, and
// erase older tool outputs IN PLACE; below PRUNE_MINIMUM of gain do nothing. Claude Code's
// auto-compact phase 1 is the same idea ("clears older tool outputs first"). The difference
// here is WHERE it runs: rovecode never rewrites the session record — the store keeps every
// byte (replay/export/trace stay truthful) and prune transforms only the VIEW sent to the
// provider, recomputed per turn from the full history. Because parts are stubbed in place —
// never removed — every tool_call keeps its tool_result on the wire (the invariant
// message-v2.ts:349-360 protects) by construction, and turn/branch bookkeeping is untouched.

export interface PruneConfig {
  /** tokens of tool traffic protected from the cut, walking back from the last user turn
   *  (OpenCode PRUNE_PROTECT = 40_000) */
  protectTokens: number;
  /** prune only when at least this many tokens are freed (OpenCode PRUNE_MINIMUM = 20_000) —
   *  below it the marker costs more than the win */
  minGainTokens: number;
  /** tool names whose results are never pruned — OpenCode protects ["skill"]; here the active
   *  skill body (skill_view) is what the model is following this minute */
  protectedTools: readonly string[];
  /** chars of the original output kept at the head of the stub, so the model can tell what it
   *  was without re-running the tool (the rest is named, not shown) */
  headChars: number;
}

export const DEFAULT_PRUNE_CONFIG: PruneConfig = {
  protectTokens: 40_000,
  minGainTokens: 20_000,
  protectedTools: ["skill_view"],
  headChars: 160,
};

/** stub marker — the idempotence check keys on it, so a pruned view is never re-pruned */
export const PRUNE_STUB_MARK = "[pruned from context:";

export interface PruneOutcome {
  /** new message objects where stubs landed; untouched messages keep identity (===) */
  view: Message[];
  pruned: number;
  tokensBefore: number;
  tokensAfter: number;
  tokensFreed: number;
}

/** Stub text: a small head of the original (what the output WAS), then the numbers and the
 *  remedy. The session transcript keeps the full output — the stub says so. */
function pruneStub(output: string, headChars: number): string {
  const head = headChars > 0 ? safeHead(output, headChars) : "";
  return `${head}\n${PRUNE_STUB_MARK} ${output.length} chars (~${estimateTokens(output)} tokens) removed — the full output is in the session transcript; re-read the file or re-run the tool if you need it]`;
}

/** Pure over the history; never mutates `history`. Returns null when the gain is below the
 *  threshold or there is nothing to do — the caller then sends the history unchanged and
 *  yields no event. */
export function pruneToolOutputs(
  history: readonly Message[],
  cfg: PruneConfig,
  tokenText: (m: Message) => string,
): PruneOutcome | null {
  // callId → tool name (results carry no tool name; the call does)
  const toolOf = new Map<string, string>();
  for (const m of history) {
    if (m.role !== "assistant") continue;
    for (const p of m.parts) if (p.kind === "tool_call") toolOf.set(p.id, p.tool);
  }
  // the active turn: from the last user message on, everything is untouchable
  let lastUser = -1;
  for (let i = 0; i < history.length; i++) if (history[i]!.role === "user") lastUser = i;
  const start = (lastUser === -1 ? history.length : lastUser) - 1;
  // walk back: protect protectTokens of tool traffic; everything older is eligible
  let acc = 0;
  const eligible = new Set<number>();
  for (let i = start; i >= 0; i--) {
    const m = history[i]!;
    if (m.role !== "tool") continue;
    let mt = 0;
    for (const p of m.parts) if (p.kind === "tool_result") mt += estimateTokens(p.output);
    if (acc + mt <= cfg.protectTokens) acc += mt;
    else eligible.add(i);
  }
  if (eligible.size === 0) return null;
  const stubbable = (callId: string, ok: boolean, output: string): boolean =>
    ok &&                                                    // errors stay verbatim — they are the lesson
    !output.includes(PRUNE_STUB_MARK) &&                     // idempotence: never re-stub a stub
    !cfg.protectedTools.includes(toolOf.get(callId) ?? "") &&
    output.length > 256;                                     // a stub must pay for its own marker
  let freed = 0;
  let pruned = 0;
  const view = history.map((m, i) => {
    if (!eligible.has(i)) return m;
    let changed = false;
    const parts = m.parts.map((p) => {
      if (p.kind !== "tool_result" || !stubbable(p.callId, p.ok, p.output)) return p;
      const stub = pruneStub(p.output, cfg.headChars);
      if (stub.length >= p.output.length) return p;          // paranoia: never grow
      freed += estimateTokens(p.output) - estimateTokens(stub);
      pruned++;
      changed = true;
      return { ...p, output: stub };
    });
    return changed ? { ...m, parts } : m;
  });
  if (pruned === 0 || freed < cfg.minGainTokens) return null;
  const measure = (ms: readonly Message[]) => ms.reduce((n, m) => n + estimateTokens(tokenText(m)), 0);
  const tokensBefore = measure(history);
  const tokensAfter = measure(view);
  return { view: view as Message[], pruned, tokensBefore, tokensAfter, tokensFreed: tokensBefore - tokensAfter };
}

// ---------- thrash guard (P0-4) ----------
//
// Claude Code stops auto-compacting after a few attempts when the window refills immediately
// ("auto-compact thrashing" — code.claude.com/docs/en/troubleshooting.md). The same protection
// here, as a pure pace ledger the loop carries per run: a compaction within `rapidWindow` turns
// of the previous one earns one strike, one that fails to shrink the wire by 5% earns another —
// three strikes and the run stops compacting. (A first-ever compaction can LEGITIMATELY not
// shrink — a one-token head summarizes into a ten-token summary; that alone must never trip the
// guard, which is why a strike pair, not the bare fact, is the signal.) An emergency arriving
// during cooldown ends the run in error instead of re-driving a request whose compaction just
// failed — a loop that will not stop is worse than one that stops early (core/loop.ts).

export interface CompactionPace { lastTurn: number; strikes: number }
export const initialCompactionPace: CompactionPace = { lastTurn: -1_000_000, strikes: 0 };
export const DEFAULT_RAPID_WINDOW_TURNS = 2;
export const COOLDOWN_STRIKES = 3;

/** Strike ledger: +1 when rapid (≤ rapidWindow turns since the last compaction), +1 when the
 *  wire did not shrink by ≥5%. A spaced, effective compaction clears the ledger. */
export function updateCompactionPace(pace: CompactionPace, turn: number, shrankWell: boolean, rapidWindow: number): CompactionPace {
  const strikes = (turn - pace.lastTurn <= rapidWindow ? 1 : 0) + (shrankWell ? 0 : 1);
  return { lastTurn: turn, strikes: strikes === 0 ? 0 : pace.strikes + strikes };
}

export function compactionCooldown(pace: CompactionPace, rapidWindow: number): boolean {
  return rapidWindow > 0 && pace.strikes >= COOLDOWN_STRIKES;
}

// ---------- apply ----------

/** Rebuild the working history per plan. null = nothing to compact (keep-window found nothing
 *  droppable; a native decline with no local fallback) — the caller yields no event then. */
export async function applyCompaction(history: Message[], plan: CompactionPlan, cfg: RunConfig, ctx: CompactionCtx): Promise<CompactionOutcome | null> {
  const tag = plan.fallbackFrom ? { fallbackFrom: plan.fallbackFrom } : {};
  if (plan.strategy === "provider-native") {
    let out: Message[] | null = null;
    if (ctx.native) {
      try { out = await ctx.native(history, { model: ctx.model, budgetTokens: plan.budgetTokens, trigger: ctx.trigger, signal: ctx.signal }); } catch { out = null; }
    }
    if (out) return { history: out, strategy: "provider-native", ...tag };
    // declined at apply time: re-plan locally (oh-my-pi :1264 keeps a portable local summary
    // rather than strand the history); the local plan is never provider-native — bounded
    const local = planCompaction(history, { ...cfg, compactionStrategy: DEFAULT_COMPACTION_STRATEGY }, { ...ctx, native: undefined });
    if (!local) return null;
    const res = await applyCompaction(history, local, cfg, { ...ctx, native: undefined });
    return res ? { ...res, fallbackFrom: "provider-native" } : null;
  }
  if (plan.strategy === "keep-window") {
    if (plan.drop.length === 0) return null;
    const dropped = plan.drop.reduce((n, m) => n + estimateTokens(ctx.tokenText(m)), 0);
    const marker: Message = {
      id: randomUUID(), role: "system",
      parts: [{ kind: "text", text: `[context compacted (keep-window): ${plan.drop.length} earlier messages, ~${dropped} tokens, removed from the working context]` }],
      parentId: plan.keep[0]?.id ?? null, createdAt: Date.now(),
    };
    return { history: [marker, ...plan.keep], strategy: "keep-window", ...tag };
  }
  if (!ctx.summarize) return null;
  const summary = await ctx.summarize(plan.drop.map((m) => ctx.tokenText(m)));
  const compactMsg: Message = {
    id: randomUUID(), role: "system",
    parts: [{ kind: "text", text: `Summary of earlier conversation:\n${summary}` }],
    parentId: history[0]?.id ?? null, createdAt: Date.now(),
  };
  return { history: [compactMsg, ...plan.keep], strategy: "head-summarize", ...tag };
}
