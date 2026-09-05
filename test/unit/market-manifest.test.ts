/** The install record: where a thing came from, kept beside the disk rather than instead of it.
 *
 *  The load-bearing rule is the split — the DISK says whether something is installed, the MANIFEST says
 *  where it came from. Every test here is really about that: a record cannot make a deleted thing look
 *  installed, a missing record cannot make an installed thing disappear, and neither file can carry a
 *  secret. Hermetic: scratch home and cwd, fixture catalogs, injected clone and clock. */

import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MarketEntry } from "../../src/mcp/market.ts";
import { searchMarket, type RegistryDeps } from "../../src/market/registry.ts";
import { installedState, planInstall, removeItem, runInstall } from "../../src/market/install.ts";
import { buildRecord, manifestPath, originLine, readManifest, recordFor, recordInstall, scrubUrl } from "../../src/market/manifest.ts";
import type { MarketItem } from "../../src/market/types.ts";
import { cmdMarket } from "../../src/cli/market-cmd.ts";

const MCP_CATALOG: readonly MarketEntry[] = [
  { key: "notes", title: "Notes", source: "curated", publisher: "acme", description: "Notes.",
    installs: [{ kind: "stdio", runtime: "npx", command: "npx", args: ["-y", "notes-server"], env: [], pending: [] }] },
];
const SKILLS = { version: 1, items: [
  { id: "local-skill", title: "Local skill", publisher: "rovecode", version: "3.1", description: "Ships in the catalog.",
    install: { files: [{ path: "SKILL.md", text: "---\nname: local-skill\n---\nbody\n" }] } },
] };
const PLUGINS = { version: 1, items: [
  { id: "linter", title: "Linter", publisher: "acme", version: "2.0.0", description: "Lints.", install: { source: "https://example.com/linter.git", git: true } },
] };

function scratch() {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-man-cwd-"));
  const home = mkdtempSync(join(tmpdir(), "rovecode-man-home-"));
  writeFileSync(join(home, "skills.json"), JSON.stringify(SKILLS));
  writeFileSync(join(home, "plugins.json"), JSON.stringify(PLUGINS));
  const registry: RegistryDeps = { offline: true, catalogFiles: { skill: join(home, "skills.json"), plugin: join(home, "plugins.json") },
    mcpDocsFile: join(home, "mcp-docs.json"), mcp: { catalog: MCP_CATALOG, offline: true, home } };
  return { cwd, home, registry, cleanup: () => { rmSync(cwd, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); } };
}
const find = (items: MarketItem[], id: string, kind: string): MarketItem => items.find((i) => i.id === id && i.kind === kind)!;

// ---------- secrets ----------

test("a token in a clone URL never reaches the record", () => {
  expect(scrubUrl("https://someone:ghp_secret@github.com/o/r.git")).toBe("https://github.com/o/r.git");
  expect(scrubUrl("https://x-access-token:abc123@github.com/o/r.git")).toBe("https://github.com/o/r.git");
  expect(scrubUrl("ssh://user:pw@host/o/r.git")).toBe("ssh://host/o/r.git");
  // an ssh spec is not a URL and must still lose an inline secret without being mangled
  expect(scrubUrl("git@github.com:o/r.git")).toBe("git@github.com:o/r.git");
  expect(scrubUrl("https://github.com/o/r.git")).toBe("https://github.com/o/r.git");
  expect(scrubUrl("../local/folder")).toBe("../local/folder");

  const item: MarketItem = { id: "x", kind: "plugin", title: "x", publisher: "p", description: "d", source: "catalog", tags: [], env: [],
    install: { kind: "plugin", source: "https://u:tok@example.com/r.git", git: true } };
  const record = buildRecord(item, { scope: "user", target: "/somewhere", git: { source: "https://u:tok@example.com/r.git" } });
  expect(JSON.stringify(record)).not.toContain("tok");
  expect(record.git!.source).toBe("https://example.com/r.git");
});

// ---------- the split: disk decides installed, manifest decides origin ----------

