/** The one market over three kinds (src/market/**): what a catalog is allowed to contribute, what an
 *  ambiguous name does, what the human is shown before anything is written, and that every path works
 *  with the network switched off. Hermetic: scratch home + cwd, fixture catalogs, an injected MCP
 *  catalog and `offline: true`, an injected clone — no network, no `C:/`, no readdir-order assumptions. */

import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MarketEntry } from "../../src/mcp/market.ts";
import { itemFromCatalog, searchMarket, findItem, type RegistryDeps } from "../../src/market/registry.ts";
import { resolveTarget, resolveDirect } from "../../src/market/resolve.ts";
import { installedState, planInstall, removeItem, runInstall, skillDir, withInstalled } from "../../src/market/install.ts";
import { parseQualifiedId, qualify, type MarketItem } from "../../src/market/types.ts";
import { cmdMarket } from "../../src/cli/market-cmd.ts";

// ---------- fixtures ----------

const MCP_CATALOG: readonly MarketEntry[] = [
  { key: "filesystem", title: "Filesystem", source: "curated", publisher: "modelcontextprotocol", description: "Files under the directories you name.",
    installs: [{ kind: "stdio", runtime: "npx", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem"], env: [], pending: ["<directory>"] }] },
  { key: "notes", title: "Notes", source: "curated", publisher: "acme", description: "A notes server that wants a key.",
    installs: [{ kind: "stdio", runtime: "npx", command: "npx", args: ["-y", "notes-server"], env: [{ name: "NOTES_TOKEN", required: true, secret: true }], pending: [] }] },
];

const SKILLS = {
  version: 1,
  items: [
    { id: "code-review", title: "Code review", publisher: "rovecode", description: "A checklist for reviewing a diff.",
      tags: ["Review", "Quality"], install: { files: [{ path: "SKILL.md", text: "---\nname: code-review\nversion: 2.0\n---\nreview it\n" }] } },
    // shares its id with a plugin below: the ambiguity case
    { id: "shared", title: "Shared skill", publisher: "rovecode", description: "Same name in two kinds.",
      install: { files: [{ path: "SKILL.md", text: "# shared\n" }] } },
  ],
};

const PLUGINS = {
  version: 1,
  items: [
    { id: "shared", title: "Shared plugin", publisher: "rovecode", description: "Same name in two kinds.", install: { source: "https://example.com/shared.git", git: true } },
    { id: "linter", title: "Linter", publisher: "acme", version: "2.0.0", description: "Lints on save.", repository: "https://example.com/linter", install: { source: "https://example.com/linter.git", git: true } },
  ],
};

function scratch(): { cwd: string; home: string; deps: RegistryDeps; cleanup: () => void } {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-market-cwd-"));
  const home = mkdtempSync(join(tmpdir(), "rovecode-market-home-"));
  const skills = join(home, "skills.json"), plugins = join(home, "plugins.json");
  writeFileSync(skills, JSON.stringify(SKILLS));
  writeFileSync(plugins, JSON.stringify(PLUGINS));
  // mcpDocsFile points into the scratch home ON PURPOSE: left unset it would read the SHIPPED
  // src/market/catalogs/mcp-docs.json, and then whether a test passes depends on whether a real
  // upstream README happens to exist today. A test writes the sidecar it wants.
  const deps: RegistryDeps = { offline: true, catalogFiles: { skill: skills, plugin: plugins },
    mcpDocsFile: join(home, "mcp-docs.json"), mcp: { catalog: MCP_CATALOG, offline: true, home } };
  return { cwd, home, deps, cleanup: () => { rmSync(cwd, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); } };
}

const item = (items: MarketItem[], id: string, kind: string): MarketItem => items.find((i) => i.id === id && i.kind === kind)!;

// ---------- untrusted catalog data ----------

test("a catalog row is re-typed field by field: caps applied, bad rows skipped with a note, one bad row never blanks the file", () => {
  const notes: string[] = [];
  const long = "x".repeat(5000);
  const ok = itemFromCatalog("skill", { id: "good", description: long, title: long, publisher: long, tags: Array.from({ length: 100 }, (_, i) => `T${i}`), install: { files: [{ path: "SKILL.md", text: "hi" }] } }, notes);
  expect(ok).not.toBeNull();
  expect(ok!.description.length).toBe(500);   // LIMITS.desc
  expect(ok!.title.length).toBe(300);         // LIMITS.str
  expect(ok!.tags.length).toBe(32);           // LIMITS.list
  expect(ok!.tags[0]).toBe("t0");             // lowercased

  // an id that is not a slug, a missing description, and a number where a string belongs
  expect(itemFromCatalog("skill", { id: "Not A Slug", description: "x", install: { files: [{ path: "SKILL.md", text: "x" }] } }, notes)).toBeNull();
  expect(itemFromCatalog("skill", { id: "nodesc", install: { files: [{ path: "SKILL.md", text: "x" }] } }, notes)).toBeNull();
  expect(itemFromCatalog("skill", { id: "weird", description: 42, install: { files: [] } }, notes)).toBeNull();
  expect(itemFromCatalog("plugin", { id: "nosource", description: "x" }, notes)).toBeNull();
  expect(notes.length).toBeGreaterThanOrEqual(4);
});

test("a catalog cannot write outside the item's own folder, and a plugin source must be a real URL", () => {
  const notes: string[] = [];
  for (const path of ["../../evil.md", "/etc/passwd", "C:/Windows/evil", "a/../../b"]) {
    expect(itemFromCatalog("skill", { id: "escape", description: "x", install: { files: [{ path, text: "x" }] } }, notes)).toBeNull();
  }
  expect(itemFromCatalog("skill", { id: "sub", description: "x", install: { source: { git: "https://example.com/x.git", subfolder: "../out" } } }, notes)).toBeNull();
  expect(itemFromCatalog("plugin", { id: "js", description: "x", install: { source: "javascript:alert(1)", git: true } }, notes)).toBeNull();
  // a plugin's subfolder is bounded by the same rule as a skill's
  for (const sub of ["../out", "/etc", "C:/Windows", "a/../../b"]) {
    expect(itemFromCatalog("plugin", { id: "mono", description: "x", install: { source: "https://example.com/x.git", git: true, subfolder: sub } }, notes)).toBeNull();
  }
  expect(notes.every((n) => n.includes("skipped"))).toBe(true);
});

test("a plugin in a monorepo subfolder, and the licence, survive the validator and reach the human", () => {
  const notes: string[] = [];
  const it = itemFromCatalog("plugin", {
    id: "safety-net", description: "Guards a repo.", license: "Apache-2.0",
    install: { source: "https://example.com/rovecode.git", git: true, subfolder: "plugins/safety-net" },
  }, notes);
  expect(it).not.toBeNull();
  expect(it!.license).toBe("Apache-2.0");
  expect(it!.install).toMatchObject({ kind: "plugin", subfolder: "plugins/safety-net" });
  expect(notes).toEqual([]);
  // both reach the approval preview, which is the only place they matter
  const home = mkdtempSync(join(tmpdir(), "rovecode-market-lic-"));
  try {
    const plan = planInstall(it!, { scope: "user", cwd: home, home });
    if ("error" in plan) throw new Error(plan.error);
    const preview = plan.preview.join("\n");
    expect(preview).toContain("licence    Apache-2.0");
    expect(preview).toContain("(subfolder plugins/safety-net)");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("a licence a publisher states in its own words is carried verbatim, not normalised", () => {
  const notes: string[] = [];
  const it = itemFromCatalog("skill", { id: "docx", description: "x", license: "source-available, not open source",
    install: { files: [{ path: "SKILL.md", text: "x" }] } }, notes);
  expect(it!.license).toBe("source-available, not open source");
  const none = itemFromCatalog("skill", { id: "nolic", description: "x", install: { files: [{ path: "SKILL.md", text: "x" }] } }, notes);
  expect(none!.license).toBeUndefined();   // absent, never guessed
});

test("a broken catalog file is one dead source, not an exception — the other sources still answer", async () => {
  const s = scratch();
  try {
    const bad = join(s.home, "broken.json");
    writeFileSync(bad, "{ this is not json");
    const r = await searchMarket("", { ...s.deps, catalogFiles: { ...s.deps.catalogFiles, skill: bad } });
    expect(r.sources.skills).toEqual({ ok: false, reason: "skills catalog is not valid JSON" });
    expect(r.sources.plugins).toMatchObject({ ok: true });
    expect(r.items.some((i) => i.kind === "plugin")).toBe(true);   // plugins survived
    expect(r.items.some((i) => i.kind === "skill")).toBe(false);
  } finally { s.cleanup(); }
});

test("a catalog that is not in the tree yet is not an error", async () => {
  const s = scratch();
  try {
    const r = await searchMarket("", { ...s.deps, catalogFiles: { skill: join(s.home, "absent.json"), plugin: join(s.home, "plugins.json") } });
    expect(r.sources.skills).toMatchObject({ ok: true });
    expect(r.items.some((i) => i.kind === "plugin")).toBe(true);
  } finally { s.cleanup(); }
});

// ---------- search, offline ----------

test("offline, every source still answers from disk: three kinds in one list, and the registry says it was not consulted", async () => {
  const s = scratch();
  try {
    const r = await searchMarket("", s.deps);
    expect(new Set(r.items.map((i) => i.kind))).toEqual(new Set(["mcp", "skill", "plugin"]));
    expect(r.sources["mcp:registry"]).toMatchObject({ ok: true, from: "skipped" });
    expect(Object.values(r.sources).every((x) => x.ok)).toBe(true);
    // the MCP entry is WRAPPED, not rewritten
    const fs = item(r.items, "filesystem", "mcp");
    expect(fs.install).toMatchObject({ kind: "mcp" });
    if (fs.install.kind === "mcp") expect(fs.install.entry).toBe(MCP_CATALOG[0]!);
  } finally { s.cleanup(); }
});

test("search matches id, title, description and tags across kinds", async () => {
  const s = scratch();
  try {
    expect((await searchMarket("review", s.deps)).items.map(qualify)).toEqual(["skill:code-review"]);
    expect((await searchMarket("quality", s.deps)).items.map(qualify)).toEqual(["skill:code-review"]); // by tag
    expect((await searchMarket("lints on save", s.deps)).items.map(qualify)).toEqual(["plugin:linter"]);
    expect((await searchMarket("nothing-like-this", s.deps)).items).toEqual([]);
  } finally { s.cleanup(); }
});

// ---------- resolving ----------

test("an id owned by two kinds is a question, never a coin toss", async () => {
  const s = scratch();
  try {
    const r = await resolveTarget("shared", s.deps);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.ambiguous!.map(qualify).sort()).toEqual(["plugin:shared", "skill:shared"]);
      expect(r.error).toContain("exists in 2 kinds");
    }
    // qualifying it resolves
    const one = await resolveTarget("skill:shared", s.deps);
    expect(one.ok && one.item.kind).toBe("skill");
  } finally { s.cleanup(); }
});

test("a git URL, an npm package and a local folder resolve without a catalog; a catalog name is never re-read as a package", async () => {
  const s = scratch();
  try {
    const git = await resolveTarget("https://example.com/thing.git", s.deps);
    expect(git.ok && git.item).toMatchObject({ kind: "plugin", id: "thing", install: { kind: "plugin", git: true } });
    const skill = await resolveTarget("skill:https://example.com/thing.git", s.deps);
    expect(skill.ok && skill.item.kind).toBe("skill");
    // the id is the name the server is WRITTEN under, or list/remove would look for the wrong entry
    const npm = resolveDirect("@modelcontextprotocol/server-github");
    expect(npm).toMatchObject({ kind: "mcp", id: "server-github" });
    expect(npm!.install.kind === "mcp" && npm!.install.entry.installs[0]).toMatchObject({ command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] });
    // "filesystem" is a curated MCP id and must stay that, not become an npm package
    const named = await resolveTarget("filesystem", s.deps);
    expect(named.ok && named.item.source).toBe("curated");
  } finally { s.cleanup(); }
});

test("an unknown name suggests instead of failing blankly", async () => {
  const s = scratch();
  try {
    const r = await resolveTarget("revie", s.deps);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("skill:code-review");
  } finally { s.cleanup(); }
});

test("parseQualifiedId", () => {
  expect(parseQualifiedId("mcp:filesystem")).toEqual({ kind: "mcp", id: "filesystem" });
  expect(parseQualifiedId("filesystem")).toEqual({ id: "filesystem" });
  expect(parseQualifiedId("  ")).toBeNull();
});

// ---------- the plan is shown before anything is written ----------

test("planning writes NOTHING and shows what will happen, in words that differ per kind", async () => {
  const s = scratch();
  try {
    const items = (await searchMarket("", s.deps)).items;
    const opts = { scope: "user" as const, cwd: s.cwd, home: s.home };

    const skill = planInstall(item(items, "code-review", "skill"), opts);
    expect("error" in skill).toBe(false);
    if ("error" in skill) throw new Error(skill.error);
    expect(skill.preview.join("\n")).toContain("Files only: nothing here is executed");
    expect(skill.preview.join("\n")).toContain("SKILL.md");
    expect(skill.target).toBe(skillDir("code-review", { ...opts }));

    const plugin = planInstall(item(items, "linter", "plugin"), opts);
    if ("error" in plugin) throw new Error(plugin.error);
    expect(plugin.preview.join("\n")).toContain("a folder of CODE that rovecode loads and RUNS");
    expect(plugin.preview.join("\n")).toContain("git clone --depth 1 https://example.com/linter.git");

    const mcp = planInstall(item(items, "notes", "mcp"), opts);
    if ("error" in mcp) throw new Error(mcp.error);
    expect(mcp.preview.join("\n")).toContain("npx -y notes-server");
    expect(mcp.asks.map((a) => a.name)).toEqual(["NOTES_TOKEN"]);   // asked, not silently written

    // nothing on disk from any of that
    expect(existsSync(join(s.home, "skills"))).toBe(false);
    expect(existsSync(join(s.home, "plugins"))).toBe(false);
    expect(existsSync(join(s.home, "mcp.json"))).toBe(false);
  } finally { s.cleanup(); }
});

// ---------- installing, per kind ----------

test("a skill installs as files and nothing else; installed state and removal follow", async () => {
  const s = scratch();
  try {
    const items = (await searchMarket("", s.deps)).items;
    const it = item(items, "code-review", "skill");
    const opts = { scope: "user" as const, cwd: s.cwd, home: s.home };
    const plan = planInstall(it, opts);
    if ("error" in plan) throw new Error(plan.error);
    const outcome = await runInstall(plan, {}, opts);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(readFileSync(join(outcome.target, "SKILL.md"), "utf8")).toContain("review it");
    expect(outcome.envNames).toEqual([]);
    expect(outcome.next).toContain("skills are indexed at startup");

    const state = installedState(it, s.cwd, s.home);
    expect(state).toMatchObject({ scope: "user", version: "2.0" });
    // the catalog has no version for this row, so no update is claimed
    expect(state!.updateAvailable).toBeUndefined();
    expect(withInstalled([it], s.cwd, s.home)[0]!.installed).toBeDefined();

    expect(removeItem(it, s.cwd, s.home)).toMatchObject({ ok: true });
    expect(existsSync(state!.path)).toBe(false);
    expect(installedState(it, s.cwd, s.home)).toBeUndefined();
  } finally { s.cleanup(); }
});

test("a plugin install runs the real installer through an injected clone — no network, and a bad clone is a result, not a throw", async () => {
  const s = scratch();
  try {
    const items = (await searchMarket("", s.deps)).items;
    const it = item(items, "linter", "plugin");
    const opts = { scope: "user" as const, cwd: s.cwd, home: s.home };
    const plan = planInstall(it, opts);
    if ("error" in plan) throw new Error(plan.error);

    const failing = await runInstall(plan, {}, opts, { spawn: async () => ({ code: 128, stderr: "fatal: repository not found" }) });
    expect(failing).toMatchObject({ ok: false });
    if (!failing.ok) expect(failing.error).toContain("git clone failed");

    // a clone that produces a real plugin folder
    const outcome = await runInstall(plan, {}, opts, {
      spawn: async (cmd, cwd) => {
        const dir = join(cwd, cmd.at(-1) ?? ".");   // follow the command: addPlugin clones into "." now
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "plugin.json"), JSON.stringify({ api: 1, name: "linter", version: "2.0.0", description: "Lints on save." }));
        return { code: 0, stderr: "" };
      },
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(existsSync(join(outcome.target, "plugin.json"))).toBe(true);
    expect(installedState(it, s.cwd, s.home)).toMatchObject({ scope: "user", version: "2.0.0" });
  } finally { s.cleanup(); }
});

test("an MCP install goes through the existing planner: the file is written, a secret is never in it, project scope records trust", async () => {
  const s = scratch();
  try {
    const items = (await searchMarket("", s.deps)).items;
    const it = item(items, "notes", "mcp");
    const opts = { scope: "project" as const, cwd: s.cwd, home: s.home };
    const plan = planInstall(it, opts);
    if ("error" in plan) throw new Error(plan.error);
    const outcome = await runInstall(plan, { NOTES_TOKEN: "a-real-secret" }, opts);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const written = readFileSync(outcome.target, "utf8");
    expect(written).not.toContain("a-real-secret");     // a project file never holds the value
    expect(written).toContain("${NOTES_TOKEN}");
    expect(outcome.envNames).toEqual(["NOTES_TOKEN"]);
    expect(outcome.trusted).toBe(true);                  // the human approved this exact content
    expect(installedState(it, s.cwd, s.home)).toMatchObject({ scope: "project", trusted: true });
  } finally { s.cleanup(); }
});

// ---------- the CLI ----------

test("the CLI: search prints rows, --json carries sources, an ambiguous install exits 2 without writing, --yes installs", async () => {
  const s = scratch();
  try {
    const out: string[] = [], err: string[] = [];
    const deps = { cwd: s.cwd, home: s.home, registry: s.deps, out: (l: string) => out.push(l), err: (l: string) => err.push(l), tty: false };

    expect(await cmdMarket(["search", "review"], deps)).toBe(0);
    expect(out.join("\n")).toContain("Code review");

    out.length = 0;
    expect(await cmdMarket(["search", "--json"], deps)).toBe(0);
    const parsed = JSON.parse(out.join("\n")) as { items: unknown[]; sources: Record<string, unknown> };
    expect(parsed.items.length).toBeGreaterThan(0);
    expect(parsed.sources["mcp:registry"]).toMatchObject({ ok: true, from: "skipped" });

    // ambiguous → exit 2, nothing written
    out.length = 0; err.length = 0;
    expect(await cmdMarket(["install", "shared"], deps)).toBe(2);
    expect(err.join("\n")).toContain("exists in 2 kinds");
    expect(existsSync(join(s.home, "skills", "shared"))).toBe(false);

    // no TTY and no --yes → the plan is shown and nothing is written
    out.length = 0; err.length = 0;
    expect(await cmdMarket(["install", "skill:code-review"], deps)).toBe(1);
    expect(out.join("\n")).toContain("nothing here is executed");
    expect(err.join("\n")).toContain("--yes");
    expect(existsSync(skillDir("code-review", { scope: "user", cwd: s.cwd, home: s.home }))).toBe(false);

    // --yes installs
    out.length = 0; err.length = 0;
    expect(await cmdMarket(["install", "skill:code-review", "--yes"], deps)).toBe(0);
    expect(existsSync(join(skillDir("code-review", { scope: "user", cwd: s.cwd, home: s.home }), "SKILL.md"))).toBe(true);
    expect(out.join("\n")).toContain("installed skill:code-review");

    // list shows it, remove undoes it
    out.length = 0;
    expect(await cmdMarket(["list"], deps)).toBe(0);
    expect(out.join("\n")).toContain("[installed]");
    out.length = 0;
    expect(await cmdMarket(["remove", "skill:code-review", "--yes"], deps)).toBe(0);   // remove asks, like install
    expect(existsSync(skillDir("code-review", { scope: "user", cwd: s.cwd, home: s.home }))).toBe(false);

    // unknown flag and unknown subcommand are usage errors
    expect(await cmdMarket(["search", "--nope"], deps)).toBe(2);
    expect(await cmdMarket(["frobnicate"], deps)).toBe(2);
    expect(await cmdMarket([], deps)).toBe(2);
  } finally { s.cleanup(); }
});

test("the CLI: sources reports every source, and a dead one makes it exit 1", async () => {
  const s = scratch();
  try {
    const out: string[] = [];
    const bad = join(s.home, "broken.json");
    writeFileSync(bad, "nope");
    const deps = { cwd: s.cwd, home: s.home, out: (l: string) => out.push(l), err: () => {}, tty: false,
      registry: { ...s.deps, catalogFiles: { ...s.deps.catalogFiles, skill: bad } } };
    expect(await cmdMarket(["sources"], deps)).toBe(1);
    expect(out.join("\n")).toContain("FAILED");
    expect(out.join("\n")).toContain("not consulted");
  } finally { s.cleanup(); }
});

test("findItem is exact and offline for catalog kinds", async () => {
  const s = scratch();
  try {
    expect((await findItem("skill", "code-review", s.deps)).item?.title).toBe("Code review");
    expect((await findItem("skill", "code-revie", s.deps)).item).toBeUndefined();
    expect((await findItem("plugin", "linter", s.deps)).item?.version).toBe("2.0.0");
  } finally { s.cleanup(); }
});

// ---------- update ----------

test("update lists what is stale, names the items whose version nobody can compare, and installs only when asked", async () => {
  const s = scratch();
  try {
    const out: string[] = [], err: string[] = [];
    const deps = { cwd: s.cwd, home: s.home, registry: s.deps, out: (l: string) => out.push(l), err: (l: string) => err.push(l), tty: false };
    // install the skill (SKILL.md says version 2.0; the catalog row states none)
    expect(await cmdMarket(["install", "skill:code-review", "--yes"], deps)).toBe(0);

    out.length = 0;
    expect(await cmdMarket(["update"], deps)).toBe(0);
    const listed = out.join("\n");
    // not silently skipped: it says WHY it cannot compare, and that updating reinstalls
    expect(listed).toContain("skill:code-review");
    expect(listed).toContain("version unknown");
    expect(listed).toContain("the catalog states none");
    expect(listed).toContain("updating reinstalls it");

    // the dry list wrote nothing new: still the originally installed bytes
    const file = join(skillDir("code-review", { scope: "user", cwd: s.cwd, home: s.home }), "SKILL.md");
    writeFileSync(file, "edited by hand");
    out.length = 0; err.length = 0;

    // no TTY and no --yes: the plan is shown, nothing is written
    expect(await cmdMarket(["update", "skill:code-review"], deps)).toBe(1);
    expect(out.join("\n")).toContain("nothing here is executed");
    expect(readFileSync(file, "utf8")).toBe("edited by hand");

    // with --yes it really reinstalls, over the top, without needing --force from the caller
    out.length = 0;
    expect(await cmdMarket(["update", "skill:code-review", "--yes"], deps)).toBe(0);
    expect(readFileSync(file, "utf8")).toContain("review it");
    expect(out.join("\n")).toContain("updated skill:code-review");
  } finally { s.cleanup(); }
});

test("update refuses an id that is not installed, and updates in the scope the item lives in", async () => {
  const s = scratch();
  try {
    const out: string[] = [], err: string[] = [];
    const deps = { cwd: s.cwd, home: s.home, registry: s.deps, out: (l: string) => out.push(l), err: (l: string) => err.push(l), tty: false };
    expect(await cmdMarket(["update", "skill:code-review"], deps)).toBe(1);
    expect(err.join("\n")).toContain("is not installed here");

    // installed into the PROJECT scope; `update` must not quietly move it to the user scope
    expect(await cmdMarket(["install", "skill:code-review", "--project", "--yes"], deps)).toBe(0);
    const projectFile = join(skillDir("code-review", { scope: "project", cwd: s.cwd, home: s.home }), "SKILL.md");
    expect(existsSync(projectFile)).toBe(true);
    out.length = 0;
    expect(await cmdMarket(["update", "--all", "--yes"], deps)).toBe(0);
    expect(existsSync(projectFile)).toBe(true);
    expect(existsSync(skillDir("code-review", { scope: "user", cwd: s.cwd, home: s.home }))).toBe(false);
  } finally { s.cleanup(); }
});

// ---------- documentation carried in the catalog ----------

const DOC = "# Code review\n\nA checklist.\n";

test("a good docs block survives; bytes/truncated describe upstream, not what we carry", () => {
  const notes: string[] = [];
  const it = itemFromCatalog("skill", {
    id: "documented", description: "x", install: { files: [{ path: "SKILL.md", text: "x" }] },
    docs: { source: "https://example.com/SKILL.md", format: "markdown", bytes: 84_000, truncated: true, body: DOC },
  }, notes);
  expect(it!.docs).toMatchObject({ source: "https://example.com/SKILL.md", format: "markdown", bytes: 84_000, truncated: true, body: DOC });
  expect(notes).toEqual([]);
  // no docs at all is a normal row, not a broken one
  const plain = itemFromCatalog("skill", { id: "plain", description: "x", install: { files: [{ path: "SKILL.md", text: "x" }] } }, notes);
  expect(plain).not.toBeNull();
  expect(plain!.docs).toBeUndefined();
  expect(notes).toEqual([]);
});

test("a broken docs block drops the DOCS, never the row, and says which item and why", () => {
  const base = { id: "item", description: "x", install: { files: [{ path: "SKILL.md", text: "x" }] } };
  for (const [docs, why] of [
    [{ source: "ftp://example.com/x.md", format: "markdown", bytes: 10, truncated: false, body: DOC }, "http(s)"],
    [{ source: "https://example.com/x.md", format: "html", bytes: 10, truncated: false, body: DOC }, "markdown"],
    [{ source: "https://example.com/x.md", format: "markdown", bytes: 10, truncated: false, body: "   " }, "empty"],
  ] as const) {
    const notes: string[] = [];
    const it = itemFromCatalog("skill", { ...base, docs }, notes);
    expect(it).not.toBeNull();              // the row survives — a moved README is not an uninstallable item
    expect(it!.docs).toBeUndefined();
    expect(notes.join(" ")).toContain(why);
    expect(notes.join(" ")).toContain("the row stays");
  }
});

test("a 24 KB body is not silently cut to a label, and a junk `bytes` is replaced by what we can see", () => {
  const notes: string[] = [];
  const big = "#".repeat(30_000);
  const it = itemFromCatalog("skill", {
    id: "big", description: "x", install: { files: [{ path: "SKILL.md", text: "x" }] },
    docs: { source: "https://example.com/x.md", format: "markdown", bytes: 30_000, truncated: true, body: big },
  }, notes);
  expect(it!.docs!.body!.length).toBe(24 * 1024);   // LIMITS.docs, not LIMITS.str's 300
  expect(it!.docs!.bytes).toBe(30_000);

  // bytes that is junk, negative, absurd or smaller than the body: trust the body we can measure
  for (const bytes of [undefined, -5, Number.NaN, "12", {}, 1]) {
    const n2: string[] = [];
    const d = itemFromCatalog("skill", { ...{ id: "b", description: "x", install: { files: [{ path: "SKILL.md", text: "x" }] } },
      docs: { source: "https://example.com/x.md", format: "markdown", bytes, truncated: false, body: DOC } }, n2)!.docs!;
    expect(d.bytes).toBe(Buffer.byteLength(DOC, "utf8"));
    expect(d.truncated).toBe(false);
  }
});

test("the search path carries docs metadata but not the body; asking for one item carries it", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-docs-cwd-"));
  const home = mkdtempSync(join(tmpdir(), "rovecode-docs-home-"));
  try {
    const skills = join(home, "skills.json");
    writeFileSync(skills, JSON.stringify({ version: 1, items: [{ ...SKILLS.items[0]!,
      docs: { source: "https://example.com/SKILL.md", format: "markdown", bytes: 84_000, truncated: true, body: DOC } }] }));
    const deps: RegistryDeps = { offline: true, catalogFiles: { skill: skills, plugin: join(home, "none.json") }, mcp: { catalog: [], offline: true, home } };

    const searched = (await searchMarket("", deps)).items.find((i) => i.kind === "skill")!;
    expect(searched.docs).toMatchObject({ bytes: 84_000, truncated: true, source: "https://example.com/SKILL.md" });
    expect(searched.docs!.body).toBeUndefined();   // NOT "" — a UI must not read this as an empty document

    const one = (await findItem("skill", "code-review", deps)).item!;
    expect(one.docs!.body).toBe(DOC);
  } finally { rmSync(cwd, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("MCP docs ride in as a sidecar keyed by the curated key; a missing file is silently no docs", async () => {
  const home = mkdtempSync(join(tmpdir(), "rovecode-mcpdocs-"));
  try {
    const sidecar = join(home, "mcp-docs.json");
    writeFileSync(sidecar, JSON.stringify({ docs: { filesystem: { source: "https://example.com/fs.md", format: "markdown", bytes: 500, truncated: false, body: "# Filesystem\n" } } }));
    const base: RegistryDeps = { offline: true, catalogFiles: { skill: join(home, "a.json"), plugin: join(home, "b.json") }, mcp: { catalog: MCP_CATALOG, offline: true, home } };

    const withDocs = (await searchMarket("", { ...base, mcpDocsFile: sidecar })).items.find((i) => i.id === "filesystem")!;
    expect(withDocs.docs).toMatchObject({ source: "https://example.com/fs.md", bytes: 500 });
    expect(withDocs.docs!.body).toBeUndefined();                       // search path again: metadata only
    expect((await searchMarket("", { ...base, mcpDocsFile: sidecar })).items.find((i) => i.id === "notes")!.docs).toBeUndefined();
    const one = (await findItem("mcp", "filesystem", { ...base, mcpDocsFile: sidecar })).item!;
    expect(one.docs!.body).toBe("# Filesystem\n");

    // no sidecar at all: MCP rows simply have no docs, and nothing complains
    const none = (await searchMarket("", { ...base, mcpDocsFile: join(home, "absent.json") })).items.find((i) => i.id === "filesystem")!;
    expect(none.docs).toBeUndefined();
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("the CLI: `market docs` prints the body, says when it is truncated, and exits 1 with a pointer when there is none", async () => {
  const s = scratch();
  try {
    const skills = join(s.home, "skills.json");
    writeFileSync(skills, JSON.stringify({ version: 1, items: [{ ...SKILLS.items[0]!, repository: "https://example.com/repo",
      docs: { source: "https://example.com/SKILL.md", format: "markdown", bytes: 84_000, truncated: true, body: DOC } }] }));
    const registry: RegistryDeps = { ...s.deps, catalogFiles: { ...s.deps.catalogFiles, skill: skills } };
    const out: string[] = [], err: string[] = [];
    const deps = { cwd: s.cwd, home: s.home, registry, out: (l: string) => out.push(l), err: (l: string) => err.push(l), tty: false };

    expect(await cmdMarket(["docs", "skill:code-review"], deps)).toBe(0);
    expect(out.join("\n")).toBe(DOC);
    expect(err.join("\n")).toContain("truncated: 82.0 KB upstream");

    out.length = 0; err.length = 0;
    expect(await cmdMarket(["docs", "mcp:filesystem"], deps)).toBe(1);
    expect(err.join("\n")).toContain("carries no documentation");

    out.length = 0;
    expect(await cmdMarket(["docs", "skill:code-review", "--json"], deps)).toBe(0);
    expect(JSON.parse(out.join("\n")).docs.body).toBe(DOC);

    out.length = 0;
    expect(await cmdMarket(["info", "skill:code-review"], deps)).toBe(0);
    expect(out.join("\n")).toContain("docs       82.0 KB from https://example.com/SKILL.md (truncated)");

    expect(await cmdMarket(["docs"], deps)).toBe(2);
  } finally { s.cleanup(); }
});

test("the SHIPPED mcp-docs.json is shaped the way the reader expects — a silent mismatch is the worst failure here", () => {
  // This one deliberately reads the real file. Not to assert that any particular server has documentation
  // (upstream moves, and that is not this test's business) but to catch the failure mode where the
  // generator's shape and the reader's expectations drift apart: nothing throws, nothing is logged, and
  // every MCP row quietly loses its docs.
  const file = join(import.meta.dir, "..", "..", "src", "market", "catalogs", "mcp-docs.json");
  if (!existsSync(file)) return;                       // the sidecar is optional by design
  const raw = JSON.parse(readFileSync(file, "utf8")) as { docs?: Record<string, unknown> };
  expect(raw.docs).toBeDefined();
  const keys = Object.keys(raw.docs!);
  expect(keys.length).toBeGreaterThan(0);

  // every entry survives the validator this repo actually uses — not a re-implementation of it
  // (bun's two-argument expect(value, message) upsets the matcher that follows it, so failures are
  //  named by collecting them instead)
  const notes: string[] = [];
  const rejected: string[] = [];
  for (const [key, value] of Object.entries(raw.docs!)) {
    const item = itemFromCatalog("skill", { id: "probe", description: "x", install: { files: [{ path: "SKILL.md", text: "x" }] }, docs: value }, notes);
    if (!item?.docs) rejected.push(key);
  }
  expect(rejected).toEqual([]);   // any name here is an entry the reader would silently drop
  expect(notes).toEqual([]);

  // the keys are curated shelf names, so they can actually attach to a row
  const curated = readFileSync(join(import.meta.dir, "..", "..", "src", "mcp", "market-catalog.ts"), "utf8");
  const shelf = new Set([...curated.matchAll(/\{ key: "([^"]+)"/g)].map((m) => m[1]!));
  const orphans = keys.filter((k) => !shelf.has(k));
  expect(orphans).toEqual([]);    // a key no curated entry uses attaches to nothing

});
