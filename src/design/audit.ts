/** design_audit's engine: the checks that read generated markup and styles and count the things a
 *  prompt rule forgets by turn six.
 *
 *  Every check here came from a concrete complaint Berkay made about what AI-generated sites look
 *  like: amber accents, a full-viewport hero nobody needed, fonts with no relationship to the
 *  product, rules and hairlines everywhere, nothing but square corners, and every last element
 *  stacked down the middle of the page. Those are all countable, which is the whole point — the
 *  system prompt can ASK for restraint, but only a counter notices that the fourth section also
 *  centred everything.
 *
 *  Two kinds of finding:
 *    - SLOP: the pattern is a cliche whatever the project is (amber accent, Inter, purple gradient).
 *    - DEVIATION: the pattern contradicts the direction THIS project chose (design.json) — an
 *      off-palette colour, a font that is not the chosen one. Deviation only exists once a direction
 *      is recorded, and it is the half a machine judges best.
 *
 *  Direction-aware on purpose: "no rounded corners anywhere" is slop by default and CORRECT when the
 *  project chose sharp corners. A checker that cannot be told "this was deliberate" gets ignored,
 *  and an ignored checker is worse than none.
 *
 *  Deliberately textual — it greps source, it does not parse a DOM or run a browser. It therefore
 *  reports what is WRITTEN, misses what is computed at runtime, and can be fooled by indirection.
 *  It is a smoke alarm, not a fire marshal; every finding names its evidence so a human can overrule. */

import { readFileSync } from "node:fs";
import type { DesignDirection } from "./direction.ts";

export type Severity = "high" | "med" | "low";

export interface Finding {
  /** stable kebab-case id, so a project can silence one check by name */
  rule: string;
  severity: Severity;
  /** what is wrong, in one sentence */
  message: string;
  /** what was actually counted or matched — the reason a human can disagree */
  evidence: string;
  file?: string;
}

export interface AuditOptions {
  file?: string;
  direction?: DesignDirection | null;
  /** rule ids to skip (the project decided the check does not apply) */
  ignore?: readonly string[];
}

// ---------- colour ----------

/** #rgb / #rrggbb -> {h,s,l} in degrees/percent, or null when it is not a hex colour. */
export function hexToHsl(hex: string): { h: number; s: number; l: number } | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (m === null) return null;
  let h6 = m[1] as string;
  if (h6.length === 3) h6 = h6.split("").map((c) => c + c).join("");
  const r = parseInt(h6.slice(0, 2), 16) / 255;
  const g = parseInt(h6.slice(2, 4), 16) / 255;
  const b = parseInt(h6.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l: l * 100 };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === r) h = 60 * (((g - b) / d) % 6);
  else if (max === g) h = 60 * ((b - r) / d + 2);
  else h = 60 * ((r - g) / d + 4);
  if (h < 0) h += 360;
  return { h, s: s * 100, l: l * 100 };
}

/** The amber/orange/gold band AI-generated sites reach for by reflex. Saturated and mid-light: a
 *  dark brown or a pale cream in the same hue range is not the cliche and is not flagged. */
export function isAmberish(hex: string): boolean {
  const c = hexToHsl(hex);
  if (c === null) return false;
  return c.h >= 20 && c.h <= 55 && c.s >= 45 && c.l >= 35 && c.l <= 80;
}

/** A colour that is doing neutral duty — grey, ink, paper. Never counted as an accent.
 *
 *  Not just "unsaturated": the standard neutral ramps are deliberately tinted (tailwind's gray-900 is
 *  #111827, a blue-leaning near-black at 39% saturation). Treating those as accents would report the
 *  body text colour of every page as off-palette, which is the fastest way to get a check ignored. So
 *  a very dark or very light colour is neutral at a much looser chroma bar than a mid-tone one. */
export function isNeutral(hex: string): boolean {
  const c = hexToHsl(hex);
  if (c === null) return false;
  if (c.s < 12 || c.l < 8 || c.l > 95) return true;
  if (c.l < 20 && c.s < 45) return true;   // tinted ink
  return c.l > 92 && c.s < 30;             // tinted paper
}

const HEX_RE = /#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})\b/g;

// ---------- typefaces ----------

/** The fonts that show up when nobody chose a font. The system stacks are included because
 *  "whatever the OS has" is the same non-decision. */
export const CLICHE_FONTS: readonly string[] = [
  "Inter", "Roboto", "Arial", "Helvetica Neue", "Helvetica", "system-ui", "-apple-system",
  "Segoe UI", "Open Sans", "Lato", "Montserrat", "Poppins", "Nunito", "Source Sans Pro", "Raleway",
];

/** The system stacks. Naming one of these FIRST is the non-decision; naming it LAST is just a fallback
 *  — `"Geist", ui-sans-serif, system-ui, sans-serif` chose Geist, and the checker used to scold it for
 *  the tail (nimbus-f9's site pass, the first real false positive this checker produced). A named
 *  webfont (Inter, Poppins…) is different: writing it anywhere in a stack means loading it, so it
 *  counts wherever it appears. */
