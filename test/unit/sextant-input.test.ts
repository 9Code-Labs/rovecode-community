/** Port #40 — input.ts: the 19 parser cases ported from the prototype's tools/test-input.js, SGR
 *  mouse press/release/wheel/drag, a CSI split across chunks, bracketed paste as ONE event, the
 *  unknown-CSI sink, and the enter/leave control strings. */

import { describe, expect, it } from "bun:test";
import { MAX_CSI, enterSequence, leaveSequence, mouseKind, parseInput } from "../../src/sextant/input.ts";
import type { InputEvent, MouseEvent } from "../../src/sextant/types.ts";

const CSI = "\x1b[";
const ev = (s: string, carry?: string): InputEvent[] => parseInput(s, carry).events;
const mouse = (b: number, press = true): MouseEvent => ({ type: "mouse", b, x: 0, y: 0, press });

/** verbatim from sextant tools/test-input.js (19 cases; only the listed keys are compared, as there) */
const CASES: [string, Record<string, unknown>[]][] = [
  ["a", [{ name: "a", ch: "a" }]],
  ["\x0b", [{ name: "k", ctrl: true }]],
  ["\x1b", [{ name: "escape" }]],
  ["\x1b[A", [{ name: "up" }]],
  ["\x1b[1;5D", [{ name: "left", ctrl: true }]],
  ["\x1b[3~", [{ name: "delete" }]],
  ["\x1b[5~", [{ name: "pageup" }]],
  ["\x1bOP", [{ name: "f1" }]],
  ["\x1b[12~", [{ name: "f2" }]],
  ["\x1b[Z", [{ name: "shift-tab" }]],
  ["\r", [{ name: "enter" }]],
  ["\t", [{ name: "tab" }]],
  ["\x7f", [{ name: "backspace" }]],
  ["\x1b[<0;12;5M", [{ type: "mouse", b: 0, x: 11, y: 4, press: true }]],
  ["\x1b[<64;3;3M", [{ type: "mouse", b: 64 }]],
  ["ğü", [{ ch: "ğ" }, { ch: "ü" }]],
  ["\x1bx", [{ name: "x", alt: true }]],
  ["\x1c", [{ name: "\\", ctrl: true }]],
  ["ab\x1b[B", [{ ch: "a" }, { ch: "b" }, { name: "down" }]],
];

describe("sextant input: the 19 prototype cases", () => {
  for (const [inp, exp] of CASES) {
    it(JSON.stringify(inp), () => {
      const { events, rest } = parseInput(inp);
      expect(events.length).toBe(exp.length);
      exp.forEach((e, i) => { for (const k of Object.keys(e)) expect(String((events[i] as unknown as Record<string, unknown>)[k])).toBe(String(e[k])); });
      expect(rest).toBe("");
    });
  }

  it("exact event shapes: modifiers are explicit booleans on CSI keys, plain keys carry ch", () => {
    expect(ev("\x1b[1;5D")).toEqual([{ type: "key", name: "left", shift: false, alt: false, ctrl: true }]);
    expect(ev("\x1b[1;2A")).toEqual([{ type: "key", name: "up", shift: true, alt: false, ctrl: false }]);
    expect(ev("\x1b[1;3A")[0]).toMatchObject({ name: "up", alt: true, ctrl: false });
    expect(ev("\x1b[1;6A")[0]).toMatchObject({ name: "up", shift: true, ctrl: true });
    expect(ev("\x1b[3;5~")[0]).toMatchObject({ name: "delete", ctrl: true });
    expect(ev("\x1b[24~")[0]).toMatchObject({ name: "f12" });
    expect(ev("\x1b[99~")[0]).toMatchObject({ name: "unknown" });
    expect(ev("\x1b[Y")[0]).toMatchObject({ name: "unknown" });
    expect(ev("q")).toEqual([{ type: "key", name: "q", ch: "q" }]);
    expect(ev("😀")).toEqual([{ type: "key", name: "😀", ch: "😀" }]);
    expect(ev("\x1bX")).toEqual([{ type: "key", name: "x", alt: true, ch: "X" }]);
    expect(ev("\x00")).toEqual([{ type: "key", name: "space", ctrl: true }]);
    expect(ev("\x1d")).toEqual([{ type: "key", name: "]", ctrl: true }]);
    expect(ev("\x01")).toEqual([{ type: "key", name: "a", ctrl: true }]);
    expect(ev("\n")).toEqual([{ type: "key", name: "enter" }]);
    expect(ev("\b")).toEqual([{ type: "key", name: "backspace" }]);
  });
});

