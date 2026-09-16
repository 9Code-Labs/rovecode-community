/** Port #72 — the agentskills.io-shaped LOADER: spec.ts parseSkillFrontmatter / validateSkillMeta (lenient vs
 *  strict, table-driven) and index.ts SkillStore (leaf rule, dot-dirs, grouping dirs, version fallback,
 *  ScanResult.warnings). Mutation targets are named inline: M2 find() descending below SKILL.md, M6 the
 *  metadata.version fallback. Scratch dirs through test/helpers/scratch.ts (swept per test).
 *
 *  Rovecode's own prompt surface is NOT re-pinned here: the index line clips the description and skill_view carries
 *  it whole (skills.test.ts), which is this tree's answer to the same problem the upstream excerpt solved — so the
 *  upstream 200-char excerpt, its 16 000-char index cap and its skill_view resources tail were deliberately not
 *  ported. `allowed-tools` is pinned as DATA below: parsed, carried, enforced by nothing. */

import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ToolContext } from "../../src/core/types.ts";
import { SkillStore, parseFrontmatter } from "../../src/skills/index.ts";
import { DESCRIPTION_MAX, parseSkillFrontmatter, validateSkillMeta } from "../../src/skills/spec.ts";
import { buildSkillsIndex, createSkillTools } from "../../src/skills/tools.ts";
import { scratchDirs } from "../helpers/scratch.ts";
import { LONG_DESCRIPTION, mkSpecSkill, skillMd, write } from "../helpers/skills-fixtures.ts";

const scratch = scratchDirs();
const ctx = (cwd: string): ToolContext => ({ sessionId: "s", cwd, signal: new AbortController().signal, permissions: { effect: "allow" } });
/** a store over ONE skills dir (global disabled) */
const storeOver = (dir: string): SkillStore => new SkillStore(dir, { projectDir: dir, globalDir: null });

describe("a spec-shaped skill", () => {
  test("loads ONCE with every field populated, zero invalid, one warning naming the unknown key; the decoy references/example/SKILL.md is not a second skill (M2)", () => {
    const root = scratch("rovecode-sk72-");
    const dir = mkSpecSkill(root, { decoy: true });
    const r = storeOver(root).scan();
    expect(r.invalid).toEqual([]);
    expect(r.skills.map((s) => s.name)).toEqual(["pdf-processing"]); // MUTATION TARGET M2: find() descending below SKILL.md → ["example", "pdf-processing"]
    const s = r.skills[0]!;
    expect(s.fullDescription).toBe(LONG_DESCRIPTION); // rovecode: `description` is the clipped index line, `fullDescription` the text as written
    expect(s.description.length).toBeLessThanOrEqual(60);
    expect(s.fullDescription.length).toBe(DESCRIPTION_MAX); // a 1024-char description LOADS (it is clipped for the index, never rejected)
    expect(resolve(s.dir)).toBe(resolve(dir));
    expect(s.path).toBe(join(dir, "SKILL.md"));
    expect(s.license).toBe("Apache-2.0");
    expect(s.compatibility).toBe("Requires python3 and the pdfplumber package");
    expect(s.metadata).toEqual({ author: "rovecode-tests", version: "1.2.3" });
    expect(s.allowedTools).toEqual(["read", "bash", "grep"]);
    expect(s.version).toBe("1.2.3");
    expect(s.body).toBe("# PDF processing\n\nRun scripts/run.sh against the PDF.\n");
    expect(r.warnings).toEqual([{ path: s.path, reason: "unknown frontmatter keys: x-custom" }]);
  });

  test("grouping dirs skills/group/name/SKILL.md load; dot-dirs (.install-*, .old-*) are skipped; a dir holding SKILL.md is a leaf even with deeper SKILL.md files", () => {
    const root = scratch("rovecode-sk72-");
    write(join(root, "group", "alpha", "SKILL.md"), skillMd("alpha"));
    write(join(root, ".install-abc", "hidden", "SKILL.md"), skillMd("hidden"));
    write(join(root, ".old-abc", "SKILL.md"), skillMd("old"));
    write(join(root, "beta", "SKILL.md"), skillMd("beta"));
    write(join(root, "beta", "sub", "deeper", "SKILL.md"), skillMd("deeper"));
    const r = storeOver(root).scan();
    expect(r.skills.map((s) => s.name)).toEqual(["alpha", "beta"]);
    expect(r.invalid).toEqual([]);
    expect(r.warnings).toEqual([]);
  });
});