const SYSTEM_STACK_FONTS: ReadonlySet<string> = new Set(["system-ui", "-apple-system", "Segoe UI", "Arial", "Helvetica", "Helvetica Neue"]);

/** does a match at `index` lead its font list? The list starts at the nearest preceding `:` `[` `(` `=`
 *  or line break; a comma between that start and the match means another family came first. */
function leadsList(text: string, index: number): boolean {
  let i = index - 1;
  while (i >= 0) {
    const c = text[i]!;
    if (c === ":" || c === "[" || c === "(" || c === "=" || c === "\n") return true;
    if (c === ",") return false;
    i--;
  }
  return true;
}

function fontsPresent(text: string): string[] {
  const hits: string[] = [];
  for (const f of CLICHE_FONTS) {
    const esc = f.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
    // word-ish boundaries rather than a quote/space list: a font name arrives quoted in CSS, bare in a
    // tailwind config, and after `family=` in a Google Fonts URL. `_` only (not `-`), so `-apple-system`
    // still matches after a space or comma.
    const re = new RegExp("(?:^|[^A-Za-z0-9_])(" + esc + ")(?![A-Za-z0-9_])", "gi");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const at = m.index + m[0].length - m[1]!.length;
      if (!SYSTEM_STACK_FONTS.has(f) || leadsList(text, at)) { hits.push(f); break; }
    }
  }
  // "Helvetica Neue" also matches "Helvetica"; keep only the more specific one
  return hits.filter((f) => !(f === "Helvetica" && hits.includes("Helvetica Neue")));
}

// ---------- counting helpers ----------

const count = (text: string, re: RegExp): number => (text.match(re) ?? []).length;

/** Rough element count: opening HTML/JSX tags. The denominator for every density check. */
export function elementCount(text: string): number {
  return count(text, /<[a-zA-Z][\w.:-]*/g);
}

const RULE_LINE_RE = /\bborder(?:-[trbl])?(?:-\d+)?\b(?!-(?:none|0|transparent))|\bdivide-[xy]\b|<hr\b|border-(?:top|bottom|left|right)\s*:(?!\s*(?:none|0))/g;
const RADIUS_RE = /\brounded(?:-(?:sm|md|lg|xl|2xl|3xl|full|t|b|l|r|tl|tr|bl|br))?\b|border-radius\s*:\s*(?!0)/g;
const CENTER_RE = /\btext-center\b|\bitems-center\b|\bjustify-center\b|\bmx-auto\b|\bplace-items-center\b|text-align\s*:\s*center|margin\s*:\s*0\s+auto/g;
const VIEWPORT_RE = /\bmin-h-screen\b|\bh-screen\b|(?:min-)?height\s*:\s*100[dsl]?vh/;

// ---------- the checks ----------