describe("sextant input: SGR mouse", () => {
  it("press / release / wheel / drag decode with 0-based coordinates", () => {
    expect(ev("\x1b[<0;12;5M")).toEqual([{ type: "mouse", b: 0, x: 11, y: 4, press: true }]);
    expect(ev("\x1b[<0;12;5m")).toEqual([{ type: "mouse", b: 0, x: 11, y: 4, press: false }]);
    expect(ev("\x1b[<64;3;3M")).toEqual([{ type: "mouse", b: 64, x: 2, y: 2, press: true }]);
    expect(ev("\x1b[<65;3;3M")).toEqual([{ type: "mouse", b: 65, x: 2, y: 2, press: true }]);
    expect(ev("\x1b[<32;10;10M")).toEqual([{ type: "mouse", b: 32, x: 9, y: 9, press: true }]);
    expect(ev("\x1b[<2;160;44M")).toEqual([{ type: "mouse", b: 2, x: 159, y: 43, press: true }]);
  });

  it("mouseKind: releases ignored, 64/65 wheel, b&3≠0 never clicks, 32+b drags", () => {
    expect(mouseKind(mouse(0))).toBe("click");
    expect(mouseKind(mouse(32))).toBe("drag");
    expect(mouseKind(mouse(64))).toBe("wheel-up");
    expect(mouseKind(mouse(65))).toBe("wheel-down");
    expect(mouseKind(mouse(1))).toBe("other");   // middle
    expect(mouseKind(mouse(2))).toBe("other");   // right
    expect(mouseKind(mouse(34))).toBe("other");  // right drag
    expect(mouseKind(mouse(0, false))).toBe("release");
    expect(mouseKind(mouse(64, false))).toBe("release");
  });

  it("mouseKind masks the modifier bits: shift/meta/ctrl + wheel still scrolls (never clicks); a modified button is 'other'", () => {
    for (const b of [64, 68, 72, 80, 84, 92]) expect(mouseKind(mouse(b)), `b=${b}`).toBe("wheel-up");     // +4 shift, +8 meta, +16 ctrl
    for (const b of [65, 69, 73, 81, 85, 93]) expect(mouseKind(mouse(b)), `b=${b}`).toBe("wheel-down");
    expect(mouseKind(mouse(0))).toBe("click");
    expect(mouseKind(mouse(32))).toBe("drag");
    expect(mouseKind(mouse(4))).toBe("other");   // shift+left: a modified press never hits a zone
    expect(mouseKind(mouse(8))).toBe("other");   // meta+left
    expect(mouseKind(mouse(16))).toBe("other");  // ctrl+left
    expect(mouseKind(mouse(36))).toBe("other");  // shift+drag
    expect(mouseKind(mouse(6))).toBe("other");   // shift+right
    expect(mouseKind(mouse(68, false))).toBe("release");
    expect(mouseKind(ev("\x1b[<68;3;3M")[0] as MouseEvent)).toBe("wheel-up"); // through the parser too
  });
});

describe("sextant input: chunk boundaries", () => {
  it("a CSI split across two chunks is buffered in rest, then completed with the carry", () => {
    const first = parseInput("\x1b[1;");
    expect(first).toEqual({ events: [], rest: "\x1b[1;" });
    expect(parseInput("5D", first.rest)).toEqual({ events: [{ type: "key", name: "left", shift: false, alt: false, ctrl: true }], rest: "" });
    const m1 = parseInput("ab\x1b[<0;12");
    expect(m1.events.map((e) => (e as { ch?: string }).ch)).toEqual(["a", "b"]);
    expect(m1.rest).toBe("\x1b[<0;12");
    expect(parseInput(";5M", m1.rest).events).toEqual([{ type: "mouse", b: 0, x: 11, y: 4, press: true }]);
    expect(parseInput("\x1b[")).toEqual({ events: [], rest: "\x1b[" });
    expect(parseInput("\x1bO")).toEqual({ events: [], rest: "\x1bO" });
    expect(parseInput("P", "\x1bO").events).toEqual([{ type: "key", name: "f1", shift: false, alt: false, ctrl: false }]);
  });

  it("a lone ESC is Escape (no timer in a pure parser); ESC + control byte is Escape then that key; ESC + letter is alt", () => {
    expect(ev("\x1b")).toEqual([{ type: "key", name: "escape" }]);
    expect(ev("\x1b\x1b")).toEqual([{ type: "key", name: "escape" }, { type: "key", name: "escape" }]); // the esc-esc arm
    expect(ev("\x1b\r")).toEqual([{ type: "key", name: "escape" }, { type: "key", name: "enter" }]);
    expect(ev("\x1b\x1b[A")).toEqual([{ type: "key", name: "escape" }, { type: "key", name: "up", shift: false, alt: false, ctrl: false }]);
    expect(ev("\x1bx")).toEqual([{ type: "key", name: "x", alt: true, ch: "x" }]);
  });

  it("an unknown CSI is consumed, not echoed; text after it still arrives", () => {
    expect(parseInput("\x1b[?1;2c")).toEqual({ events: [], rest: "" });
    expect(ev("\x1b[?1;2cab")).toEqual([{ type: "key", name: "a", ch: "a" }, { type: "key", name: "b", ch: "b" }]);
    expect(ev("\x1b[38;2;1;2;3mZ")).toEqual([{ type: "key", name: "Z", ch: "Z" }]);
    expect(ev("\x1b[[A")).toEqual([]); // linux-console F1: swallowed whole, as in the prototype
  });

  it("an unterminated fragment longer than MAX_CSI is garbage and dropped, not carried forever", () => {
    const junk = "\x1b[" + "1;".repeat(MAX_CSI);
    expect(junk.length).toBeGreaterThan(MAX_CSI);
    expect(parseInput(junk)).toEqual({ events: [], rest: "" });
    expect(parseInput("x" + junk).events).toEqual([{ type: "key", name: "x", ch: "x" }]);
  });
});

