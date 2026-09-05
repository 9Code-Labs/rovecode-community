/** What is actually in the context window, item by item — and how far our arithmetic is from what
 *  the provider says it charged for.
 *
 *  Two numbers exist for every turn and they are NOT the same thing:
 *    - the ESTIMATE: o200k over every part we are about to send. Ours, synchronous, available before
 *      a request and for a session that never ran. An estimate for anything that is not an OpenAI
 *      tokenizer — Anthropic's is not public, and its 4.7-generation tokenizer produces materially
 *      more tokens for the same text, so the estimate reads LOW there.
 *    - the REPORTED prompt: what the provider itself counted, i.e. `input + cacheRead + cacheWrite`
 *      of a turn's usage. Cache reads and writes are part of the prompt the model saw; leaving them
 *      out is the most common way a context meter reads far too low on an agentic session, where
 *      almost the whole prompt is a cache read.
 *  drift() compares them at the same point in the transcript, so "how wrong is our meter for this
 *  provider" becomes a measured number instead of a belief. Beyond DRIFT_TOLERANCE it is worth
 *  saying out loud: it means compaction fires at the wrong time.
 *
 *  Nothing here reads the network or the disk, and nothing throws: a transcript with no usage at all
 *  still produces a report, with `drift` simply absent. */

import { partsTokenText } from "./loop.ts";
import type { Message, MessagePart } from "./types.ts";
import { tokenScaleFor } from "./token-scale.ts";
import { contextHealth, costUsdTiered, countTokens, type NormalizedUsage, type PricingRow } from "./usage.ts";
import { ratesFor } from "../providers/catalog.ts";
import type { PriceTier } from "../providers/catalog-local.ts";

/** past this the estimate is misleading enough to name — the compaction trigger reads the estimate */
export const DRIFT_TOLERANCE = 0.05;

/** the budget for a model whose window we do not know — the old flat value, kept as the fallback */
export const DEFAULT_CONTEXT_BUDGET = 200_000;
/** never plan for less history than this, however small the window says it is */
export const MIN_CONTEXT_BUDGET = 32_000;
/** room left beside the history for the system prompt, the tool schemas and the indexes */
export const PROMPT_OVERHEAD_TOKENS = 24_000;
/** assumed answer room when the catalog states no output limit */
const ASSUMED_OUTPUT = 32_000;

/** How much history a run may carry before compaction. A flat 200k spends a fifth of a 1M window and
 *  overflows a 128k one, so it is derived: the window minus what the answer and the fixed prompt need.
 *  An explicit override wins (ROVECODE_CONTEXT_BUDGET), an unknown window keeps the old default, and a
 *  window too small to hold the floor gets a proportional share rather than a budget larger than itself. */
export function contextBudgetFor(opts: { window?: number; maxOutput?: number; override?: number; scale?: number }): number {
  const { window, maxOutput, override } = opts;
  if (override !== undefined && Number.isFinite(override) && override > 0) return Math.floor(override);
  if (!window || !Number.isFinite(window) || window <= 0) return DEFAULT_CONTEXT_BUDGET;
  const reserve = (Number.isFinite(maxOutput) && (maxOutput ?? 0) > 0 ? (maxOutput as number) : ASSUMED_OUTPUT) + PROMPT_OVERHEAD_TOKENS;
  const room = window - reserve;
  const raw = room < MIN_CONTEXT_BUDGET ? Math.max(1, Math.floor(window * 0.6)) : Math.floor(room);
  // The budget is compared against an estimate, so a model whose tokenizer counts more than the
  // estimator must get a smaller budget — dividing here is exactly equivalent to inflating every
  // estimate at every call site, and there is one of it. See core/token-scale.ts for the measurements.
  const scale = opts.scale !== undefined && Number.isFinite(opts.scale) && opts.scale > 0 ? opts.scale : 1;
  return Math.max(1, Math.floor(raw / scale));
}

export interface ContextSlice {
  label: string;
  tokens: number;
  /** of the estimate, 0..1 — 0 when the estimate is 0 */
  share: number;
  /** what the reader should know about this row, when a number alone would mislead */
  note?: string;
}

