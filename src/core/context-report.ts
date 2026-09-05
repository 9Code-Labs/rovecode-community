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
import { contextHealth, costUsd, countTokens, type NormalizedUsage, type PricingRow } from "./usage.ts";

/** past this the estimate is misleading enough to name — the compaction trigger reads the estimate */
export const DRIFT_TOLERANCE = 0.05;

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
  slices: ContextSlice[];
  /** window − estimated, floored at 0; absent when the window is unknown */
  remaining?: number;
  /** estimated / window; absent when the window is unknown */
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
  lookup: (ref: { provider: string; model: string }) => { contextWindow?: number; pricing?: PricingRow } | undefined;
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
    const pricing = lookup(m.origin ?? current)?.pricing;
    const c = pricing ? costUsd(n, pricing) : undefined;
    if (c === undefined) unpricedTurns += 1;
    else { cost += c; priced += 1; }
  }

  const report: ContextReport = {
    model: current,
    estimated,
    slices,
    totals,
    unpricedTurns,
    images: allParts.filter((p) => p.kind === "image").length,
    ...(priced > 0 ? { costUsd: cost } : {}),
  };
  if (info?.contextWindow) {
    const health = contextHealth(estimated, info.contextWindow);
    report.window = info.contextWindow;
    report.fraction = health.fraction;
    report.nearLimit = health.nearLimit;
    report.remaining = Math.max(0, info.contextWindow - estimated);
  }
  const d = drift(messages);
  if (d) report.drift = d;
  return report;
}

/** Our estimate against the provider's own count, measured at the last turn that reported one.
 *  The comparison point matters: a turn's usage describes the prompt BEFORE that turn, so the
 *  estimate is taken over everything up to it, exclusive. Returns undefined when no turn reported
 *  a prompt (a fresh session, or a provider that sends no usage). */
export function drift(messages: readonly Message[]): ContextDrift | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const u = messages[i]?.usage;
    if (!u) continue;
    const reported = u.input + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
    if (reported <= 0) continue;
    const before = messages.slice(0, i);
    const estimated = before.length === 0 ? 0 : tokensOf(before.map((m) => partsTokenText(m.parts)).join("\n"));
    const delta = reported - estimated;
    const fraction = reported > 0 ? Math.abs(delta) / reported : 0;
    return { estimated, reported, delta, fraction, beyondTolerance: fraction > DRIFT_TOLERANCE };
  }
  return undefined;
}
