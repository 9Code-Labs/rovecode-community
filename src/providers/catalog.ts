/** Model catalog: capability/pricing lookups backed by the models.dev database (ADR: port #6).
 *
 *  Source of truth is the offline snapshot bundled in @opencode-ai/models (generated from
 *  https://models.dev/api.json). Live refresh against models.dev itself is entirely OPT-IN
 *  (only when a `fetchFn` is supplied) and layers on top of — never replaces — the offline
 *  data, so a fresh `new ModelCatalog()` works fully offline with zero network access. */

import { readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ProviderMap, Model } from "@opencode-ai/models";
import modelIndex from "./models-index.json";
import { LOCAL_MODELS, PRICE_NOTES, PRICE_TIERS, type LocalModel, type PriceTier } from "./catalog-local.ts";

// Loaded lazily on the first lookup() so that importing catalog.ts costs nothing — the TUI paints its
// first frame before buildDef() is called.
//
// It reads src/providers/models-index.json, not @opencode-ai/models/snapshot. Same shape, same source,
// five fields per model instead of the whole models.dev record: the upstream snapshot is 4.26 MB and
// parsing it costs 55 MB resident, which every session paid on its first status update to answer "what
// is this model's window and price". The trimmed index is 1.1 MB. scripts/build-model-index.mjs
// generates it and `--check` fails when it and the installed package disagree, so an upgrade cannot
// leave the catalog quietly describing the previous release.
const snapshotProviders = (): ProviderMap => (modelIndex as unknown as { providers: ProviderMap }).providers;

export interface ModelInfo {
  provider: string;
  model: string;
  contextWindow?: number;
  maxOutput?: number;
  pricing?: { inputPerMTok?: number; outputPerMTok?: number; cacheReadPerMTok?: number; cacheWritePerMTok?: number };
  supportsTools?: boolean;
  supportsReasoning?: boolean;
  /** where the numbers come from: models.dev (snapshot or live) or rovecode's own table (catalog-local.ts) for a
   *  model the snapshot lacks — `rovecode model show` says which, so a local price is never mistaken for models.dev's */
  source?: "models.dev" | "local";
  /** local entries only: the vendor page the numbers were read from, and when */
  sourceNote?: string;
  /** this model's price changes past a prompt size (xAI, Gemini). Attached whatever the row's source —
   *  models.dev has no field for it. A cost estimator that ignores it under-quotes a long prompt, and for
   *  `mode: "per-request"` it under-quotes the WHOLE request, not just the overflow. */
  tier?: PriceTier;
  /** a scheduled change or a condition attached to the price ("doubles on 2027-01-01") */
  priceNote?: string;
}

export interface CatalogOptions {
  fetchFn?: typeof fetch | null; // null = offline only; default null (live fetch is OPT-IN)
  cacheDir?: string;             // when live: cache api.json to <cacheDir>/models.json, ttl 24h
  /** the local overlay (default catalog-local.ts LOCAL_MODELS); tests inject their own */
  local?: Readonly<Record<string, Readonly<Record<string, LocalModel>>>>;
}

const CACHE_TTL_MS = 24 * 60 * 60_000;
const CACHE_FILE = "models.json";
const LIVE_URL = "https://models.dev/api.json";

