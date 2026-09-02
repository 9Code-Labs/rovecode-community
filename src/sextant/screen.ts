/** ported from the user's sextant v0.4.0 prototype, src/term.js (Screen, sgr) — cell buffer + diff flush + SGR */
/* Pure over an injected Sink: no process access, no clock. The renderer (#44) owns stdout, resize
   events and the frame interval; this module only turns a cell buffer into the minimal byte stream
   that repaints what changed. Additions over the prototype: truecolor → xterm-256 quantization,
   East-Asian width measurement (a width-2 glyph occupies two cells; a later write over either half
   breaks the glyph into spaces so borders stay put), zero-width code points (combining marks, VS16,
   ZWJ and the glyph it joins) ride on the cell before them so the terminal cursor never ends left of
   the buffer, frame glyphs measure 1 cell even under ambiguousAsWide, and control characters never
   reach a cell (toText()/flush cannot leak stray escape bytes). */

import { eastAsianWidth } from "get-east-asian-width";
import { hex } from "./theme.ts";
import { ATTR, type ScreenLike, type Seg, type Style } from "./types.ts";

export const ESC = "\x1b";
export const CSI = ESC + "[";
/** the prototype's floor (Screen.resize); layout() clamps to the same numbers */
export const MIN_COLS = 40;
export const MIN_ROWS = 12;

export interface Sink { write(s: string): void }
export interface Cursor { x: number; y: number }
export interface ScreenOptions {
  /** emit 38;2/48;2 truecolor SGR (default true); false quantizes to the xterm 256 cube (38;5/48;5) */
  truecolor?: boolean;
  /** count East-Asian-ambiguous text (◆, ¡ …) as 2 cells; default false. Frame glyphs (box drawing,
   *  block elements, …) stay 1 cell either way — the option measures content, never the frame */
  ambiguousAsWide?: boolean;
}
/** one buffer cell for tests/panels: width 2 = a wide glyph, 0 = the continuation half of one;
 *  ch holds the glyph plus any zero-width code points that joined it (e + U+0301, ZWJ sequences) */
export interface Cell { ch: string; fg: number; bg: number; a: number; width: number }

/* ------------------------------------------------------------ width */

/** zero-width code points join the glyph before them: combining marks (Mn/Me), format characters
 *  (Cf — ZWSP/ZWNJ/ZWJ U+200B–D, BOM, tags…) and variation selectors U+FE00–0F. Nothing below
 *  U+0300 qualifies (U+00AD soft hyphen stays 1 as in wcwidth), which keeps Latin text off the regex. */
const ZERO_WIDTH_RE = /^[\p{Mn}\p{Me}\p{Cf}\u200B-\u200D\uFE00-\uFE0F]$/u;
const isZeroWidth = (cp: number): boolean => cp >= 0x300 && ZERO_WIDTH_RE.test(String.fromCodePoint(cp));
/** Box Drawing + Block Elements (U+2500–259F) and the ellipsis: a frame is 1 cell whatever ambiguousAsWide says */
const isFrameGlyph = (cp: number): boolean => (cp >= 0x2500 && cp < 0x25a0) || cp === 0x2026;
const ZWJ = 0x200d;
const CONTROL_RE = /[\x00-\x1f\x7f-\x9f]/g;

/** display width of one code point: 0 (joins the previous glyph), else 1 or 2 via get-east-asian-width;
 *  no wide/ambiguous code point exists below U+1100/U+00A1 */
export function charWidth(cp: number, ambiguousAsWide = false): 0 | 1 | 2 {
  if (cp < 0x80) return 1;
  if (isZeroWidth(cp)) return 0;
  if (ambiguousAsWide ? isFrameGlyph(cp) : cp < 0x1100) return 1;
  return eastAsianWidth(cp, { ambiguousAsWide });
}

/** a string as cells, [text, width] per glyph: zero-width code points — and the code point a ZWJ
 *  joins — ride on the glyph before them; a leading one has nothing to join and is dropped */
export function* glyphs(s: string, ambiguousAsWide = false): Generator<[string, 1 | 2], void> {
  let cur = "", cw: 1 | 2 = 1, join = false;
  for (const c of s) {
    const cp = c.codePointAt(0)!;
    const w = charWidth(cp, ambiguousAsWide);
    if (cur && (w === 0 || (join && cp >= 0x80))) { cur += c; join = cp === ZWJ; continue; }
    if (w === 0) continue;
    if (cur) yield [cur, cw];
    cur = c; cw = w; join = false;
  }
  if (cur) yield [cur, cw];
}

/** display width of a string in cells (control characters count as the space they become) */
export function strWidth(s: string, ambiguousAsWide = false): number {
  let w = 0;
  for (const [, cw] of glyphs(s, ambiguousAsWide)) w += cw;
  return w;
}

