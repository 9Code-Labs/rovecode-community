/** The documentation a market item carries, rendered at build time.
 *
 *  A catalog entry may bring its own docs: `docs: { source, format: "markdown", bytes, truncated, body }`.
 *  The body is THIRD-PARTY TEXT — it comes from whoever published the skill or the plugin, not from us — so
 *  it is rendered here under two rules that the rest of the site does not need:
 *
 *  1. NO RAW HTML, EVER. `marked` is told to drop html tokens rather than pass them through, and the source
 *     is stripped of tag-looking runs before it is parsed. The catalog generator sanitises too; this is the
 *     second layer, because a page that injects a stranger's HTML is a page that will eventually inject a
 *     stranger's script.
 *  2. A LINK IS ALWAYS EXTERNAL. A relative link inside someone else's README means nothing on our origin,
 *     so it is resolved against their source URL when we can, and dropped to plain text when we cannot.
 *
 *  Everything else deliberately matches docs-build.mjs beside it — the same heading ids and anchors, the same
 *  `tabindex="0"` on scrollable `<pre>`/`<table>` (axe scrollable-region-focusable) — so /docs/ and a market
 *  item's documentation read as one product. The rules are duplicated rather than shared because the two
 *  differ exactly where it matters: /docs/ renders OUR files and may link between them; this renders theirs
 *  and may not. */
import { marked } from "marked";

/** the id an anchor gets: lowercase, words joined by dashes, nothing else */
const slugify = (s) =>
  s.toLowerCase().trim().replace(/[^\p{L}\p{N}\s-]/gu, "").replace(/\s+/g, "-").replace(/-+/g, "-").slice(0, 80) || "section";

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ESCAPES[c]);

/** a CommonMark autolink — `<https://example.com/a>`, `<mailto:x@e.com>`, `<x@e.com>` — which is markdown
 *  that happens to look like a tag. It survives the strip below and is rendered as a link like any other. */
const AUTOLINK = /^<(?:[a-zA-Z][\w+.-]{1,31}:[^<>\s]*|[^<>\s@]+@[^<>\s@]+\.[^<>\s@]+)>$/;

/** tags that were a line break in the original: removing them silently glues the words on either side
 *  together — a `<details><summary>Using OAuth</summary>` next to another one became "Using OAuthUsing a
 *  GitHub PAT", which is a sentence neither author wrote */
const BLOCK_TAG = /^<\/?(?:p|div|br|hr|li|ul|ol|dl|dt|dd|table|thead|tbody|tr|td|th|details|summary|section|article|header|footer|nav|aside|blockquote|pre|h[1-6])\b/i;

/** strip anything that would reach the renderer as html: the elements whose CONTENT is code (script,
 *  style and friends go body and all — leaving `alert(1)` as a paragraph is inert but reads like a bug),
 *  then comments, then every remaining tag */
function stripTags(md) {
  return md
    .replace(/<(script|style|iframe|object|embed|template|noscript)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<(script|style|iframe|object|embed|template|noscript)\b[^>]*>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\/?[a-zA-Z][^>]*>/g, (tag) => (AUTOLINK.test(tag) ? tag : BLOCK_TAG.test(tag) ? "\n" : ""));
}

/** run `fn` over everything EXCEPT fenced code blocks. A fence is quoted source: a README that shows
 *  `<div id="app"></div>` or a `[label](url)` is showing it on purpose, and marked escapes a fence's
 *  contents anyway, so nothing in there can become markup however it is left. */
