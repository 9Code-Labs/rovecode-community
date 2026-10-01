/** Sextant markdown (the messages panel): assistant text in → styled rows out.
 *
 *  WHY: assistant turns used to render as one plain wrapped block — a model that answered in markdown
 *  showed its source: literal `##`, `**`, backticks. The model's answer is the panel's main payload,
 *  and markdown is how models structure one.
 *
 *  WHAT IS RENDERED (and what is deliberately not):
 *    # h1 / ## h2        accent + bold, markers stripped     ### h3+   fg + bold
 *    **b** *i* ~~s~~     bold / italic / strikethrough
 *    `code`              str colour on the panel's alt bg (a chip)
 *    [text](url)         text, underlined — a terminal cannot click a title, so the url is dropped
 *    - / 1. lists        bullet / number in accent, hanging indent on wrap
 *    ``` code ```        every line on bg2 padded to full width, wrapped (never clipped — code that
 *                        says less than the model wrote is worse than code that wraps), lang label row
 *    > quote             ▎ bar + italic muted            ---    a rule row
 *    tables              columns sized to their widest cell (cap 24), ` │ ` separators, header bold
 *
 *  The parser is marked's LEXER (a dependency already, via the vendored pi-tui) — hand-rolling inline
 *  parsing is how `**a `mid-backtick` b**` gets bolded wrong. The renderer is ours: marked emits
 *  tokens, this file emits cells. Anything it does not know falls back to the token's raw text, so a
 *  construct added upstream degrades to plain, never to a crash or a lost line.
 *
 *  STREAMING: the text arrives in chunks and an unclosed fence lexes as a code block anyway, so the
 *  partial answer renders as it grows. Completed messages never change, and the rows cache is keyed by
 *  the exact text, so the per-frame cost is one lex of the message that is still streaming.
 *
 *  Pure: no clock, no I/O, no state — the cache is a memo, not a mutation of anything the caller owns. */

import { marked } from "marked";
import type { Seg, Style, Theme } from "./types.ts";
import { ATTR } from "./types.ts";
import { st } from "./draw-util.ts";
import type { Token, Tokens } from "marked";

/** one painted line — the same shape draw-messages.ts buildRows returns */
export interface MdRow { segs: Seg[]; indent?: number }

const cells = (s: string): number => [...s].length;
const segCells = (segs: readonly Seg[]): number => segs.reduce((n, [t]) => n + cells(t), 0);

/** cells-per-code-point clip with an ellipsis — tool-rows.ts's rule, duplicated here to keep this
 *  module free of a tool-name table it does not need */
const clip = (s: string, max: number): string => {
  const cps = [...s];
  return cps.length <= max ? s : cps.slice(0, Math.max(0, max - 1)).join("") + "…";
};

/** Segment-aware word wrap: break at spaces (carrying the space's style), hard-break words longer
 *  than the width. A paragraph's inline styles survive wrapping — the reason this exists beside
 *  draw-util's string wrap. */
function wrapSegs(segs: Seg[], w: number): Seg[][] {
  const width = Math.max(1, w);
  // flatten to styled words: [text, style] split on spaces, space glued to the PRECEDING word so a
  // wrapped line never starts with one
  const words: Seg[] = [];
  for (const [text, style] of segs) {
    for (const part of text.split(/( )/)) {
      if (part === "") continue;
      if (part === " " && words.length > 0) { const last = words[words.length - 1]!; words[words.length - 1] = [last[0] + " ", last[1]]; }
      else words.push([part, style]);
    }
  }
  const lines: Seg[][] = [];
  let line: Seg[] = [];
  let len = 0;
  const flush = (): void => { lines.push(line); line = []; len = 0; };
  for (let [word, style] of words) {
    let wl = cells(word);
    if (len > 0 && len + wl > width) flush();
    while (wl > width) {
      const cps = [...word];
      line.push([cps.splice(0, width - len).join(""), style]);
      flush();
      word = cps.join(""); wl = cells(word);
    }
    line.push([word, style]); len += wl;
  }
  if (line.length > 0 || lines.length === 0) lines.push(line);
  // a trailing space at a wrap point reads as ragged; drop it from each line's end
  for (const l of lines) {
    const last = l[l.length - 1];
    if (last) l[l.length - 1] = [last[0].replace(/ +$/, ""), last[1]];
  }
  return lines.filter((l) => segCells(l) > 0 || lines.length === 1);
}

