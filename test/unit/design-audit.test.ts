/** design/audit.ts — the counters behind design_audit. Each check exists because Berkay named the
 *  pattern ("amber rengi kullanimi", "heronun cok gereksiz kullanimi", "yazi fontlari cok alakasiz",
 *  "cizgiler cok kullanilior", "cok fazla kosuli tasarim", "bilgilerin hepsi ortaya dizilmis"), so
 *  these pin BOTH halves: the cliche is caught, and the deliberate version of the same thing is not.
 *  A checker that cannot be told "this was on purpose" gets switched off, and then it protects nothing. */

import { test, expect } from "bun:test";
import {
  auditSource, elementCount, formatFindings, hexToHsl, isAmberish, isNeutral,
} from "../../src/design/audit.ts";
import type { DesignDirection } from "../../src/design/direction.ts";

const rules = (text: string, direction: DesignDirection | null = null): string[] =>
  auditSource(text, { direction }).map((f) => f.rule);

/** ~20 elements, no findings of its own — the neutral carrier for the density checks. */
const carrier = (extra = ""): string =>
  `<main>${"<section><p>copy</p></section>".repeat(10)}${extra}</main>`;

test("hexToHsl handles 3- and 6-digit hex and reports achromatic grey as s=0", () => {
  expect(hexToHsl("#fff")).toEqual({ h: 0, s: 0, l: 100 });
  expect(hexToHsl("#808080")?.s).toBe(0);
  const red = hexToHsl("#ff0000");
  expect(red?.h).toBe(0);
  expect(Math.round(red?.s ?? 0)).toBe(100);
  expect(hexToHsl("not-a-colour")).toBeNull();
});

test("isAmberish catches the reflex amber but not brown, cream or a neighbouring hue", () => {
  expect(isAmberish("#f59e0b")).toBe(true);  // tailwind amber-500
  expect(isAmberish("#d97706")).toBe(true);  // amber-600
  expect(isAmberish("#451a03")).toBe(false); // dark brown: same hue, too dark
  expect(isAmberish("#fffbeb")).toBe(false); // cream: same hue, too light
  expect(isAmberish("#0ea5e9")).toBe(false); // sky
});

test("isNeutral treats greys and near-black/white as never-an-accent", () => {
  expect([isNeutral("#111827"), isNeutral("#ffffff"), isNeutral("#6b7280")]).toEqual([true, true, true]);
  expect(isNeutral("#c2410c")).toBe(false);
});

test("elementCount counts opening tags, including namespaced and component tags", () => {
  expect(elementCount('<div><Hero.Title/><svg:rect/><p>x</p>')).toBe(4);
});

// ---------- 1. amber ----------

test("amber gets a budget: one warning colour passes, an amber theme does not", () => {
  expect(rules('<p class="text-amber-500">warning</p>')).not.toContain("cliche-accent-amber");
  const themed = '<a class="bg-amber-500 border-amber-600 text-amber-700 ring-amber-400">go</a>';
  expect(rules(themed)).toContain("cliche-accent-amber");
});

test("amber is caught as raw hex too, and severity rises with how much of it there is", () => {
  const few = auditSource("a #f59e0b b #d97706 c #fbbf24 d");
  expect(few.find((f) => f.rule === "cliche-accent-amber")?.severity).toBe("med");
  const many = auditSource("#f59e0b #d97706 #fbbf24 #b45309 #f59e0b #d97706".repeat(1));
  expect(many.find((f) => f.rule === "cliche-accent-amber")?.severity).toBe("high");
});

test("a project that CHOSE a warm brand and recorded it is not scolded for its own palette", () => {
  // nimbus-ed's probe 1: brand #D4A017 (h 43.5, s 80, l 46) sits inside the amber band on purpose
  const d: DesignDirection = { name: "harvest", palette: { paper: "#faf7f0", brand: "#d4a017" } };
  const themed = "#d4a017 #d4a017 #b8860b #e0b030 #c9971a";
  expect(rules(themed, d)).not.toContain("cliche-accent-amber");
  // the same code with no direction, or with a cool direction, is still the reflex accent
  expect(rules(themed)).toContain("cliche-accent-amber");
  expect(rules(themed, { name: "ink", palette: { ink: "#0b1a2e" } })).toContain("cliche-accent-amber");
});

