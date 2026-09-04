/** design_audit's engine: the checks that read generated markup and styles and count the things a
 *  prompt rule forgets by turn six.
 *
 *  REWORKED against docs/design-audit-calibration.md, which measured the previous version over 1,502
 *  files in 20 repos and 43 live sites. The headline result: the old slop checks did not separate good
 *  design from template slop. `cliche-font` fired on 86% of GOOD repos, `cliche-accent-amber` inverted
 *  (80% of sober good sites vs 35% slop), `rule-line-density` was within noise of itself at every
 *  threshold and every element floor (2% good vs 3% slop), and `all-square` fired on 330 files in repos
 *  that all use rounded corners somewhere. Meanwhile the four template repos the checker called CLEAN
 *  were textbook slop. Every threshold below cites the number that set it.
 *
 *  Two structural changes carry most of the improvement:
 *
 *  1. SCOPE. Density and centring are properties of a PAGE, not of a component file. A bezel drawn with
 *     six borders is one figure on a page of 300 elements (0.02), not a 0.60 violation; the same
 *     vendored `components/ui/scroll-area.tsx` fired identically in three different repos. So those
 *     checks now sum a route file with the components it imports, and `all-square` is project-level:
 *     "no radius anywhere in the audited set", never per file.
 *
 *  2. KIND. Kent C. Dodds' yellow, Paco Coursey's Inter and Aristide Benoist's square corners are the
 *     SAME TOKENS as a template's yellow, Inter and squares. No count tells them apart; only the record
 *     does. So every check is either SLOP — meaning "no decision was made", which can only be asserted
 *     when .rovecode/design.json is absent — or DEVIATION, meaning "this contradicts what the human
 *     chose". A check that keeps firing after the human has decided is the failure this file's previous
 *     header called fatal, and it was committing it.
 *
 *  What the calibration found actually discriminates, now checked here: `(md|lg):grid-cols-3` (12/13
 *  slop repos, 0/7 good — the strongest single number in the study), font LOAD sites rather than font
 *  mentions (`next/font/google` 6/13 slop, 0/7 good), and `lucide-react` (6/13 slop, 0/7 good). All
 *  three detect the ABSENCE of a decision and go silent the moment one is recorded. None of them names
 *  a colour, a face or a layout, so none of them is a default in disguise.
 *
 *  Deliberately textual — it greps source, it does not parse a DOM or run a browser. It reports what is
 *  WRITTEN, misses what is computed at runtime, and can be fooled by indirection. Run it on a source
 *  tree; a fetched page measures the framework's build output, not the design (calibration §5: 7 of 43
 *  live sites arrived as SPA shells with under 60 elements). It is a smoke alarm, not a fire marshal;
 *  every finding names its evidence so a human can overrule. */

import { readFileSync } from "node:fs";
import type { DesignDirection } from "./direction.ts";

export type Severity = "high" | "med" | "low";

/** SLOP = "nobody decided this", assertable only with no direction recorded. DEVIATION = "this
 *  contradicts the recorded direction". The distinction is the whole rework: see the header. */
export type FindingKind = "slop" | "deviation";

export interface Finding {
  /** stable kebab-case id, so a project can silence one check by name */
  rule: string;
  kind: FindingKind;
  severity: Severity;
  /** what is wrong, in one sentence */
  message: string;
  /** what was actually counted or matched — the reason a human can disagree */
  evidence: string;
  /** the file, the page (for page-scoped checks), or absent for project-scoped ones */
  file?: string;
}

export interface AuditOptions {
  file?: string;
  direction?: DesignDirection | null;
  /** rule ids to skip (the project decided the check does not apply) */
  ignore?: readonly string[];
}

/** One source file for the project-scoped pass. */
export interface SourceFile {
  path: string;
  text: string;
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

const srgbToLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

/** #rgb / #rrggbb -> OKLCH {l 0-1, c, h degrees}, or null. Perceptual, so a "hue family" means what the
 *  eye means by it: calibration §6.3 asks for palette membership in OKLCH precisely because exact-hex
 *  membership calls the chosen brand's own ramp off-palette. */
export function hexToOklch(hex: string): { l: number; c: number; h: number } | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (m === null) return null;
  let h6 = m[1] as string;
  if (h6.length === 3) h6 = h6.split("").map((ch) => ch + ch).join("");
  const r = srgbToLinear(parseInt(h6.slice(0, 2), 16) / 255);
  const g = srgbToLinear(parseInt(h6.slice(2, 4), 16) / 255);
  const b = srgbToLinear(parseInt(h6.slice(4, 6), 16) / 255);
  const l_ = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m_ = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s_ = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_;
  const a = 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_;
  const bb = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_;
  const c = Math.sqrt(a * a + bb * bb);
  let h = (Math.atan2(bb, a) * 180) / Math.PI;
  if (h < 0) h += 360;
  return { l: L, c, h };
}

/** Below this OKLCH chroma a colour is doing neutral duty whatever its hue: greys, inks, papers and
 *  every tinted neutral ramp. Calibration §6.8: exact-saturation neutrality misfiled Tailwind's
 *  `gray-700 #374151` (HSL s 19) as a chromatic off-palette colour on every page that sets body text.
 *
 *  Measured before choosing the number. Tinted neutrals: zinc-800 0.006, gray-500 0.023, gray-700 0.031,
 *  gray-900 0.032, slate-800 0.037, slate-600 0.037. Real colours: muted plum 0.043, navy #0b1a2e 0.045,
 *  brown 0.074, teal 0.096, green-800 0.108. The two bands genuinely OVERLAP between 0.037 and 0.045, so
 *  this is a judgement inside a grey zone, not a discovered boundary: 0.042 keeps Tailwind's slate ramp
 *  neutral while leaving site/'s own navy ink chromatic. Being wrong is cheap either way — a misfiled
 *  neutral contributes no hue family, and a misfiled colour contributes one the budget of 1 absorbs. */
