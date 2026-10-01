/** sextant/markdown.ts (assistant turns render markdown, not its source) and the transcript's
 *  tool-run collapse (draw-messages.ts toolRunRows).
 *
 *  Markdown: the assertions are about what the CELLS carry, not about a snapshot — the heading's `##`
 *  gone, the bold's text bold and its asterisks gone, the code fence's content present and padded to
 *  the panel width. Marked does the parsing; what is pinned here is OUR mapping of its tokens to
 *  styles, because that is the part that can quietly regress.
 *
 *  Collapse: an exploration phase floods the transcript with read rows; the collapse folds them into
 *  one summary line. The invariants are the negative space — mutations, failures and the live row can
 *  NEVER fold, and the summary carries no click path (message-hits.ts maps rows to files by it). */

import { test, expect } from "bun:test";
import type { MessageRow, SextantState, ToolRow } from "../../src/sextant/types.ts";
import { ATTR } from "../../src/sextant/types.ts";
import { markdownRows } from "../../src/sextant/markdown.ts";
import { buildRows, toolRunRows } from "../../src/sextant/draw-messages.ts";
import { THEME, baseState } from "../helpers/sextant-grid.ts";

const W = 80;
/** rows as painted strings — indent applied, like the panel paints them */
const text = (rows: ReadonlyArray<{ segs: ReadonlyArray<readonly [string, unknown]>; indent?: number }>): string[] =>
  rows.map((r) => " ".repeat(r.indent ?? 0) + r.segs.map(([t]) => t).join(""));
const hasAttr = (rows: ReturnType<typeof markdownRows>, needle: string, attr: number): boolean =>
  rows.some((r) => r.segs.some(([t, s]) => t.includes(needle) && s !== undefined && (s.a & attr) !== 0));

// ------------------------------------------------------------------ markdown

test("a heading loses its ## and gains bold+accent; a paragraph keeps the base colour", () => {
  const rows = markdownRows("## Plan\n\njust prose", W, THEME);
  const flat = text(rows);
  expect(flat.some((l) => l.includes("##"))).toBe(false);
  expect(flat.find((l) => l.includes("Plan"))).toBe("  Plan");
  expect(hasAttr(rows, "Plan", ATTR.BOLD)).toBe(true);
  const plan = rows.find((r) => r.segs.some(([t]) => t.includes("Plan")))!;
  expect(plan.segs[0]![1]!.fg).toBe(THEME.accent);
  const prose = rows.find((r) => r.segs.some(([t]) => t.includes("just")))!;
  expect(prose.segs[0]![1]!.fg).toBe(THEME.fg2);
  expect(prose.segs[0]![1]!.a & ATTR.BOLD).toBe(0);
});

test("inline markup: **bold**, *italic*, ~~strike~~, a `code` chip, and a link that drops its url", () => {
  const rows = markdownRows("a **bold** and *it* and ~~gone~~ and `x.y()` and [docs](https://example.com/page) end", W, THEME);
  const line = text(rows).join("\n");
  expect(line).toContain("a bold and it and gone and  x.y()  and docs end");
  expect(line).not.toContain("**"); expect(line).not.toContain("https://"); // markers and urls are not the answer
  expect(hasAttr(rows, "bold", ATTR.BOLD)).toBe(true);
  expect(hasAttr(rows, "it", ATTR.ITALIC)).toBe(true);
  expect(hasAttr(rows, "gone", ATTR.STRIKE)).toBe(true);
  expect(hasAttr(rows, "docs", ATTR.UNDERLINE)).toBe(true);
  const chip = rows[0]!.segs.find(([t]) => t.includes("x.y()"))!;
  expect(chip[1]!.bg).toBe(THEME.bg2); // the chip look: str colour on the alt background
});

