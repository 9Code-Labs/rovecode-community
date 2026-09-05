/** scripts/lib/docs.mjs — the pass that turns a third party's markdown into the `docs` field a market row
 *  carries. Pure functions, no network, no filesystem.
 *
 *  This module is the reason a catalog can hold someone else's text at all, so the tests are written from
 *  the attacker's side first and the formatting side second. Two of them exist because the code got it
 *  wrong on the first pass:
 *
 *    - the `javascript:` target that contains parentheses. The destination pattern was `[^()\s]+`, so
 *      `[click](javascript:alert(1))` did not match it and was copied through UNREWRITTEN — the single
 *      input the pass exists to catch was the one it let past, and the output was still valid markdown so
 *      nothing looked wrong.
 *    - a cut in the middle of a fenced block. Left open, one ``` swallows every following section into a
 *      code box.
 *
 *  Nothing here is the last line of defence and none of it should be read as such: a catalog arrives by
 *  git pull like any other file, and markdown can produce HTML on its own. The renderer keeps raw HTML
 *  off regardless. This layer exists so that the renderer is not the ONLY thing standing there. */

import { test, expect } from "bun:test";
// @ts-expect-error - a build script, plain JS, no types alongside it
import { absolutiseLinks, buildDocs, closeOpenFence, proseOnly, stripFrontmatter, stripHtml, truncate } from "../../scripts/lib/docs.mjs";

const BASE = "https://raw.githubusercontent.com/o/r/main/skills/demo/SKILL.md";
const bytes = (s: string) => Buffer.byteLength(s, "utf8");

/** Read at module scope, not inside the test, because the round count also has to set the test's TIMEOUT:
 *  the weekly search runs 40 000 rounds and blew through bun's 5 s default, which reads exactly like a
 *  real failure in the log and is not one. */
const SEED = Number(process.env["ROVECODE_FUZZ_SEED"] ?? 7);
const ROUNDS = Number(process.env["ROVECODE_FUZZ_ROUNDS"] ?? 200);
const FUZZ_TIMEOUT = Math.max(5_000, Math.ceil(ROUNDS * 0.75));

// ------------------------------------------------------------------ dangerous link targets

test("a scheme we do not allow loses its target and keeps its words — parentheses included", () => {
  // the regression: alert(1) has parentheses, which the first destination pattern refused to match
  expect(absolutiseLinks("[click](javascript:alert(1)).", BASE)).toBe("click.");
  expect(absolutiseLinks("[d](data:text/html,<script>1</script>)", BASE)).toBe("d");
  expect(absolutiseLinks("[v](VbScript:msgbox(1))", BASE)).toBe("v");     // the check is case-insensitive
  expect(absolutiseLinks("![i](javascript:x)", BASE)).toBe("i");          // images take the same path
});

test("a reference definition pointing somewhere unusable is removed, not left pointing there", () => {
  expect(absolutiseLinks("[ref]: javascript:alert(1)", BASE)).toBe("");
  expect(absolutiseLinks("[ref]: ../shared/notes.md", BASE))
    .toBe("[ref]: https://raw.githubusercontent.com/o/r/main/skills/shared/notes.md");
});

test("a legitimate target with balanced parentheses survives untouched", () => {
  const wiki = "[w](https://en.wikipedia.org/wiki/Foo_(bar))";
  expect(absolutiseLinks(wiki, BASE)).toBe(wiki);
});

// ------------------------------------------------------------------ relative -> absolute

test("relative links and images resolve against the document's own URL", () => {
  expect(absolutiseLinks("[g](./guide.md)", BASE))
    .toBe("[g](https://raw.githubusercontent.com/o/r/main/skills/demo/guide.md)");
  expect(absolutiseLinks("![s](img/a.png)", BASE))
    .toBe("![s](https://raw.githubusercontent.com/o/r/main/skills/demo/img/a.png)");
  expect(absolutiseLinks("[u](../x.md)", BASE))
    .toBe("[u](https://raw.githubusercontent.com/o/r/main/skills/x.md)");
  expect(absolutiseLinks("[s](<./a b.md>)", BASE))            // angle-bracket destination, space inside
    .toBe("[s](https://raw.githubusercontent.com/o/r/main/skills/demo/a%20b.md)");
});