/**
 * rovecode provider id -> models.dev provider key. Derived by loading the offline snapshot
 * (node_modules/@opencode-ai/models/dist/snapshot.js) and inspecting Object.keys(providers)
 * directly rather than guessing:
 *   - together -> "togetherai" and fireworks -> "fireworks-ai" (not the bare names)
 *   - lmstudio -> "lmstudio" DOES exist in the snapshot (3 curated local models), so it maps
 *   - everything else here is an exact 1:1 id match confirmed present in the snapshot
 *
 * Deliberately absent (verified NOT a key in the snapshot -> lookup() returns undefined):
 * kaesra (rovecode's own proxy brand, not a models.dev provider — its vendor-prefixed model ids
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
  // not built-in providers, but the ids people give `rovecode provider add` for these vendors' own endpoints
  // (Google's OpenAI layer, Z.ai, Moonshot, Alibaba DashScope, MiniMax) — mapped so their models price and
  // carry the reasoning flag like the built-ins (2026-09-04: models.dev snapshot 0.0.64 has all five)
  google: "google",
  gemini: "google",
  zai: "zai",
  moonshot: "moonshotai",
  moonshotai: "moonshotai",
  alibaba: "alibaba",
  dashscope: "alibaba",
  minimax: "minimax",
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

/** the tiered-price row for a model, if the vendor has one (case-insensitive, like every other lookup) */
function tierFor(providerId: string, modelId: string): PriceTier | undefined {
  const table = PRICE_TIERS[providerId.toLowerCase()];
  if (!table) return undefined;
  const key = Object.keys(table).find((k) => k.toLowerCase() === modelId.toLowerCase());
  return key === undefined ? undefined : table[key];
}

function noteFor(providerId: string, modelId: string): string | undefined {
  const table = PRICE_NOTES[providerId.toLowerCase()];
  if (!table) return undefined;
  const key = Object.keys(table).find((k) => k.toLowerCase() === modelId.toLowerCase());
  return key === undefined ? undefined : table[key];
}

/** The four rates one request is billed at. Same field names as `ModelInfo.pricing`, so a caller can pass
 *  either where a rate table is wanted. */
export interface Rates { inputPerMTok?: number; outputPerMTok?: number; cacheReadPerMTok?: number; cacheWritePerMTok?: number }

/** What `promptTokens` actually costs on this model, split the way the vendor bills it. PURE — no I/O, no
 *  clock, no rounding: a cost function multiplies these and decides its own precision.
 *
 *  Read `promptBase`/`promptAbove` as token counts to multiply by `base`/`above`; `request` is the rate
 *  table for everything that is not the prompt (output, cache) on this request, because both vendors we
 *  have select the OUTPUT price by prompt size too. For a flat model the split is trivial (everything in
 *  `promptBase`) so a caller never needs to branch on whether a tier exists — only on whether it wants the
 *  detail. */
export interface RateBreakdown {
  mode: "flat" | "per-request" | "marginal";
  /** true when the prompt crossed a threshold and the upper rates are in play */
  tierApplied: boolean;
  thresholdTokens?: number;
  promptBase: number;
  promptAbove: number;
  base: Rates;
  above?: Rates;
  request: Rates;
}

/** The rate breakdown for a prompt of `promptTokens` on this model. A negative or non-finite count is
 *  treated as 0 — an estimator must not be able to produce a negative bill. */
export function ratesFor(info: ModelInfo, promptTokens: number): RateBreakdown {
  const base: Rates = { ...(info.pricing ?? {}) };
  const n = Number.isFinite(promptTokens) && promptTokens > 0 ? Math.floor(promptTokens) : 0;
  const t = info.tier;
  if (!t || n <= t.thresholdTokens) {
    return { mode: t ? t.mode : "flat", tierApplied: false, ...(t ? { thresholdTokens: t.thresholdTokens } : {}),
      promptBase: n, promptAbove: 0, base, ...(t ? { above: ratesOf(t) } : {}), request: base };
  }
  const above = ratesOf(t);
  return t.mode === "per-request"
    // every token of the prompt, and this request's output, at the upper rate
    ? { mode: "per-request", tierApplied: true, thresholdTokens: t.thresholdTokens, promptBase: 0, promptAbove: n, base, above, request: above }
    // only the overflow at the upper rate; output follows the upper table, which is the conservative read
    : { mode: "marginal", tierApplied: true, thresholdTokens: t.thresholdTokens, promptBase: t.thresholdTokens, promptAbove: n - t.thresholdTokens, base, above, request: above };
}

