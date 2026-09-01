/** /cost note body (ports #5+#6), extracted from app.ts for the ADR-002 line cap.
 *  Usage is priced PER MESSAGE at the model recorded in Message.origin —
 *  a session that switched models mid-way is not silently re-priced at the current model.
 *  Messages without an origin fall back to the current model WITH an explicit caveat; messages
 *  whose model has no catalog pricing are excluded and flagged (cost becomes a lower bound).
 *  Context health counts ALL parts (partsTokenText): tool calls/results dominate agentic
 *  sessions, and a text-only count reads ~0% forever. */

import { partsTokenText } from "../core/loop.ts";
import { ModelCatalog } from "../providers/catalog.ts";
import { costUsd, contextHealth, countTokens } from "../core/usage.ts";
import type { Message } from "../core/types.ts";

export function buildCostNote(messages: Message[], catalog: ModelCatalog, current: { provider: string; model: string }): string {
  let inTok = 0, outTok = 0, cacheRead = 0, cacheWrite = 0;
  let cost = 0, priced = 0, unpriced = 0, noOrigin = 0;
  for (const m of messages) {
    const u = m.usage;
    if (!u) continue;
    inTok += u.input; outTok += u.output;
    cacheRead += u.cacheRead ?? 0; cacheWrite += u.cacheWrite ?? 0;
    if (u.input === 0 && u.output === 0 && !u.cacheRead && !u.cacheWrite) continue; // nothing to price
    if (!m.origin) noOrigin += 1;
    const origin = m.origin ?? current;
    const info = catalog.lookup(origin.provider, origin.model);
    const c = info?.pricing
      ? costUsd({ input: u.input, output: u.output, cacheRead: u.cacheRead ?? 0, cacheWrite: u.cacheWrite ?? 0 }, info.pricing)
      : undefined;
    if (c === undefined) unpriced += 1;
    else { cost += c; priced += 1; }
  }
  const info = catalog.lookup(current.provider, current.model);
  const est = countTokens(messages.map((m) => partsTokenText(m.parts)).join("\n"));
  const health = info?.contextWindow ? contextHealth(est, info.contextWindow) : undefined;
  let costLine: string;
  if (priced === 0 && unpriced > 0) {
    costLine = `pricing unknown for ${current.provider}/${current.model}`;
  } else {
    costLine = `estimated cost: $${cost.toFixed(4)}`;
    if (unpriced > 0) costLine += ` — ${unpriced} message${unpriced > 1 ? "s" : ""} unpriced (lower bound)`;
    if (noOrigin > 0) costLine += ` — ${noOrigin} without origin priced at the current model`;
  }
  return [
    `tokens: ${inTok} in / ${outTok} out · cache: ${cacheRead} read / ${cacheWrite} written`,
    health
      ? `context: ~${est} of ${info?.contextWindow} (${Math.round(health.fraction * 100)}%${health.nearLimit ? " — near limit" : ""})`
      : `context: ~${est} tokens (window unknown)`,
    costLine,
  ].join("\n");
}
