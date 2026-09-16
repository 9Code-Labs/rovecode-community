/** Port #40 — layout.ts: layout() rectangles pinned against the prototype's layout() (computed with
 *  node over app.js lines 184-205 at each size, 2026-09-02) and panel() geometry/colors. */

import { describe, expect, it } from "bun:test";
import { layout, panel } from "../../src/sextant/layout.ts";
import { Screen } from "../../src/sextant/screen.ts";
import { buildTheme, st } from "../../src/sextant/theme.ts";
import { ATTR, type Layout, type Rect } from "../../src/sextant/types.ts";

const R = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });
const C = buildTheme("night");

/** [cols, rows] → the prototype's rectangles (msg renamed messages; absent panels are null) */
const PROTOTYPE: [number, number, Layout][] = [
  [160, 44, { w: 160, h: 44, frame: R(0, 0, 159, 44), files: R(2, 1, 30, 28), code: R(33, 1, 89, 28), messages: R(33, 29, 89, 14), plan: R(123, 1, 34, 37), usage: R(123, 38, 34, 5), pet: R(2, 29, 30, 14) }],
  [149, 44, { w: 149, h: 44, frame: R(0, 0, 148, 44), files: R(2, 1, 26, 28), code: R(29, 1, 88, 28), messages: R(29, 29, 88, 14), plan: R(118, 1, 28, 37), usage: R(118, 38, 28, 5), pet: R(2, 29, 26, 14) }],
  [139, 44, { w: 139, h: 44, frame: R(0, 0, 138, 44), files: null, code: R(2, 1, 105, 28), messages: R(2, 29, 105, 14), plan: R(108, 1, 28, 23), usage: R(108, 38, 28, 5), pet: R(108, 24, 28, 14) }],
  [109, 44, { w: 109, h: 44, frame: R(0, 0, 108, 44), files: null, code: R(2, 1, 104, 28), messages: R(2, 29, 104, 14), plan: null, usage: null, pet: null }],
  [100, 30, { w: 100, h: 30, frame: R(0, 0, 99, 30), files: null, code: R(2, 1, 95, 18), messages: R(2, 19, 95, 10), plan: null, usage: null, pet: null }],
  [160, 33, { w: 160, h: 33, frame: R(0, 0, 159, 33), files: R(2, 1, 30, 31), code: R(33, 1, 89, 20), messages: R(33, 21, 89, 11), plan: R(123, 1, 34, 26), usage: R(123, 27, 34, 5), pet: null }],
  [150, 38, { w: 150, h: 38, frame: R(0, 0, 149, 38), files: R(2, 1, 30, 22), code: R(33, 1, 79, 24), messages: R(33, 25, 79, 12), plan: R(113, 1, 34, 31), usage: R(113, 32, 34, 5), pet: R(2, 23, 30, 14) }],
  [110, 44, { w: 110, h: 44, frame: R(0, 0, 109, 44), files: null, code: R(2, 1, 76, 28), messages: R(2, 29, 76, 14), plan: R(79, 1, 28, 23), usage: R(79, 38, 28, 5), pet: R(79, 24, 28, 14) }],
  [140, 44, { w: 140, h: 44, frame: R(0, 0, 139, 44), files: R(2, 1, 26, 28), code: R(29, 1, 79, 28), messages: R(29, 29, 79, 14), plan: R(109, 1, 28, 37), usage: R(109, 38, 28, 5), pet: R(2, 29, 26, 14) }],
];

