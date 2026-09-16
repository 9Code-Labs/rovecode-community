/** Port #72 — `rovecode skills list|validate|pack|install <dir>` through cmdSkills (cli/skills-cmd.ts) with the io
 *  seam: list rows + warnings, the STRICT validate findings, pack's archive shape and its refusals (a finding → nothing
 *  written, M4; an existing output; a symlink), install from a directory (project scope over a legacy .rovecode dir, the
 *  --force rename swap with byte identity, the mid-copy failure that must leave the old skill intact and no
 *  .install-* / .old-* dir, M5; --user through the globalDir seam), the usage exits and the 1024-char load (M1).
 *  Archive / URL installs live in skills-cmd-2.test.ts. Every store is pointed at a scratch global dir — the real
 *  ~/.rovecode/skills is never read. */

import { describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cmdSkills, SKILLS_USAGE } from "../../src/cli/skills-cmd.ts";
import { installFromDir } from "../../src/skills/pack.ts";
import { scratchDirs } from "../helpers/scratch.ts";
import { collectIo, LONG_DESCRIPTION, mkSpecSkill, skillMd, write } from "../helpers/skills-fixtures.ts";

const scratch = scratchDirs();
async function run(args: string[], cwd: string, deps: { globalDir?: string } = {}): Promise<{ code: number; out: string[]; err: string[] }> {
  const c = collectIo();
  const code = await cmdSkills(args, cwd, { io: c.io, globalDir: deps.globalDir ?? join(cwd, "no-global") });
  return { code, out: c.out, err: c.err };
}
const listing = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).sort() : []);
interface Row { name: string; version: string; scope: string; path: string; description: string; metadata: Record<string, string>; warnings: string[] }
const jsonOut = (out: string[]): { skills: Row[]; invalid: { path: string; reason: string }[] } => JSON.parse(out.join("\n")) as { skills: Row[]; invalid: { path: string; reason: string }[] };

describe("rovecode skills list", () => {
  test("--json shows name, version, scope, path, description, metadata and every warning for project + global skills, refused files apart; text mode prints a row per skill and the warnings on stderr", async () => {
    const cwd = scratch("rovecode-sk72cmd-"), globalDir = scratch("rovecode-sk72cmd-");
    mkSpecSkill(join(cwd, ".rovecode", "skills")); // project, one warning (x-custom)
    write(join(globalDir, "helper", "SKILL.md"), skillMd("helper")); // global, clean
    write(join(globalDir, "broken", "SKILL.md"), "---\nname: broken\n---\n");
    const r = await run(["list", "--json"], cwd, { globalDir });
    expect(r.code).toBe(0);
    const j = jsonOut(r.out);
    expect(j.skills.map((s) => [s.name, s.version, s.scope])).toEqual([["helper", "0.0.0", "global"], ["pdf-processing", "1.2.3", "project"]]); // rovecode's version default
    const pdf = j.skills[1]!;
    expect(pdf.path).toBe(join(cwd, ".rovecode", "skills", "pdf-processing", "SKILL.md"));
    expect(pdf.description).toBe(LONG_DESCRIPTION); // MUTATION TARGET M1: the 60-char reject → the skill is missing from the list
    expect(pdf.metadata).toEqual({ author: "rovecode-tests", version: "1.2.3" });
    expect(pdf.warnings).toEqual(["unknown frontmatter keys: x-custom"]);
    expect(j.invalid).toEqual([{ path: join(globalDir, "broken", "SKILL.md"), reason: expect.stringMatching(/description is required/) }]);
    const t = await run(["list"], cwd, { globalDir });
    expect(t.code).toBe(0);
    expect(t.out.some((l) => l.startsWith("pdf-processing") && l.includes("1.2.3") && l.includes("project"))).toBe(true);
    expect(t.out.some((l) => l.startsWith("helper") && l.includes("global"))).toBe(true);
    expect(t.err).toEqual([expect.stringContaining("unknown frontmatter keys: x-custom"), expect.stringContaining("not loaded")]);
  });

  test("an empty catalogue says so, exit 0", async () => {
    const cwd = scratch("rovecode-sk72cmd-");
    const r = await run(["list"], cwd);
    expect(r.code).toBe(0);
    expect(r.out).toEqual([expect.stringMatching(/^no skills installed/)]);
  });
});

