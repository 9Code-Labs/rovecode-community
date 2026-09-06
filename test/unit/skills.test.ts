import { test, expect, beforeAll, afterAll } from "bun:test";
import type { ToolContext } from "../../src/core/types.ts";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SkillStore, parseFrontmatter, skillLifecycle, readUsage, usagePath,
  touchSkillFile, STALE_AFTER_MS, MAX_DESCRIPTION_CHARS,
} from "../../src/skills/index.ts";
import { createSkillTools, buildSkillsIndex, INDEX_PROMPT_LIMIT } from "../../src/skills/tools.ts";

// a per-run directory, not a shared name: bun runs test FILES concurrently, and two overlapping runs
// on one fixed path made recursive mkdir throw EEXIST — a failure that says nothing about skills.
const root = mkdtempSync(join(tmpdir(), "rovecode-skills-test-"));
const projSkills = join(root, "proj", ".rovecode", "skills");
const globalSkills = join(root, "global-skills");

function mkSkill(dir: string, name: string, description: string, body = "do the thing", version = "1.0.0"): string {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name, "SKILL.md");
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(p, `---\nname: ${name}\ndescription: ${description}\nversion: ${version}\n---\n\n${body}\n`);
  return p;
}

function fakeCtx(): ToolContext {
  return { sessionId: "s", cwd: root, signal: new AbortController().signal, permissions: { effect: "allow" } };
}

