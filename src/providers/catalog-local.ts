/** rovecode's own price table for models the models.dev snapshot does not carry — the API ALIASES a
 *  vendor sells under (DeepSeek's `deepseek-chat` / `deepseek-reasoner` are aliases of a release; the
 *  snapshot lists release ids), and xAI's retired grok-4 slugs, which still resolve but are served and
 *  billed as grok-4.3. Without these a real run on those ids is "unpriced" in /cost and `rovecode model show`.
 *
 *  Rules: an entry here applies ONLY when neither the live models.dev layer nor the snapshot has the model
 *  (catalog.ts findIn) — a later snapshot entry wins by construction. Every entry names the vendor page the
 *  numbers were read from and the day; "fetched" means the page was read on that day, "unverified" means the
 *  page no longer documents the id and the row is the last known value. `rovecode model show` prints
 *  "priced from rovecode's own table" so nobody mistakes them for models.dev's. Prices are USD per million
 *  tokens. Output limits are given only where the vendor publishes one (the runtime caps at MAX_OUTPUT_CAP). */

export interface LocalModel {
  context: number;
  output?: number;
  /** has a reasoning mode (thinking.ts sends the dial only when this is not false) */
  reasoning: boolean;
  toolCall: boolean;
  image?: boolean;
  cost: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
  /** where the numbers were read — the reader's warrant */
  source: string;
  /** when, and how: "YYYY-MM-DD (fetched)" or "YYYY-MM-DD (unverified: …)" */
  checked: string;
  /** Take precedence over a models.dev entry for this model. Off by default and deliberately rare: the
   *  overlay exists to fill gaps, and a snapshot that gains a model should normally win. Set it ONLY when
   *  the vendor's own page was read and disagrees with the snapshot, and say so in `source` — a reader has
   *  to be able to see which number rovecode chose and why. */
  override?: true;
}

/** A vendor whose price CHANGES WITH PROMPT SIZE. models.dev has no field for this, so it lives beside the
 *  overlay and augments a row whatever its source — the snapshot keeps owning the base prices.
 *
 *  `mode` is the part that is easy to get wrong and expensive to get wrong:
 *   - "per-request": crossing the threshold reprices THE WHOLE REQUEST, every token, at the upper rate
 *     (xAI). A 201k-token prompt costs 201k × the high rate, not 200k low + 1k high.
 *   - "marginal": only the tokens past the threshold take the upper rate. NO vendor row uses this today —
 *     it exists because the two shapes are not interchangeable and a cost function must branch on which one
 *     it has, rather than assume. Do not classify a vendor as marginal without wording that says so. */
export interface PriceTier {
  thresholdTokens: number;
  mode: "per-request" | "marginal";
  above: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
  source: string;
  checked: string;
}

/** xAI, docs.x.ai/developers/migration/may-15-retirement (fetched 2026-09-04): grok-4-0709, grok-4-fast-reasoning,
 *  grok-4-fast-non-reasoning, grok-4-1-fast-* and grok-3 were retired on 2026-05-15; the slugs still resolve and
 *  are SERVED BY grok-4.3 — reasoning slugs at low effort, non-reasoning ones at none — and BILLED at grok-4.3
 *  rates ($1.25 in / $2.50 out / $0.20 cached per 1M under 200k context; docs.x.ai/docs/models/grok-4.3, fetched
 *  the same day: 1M context, configurable reasoning none|low|medium|high). So a request to `grok-4` costs this. */
const GROK_43_REDIRECT = { context: 1_000_000, toolCall: true, image: true, cost: { input: 1.25, output: 2.5, cacheRead: 0.2 },
  source: "docs.x.ai May-15-2026 retirement: served by grok-4.3, billed at grok-4.3 rates (under 200k context)", checked: "2026-09-04 (fetched)" } as const;

/** Tiered pricing, by provider and model id. Verified 2026-09-05 against the vendors' own pricing pages.
 *  Nothing here changes a base price — `catalog.ts` attaches the tier to whatever row it resolved, so a
 *  models.dev entry keeps its numbers and gains the threshold it has no field for. */
