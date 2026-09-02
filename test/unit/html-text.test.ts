/** Port #31 html-text tokenizer: linear-time bounds on hostile bodies (the
 *  tool's timeout cannot interrupt a synchronous parse, so the parse itself must
 *  never be the slow part), the omitted-</head> minified-page shape (closed by
 *  <body> or by any other non-head start tag), "<" and ">" inside quoted
 *  attributes, void <embed>, fragment links judged on the raw href, and the
 *  tokenizer contracts the bounded regex relies on (unterminated comment/CDATA
 *  swallow the rest as browsers do, self-closing and multi-line tags, doctype/PI
 *  skipped). The byte-exact realistic-page golden lives in webfetch.test.ts. */

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
 *  blank, plus the worst cases of the quote-aware attribute scan (one tag whose
 *  attribute part runs to EOF through the per-character loop: ~200ms at 512KB) and
 *  a dense realistic page (32k links, each resolved). Each is probed at a small size
 *  FIRST so a regression fails within seconds instead of minutes, then run at the
 *  tool's MAX_BYTES (512KB). Bound is generous (the fixed parser takes 2–210ms even
 *  on a loaded machine). */
const SHAPES: [label: string, probeKB: number, build: (chars: number) => string, outRatio?: number][] = [
  ["unterminated tags `<a<a<a…`", 128, (n) => "<a".repeat(n / 2)],
  ["unterminated comments `<!--<!--…`", 128, (n) => "<!--".repeat(n / 4)],
  ["unclosed attributes `<a href=\"x<a href=\"x…`", 128, (n) => '<a href="x'.repeat(Math.ceil(n / 10))],
  ["one giant tag name `<aaaa…`", 128, (n) => "<" + "a".repeat(n - 1)],
  ["name, blank, giant run `<aaa… bbb…`", 128, (n) => "<" + "a".repeat(n / 2) + " " + "b".repeat(n / 2 - 2)],
  ["<pre> full of blanks (trailing-blank strip)", 64, (n) => "<pre>" + " ".repeat(n - 5)],
  ["one giant unquoted attribute `<a href=xxx…`", 128, (n) => "<a href=" + "x".repeat(n - 8)],
  ["unterminated close tags `</a</a</a…` (one tag, `/`-started attribute part to EOF)", 128, (n) => "</a".repeat(Math.ceil(n / 3))],
  ["one tag, `/`-run attribute part `<a////…`", 128, (n) => "<a" + "/".repeat(n - 2)],
  // links render `t (https://b.test/p/x)`: the only shape whose text is longer than its markup
  ["dense links `<a href=x>t</a>` ×32k (each href resolved)", 128, (n) => "<a href=x>t</a>".repeat(n / 16), 2],
];

test("MED-3: hostile 512KB bodies parse in linear time — under 1500ms each (probe size first, then MAX_BYTES)", () => {
  for (const [label, probeKB, build, outRatio = 1] of SHAPES) {
    for (const kb of [probeKB, 512]) {
      const html = build(kb * K);
      const { ms, out } = timed(html);
      expect([label, kb, ms < 1500]).toEqual([label, kb, true]);
      expect(out.length).toBeLessThanOrEqual(html.length * outRatio);
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

test("re-verify LOW-1: '<' and '>' inside quoted attributes stay inside the tag — raw-text jump, subtree drop and plain tags all still engage; a tag name runs to blank|/|> and an unterminated quote runs to EOF, as in a browser", () => {
  // the linear-tokenizer fix bailed out of a tag at any "<" in an attribute VALUE, so none of these engaged
  expect(htmlToText('<script data-x="<">alert(1)</script>after')).toBe("after");
  expect(htmlToText('<style media="a<b">p{}</style>after')).toBe("after");
  expect(htmlToText('<head data-x="<"><title>T</title><meta x><body>b')).toBe("b");
  expect(htmlToText('<svg viewBox="0 0 1 1" data-x="<"><text>hidden</text></svg>vis')).toBe("vis");
  expect(htmlToText('<div onclick="if(a<b)x()">content</div>')).toBe("content");
  expect(htmlToText("<div title='a>b'>c</div><a href=\"/x\" data-x=\"<\">l</a>", "https://s.test/")).toBe("c\nl (https://s.test/x)");
  expect(htmlToText('<a href="/x?q=<y>">l</a>', "https://s.test/")).toBe("l (https://s.test/x?q=%3Cy%3E)");
  // HTML5 tag-name state: "<" inside a name is part of the name — `<a<a<a…` is ONE unknown element, not a run of <a>s
  expect(htmlToText("<a<a<a<a")).toBe("");
  expect(htmlToText("<div<div>x")).toBe("x");
  // an unterminated quoted value runs to EOF and the tag is dropped ("eof-in-tag"); the text before it is kept
  expect(htmlToText('kept<a href="x>never')).toBe("kept");
  expect(htmlToText("kept<a href=x>shown</a>")).toBe("keptshown (x)");
});

test("re-verify LOW-2: an unclosed <head> is also closed by a non-head start tag when <body> is omitted too; <title> is raw text so it is dropped even when <head> itself is omitted", () => {
  // browser "in head" insertion mode: <p> implies </head><body>
  expect(htmlToText("<html><head><title>T</title><meta x><p>para</p>")).toBe("para");
  expect(htmlToText("<head><title>T</title><h1>H</h1>")).toBe("H");
  // head-only elements do NOT end the head; the body start tag still does
  expect(htmlToText("<head><title>T</title><link rel=x><base href=/><meta><style>p{}</style><script>1<2</script><noscript>n</noscript><template>t</template><body>b")).toBe("b");
  // no <head> at all: the title used to leak as body text ("T\ncontent")
  expect(htmlToText("<!doctype html><title>T</title><meta><div>content</div>")).toBe("content");
  expect(htmlToText("<p>x</p><title>T</title><p>y</p>")).toBe("x\n\ny");
  // a DROP element inside the head implies <body> too, and is itself still dropped
  expect(htmlToText("<head><svg><text>hidden</text></svg><body>b")).toBe("b");
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