/** inline tokens → styled segments. `base` is the surrounding block's style (blockquote italicises
 *  everything, a heading bolds everything); inline markup layers on top of it. */
function inlineSegs(tokens: Token[] | undefined, theme: Theme, base: Style): Seg[] {
  const out: Seg[] = [];
  const walk = (toks: Token[] | undefined, style: Style): void => {
    for (const t of toks ?? []) {
      switch (t.type) {
        case "strong": walk((t as Tokens.Strong).tokens, st(style.fg === -1 ? theme.fg : style.fg, style.bg, (style.a | ATTR.BOLD))); break;
        case "em": walk((t as Tokens.Em).tokens, st(style.fg, style.bg, style.a | ATTR.ITALIC)); break;
        case "del": walk((t as Tokens.Del).tokens, st(theme.muted, style.bg, style.a | ATTR.STRIKE)); break;
        case "codespan": out.push([` ${(t as Tokens.Codespan).text} `, st(theme.str, theme.bg2, style.a)]); break;
        case "link": walk((t as Tokens.Link).tokens, st(theme.info, style.bg, style.a | ATTR.UNDERLINE)); break;
        case "image": out.push([`▣ ${(t as Tokens.Image).text || (t as Tokens.Image).href}`, st(theme.dim, style.bg, style.a)]); break;
        case "br": out.push(["\n", style]); break; // block level splits on it below
        default: {
          const text = (t as { text?: string }).text ?? (t as { raw?: string }).raw ?? "";
          const nested = (t as { tokens?: Token[] }).tokens;
          if (nested) walk(nested, style);
          else out.push([text, style]);
        }
      }
    }
  };
  walk(tokens, base);
  return out;
}

/** a fenced block: a dim lang label row, then every code line padded to the full width on bg2 —
 *  the block reads as a block. Long lines WRAP (code clipped away would lie about what the model
 *  wrote); continuation rows keep the fill so the block does not break apart visually. */
function codeRows(text: string, lang: string | undefined, w: number, theme: Theme, indent: number): MdRow[] {
  const iw = Math.max(8, w - indent - 2);
  const rows: MdRow[] = [];
  if (lang) rows.push({ segs: [[`▍ ${lang} `, st(theme.accentDim, theme.bg2)], [" ".repeat(Math.max(0, w - indent - cells(lang) - 3)), st(-1, theme.bg2)]], indent });
  for (const raw of text.replace(/\n$/, "").split("\n")) {
    const style = st(theme.fg, theme.bg2);
    const content = "  " + raw;
    for (const part of wrapSegs([[content, style]], iw)) {
      const pad = Math.max(0, w - indent - segCells(part));
      rows.push({ segs: [...part, [" ".repeat(pad), st(-1, theme.bg2)]], indent });
    }
  }
  return rows;
}

/** table columns sized to the widest cell, capped — a model's 8-column table still reads as a table
 *  instead of a prose spill; the header row is bold, the markdown separator row is not drawn */
function tableRows(token: Tokens.Table, w: number, theme: Theme, indent: number): MdRow[] {
  const plain = (toks: Token[] | undefined): string => inlineSegs(toks, theme, st(theme.fg2)).map(([t]) => t).join("");
  const head = token.header.map((c) => plain(c.tokens));
  const body = token.rows.map((r) => r.map((c) => plain(c.tokens)));
  const widths = head.map((h, i) => Math.min(24, Math.max(cells(h), ...body.map((r) => cells(r[i] ?? "")))));
  const fits = widths.reduce((n, x) => n + x + 3, -3) <= w - indent;
  if (!fits) return []; // too wide for honesty: the caller falls back to the raw rows as a paragraph
  const line = (cells_: string[], bold: boolean): Seg[] =>
    cells_.flatMap((c, i): Seg[] => {
      const text = clip(c, widths[i]!).padEnd(widths[i]!);
      const seg: Seg = [text, bold ? st(theme.fg, -1, ATTR.BOLD) : st(theme.fg2)];
      return i < cells_.length - 1 ? [seg, [" │ ", st(theme.rule2)]] : [seg];
    });
  return [line(head, true), ...body.map((r) => line(r, false))].map((segs) => ({ segs, indent }));
}

