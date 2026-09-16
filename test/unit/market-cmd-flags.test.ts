/** Flags are validated PER SUBCOMMAND, and every exit in --json mode is one document.
 *
 *  `rovecode market list --kind mcp` returned a skill row: the flag was in the global KNOWN set (search takes
 *  it), so nothing complained, and `list` never read it. This file pins the table of what each subcommand
 *  takes — one refusal per subcommand, so a later edit cannot quietly widen it — and checks the two
 *  behaviours that table drives: `list --kind` filters, and a refused flag in --json mode is still a document
 *  on stdout (exit 2, `{ok:false, error, usage}`), not an empty stdout and a number.
 *
 *  Also here, because the --json sweep found them: `update --all --yes --json` printed a sentence when nothing
 *  was stale and one document PER ITEM otherwise; now it is one object however many items it touches. */

import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdMarket, SUBCOMMAND_FLAGS } from "../../src/cli/market-cmd.ts";

const skills = (version: string) => ({ version: 1, items: [
  { id: "local-skill", title: "Local skill", publisher: "rovecode", description: "Ships in the catalog.", version,
    install: { files: [{ path: "SKILL.md", text: `---\nname: local-skill\nversion: ${version}\n---\nbody\n` }] } },
] });

function scratch() {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-flags-cwd-"));
  const home = mkdtempSync(join(tmpdir(), "rovecode-flags-home-"));
  const skillsFile = join(home, "skills.json");
  writeFileSync(skillsFile, JSON.stringify(skills("1.0.0")));
  writeFileSync(join(home, "plugins.json"), JSON.stringify({ version: 1, items: [] }));
  const registry = { offline: true, catalogFiles: { skill: skillsFile, plugin: join(home, "plugins.json") },
    mcpDocsFile: join(home, "mcp-docs.json"), mcp: { catalog: [], offline: true, home } };
  return { cwd, home, registry, skillsFile, cleanup: () => { rmSync(cwd, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); } };
}

async function run(s: ReturnType<typeof scratch>, args: string[]) {
  const out: string[] = []; const errs: string[] = [];
  const code = await cmdMarket(args, {
    cwd: s.cwd, home: s.home, registry: s.registry, tty: false,
    out: (l: string) => out.push(l), err: (l: string) => errs.push(l),
    plain: async () => { throw new Error("prompted"); }, secret: async () => { throw new Error("prompted"); },
  });
  return { code, stdout: out.join("\n"), stderr: errs.join("\n") };
}

/** stdout must be exactly one JSON document */
function one(stdout: string, label: string): unknown {
  try { return JSON.parse(stdout); }
  catch { throw new Error(`${label}: stdout is not one JSON document:\n${stdout}`); }
}

test("the table: what each subcommand reads beyond --json/--offline (widening it is a deliberate edit here, not a side effect)", () => {
  const pinned = Object.fromEntries(Object.entries(SUBCOMMAND_FLAGS).map(([k, v]) => [k, [...v].sort()]));
  expect(pinned).toEqual({
    search: ["--kind"],
    info: [],
    docs: [],
    install: ["--as", "--dry-run", "--force", "--local", "--no-local", "--pick", "--project", "--ref", "--yes"],
    remove: ["--project", "--yes"],
    list: ["--all", "--kind"],
    update: ["--all", "--dry-run", "--yes", "--yes-plugins"],
    sources: [],
    verify: [],
    validate: ["--kind"],
    help: [],
  });
});

test("one refusal per subcommand: a flag another subcommand takes is 'does not take', exit 2 — and in --json a document", async () => {
  const s = scratch();
  try {
    // (subcommand argv, a flag some OTHER subcommand legitimately takes)
    const cases: [string[], string][] = [
      [["search", "x"], "--all"],
      [["info", "skill:local-skill"], "--kind"],
      [["docs", "skill:local-skill"], "--yes"],
      [["install", "skill:local-skill"], "--yes-plugins"],
      [["remove", "skill:local-skill"], "--force"],
      [["list"], "--pick"],
      [["update"], "--project"],
      [["sources"], "--kind"],
      [["verify"], "--all"],
      [["validate", s.skillsFile], "--project"],
      [["help"], "--all"],
    ];
    for (const [argv, flag] of cases) {
      const plain = await run(s, [...argv, flag]);
      expect(plain.code).toBe(2);
      expect(plain.stderr).toContain(`market ${argv[0]} does not take ${flag}`);
      expect(plain.stdout).toBe("");                       // usage goes to stderr off --json
      const j = await run(s, [...argv, flag, "--json"]);
      expect(j.code).toBe(2);
      const doc = one(j.stdout, `${argv[0]} ${flag} --json`) as { ok: boolean; error: string; usage: string[] };
      expect(doc.ok).toBe(false);
      expect(doc.error).toBe(`market ${argv[0]} does not take ${flag}`);
      expect(doc.usage.length).toBeGreaterThan(3);
    }
  } finally { s.cleanup(); }
});

