/** rovecode's own price table (providers/catalog-local.ts) behind the models.dev snapshot: every entry resolves
 *  with its numbers and `source: "local"` plus the page-and-date note; a model the snapshot HAS is never shadowed
 *  by an overlay row (a later snapshot wins by construction); `rovecode model show` names the source. */

import { expect, test } from "bun:test";
import { ModelCatalog, describePricing, ratesFor } from "../../src/providers/catalog.ts";
import { LOCAL_MODELS } from "../../src/providers/catalog-local.ts";
import { thinkingReport } from "../../src/providers/thinking.ts";

test("every local entry resolves with its own numbers, source 'local' and the page/date note; the snapshot's entries stay 'models.dev'", () => {
  const c = new ModelCatalog();
  for (const [provider, table] of Object.entries(LOCAL_MODELS)) {
    for (const [id, m] of Object.entries(table)) {
      const info = c.lookup(provider, id);
      expect(info).toBeDefined();
      expect(info).toMatchObject({ provider, model: id, source: "local", contextWindow: m.context, supportsReasoning: m.reasoning, supportsTools: m.toolCall,
        pricing: { inputPerMTok: m.cost.input, outputPerMTok: m.cost.output, ...(m.cost.cacheRead !== undefined ? { cacheReadPerMTok: m.cost.cacheRead } : {}) } });
      expect(info!.sourceNote).toBe(`${m.source}, checked ${m.checked}`);
      if (m.output !== undefined) expect(info!.maxOutput).toBe(m.output); else expect(info!.maxOutput).toBeUndefined();
      expect(c.supportsImages(provider, id)).toBe(m.image === true);
    }
  }
  // the two gaps the audit found are closed with the right shape
  expect(c.lookup("deepseek", "deepseek-chat")).toMatchObject({ source: "local", pricing: { inputPerMTok: 0.28, outputPerMTok: 0.42, cacheReadPerMTok: 0.028 }, contextWindow: 128_000, maxOutput: 8_000, supportsReasoning: true });
  expect(c.lookup("deepseek", "deepseek-reasoner")!.maxOutput).toBe(64_000);
  // xAI retired the grok-4 slugs on 2026-05-15 and serves them as grok-4.3 at grok-4.3 rates (docs.x.ai, fetched 2026-09-04)
  expect(c.lookup("xai", "grok-4")).toMatchObject({ source: "local", contextWindow: 1_000_000, pricing: { inputPerMTok: 1.25, outputPerMTok: 2.5, cacheReadPerMTok: 0.2 }, supportsReasoning: true });
  expect(c.lookup("xai", "grok-4")!.sourceNote).toContain("served by grok-4.3, billed at grok-4.3 rates");
  expect(c.lookup("xai", "grok-4")!.sourceNote).toContain("2026-09-04 (fetched)");
  expect(c.lookup("xai", "grok-4-fast-non-reasoning")!.supportsReasoning).toBe(false); // served at none: thinking.ts sends nothing to it
  expect(c.lookup("xai", "grok-3-mini")).toBeUndefined(); // neither documented nor in the retirement list: stays unpriced on purpose
  expect(c.lookup("deepseek", "deepseek-chat")!.sourceNote).toContain("unverified: the alias is not on the pricing page");
  expect(c.lookup("xai", "GROK-4")!.source).toBe("local"); // the snapshot's case-insensitive match applies to the table too
  expect(c.lookup("anthropic", "claude-opus-5")).toMatchObject({ source: "models.dev" });
  expect(c.lookup("anthropic", "claude-opus-5")!.sourceNote).toBeUndefined();
});

test("a snapshot entry wins over an overlay row for the same model: the overlay only fills gaps", () => {
  const c = new ModelCatalog({ local: { anthropic: { "claude-opus-5": { context: 1, output: 1, reasoning: false, toolCall: false, cost: { input: 999, output: 999 }, source: "a test", checked: "2026-09-04" } }, xai: { "grok-4": { context: 42, reasoning: true, toolCall: true, cost: { input: 1, output: 2 }, source: "a test", checked: "2026-09-04" } } } });
  expect(c.lookup("anthropic", "claude-opus-5")).toMatchObject({ source: "models.dev", contextWindow: 1_000_000, pricing: { inputPerMTok: 5 } }); // the snapshot's numbers, not 999
  expect(c.lookup("xai", "grok-4")).toMatchObject({ source: "local", contextWindow: 42 }); // the injected table is the one consulted
  expect(new ModelCatalog({ local: {} }).lookup("xai", "grok-4")).toBeUndefined(); // no table → the gap stays a gap
});

test("`model show` says where the prices come from", () => {
  const lines = thinkingReport({ provider: "deepseek", model: "deepseek-chat", effort: "auto", reasoning: true }, "openai", { source: "the default", catalog: "priced from rovecode's own table, not models.dev (api-docs.deepseek.com pricing (V3.2), checked 2026-09-04)" });
  expect(lines[3]).toBe("  prices    priced from rovecode's own table, not models.dev (api-docs.deepseek.com pricing (V3.2), checked 2026-09-04)");
  expect(lines[4]).toBe("  effort    auto  (ROVECODE_EFFORT / --effort / /effort)");
  expect(thinkingReport({ provider: "openai", model: "gpt-5.2" }, "openai")[3]).toBe("  effort    auto  (ROVECODE_EFFORT / --effort / /effort)"); // no catalog line when none is given
});