function ratesOf(t: PriceTier): Rates {
  return { inputPerMTok: t.above.input, outputPerMTok: t.above.output,
    ...(t.above.cacheRead !== undefined ? { cacheReadPerMTok: t.above.cacheRead } : {}),
    ...(t.above.cacheWrite !== undefined ? { cacheWritePerMTok: t.above.cacheWrite } : {}) };
}

/** The price lines a surface shows — one place, so `model show`, /cost and the market cannot drift apart.
 *  Empty when the model is unpriced. */
export function describePricing(info: ModelInfo): string[] {
  const p = info.pricing;
  if (!p || (p.inputPerMTok === undefined && p.outputPerMTok === undefined)) return [];
  const money = (n?: number): string => (n === undefined ? "—" : `$${n}`);
  const lines = [`${money(p.inputPerMTok)} in / ${money(p.outputPerMTok)} out per 1M${p.cacheReadPerMTok !== undefined ? ` · cache read ${money(p.cacheReadPerMTok)}` : ""}${p.cacheWritePerMTok !== undefined ? ` · cache write ${money(p.cacheWritePerMTok)}` : ""}`];
  if (info.tier) {
    const t = info.tier;
    lines.push(t.mode === "per-request"
      ? `over ${t.thresholdTokens.toLocaleString("en-US")} prompt tokens the WHOLE request bills at ${money(t.above.input)} in / ${money(t.above.output)} out`
      : `tokens past ${t.thresholdTokens.toLocaleString("en-US")} bill at ${money(t.above.input)} in / ${money(t.above.output)} out`);
  }
  if (info.priceNote) lines.push(info.priceNote);
  return lines;
}