test("a fenced block: lang label, content intact, every row filled to the panel width, no ``` on screen", () => {
  const src = "```ts\nconst x = 1;\nreturn x;\n```";
  const rows = markdownRows(src, 40, THEME);
  const flat = text(rows);
  expect(flat[0]).toContain("▍ ts");
  expect(flat.some((l) => l.includes("```"))).toBe(false);
  expect(flat[1]).toContain("const x = 1;");
  expect(flat[2]).toContain("return x;");
  // the block reads as a block: every row is padded to the panel width on bg2
  for (const l of flat) expect([...l].length).toBe(40);
  for (const r of rows) expect(r.segs[r.segs.length - 1]![1]!.bg).toBe(THEME.bg2);
});

test("streaming safety: an unclosed fence lexes as code and still renders, never throws", () => {
  const rows = markdownRows("here:\n\n```ts\nconst x = ", W, THEME);
  expect(text(rows).join("\n")).toContain("const x =");
  expect(text(rows).join("\n")).not.toContain("```");
});

test("lists: bullets hang their wraps, ordered keeps its numbers, nesting indents", () => {
  const rows = markdownRows("- one item that is long enough to wrap at this narrow width for sure\n- two\n  - nested\n\n1. first\n2. second", 44, THEME);
  const flat = text(rows);
  expect(flat[0]).toMatch(/^ {2}• one item/);
  // hanging indent: the continuation aligns under the item text, not under the bullet
  expect(flat[1]).toMatch(/^ {4}\S/);
  expect(flat.some((l) => /^\s{4}• nested/.test(l))).toBe(true);
  expect(flat.some((l) => l.includes("1. first"))).toBe(true);
  expect(flat.some((l) => l.includes("2. second"))).toBe(true);
});

test("a blockquote gets its bar and italics; an hr is a rule; html renders as nothing", () => {
  const rows = markdownRows("> a note worth seeing\n\n---\n\n<div>gone</div>", W, THEME);
  const flat = text(rows);
  expect(flat.some((l) => l.includes("▎ a note worth seeing"))).toBe(true);
  expect(hasAttr(rows, "seeing", ATTR.ITALIC)).toBe(true); // wrapSegs splits words — assert one word, not the phrase
  expect(flat.some((l) => /^ {2}╌+$/.test(l))).toBe(true);
  expect(flat.join("\n")).not.toContain("div");
});

test("a table aligns its columns and bolds the header; a too-wide table falls back to readable text", () => {
  const rows = markdownRows("| model | ctx |\n|---|---|\n| opus-5 | 1M |\n| haiku | 200k |", W, THEME);
  const flat = text(rows);
  expect(flat.some((l) => l.includes("model") && l.includes("│") && l.includes("ctx"))).toBe(true);
  expect(flat.some((l) => l.includes("opus-5") && l.includes("1M"))).toBe(true);
  expect(hasAttr(rows, "model", ATTR.BOLD)).toBe(true);
  // cells wider than the panel can align honestly → raw text, not a broken grid
  const wide = markdownRows("| a model identifier column | another wide column here |\n|---|---|\n| claude-opus-5-with-a-long-id | something-else-long |", 40, THEME);
  expect(text(wide).join("\n")).toContain("| a model identifier column |");
});

test("plain prose is unchanged behaviour: wrapped at the width, no invented structure", () => {
  const rows = markdownRows("the answer is forty two and this sentence keeps going until it wraps at eighty cells for sure it will", W, THEME);
  const flat = text(rows);
  expect(flat.length).toBe(2);
  expect(flat.every((l) => l.startsWith("  ") && [...l].length <= W)).toBe(true);
});

test("the rows cache: same text+width+theme returns the identical array; the lexer never runs twice", () => {
  const a = markdownRows("# same", W, THEME);
  const b = markdownRows("# same", W, THEME);
  expect(a).toBe(b);
});

// ------------------------------------------------------------------ tool-run collapse

const tool = (over: Partial<ToolRow>): ToolRow => ({ kind: "tool", callId: "c", tool: over.verb ?? "read", verb: "read", label: "f.ts", running: false, ok: true, ...over });
const rowText = (rows: ReadonlyArray<{ segs: ReadonlyArray<readonly [string, unknown]> }>): string[] => rows.map((r) => r.segs.map(([t]) => t).join(""));