describe("rovecode skills validate", () => {
  test("STRICT: one stderr line per finding, exit 1 — a non-conforming name, name ≠ dir, a 1025-char description, a 501-char compatibility, nested metadata, a list allowed-tools", async () => {
    const cwd = scratch("rovecode-sk72cmd-");
    const dir = join(cwd, "bad-dir");
    write(join(dir, "SKILL.md"), ["---", "name: Bad_Name", `description: ${"d".repeat(1025)}`, `compatibility: ${"c".repeat(501)}`, "metadata:", "  nested:", "    a: b", "allowed-tools:", "  - read", "---", "body", ""].join("\n"));
    const r = await run(["validate", "bad-dir"], cwd);
    expect(r.code).toBe(1);
    expect(r.err.length).toBe(6);
    for (const l of r.err) expect(l.startsWith(`${join(dir, "SKILL.md")}: `)).toBe(true);
    expect(r.err.join("\n")).toMatch(/does not match its directory "bad-dir"/);
    expect(r.err.join("\n")).toMatch(/1025 characters \(max 1024\)/);
    expect(r.out).toEqual([]);
  });

  test("a clean spec-shaped skill → exit 0 `ok:`; unknown keys are notes on stdout, never a failure; no SKILL.md → exit 2; no frontmatter → exit 1", async () => {
    const cwd = scratch("rovecode-sk72cmd-");
    const dir = mkSpecSkill(cwd);
    const r = await run(["validate", dir], cwd);
    expect(r.code).toBe(0);
    expect(r.out).toEqual(["note: unknown frontmatter keys: x-custom", expect.stringMatching(/^ok: pdf-processing \(v1\.2\.3\)/)]);
    expect(r.err).toEqual([]);
    expect((await run(["validate", join(cwd, "nope")], cwd)).code).toBe(2);
    write(join(cwd, "nofm", "SKILL.md"), "plain\n");
    expect((await run(["validate", join(cwd, "nofm")], cwd)).code).toBe(1);
  });
});