describe("sextant input: bracketed paste", () => {
  it("CSI 200~ … 201~ becomes ONE paste event — newlines inside never become Enter", () => {
    const { events, rest } = parseInput(CSI + "200~hello\nworld\r\n" + CSI + "201~");
    expect(events).toEqual([{ type: "paste", text: "hello\nworld\r\n" }]);
    expect(rest).toBe("");
    expect(ev("a" + CSI + "200~b\x1b[Ac" + CSI + "201~d")).toEqual([
      { type: "key", name: "a", ch: "a" },
      { type: "paste", text: "b\x1b[Ac" },
      { type: "key", name: "d", ch: "d" },
    ]);
  });

  it("a paste spanning chunks waits in rest until its terminator arrives", () => {
    const open = parseInput("x" + CSI + "200~hel");
    expect(open.events).toEqual([{ type: "key", name: "x", ch: "x" }]);
    expect(open.rest).toBe(CSI + "200~hel");
    const mid = parseInput("lo\nwor", open.rest);
    expect(mid.events).toEqual([]);
    expect(mid.rest).toBe(CSI + "200~hello\nwor");
    const done = parseInput("ld" + CSI + "201~y", mid.rest);
    expect(done).toEqual({ events: [{ type: "paste", text: "hello\nworld" }, { type: "key", name: "y", ch: "y" }], rest: "" });
  });

  it("an empty paste is still one (empty) event, and a long paste is not subject to MAX_CSI", () => {
    expect(ev(CSI + "200~" + CSI + "201~")).toEqual([{ type: "paste", text: "" }]);
    const big = "line\n".repeat(2000);
    const open = parseInput(CSI + "200~" + big);
    expect(open.events).toEqual([]);
    expect(open.rest.length).toBe(6 + big.length);
    expect(parseInput(CSI + "201~", open.rest).events).toEqual([{ type: "paste", text: big }]);
  });
});

describe("sextant input: enter/leave control strings", () => {
  it("enterSequence: alt screen, cursor off, no autowrap, clear, home, SGR mouse, bracketed paste", () => {
    expect(enterSequence(true)).toBe(CSI + "?1049h" + CSI + "?25l" + CSI + "?7l" + CSI + "2J" + CSI + "H" + CSI + "?1000h" + CSI + "?1002h" + CSI + "?1006h" + CSI + "?2004h");
    expect(enterSequence(false)).toBe(CSI + "?1049h" + CSI + "?25l" + CSI + "?7l" + CSI + "2J" + CSI + "H" + CSI + "?2004h");
    expect(enterSequence()).toBe(enterSequence(true));
  });

  it("leaveSequence: the exact inverse, ending on the main screen with the cursor shown", () => {
    expect(leaveSequence()).toBe(CSI + "?2004l" + CSI + "?1006l" + CSI + "?1002l" + CSI + "?1000l" + CSI + "0m" + CSI + "?7h" + CSI + "?25h" + CSI + "?1049l");
    for (const tail of ["?1049l", "?25h", "?1006l", "?2004l"]) expect(leaveSequence()).toContain(CSI + tail);
    expect(leaveSequence().endsWith(CSI + "?1049l")).toBe(true);
  });
});