/* ------------------------------------------------------------ colors */

const CUBE = [0, 95, 135, 175, 215, 255] as const;
/** xterm's default 16 ANSI colors — so color256() covers every index; sgr() never emits 0-15 */
const ANSI16 = [0x000000, 0x800000, 0x008000, 0x808000, 0x000080, 0x800080, 0x008080, 0xc0c0c0, 0x808080, 0xff0000, 0x00ff00, 0xffff00, 0x0000ff, 0xff00ff, 0x00ffff, 0xffffff];
/** nearest cube level for one channel (the 0/95/135/175/215/255 ramp) */
const cubeLevel = (v: number): number => (v < 48 ? 0 : v < 115 ? 1 : Math.min(5, Math.floor((v - 35) / 40)));
function dist2(a: number, b: number): number {
  const dr = ((a >> 16) & 255) - ((b >> 16) & 255), dg = ((a >> 8) & 255) - ((b >> 8) & 255), db = (a & 255) - (b & 255);
  return dr * dr + dg * dg + db * db;
}

/** packed rgb of an xterm-256 palette index */
export function color256(i: number): number {
  if (i < 16) return ANSI16[i] ?? 0;
  if (i < 232) { const k = i - 16; return (CUBE[Math.floor(k / 36)]! << 16) | (CUBE[Math.floor(k / 6) % 6]! << 8) | CUBE[k % 6]!; }
  const g = 8 + 10 * Math.min(23, i - 232);
  return (g << 16) | (g << 8) | g;
}

/** nearest xterm-256 index (16..255) for a packed rgb: the 6×6×6 cube or the 24-step gray ramp, whichever is closer */
export function quantize256(c: number): number {
  const r = (c >> 16) & 255, g = (c >> 8) & 255, b = c & 255;
  const cube = 16 + 36 * cubeLevel(r) + 6 * cubeLevel(g) + cubeLevel(b);
  const gray = 232 + Math.max(0, Math.min(23, Math.round(((r + g + b) / 3 - 8) / 10)));
  return dist2(c, color256(gray)) < dist2(c, color256(cube)) ? gray : cube;
}

/** SGR for a cell style: reset + attribute bits + fg/bg (truecolor 38;2 or quantized 38;5); -1 = default color */
export function sgr(fg: number, bg: number, a: number, truecolor = true): string {
  let s = CSI + "0";
  if (a & ATTR.BOLD) s += ";1";
  if (a & ATTR.DIM) s += ";2";
  if (a & ATTR.ITALIC) s += ";3";
  if (a & ATTR.UNDERLINE) s += ";4";
  if (a & ATTR.INVERSE) s += ";7";
  if (a & ATTR.STRIKE) s += ";9";
  if (fg >= 0) s += truecolor ? `;38;2;${(fg >> 16) & 255};${(fg >> 8) & 255};${fg & 255}` : `;38;5;${quantize256(fg)}`;
  if (bg >= 0) s += truecolor ? `;48;2;${(bg >> 16) & 255};${(bg >> 8) & 255};${bg & 255}` : `;48;5;${quantize256(bg)}`;
  return s + "m";
}

/* ------------------------------------------------------------ screen */

interface Prev { ch: (string | null)[]; fg: Int32Array; bg: Int32Array; at: Uint8Array }

export class Screen implements ScreenLike {
  w = 0;
  h = 0;
  private ch: string[] = [];
  /** cell widths: 1, 2 (wide glyph) or 0 (continuation half of the wide glyph to its left) */
  private wd = new Uint8Array(0);
  private fg = new Int32Array(0);
  private bg = new Int32Array(0);
  private at = new Uint8Array(0);
  private prev: Prev | null = null;
  private readonly truecolor: boolean;
  private readonly ambiguousAsWide: boolean;

  constructor(private readonly sink: Sink, cols: number, rows: number, opts: ScreenOptions = {}) {
    this.truecolor = opts.truecolor ?? true;
    this.ambiguousAsWide = opts.ambiguousAsWide ?? false;
    this.resize(cols, rows);
  }

  /** (re)allocate the buffer at ≥ 40×12; the next flush repaints everything */
  resize(cols: number, rows: number): void {
    this.w = Math.max(MIN_COLS, Number.isFinite(cols) ? Math.floor(cols) : 0);
    this.h = Math.max(MIN_ROWS, Number.isFinite(rows) ? Math.floor(rows) : 0);
    const n = this.w * this.h;
    this.ch = new Array<string>(n).fill(" ");
    this.wd = new Uint8Array(n).fill(1);
    this.fg = new Int32Array(n).fill(-1);
    this.bg = new Int32Array(n).fill(-1);
    this.at = new Uint8Array(n);
    this.prev = null;
  }

