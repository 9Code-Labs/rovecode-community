/** src/market/context-cost.ts — what an item costs you in context, said before the yes.
 *
 *  The test that matters is the first one. Claude Code shows a single "tokens added per turn" figure, and
 *  copying that shape would have been wrong here: rovecode's skills are progressive disclosure, so the
 *  index line is in every prompt and the body only arrives if the model opens the skill. Measured across
 *  the 19 skills that ship, the body is 29× the index line — so one combined "per turn" number would
 *  overstate a skill nobody opens by that factor. A reader who checked it once would never read the line
 *  again, and a line nobody reads is worse than no line.
 *
 *  The rest is about saying "not known" where it is not known, rather than producing a number. */

import { tokenScaleFor } from "../../src/core/token-scale.ts";
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { contextCostLines, contextCostOf } from "../../src/market/context-cost.ts";
import { itemFromCatalog } from "../../src/market/registry.ts";
import { INDEX_PROMPT_LIMIT } from "../../src/skills/tools.ts";
import { countTokens } from "../../src/core/usage.ts";
import type { MarketItem } from "../../src/market/types.ts";

const CATALOGS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "market", "catalogs");
const load = (kind: "skill" | "plugin", file: string, id: string): MarketItem => {
  const doc = JSON.parse(readFileSync(join(CATALOGS, `${file}.json`), "utf8")) as { items: Record<string, unknown>[] };
  return itemFromCatalog(kind, doc.items.find((i) => i["id"] === id)!, [])!;
};

test("a skill's per-turn cost is the index line, not the body — they are an order of magnitude apart", () => {
  const item = load("skill", "skills", "pdf");
  const c = contextCostOf(item)!;

  // the index line is what buildSkillsIndex puts in the system prompt, and it is small
  expect(c.perTurn).toBeGreaterThan(0);
  expect(c.perTurn).toBeLessThan(200);
  // the body is what arrives only on skill_view, and it is not small
  expect(c.whenUsed!).toBeGreaterThan(1000);
  expect(c.whenUsed! / c.perTurn).toBeGreaterThan(10);

  // and the two are reported separately, in those words
  const lines = contextCostLines(c);
  expect(lines[0]).toContain("every turn");
  expect(lines[0]).toContain("when the model opens it");
});

/** The measurement behind the design decision, kept as a test so it cannot quietly stop being true: if a
 *  future change made bodies small, or index lines large, the single-number shape would become defensible
 *  and this file's whole argument would need revisiting. */
test("across the catalog that ships, bodies dwarf index lines", () => {
  const doc = JSON.parse(readFileSync(join(CATALOGS, "skills.json"), "utf8")) as { items: Record<string, unknown>[] };
  let index = 0, body = 0;
  for (const raw of doc.items) {
    const c = contextCostOf(itemFromCatalog("skill", raw, [])!)!;
    index += c.perTurn;
    body += c.whenUsed ?? 0;
  }
  expect(index / doc.items.length).toBeLessThan(150);       // ~79 today
  expect(body / doc.items.length).toBeGreaterThan(1000);    // ~2288 today
  expect(body / index).toBeGreaterThan(10);                 // ~29× today
});

test("the index line counted is the one the prompt would actually carry", () => {
  const item = load("skill", "skills", "pdf");
  // skills/tools.ts renderIndexLine: `- name (vX): description`
  const expected = countTokens(`- ${item.id}${item.version ? ` (v${item.version})` : ""}: ${item.description}`);
  expect(contextCostOf(item)!.perTurn).toBe(expected);
});

// ------------------------------------------------------------------ what cannot be known

/** An MCP server reports its tools when it connects. There is no honest number before that, and a made-up
 *  one would be the fastest way to make every other number here untrustworthy. */
test("an MCP item gets no figure at all, and says why", () => {
  const item = { id: "x", kind: "mcp", title: "X", publisher: "p", description: "d", source: "curated",
                 tags: [], env: [], install: { kind: "mcp", entry: {} } } as unknown as MarketItem;
  const c = contextCostOf(item)!;
  expect(c.perTurn).toBe(0);
  expect(c.whenUsed).toBeUndefined();
  expect(c.unknown).toContain("connects");
  const lines = contextCostLines(c);
  expect(lines.join(" ")).not.toMatch(/~\d/);              // no number anywhere in the output
});

test("a plugin gets no figure either: its tools need the code loaded and its files are not in the catalog", () => {
  const c = contextCostOf(load("plugin", "plugins", "notes"))!;
  expect(c.perTurn).toBe(0);
  expect(c.unknown).toContain("loaded");
  expect(contextCostLines(c).join(" ")).not.toMatch(/~\d/);
});

