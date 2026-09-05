/** The digest: what actually landed, so drift can be detected later.
 *
 *  `--ref` pins what was asked for; this is what arrived. The distinction matters in what the tests claim:
 *  a digest DETECTS CHANGE, it does not prove provenance, and none of these tests pretend otherwise. */

import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digestOf, verifyDigest, verifyLine } from "../../src/market/digest.ts";
import { planInstall, runInstall, skillDir } from "../../src/market/install.ts";
import { recordFor } from "../../src/market/manifest.ts";
import { findItem, type RegistryDeps } from "../../src/market/registry.ts";
import { cmdMarket } from "../../src/cli/market-cmd.ts";

const SKILLS = { version: 1, items: [
  { id: "local-skill", title: "Local skill", publisher: "rovecode", description: "Ships in the catalog.",
    install: { files: [{ path: "SKILL.md", text: "---\nname: local-skill\n---\nbody\n" }, { path: "extra/notes.md", text: "notes\n" }] } },
] };

function scratch() {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-dig-cwd-"));
  const home = mkdtempSync(join(tmpdir(), "rovecode-dig-home-"));
  writeFileSync(join(home, "skills.json"), JSON.stringify(SKILLS));
  writeFileSync(join(home, "plugins.json"), JSON.stringify({ version: 1, items: [] }));
  const registry: RegistryDeps = { offline: true, catalogFiles: { skill: join(home, "skills.json"), plugin: join(home, "plugins.json") },
    mcpDocsFile: join(home, "mcp-docs.json"), mcp: { catalog: [], offline: true, home } };
  return { cwd, home, registry, cleanup: () => { rmSync(cwd, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); } };
}

function tree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-tree-"));
  for (const [rel, text] of Object.entries(files)) {
    const full = join(dir, ...rel.split("/"));
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, text);
  }
  return dir;
}

// ---------- what the hash covers ----------

test("the same content hashes the same, and any real difference changes it", () => {
  const a = tree({ "SKILL.md": "one\n", "extra/notes.md": "two\n" });
  const b = tree({ "SKILL.md": "one\n", "extra/notes.md": "two\n" });
  try {
    expect(digestOf(a)!.value).toBe(digestOf(b)!.value);
    expect(digestOf(a)!.files).toBe(2);

    // content
    writeFileSync(join(b, "SKILL.md"), "one changed\n");
    expect(digestOf(b)!.value).not.toBe(digestOf(a)!.value);

    // the NAME is part of it: moving content to another file is a change, not a coincidence
    const c = tree({ "SKILL.md": "one\n", "extra/renamed.md": "two\n" });
    expect(digestOf(c)!.value).not.toBe(digestOf(a)!.value);
    rmSync(c, { recursive: true, force: true });

    // line endings are NOT normalised — CRLF really is different content
    const d = tree({ "SKILL.md": "one\r\n", "extra/notes.md": "two\n" });
    expect(digestOf(d)!.value).not.toBe(digestOf(a)!.value);
    rmSync(d, { recursive: true, force: true });
  } finally { rmSync(a, { recursive: true, force: true }); rmSync(b, { recursive: true, force: true }); }
});

test("`.git` is excluded, so a clone and a copy of the same tree agree", () => {
  const withGit = tree({ "SKILL.md": "one\n", ".git/HEAD": "ref: refs/heads/main\n", ".git/config": "[core]\n" });
  const without = tree({ "SKILL.md": "one\n" });
  try {
    expect(digestOf(withGit)!.value).toBe(digestOf(without)!.value);
    expect(digestOf(withGit)!.files).toBe(1);
  } finally { rmSync(withGit, { recursive: true, force: true }); rmSync(without, { recursive: true, force: true }); }
});

test("a missing path has no digest — 'deleted' and 'emptied' must not look alike", () => {
  const empty = mkdtempSync(join(tmpdir(), "rovecode-empty-"));
  try {
    expect(digestOf(join(empty, "not-there"))).toBeUndefined();
    expect(digestOf(empty)).toMatchObject({ files: 0 });   // an empty folder DOES have one
  } finally { rmSync(empty, { recursive: true, force: true }); }
});

// ---------- the four verdicts ----------

