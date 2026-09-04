/** Sextant surface (port #42) — small pure drawing helpers shared by the code and messages panels.
 *  Ported from the user's own sextant v0.4.0 prototype: src/app.js:37 (st), :66-78 (wrap), :210-220
 *  (panel). Pure: no clock, no timers, no process access — `now` arrives as a parameter.
 *  #44 dedupe: `st` and `panel` are the shared theme.ts / layout.ts ones, re-exported here so the
 *  panels' imports stay put (layout.ts panel() = this file's former one: interior cleared to the
 *  theme background, extras clipped with an ellipsis before they are dropped). */

import { SPIN, type Rect } from "./types.ts";

export { st } from "./theme.ts";
export { panel } from "./layout.ts";

/** the four-glyph diamond spinner, phase from the frame clock (140 ms per step) */
export const spinner = (now: number): string => SPIN[Math.floor(now / 140) % SPIN.length] ?? "◇";

/** split file content into lines; a trailing newline does not produce a phantom empty line */
export function splitLines(s: string): string[] {
  const l = s.split("\n");
  if (l.length && l[l.length - 1] === "") l.pop();
  return l;
}

/** 1-slot cache: splitLines is called twice per frame (drawFileView + codeScrollTop/rowCount).
 *  File content is a stable string reference within a frame; reference equality is the cheapest guard. */
let _splitCache: { src: string; lines: string[] } | null = null;
export function splitLinesCached(s: string): string[] {
  if (_splitCache && _splitCache.src === s) return _splitCache.lines;
  const lines = splitLines(s);
  _splitCache = { src: s, lines };
  return lines;
}

/** Word-wrap to `width` cells — one cell per code point (types.ts), so an emoji counts once and a
 *  surrogate pair never straddles two rows — keeping explicit newlines (a blank paragraph stays a
 *  blank row); a word longer than the width is hard-split wherever it starts. Never returns []. */
export function wrap(text: string, width: number): string[] {
  const w = Math.max(1, width);
  const out: string[] = [];
  for (const para of String(text).split("\n")) {
    let line = "", len = 0;
    for (const word of para.split(" ")) {
      const cps = [...word];
      if (line && len + 1 + cps.length <= w) { line += " " + word; len += 1 + cps.length; continue; }
      if (line) out.push(line);
      while (cps.length > w) out.push(cps.splice(0, w).join(""));
      line = cps.join(""); len = cps.length;
    }
    out.push(line);
  }
  return out;
}

/** hard-split a line into `width`-cell chunks (terminal-style, no word boundaries; one cell per
 *  code point — an astral glyph moves to the next row whole); "" → [""] */
export function hardWrap(line: string, width: number): string[] {
  const w = Math.max(1, width);
  const cps = [...line];
  if (cps.length <= w) return [line];
  const out: string[] = [];
  for (let i = 0; i < cps.length; i += w) out.push(cps.slice(i, i + w).join(""));
  return out;
}

/** inner rect of a panel drawn at `r` (2 cells of horizontal padding, 1 row for each border) */
export const inner = (r: Rect): Rect => ({ x: r.x + 2, y: r.y + 1, w: r.w - 4, h: r.h - 2 });
