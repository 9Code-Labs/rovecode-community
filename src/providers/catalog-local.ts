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
}

/** xAI, docs.x.ai/developers/migration/may-15-retirement (fetched 2026-09-04): grok-4-0709, grok-4-fast-reasoning,
 *  grok-4-fast-non-reasoning, grok-4-1-fast-* and grok-3 were retired on 2026-05-15; the slugs still resolve and
 *  are SERVED BY grok-4.3 — reasoning slugs at low effort, non-reasoning ones at none — and BILLED at grok-4.3
 *  rates ($1.25 in / $2.50 out / $0.20 cached per 1M under 200k context; docs.x.ai/docs/models/grok-4.3, fetched
 *  the same day: 1M context, configurable reasoning none|low|medium|high). So a request to `grok-4` costs this. */
const GROK_43_REDIRECT = { context: 1_000_000, toolCall: true, image: true, cost: { input: 1.25, output: 2.5, cacheRead: 0.2 },
  source: "docs.x.ai May-15-2026 retirement: served by grok-4.3, billed at grok-4.3 rates (under 200k context)", checked: "2026-09-04 (fetched)" } as const;

export const LOCAL_MODELS: Readonly<Record<string, Readonly<Record<string, LocalModel>>>> = {
  deepseek: {
    // api-docs.deepseek.com/quick_start/pricing, fetched 2026-09-04: the page prices deepseek-v4-flash / v4-pro /
    // v4-flash-vision-exp only (1M context, 384K max output, peak $0.44 / $1.32 per 1M in/out for flash, $1.32 /
    // $3.96 for pro; models.dev carries those). The two ALIASES below are no longer on the page, so what they
    // resolve to cannot be read there; the rows keep the last documented (V3.2) prices and say so.
    "deepseek-chat": { context: 128_000, output: 8_000, reasoning: true, toolCall: true, cost: { input: 0.28, output: 0.42, cacheRead: 0.028 }, source: "api-docs.deepseek.com pricing (V3.2 era)", checked: "2026-09-04 (unverified: the alias is no longer on the pricing page, which lists deepseek-v4-* only)" },
    "deepseek-reasoner": { context: 128_000, output: 64_000, reasoning: true, toolCall: true, cost: { input: 0.28, output: 0.42, cacheRead: 0.028 }, source: "api-docs.deepseek.com pricing (V3.2 era)", checked: "2026-09-04 (unverified: the alias is no longer on the pricing page, which lists deepseek-v4-* only)" },
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
