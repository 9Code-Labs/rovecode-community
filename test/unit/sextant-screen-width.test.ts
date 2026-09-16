/** Port #40 hardening — screen.ts width rules: zero-width code points (combining marks, VS16, ZWJ
 *  sequences) ride on the glyph before them, so the terminal cursor never ends left of the buffer and
 *  a border emitted in the same run lands in its column; frame glyphs measure 1 cell even under
 *  ambiguousAsWide, so box()/hline()/clip() cannot self-destruct. BMP marks are replayed through
 *  @xterm/headless as the oracle; its Unicode 6 tables predate emoji (a ZWJ family shows as three
 *  1-cell glyphs there), so the family case is asserted on the buffer and the byte stream only.
 *  Invisible code points are built with String.fromCodePoint so this file stays readable. */

import { describe, expect, it } from "bun:test";
import xterm from "@xterm/headless";
import { CSI, Screen, charWidth, glyphs, sgr, strWidth } from "../../src/sextant/screen.ts";
import { buildTheme, st } from "../../src/sextant/theme.ts";

const C = buildTheme("night");
const ACUTE = String.fromCodePoint(0x301);  // COMBINING ACUTE ACCENT (Mn)
const VS16 = String.fromCodePoint(0xfe0f);  // VARIATION SELECTOR-16 (Mn, EAW ambiguous)
const ZWJ = String.fromCodePoint(0x200d);   // ZERO WIDTH JOINER (Cf)
const MAN = String.fromCodePoint(0x1f468), WOMAN = String.fromCodePoint(0x1f469), GIRL = String.fromCodePoint(0x1f467);
const FAMILY = MAN + ZWJ + WOMAN + ZWJ + GIRL; // the family emoji: 2 cells on Windows Terminal, 8 when every code point gets a cell
const cp = (s: string): number => s.codePointAt(0)!;

function make(cols = 40, rows = 12, opts?: { ambiguousAsWide?: boolean }) {
  const writes: string[] = [];
  const scr = new Screen({ write: (s) => writes.push(s) }, cols, rows, opts);
  return { scr, writes, row: (y = 0): string => scr.toText().split("\n")[y]! };
}

/** House hazard: an await with no pending timer hangs the runner — the xterm settle rides a deadline. */
function deadline<T>(p: Promise<T>, ms = 4000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bomb = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`did not settle within ${ms}ms`)), ms); });
  return Promise.race([p, bomb]).finally(() => { if (timer) clearTimeout(timer); });
}
/** replay the sink writes through xterm.js; getChars() per cell of row y ("" = never written), asserting no scroll */
async function replayRow(writes: readonly string[], cols: number, rows: number, y = 0): Promise<string[]> {
  const t = new xterm.Terminal({ cols, rows, allowProposedApi: true, disableStdin: true });
  for (const w of writes) t.write(w);
  await deadline(new Promise<void>((r) => t.write("", () => r())));
  const line = t.buffer.active.getLine(y);
  const cells: string[] = [];
  for (let x = 0; x < cols; x++) cells.push(line?.getCell(x)?.getChars() ?? "");
  const scrolled = t.buffer.active.length > rows;
  t.dispose();
  expect(scrolled).toBe(false);
  return cells;
}