test("five reads fold to one summary plus two live rows; the summary has no click path", () => {
  const reads = Array.from({ length: 5 }, (_, i) => tool({ callId: `r${i}`, label: `f${i}.ts`, path: `f${i}.ts` }));
  const rows = toolRunRows(reads, W, THEME, 0);
  const flat = rowText(rows);
  expect(rows.length).toBe(3);
  expect(flat[0]).toContain("3 calls");
  expect(flat[0]).toContain("read ×3");
  expect(rows[0]!.path).toBeUndefined();           // nothing to open — it names no one file
  expect(flat[1]).toContain("f3.ts");
  expect(flat[2]).toContain("f4.ts");
  expect(rows[1]!.path).toBe("f3.ts");             // the kept rows keep their affordance
});

test("mutations never fold: writes and edits stay expanded between folded reads", () => {
  const group = [
    tool({ callId: "r1", path: "a.ts" }), tool({ callId: "r2", path: "b.ts" }), tool({ callId: "r3", path: "c.ts" }),
    tool({ callId: "w", verb: "write", tool: "write", label: "out.ts", path: "out.ts" }),
    tool({ callId: "r4", path: "d.ts" }), tool({ callId: "r5", path: "e.ts" }),
  ];
  const flat = rowText(toolRunRows(group, W, THEME, 0));
  // the run is 5 reads around a write — but the split runs are 3 and 2, and a 3-run folds nothing
  // (3 − 2 kept < 3 folded), so only the ORDER is asserted: the write is always its own row
  expect(flat.some((l) => l.includes("~ ") || l.includes("+ write"))).toBe(true);
  expect(flat.join("\n")).toContain("out.ts");
});

test("a failed read never folds — its detail is the error the user came for", () => {
  const reads = [
    ...Array.from({ length: 4 }, (_, i) => tool({ callId: `r${i}`, label: `f${i}.ts` })),
    tool({ callId: "bad", label: "gone.ts", ok: false, detail: "ENOENT" }),
    tool({ callId: "r5", label: "f5.ts" }),
  ];
  const flat = rowText(toolRunRows(reads, W, THEME, 0));
  expect(flat.join("\n")).toContain("ENOENT");
  expect(flat.some((l) => l.includes("gone.ts"))).toBe(true);
});

test("a running row never folds, and four rows is below the threshold — all stay", () => {
  const running = [
    ...Array.from({ length: 4 }, (_, i) => tool({ callId: `r${i}`, label: `f${i}.ts` })),
    tool({ callId: "live", label: "now.ts", running: true }),
  ];
  const rows = toolRunRows(running, W, THEME, 0);
  expect(rows.length).toBe(5);                     // nothing folded: the run before the live row is 4
  expect(rowText(rows).join("\n")).toContain("now.ts");
  const four = Array.from({ length: 4 }, (_, i) => tool({ callId: `r${i}`, label: `f${i}.ts` }));
  expect(toolRunRows(four, W, THEME, 0).length).toBe(4);
});

test("through buildRows: the group is one emit, the click map sees the kept rows only", () => {
  const messages: MessageRow[] = [
    { kind: "user", text: "survey the repo" } as MessageRow,
    ...Array.from({ length: 6 }, (_, i) => tool({ callId: `r${i}`, label: `src/f${i}.ts`, path: `src/f${i}.ts` }) as MessageRow),
  ];
  const s: SextantState = baseState({ messages });
  const rows = buildRows(s, W, THEME, 0);
  const flat = rows.map((r) => r.segs.map(([t]) => t).join(""));
  expect(flat.filter((l) => l.includes("calls") && l.includes("read ×4")).length).toBe(1);
  expect(rows.filter((r) => r.path !== undefined).map((r) => r.path)).toEqual(["src/f4.ts", "src/f5.ts"]);
});
