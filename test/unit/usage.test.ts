import { test, expect } from "bun:test";
import { countTokens, normalizeUsage, costUsd, contextHealth } from "../../src/core/usage.ts";

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