/** a local overlay row in the snapshot's shape, so one toModelInfo serves both */
function localAsModel(id: string, m: LocalModel): Model {
  return {
    id, name: id, description: `${m.source} — checked ${m.checked}`, attachment: false, reasoning: m.reasoning, tool_call: m.toolCall,
    release_date: m.checked, modalities: { input: m.image ? ["text", "image"] : ["text"], output: ["text"] },
    limit: { context: m.context, ...(m.output !== undefined ? { output: m.output } : {}) },
    cost: { input: m.cost.input, output: m.cost.output, ...(m.cost.cacheRead !== undefined ? { cache_read: m.cost.cacheRead } : {}), ...(m.cost.cacheWrite !== undefined ? { cache_write: m.cost.cacheWrite } : {}) },
  } as unknown as Model;
}

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
  private readonly local: Readonly<Record<string, Readonly<Record<string, LocalModel>>>>;
  private liveProviders: ProviderMap | null = null;
  private triedDiskCache = false;

  constructor(opts: CatalogOptions = {}) {
    this.fetchFn = opts.fetchFn ?? null;
    this.cacheDir = opts.cacheDir;
    this.local = opts.local ?? LOCAL_MODELS;
  }

  /** offline snapshot first; live cache layered on top when enabled.
   *  Resolution order: (1) the rovecode provider's own models.dev entry (PROVIDER_MAP), then
   *  (2) the model id's vendor prefix (VENDOR_PREFIX_MAP) with the prefix stripped — the
   *  path that makes aggregator providers like kaesra (default model zai-org/glm-5.3-flash)
   *  priceable. The vendor hit reports the vendor as `provider`, naming the pricing source. */
  lookup(providerId: string, modelId: string): ModelInfo | undefined {
    const hit = this.resolve(providerId, modelId);
    if (!hit) return undefined;
    const info = toModelInfo(hit.as, hit.key, hit.model);
    info.source = hit.local ? "local" : "models.dev";
    if (hit.local) info.sourceNote = `${hit.local.source}, checked ${hit.local.checked}`;
    const tier = tierFor(providerId, modelId) ?? tierFor(providerId, hit.key);
    if (tier) info.tier = tier;
    const note = noteFor(providerId, modelId) ?? noteFor(providerId, hit.key);
    if (note) info.priceNote = note;
    return info;
  }

  /** port #34: does the model accept image input? models.dev `modalities.input` (every entry of
   *  the bundled snapshot carries it — 7479/7479 at @opencode-ai/models 0.0.61). undefined = the
   *  model is not in the catalog (custom base URLs, local servers, aggregator ids without a
   *  vendor prefix): callers treat unknown as "send the image" — a wrong guess then fails loudly
   *  at the provider (HTTP 400 → error turn) instead of silently turning the user's image into
   *  text. Same resolution order as lookup(). */
  supportsImages(providerId: string, modelId: string): boolean | undefined {
    const hit = this.resolve(providerId, modelId);
    const input: unknown = hit?.model.modalities?.input;
    return Array.isArray(input) ? input.includes("image") : undefined;
  }

  /** models.dev `reasoning` for a model: true/false, undefined for a model the catalog does not know — the same
   *  resolution as supportsImages(). Callers treat unknown as "may reason" (wire-select.ts: an unlisted
   *  Responses-only id must not be sent to a wire that 404s it). */
  supportsReasoning(providerId: string, modelId: string): boolean | undefined {
    const hit = this.resolve(providerId, modelId);
    return typeof hit?.model.reasoning === "boolean" ? hit.model.reasoning : undefined;
  }

  /** The catalog entry behind lookup()/supportsImages(): provider key candidates in order, live
   *  layer over snapshot. `as` = the provider name reported (the vendor for a prefix hit). */
  private resolve(providerId: string, modelId: string): { as: string; key: string; model: Model; local?: LocalModel } | undefined {
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
      const hit = this.findIn(c.key, c.model);
      if (hit) return { as: c.as, ...hit };
    }
    return undefined;
  }

  /** one provider key: live layer, then the snapshot, then rovecode's own table (catalog-local.ts). The
   *  overlay does not shadow a models.dev entry, so a later snapshot that adds a model wins by construction
   *  — EXCEPT for a row marked `override: true`, which is how a vendor page that disagrees with the
   *  snapshot wins (today: DeepSeek's v4 family, where models.dev carries about a third of the published
   *  price). An override says which page and which day in its `source`, and `model show` prints it. */
  private findIn(key: string, modelId: string): { key: string; model: Model; local?: LocalModel } | undefined {
    const overriding = this.local[key];
    if (overriding) {
      const found = findModelKey(overriding as unknown as Record<string, Model>, modelId);
      const row = found === undefined ? undefined : overriding[found];
      if (found !== undefined && row?.override === true) return { key: found, model: localAsModel(found, row), local: row };
    }

    const live = this.liveProviders?.[key];
    if (live) {
      const found = findModelKey(live.models, modelId);
      if (found !== undefined) {
        const model = live.models[found];
        if (model) return { key: found, model };
      }
    }

    const snap = snapshotProviders()[key];
    if (snap) {
      const found = findModelKey(snap.models, modelId);
      if (found !== undefined) {
        const model = snap.models[found];
        if (model) return { key: found, model };
      }
    }

    const table = this.local[key];
    if (!table) return undefined;
    const found = findModelKey(table as unknown as Record<string, Model>, modelId);
    if (found === undefined) return undefined;
    const local = table[found]!;
    return { key: found, model: localAsModel(found, local), local };
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

let offlineCatalog: ModelCatalog | null = null;

/** Port #34 adapter hook: image capability of a ModelRef from the offline snapshot (no fetchFn →
 *  never touches network or disk). undefined = unknown model (see ModelCatalog.supportsImages). */
export function supportsImages(ref: { provider: string; model: string }, catalog?: ModelCatalog): boolean | undefined {
  return (catalog ?? (offlineCatalog ??= new ModelCatalog())).supportsImages(ref.provider, ref.model);
}

/** the same hook for the reasoning flag (wire-select.ts): true/false from the offline snapshot, undefined = unknown model */
export function supportsReasoning(ref: { provider: string; model: string }, catalog?: ModelCatalog): boolean | undefined {
  return (catalog ?? (offlineCatalog ??= new ModelCatalog())).supportsReasoning(ref.provider, ref.model);
}