function mapOutsideFences(md, fn) {
  const parts = md.split(/^(```+|~~~+)/m);
  // odd indexes are the fence markers, so an odd NUMBER of them means the last block never closes — a
  // body cut at 24 KB often ends mid-fence. Nothing after an unclosed fence counts as code.
  const markers = (parts.length - 1) / 2;
  const openEnded = markers % 2 === 1;
  let out = "";
  let inFence = false;
  for (let i = 0; i < parts.length; i++) {
    const piece = parts[i];
    if (i % 2 === 1) { inFence = !inFence; out += piece; continue; }
    const last = i === parts.length - 1;
    out += inFence && !(openEnded && last) ? piece : fn(piece);
  }
  return out;
}

const stripHtml = (md) => mapOutsideFences(md, stripTags);

/** resolve a link inside someone else's document: absolute stays, relative is rebuilt against their source,
 *  anything else becomes plain text (the label survives, the dead link does not) */
const SAFE_SCHEMES = new Set(["http:", "https:", "mailto:"]);

/** the resolved URL, or null when it is not one a page may follow. The scheme is checked AFTER resolving,
 *  because that is the only string that ends up in the href: `new URL()` preserves whatever scheme it is
 *  handed, and marked 18 no longer filters any of them, so `javascript:` and `data:` reach this function
 *  intact. A rejected link keeps its words and loses its href. */
function resolveLink(href, source) {
  if (/^#/.test(href)) return href; // an in-page anchor has no scheme to check
  const base = source ? (source.endsWith("/") ? source : `${source.replace(/\/[^/]*$/, "")}/`) : undefined;
  let url;
  try {
    url = base ? new URL(href, base) : new URL(href);
  } catch {
    return null;
  }
  return SAFE_SCHEMES.has(url.protocol) ? url.href : null;
}

/**
 * Render one item's documentation.
 * @param {{ source?: string, format?: string, bytes?: number, truncated?: boolean, body?: string }} docs
 * @returns {{ html: string, toc: { id: string, text: string }[], source: string, truncated: boolean, words: number } | null}
 */
export function renderItemDocs(docs) {
  if (!docs || typeof docs.body !== "string" || docs.body.trim() === "") return null;
  // a format we do not render is not an error: the page simply links the source instead of guessing
  if (docs.format !== undefined && docs.format !== "markdown") return null;

  const source = typeof docs.source === "string" ? docs.source : "";
  let md = stripHtml(docs.body.replace(/\r\n?/g, "\n"));
  // a SKILL.md opens with a frontmatter block: metadata for the model, not prose for a reader
  md = md.replace(/^---\n[\s\S]*?\n---\n/, "");
  // the body's own h1 repeats the item's title, which the page already shows above it
  md = md.replace(/^\s*#\s+.+\n/, "");

  // A third-party document sets its own heading levels: some start at ##, some at ###, some mix. The page
  // already spends h1 on the item and h2 on "Documentation", so the shallowest heading in the body becomes
  // h3 and the rest keep their relative depth — otherwise a document that opens at ### produces an h4 with
  // no h3 above it, which is an accessibility finding (heading-order) and a lie about the structure.
  // …and the levels a document actually USES are compacted, not just shifted: a README that goes ## then
  // #### (skipping ###) would otherwise produce h3 then h5, which axe reports as heading-order. Mapping the
  // distinct depths onto consecutive levels keeps the hierarchy and removes the gaps.
  const used = [...new Set([...md.matchAll(/^(#{1,6})\s+\S/gm)].map((m) => m[1].length))].sort((a, b) => a - b);
  const levelOf = new Map(used.map((d, i) => [d, Math.min(3 + i, 6)]));

  const toc = [];
  const seen = new Map();
  // ...and no heading may sit more than one level below the one before it: a document that goes ## then
  // #### skips a level in READING order, which is the finding axe reports, so the jump is clamped.
  let prev = 2;
  const renderer = new marked.Renderer();
  renderer.heading = ({ text, depth, tokens }) => {
    const plain = tokens.map((t) => (t.type === "codespan" || t.type === "text" ? t.text : t.raw ?? "")).join("").replace(/[`*]/g, "");
    let id = `doc-${slugify(plain)}`;
    const n = seen.get(id) ?? 0;
    seen.set(id, n + 1);
    if (n) id = `${id}-${n}`;
    // the top TWO levels of whatever the document uses are navigation; deeper ones are structure
    const level = Math.max(3, Math.min(levelOf.get(depth) ?? 3, prev + 1));
    prev = level;
    // the top two levels the document uses are navigation; deeper ones are structure
    if (level <= 4) toc.push({ id, text: plain, depth: level });
    const inner = renderer.parser.parseInline(tokens);
    // the heading is its own permalink — unless it already contains a link, because an <a> inside an <a>
    // is not markup a browser can nest and the outer one would have no text of its own
    const body = /<a\b/i.test(inner) ? inner : `<a href="#${id}">${inner}</a>`;
    return `<h${level} id="${id}">${body}</h${level}>\n`;
  };
  renderer.link = ({ href, title, tokens }) => {
    // a bare URL arrives as a link whose only child is that URL as text; re-parsing it inline would
    // autolink it a second time and nest one <a> inside another
    const plain = tokens.length === 1 && tokens[0]?.type === "text";
    const inner = plain ? escapeHtml(tokens[0].text) : renderer.parser.parseInline(tokens);
    const h = resolveLink(href, source);
    if (!h) return inner; // unresolvable: keep the words, drop the link
    // a link whose whole label was an image (an install badge, a shields.io button) has no words left
    // once the image is refused: an <a> with nothing readable in it is a screen-reader dead end, so the
    // href becomes the label rather than the link becoming invisible
    const label = inner.replace(/<[^>]*>/g, "").trim() === "" ? escapeHtml(h.length > 60 ? `${h.slice(0, 57)}…` : h) : inner;
    const ext = /^https?:/i.test(h);
    return `<a href="${h}"${title ? ` title="${escapeHtml(String(title))}"` : ""}${ext ? ' target="_blank" rel="noreferrer nofollow"' : ""}>${label}</a>`;
  };
  renderer.image = ({ href, title, text }) => {
    // an image from a stranger is a request to their server from our page; the alt text is kept, the
    // request is not made
    // alt text first, then the title; an image with neither says so rather than naming its own URL,
    // which reads like a link to somewhere it is not
    const label = escapeHtml(String(text || title || "image"));
    return `<span class="doc-image">[${label}]</span>`;
  };
  renderer.html = () => "";

  let html = marked.parse(md, { renderer, gfm: true, breaks: false });
  html = html.replace(/<pre>/g, '<pre tabindex="0">').replace(/<table>/g, '<table tabindex="0">');
  return {
    html,
    // the same body as markdown, cleaned the same way (HTML gone, frontmatter gone, the item title gone)
    // and then thinned for the reader it actually has: what /market/<id>/index.md serves
    markdown: markdownForMachines(md, source),
    toc: toc.filter((h) => h.depth === 3).map(({ id, text }) => ({ id, text })),
    source,
    truncated: docs.truncated === true,
    words: md.split(/\s+/).filter(Boolean).length,
  };
}