describe("lenient vs strict", () => {
  const long65 = "a".repeat(65);
  const cases: { title: string; fm: string; dir: string; warn: RegExp }[] = [
    { title: "1025-char description", fm: `name: x\ndescription: ${"d".repeat(1025)}`, dir: "x", warn: /1025 characters \(max 1024\)/ },
    { title: "PDF-Processing (upper-case)", fm: "name: PDF-Processing\ndescription: d", dir: "PDF-Processing", warn: /lower-case/ },
    { title: "-pdf (leading hyphen)", fm: "name: -pdf\ndescription: d", dir: "-pdf", warn: /hyphen/ },
    { title: "pdf--processing (double hyphen)", fm: "name: pdf--processing\ndescription: d", dir: "pdf--processing", warn: /hyphen/ },
    { title: "65-char name", fm: `name: ${long65}\ndescription: d`, dir: long65, warn: /65 characters \(max 64\)/ },
    { title: "name ≠ dir", fm: "name: alpha\ndescription: d", dir: "beta", warn: /does not match its directory "beta"/ },
    { title: "compatibility 501", fm: `name: x\ndescription: d\ncompatibility: ${"c".repeat(501)}`, dir: "x", warn: /501 characters \(max 500\)/ },
    { title: "non-string metadata", fm: "name: x\ndescription: d\nmetadata:\n  author:\n    first: a", dir: "x", warn: /metadata values must be strings: author/ },
    { title: "allowed-tools as a list", fm: "name: x\ndescription: d\nallowed-tools:\n  - read\n  - bash", dir: "x", warn: /allowed-tools must be one space-separated string/ },
    { title: "unknown key", fm: "name: x\ndescription: d\nfoo: 1\nbar: 2", dir: "x", warn: /^unknown frontmatter keys: foo, bar$/ },
  ];
  for (const c of cases) {
    test(`${c.title}: loads with a warning (lenient); strict → error (unknown keys → note); the store lists ONE skill`, () => {
      const fm = parseSkillFrontmatter(`---\n${c.fm}\n---\nbody\n`)!;
      const lenient = validateSkillMeta(fm, c.dir, "lenient");
      expect(lenient.errors).toEqual([]);
      expect(lenient.warnings.some((w) => c.warn.test(w)), lenient.warnings.join(" | ")).toBe(true);
      const strict = validateSkillMeta(fm, c.dir, "strict");
      if (c.title === "unknown key") {
        expect(strict.errors).toEqual([]);
        expect(strict.notes).toEqual(["unknown frontmatter keys: foo, bar"]);
      } else expect(strict.errors.some((e) => c.warn.test(e)), strict.errors.join(" | ")).toBe(true);
      const root = scratch("rovecode-sk72-");
      write(join(root, c.dir, "SKILL.md"), `---\n${c.fm}\n---\nbody\n`);
      const r = storeOver(root).scan();
      expect(r.invalid).toEqual([]);
      expect(r.skills.length).toBe(1);
      expect(r.warnings.some((w) => c.warn.test(w.reason))).toBe(true);
    });
  }

  test("INVALID (not loaded): missing description, empty description, no frontmatter, unterminated block", () => {
    const root = scratch("rovecode-sk72-");
    write(join(root, "a", "SKILL.md"), "---\nname: a\n---\nbody\n");
    write(join(root, "b", "SKILL.md"), '---\nname: b\ndescription: ""\n---\nbody\n');
    write(join(root, "c", "SKILL.md"), "no frontmatter here\n");
    write(join(root, "d", "SKILL.md"), "---\nname: d\ndescription: x\n");
    const r = storeOver(root).scan();
    expect(r.skills).toEqual([]);
    const reasons = new Map(r.invalid.map((i) => [i.path.split(/[\\/]/).at(-2), i.reason]));
    expect(reasons.get("a")).toMatch(/description is required/);
    expect(reasons.get("b")).toMatch(/description is required/);
    expect(reasons.get("c")).toMatch(/missing frontmatter block/); // rovecode says this for both shapes
    expect(reasons.get("d")).toMatch(/missing frontmatter block/); // rovecode says this for both shapes
  });

  test("missing name → the parent-dir basename + a warning (lenient), an error (strict); `version` and the spec fields never warn", () => {
    const fm = parseSkillFrontmatter("---\ndescription: d\nversion: 2.0.0\n---\n")!;
    const l = validateSkillMeta(fm, "from-dir", "lenient");
    expect(l.meta.name).toBe("from-dir");
    expect(l.errors).toEqual([]);
    expect(l.warnings).toEqual([expect.stringMatching(/name missing — using the directory name "from-dir"/)]);
    expect(validateSkillMeta(fm, "from-dir", "strict").errors).toEqual(["name is required"]);
    const known = parseSkillFrontmatter("---\nname: k\ndescription: d\nversion: 1.0.0\nlicense: MIT\ncompatibility: c\nmetadata:\n  a: b\nallowed-tools: read\n---\n")!;
    expect(validateSkillMeta(known, "k", "lenient").warnings).toEqual([]);
    expect(validateSkillMeta(known, "k", "strict")).toMatchObject({ errors: [], notes: [], warnings: [] });
  });
});

