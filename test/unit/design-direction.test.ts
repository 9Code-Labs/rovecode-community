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
