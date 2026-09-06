/** How wrong our token estimate is for a given model, measured rather than assumed.
 *
 *  rovecode budgets with two estimators and neither is the tokenizer that decides: `estimateTokens`
 *  (chars/4) drives compaction, `countTokens` (o200k, OpenAI's tokenizer) drives the reports. For an
 *  OpenAI model o200k is the truth by construction. For everyone else it is a stand-in, and the size of
 *  the error is not a detail — compaction fires on the estimate, so an estimate that reads low compacts
 *  too late and the provider rejects the request that follows.
 *
 *  The numbers below were measured with `bun scripts/measure-tokenizer.ts`, which sends real samples to
 *  Anthropic's own `/v1/messages/count_tokens` and divides. Rerun it to check them; that is the point of
 *  keeping the script. Measured 2026-09-05 over twenty samples — the system prompt, the tool schemas, a
 *  TypeScript file, English prose, Turkish prose, a JSON tool result, and fourteen market documentation
 *  bodies:
 *
 *      claude-opus-5, claude-sonnet-5     chars/4 1.33–1.81×   o200k 1.43–1.79×
 *      claude-haiku-4-5                   chars/4 1.00–1.46×   o200k 1.08–1.29×
 *
 *  The market documents were added after nimbus-24, independently measuring 19 skill bodies, found
 *  ratios above the ceiling the first six samples produced. They were right, and the reason matters:
 *  markdown documentation — headings, bullets, fenced code and tables in one file — tokenizes worse
 *  than either prose or code alone, and it is precisely what lands in a window when a model opens a
 *  skill. Their worst case (mcp-builder, 1.792) reproduces here at 1.791. A sample set that omits the
 *  commonest content is not conservative; it is wrong in the expensive direction.
 *
 *  Two things that table settles. The Claude 5 models share one tokenizer — Opus 5 and Sonnet 5 returned
 *  identical counts on every sample — so the factor belongs to a generation, not to a model name.
 *  And 4.5 is a different, older one: applying the 5-generation figure to Haiku would over-correct by two
 *  fifths, which wastes window rather than overflowing it, but is still a wrong number.
 *
 *  Each factor is the **maximum** ratio across the samples, not the mean. The two errors are not
 *  symmetric: a budget that reads high merely leaves some window unused, while one that reads low sends
 *  a request the provider refuses and loses the turn. Rounded up to two decimals, and rounded up rather
 *  than to nearest, for the same reason.
 *
 *  A model nobody has measured gets 1 and says so. A guessed multiplier is worse than none: it moves the
 *  budget by an amount whose provenance no one can explain, and hides the fact that the number is unknown. */

export interface TokenScale {
  /** multiply an o200k estimate (`countTokens`) by this to approximate what the provider will count;
   *  1 when unmeasured */
  scale: number;
  /** the same for the OTHER estimator, `estimateTokens` (chars/4), which is what compaction and context
   *  assembly measure with. It is a different approximation with a different error, so it needs its own
   *  number: on Claude 4.5 the o200k figure is 1.29x while chars/4 needs 1.46x, and using the first to
   *  size a budget the second is compared against under-corrects by an eighth — which is the direction
   *  that overflows the window. Measured in the same run, from the same samples. */
  charScale: number;
  /** true when the number came from a measurement rather than from the default */
  measured: boolean;
  /** one line for the reader: where the number is from, or that there is none */
  note: string;
}

const UNMEASURED: TokenScale = {
  scale: 1,
  charScale: 1,
  measured: false,
  note: "no measurement for this model — the estimate is used as-is; bun scripts/measure-tokenizer.ts measures it",
};

/** o200k is OpenAI's own tokenizer, so `scale` is exactly 1 — but chars/4 is nobody's tokenizer, and
 *  the budget is compared against chars/4. Left at 1 because it has not been measured against an
 *  OpenAI model, and an unmeasured number is what this file refuses to invent. */
const EXACT: TokenScale = {
  scale: 1,
  charScale: 1,
  measured: true,
  note: "o200k is this vendor's own tokenizer — the estimate is exact",
};

interface Row { provider: string; match: RegExp; scale: number; charScale: number; note: string }

const MEASURED: Row[] = [
  {
    provider: "anthropic",
    // the 5 generation: opus-5, sonnet-5, fable-5.x, and the dated snapshots of each
    match: /(opus-5|sonnet-5|fable-5|mythos-5)/,
    scale: 1.80,
    charScale: 1.82,
    note: "measured 2026-09-05 against /v1/messages/count_tokens over 20 samples — o200k reads up to 1.79× low on Claude 5",
  },
  {
    provider: "anthropic",
    match: /(haiku-4-5|opus-4-5|sonnet-4-6)/,
    scale: 1.29,
    charScale: 1.46,
    note: "measured 2026-09-05 against /v1/messages/count_tokens over 20 samples — o200k reads up to 1.29× low on Claude 4.5/4.6",
  },
];

/** OpenAI's own models are counted with OpenAI's own tokenizer; there is nothing to correct. */
const EXACT_PROVIDERS = new Set(["openai"]);

/** The scale for a model, by provider and model id. Unknown models get 1 with a note saying so —
 *  never a factor borrowed from a neighbouring model, which would be a guess dressed as a measurement. */
export function tokenScaleFor(ref: { provider: string; model: string }): TokenScale {
  const provider = ref.provider.toLowerCase();
  const model = ref.model.toLowerCase();
  if (EXACT_PROVIDERS.has(provider)) return EXACT;
  const row = MEASURED.find((r) => r.provider === provider && r.match.test(model));
  return row ? { scale: row.scale, charScale: row.charScale, measured: true, note: row.note } : UNMEASURED;
}

/** An estimate corrected towards what the provider will count. Rounds up: a token of slack costs
 *  nothing, a token of shortfall is a rejected request. */
export function scaleEstimate(tokens: number, ref: { provider: string; model: string }): number {
  return Math.ceil(tokens * tokenScaleFor(ref).scale);
}
