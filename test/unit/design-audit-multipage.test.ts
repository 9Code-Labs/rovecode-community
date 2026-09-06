/** design_audit against a real multi-page shape, from a fixture tree on disk (test/fixtures/design-site).
 *
 *  Both claims here were found false on two cloned public repos on 2026-09-04 — shadcn-ui/taxonomy (a
 *  Next.js app router with 14 routes) and withastro/blog-tutorial-demo — and fixed in audit.ts:
 *
 *  1. "Density and centring are scored per PAGE." They were scored over the route file plus its own
 *     imports, and an app-router page imports none of the layouts it renders inside. On taxonomy the
 *     layout chain carried 8-24 elements per route and on four routes was larger than the page file.
 *  2. The colour rules read `#rrggbb` only. taxonomy declares its whole palette as bare HSL triplets on
 *     custom properties and contains ZERO hex literals, so every colour rule saw an empty document.
 *
 *  The fixture is deliberately minimal and synthetic: the thin page is under every threshold alone, and
 *  the chrome that pushes it over lives where a real site keeps it. */

import { test, expect } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { auditProject, declaredColours, hslToHex, hueFamily, isRouteFile } from "../../src/design/audit.ts";
import type { DesignDirection } from "../../src/design/direction.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "design-site");

function tree(root = ROOT): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      out.push({ path: relative(ROOT, p).split(sep).join("/"), text: readFileSync(p, "utf8") });
    }
  };
  walk(root);
  return out;
}

const rule = (fs: readonly { rule: string }[], id: string): number => fs.filter((f) => f.rule === id).length;

// ---------- the page is what renders, not what the page file imports ----------

test("a route is scored together with the layouts it renders inside, which it never imports", () => {
  const files = tree();
  expect(files.some((f) => f.path === "app/layout.tsx")).toBe(true);
  const page = files.find((f) => f.path === "app/(marketing)/pricing/page.tsx")!;
  expect(isRouteFile(page.path)).toBe(true);

  // alone, the page is nowhere near the 0.4 hairlines-per-element bar — it has none at all
  expect(rule(auditProject([page]), "rule-line-density")).toBe(0);

  // in the tree, the layout chain (and the nav the layout imports) comes with it and it fires
  const found = auditProject(files).filter((f) => f.rule === "rule-line-density");
  expect(found).toHaveLength(1);
  expect(found[0]!.file).toBe("app/(marketing)/pricing/page.tsx");
  // the evidence names what was actually counted, so a human can disagree with the scope itself
  expect(found[0]!.evidence).toContain("app/(marketing)/pricing/page.tsx +");
  expect(found[0]!.evidence).toContain("layout");
});

test("components/ui/** stays out of the count even when a layout's own import pulls it in", () => {
  const files = tree();
  const ev = auditProject(files).find((f) => f.rule === "rule-line-density")!.evidence;
  // the button is a vendored primitive with a border of its own; it must not be part of the page
  expect(ev).not.toContain("components/ui/button.tsx");
  // the nav is not a primitive and IS part of the chrome, so it counts
  const parts = Number(/\+ (\d+) file/.exec(ev)?.[1] ?? "0");
  expect(parts).toBeGreaterThanOrEqual(2); // at least the root layout and the nav it imports
});

test("a components-only run produces no page-scoped finding at all — silence there means not measured", () => {
  const componentsOnly = tree().filter((f) => f.path.startsWith("components/"));
  expect(componentsOnly.some((f) => isRouteFile(f.path))).toBe(false);
  const found = auditProject(componentsOnly);
  expect(rule(found, "rule-line-density")).toBe(0);
  expect(rule(found, "everything-centered")).toBe(0);
});

// ---------- colour, however the stylesheet writes it ----------

test("hslToHex round-trips against the hex the same colour would have been written as", () => {
  expect(hslToHex(0, 0, 100)).toBe("#ffffff");
  expect(hslToHex(0, 0, 0)).toBe("#000000");
  expect(hslToHex(0, 100, 50)).toBe("#ff0000");
  expect(hslToHex(120, 100, 50)).toBe("#00ff00");
  expect(hslToHex(240, 100, 50)).toBe("#0000ff");
  expect(hslToHex(38, 92, 50)).toBe("#f59f0a");   // the reflex amber, within a point of #f59e0b
});

test("a palette written only as bare HSL triplets is read, not skipped", () => {
  const css = tree().find((f) => f.path === "styles/globals.css")!.text;
  expect(css).not.toMatch(/#[0-9a-f]{6}/i);        // the fixture really has no hex, like the repo it came from
  const cs = declaredColours(css);
  expect(cs).toContain("#f59f0a");                  // --primary: 38 92% 50%
  expect(cs).toContain("#ffffff");                  // --background: 0 0% 100%
  expect(cs).toContain(hslToHex(174, 62, 47));      // the written hsl(174, 62%, 47%)
  expect(cs.length).toBeGreaterThanOrEqual(6);
});

test("declaredColours reads the three syntaxes and refuses to invent a colour from a plain triplet", () => {
  expect(declaredColours("color: #0af;")).toEqual(["#0af"]);
  expect(declaredColours("--x: 210 40% 96%;")).toEqual([hslToHex(210, 40, 96)]);
  expect(declaredColours("background: hsl(210 40% 96% / 0.5);")).toEqual([hslToHex(210, 40, 96)]);
  // no percent signs: a grid template, a transform, a version — not a colour
  expect(declaredColours("--cols: 3 4 5; transform: translate(10 20);")).toEqual([]);
});

test("an off-palette colour declared in HSL is a deviation, and one extra family still is not", () => {
  const direction: DesignDirection = { name: "slate", palette: { ink: "#101418", paper: "#f7f7f5" } };
  const css = tree().find((f) => f.path === "styles/globals.css")!;
  const found = auditProject([css], { direction }).filter((f) => f.rule === "off-palette");
  // amber, violet, red and teal are four families and none is in the recorded palette
  expect(found).toHaveLength(1);
  expect(found[0]!.kind).toBe("deviation");

  // the same file with the amber recorded loses that family; the budget of 1 covers a lone extra
  const oneFamily = auditProject(
    [{ path: "styles/globals.css", text: ":root { --primary: 38 92% 50%; --destructive: 0 84% 60%; }" }],
    { direction: { name: "amber", palette: { accent: "#f59e0b" } } },
  );
  expect(rule(oneFamily, "off-palette")).toBe(0);
  expect(hueFamily(hslToHex(38, 92, 50))).toBe(hueFamily("#f59e0b")); // same family, so it is in-palette
});