export interface ContextDrift {
  /** our estimate of the prompt at the last turn that reported usage */
  estimated: number;
  /** what that turn says it was given: input + cacheRead + cacheWrite */
  reported: number;
  /** reported − estimated; positive means we are UNDER-counting the real window */
  delta: number;
  /** |delta| / reported, 0 when reported is 0 */
  fraction: number;
  beyondTolerance: boolean;
}

export interface ContextReport {
  model: { provider: string; model: string };
  /** the catalog's context window for the current model, when it knows one */
  window?: number;
  /** o200k over the whole transcript — what the next request would carry */
  estimated: number;
  /** the estimate corrected towards this model's own tokenizer; equals `estimated` when unmeasured.
   *  The window rows below are computed from THIS, because it is the number the provider will use. */
  corrected: number;
  /** the correction that was applied, and where its number came from */
  scale: { factor: number; measured: boolean; note: string };
  slices: ContextSlice[];
  /** window − corrected, floored at 0; absent when the window is unknown */
  remaining?: number;
  /** corrected / window; absent when the window is unknown */
  fraction?: number;
  nearLimit?: boolean;
  drift?: ContextDrift;
  /** summed over every turn that reported usage */
  totals: NormalizedUsage;
  /** USD over the turns that could be priced, and how many could not */
  costUsd?: number;
  unpricedTurns: number;
  /** images carry tokens we do not estimate — say how many rather than pretend they are free */
  images: number;
}

export interface ReportInput {
  messages: readonly Message[];
  /** the current model, used for the window and for turns with no origin */
  current: { provider: string; model: string };
  /** window + pricing for a model, however the caller gets them (catalog, overlay, a test double) */
  lookup: (ref: { provider: string; model: string }) => { contextWindow?: number; pricing?: PricingRow; tier?: PriceTier } | undefined;
  /** the system prompt that will be sent, when the caller has it */
  system?: string;
  /** the serialized tool schemas that will be sent, when the caller has them */
  toolSchemas?: string;
}

const tokensOf = (text: string): number => (text ? countTokens(text) : 0);

function partTokens(parts: readonly MessagePart[], kind: MessagePart["kind"]): number {
  const only = parts.filter((p) => p.kind === kind);
  return only.length === 0 ? 0 : tokensOf(partsTokenText(only as MessagePart[]));
}

/** Roles are grouped the way a reader thinks about them, not the way the wire does: what I sent, what
 *  the model said, what the tools were asked, what they answered. Tool traffic dominates an agentic
 *  session and hiding it inside "assistant" is what makes a context meter useless. */
