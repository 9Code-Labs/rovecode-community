import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelCatalog } from "../../src/providers/catalog.ts";
import { costUsd } from "../../src/core/usage.ts";

// A fetchFn that must never actually be invoked — used to prove that lookup() (unlike
// refresh()) never touches the network, only ever the offline snapshot / disk cache.
const neverCalledFetch = (async () => {
  throw new Error("fetchFn must not be called");
}) as unknown as typeof fetch;

function stubFetchOk(data: unknown): typeof fetch {
  return (async () => ({ ok: true, json: async () => data })) as unknown as typeof fetch;
}

// ---------- offline snapshot lookups (anthropic, openai, deepseek) ----------

test("offline lookup: anthropic claude-haiku-4-5 resolves full ModelInfo from the snapshot", () => {
  const catalog = new ModelCatalog();
  const info = catalog.lookup("anthropic", "claude-haiku-4-5");
  expect(info).toEqual({
    provider: "anthropic",
    model: "claude-haiku-4-5",
    contextWindow: 200000,
    maxOutput: 64000,
    pricing: { inputPerMTok: 1, outputPerMTok: 5, cacheReadPerMTok: 0.1, cacheWritePerMTok: 1.25 },
    supportsTools: true,
    supportsReasoning: true,
    source: "models.dev", // vs "local" for rovecode's own table (catalog-local.ts)
  });
});

test("offline lookup: openai gpt-4o resolves, with no cache_write in its pricing", () => {
  const catalog = new ModelCatalog();
  const info = catalog.lookup("openai", "gpt-4o");
  expect(info?.contextWindow).toBe(128000);
  expect(info?.maxOutput).toBe(16384);
  expect(info?.pricing).toEqual({ inputPerMTok: 2.5, outputPerMTok: 10, cacheReadPerMTok: 1.25 });
  expect(info?.pricing?.cacheWritePerMTok).toBeUndefined();
  expect(info?.supportsTools).toBe(true);
  expect(info?.supportsReasoning).toBe(false);
});

test("offline lookup: deepseek deepseek-v4-pro resolves (reasoning model, huge context)", () => {
  const catalog = new ModelCatalog();
  const info = catalog.lookup("deepseek", "deepseek-v4-pro");
  expect(info?.contextWindow).toBe(1000000);
  expect(info?.maxOutput).toBe(384000);
  expect(info?.pricing?.inputPerMTok).toBe(1.32);
  expect(info?.pricing?.outputPerMTok).toBe(3.96);
  expect(info?.pricing?.cacheReadPerMTok).toBe(0.044);
  expect(info?.supportsReasoning).toBe(true);
  expect(info?.supportsTools).toBe(true);
});

// ---------- model-id normalization ----------

test("case-insensitive normalization matches the same model as the exact id", () => {
  const catalog = new ModelCatalog();
  const exact = catalog.lookup("openai", "gpt-4o");
  const upper = catalog.lookup("openai", "GPT-4O");
  expect(upper).toEqual(exact);

  const exactDs = catalog.lookup("deepseek", "deepseek-v4-pro");
  const upperDs = catalog.lookup("deepseek", "DEEPSEEK-V4-PRO");
  expect(upperDs).toEqual(exactDs);
});

test("vendor/ prefix is stripped when the bare id isn't a direct or case-insensitive match", () => {
  const catalog = new ModelCatalog();
  expect(catalog.lookup("anthropic", "anthropic/claude-haiku-4-5")?.model).toBe("claude-haiku-4-5");
  expect(catalog.lookup("openai", "openai/gpt-4o")?.model).toBe("gpt-4o");
  // mirrors the spec's own "zai-org/glm-5.3" -> "glm-5.3" example shape
  expect(catalog.lookup("deepseek", "deepseek-ai/deepseek-v4-pro")?.model).toBe("deepseek-v4-pro");
});

// ---------- vendor-prefix resolution (makes /cost live on the default provider) ----------