test("what is already usable is left alone: absolute, anchor, mailto, protocol-relative", () => {
  expect(absolutiseLinks("[a](https://x.test/y)", BASE)).toBe("[a](https://x.test/y)");
  expect(absolutiseLinks("[h](#head)", BASE)).toBe("[h](#head)");
  expect(absolutiseLinks("[m](mailto:a@b.c)", BASE)).toBe("[m](mailto:a@b.c)");
  expect(absolutiseLinks("[p](//cdn.test/x.js)", BASE)).toBe("[p](https://cdn.test/x.js)");
});

// ------------------------------------------------------------------ HTML

test("script, style, iframe and comments go with their contents; other tags are unwrapped", () => {
  expect(stripHtml("a<script>alert(1)</script>b")).toBe("ab");     // not "aalert(1)b"
  expect(stripHtml("a<style>p{}</style>b")).toBe("ab");
  expect(stripHtml("a<iframe src=x></iframe>b")).toBe("ab");
  expect(stripHtml("a<!-- hidden -->b")).toBe("ab");
  expect(stripHtml("<script src=x>")).toBe("");                    // unclosed, and still not prose
  expect(stripHtml("some <b>bold</b> text")).toBe("some bold text");
});

test("a markdown autolink is not an HTML tag and survives", () => {
  expect(stripHtml("see <https://example.com/x> now")).toBe("see <https://example.com/x> now");
  expect(stripHtml("mail <mailto:a@b.c>")).toBe("mail <mailto:a@b.c>");
});

// ------------------------------------------------------------------ code is verbatim

/** The case that would have quietly corrupted the documentation rather than endangering anyone: a SKILL.md
 *  is mostly examples, and several of them contain HTML or relative paths ON PURPOSE. A fence renders as
 *  text, so nothing in it was ever markup — rewriting it would be destroying content to no benefit. */
test("fenced blocks and inline code are carried through exactly, tags and relative links included", () => {
  const src = ["# T", "", "```html", "<script>this must survive</script>", '<a href="./rel.html">x</a>', "```",
               "", "Inline `<div>` and `[x](./y)` stay."].join("\n");
  const d = buildDocs(src, BASE);
  expect(d.body).toContain("<script>this must survive</script>");
  expect(d.body).toContain('<a href="./rel.html">x</a>');
  expect(d.body).toContain("Inline `<div>` and `[x](./y)` stay.");
});

test("prose between two fenced blocks keeps its position and is still cleaned", () => {
  const src = ["```", "one", "```", "middle <b>prose</b> [l](./a.md)", "```", "two", "```"].join("\n");
  const body = buildDocs(src, BASE).body as string;
  expect(body.indexOf("one")).toBeLessThan(body.indexOf("middle"));
  expect(body.indexOf("middle")).toBeLessThan(body.indexOf("two"));
  expect(body).toContain("middle prose [l](https://raw.githubusercontent.com/o/r/main/skills/demo/a.md)");
});

// ------------------------------------------------------------------ truncation

test("a body over the cap is cut on a line boundary, under the cap, and says where the rest is", () => {
  const src = `# T\n\n${"a line of text\n".repeat(80)}`;
  const d = buildDocs(src, BASE, { cap: 400 });
  expect(d.truncated).toBe(true);
  expect(bytes(d.body)).toBeLessThanOrEqual(400);
  expect(d.bytes).toBeGreaterThan(400);              // the size BEFORE the cut: "how much is missing"
  expect(d.body).toContain(BASE);
  expect(d.body.split("\n").every((l: string) => l === "" || !l.startsWith("a line of tex" + "t".repeat(2)))).toBe(true);
});

