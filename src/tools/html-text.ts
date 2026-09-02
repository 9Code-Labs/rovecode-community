/** Compact HTML → readable text (PORT #31). Stands in for the html-to-text
 *  dependency gemini-cli uses (Apache-2.0, 0bd1d43, packages/core/src/tools/
 *  web-fetch.ts:704-709: links keep their href, images are skipped) and for
 *  opencode's htmlparser2 skip-depth extractor (MIT, ebece6e, packages/opencode/
 *  src/tool/webfetch.ts:158-180: script/style/noscript/iframe/object subtrees
 *  dropped; <embed> is void, so unlike opencode it is not depth-tracked). One
 *  regex tokenizer pass: raw-text elements are jumped over wholesale, dropped
 *  subtrees are depth-tracked, block elements become line breaks, list items
 *  get "- ", links render as `text (href)` resolved against the page URL,
 *  entities are decoded, whitespace collapses except inside <pre>. Not a spec
 *  parser (no tree, no adoption agency) but the tokenizer follows the HTML5
 *  tag and attribute states, so quoted attribute values may contain "<" and
 *  ">". Every scan is bounded (see tagRx) so a hostile body parses in O(n):
 *  the tool's timeout cannot interrupt a synchronous parse, so the parse must
 *  never be the slow part. */

/** Elements whose CONTENT is raw text up to the matching close tag. <title> is
 *  RCDATA and never rendered, so a page that omits <head> still loses its title. */
const RAW = new Set(["script", "style", "noscript", "template", "title"]);
/** Elements dropped with their whole (markup) subtree. <head> also ends at the
 *  first start tag outside HEAD_ONLY: an omitted </head> — even an omitted
 *  <body> — is legal HTML, common in minified pages. */
const DROP = new Set(["head", "svg", "iframe", "object", "canvas", "audio", "video", "select"]);
/** Start tags the HTML5 "in head" insertion mode keeps inside <head>; any other
 *  start tag implies </head> (and <body>). RAW members are jumped before the
 *  check ever runs — listed so the set reads as the spec's. */
const HEAD_ONLY = new Set(["head", "meta", "link", "base", "basefont", "bgsound", "noframes", "title", "style", "script", "noscript", "template"]);
/** Elements that break lines; PARA members separate with a blank line. */
const BLOCK = new Set([
  "address", "article", "aside", "blockquote", "body", "caption", "center", "dd", "details", "dialog", "div", "dl", "dt",
  "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "html",
  "legend", "main", "menu", "nav", "ol", "p", "pre", "section", "summary", "table", "tbody", "tfoot", "thead", "tr", "ul",
]);
const PARA = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "ul", "ol", "table", "figure"]);

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", shy: "", copy: "©", reg: "®", trade: "™",
  hellip: "…", mdash: "—", ndash: "–", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", laquo: "«", raquo: "»",
  bull: "•", middot: "·", deg: "°", times: "×", divide: "÷", plusmn: "±", euro: "€", pound: "£", yen: "¥", cent: "¢",
  sect: "§", para: "¶", larr: "←", rarr: "→", uarr: "↑", darr: "↓", harr: "↔", frac12: "½", frac14: "¼", frac34: "¾",
  sup2: "²", sup3: "³", micro: "µ", iexcl: "¡", iquest: "¿",
};

