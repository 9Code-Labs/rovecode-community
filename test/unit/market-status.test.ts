/** "The publisher stopped maintaining this" — said before the yes, and never as a refusal.
 *
 *  The status is the publisher's, not ours. It is derived in the generator from GitHub's `archived` flag
 *  rather than typed into a catalog by hand, because a hand-written status is correct the day it is written
 *  and wrong every day after. These tests pin two things about that: WHERE it appears (first, above the
 *  cost rows, because it is a reason not to want the thing rather than a detail of wanting it) and that it
 *  changes nothing else — an archived skill installs exactly like any other. */

import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdMarket } from "../../src/cli/market-cmd.ts";
import { planInstall } from "../../src/market/install.ts";
import { findItem, searchMarket, type RegistryDeps } from "../../src/market/registry.ts";

const files = [{ path: "SKILL.md", text: "---\nname: x\n---\nbody\n" }];
const SKILLS = { version: 1, items: [
  { id: "old-skill", title: "Old skill", publisher: "someone", description: "Still works.", status: "archived", install: { files } },
  { id: "dying-skill", title: "Dying skill", publisher: "someone", description: "On the way out.", status: "deprecated", install: { files } },
  { id: "odd-skill", title: "Odd skill", publisher: "someone", description: "Something else entirely.", status: "beta-forever", install: { files } },
  { id: "fine-skill", title: "Fine skill", publisher: "someone", description: "Nothing to report.", install: { files } },
] };

function scratch() {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-status-cwd-"));
  const home = mkdtempSync(join(tmpdir(), "rovecode-status-home-"));
  writeFileSync(join(home, "skills.json"), JSON.stringify(SKILLS));
  writeFileSync(join(home, "plugins.json"), JSON.stringify({ version: 1, items: [] }));
  const registry: RegistryDeps = { offline: true, catalogFiles: { skill: join(home, "skills.json"), plugin: join(home, "plugins.json") },
    mcpDocsFile: join(home, "mcp-docs.json"), mcp: { catalog: [], offline: true, home } };
  return { cwd, home, registry, cleanup: () => { rmSync(cwd, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); } };
}

const previewOf = async (s: ReturnType<typeof scratch>, id: string): Promise<string[]> => {
  const item = (await findItem("skill", id, s.registry)).item!;
  const plan = planInstall(item, { scope: "user", cwd: s.cwd, home: s.home });
  if ("error" in plan) throw new Error(plan.error);
  return plan.preview;
};

test("an archived item says so in the preview's FIRST line, in GitHub's own word", async () => {
  const s = scratch();
  try {
    const preview = await previewOf(s, "old-skill");
    expect(preview[0]).toContain("archived on GitHub");
    expect(preview[0]).toContain("stopped maintaining");
    // "abandoned" is a judgement about someone else's work that nobody upstream made
    expect(preview.join("\n")).not.toContain("abandoned");
    // and it is above the cost rows, not buried among them
    const cost = preview.findIndex((l) => l.includes("context") || l.includes("writes"));
    if (cost !== -1) expect(cost).toBeGreaterThan(0);
  } finally { s.cleanup(); }
});

test("the warning is a warning: an archived item installs, and the exit code is a success", async () => {
  const s = scratch();
  try {
    const out: string[] = [], err: string[] = [];
    const deps = { cwd: s.cwd, home: s.home, registry: s.registry, out: (l: string) => out.push(l), err: (l: string) => err.push(l), tty: false };
    expect(await cmdMarket(["install", "skill:old-skill", "--yes"], deps)).toBe(0);
    // the person saw it before the write, which is the whole point of saying it at all
    expect(out.join("\n")).toContain("archived on GitHub");
  } finally { s.cleanup(); }
});

test("a status we have no sentence for is passed through in the publisher's words, never translated", async () => {
  const s = scratch();
  try {
    expect((await previewOf(s, "dying-skill"))[0]).toContain("marked deprecated by its publisher");
    const odd = (await previewOf(s, "odd-skill"))[0];
    expect(odd).toContain(`marked "beta-forever" by its publisher`);
    // an unknown word must not be silently promoted to the strongest sentence we have
    expect(odd).not.toContain("archived");
  } finally { s.cleanup(); }
});

test("an item with nothing to report gets no banner and no blank line where one would be", async () => {
  const s = scratch();
  try {
    const preview = await previewOf(s, "fine-skill");
    expect(preview[0]).not.toContain("publisher");
    expect(preview[0]!.trim()).not.toBe("");
  } finally { s.cleanup(); }
});

test("`search` badges the status next to the install state, because both are true at once", async () => {
  const s = scratch();
  try {
    const out: string[] = [];
    const deps = { cwd: s.cwd, home: s.home, registry: s.registry, out: (l: string) => out.push(l), err: () => {}, tty: false };
    expect(await cmdMarket(["install", "skill:old-skill", "--yes"], deps)).toBe(0);

    out.length = 0;
    expect(await cmdMarket(["search", "old-skill"], deps)).toBe(0);
    const row = out.find((l) => l.includes("Old skill"))!;
    expect(row).toContain("[archived]");
    expect(row).toContain("[installed]");   // knowing it is archived is exactly why you might remove it

    out.length = 0;
    expect(await cmdMarket(["search", "fine-skill"], deps)).toBe(0);
    expect(out.find((l) => l.includes("Fine skill"))!).not.toContain("[");
  } finally { s.cleanup(); }
});

test("`--json` carries the status as a field, so a UI never has to read the sentence", async () => {
  const s = scratch();
  try {
    const out: string[] = [];
    const deps = { cwd: s.cwd, home: s.home, registry: s.registry, out: (l: string) => out.push(l), err: () => {}, tty: false };
    expect(await cmdMarket(["search", "skill", "--json"], deps)).toBe(0);
    const parsed = JSON.parse(out.join("\n"));
    const rows: Array<{ id: string; status?: string }> = parsed.items ?? parsed;
    expect(rows.find((r) => r.id === "old-skill")?.status).toBe("archived");
    expect(rows.find((r) => r.id === "fine-skill")?.status).toBeUndefined();
  } finally { s.cleanup(); }
});

test("every status in the SHIPPED skill catalog is one the generator can produce", async () => {
  // the generator writes exactly one value, from GitHub's flag. A hand-edited catalog carrying "deprecated"
  // would still render, but it would be a fact nobody can re-derive by re-running the build — which is the
  // rule the whole catalog is built on.
  const catalog = await import("../../src/market/catalogs/skills.json", { with: { type: "json" } });
  const rows: Array<{ status?: string }> = (catalog.default as { items: Array<{ status?: string }> }).items;
  for (const r of rows) if (r.status !== undefined) expect(r.status).toBe("archived");
});
