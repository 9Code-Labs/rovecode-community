/** ported from the user's sextant v0.4.0 prototype, src/app.js lines 16-37 (THEMES, buildTheme, st) + term.js (rgb, mix, hex) */
/* Palettes and their derived mixes for the sextant surface. Pure: no I/O, no clock. The derived
   values are byte-for-byte the prototype's (same mix() arithmetic); sextant-theme.test.ts pins
   every number for all three palettes. */

import { THEME_ORDER, type Style, type Theme, type ThemeName } from "./types.ts";

export { THEME_ORDER };

/** a palette as authored: "#rrggbb" strings plus the human label */
export interface Palette {
  label: string;
  bg: string; bg2: string; fg: string; fg2: string; muted: string; dim: string;
  rule: string; rule2: string; accent: string; accent2: string;
  ok: string; err: string; warn: string; info: string; str: string; ty: string;
}

export const THEMES: Readonly<Record<ThemeName, Palette>> = {
  night: { label: "Gece + nane", bg: "#0b0e12", bg2: "#11161c", fg: "#e6edf3", fg2: "#aab4bf", muted: "#7d8590", dim: "#4b545e", rule: "#2a323b", rule2: "#3a4550", accent: "#3ddbb9", accent2: "#9af2df", ok: "#3fb950", err: "#f0605d", warn: "#e3b341", info: "#79c0ff", str: "#9ee7d6", ty: "#b6c2ce" },
  ember: { label: "Mürekkep + kor", bg: "#0f0c0b", bg2: "#171210", fg: "#f2eae2", fg2: "#c9bcb0", muted: "#8c817a", dim: "#554c46", rule: "#332b27", rule2: "#463a34", accent: "#ff7a45", accent2: "#ffb08a", ok: "#6cc783", err: "#ef5a5a", warn: "#f4b942", info: "#8fb8e8", str: "#ffb38a", ty: "#cdbfb3" },
  contrast: { label: "Saf kontrast", bg: "#000000", bg2: "#0b0b0b", fg: "#ffffff", fg2: "#d4d4d4", muted: "#8a8a8a", dim: "#4c4c4c", rule: "#3a3a3a", rule2: "#4a4a4a", accent: "#ffffff", accent2: "#ffffff", ok: "#4ade80", err: "#f87171", warn: "#fbbf24", info: "#93c5fd", str: "#d4d4d4", ty: "#bdbdbd" },
};

/** "#rrggbb" → packed 0xRRGGBB */
export const rgb = (h: string): number => parseInt(h.slice(1), 16);

/** per-channel linear blend of two packed colors, rounded (term.js mix — the derived-color arithmetic) */
export function mix(c1: number, c2: number, t: number): number {
  const r = Math.round(((c1 >> 16) & 255) + ((((c2 >> 16) & 255) - ((c1 >> 16) & 255)) * t));
  const g = Math.round(((c1 >> 8) & 255) + ((((c2 >> 8) & 255) - ((c1 >> 8) & 255)) * t));
  const b = Math.round((c1 & 255) + (((c2 & 255) - (c1 & 255)) * t));
  return (r << 16) | (g << 8) | b;
}

/** packed color → "#rrggbb" */
export const hex = (c: number): string => "#" + (c >>> 0).toString(16).padStart(6, "0");

export function isThemeName(name: string): name is ThemeName {
  return Object.hasOwn(THEMES, name);
}

/** palette → packed ints + derived mixes; an unknown name falls back to "night" (prototype behavior) */
export function buildTheme(name: string): Theme {
  const n: ThemeName = isThemeName(name) ? name : "night";
  const t = THEMES[n];
  const bg = rgb(t.bg), fg = rgb(t.fg), fg2 = rgb(t.fg2), accent = rgb(t.accent), ok = rgb(t.ok), err = rgb(t.err);
  return {
    name: n,
    label: t.label,
    bg, bg2: rgb(t.bg2), fg, fg2, muted: rgb(t.muted), dim: rgb(t.dim),
    rule: rgb(t.rule), rule2: rgb(t.rule2), accent, accent2: rgb(t.accent2),
    ok, err, warn: rgb(t.warn), info: rgb(t.info), str: rgb(t.str), ty: rgb(t.ty),
    hlBg: mix(bg, accent, 0.12),
    addBg: mix(bg, ok, 0.15),
    delBg: mix(bg, err, 0.15),
    selBg: mix(bg, fg, 0.08),
    accentDim: mix(bg, accent, 0.45),
    okDim: mix(bg, ok, 0.55),
    mixDim: mix(bg, fg2, 0.55),
    frame: mix(bg, fg, 0.28),
    frameDim: mix(bg, fg, 0.17),
  };
}

/** style literal: fg, optional bg (-1 = keep the cell's), attribute bits (ATTR) */
export const st = (fg: number, bg = -1, a = 0): Style => ({ fg, bg, a });