test("a skill whose body the catalog does not carry reports the index line and says the rest is unknown", () => {
  const item = { ...load("skill", "skills", "pdf") };
  delete (item as { docs?: unknown }).docs;
  const c = contextCostOf(item)!;
  expect(c.perTurn).toBeGreaterThan(0);
  expect(c.whenUsed).toBeUndefined();
  expect(c.unknown).toContain("not carried in the catalog");
});

// ------------------------------------------------------------------ the estimate is labelled

/** o200k_base is not the model's tokenizer, so the numbers are scaled by a MEASURED factor per model
 *  generation rather than hedged in prose. An earlier draft said "reads roughly a third low on Anthropic
 *  models", which was already wrong for Claude 4.5 (1.21x) the moment the table had two generations in
 *  it — a hand-written caveat about models is wrong again every time a model ships. */
test("a named model scales the numbers by its measured factor, and says where the factor came from", () => {
  const item = load("skill", "skills", "pdf");
  const plain = contextCostOf(item)!;
  const c5 = contextCostLines(contextCostOf(item, { model: { provider: "anthropic", model: "claude-sonnet-5" } }));
  const h45 = contextCostLines(contextCostOf(item, { model: { provider: "anthropic", model: "claude-haiku-4-5" } }));

  expect(c5[0]).toMatch(/scaled|tokens every turn/);
  expect(c5[1]).toContain("count_tokens");                       // the provenance, not an adjective
  // the digits come from the table, not from this file: they move whenever the measurement is rerun
  // (they already have — the sample set grew and 1.59 became 1.80), and a test that restates them
  // fails on a correct change while proving nothing about the behaviour it is meant to guard.
  expect(c5[1]).toContain(String(tokenScaleFor({ provider: "anthropic", model: "claude-sonnet-5" }).scale));
  expect(h45[1]).toContain(String(tokenScaleFor({ provider: "anthropic", model: "claude-haiku-4-5" }).scale));
  expect(tokenScaleFor({ provider: "anthropic", model: "claude-haiku-4-5" }).scale)
    .not.toBe(tokenScaleFor({ provider: "anthropic", model: "claude-sonnet-5" }).scale); // different generation, different factor
  expect(c5[0]).not.toBe(h45[0]);                                // and therefore different numbers

  // the scaled figure really is larger than the raw one
  const scaled = Number(/~(\d+) tokens/.exec(c5[0]!)![1]);
  expect(scaled).toBeGreaterThan(plain.perTurn);
});

test("OpenAI is not scaled, because o200k is its own tokenizer", () => {
  const lines = contextCostLines(contextCostOf(load("skill", "skills", "pdf"), { model: { provider: "openai", model: "gpt-5" } }));
  expect(lines[1]).toContain("exact");
  expect(lines[1]).not.toContain("scaled");
});

/** A model nobody measured gets no factor — never a neighbour's, which would be a guess wearing a
 *  measurement's clothes. */
test("an unmeasured model is left unscaled and says there is no measurement", () => {
  const item = load("skill", "skills", "pdf");
  const raw = contextCostOf(item)!;
  const lines = contextCostLines(contextCostOf(item, { model: { provider: "deepseek", model: "deepseek-v4" } }));
  expect(lines[0]).toContain(`~${raw.perTurn} tokens`);
  expect(lines[1]).toContain("no measurement");
});

test("with no model named the numbers are unscaled and the line admits it", () => {
  const lines = contextCostLines(contextCostOf(load("skill", "skills", "pdf")));
  expect(lines[1]).toContain("no model was named");
});

// ------------------------------------------------------------------ the index limit

/** Installing the 51st skill does not just cost the 51st skill: the index leaves the prompt for ALL of
 *  them and the model has to ask for a list. That is a change to what the user already has, so it is said
 *  at the moment they can still decide. */
test("crossing the skill index limit is called out as changing the cost of every skill", () => {
  const item = load("skill", "skills", "pdf");
  expect(contextCostOf(item, { installedSkills: INDEX_PROMPT_LIMIT - 2 })!.overIndexLimit).toBeUndefined();
  const over = contextCostOf(item, { installedSkills: INDEX_PROMPT_LIMIT })!;
  expect(over.overIndexLimit).toBe(true);
  expect(contextCostLines(over).join(" ")).toContain("every skill you have");
});

test("with no count of installed skills, no limit claim is made", () => {
  expect(contextCostOf(load("skill", "skills", "pdf"))!.overIndexLimit).toBeUndefined();
});

test("nothing to say produces no lines, not an empty one", () => {
  expect(contextCostLines(undefined)).toEqual([]);
});
