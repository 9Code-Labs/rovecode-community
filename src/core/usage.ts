/** Token & cost accounting: o200k token counting, provider usage normalization, USD costing,
 *  and context-window health.
 *
 *  Normalization convention (the part that makes cost math coherent across providers):
 *  `input` = tokens billed at the BASE input rate — i.e. excluding cache reads and cache writes.
 *  - Anthropic `/messages` usage already follows this convention: `input_tokens` excludes both
 *    `cache_read_input_tokens` (billed ~0.1x input) and `cache_creation_input_tokens` (~1.25x).
 *  - OpenAI `/chat/completions` does NOT: `prompt_tokens` INCLUDES
 *    `prompt_tokens_details.cached_tokens`, so we subtract the cached share (clamped at 0) or the
 *    cached tokens would be double-billed (once at the input rate, once at the cache-read rate).
 *
 *  tokenlens (v1.3.1) is used where it fits: `breakdownTokens` from tokenlens/helpers already
 *  recognizes both providers' field spellings (prompt_tokens/completion_tokens/
 *  prompt_tokens_details.cached_tokens as well as input_tokens/output_tokens/
 *  cache_read_input_tokens/cache_creation_input_tokens) and tolerates junk input. What it does
 *  NOT do is reconcile the OpenAI inclusive-input asymmetry above — that part is hand-mapped here.
 */

import { countTokens as o200kCountTokens } from "gpt-tokenizer/encoding/o200k_base";
import { breakdownTokens } from "tokenlens/helpers";

// ---------- pricing ----------

export interface PricingRow {
  inputPerMTok?: number;
  outputPerMTok?: number;
  cacheReadPerMTok?: number;
  cacheWritePerMTok?: number;
}

export interface NormalizedUsage {
  /** tokens billed at the base input rate (cache reads/writes excluded) */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

// ---------- token counting ----------

/** Synchronous token count using gpt-tokenizer's o200k_base encoding.
 *  An ESTIMATE for non-OpenAI models (Anthropic's tokenizer is not public); good enough for
 *  context-budget arithmetic, not for billing reconciliation — use provider usage for that. */
export function countTokens(text: string): number {
  return o200kCountTokens(text);
}

// ---------- usage normalization ----------

/** Non-negative finite number, else 0. Keeps NaN/negatives out of cost arithmetic. */
function nz(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

function isRec(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Normalize a raw provider usage payload (OpenAI or Anthropic wire shape) to a single
 *  cost-coherent structure. Unrecognized/malformed input normalizes to all zeros. */
export function normalizeUsage(raw: unknown): NormalizedUsage {
  const b = breakdownTokens(raw as Parameters<typeof breakdownTokens>[0]);
  const cacheRead = nz(b.cacheReads);
  const cacheWrite = nz(b.cacheWrites);
  let input = nz(b.input);
  // OpenAI-style shape: prompt_tokens present, input_tokens absent → prompt_tokens includes the
  // cached share; subtract it (clamped) so `input` means "billed at the base rate" everywhere.
  const openAiStyle = isRec(raw)
    && typeof raw["prompt_tokens"] === "number"
    && typeof raw["input_tokens"] !== "number";
  if (openAiStyle) input = Math.max(0, input - cacheRead);
  return { input, output: nz(b.output), cacheRead, cacheWrite };
}

// ---------- cost ----------

/** USD cost of a normalized usage under a pricing row (rates are $ per 1M tokens).
 *  Returns undefined when a rate needed for a NONZERO component is missing — an honest "unknown"
 *  beats silently under-billing (e.g. pricing cache reads at 0) or over-billing (at the full
 *  input rate). Zero components never require a rate; an all-zero usage costs 0. */
export function costUsd(u: NormalizedUsage, p: PricingRow): number | undefined {
  const parts: readonly (readonly [number, number | undefined])[] = [
    [u.input, p.inputPerMTok],
    [u.output, p.outputPerMTok],
    [u.cacheRead, p.cacheReadPerMTok],
    [u.cacheWrite, p.cacheWritePerMTok],
  ];
  let total = 0;
  for (const [count, rate] of parts) {
    const c = nz(count);
    if (c === 0) continue;
    if (typeof rate !== "number" || !Number.isFinite(rate)) return undefined;
    total += (c / 1_000_000) * rate;
  }
  return total;
}

// ---------- context health ----------

export const NEAR_LIMIT_FRACTION = 0.8;

/** Fraction of the context window consumed. `nearLimit` trips at ≥ 0.8 — the compaction signal.
 *  The fraction is deliberately NOT clamped above 1 (callers may want the overflow magnitude);
 *  negative/NaN usedTokens counts as 0. A degenerate window (≤ 0 or non-finite) reports full
 *  (fraction 1, nearLimit true): compacting on broken config beats silently overflowing. */
export function contextHealth(usedTokens: number, contextWindow: number): { fraction: number; nearLimit: boolean } {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return { fraction: 1, nearLimit: true };
  const fraction = nz(usedTokens) / contextWindow;
  return { fraction, nearLimit: fraction >= NEAR_LIMIT_FRACTION };
}
