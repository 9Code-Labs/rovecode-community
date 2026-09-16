/** design/audit.ts — the counters behind design_audit, REWORKED against docs/design-audit-calibration.md.
 *
 *  The old suite pinned the old contract: every check per file, every finding "slop". The calibration
 *  measured that contract over 1,502 files and found it did not separate good design from template slop,
 *  so these tests pin the two structural changes instead:
 *
 *    SCOPE  — density and centring are page properties, all-square is a project property. A component
 *             file is no longer scored as if it were a page.
 *    KIND   — a check is SLOP ("nobody decided") only when no direction is recorded; once one is, the
 *             same evidence is a DEVIATION or it is silent. Kent's yellow and a template's yellow are
 *             the same token; only the record tells them apart.
 *
 *  Each regression test names the calibration number it protects. */

import { test, expect } from "bun:test";
import {
  auditFiles, auditProject, auditSource, elementCount, formatFindings,
  hexToHsl, hexToOklch, hueFamily, isAmberish, isCentringExempt, isNeutral, isRouteFile, isUiPrimitive,
  type SourceFile,
} from "../../src/design/audit.ts";
import type { DesignDirection } from "../../src/design/direction.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const rules = (text: string, direction: DesignDirection | null = null, file = "app/page.tsx"): string[] =>
  auditSource(text, { direction, file }).map((f) => f.rule);

const projectRules = (files: SourceFile[], direction: DesignDirection | null = null): string[] =>
  auditProject(files, { direction }).map((f) => f.rule);

/** ~20 elements of neutral carrier markup. */
const carrier = (extra = ""): string =>
  `<main>${"<section><p>copy</p></section>".repeat(10)}${extra}</main>`;

// ---------- colour ----------

test("hexToHsl handles 3- and 6-digit hex and reports achromatic grey as s=0", () => {
  expect(hexToHsl("#fff")).toEqual({ h: 0, s: 0, l: 100 });
  expect(hexToHsl("#808080")?.s).toBe(0);
  expect(hexToHsl("not-a-colour")).toBeNull();
});

test("isAmberish catches the reflex amber but not brown, cream or a neighbouring hue", () => {
  expect(isAmberish("#f59e0b")).toBe(true);  // tailwind amber-500
  expect(isAmberish("#d4a017")).toBe(true);  // the AVOID "warm" accent: h 43.5 s 80 l 46
  expect(isAmberish("#451a03")).toBe(false); // dark brown: same hue, too dark
  expect(isAmberish("#fffbeb")).toBe(false); // cream: same hue, too light
  expect(isAmberish("#0ea5e9")).toBe(false); // sky
});

test("isNeutral's mid-tone bar is s<20, so Tailwind body-text greys stop reading as accents", () => {
  // calibration §3.8: at s<12, gray-700 #374151 (l 27, s 19) counted as a chromatic off-palette colour
  // on every page that sets body text
  expect(isNeutral("#374151")).toBe(true);
  expect([isNeutral("#111827"), isNeutral("#ffffff"), isNeutral("#6b7280")]).toEqual([true, true, true]);
  expect(isNeutral("#c2410c")).toBe(false);
});

test("hexToOklch and hueFamily: a brand's tints and shades share one family, a different hue does not", () => {
  expect(hexToOklch("#zzz")).toBeNull();
  const brand = hueFamily("#0f8b8d");
  expect(brand).not.toBeNull();
  // the ramp avoid_tokens derives from that brand
  for (const tint of ["#259193", "#017577", "#005c5d", "#86c8c9"]) expect(hueFamily(tint)).toBe(brand!);
  expect(hueFamily("#c2410c")).not.toBe(brand!);
  // a near-neutral has no family at all
  expect(hueFamily("#374151")).toBeNull();
});

test("elementCount counts opening tags, including namespaced and component tags", () => {
  expect(elementCount('<div><Hero.Title/><svg:rect/><p>x</p>')).toBe(4);
});

// ---------- file kinds ----------

test("route, ui-primitive and centring-exempt paths are recognised", () => {
  expect([isRouteFile("app/page.tsx"), isRouteFile("app/pricing/page.tsx"), isRouteFile("src/pages/index.astro"), isRouteFile("index.html")]).toEqual([true, true, true, true]);
  expect(isRouteFile("components/Hero.tsx")).toBe(false);
  expect(isUiPrimitive("components/ui/scroll-area.tsx")).toBe(true);
  // calibration §3.6.1 / §3.7: these page types are correctly centred and correctly full-height
  for (const p of ["app/login/page.tsx", "app/not-found.tsx", "components/empty-placeholder.tsx", "components/ui-tooltip.tsx", "app/layout.tsx"]) {
    expect(isCentringExempt(p)).toBe(true);
  }
  expect(isCentringExempt("app/pricing/page.tsx")).toBe(false);
});