test("kaesra's default model resolves via the vendor-prefix map: zai-org/glm-5.3-flash → zai", () => {
  const catalog = new ModelCatalog();
  const info = catalog.lookup("kaesra", "zai-org/glm-5.3-flash");
  expect(info).toEqual({
    provider: "zai", // the pricing source, named honestly
    model: "glm-5.3-flash",
    contextWindow: 1000000,
    maxOutput: 131072,
    pricing: { inputPerMTok: 0.075, outputPerMTok: 0.25, cacheReadPerMTok: 0.015, cacheWritePerMTok: 0 },
    supportsTools: true,
    supportsReasoning: true,
    source: "models.dev",
  });
});

test("deepseek-ai/ and moonshotai/ vendor prefixes resolve for aggregator providers", () => {
  const catalog = new ModelCatalog();
  const ds = catalog.lookup("kaesra", "deepseek-ai/deepseek-v4-pro");
  expect(ds?.provider).toBe("deepseek");
  expect(ds?.pricing?.inputPerMTok).toBe(1.32);
  // the snapshot's key is "moonshotai" — there is NO bare "moonshot" provider key
  const kimi = catalog.lookup("kaesra", "moonshotai/kimi-k2-0711-preview");
  expect(kimi?.provider).toBe("moonshotai");
  expect(kimi?.pricing?.inputPerMTok).toBe(0.6);
});

test("vendor-prefix resolution also covers providers with no PROVIDER_MAP entry at all", () => {
  const catalog = new ModelCatalog();
  // e.g. a custom ROVECODE_BASE_URL provider serving HuggingFace-style ids
  expect(catalog.lookup("custom", "zai-org/glm-5.3-flash")?.provider).toBe("zai");
  // …while a prefix-less id under the same unmapped provider stays undefined
  expect(catalog.lookup("custom", "glm-5.3-flash")).toBeUndefined();
});

// ---------- lookup → costUsd composition (pins real dollars end-to-end) ----------

test("composition: haiku pricing × 1M tokens of each component = $7.35", () => {
  const catalog = new ModelCatalog();
  const pricing = catalog.lookup("anthropic", "claude-haiku-4-5")?.pricing;
  expect(pricing).toBeDefined();
  const usd = costUsd({ input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 }, pricing!);
  // $1.00 input + $5.00 output + $0.10 cache-read + $1.25 cache-write
  expect(usd).toBeCloseTo(7.35, 10);
});

// ---------- provider-id mapping ----------

test("unmappable provider ids return undefined cleanly, never throw", () => {
  const catalog = new ModelCatalog();
  for (const providerId of ["kaesra", "ollama", "vllm", "moondream", "totally-unknown-provider"]) {
    expect(() => catalog.lookup(providerId, "anything")).not.toThrow();
    expect(catalog.lookup(providerId, "anything")).toBeUndefined();
  }
});

test("mapped provider with an unknown model id returns undefined, not a false-positive match", () => {
  const catalog = new ModelCatalog();
  expect(catalog.lookup("openai", "totally-bogus-model-xyz-does-not-exist")).toBeUndefined();
});

// ---------- live refresh: layering, failure modes ----------

test("refresh() layers live data over the snapshot: overrides existing models and adds new ones", async () => {
  const live = {
    openai: {
      models: {
        "gpt-4o": { limit: { context: 128000, output: 16384 }, cost: { input: 999, output: 10, cache_read: 1.25 }, tool_call: true, reasoning: false },
        "brand-new-model": { limit: { context: 32000, output: 4000 }, cost: { input: 3, output: 6 }, tool_call: true, reasoning: true },
      },
    },
  };
  const catalog = new ModelCatalog({ fetchFn: stubFetchOk(live) });
  expect(await catalog.refresh()).toBe(true);

  // live overrides the snapshot's real gpt-4o pricing (2.5) with the stub's (999)
  expect(catalog.lookup("openai", "gpt-4o")?.pricing?.inputPerMTok).toBe(999);
  // live-only model, absent from the offline snapshot entirely
  const fresh = catalog.lookup("openai", "brand-new-model");
  expect(fresh?.contextWindow).toBe(32000);
  expect(fresh?.supportsReasoning).toBe(true);
});

