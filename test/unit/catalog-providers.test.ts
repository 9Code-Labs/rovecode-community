/** The models.dev snapshot (@opencode-ai/models) as rovecode reads it: the built-in providers' default models
 *  must price (cost accounting, `rovecode model show`), and the vendor ids people register by hand for their
 *  own endpoints resolve too. Also the one place that says which snapshot version the numbers were checked at. */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { providers as snapshot } from "@opencode-ai/models/snapshot";
import { ModelCatalog } from "../../src/providers/catalog.ts";

test("snapshot 0.0.64: the models we default to are priced with a reasoning flag; the manual vendor ids resolve", () => {
  const pkg = JSON.parse(readFileSync(new URL("../../node_modules/@opencode-ai/models/package.json", import.meta.url), "utf8")) as { version: string };
  expect(pkg.version).toBe("0.0.64");
  const c = new ModelCatalog();
  const opus = c.lookup("anthropic", "claude-opus-5")!;
  expect(opus).toMatchObject({ contextWindow: 1_000_000, maxOutput: 128_000, supportsReasoning: true, pricing: { inputPerMTok: 5, outputPerMTok: 25, cacheReadPerMTok: 0.5, cacheWritePerMTok: 6.25 } });
  expect(c.lookup("anthropic", "claude-sonnet-5")!.pricing).toMatchObject({ inputPerMTok: 2, outputPerMTok: 10 });
  expect(c.lookup("anthropic", "claude-haiku-4-5")!.pricing).toMatchObject({ inputPerMTok: 1, outputPerMTok: 5 });
  expect(c.lookup("openai", "gpt-5.2")).toMatchObject({ supportsReasoning: true, pricing: { inputPerMTok: 1.75, outputPerMTok: 14 } });
  expect(c.lookup("openai", "gpt-4o")!.supportsReasoning).toBe(false); // what thinking.ts leans on: no dial to a model without a mode
  expect(c.lookup("kaesra", "zai-org/glm-5.3-flash")).toMatchObject({ provider: "zai", supportsReasoning: true, pricing: { inputPerMTok: 0.075, outputPerMTok: 0.25 } }); // vendor prefix → zai
  // the hand-registered vendor ids (PROVIDER_MAP additions)
  expect(c.lookup("zai", "glm-5.3")).toMatchObject({ supportsReasoning: true });
  expect(c.lookup("google", "gemini-2.5-pro")).toMatchObject({ supportsReasoning: true });
  expect(c.lookup("gemini", "gemini-2.5-flash")).toBeDefined();
  expect(c.lookup("moonshot", "kimi-k2.5")).toBeDefined();
  expect(c.lookup("alibaba", "qwen3-235b-a22b")).toBeDefined();
  const anyMinimax = Object.keys((snapshot as Record<string, { models: Record<string, unknown> }>).minimax!.models)[0]!;
  expect(c.lookup("minimax", anyMinimax)).toBeDefined();
  // gaps at this snapshot — DeepSeek's API aliases and grok-4 are not listed — are filled by rovecode's own table (catalog-local.ts)
  expect(c.lookup("deepseek", "deepseek-chat")!.source).toBe("local");
  expect(c.lookup("deepseek", "deepseek-v4-pro")!.source).toBe("local"); // overridden 2026-09-05: models.dev carries ~1/3 of the vendor page price
  expect(c.lookup("xai", "grok-4")!.source).toBe("local");
  expect(new ModelCatalog({ local: {} }).lookup("xai", "grok-4")).toBeUndefined(); // the snapshot alone still lacks it
});
