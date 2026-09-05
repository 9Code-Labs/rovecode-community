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
 *  keeping the script. Measured 2026-09-05 over six samples — the system prompt, the tool schemas, a
 *  TypeScript file, English prose, Turkish prose and a JSON tool result:
 *
 *      claude-opus-5, claude-sonnet-5     chars/4 1.33–1.81×   o200k 1.43–1.58×
 *      claude-haiku-4-5                   chars/4 1.01–1.46×   o200k 1.08–1.21×
 *
 *  Two things that table settles. The Claude 5 models share one tokenizer — Opus 5 and Sonnet 5 returned
 *  identical counts on all six samples — so the factor belongs to a generation, not to a model name.
 *  And 4.5 is a different, older one: applying the 5-generation figure to Haiku would over-correct by a
 *  third, which wastes window rather than overflowing it, but is still a wrong number.
 *
 *  Each factor is the **maximum** ratio across the samples, not the mean. The two errors are not
 *  symmetric: a budget that reads high merely leaves some window unused, while one that reads low sends
 *  a request the provider refuses and loses the turn. Rounded up to two decimals, and rounded up rather
 *  than to nearest, for the same reason.
 *
 *  A model nobody has measured gets 1 and says so. A guessed multiplier is worse than none: it moves the
 *  budget by an amount whose provenance no one can explain, and hides the fact that the number is unknown. */

export interface TokenScale {
  /** multiply an estimate by this to approximate what the provider will count; 1 when unmeasured */
  scale: number;
  /** true when the number came from a measurement rather than from the default */
  measured: boolean;
  /** one line for the reader: where the number is from, or that there is none */
  note: string;
}

const UNMEASURED: TokenScale = {
  scale: 1,
  measured: false,
  note: "no measurement for this model — the estimate is used as-is; bun scripts/measure-tokenizer.ts measures it",
};

const EXACT: TokenScale = {
  scale: 1,
  measured: true,
  note: "o200k is this vendor's own tokenizer — the estimate is exact",
};

interface Row { provider: string; match: RegExp; scale: number; note: string }

const MEASURED: Row[] = [
  {
    provider: "anthropic",
    // the 5 generation: opus-5, sonnet-5, fable-5.x, and the dated snapshots of each
    match: /(opus-5|sonnet-5|fable-5|mythos-5)/,
    scale: 1.59,
    note: "measured 2026-09-05 against /v1/messages/count_tokens — o200k reads up to 1.58× low on Claude 5",
  },
  {
    provider: "anthropic",
    match: /(haiku-4-5|opus-4-5|sonnet-4-6)/,
    scale: 1.21,
    note: "measured 2026-09-05 against /v1/messages/count_tokens — o200k reads up to 1.21× low on Claude 4.5/4.6",
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
  return row ? { scale: row.scale, measured: true, note: row.note } : UNMEASURED;
}

/** An estimate corrected towards what the provider will count. Rounds up: a token of slack costs
 *  nothing, a token of shortfall is a rejected request. */
export function scaleEstimate(tokens: number, ref: { provider: string; model: string }): number {
  return Math.ceil(tokens * tokenScaleFor(ref).scale);
}
