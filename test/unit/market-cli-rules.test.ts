/** The rules the CLI promises, each of which was once only a claim in the usage text:
 *  `--offline` really means no network, `info`/`docs` do not invent a record for a typo, `remove` asks
 *  before it deletes the way `install` asks before it writes, and `--json` carries the same signal in its
 *  exit code that the human-readable form carries in its words.
 *
 *  Hermetic: scratch home and cwd, fixture catalogs, a spawn that FAILS the test if it is ever called. */

import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MarketEntry } from "../../src/mcp/market.ts";
import type { RegistryDeps } from "../../src/market/registry.ts";
import { skillDir } from "../../src/market/install.ts";
import { cmdMarket } from "../../src/cli/market-cmd.ts";
import type { PrereqEnv } from "../../src/market/prereq.ts";

const MCP_CATALOG: readonly MarketEntry[] = [
  { key: "filesystem", title: "Filesystem", source: "curated", publisher: "modelcontextprotocol", description: "Files.",
    installs: [{ kind: "stdio", runtime: "npx", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem"], env: [],
      pending: ["<directory the server may touch>"] }] },
];
const SKILLS = { version: 1, items: [
  { id: "local-skill", title: "Local skill", publisher: "rovecode", description: "Ships in the catalog.",
    install: { files: [{ path: "SKILL.md", text: "---\nname: local-skill\n---\nbody\n" }] } },
  { id: "remote-skill", title: "Remote skill", publisher: "rovecode", description: "Has to be cloned.",
    install: { source: { git: "https://example.com/skill.git" } } },
] };
const PLUGINS = { version: 1, items: [
  { id: "linter", title: "Linter", publisher: "acme", version: "2.0.0", description: "Lints.", install: { source: "https://example.com/linter.git", git: true } },
] };

function scratch() {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-rules-cwd-"));
  const home = mkdtempSync(join(tmpdir(), "rovecode-rules-home-"));
  writeFileSync(join(home, "skills.json"), JSON.stringify(SKILLS));
  writeFileSync(join(home, "plugins.json"), JSON.stringify(PLUGINS));
  const registry: RegistryDeps = { offline: true, catalogFiles: { skill: join(home, "skills.json"), plugin: join(home, "plugins.json") },
    mcpDocsFile: join(home, "mcp-docs.json"), mcp: { catalog: MCP_CATALOG, offline: true, home } };
  return { cwd, home, registry, cleanup: () => { rmSync(cwd, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); } };
}

/** any use of this is the failure: --offline must not reach a clone */
const forbiddenSpawn = async (): Promise<{ code: number; stderr: string }> => {
  throw new Error("the network was used under --offline");
};

test("--offline refuses an install that would have to be fetched, and still allows one that would not", async () => {
  const s = scratch();
  try {
    const out: string[] = [], err: string[] = [];
    const deps = { cwd: s.cwd, home: s.home, registry: s.registry, run: { spawn: forbiddenSpawn },
      out: (l: string) => out.push(l), err: (l: string) => err.push(l), tty: false };

    // a git-backed skill: previously this cloned for real and reported success
    expect(await cmdMarket(["install", "skill:remote-skill", "--offline", "--yes"], deps)).toBe(1);
    expect(err.join("\n")).toContain("--offline");
    expect(err.join("\n")).toContain("would have to be fetched");
    expect(existsSync(skillDir("remote-skill", { scope: "user", cwd: s.cwd, home: s.home }))).toBe(false);

    // a plugin is always a fetch
    err.length = 0;
    expect(await cmdMarket(["install", "plugin:linter", "--offline", "--yes"], deps)).toBe(1);
    expect(err.join("\n")).toContain("would have to be fetched");

    // a catalog skill whose files ship with it needs nothing from the network
    err.length = 0;
    expect(await cmdMarket(["install", "skill:local-skill", "--offline", "--yes"], deps)).toBe(0);
    expect(readFileSync(join(skillDir("local-skill", { scope: "user", cwd: s.cwd, home: s.home }), "SKILL.md"), "utf8")).toContain("body");

    // and an MCP entry is a config write, not a download
    err.length = 0;
    expect(await cmdMarket(["install", "mcp:filesystem", "--offline", "--yes"], deps)).toBe(0);
  } finally { s.cleanup(); }
});

