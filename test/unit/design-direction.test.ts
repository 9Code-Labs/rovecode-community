/** design/direction.ts, design/rules.ts and tools/design.ts — the protocol half of the design work.
 *
 *  The load-bearing claim is that rovecode ships NO default look: Berkay's standing rule is that
 *  colour, type and layout are decided per project and nothing carries over. A built-in "good palette"
 *  would produce exactly the sameness he complained about, so the prompt test below asserts the
 *  ABSENCE of one as hard as it asserts the presence of the ban list. */

import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DESIGN_FILE, designPath, loadDirection, parseDirection, renderDirection, saveDirection,
} from "../../src/design/direction.ts";
import { DESIGN_RULES, designPromptSection } from "../../src/design/rules.ts";
import { auditProject, formatFindings, isAmberish } from "../../src/design/audit.ts";
import { designAuditTool, designDirectionTool } from "../../src/tools/design.ts";
import type { ToolContext } from "../../src/core/types.ts";

const tmp = (): string => mkdtempSync(join(tmpdir(), "rovecode-design-"));
const ctx = (cwd: string): ToolContext =>
  ({ sessionId: "s", cwd, signal: new AbortController().signal, permissions: { effect: "allow" } });

// ---------- the record ----------

test("a direction round-trips through the file and stamps the date it was chosen", () => {
  const dir = tmp();
  try {
    expect(loadDirection(dir)).toBeNull();
    const path = saveDirection(dir, { name: "ink band", palette: { ink: "#0b1a2e" }, corners: "sharp" });
    expect(path).toBe(designPath(dir));
    expect(path.endsWith(join(".rovecode", DESIGN_FILE))).toBe(true);
    const back = loadDirection(dir);
    expect(back?.name).toBe("ink band");
    expect(back?.palette).toEqual({ ink: "#0b1a2e" });
    expect(back?.corners).toBe("sharp");
    expect(back?.chosenAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("parseDirection drops malformed fields instead of throwing, and needs a name to exist at all", () => {
  expect(parseDirection({ rationale: "no name" })).toBeNull();
  expect(parseDirection("nope")).toBeNull();
  const d = parseDirection({ name: "x", corners: "hexagonal", layout: "GRID", palette: { a: 1, b: "#fff" }, typeface: { display: "Geist" } });
  expect(d?.corners).toBeUndefined();       // not one of the known values -> dropped, not fatal
  expect(d?.layout).toBe("grid");           // case-insensitive
  expect(d?.palette).toEqual({ b: "#fff" }); // the non-string entry is dropped
  expect(d?.typeface).toEqual({ display: "Geist" });
});

test("a corrupt design.json reads as 'no direction' rather than taking the run down", () => {
  const dir = tmp();
  try {
    mkdirSync(join(dir, ".rovecode"), { recursive: true });
    writeFileSync(designPath(dir), "{ not json");
    expect(loadDirection(dir)).toBeNull();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("renderDirection states only what was chosen, and collapses one typeface into one clause", () => {
  const out = renderDirection({ name: "n", typeface: { display: "Geist", text: "Geist" }, corners: "soft" });
  expect(out).toContain("Typefaces: Geist");
  expect(out).not.toContain("for display");
  expect(out).not.toContain("Palette");
  expect(renderDirection({ name: "n", typeface: { display: "A", text: "B" } })).toContain("A for display, B for text");
  expect(renderDirection(null)).toBe("");
});

// ---------- the prompt section ----------

test("the rules prescribe no palette, no typeface and no layout — there is no default look to carry over", () => {
  expect(DESIGN_RULES).not.toMatch(/#[0-9a-fA-F]{6}/);
  // every font named is named as something to climb OUT of, inside the defaults section
  const defaults = DESIGN_RULES.slice(DESIGN_RULES.indexOf("## The defaults to climb out of"));
  for (const f of ["Inter", "Roboto", "Poppins", "Montserrat"]) expect(defaults).toContain(f);
  // \b so the heading "Interface design" does not count as naming the typeface Inter
  expect(DESIGN_RULES.slice(0, DESIGN_RULES.indexOf("## The defaults"))).not.toMatch(/\bInter\b/);
});

test("every pattern Berkay named is covered by the rules", () => {
  const t = DESIGN_RULES.toLowerCase();
  for (const needle of ["amber", "hero", "typeface", "hairline", "square", "centred", "gradient"]) {
    expect(t).toContain(needle);
  }
  expect(t).toContain("design_audit");
  expect(t).toContain("design_direction");
});

test("the section tells a fresh project to ask, and a decided project to stop asking", () => {
  const dir = tmp();
  try {
    const before = designPromptSection(dir);
    expect(before).toContain("No design direction is recorded yet");
    saveDirection(dir, { name: "ink band", rationale: "quiet, editorial" });
    const after = designPromptSection(dir);
    expect(after).toContain("do not re-ask");
    expect(after).toContain("ink band");
    expect(after).not.toContain("No design direction is recorded yet");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------- the tools ----------

test("design_direction get reports nothing recorded, set records what the human chose", async () => {
  const dir = tmp();
  try {
    const tool = designDirectionTool();
    const empty = await tool.execute({ action: "get" }, ctx(dir));
    expect(empty.ok).toBe(true);
    expect(empty.output).toContain("No design direction recorded");
    // lazy disclosure (the staged prompt): the full protocol rides in THIS answer, not in every
    // request's system prompt — the stub in rules.ts points here
    expect(empty.output).toContain("This question is about NEW work");

    const set = await tool.execute({ action: "set", name: "ink band", corners: "sharp" }, ctx(dir));
    expect(set.ok).toBe(true);
    expect(existsSync(designPath(dir))).toBe(true);
    expect(JSON.parse(readFileSync(designPath(dir), "utf8")).name).toBe("ink band");

    const got = await tool.execute({ action: "get" }, ctx(dir));
    expect(got.output).toContain("ink band");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("design_direction set refuses a nameless direction and an unknown action", async () => {
  const dir = tmp();
  try {
    const tool = designDirectionTool();
    const noName = await tool.execute({ action: "set", corners: "sharp" }, ctx(dir));
    expect(noName.ok).toBe(false);
    expect(noName.output).toContain("name");
    expect(existsSync(designPath(dir))).toBe(false);
    expect((await tool.execute({ action: "reset" }, ctx(dir))).ok).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("design_direction is the one that prompts; design_audit is free", () => {
  expect(designDirectionTool().kind).toBe("custom"); // -> tool.design_direction, PROMPT under gated rules
  expect(designAuditTool().kind).toBe("read");       // -> file.read, auto-allowed: self-checking must cost nothing
});

test("design_audit reads source directly and honours the project's recorded direction", async () => {
  const dir = tmp();
  try {
    const tool = designAuditTool();
    // all-square is project-scoped since the calibration rework (§3.5: per file it fired on 330 files in
    // repos that all use rounded corners somewhere), so the pasted source has to be project-sized before
    // "not one rounded corner anywhere" means anything at all
    const square = `<main>${"<section><p>c</p></section>".repeat(25)}</main>`;
    expect((await tool.execute({ source: square }, ctx(dir))).output).toContain("all-square");
    saveDirection(dir, { name: "brutalist", corners: "sharp" });
    const after = await tool.execute({ source: square }, ctx(dir));
    expect(after.output).not.toContain("all-square");
    expect(after.output).toContain("brutalist");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("design_audit reads files, reports paths relative to the project, and refuses to leave it", async () => {
  const dir = tmp();
  try {
    const tool = designAuditTool();
    mkdirSync(join(dir, "app"), { recursive: true });
    writeFileSync(join(dir, "app", "page.tsx"), 'export default () => <p className="text-amber-500 bg-amber-600 border-amber-700">x</p>;');
    const out = await tool.execute({ files: ["app/page.tsx"] }, ctx(dir));
    expect(out.ok).toBe(true);
    expect(out.output).toContain("cliche-accent-amber");
    expect(out.output).toContain(join("app", "page.tsx"));

    const escaped = await tool.execute({ files: ["../secrets.env"] }, ctx(dir));
    expect(escaped.ok).toBe(false);
    expect(escaped.output).toContain("inside the project");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("design_audit with neither files nor source says what it needs", async () => {
  const dir = tmp();
  try {
    const out = await designAuditTool().execute({}, ctx(dir));
    expect(out.ok).toBe(false);
    expect(out.output).toContain("needs");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------- headless: the provisional direction ----------

test("a provisional direction round-trips, and set() derives chosenBy from it", async () => {
  const dir = tmp();
  try {
    const out = await designDirectionTool().execute({
      action: "set", name: "its own output", rationale: "the tool's transcript is the product",
      provisional: true, alternatives: ["the manual", "the instrument"],
    }, ctx(dir));
    expect(out.ok).toBe(true);
    expect(out.output).toContain("PROVISIONAL");
    expect(out.output).toContain("the manual, the instrument");

    const back = loadDirection(dir);
    expect(back?.provisional).toBe(true);
    // provisional implies the agent chose: the record can never say "human" and "provisional" at once
    expect(back?.chosenBy).toBe("agent");
    expect(back?.alternatives).toEqual(["the manual", "the instrument"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a human's direction records neither provisional nor an agent author", async () => {
  const dir = tmp();
  try {
    const out = await designDirectionTool().execute({ action: "set", name: "ink band" }, ctx(dir));
    expect(out.ok).toBe(true);
    expect(out.output).not.toContain("PROVISIONAL");
    const back = loadDirection(dir);
    expect(back?.provisional).toBeUndefined();
    // derived, not taken from the call: every write says who chose, so the field can be believed
    expect(back?.chosenBy).toBe("human");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("get and the prompt section both say a provisional direction is not the human's yet", async () => {
  const dir = tmp();
  try {
    saveDirection(dir, { name: "the instrument", provisional: true, chosenBy: "agent", alternatives: ["the manual"] });
    const got = await designDirectionTool().execute({ action: "get" }, ctx(dir));
    expect(got.output).toContain("PROVISIONAL direction: the instrument");
    expect(got.output).toContain("ask the human once");
    expect(got.output).toContain("Not built: the manual");
    // and the run's own system prompt carries the same caveat, not just the tool call
    const section = designPromptSection(dir);
    expect(section).toContain("PROVISIONAL direction");
    // the heading must not tell the model "do not re-ask" about the question that is still open
    expect(section).toContain("PROVISIONAL: build to this, and ask once before more UI");
    expect(section).not.toContain("build to this, do not re-ask");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a record from before the field existed carries no author, and is not treated as the agent's", () => {
  const d = parseDirection({ name: "ink band", corners: "sharp" });
  expect(d?.chosenBy).toBeUndefined();
  expect(d?.provisional).toBeUndefined();
  expect(renderDirection(d)).toContain("Chosen direction: ink band");
});

test("parseDirection drops a malformed provisional record rather than trusting half of it", () => {
  const d = parseDirection({ name: "x", provisional: "yes", chosenBy: "the cat", alternatives: [1, 2] });
  expect(d?.name).toBe("x");
  expect(d?.provisional).toBeUndefined();   // only literal true counts
  expect(d?.chosenBy).toBeUndefined();      // only "human" | "agent"
  expect(d?.alternatives).toBeUndefined();  // non-strings dropped, and an empty list is no list
  expect(renderDirection(d)).toContain("Chosen direction: x");
});

test("the audit's consistency line marks a provisional direction every time it names it", () => {
  const clean = formatFindings([], { name: "the instrument", provisional: true });
  expect(clean).toContain("provisional direction");
  const withFindings = formatFindings(
    [{ rule: "all-square", kind: "slop", severity: "low", message: "m", evidence: "e" }],
    { name: "the instrument", provisional: true },
  );
  expect(withFindings).toContain("provisional direction");
  // a human's direction says nothing of the sort
  expect(formatFindings([], { name: "the instrument" })).not.toContain("provisional");
});

// ---------- the prompt rules the headless run needed ----------

test("the prompt tells a headless run to record provisionally, and caps ask_user option labels", () => {
  expect(DESIGN_RULES).toContain("provisional: true");
  expect(DESIGN_RULES).toContain("alternatives");
  expect(DESIGN_RULES).toMatch(/60 characters or less/);
  // and it says what to do on the NEXT interactive run rather than leaving the flag inert
  expect(DESIGN_RULES).toContain("PROVISIONAL was chosen by an agent");
});

test("the prompt says a named face must be loaded, and that the first screen names the product", () => {
  expect(DESIGN_RULES).toMatch(/name a face in CSS, LOAD it/);
  expect(DESIGN_RULES).toContain("font-named-not-loaded");
  expect(DESIGN_RULES).toMatch(/sr-only h1 is not that line/);
  expect(DESIGN_RULES).toMatch(/re-read the `notes` and `rationale`/);
});

// ---------- font-named-not-loaded ----------

test("a face named in CSS with no load site anywhere in the set is a finding", () => {
  const out = auditProject([
    { path: "app/page.tsx", text: '<main className="font-[Sohne]"><h1>x</h1></main>' },
    { path: "app/globals.css", text: "body { font-family: 'Sohne', sans-serif; }" },
  ]);
  const f = out.filter((x) => x.rule === "font-named-not-loaded");
  expect(f.length).toBe(1);                       // one per face, not one per mention
  expect(f[0]!.severity).toBe("low");
  expect(f[0]!.kind).toBe("slop");
  expect(f[0]!.message).toContain("Sohne");
  expect(f[0]!.evidence).toContain("no load site");
});

test("the same face goes unreported once any audited file loads it", () => {
  const named = { path: "app/globals.css", text: "body { font-family: 'Sohne', sans-serif; }" };
  const viaFontFace = auditProject([named, { path: "app/fonts.css", text: "@font-face { font-family: 'Sohne'; src: url(/s.woff2); }" }]);
  expect(viaFontFace.some((f) => f.rule === "font-named-not-loaded")).toBe(false);

  const viaImport = auditProject([named, { path: "app/layout.tsx", text: 'import { Sohne } from "next/font/google";' }]);
  expect(viaImport.some((f) => f.rule === "font-named-not-loaded")).toBe(false);

  const viaUrl = auditProject([named, { path: "app/head.tsx", text: '<link href="https://fonts.googleapis.com/css2?family=Sohne&display=swap" />' }]);
  expect(viaUrl.some((f) => f.rule === "font-named-not-loaded")).toBe(false);
});

test("generic keywords, system stacks and var() indirection are not faces", () => {
  const out = auditProject([{
    path: "app/globals.css",
    text: `body { font-family: sans-serif; }
           code { font-family: ui-monospace, monospace; }
           input { font-family: -apple-system, "Segoe UI", Arial; }
           .brand { font-family: var(--font-display); }`,
  }]);
  expect(out.some((f) => f.rule === "font-named-not-loaded")).toBe(false);
});

test("a Tailwind arbitrary WEIGHT is not a face: font-[450] and font-[bold] never report", () => {
  // found on site/ 2026-09-04: `font-[450]` on an accordion trigger was reported as a face named "450"
  const out = auditProject([{
    path: "src/sections/Faq.tsx",
    text: `<h3 className="font-[450]">a</h3><p className="font-[bold]">b</p><em className="font-[italic]">c</em>`,
  }]);
  expect(out.some((f) => f.rule === "font-named-not-loaded")).toBe(false);
  // and a real family in the same syntax still does report
  const real = auditProject([{ path: "src/sections/Faq.tsx", text: `<h3 className="font-[Sohne]">a</h3>` }]);
  expect(real.some((f) => f.rule === "font-named-not-loaded")).toBe(true);
});

test("when the RECORDED face is the one nothing loads, it is a deviation, not slop", () => {
  const out = auditProject(
    [{ path: "app/globals.css", text: "body { font-family: 'Sohne', sans-serif; }" }],
    { direction: { name: "the manual", typeface: { text: "Sohne" } } },
  );
  const f = out.find((x) => x.rule === "font-named-not-loaded");
  expect(f?.kind).toBe("deviation");
  expect(f?.message).toContain("not what a reader sees");
});

test("font-named-not-loaded honours ignore, and skips prose files", () => {
  const files = [{ path: "app/globals.css", text: "body { font-family: 'Sohne'; }" }];
  expect(auditProject(files, { ignore: ["font-named-not-loaded"] }).some((f) => f.rule === "font-named-not-loaded")).toBe(false);
  const prose = auditProject([{ path: "docs/style.md", text: "body { font-family: 'Sohne'; }" }]);
  expect(prose.some((f) => f.rule === "font-named-not-loaded")).toBe(false);
});

// ---------- the amber floor, written down ----------

test("rust and terracotta sit below the amber band; the reflex ramp sits inside it", () => {
  for (const rust of ["#b4431d", "#c2410c", "#9a3412"]) expect(isAmberish(rust)).toBe(false);
  for (const amber of ["#ea580c", "#b45309", "#d97706", "#f59e0b"]) expect(isAmberish(amber)).toBe(true);
});