export const NEUTRAL_CHROMA = 0.042;

/** 30-degree bins. Twelve families across the wheel: wide enough that a brand's tints, shades and
 *  hover state land in one family, narrow enough that a second brand colour lands in another. */
export function hueFamily(hex: string): number | null {
  const c = hexToOklch(hex);
  if (c === null || c.c < NEUTRAL_CHROMA) return null;
  return Math.floor(c.h / 30) % 12;
}

const familyLabel = (f: number): string => `${f * 30}-${f * 30 + 30} deg`;

/** The amber/orange/gold band AI-generated sites reach for by reflex. Saturated and mid-light: a
 *  dark brown or a pale cream in the same hue range is not the cliche and is not flagged.
 *
 *  The 20 deg floor is a decision, not an accident (nimbus-96 raised it on #b4431d, 2026-09-04).
 *  Measured: rust and terracotta sit at h 12-19 (#b4431d h 15, #c2410c h 17, #9a3412 h 15) and the
 *  reflex amber ramp at h 21-38 (#ea580c 21, #b45309 26, #d97706 32, #f59e0b 38). A rust is a colour
 *  someone reaches for on purpose — it is nobody's default — so the floor stays at 20 and all three
 *  rusts go unflagged, verified above. The cost is honest and accepted: an amber at exactly h 19 also
 *  escapes. This rule only ever fires when NO direction is recorded, and one wrong slop finding on a
 *  deliberate palette costs more trust than one missed cliche costs quality. Widening the floor to
 *  catch h 15-19 would flag every terracotta brand there is. */
export function isAmberish(hex: string): boolean {
  const c = hexToHsl(hex);
  if (c === null) return false;
  return c.h >= 20 && c.h <= 55 && c.s >= 45 && c.l >= 35 && c.l <= 80;
}

const HEX_RE = /#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})\b/g;

/** HSL back to a hex string, so one colour pipeline serves every syntax a stylesheet writes. */
export function hslToHex(h: number, s: number, l: number): string {
  const sn = Math.min(100, Math.max(0, s)) / 100;
  const ln = Math.min(100, Math.max(0, l)) / 100;
  const c = (1 - Math.abs(2 * ln - 1)) * sn;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r1, g1, b1] = hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x]
    : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
  const m = ln - c / 2;
  const to = (v: number): string => Math.round((v + m) * 255).toString(16).padStart(2, "0");
  return `#${to(r1!)}${to(g1!)}${to(b1!)}`;
}

/** Every colour a stylesheet DECLARES, normalised to hex.
 *
 *  Hex alone is not enough. Measured on shadcn-ui/taxonomy (2026-09-04): a current Next.js + Tailwind
 *  project declares its entire palette as bare HSL triplets on custom properties — `--primary: 222.2
 *  47.4% 11.2%` — and contains ZERO hex literals, so every colour rule here saw an empty document and
 *  `off-palette` could not fire at all. That convention is most of the ecosystem rovecode's users build
 *  in, so reading only `#rrggbb` made the colour half of the audit blind exactly where it is needed.
 *
 *  Three forms are read: a hex literal, a custom property holding a bare `H S% L%` triplet (Tailwind's
 *  `hsl(var(--x))` convention), and a written `hsl()` / `hsla()` in either the comma or the space
 *  syntax. An alpha component is dropped — transparency is not a hue decision. Anything else (a
 *  `color-mix`, an `oklch()` literal, a value behind another variable) is still unread, and that is the
 *  documented limit rather than a silent one. */
