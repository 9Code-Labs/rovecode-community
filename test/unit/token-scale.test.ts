/** token-scale: the measured correction between our estimate and a model's own tokenizer.
 *
 *  The table's value is entirely in its provenance, so what is pinned here is not the digits — those
 *  will move when someone reruns the measurement — but the properties that make a correction safe:
 *  an unmeasured model is left alone and says so, a correction never rounds a budget upward, and the
 *  direction is always towards more tokens, because the two errors are not symmetric. */

import { describe, expect, it } from "bun:test";
import { scaleEstimate, tokenScaleFor } from "../../src/core/token-scale.ts";
import { contextBudgetFor } from "../../src/core/context-report.ts";

describe("tokenScaleFor", () => {
  it("corrects Claude 5, whose tokenizer counts about half again what o200k does", () => {
    const s = tokenScaleFor({ provider: "anthropic", model: "claude-opus-5" });
    expect(s.measured).toBe(true);
    expect(s.scale).toBeGreaterThan(1.4);
    expect(s.note).toContain("measured 2026-09-05");
  });

  it("gives Opus 5 and Sonnet 5 the same factor — they returned identical counts on every sample", () => {
    expect(tokenScaleFor({ provider: "anthropic", model: "claude-opus-5" }).scale)
      .toBe(tokenScaleFor({ provider: "anthropic", model: "claude-sonnet-5" }).scale);
  });

  it("does not apply the 5-generation factor to 4.5, which is a different tokenizer", () => {
    const five = tokenScaleFor({ provider: "anthropic", model: "claude-opus-5" }).scale;
    const older = tokenScaleFor({ provider: "anthropic", model: "claude-haiku-4-5-20251001" });
    expect(older.measured).toBe(true);
    expect(older.scale).toBeLessThan(five);
    expect(older.scale).toBeGreaterThan(1);
  });

  it("leaves OpenAI alone — o200k is that vendor's own tokenizer", () => {
    const s = tokenScaleFor({ provider: "openai", model: "gpt-5.5" });
    expect(s).toMatchObject({ scale: 1, measured: true });
    expect(s.note).toContain("exact");
  });

  it("does not borrow a neighbour's factor for a model nobody measured", () => {
    for (const ref of [
      { provider: "google", model: "gemini-3.1-pro-preview" },
      { provider: "deepseek", model: "deepseek-v4-pro" },
      { provider: "anthropic", model: "claude-some-future-model" },
      { provider: "openrouter", model: "anthropic/claude-opus-5" }, // same model, but not measured through this route
    ]) {
      const s = tokenScaleFor(ref);
      expect(s.scale).toBe(1);
      expect(s.measured).toBe(false);
      expect(s.note).toContain("no measurement");
    }
  });

  it("matches on the model id whatever its case, and tolerates a dated snapshot suffix", () => {
    expect(tokenScaleFor({ provider: "Anthropic", model: "CLAUDE-SONNET-5-20260101" }).measured).toBe(true);
  });
});

describe("charScale — the other estimator's number", () => {
  it("is what the budget uses, because the budget is compared against chars/4, not o200k", () => {
    // this is the whole reason the field exists: one scale for two different approximations would be
    // right for at most one of them, and wrong in the direction that overflows the window
    const ref = { provider: "anthropic", model: "claude-haiku-4-5" };
    const s = tokenScaleFor(ref);
    expect(s.charScale).toBeGreaterThan(s.scale);
    const budget = contextBudgetFor({ window: 200_000, maxOutput: 8_000, scale: s.charScale });
    expect(budget).toBeLessThan(contextBudgetFor({ window: 200_000, maxOutput: 8_000, scale: s.scale }));
  });

  it("is present on every row, measured or not — a caller never has to check which", () => {
    for (const ref of [
      { provider: "anthropic", model: "claude-opus-5" },
      { provider: "anthropic", model: "claude-haiku-4-5" },
      { provider: "openai", model: "gpt-5.5" },
      { provider: "google", model: "gemini-3.1-pro-preview" },
    ]) {
      const s = tokenScaleFor(ref);
      expect(s.charScale).toBeGreaterThanOrEqual(1);
      expect(Number.isFinite(s.charScale)).toBe(true);
    }
  });

  it("leaves an unmeasured model at 1 on both scales rather than borrowing one for the other", () => {
    const s = tokenScaleFor({ provider: "deepseek", model: "deepseek-v4-pro" });
    expect(s).toMatchObject({ scale: 1, charScale: 1, measured: false });
  });
});

describe("scaleEstimate", () => {
  it("rounds up — a token of slack costs nothing, a token of shortfall loses the turn", () => {
    const { scale } = tokenScaleFor({ provider: "anthropic", model: "claude-opus-5" });
    expect(scaleEstimate(1000, { provider: "anthropic", model: "claude-opus-5" })).toBe(Math.ceil(1000 * scale));
    expect(scaleEstimate(1, { provider: "anthropic", model: "claude-opus-5" })).toBeGreaterThanOrEqual(2);
  });

  it("is the identity for an unmeasured model", () => {
    expect(scaleEstimate(4321, { provider: "google", model: "gemini-3.1-pro-preview" })).toBe(4321);
  });
});

describe("contextBudgetFor with a scale", () => {
  it("shrinks the budget, because the budget is compared against the estimate", () => {
    const plain = contextBudgetFor({ window: 1_000_000, maxOutput: 128_000 });
    const scaled = contextBudgetFor({ window: 1_000_000, maxOutput: 128_000, scale: 1.59 });
    expect(scaled).toBe(Math.floor(plain / 1.59));
    expect(scaled).toBeLessThan(plain);
  });

  it("dividing the budget is equivalent to inflating every estimate", () => {
    // the property that justifies doing this in one place instead of at every call site
    const window = 400_000, maxOutput = 32_000, scale = 1.59, history = 120_000;
    const scaledBudget = contextBudgetFor({ window, maxOutput, scale });
    const plainBudget = contextBudgetFor({ window, maxOutput });
    expect(history > scaledBudget).toBe(Math.ceil(history * scale) > plainBudget);
  });

  it("a scale of 1, an absent scale and a nonsense scale all mean the same thing", () => {
    const base = contextBudgetFor({ window: 200_000 });
    for (const scale of [1, 0, -2, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(contextBudgetFor({ window: 200_000, scale })).toBe(base);
    }
  });

  it("an explicit override is the user's number and is never scaled", () => {
    expect(contextBudgetFor({ window: 1_000_000, override: 50_000, scale: 1.59 })).toBe(50_000);
  });

  it("never returns a budget below 1, however large the scale", () => {
    expect(contextBudgetFor({ window: 40_000, maxOutput: 32_000, scale: 1000 })).toBeGreaterThanOrEqual(1);
  });
});