describe("sextant screen: zero-width code points join the glyph before them", () => {
  it("e + U+0301 is ONE cell in the buffer, in toText and in the terminal; strWidth/glyphs agree", async () => {
    const { scr, writes, row } = make();
    scr.begin(-1);
    expect(scr.put(0, 0, "e" + ACUTE + "x", st(C.fg))).toBe(2);
    expect(scr.cellAt(0, 0)).toMatchObject({ ch: "e" + ACUTE, width: 1 });
    expect(scr.cellAt(1, 0)).toMatchObject({ ch: "x", width: 1 });
    expect(row()).toBe("e" + ACUTE + "x");
    expect(charWidth(0x301)).toBe(0);
    expect(strWidth("e" + ACUTE + "x")).toBe(2);
    expect([...glyphs("e" + ACUTE + "x")]).toEqual([["e" + ACUTE, 1], ["x", 1]]);
    scr.flush(null);
    expect(writes[0]).toContain(sgr(C.fg, -1, 0) + "e" + ACUTE + "x");
    const cells = await replayRow(writes, 40, 12);
    expect(cells[0]).toBe("e" + ACUTE);
    expect(cells[1]).toBe("x");
    expect(cells[2]).toBe(" ");
  });

  it("VS16 joins its base (x + U+FE0F = 1 cell, even under ambiguousAsWide) and a right border after it stays in column w-1", async () => {
    const { scr, writes } = make();
    scr.begin(-1);
    expect(scr.put(37, 0, "x" + VS16 + "y", st(C.fg))).toBe(39);
    scr.vline(39, 0, 1, st(C.fg));
    expect(scr.cellAt(37, 0)).toMatchObject({ ch: "x" + VS16, width: 1 });
    expect(scr.cellAt(38, 0)).toMatchObject({ ch: "y", width: 1 });
    expect(scr.cellAt(39, 0)).toMatchObject({ ch: "│", width: 1 });
    expect(charWidth(0xfe0f, true)).toBe(0); // EAW calls VS16 "ambiguous": zero-width wins over the option
    expect(strWidth("x" + VS16, true)).toBe(1);
    scr.flush(null);
    const cells = await replayRow(writes, 40, 12);
    expect(cells[37]).toBe("x" + VS16);
    expect(cells[38]).toBe("y");
    expect(cells[39]).toBe("│");
  });

  it("a ZWJ family emoji is ONE wide glyph: 2 cells, the border after it in the right column, one contiguous flush run", () => {
    const { scr, writes, row } = make();
    scr.begin(-1);
    expect(scr.put(37, 0, FAMILY, st(C.fg))).toBe(39);
    scr.vline(39, 0, 1, st(C.fg));
    expect(scr.cellAt(37, 0)).toMatchObject({ ch: FAMILY, width: 2 });
    expect(scr.cellAt(38, 0)).toMatchObject({ ch: "", width: 0 });
    expect(scr.cellAt(39, 0)).toMatchObject({ ch: "│", width: 1 });
    expect(row()).toBe(" ".repeat(37) + FAMILY + "│");
    expect(strWidth(FAMILY)).toBe(2);
    expect(strWidth(row())).toBe(40);
    expect([...glyphs(FAMILY)]).toEqual([[FAMILY, 2]]);
    scr.flush(null);
    // the family and the border go out in one run: no cursor move to column 40 between them
    expect(writes[0]).toContain(sgr(C.fg, -1, 0) + FAMILY + "│");
    expect(writes[0]).not.toContain(CSI + "1;40H");
  });

  it("a leading zero-width code point has nothing to join and is dropped; a clipped glyph takes its marks with it", () => {
    const { scr, row } = make();
    scr.begin(-1);
    expect(scr.put(0, 0, ACUTE + "a", st(C.fg))).toBe(1);
    expect(scr.cellAt(0, 0)).toMatchObject({ ch: "a", width: 1 });
    expect(row(0)).toBe("a");
    expect(scr.put(0, 1, ZWJ + WOMAN, st(C.fg))).toBe(2); // a ZWJ with no glyph before it joins nothing
    expect(scr.cellAt(0, 1)).toMatchObject({ ch: WOMAN, width: 2 });
    expect(scr.put(-1, 2, "a" + ACUTE + "b", st(C.fg))).toBe(1); // "a" is off-screen: its mark goes with it
    expect(row(2)).toBe("b");
    expect([...glyphs(ACUTE)]).toEqual([]);
    expect(strWidth(ACUTE)).toBe(0);
    expect(strWidth(ZWJ + ACUTE)).toBe(0);
    expect(strWidth(ZWJ + "a")).toBe(1); // a ZWJ never joins ASCII (UAX #29 keeps them apart)
  });

  it("clip()/head() count a joined glyph as one cell; fill() with a lone zero-width glyph paints spaces and returns", () => {
    const { scr, row } = make();
    scr.begin(-1);
    expect(scr.clip(0, 0, ("e" + ACUTE).repeat(4), st(C.fg), 3)).toBe(3);
    expect(row(0)).toBe("e" + ACUTE + "e" + ACUTE + "…");
    scr.begin(-1);
    expect(scr.clip(0, 0, ("e" + ACUTE).repeat(3), st(C.fg), 3)).toBe(3); // exact fit: untouched
    expect(row(0)).toBe(("e" + ACUTE).repeat(3));
    scr.fill(0, 1, 3, 1, ACUTE, st(C.fg));
    expect(scr.cellAt(0, 1)).toMatchObject({ ch: " ", width: 1 });
    expect(row(1)).toBe("");
  });
});

describe("sextant screen: ambiguousAsWide measures content, never the frame", () => {
  it("frame glyphs are 1 cell under the option while ◆/¡ are 2; the defaults are unchanged", () => {
    for (const g of "╭╮╰╯─│┆╌…▌▏▎━╱╲░") expect(charWidth(cp(g), true), g).toBe(1);
    expect(charWidth(cp("◆"), true)).toBe(2);
    expect(charWidth(cp("¡"), true)).toBe(2);
    expect(strWidth("◆ sextant", true)).toBe(10);
    expect(strWidth("╭───╮", true)).toBe(5);
    expect(charWidth(cp("─"))).toBe(1);
    expect(charWidth(cp("◆"))).toBe(1);
    expect(charWidth(cp("字"))).toBe(2);
    expect(charWidth(cp("😀"))).toBe(2); // U+1F600 is East Asian Wide
    expect(charWidth(cp("🌩"))).toBe(1); // U+1F329 is Neutral (text presentation) — one cell
    expect(strWidth("◆ sextant")).toBe(9);
    expect(strWidth("字字")).toBe(4);
  });

  it("with ambiguousAsWide, box()/hline()/vline() render intact and clip() keeps its ellipsis; content is still wide", () => {
    const { scr, row } = make(40, 12, { ambiguousAsWide: true });
    scr.begin(C.bg);
    scr.box(0, 0, 5, 3, st(C.frame));
    expect(scr.toText().split("\n").slice(0, 3)).toEqual(["╭───╮", "│   │", "╰───╯"]);
    expect(scr.cellAt(0, 0)).toMatchObject({ ch: "╭", width: 1 });
    expect(scr.cellAt(4, 0)).toMatchObject({ ch: "╮", width: 1 });
    scr.hline(10, 5, 3, st(C.frame), "╌");
    expect(row(5)).toBe(" ".repeat(10) + "╌╌╌");
    expect(scr.clip(0, 6, "abcdefgh", st(C.fg), 5)).toBe(5);
    expect(row(6)).toBe("abcd…");
    scr.put(0, 7, "◆", st(C.accent));
    expect(scr.cellAt(0, 7)).toMatchObject({ ch: "◆", width: 2 });
    expect(scr.cellAt(1, 7)).toMatchObject({ ch: "", width: 0 });
    const narrow = make();
    narrow.scr.begin(-1); narrow.scr.put(0, 0, "◆", st(C.fg));
    expect(narrow.scr.cellAt(0, 0)!.width).toBe(1);
  });
});
