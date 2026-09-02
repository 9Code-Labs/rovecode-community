/** Test double for #40's buildTheme (port #41 tests): the "night" palette from the user's sextant
 *  v0.4.0 app.js:17 + the derived mixes of app.js:22-36, so panels can be drawn before theme.ts lands.
 *  Goldens compare text only — colors here only need to be well-formed packed ints. */

import type { Theme } from "../../src/sextant/types.ts";

const rgb = (hex: string): number => parseInt(hex.slice(1), 16);
function mix(c1: number, c2: number, t: number): number {
  const ch = (sh: number) => Math.round(((c1 >> sh) & 255) + ((((c2 >> sh) & 255) - ((c1 >> sh) & 255)) * t));
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}

export function nightTheme(): Theme {
  const bg = rgb("#0b0e12"), fg = rgb("#e6edf3"), fg2 = rgb("#aab4bf"), accent = rgb("#3ddbb9"), ok = rgb("#3fb950"), err = rgb("#f0605d");
  return {
    name: "night", label: "Gece + nane",
    bg, bg2: rgb("#11161c"), fg, fg2, muted: rgb("#7d8590"), dim: rgb("#4b545e"),
    rule: rgb("#2a323b"), rule2: rgb("#3a4550"), accent, accent2: rgb("#9af2df"),
    ok, err, warn: rgb("#e3b341"), info: rgb("#79c0ff"), str: rgb("#9ee7d6"), ty: rgb("#b6c2ce"),
    hlBg: mix(bg, accent, 0.12), addBg: mix(bg, ok, 0.15), delBg: mix(bg, err, 0.15), selBg: mix(bg, fg, 0.08),
    accentDim: mix(bg, accent, 0.45), okDim: mix(bg, ok, 0.55), mixDim: mix(bg, fg2, 0.55),
    frame: mix(bg, fg, 0.28), frameDim: mix(bg, fg, 0.17),
  };
}
