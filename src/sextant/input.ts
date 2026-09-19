/** ported from the user's sextant v0.4.0 prototype, src/term.js (parseInput, enter, leave) — raw key/mouse/paste parser */
/* Pure: bytes in → events out. The stdin/stdout hookup (raw mode, resize, carrying `rest` into the
   next chunk) belongs to the renderer (#44). Additions over the prototype: bracketed paste arrives
   as ONE event (a paste split across chunks waits in `rest`), an incomplete control sequence at the
   end of a chunk is carried instead of dropped, and mouseKind() encodes app.js's onMouse rules
   (releases ignored, 64/65 = wheel under any modifier, only the plain left button — b&3 = 0 and no
   modifier bits — clicks or drags).
   Renderer notes (#44): a chunk ending in a lone ESC is ambiguous — hold it ~20 ms before parsing,
   since a chunk boundary right after ESC turns the next sequence into typed keys; decode stdin as
   utf8 (a surrogate pair can split across chunks, so never decode chunks independently); OSC/DCS
   replies are not recognized here, so the renderer must not send OSC queries — a reply would arrive
   as typed text. */

import type { InputEvent, KeyEvent, MouseEvent } from "./types.ts";

const ESC = "\x1b";
const CSI = ESC + "[";
const PASTE_START = CSI + "200~";
const PASTE_END = CSI + "201~";
/** no real control sequence is this long; a longer unterminated fragment is garbage and is dropped */
export const MAX_CSI = 32;

const CSI_KEYS: Readonly<Record<string, string>> = { A: "up", B: "down", C: "right", D: "left", H: "home", F: "end", Z: "shift-tab", P: "f1", Q: "f2", R: "f3", S: "f4" };
const TILDE_KEYS: Readonly<Record<string, string>> = { 1: "home", 2: "insert", 3: "delete", 4: "end", 5: "pageup", 6: "pagedown", 7: "home", 8: "end", 11: "f1", 12: "f2", 13: "f3", 14: "f4", 15: "f5", 17: "f6", 18: "f7", 19: "f8", 20: "f9", 21: "f10", 23: "f11", 24: "f12" };
const CTRL_NAMES: Readonly<Record<number, string>> = { 0: "space", 28: "\\", 29: "]", 30: "^", 31: "/" };

