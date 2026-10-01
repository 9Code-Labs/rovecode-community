/** @rovecode-labs/models — the public surface. Everything here is offline: the data ships as generated
 *  JSON beside this file (models-index.json / models-index-extra.json / models-manifest.json, trimmed
 *  from the models.dev database), and live refresh is opt-in (CatalogOptions.fetchFn). */

export {
  ModelCatalog,
  describePricing,
  indexState,
  ratesFor,
  supportsImages,
  type CatalogOptions,
  type ModelInfo,
  type RateBreakdown,
  type Rates,
} from "./catalog.ts";
export { LOCAL_MODELS, PRICE_NOTES, PRICE_TIERS, type LocalModel, type PriceTier } from "./catalog-local.ts";
export { PROVIDER_MAP, VENDOR_PREFIX_MAP, mappedProviderKeys } from "./provider-map.ts";
export { ASSUMED_CONTEXT_WINDOW, resolveContextWindow, type ContextWindowSpec, type ResolvedWindow, type WindowSource } from "./context-window.ts";
export { keyNameFor } from "./key-name.ts";
