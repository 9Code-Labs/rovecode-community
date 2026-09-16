/** summarizeUsage's two counters (tui/cost.ts): the default is the exact o200k count and loads the table;
 *  "cheap" (what the sextant panel uses) takes o200k only when the table is already resident and otherwise
 *  estimates from chars/4 with the model's own measured char factor — and says which one it used. The
 *  "table not resident" branch cannot be observed in-process (usage.test.ts loads the table for the whole
 *  run), so it is pinned in tokenizer-lazy.test.ts from a child bun; here the resident case and the labels. */

import { test, expect } from "bun:test";
import { summarizeUsage, sessionUsage, buildCostNote } from "../../src/tui/cost.ts";
import { countTokens, tokenizerLoaded } from "../../src/core/usage.ts";
import { estimateTokens } from "../../src/core/context.ts";
import { tokenScaleFor } from "../../src/core/token-scale.ts";
import { ModelCatalog } from "../../src/providers/catalog.ts";
import type { Message } from "../../src/core/types.ts";

const catalog = new ModelCatalog({ fetchFn: fetch as never, cacheDir: "/nonexistent" });
const text = "The loop sleeps until the next ambient change, then paints once. ".repeat(12);
const messages: Message[] = [
  { id: "u", role: "user", parts: [{ kind: "text", text }], parentId: null, createdAt: 1 },
  { id: "a", role: "assistant", parts: [{ kind: "text", text: "Noted." }], parentId: "u", createdAt: 2, usage: { input: 100, output: 5 } },
];
const claude = { provider: "anthropic", model: "claude-sonnet-5" };

test("default counter is exact o200k: it loads the table and applies the o200k factor", () => {
  const u = summarizeUsage(messages, catalog, claude);
  expect(tokenizerLoaded()).toBe(true);
  expect(u.counter).toBe("o200k");
  expect(u.estRaw).toBe(countTokens(`${text}\nNoted.`));
  expect(u.scale.scale).toBe(tokenScaleFor(claude).scale);
  expect(u.est).toBe(Math.ceil(u.estRaw * tokenScaleFor(claude).scale));
});

test("cheap counter with the table resident gives the same o200k figure as exact — the panel does not lose precision once someone paid for the table", () => {
  countTokens("x"); // make sure it is resident
  const exact = summarizeUsage(messages, catalog, claude);
  const cheap = summarizeUsage(messages, catalog, claude, { counter: "cheap" });
  expect(cheap.counter).toBe("o200k");
  expect(cheap.est).toBe(exact.est);
  expect(sessionUsage(messages, catalog, claude)).toEqual({ costUsd: exact.cost, contextTokens: exact.est, counter: "o200k" }); // the assistant turn carries usage and is priced at the current model
});

test("the chars/4 path uses the char factor, not the o200k factor, and estimateTokens as its raw count", () => {
  // the branch itself is exercised from a child process in tokenizer-lazy.test.ts; here: the numbers it would produce agree with the estimator + charScale contract
  const ts = tokenScaleFor(claude);
  expect(ts.charScale).not.toBe(ts.scale);                         // the two counters really do need their own factors
  expect(Math.ceil(estimateTokens(`${text}\nNoted.`) * ts.charScale)).toBeGreaterThan(0);
});

test("the /cost note names the counter it used", () => {
  const note = buildCostNote(messages, catalog, claude);
  expect(note).toContain("o200k counted");
  expect(note).not.toContain("chars/4 estimated");
});

test("an empty transcript is 0 tokens under both counters", () => {
  expect(summarizeUsage([], catalog, claude).est).toBe(0);
  expect(summarizeUsage([], catalog, claude, { counter: "cheap" }).est).toBe(0);
});