// ---------- fonts: load sites, not mentions ----------

test("a face is a finding where it is LOADED, not where it is mentioned", () => {
  // calibration §3.1: kentcdodds fired because a post mentions Inter, 11ty on a fallback in code.css
  expect(rules('import { Inter } from "next/font/google";')).toContain("cliche-font");
  expect(rules('import "@fontsource/inter";')).toContain("cliche-font");
  expect(rules("<link href='https://fonts.googleapis.com/css2?family=Poppins'>")).toContain("cliche-font");
  expect(rules('@font-face { font-family: "Roboto"; src: url(x.woff2) }')).toContain("cliche-font");
  // a mention, a fallback position, a tailwind stack: not a decision
  expect(rules("This post explains why we moved to Inter.")).not.toContain("cliche-font");
  expect(rules('font-family: "Geist", "Inter", sans-serif;')).not.toContain("cliche-font");
  expect(rules('fontFamily: { sans: ["Roboto"] }')).not.toContain("cliche-font");
});

test("system stacks are never slop — they are a fallback in every reset", () => {
  // calibration §3.1: 100% of the good-site false positives involved one of these
  expect(rules("font-family: system-ui, sans-serif;")).not.toContain("cliche-font");
  expect(rules('sans: ["Segoe UI", "Geist"]')).not.toContain("cliche-font");
  expect(rules("button, input { font-family: system-ui }")).not.toContain("cliche-font");
});

test("prose and generated-image files are excluded from the font rule", () => {
  // calibration §3.1.3: 3 of 9 good-repo hits were exactly an .mdx post and an OG-image renderer
  expect(rules('import { Inter } from "next/font/google";', null, "content/blog/post.mdx")).not.toContain("cliche-font");
  expect(rules('import { Inter } from "next/font/google";', null, "app/opengraph-image.tsx")).not.toContain("cliche-font");
});

test("the font rule is med, not high, when nothing is recorded, and turns into a deviation once it is", () => {
  // calibration §3.1.4: at high, 6 of 7 good repos would open with a high severity
  const loaded = 'import { Inter } from "next/font/google";';
  expect(auditSource(loaded, { file: "app/page.tsx" }).find((f) => f.rule === "cliche-font")?.severity).toBe("med");
  const chose: DesignDirection = { name: "editorial", typeface: { display: "Fraunces", text: "Fraunces" } };
  const dev = auditSource(loaded, { direction: chose, file: "app/page.tsx" }).find((f) => f.rule === "font-deviation");
  expect(dev?.kind).toBe("deviation");
  expect(dev?.evidence).toContain("Fraunces");
  // a chosen Inter is legitimate and silent (calibration §3.1: paco.me and leerob use it as a decision)
  const choseInter: DesignDirection = { name: "plain", typeface: { text: "Inter" } };
  expect(rules(loaded, choseInter)).toEqual([]);
});

// ---------- amber: accent positions ----------

test("amber counts where it is an ACCENT, not wherever it appears", () => {
  // calibration §3.2: the absolute count made the rule measure stylesheet size and inverted it
  expect(rules('<a class="bg-amber-500">go</a>')).toContain("cliche-accent-amber");
  expect(rules("--accent: #f59e0b;")).toContain("cliche-accent-amber");
  // a warning/status use is not an accent: this is Linear's #F2C94C and MDN's notecard
  expect(rules('<p class="text-amber-500">warning: disk full</p>')).not.toContain("cliche-accent-amber");
  expect(rules("--color-warning: #f59e0b;")).not.toContain("cliche-accent-amber");
  // an SVG payload is not an accent: this is Stripe's Google logo
  expect(rules('<svg><path fill="#fbbc04"/><path fill="#f59e0b"/></svg>')).not.toContain("cliche-accent-amber");
});

test("a document that ships a whole palette is not an amber theme", () => {
  // calibration §3.2.2: Vercel, tailwindcss.com's colour page, Sentry and fly.io all fired for this
  const palette = "--a:#f59e0b; --b:#0ea5e9; --c:#16a34a; --d:#db2777; --e:#7c3aed; --f:#dc2626;";
  expect(rules(palette)).not.toContain("cliche-accent-amber");
});

