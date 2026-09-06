/** The audit's findings, one test each — every one of these was a real behaviour, reproduced before it was
 *  fixed, and none of them had a test. They live in their own file because they are about the seams between
 *  resolve → plan → write rather than about any single module's contract.
 *
 *  Hermetic like market.test.ts: scratch home and cwd, fixture catalogs, injected clone, no network. */

import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MarketEntry } from "../../src/mcp/market.ts";
import { capBytes, itemFromCatalog, searchMarket, type RegistryDeps } from "../../src/market/registry.ts";
import { resolveDirect } from "../../src/market/resolve.ts";
import { installedState, planInstall, removeItem, runInstall, skillDir, validInstallName } from "../../src/market/install.ts";
import { LIMITS, type MarketItem } from "../../src/market/types.ts";
import { cmdMarket, safeForTerminal } from "../../src/cli/market-cmd.ts";

const MCP_CATALOG: readonly MarketEntry[] = [
  { key: "filesystem", title: "Filesystem", source: "curated", publisher: "modelcontextprotocol", description: "Files.",
    installs: [{ kind: "stdio", runtime: "npx", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem"], env: [], pending: [] }] },
  { key: "notes", title: "Notes", source: "curated", publisher: "acme", description: "Notes.",
    installs: [{ kind: "stdio", runtime: "npx", command: "npx", args: ["-y", "notes-server"], env: [], pending: [] }] },
];
const SKILLS = { version: 1, items: [
  { id: "code-review", title: "Code review", publisher: "rovecode", description: "A checklist.",
    install: { files: [{ path: "SKILL.md", text: "---\nname: code-review\n---\nreview it\n" }] } },
] };
const PLUGINS = { version: 1, items: [
  { id: "linter", title: "Linter", publisher: "acme", version: "2.0.0", description: "Lints.", install: { source: "https://example.com/linter.git", git: true } },
] };

function scratch(): { cwd: string; home: string; deps: RegistryDeps; cleanup: () => void } {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-find-cwd-"));
  const home = mkdtempSync(join(tmpdir(), "rovecode-find-home-"));
  writeFileSync(join(home, "skills.json"), JSON.stringify(SKILLS));
  writeFileSync(join(home, "plugins.json"), JSON.stringify(PLUGINS));
  const deps: RegistryDeps = { offline: true, catalogFiles: { skill: join(home, "skills.json"), plugin: join(home, "plugins.json") },
    mcpDocsFile: join(home, "mcp-docs.json"), mcp: { catalog: MCP_CATALOG, offline: true, home } };
  return { cwd, home, deps, cleanup: () => { rmSync(cwd, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); } };
}
const find = (items: MarketItem[], id: string, kind: string): MarketItem => items.find((i) => i.id === id && i.kind === kind)!;
const pluginClone = async (cmd: string[], cwd: string): Promise<{ code: number; stderr: string }> => {
  const dir = join(cwd, cmd.at(-1) ?? ".");   // follow the command: addPlugin clones into "." now
  mkdirSync(dir, { recursive: true });
  // an OLDER version than the catalog's 2.0.0, so `update` sees it as stale
  writeFileSync(join(dir, "plugin.json"), JSON.stringify({ api: 1, name: "linter", version: "1.0.0", description: "Lints." }));
  return { code: 0, stderr: "" };
};

// ---------- what gets installed ----------

test("the requested kind decides, not the shape: `skill:./folder` never installs a PLUGIN", () => {
  // the human asks for a skill (text, nothing runs) and used to be handed CODE rovecode loads into its own
  // process — and, in project scope, records as trusted
  expect(resolveDirect("./my-skill", "skill")).toBeNull();
  expect(resolveDirect("./my-skill", "mcp")).toBeNull();
  expect(resolveDirect("./my-skill", "plugin")).toMatchObject({ kind: "plugin" });
  expect(resolveDirect("./my-skill")).toMatchObject({ kind: "plugin" });     // unqualified is still a plugin
  expect(resolveDirect("https://example.com/x.git", "mcp")).toBeNull();      // a repo is not an MCP server
  expect(resolveDirect("https://example.com/x.git", "skill")).toMatchObject({ kind: "skill" });
});

test("an npm install is named the way it is written, so list and remove find the same entry", async () => {
  const s = scratch();
  try {
    const it = resolveDirect("@modelcontextprotocol/server-github")!;
    expect(it.id).toBe("server-github");     // was "github", which nothing downstream could find
    const opts = { scope: "user" as const, cwd: s.cwd, home: s.home };
    const plan = planInstall(it, opts);
    if ("error" in plan) throw new Error(plan.error);
    expect((await runInstall(plan, {}, opts)).ok).toBe(true);
    expect(installedState(it, s.cwd, s.home)).toBeDefined();
    expect(removeItem(it, s.cwd, s.home)).toMatchObject({ ok: true });
  } finally { s.cleanup(); }
});

// ---------- where it gets installed ----------

test("`--as` is a name, not a path — it cannot escape the skills folder", async () => {
  const s = scratch();
  try {
    const skill = find((await searchMarket("", s.deps)).items, "code-review", "skill");
    // "../../../head-pwned" really did write outside ROVECODE_HOME, and "" targeted the skills root
    for (const as of ["../../../head-pwned", "", "C:/Windows/x", "a/b", "a\\b", "..", ".", "  "]) {
      expect(validInstallName(as)).toBe(false);
      expect("error" in planInstall(skill, { scope: "user", cwd: s.cwd, home: s.home, as })).toBe(true);
    }
    expect(validInstallName("renamed-1.2")).toBe(true);
    expect("error" in planInstall(skill, { scope: "user", cwd: s.cwd, home: s.home, as: "renamed-1.2" })).toBe(false);
    expect(existsSync(join(s.home, "..", "head-pwned"))).toBe(false);
  } finally { s.cleanup(); }
});

test("`--as` is refused on a plugin rather than silently ignored", async () => {
  const s = scratch();
  try {
    const plan = planInstall(find((await searchMarket("", s.deps)).items, "linter", "plugin"),
      { scope: "user", cwd: s.cwd, home: s.home, as: "something-else" });
    expect("error" in plan).toBe(true);
    if ("error" in plan) expect(plan.error).toContain("--as does not apply to a plugin");
  } finally { s.cleanup(); }
});

// ---------- the flags the user actually passed ----------

test("--force is honoured rather than demanded back", async () => {
  const s = scratch();
  try {
    const out: string[] = [], err: string[] = [];
    const deps = { cwd: s.cwd, home: s.home, registry: s.deps, out: (l: string) => out.push(l), err: (l: string) => err.push(l), tty: false };
    expect(await cmdMarket(["install", "skill:code-review", "--yes"], deps)).toBe(0);
    const file = join(skillDir("code-review", { scope: "user", cwd: s.cwd, home: s.home }), "SKILL.md");
    writeFileSync(file, "edited");

    err.length = 0;
    expect(await cmdMarket(["install", "skill:code-review", "--yes"], deps)).toBe(1);
    expect(err.join("\n")).toContain("already exists");
    expect(readFileSync(file, "utf8")).toBe("edited");

    // the plan said "replaces …" and the write then asked for the flag that was already passed
    expect(await cmdMarket(["install", "skill:code-review", "--yes", "--force"], deps)).toBe(0);
    expect(readFileSync(file, "utf8")).toContain("review it");
  } finally { s.cleanup(); }
});

test("`update --all --yes` does not re-run every plugin's code without asking", async () => {
  const s = scratch();
  try {
    const out: string[] = [];
    const deps = { cwd: s.cwd, home: s.home, registry: s.deps, run: { spawn: pluginClone }, out: (l: string) => out.push(l), err: () => {}, tty: false };
    expect(await cmdMarket(["install", "plugin:linter", "--yes"], deps)).toBe(0);

    out.length = 0;
    expect(await cmdMarket(["update", "--all", "--yes"], deps)).toBe(0);
    expect(out.join("\n")).toContain("1 plugin skipped");
    expect(out.join("\n")).toContain("--yes-plugins");
    expect(out.join("\n")).not.toContain("updated plugin:linter");

    out.length = 0;
    expect(await cmdMarket(["update", "--all", "--yes", "--yes-plugins"], deps)).toBe(0);
    expect(out.join("\n")).toContain("updated plugin:linter");
  } finally { s.cleanup(); }
});

// ---------- what survives a failure ----------

test("a failed skill write leaves the installed copy alone instead of deleting it first", async () => {
  const s = scratch();
  try {
    const good = find((await searchMarket("", s.deps)).items, "code-review", "skill");
    const opts = { scope: "user" as const, cwd: s.cwd, home: s.home };
    const first = planInstall(good, opts);
    if ("error" in first) throw new Error(first.error);
    await runInstall(first, {}, opts);
    const file = join(skillDir("code-review", { scope: "user", cwd: s.cwd, home: s.home }), "SKILL.md");

    const evil: MarketItem = { ...good, install: { kind: "skill", files: [{ path: "SKILL.md", text: "x" }, { path: "nested/../../escape.md", text: "x" }] } };
    const plan = planInstall(evil, opts);
    if ("error" in plan) throw new Error(plan.error);
    expect((await runInstall(plan, {}, opts, { force: true })).ok).toBe(false);
    expect(readFileSync(file, "utf8")).toContain("review it");            // the previous version survived
    expect(existsSync(join(s.home, "skills", "escape.md"))).toBe(false);
  } finally { s.cleanup(); }
});

test("a skill with no SKILL.md is refused at planning, not installed into invisibility", async () => {
  const s = scratch();
  try {
    const base = find((await searchMarket("", s.deps)).items, "code-review", "skill");
    const noSkillMd: MarketItem = { ...base, install: { kind: "skill", files: [{ path: "README.md", text: "x" }] } };
    const plan = planInstall(noSkillMd, { scope: "user", cwd: s.cwd, home: s.home });
    expect("error" in plan).toBe(true);
    if ("error" in plan) expect(plan.error).toContain("SKILL.md");
  } finally { s.cleanup(); }
});

// ---------- what removal leaves behind ----------

test("removing one server keeps the project file's trust; removing a plugin drops its trust entry", async () => {
  const s = scratch();
  try {
    const items = (await searchMarket("", s.deps)).items;
    const opts = { scope: "project" as const, cwd: s.cwd, home: s.home };
    for (const id of ["filesystem", "notes"]) {
      const plan = planInstall(find(items, id, "mcp"), opts);
      if ("error" in plan) throw new Error(plan.error);
      await runInstall(plan, {}, opts, { force: true });
    }
    expect(installedState(find(items, "filesystem", "mcp"), s.cwd, s.home)).toMatchObject({ trusted: true });
    removeItem(find(items, "notes", "mcp"), s.cwd, s.home);
    // the survivor must not drop to "not approved" merely because the file it lives in changed
    expect(installedState(find(items, "filesystem", "mcp"), s.cwd, s.home)).toMatchObject({ trusted: true });

    const linter = find(items, "linter", "plugin");
    const pOpts = { scope: "user" as const, cwd: s.cwd, home: s.home };
    const pPlan = planInstall(linter, pOpts);
    if ("error" in pPlan) throw new Error(pPlan.error);
    await runInstall(pPlan, {}, pOpts, { spawn: pluginClone });
    const dir = installedState(linter, s.cwd, s.home)!.path;
    expect(removeItem(linter, s.cwd, s.home)).toMatchObject({ ok: true });
    expect(existsSync(dir)).toBe(false);
    // a trust record pointing at a folder that no longer exists is what the next install gets compared to
    const state = JSON.parse(readFileSync(join(s.home, "plugins.json"), "utf8")) as { trusted?: Record<string, string> };
    expect(Object.keys(state.trusted ?? {}).some((k) => k.toLowerCase().includes("linter"))).toBe(false);
  } finally { s.cleanup(); }
});

// ---------- what reaches the terminal ----------

test("`market docs` cannot repaint the terminal: control characters are stripped before printing", async () => {
  const s = scratch();
  try {
    const nasty = "# Title\n\u001b[2J\u001b]0;pwned\u0007hidden\u001b[8m secret \u0000 end\n";
    writeFileSync(join(s.home, "skills.json"), JSON.stringify({ version: 1, items: [{ ...SKILLS.items[0]!,
      docs: { source: "https://example.com/x.md", format: "markdown", bytes: 100, truncated: false, body: nasty } }] }));
    const out: string[] = [];
    const deps = { cwd: s.cwd, home: s.home, registry: s.deps, out: (l: string) => out.push(l), err: () => {}, tty: false };
    expect(await cmdMarket(["docs", "skill:code-review"], deps)).toBe(0);
    const printed = out.join("\n");
    expect(printed).toContain("# Title");
    expect(printed).toContain("hidden");                                        // the words survive
    expect(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(printed)).toBe(false);  // the escapes do not
    expect(safeForTerminal("a\u001b[31mb")).toBe("a[31mb");
  } finally { s.cleanup(); }
});

test("the documentation cap counts BYTES, not UTF-16 units, and never cuts a surrogate pair in half", () => {
  // 24576 emoji is 24576 UTF-16 units per .slice() but ~98 KB on the wire: a character-based cap lets a
  // body through at four times the limit it was meant to enforce
  const emoji = "\u{1F600}".repeat(20_000);
  const capped = capBytes(emoji, LIMITS.docs);
  expect(Buffer.byteLength(capped, "utf8")).toBeLessThanOrEqual(LIMITS.docs);
  expect(capped.length % 2).toBe(0);                       // whole pairs only
  expect([...capped].every((c) => c === "\u{1F600}")).toBe(true);   // no half character survived
  expect(capBytes("plain ascii", LIMITS.docs)).toBe("plain ascii");  // under the cap is untouched

  const notes: string[] = [];
  const it = itemFromCatalog("skill", { id: "big", description: "x", install: { files: [{ path: "SKILL.md", text: "x" }] },
    docs: { source: "https://example.com/x.md", format: "markdown", bytes: 999_999, truncated: true, body: emoji } }, notes);
  expect(Buffer.byteLength(it!.docs!.body!, "utf8")).toBeLessThanOrEqual(LIMITS.docs);
});
