/** Port #60 model-picker row metadata, adapted from aion's providers/model-list.ts.
 *  Rovecode already lists LIVE provider ids through ProviderRegistry.models; keep that source of truth.
 *  Only format the optional ModelCatalog.lookup metadata here — no second row/table/catalog abstraction. */
import type { ModelInfo } from "./catalog.ts";

/** Context tokens, compact enough for a picker row; unknown metadata stays blank. */
export function fmtContext(n: number | undefined): string {
  if (n === undefined) return "";
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M ctx` : n >= 1000 ? `${Math.round(n / 1000)}k ctx` : `${n} ctx`;
}

/** Input/output dollars per million tokens; zero is a known price, a missing side is '?'. */
export function fmtPrice(pricing: ModelInfo["pricing"]): string {
  if (pricing?.inputPerMTok === undefined && pricing?.outputPerMTok === undefined) return "";
  const price = (n: number | undefined): string => n === undefined ? "?" : `$${n}`;
  return `${price(pricing?.inputPerMTok)}/${price(pricing?.outputPerMTok)}`;
}

/** The aion row wording, over rovecode's real ModelInfo shape. */
export function describeModel(info: ModelInfo | undefined): string {
  if (info === undefined) return "";
  return [fmtContext(info.contextWindow), fmtPrice(info.pricing), info.supportsReasoning ? "reasoning" : "", info.supportsTools === false ? "no tools" : ""].filter(Boolean).join(" · ");
}
