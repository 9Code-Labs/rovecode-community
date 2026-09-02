/** Sextant surface (port #42) — small pure drawing helpers shared by the code and messages panels.
 *  Ported from the user's own sextant v0.4.0 prototype: src/app.js:37 (st), :66-78 (wrap), :210-220
 *  (panel). Pure: no clock, no timers, no process access — `now` arrives as a parameter. */

import { ATTR, SPIN, type Rect, type ScreenLike, type Seg, type Style, type Theme } from "./types.ts";

/** pack a Style; -1 = "leave the cell's color alone" */
export const st = (fg: number, bg = -1, a = 0): Style => ({ fg, bg, a });

/** the four-glyph diamond spinner, phase from the frame clock (140 ms per step) */
export const spinner = (now: number): string => SPIN[Math.floor(now / 140) % SPIN.length] ?? "◇";

/** split file content into lines; a trailing newline does not produce a phantom empty line */
export function splitLines(s: string): string[] {
  const l = s.split("\n");
  if (l.length && l[l.length - 1] === "") l.pop();
  return l;
}

/** Word-wrap to `width` cells, keeping explicit newlines (a blank paragraph stays a blank row);
 *  a word longer than the width is hard-split wherever it starts. Never returns []. */
export function wrap(text: string, width: number): string[] {
  const w = Math.max(1, width);
  const out: string[] = [];
  for (const para of String(text).split("\n")) {
    let line = "";
    for (const word of para.split(" ")) {
      if (line && line.length + 1 + word.length <= w) { line += " " + word; continue; }
      if (line) out.push(line);
      line = word;
      while (line.length > w) { out.push(line.slice(0, w)); line = line.slice(w); }
    }
    out.push(line);
  }
  return out;
}

/** hard-split a line into `width`-cell chunks (terminal-style, no word boundaries); "" → [""] */
export function hardWrap(line: string, width: number): string[] {
  const w = Math.max(1, width);
  if (line.length <= w) return [line];
  const out: string[] = [];
  for (let i = 0; i < line.length; i += w) out.push(line.slice(i, i + w));
  return out;
}

/** inner rect of a panel drawn at `r` (2 cells of horizontal padding, 1 row for each border) */
export const inner = (r: Rect): Rect => ({ x: r.x + 2, y: r.y + 1, w: r.w - 4, h: r.h - 2 });

/** The rounded panel frame: interior cleared to the theme background, a bold title in the top
 *  border, `extra` segments right-aligned in the same border (the widest one clipped with an
 *  ellipsis when the row is short). A focused panel takes the accent color. Returns the inner rect. */
export function panel(scr: ScreenLike, r: Rect, title: string, focused: boolean, extra: readonly Seg[], theme: Theme): Rect {
  const col = focused ? theme.accent : theme.frame;
  scr.box(r.x, r.y, r.w, r.h, st(col), theme.bg);
  if (title) scr.text(r.x + 2, r.y, [[" ", st(-1)], [title, st(focused ? theme.accent : theme.fg2, -1, ATTR.BOLD)], [" ", st(-1)]], Math.max(0, r.w - 4));
  if (extra.length) {
    const room = r.w - 7 - title.length; // cells left of the right corner after the title and its spacing
    const segs = fitSegs(extra, room);
    const ew = segs.reduce((n, [t]) => n + t.length, 0);
    if (ew > 0) scr.text(r.x + r.w - 3 - ew, r.y, [[" ", st(-1)], ...segs, [" ", st(-1)]]);
  }
  return inner(r);
}

/** clip the widest segment (with an ellipsis) until the run fits `room` cells; [] when hopeless */
function fitSegs(segs: readonly Seg[], room: number): Seg[] {
  let out: Seg[] = segs.filter(([t]) => t.length > 0);
  let ew = out.reduce((n, [t]) => n + t.length, 0);
  if (ew <= room) return out;
  if (room < 6) return [];
  let widest = 0;
  out.forEach(([t], i) => { if (t.length > (out[widest]?.[0].length ?? 0)) widest = i; });
  const [text, style] = out[widest]!;
  const keep = text.length - (ew - room) - 1;
  if (keep < 3) return [];
  out = out.map((sg, i) => (i === widest ? [text.slice(0, keep) + "…", style] : sg));
  ew = out.reduce((n, [t]) => n + t.length, 0);
  return ew <= room ? out : [];
}