test("verifyDigest names the four states and never confuses two of them", () => {
  const dir = tree({ "SKILL.md": "one\n" });
  try {
    const recorded = digestOf(dir)!;
    expect(verifyDigest(recorded, dir)).toMatchObject({ state: "unchanged" });

    writeFileSync(join(dir, "SKILL.md"), "edited\n");
    const changed = verifyDigest(recorded, dir);
    expect(changed.state).toBe("changed");
    if (changed.state === "changed") expect(changed.now.value).not.toBe(changed.recorded.value);

    // nothing recorded is NOT a failure — it is what an old or hand-made install looks like
    expect(verifyDigest(undefined, dir)).toMatchObject({ state: "unrecorded" });

    const gone = join(dir, "..", "definitely-not-here");
    expect(verifyDigest(recorded, gone)).toMatchObject({ state: "missing" });
    expect(verifyDigest(recorded, undefined)).toMatchObject({ state: "not-applicable" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("verifyLine says which is which, in words", () => {
  const d = { algo: "sha256" as const, value: "a".repeat(64), files: 3 };
  expect(verifyLine("skill:x", { state: "unchanged", digest: d })).toContain("unchanged (3 files)");
  expect(verifyLine("skill:x", { state: "changed", recorded: d, now: { ...d, value: "b".repeat(64), files: 4 } })).toContain("CHANGED since install");
  expect(verifyLine("skill:x", { state: "missing", recorded: d })).toContain("gone from disk");
  expect(verifyLine("skill:x", { state: "unrecorded" })).toContain("no digest recorded");
  expect(verifyLine("mcp:x", { state: "not-applicable", why: "a line in a shared file" })).toContain("a line in a shared file");
});

// ---------- end to end ----------

test("an install records a digest, and `market verify` notices a hand edit afterwards", async () => {
  const s = scratch();
  try {
    const item = (await findItem("skill", "local-skill", s.registry)).item!;
    const opts = { scope: "user" as const, cwd: s.cwd, home: s.home };
    const plan = planInstall(item, opts);
    if ("error" in plan) throw new Error(plan.error);
    expect((await runInstall(plan, {}, opts)).ok).toBe(true);

    const record = recordFor(item, "user", s.cwd, s.home)!;
    expect(record.digest).toMatchObject({ algo: "sha256", files: 2 });
    expect(record.digest!.value).toHaveLength(64);

    const out: string[] = [], err: string[] = [];
    const deps = { cwd: s.cwd, home: s.home, registry: s.registry, out: (l: string) => out.push(l), err: (l: string) => err.push(l), tty: false };
    expect(await cmdMarket(["verify"], deps)).toBe(0);
    expect(out.join("\n")).toContain("unchanged (2 files)");

    // someone edits the installed skill by hand — a perfectly reasonable thing to do, and worth knowing
    const file = join(skillDir("local-skill", { scope: "user", cwd: s.cwd, home: s.home }), "SKILL.md");
    writeFileSync(file, readFileSync(file, "utf8") + "\nmy own note\n");
    out.length = 0; err.length = 0;
    expect(await cmdMarket(["verify"], deps)).toBe(1);
    expect(out.join("\n")).toContain("CHANGED since install");
    expect(err.join("\n")).toContain("or keep the edit");   // an edit is not an accusation

    // and reinstalling settles it
    out.length = 0;
    expect(await cmdMarket(["install", "skill:local-skill", "--yes", "--force"], deps)).toBe(0);
    out.length = 0;
    expect(await cmdMarket(["verify"], deps)).toBe(0);
    expect(out.join("\n")).toContain("unchanged");
  } finally { s.cleanup(); }
});

test("`market verify` reports a removed folder, and says nothing at all when nothing is installed", async () => {
  const s = scratch();
  try {
    const out: string[] = [];
    const deps = { cwd: s.cwd, home: s.home, registry: s.registry, out: (l: string) => out.push(l), err: () => {}, tty: false };
    expect(await cmdMarket(["verify"], deps)).toBe(0);
    expect(out.join("\n")).toContain("nothing installed through the market yet");

    expect(await cmdMarket(["install", "skill:local-skill", "--yes"], deps)).toBe(0);
    const dir = skillDir("local-skill", { scope: "user", cwd: s.cwd, home: s.home });
    // moved aside rather than removed through the market, so the record survives
    renameSync(dir, `${dir}-moved`);
    out.length = 0;
    expect(await cmdMarket(["verify"], deps)).toBe(1);
    expect(out.join("\n")).toContain("gone from disk");
    expect(existsSync(`${dir}-moved`)).toBe(true);

    // an id that was never installed is a question with an answer, not silence
    out.length = 0;
    expect(await cmdMarket(["verify", "skill:nope"], deps)).toBe(1);
    expect(out.join("\n")).toContain('nothing recorded for "skill:nope"');
  } finally { s.cleanup(); }
});
