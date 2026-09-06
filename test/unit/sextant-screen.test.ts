/** Port #40 — screen.ts: the cell buffer + diff flush byte protocol on 160×44, width handling,
 *  SGR truecolor/256, toText/toHTML, and the directory hygiene rules (no process access, ≤400
 *  lines, provenance header). flush output is replayed through @xterm/headless as an independent
 *  oracle: what a real VT shows must equal toText(), with no scroll and the last cell untouched. */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import xterm from "@xterm/headless";
import { CSI, Screen, color256, quantize256, sgr, strWidth } from "../../src/sextant/screen.ts";
import { buildTheme, st } from "../../src/sextant/theme.ts";
import { ATTR, THEME_ORDER, type ScreenLike } from "../../src/sextant/types.ts";

const W = 160, H = 44;
const C = buildTheme("night");
const HIDE = CSI + "?25l";
const MOVE_RE = /\x1b\[\d+;\d+H/g;
const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;

function make(cols = W, rows = H, opts?: { truecolor?: boolean; ambiguousAsWide?: boolean }) {
  const writes: string[] = [];
  const scr = new Screen({ write: (s) => writes.push(s) }, cols, rows, opts);
  return { scr, writes };
}
/** a small frame: outer box + a word (what every test re-draws before changing one thing) */
function base(scr: Screen): void {
  scr.begin(C.bg);
  scr.box(0, 0, scr.w - 1, scr.h, st(C.frameDim));
  scr.put(4, 2, "hello", st(C.fg));
}

/** House hazard: an await with no pending timer hangs the runner — every xterm settle rides a deadline. */
function deadline<T>(p: Promise<T>, ms = 4000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bomb = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`did not settle within ${ms}ms`)), ms); });
  return Promise.race([p, bomb]).finally(() => { if (timer) clearTimeout(timer); });
}
/** replay sink writes through xterm.js; returns what the terminal shows. `lines` are right-trimmed like
 *  toText(); `cells` hold getChars() per cell — "" for a cell that was NEVER written (xterm's null cell). */
async function replay(writes: readonly string[], cols: number, rows: number): Promise<{ lines: string[]; cells: string[][]; scrolled: boolean }> {
  const t = new xterm.Terminal({ cols, rows, allowProposedApi: true, disableStdin: true });
  for (const w of writes) t.write(w);
  await deadline(new Promise<void>((r) => t.write("", () => r())));
  const buf = t.buffer.active;
  const lines: string[] = [], cells: string[][] = [];
  for (let y = 0; y < rows; y++) {
    const line = buf.getLine(buf.viewportY + y);
    lines.push((line?.translateToString(true) ?? "").replace(/\s+$/, ""));
    const row: string[] = [];
    for (let x = 0; x < cols; x++) row.push(line?.getCell(x)?.getChars() ?? "");
    cells.push(row);
  }
  const scrolled = buf.length > rows;
  t.dispose();
  return { lines, cells, scrolled };
}