test("an amber finding carries the evidence that justifies it", () => {
  const f = auditSource('<a class="bg-amber-500 border-amber-600 text-amber-700">x</a>')
    .find((x) => x.rule === "cliche-accent-amber");
  expect(f?.evidence).toContain("3 occurrences");
  expect(f?.evidence).toContain("amber-500");
});

// ---------- 2. fonts ----------

test("the default typefaces are caught wherever they are written", () => {
  expect(rules('font-family: "Inter", sans-serif;')).toContain("cliche-font");
  expect(rules("<link href='https://fonts.googleapis.com/css2?family=Poppins'>")).toContain("cliche-font");
  expect(rules('fontFamily: { sans: ["Roboto"] }')).toContain("cliche-font");
});

test("a font is not a finding when the project CHOSE it", () => {
  const d: DesignDirection = { name: "editorial", typeface: { display: "Inter", text: "Inter" } };
  expect(rules('font-family: "Inter";', d)).not.toContain("cliche-font");
  // ...but a second, unchosen default still is
  expect(rules('font-family: "Inter"; --alt: "Poppins";', d)).toContain("cliche-font");
});

test("a system stack as a trailing FALLBACK is not a finding; leading the list it is", () => {
  // the first real false positive the checker produced (nimbus-f9's site pass): Geist chosen, scolded for the tail
  expect(rules('font-family: "Geist Variable", "Geist", ui-sans-serif, system-ui, sans-serif;')).not.toContain("cliche-font");
  expect(rules('sans: ["Geist", "Segoe UI", "Arial", sans-serif]')).not.toContain("cliche-font");
  // the same names LEADING the list are the non-decision
  expect(rules("font-family: system-ui, sans-serif;")).toContain("cliche-font");
  expect(rules('sans: ["Segoe UI", "Geist"]')).toContain("cliche-font");
  // a second declaration on its own line starts a new list
  expect(rules('font-family: "Geist";\nfont-family: Arial;')).toContain("cliche-font");
});

test("a named webfont counts wherever it sits in the stack — naming it means loading it", () => {
  expect(rules('font-family: "Geist", "Inter", sans-serif;')).toContain("cliche-font");
  expect(rules('sans: ["Redaction", "Poppins"]')).toContain("cliche-font");
});

test("a face named under ANY typeface role is exempt — label and mono are roles too", () => {
  // nimbus-f9's chart direction: condensed map labels and mono are first-class, not afterthoughts
  const d: DesignDirection = { name: "chart", typeface: { display: "IBM Plex Sans", label: "Roboto", mono: "Inter" } };
  expect(rules('font-family: "Roboto"; --mono: "Inter";', d)).not.toContain("cliche-font");
});

test("a typeface nobody on the list uses is left alone", () => {
  expect(rules('font-family: "Geist", "Redaction";')).not.toContain("cliche-font");
});

test("Helvetica Neue is reported once, not twice as Helvetica as well", () => {
  const f = auditSource('font-family: "Helvetica Neue";').find((x) => x.rule === "cliche-font");
  expect(f?.evidence).toBe("Helvetica Neue");
});

// ---------- 3. hero ----------

test("a full-viewport block with a headline is the reflex hero; the same block without one is not", () => {
  expect(rules('<section class="min-h-screen"><h1>Ship faster</h1></section>')).toContain("reflex-hero");
  expect(rules('<section class="min-h-screen"><video src="x.mp4"/></section>')).not.toContain("reflex-hero");
  expect(rules('<section style="min-height: 100dvh"><h1>x</h1></section>')).toContain("reflex-hero");
});

test("a headline far below a viewport-height block is not called a hero", () => {
  expect(rules(`<div class="h-screen"></div>${"<p>filler</p>".repeat(200)}<h1>later</h1>`)).not.toContain("reflex-hero");
});

// ---------- 4. hairlines ----------

