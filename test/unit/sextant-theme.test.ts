/** Port #40 — theme.ts: palettes, derived mixes byte-equal to the prototype, st(). The expected
 *  numbers were computed from the prototype itself (node -e over app.js lines 16-36 with term.js
 *  rgb/mix, 2026-09-02) — not from this port. */

import { describe, expect, it } from "bun:test";
import { THEME_ORDER, THEMES, buildTheme, hex, isThemeName, mix, rgb, st } from "../../src/sextant/theme.ts";
import { THEME_ORDER as CONTRACT_ORDER, type Theme } from "../../src/sextant/types.ts";

/** derived mixes per palette, as the prototype's buildTheme() produces them (packed ints) */
const DERIVED: Record<string, Pick<Theme, "hlBg" | "addBg" | "delBg" | "selBg" | "accentDim" | "okDim" | "mixDim" | "frame" | "frameDim">> = {
  night: { hlBg: 1124134, addBg: 1255451, delBg: 2955805, selBg: 1908772, accentDim: 2255453, okDim: 2649140, mixDim: 6449521, frame: 4738129, frameDim: 3159096 },
  ember: { hlBg: 2890002, addBg: 1910813, delBg: 3217431, selBg: 2170396, accentDim: 8076837, okDim: 4354893, mixDim: 7695718, frame: 5196359, frameDim: 3551792 },
  contrast: { hlBg: 2039583, addBg: 729363, delBg: 2429201, selBg: 1315860, accentDim: 7566195, okDim: 2718278, mixDim: 7697781, frame: 4671303, frameDim: 2829099 },
};
/** the same, as hex — the prototype's hex() of each derived value */
const DERIVED_HEX: Record<string, Record<string, string>> = {
  night: { hlBg: "#112726", addBg: "#13281b", delBg: "#2d1a1d", selBg: "#1d2024", accentDim: "#226a5d", okDim: "#286c34", mixDim: "#626971", frame: "#484c51", frameDim: "#303438" },
  ember: { hlBg: "#2c1912", addBg: "#1d281d", delBg: "#311817", selBg: "#211e1c", accentDim: "#7b3e25", okDim: "#42734d", mixDim: "#756d66", frame: "#4f4a47", frameDim: "#363230" },
  contrast: { hlBg: "#1f1f1f", addBg: "#0b2113", delBg: "#251111", selBg: "#141414", accentDim: "#737373", okDim: "#297a46", mixDim: "#757575", frame: "#474747", frameDim: "#2b2b2b" },
};
const PALETTE_KEYS = ["bg", "bg2", "fg", "fg2", "muted", "dim", "rule", "rule2", "accent", "accent2", "ok", "err", "warn", "info", "str", "ty"] as const;

describe("sextant theme: palettes", () => {
  it("THEME_ORDER is the contract's and lists the three prototype palettes", () => {
    expect(THEME_ORDER).toBe(CONTRACT_ORDER);
    expect([...THEME_ORDER]).toEqual(["night", "ember", "contrast"]);
    expect(Object.keys(THEMES)).toEqual(["night", "ember", "contrast"]);
  });

  it("labels are the prototype's (Turkish, verbatim)", () => {
    expect(THEMES.night.label).toBe("Gece + nane");
    expect(THEMES.ember.label).toBe("Mürekkep + kor");
    expect(THEMES.contrast.label).toBe("Saf kontrast");
  });

  it("every palette color is a #rrggbb string that survives rgb()/hex()", () => {
    for (const name of THEME_ORDER) for (const k of PALETTE_KEYS) {
      const h = THEMES[name][k];
      expect(h).toMatch(/^#[0-9a-f]{6}$/);
      expect(hex(rgb(h))).toBe(h);
    }
  });
});

describe("sextant theme: buildTheme derived mixes equal the prototype", () => {
  for (const name of THEME_ORDER) {
    it(`${name}: palette ints + nine derived mixes byte-for-byte`, () => {
      const C = buildTheme(name);
      expect(C.name).toBe(name);
      expect(C.label).toBe(THEMES[name].label);
      for (const k of PALETTE_KEYS) expect(C[k]).toBe(rgb(THEMES[name][k]));
      for (const [k, v] of Object.entries(DERIVED[name]!)) expect(C[k as keyof Theme]).toBe(v);
      for (const [k, h] of Object.entries(DERIVED_HEX[name]!)) expect(hex(C[k as keyof Theme] as number)).toBe(h);
    });
  }

  it("has exactly the contract's keys (nothing missing, nothing extra)", () => {
    const keys = Object.keys(buildTheme("night")).sort();
    expect(keys).toEqual(["name", "label", ...PALETTE_KEYS, "hlBg", "addBg", "delBg", "selBg", "accentDim", "okDim", "mixDim", "frame", "frameDim"].sort());
  });

  it("an unknown or empty name falls back to night (prototype: THEMES[name] || THEMES.night)", () => {
    expect(buildTheme("nope").name).toBe("night");
    expect(buildTheme("").name).toBe("night");
    expect(buildTheme("nope")).toEqual(buildTheme("night"));
    expect(buildTheme("constructor").name).toBe("night"); // Object.hasOwn, not a prototype-chain hit
    expect(isThemeName("ember")).toBe(true);
    expect(isThemeName("toString")).toBe(false);
  });

  it("returns a fresh object per call", () => {
    const a = buildTheme("ember"), b = buildTheme("ember");
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});

describe("sextant theme: color math", () => {
  it("mix is the prototype's per-channel rounded blend", () => {
    expect(mix(0x0b0e12, 0x3ddbb9, 0.12)).toBe(0x112726);   // night hlBg
    expect(mix(0x000000, 0xffffff, 0.28)).toBe(0x474747);   // contrast frame
    expect(mix(0x102030, 0xa0b0c0, 0)).toBe(0x102030);
    expect(mix(0x102030, 0xa0b0c0, 1)).toBe(0xa0b0c0);
    expect(mix(0x000000, 0x010101, 0.5)).toBe(0x010101);    // Math.round(0.5) = 1 per channel
  });

  it("rgb/hex round-trip and pad", () => {
    expect(rgb("#0b0e12")).toBe(724498);
    expect(hex(724498)).toBe("#0b0e12");
    expect(hex(0)).toBe("#000000");
    expect(hex(0xffffff)).toBe("#ffffff");
  });

  it("st() builds a Style with bg -1 and no attributes by default", () => {
    expect(st(5)).toEqual({ fg: 5, bg: -1, a: 0 });
    expect(st(1, 2, 3)).toEqual({ fg: 1, bg: 2, a: 3 });
    expect(st(-1)).toEqual({ fg: -1, bg: -1, a: 0 });
    expect(st(1)).not.toBe(st(1));
  });
});