/** The markdown mirror's reader is a context window, not a person, so the measure of this pass is tokens
 *  per fact. Three things in a README cost tokens and carry none of them:
 *
 *    · badges — `[![Install in VS Code](https://img.shields.io/badge/…)](https://insiders.vscode.dev/…)`
 *      is 300 characters of percent-encoded button for another editor. The label survives as words; the
 *      two URLs do not.
 *    · images — the mirror cannot show them and this renderer refuses to fetch them anyway (the html side
 *      does the same). The alt text is the information; the URL is the address of a picture.
 *    · a relative link — `[policies](./docs/policy.md)` — is broken for anything that reads this file,
 *      because the file is served from a path the document has never heard of. Resolved against the
 *      document's own source, or dropped to its words when it cannot be resolved.
 *
 *  Everything else is left exactly as its author wrote it: prose, code blocks, tables, headings. */
export function markdownForMachines(md, source = "") {
  const keep = (label) => label.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\s+/g, " ").trim();
  // marks a run of text that used to be a badge, so a line that is ONLY badges can be dropped whole:
  // "Install in VS Code Install in VS Code Insiders Install in Visual Studio" is a row of buttons for
  // other editors, and as words it says nothing this reader can act on
  const MARK = String.fromCharCode(0);
  const out = mapOutsideFences(md, (text) => text
    // a link whose whole label is an image: a badge or an install button. Its words, never its URLs.
    .replace(/\[!\[([^\]]*)\]\([^)]*\)\]\([^)]*\)/g, (_m, alt) => `${MARK}${keep(alt)}${MARK}`)
    // a plain image: its alt text, or nothing when it has none
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, (_m, alt) => keep(alt))
    // every remaining link: the href resolved against the source, or the label alone
    .replace(/\[([^\]]*)\]\(([^)\s]+)(\s+"[^"]*")?\)/g, (m, label, href) => {
      const text = keep(label);
      if (!text) return "";
      const resolved = resolveLink(href, source);
      return resolved ? `[${text}](${resolved})` : text;
    })
    .split("\n")
    .map((line) => {
      // a line whose every word came from a badge goes entirely; anywhere else the words stay and only
      // the marks go, because there the label is part of a sentence
      const withoutBadges = line.replace(new RegExp(`${MARK}[^${MARK}]*${MARK}`, "g"), "").trim();
      const l = withoutBadges === "" ? "" : line.split(MARK).join("");
      // …and a line left holding empty brackets is worse than a line that is gone
      const empty = /^[\s[\]()·|-]*$/.test(l) && !/^\s*([-*+]|\d+\.)\s/.test(l) && !/^\s*\|/.test(l) && !/^\s*-{3,}\s*$/.test(l);
      return empty ? "" : l.replace(/[ \t]+$/, "");
    })
    .join("\n"));
  // blank runs are collapsed across the whole document, fences included: three empty lines say what one does
  return out
    .replace(/\n{3,}/g, "\n\n")
    // the body's own h1 repeats the item's title, which the file already carries as its first line — it is
    // only reachable here when a badge row used to stand in front of it
    .replace(/^\s*#\s+.+\n/, "")
    .trim();
}

