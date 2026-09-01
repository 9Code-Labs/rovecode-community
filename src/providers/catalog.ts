/** Model catalog: capability/pricing lookups backed by the models.dev database (ADR: port #6).
 *
 *  Source of truth is the offline snapshot bundled in @opencode-ai/models (generated from
 *  https://models.dev/api.json). Live refresh against models.dev itself is entirely OPT-IN
 *  (only when a `fetchFn` is supplied) and layers on top of — never replaces — the offline
 *  data, so a fresh `new ModelCatalog()` works fully offline with zero network access. */

import { readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { providers as snapshotProviders } from "@opencode-ai/models/snapshot";
import type { ProviderMap, Model } from "@opencode-ai/models";

export interface ModelInfo {
  provider: string;
  model: string;
  contextWindow?: number;
  maxOutput?: number;
  pricing?: { inputPerMTok?: number; outputPerMTok?: number; cacheReadPerMTok?: number; cacheWritePerMTok?: number };
  supportsTools?: boolean;
  supportsReasoning?: boolean;
}

export interface CatalogOptions {
  fetchFn?: typeof fetch | null; // null = offline only; default null (live fetch is OPT-IN)
  cacheDir?: string;             // when live: cache api.json to <cacheDir>/models.json, ttl 24h
}

const CACHE_TTL_MS = 24 * 60 * 60_000;
const CACHE_FILE = "models.json";
const LIVE_URL = "https://models.dev/api.json";

/**
 * aion provider id -> models.dev provider key. Derived by loading the offline snapshot
 * (node_modules/@opencode-ai/models/dist/snapshot.js) and inspecting Object.keys(providers)
 * directly rather than guessing:
 *   - together -> "togetherai" and fireworks -> "fireworks-ai" (not the bare names)
 *   - lmstudio -> "lmstudio" DOES exist in the snapshot (3 curated local models), so it maps
 *   - everything else here is an exact 1:1 id match confirmed present in the snapshot
 *
 * Deliberately absent (verified NOT a key in the snapshot -> lookup() returns undefined):
 * kaesra (aion's own proxy brand, not a models.dev provider — its vendor-prefixed model ids
 * resolve through VENDOR_PREFIX_MAP below instead), ollama (only "ollama-cloud" exists, not
 * bare "ollama"), moondream, vllm.
 */
const PROVIDER_MAP: Record<string, string> = {
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
};

/**
 * HuggingFace-style vendor prefix -> models.dev provider key, for aggregator providers
 * (kaesra, or any custom base URL) that serve models under "vendor/model" ids. Lets
 * lookup("kaesra", "zai-org/glm-5.3-flash") price against the zai snapshot entry.
 * Verified against Object.keys(snapshotProviders): "zai", "deepseek", "moonshotai" all
 * exist; there is NO bare "moonshot" key (only moonshotai/moonshotai-cn), hence the
 * identity mapping for moonshotai.
 */
const VENDOR_PREFIX_MAP: Record<string, string> = {
  "zai-org": "zai",
  "deepseek-ai": "deepseek",
  "moonshotai": "moonshotai",
};

function isProviderMap(value: unknown): value is ProviderMap {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  for (const entry of Object.values(value as Record<string, unknown>)) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
    const models = (entry as { models?: unknown }).models;
    if (typeof models !== "object" || models === null || Array.isArray(models)) return false;
  }
  return true;
}

/** exact match, then case-insensitive, then match after stripping a single leading "vendor/" prefix. */
function findModelKey(models: Record<string, Model>, modelId: string): string | undefined {
  if (modelId in models) return modelId;
  const lower = modelId.toLowerCase();
  for (const key of Object.keys(models)) {
    if (key.toLowerCase() === lower) return key;
  }
  const slashIndex = modelId.indexOf("/");
  if (slashIndex === -1) return undefined;
  const stripped = modelId.slice(slashIndex + 1);
  if (stripped in models) return stripped;
  const strippedLower = stripped.toLowerCase();
  for (const key of Object.keys(models)) {
    if (key.toLowerCase() === strippedLower) return key;
  }
  return undefined;
}