test("`info` and `docs` do not invent a record for a name nobody published", async () => {
  const s = scratch();
  try {
    const out: string[] = [], err: string[] = [];
    const deps = { cwd: s.cwd, home: s.home, registry: s.registry, out: (l: string) => out.push(l), err: (l: string) => err.push(l), tty: false };

    // "totally-bogus-name" looks like an npm package to the installer, and used to come back from `info`
    // as a confident MCP record ("runs npx -y totally-bogus-name") with exit 0
    expect(await cmdMarket(["info", "totally-bogus-name"], deps)).toBe(1);
    expect(err.join("\n")).toContain("not in the catalog or the registry");
    expect(out.join("\n")).not.toContain("npx -y totally-bogus-name");

    err.length = 0;
    expect(await cmdMarket(["docs", "totally-bogus-name"], deps)).toBe(1);
    expect(err.join("\n")).toContain("not in the catalog or the registry");

    // a real catalog name is unaffected
    out.length = 0;
    expect(await cmdMarket(["info", "skill:local-skill"], deps)).toBe(0);
    expect(out.join("\n")).toContain("Local skill");
  } finally { s.cleanup(); }
});

test("`remove` asks before deleting, the way `install` asks before writing", async () => {
  const s = scratch();
  try {
    const out: string[] = [], err: string[] = [];
    const deps = { cwd: s.cwd, home: s.home, registry: s.registry, out: (l: string) => out.push(l), err: (l: string) => err.push(l), tty: false };
    expect(await cmdMarket(["install", "skill:local-skill", "--yes"], deps)).toBe(0);
    const dir = skillDir("local-skill", { scope: "user", cwd: s.cwd, home: s.home });

    // no TTY and no --yes: it names where the thing lives and removes nothing
    err.length = 0;
    expect(await cmdMarket(["remove", "skill:local-skill"], deps)).toBe(1);
    expect(err.join("\n")).toContain("nothing removed");
    expect(err.join("\n")).toContain(dir);
    expect(existsSync(dir)).toBe(true);

    // a terminal that says no also removes nothing
    const asked: string[] = [];
    const saysNo = { ...deps, tty: true, plain: async (p: string) => { asked.push(p); return "n"; } };
    out.length = 0;
    expect(await cmdMarket(["remove", "skill:local-skill"], saysNo)).toBe(1);
    expect(asked.join("")).toContain("remove this?");
    expect(existsSync(dir)).toBe(true);

    // --yes in a script, or a y at the prompt
    expect(await cmdMarket(["remove", "skill:local-skill", "--yes"], deps)).toBe(0);
    expect(existsSync(dir)).toBe(false);
  } finally { s.cleanup(); }
});

test("`search --json` reports 'nothing found' in its exit code, like the text form does", async () => {
  const s = scratch();
  try {
    const out: string[] = [];
    const deps = { cwd: s.cwd, home: s.home, registry: s.registry, out: (l: string) => out.push(l), err: () => {}, tty: false };
    expect(await cmdMarket(["search", "nothing-matches-this", "--json"], deps)).toBe(1);
    expect(JSON.parse(out.join("\n")).items).toEqual([]);
    out.length = 0;
    expect(await cmdMarket(["search", "local", "--json"], deps)).toBe(0);
    expect(JSON.parse(out.join("\n")).items.length).toBeGreaterThan(0);
  } finally { s.cleanup(); }
});

test("one command, one clone: three items from the same repository are fetched once, and the clones do not outlive the command", async () => {
  const s = scratch();
  try {
    // a monorepo publishing three plugins; each install used to clone the whole thing again
    const mono = { version: 1, items: ["alpha", "beta", "gamma"].map((id) => ({
      id, title: id, publisher: "acme", version: "2.0.0", description: `${id} plugin`,
      install: { source: "https://example.com/mono.git", git: true, subfolder: `plugins/${id}` },
    })) };
    writeFileSync(join(s.home, "plugins.json"), JSON.stringify(mono));

    const clonedInto: string[] = [];
    const spawn = async (cmd: string[], cwd: string): Promise<{ code: number; stderr: string }> => {
      clonedInto.push(cwd);
      for (const id of ["alpha", "beta", "gamma"]) {
        const dir = join(cwd, cmd.at(-1) ?? ".", "plugins", id);
        mkdirSync(dir, { recursive: true });
        // older than the catalog's 2.0.0, so `update` has something to do
        writeFileSync(join(dir, "plugin.json"), JSON.stringify({ api: 1, name: id, version: "1.0.0", description: `${id} plugin` }));
      }
      return { code: 0, stderr: "" };
    };
    const out: string[] = [];
    const deps = { cwd: s.cwd, home: s.home, registry: s.registry, run: { spawn }, out: (l: string) => out.push(l), err: () => {}, tty: false };

    // separate commands each pay for their own clone — the cache is per command, on purpose
    for (const id of ["alpha", "beta", "gamma"]) expect(await cmdMarket(["install", `plugin:${id}`, "--yes"], deps)).toBe(0);
    expect(clonedInto.length).toBe(3);
    for (const id of ["alpha", "beta", "gamma"]) expect(existsSync(join(s.home, "plugins", id, "plugin.json"))).toBe(true);

    // ONE command touching all three clones once
    clonedInto.length = 0;
    expect(await cmdMarket(["update", "--all", "--yes", "--yes-plugins"], deps)).toBe(0);
    expect(clonedInto.length).toBe(1);
    for (const id of ["alpha", "beta", "gamma"]) expect(existsSync(join(s.home, "plugins", id, "plugin.json"))).toBe(true);

    // the cache owns its clones, so the command has to have disposed of them
    for (const dir of clonedInto) expect(existsSync(dir)).toBe(false);
  } finally { s.cleanup(); }
});

