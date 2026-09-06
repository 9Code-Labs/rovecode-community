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
import { contextHealth, costUsdTiered, countTokens, countTokensIfLoaded } from "../core/usage.ts";
import { estimateTokens } from "../core/context.ts";
import { tokenScaleFor } from "../core/token-scale.ts";
import type { Message } from "../core/types.ts";

export interface UsageSummary {
  inTok: number; outTok: number; cacheRead: number; cacheWrite: number;
  /** USD over the priced messages; `priced`/`unpriced`/`noOrigin` say how much of the transcript it covers */
  cost: number; priced: number; unpriced: number; noOrigin: number;
  /** estimated prompt tokens, corrected towards the current model's own tokenizer, and the catalog's
   *  window when it knows one. `estRaw` is the uncorrected count the correction was applied to, and
   *  `counter` says which estimator produced it — both are estimates, with different measured errors
   *  (core/token-scale.ts): "o200k" is countTokens (exact for OpenAI models), "chars" is estimateTokens
   *  (chars/4, what compaction budgets with). The scale applied is the one measured for that counter. */
  est: number; estRaw: number; counter: "o200k" | "chars"; scale: { scale: number; measured: boolean; note: string }; window?: number;
}

export interface SummarizeOptions {
  /** "exact": count with o200k, loading its table if it is not resident (385–520 ms and ~136 MB the
   *  first time — fine for /cost, which a person asked for). "cheap": o200k only if the table is already
   *  resident, else chars/4 — for the sextant usage panel, which is computed at boot and after every
   *  turn and must never be the reason the table loads. Default "exact". */
  counter?: "exact" | "cheap";
}

export function summarizeUsage(messages: Message[], catalog: ModelCatalog, current: { provider: string; model: string }, opts: SummarizeOptions = {}): UsageSummary {
  const u: UsageSummary = { inTok: 0, outTok: 0, cacheRead: 0, cacheWrite: 0, cost: 0, priced: 0, unpriced: 0, noOrigin: 0, est: 0, estRaw: 0, counter: "o200k", scale: { scale: 1, measured: false, note: "" } };
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
  const text = messages.map((m) => partsTokenText(m.parts)).join("\n");
  const exact = opts.counter === "cheap" ? countTokensIfLoaded(text) : countTokens(text);
  // Neither counter is this model's tokenizer (o200k is OpenAI's; chars/4 is nobody's). `rovecode context`
  // has corrected for that since the factors were measured; this panel had not, so the live meter a user
  // actually watches read up to 1.8x low on Claude 5 — the worst place for it, because this is the number
  // you look at to decide whether there is room for another turn. Each counter gets ITS OWN measured
  // factor: the chars/4 error is not the o200k error (token-scale.ts charScale).
  const ts = tokenScaleFor(current);
  if (exact !== null) {
    u.counter = "o200k"; u.estRaw = exact;
    u.scale = { scale: ts.scale, measured: ts.measured, note: ts.note };
  } else {
    u.counter = "chars"; u.estRaw = estimateTokens(text);
    u.scale = { scale: ts.charScale, measured: ts.measured, note: ts.note };
  }
  u.est = Math.ceil(u.estRaw * u.scale.scale);
  return u;
}

/** the sextant usage panel's numbers: cost = the priced lower bound (null until something is priced), context = the
 *  estimate. Runs at boot and after every turn, so it is the "cheap" counter: the panel's "estimated context fill"
 *  is chars/4 × the model's measured char factor until someone loads the o200k table (/cost, /context), and the
 *  o200k figure from then on. Both are estimates; neither is ever presented as the provider's count — that is
 *  drift() in core/context-report.ts, which counts exactly and compares against what the provider reported. */
export function sessionUsage(messages: Message[], catalog: ModelCatalog, current: { provider: string; model: string }): { costUsd: number | null; contextTokens: number; counter: "o200k" | "chars" } {
  const u = summarizeUsage(messages, catalog, current, { counter: "cheap" });
  return { costUsd: u.priced > 0 ? u.cost : null, contextTokens: u.est, counter: u.counter };
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
    ...(u.scale.scale !== 1 ? [`  ${u.counter === "o200k" ? "o200k counted" : "chars/4 estimated"} ${u.estRaw}, scaled ${u.scale.scale}× for ${current.model}`] : []),
    costLine,
  ].join("\n");
}
