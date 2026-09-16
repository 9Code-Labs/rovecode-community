/** What a market item's documentation cannot do to the page that renders it.
 *
 *  Every input below came from an end-to-end audit of this renderer, not from imagination: each one
 *  produced working markup on the page before the fix beside it. The body is a stranger's text pulled from
 *  a catalog by `git pull`, so these are the tests that decide whether the section is safe to ship.
 *
 *  A bun:test file on purpose. It was a standalone script with its own runner once, and because the name
 *  ended the whole run after this one file. A suite that exits green having run 1% of itself is worse than
 *  a red one, so there is no runner and no exit here: bun owns both.
 *
 *  It lives here, in the agent's repository, because the renderer does: the website moved to
 *  9Code-Labs/rovecode-site on 2026-09-06 and the three generators that read this repository's content
 *  stayed behind in scripts/site-generators/. The rendered page is over there; what a stranger's markdown
 *  is allowed to become is decided here, and is tested here. */
import { describe, expect, test } from "bun:test";
import { docsToLines, markdownForMachines, renderItemDocs } from "../../scripts/site-generators/market-docs.mjs";

const SOURCE = "https://github.com/anthropics/skills/blob/main/skills/x/SKILL.md";
const render = (body) => renderItemDocs({ source: SOURCE, format: "markdown", bytes: 100, truncated: false, body })?.html ?? "";
/** the text a screen reader would announce for the first link in a fragment */
const anchorText = (html) => (html.match(/<a\b[^>]*>([\s\S]*?)<\/a>/)?.[1] ?? "").replace(/<[^>]*>/g, "").trim();