test("the plan says what has to be on PATH, before the yes rather than as a clone failure after it", async () => {
  const s = scratch();
  try {
    const out: string[] = [];
    // an injected environment, never this developer's PATH: a prerequisite test that reads the real
    // machine tells you about the machine, not about the code
    const withoutGit: PrereqEnv = { PATH: "/nowhere", windows: false, exists: () => false };
    const withGit: PrereqEnv = { PATH: "/usr/bin", windows: false, exists: (p: string) => p === "/usr/bin/git" };

    const deps = { cwd: s.cwd, home: s.home, registry: s.registry, out: (l: string) => out.push(l), err: () => {}, tty: false };
    expect(await cmdMarket(["install", "skill:remote-skill"], { ...deps, prereqEnv: withoutGit })).toBe(1);
    expect(out.join("\n")).toContain("requires   git — not on PATH");

    out.length = 0;
    expect(await cmdMarket(["install", "skill:remote-skill"], { ...deps, prereqEnv: withGit })).toBe(1);
    expect(out.join("\n")).toContain("requires   git ✓");

    // a catalog skill that ships its files needs nothing, so the row is absent rather than blank
    out.length = 0;
    expect(await cmdMarket(["install", "skill:local-skill"], { ...deps, prereqEnv: withoutGit })).toBe(1);
    expect(out.join("\n")).not.toContain("requires");

    // and it is a warning, never a gate: the install still goes through with the tool missing
    out.length = 0;
    expect(await cmdMarket(["install", "skill:local-skill", "--yes"], { ...deps, prereqEnv: withoutGit })).toBe(0);
  } finally { s.cleanup(); }
});

test("the plan uses two different words for two different things, and says each of them once", async () => {
  const s = scratch();
  try {
    const out: string[] = [];
    const noGit: PrereqEnv = { PATH: "/nowhere", windows: false, exists: () => false };
    const deps = { cwd: s.cwd, home: s.home, registry: s.registry, out: (l: string) => out.push(l), err: () => {}, tty: false, prereqEnv: noGit };

    // an MCP entry that wants an argument from the human AND a program on the machine: the two used to
    // arrive as two `needs` rows one under the other, saying entirely different kinds of thing
    expect(await cmdMarket(["install", "mcp:filesystem"], deps)).toBe(1);
    const plan = out.join("\n");
    expect(plan).toContain("requires   npx");          // about the machine
    expect(plan).toContain("fill in    <directory");   // about the human
    expect(plan).not.toContain("needs ");              // the overloaded word is gone entirely

    // and the argument is mentioned ONCE, by the line that also gives the file path
    const mentions = plan.split("\n").filter((l) => l.includes("<directory the server may touch>"));
    expect(mentions.length).toBe(1);
    expect(mentions[0]).toContain("mcp.json");   // the surviving line is the one that says WHERE

    // order: what will run, then what that requires, then what lands on disk, then what is left to you
    const at = (needle: string) => plan.split("\n").findIndex((l) => l.includes(needle));
    expect(at("runs ")).toBeLessThan(at("requires "));
    expect(at("requires ")).toBeLessThan(at("writes "));
    expect(at("writes ")).toBeLessThan(at("fill in "));
  } finally { s.cleanup(); }
});
