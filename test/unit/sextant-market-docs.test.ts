/** An item's own documentation inside the market overlay.
 *
 *  The body is a stranger's text — it arrives in a catalog that `git pull` brings in. The tests that matter
 *  here are the ones about what it CANNOT do: no escape sequence, no control character, no HTML that a
 *  terminal or a later renderer might obey. The rest is behaviour: `d` opens and closes the pane, the arrows
 *  belong to whichever thing is in front, and esc backs out one step at a time. */

import { describe, expect, test } from "bun:test";
import { drawMarket, onMarketKey, openMarket, type MarketViewRow } from "../../src/sextant/draw-market.ts";
import { docLines } from "../../src/sextant/market-source.ts";
import { key, makeLayout } from "../helpers/sextant-fixtures-keys.ts";
import { GridScreen, THEME, baseState } from "../helpers/sextant-grid.ts";
import type { SextantState } from "../../src/sextant/types.ts";

const L = makeLayout(150, 40);
/** the docs key: a bare d belongs to the search line ("docker", "deepwiki") */
const ALT_D = key("d", { alt: true });
/** a document longer than any pane, for the scroll clamp */
const LONG_BODY = Array.from({ length: 200 }, (_, i) => `body line ${i}`).join(String.fromCharCode(10));
const render = (s: SextantState): string => {
  const g = new GridScreen(L.w, L.h, " ");
  drawMarket(g, L, THEME, s);
  return g.toText();
};

const DOC_BODY = `---
name: conventional-commits
description: types, one scope, imperative subject
---
# Conventional Commits

A commit message has three parts.

## Subject

- \`type\` from the closed list
- \`scope\` names the module

\`\`\`bash
git commit -m "feat(cli): add the flag"
\`\`\`
`;

const withDocs = (over: Partial<MarketViewRow> = {}): MarketViewRow => ({
  id: "conventional-commits", kind: "skill", title: "conventional-commits", publisher: "Anthropic",
  description: "Conventional Commits: types, one scope, imperative subject.",
  runs: "clone https://github.com/anthropics/skills", env: [],
  docs: { source: "https://github.com/anthropics/skills/blob/main/SKILL.md", truncated: false, lines: docLines(DOC_BODY) },
  ...over,
});
const plain = (over: Partial<MarketViewRow> = {}): MarketViewRow => ({
  id: "filesystem", kind: "mcp", title: "Filesystem", publisher: "modelcontextprotocol (Anthropic)",
  description: "Read, write, search and move files under the directories you name.",
  runs: "npx -y @modelcontextprotocol/server-filesystem", env: [], ...over,
});

function open(rows: MarketViewRow[] = [withDocs(), plain()]) {
  const s = baseState();
  openMarket(s, rows);
  return s;
}

describe("docLines · what a document cannot do", () => {
  test("escape sequences and control characters do not survive", () => {
    const hostile = `norm\u001b[31mal \u001b]0;title\u0007 \u0000 \u007f \u009b2J end`;
    const text = docLines(hostile).map((l) => l.text).join("\n");
    // the ESC bytes are gone, so what is left ("[31m", "2J") is inert text a terminal prints, not obeys
    expect(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(text)).toBe(false);
    expect(text).toContain("norm");
    expect(text).toContain("end");
  });

  test("html goes, and a script's body goes with it", () => {
    const lines = docLines("<script>alert(1)</script>\n<b>bold</b> text\n").map((l) => l.text).join("\n");
    expect(lines).not.toContain("alert(1)");
    expect(lines).not.toContain("<b>");
    expect(lines).toContain("bold text");
  });

  test("frontmatter is dropped, headings and fenced code keep their kind", () => {
    const lines = docLines(DOC_BODY);
    expect(lines.some((l) => l.text.includes("description:"))).toBe(false);
    expect(lines.find((l) => l.kind === "head")?.text).toBe("Conventional Commits");
    expect(lines.some((l) => l.kind === "code" && l.text.includes("git commit"))).toBe(true);
  });

  test("prose wraps to the column and nothing overflows it", () => {
    const long = `${"word ".repeat(60)}`;
    for (const l of docLines(long, 40)) expect(l.text.length).toBeLessThanOrEqual(40);
  });
});