/** Named (common subset), decimal and hex character references; unknown ones are kept verbatim. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, body: string) => {
    if (body[0] === "#") {
      const cp = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return cp > 0 && cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff) ? String.fromCodePoint(cp) : m;
    }
    return ENTITIES[body] ?? m;
  });
}

function attr(attrs: string, key: string): string | undefined {
  const m = new RegExp(`(?:^|\\s)${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i").exec(attrs);
  return m ? decodeEntities(m[1] ?? m[2] ?? m[3] ?? "").trim() : undefined;
}

function resolveHref(href: string, baseUrl: string | undefined): string {
  try { return new URL(href, baseUrl).href; } catch { return href; }
}

/** Readable text for an HTML document. `baseUrl` resolves relative link hrefs. */
export function htmlToText(html: string, baseUrl?: string): string {
  const out: string[] = [];
  let skip = 0; // depth inside DROP subtrees
  let pre = 0;  // depth inside <pre>
  let inHead = false; // between <head> and </head>, explicit or implied
  let link: { href: string; start: number } | null = null;
  // Linear-time tokenizer (MED-3): every alternative is deterministic, so each
  // character is examined once. Comment/CDATA run lazily to their close or EOF
  // (unterminated swallows the rest, as browsers do). A tag, once opened, never
  // backs out: the name runs to the next blank, "/" or ">" (HTML5 tag-name state —
  // `<a<a<a…` is ONE element, as in a browser), the attribute part must START with
  // a blank or "/" so the name and attribute quantifiers can never trade characters
  // (that nesting made `<aaaa…` quadratic), and inside it a quoted value consumes
  // "<" and ">" while an unterminated quote runs to EOF ("eof-in-tag"), so raw-text
  // jumps and subtree drops engage on legal markup like <script data-x="<">.
  const tagRx = /<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>|$)|<[!?][^<>]*>|<\/?([a-zA-Z][^\s/>]*)((?:[\s/](?:[^>"']|"[^"]*(?:"|$)|'[^']*(?:'|$))*)?)(?:>|$)/g;
  let pos = 0;

  const text = (raw: string): void => {
    if (skip > 0 || raw === "") return;
    let s = decodeEntities(raw);
    if (pre === 0) {
      s = s.replace(/\s+/g, " ");
      const last = out.length > 0 ? out[out.length - 1]! : "\n";
      if (last.endsWith("\n") || last.endsWith("- ")) s = s.trimStart();
    }
    if (s) out.push(s);
  };

  let m: RegExpExecArray | null;
  while ((m = tagRx.exec(html)) !== null) {
    text(html.slice(pos, m.index));
    pos = tagRx.lastIndex;
    const name = m[1]?.toLowerCase();
    if (!name) continue; // comment, doctype, CDATA, processing instruction
    const closing = m[0].startsWith("</");
    if (RAW.has(name)) {
      if (closing) continue;
      const end = html.slice(pos).search(new RegExp(`</${name}\\s*>`, "i"));
      pos = end < 0 ? html.length : pos + end; // the close tag itself is tokenized next and ignored above
      tagRx.lastIndex = pos;
      continue;
    }
    // Browser "in head" insertion mode (MED-4): the first start tag that is not a
    // head-only element — <body>, but also a bare <p> — closes an unclosed <head>.
    if (inHead && !closing && !HEAD_ONLY.has(name)) { inHead = false; skip = 0; }
    if (name === "head") inHead = !closing;
    if (DROP.has(name)) { skip = closing ? Math.max(0, skip - 1) : skip + 1; continue; }
    if (skip > 0) continue;
    if (name === "a") {
      if (!closing) {
        // same-page fragments are judged on the RAW href: resolved against a base they never start with "#"
        const href = attr(m[2] ?? "", "href") ?? "";
        link = { href: href === "" || href.startsWith("#") ? "" : resolveHref(href, baseUrl), start: out.length };
      } else if (link) {
        const label = out.slice(link.start).join("").trim();
        const h = link.href;
        if (h && label && label !== h && !/^(javascript|data|mailto|tel):/i.test(h)) out.push(` (${h})`);
        link = null;
      }
      continue;
    }
    if (name === "br") { out.push("\n"); continue; }
    if (name === "li") { if (!closing) out.push("\n- "); continue; }
    const last = out.length > 0 ? out[out.length - 1]! : "\n";
    if (name === "td" || name === "th") { if (!closing && !last.endsWith("\n")) out.push(" "); continue; }
    if (name === "pre") pre = Math.max(0, pre + (closing ? -1 : 1));
    if (BLOCK.has(name)) { const sep = PARA.has(name) ? "\n\n" : "\n"; if (!last.endsWith(sep)) out.push(sep); }
  }
  text(html.slice(pos));
  // Trailing blanks before a newline: the lookbehind anchors each run at its
  // first blank so a <pre> full of spaces is scanned once (bare `[ \t]+\n`
  // re-scanned the run from every blank — quadratic, minutes on 512KB).
  return out.join("").replace(/(?<=^|[^ \t])[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