test("the other usage errors are documents too: no command, an unknown command, an unknown flag, a bad --kind value", async () => {
  const s = scratch();
  try {
    for (const [argv, error] of [
      [["--json"], "market needs a command"],
      [["frobnicate", "--json"], 'unknown command "frobnicate"'],
      [["list", "--nope", "--json"], "unknown flag --nope"],
      [["list", "--kind", "server", "--json"], "--kind takes mcp, skill or plugin"],
      [["search", "--kind", "server", "--json"], "--kind takes mcp, skill or plugin"],
      [["info", "--json"], "market info needs a name"],
    ] as [string[], string][]) {
      const r = await run(s, argv);
      expect(r.code).toBe(2);
      expect((one(r.stdout, argv.join(" ")) as { error: string }).error).toBe(error);
    }
    // `help` is the one subcommand whose stdout IS the prose: it prints usage, exit 0, --json or not
    const h = await run(s, ["help", "--json"]);
    expect(h.code).toBe(0);
    expect(h.stdout).toContain("usage: rovecode market");
  } finally { s.cleanup(); }
});

test("`list --kind` filters: asked for plugins, a skill row does not come back", async () => {
  const s = scratch();
  try {
    const all = one((await run(s, ["list", "--all", "--json"])).stdout, "list --all") as { kind: string }[];
    expect(all.map((r) => r.kind)).toEqual(["skill"]);
    const skill = one((await run(s, ["list", "--all", "--kind", "skill", "--json"])).stdout, "list --kind skill") as { kind: string }[];
    expect(skill.map((r) => r.kind)).toEqual(["skill"]);
    const plugin = await run(s, ["list", "--all", "--kind", "plugin", "--json"]);
    expect(plugin.code).toBe(0);
    expect(one(plugin.stdout, "list --kind plugin")).toEqual([]);
    const mcp = await run(s, ["list", "--all", "--kind", "mcp", "--json"]);
    expect(one(mcp.stdout, "list --kind mcp")).toEqual([]);          // this is the call that returned a skill row
    // installed view, filtered
    await run(s, ["install", "skill:local-skill", "--yes", "--json"]);
    expect((one((await run(s, ["list", "--kind", "skill", "--json"])).stdout, "list installed skill") as unknown[]).length).toBe(1);
    expect(one((await run(s, ["list", "--kind", "plugin", "--json"])).stdout, "list installed plugin")).toEqual([]);
    const text = await run(s, ["list", "--kind", "plugin"]);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain("no plugin installed here yet");
  } finally { s.cleanup(); }
});

test("`update --all --yes --json` is ONE document with nothing stale, with one stale item, and with a named item that is not installed", async () => {
  const s = scratch();
  try {
    await run(s, ["install", "skill:local-skill", "--yes", "--json"]);
    const idle = await run(s, ["update", "--all", "--yes", "--json"]);
    expect(idle.code).toBe(0);
    expect(one(idle.stdout, "update idle")).toEqual({ ok: true, results: [], skipped: [] });   // was a sentence

    writeFileSync(s.skillsFile, JSON.stringify(skills("1.0.1")));                             // the catalog moves on
    const stale = await run(s, ["update", "--json"]);
    expect((one(stale.stdout, "update dry list") as unknown[]).length).toBe(1);
    const done = await run(s, ["update", "--all", "--yes", "--json"]);
    expect(done.code).toBe(0);
    const doc = one(done.stdout, "update --all") as { ok: boolean; results: { ok?: boolean; target?: string }[]; skipped: string[] };
    expect(doc.ok).toBe(true);
    expect(doc.results.length).toBe(1);                                                        // the item's own outcome object
    expect(doc.results[0]!.ok).toBe(true);
    expect(doc.skipped).toEqual([]);

    await run(s, ["remove", "skill:local-skill", "--yes", "--json"]);
    const missing = await run(s, ["update", "skill:local-skill", "--json"]);
    expect(missing.code).toBe(1);
    expect((one(missing.stdout, "update <not installed>") as { ok: boolean; installed: boolean }).installed).toBe(false);
  } finally { s.cleanup(); }
});
