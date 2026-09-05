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

/** the default note appended when a body is cut. Kept a parameter, not a constant, because it is the one
 *  piece of prose in here and the display side may want to own it — see the note in the report. */
export const TRUNCATION_NOTE = (url) => `… (kısaltıldı, tamamı: ${url})`;

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
  if (HAS_SCHEME.test(t)) return SAFE_SCHEME.test(t) ? t : null;
  if (t.startsWith("//")) return `https:${t}`;
  try { return new URL(t, base).href; } catch { return null; }
}

/** A link destination as CommonMark allows it: either `<...>`, or a run of non-space characters that may
 *  contain BALANCED parentheses.
 *
 *  The parentheses are the whole point and were a real hole while this read `[^()\s]+`: the target in
 *  `[click](javascript:alert(1))` contains them, so the pattern simply failed to match and the link was
 *  copied through unrewritten — the one input this pass exists to catch was the one it let past. */
const TARGET = String.raw`<[^<>\n]*>|(?:[^()\s]|\([^()\s]*\))+`;
const INLINE_LINK = new RegExp(String.raw`(!?)\[([^\]]*)\]\(\s*(${TARGET})(\s+"[^"]*")?\s*\)`, "g");

/** `[text](target)`, `![alt](target)` and the reference form `[label]: target`, made absolute. A target
 *  that cannot be kept leaves the text behind: dropping the words too would lose meaning, and leaving a
 *  `javascript:` href would be the one thing this pass exists to prevent. */
export function absolutiseLinks(prose, base) {
  return mapOutsideInlineCode(prose, (part) =>
    part
      .replace(INLINE_LINK, (whole, bang, text, target, title) => {
        const abs = absolutise(target, base);
        if (abs === null) return text;                          // keep the words, lose the target
        return `${bang}[${text}](${abs}${title ?? ""})`;
      })
      .replace(/^(\s{0,3}\[[^\]]+\]:\s*)(\S+)/gm, (whole, head, target) => {
        const abs = absolutise(target, base);
        return abs === null ? "" : `${head}${abs}`;
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
