/** P0-3: unified tool-output budget policy (src/core/tool-output-budget.ts).
 *  Pins: byte-verbatim passthrough at/under the cap; head+tail cut over the cap with the
 *  marker carrying the numbers; UTF-8/grapheme-safe boundaries (no lone surrogates, no
 *  split combining marks / ZWJ sequences / flag pairs); per-tool overrides where the
 *  tighter cap wins; idempotence. */

import { test, expect } from "bun:test";
import {
  createOutputBudget, applyBudget, DEFAULT_OUTPUT_CAP, TRUNCATION_MARK,
  type TruncatedOutput,
} from "../../src/core/tool-output-budget.ts";
import { estimateTokens } from "../../src/core/context.ts";

/** no lone surrogates and no replacement chars introduced by the cut */
const FFFD = String.fromCodePoint(0xFFFD);
function utf8Clean(s: string): boolean {
  return !s.includes(FFFD) && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);
}

function headOf(r: TruncatedOutput): string {
  const i = r.text.indexOf(TRUNCATION_MARK);
  return i < 0 ? r.text : r.text.slice(0, i).replace(/\n+$/, "");
}
function tailOf(r: TruncatedOutput): string {
  const i = r.text.indexOf("…]");
  return i < 0 ? "" : r.text.slice(i + 2).replace(/^\n+/, "");
}

// ---------- passthrough ----------

test("small outputs pass BYTE-VERBATIM: same content, no marker, zero stats", () => {
  const budget = createOutputBudget();
  const small = "value=42\n".repeat(10);
  const r = budget.apply("bash", small);
  expect(r.text).toBe(small);
  expect(r.truncated).toBe(false);
  expect(r.originalChars).toBe(small.length);
  expect(r.keptChars).toBe(small.length);
  expect(r.estTokensCut).toBe(0);
  // exactly AT the cap is still verbatim (the cut starts one char over)
  const atCap = "x".repeat(DEFAULT_OUTPUT_CAP);
  expect(budget.apply("bash", atCap).truncated).toBe(false);
  expect(budget.apply("bash", atCap + "y").truncated).toBe(true);
});

test("an empty output and a control message (abort/permission) pass untouched", () => {
  const budget = createOutputBudget();
  for (const s of ["", "Tool execution aborted", "Permission denied: denied by rule shell.exec rm *"]) {
    const r = budget.apply("bash", s);
    expect(r.text).toBe(s);
    expect(r.truncated).toBe(false);
  }
});

// ---------- head+tail cut ----------

test("over-cap output keeps head AND tail, drops the middle, and the marker names what was cut", () => {
  const cap = 4_000;
  const body = Array.from({ length: 500 }, (_, i) => `line ${String(i).padStart(4, "0")} ${"abcdefgh".repeat(10)}`).join("\n");
  const r = applyBudget(body, cap);
  expect(r.truncated).toBe(true);
  expect(r.keptChars).toBeLessThanOrEqual(cap);
  expect(r.text.length).toBeLessThanOrEqual(cap);
  expect(r.originalChars).toBe(body.length);
  expect(headOf(r)).toContain("line 0000");          // head preserved
  expect(tailOf(r)).toContain("line 0499");          // tail preserved
  expect(r.text).not.toContain("line 0250");         // middle gone
  expect(r.text).toContain(TRUNCATION_MARK);
  // the marker carries the honest numbers: removed chars + their estimate in the loop's unit (chars/4)
  const removedChars = r.originalChars - r.keptChars;
  expect(r.text).toContain(`${removedChars}`);
  expect(r.text).toContain(`${estimateTokens("x".repeat(removedChars))}`);
  expect(r.estTokensCut).toBe(estimateTokens("x".repeat(removedChars)));
  // continuation hint: the model is told how to see the middle
  expect(r.text).toMatch(/narrower|offset|range/i);
});

