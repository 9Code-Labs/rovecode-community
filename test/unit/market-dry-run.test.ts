/** `--dry-run`: the plan, and then nothing.
 *
 *  It sits between the two things that already existed and was missing from both. Without `--yes` on a
 *  terminal you get the plan and a y/N — fine, unless you are in a script. Without `--yes` and without a
 *  terminal you get the plan and exit 1, which is correct as a refusal and useless as a question: a script
 *  that wants to SEE what would happen has to read an error code that means "I would not do this".
 *
 *  So: it is a success, it overrides `--yes` rather than arguing with it, and it fetches nothing. The last
 *  one is the honest limit and the output says it out loud — a git-sourced skill is not cloned, so what you
 *  are shown is the plan and not the repository's contents. */

import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdMarket } from "../../src/cli/market-cmd.ts";
import { skillDir } from "../../src/market/install.ts";
import { manifestPath } from "../../src/market/manifest.ts";
import type { Spawn } from "../../src/plugins/install.ts";

const SKILLS = { version: 1, items: [
  { id: "local-skill", title: "Local skill", publisher: "rovecode", description: "Ships in the catalog.",
    install: { files: [{ path: "SKILL.md", text: "---\nname: local-skill\n---\nbody\n" }] } },
  { id: "remote-skill", title: "Remote skill", publisher: "rovecode", description: "Cloned.",
    install: { source: { git: "https://example.com/skill.git" } } },
] };

function scratch() {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-dry-cwd-"));
  const home = mkdtempSync(join(tmpdir(), "rovecode-dry-home-"));
  writeFileSync(join(home, "skills.json"), JSON.stringify(SKILLS));
  writeFileSync(join(home, "plugins.json"), JSON.stringify({ version: 1, items: [] }));
  const registry = { offline: true, catalogFiles: { skill: join(home, "skills.json"), plugin: join(home, "plugins.json") },
    mcpDocsFile: join(home, "mcp-docs.json"), mcp: { catalog: [], offline: true, home } };
  return { cwd, home, registry, cleanup: () => { rmSync(cwd, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); } };
}

/** a spawn that fails the test the moment anything asks it to run */
const forbidden: Spawn = async (cmd) => { throw new Error(`--dry-run ran a command: ${cmd.join(" ")}`) };

test("the plan is printed, the exit code is a success, and nothing lands on disk", async () => {
  const s = scratch();
  try {
    const out: string[] = [], err: string[] = [];
    const deps = { cwd: s.cwd, home: s.home, registry: s.registry, out: (l: string) => out.push(l), err: (l: string) => err.push(l), tty: false };

    // no TTY and no --yes: without the flag this is exit 1 and "rerun on a terminal"
    expect(await cmdMarket(["install", "skill:local-skill", "--dry-run"], deps)).toBe(0);
    expect(out.join("\n")).toContain("writes");           // the plan really was shown
    expect(out.join("\n")).toContain("nothing written — --dry-run");
    expect(err.join("\n")).not.toContain("rerun on a terminal");

    expect(existsSync(skillDir("local-skill", { scope: "user", cwd: s.cwd, home: s.home }))).toBe(false);
    expect(existsSync(manifestPath("user", s.cwd, s.home))).toBe(false);
  } finally { s.cleanup(); }
});

test("--dry-run beats --yes: between 'show me' and 'go ahead', the one that writes nothing wins", async () => {
  const s = scratch();
  try {
    const out: string[] = [];
    const deps = { cwd: s.cwd, home: s.home, registry: s.registry, out: (l: string) => out.push(l), err: () => {}, tty: true };
    expect(await cmdMarket(["install", "skill:local-skill", "--yes", "--dry-run"], deps)).toBe(0);
    expect(out.join("\n")).toContain("nothing written");
    expect(existsSync(skillDir("local-skill", { scope: "user", cwd: s.cwd, home: s.home }))).toBe(false);
  } finally { s.cleanup(); }
});