function toModelInfo(providerId: string, modelId: string, model: Model): ModelInfo {
  const info: ModelInfo = { provider: providerId, model: modelId };
  if (model.limit?.context !== undefined) info.contextWindow = model.limit.context;
  if (model.limit?.output !== undefined) info.maxOutput = model.limit.output;
  const cost = model.cost;
  if (cost) {
    const pricing: NonNullable<ModelInfo["pricing"]> = {};
    if (cost.input !== undefined) pricing.inputPerMTok = cost.input;
    if (cost.output !== undefined) pricing.outputPerMTok = cost.output;
    if (cost.cache_read !== undefined) pricing.cacheReadPerMTok = cost.cache_read;
    if (cost.cache_write !== undefined) pricing.cacheWritePerMTok = cost.cache_write;
    if (Object.keys(pricing).length > 0) info.pricing = pricing;
  }
  if (model.tool_call !== undefined) info.supportsTools = model.tool_call;
  if (model.reasoning !== undefined) info.supportsReasoning = model.reasoning;
  return info;
}

export class ModelCatalog {
  private readonly fetchFn: typeof fetch | null;
  private readonly cacheDir: string | undefined;
  private liveProviders: ProviderMap | null = null;
  private triedDiskCache = false;

  constructor(opts: CatalogOptions = {}) {
    this.fetchFn = opts.fetchFn ?? null;
    this.cacheDir = opts.cacheDir;
  }

  /** offline snapshot first; live cache layered on top when enabled.
   *  Resolution order: (1) the aion provider's own models.dev entry (PROVIDER_MAP), then
   *  (2) the model id's vendor prefix (VENDOR_PREFIX_MAP) with the prefix stripped — the
   *  path that makes aggregator providers like kaesra (default model zai-org/glm-5.3-flash)
   *  priceable. The vendor hit reports the vendor as `provider`, naming the pricing source. */
  lookup(providerId: string, modelId: string): ModelInfo | undefined {
    this.loadDiskCacheOnce();

    const candidates: { key: string; as: string; model: string }[] = [];
    const direct = PROVIDER_MAP[providerId];
    if (direct) candidates.push({ key: direct, as: providerId, model: modelId });
    const slash = modelId.indexOf("/");
    if (slash > 0) {
      const vendorKey = VENDOR_PREFIX_MAP[modelId.slice(0, slash).toLowerCase()];
      if (vendorKey && vendorKey !== direct) candidates.push({ key: vendorKey, as: vendorKey, model: modelId.slice(slash + 1) });
    }

    for (const c of candidates) {
      const hit = this.lookupIn(c.key, c.as, c.model);
      if (hit) return hit;
    }
    return undefined;
  }

  /** one provider key, live layer over snapshot. */
  private lookupIn(key: string, providerId: string, modelId: string): ModelInfo | undefined {
    const live = this.liveProviders?.[key];
    if (live) {
      const found = findModelKey(live.models, modelId);
      if (found !== undefined) {
        const model = live.models[found];
        if (model) return toModelInfo(providerId, found, model);
      }
    }

    const snap = snapshotProviders[key];
    if (!snap) return undefined;
    const found = findModelKey(snap.models, modelId);
    if (found === undefined) return undefined;
    const model = snap.models[found];
    if (!model) return undefined;
    return toModelInfo(providerId, found, model);
  }

  /** live fetch https://models.dev/api.json when fetchFn set; false on failure, never throws. */
  async refresh(): Promise<boolean> {
    if (!this.fetchFn) return false;
    try {
      const res = await this.fetchFn(LIVE_URL);
      if (!res.ok) return false;
      const json: unknown = await res.json();
      if (!isProviderMap(json)) return false;
      this.liveProviders = json;
      this.triedDiskCache = true;
      this.writeDiskCache(json);
      return true;
    } catch {
      return false;
    }
  }

  /** Load a still-fresh (<24h) on-disk cache at most once per instance. Corrupted/stale/missing
   *  cache is silently ignored — offline snapshot remains the fallback. Only consulted when a
   *  fetchFn is configured, matching "live fetch is OPT-IN" (a purely-offline catalog never
   *  touches disk). */
  private loadDiskCacheOnce(): void {
    if (this.triedDiskCache) return;
    this.triedDiskCache = true;
    if (!this.fetchFn || !this.cacheDir) return;
    try {
      const path = join(this.cacheDir, CACHE_FILE);
      const age = Date.now() - statSync(path).mtimeMs;
      if (age > CACHE_TTL_MS) return;
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (isProviderMap(parsed)) this.liveProviders = parsed;
    } catch {
      // missing file, unreadable, or malformed JSON/shape -> treated as "no cache"
    }
  }

  private writeDiskCache(data: ProviderMap): void {
    if (!this.cacheDir) return;
    try {
      mkdirSync(this.cacheDir, { recursive: true });
      writeFileSync(join(this.cacheDir, CACHE_FILE), JSON.stringify(data));
    } catch {
      // best-effort cache write; a failed write must not fail refresh()
    }
  }
}
