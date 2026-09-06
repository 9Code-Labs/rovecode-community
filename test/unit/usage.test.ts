import { describe, test, expect } from "bun:test";
import { contextHealth, costUsd, costUsdTiered, countTokens, normalizeUsage } from "../../src/core/usage.ts";

// ---------- countTokens (gpt-tokenizer o200k_base, sync) ----------

test("countTokens: known short strings under o200k_base", () => {
  expect(countTokens("")).toBe(0);
  expect(countTokens("hello")).toBe(1);
  expect(countTokens("hello world")).toBe(2);
  expect(countTokens("The quick brown fox jumps over the lazy dog.")).toBe(10);
});

test("countTokens: longer text costs more tokens", () => {
  const short = "a paragraph of text";
  expect(countTokens(short.repeat(20))).toBeGreaterThan(countTokens(short));
});

// ---------- normalizeUsage ----------

test("normalizeUsage: Anthropic shape maps 1:1 (input_tokens already excludes cache fields)", () => {
  expect(
    normalizeUsage({
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 300,
      cache_creation_input_tokens: 50,
    }),
  ).toEqual({ input: 100, output: 20, cacheRead: 300, cacheWrite: 50 });
});

test("normalizeUsage: Anthropic shape without cache fields", () => {
  expect(normalizeUsage({ input_tokens: 7, output_tokens: 3 })).toEqual({
    input: 7,
    output: 3,
    cacheRead: 0,
    cacheWrite: 0,
  });
});

test("normalizeUsage: OpenAI prompt_tokens INCLUDES cached_tokens → cached share subtracted", () => {
  expect(
    normalizeUsage({
      prompt_tokens: 1000,
      completion_tokens: 40,
      prompt_tokens_details: { cached_tokens: 600 },
    }),
  ).toEqual({ input: 400, output: 40, cacheRead: 600, cacheWrite: 0 });
});

test("normalizeUsage: OpenAI shape without cache details", () => {
  expect(normalizeUsage({ prompt_tokens: 1000, completion_tokens: 40 })).toEqual({
    input: 1000,
    output: 40,
    cacheRead: 0,
    cacheWrite: 0,
  });
});

test("normalizeUsage: OpenAI cached > prompt clamps input at 0 (never negative)", () => {
  expect(
    normalizeUsage({ prompt_tokens: 100, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 150 } }),
  ).toEqual({ input: 0, output: 1, cacheRead: 150, cacheWrite: 0 });
});

test("normalizeUsage: OpenRouter dual-spelling payload bills the cached share exactly once", () => {
  // gateways like OpenRouter emit BOTH field spellings in one payload; detection keyed on the
  // ABSENCE of input_tokens would skip the subtraction and bill 1600 for a 1000-token prompt.
  // 1000 prompt tokens with 600 cached must normalize to 400 base + 600 cacheRead = 1000 total.
  const u = normalizeUsage({
    prompt_tokens: 1000,
    completion_tokens: 40,
    input_tokens: 1000,
    output_tokens: 40,
    prompt_tokens_details: { cached_tokens: 600 },
  });
  expect(u).toEqual({ input: 400, output: 40, cacheRead: 600, cacheWrite: 0 });
  expect(u.input + u.cacheRead).toBe(1000); // never 1600
});

test("normalizeUsage: OpenAI Responses shape (input_tokens_details) subtracts its cached share too", () => {
  expect(
    normalizeUsage({ input_tokens: 1000, output_tokens: 40, input_tokens_details: { cached_tokens: 600 } }),
  ).toEqual({ input: 400, output: 40, cacheRead: 600, cacheWrite: 0 });
});

test("normalizeUsage: Anthropic cache spelling + mirrored *_details block stays cache-EXCLUSIVE (no double subtraction)", () => {
  // #5 re-verify (FW2-N): a gateway that keeps Anthropic spellings but mirrors the cached share
  // into an OpenAI *_details block must NOT flip the base to "cache-inclusive" — input_tokens
  // (400) already excludes the 600 cached; subtracting again clamps input to 0 and /cost
  // under-reports the whole base share.
  expect(
    normalizeUsage({ input_tokens: 400, cache_read_input_tokens: 600, prompt_tokens_details: { cached_tokens: 600 } }),
  ).toEqual({ input: 400, output: 0, cacheRead: 600, cacheWrite: 0 });
});

test("normalizeUsage: junk and malformed payloads normalize to zeros", () => {
  const zeros = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  expect(normalizeUsage(undefined)).toEqual(zeros);
  expect(normalizeUsage(null)).toEqual(zeros);
  expect(normalizeUsage("nonsense")).toEqual(zeros);
  expect(normalizeUsage(42)).toEqual(zeros);
  expect(normalizeUsage({})).toEqual(zeros);
  expect(normalizeUsage({ input_tokens: -5, output_tokens: Number.NaN })).toEqual(zeros);
});

// ---------- costUsd ----------

test("costUsd: arithmetic across all four components", () => {
  const u = { input: 1_000_000, output: 500_000, cacheRead: 2_000_000, cacheWrite: 100_000 };
  const p = { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75 };
  // 3 + 7.5 + 0.6 + 0.375
  expect(costUsd(u, p)).toBeCloseTo(11.475, 9);
});

