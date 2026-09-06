/** docs/*.md and the README's command reference → src/generated/docs.json, for the /docs/ pages.
 *
 *  Only when VITE_DOCS=1 (`bun run build:docs`, the production build since 2026-09-04); otherwise writes an empty list so
 *  the default build is unchanged. Markdown → HTML with marked; heading ids for the in-page index; relative links
 *  to other docs become /docs/<slug>/, other relative links point at the repository on GitHub. The docs body stays
 *  English — it is documentation, not copy. The site checkout is written to; this repository is only read. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { marked } from "marked";

// SITE and REPO are overridable because the website moved to its own repository on 2026-09-06 while
// these generators stayed here, with the content they read. scripts/publish-site-data.sh points SITE at
// the site checkout and REPO at this one; with neither set they behave exactly as they did in the
// monorepo, so nothing else has to know the split happened.
const SITE = process.env.SITE_DIR ?? join(import.meta.dirname, "..");
const REPO = process.env.ROVECODE_REPO ?? join(SITE, "..");
const OUT = join(SITE, "src", "generated", "docs.json");
const GITHUB = "https://github.com/9Code-Labs/rovecode/blob/main";
const ON = process.env.VITE_DOCS === "1";

/** the documents, in index order; `readme` takes a slice of README.md between two h2 headings */
const SOURCES = [
  { slug: "commands", title: "Command reference", file: "README.md", from: "## Install", to: "## Features beyond" },
  { slug: "design", file: "docs/design.md" },
  { slug: "thinking", file: "docs/thinking.md" },
  { slug: "market", file: "docs/market.md" },
  { slug: "mcp-market", file: "docs/mcp-market.md" },
  { slug: "context", file: "docs/context.md" },
  { slug: "plugins", file: "docs/plugins.md" },
  { slug: "deploy", file: "docs/deploy.md" },
];

const slugify = (s) => s.toLowerCase().replace(/<[^>]+>/g, "").replace(/[`*_]/g, "").replace(/[^\p{L}\p{N}\s-]/gu, "").trim().replace(/\s+/g, "-");
const known = new Set(SOURCES.map((s) => s.slug));
const slugOf = (mdPath) => mdPath.replace(/^.*\//, "").replace(/\.md$/, "");

function build(src) {
  return renderDoc(readFileSync(join(REPO, src.file), "utf8"), src);
}

/** markdown → the page record, with nothing read and nothing written: the part worth testing */
export function renderDoc(source, src) {
  let md = source.replace(/\r\n?/g, "\n"); // Windows checkouts: CRLF hides the h1 from the strip below and reaches marked
  if (src.from) {
    const a = md.indexOf(src.from), b = md.indexOf(src.to, a + 1);
    md = md.slice(a, b < 0 ? undefined : b);
  }
  const title = src.title ?? (/^#\s+(.+)$/m.exec(md)?.[1] ?? src.slug);
  md = md.replace(/^#\s+.+\n/m, "");           // the h1 is rendered by the page shell
  if (src.from) md = md.replace(/^## /gm, "## "); // README slices keep their h2s as sections
  const toc = [];
  const renderer = new marked.Renderer();
  const seen = new Map();
  renderer.heading = ({ text, depth, tokens }) => {
    // display text keeps its underscores (ROVECODE_EFFORT); only the emphasis/code markers go
    const plain = tokens.map((t) => (t.type === "codespan" || t.type === "text" ? t.text : t.raw ?? "")).join("").replace(/[`*]/g, "");
    let id = slugify(plain); const n = seen.get(id) ?? 0; seen.set(id, n + 1); if (n) id = `${id}-${n}`;
    if (depth <= 3) toc.push({ id, text: plain, depth });
    const inner = renderer.parser.parseInline(tokens);
    // the heading links to itself, unless it already holds a link: <a> inside <a> is not nestable markup
    const body = /<a\b/i.test(inner) ? inner : `<a href="#${id}">${inner}</a>`;
    return `<h${depth} id="${id}">${body}</h${depth}>\n`;
  };
  renderer.link = ({ href, title: t, tokens }) => {
    // the child tokens are already parsed: re-tokenizing their raw text autolinks a bare URL a second
    // time and nests one <a> inside another (axe link-name, the outer anchor has no text of its own).
    // `<https://example.com>` is valid CommonMark and documents do use it, so the fix belongs here.
    const inner = renderer.parser.parseInline(tokens);
    let h = href;
    if (/^(\.\.?\/)?[\w./-]+\.md(#.*)?$/.test(href) && !/^https?:/.test(href)) {
      const [path, hash = ""] = href.split("#");
      const slug = slugOf(path);
      h = known.has(slug) ? `/docs/${slug}/${hash ? "#" + hash : ""}` : `${GITHUB}/${path.replace(/^(\.\.\/)+|^\.\//, "").replace(/^docs\/docs\//, "docs/")}${hash ? "#" + hash : ""}`;
      if (!known.has(slug) && /^\.\//.test(href) && src.file.startsWith("docs/")) h = `${GITHUB}/docs/${path.replace(/^\.\//, "")}${hash ? "#" + hash : ""}`;
    } else if (!/^(https?:|mailto:|#|\/)/.test(href)) {
      h = `${GITHUB}/${href.replace(/^\.\//, "")}`;
    }
    const ext = /^https?:/.test(h);
    return `<a href="${h}"${t ? ` title="${t}"` : ""}${ext ? ' target="_blank" rel="noreferrer"' : ""}>${inner}</a>`;
  };
  let html = marked.parse(md, { renderer, gfm: true, breaks: false });
  // the first prose paragraph (the source hard-wraps at ~100 columns, so join its lines) as plain text, links → their label, cut at a sentence end
  const block = md.split(/\n\s*\n/).map((b) => b.trim()).find((b) => b.length >= 40 && !/^(#|\||```|- |\d+\. |<)/.test(b) && !b.includes("\n```")) ?? "";
  const para = block.replace(/\s*\n\s*/g, " ").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/[`*]/g, "");
  const summary = para.length <= 200 ? para : (para.slice(0, 200).match(/^[\s\S]*[.!?](?=\s|$)/)?.[0] ?? para.slice(0, 197).trimEnd() + "\u2026");
  // overflow-x regions must be keyboard-scrollable (axe scrollable-region-focusable); the global :focus-visible ring covers them
  html = html.replace(/<pre>/g, '<pre tabindex="0">').replace(/<table>/g, '<table tabindex="0">');
  return { slug: src.slug, title, source: src.file, summary, toc, html, words: md.split(/\s+/).length };
}

// only when this file IS the script: a test may import renderDoc without writing anything
if (import.meta.main) {
  mkdirSync(join(SITE, "src", "generated"), { recursive: true });
  const docs = ON ? SOURCES.filter((s) => existsSync(join(REPO, s.file))).map(build) : [];
  writeFileSync(OUT, JSON.stringify({ enabled: ON, docs }, null, 1) + "\n");
  console.log(ON ? `docs: ${docs.length} pages (${docs.map((d) => `${d.slug} ${d.words}w`).join(", ")})` : "docs: off (set VITE_DOCS=1)");
}