describe("rovecode skills pack", () => {
  test("writes <cwd>/<name>.tar.gz: files() keys are sorted posix paths under ONE top-level dir = name; sidecars, .git, node_modules excluded; real bytes; --out names the file; an existing output → exit 1 without --force", async () => {
    const cwd = scratch("rovecode-sk72cmd-");
    const dir = mkSpecSkill(cwd, { unknownKey: false });
    writeFileSync(join(dir, "SKILL.md.usage.json"), "{}");
    writeFileSync(join(dir, "SKILL.md.versions.jsonl"), "");
    write(join(dir, ".git", "HEAD"), "ref");
    write(join(dir, "node_modules", "x", "index.js"), "");
    const r = await run(["pack", dir], cwd);
    expect(r.code, r.err.join("\n")).toBe(0);
    const out = join(cwd, "pdf-processing.tar.gz");
    expect(existsSync(out)).toBe(true);
    const bytes = readFileSync(out);
    expect([bytes[0], bytes[1]]).toEqual([0x1f, 0x8b]); // gzip magic
    const files = await new Bun.Archive(bytes).files();
    expect([...files.keys()]).toEqual(["pdf-processing/SKILL.md", "pdf-processing/assets/logo.txt", "pdf-processing/references/a.md", "pdf-processing/scripts/run.sh"]);
    expect(files.get("pdf-processing/scripts/run.sh")!.size).toBe(Buffer.byteLength("#!/bin/sh\necho run\n")); // readFileSync bytes — Bun.file() inputs yield EMPTY entries (Bun #28459)
    expect((await run(["pack", dir], cwd)).code).toBe(1);
    expect((await run(["pack", dir, "--force"], cwd)).code).toBe(0);
    mkdirSync(join(cwd, "sub"));
    expect((await run(["pack", dir, "--out", join("sub", "custom.tgz")], cwd)).code).toBe(0);
    expect(existsSync(join(cwd, "sub", "custom.tgz"))).toBe(true);
  });

  test("a strict finding (name ≠ dir) → exit 1 and NOTHING written (M4)", async () => {
    const cwd = scratch("rovecode-sk72cmd-");
    const dir = mkSpecSkill(cwd, { dirName: "other-dir" });
    const before = listing(cwd);
    const r = await run(["pack", dir], cwd);
    expect(r.code).toBe(1); // MUTATION TARGET M4: pack proceeding past a strict error → 0 and a written file
    expect(r.err.join("\n")).toContain('does not match its directory "other-dir"');
    expect(listing(cwd)).toEqual(before);
    expect(existsSync(join(cwd, "pdf-processing.tar.gz"))).toBe(false);
  });

  test.skipIf(process.platform === "win32")("a symlink inside the skill → exit 1, nothing written (skipped on win32: symlinks need a privilege there)", async () => {
    const cwd = scratch("rovecode-sk72cmd-");
    const dir = mkSpecSkill(cwd, { unknownKey: false });
    symlinkSync(join(dir, "SKILL.md"), join(dir, "link.md"));
    const r = await run(["pack", dir], cwd);
    expect(r.code).toBe(1);
    expect(r.err.join("\n")).toContain("symlink refused: link.md");
    expect(existsSync(join(cwd, "pdf-processing.tar.gz"))).toBe(false);
  });
});