  /** start a frame: every cell becomes a plain space over the given background */
  begin(bg?: number): void {
    this.ch.fill(" "); this.wd.fill(1); this.fg.fill(-1); this.bg.fill(bg == null ? -1 : bg); this.at.fill(0);
  }

  cellAt(x: number, y: number): Cell | null {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return null;
    const i = y * this.w + x;
    return { ch: this.ch[i]!, fg: this.fg[i]!, bg: this.bg[i]!, a: this.at[i]!, width: this.wd[i]! };
  }

  /** a write over either half of a wide glyph turns its other half into a space */
  private breakWide(i: number): void {
    const w = this.wd[i];
    if (w === 0 && i > 0) { this.ch[i - 1] = " "; this.wd[i - 1] = 1; }
    else if (w === 2 && i + 1 < this.wd.length) { this.ch[i + 1] = " "; this.wd[i + 1] = 1; }
  }

  private set(i: number, c: string, w: 1 | 2, fg: number, bg: number, a: number): void {
    this.breakWide(i);
    if (w === 2) this.breakWide(i + 1);
    this.ch[i] = c; this.wd[i] = w; this.fg[i] = fg; if (bg >= 0) this.bg[i] = bg; this.at[i] = a;
    if (w === 2) { this.ch[i + 1] = ""; this.wd[i + 1] = 0; this.fg[i + 1] = fg; if (bg >= 0) this.bg[i + 1] = bg; this.at[i + 1] = a; }
  }

  /** the longest prefix of s that fits in w cells */
  private head(s: string, w: number): string {
    let out = "", used = 0;
    for (const [g, cw] of glyphs(s, this.ambiguousAsWide)) {
      if (used + cw > w) break;
      out += g; used += cw;
    }
    return out;
  }

  /** write a string; returns the x after the last cell written. bg < 0 keeps the cell's background. */
  put(x: number, y: number, str: string, st?: Style, maxW = Infinity): number {
    if (y < 0 || y >= this.h || !str) return x;
    const fg = st ? st.fg : -1, bg = st ? st.bg : -1, a = st ? st.a : 0;
    let cx = x;
    const end = Math.min(this.w, x + maxW);
    for (const [g, cw] of glyphs(str.replace(CONTROL_RE, " "), this.ambiguousAsWide)) {
      if (cx >= end) break;
      if (cw === 2 && cx + 2 > end) break; // a wide glyph that does not fit is dropped, never half-drawn
      if (cx >= 0) this.set(y * this.w + cx, g, cw, fg, bg, a);
      cx += cw;
    }
    return cx;
  }

  /** write segments clipped to maxW; returns the x after the last cell */
  text(x: number, y: number, segs: readonly Seg[], maxW = Infinity): number {
    let cx = x;
    const end = x + maxW;
    for (const [s, st] of segs) {
      if (cx >= end) break;
      cx = this.put(cx, y, s, st, end - cx);
    }
    return cx;
  }

  /** clipped text with a trailing ellipsis when it does not fit (measured in cells) */
  clip(x: number, y: number, str: string, st: Style | undefined, maxW: number): number {
    if (maxW <= 0) return x;
    if (strWidth(str, this.ambiguousAsWide) > maxW) str = maxW > 1 ? this.head(str, maxW - 1) + "…" : this.head(str, maxW);
    return this.put(x, y, str, st, maxW);
  }

  fill(x: number, y: number, w: number, h: number, ch: string, st?: Style): void {
    const fg = st ? st.fg : -1, bg = st ? st.bg : -1, a = st ? st.a : 0;
    let cp = ch.replace(CONTROL_RE, " ").codePointAt(0) ?? 0x20;
    if (isZeroWidth(cp)) cp = 0x20; // a lone zero-width glyph has nothing to join (and a 0-cell step would never advance)
    const g = String.fromCodePoint(cp), cw = charWidth(cp, this.ambiguousAsWide) || 1;
    for (let yy = y; yy < y + h; yy++) {
      if (yy < 0 || yy >= this.h) continue;
      for (let xx = x; xx < x + w; xx += cw) {
        if (xx < 0 || xx + cw > this.w || xx + cw > x + w) continue;
        this.set(yy * this.w + xx, g, cw, fg, bg, a);
      }
    }
  }

  /** recolor a rectangle's background only */
  tint(x: number, y: number, w: number, h: number, bg: number): void {
    for (let yy = y; yy < y + h; yy++) {
      if (yy < 0 || yy >= this.h) continue;
      for (let xx = x; xx < x + w; xx++) {
        if (xx < 0 || xx >= this.w) continue;
        this.bg[yy * this.w + xx] = bg;
      }
    }
  }

  hline(x: number, y: number, w: number, st?: Style, ch = "─"): void { for (let i = 0; i < w; i++) this.put(x + i, y, ch, st); }
  vline(x: number, y: number, h: number, st?: Style, ch = "│"): void { for (let i = 0; i < h; i++) this.put(x, y + i, ch, st); }