describe("parseSkillFrontmatter", () => {
  test("metadata block → nested map without top-level pollution; `>` and `|` scalars join with spaces; a colon inside an unquoted value is kept; quotes stripped", () => {
    const text = ["---", "name: x", "description: >", "  Use when: the user", "  asks for PDFs.", "metadata:", '  author: "Jane"', "  version: '3.1'", "license: 'MIT'", "compatibility: |", "  needs python", "  and git", "---", "", "Body", ""].join("\n");
    const fm = parseSkillFrontmatter(text)!;
    expect(fm.fields["description"]).toBe("Use when: the user asks for PDFs.");
    expect(fm.fields["compatibility"]).toBe("needs python and git");
    expect(fm.metadata).toEqual({ author: "Jane", version: "3.1" });
    expect(fm.fields["author"]).toBeUndefined();
    expect(fm.fields["version"]).toBeUndefined();
    expect(fm.fields["metadata"]).toBeUndefined();
    expect(fm.fields["license"]).toBe("MIT");
    expect(fm.shapes["metadata"]).toBe("map");
    expect(fm.body).toBe("Body\n");
  });

  test("CRLF + BOM tolerated; the flat-file result equals parseFrontmatter's; null without a block or unterminated", () => {
    const fm = parseSkillFrontmatter("﻿---\r\nname: x\r\ndescription: d\r\n---\r\n\r\nBody\r\n")!;
    expect(fm.fields).toEqual({ name: "x", description: "d" });
    expect(fm.body).toBe("Body\r\n");
    expect(parseSkillFrontmatter("just body")).toBeNull();
    expect(parseSkillFrontmatter("---\nname: x\n")).toBeNull();
    const flat = '---\nname: x\ndescription: "quoted desc"\nversion: 2.1.0\n---\n\nBody here\n';
    expect(parseSkillFrontmatter(flat)!.fields).toEqual(parseFrontmatter(flat)!.fm);
    expect(parseSkillFrontmatter(flat)!.body).toBe(parseFrontmatter(flat)!.body);
  });

  test("parseFrontmatter (index.ts) is untouched — the agents.ts / commands.ts shapes: colon-less lines DROPPED, first-colon split, quote strip, body slice", () => {
    expect(parseFrontmatter("---\nname: x\n- read\nmode: plan\ntools: read, grep\n---\nbody\n")).toEqual({ fm: { name: "x", mode: "plan", tools: "read, grep" }, body: "body\n" });
    expect(parseFrontmatter('---\ndescription: "a: b"\n---\n\nBody\n')).toEqual({ fm: { description: "a: b" }, body: "Body\n" });
    expect(parseFrontmatter("---\nname: x\n")).toBeNull();
    expect(parseFrontmatter("nope")).toBeNull();
  });
});