beforeAll(() => {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(projSkills, { recursive: true });
  mkdirSync(globalSkills, { recursive: true });
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

// ---------- frontmatter parsing ----------

test("parseFrontmatter extracts fields and body", () => {
  const parsed = parseFrontmatter('---\nname: x\ndescription: "quoted desc"\nversion: 2.1.0\n---\n\nBody here\n');
  expect(parsed).not.toBeNull();
  expect(parsed!.fm["name"]).toBe("x");
  expect(parsed!.fm["description"]).toBe("quoted desc");
  expect(parsed!.fm["version"]).toBe("2.1.0");
  expect(parsed!.body).toBe("Body here\n");
});

test("parseFrontmatter returns null without a block", () => {
  expect(parseFrontmatter("just body")).toBeNull();
  expect(parseFrontmatter("---\nname: x\n")).toBeNull(); // unterminated
});

// ---------- scan + parse ----------

test("scan finds project and global skills, parses frontmatter", () => {
  mkSkill(projSkills, "alpha", "does alpha things");
  mkSkill(globalSkills, "beta", "does beta things", "global body", "0.3.0");
  const store = new SkillStore(join(root, "proj"), { globalDir: globalSkills });
  const r = store.scan();
  expect(r.skills.map((s) => s.name)).toEqual(["alpha", "beta"]);
  expect(r.skills.map((s) => s.scope)).toEqual(["project", "global"]);
  expect(r.invalid).toEqual([]);
  const alpha = store.get("alpha")!;
  expect(alpha.version).toBe("1.0.0");
  expect(alpha.body).toBe("do the thing\n");
});

test("scan reports invalid skills without failing the whole scan", () => {
  mkdirSync(join(projSkills, "nodesc"), { recursive: true });
  writeFileSync(join(projSkills, "nodesc", "SKILL.md"), "---\nname: nodesc\n---\nbody\n");
  const store = new SkillStore(join(root, "proj"), { globalDir: globalSkills });
  const r = store.scan();
  expect(r.invalid.length).toBe(1);           // a missing name or description is still fatal
  expect(r.invalid.map((i) => i.path).some((p) => p.includes("nodesc"))).toBe(true);
  expect(r.skills.some((s) => s.name === "alpha")).toBe(true); // valid ones still listed
});

/** A wordy description is not a broken skill. 16 of the 19 skills in anthropics/skills are over the
 *  60-char cap (median 319, longest 950), so rejecting them would have made the only real public
 *  corpus unusable; the cap exists to protect the system-prompt index, and clipping protects it just
 *  as well. The two other places rovecode reads a description already clip. */
test("a long description is clipped for the index, not a reason to reject the skill", () => {
  mkdirSync(join(projSkills, "wordy"), { recursive: true });
  const long = "Use this skill any time a spreadsheet file is the primary input or output of the task, including reading data and writing formulas.";
  writeFileSync(join(projSkills, "wordy", "SKILL.md"), `---\nname: wordy\ndescription: ${long}\n---\nbody\n`);
  const store = new SkillStore(join(root, "proj"), { globalDir: globalSkills });
  const r = store.scan();
  expect(r.invalid.map((i) => i.path).some((p) => p.includes("wordy"))).toBe(false);
  const s = store.get("wordy")!;
  expect(s.description.length).toBeLessThanOrEqual(MAX_DESCRIPTION_CHARS);
  expect(s.description.endsWith("…")).toBe(true);        // the cut is visible, not silent
  expect(s.description).not.toContain("formulas");            // really clipped
  expect(s.fullDescription).toBe(long);                       // and the whole thing is still there
});

/** Real SKILL.md files write a long description as a YAML block scalar. Read line by line it came out
 *  as `">"`, and the indented continuation lines became keys of their own — a skill that loads fine
 *  and tells the model nothing about itself. */
test("a block-scalar description is folded, and its continuation lines are not keys", () => {
  const fm = parseFrontmatter("---\nname: folded\ndescription: >\n  first line\n  second line\nlicense: MIT\n---\n\nbody\n");
  expect(fm!.fm["description"]).toBe("first line second line");
  expect(fm!.fm["license"]).toBe("MIT");
  expect(Object.keys(fm!.fm).sort()).toEqual(["description", "license", "name"]);

  const lit = parseFrontmatter("---\nname: literal\ndescription: |\n  line one\n  line two\n---\n\nbody\n");
  expect(lit!.fm["description"]).toBe("line one\nline two");   // literal keeps the newline
});

test("missing dirs scan to empty without throwing", () => {
  const store = new SkillStore(join(root, "empty-nowhere"), { globalDir: null });
  const r = store.scan();
  expect(r.skills).toEqual([]);
  expect(r.changes).toEqual({ added: [], removed: [], changed: [] });
});

// ---------- manifest invalidation ----------

test("manifest diff: no changes → empty diff; touch → changed; new file → added; delete → removed", async () => {
  const dir = join(root, "mf", ".rovecode", "skills");
  const store = new SkillStore(join(root, "mf"), { globalDir: null });
  const first = store.scan();
  expect(first.changes.added.length).toBe(0);

  const p = mkSkill(dir, "gamma", "gamma skill");
  let r = store.scan();
  expect(r.changes.added).toEqual([p]);

  // same mtime+size → nothing
  r = store.scan();
  expect(r.changes.added).toEqual([]);
  // content rewrite + touch: new mtime → changed, body re-parsed
  writeFileSync(p, "---\nname: gamma\ndescription: gamma v2\nversion: 2.0.0\n---\n\nnew body\n");
  touchSkillFile(p, new Date(Date.now() + 2000));
  r = store.scan();
  expect(r.changes.changed).toEqual([p]);
  expect(store.get("gamma")!.version).toBe("2.0.0");
  expect(store.get("gamma")!.body).toBe("new body\n");

  rmSync(join(dir, "gamma"), { recursive: true, force: true });
  r = store.scan();
  expect(r.changes.removed).toEqual([p]);
  expect(store.get("gamma")).toBeUndefined();
});

// ---------- usage sidecar + lifecycle ----------

test("skill_view returns body and bumps usage sidecar atomically", async () => {
  const store = new SkillStore(join(root, "proj"), { globalDir: null });
  store.scan();
  const skillView = createSkillTools(store)[0]!;
  const before = readUsage(join(projSkills, "alpha", "SKILL.md"));
  expect(before).toBeUndefined();

  const out = await skillView.execute({ name: "alpha" }, fakeCtx());
  expect(out.ok).toBe(true);
  expect(out.output).toContain("do the thing");
  const u1 = readUsage(join(projSkills, "alpha", "SKILL.md"))!;
  expect(u1.viewCount).toBe(1);
  expect(u1.lastViewedAt).toBeGreaterThan(0);

  await skillView.execute({ name: "alpha" }, fakeCtx());
  expect(readUsage(join(projSkills, "alpha", "SKILL.md"))!.viewCount).toBe(2);

  // sidecar lives beside the SKILL.md and no temp file is left behind
  expect(existsSync(usagePath(join(projSkills, "alpha", "SKILL.md")))).toBe(true);
  expect(existsSync(usagePath(join(projSkills, "alpha", "SKILL.md")) + ".tmp")).toBe(false);

  // unknown name → failure, no sidecar created
  const miss = await skillView.execute({ name: "nope" }, fakeCtx());
  expect(miss.ok).toBe(false);
});

test("corrupt sidecar is treated as never used", () => {
  const p = join(projSkills, "alpha", "SKILL.md");
  writeFileSync(usagePath(p), "{not json");
  expect(readUsage(p)).toBeUndefined();
});

test("lifecycle: active → stale transitions on 90d boundary", () => {
  const now = Date.now();
  const skill = { mtimeMs: now };
  const day = 1000 * 60 * 60 * 24;
  expect(skillLifecycle(skill, undefined, now)).toBe("active");
  expect(skillLifecycle({ mtimeMs: now - STALE_AFTER_MS - 1 }, undefined, now)).toBe("stale");
  expect(skillLifecycle(skill, { viewCount: 1, lastViewedAt: now - 5 * day }, now)).toBe("active");
  expect(skillLifecycle({ mtimeMs: now - 100 * day }, { viewCount: 1, lastViewedAt: now - 91 * day }, now)).toBe("stale");
  // zero views → fall back to mtime, not lastViewedAt=0
  expect(skillLifecycle({ mtimeMs: now - 91 * day }, { viewCount: 0, lastViewedAt: 0 }, now)).toBe("stale");
});

// ---------- index building + skills_list path ----------

test("buildSkillsIndex renders names and descriptions; empty above the 50-skill limit", async () => {
  const store = new SkillStore(join(root, "idx"), { globalDir: null });
  mkSkill(join(root, "idx", ".rovecode", "skills"), "solo", "only skill in town");
  store.scan();
  const idx = buildSkillsIndex(store);
  expect(idx).toBe("- solo (v1.0.0): only skill in town");

  // >50 skills → index must NOT go to the system prompt; skills_list tool covers it
  const bigDir = join(root, "big", ".rovecode", "skills");
  for (let i = 0; i < INDEX_PROMPT_LIMIT + 1; i++) mkSkill(bigDir, `sk${String(i).padStart(2, "0")}`, `skill number ${i}`);
  const bigStore = new SkillStore(join(root, "big"), { globalDir: null });
  bigStore.scan();
  expect(bigStore.list().length).toBe(INDEX_PROMPT_LIMIT + 1);
  expect(buildSkillsIndex(bigStore)).toBe("");

  const skillsList = createSkillTools(bigStore)[1]!;
  const out = await skillsList.execute({}, fakeCtx());
  expect(out.ok).toBe(true);
  expect((out.data as { count: number }).count).toBe(INDEX_PROMPT_LIMIT + 1);
  expect(out.output).toContain("sk00");
  expect(out.output).toContain("sk50");
});

test("skills_list on an empty store reports no skills", async () => {
  const store = new SkillStore(join(root, "nothing-here"), { globalDir: null });
  const skillsList = createSkillTools(store)[1]!;
  const out = await skillsList.execute({}, fakeCtx());
  expect(out.ok).toBe(true);
  expect(out.output).toBe("no skills installed");
});

test("tools are read-kind and registerable shapes", () => {
  const store = new SkillStore(root, { globalDir: null });
  const tools = createSkillTools(store);
  expect(tools.map((t) => t.schema.name).sort()).toEqual(["skill_view", "skills_list"]);
  for (const t of tools) {
    expect(t.kind).toBe("read");
    expect(t.schema.args.type).toBe("object");
  }
});