export function declaredColours(text: string): string[] {
  const out = new Set<string>();
  for (const h of text.match(HEX_RE) ?? []) out.add(h.toLowerCase());
  // `--token: 222.2 47.4% 11.2%` — the percent signs are what tell a colour from any other triplet
  for (const m of text.matchAll(/--[\w-]+\s*:\s*(-?[\d.]+)\s+([\d.]+)%\s+([\d.]+)%/g)) {
    out.add(hslToHex(Number(m[1]), Number(m[2]), Number(m[3])));
  }
  // `hsl(222 47% 11%)`, `hsl(222, 47%, 11%)`, with or without an alpha
  for (const m of text.matchAll(/hsla?\(\s*(-?[\d.]+)(?:deg)?\s*[, ]\s*([\d.]+)%\s*[, ]\s*([\d.]+)%/gi)) {
    out.add(hslToHex(Number(m[1]), Number(m[2]), Number(m[3])));
  }
  return [...out];
}

/** A colour that is doing neutral duty — grey, ink, paper. Never counted as an accent.
 *
 *  The mid-tone bar is s < 20, widened from s < 12 on calibration §3.8: at 12, every Tailwind body-text
 *  colour between l 20 and l 92 (gray-700 #374151 is l 27 s 19) read as a chromatic off-palette colour.
 *  Very dark and very light colours keep the looser chroma bar they always had, because the standard
 *  neutral ramps are deliberately tinted (gray-900 #111827 is a blue-leaning near-black at s 39). */
export function isNeutral(hex: string): boolean {
  const c = hexToHsl(hex);
  if (c === null) return false;
  if (c.s < 20 || c.l < 8 || c.l > 95) return true;
  if (c.l < 20 && c.s < 45) return true;   // tinted ink
  return c.l > 92 && c.s < 30;             // tinted paper
}


// ---------- typefaces ----------

/** Named webfonts that arrive when nobody chose a face. System stacks are NOT here: calibration §3.1
 *  found 100% of the good-site false positives involved one of `system-ui, -apple-system, Segoe UI,
 *  Arial, Helvetica, Helvetica Neue`, because every reset (Tailwind preflight, normalize) puts one in a
 *  fallback position or on a form control. They survive only as DEVIATION evidence, where a direction
 *  names a face and a file overrides it. */
export const CLICHE_FONTS: readonly string[] = [
  "Inter", "Roboto", "Open Sans", "Lato", "Montserrat", "Poppins", "Nunito", "Source Sans Pro", "Raleway",
];

/** The stacks that are fallbacks, not decisions. Deviation-only (see CLICHE_FONTS). */
export const SYSTEM_STACK_FONTS: readonly string[] = [
  "system-ui", "-apple-system", "Segoe UI", "Arial", "Helvetica Neue", "Helvetica",
];

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");

/** Where a face is LOADED, not merely mentioned. Calibration §3.1: kentcdodds fired because a blog post
 *  mentions Inter in prose, shud.in because the OG-image renderer loads it for a social card, 11ty
 *  because of a fallback in `code.css`. A mention, a fallback position and a stack behind a webfont are
 *  all "not a decision"; an import or an @font-face is one. */
export function fontLoadSites(text: string): string[] {
  const hits = new Set<string>();
  for (const f of CLICHE_FONTS) {
    const name = esc(f);
    const spaced = name.replace(/\\?\s/g, "[\\s_+-]");
    // 1. next/font/google: `import { Inter } from "next/font/google"` — 6/13 slop repos, 0/7 good
    if (new RegExp("\\{[^}]*\\b" + name.replace(/\s/g, "_") + "\\b[^}]*\\}\\s*from\\s*[\"']next/font/google", "i").test(text)) hits.add(f);
    // 2. @fontsource/inter, @fontsource-variable/inter
    if (new RegExp("@fontsource(?:-variable)?/" + spaced.toLowerCase().replace(/\\s/g, "-"), "i").test(text)) hits.add(f);
    // 3. a Google Fonts URL that asks for the family
    if (new RegExp("family=" + spaced, "i").test(text)) hits.add(f);
    // 4. @font-face { ... font-family: "X" ... } — the file itself defines the face
    for (const block of text.match(/@font-face\s*\{[^}]*\}/gi) ?? []) {
      if (new RegExp("font-family\\s*:\\s*[\"']?" + spaced, "i").test(block)) hits.add(f);
    }
  }
  return [...hits];
}

/** CSS generic families and the keywords a font-family can legally lead with. None of these is a face,
 *  so none of them can be "named but not loaded". */
const GENERIC_FAMILIES: readonly string[] = [
  "sans-serif", "serif", "monospace", "cursive", "fantasy", "system-ui", "ui-sans-serif", "ui-serif",
  "ui-monospace", "ui-rounded", "math", "emoji", "fangsong", "inherit", "initial", "unset", "revert",
  "revert-layer", "none", "currentcolor",
];

/** Every face this text actually LOADS, by name — the general form of fontLoadSites, which answers the
 *  same question for the cliché list only. Four load sites: a next/font/google import, an @fontsource
 *  package, a Google-Fonts `family=` URL, and an @font-face block that defines the face here. */
