/** Port #40 — engine.ts: tokenizer, langOf, fuzzy, wrap, formatters and the hunk/mark code over
 *  jsdiff output. Expected values were produced by the prototype (node -e over engine.js and
 *  app.js wrap(), 2026-09-02); the diff cases use inputs where Myers and the prototype's LCS agree. */

import { describe, expect, it } from "bun:test";
import { structuredPatch } from "diff";
import {
  LANG_NAME, basename, buildHunks, diffOps, dirname, fmtClock, fmtDur, fmtK, fuzzy, hunksFromPatch, langOf, lineMarks,
  opStats, opsFromChanges, splitLines, toDiffHunk, tokenize, tokenizeMd, wrap, type DiffOp, type Token,
} from "../../src/sextant/engine.ts";

const T = (line: string, lang: string, want: Token[]) => { expect(tokenize(line, lang)).toEqual(want); };

describe("sextant engine: tokenizer (prototype output pinned)", () => {
  it("ts: keywords, types, punctuation, strings", () => {
    T('import { Screen, A } from "./term";', "ts", [["import", "kw"], [" ", "plain"], ["{", "pu"], [" ", "plain"], ["Screen", "ty"], [",", "pu"], [" ", "plain"], ["A", "ty"], [" ", "plain"], ["}", "pu"], [" ", "plain"], ["from", "kw"], [" ", "plain"], ['"./term"', "str"], [";", "pu"]]);
  });
  it("ts: calls, numbers, template strings, operators, props, comments", () => {
    T("const x = foo(1.5, `t${y}`) ?? bar.baz; // note", "ts", [["const", "kw"], [" ", "plain"], ["x", "id"], [" ", "plain"], ["=", "op"], [" ", "plain"], ["foo", "fn"], ["(", "pu"], ["1.5", "num"], [",", "pu"], [" ", "plain"], ["`t${y}`", "str"], [")", "pu"], [" ", "plain"], ["??", "op"], [" ", "plain"], ["bar", "id"], [".", "pu"], ["baz", "prop"], [";", "pu"], [" ", "plain"], ["// note", "cm"]]);
  });
  it("ts: signature with typed params (`a:` is prop, `Foo` is ty, `void` kw)", () => {
    T("export async function run(a: Foo, b?: string): Promise<void> {", "ts", [["export", "kw"], [" ", "plain"], ["async", "kw"], [" ", "plain"], ["function", "kw"], [" ", "plain"], ["run", "fn"], ["(", "pu"], ["a", "prop"], [":", "pu"], [" ", "plain"], ["Foo", "ty"], [",", "pu"], [" ", "plain"], ["b", "prop"], ["?", "op"], [":", "pu"], [" ", "plain"], ["string", "id"], [")", "pu"], [":", "pu"], [" ", "plain"], ["Promise", "ty"], ["<", "op"], ["void", "kw"], [">", "op"], [" ", "plain"], ["{", "pu"]]);
  });
  it("ts: decorators, class keywords, and the prototype's hex-literal quirk (0x10 → ' 0' plain + 'x10' id)", () => {
    T("@dec class Thing extends Base implements I { readonly n = 0x10; }", "ts", [["@dec", "dec"], [" ", "plain"], ["class", "kw"], [" ", "plain"], ["Thing", "ty"], [" ", "plain"], ["extends", "kw"], [" ", "plain"], ["Base", "ty"], [" ", "plain"], ["implements", "kw"], [" ", "plain"], ["I", "ty"], [" ", "plain"], ["{", "pu"], [" ", "plain"], ["readonly", "kw"], [" ", "plain"], ["n", "id"], [" ", "plain"], ["=", "op"], [" 0", "plain"], ["x10", "id"], [";", "pu"], [" ", "plain"], ["}", "pu"]]);
  });
  it("ts: optional chaining, member calls are props, `this` kw", () => {
    T("  if (a >= b) return obj.prop?.call(this);", "ts", [["  ", "plain"], ["if", "kw"], [" ", "plain"], ["(", "pu"], ["a", "id"], [" ", "plain"], [">=", "op"], [" ", "plain"], ["b", "id"], [")", "pu"], [" ", "plain"], ["return", "kw"], [" ", "plain"], ["obj", "id"], [".", "pu"], ["prop", "prop"], ["?.", "op"], ["call", "prop"], ["(", "pu"], ["this", "kw"], [")", "pu"], [";", "pu"]]);
  });
  it("ts: generics — lowercase before < is fn, capitalized is ty", () => {
    T("x<T>(1); y<3; Comp<Props>", "ts", [["x", "fn"], ["<", "op"], ["T", "ty"], [">", "op"], ["(", "pu"], ["1", "num"], [")", "pu"], [";", "pu"], [" ", "plain"], ["y", "fn"], ["<", "op"], ["3", "num"], [";", "pu"], [" ", "plain"], ["Comp", "ty"], ["<", "op"], ["Props", "ty"], [">", "op"]]);
    T("", "ts", []);
  });
  it("json: object keys are `key`, values `str`/`num`/`kw`", () => {
    T('{ "name": "rovecode", "n": 12, "ok": true }', "json", [["{", "pu"], [" ", "plain"], ['"name"', "key"], [":", "pu"], [" ", "plain"], ['"rovecode"', "str"], [",", "pu"], [" ", "plain"], ['"n"', "key"], [":", "pu"], [" ", "plain"], ["12", "num"], [",", "pu"], [" ", "plain"], ['"ok"', "key"], [":", "pu"], [" ", "plain"], ["true", "kw"], [" ", "plain"], ["}", "pu"]]);
    T('  "nested": { "k": [1, 2] },', "json", [["  ", "plain"], ['"nested"', "key"], [":", "pu"], [" ", "plain"], ["{", "pu"], [" ", "plain"], ['"k"', "key"], [":", "pu"], [" ", "plain"], ["[", "pu"], ["1", "num"], [",", "pu"], [" ", "plain"], ["2", "num"], ["]", "pu"], [" ", "plain"], ["}", "pu"], [",", "pu"]]);
  });
  it("md: headings kw, indented code str, inline code str, else plain; text is one plain run", () => {
    T("## Heading here", "md", [["## Heading here", "kw"]]);
    T("    indented code", "md", [["    indented code", "str"]]);
    T("use `bun test` then `tsc` ok", "md", [["use ", "plain"], ["`bun test`", "str"], [" then ", "plain"], ["`tsc`", "str"], [" ok", "plain"]]);
    T("plain markdown", "md", [["plain markdown", "plain"]]);
    expect(tokenizeMd("#nospace")).toEqual([["#nospace", "plain"]]);
    T("anything <here>", "text", [["anything <here>", "plain"]]);
    T("", "text", [["", "plain"]]);
  });
  it("is stateless across calls (the global regex is reset)", () => {
    const a = tokenize("const a = 1;", "ts");
    tokenize("let b = `x`;", "ts");
    expect(tokenize("const a = 1;", "ts")).toEqual(a);
  });
});