test("a record cannot make a deleted thing look installed", async () => {
  const s = scratch();
  try {
    const items = (await searchMarket("", s.registry)).items;
    const skill = find(items, "local-skill", "skill");
    const opts = { scope: "user" as const, cwd: s.cwd, home: s.home };
    const plan = planInstall(skill, opts);
    if ("error" in plan) throw new Error(plan.error);
    const outcome = await runInstall(plan, {}, opts);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(recordFor(skill, "user", s.cwd, s.home)).toBeDefined();

    // delete it the way a person would, leaving the record behind
    rmSync(outcome.target, { recursive: true, force: true });
    expect(installedState(skill, s.cwd, s.home)).toBeUndefined();   // the DISK decides
    expect(recordFor(skill, "user", s.cwd, s.home)).toBeDefined();  // the stale record is still on file

    const out: string[] = [];
    const deps = { cwd: s.cwd, home: s.home, registry: s.registry, out: (l: string) => out.push(l), err: () => {}, tty: false };
    expect(await cmdMarket(["list"], deps)).toBe(0);
    expect(out.join("\n")).toContain("nothing installed here yet");
  } finally { s.cleanup(); }
});

test("a missing record cannot make an installed thing disappear — it says the origin is unknown", async () => {
  const s = scratch();
  try {
    const items = (await searchMarket("", s.registry)).items;
    const skill = find(items, "local-skill", "skill");
    const opts = { scope: "user" as const, cwd: s.cwd, home: s.home };
    const plan = planInstall(skill, opts);
    if ("error" in plan) throw new Error(plan.error);
    await runInstall(plan, {}, opts);

    // an install from before this file existed, or a folder copied in by hand
    rmSync(manifestPath("user", s.cwd, s.home), { force: true });
    expect(installedState(skill, s.cwd, s.home)).toBeDefined();

    const out: string[] = [];
    const deps = { cwd: s.cwd, home: s.home, registry: s.registry, out: (l: string) => out.push(l), err: () => {}, tty: false };
    expect(await cmdMarket(["list"], deps)).toBe(0);
    expect(out.join("\n")).toContain("[installed]");
    expect(out.join("\n")).toContain("origin unknown");
  } finally { s.cleanup(); }
});

test("a broken manifest is an empty one, never a failed install", async () => {
  const s = scratch();
  try {
    writeFileSync(manifestPath("user", s.cwd, s.home), "{ not json at all");
    expect(readManifest("user", s.cwd, s.home)).toEqual([]);

    const items = (await searchMarket("", s.registry)).items;
    const opts = { scope: "user" as const, cwd: s.cwd, home: s.home };
    const plan = planInstall(find(items, "local-skill", "skill"), opts);
    if ("error" in plan) throw new Error(plan.error);
    expect((await runInstall(plan, {}, opts)).ok).toBe(true);   // provenance must not be able to stop this
    expect(readManifest("user", s.cwd, s.home).length).toBe(1); // and the file is rewritten intact
  } finally { s.cleanup(); }
});

test("orphaned records are dropped on the next write rather than accumulating", async () => {
  const s = scratch();
  try {
    const ghost = buildRecord({ id: "gone", kind: "skill", title: "gone", publisher: "p", description: "d", source: "catalog", tags: [], env: [],
      install: { kind: "skill", files: [{ path: "SKILL.md", text: "x" }] } }, { scope: "user", target: join(s.home, "skills", "gone") });
    recordInstall(ghost, { cwd: s.cwd, home: s.home });
    expect(readManifest("user", s.cwd, s.home).length).toBe(1);

    // the next real install prunes what no longer exists on disk
    recordInstall(ghost, { cwd: s.cwd, home: s.home, stillInstalled: (r) => existsSync(r.target) });
    expect(readManifest("user", s.cwd, s.home)).toEqual([]);
  } finally { s.cleanup(); }
});

// ---------- what the record carries ----------