test("head share is honored: default keeps more head than tail; 0.5 balances", () => {
  const body = "H".repeat(20_000) + "T".repeat(20_000);
  const r = applyBudget(body, 2_000);
  expect(headOf(r).length).toBeGreaterThan(tailOf(r).length);
  const even = applyBudget(body, 2_000, 0.5);
  expect(Math.abs(headOf(even).length - tailOf(even).length)).toBeLessThanOrEqual(8);
});

// ---------- UTF-8 / grapheme safety ----------

test("the cut never splits a surrogate pair, a combining-mark sequence, a ZWJ emoji chain, or a flag", () => {
  const emoji = "👍🏽";           // thumbs up + skin-tone modifier
  const flags = "🇹🇷".repeat(4);
  const combining = "é".repeat(20);   // e + combining acute
  const zwj = "👨‍👩‍👧‍👦".repeat(10);  // ZWJ chain
  const body = "a".repeat(900) + combining + emoji + flags + zwj + "b".repeat(4_000);
  const r = applyBudget(body, 1_200);
  expect(r.truncated).toBe(true);
  expect(utf8Clean(r.text)).toBe(true);
  const head = headOf(r);
  expect(/\p{M}$/u.test(head)).toBe(false);           // no dangling combining mark at the head's end
  expect(head.endsWith("‍")).toBe(false);          // no dangling joiner
  const tail = tailOf(r);
  expect(/^\p{M}/u.test(tail)).toBe(false);           // the tail does not start mid-sequence
  expect(/^[\u{1F1E6}-\u{1F1FF}]/u.test(tail)).toBe(false);   // …or with half a flag
});

test("CJK text truncates cleanly (no mojibake, cap respected)", () => {
  const body = "漢字かな混じりの長い行。\n".repeat(2_000);
  const r = applyBudget(body, 4_000);
  expect(r.truncated).toBe(true);
  expect(utf8Clean(r.text)).toBe(true);
  expect(r.text.length).toBeLessThanOrEqual(4_000);
});

// ---------- policy ----------

test("per-tool override: the tighter cap wins; an unlisted tool gets the default", () => {
  const budget = createOutputBudget({ perTool: { bash: 1_000, evalcell: 100_000 } });
  expect(budget.capFor("bash")).toBe(1_000);
  expect(budget.capFor("read")).toBe(DEFAULT_OUTPUT_CAP);
  const big = "z".repeat(50_000);
  expect(budget.apply("bash", big).keptChars).toBeLessThanOrEqual(1_000);
  expect(budget.apply("read", big).keptChars).toBeLessThanOrEqual(DEFAULT_OUTPUT_CAP);
});

test("defaultCap override applies to every tool without its own row", () => {
  const budget = createOutputBudget({ defaultCap: 500 });
  expect(budget.apply("anything", "q".repeat(600)).truncated).toBe(true);
  expect(budget.apply("anything", "q".repeat(500)).truncated).toBe(false);
});

test("idempotent: applying the policy to an already-truncated output changes nothing", () => {
  const budget = createOutputBudget({ defaultCap: 2_000 });
  const once = budget.apply("bash", "w".repeat(10_000));
  const twice = budget.apply("bash", once.text);
  expect(twice.text).toBe(once.text);
  expect(twice.truncated).toBe(false);   // it fits now — the policy sees nothing to do
});

test("degenerate caps: a cap smaller than the marker still returns something bounded and marked", () => {
  const r = applyBudget("y".repeat(10_000), 200);
  expect(r.truncated).toBe(true);
  expect(r.text.length).toBeLessThanOrEqual(240);   // cap + slack for the shortest possible marker
  expect(r.text).toContain("…");
});

test("stats are honest: originalChars is the input length, keptChars ≤ cap, estTokensCut ≥ 0", () => {
  const r: TruncatedOutput = applyBudget("s".repeat(100_000), 10_000);
  expect(r.originalChars).toBe(100_000);
  expect(r.keptChars).toBeLessThanOrEqual(10_000);
  expect(r.keptChars).toBeGreaterThan(9_000);        // not wasteful: most of the budget is used
  expect(r.estTokensCut).toBeGreaterThan(20_000);    // ~22.5k tokens cut
});
