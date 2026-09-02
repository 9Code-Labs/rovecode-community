/** Port #31 html-text tokenizer: linear-time bounds on hostile bodies (the
 *  tool's timeout cannot interrupt a synchronous parse, so the parse itself must
 *  never be the slow part), the omitted-</head> minified-page shape, void
 *  <embed>, fragment links judged on the raw href, and the tokenizer contracts
 *  the bounded regex relies on (unterminated comment/CDATA swallow the rest as
 *  browsers do, self-closing and multi-line tags, doctype/PI skipped). The
 *  byte-exact realistic-page golden lives in webfetch.test.ts. */

import { test, expect } from "bun:test";
import { htmlToText } from "../../src/tools/html-text.ts";

const K = 1024;
const timed = (html: string): { ms: number; out: string } => {
  const t0 = performance.now();
  const out = htmlToText(html, "https://b.test/p/");
  return { ms: performance.now() - t0, out };
};

/** Shapes that made the old tokenizer rescan to end-of-input per "<" (quadratic:
 *  64KB ≈ 1.4–1.9s, 128KB ≈ 5–9s, 512KB killed) or backtrack a blank run from every
 *  blank. Each is probed at a small size FIRST so a regression fails within seconds
 *  instead of minutes, then run at the tool's MAX_BYTES (512KB). Bound is generous
 *  (the fixed parser takes 2–70ms even on a loaded machine). */
const SHAPES: [label: string, probeKB: number, build: (chars: number) => string][] = [
  ["unterminated tags `<a<a<a…`", 128, (n) => "<a".repeat(n / 2)],
  ["unterminated comments `<!--<!--…`", 128, (n) => "<!--".repeat(n / 4)],
  ["unclosed attributes `<a href=\"x<a href=\"x…`", 128, (n) => '<a href="x'.repeat(Math.ceil(n / 10))],
  ["one giant tag name `<aaaa…`", 128, (n) => "<" + "a".repeat(n - 1)],
  ["name, blank, giant run `<aaa… bbb…`", 128, (n) => "<" + "a".repeat(n / 2) + " " + "b".repeat(n / 2 - 2)],
  ["<pre> full of blanks (trailing-blank strip)", 64, (n) => "<pre>" + " ".repeat(n - 5)],
];

test("MED-3: hostile 512KB bodies parse in linear time — under 1500ms each (probe size first, then MAX_BYTES)", () => {
  for (const [label, probeKB, build] of SHAPES) {
    for (const kb of [probeKB, 512]) {
      const html = build(kb * K);
      const { ms, out } = timed(html);
      expect([label, kb, ms < 1500]).toEqual([label, kb, true]);
      expect(out.length).toBeLessThanOrEqual(html.length);
    }
  }
}, 120_000);

test("tokenizer contracts: unterminated comment/CDATA swallow the rest (browser behavior); doctype, PI, self-closing and multi-line tags tokenize", () => {
  expect(htmlToText("kept<!-- open comment <p>never</p>")).toBe("kept");
  expect(htmlToText("kept<![CDATA[ open <p>never</p>")).toBe("kept");
  expect(htmlToText("a<!-- c --><p>b</p><![CDATA[ x ]]>c")).toBe("a\n\nb\n\nc");
  expect(htmlToText('<?xml version="1.0"?><!DOCTYPE html><p>x</p>')).toBe("x");
  expect(htmlToText("x<br/>y<br />z<hr>w")).toBe("x\ny\nz\nw");
  expect(htmlToText('<a\n  href="/x"\n>t</a>', "https://s.test/")).toBe("t (https://s.test/x)");
  expect(htmlToText("<pre>a   \n  b</pre>")).toBe("a\n  b"); // blanks before a newline go, indentation stays
});

test("MED-4: an omitted </head> (minified pages) is closed by the <body> start tag — the body is kept, the head content still dropped", () => {
  const minified = "<!doctype html><html><head><meta charset=utf-8><title>Min</title><body><h1>Hi</h1><p>Minified page body</p>";
  expect(htmlToText(minified)).toBe("Hi\n\nMinified page body");
  const explicit = "<!doctype html><html><head><meta charset=utf-8><title>Min</title></head><body><h1>Hi</h1><p>Minified page body</p></body></html>";
  expect(htmlToText(explicit)).toBe("Hi\n\nMinified page body");
  expect(htmlToText("<head><title>T</title><style>p{}</style><body><p>x</p>")).not.toContain("T");
});

test("LOW-5: <embed> is a void element — content after it is kept; object/iframe/svg subtrees are still dropped", () => {
  expect(htmlToText("<p>before</p><embed src=x.swf type=application/x-shockwave-flash><p>after</p>")).toBe("before\n\nafter");
  expect(htmlToText("<object data=x>fallback</object><iframe>inner</iframe><svg><text>t</text></svg>vis")).toBe("vis");
});

test("LOW-6: same-page fragment links get no href even under a base URL; fragment-bearing paths and absolute links still do", () => {
  expect(htmlToText('<p><a href="#install">install</a> and <a href="/start#install">start</a></p>', "https://d.test/guide/")).toBe("install and start (https://d.test/start#install)");
  expect(htmlToText('<a href="#top">frag</a>')).toBe("frag");
  expect(htmlToText('<a href="https://o.test/#frag">o</a>', "https://d.test/")).toBe("o (https://o.test/#frag)");
});