describe("rovecode skills install <dir>", () => {
  test("lands in <cwd>/.rovecode/skills/<name> with every file, sidecars dropped, no .install-* left; prints `installed <name> (vX) → <path>` + the warnings", async () => {
    const cwd = scratch("rovecode-sk72cmd-");
    const src = mkSpecSkill(scratch("rovecode-sk72cmd-"));
    writeFileSync(join(src, "SKILL.md.usage.json"), "{}");
    const r = await run(["install", src], cwd);
    expect(r.code, r.err.join("\n")).toBe(0);
    const target = join(cwd, ".rovecode", "skills", "pdf-processing");
    expect(r.out).toEqual([`installed pdf-processing (v1.2.3) → ${target}`]);
    expect(r.err).toEqual(["warning: unknown frontmatter keys: x-custom"]);
    expect(listing(target)).toEqual(["SKILL.md", "assets", "references", "scripts"]);
    expect(readFileSync(join(target, "SKILL.md"), "utf8")).toBe(readFileSync(join(src, "SKILL.md"), "utf8"));
    expect(listing(join(cwd, ".rovecode", "skills"))).toEqual(["pdf-processing"]);
  });

  test("an existing target → exit 1 with bytes identical; --force replaces it (old-only files gone, new body in place, no .old-* / .install-* left)", async () => {
    const cwd = scratch("rovecode-sk72cmd-");
    const v1 = mkSpecSkill(scratch("rovecode-sk72cmd-"), { metadataVersion: "1.0.0", unknownKey: false });
    const v2 = mkSpecSkill(scratch("rovecode-sk72cmd-"), { metadataVersion: "2.0.0", unknownKey: false, body: "v2 body" });
    write(join(v1, "assets", "only-in-v1.txt"), "old");
    expect((await run(["install", v1], cwd)).code).toBe(0);
    const target = join(cwd, ".rovecode", "skills", "pdf-processing");
    const before = readFileSync(join(target, "SKILL.md"));
    const r = await run(["install", v2], cwd);
    expect(r.code).toBe(1); // MUTATION TARGET M5: guard inverted / write in place → 0 and the bytes change
    expect(r.err.join("\n")).toContain("already exists (use --force");
    expect(Buffer.compare(readFileSync(join(target, "SKILL.md")), before)).toBe(0);
    expect(existsSync(join(target, "assets", "only-in-v1.txt"))).toBe(true);
    const f = await run(["install", v2, "--force"], cwd);
    expect(f.code, f.err.join("\n")).toBe(0);
    expect(f.out[0]).toBe(`installed pdf-processing (v2.0.0) → ${target}`);
    expect(readFileSync(join(target, "SKILL.md"), "utf8")).toContain("v2 body");
    expect(existsSync(join(target, "assets", "only-in-v1.txt"))).toBe(false);
    expect(listing(join(cwd, ".rovecode", "skills"))).toEqual(["pdf-processing"]);
  });

  test("an injected copy failure mid-install leaves the old skill intact and no .install-* / .old-* dir; a failure at the swap restores the old skill (M5)", () => {
    const cwd = scratch("rovecode-sk72cmd-");
    const skillsDir = join(cwd, ".rovecode", "skills");
    const v1 = mkSpecSkill(scratch("rovecode-sk72cmd-"), { metadataVersion: "1.0.0", unknownKey: false });
    const v2 = mkSpecSkill(scratch("rovecode-sk72cmd-"), { metadataVersion: "2.0.0", unknownKey: false });
    installFromDir(v1, skillsDir);
    const target = join(skillsDir, "pdf-processing");
    const before = readFileSync(join(target, "SKILL.md"));
    let copies = 0;
    const failing = (s: string, d: string): void => { if (++copies === 2) throw new Error("disk full (injected)"); copyFileSync(s, d); };
    expect(() => installFromDir(v2, skillsDir, { force: true, copyFile: failing })).toThrow("disk full");
    expect(Buffer.compare(readFileSync(join(target, "SKILL.md")), before)).toBe(0);
    expect(listing(skillsDir)).toEqual(["pdf-processing"]);
    expect(() => installFromDir(v2, skillsDir, { force: true, onSwap: () => { throw new Error("swap failed (injected)"); } })).toThrow("swap failed");
    expect(Buffer.compare(readFileSync(join(target, "SKILL.md")), before)).toBe(0);
    expect(listing(skillsDir)).toEqual(["pdf-processing"]);
    expect(installFromDir(v2, skillsDir, { force: true }).version).toBe("2.0.0"); // a clean --force still works afterwards
  });

  test("--user installs under the user skills dir (the globalDir seam = <ROVECODE_HOME>/skills), never the project; a missing source → exit 2", async () => {
    const cwd = scratch("rovecode-sk72cmd-"), home = scratch("rovecode-sk72cmd-");
    const src = mkSpecSkill(scratch("rovecode-sk72cmd-"), { unknownKey: false });
    const r = await run(["install", src, "--user"], cwd, { globalDir: join(home, "skills") });
    expect(r.code, r.err.join("\n")).toBe(0);
    expect(existsSync(join(home, "skills", "pdf-processing", "SKILL.md"))).toBe(true);
    expect(existsSync(join(cwd, ".rovecode"))).toBe(false);
    expect((await run(["install", join(cwd, "missing")], cwd)).code).toBe(2);
  });
});

describe("usage", () => {
  test("bare `skills`, an unknown action, a missing operand → the usage on stderr, exit 1, nothing on stdout, nothing created", async () => {
    const cwd = scratch("rovecode-sk72cmd-");
    for (const args of [[], ["frobnicate"], ["validate"], ["pack"], ["install"]]) {
      const r = await run(args, cwd);
      expect(r.code, args.join(" ")).toBe(1);
      expect(r.err).toEqual([SKILLS_USAGE]);
      expect(r.out).toEqual([]);
    }
    expect(existsSync(join(cwd, ".rovecode"))).toBe(false);
  });
});