  /** rounded box; bgFill paints the interior first when given */
  box(x: number, y: number, w: number, h: number, st?: Style, bgFill?: number): void {
    if (bgFill != null) this.fill(x, y, w, h, " ", { fg: -1, bg: bgFill, a: 0 });
    this.put(x, y, "╭", st); this.put(x + w - 1, y, "╮", st);
    this.put(x, y + h - 1, "╰", st); this.put(x + w - 1, y + h - 1, "╯", st);
    this.hline(x + 1, y, w - 2, st); this.hline(x + 1, y + h - 1, w - 2, st);
    this.vline(x, y + 1, h - 2, st); this.vline(x + w - 1, y + 1, h - 2, st);
  }

  /** emit the difference to the previous flush: full paint (ESC[2J) on the first frame or after
   *  resize, otherwise only changed cells — a cursor move only where the run is discontiguous, an
   *  SGR only when the style changes, and never the bottom-right cell (terminals may scroll on it). */
  flush(cursor?: Cursor | null): void {
    const n = this.w * this.h;
    let full = false;
    if (!this.prev || this.prev.ch.length !== n) {
      this.prev = { ch: new Array<string | null>(n).fill(null), fg: new Int32Array(n).fill(-2), bg: new Int32Array(n).fill(-2), at: new Uint8Array(n).fill(255) };
      full = true;
    }
    const p = this.prev;
    let out = full ? CSI + "2J" : "";
    let cfg: number | null = null, cbg: number | null = null, cat: number | null = null, lx = -1, ly = -1;
    const last = n - 1;
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        const i = y * this.w + x;
        const wd = this.wd[i]!;
        if (wd === 0) continue;               // continuation half: painted together with its glyph
        if (i + wd - 1 >= last) continue;     // scroll guard: the last cell (or a glyph spilling into it) is never written
        if (!full && this.ch[i] === p.ch[i] && this.fg[i] === p.fg[i] && this.bg[i] === p.bg[i] && this.at[i] === p.at[i]) continue;
        if (!(ly === y && lx === x)) out += CSI + (y + 1) + ";" + (x + 1) + "H";
        const fg = this.fg[i]!, bg = this.bg[i]!, at = this.at[i]!;
        if (fg !== cfg || bg !== cbg || at !== cat) { out += sgr(fg, bg, at, this.truecolor); cfg = fg; cbg = bg; cat = at; }
        out += this.ch[i]!;
        lx = x + wd; ly = y;
        p.ch[i] = this.ch[i]!; p.fg[i] = fg; p.bg[i] = bg; p.at[i] = at;
        if (wd === 2) { p.ch[i + 1] = ""; p.fg[i + 1] = fg; p.bg[i + 1] = bg; p.at[i + 1] = at; }
      }
    }
    out += cursor ? CSI + (cursor.y + 1) + ";" + (cursor.x + 1) + "H" + CSI + "?25h" : CSI + "?25l";
    this.sink.write(out);
  }

  /** plain-text dump: one line per row, trailing whitespace removed, no escape bytes ever */
  toText(): string {
    const lines: string[] = [];
    for (let y = 0; y < this.h; y++) lines.push(this.ch.slice(y * this.w, (y + 1) * this.w).join("").replace(/\s+$/, ""));
    return lines.join("\n");
  }

  /** html dump with colors (debug/screenshots) */
  toHTML(font = "Cascadia Mono"): string {
    let html = "";
    for (let y = 0; y < this.h; y++) {
      let row = "", run = "";
      let cur: Style | null = null;
      const flushRun = (): void => {
        if (!run || !cur) return;
        const s = cur;
        row += `<span style="color:${s.fg >= 0 ? hex(s.fg) : "inherit"};background:${s.bg >= 0 ? hex(s.bg) : "transparent"};${s.a & ATTR.BOLD ? "font-weight:600;" : ""}${s.a & ATTR.ITALIC ? "font-style:italic;" : ""}${s.a & ATTR.STRIKE ? "text-decoration:line-through;" : ""}">${run.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</span>`;
        run = "";
      };
      for (let x = 0; x < this.w; x++) {
        const i = y * this.w + x;
        const s: Style = { fg: this.fg[i]!, bg: this.bg[i]!, a: this.at[i]! };
        if (!cur || cur.fg !== s.fg || cur.bg !== s.bg || cur.a !== s.a) { flushRun(); cur = s; }
        run += this.ch[i]!;
      }
      flushRun();
      html += row + "\n";
    }
    return `<!doctype html><meta charset="utf-8"><body style="margin:0;background:#000"><pre style="margin:0;font:14px/1.25 '${font}',Consolas,monospace;display:inline-block">${html}</pre></body>`;
  }
}