test("hairline density is a ratio, so a big page is not punished for a few borders", () => {
  expect(rules(carrier('<div class="border">x</div>'))).not.toContain("rule-line-density");
  const bordered = `<main>${'<section class="border-t border-b"><p>c</p></section>'.repeat(10)}</main>`;
  expect(rules(bordered)).toContain("rule-line-density");
});

test("border-none and border-0 are not lines and do not count toward the density", () => {
  const off = `<main>${'<section class="border-none"><p>c</p></section>'.repeat(10)}</main>`;
  expect(rules(off)).not.toContain("rule-line-density");
});

// ---------- 5. corners ----------

test("no radius anywhere is a finding by default and silent when sharp corners were chosen", () => {
  expect(rules(carrier())).toContain("all-square");
  expect(rules(carrier(), { name: "brutalist", corners: "sharp" })).not.toContain("all-square");
  expect(rules(carrier('<div class="rounded-lg">x</div>'))).not.toContain("all-square");
});

test("a page too small to judge is not judged on corners or centring", () => {
  expect(rules("<div><p>hi</p></div>")).toEqual([]);
});

// ---------- 6. centring ----------

test("centring everything is a finding, unless centred was the chosen composition", () => {
  const centred = `<main>${'<section class="text-center mx-auto items-center"><p>c</p></section>'.repeat(8)}</main>`;
  expect(rules(centred)).toContain("everything-centered");
  expect(rules(centred, { name: "poster", layout: "centered" })).not.toContain("everything-centered");
});

// ---------- 7. gradient ----------

test("the violet gradient is caught in tailwind and in raw CSS", () => {
  expect(rules('<div class="bg-gradient-to-r from-purple-500 to-blue-500">x</div>')).toContain("cliche-gradient");
  expect(rules("background: linear-gradient(90deg, #8b5cf6, #3b82f6);")).toContain("cliche-gradient");
  expect(rules("background: linear-gradient(90deg, #0b1a2e, #123);")).not.toContain("cliche-gradient");
});

// ---------- 8. deviation ----------

test("off-palette colours are only reported once a palette exists, and neutrals never count", () => {
  const d: DesignDirection = { name: "ink", palette: { ink: "#0b1a2e", accent: "#c2410c" } };
  const onPalette = "a #0b1a2e b #c2410c c #ffffff d #111827 e #6b7280";
  expect(rules(onPalette, d)).not.toContain("off-palette");
  expect(rules("a #16a34a b #0ea5e9 c #db2777 d #7c3aed", d)).toContain("off-palette");
  // no palette recorded -> no consistency check at all
  expect(rules("a #16a34a b #0ea5e9 c #db2777 d #7c3aed")).not.toContain("off-palette");
});

test("palette matching ignores case, so #C2410C is the recorded #c2410c", () => {
  const d: DesignDirection = { name: "ink", palette: { accent: "#c2410c" } };
  expect(rules("#C2410C #C2410C #C2410C #C2410C", d)).not.toContain("off-palette");
});

// ---------- plumbing ----------

test("ignore silences one rule by id and leaves the others reporting", () => {
  const text = carrier();
  expect(auditSource(text, { ignore: ["all-square"] }).map((f) => f.rule)).not.toContain("all-square");
  expect(auditSource(text, {}).map((f) => f.rule)).toContain("all-square");
});

test("a clean file says so, and says whether consistency was even checked", () => {
  expect(formatFindings([], null)).toContain("no design direction");
  expect(formatFindings([], { name: "ink" })).toContain('consistent with the recorded direction "ink"');
});

test("findings are ordered worst-first and every line carries its evidence", () => {
  const out = formatFindings([
    { rule: "all-square", severity: "low", message: "m1", evidence: "e1" },
    { rule: "cliche-font", severity: "high", message: "m2", evidence: "e2" },
    { rule: "reflex-hero", severity: "med", message: "m3", evidence: "e3" },
  ], null);
  const order = ["cliche-font", "reflex-hero", "all-square"].map((r) => out.indexOf(r));
  expect(order).toEqual([...order].sort((a, b) => a - b));
  expect(out).toContain("evidence: e2");
  expect(out).toContain("slop checks only");
});