describe("sextant engine: paths + langOf", () => {
  it("langOf: prototype cases, plus the JS family and jsonc/markdown extensions", () => {
    expect(["a.ts", "b.tsx", "c.json", "d.md", "e.txt", "f", "g.TS"].map(langOf)).toEqual(["ts", "ts", "json", "md", "text", "text", "text"]);
    expect(["x.js", "x.jsx", "x.mjs", "x.cjs", "x.mts", "x.cts", "x.jsonc", "x.markdown", "x.yaml", "x.tsv"].map(langOf)).toEqual(["ts", "ts", "ts", "ts", "ts", "ts", "json", "md", "text", "text"]);
    expect(LANG_NAME).toEqual({ ts: "TypeScript", json: "JSON", md: "Markdown", text: "Plain Text" });
  });
  it("splitLines/basename/dirname", () => {
    expect([splitLines("a\nb\n"), splitLines("a\nb"), splitLines(""), splitLines("\n")]).toEqual([["a", "b"], ["a", "b"], [], [""]]);
    expect([basename("a/b/c.ts"), basename("c.ts"), dirname("a/b/c.ts"), dirname("c.ts")]).toEqual(["c.ts", "c.ts", "a/b", ""]);
  });
});

describe("sextant engine: fuzzy / wrap / formatters (prototype output pinned)", () => {
  it("fuzzy scores: +3 runs, +2 word/path starts, null when absent, empty query matches with 0", () => {
    expect(fuzzy("ses", "src/core/session.ts")).toEqual({ score: 7, idx: [0, 7, 9] });
    expect(fuzzy("cb", "src/auth/callback.ts")).toEqual({ score: 2, idx: [2, 13] });
    expect(fuzzy("zz", "abc")).toBeNull();
    expect(fuzzy("", "abc")).toEqual({ score: 0, idx: [] });
    expect(fuzzy("Ab", "xaB")).toEqual({ score: 4, idx: [1, 2] });
    expect(fuzzy("ss", "session")).toEqual({ score: 4, idx: [0, 2] });
    expect(fuzzy("a b", "a b")).toEqual({ score: 11, idx: [0, 1, 2] });
  });
  it("wrap: greedy words per paragraph; only the paragraph's last line is hard-split (prototype quirk kept)", () => {
    expect(wrap("hello world this is a test", 11)).toEqual(["hello world", "this is a", "test"]);
    expect(wrap("averyveryverylongword short", 8)).toEqual(["averyveryverylongword", "short"]);
    expect(wrap("short averyveryverylongword", 8)).toEqual(["short", "averyver", "yverylon", "gword"]);
    expect(wrap("a\nb c", 3)).toEqual(["a", "b c"]);
    expect(wrap("", 5)).toEqual([""]);
    expect(wrap("x", 1)).toEqual(["x"]);
    expect(wrap("one  two", 5)).toEqual(["one ", "two"]);
    expect(wrap("exact fit!", 10)).toEqual(["exact fit!"]);
  });
  it("wrap: width ≤ 0 is clamped to 1 — the prototype's hard-split loop never advanced there (returns, equals width 1)", () => {
    expect(wrap("abc", 0)).toEqual(wrap("abc", 1));
    expect(wrap("abc", 1)).toEqual(["a", "b", "c"]);
    expect(wrap("abc", -5)).toEqual(["a", "b", "c"]);
    expect(wrap("a b", 0)).toEqual(["a", "b"]);
    expect(wrap("", 0)).toEqual([""]);
    expect(wrap("x\nyz", 0)).toEqual(["x", "y", "z"]);
  }, 2000);
  it("fmtClock / fmtDur / fmtK", () => {
    expect([0, 999, 1000, 59999, 60000, 61050, 3599999, -5, 1234567].map(fmtClock)).toEqual(["00:00.0", "00:01.0", "00:01.0", "00:60.0", "01:00.0", "01:01.0", "59:60.0", "00:00.0", "20:34.6"]);
    expect([0, 999, 999.4, 999.6, 1000, 1500, 12345].map(fmtDur)).toEqual(["0ms", "999ms", "999ms", "1000ms", "1.0s", "1.5s", "12.3s"]);
    expect([0, 999, 1000, 1500, 12345, 999999].map(fmtK)).toEqual(["0", "999", "1.0k", "1.5k", "12.3k", "1000.0k"]);
  });
});