// ---------- verified 2026-09-05 against the vendors' own pages ----------

test("DeepSeek's v4 rows OVERRIDE models.dev, which carries about a third of the published price; the aliases stay unverified", () => {
  const c = new ModelCatalog();
  const flash = c.lookup("deepseek", "deepseek-v4-flash");
  expect(flash).toMatchObject({ source: "local", contextWindow: 1_000_000, maxOutput: 384_000,
    pricing: { inputPerMTok: 0.44, outputPerMTok: 1.32, cacheReadPerMTok: 0.014 } });
  expect(flash!.sourceNote).toContain("api-docs.deepseek.com/quick_start/pricing");
  expect(flash!.sourceNote).toContain("2026-09-05 (fetched)");
  expect(c.lookup("deepseek", "deepseek-v4-pro")).toMatchObject({ source: "local", pricing: { inputPerMTok: 1.32, outputPerMTok: 3.96, cacheReadPerMTok: 0.044 } });
  expect(c.supportsImages("deepseek", "deepseek-v4-flash-vision-exp")).toBe(true);
  // the aliases are NOT quietly refreshed to a v4 price they may not be billed at
  expect(c.lookup("deepseek", "deepseek-chat")!.sourceNote).toContain("unverified");
  expect(c.lookup("deepseek", "deepseek-reasoner")!.sourceNote).toContain("thinking as a MODE");

  // an override is opt-in per row: a local row without the flag still never shadows the snapshot
  const shadowing = new ModelCatalog({ local: { anthropic: { "claude-opus-5": { context: 1, reasoning: false, toolCall: false, cost: { input: 999, output: 999 }, source: "a test", checked: "2026-09-05" } } } });
  expect(shadowing.lookup("anthropic", "claude-opus-5")).toMatchObject({ source: "models.dev", pricing: { inputPerMTok: 5 } });
  const overriding = new ModelCatalog({ local: { anthropic: { "claude-opus-5": { context: 1, reasoning: false, toolCall: false, override: true, cost: { input: 999, output: 999 }, source: "a test", checked: "2026-09-05" } } } });
  expect(overriding.lookup("anthropic", "claude-opus-5")).toMatchObject({ source: "local", pricing: { inputPerMTok: 999 } });
});

test("a prompt-size price tier is attached to a models.dev row, which keeps its own base numbers", () => {
  const c = new ModelCatalog();
  const grok = c.lookup("xai", "grok-4.6");
  expect(grok).toMatchObject({ source: "models.dev", pricing: { inputPerMTok: 2, outputPerMTok: 6 } }); // base price still models.dev's
  expect(grok!.tier).toMatchObject({ thresholdTokens: 200_000, mode: "per-request", above: { input: 4, output: 12, cacheRead: 1 } });
  expect(c.lookup("xai", "grok-4.3")!.tier).toMatchObject({ mode: "per-request", above: { input: 2.5, output: 5 } });
  // Google prices by prompt size too (the page's columns say "prompts > 200k tokens"), so it is per-request, not marginal
  expect(c.lookup("google", "gemini-3.1-pro-preview")!.tier).toMatchObject({ thresholdTokens: 200_000, mode: "per-request", above: { input: 4, output: 18 } });
  expect(c.lookup("google", "gemini-2.5-pro")!.tier).toMatchObject({ mode: "per-request", above: { input: 2.5, output: 15 } });
  expect(c.lookup("anthropic", "claude-opus-5")!.tier).toBeUndefined(); // Anthropic has no long-context step any more
  expect(c.lookup("google", "GEMINI-2.5-PRO")!.tier).toBeDefined();     // model id matched case-insensitively, like every other lookup
});

test("a scheduled price change rides with the row, and describePricing says all of it in one place", () => {
  const c = new ModelCatalog();
  expect(c.lookup("google", "gemini-3.8-flash")!.priceNote).toContain("starting 2027-01-01");
  expect(c.lookup("google", "gemini-2.5-pro")!.priceNote).toBeUndefined();

  const grok = describePricing(c.lookup("xai", "grok-4.6")!);
  expect(grok[0]).toBe("$2 in / $6 out per 1M · cache read $0.5");
  expect(grok[1]).toBe("over 200,000 prompt tokens the WHOLE request bills at $4 in / $12 out");
  const gem = describePricing(c.lookup("google", "gemini-3.1-pro-preview")!);
  expect(gem[1]).toBe("over 200,000 prompt tokens the WHOLE request bills at $4 in / $18 out");
  expect(describePricing(c.lookup("google", "gemini-3.8-flash")!).at(-1)).toContain("2027-01-01");
  expect(describePricing({ provider: "x", model: "y" })).toEqual([]); // unpriced says nothing rather than "$undefined"
});