export function loadedFaceNames(text: string): string[] {
  const hits = new Set<string>();
  const put = (raw: string): void => {
    const name = raw.trim().replace(/^["']|["']$/g, "").replace(/[_+-]+/g, " ").trim();
    if (name.length > 0) hits.add(name.toLowerCase());
  };
  for (const m of text.matchAll(/\{([^}]*)\}\s*from\s*["']next\/font\/google/gi)) {
    for (const ident of (m[1] ?? "").split(",")) put(ident.split(" as ")[0] ?? "");
  }
  for (const m of text.matchAll(/@fontsource(?:-variable)?\/([a-z0-9-]+)/gi)) put(m[1] ?? "");
  for (const m of text.matchAll(/family=([^&"'`\s:;)]+)/gi)) put(m[1] ?? "");
  for (const block of text.match(/@font-face\s*\{[^}]*\}/gi) ?? []) {
    const m = /font-family\s*:\s*([^;}\n]+)/i.exec(block);
    if (m) put((m[1] ?? "").split(",")[0] ?? "");
  }
  // next/font/local and a bare `src: url(...)` outside @font-face cannot name their face reliably;
  // that is this rule's known blind spot, recorded in docs/design.md rather than guessed at here.
  return [...hits];
}

/** Tailwind's `font-[…]` is overloaded: `font-[Sohne]` is a family but `font-[450]`, `font-[bold]`
 *  and `font-[italic]` are a WEIGHT or a style — Tailwind picks by data type. Measured on site/ during
 *  the 2026-09-04 review, where `font-[450]` on an accordion trigger was reported as an unloaded face
 *  called "450". A number, a weight keyword or a style keyword is never a family, in the shorthand or
 *  in a declaration. */
const NOT_A_FACE = /^(?:[\d.]+%?|bolder|lighter|bold|normal|medium|light|thin|black|heavy|semibold|extrabold|ultrabold|extralight|ultralight|book|regular|italic|oblique)$/i;

/** Faces this text NAMES: the leading family of each font-family declaration, plus Tailwind's
 *  `font-[Family_Name]` arbitrary value. Generic keywords and var()/theme() indirection are dropped —
 *  a family behind a custom property is not a name this rule can check. */
export function namedFaces(text: string): string[] {
  const out: string[] = [];
  const push = (raw: string): void => {
    const name = raw.trim().replace(/^["']|["']$/g, "").replace(/_/g, " ").trim();
    if (name.length === 0) return;
    if (/^(?:var|theme|calc)\s*\(/i.test(name) || name.startsWith("--") || name.includes("$")) return;
    if (GENERIC_FAMILIES.includes(name.toLowerCase())) return;
    if (NOT_A_FACE.test(name)) return;
    out.push(name);
  };
  for (const m of text.matchAll(/font-family\s*:\s*([^;}\n]+)/gi)) push((m[1] ?? "").split(",")[0] ?? "");
  for (const m of text.matchAll(/\bfont-\[([^\]]+)\]/g)) push((m[1] ?? "").split(",")[0] ?? "");
  return out;
}

/** The leading family of every `font-family:` declaration, plus Tailwind `font-\[...\]` arbitrary
 *  values. Used for the DEVIATION check only: with a face recorded, a file that sets a different
 *  leading family on its own text is contradicting the record. */
export function leadingFamilies(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/font-family\s*:\s*([^;}\n]+)/gi)) {
    const first = (m[1] ?? "").split(",")[0]?.trim().replace(/^["']|["']$/g, "");
    if (first !== undefined && first.length > 0) out.push(first);
  }
  return out;
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
/** The three-up feature grid, only at a breakpoint — a plain `grid-cols-3` is a layout primitive, the
 *  responsive form is the template idiom. 12/13 slop repos, 0/7 good (calibration §2). */
const TEMPLATE_GRID_RE = /\b(?:md|lg):grid-cols-3\b/;
const DECOR_RE = /\b(?:linear|radial|conic)-gradient\b|\bbg-gradient-to\b|background-image\s*:|\bbg-\[url\(|\btransition-(?:all|colors|transform|opacity)\b|\banimate-[a-z]|@keyframes\b|\banimation\s*:|\bbefore:|\bafter:|::(?:before|after)|\bbackdrop-blur\b|\bdrop-shadow\b/g;

// ---------- file kinds ----------

const norm = (p: string): string => p.replace(/\\/g, "/").toLowerCase();

/** Route files: a page is what a reader loads. Next app/pages routers, Astro/Nuxt/SvelteKit pages,
 *  plain HTML. These are the units density and centring are scored over (calibration §3.4, §3.6). */
export function isRouteFile(path: string): boolean {
  const p = norm(path);
  return /(?:^|\/)app\/.*\/page\.[jt]sx?$/.test(p)
    || /(?:^|\/)app\/page\.[jt]sx?$/.test(p)
    || /(?:^|\/)pages\/(?!api\/)/.test(p)
    || /(?:^|\/)routes\/.*\+page\.svelte$/.test(p)
    || /\.html?$/.test(p);
}

/** Sections are the page's own blocks — the other place the template grid shows up. */
export function isPageOrSection(path: string): boolean {
  const p = norm(path);
  return isRouteFile(path) || /(?:^|\/)(?:sections?|blocks?)\//.test(p) || /(?:hero|features?|pricing|testimonial|cta|footer|header)[^/]*\.(?:[jt]sx|astro|vue|svelte)$/.test(p);
}

/** Vendored primitives. Calibration §3.4.2: 4 of 12 slop density hits were `components/ui/**` and none
 *  of them was a design decision — the identical shadcn `scroll-area.tsx` fired in three repos. */
export function isUiPrimitive(path: string): boolean {
  return /(?:^|\/)components\/ui\//.test(norm(path));
}

/** Page types where centring and a full-height wrapper are CORRECT. Calibration §3.6.1: exempting these
 *  removes 17 of 24 centring fires, 14 of them in the slop corpus, i.e. it costs recall the rule never
 *  had. §3.7: 9 of 10 `reflex-hero` fires were the sticky-footer wrapper on exactly these files. */
export function isCentringExempt(path: string): boolean {
  // ANY segment, not just the last: the exempt name is `login` in `app/login/page.tsx`, where the final
  // segment is the router's own `page`. Matching only the tail missed every Next app-router auth route.
  const segments = norm(path).replace(/\.[a-z]+$/, "").split("/");
  return segments.some((s) => /(?:^|-|_)(?:login|register|signin|signup|auth|404|not-found|error|loading|empty|placeholder|tooltip|dialog|modal|toast|announcement|layout)(?:$|-|_)/.test(s));
}

/** Prose and generated-image files: a face named here is not the site's face. Calibration §3.1.3 —
 *  3 of 9 good-repo font hits were exactly an .mdx post and an opengraph-image renderer. */
export function isProseOrGenerated(path: string): boolean {
  const p = norm(path);
  return /\.mdx?$/.test(p) || /opengraph-image|twitter-image|(?:^|\/)og\/route\./.test(p);
}

// ---------- accent positions ----------

/** Strip the places a colour is not an accent: SVG payloads (Stripe's Google logo), data URIs, and
 *  syntax-highlight scopes. Calibration §3.2.3, §3.3. */
function stripNonAccent(text: string): string {
  return text
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/data:image\/[^"')\s]+/gi, " ")
    .replace(/(?:\.hljs|\.shiki|\.token|pre|code)\s*[^{]*\{[^}]*\}/gi, " ");
}

const WARNING_CTX = /warn|warning|caution|alert|danger|error|status|badge|pending|highlight|mark|star|rating/i;

/** Amber in a position that MEANS accent: a brand/accent token, a button or link background, a heading
 *  colour, a hero gradient stop. Calibration §3.2: the old absolute count over a whole document made the
 *  rule measure stylesheet size, inverting it to 80% of sober good sites vs 35% of slop. */
export function amberAccentPositions(text: string): string[] {
  const src = stripNonAccent(text);
  const hits: string[] = [];
  const near = (i: number): string => src.slice(Math.max(0, i - 90), i + 90);
  // ROLE tokens only: `--accent`, `--brand`, `--color-primary`. A token named after the colour itself
  // (`--color-team-yellow`) is a palette entry, not an accent assignment — kentcdodds.com declares
  // exactly that for a brand yellow he has kept for years (calibration §3.2), and reading it as "the
  // accent" is the checker guessing at intent it cannot see.
  for (const m of src.matchAll(/--(?:color-)?(?:primary|accent|brand)\b\s*:\s*([^;}\n]+)/gi)) {
    const val = m[1] ?? "";
    const hex = declaredColours(val).find(isAmberish);
    if (hex !== undefined && !WARNING_CTX.test(m[0])) hits.push(`${m[0].split(":")[0]?.trim()}: ${hex}`);
  }
  // Tailwind utilities in accent positions. The 300-700 band is the same window isAmberish applies to a
  // hex (l 35-80): amber-800/900 are dark browns, and counting a class the hex path would reject made
  // the two halves of this rule disagree — sindresorhus's `bg-amber-900` warning box was the case.
  for (const m of src.matchAll(/\b(?:bg|text|from|border)-(?:amber|orange|yellow)-(?:[3-7]00)\b/gi)) {
    const ctx = near(m.index);
    if (WARNING_CTX.test(ctx)) continue;
    if (/\b(?:button|btn|<a\b|link|cta|hero|h1|h2)\b/i.test(ctx) || /^(?:bg|from)-/i.test(m[0])) hits.push(m[0]);
  }
  return [...new Set(hits)];
}

/** How many distinct saturated hue families the document declares. Calibration §3.2.2: a document that
 *  ships a whole palette (Vercel, tailwindcss.com's colour page, Sentry, fly.io) has amber as one swatch
 *  among many, not as the accent. */
export function saturatedFamilies(text: string): number {
  const fams = new Set<number>();
  for (const h of declaredColours(stripNonAccent(text))) {
    const f = hueFamily(h);
    if (f !== null) fams.add(f);
  }
  return fams.size;
}

// ---------- file-scope checks ----------

/** Audit one source file's text. Pure: no disk, no network.
 *
 *  FILE SCOPE ONLY. Density, centring and all-square are page- and project-scoped after the calibration
 *  (see the header) and live in auditProject; calling this on one file will not produce them. */
export function auditSource(text: string, opts: AuditOptions = {}): Finding[] {
  const { direction = null, ignore = [], file } = opts;
  const out: Finding[] = [];
  const path = file ?? "";
  const add = (rule: string, kind: FindingKind, severity: Severity, message: string, evidence: string): void => {
    if (ignore.includes(rule)) return;
    out.push({ rule, kind, severity, message, evidence, ...(file !== undefined ? { file } : {}) });
  };
  const decided = direction !== null;

  // ---- f1 fonts: a face that was LOADED without being chosen ----
  if (!isProseOrGenerated(path)) {
    const loaded = fontLoadSites(text);
    const chosen = Object.values(direction?.typeface ?? {}).map((f) => f.toLowerCase());
    const unchosen = loaded.filter((f) => !chosen.includes(f.toLowerCase()));
    if (unchosen.length > 0) {
      if (!decided) {
        // med, not high: 6 of 7 good repos would otherwise open with a high (calibration §3.1.4)
        add("cliche-font", "slop", "med",
          "A default webfont is loaded and nothing records that anyone chose it. The typeface is half the personality of a page; pick one for a reason you can state, then record it.",
          `loaded at a font import or @font-face: ${unchosen.join(", ")}`);
      } else if (direction?.typeface !== undefined) {
        add("font-deviation", "deviation", "med",
          "A typeface is loaded that is not the one this project recorded.",
          `loaded: ${unchosen.join(", ")}; recorded: ${Object.values(direction.typeface).join(", ")}`);
      }
    }
    // system stacks are deviation-only: they are fallbacks everywhere, and a decision nowhere
    if (direction?.typeface !== undefined) {
      const sys = leadingFamilies(text).filter((f) => SYSTEM_STACK_FONTS.some((s) => s.toLowerCase() === f.toLowerCase()));
      if (sys.length > 0 && !chosen.some((c) => sys.some((s) => s.toLowerCase() === c))) {
        add("font-deviation", "deviation", "low",
          "A font-family declaration leads with a system stack while this project records a chosen face.",
          `${[...new Set(sys)].join(", ")} leads a font-family here; recorded: ${Object.values(direction.typeface).join(", ")}`);
      }
    }
  }

  // ---- f2 amber in accent positions ----
  const warmChosen = Object.values(direction?.palette ?? {}).some(isAmberish);
  if (!warmChosen) {
    const positions = amberAccentPositions(text);
    // a full palette makes amber one swatch among many, not the accent (calibration §3.2.2)
    if (positions.length > 0 && saturatedFamilies(text) < 5) {
      const shown = positions.slice(0, 5).join(", ");
      if (!decided) {
        add("cliche-accent-amber", "slop", "med",
          "Amber/orange is doing accent duty and nothing records that it was chosen. It is the reflex accent of generated interfaces; pick one that belongs to this product.",
          `${positions.length} accent position${positions.length === 1 ? "" : "s"} (${shown})`);
      } else {
        add("accent-deviation", "deviation", "med",
          "Amber/orange is used as an accent and it is not in this project's recorded palette.",
          `${positions.length} accent position${positions.length === 1 ? "" : "s"} (${shown})`);
      }
    }
  }

  // ---- f3 the template grid: three equal cards ----
  // 12/13 slop repos, 0/7 good — the strongest single signal in the calibration (§2). Silent the moment
  // a layout is recorded, because then the grid is a choice and off-layout work is a deviation question.
  if (direction?.layout === undefined && isPageOrSection(path) && TEMPLATE_GRID_RE.test(text)) {
    add("template-grid", "slop", "low",
      "Three equal cards at a breakpoint is the feature grid every template ships. Is this the layout the content wants, or the one the starter had?",
      "md|lg:grid-cols-3 in a page/section file");
  }

  // ---- f4 the icon-per-card template marker ----
  // 6/13 slop repos, 0/7 good (calibration §2). A marker, not a fault: lowest severity, and silent once
  // anything is recorded, because a project that decided its look may legitimately use an icon set.
  if (!decided && /from\s*["']lucide-react["']/.test(text)) {
    add("template-icons", "slop", "low",
      "lucide-react is imported and nothing records a design direction. It is the icon set of the shadcn landing-page template; it is fine as a choice and a tell as a default.",
      "import from \"lucide-react\" with no design.json");
  }

  // ---- f5 the reflex hero ----
  // KEPT rather than deleted (calibration §3.7 offered either), but only in its specific form: 9 of its
  // 10 fires were a sticky-footer wrapper on a login/404 page, and all three added conditions —
  // centring in the same element's class list, an h1 in the window, a page/section file that is not an
  // exempt name — are exactly what separated those from the one true hero.
  if (isPageOrSection(path) && !isCentringExempt(path)) {
    const vp = VIEWPORT_RE.exec(text);
    if (vp !== null) {
      // a fresh non-global copy: CENTER_RE carries /g, and .test() on a /g regex advances lastIndex, so
      // sharing it here made the answer depend on whatever the previous call happened to match
      const attr = text.slice(Math.max(0, vp.index - 200), vp.index + 200);
      const centredHere = new RegExp(CENTER_RE.source, "i").test(attr);
      if (centredHere && /<h1\b/i.test(text.slice(vp.index, vp.index + 1500))) {
        add("reflex-hero", direction?.heroPattern === undefined ? "slop" : "deviation", "low",
          "A full-viewport centred first screen with a headline in it. A hero costs the reader a whole screen; keep the height only when an image or an idea earns it.",
          `${vp[0]} centred in the same element, with an <h1> within 1500 characters`);
      }
    }
  }

  // ---- f6 the purple-to-blue gradient ----
  // The SIGNATURE is the pair, not a violet stop somewhere: the old hex form fired on 53% of sober good
  // sites (syntax themes, a dark-mode glow, a progress bar) vs 12% of slop (calibration §3.3).
  const clean = stripNonAccent(text);
  const gradTw = /from-(?:purple|violet|indigo|fuchsia)-\d00[\s\S]{0,80}?to-(?:blue|pink|cyan|indigo|purple)-\d00/.test(clean);
  const gradCss = (clean.match(/linear-gradient\([^)]*\)/g) ?? []).some((g) => {
    const stops = declaredColours(g).map(hexToHsl).filter((c): c is { h: number; s: number; l: number } => c !== null && c.s >= 40);
    return stops.some((a) => a.h >= 250 && a.h <= 290) && stops.some((b) => b.h >= 180 && b.h <= 330) && stops.length >= 2;
  });
  if (gradTw || gradCss) {
    add("cliche-gradient", decided ? "deviation" : "slop", "low",
      "A violet-to-blue gradient pair. It is the most recognisable generated-template signature there is.",
      gradTw ? "tailwind from-violet/to-blue pair" : "linear-gradient with a violet stop and a second saturated stop");
  }

  // ---- f7 off-palette, in OKLCH hue families ----
  // Exact-hex membership called the chosen brand's own ramp off-palette (nimbus-ed's probe 1: six of the
  // six "off-palette" colours WERE the recorded brand's tints). Families let a tint, a shade and a hover
  // state belong to the colour they came from. Budget of 1: semantic states (a red, a green) are not a
  // second brand (design-slop-research §6.2).
  if (direction?.palette !== undefined) {
    const chosen = new Set<number>();
    for (const v of Object.values(direction.palette)) {
      // the human may have recorded "hsl(210 40% 96%)" as readily as a hex
      for (const c of declaredColours(v)) { const f = hueFamily(c); if (f !== null) chosen.add(f); }
    }
    const seen = new Map<number, string[]>();
    for (const h of declaredColours(stripNonAccent(text))) {
      const f = hueFamily(h);
      if (f === null || chosen.has(f)) continue;
      seen.set(f, [...(seen.get(f) ?? []), h]);
    }
    if (seen.size > 1) {
      const shown = [...seen.entries()].map(([f, hs]) => `${familyLabel(f)} (${hs.slice(0, 3).join(", ")})`).join("; ");
      add("off-palette", "deviation", "med",
        "Colours from hue families outside the recorded palette. One extra family is a semantic state; more than one is a second palette.",
        `${seen.size} extra hue families: ${shown}`);
    }
  }

  // ---- f9 decoration density against a record that asked for restraint ----
  // The one rule here with NO corpus number behind it: it comes from eight rounds of rejections, not
  // from the calibration sweep. It is therefore gated twice — it needs a recorded direction AND that
  // record must ask for restraint in its own words — so it cannot fire on a project that did not ask.
  if (direction !== null && wantsRestraint(direction)) {
    const els = elementCount(text);
    const decor = count(text, DECOR_RE);
    if (els >= 10 && decor / els > 0.6) {
      add("decoration-density", "deviation", "low",
        "More decoration than the recorded direction asks for: gradients, background images, ornament and motion, counted against the elements that carry them.",
        `${decor} decorative declarations across ~${els} elements (${(decor / els).toFixed(2)} per element); the record asks for restraint`);
    }
  }

  return out;
}

/** Does the recorded direction ask for restraint, in its own words? Read from `notes` and `rationale`
 *  because those are where a human says it; English and Turkish, since this project is written in both. */
export function wantsRestraint(d: DesignDirection): boolean {
  const said = `${d.notes ?? ""} ${d.rationale ?? ""}`.toLowerCase();
  return /restrain|minimal|sober|quiet|austere|understated|plain|calm|spare|no decoration|sade|yal[ıi]n|sakin|az\b|g[öo]sterissiz/.test(said);
}

// ---------- page and project scope ----------

/** The layout files a route is WRAPPED in, which it never imports.
 *
 *  Next.js and the routers that copy it nest `layout.tsx` implicitly: `app/(docs)/guides/page.tsx` renders
 *  inside `app/(docs)/guides/layout.tsx`, then `app/(docs)/layout.tsx`, then `app/layout.tsx`, and imports
 *  none of them. Measured on shadcn-ui/taxonomy (2026-09-04): the chain carries 8-24 elements per route and
 *  on four of its fourteen routes it is LARGER than the page file — the settings page is 4 elements of its
 *  own inside 17 of layout. That is where a site's nav, footer and section rules live, so scoring "the page"
 *  without it measured the smaller and quieter half and called it the page.
 *
 *  Astro, SvelteKit and the rest import their layouts explicitly, so `importsOf` already has them; this only
 *  adds what the convention hides. Only files actually passed to the audit are used — nothing is read from
 *  disk here. */
function layoutChain(page: SourceFile, byPath: ReadonlyMap<string, SourceFile>): SourceFile[] {
  const out: SourceFile[] = [];
  let dir = norm(page.path).replace(/\/[^/]*$/, "");
  for (;;) {
    for (const ext of ["tsx", "jsx", "ts", "js"]) {
      const f = byPath.get(dir === "" ? `layout.${ext}` : `${dir}/layout.${ext}`);
      if (f !== undefined && f.path !== page.path) { out.push(f); break; }
    }
    if (dir === "") break;
    dir = dir.includes("/") ? dir.replace(/\/[^/]*$/, "") : "";
  }
  return out;
}

/** Which audited files a page pulls in. Relative specifiers are resolved against the importer; alias
 *  forms (`@/x`, `~/x`, `src/x`) are matched by path suffix. One level deep, which is what the
 *  calibration's page-scoping recommendation needs (§3.4.1) and keeps this from walking a whole graph. */
function importsOf(file: SourceFile, byPath: ReadonlyMap<string, SourceFile>): SourceFile[] {
  const dir = norm(file.path).replace(/\/[^/]*$/, "");
  const out: SourceFile[] = [];
  for (const m of file.text.matchAll(/\bfrom\s*["']([^"']+)["']|\bimport\s*["']([^"']+)["']/g)) {
    const spec = (m[1] ?? m[2] ?? "").trim();
    if (spec === "" || /^[a-z@][^/]*$/i.test(spec)) continue; // bare package
    let base = spec.replace(/^[@~]\//, "").replace(/^\.\//, dir === "" ? "" : dir + "/");
    if (spec.startsWith("../")) {
      const up = spec.match(/^(?:\.\.\/)+/)?.[0] ?? "";
      const levels = up.split("../").length - 1;
      base = dir.split("/").slice(0, Math.max(0, dir.split("/").length - levels)).concat(spec.slice(up.length)).join("/");
    }
    const want = norm(base).replace(/\.[a-z]+$/, "");
    for (const [p, f] of byPath) {
      const stem = p.replace(/\.[a-z]+$/, "").replace(/\/index$/, "");
      if (stem === want || stem.endsWith("/" + want) || p.replace(/\.[a-z]+$/, "").endsWith("/" + want)) { out.push(f); break; }
    }
  }
  return out;
}

/** Audit a whole set of files: file-scope checks per file, density and centring per PAGE, all-square
 *  once for the project. This is what design_audit runs; auditSource alone cannot produce the scoped
 *  findings, by design (see the header). */
export function auditProject(files: readonly SourceFile[], opts: Omit<AuditOptions, "file"> = {}): Finding[] {
  const { direction = null, ignore = [] } = opts;
  const out: Finding[] = [];
  const add = (rule: string, kind: FindingKind, severity: Severity, message: string, evidence: string, file?: string): void => {
    if (ignore.includes(rule)) return;
    out.push({ rule, kind, severity, message, evidence, ...(file !== undefined ? { file } : {}) });
  };

  for (const f of files) out.push(...auditSource(f.text, { ...opts, file: f.path }));

  const byPath = new Map(files.map((f) => [norm(f.path), f]));
  // A single PATHLESS input (design_audit's `source` mode passes the synthetic name "source") is one
  // page, so pasted markup still gets the page-scoped checks. A lone file WITH a directory in its path
  // is a component and is not promoted to a page: that promotion is exactly the per-file scoring the
  // calibration removed (§3.4 — a bezel scored 0.60 alone and 0.02 inside the page it belongs to).
  const pages = files.filter((f) => isRouteFile(f.path));
  const asPages = pages.length > 0 ? pages
    : files.length === 1 && !norm(files[0]!.path).includes("/") ? files
    : [];

  for (const page of asPages) {
    if (isCentringExempt(page.path)) continue;
    const chain = layoutChain(page, byPath);
    const parts = [page, ...chain, ...importsOf(page, byPath), ...chain.flatMap((l) => importsOf(l, byPath))]
      .filter((f, i, a) => a.findIndex((x) => x.path === f.path) === i && !isUiPrimitive(f.path));
    const text = parts.map((f) => f.text).join("\n");
    const els = elementCount(text);
    if (els < 10) continue;
    const others = parts.length - 1;
    const scope = others > 0
      ? `${page.path} + ${others} file${others === 1 ? "" : "s"} it renders inside or imports${chain.length > 0 ? ` (incl. ${chain.length} layout${chain.length === 1 ? "" : "s"})` : ""}`
      : page.path;

    // Threshold stays 0.4. The calibration swept it per FILE and found good and slop within noise at
    // every value (2% vs 3%, §3.4) — the fix was scope, not the number, and at page scope a framed
    // component is diluted by the page around it instead of scored on its own.
    const lines = count(text, RULE_LINE_RE);
    if (lines / els > 0.4) {
      add("rule-line-density", direction === null ? "slop" : "deviation", "med",
        "Across this page almost everything is separated by a drawn line. Separation reads better from spacing, weight and background than from hairlines.",
        `${lines} border/divider declarations across ~${els} elements (${(lines / els).toFixed(2)} per element) over ${scope}`, page.path);
    }

    // 0.45 as before, now over a page and with the exempt names removed: on the corpus those two changes
    // took the rule from 24 fires (17 of them correct centring) to the 4 marketing pages that are the
    // actual complaint (calibration §3.6).
    if (direction?.layout === undefined) {
      const centred = count(text, CENTER_RE);
      if (centred / els > 0.45) {
        add("everything-centered", "slop", "med",
          "Nearly every block on this page is centred. Centring everything removes the alignment edge the eye follows down the page and flattens the hierarchy.",
          `${centred} centring declarations across ~${els} elements (${(centred / els).toFixed(2)} per element) over ${scope}`, page.path);
      }
    }
  }

  // Project scope, and deterministic: a face named in a font-family that nothing in the audited set
  // LOADS renders as its fallback. That is not a taste call — the page does not look the way the code
  // says it does, and if the name is the recorded face the record is describing a page that is not
  // there. Project-scoped because the load site is usually a layout or a global stylesheet, not the
  // file that names the face; pass those in or this rule cannot see them (docs/design.md).
  {
    const loaded = new Set(files.flatMap((f) => loadedFaceNames(f.text)));
    const chosen = Object.values(direction?.typeface ?? {}).map((f) => f.toLowerCase());
    const seen = new Set<string>();
    for (const f of files) {
      if (isProseOrGenerated(f.path)) continue;
      for (const face of namedFaces(f.text)) {
        const key = face.toLowerCase();
        if (seen.has(key)) continue;
        if (loaded.has(key)) continue;
        // a system stack is a fallback by definition — it needs no load site and never fires here
        if (SYSTEM_STACK_FONTS.some((sys) => sys.toLowerCase() === key)) continue;
        seen.add(key);
        const isChosen = chosen.includes(key);
        add("font-named-not-loaded", isChosen ? "deviation" : "slop", "low",
          isChosen
            ? `"${face}" is the face this project recorded, but nothing in the audited set loads it — the page renders its fallback, so the recorded direction is not what a reader sees.`
            : `"${face}" is named in a font-family but nothing in the audited set loads it (no @font-face, next/font import, @fontsource package or Google-Fonts URL). It renders as the fallback, which is nobody's decision. Load it, or drop the name.`,
          `named in ${f.path}; no load site across ${files.length} audited file${files.length === 1 ? "" : "s"}`, f.path);
      }
    }
  }

  // Project scope. Per file this fired on 330 files across repos that ALL use rounded corners somewhere
  // (calibration §3.5) — a component with no radius is not a design statement, a whole project with none
  // is. Recording corners "sharp" silences it, which is the point.
  if (direction?.corners !== "sharp" && files.length > 0) {
    const totalEls = files.reduce((n, f) => n + elementCount(f.text), 0);
    const anyRadius = files.some((f) => count(f.text, RADIUS_RE) > 0);
    if (totalEls >= 40 && !anyRadius) {
      add("all-square", "slop", "low",
        "Not one rounded corner anywhere in the audited set. Square everything is a legitimate choice; if it was chosen, record corners \"sharp\" so this stops being a finding.",
        `0 radius declarations across ${files.length} files (~${totalEls} elements)`);
    }
  }

  return out;
}

/** Audit files from disk. An unreadable file becomes a finding rather than an exception, so one bad
 *  path never costs the caller the other results. */
export function auditFiles(paths: readonly string[], opts: Omit<AuditOptions, "file"> = {}): Finding[] {
  const out: Finding[] = [];
  const files: SourceFile[] = [];
  for (const p of paths) {
    try { files.push({ path: p, text: readFileSync(p, "utf8") }); }
    catch (e) {
      out.push({ rule: "unreadable", kind: "slop", severity: "low", message: "could not read the file", evidence: (e as Error).message, file: p });
    }
  }
  out.push(...auditProject(files, opts));
  return out;
}

const ORDER: Record<Severity, number> = { high: 0, med: 1, low: 2 };

/** A provisional direction is checked exactly like a chosen one — but "consistent with the direction"
 *  must not read as "the human approved this". The suffix says which of the two it is, every time. */
function provisionalNote(d: DesignDirection): string {
  return d.provisional === true ? " (provisional direction — recorded by the agent, not yet confirmed by a human)" : "";
}

/** Findings as the model reads them: worst first, evidence attached, no finding without a reason. */
export function formatFindings(findings: readonly Finding[], direction: DesignDirection | null): string {
  if (findings.length === 0) {
    return direction === null
      ? "No design findings. Note: this project has recorded no design direction, so only the \"nobody decided\" checks ran — once the human has chosen a direction, record it with design_direction and later screens get consistency checks too."
      : `No design findings; consistent with the recorded direction "${direction.name}"${provisionalNote(direction)}.`;
  }
  const sorted = [...findings].sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
  const head = `${findings.length} design finding${findings.length === 1 ? "" : "s"}${direction === null ? " (no direction recorded — \"nobody decided\" checks only, no consistency checks)" : ` against "${direction.name}"${provisionalNote(direction)}`}:`;
  const body = sorted.map((f) => `- [${f.severity}] ${f.rule}${f.kind === "deviation" ? " (deviation)" : ""}${f.file !== undefined ? ` (${f.file})` : ""}: ${f.message}\n  evidence: ${f.evidence}`);
  return [head, ...body].join("\n");
}