export const PRICE_TIERS: Readonly<Record<string, Readonly<Record<string, PriceTier>>>> = {
  // xAI: "requests over 200,000 prompt tokens are billed at the higher rate FOR THE ENTIRE REQUEST"
  xai: {
    "grok-4.6": { thresholdTokens: 200_000, mode: "per-request", above: { input: 4, output: 12, cacheRead: 1 },
      source: "docs.x.ai/developers/pricing — over 200k prompt tokens the whole request bills at the high rate", checked: "2026-09-05 (fetched)" },
    "grok-4.3": { thresholdTokens: 200_000, mode: "per-request", above: { input: 2.5, output: 5, cacheRead: 0.4 },
      source: "docs.x.ai/developers/pricing — over 200k prompt tokens the whole request bills at the high rate", checked: "2026-09-05 (fetched)" },
  },
  // OpenAI, developers.openai.com/api/docs/models/gpt-5.4 and /gpt-5.5: "Prompts with >272K input tokens
  // are priced at 2x input and 1.5x output for the full session." The multipliers are ASYMMETRIC — input
  // doubles, output goes up by half — so these are written out rather than derived from one rate.
  // The -pro tiers are NOT given this: their own pages do not carry the sentence, and inventing a
  // threshold for a $30/1M model is the expensive kind of guess.
  openai: {
    "gpt-5.4": { thresholdTokens: 272_000, mode: "per-request", above: { input: 5, output: 22.5, cacheRead: 0.5 },
      source: "developers.openai.com/api/docs/models/gpt-5.4 — >272K input tokens: 2x input, 1.5x output for the full session", checked: "2026-09-05 (fetched)" },
    "gpt-5.5": { thresholdTokens: 272_000, mode: "per-request", above: { input: 10, output: 45, cacheRead: 1 },
      source: "developers.openai.com/api/docs/models/gpt-5.5 — >272K input tokens: 2x input, 1.5x output for the full session", checked: "2026-09-05 (fetched)" },
  },
  // Google prices by PROMPT SIZE, not by overflow: the page's own columns read "prompts <= 200k tokens"
  // and "prompts > 200k tokens" for BOTH input and output, so a 201k prompt bills every token — and that
  // request's output — at the upper rate. Same shape as xAI, which is why neither is "marginal".
  google: {
    "gemini-3.1-pro-preview": { thresholdTokens: 200_000, mode: "per-request", above: { input: 4, output: 18 },
      source: "ai.google.dev/gemini-api/docs/pricing — \"$4.00, prompts > 200k tokens\" / \"$18.00, prompts > 200k\"", checked: "2026-09-05 (fetched)" },
    "gemini-2.5-pro": { thresholdTokens: 200_000, mode: "per-request", above: { input: 2.5, output: 15 },
      source: "ai.google.dev/gemini-api/docs/pricing — \"$2.50, prompts > 200k tokens\" / \"$15.00, prompts > 200k\"", checked: "2026-09-05 (fetched)" },
  },
} as const;

/** A price that is scheduled to change, or a condition the number depends on. Not a tier and not an
 *  override — just the sentence a reader needs so today's number is not mistaken for a permanent one.
 *  Attached to a row whatever its source. */
export const PRICE_NOTES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  google: {
    "gemini-3.8-flash": "promotional pricing through 2026-12-31: ai.google.dev/gemini-api/docs/pricing says it doubles to $1.50 in / $7.50 out starting 2027-01-01 (checked 2026-09-05)",
  },
  mistral: {
    // Checked against mistral.ai/pricing/api on 2026-09-05: the table publishes ONLY `-latest` aliases
    // (mistral-medium-latest $1.5/$7.5, mistral-small-latest $0.15/$0.6, mistral-large-latest $0.5/$1.5).
    // No dated id appears — not the snapshot's `mistral-medium-2604`, and not `mistral-medium-3-5` or
    // `ministral-8b-2512` either. The prices match, the ids are unverifiable, so nothing is renamed here.
    "mistral-medium-latest": "mistral.ai/pricing/api publishes only `-latest` aliases and NO maximum output for any model — the catalog's maxOutput equalling the context window is filler, not a vendor figure (checked 2026-09-05)",
    "mistral-medium-2604": "this dated id is not on mistral.ai/pricing/api, which lists only `-latest` aliases; the price matches mistral-medium-latest but the id itself is unverified (checked 2026-09-05)",
  },
  groq: {
    // Not "unverified" — UNPUBLISHED. Groq's docs table says "Contact Sales" for the Llama models and
    // console.groq.com/pricing is a 404, so any number here came from a third party, not from Groq.
    "llama-3.3-70b-versatile": "Groq does not publish a price for this model — its docs table says \"Contact Sales\" and there is no public pricing page; the catalog's figure is models.dev's, not the vendor's (checked 2026-09-05)",
  },
  anthropic: {
    // true of every Anthropic row; recorded on the one most runs use
    "claude-mythos-5-1": "invite-only access (platform.claude.com/docs/en/models/mythos-5-1/overview); outside the Batches 300k beta, which covers Opus 5/4.8/4.7/4.6 and Sonnet 5/4.6 only (checked 2026-09-05)",
    "claude-fable-5-1": "outside the Batches 300k beta, which covers Opus 5/4.8/4.7/4.6 and Sonnet 5/4.6 only (checked 2026-09-05)",
    "claude-opus-5": "thinking tokens bill as OUTPUT and count inside max_tokens; from Opus 4.5 / Sonnet 4.6 / Fable 5.x earlier thinking blocks are preserved and bill as INPUT on the next turn (platform.claude.com/docs, checked 2026-09-05)",
  },
} as const;