test("gpt-6-astra is a gap fill: the snapshot does not carry it, so the vendor page does", () => {
  const c = new ModelCatalog();
  expect(c.lookup("openai", "gpt-6-astra")).toMatchObject({ source: "local", contextWindow: 1_050_000, maxOutput: 128_000,
    pricing: { inputPerMTok: 10, outputPerMTok: 50, cacheReadPerMTok: 1 } });
  expect(c.lookup("openai", "gpt-5")).toMatchObject({ source: "models.dev", pricing: { inputPerMTok: 1.25, cacheReadPerMTok: 0.125 } });
});

test("Anthropic today: no long-context step, Sonnet 5 at $2/$10, Fable's cache read at 0.025x", () => {
  const c = new ModelCatalog();
  // every Anthropic row is the snapshot's, unpriced by rovecode, and none carries a >200k tier
  for (const m of ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5", "claude-fable-5-1"]) {
    const i = c.lookup("anthropic", m)!;
    expect(i.source).toBe("models.dev");
    expect(i.tier).toBeUndefined();
  }
  expect(c.lookup("anthropic", "claude-sonnet-5")).toMatchObject({ contextWindow: 1_000_000, pricing: { inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.2 } });
  expect(c.lookup("anthropic", "claude-opus-5")).toMatchObject({ pricing: { inputPerMTok: 5, outputPerMTok: 25, cacheReadPerMTok: 0.5 } });
  const fable = c.lookup("anthropic", "claude-fable-5-1")!;
  expect(fable.pricing!.cacheReadPerMTok).toBe(0.25);
  expect(fable.pricing!.cacheReadPerMTok! / fable.pricing!.inputPerMTok!).toBeCloseTo(0.025, 5); // the one model that is not 0.1x
  expect(c.lookup("anthropic", "claude-opus-5")!.pricing!.cacheReadPerMTok! / 5).toBeCloseTo(0.1, 5);
});

// ---------- ratesFor: what a cost function multiplies ----------

test("Google tiers by PROMPT SIZE like xAI, not by overflow — the page reads \"prompts > 200k tokens\"", () => {
  const c = new ModelCatalog();
  for (const [p, m] of [["google", "gemini-3.1-pro-preview"], ["google", "gemini-2.5-pro"], ["xai", "grok-4.6"], ["xai", "grok-4.3"]] as const) {
    expect(c.lookup(p, m)!.tier!.mode).toBe("per-request");
  }
  expect(c.lookup("google", "gemini-3.1-pro-preview")!.tier!.source).toContain("prompts > 200k");
});

test("ratesFor: under the threshold nothing changes; over it the WHOLE request reprices, output included", () => {
  const c = new ModelCatalog();
  const gem = c.lookup("google", "gemini-3.1-pro-preview")!;

  const under = ratesFor(gem, 200_000);           // exactly at the threshold is still the low tier ("<= 200k")
  expect(under).toMatchObject({ mode: "per-request", tierApplied: false, promptBase: 200_000, promptAbove: 0 });
  expect(under.request.inputPerMTok).toBe(2);
  expect(under.request.outputPerMTok).toBe(12);

  const over = ratesFor(gem, 200_001);
  expect(over).toMatchObject({ tierApplied: true, promptBase: 0, promptAbove: 200_001 });
  expect(over.request.inputPerMTok).toBe(4);
  expect(over.request.outputPerMTok).toBe(18);    // the output of a long-prompt request costs more too
  // the whole prompt at the high rate, NOT 200k low + 1 high — the expensive difference, stated as a number
  expect(over.promptAbove * over.above!.inputPerMTok! / 1e6).toBeCloseTo(0.800004, 6);

  const grok = ratesFor(c.lookup("xai", "grok-4.6")!, 500_000);
  expect(grok.request).toMatchObject({ inputPerMTok: 4, outputPerMTok: 12, cacheReadPerMTok: 1 });
});

test("ratesFor on a flat model is the trivial split, so a caller never has to branch on whether a tier exists", () => {
  const c = new ModelCatalog();
  const flat = ratesFor(c.lookup("anthropic", "claude-opus-5")!, 900_000);
  expect(flat).toMatchObject({ mode: "flat", tierApplied: false, promptBase: 900_000, promptAbove: 0 });
  expect(flat.above).toBeUndefined();
  expect(flat.request.inputPerMTok).toBe(5);
  // an unpriced model yields empty rate tables rather than throwing
  expect(ratesFor({ provider: "x", model: "y" }, 10).request).toEqual({});
});

test("ratesFor cannot produce a negative or fractional bill from a junk token count", () => {
  const c = new ModelCatalog();
  const gem = c.lookup("google", "gemini-2.5-pro")!;
  for (const bad of [-1, -1e9, Number.NaN, Number.POSITIVE_INFINITY]) {
    const r = ratesFor(gem, bad);
    expect(r.promptBase).toBe(0);
    expect(r.promptAbove).toBe(0);
    expect(r.tierApplied).toBe(false);
  }
  expect(ratesFor(gem, 200_000.7).promptBase).toBe(200_000); // floored, never a fractional token
});