test("a cut inside a fenced block closes the fence it opened", () => {
  const src = `# T\n\nintro\n\n\`\`\`js\n${"const line = 1;\n".repeat(40)}\`\`\`\n\ntail\n`;
  const d = buildDocs(src, BASE, { cap: 260 });
  expect(d.truncated).toBe(true);
  expect(bytes(d.body)).toBeLessThanOrEqual(260);
  // an odd number of fences means one is open, and an open fence eats every section after it
  expect((d.body.match(/^```/gm) ?? []).length % 2).toBe(0);
});

test("a body under the cap is not touched and is not marked truncated", () => {
  const r = truncate("short enough", 1024, "note");
  expect(r).toEqual({ body: "short enough", truncated: false });
});

// ------------------------------------------------------------------ the whole pass

test("frontmatter is dropped: it is already columns on the row, not documentation", () => {
  expect(stripFrontmatter("---\nname: x\ndescription: y\n---\n\n# Body\n")).toBe("\n# Body\n");
  expect(stripFrontmatter("# No frontmatter\n")).toBe("# No frontmatter\n");
});

/** "No documentation" is a normal state for a row, so the pass says so with null rather than handing back
 *  an empty body the display side would draw a heading over. */
test("nothing worth carrying returns null, not an empty docs object", () => {
  expect(buildDocs("---\nname: x\ndescription: y\n---\n", BASE)).toBeNull();
  expect(buildDocs("", BASE)).toBeNull();
  expect(buildDocs("   \n\n  ", BASE)).toBeNull();
  expect(buildDocs("<!-- only a comment -->", BASE)).toBeNull();
  expect(buildDocs(null, BASE)).toBeNull();          // an unreachable fetch returns null upstream
});

test("the shape is exactly what the catalog schema promises", () => {
  const d = buildDocs("# T\n\nbody text\n", BASE);
  expect(Object.keys(d).sort()).toEqual(["body", "bytes", "format", "source", "truncated"]);
  expect(d.format).toBe("markdown");
  expect(d.source).toBe(BASE);
  expect(d.truncated).toBe(false);
  expect(d.bytes).toBe(bytes(d.body));               // untruncated: the two agree
});

test("bytes counts bytes, not UTF-16 units, so the cap means what it says", () => {
  const d = buildDocs("# T\n\nişte çok güzel bir satır — em dash\n", BASE);
  expect(d.bytes).toBe(bytes(d.body));
  expect(d.bytes).toBeGreaterThan(d.body.length);    // multi-byte characters really are in there
});

/** The cap was broken once already — the closing fence was appended after the line budget had been spent,
 *  so the output ran one byte over. A single example would not have caught it (the first case I tried came
 *  in nine bytes under by luck), so the invariant gets exercised across shapes and caps instead. */
test("the cap is never exceeded, whatever the shape of the input", () => {
  const pieces = ["# Heading", "", "some prose with a [link](./a.md)", "```js", "const x = 1;", "```",
                  "~~~", "tilde fenced", "~~~", "a much longer line ".repeat(6), "üçüncü satır çok güzel", "- bullet",
                  // The three CommonMark title forms and a title carrying the characters that end an
                  // attribute. These were NOT in the generator, which is exactly why 40 000 rounds found
                  // nothing and a security review found the single-quoted form in minutes: a fuzzer only
                  // explores the alphabet it is given.
                  `[a](https://e.com "double")`, `[b](https://e.com 'single')`, `[c](https://e.com (paren))`,
                  `[d](https://e.com 'has " quote')`, `[e](./rel.md "has <tag> and > sign")`,
                  `[f](<https://e.com/a b> 'spaced target')`, `[g](https://e.com/x_(y) "balanced parens")`,
                  "[unclosed](https://e.com 'never", "[ref]: ./n.md 'a title'", "![img](./a.png \"alt\")",
                  `[h](javascript:alert(1) 'x')`, `[i](JavaScript:alert(1))`, `[j](data:text/html,x 'y')`];
  // Seeded and fixed by DEFAULT, so this is a regression net that fails for the commit that broke it and
  // for no other reason — the same rule the catalog --check jobs are split on. The two knobs let the
  // scheduled job run a different, much longer search, where a red result means "go look" rather than
  // "your branch is broken"; on failure the seed is printed so the shape can be replayed here.
  let seed = SEED;
  const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = 0; i < ROUNDS; i++) {
    const lines: string[] = [];
    for (let n = Math.floor(next() * 40); n > 0; n--) lines.push(pieces[Math.floor(next() * pieces.length)]!);
    const cap = 60 + Math.floor(next() * 900);
    const d = buildDocs(lines.join("\n"), BASE, { cap });
    if (d === null) continue;
    const where = `seed ${SEED}, round ${i}, cap ${cap} (replay: ROVECODE_FUZZ_SEED=${SEED})`;
    expect(bytes(d.body), where).toBeLessThanOrEqual(cap);
    // "balanced" has to be asked the way the parser defines it: a ~~~ line INSIDE a ``` block is content,
    // not a fence, so counting markers with a regex reports a false imbalance. If nothing is open, the
    // repair is a no-op — that is the invariant, and it is the same code path the generator relies on.
    expect(closeOpenFence(d.body), where).toBe(d.body);

    // No shape of input may leave a dangerous scheme in a link position, and no title may carry a quote
    // out — a title re-emitted verbatim is how `'a" onmouseover="alert(1)'` reached a `title` attribute
    // even after the pattern started matching it. Fences are exempt: they are text by construction.
    // proseOnly, not a regex: a regex pairs an opening ``` with a closing ~~~ and hands back fenced
    // content as prose. That misfired here on the first run — a javascript: link INSIDE a fence, which is
    // text and perfectly safe, was reported as a leak.
    const prose = proseOnly(d.body);
    expect(prose, where).not.toMatch(/\]\(\s*(?:javascript|data|vbscript):/i);
    for (const link of prose.match(/\]\([^)\n]*\)/g) ?? []) {
      expect((link.match(/"/g) ?? []).length % 2, `${where}: unbalanced quotes in ${link}`).toBe(0);
      expect(link, where).not.toMatch(/["'][^"']*["'][^"']*["']/);   // never three quote characters
    }
  }
}, FUZZ_TIMEOUT);

/** The second hole of the same class, found by a security review rather than by the fuzz — and the reason
 *  the fuzz now generates all three CommonMark title forms.
 *
 *  `[x](https://e.com 'a" onmouseover="alert(1)')` is legal CommonMark: a single-quoted title, which the
 *  pattern only recognised in double quotes. It therefore did not match, and the link was copied through
 *  UNTOUCHED — straight into a `title` attribute in the rendered page. Matching it is only half the fix:
 *  a title copied out verbatim carries the same payload into a form we DO match, so titles are stripped of
 *  the characters that can close an attribute or open a tag and re-emitted in one canonical shape. */
test("every CommonMark title form is recognised, and no title carries a quote back out", () => {
  expect(absolutiseLinks(`[x](https://e.com 'a" onmouseover="alert(1)')`, BASE))
    .toBe(`[x](https://e.com/ "a onmouseover=alert(1)")`);
  expect(absolutiseLinks(`[x](https://e.com (paren title))`, BASE)).toBe(`[x](https://e.com/ "paren title")`);
  expect(absolutiseLinks(`[x](https://e.com "plain")`, BASE)).toBe(`[x](https://e.com/ "plain")`);
  expect(absolutiseLinks(`[x](https://e.com '<img src=x onerror=alert(1)>')`, BASE))
    .toBe(`[x](https://e.com/ "img src=x onerror=alert(1)")`);
  // a title on a reference definition takes the same path
  expect(absolutiseLinks(`[ref]: https://e.com 'a" onmouseover="x'`, BASE))
    .toBe(`[ref]: https://e.com/ "a onmouseover=x"`);
});

test("a dangerous scheme is still refused when it hides behind a title", () => {
  expect(absolutiseLinks(`[x](javascript:alert(1) 'title')`, BASE)).toBe("x");
  expect(absolutiseLinks(`[x](data:text/html,<script>1</script> "t")`, BASE)).toBe("x");
});

/** The design change behind both fixes: a shape we cannot read must STOP being a link, because the
 *  renderer's parser is more generous than any pattern we write. Failing by copying through is what let
 *  two holes past. */
test("a link shape that cannot be read degrades to plain text rather than passing through", () => {
  const out = absolutiseLinks("[unclosed](https://e.com 'never closed", BASE);
  expect(out).not.toContain("](");                    // no link markup survives
  expect(out).toContain("unclosed");                  // the words do
});

test("a destination is re-emitted encoded, so dropping the angle brackets cannot produce a broken link", () => {
  // <...> legally carries a space; without the brackets that space has to become %20 or the link breaks
  expect(absolutiseLinks(`[s](<https://e.com/a b> "t")`, BASE)).toBe(`[s](https://e.com/a%20b "t")`);
});