describe("sextant engine: diff ops over jsdiff", () => {
  const A = "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n";
  const B = "a\nB\nc\nd\ne\nf\ng\nh\nX\ni\nj\n";
  const OPS: DiffOp[] = [
    { t: "eq", text: "a", an: 1, bn: 1 }, { t: "del", text: "b", an: 2 }, { t: "ins", text: "B", bn: 2 },
    { t: "eq", text: "c", an: 3, bn: 3 }, { t: "eq", text: "d", an: 4, bn: 4 }, { t: "eq", text: "e", an: 5, bn: 5 },
    { t: "eq", text: "f", an: 6, bn: 6 }, { t: "eq", text: "g", an: 7, bn: 7 }, { t: "eq", text: "h", an: 8, bn: 8 },
    { t: "ins", text: "X", bn: 9 }, { t: "eq", text: "i", an: 9, bn: 10 }, { t: "eq", text: "j", an: 10, bn: 11 },
  ];

  it("diffOps reproduces the prototype's op list (line numbers on each side)", () => {
    expect(diffOps(A, B)).toEqual(OPS);
    expect(diffOps("x\ny\n", "y\nz\nw\n")).toEqual([{ t: "del", text: "x", an: 1 }, { t: "eq", text: "y", an: 2, bn: 1 }, { t: "ins", text: "z", bn: 2 }, { t: "ins", text: "w", bn: 3 }]);
    expect(diffOps("", "")).toEqual([]);
    expect(diffOps("a\nb", "a\nc")).toEqual([{ t: "eq", text: "a", an: 1, bn: 1 }, { t: "del", text: "b", an: 2 }, { t: "ins", text: "c", bn: 2 }]);
  });

  it("opsFromChanges splits multi-line values and drops only the newline tail", () => {
    expect(opsFromChanges([{ value: "a\nb\n", count: 2, added: false, removed: false }, { value: "c", count: 1, added: true, removed: false }, { value: "\n", count: 1, added: false, removed: true }]))
      .toEqual([{ t: "eq", text: "a", an: 1, bn: 1 }, { t: "eq", text: "b", an: 2, bn: 2 }, { t: "ins", text: "c", bn: 3 }, { t: "del", text: "", an: 3 }]);
  });

  it("buildHunks: ctx 3 merges (gap 6 ≤ 2·3), ctx 1 splits, Infinity is one hunk, none for no ops", () => {
    const h3 = buildHunks(OPS, 3);
    expect(h3.length).toBe(1);
    expect(h3[0]).toEqual({ ops: OPS, as: 1, bs: 1, ac: 10, bc: 11 });
    expect(buildHunks(OPS, 1)).toEqual([
      { ops: OPS.slice(0, 4), as: 1, bs: 1, ac: 3, bc: 3 },
      { ops: OPS.slice(8, 11), as: 8, bs: 8, ac: 2, bc: 3 },
    ]);
    expect(buildHunks(OPS, Infinity)).toEqual([{ ops: OPS, as: 1, bs: 1, ac: 10, bc: 11 }]);
    expect(buildHunks([], Infinity)).toEqual([]);
    expect(buildHunks([], 3)).toEqual([]);
    const ops2 = diffOps("x\ny\n", "y\nz\nw\n");
    expect(buildHunks(ops2, 0)).toEqual([
      { ops: [{ t: "del", text: "x", an: 1 }], as: 1, bs: 0, ac: 1, bc: 0 },
      { ops: [{ t: "ins", text: "z", bn: 2 }, { t: "ins", text: "w", bn: 3 }], as: 0, bs: 2, ac: 0, bc: 2 },
    ]);
  });

  it("buildHunks: two changes exactly 2·ctx apart share a hunk; 2·ctx+1 apart do not", () => {
    const near = diffOps("a\nb\nc\nd\ne\n", "A\nb\nc\nD\ne\n");
    expect(near).toEqual([{ t: "del", text: "a", an: 1 }, { t: "ins", text: "A", bn: 1 }, { t: "eq", text: "b", an: 2, bn: 2 }, { t: "eq", text: "c", an: 3, bn: 3 }, { t: "del", text: "d", an: 4 }, { t: "ins", text: "D", bn: 4 }, { t: "eq", text: "e", an: 5, bn: 5 }]);
    expect(buildHunks(near, 1)).toEqual([{ ops: near, as: 1, bs: 1, ac: 5, bc: 5 }]);
    expect(buildHunks(near, 0)).toEqual([
      { ops: near.slice(0, 2), as: 1, bs: 1, ac: 1, bc: 1 },
      { ops: near.slice(4, 6), as: 4, bs: 4, ac: 1, bc: 1 },
    ]);
    const far = diffOps("a\nb\nc\nd\ne\nf\n", "A\nb\nc\nd\nE\nf\n");
    expect(buildHunks(far, 1).map((h) => [h.as, h.bs, h.ac, h.bc, h.ops.length])).toEqual([[1, 1, 2, 2, 3], [4, 4, 3, 3, 4]]);
  });

  it("lineMarks: insertion next to a deletion is 'changed', a pure insertion 'added'; opStats counts", () => {
    expect([...lineMarks(OPS)]).toEqual([[2, "changed"], [9, "added"]]);
    expect([...lineMarks(diffOps("x\ny\n", "y\nz\nw\n"))]).toEqual([[2, "added"], [3, "added"]]);
    expect([...lineMarks(diffOps("a\nb\nc\nd\ne\n", "A\nb\nc\nD\ne\n"))]).toEqual([[1, "changed"], [4, "changed"]]);
    expect([...lineMarks([])]).toEqual([]);
    expect(opStats(OPS)).toEqual({ a: 2, d: 1 });
    expect(opStats([])).toEqual({ a: 0, d: 0 });
  });

  it("toDiffHunk / hunksFromPatch produce the contract's DiffHunk rows", () => {
    const [, second] = buildHunks(diffOps("x\ny\n", "y\nz\nw\n"), 0);
    expect(toDiffHunk(second!)).toEqual({ rows: [{ op: "+", text: "z" }, { op: "+", text: "w" }], oldStart: 0, newStart: 2 });
    expect(toDiffHunk(buildHunks(OPS, 1)[0]!)).toEqual({ rows: [{ op: " ", text: "a" }, { op: "-", text: "b" }, { op: "+", text: "B" }, { op: " ", text: "c" }], oldStart: 1, newStart: 1 });
    const patch = structuredPatch("f", "f", "a\nb\nc\n", "a\nB\nc\n");
    expect(hunksFromPatch(patch)).toEqual([{ oldStart: 1, newStart: 1, rows: [{ op: " ", text: "a" }, { op: "-", text: "b" }, { op: "+", text: "B" }, { op: " ", text: "c" }] }]);
    const noEol = hunksFromPatch(structuredPatch("f", "f", "a\nb", "a\nc"));
    expect(noEol.length).toBe(1);
    const markers = noEol[0]!.rows.filter((r) => r.text.startsWith("\\ No newline"));
    expect(markers.length).toBe(2);
    expect(markers.every((r) => r.op === " ")).toBe(true);
    expect(noEol[0]!.rows.filter((r) => r.op !== " ").map((r) => r.op + r.text)).toEqual(["-b", "+c"]);
    expect(hunksFromPatch(structuredPatch("f", "f", "same\n", "same\n"))).toEqual([]);
  });
});