export function contextReport(input: ReportInput): ContextReport {
  const { messages, current, lookup } = input;
  const info = lookup(current);

  const userText = messages.filter((m) => m.role === "user");
  const assistantText = messages.filter((m) => m.role === "assistant");
  const systemMsgs = messages.filter((m) => m.role === "system");

  const slices: ContextSlice[] = [];
  const push = (label: string, tokens: number, note?: string) => {
    if (tokens > 0) slices.push({ label, tokens, share: 0, ...(note ? { note } : {}) });
  };

  push("system prompt", tokensOf(input.system ?? "") + partTokens(systemMsgs.flatMap((m) => m.parts), "text"));
  push("tool schemas", tokensOf(input.toolSchemas ?? ""), input.toolSchemas ? undefined : "not supplied");
  push("your messages", partTokens(userText.flatMap((m) => m.parts), "text"));
  push("assistant replies", partTokens(assistantText.flatMap((m) => m.parts), "text"));
  const allParts = messages.flatMap((m) => m.parts);
  push("tool calls", partTokens(allParts, "tool_call"));
  push("tool results", partTokens(allParts, "tool_result"));

  const estimated = slices.reduce((n, s) => n + s.tokens, 0);
  for (const s of slices) s.share = estimated > 0 ? s.tokens / estimated : 0;

  const totals: NormalizedUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let cost = 0;
  let priced = 0;
  let unpricedTurns = 0;
  for (const m of messages) {
    const u = m.usage;
    if (!u) continue;
    const n: NormalizedUsage = { input: u.input, output: u.output, cacheRead: u.cacheRead ?? 0, cacheWrite: u.cacheWrite ?? 0 };
    totals.input += n.input; totals.output += n.output; totals.cacheRead += n.cacheRead; totals.cacheWrite += n.cacheWrite;
    if (n.input === 0 && n.output === 0 && n.cacheRead === 0 && n.cacheWrite === 0) continue;
    const info = lookup(m.origin ?? current);
    // The prompt this turn carried decides the rate on a tiered model: xAI and Google bill a prompt
    // over 200k at the upper rate, and xAI applies it to the whole request. Pricing a tiered turn at
    // the base rate printed roughly HALF the real cost, with no caveat saying so — the TUI's /cost had
    // this right and this report did not, which is the worst arrangement of the two.
    const c = info?.pricing
      ? costUsdTiered(n, ratesFor({ ...(m.origin ?? current), pricing: info.pricing, ...(info.tier ? { tier: info.tier } : {}) }, n.input + n.cacheRead + n.cacheWrite))
      : undefined;
    if (c === undefined) unpricedTurns += 1;
    else { cost += c; priced += 1; }
  }

  // The window rows are what a reader acts on, so they are computed from the corrected estimate: on
  // Claude 5 o200k reads up to 1.58x low, and a meter that says 60% of a window already at 95% is worse
  // than no meter. `estimated` stays raw beside it so the correction is visible, never silent.
  const sc = tokenScaleFor(current);
  const corrected = Math.ceil(estimated * sc.scale);
  const report: ContextReport = {
    model: current,
    estimated,
    corrected,
    scale: { factor: sc.scale, measured: sc.measured, note: sc.note },
    slices,
    totals,
    unpricedTurns,
    images: allParts.filter((p) => p.kind === "image").length,
    ...(priced > 0 ? { costUsd: cost } : {}),
  };
  if (info?.contextWindow) {
    const health = contextHealth(corrected, info.contextWindow);
    report.window = info.contextWindow;
    report.fraction = health.fraction;
    report.nearLimit = health.nearLimit;
    report.remaining = Math.max(0, info.contextWindow - corrected);
  }
  // the two rows the provider counted and the transcript never stored — see drift()
  const fixedTokens = (slices.find((x) => x.label === "system prompt")?.tokens ?? 0) + (slices.find((x) => x.label === "tool schemas")?.tokens ?? 0);
  const d = drift(messages, fixedTokens);
  if (d) report.drift = d;
  return report;
}

/** Our estimate against the provider's own count, measured at the last turn that reported one.
 *  The comparison point matters: a turn's usage describes the prompt BEFORE that turn, so the
 *  estimate is taken over everything up to it, exclusive. Returns undefined when no turn reported
 *  a prompt (a fresh session, or a provider that sends no usage).
 *
 *  `fixedTokens` is the system prompt plus the tool schemas. They must be included or the comparison
 *  is not a comparison: neither is ever stored in a transcript — the system message is appended to the
 *  wire payload and never to history, and tool schemas are a separate wire field entirely — while the
 *  provider's `reported` count is of a request that always carried both. Leaving them out made every
 *  session look like it drifted by roughly the size of the fixed prompt, which on a fresh session is
 *  most of it, and did so even for OpenAI models where the estimator is exact by construction. That is
 *  a false signal on the one line whose whole job is to say whether the meter can be trusted. */
export function drift(messages: readonly Message[], fixedTokens = 0): ContextDrift | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const u = messages[i]?.usage;
    if (!u) continue;
    const reported = u.input + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
    if (reported <= 0) continue;
    const before = messages.slice(0, i);
    const estimated = fixedTokens + (before.length === 0 ? 0 : tokensOf(before.map((m) => partsTokenText(m.parts)).join("\n")));
    const delta = reported - estimated;
    const fraction = reported > 0 ? Math.abs(delta) / reported : 0;
    return { estimated, reported, delta, fraction, beyondTolerance: fraction > DRIFT_TOLERANCE };
  }
  return undefined;
}