describe("version", () => {
  test("top-level version wins, else metadata.version (M6), else rovecode's \"0.0.0\" default; the index line renders (vX)", async () => {
    const root = scratch("rovecode-sk72-");
    write(join(root, "top", "SKILL.md"), "---\nname: top\ndescription: d\nversion: 9.9.9\nmetadata:\n  version: 1.1.1\n---\nbody\n");
    write(join(root, "meta", "SKILL.md"), "---\nname: meta\ndescription: d\nmetadata:\n  version: 1.2.3\n---\nbody\n");
    write(join(root, "none", "SKILL.md"), "---\nname: none\ndescription: d\n---\nbody\n");
    write(join(root, "solo", "SKILL.md"), "---\nname: solo\ndescription: only skill in town\nversion: 1.0.0\n---\n\ndo the thing\n");
    const store = storeOver(root);
    store.scan();
    expect(store.get("top")!.version).toBe("9.9.9");
    expect(store.get("meta")!.version).toBe("1.2.3"); // MUTATION TARGET M6: drop the metadata.version fallback → ""
    expect(store.get("none")!.version).toBe("0.0.0"); // rovecode's default, unchanged by this port
    const idx = buildSkillsIndex(store);
    expect(idx).toContain("- solo (v1.0.0): only skill in town");
    expect(idx).toContain("- meta (v1.2.3): d");
    const view = createSkillTools(store)[0]!;
    expect((await view.execute({ name: "meta" }, ctx(root))).output.startsWith("# meta (v1.2.3)\n\n")).toBe(true);
  });
});

describe("allowed-tools is DATA", () => {
  test("the field is parsed and carried, and nothing anywhere enforces it: the tools a skill declares are not a permission", () => {
    const root = scratch("rovecode-sk72-");
    mkSpecSkill(root, { extra: [] });                       // the fixture writes `allowed-tools: read bash grep`
    write(join(root, "bare", "SKILL.md"), skillMd("bare")); // no allowed-tools line at all
    const store = storeOver(root);
    store.scan();
    expect(store.get("pdf-processing")!.allowedTools).toEqual(["read", "bash", "grep"]);
    expect(store.get("bare")!.allowedTools).toEqual([]);
    // the whole prompt surface: the declared tools appear in NEITHER the index line nor skill_view, so the model is
    // never told a skill may use a tool, and the runtime is never told to let it
    const idx = buildSkillsIndex(store);
    for (const t of ["read", "bash", "grep", "allowed-tools", "allowedTools"]) expect(idx).not.toContain(t);
    // and the three files that touch the field never reach the permission machinery: a skill's declared tools
    // cannot become an allow rule without one of these importing something it does not import today
    const repoRoot = resolve(import.meta.dir, "..", "..");
    const FORBIDDEN = ["permissionRules", "checkCall", "PermissionRule", "core/permissions"];
    for (const rel of ["src/skills/spec.ts", "src/skills/index.ts", "src/cli/skills-cmd.ts"]) {
      const src = readFileSync(join(repoRoot, rel), "utf8");
      for (const f of FORBIDDEN) expect(src, `${rel} must not reach the permission machinery`).not.toContain(f);
    }
  });
});
