/** The failures that happen between two lines of code, and the ones nobody writes a test for.
 *
 *  Every case here is about a write that does not finish: a copy that dies half way, a manifest that cannot
 *  be written, a clone whose `git` is not on the machine. They share a shape — the operation fails, and the
 *  question under test is what the DISK looks like afterwards, not what the function returned. An install
 *  that reports an error and has already deleted the previous version is worse than one that refuses.
 *
 *  The copy step is injected for exactly this reason. A real half-finished copy needs a full disk or a file
 *  another process holds open; a fake one needs a function that throws on the second call. */

import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdMarket } from "../../src/cli/market-cmd.ts";
import { planInstall, runInstall, skillDir } from "../../src/market/install.ts";
import { manifestPath, recordFor } from "../../src/market/manifest.ts";
import { findItem, type RegistryDeps } from "../../src/market/registry.ts";
import { addPlugin, cloneKey, type Spawn } from "../../src/plugins/install.ts";

const MONO = "https://example.com/mono.git";

const SKILLS = { version: 1, items: [
  { id: "mono-skill", title: "Mono skill", publisher: "rovecode", description: "From the monorepo.",
    install: { source: { git: MONO, subfolder: "skills/mono-skill" } } },
] };
const PLUGINS = { version: 1, items: [
  { id: "mono-plugin", title: "Mono plugin", publisher: "rovecode", version: "1.0.0", description: "From the same monorepo.",
    install: { source: MONO, git: true, subfolder: "plugins/mono-plugin" } },
] };

function scratch() {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-atom-cwd-"));
  const home = mkdtempSync(join(tmpdir(), "rovecode-atom-home-"));
  writeFileSync(join(home, "skills.json"), JSON.stringify(SKILLS));
  writeFileSync(join(home, "plugins.json"), JSON.stringify(PLUGINS));
  const registry: RegistryDeps = { offline: true, catalogFiles: { skill: join(home, "skills.json"), plugin: join(home, "plugins.json") },
    mcpDocsFile: join(home, "mcp-docs.json"), mcp: { catalog: [], offline: true, home } };
  return { cwd, home, registry, cleanup: () => { rmSync(cwd, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); } };
}

/** a `git clone` that writes the monorepo's two folders instead of talking to a network */
function fakeMonorepo(body = "one\n"): { spawn: Spawn; clones: number } {
  const state = { clones: 0 };
  const spawn: Spawn = async (cmd, cwd) => {
    if (cmd[1] === "clone" || cmd[1] === "fetch") {
      if (cmd[1] === "clone") state.clones += 1;
      mkdirSync(join(cwd, "skills", "mono-skill"), { recursive: true });
      writeFileSync(join(cwd, "skills", "mono-skill", "SKILL.md"), `---\nname: mono-skill\n---\n${body}`);
      mkdirSync(join(cwd, "plugins", "mono-plugin"), { recursive: true });
      writeFileSync(join(cwd, "plugins", "mono-plugin", "plugin.json"), JSON.stringify({ api: 1, name: "mono-plugin", version: "1.0.0", entry: "index.ts" }));
      mkdirSync(join(cwd, ".git"), { recursive: true });
      writeFileSync(join(cwd, ".git", "HEAD"), "aa11bb22cc33dd44ee55ff66aa77bb88cc99dd00\n");
    }
    return { code: 0, stderr: "" };
  };
  return { spawn, get clones() { return state.clones; } };
}

const skillsRoot = (home: string) => join(home, "skills");
const stagingLeft = (root: string) => (existsSync(root) ? readdirSync(root).filter((n) => n.startsWith(".rovecode-")) : []);

// ---------------------------------------------------------------- a copy that dies half way

test("a skill reinstall whose copy fails leaves the OLD skill exactly as it was", async () => {
  const s = scratch();
  try {
    const item = (await findItem("skill", "mono-skill", s.registry)).item!;
    const opts = { scope: "user" as const, cwd: s.cwd, home: s.home };
    const plan = planInstall(item, opts);
    if ("error" in plan) throw new Error(plan.error);

    expect((await runInstall(plan, {}, opts, { spawn: fakeMonorepo("first version\n").spawn })).ok).toBe(true);
    const file = join(skillDir("mono-skill", opts), "SKILL.md");
    expect(readFileSync(file, "utf8")).toContain("first version");

    // now a second install of DIFFERENT content, and the copy gives up part way through
    const plan2 = planInstall(item, opts);
    if ("error" in plan2) throw new Error(plan2.error);
    const outcome = await runInstall(plan2, {}, opts, {
      spawn: fakeMonorepo("second version\n").spawn,
      force: true,
      copy: () => { throw new Error("ENOSPC: no space left on device"); },
    });

    expect(outcome.ok).toBe(false);
    // the point of the whole exercise: the working copy is still the working copy
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8")).toContain("first version");
    // and no half-built folder is left wearing a name someone might mistake for a skill
    expect(stagingLeft(skillsRoot(s.home))).toEqual([]);
  } finally { s.cleanup(); }
});