test("a chosen warm brand is silent; an unchosen one is a deviation; with no record it is slop", () => {
  // nimbus-ed's probe 1: brand #D4A017 sits inside the amber band on purpose
  const warm: DesignDirection = { name: "harvest", palette: { paper: "#faf7f0", brand: "#d4a017" } };
  const themed = '<a class="bg-amber-500">go</a> --brand: #d4a017;';
  expect(rules(themed, warm)).not.toContain("cliche-accent-amber");
  expect(rules(themed).includes("cliche-accent-amber")).toBe(true);
  const cool: DesignDirection = { name: "ink", palette: { ink: "#0b1a2e" } };
  const dev = auditSource(themed, { direction: cool, file: "app/page.tsx" }).find((f) => f.rule === "accent-deviation");
  expect(dev?.kind).toBe("deviation");
});

// ---------- the signals that actually discriminated ----------

test("the three-up feature grid is a finding in a page or section file, and silent once a layout is recorded", () => {
  // calibration §2: 12/13 slop repos, 0/7 good — the strongest single number in the study
  expect(rules('<div class="grid md:grid-cols-3 gap-6"></div>')).toContain("template-grid");
  expect(rules('<div class="grid md:grid-cols-3"></div>', null, "components/sections/Features.tsx")).toContain("template-grid");
  // a plain grid-cols-3 is a layout primitive, not the template idiom
  expect(rules('<div class="grid grid-cols-3"></div>')).not.toContain("template-grid");
  // a component that is not a page or a section is not where the complaint lives
  expect(rules('<div class="md:grid-cols-3"></div>', null, "components/Table.tsx")).not.toContain("template-grid");
  // recorded layout: the grid is now a choice
  expect(rules('<div class="md:grid-cols-3"></div>', { name: "grid", layout: "grid" })).not.toContain("template-grid");
});

test("lucide-react is a template marker that goes quiet the moment anything is recorded", () => {
  // calibration §2: 6/13 slop, 0/7 good
  expect(rules('import { Check } from "lucide-react";')).toContain("template-icons");
  expect(rules('import { Check } from "lucide-react";', { name: "anything" })).not.toContain("template-icons");
});

// ---------- hero ----------

test("the hero rule needs viewport AND centring on the same element AND a headline AND a page file", () => {
  // calibration §3.7: 9 of 10 fires were a sticky-footer wrapper around a login form
  expect(rules('<section class="min-h-screen flex items-center justify-center"><h1>Ship faster</h1></section>')).toContain("reflex-hero");
  // a full-height wrapper that is not centred is a layout, not a hero
  expect(rules('<div class="min-h-screen"><h1>Docs</h1></div>')).not.toContain("reflex-hero");
  // centred and full-height on a login page is correct
  expect(rules('<div class="min-h-screen flex items-center"><h1>Sign in</h1></div>', null, "app/login/page.tsx")).not.toContain("reflex-hero");
  // a component that is not a page or section is out of scope
  expect(rules('<div class="min-h-screen items-center"><h1>x</h1></div>', null, "components/Shell.tsx")).not.toContain("reflex-hero");
  // no headline in the window
  expect(rules(`<div class="h-screen items-center"></div>${"<p>filler</p>".repeat(200)}<h1>later</h1>`)).not.toContain("reflex-hero");
});

// ---------- gradient ----------

test("the violet gradient needs the PAIR, not one violet stop in a big stylesheet", () => {
  // calibration §3.3: the any-stop form fired on 53% of sober good sites vs 12% of slop
  expect(rules('<div class="bg-gradient-to-r from-purple-500 to-blue-500">x</div>')).toContain("cliche-gradient");
  expect(rules("background: linear-gradient(90deg, #8b5cf6, #3b82f6);")).toContain("cliche-gradient");
  // one violet stop with a neutral: a dark-mode glow, a progress bar
  expect(rules("background: linear-gradient(90deg, #8b5cf6, #111827);")).not.toContain("cliche-gradient");
  // inside a syntax-highlight scope it is a theme, not a hero
  expect(rules(".hljs { background: linear-gradient(90deg, #8b5cf6, #3b82f6); }")).not.toContain("cliche-gradient");
});

// ---------- off-palette in OKLCH families ----------

