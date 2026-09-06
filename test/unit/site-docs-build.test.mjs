/** What the /docs/ renderer must not produce.
 *
 *  `renderDoc` is the file's pure half: markdown in, the page record out, nothing read and nothing
 *  written. The first case here is a live axe finding — `/zh/docs/context/`, link-name, serious, in every
 *  locale — and it came from ordinary markdown, not from an attack.
 *
 *  The generator lives in this repository (scripts/site-generators/) because the markdown it renders does:
 *  docs/*.md and the README. Only the pages moved to 9Code-Labs/rovecode-site on 2026-09-06. */
import { describe, expect, test } from "bun:test";
import { renderDoc } from "../../scripts/site-generators/docs-build.mjs";

const SRC = { slug: "context", file: "docs/context.md" };
const render = (md) => renderDoc(`# Title\n\n${md}\n`, SRC).html;
const anchors = (html) => html.match(/<a\b/g)?.length ?? 0;

describe("docs renderer · anchors", () => {
  test("an autolink is one anchor whose text is the URL", () => {
    // `(<https://…>)` is valid CommonMark and docs/context.md uses it. The link renderer used to re-parse
    // the link's own raw text, which autolinked it a second time: <a href="…"><a href="…">…</a></a>, and
    // the outer anchor had no text of its own — "Links must have discernible text".
    const html = render("The window (<https://platform.claude.com/docs/en/build-with-claude/context-windows>).");
    expect(anchors(html)).toBe(1);
    expect(html).not.toMatch(/<a\b[^>]*>\s*<a\b/);
    expect(html).toContain(">https://platform.claude.com/docs/en/build-with-claude/context-windows<");
  });

  test("an ordinary link keeps its label and opens off-site in a new tab", () => {
    const html = render("See [the guide](https://example.com/g) for more.");
    expect(anchors(html)).toBe(1);
    expect(html).toContain(">the guide</a>");
    expect(html).toContain('target="_blank"');
  });

  test("a heading that contains a link does not also link to itself", () => {
    const html = render("## See <https://example.com/a>\n\ntext");
    expect(html).not.toMatch(/<a\b[^>]*>[\s\S]*?<a\b/);
    expect(html).toMatch(/<h2 id="[^"]+"/); // the id stays, so the in-page index still reaches it
  });

  test("a heading with no link is its own permalink", () => {
    const html = render("## Context window\n\ntext");
    expect(html).toMatch(/<h2 id="context-window"><a href="#context-window">Context window<\/a><\/h2>/);
  });

  test("a link to another document in this set becomes a site path, not a GitHub blob", () => {
    const html = renderDoc("# T\n\nSee [design](./design.md#tokens).\n", SRC).html;
    expect(html).toContain('href="/docs/design/#tokens"');
  });

  test("scrollable regions are reachable from the keyboard", () => {
    const html = render("```js\nconst a = 1;\n```");
    expect(html).toContain('<pre tabindex="0">');
  });
});
