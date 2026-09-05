/** Turning a third party's README or SKILL.md into the `docs` field a market row carries.
 *
 *  ONE COPY, ON PURPOSE. Both catalog generators call this. If each had its own cleaning pass they would
 *  drift, and the two would end up with two different answers to "what does this strip" — which for a
 *  field that carries someone else's text into our UI is a security answer, not a formatting one.
 *
 *  What it does, and the reasoning where it is not obvious:
 *
 *  - FENCED CODE IS LEFT ALONE. Nothing below rewrites a link or strips a tag inside a ``` block or an
 *    inline `code` span. This matters more than it sounds: a SKILL.md is mostly examples, several of them
 *    contain HTML, and a "sanitiser" that ate them would silently corrupt the documentation it was meant
 *    to carry. It is also safe — a renderer shows a fence as text, so an HTML tag there was never markup.
 *
 *  - <script>, <style>, <iframe> and HTML comments go WITH THEIR CONTENTS. Removing only the tags would
 *    leave the script body sitting in the page as prose: still wrong, and worse if anything downstream
 *    ever re-wrapped it. Every other tag is unwrapped: the tag goes, its text stays.
 *
 *  - This is NOT the last line of defence, and must not be treated as one. A catalog file arrives through
 *    a git pull like any other file, and markdown itself can produce HTML. The renderer has to keep HTML
 *    off regardless of what happens here.
 *
 *  - Relative links and images become absolute against the document's own URL, because a relative link is
 *    simply broken once the text is shown anywhere but its home repository. A target that is neither
 *    http(s), mailto: nor an anchor is dropped and its text kept — `javascript:` is the case that matters.
 *
 *  - Truncation cuts on a line boundary and CLOSES AN ODD FENCE. Cutting mid-block would otherwise leave
 *    an unterminated ``` and every renderer would swallow the rest of the view into a code block.
 */

const CAP_BYTES = 24 * 1024;
const enc = new TextEncoder();
export const byteLength = (s) => enc.encode(s).length;

/** The note appended when a body is cut.
 *
 *  English, and deliberately so: it is appended INSIDE a third party's document, which is English, and a
 *  sentence embedded in a body cannot be translated the way a rendered line can. The site builds its own
 *  localised sentence from `truncated`, `bytes` and `source` in all fifteen languages and never shows this
 *  one — it exists for the CLI and for anyone reading the raw body, where a document that simply stops
 *  with no marker is the worse outcome. Kept a parameter so a caller can own the wording. */
export const TRUNCATION_NOTE = (url) => `… (truncated — the rest is at ${url})`;

/** Drop a leading `---` frontmatter block. The body is what a reader wants; the frontmatter's fields are
 *  already columns on the row (name, description), so carrying them again would just be noise. */
export function stripFrontmatter(text) {
  if (!text.startsWith("---")) return text;
  const end = text.indexOf("\n---", 3);
  if (end === -1) return text;
  const after = text.indexOf("\n", end + 1);
  return after === -1 ? "" : text.slice(after + 1);
}

/** Split into alternating prose and verbatim (fenced code) runs, so callers can transform only the prose.
 *  Line based rather than a regex because a fence is a line construct: an opening ``` is closed by a fence
 *  of the same character and at least the same length, and anything else on the way is content. */
function segments(text) {
  const out = [];
  let prose = [];
  let fence = null;                                   // { char, len } while inside a block
  for (const line of text.split("\n")) {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence === null) {
      if (m && !(m[1][0] === "`" && line.slice(line.indexOf(m[1]) + m[1].length).includes("`"))) {
        // an opening ``` may carry a language, but a backtick after it means this was an inline span
        out.push({ code: false, text: prose.join("\n") });
        prose = [];
        fence = { char: m[1][0], len: m[1].length };
        out.push({ code: true, text: line });
      } else prose.push(line);
      continue;
    }
    out.at(-1).text += `\n${line}`;
    if (m && m[1][0] === fence.char && m[1].length >= fence.len) fence = null;
  }
  if (prose.length > 0 || out.length === 0) out.push({ code: false, text: prose.join("\n") });
  return out;
}