export const LOCAL_MODELS: Readonly<Record<string, Readonly<Record<string, LocalModel>>>> = {
  deepseek: {
    // api-docs.deepseek.com/quick_start/pricing, fetched 2026-09-05. These three rows OVERRIDE models.dev,
    // which carries roughly a third of the vendor's own peak numbers for the same ids (flash 0.14/0.28 vs
    // 0.44/1.32). The page is the seller; the snapshot is a mirror that has drifted, so the page wins here
    // and says so. Peak rates are used: the page's own off-peak wording is self-contradictory (it labels
    // "peak" 01:00-04:00 and 06:00-10:00 UTC, which are its cheap hours elsewhere), so rovecode quotes the
    // HIGHER of the two — an estimate that surprises nobody with a bigger bill. Do not build discount logic
    // on that wording until the page is unambiguous.
    "deepseek-v4-flash": { context: 1_000_000, output: 384_000, reasoning: true, toolCall: true, override: true,
      cost: { input: 0.44, output: 1.32, cacheRead: 0.014 },
      source: "api-docs.deepseek.com/quick_start/pricing (peak rate — off-peak is half, we do not model time-of-day; models.dev carries ~1/3 of these)", checked: "2026-09-05 (fetched)" },
    "deepseek-v4-pro": { context: 1_000_000, output: 384_000, reasoning: true, toolCall: true, override: true,
      cost: { input: 1.32, output: 3.96, cacheRead: 0.044 },
      source: "api-docs.deepseek.com/quick_start/pricing (peak rate — off-peak is half, we do not model time-of-day; models.dev carries ~1/3 of these)", checked: "2026-09-05 (fetched)" },
    "deepseek-v4-flash-vision-exp": { context: 1_000_000, output: 384_000, reasoning: true, toolCall: true, image: true, override: true,
      cost: { input: 0.44, output: 1.32, cacheRead: 0.014 },
      source: "api-docs.deepseek.com/quick_start/pricing (peak rate — off-peak is half, we do not model time-of-day; models.dev carries ~1/3 of these)", checked: "2026-09-05 (fetched)" },
    // The two API aliases. The pricing page lists only the v4-* ids, so nothing here is verified: the
    // numbers are the last ones DeepSeek published for them and are marked as such rather than being
    // quietly refreshed to a v4 price they may not be billed at.
    "deepseek-chat": { context: 128_000, output: 8_000, reasoning: true, toolCall: true, cost: { input: 0.28, output: 0.42, cacheRead: 0.028 }, source: "api-docs.deepseek.com pricing (V3.2 era)", checked: "2026-09-05 (unverified: the alias is not on the pricing page, which lists deepseek-v4-* only)" },
    "deepseek-reasoner": { context: 128_000, output: 64_000, reasoning: true, toolCall: true, cost: { input: 0.28, output: 0.42, cacheRead: 0.028 }, source: "api-docs.deepseek.com pricing (V3.2 era)", checked: "2026-09-05 (unverified: not on the pricing page; DeepSeek now exposes thinking as a MODE of the v4 models, not a separate id)" },
  },
  openai: {
    // developers.openai.com/api/docs/pricing, fetched 2026-09-05. Not in the snapshot at all, so this is a
    // gap fill, not an override.
    "gpt-6-astra": { context: 1_050_000, output: 128_000, reasoning: true, toolCall: true, image: true,
      cost: { input: 10, output: 50, cacheRead: 1 },
      source: "developers.openai.com/api/docs/pricing", checked: "2026-09-05 (fetched)" },
  },
  xai: {
    "grok-4": { ...GROK_43_REDIRECT, reasoning: true },
    "grok-4-0709": { ...GROK_43_REDIRECT, reasoning: true },
    "grok-4-fast": { ...GROK_43_REDIRECT, reasoning: true },
    "grok-4-fast-reasoning": { ...GROK_43_REDIRECT, reasoning: true },
    "grok-4-fast-non-reasoning": { ...GROK_43_REDIRECT, reasoning: false },
    "grok-4-1-fast-reasoning": { ...GROK_43_REDIRECT, reasoning: true },
    "grok-4-1-fast-non-reasoning": { ...GROK_43_REDIRECT, reasoning: false },
    "grok-3": { ...GROK_43_REDIRECT, reasoning: false },
    // grok-3-mini: neither on docs.x.ai/docs/models nor in the retirement list on 2026-09-04 — no row, stays unpriced
  },
};
