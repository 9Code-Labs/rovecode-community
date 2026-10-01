/** rovecode provider id → models.dev provider key. THE mapping table, in one file, because two
 *  consumers need it and a third needs to know what it covers:
 *
 *    catalog.ts   resolve() builds its lookup candidates from these two maps
 *    build-model-index.mjs   decides which providers ship in the HOT index and which in the
 *                            lazily-loaded extra one — a provider the catalog can name must be in
 *                            the hot file, or every lookup for it would pay the extra parse
 *
 *  It lives beside neither of them: catalog.ts is a runtime module and the generator is a script,
 *  and a table both read must not be imported out of one by the other.
 *
 *  Deliberately absent (verified NOT a key in the models.dev snapshot → a direct lookup misses and
 *  the id falls through to the vendor prefix, then to rovecode's own table): kaesra (rovecode's own
 *  proxy brand, not a models.dev provider — its vendor-prefixed model ids resolve through
 *  VENDOR_PREFIX_MAP), ollama (only "ollama-cloud" exists, not bare "ollama"), moondream, vllm.
 *  A provider id that is absent here is not unpriceable: resolve() also tries the id ITSELF against
 *  the index, so any of the 200-odd models.dev providers a user registers by hand resolves without
 *  an entry (see the "direct id" candidate in catalog.ts). These maps exist for the ids that need
 *  TRANSLATING, not as an allow-list. */

/** Derived by loading the offline snapshot and inspecting Object.keys(providers) directly rather
 *  than guessing: together → "togetherai" and fireworks → "fireworks-ai" (not the bare names);
 *  lmstudio → "lmstudio" DOES exist (3 curated local models), so it maps; everything else here is
 *  an exact 1:1 id match confirmed present in the snapshot. */
export const PROVIDER_MAP: Readonly<Record<string, string>> = {
  openai: "openai",
  anthropic: "anthropic",
  deepseek: "deepseek",
  groq: "groq",
  openrouter: "openrouter",
  lmstudio: "lmstudio",
  together: "togetherai",
  mistral: "mistral",
  cerebras: "cerebras",
  fireworks: "fireworks-ai",
  perplexity: "perplexity",
  xai: "xai",
  // not built-in providers, but the ids people give `rovecode provider add` for these vendors' own
  // endpoints (Google's OpenAI layer, Z.ai, Moonshot, Alibaba DashScope, MiniMax) — mapped so their
  // models price and carry the reasoning flag like the built-ins
  google: "google",
  gemini: "google",
  zai: "zai",
  moonshot: "moonshotai",
  moonshotai: "moonshotai",
  alibaba: "alibaba",
  dashscope: "alibaba",
  minimax: "minimax",
};

/** HuggingFace-style vendor prefix → models.dev provider key, for aggregator providers (kaesra, or
 *  any custom base URL) that serve models under "vendor/model" ids. Lets
 *  lookup("kaesra", "zai-org/glm-5.3-flash") price against the zai snapshot entry.
 *  Verified against Object.keys(providers): "zai", "deepseek", "moonshotai" all exist; there is NO
 *  bare "moonshot" key (only moonshotai / moonshotai-cn), hence the identity mapping for moonshotai. */
export const VENDOR_PREFIX_MAP: Readonly<Record<string, string>> = {
  "zai-org": "zai",
  "deepseek-ai": "deepseek",
  "moonshotai": "moonshotai",
};

/** Every models.dev key the two tables above can name. The generator puts these in the hot index;
 *  a lookup for any of them never touches the extra file. */
export function mappedProviderKeys(): string[] {
  return [...new Set([...Object.values(PROVIDER_MAP), ...Object.values(VENDOR_PREFIX_MAP)])].sort();
}
