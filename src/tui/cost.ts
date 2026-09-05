/** /cost note body (ports #5+#6), extracted from app.ts for the ADR-002 line cap.
 *  Usage is priced PER MESSAGE at the model recorded in Message.origin —
 *  a session that switched models mid-way is not silently re-priced at the current model.
 *  Messages without an origin fall back to the current model WITH an explicit caveat; messages
 *  whose model has no catalog pricing are excluded and flagged (cost becomes a lower bound).
 *  Context health counts ALL parts (partsTokenText): tool calls/results dominate agentic
 *  sessions, and a text-only count reads ~0% forever.
 *  Port #44: the same math feeds the sextant usage panel through sessionUsage(). */

import { partsTokenText } from "../core/loop.ts";
import { ModelCatalog, ratesFor } from "../providers/catalog.ts";
import { contextHealth, costUsdTiered, countTokens } from "../core/usage.ts";
import { tokenScaleFor } from "../core/token-scale.ts";
import type { Message } from "../core/types.ts";

export interface UsageSummary {
  inTok: number; outTok: number; cacheRead: number; cacheWrite: number;
  /** USD over the priced messages; `priced`/`unpriced`/`noOrigin` say how much of the transcript it covers */
  cost: number; priced: number; unpriced: number; noOrigin: number;
  /** estimated prompt tokens, corrected towards the current model's own tokenizer, and the catalog's
   *  window when it knows one. `estRaw` is the uncorrected o200k count the correction was applied to. */
  est: number; estRaw: number; scale: { scale: number; measured: boolean; note: string }; window?: number;
}

export function summarizeUsage(messages: Message[], catalog: ModelCatalog, current: { provider: string; model: string }): UsageSummary {
  const u: UsageSummary = { inTok: 0, outTok: 0, cacheRead: 0, cacheWrite: 0, cost: 0, priced: 0, unpriced: 0, noOrigin: 0, est: 0, estRaw: 0, scale: { scale: 1, measured: false, note: "" } };
  for (const m of messages) {
    const usage = m.usage;
    if (!usage) continue;
    u.inTok += usage.input; u.outTok += usage.output;
    u.cacheRead += usage.cacheRead ?? 0; u.cacheWrite += usage.cacheWrite ?? 0;
    if (usage.input === 0 && usage.output === 0 && !usage.cacheRead && !usage.cacheWrite) continue; // nothing to price
    if (!m.origin) u.noOrigin += 1;
    const origin = m.origin ?? current;
    const info = catalog.lookup(origin.provider, origin.model);
    const n = { input: usage.input, output: usage.output, cacheRead: usage.cacheRead ?? 0, cacheWrite: usage.cacheWrite ?? 0 };
    // the prompt this turn actually carried decides the rate on a tiered model: xAI and Google bill a
    // prompt over 200k at the upper rate — xAI for the whole request. A flat model's breakdown is trivial.
    const c = info?.pricing
      ? costUsdTiered(n, ratesFor(info, n.input + n.cacheRead + n.cacheWrite))
      : undefined;
    if (c === undefined) u.unpriced += 1;
    else { u.cost += c; u.priced += 1; }
  }
  const window = catalog.lookup(current.provider, current.model)?.contextWindow;
  if (window) u.window = window;
  const raw = countTokens(messages.map((m) => partsTokenText(m.parts)).join("\n"));
  // o200k is not this model's tokenizer. `rovecode context` has corrected for that since the factors
  // were measured; this panel had not, so the live meter a user actually watches read up to 1.8x low
  // on Claude 5 — the worst place for it, because this is the number you look at to decide whether
  // there is room for another turn.
  u.estRaw = raw;
  u.scale = tokenScaleFor(current);
  u.est = Math.ceil(raw * u.scale.scale);
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
    // a corrected number that does not say it was corrected is indistinguishable from a wrong one
    ...(u.scale.scale !== 1 ? [`  o200k counted ${u.estRaw}, scaled ${u.scale.scale}× for ${current.model}`] : []),
    costLine,
  ].join("\n");
}