/** Audit one source file's text. Pure: no disk, no network. */
export function auditSource(text: string, opts: AuditOptions = {}): Finding[] {
  const { direction = null, ignore = [], file } = opts;
  const out: Finding[] = [];
  const add = (rule: string, severity: Severity, message: string, evidence: string): void => {
    if (ignore.includes(rule)) return;
    out.push({ rule, severity, message, evidence, ...(file !== undefined ? { file } : {}) });
  };
  const els = elementCount(text);

  // 1. amber/orange accent — the single most requested thing to stop doing.
  // Direction-aware (nimbus-ed's probe 1): a project that CHOSE a warm brand and recorded it followed
  // the protocol exactly, and scolding it for its own palette is the checker being unable to hear
  // "this was deliberate" — the failure its own header calls fatal. So a palette holding an amberish
  // colour switches this check off; off-palette (check 8) still catches a warm colour that is NOT the
  // chosen one.
  const twAmber = text.match(/\b(?:amber|orange|yellow)-(?:[3-9]00)\b/g) ?? [];
  const hexes = text.match(HEX_RE) ?? [];
  const hexAmber = hexes.filter(isAmberish);
  const amberTotal = twAmber.length + hexAmber.length;
  const warmChosen = Object.values(direction?.palette ?? {}).some(isAmberish);
  // a budget of 2: a warning state or one highlight is legitimate; a THEME is not
  if (!warmChosen && amberTotal > 2) {
    const shown = [...new Set([...twAmber, ...hexAmber])].slice(0, 5).join(", ");
    add("cliche-accent-amber", amberTotal > 5 ? "high" : "med",
      "Amber/orange is doing accent duty. It is the default accent of AI-generated sites; pick an accent that belongs to this product.",
      `${amberTotal} occurrences (${shown})`);
  }

  // 2. fonts nobody chose
  const fonts = fontsPresent(text);
  if (fonts.length > 0) {
    // every face the direction names, whatever its role (display, text, label, mono…), is a choice
    const chosen = Object.values(direction?.typeface ?? {}).map((f) => f.toLowerCase());
    const offenders = fonts.filter((f) => !chosen.includes(f.toLowerCase()));
    if (offenders.length > 0) {
      add("cliche-font", "high",
        "A default typeface is in use. The typeface is half the personality of a page, and these are the ones that get picked when nobody picked.",
        offenders.join(", "));
    }
  }

  // 3. the reflex hero: a full-viewport first screen with a headline in it
  const vp = VIEWPORT_RE.exec(text);
  if (vp !== null && /<h1\b/i.test(text.slice(vp.index, vp.index + 1500))) {
    add("reflex-hero", "med",
      "A full-viewport hero. It spends a whole screen before any substance; keep the height only when an image or an idea earns it.",
      `${vp[0]} with an <h1> within 1500 characters`);
  }

  // 4. hairlines everywhere — boxes drawn with borders instead of spacing, weight or colour
  const lines = count(text, RULE_LINE_RE);
  if (els >= 10 && lines / els > 0.4) {
    add("rule-line-density", "med",
      "Almost everything is separated by a drawn line. Separation reads better from spacing, weight and background than from hairlines.",
      `${lines} border/divider declarations across ~${els} elements (${(lines / els).toFixed(2)} per element)`);
  }

  // 5. all square — slop by default, CORRECT when the project chose sharp corners
  if (els >= 10 && direction?.corners !== "sharp" && count(text, RADIUS_RE) === 0) {
    add("all-square", "low",
      "Not one rounded corner. Square everything is a legitimate choice; if it was chosen, record corners \"sharp\" in design.json so this stops being a finding.",
      `0 radius declarations across ~${els} elements`);
  }

  // 6. everything down the middle
  if (els >= 8 && direction?.layout !== "centered") {
    const centered = count(text, CENTER_RE);
    if (centered / els > 0.45) {
      add("everything-centered", "med",
        "Nearly every block is centred. Centring everything removes the alignment edge the eye follows and flattens the hierarchy.",
        `${centered} centring declarations across ~${els} elements (${(centered / els).toFixed(2)} per element)`);
    }
  }

  // 7. the purple-to-blue gradient
  const gradTw = /from-(?:purple|violet|indigo|fuchsia)-\d00[\s\S]{0,80}?to-(?:blue|pink|cyan|indigo|purple)-\d00/.test(text);
  const gradCss = (text.match(/linear-gradient\([^)]*\)/g) ?? []).some((g) =>
    (g.match(HEX_RE) ?? []).some((h) => {
      const c = hexToHsl(h);
      return c !== null && c.h >= 250 && c.h <= 290 && c.s >= 40;
    }));
  if (gradTw || gradCss) {
    add("cliche-gradient", "low",
      "A purple/violet gradient. It is the most recognisable AI-template signature there is.",
      gradTw ? "tailwind from-*/to-* gradient in the violet band" : "linear-gradient with a violet stop");
  }

  // 8. deviation from the recorded direction — only meaningful once one exists
  if (direction?.palette !== undefined) {
    const allowed = new Set(Object.values(direction.palette).map((v) => v.trim().toLowerCase()));
    const off = [...new Set(hexes.map((h) => h.toLowerCase()))].filter((h) => !allowed.has(h) && !isNeutral(h));
    if (off.length > 2) {
      add("off-palette", "med",
        "Colours outside the project's chosen palette. Holding one palette across screens is the part of a design system that actually has to hold.",
        `${off.length} off-palette colours: ${off.slice(0, 6).join(", ")}`);
    }
  }

  return out;
}

/** Audit files from disk. An unreadable file becomes a finding rather than an exception, so one bad
 *  path never costs the caller the other results. */
export function auditFiles(paths: readonly string[], opts: Omit<AuditOptions, "file"> = {}): Finding[] {
  const out: Finding[] = [];
  for (const p of paths) {
    let text: string;
    try { text = readFileSync(p, "utf8"); }
    catch (e) {
      out.push({ rule: "unreadable", severity: "low", message: "could not read the file", evidence: (e as Error).message, file: p });
      continue;
    }
    out.push(...auditSource(text, { ...opts, file: p }));
  }
  return out;
}

const ORDER: Record<Severity, number> = { high: 0, med: 1, low: 2 };

/** Findings as the model reads them: worst first, evidence attached, no finding without a reason. */
export function formatFindings(findings: readonly Finding[], direction: DesignDirection | null): string {
  if (findings.length === 0) {
    return direction === null
      ? "No design findings. Note: this project has recorded no design direction, so only the slop checks ran — once the human has chosen a direction, record it with design_direction and later screens get consistency checks too."
      : `No design findings; consistent with the recorded direction "${direction.name}".`;
  }
  const sorted = [...findings].sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
  const head = `${findings.length} design finding${findings.length === 1 ? "" : "s"}${direction === null ? " (no direction recorded — slop checks only, no consistency checks)" : ` against "${direction.name}"`}:`;
  const body = sorted.map((f) => `- [${f.severity}] ${f.rule}${f.file !== undefined ? ` (${f.file})` : ""}: ${f.message}\n  evidence: ${f.evidence}`);
  return [head, ...body].join("\n");
}
