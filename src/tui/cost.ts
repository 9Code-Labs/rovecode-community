/** /cost note body (ports #5+#6), extracted from app.ts for the ADR-002 line cap.
 *  Usage is priced PER MESSAGE at the model recorded in Message.origin —
 *  a session that switched models mid-way is not silently re-priced at the current model.
 *  Messages without an origin fall back to the current model WITH an explicit caveat; messages
 *  whose model has no catalog pricing are excluded and flagged (cost becomes a lower bound).
 *  Context health counts ALL parts (partsTokenText): tool calls/results dominate agentic
 *  sessions, and a text-only count reads ~0% forever.
 *  Port #44: the same math feeds the sextant usage panel through sessionUsage(). */

import { partsTokenText } from "../core/loop.ts";
import { ModelCatalog } from "../providers/catalog.ts";
import { costUsd, contextHealth, countTokens } from "../core/usage.ts";
import type { Message } from "../core/types.ts";

export interface UsageSummary {
  inTok: number; outTok: number; cacheRead: number; cacheWrite: number;
  /** USD over the priced messages; `priced`/`unpriced`/`noOrigin` say how much of the transcript it covers */
  cost: number; priced: number; unpriced: number; noOrigin: number;
  /** estimated prompt tokens (o200k over every part) and the current model's window when the catalog knows it */
  est: number; window?: number;
}

export function summarizeUsage(messages: Message[], catalog: ModelCatalog, current: { provider: string; model: string }): UsageSummary {
  const u: UsageSummary = { inTok: 0, outTok: 0, cacheRead: 0, cacheWrite: 0, cost: 0, priced: 0, unpriced: 0, noOrigin: 0, est: 0 };
  for (const m of messages) {
    const usage = m.usage;
    if (!usage) continue;
    u.inTok += usage.input; u.outTok += usage.output;
    u.cacheRead += usage.cacheRead ?? 0; u.cacheWrite += usage.cacheWrite ?? 0;
    if (usage.input === 0 && usage.output === 0 && !usage.cacheRead && !usage.cacheWrite) continue; // nothing to price
    if (!m.origin) u.noOrigin += 1;
    const origin = m.origin ?? current;
    const info = catalog.lookup(origin.provider, origin.model);
    const c = info?.pricing
      ? costUsd({ input: usage.input, output: usage.output, cacheRead: usage.cacheRead ?? 0, cacheWrite: usage.cacheWrite ?? 0 }, info.pricing)
      : undefined;
    if (c === undefined) u.unpriced += 1;
    else { u.cost += c; u.priced += 1; }
  }
  const window = catalog.lookup(current.provider, current.model)?.contextWindow;
  if (window) u.window = window;
  u.est = countTokens(messages.map((m) => partsTokenText(m.parts)).join("\n"));
  return u;
}

/** the sextant usage panel's numbers: cost = the priced lower bound (null until something is priced), context = the estimate */
export function sessionUsage(messages: Message[], catalog: ModelCatalog, current: { provider: string; model: string }): { costUsd: number | null; contextTokens: number } {
  const u = summarizeUsage(messages, catalog, current);
  return { costUsd: u.priced > 0 ? u.cost : null, contextTokens: u.est };
}

export function buildCostNote(messages: Message[], catalog: ModelCatalog, current: { provider: string; model: string }): string {
  const u = summarizeUsage(messages, catalog, current);
  const health = u.window ? contextHealth(u.est, u.window) : undefined;
  let costLine: string;
  if (u.priced === 0 && u.unpriced > 0) {
    costLine = `pricing unknown for ${current.provider}/${current.model}`;
  } else {
    costLine = `estimated cost: $${u.cost.toFixed(4)}`;
    if (u.unpriced > 0) costLine += ` — ${u.unpriced} message${u.unpriced > 1 ? "s" : ""} unpriced (lower bound)`;
    if (u.noOrigin > 0) costLine += ` — ${u.noOrigin} without origin priced at the current model`;
  }
  return [
    `tokens: ${u.inTok} in / ${u.outTok} out · cache: ${u.cacheRead} read / ${u.cacheWrite} written`,
    health
      ? `context: ~${u.est} of ${u.window} (${Math.round(health.fraction * 100)}%${health.nearLimit ? " — near limit" : ""})`
      : `context: ~${u.est} tokens (window unknown)`,
    costLine,
  ].join("\n");
}