const MOUSE_RE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/;
const TILDE_RE = /^\x1b\[(\d+)(?:;(\d+))?~/;
const CSI_LETTER_RE = /^\x1b\[(?:(\d+);(\d+))?([A-Z])/;
const SS3_RE = /^\x1bO([A-Z])/;
/** what ends a sequence we do not otherwise recognize (prototype: skip to the final byte) */
const FINAL_RE = /[A-Za-z~]/;

export interface ParseResult {
  events: InputEvent[];
  /** an unfinished sequence (split CSI, open paste) to prepend to the next chunk */
  rest: string;
}

/** xterm modifier parameter (1 + bits: 1 shift, 2 alt, 4 ctrl) → key event */
function withMods(name: string, mod: string | undefined): KeyEvent {
  const m = (mod ? Number(mod) : 1) - 1;
  return { type: "key", name, shift: !!(m & 1), alt: !!(m & 2), ctrl: !!(m & 4) };
}

/** parse raw terminal input (carry = the previous call's `rest`) into key/mouse/paste events */
export function parseInput(chunk: string, carry = ""): ParseResult {
  const s = carry + chunk;
  const evs: InputEvent[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (c === ESC) {
      const rest = s.slice(i);
      if (rest.startsWith(PASTE_START)) {
        const end = s.indexOf(PASTE_END, i + PASTE_START.length);
        if (end < 0) return { events: evs, rest }; // the paste continues in the next chunk
        evs.push({ type: "paste", text: s.slice(i + PASTE_START.length, end) });
        i = end + PASTE_END.length;
        continue;
      }
      let m: RegExpExecArray | null;
      if ((m = MOUSE_RE.exec(rest))) { evs.push({ type: "mouse", b: +m[1]!, x: +m[2]! - 1, y: +m[3]! - 1, press: m[4] === "M" }); i += m[0].length; continue; }
      if ((m = TILDE_RE.exec(rest))) { evs.push(withMods(TILDE_KEYS[m[1]!] ?? "unknown", m[2])); i += m[0].length; continue; }
      if ((m = CSI_LETTER_RE.exec(rest))) { evs.push(withMods(CSI_KEYS[m[3]!] ?? "unknown", m[2])); i += m[0].length; continue; }
      if ((m = SS3_RE.exec(rest))) { evs.push(withMods(CSI_KEYS[m[1]!] ?? "unknown", undefined)); i += m[0].length; continue; }
      if (rest.length === 1) { evs.push({ type: "key", name: "escape" }); i++; continue; }
      const nextCp = s.codePointAt(i + 1)!;
      // ESC followed by a control byte (ESC ESC, ESC Enter…) is a bare Escape; the next byte parses on its own
      // (the prototype reported alt+<control>, which broke the esc-esc "again to stop" arm)
      if (nextCp < 0x20 || nextCp === 0x7f) { evs.push({ type: "key", name: "escape" }); i++; continue; }
      const next = String.fromCodePoint(nextCp);
      if (next !== "[" && next !== "O") { evs.push({ type: "key", name: next.toLowerCase(), alt: true, ch: next }); i += 1 + next.length; continue; }
      // unknown or unfinished CSI/SS3: find the final byte
      let j = i + 2;
      while (j < s.length && !FINAL_RE.test(s[j]!)) j++;
      if (j >= s.length) {
        if (rest.length > MAX_CSI) { i = s.length; continue; } // garbage, not a split sequence
        return { events: evs, rest };                          // split across chunks: keep it for the next call
      }
      i = j + 1; // unknown sequence: consumed, never echoed as text
      continue;
    }
    if (c === "\r" || c === "\n") { evs.push({ type: "key", name: "enter" }); i++; continue; }
    if (c === "\t") { evs.push({ type: "key", name: "tab" }); i++; continue; }
    if (c === "\x7f" || c === "\b") { evs.push({ type: "key", name: "backspace" }); i++; continue; }
    const code = c.charCodeAt(0);
    if (code < 32) { evs.push({ type: "key", name: CTRL_NAMES[code] ?? String.fromCharCode(code + 96), ctrl: true }); i++; continue; }
    const ch = String.fromCodePoint(s.codePointAt(i)!);
    evs.push({ type: "key", name: ch, ch });
    i += ch.length;
  }
  return { events: evs, rest: "" };
}

export type MouseKind = "click" | "drag" | "wheel-up" | "wheel-down" | "release" | "other";

/** app.js onMouse rules: releases do nothing, 64/65 scroll — with the modifier bits (4 shift, 8 meta,
 *  16 ctrl) masked off first, so shift+wheel over a hit zone scrolls and never clicks it — and only the
 *  plain left button (b&3 = 0, no modifiers) clicks or drags */
export function mouseKind(e: MouseEvent): MouseKind {
  if (!e.press) return "release";
  const button = e.b & ~28;
  if (button === 64) return "wheel-up";
  if (button === 65) return "wheel-down";
  if ((e.b & 31) !== 0) return "other"; // a non-left (b&3) or modified (b&28) button never clicks or drags
  return e.b & 32 ? "drag" : "click";
}

/** term.js enter(): alt screen, cursor off, no autowrap, clear, home, SGR mouse (1000/1002/1006) and bracketed paste (2004) */
export function enterSequence(mouse = true): string {
  return CSI + "?1049h" + CSI + "?25l" + CSI + "?7l" + CSI + "2J" + CSI + "H"
    + (mouse ? CSI + "?1000h" + CSI + "?1002h" + CSI + "?1006h" : "") + CSI + "?2004h";
}

/** term.js leave(): the exact inverse, ending with the main screen restored */
export function leaveSequence(): string {
  return CSI + "?2004l" + CSI + "?1006l" + CSI + "?1002l" + CSI + "?1000l" + CSI + "0m" + CSI + "?7h" + CSI + "?25h" + CSI + "?1049l";
}

/** The runtime mouse toggle (/mouse): with tracking ON the terminal hands every drag to the app and
 *  native text selection is dead — a terminal cannot select what it is reporting. OFF gives the drag
 *  back to the terminal (select + copy as usual, in every panel at once); ON restores clicks, focus
 *  and scrollbar dragging. Most terminals also bypass reporting while Shift is held, which is why
 *  shift+drag stays the quick path and /mouse off is the comfortable one. */
export function mouseOnSequence(): string {
  return CSI + "?1000h" + CSI + "?1002h" + CSI + "?1006h";
}
export function mouseOffSequence(): string {
  return CSI + "?1006l" + CSI + "?1002l" + CSI + "?1000l";
}