describe("sextant layout: mirrors the prototype's layout()", () => {
  for (const [w, h, want] of PROTOTYPE) {
    it(`${w}×${h}`, () => { expect(layout(w, h, { pet: true })).toEqual(want); });
  }

  it("bar clauses: 139 → no files column, 109 → no right column, 160×33 → no pet", () => {
    expect(layout(139, 44, { pet: true }).files).toBeNull();
    expect(layout(140, 44, { pet: true }).files).not.toBeNull();
    const narrow = layout(109, 44, { pet: true });
    expect(narrow.plan).toBeNull();
    expect(narrow.usage).toBeNull();
    expect(narrow.pet).toBeNull(); // no files and no right column → nowhere to put the pet
    expect(layout(110, 44, { pet: true }).plan).not.toBeNull();
    expect(layout(160, 33, { pet: true }).pet).toBeNull(); // contentH 31 < 36
    expect(layout(160, 38, { pet: true }).pet).not.toBeNull(); // contentH 36
  });

  it("breakpoint widths: files 26/30 at 140/150, right 28/34 at 110/150", () => {
    expect(layout(149, 44, { pet: true }).files!.w).toBe(26);
    expect(layout(150, 44, { pet: true }).files!.w).toBe(30);
    expect(layout(149, 44, { pet: true }).plan!.w).toBe(28);
    expect(layout(150, 44, { pet: true }).plan!.w).toBe(34);
  });

  it("messages = max(8, round(contentH · 0.34)) and the code panel takes the rest", () => {
    const big = layout(160, 44, { pet: true });
    expect(big.messages.h).toBe(14); // round(42 · 0.34 = 14.28)
    expect(big.code.h + big.messages.h).toBe(42);
    expect(big.messages.y).toBe(big.code.y + big.code.h);
    const small = layout(100, 30, { pet: true });
    expect(small.messages.h).toBe(10); // round(28 · 0.34 = 9.52)
    expect(layout(40, 12, { pet: true }).messages.h).toBe(8); // floor: round(10 · 0.34 = 3.4) → 8
  });

  it("pet: 14 rows under files when present, else under plan; opts.pet=false gives the rows back", () => {
    const withFiles = layout(160, 44, { pet: true });
    expect(withFiles.pet).toEqual(R(2, 29, 30, 14));
    expect(withFiles.files!.h + withFiles.pet!.h).toBe(42);
    const underPlan = layout(139, 44, { pet: true });
    expect(underPlan.pet!.x).toBe(underPlan.plan!.x);
    expect(underPlan.plan!.h + underPlan.pet!.h + underPlan.usage!.h).toBe(42);
    expect(underPlan.usage!.h).toBe(5);
    const noPet = layout(160, 44, { pet: false });
    expect(noPet.pet).toBeNull();
    expect(noPet.files!.h).toBe(42);
    expect({ ...noPet, files: null, pet: null }).toEqual({ ...withFiles, files: null, pet: null });
  });

  it("columns tile the frame: files | code | right with one-cell gutters", () => {
    for (const [w, h] of PROTOTYPE) {
      const L = layout(w, h, { pet: true });
      if (L.files) expect(L.code.x).toBe(L.files.x + L.files.w + 1); else expect(L.code.x).toBe(2);
      if (L.plan) expect(L.plan.x).toBe(L.code.x + L.code.w + 1); else expect(L.code.x + L.code.w).toBe(L.w - 3);
      if (L.plan && L.usage) { expect(L.usage.y).toBe(L.plan.y + L.plan.h + (L.pet && !L.files ? L.pet.h : 0)); expect(L.usage.y + L.usage.h).toBe(L.h - 1); }
      expect(L.frame).toEqual(R(0, 0, L.w - 1, L.h));
    }
  });

  it("clamps to the 40×12 floor like Screen.resize", () => {
    expect(layout(10, 5, { pet: true })).toEqual(layout(40, 12, { pet: true }));
    expect(layout(0, 0, { pet: false }).w).toBe(40);
    expect(layout(0, 0, { pet: false }).h).toBe(12);
    expect(layout(200, 60, { pet: true }).w).toBe(200);
  });
});

describe("sextant layout: panel()", () => {
  const make = () => { const scr = new Screen({ write() {} }, 60, 20); scr.begin(C.bg); return scr; };
  const row = (scr: Screen, y: number) => scr.toText().split("\n")[y]!;

  it("draws the rounded box, title in the border, right-aligned extra, and returns the inner rect", () => {
    const scr = make();
    const inner = panel(scr, R(2, 1, 40, 10), "files", false, [["12", st(C.muted)]], C);
    expect(inner).toEqual(R(4, 2, 36, 8));
    expect(row(scr, 1)).toBe("  ╭─ files " + "─".repeat(26) + " 12 ╮");
    expect(row(scr, 10)).toBe("  ╰" + "─".repeat(38) + "╯");
    expect(row(scr, 5)).toBe("  │" + " ".repeat(38) + "│");
    expect(scr.cellAt(2, 1)!.fg).toBe(C.frame);         // unfocused border
    expect(scr.cellAt(5, 1)!.fg).toBe(C.fg2);           // unfocused title
    expect(scr.cellAt(5, 1)!.a & ATTR.BOLD).toBe(ATTR.BOLD);
    expect(scr.cellAt(38, 1)!.fg).toBe(C.muted);        // extra keeps its own style
  });

  it("focused → accent border and title; an explicit color wins over both", () => {
    const scr = make();
    panel(scr, R(2, 1, 40, 10), "code", true, [], C);
    expect(scr.cellAt(2, 1)!.fg).toBe(C.accent);
    expect(scr.cellAt(5, 1)!.fg).toBe(C.accent);
    const scr2 = make();
    panel(scr2, R(2, 1, 40, 10), "run", false, undefined, C, 0x123456);
    expect(scr2.cellAt(2, 1)!.fg).toBe(0x123456);
    expect(scr2.cellAt(5, 1)!.fg).toBe(0x123456);
    expect(scr2.cellAt(41, 1)!.ch).toBe("╮");
  });

  it("no title → plain border; empty extra list draws nothing extra", () => {
    const scr = make();
    panel(scr, R(0, 0, 10, 3), "", false, [], C);
    expect(row(scr, 0)).toBe("╭────────╮");
  });

  it("extra is dropped when it would collide with the title (strict >, as the prototype)", () => {
    const tight = make();
    panel(tight, R(2, 1, 12, 5), "ab", false, [["xyz", st(C.muted)]], C); // ex = P.x+6, limit = P.x+4+2 → not >
    expect(row(tight, 1)).not.toContain("xyz");
    const roomy = make();
    panel(roomy, R(2, 1, 13, 5), "ab", false, [["xyz", st(C.muted)]], C);
    expect(row(roomy, 1)).toBe("  ╭─ ab ─ xyz ╮");
  });

  it("extra width is measured in cells, so a wide glyph keeps the closing corner at x+w-1", () => {
    const scr = make();
    panel(scr, R(0, 0, 20, 3), "t", false, [["字字", st(C.fg)]], C);
    expect(row(scr, 0).endsWith(" 字字 ╮")).toBe(true);
    expect(scr.cellAt(19, 0)!.ch).toBe("╮");
    expect(scr.cellAt(14, 0)!.ch).toBe("字");
    expect(scr.cellAt(16, 0)!.ch).toBe("字");
    expect(scr.cellAt(13, 0)!.ch).toBe(" ");
  });
});