test("costUsd: missing rate for a NONZERO component → undefined", () => {
  const u = { input: 1_000_000, output: 500_000, cacheRead: 2_000_000, cacheWrite: 100_000 };
  expect(costUsd(u, { inputPerMTok: 3, outputPerMTok: 15, cacheWritePerMTok: 3.75 })).toBeUndefined();
  expect(costUsd(u, { inputPerMTok: 3, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75 })).toBeUndefined();
  expect(costUsd(u, {})).toBeUndefined();
});

test("costUsd: zero components never require a rate", () => {
  const u = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 };
  expect(costUsd(u, { inputPerMTok: 2, outputPerMTok: 4 })).toBeCloseTo(0.00004, 12); // 2e-5 + 2e-5
});

test("costUsd: all-zero usage costs 0 even with empty pricing", () => {
  expect(costUsd({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, {})).toBe(0);
});

test("costUsd: cache read/write pricing applied to the right components", () => {
  const p = { inputPerMTok: 1, outputPerMTok: 1, cacheReadPerMTok: 0.1, cacheWritePerMTok: 1.25 };
  // isolate each cache component to pin its multiplier
  expect(costUsd({ input: 0, output: 0, cacheRead: 1_000_000, cacheWrite: 0 }, p)).toBeCloseTo(0.1, 12);
  expect(costUsd({ input: 0, output: 0, cacheRead: 0, cacheWrite: 1_000_000 }, p)).toBeCloseTo(1.25, 12);
});

// ---------- contextHealth ----------

test("contextHealth: nearLimit trips at exactly 0.8, not below", () => {
  expect(contextHealth(800, 1000)).toEqual({ fraction: 0.8, nearLimit: true });
  const below = contextHealth(799, 1000);
  expect(below.fraction).toBeCloseTo(0.799, 12);
  expect(below.nearLimit).toBe(false);
});

test("contextHealth: empty and overflowing windows", () => {
  expect(contextHealth(0, 1000)).toEqual({ fraction: 0, nearLimit: false });
  expect(contextHealth(1500, 1000)).toEqual({ fraction: 1.5, nearLimit: true }); // unclamped overflow
});

test("contextHealth: degenerate window reports full (compact rather than overflow)", () => {
  expect(contextHealth(10, 0)).toEqual({ fraction: 1, nearLimit: true });
  expect(contextHealth(10, -5)).toEqual({ fraction: 1, nearLimit: true });
  expect(contextHealth(10, Number.NaN)).toEqual({ fraction: 1, nearLimit: true });
});

test("contextHealth: negative/NaN usedTokens counts as 0", () => {
  expect(contextHealth(-50, 100)).toEqual({ fraction: 0, nearLimit: false });
  expect(contextHealth(Number.NaN, 100)).toEqual({ fraction: 0, nearLimit: false });
});

describe("costUsdTiered", () => {
  const base = { inputPerMTok: 1.25, outputPerMTok: 2.5, cacheReadPerMTok: 0.2, cacheWritePerMTok: 1 };
  const above = { inputPerMTok: 2.5, outputPerMTok: 5, cacheReadPerMTok: 0.4, cacheWritePerMTok: 2 };

  test("prices a flat model exactly like costUsd", () => {
    const u = { input: 1_000, output: 500, cacheRead: 10_000, cacheWrite: 100 };
    const flat = costUsd(u, base);
    expect(costUsdTiered(u, { promptBase: 11_100, promptAbove: 0, base, request: base })).toBeCloseTo(flat!, 12);
  });

  test("bills the WHOLE request at the upper rate when a per-request tier applies", () => {
    // xAI: a prompt over the threshold re-prices every token of the request, output included
    const u = { input: 250_000, output: 1_000, cacheRead: 0, cacheWrite: 0 };
    const tiered = costUsdTiered(u, { promptBase: 0, promptAbove: 250_000, base, above, request: above });
    expect(tiered).toBeCloseTo((250_000 * 2.5 + 1_000 * 5) / 1e6, 12);
    expect(tiered).toBeGreaterThan(costUsd(u, base)!); // the old flat math under-charged
  });

  test("splits the prompt in proportion for a marginal tier and leaves output on the request table", () => {
    const u = { input: 100_000, output: 1_000, cacheRead: 100_000, cacheWrite: 0 };
    // half the prompt over the threshold
    const c = costUsdTiered(u, { promptBase: 100_000, promptAbove: 100_000, base, above, request: above });
    const expected = (50_000 * 1.25 + 50_000 * 2.5 + 50_000 * 0.2 + 50_000 * 0.4 + 1_000 * 5) / 1e6;
    expect(c).toBeCloseTo(expected, 12);
  });

  test("returns undefined when a rate a nonzero component needs is missing", () => {
    const u = { input: 10, output: 0, cacheRead: 5, cacheWrite: 0 };
    expect(costUsdTiered(u, { promptBase: 15, promptAbove: 0, base: { inputPerMTok: 1 }, request: { inputPerMTok: 1 } })).toBeUndefined();
    // zero components never need a rate
    expect(costUsdTiered({ input: 10, output: 0, cacheRead: 0, cacheWrite: 0 }, { promptBase: 10, promptAbove: 0, base: { inputPerMTok: 1 }, request: {} })).toBeCloseTo(1e-5, 12);
  });
});