/** block tokens → rows. `indent` is the transcript's base indent; lists stack theirs on it. */
function blockRows(tokens: Token[], w: number, theme: Theme, indent: number, listDepth = 0): MdRow[] {
  const rows: MdRow[] = [];
  const iw = Math.max(8, w - indent);
  const para = (toks: Token[] | undefined, base: Style, extraIndent = 0): void => {
    const segs = inlineSegs(toks, theme, base);
    // a hard line break (two-space newline) inside a paragraph splits the row sequence
    const split: Seg[][] = [[]];
    for (const seg of segs) (seg[0] === "\n" ? () => { split.push([]); } : () => { split[split.length - 1]!.push(seg); })();
    for (const s of split) for (const l of wrapSegs(s, iw - extraIndent)) rows.push({ segs: l, indent: indent + extraIndent });
  };
  for (const t of tokens) {
    switch (t.type) {
      case "space": rows.push({ segs: [], indent }); break;
      case "heading": {
        const d = (t as Tokens.Heading).depth;
        const base = d <= 2 ? st(theme.accent, -1, ATTR.BOLD) : st(theme.fg, -1, ATTR.BOLD);
        para((t as Tokens.Heading).tokens, base);
        break;
      }
      case "paragraph": para((t as Tokens.Paragraph).tokens, st(theme.fg2)); break;
      case "text": para((t as Tokens.Text).tokens ?? undefined, st(theme.fg2)); break;
      case "code": rows.push(...codeRows((t as Tokens.Code).text, (t as Tokens.Code).lang || undefined, w, theme, indent)); break;
      case "blockquote": {
        const inner = blockRows((t as Tokens.Blockquote).tokens, w - 2, theme, indent + 2);
        for (const r of inner) {
          if (segCells(r.segs) === 0) { rows.push({ segs: [], indent }); continue; }
          rows.push({ segs: [["▎ ", st(theme.accentDim)], ...r.segs.map(([x, sg]): Seg => { const s = sg ?? st(theme.fg2); return [x, st(s.fg === -1 ? theme.muted : s.fg, s.bg, s.a | ATTR.ITALIC)]; })], indent: r.indent ?? indent });
        }
        break;
      }
      case "hr": rows.push({ segs: [["╌".repeat(Math.min(24, iw)), st(theme.rule)]], indent }); break;
      case "list": {
        const list = t as Tokens.List;
        list.items.forEach((item, n) => {
          const marker = list.ordered ? `${(list.start as number) + n}.` : "•";
          const markerSegs: Seg[] = [[`${marker} `, st(list.ordered ? theme.accent : theme.accentDim)]];
          const hang = cells(marker) + 1;
          const before = rows.length;
          blockRows(item.tokens, w, theme, indent + hang, listDepth + 1).forEach((r, k) => {
            if (k === 0) rows.push({ segs: [...markerSegs, ...r.segs], indent: indent });
            else rows.push(r);
          });
          if (rows.length === before) rows.push({ segs: markerSegs, indent });
        });
        break;
      }
      case "table": {
        const tRows = tableRows(t as Tokens.Table, w, theme, indent);
        // too wide to align honestly: the raw rows as plain text beat a table that lies about its columns
        if (tRows.length > 0) rows.push(...tRows);
        else for (const l of wrapSegs([[(t as Tokens.Table).raw.replace(/\n$/, ""), st(theme.fg2)]], iw)) rows.push({ segs: l, indent });
        break;
      }
      case "html": break; // raw html in an answer renders as nothing, not as angle-bracket soup
      default: {
        const raw = (t as { raw?: string }).raw;
        if (raw) for (const l of wrapSegs([[raw.replace(/\n$/, ""), st(theme.fg2)]], iw)) rows.push({ segs: l, indent });
      }
    }
  }
  return rows;
}

/** rows cache: keyed by the exact text + geometry + theme. Completed messages hit forever; the one
 *  streaming message misses per chunk. Capped so a long session cannot grow it without bound. */
const CACHE_MAX = 24;
const cache = new Map<string, MdRow[]>();

/** assistant text → drawable rows. Never throws: a lexer hiccup degrades to the plain wrapped text
 *  the panel showed before markdown landed — an answer must never go missing over its formatting. */
export function markdownRows(text: string, w: number, theme: Theme, indent = 2): MdRow[] {
  const key = `${theme.name}${w}:${indent}:${text.length}:${text}`;
  const hit = cache.get(key);
  if (hit) return hit;
  let rows: MdRow[];
  try {
    rows = blockRows(marked.lexer(text, { gfm: true }), w, theme, indent);
  } catch {
    rows = text.split("\n").flatMap((para) => wrapSegs([[para, st(theme.fg2)]], Math.max(8, w - indent)).map((segs) => ({ segs, indent })));
  }
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
  cache.set(key, rows);
  return rows;
}