test("a tint or shade of the recorded brand is IN palette; a second real hue family is not", () => {
  // nimbus-ed's probe 1: exact-hex membership called six steps of the chosen brand's own ramp off-palette
  const d: DesignDirection = { name: "teal", palette: { brand: "#0f8b8d", ink: "#060d0d", paper: "#f3fcfc" } };
  const ownRamp = "#0f8b8d #259193 #017577 #005c5d #86c8c9 #a9e0e1";
  expect(rules(ownRamp, d)).not.toContain("off-palette");
  // one extra family is a semantic state and is allowed
  expect(rules(`${ownRamp} #dc2626 #b91c1c`, d)).not.toContain("off-palette");
  // two extra families is a second palette
  const off = auditSource(`${ownRamp} #dc2626 #7c3aed`, { direction: d, file: "app/page.tsx" }).find((f) => f.rule === "off-palette");
  expect(off?.kind).toBe("deviation");
  expect(off?.evidence).toContain("extra hue families");
  // no palette recorded means no consistency check at all
  expect(rules("#dc2626 #7c3aed #16a34a")).not.toContain("off-palette");
});

// ---------- decoration density (f9) ----------

test("decoration density fires only when the record itself asks for restraint", () => {
  const busy = `<main>${'<div class="bg-gradient-to-r animate-pulse transition-all before:content backdrop-blur"><p>x</p></div>'.repeat(10)}</main>`;
  expect(rules(busy)).not.toContain("decoration-density");
  expect(rules(busy, { name: "loud" })).not.toContain("decoration-density");
  const restrained: DesignDirection = { name: "quiet", notes: "restrained, no decoration, motion only on entrance" };
  expect(rules(busy, restrained)).toContain("decoration-density");
  // and a calm file under the same record is silent
  expect(rules(carrier(), restrained)).not.toContain("decoration-density");
});

// ---------- scope: density and centring are page properties ----------

test("a bordered component is not scored on its own; the page it sits in is", () => {
  // calibration §3.4: the same vendored shadcn scroll-area.tsx fired identically in three repos
  const bezel: SourceFile = { path: "components/Device.tsx", text: `<div>${'<div class="border-t border-b"><span>x</span></div>'.repeat(5)}</div>` };
  expect(projectRules([bezel])).not.toContain("rule-line-density");
  // the same borders inside a real page of substance are diluted, as they should be
  const page: SourceFile = { path: "app/page.tsx", text: `import Device from "../components/Device";\n<main>${"<section><p>copy</p></section>".repeat(60)}</main>` };
  expect(projectRules([page, bezel])).not.toContain("rule-line-density");
  // a page that really is all hairlines still reports
  const hairlines: SourceFile = { path: "app/page.tsx", text: `<main>${'<section class="border-t border-b"><p>c</p></section>'.repeat(10)}</main>` };
  expect(projectRules([hairlines])).toContain("rule-line-density");
});

test("components/ui/** never contributes to the page's density or centring", () => {
  // calibration §3.4.2: 4 of 12 slop density hits were vendored primitives and none was a decision
  const page: SourceFile = { path: "app/page.tsx", text: `import { ScrollArea } from "../components/ui/scroll-area";\n<main>${"<section><p>c</p></section>".repeat(10)}</main>` };
  const prim: SourceFile = { path: "components/ui/scroll-area.tsx", text: `<div>${'<div class="border-t border-b border-l"><i>x</i></div>'.repeat(8)}</div>` };
  expect(projectRules([page, prim])).not.toContain("rule-line-density");
});

test("centring is scored per page, skips the page types that are correctly centred, and honours a recorded layout", () => {
  // calibration §3.6: name exemptions remove 17 of 24 fires, 14 of them slop
  const centred = (p: string): SourceFile => ({ path: p, text: `<main>${'<section class="text-center mx-auto items-center"><p>c</p></section>'.repeat(8)}</main>` });
  expect(projectRules([centred("app/page.tsx")])).toContain("everything-centered");
  expect(projectRules([centred("app/login/page.tsx")])).not.toContain("everything-centered");
  expect(projectRules([centred("app/not-found.tsx")])).not.toContain("everything-centered");
  expect(projectRules([centred("app/page.tsx")], { name: "poster", layout: "centered" })).not.toContain("everything-centered");
});

test("all-square is a project finding, never a per-file one", () => {
  // calibration §3.5: per file this fired on 330 files in repos that ALL use rounded corners somewhere
  const plain: SourceFile[] = [
    { path: "components/MetaTags.astro", text: carrier() },
    { path: "components/Pagination.astro", text: carrier() },
  ];
  expect(projectRules(plain)).toContain("all-square");
  // one rounded corner ANYWHERE in the set answers the question for the project
  expect(projectRules([...plain, { path: "components/Card.tsx", text: '<div class="rounded-lg">x</div>' }])).not.toContain("all-square");
  expect(projectRules(plain, { name: "brutalist", corners: "sharp" })).not.toContain("all-square");
  // and a single small file is not a project
  expect(projectRules([{ path: "components/Tiny.tsx", text: "<div><p>hi</p></div>" }])).not.toContain("all-square");
});