/** The same body as plain lines for the TUI: headings marked, code blocks kept, everything a terminal must
 *  not be asked to interpret removed — escape sequences, control characters, and the C1 range that some
 *  terminals still treat as CSI. A document must not be able to paint the cockpit. */
export function docsToLines(docs, width = 96) {
  if (!docs || typeof docs.body !== "string") return [];
  const safe = stripHtml(docs.body.replace(/\r\n?/g, "\n"))
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
    .replace(/\t/g, "  ");
  const out = [];
  let inFence = false;
  for (const raw of safe.split("\n")) {
    if (/^\s*```/.test(raw)) { inFence = !inFence; out.push({ kind: "rule", text: "" }); continue; }
    if (inFence) { out.push({ kind: "code", text: raw.slice(0, width) }); continue; }
    const h = /^(#{1,6})\s+(.*)$/.exec(raw);
    if (h) { out.push({ kind: "head", text: h[2].replace(/[`*]/g, "").slice(0, width) }); continue; }
    const text = raw.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[`*]/g, "");
    if (text.trim() === "") { out.push({ kind: "blank", text: "" }); continue; }
    // wrap prose to the column; a list marker keeps its indent on the continuation lines
    const indent = /^(\s*(?:[-*+]|\d+\.)\s+)/.exec(text)?.[1]?.length ?? 0;
    let line = "";
    for (const word of text.split(/\s+/).filter(Boolean)) {
      const piece = word.length > width ? word.slice(0, width) : word;
      if (!line) { line = piece; continue; }
      if (line.length + 1 + piece.length <= width) line += ` ${piece}`;
      else { out.push({ kind: "text", text: line }); line = " ".repeat(Math.min(indent, 8)) + piece; }
    }
    if (line) out.push({ kind: "text", text: line });
  }
  return out;
}