test("nothing is fetched, and the output says so rather than implying a check that did not happen", async () => {
  const s = scratch();
  const before = readdirSync(tmpdir()).filter((n) => n.startsWith("rovecode-skill-")).length;
  try {
    const out: string[] = [];
    const deps = { cwd: s.cwd, home: s.home, registry: s.registry, out: (l: string) => out.push(l), err: () => {},
      tty: false, run: { spawn: forbidden } };
    // `forbidden` throws if git is ever invoked; cmdMarket catches, so a silent failure would show as exit 1
    expect(await cmdMarket(["install", "skill:remote-skill", "--dry-run"], deps)).toBe(0);
    expect(out.join("\n")).toContain("The source was not fetched");

    // and a skill that ships its files has nothing to fetch, so it must not claim it skipped anything
    out.length = 0;
    expect(await cmdMarket(["install", "skill:local-skill", "--dry-run"], deps)).toBe(0);
    expect(out.join("\n")).toContain("This is the whole plan");
    expect(out.join("\n")).not.toContain("not fetched");

    // and no clone directory was made and then quietly cleaned up either — none was ever started
    expect(readdirSync(tmpdir()).filter((n) => n.startsWith("rovecode-skill-")).length).toBe(before);
  } finally { s.cleanup(); }
});

test("--json gives the plan as data, marked as a dry run so a caller cannot mistake it for an outcome", async () => {
  const s = scratch();
  try {
    const out: string[] = [];
    const deps = { cwd: s.cwd, home: s.home, registry: s.registry, out: (l: string) => out.push(l), err: () => {}, tty: false };
    expect(await cmdMarket(["install", "skill:local-skill", "--dry-run", "--json"], deps)).toBe(0);
    const plan = JSON.parse(out.join("\n"));
    expect(plan.dryRun).toBe(true);
    expect(plan.item.id).toBe("local-skill");
    expect(plan.scope).toBe("user");
    expect(typeof plan.target).toBe("string");
    expect(Array.isArray(plan.preview)).toBe(true);
    // an install outcome carries `ok`; a dry run must not, or a caller checking `ok` reads a plan as a write
    expect(plan.ok).toBeUndefined();
  } finally { s.cleanup(); }
});

test("`update` takes it too, and a plan that cannot be made is still an error rather than a dry success", async () => {
  const s = scratch();
  try {
    const out: string[] = [], err: string[] = [];
    const deps = { cwd: s.cwd, home: s.home, registry: s.registry, out: (l: string) => out.push(l), err: (l: string) => err.push(l), tty: false };

    expect(await cmdMarket(["install", "skill:local-skill", "--yes"], deps)).toBe(0);
    out.length = 0;
    expect(await cmdMarket(["update", "skill:local-skill", "--dry-run"], deps)).toBe(0);
    expect(out.join("\n")).toContain("nothing written — --dry-run");

    // a name that escapes the skills root is refused at PLAN time; --dry-run must not turn that into a 0
    out.length = 0; err.length = 0;
    expect(await cmdMarket(["install", "skill:local-skill", "--as", "../escape", "--dry-run"], deps)).toBe(1);
    expect(err.join("\n")).toContain("not a usable name");
  } finally { s.cleanup(); }
});

/** Not about --dry-run, but the same seam: the fix that made the dry run's JSON parseable was to stop
 *  printing the human preview above it, and that applies to a real install too. Without this test the
 *  regression would come back the next time someone wanted the plan visible during a scripted install. */
test("a real `install --json` is one document too, not prose followed by an object", async () => {
  const s = scratch();
  try {
    const out: string[] = [];
    const deps = { cwd: s.cwd, home: s.home, registry: s.registry, out: (l: string) => out.push(l), err: () => {}, tty: false };
    expect(await cmdMarket(["install", "skill:local-skill", "--yes", "--json"], deps)).toBe(0);
    const outcome = JSON.parse(out.join("\n"));
    expect(outcome.ok).toBe(true);
    expect(outcome.item.id).toBe("local-skill");
    expect(existsSync(skillDir("local-skill", { scope: "user", cwd: s.cwd, home: s.home }))).toBe(true);
  } finally { s.cleanup(); }
});