// ---------- the regressions the rework exists for ----------

test("REGRESSION: the canonical template page no longer scores zero", () => {
  // nimbus-ed's probe 5: this exact shape returned "No design findings" before the rework
  const slop: SourceFile = {
    path: "app/page.tsx",
    text: `import { Check } from "lucide-react";
      <section class="px-6 py-16">
        <h2 class="text-3xl">Everything you need to ship faster</h2>
        <div class="grid md:grid-cols-3 gap-6">
          <div class="rounded-lg p-6"><h3>Seamless integration</h3><p>Unlock the power of your data.</p></div>
          <div class="rounded-lg p-6"><h3>Effortless scaling</h3><p>Take it to the next level.</p></div>
          <div class="rounded-lg p-6"><h3>Enterprise ready</h3><p>Supercharge your team.</p></div>
        </div>
      </section>`,
  };
  const found = projectRules([slop]);
  expect(found).toContain("template-grid");
  expect(found).toContain("template-icons");
});

test("REGRESSION: work that follows the protocol exactly reports nothing", () => {
  // the human proposed, chose, recorded — and every check that used to scold them is silent
  const d: DesignDirection = {
    name: "Warm & specific", palette: { brand: "#d4a017", bg: "#fdfaf3", text: "#0d0b06" },
    typeface: { display: "Figtree", text: "Figtree" }, corners: "soft", layout: "left",
  };
  const tokens: SourceFile = {
    path: "app/globals.css",
    text: `:root{--color-brand:#d4a017;--color-brand-hover:#b8860b;--brand-300:#e5be55;--brand-400:#dcac2e;--brand-700:#926c00;--color-bg:#fdfaf3;--color-text:#0d0b06}
      .btn{background:var(--color-brand);border-radius:8px}`,
  };
  const page: SourceFile = { path: "app/page.tsx", text: `<main>${"<section><p>copy</p></section>".repeat(12)}<div class=\"rounded-lg\">x</div></main>` };
  expect(auditProject([tokens, page], { direction: d })).toEqual([]);
});

test("REGRESSION: a data table's borders and a brutalist panel's squares are not findings", () => {
  // nimbus-ed's probes 2 and 4: both were false positives on correct work
  const table: SourceFile = { path: "components/PlanTable.tsx", text: `<table>${'<tr class="border-b"><td class="border-r">x</td><td>y</td></tr>'.repeat(6)}</table>` };
  expect(projectRules([table])).not.toContain("rule-line-density");
  const panel: SourceFile = { path: "components/Terminal.tsx", text: `<section>${'<div class="border"><pre>$ run</pre></div>'.repeat(10)}</section>` };
  expect(projectRules([panel], { name: "terminal", corners: "sharp" })).toEqual([]);
});

// ---------- plumbing ----------

test("ignore silences one rule by id and leaves the others reporting", () => {
  const files: SourceFile[] = [{ path: "app/page.tsx", text: `import { Check } from "lucide-react";<div class="md:grid-cols-3"></div>` }];
  expect(auditProject(files, { ignore: ["template-grid"] }).map((f) => f.rule)).not.toContain("template-grid");
  expect(projectRules(files)).toContain("template-grid");
});

test("auditFiles reads from disk and turns an unreadable path into a finding, not an exception", () => {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-audit-"));
  try {
    const p = join(dir, "page.html");
    writeFileSync(p, '<div class="md:grid-cols-3"></div>');
    const out = auditFiles([p, join(dir, "missing.tsx")]);
    expect(out.map((f) => f.rule)).toContain("template-grid");
    expect(out.find((f) => f.rule === "unreadable")?.file).toContain("missing.tsx");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a clean file says so, and says whether consistency was even checked", () => {
  expect(formatFindings([], null)).toContain("no design direction");
  expect(formatFindings([], { name: "ink" })).toContain('consistent with the recorded direction "ink"');
});

test("findings are ordered worst-first, carry their evidence, and name a deviation as one", () => {
  const out = formatFindings([
    { rule: "all-square", kind: "slop", severity: "low", message: "m1", evidence: "e1" },
    { rule: "font-deviation", kind: "deviation", severity: "high", message: "m2", evidence: "e2" },
    { rule: "everything-centered", kind: "slop", severity: "med", message: "m3", evidence: "e3" },
  ], { name: "ink" });
  const order = ["font-deviation", "everything-centered", "all-square"].map((r) => out.indexOf(r));
  expect(order).toEqual([...order].sort((a, b) => a - b));
  expect(out).toContain("evidence: e2");
  expect(out).toContain("font-deviation (deviation)");
});
