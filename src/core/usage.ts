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
 *    The cached-inclusive convention is detected by the PRESENCE of `prompt_tokens`, or of a
 *    *_details cached count when no Anthropic `cache_read_input_tokens` coexists — NOT by the
 *    absence of `input_tokens` (gateways like OpenRouter emit BOTH spellings in one payload, and
 *    keying on absence would skip the subtraction there and double-bill the cached share), and
 *    NOT by a bare *_details block (a payload that also carries `cache_read_input_tokens` has a
 *    cache-EXCLUSIVE base; subtracting again would double-subtract and clamp input to 0).
 *
 *  tokenlens (v1.3.1) is used where it fits: `breakdownTokens` from tokenlens/helpers already
 *  recognizes both providers' field spellings (prompt_tokens/completion_tokens/
 *  prompt_tokens_details.cached_tokens as well as input_tokens/output_tokens/
 *  cache_read_input_tokens/cache_creation_input_tokens) and tolerates junk input. What it does
 *  NOT do is reconcile the OpenAI inclusive-input asymmetry above — that part is hand-mapped here.
 */

import type { countTokens as CountTokensFn } from "gpt-tokenizer/encoding/o200k_base";
import { breakdownTokens } from "tokenlens/helpers";

// lazy loader — the o200k rank table is deferred until the first countTokens() call that needs it.
// Measured (scripts/probe-import.ts, 2026-09-06): loading it takes 385–520 ms and adds ~136 MB of
// resident memory, and 3.8 MB of the 8 MB CLI bundle is this table. So nothing on a session's boot
// path may call countTokens(): the sextant usage panel goes through countTokensIfLoaded() and the
// chars-based estimator instead (tui/cost.ts), and the table loads when a person asks for the exact
// figure — /cost, /context, `rovecode context`.
type GptTokenizerMod = { countTokens: typeof CountTokensFn };
let _gptMod: GptTokenizerMod | null = null;
function lazyTokenizer(): GptTokenizerMod {
  if (_gptMod === null) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    _gptMod = require("gpt-tokenizer/encoding/o200k_base") as GptTokenizerMod;
  }
  return _gptMod;
}
/** the o200k table is resident (some caller already paid for it) */
export function tokenizerLoaded(): boolean { return _gptMod !== null; }

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
  if (text.length === 0) return 0; // a fresh session's empty transcript must not load a 136 MB table to learn it is empty
  return lazyTokenizer().countTokens(text);
}

/** The exact o200k count when the table is already resident, else null — never loads it. For callers
 *  that run on a session's boot path or on every repaint and have a cheaper estimator to fall back on. */
export function countTokensIfLoaded(text: string): number | null {
  if (text.length === 0) return 0;
  return _gptMod === null ? null : _gptMod.countTokens(text);
}

// ---------- usage normalization ----------

/** Non-negative finite number, else 0. Keeps NaN/negatives out of cost arithmetic. */
function nz(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

function isRec(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** cached_tokens read straight from prompt_tokens_details/input_tokens_details — tokenlens
 *  recognizes the former but not the Responses-API latter, so this is the fallback source. */
function detailsCachedTokens(raw: unknown): number {
  if (!isRec(raw)) return 0;
  for (const k of ["prompt_tokens_details", "input_tokens_details"]) {
    const d = raw[k];
    if (isRec(d)) return nz(d["cached_tokens"]);
  }
  return 0;
}

/** Normalize a raw provider usage payload (OpenAI or Anthropic wire shape) to a single
 *  cost-coherent structure. Unrecognized/malformed input normalizes to all zeros. */
export function normalizeUsage(raw: unknown): NormalizedUsage {
  const b = breakdownTokens(raw as Parameters<typeof breakdownTokens>[0]);
  const cacheRead = nz(b.cacheReads) || detailsCachedTokens(raw);
  const cacheWrite = nz(b.cacheWrites);
  let input = nz(b.input);
  // OpenAI-style cache-INCLUSIVE base, i.e. the reported input still contains the cached share
  // and it must be subtracted (clamped) so `input` means "billed at the base rate". Detected by
  // PRESENCE of prompt_tokens — never by absence of input_tokens, which OpenRouter emits
  // alongside prompt_tokens — or by a *_details cached count with NO cache_read_input_tokens
  // beside it: that Anthropic spelling marks the base as already cache-EXCLUSIVE, so a payload
  // carrying both (gateway mirroring the cached share into a details block) must not be
  // subtracted a second time — that would clamp input to 0 and under-report /cost.
  const cachedInclusive = isRec(raw) && (
    typeof raw["prompt_tokens"] === "number"
    || (detailsCachedTokens(raw) > 0 && raw["cache_read_input_tokens"] === undefined)
  );
  if (cachedInclusive) input = Math.max(0, input - cacheRead);
  return { input, output: nz(b.output), cacheRead, cacheWrite };
}

// ---------- cost ----------

/** USD cost of a normalized usage under a pricing row (rates are $ per 1M tokens).
 *  Returns undefined when a rate needed for a NONZERO component is missing — an honest "unknown"
 *  beats silently under-billing (e.g. pricing cache reads at 0) or over-billing (at the full
 *  input rate). Zero components never require a rate; an all-zero usage costs 0. */
/** A prompt-size-dependent rate table, structurally what providers/catalog.ts `ratesFor()` returns.
 *  Declared here rather than imported so this module stays free of the catalog (and of its snapshot):
 *  a caller that knows the model builds the breakdown, this one only multiplies. */
export interface TieredRates {
  /** prompt tokens billed at `base` */
  promptBase: number;
  /** prompt tokens billed at `above` */
  promptAbove: number;
  base: PricingRow;
  above?: PricingRow;
  /** the rates for everything that is not the prompt on this request — both vendors that tier also
   *  select the OUTPUT price by prompt size */
  request: PricingRow;
}

/** USD for one turn under a tiered rate table. The prompt's three components (base input, cache reads,
 *  cache writes) are split in the same proportion as `promptBase`/`promptAbove`, which is exact for the
 *  two shapes that exist today — flat (everything base) and per-request (everything above) — and a
 *  documented approximation for a marginal tier, where no shipping provider states how a partly cached
 *  prompt divides across the threshold. Same honesty rule as costUsd: a missing rate for a nonzero
 *  component returns undefined rather than a wrong number. */
export function costUsdTiered(u: NormalizedUsage, r: TieredRates): number | undefined {
  const promptTotal = r.promptBase + r.promptAbove;
  const aboveShare = promptTotal > 0 ? r.promptAbove / promptTotal : 0;
  const above = r.above ?? r.base;
  const split = (count: number): readonly (readonly [number, PricingRow])[] =>
    aboveShare <= 0 ? [[count, r.base]]
    : aboveShare >= 1 ? [[count, above]]
    : [[count * (1 - aboveShare), r.base], [count * aboveShare, above]];

  let total = 0;
  for (const [count, row] of [
    ...split(u.input).map(([c, p]) => [c, p.inputPerMTok] as const),
    ...split(u.cacheRead).map(([c, p]) => [c, p.cacheReadPerMTok] as const),
    ...split(u.cacheWrite).map(([c, p]) => [c, p.cacheWritePerMTok] as const),
    [u.output, r.request.outputPerMTok] as const,
  ]) {
    const c = nz(count);
    if (c === 0) continue;
    if (typeof row !== "number" || !Number.isFinite(row)) return undefined;
    total += (c / 1_000_000) * row;
  }
  return total;
}

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