test("live layering falls back to the snapshot for providers the live payload doesn't cover", async () => {
  const live = { openai: { models: { "gpt-4o": { limit: { context: 1, output: 1 }, cost: { input: 1, output: 1 }, tool_call: true, reasoning: false } } } };
  const catalog = new ModelCatalog({ fetchFn: stubFetchOk(live) });
  expect(await catalog.refresh()).toBe(true);

  // anthropic wasn't in the live payload at all -> must still resolve from the offline snapshot
  const info = catalog.lookup("anthropic", "claude-haiku-4-5");
  expect(info?.pricing?.inputPerMTok).toBe(1);
});

test("refresh() returns false without throwing when the response is not ok", async () => {
  const notOk = (async () => ({ ok: false, json: async () => ({}) })) as unknown as typeof fetch;
  const catalog = new ModelCatalog({ fetchFn: notOk });
  expect(await catalog.refresh()).toBe(false);
  // offline snapshot is untouched by the failed refresh
  expect(catalog.lookup("openai", "gpt-4o")?.pricing?.inputPerMTok).toBe(2.5);
});

test("refresh() returns false without throwing when fetchFn itself rejects", async () => {
  const throws = (async () => {
    throw new Error("network down");
  }) as unknown as typeof fetch;
  const catalog = new ModelCatalog({ fetchFn: throws });
  expect(await catalog.refresh()).toBe(false);
});

test("refresh() is a no-op returning false when no fetchFn is configured (default is offline-only)", async () => {
  const catalog = new ModelCatalog();
  expect(await catalog.refresh()).toBe(false);
  const explicitNull = new ModelCatalog({ fetchFn: null });
  expect(await explicitNull.refresh()).toBe(false);
});

// ---------- disk cache: corruption tolerance + TTL ----------

test("corrupted cache file (invalid JSON) is ignored, not thrown, snapshot still used", () => {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-catalog-"));
  writeFileSync(join(dir, "models.json"), "{not valid json at all");
  const catalog = new ModelCatalog({ fetchFn: neverCalledFetch, cacheDir: dir });
  expect(() => catalog.lookup("openai", "gpt-4o")).not.toThrow();
  expect(catalog.lookup("openai", "gpt-4o")?.pricing?.inputPerMTok).toBe(2.5);
  rmSync(dir, { recursive: true, force: true });
});

test("corrupted cache file (valid JSON, wrong shape) is ignored, not thrown", () => {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-catalog-"));
  writeFileSync(join(dir, "models.json"), JSON.stringify([1, 2, 3]));
  const catalog = new ModelCatalog({ fetchFn: neverCalledFetch, cacheDir: dir });
  expect(() => catalog.lookup("anthropic", "claude-haiku-4-5")).not.toThrow();
  expect(catalog.lookup("anthropic", "claude-haiku-4-5")?.pricing?.inputPerMTok).toBe(1);
  rmSync(dir, { recursive: true, force: true });
});

test("disk cache ttl: fresh (<24h) cache is used, stale (>24h) cache is ignored in favor of the snapshot", () => {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-catalog-"));
  const cachePath = join(dir, "models.json");
  const cached = { openai: { models: { "gpt-4o": { limit: { context: 1, output: 1 }, cost: { input: 111, output: 1 }, tool_call: true, reasoning: false } } } };
  writeFileSync(cachePath, JSON.stringify(cached)); // mtime is "now" -> fresh

  const freshCatalog = new ModelCatalog({ fetchFn: neverCalledFetch, cacheDir: dir });
  expect(freshCatalog.lookup("openai", "gpt-4o")?.pricing?.inputPerMTok).toBe(111);

  const twentyFiveHoursAgo = new Date(Date.now() - 25 * 60 * 60_000);
  utimesSync(cachePath, twentyFiveHoursAgo, twentyFiveHoursAgo);

  const staleCatalog = new ModelCatalog({ fetchFn: neverCalledFetch, cacheDir: dir });
  expect(staleCatalog.lookup("openai", "gpt-4o")?.pricing?.inputPerMTok).toBe(2.5); // real snapshot value

  rmSync(dir, { recursive: true, force: true });
});