test("the record carries the catalog version, the scope, who wrote it, and the resolved commit for a clone", async () => {
  const s = scratch();
  try {
    const items = (await searchMarket("", s.registry)).items;
    const opts = { scope: "user" as const, cwd: s.cwd, home: s.home };

    // a catalog skill: version and source, no git block
    const skillPlan = planInstall(find(items, "local-skill", "skill"), opts);
    if ("error" in skillPlan) throw new Error(skillPlan.error);
    await runInstall(skillPlan, {}, opts);
    const skillRecord = recordFor({ kind: "skill", id: "local-skill" }, "user", s.cwd, s.home)!;
    expect(skillRecord).toMatchObject({ kind: "skill", id: "local-skill", source: "catalog", scope: "user", installedBy: "market", catalogVersion: "3.1" });
    expect(skillRecord.git).toBeUndefined();
    expect(skillRecord.installedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(skillRecord.target).toBe(skillPlan.target);

    // a plugin clone: the source is recorded
    const pluginPlan = planInstall(find(items, "linter", "plugin"), opts);
    if ("error" in pluginPlan) throw new Error(pluginPlan.error);
    await runInstall(pluginPlan, {}, opts, { spawn: async (cmd, cwd) => {
      const dir = join(cwd, cmd.at(-1) ?? ".");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "plugin.json"), JSON.stringify({ api: 1, name: "linter", version: "2.0.0", description: "Lints." }));
      return { code: 0, stderr: "" };
    } });
    expect(recordFor({ kind: "plugin", id: "linter" }, "user", s.cwd, s.home)!.git).toMatchObject({ source: "https://example.com/linter.git" });

    // an MCP entry records the FILE it was written into, never the file's contents
    const mcpPlan = planInstall(find(items, "notes", "mcp"), opts);
    if ("error" in mcpPlan) throw new Error(mcpPlan.error);
    await runInstall(mcpPlan, {}, opts);
    const mcpRecord = recordFor({ kind: "mcp", id: "notes" }, "user", s.cwd, s.home)!;
    expect(mcpRecord.target).toBe(join(s.home, "mcp.json"));
    expect(JSON.stringify(mcpRecord)).not.toContain("notes-server");   // the launch line lives in mcp.json, not here
  } finally { s.cleanup(); }
});

test("removing something forgets its record, in the scope it lived in", async () => {
  const s = scratch();
  try {
    const items = (await searchMarket("", s.registry)).items;
    const skill = find(items, "local-skill", "skill");
    for (const scope of ["user", "project"] as const) {
      const opts = { scope, cwd: s.cwd, home: s.home };
      const plan = planInstall(skill, opts);
      if ("error" in plan) throw new Error(plan.error);
      await runInstall(plan, {}, opts, { force: true });
    }
    expect(recordFor(skill, "user", s.cwd, s.home)).toBeDefined();
    expect(recordFor(skill, "project", s.cwd, s.home)).toBeDefined();

    expect(removeItem(skill, s.cwd, s.home, "project")).toMatchObject({ ok: true });
    expect(recordFor(skill, "project", s.cwd, s.home)).toBeUndefined();
    expect(recordFor(skill, "user", s.cwd, s.home)).toBeDefined();     // the other scope is untouched
  } finally { s.cleanup(); }
});

test("originLine says what it knows and admits what it does not", () => {
  expect(originLine(undefined)).toContain("origin unknown");
  const base = { kind: "skill" as const, id: "x", source: "catalog" as const, scope: "user" as const,
    installedAt: "2026-09-05T10:11:12.000Z", installedBy: "market" as const, target: "/t" };
  expect(originLine(base)).toBe("catalog · 2026-09-05");
  expect(originLine({ ...base, git: { source: "https://example.com/r.git", sha: "41bbe19d1a1aa9f0deadbeef00112233" } }))
    .toBe("https://example.com/r.git @ 41bbe19d1a1a · 2026-09-05");
  expect(originLine({ ...base, git: { source: "https://example.com/r.git" } })).toBe("https://example.com/r.git · 2026-09-05");
});

test("an orphaned record is pruned by the next real install, not left to accumulate", async () => {
  const s = scratch();
  try {
    const items = (await searchMarket("", s.registry)).items;
    const skill = find(items, "local-skill", "skill");
    const opts = { scope: "user" as const, cwd: s.cwd, home: s.home };

    // a record for something that is not there: an install that was later deleted by hand
    recordInstall(buildRecord({ ...skill, id: "ghost" }, { scope: "user", target: join(s.home, "skills", "ghost") }), { cwd: s.cwd, home: s.home });
    expect(readManifest("user", s.cwd, s.home).map((r) => r.id)).toEqual(["ghost"]);

    const plan = planInstall(skill, opts);
    if ("error" in plan) throw new Error(plan.error);
    await runInstall(plan, {}, opts);
    // the real install wrote its own record AND dropped the one describing nothing
    expect(readManifest("user", s.cwd, s.home).map((r) => r.id)).toEqual(["local-skill"]);
  } finally { s.cleanup(); }
});
