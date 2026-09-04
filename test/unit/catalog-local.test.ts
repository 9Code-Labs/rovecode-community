/** rovecode's own price table (providers/catalog-local.ts) behind the models.dev snapshot: every entry resolves
 *  with its numbers and `source: "local"` plus the page-and-date note; a model the snapshot HAS is never shadowed
 *  by an overlay row (a later snapshot wins by construction); `rovecode model show` names the source. */

import { expect, test } from "bun:test";
import { ModelCatalog } from "../../src/providers/catalog.ts";
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
  expect(c.lookup("xai", "grok-4")).toMatchObject({ source: "local", pricing: { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.75 }, supportsReasoning: true });
  expect(c.lookup("xai", "grok-4-fast-non-reasoning")!.supportsReasoning).toBe(false); // thinking.ts sends nothing to it
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