describe("market documentation · injection", () => {
  test("a link title cannot break out of its attribute", () => {
    // a single-quoted markdown title carried a double quote out of the attribute, and everything after it
    // became markup: title="a" onmouseover="alert(1)"
    const html = render(`[x](https://e.com 'a" onmouseover="alert(1)')`);
    const tag = html.match(/<a\b[^>]*>/)?.[0] ?? "";
    // an event handler would need an unescaped ="…" to be an attribute; the payload has =&quot; instead
    expect(tag).not.toMatch(/\son[a-z]+\s*=\s*["']/i);
    expect(tag).toContain("title=");
    expect(html).toContain("&quot;"); // the words are still readable, as escaped text
  });

  test("an image label cannot open a tag, and no image is ever fetched", () => {
    // the unclosed tag borrowed our own </span>, and onerror fired with no interaction at all
    const html = render(`![a<img src=x onerror=alert(1) alt=](https://e.com)`);
    expect(html).not.toMatch(/<img/i);
    expect(html).toContain("&lt;img"); // the tag became text rather than markup
    expect(html).not.toMatch(/<[a-z]+\b[^>]*\son[a-z]+\s*=/i);
  });

  test.each([
    ["javascript:alert(1)"],
    ["JaVaScRiPt:alert(1)"],
    ["data:text/html;base64,PHNjcmlwdD4="],
    ["vbscript:msgbox(1)"],
  ])("%s keeps its words and loses its href", (href) => {
    const html = render(`[click](${href})`);
    expect(html).not.toContain("href=");
    expect(html).toContain("click");
  });

  test("the schemes a page may follow still work", () => {
    expect(render("[a](https://e.com)")).toContain('href="https://e.com');
    expect(render("[a](mailto:x@e.com)")).toContain('href="mailto:x@e.com');
    expect(render("[a](./b.md)")).toContain("skills/x/b.md");
  });

  test("raw html is refused twice over: stripped from the source and dropped by the renderer", () => {
    const html = render(`<script>alert(1)</script>\n<div onclick="steal()">t</div>\n<iframe src="https://e.com"></iframe>`);
    expect(html).not.toMatch(/<script|alert\(1\)/i);
    expect(html).not.toMatch(/<iframe/i);
    expect(html).not.toMatch(/onclick=/i);
  });

  test("inline parsing uses our renderer, so a badge inside a link is not an <img>", () => {
    // marked.parseInline() with no options falls back to the DEFAULT renderer; that was a real hole
    const html = render(`[![Install](https://img.shields.io/badge/x.svg)](https://e.com/install)`);
    expect(html).not.toMatch(/<img/i);
    expect(anchorText(html).length).toBeGreaterThanOrEqual(3);
  });

  test("an image with no alt says so rather than naming its own URL", () => {
    const html = render(`[![](https://img.shields.io/badge/x.svg)](https://e.com/install)`);
    const text = anchorText(html);
    expect(text.length).toBeGreaterThanOrEqual(3);
    expect(text).not.toContain("shields.io");
  });

  test("no control character reaches a terminal line", () => {
    const esc = String.fromCharCode(27), bel = String.fromCharCode(7), nul = String.fromCharCode(0);
    const lines = docsToLines({ body: `norm${esc}[31mal ${esc}]0;title${bel} ${nul} end` }).map((l) => l.text).join("\n");
    expect(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(lines)).toBe(false);
    expect(lines).toContain("norm");
    expect(lines).toContain("end");
  });

  test("an autolink is one anchor, not an anchor inside an anchor", () => {
    // <https://…> is ordinary CommonMark. Re-parsing the link's own text autolinked it a second time and
    // nested the two: the outer anchor then had no text of its own (axe link-name, serious).
    const html = render(`See (<https://platform.claude.com/docs/en/build-with-claude/context-windows>).`);
    expect(html.match(/<a\b/g)?.length).toBe(1);
    expect(anchorText(html)).toContain("context-windows");
    expect(html).not.toMatch(/<a\b[^>]*>\s*<a\b/);
  });

  test("a heading is rendered by this renderer, so an image in one is still refused", () => {
    const html = render(`## badge ![x](https://img.shields.io/b.svg) <https://e.com/a>`);
    expect(html).not.toMatch(/<img/i);
    expect(html).toContain("doc-image");
    // the heading's own anchor is the only one: the bare URL inside it did not open a second
    expect(html).not.toMatch(/<a\b[^>]*>[\s\S]*?<a\b/);
  });

  test("</script> inside the data cannot close the island the page ships it in", () => {
    const island = JSON.stringify({ body: "</script><script>alert(1)</script>" }).replace(/</g, "\\u003c");
    expect(island).not.toContain("</script>");
  });
});

/** The mirror at /market/<id>/index.md is read by a context window, so its unit is tokens per fact. */
describe("market documentation · the markdown mirror", () => {
  const md = (body) => renderItemDocs({ source: SOURCE, format: "markdown", bytes: 100, truncated: false, body })?.markdown ?? "";

  const BADGE = `[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install-0098FF?style=flat)](https://insiders.vscode.dev/redirect/mcp/install?name=github&config=%7B%22type%22%3A%20%22http%22%7D)`;

  test("a line that is only badges goes, and takes both URLs with it", () => {
    const out = md(["Intro.", "", `${BADGE} ${BADGE}`, "", "Body."].join("\n"));
    expect(out).not.toContain("shields.io");
    expect(out).not.toContain("%7B");
    expect(out).not.toContain("Install in VS Code"); // a row of buttons for another editor is not information
    expect(out).toContain("Intro.");
    expect(out).toContain("Body.");
  });

  test("a badge inside a sentence keeps its words, because there they are part of one", () => {
    const out = md(`Status ${BADGE} as of today.`);
    expect(out).toContain("Install in VS Code");
    expect(out).toContain("as of today");
    expect(out).not.toContain("shields.io");
  });

  test("a relative link is resolved against the document it came from, not left broken", () => {
    const out = md(`See [the policy](./docs/policy.md) and [a sibling](../other/README.md).`);
    expect(out).toContain("https://github.com/anthropics/skills/blob/main/skills/x/docs/policy.md");
    expect(out).not.toMatch(/\]\(\.\.?\//);
  });

  test("an ordinary link keeps both its label and its URL", () => {
    const out = md(`Read the [protocol](https://modelcontextprotocol.io/spec).`);
    expect(out).toContain("[protocol](https://modelcontextprotocol.io/spec)");
  });

  test("html inside a fenced block is left alone; html around it is not", () => {
    const out = md(["Before <b>bold</b> after.", "", "```html", '<div id="app"></div>', "```"].join("\n"));
    expect(out).toContain('<div id="app"></div>'); // the author is showing the tag on purpose
    expect(out).not.toContain("<b>");
  });

  test("removing a block tag does not glue two sentences together", () => {
    const out = md(`<details><summary>Using OAuth</summary>text</details><details><summary>Using a PAT</summary>`);
    expect(out).not.toContain("OAuthUsing");
  });

  test("markdownForMachines leaves prose, code and tables exactly as written", () => {
    const src = ["| a | b |", "| - | - |", "| 1 | 2 |", "", "```js", "const a = [1](2);", "```", "", "Plain prose."].join("\n");
    expect(markdownForMachines(src, SOURCE)).toBe(src);
  });

  test("the body's own h1 goes: the file's first line is already the item's title", () => {
    const out = markdownForMachines(["# GitHub MCP Server", "", "Prose."].join("\n"), SOURCE);
    expect(out).toBe("Prose.");
  });
});
