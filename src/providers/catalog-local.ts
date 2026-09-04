/** rovecode's own price table for models the models.dev snapshot does not carry — the API ALIASES a
 *  vendor sells under (DeepSeek's `deepseek-chat` / `deepseek-reasoner` are aliases of its current
 *  release; the snapshot lists the release ids), and xAI's grok-4 line, which the snapshot skips. Without
 *  these a real run on those models is "unpriced" in /cost and `rovecode model show`.
 *
 *  Rules: an entry here applies ONLY when neither the live models.dev layer nor the snapshot has the model
 *  (catalog.ts findIn) — a later snapshot entry wins by construction. Every entry names where the numbers
 *  came from and the day they were checked; `rovecode model show` prints "priced from rovecode's own table"
 *  so nobody mistakes them for models.dev's. Prices are USD per million tokens. Output limits are given
 *  only where the vendor publishes one (the runtime caps at MAX_OUTPUT_CAP anyway). */

export interface LocalModel {
  context: number;
  output?: number;
  /** has a reasoning mode (thinking.ts sends the dial only when this is not false) */
  reasoning: boolean;
  toolCall: boolean;
  image?: boolean;
  cost: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
  /** where the numbers were read, and when — the reader's warrant */
  source: string;
  checked: string;
}

export const LOCAL_MODELS: Readonly<Record<string, Readonly<Record<string, LocalModel>>>> = {
  deepseek: {
    // DeepSeek V3.2 pricing page (api-docs.deepseek.com/quick_start/pricing): both aliases share one price;
    // "cache hit" input is the cache-read rate. deepseek-chat is the non-thinking default with thinking
    // toggleable (a reasoning MODE, so reasoning: true); deepseek-reasoner always thinks.
    "deepseek-chat": { context: 128_000, output: 8_000, reasoning: true, toolCall: true, cost: { input: 0.28, output: 0.42, cacheRead: 0.028 }, source: "api-docs.deepseek.com pricing (V3.2)", checked: "2026-09-04" },
    "deepseek-reasoner": { context: 128_000, output: 64_000, reasoning: true, toolCall: true, cost: { input: 0.28, output: 0.42, cacheRead: 0.028 }, source: "api-docs.deepseek.com pricing (V3.2)", checked: "2026-09-04" },
  },
  xai: {
    // docs.x.ai models & pricing: grok-4 (always reasons; rejects reasoning_effort — thinking.ts), grok-4-fast
    // (reasoning and non-reasoning variants share the price), grok-3-mini (low|high effort words)
    "grok-4": { context: 256_000, reasoning: true, toolCall: true, image: true, cost: { input: 3, output: 15, cacheRead: 0.75 }, source: "docs.x.ai models (grok-4-0709)", checked: "2026-09-04" },
    "grok-4-0709": { context: 256_000, reasoning: true, toolCall: true, image: true, cost: { input: 3, output: 15, cacheRead: 0.75 }, source: "docs.x.ai models", checked: "2026-09-04" },
    "grok-4-fast": { context: 2_000_000, reasoning: true, toolCall: true, image: true, cost: { input: 0.2, output: 0.5, cacheRead: 0.05 }, source: "docs.x.ai models (grok-4-fast-reasoning)", checked: "2026-09-04" },
    "grok-4-fast-reasoning": { context: 2_000_000, reasoning: true, toolCall: true, image: true, cost: { input: 0.2, output: 0.5, cacheRead: 0.05 }, source: "docs.x.ai models", checked: "2026-09-04" },
    "grok-4-fast-non-reasoning": { context: 2_000_000, reasoning: false, toolCall: true, image: true, cost: { input: 0.2, output: 0.5, cacheRead: 0.05 }, source: "docs.x.ai models", checked: "2026-09-04" },
    "grok-3-mini": { context: 131_072, reasoning: true, toolCall: true, cost: { input: 0.3, output: 0.5, cacheRead: 0.075 }, source: "docs.x.ai models", checked: "2026-09-04" },
  },
};