/** The non-code text of a document, by the same fence rules the cleaner itself uses.
 *
 *  Exported for the tests that ask "is anything dangerous left in the text a reader sees", because doing
 *  that with a regex mis-pairs an opening ``` with a closing ~~~ and hands back fenced content as prose —
 *  which is a false alarm at best and, in the other direction, a hidden finding. */
export const proseOnly = (body) => segments(body).filter((s) => !s.code).map((s) => s.text).join("\n");

/** the same idea one level down: `code` spans inside a line of prose are verbatim too */
function mapOutsideInlineCode(text, fn) {
  return text
    .split(/(`+[^`]*?`+)/)
    .map((part, i) => (i % 2 === 1 ? part : fn(part)))
    .join("");
}

const DROP_WITH_CONTENTS = /<(script|style|iframe|object|embed)\b[\s\S]*?<\/\1\s*>/gi;
const OPEN_UNCLOSED = /<(script|style|iframe|object|embed)\b[^>]*>/gi;
const COMMENT = /<!--[\s\S]*?-->/g;
/** `<https://x>` and `<mailto:x>` are markdown autolinks, not HTML — they must survive tag stripping */
const AUTOLINK = /^<(?:https?:\/\/|mailto:)[^>\s]+>$/i;

export function stripHtml(prose) {
  return mapOutsideInlineCode(prose, (part) =>
    part
      .replace(COMMENT, "")
      .replace(DROP_WITH_CONTENTS, "")
      .replace(OPEN_UNCLOSED, "")            // an unclosed <script ...> never becomes plain text either
      .replace(/<[^<>]*>/g, (tag) => (AUTOLINK.test(tag) ? tag : "")));
}

const SAFE_SCHEME = /^(?:https?:|mailto:)/i;
const HAS_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** Resolve one link target against `base`. Returns null when the target must not be kept at all. */
function absolutise(target, base) {
  const t = target.trim().replace(/^<|>$/g, "");
  if (t === "") return null;
  if (t.startsWith("#")) return t;                             // an in-document anchor stays as it is
  if (HAS_SCHEME.test(t) && !SAFE_SCHEME.test(t)) return null;
  // Everything kept goes through the URL parser, absolute included, so what we emit is always encoded:
  // `<https://e.com/a b>` arrives legal (the angle brackets carry the space) and would leave illegal if
  // it were copied through as-is, because we drop the brackets.
  try { return new URL(t.startsWith("//") ? `https:${t}` : t, base).href; } catch { return null; }
}

/** A title as re-emitted by us, never as it arrived. CommonMark allows `"…"`, `'…'` and `(…)`, and the
 *  contents are arbitrary text — including a quote character, which is how
 *  `[x](https://e.com 'a" onmouseover="alert(1)')` becomes an unescaped `title` attribute downstream.
 *  Matching that form is necessary but NOT sufficient: copying the title through verbatim would carry the
 *  payload into a pattern we do have. So the title is stripped of the four characters that can end an
 *  attribute or open a tag and re-emitted in one canonical form. */
const safeTitle = (t) => {
  const clean = t.replace(/["'<>]/g, "").replace(/\s+/g, " ").trim();
  return clean === "" ? "" : ` "${clean}"`;
};

/** Read a link destination and optional title out of `text` starting just after `(`. Returns the pieces
 *  and where the closing `)` was, or null when this is not a link we can read.
 *
 *  Hand-written rather than a regular expression, and that is the point of the whole change. A regex has
 *  exactly one failure mode here — it does not match — and the code around it then copied the link
 *  through UNTOUCHED. That is the wrong direction to fail in, and it is now twice that a form nobody had
 *  thought of (a target containing parentheses; a single-quoted title) slipped past for that reason. A
 *  parser can say "I could not read this", which lets the caller degrade to plain text instead. */
function readDestination(text, start) {
  let i = start;
  const ws = () => { while (i < text.length && /\s/.test(text[i])) i++; };
  ws();
  let dest = "";
  if (text[i] === "<") {
    const end = text.indexOf(">", i + 1);
    if (end === -1 || text.slice(i, end).includes("\n")) return null;
    dest = text.slice(i + 1, end);
    i = end + 1;
  } else {
    let depth = 0;
    const from = i;
    while (i < text.length) {
      const c = text[i];
      if (c === "\\") { i += 2; continue; }
      if (/\s/.test(c)) break;
      if (c === "(") depth++;
      else if (c === ")") { if (depth === 0) break; depth--; }
      i++;
    }
    dest = text.slice(from, i);
  }
  ws();
  let title = "";
  const open = text[i];
  if (open === '"' || open === "'" || open === "(") {
    const close = open === "(" ? ")" : open;
    const end = text.indexOf(close, i + 1);
    if (end === -1) return null;
    title = text.slice(i + 1, end);
    i = end + 1;
    ws();
  }
  if (text[i] !== ")") return null;
  return { dest, title, end: i };
}

/** `[text](target)`, `![alt](target)` and the reference form `[label]: target`, made absolute.
 *
 *  The rule everywhere below: **when in doubt, degrade to plain text.** A target we will not keep, or a
 *  link shape we cannot read, loses its brackets and keeps its words. Leaving the markup in place and
 *  hoping is what produced two holes already — the renderer's parser is more generous than any pattern we
 *  write, so anything we cannot read confidently must stop being a link here. */
function rewriteInlineLinks(text, base) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf("[", i);
    if (open === -1) { out += text.slice(i); break; }
    const isImage = open > 0 && text[open - 1] === "!";
    out += text.slice(i, isImage ? open - 1 : open);

    // the label: to its matching ], allowing nesting and backslash escapes
    let j = open + 1, depth = 1;
    while (j < text.length && depth > 0) {
      if (text[j] === "\\") { j += 2; continue; }
      if (text[j] === "[") depth++;
      else if (text[j] === "]") depth--;
      j++;
    }
    if (depth !== 0) { out += text.slice(isImage ? open - 1 : open); break; }
    const label = text.slice(open + 1, j - 1);

    if (text[j] !== "(") {                       // a reference link or plain brackets: not ours to rewrite
      out += text.slice(isImage ? open - 1 : open, j);
      i = j;
      continue;
    }
    const read = readDestination(text, j + 1);
    // unreadable shape: the label stops being a link and the rest is left as ordinary text, starting at
    // the `(` so the words do not run together
    if (read === null) { out += label; i = j; continue; }
    const abs = absolutise(read.dest, base);
    out += abs === null ? label : `${isImage ? "!" : ""}[${label}](${abs}${safeTitle(read.title)})`;
    i = read.end + 1;
  }
  return out;
}

export function absolutiseLinks(prose, base) {
  return mapOutsideInlineCode(prose, (part) =>
    rewriteInlineLinks(part, base)
      // the reference form carries a title too, in the same three flavours
      .replace(/^(\s{0,3}\[[^\]]+\]:\s*)(\S+)([ \t]+(?:"[^"]*"|'[^']*'|\([^()]*\)))?[ \t]*$/gm, (whole, head, target, title) => {
        const abs = absolutise(target, base);
        if (abs === null) return "";
        return `${head}${abs}${title ? safeTitle(title.trim().slice(1, -1)) : ""}`;
      }));
}

/** The fence a run of lines leaves open, or null. Used twice: to repair a cut, and to repair a document
 *  that arrived unterminated. */
function openFence(lines) {
  let fence = null;
  for (const line of lines) {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (!m) continue;
    if (fence === null) fence = m[1];
    else if (m[1][0] === fence[0] && m[1].length >= fence.length) fence = null;
  }
  return fence;
}

/** Close a fence the SOURCE left open. Markdown says an unterminated fence runs to the end of the
 *  document, so this changes no meaning — but a market row is shown next to other things, and a document
 *  that ends mid-block would otherwise pull the rest of the view into a code box. Found by the shape
 *  fuzzing in market-docs.test.ts, not by reading: it only happens when an upstream file is malformed. */
export function closeOpenFence(body) {
  const fence = openFence(body.split("\n"));
  return fence === null ? body : `${body}\n${fence}`;
}

/** Drop whole characters off the end until the string fits, so a cut never lands inside a code point. */
function cutToBytes(s, cap) {
  const chars = [...s];
  while (chars.length > 0 && byteLength(chars.join("")) > cap) chars.pop();
  return chars.join("");
}

/** Cut to `cap` bytes on a line boundary, then repair the block structure the cut may have broken. */
export function truncate(body, cap, note) {
  if (byteLength(body) <= cap) return { body, truncated: false };
  const suffix = `\n\n${note}\n`;
  // The note carries the URL, so for a small enough cap the note alone is bigger than the whole budget.
  // The 24 KB cap in use cannot reach this, but "never exceed cap" has to be true of the function and not
  // just of the way we happen to call it — so below that point the text is cut hard and the note dropped.
  if (byteLength(suffix) >= cap) {
    for (let budget = cap; budget >= 0; budget--) {
      const t = cutToBytes(body, budget);
      const closed = closeOpenFence(t);
      if (byteLength(closed) <= cap) return { body: closed, truncated: true };
    }
    return { body: "", truncated: true };
  }
  const room = cap - byteLength(suffix);
  const lines = body.split("\n");
  const kept = [];
  let used = 0;
  for (const line of lines) {
    const cost = byteLength(line) + 1;
    if (used + cost > room) break;
    kept.push(line);
    used += cost;
  }
  // A cut in the middle of a fenced block leaves it open, and an open fence eats every following section
  // into a code box. Closing it costs bytes the line budget above has already spent, so the repair and the
  // measurement have to run together: repair, measure, and if that pushed us over, give back a line and
  // try again. Dropping a line can itself change whether a fence is open, which is why this re-derives the
  // state each pass instead of adjusting it.
  for (;;) {
    const fence = openFence(kept);
    const cand = `${[...kept, ...(fence === null ? [] : [fence])].join("\n").replace(/\s+$/, "")}${suffix}`;
    if (byteLength(cand) <= cap || kept.length === 0) return { body: cand, truncated: true };
    kept.pop();
  }
}

/** The whole pass. `text` is the raw file, `url` is where it was read from — used both as the base for
 *  relative targets and as the `source` a reader follows to the original.
 *
 *  Returns null when there is no documentation worth carrying, which is NOT an error: a row without docs
 *  is a normal row. An empty body after cleaning means the file was frontmatter, or markup, and nothing
 *  else — carrying an empty string would make the display side draw a heading over nothing. */
export function buildDocs(text, url, opts = {}) {
  if (typeof text !== "string" || text.trim() === "") return null;
  const cap = opts.cap ?? CAP_BYTES;
  const note = (opts.note ?? TRUNCATION_NOTE)(url);

  let body = stripFrontmatter(text).replace(/\r\n?/g, "\n");
  body = segments(body)
    .map((s) => (s.code ? s.text : absolutiseLinks(stripHtml(s.text), url)))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (body === "") return null;
  body = closeOpenFence(body);          // before the byte count, because it is part of what we report

  const bytes = byteLength(body);                              // BEFORE the cut: "how much is missing"
  const cut = truncate(body, cap, note);
  return { source: url, format: "markdown", bytes, truncated: cut.truncated, body: cut.body };
}

export { CAP_BYTES };