describe("sextant screen: flush byte protocol on 160×44", () => {
  it("first frame begins with ESC[2J, paints every cell but the bottom-right one, one cursor move per row", async () => {
    const { scr, writes } = make();
    scr.begin(C.bg);
    scr.fill(0, 0, W, H, "X", st(C.fg));
    scr.flush(null);
    const out = writes[0]!;
    expect(out.startsWith(CSI + "2J")).toBe(true);
    expect(count(out, /X/g)).toBe(W * H - 1);
    expect(out).not.toContain(CSI + `${H};${W}H`);
    expect(count(out, MOVE_RE)).toBe(H);
    expect(out.endsWith(HIDE)).toBe(true);
    const vt = await replay(writes, W, H);
    expect(vt.scrolled).toBe(false);
    expect(vt.lines[0]).toBe("X".repeat(W));
    expect(vt.lines[H - 1]).toBe("X".repeat(W - 1));
    expect(vt.cells[H - 1]![W - 2]).toBe("X");
    expect(vt.cells[H - 1]![W - 1]).toBe(""); // xterm null cell: never written at all
  });

  it("one changed cell → exactly one cursor move, one SGR, that cell, cursor state", () => {
    const { scr, writes } = make();
    base(scr); scr.flush(null);
    base(scr); scr.put(10, 5, "Z", st(C.accent)); scr.flush(null);
    expect(writes[1]).toBe(CSI + "6;11H" + sgr(C.accent, C.bg, 0) + "Z" + HIDE);
    expect(count(writes[1]!, MOVE_RE)).toBe(1);
    expect(count(writes[1]!, /\x1b\[0[;\d]*m/g)).toBe(1);
  });

  it("an unchanged frame emits nothing but the cursor state (hide, or move + show)", () => {
    const { scr, writes } = make();
    base(scr); scr.flush(null);
    base(scr); scr.flush(null);
    expect(writes[1]).toBe(HIDE);
    base(scr); scr.flush({ x: 7, y: 3 });
    expect(writes[2]).toBe(CSI + "4;8H" + CSI + "?25h");
    base(scr); scr.flush();
    expect(writes[3]).toBe(HIDE);
  });

  it("cursor moves only where the run is discontiguous; SGR only when the style changes", () => {
    const { scr, writes } = make();
    base(scr); scr.flush(null);
    base(scr);
    scr.put(10, 5, "A", st(C.ok));
    scr.put(11, 5, "BC", st(C.err, -1, ATTR.BOLD));
    scr.put(50, 20, "Q", st(C.err, -1, ATTR.BOLD));
    scr.flush(null);
    expect(writes[1]).toBe(CSI + "6;11H" + sgr(C.ok, C.bg, 0) + "A" + sgr(C.err, C.bg, ATTR.BOLD) + "BC" + CSI + "21;51H" + "Q" + HIDE);
  });

  it("the bottom-right cell is never written (scroll guard) even when the buffer holds a glyph there", async () => {
    const { scr, writes } = make();
    base(scr); scr.put(W - 1, H - 1, "Q", st(C.err)); scr.flush(null);
    expect(writes[0]).not.toContain("Q");
    base(scr); scr.put(W - 1, H - 1, "Q", st(C.err)); scr.flush(null);
    expect(writes[1]).toBe(HIDE);
    const vt = await replay(writes, W, H);
    expect(vt.scrolled).toBe(false);
    expect(vt.cells[H - 1]![W - 1]).toBe(""); // never written (null cell), although the buffer holds "Q"
    expect(vt.cells[H - 1]![W - 2]).toBe("╯");
    expect(vt.lines[0]).toBe(scr.toText().split("\n")[0]);
  });

  it("resize() forces a full repaint and clamps to the 40×12 floor", () => {
    const { scr, writes } = make();
    base(scr); scr.flush(null);
    scr.resize(W, H);
    base(scr); scr.flush(null);
    expect(writes[1]!.startsWith(CSI + "2J")).toBe(true);
    expect(writes[1]!.length).toBeGreaterThan(1000);
    scr.resize(30, 5);
    expect([scr.w, scr.h]).toEqual([40, 12]);
    expect(scr.toText().split("\n").length).toBe(12);
    scr.resize(Number.NaN, 200);
    expect([scr.w, scr.h]).toEqual([40, 200]);
  });

  it("what the terminal shows equals toText() (styles, box glyphs, colors all round-trip)", async () => {
    const { scr, writes } = make();
    base(scr);
    scr.tint(2, 1, 20, 1, C.selBg);
    scr.text(2, 1, [["◆ ", st(C.accent)], ["sextant", st(C.fg, -1, ATTR.BOLD)], ["  ·  ", st(C.dim)], ["main", st(C.fg2)]]);
    scr.flush(null);
    base(scr);
    scr.put(30, 30, "changed", st(C.warn));
    scr.flush({ x: 5, y: 5 });
    const vt = await replay(writes, W, H);
    expect(vt.scrolled).toBe(false);
    expect(vt.lines).toEqual(scr.toText().split("\n"));
  });
});

describe("sextant screen: toText", () => {
  it("is deterministic, trailing-space-free, h lines, and never contains escape bytes", () => {
    const a = make(), b = make();
    base(a.scr); base(b.scr);
    a.scr.put(0, 3, "a\x1b[31mb\tc\x7f", st(C.fg));
    b.scr.put(0, 3, "a\x1b[31mb\tc\x7f", st(C.fg));
    const text = a.scr.toText();
    expect(text).toBe(b.scr.toText());
    const lines = text.split("\n");
    expect(lines.length).toBe(H);
    expect(lines.some((l) => /\s$/.test(l))).toBe(false);
    expect(text).not.toContain("\x1b");
    expect(lines[3]).toBe("a [31mb c" + " ".repeat(W - 11) + "│");
    expect(lines[2]).toBe("│   hello" + " ".repeat(W - 11) + "│");
  });

  it("control characters become spaces in the terminal too (the VT prints the rest literally)", async () => {
    const { scr, writes } = make(40, 12);
    scr.begin(-1);
    scr.put(0, 0, "a\x1b[31mb", st(C.fg));
    scr.flush(null);
    const vt = await replay(writes, 40, 12);
    expect(vt.lines[0]).toBe("a [31mb");
    expect(scr.toText().split("\n")[0]).toBe("a [31mb");
  });
});

describe("sextant screen: width handling", () => {
  it("a width-2 glyph consumes 2 cells and a right border drawn after it stays in column w-1", async () => {
    const { scr, writes } = make(40, 12);
    scr.begin(-1);
    scr.put(37, 0, "字", st(C.fg));
    scr.vline(39, 0, 1, st(C.fg));
    expect(scr.cellAt(37, 0)).toMatchObject({ ch: "字", width: 2 });
    expect(scr.cellAt(38, 0)).toMatchObject({ ch: "", width: 0 });
    expect(scr.cellAt(39, 0)).toMatchObject({ ch: "│", width: 1 });
    const row = scr.toText().split("\n")[0]!;
    expect(row).toBe(" ".repeat(37) + "字│");
    expect(strWidth(row)).toBe(40);
    scr.flush(null);
    const vt = await replay(writes, 40, 12);
    expect(vt.lines[0]).toBe(row);
    expect(vt.cells[0]![37]).toBe("字");
    expect(vt.cells[0]![38]).toBe("");
    expect(vt.cells[0]![39]).toBe("│");
  });

  it("writing over either half of a wide glyph breaks it into spaces (the border wins the column)", async () => {
    const { scr, writes } = make(40, 12);
    scr.begin(-1);
    scr.put(38, 0, "字", st(C.fg));
    scr.put(39, 0, "│", st(C.fg));
    expect(scr.cellAt(38, 0)).toMatchObject({ ch: " ", width: 1 });
    expect(scr.cellAt(39, 0)).toMatchObject({ ch: "│", width: 1 });
    expect(scr.toText().split("\n")[0]).toBe(" ".repeat(39) + "│");
    scr.put(10, 1, "字", st(C.fg));
    scr.put(10, 1, "a", st(C.fg));
    expect(scr.cellAt(11, 1)).toMatchObject({ ch: " ", width: 1 });
    expect(scr.toText().split("\n")[1]).toBe(" ".repeat(10) + "a");
    scr.flush(null);
    const vt = await replay(writes, 40, 12);
    expect(vt.cells[0]![39]).toBe("│");
    expect(vt.cells[0]![38]).toBe(" ");
    expect(vt.lines[1]).toBe(" ".repeat(10) + "a");
  });

  it("flush advances the cursor by 2 after a wide glyph (no stray move) and repaints both halves when it goes", () => {
    const { scr, writes } = make();
    base(scr); scr.flush(null);
    base(scr); scr.put(5, 3, "字a", st(C.fg)); scr.flush(null);
    expect(writes[1]).toBe(CSI + "4;6H" + sgr(C.fg, C.bg, 0) + "字a" + HIDE);
    base(scr); scr.put(5, 3, "字a", st(C.fg)); scr.flush(null);
    expect(writes[2]).toBe(HIDE);
    base(scr); scr.flush(null);
    expect(writes[3]).toBe(CSI + "4;6H" + sgr(-1, C.bg, 0) + "   " + HIDE);
  });

  it("a wide glyph that does not fit (maxW or the right edge) is dropped, never half-drawn", () => {
    const { scr } = make(40, 12);
    scr.begin(-1);
    expect(scr.put(0, 0, "字", st(C.fg), 1)).toBe(0);
    expect(scr.cellAt(0, 0)!.ch).toBe(" ");
    expect(scr.put(39, 0, "字", st(C.fg))).toBe(39);
    expect(scr.cellAt(39, 0)!.ch).toBe(" ");
    expect(scr.put(38, 0, "字", st(C.fg))).toBe(40);
    // last row: a wide glyph that would spill into the bottom-right cell is never flushed
    const { scr: s2, writes } = make(40, 12);
    s2.begin(-1); s2.put(38, 11, "字", st(C.fg)); s2.flush(null);
    expect(writes[0]).not.toContain("字");
  });

  // ambiguousAsWide + zero-width code points: see sextant-screen-width.test.ts

  it("clip() measures in cells: ellipsis on overflow, exact fit untouched, wide-aware prefix", () => {
    const { scr } = make(40, 12);
    const row = () => scr.toText().split("\n")[0]!;
    scr.begin(-1); expect(scr.clip(0, 0, "abcdefgh", st(C.fg), 5)).toBe(5); expect(row()).toBe("abcd…");
    scr.begin(-1); expect(scr.clip(0, 0, "abc", st(C.fg), 5)).toBe(3); expect(row()).toBe("abc");
    scr.begin(-1); expect(scr.clip(0, 0, "abc", st(C.fg), 1)).toBe(1); expect(row()).toBe("a");
    scr.begin(-1); expect(scr.clip(0, 0, "abc", st(C.fg), 0)).toBe(0); expect(row()).toBe("");
    scr.begin(-1); expect(scr.clip(0, 0, "字字字", st(C.fg), 4)).toBe(3); expect(row()).toBe("字…");
  });
});

describe("sextant screen: put/text/fill/tint/box semantics (term.js parity)", () => {
  it("put: bg -1 keeps the cell background, clips at the edges, returns the end x", () => {
    const { scr } = make(40, 12);
    scr.begin(C.bg);
    scr.tint(0, 0, 5, 1, C.selBg);
    expect(scr.put(0, 0, "ab", st(C.fg))).toBe(2);
    expect(scr.cellAt(0, 0)).toEqual({ ch: "a", fg: C.fg, bg: C.selBg, a: 0, width: 1 });
    expect(scr.put(-2, 1, "abcd", st(C.fg))).toBe(2);
    expect(scr.toText().split("\n")[1]).toBe("cd");
    expect(scr.put(38, 2, "abcd", st(C.fg))).toBe(40);
    expect(scr.toText().split("\n")[2]).toBe(" ".repeat(38) + "ab");
    expect(scr.put(0, -1, "x", st(C.fg))).toBe(0);
    expect(scr.put(0, 12, "x", st(C.fg))).toBe(0);
    expect(scr.put(3, 3, "", st(C.fg))).toBe(3);
    expect(scr.put(0, 4, "abcdef", st(C.fg), 3)).toBe(3);
    expect(scr.toText().split("\n")[4]).toBe("abc");
    expect(scr.put(0, 5, "plain")).toBe(5);
    expect(scr.cellAt(0, 5)).toEqual({ ch: "p", fg: -1, bg: C.bg, a: 0, width: 1 });
  });

  it("text: segments clipped to maxW, returns the end x; fill sets style and keeps bg when unset", () => {
    const { scr } = make(40, 12);
    scr.begin(C.bg);
    expect(scr.text(0, 0, [["ab", st(C.fg)], ["cd", st(C.ok)]], 3)).toBe(3);
    expect(scr.toText().split("\n")[0]).toBe("abc");
    expect(scr.cellAt(2, 0)!.fg).toBe(C.ok);
    scr.fill(0, 1, 3, 2, "#", st(C.warn));
    expect(scr.toText().split("\n")[1]).toBe("###");
    expect(scr.cellAt(1, 2)).toEqual({ ch: "#", fg: C.warn, bg: C.bg, a: 0, width: 1 });
    scr.fill(0, 3, 2, 1, ".", st(C.fg, C.hlBg));
    expect(scr.cellAt(0, 3)!.bg).toBe(C.hlBg);
  });

  it("box draws the rounded frame; bgFill paints the interior first", () => {
    const { scr } = make(40, 12);
    scr.begin(C.bg);
    scr.box(0, 0, 5, 3, st(C.frame));
    expect(scr.toText().split("\n").slice(0, 3)).toEqual(["╭───╮", "│   │", "╰───╯"]);
    scr.box(10, 0, 4, 3, st(C.frame), C.hlBg);
    expect(scr.cellAt(11, 1)!.bg).toBe(C.hlBg);
    expect(scr.cellAt(10, 0)!.bg).toBe(C.hlBg);
    expect(scr.cellAt(9, 0)!.bg).toBe(C.bg);
    scr.hline(20, 5, 3, st(C.frame), "╌");
    expect(scr.toText().split("\n")[5]).toBe(" ".repeat(20) + "╌╌╌");
  });

  it("begin() resets glyph/style/width and takes the frame background", () => {
    const { scr } = make(40, 12);
    scr.put(3, 3, "字", st(C.fg, C.err, ATTR.BOLD));
    scr.begin(C.bg2);
    expect(scr.cellAt(3, 3)).toEqual({ ch: " ", fg: -1, bg: C.bg2, a: 0, width: 1 });
    expect(scr.cellAt(4, 3)!.width).toBe(1);
    scr.begin();
    expect(scr.cellAt(3, 3)!.bg).toBe(-1);
  });

  it("Screen satisfies the contract's ScreenLike structurally", () => {
    const { scr } = make(40, 12);
    const s: ScreenLike = scr;
    expect(s.w).toBe(40);
    expect(typeof s.box).toBe("function");
  });
});

describe("sextant screen: SGR + 256-color quantizer", () => {
  it("truecolor SGR is the prototype's: reset, attribute bits, 38;2 / 48;2", () => {
    expect(sgr(0xff0000, -1, 0)).toBe("\x1b[0;38;2;255;0;0m");
    expect(sgr(-1, 0x0b0e12, ATTR.BOLD | ATTR.ITALIC)).toBe("\x1b[0;1;3;48;2;11;14;18m");
    expect(sgr(-1, -1, ATTR.DIM | ATTR.UNDERLINE | ATTR.INVERSE | ATTR.STRIKE)).toBe("\x1b[0;2;4;7;9m");
    expect(sgr(-1, -1, 0)).toBe("\x1b[0m");
  });

  it("truecolor off → 38;5/48;5 with the nearest cube or gray index; the screen honors the option", () => {
    expect(sgr(0xff0000, 0x000000, 0, false)).toBe("\x1b[0;38;5;196;48;5;16m");
    expect(quantize256(0x000000)).toBe(16);
    expect(quantize256(0xffffff)).toBe(231);
    expect(quantize256(0xff0000)).toBe(196);
    expect(quantize256(0x00ff00)).toBe(46);
    expect(quantize256(0x0000ff)).toBe(21);
    expect(quantize256(0x808080)).toBe(244); // gray ramp beats the cube's 0x878787
    expect(quantize256(0x5f5f5f)).toBe(59);  // exact cube point
    expect(color256(244)).toBe(0x808080);
    expect(color256(196)).toBe(0xff0000);
    expect(color256(16)).toBe(0);
    expect(color256(231)).toBe(0xffffff);
    expect(color256(255)).toBe(0xeeeeee);
    const { scr, writes } = make(40, 12, { truecolor: false });
    scr.begin(C.bg); scr.put(0, 0, "x", st(C.accent)); scr.flush(null);
    expect(writes[0]).toContain(`;38;5;${quantize256(C.accent)};48;5;${quantize256(C.bg)}m`);
    expect(writes[0]).not.toContain(";38;2;");
    expect(writes[0]).not.toContain(";48;2;");
  });

  it("every theme color round-trips within the xterm cube (idempotent index, bounded error)", () => {
    for (const name of THEME_ORDER) {
      const T = buildTheme(name);
      for (const [k, v] of Object.entries(T)) {
        if (typeof v !== "number") continue;
        const q = quantize256(v);
        expect(q).toBeGreaterThanOrEqual(16);
        expect(q).toBeLessThanOrEqual(255);
        expect(quantize256(color256(q))).toBe(q);
        const c = color256(q);
        const d = Math.hypot(((v >> 16) & 255) - ((c >> 16) & 255), ((v >> 8) & 255) - ((c >> 8) & 255), (v & 255) - (c & 255));
        expect(d, `${name}.${k}`).toBeLessThanOrEqual(83);
      }
    }
  });

  it("toHTML dumps style runs with hex colors and escapes markup", () => {
    const { scr } = make(40, 12);
    scr.begin(C.bg);
    scr.put(0, 0, "<a&b>", st(C.accent, -1, ATTR.BOLD));
    const html = scr.toHTML("Consolas");
    expect(html).toContain("<pre");
    expect(html).toContain("'Consolas'");
    expect(html).toContain(`color:#3ddbb9;background:#0b0e12;font-weight:600;">&lt;a&amp;b>`);
    expect(html).not.toContain("<a&b>");
  });
});

describe("sextant core: directory hygiene (ADR-002 + the contract's rules)", () => {
  const FILES = ["screen", "input", "theme", "layout", "engine"];
  for (const f of FILES) {
    it(`${f}.ts: no process access, ≤400 lines, provenance header, no NUL bytes`, () => {
      const src = readFileSync(join(import.meta.dir, `../../src/sextant/${f}.ts`), "utf8");
      expect(/\bprocess\s*[.[]/.test(src)).toBe(false);
      expect(src).not.toMatch(/\bDate\.now\(|\bsetTimeout\(|\bsetInterval\(/);
      expect(src.trimEnd().split("\n").length).toBeLessThanOrEqual(400);
      expect(src.split("\n")[0]).toContain("ported from the user's sextant v0.4.0 prototype");
      expect(src).not.toContain("\0");
    });
  }
});