test("a plugin reinstall whose copy fails leaves the OLD plugin exactly as it was", async () => {
  const s = scratch();
  try {
    const src = mkdtempSync(join(tmpdir(), "rovecode-atom-src-"));
    writeFileSync(join(src, "plugin.json"), JSON.stringify({ api: 1, name: "keeper", version: "1.0.0", entry: "index.ts" }));
    writeFileSync(join(src, "note.txt"), "first version\n");
    const opts = { cwd: s.cwd, home: s.home, scope: "user" as const };

    const first = await addPlugin(src, opts);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const note = join(first.dir, "note.txt");
    expect(readFileSync(note, "utf8")).toContain("first version");

    writeFileSync(join(src, "note.txt"), "second version\n");
    const second = await addPlugin(src, { ...opts, force: true, copy: () => { throw new Error("EBUSY: resource busy or locked") } });
    expect(second.ok).toBe(false);

    expect(readFileSync(note, "utf8")).toContain("first version");
    expect(stagingLeft(join(s.home, "plugins"))).toEqual([]);
    rmSync(src, { recursive: true, force: true });
  } finally { s.cleanup(); }
});

// ---------------------------------------------------------------- a manifest that cannot be written

test("an install still succeeds when the manifest cannot be written — provenance is a note, not a gate", async () => {
  const s = scratch();
  try {
    // a DIRECTORY where installed.json belongs: every write to it is an EISDIR, which is as close as a
    // test can get to a read-only home without asking the CI runner for permissions it may not have
    mkdirSync(manifestPath("user", s.cwd, s.home), { recursive: true });

    const item = (await findItem("skill", "mono-skill", s.registry)).item!;
    const opts = { scope: "user" as const, cwd: s.cwd, home: s.home };
    const plan = planInstall(item, opts);
    if ("error" in plan) throw new Error(plan.error);

    const outcome = await runInstall(plan, {}, opts, { spawn: fakeMonorepo().spawn });
    expect(outcome.ok).toBe(true);
    expect(existsSync(join(skillDir("mono-skill", opts), "SKILL.md"))).toBe(true);

    // no record, and asking for one is answered rather than thrown
    expect(recordFor(item, "user", s.cwd, s.home)).toBeUndefined();

    // and the commands that READ the manifest survive its absence too
    const out: string[] = [];
    const deps = { cwd: s.cwd, home: s.home, registry: s.registry, out: (l: string) => out.push(l), err: () => {}, tty: false };
    expect(await cmdMarket(["verify"], deps)).toBe(0);
    expect(await cmdMarket(["list"], deps)).toBe(0);
  } finally { s.cleanup(); }
});

// ---------------------------------------------------------------- removing what is not there

test("`market remove` for something that was never installed says so, and touches nothing", async () => {
  const s = scratch();
  try {
    const out: string[] = [], err: string[] = [];
    const deps = { cwd: s.cwd, home: s.home, registry: s.registry, out: (l: string) => out.push(l), err: (l: string) => err.push(l), tty: false };

    expect(await cmdMarket(["remove", "skill:mono-skill", "--yes"], deps)).toBe(1);
    expect(`${out.join("\n")}\n${err.join("\n")}`).toContain("not installed");
    expect(existsSync(skillDir("mono-skill", { scope: "user", cwd: s.cwd, home: s.home }))).toBe(false);

    // an id that is not in any catalog is a different sentence, and also not a crash
    out.length = 0; err.length = 0;
    expect(await cmdMarket(["remove", "skill:no-such-thing", "--yes"], deps)).toBe(1);
    expect(`${out.join("\n")}\n${err.join("\n")}`).not.toBe("\n");
  } finally { s.cleanup(); }
});

// ---------------------------------------------------------------- one repository, two kinds

test("a skill and a plugin out of ONE repository are cloned once, not twice", async () => {
  const s = scratch();
  try {
    // the two halves live in different modules and compute the key separately; if they ever disagree the
    // cache silently stops working and only a clone COUNT notices
    expect(cloneKey(MONO)).toBe(cloneKey(MONO, undefined));

    const repo = fakeMonorepo();
    const cloneCache = new Map<string, string>();
    const opts = { scope: "user" as const, cwd: s.cwd, home: s.home };

    for (const [kind, id] of [["skill", "mono-skill"], ["plugin", "mono-plugin"]] as const) {
      const item = (await findItem(kind, id, s.registry)).item!;
      const plan = planInstall(item, opts);
      if ("error" in plan) throw new Error(plan.error);
      const outcome = await runInstall(plan, {}, opts, { spawn: repo.spawn, cloneCache });
      expect(outcome.ok).toBe(true);
    }

    expect(repo.clones).toBe(1);
    expect(existsSync(join(skillDir("mono-skill", opts), "SKILL.md"))).toBe(true);
    expect(existsSync(join(s.home, "plugins", "mono-plugin", "plugin.json"))).toBe(true);
  } finally { s.cleanup(); }
});

// ---------------------------------------------------------------- git is not on this machine

test("a spawn that THROWS leaves no temp clone behind — no git on PATH is an ENOENT, not an exit code", async () => {
  const s = scratch();
  const before = new Set(readdirSync(tmpdir()).filter((n) => n.startsWith("rovecode-skill-")));
  try {
    const item = (await findItem("skill", "mono-skill", s.registry)).item!;
    const opts = { scope: "user" as const, cwd: s.cwd, home: s.home };
    const plan = planInstall(item, opts);
    if ("error" in plan) throw new Error(plan.error);

    const spawn: Spawn = async () => { throw Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" }) };
    await runInstall(plan, {}, opts, { spawn }).catch(() => undefined);

    const after = readdirSync(tmpdir()).filter((n) => n.startsWith("rovecode-skill-") && !before.has(n));
    expect(after).toEqual([]);
  } finally { s.cleanup(); }
});