describe("the documentation pane", () => {
  test("d opens the selected item's docs, d closes them again", () => {
    const s = open();
    onMarketKey(s, ALT_D);
    expect(s.market!.docs).toBe(true);
    expect(render(s)).toContain("documentation · conventional-commits");
    onMarketKey(s, ALT_D);
    expect(s.market!.docs).toBe(false);
    expect(render(s)).toContain("what it runs"); // the detail is back
  });

  test("d does nothing on a row that has no documentation", () => {
    const s = open();
    s.market!.sel = 1; // the MCP row, no docs
    onMarketKey(s, ALT_D);
    expect(s.market!.docs).toBe(false);
  });

  test("the arrows scroll the document while it is open, and the list keeps its place", () => {
    const s = open([withDocs({ docs: { source: "https://e.com/s.md", truncated: false, lines: docLines(LONG_BODY) } }), plain()]);
    render(s); // painting publishes the pane height the keys clamp against
    onMarketKey(s, ALT_D);
    onMarketKey(s, key("down"));
    onMarketKey(s, key("down"));
    expect(s.market!.docScroll).toBe(2);
    expect(s.market!.sel).toBe(0); // the selection did not move under the reader
    onMarketKey(s, key("up"));
    expect(s.market!.docScroll).toBe(1);
    onMarketKey(s, key("home"));
    expect(s.market!.docScroll).toBe(0);
  });

  test("End stops at the last screen, and one press of up moves immediately", () => {
    const s = open([withDocs({ docs: { source: "https://e.com/s.md", truncated: false, lines: docLines(LONG_BODY) } }), plain()]);
    render(s);
    onMarketKey(s, ALT_D);
    onMarketKey(s, key("end"));
    const atEnd = s.market!.docScroll;
    expect(atEnd).toBeLessThan(200); // not "the number of lines", which scrolls past the end
    onMarketKey(s, key("up"));
    expect(s.market!.docScroll).toBe(atEnd - 1); // the next key does something, immediately
    onMarketKey(s, key("pagedown"));
    onMarketKey(s, key("pagedown"));
    expect(s.market!.docScroll).toBe(atEnd); // and paging down cannot pass it either
  });

  test("typing does not filter while a document is being read", () => {
    const s = open();
    onMarketKey(s, ALT_D);
    onMarketKey(s, key("g"));
    expect(s.market!.query).toBe("");
  });

  test("esc backs out of the document first, then closes the overlay", () => {
    const s = open();
    onMarketKey(s, ALT_D);
    onMarketKey(s, key("escape"));
    expect(s.market).not.toBeNull();
    expect(s.market!.docs).toBe(false);
    onMarketKey(s, key("escape"));
    expect(s.market).toBeNull();
  });

  test("Enter still asks for the install plan from inside the document", () => {
    const s = open();
    onMarketKey(s, ALT_D);
    const req = onMarketKey(s, key("enter"));
    expect(req).toEqual({ kind: "plan", row: s.market!.rows[0]! });
  });

  test("the pane shows the source, the position, and says when there is more upstream", () => {
    const s = open([withDocs({ docs: { source: "https://example.com/SKILL.md", truncated: true, lines: docLines(DOC_BODY) } })]);
    onMarketKey(s, ALT_D);
    const text = render(s);
    expect(text).toContain("https://example.com/SKILL.md");
    expect(text).toContain("the rest is at the source");
  });

  test("the foot offers the key only when the row has something to open", () => {
    const s = open();
    expect(render(s)).toContain("d docs");
    s.market!.sel = 1;
    expect(render(s)).not.toContain("d docs");
  });

  test("changing the kind tab closes an open document", () => {
    const s = open();
    onMarketKey(s, ALT_D);
    onMarketKey(s, key("tab"));
    expect(s.market!.docs).toBe(false);
  });
});
