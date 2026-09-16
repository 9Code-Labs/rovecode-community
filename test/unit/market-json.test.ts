/** `--json` means ONE document on stdout. Every subcommand, every exit code.
 *
 *  This file exists because `market install --json` spent its whole life emitting the human preview and
 *  then an object on the same stream, and no test noticed — every `--json` test until now asserted that the
 *  flag was ACCEPTED, or read a field out of a hand-built object, and none of them ever ran `JSON.parse`
 *  over what the command actually put on stdout. A flag whose entire promise is "a script reads the same
 *  data the terminal shows" has to be checked the way a script would read it.
 *
 *  So the shape here is deliberately dumb and exhaustive: run the command, parse stdout, fail on anything
 *  that is not parseable. It does not care what the fields mean — the other market test files do that.
 *  It cares that a caller can get to them at all. Error paths are included on purpose: a script that hits
 *  a missing id needs a document too, and stderr may carry prose because stderr is not the document. */

import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdMarket } from "../../src/cli/market-cmd.ts";

const SKILLS = { version: 1, items: [
  { id: "local-skill", title: "Local skill", publisher: "rovecode", description: "Ships in the catalog.", version: "1.0.0",
    docs: { body: "# Local skill\n\nWhat it does.\n", source: "https://example.com/s", bytes: 30 },
    install: { files: [{ path: "SKILL.md", text: "---\nname: local-skill\n---\nbody\n" }] } },
] };

function scratch() {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-json-cwd-"));
  const home = mkdtempSync(join(tmpdir(), "rovecode-json-home-"));
  writeFileSync(join(home, "skills.json"), JSON.stringify(SKILLS));
  writeFileSync(join(home, "plugins.json"), JSON.stringify({ version: 1, items: [] }));
  const registry = { offline: true, catalogFiles: { skill: join(home, "skills.json"), plugin: join(home, "plugins.json") },
    mcpDocsFile: join(home, "mcp-docs.json"), mcp: { catalog: [], offline: true, home } };
  return { cwd, home, registry, cleanup: () => { rmSync(cwd, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); } };
}

/** run one command and insist stdout is a single JSON document; returns it with the exit code */
async function jsonRun(s: ReturnType<typeof scratch>, args: string[], tty = false): Promise<{ code: number; doc: unknown; raw: string }> {
  const out: string[] = [];
  const code = await cmdMarket(args, {
    cwd: s.cwd, home: s.home, registry: s.registry, tty,
    out: (l: string) => out.push(l), err: () => {},
    // a prompt must never be reached in --json mode; if one is, this makes it a failure rather than a hang
    plain: async () => { throw new Error(`${args.join(" ")} asked a question in --json mode`) },
    secret: async () => { throw new Error(`${args.join(" ")} asked for a secret in --json mode`) },
  });
  const raw = out.join("\n");
  let doc: unknown;
  try { doc = JSON.parse(raw); }
  catch (e) { throw new Error(`${args.join(" ")} (exit ${code}) did not put one JSON document on stdout:\n${raw}\n\n${e instanceof Error ? e.message : e}`) }
  return { code, doc, raw };
}

const READS: string[][] = [
  ["search", "--json"],
  ["search", "local", "--json"],
  ["search", "definitely-nothing-matches-this", "--json"],   // empty result is still a document
  ["search", "--kind", "skill", "--json"],
  ["info", "skill:local-skill", "--json"],
  ["docs", "skill:local-skill", "--json"],
  ["list", "--json"],
  ["list", "--all", "--json"],
  ["update", "--json"],
  ["sources", "--json", "--offline"],
  ["verify", "--json"],
];

test("every read-only subcommand puts exactly one JSON document on stdout", async () => {
  const s = scratch();
  try {
    for (const args of READS) await jsonRun(s, args);
  } finally { s.cleanup(); }
});

test("the same holds once something is installed, when there is more to say", async () => {
  const s = scratch();
  try {
    await jsonRun(s, ["install", "skill:local-skill", "--yes", "--json"]);
    for (const args of READS) await jsonRun(s, args);
    // and verify, which now has a row to report on
    const v = await jsonRun(s, ["verify", "--json"]);
    expect(Array.isArray(v.doc)).toBe(true);
  } finally { s.cleanup(); }
});

test("the writing subcommands too — including on a terminal, where the prose lives", async () => {
  const s = scratch();
  try {
    // install on a TTY: without --json this prints the plan and asks. With it, one document and no prompt.
    const i = await jsonRun(s, ["install", "skill:local-skill", "--yes", "--json"], true);
    expect(i.code).toBe(0);

    // remove on a TTY was the same defect as install: a prose line, a y/N, and then an object
    const r = await jsonRun(s, ["remove", "skill:local-skill", "--yes", "--json"], true);
    expect(r.code).toBe(0);

    const d = await jsonRun(s, ["install", "skill:local-skill", "--dry-run", "--json"], true);
    expect(d.code).toBe(0);
  } finally { s.cleanup(); }
});

test("failures are documents as well — a script that hits a bad id still gets JSON", async () => {
  const s = scratch();
  try {
    for (const args of [
      ["info", "skill:no-such-thing", "--json"],
      ["docs", "skill:no-such-thing", "--json"],
      ["remove", "skill:local-skill", "--yes", "--json"],     // never installed
      ["verify", "skill:no-such-thing", "--json"],
    ]) {
      const r = await jsonRun(s, args);
      expect(r.code).not.toBe(0);          // it really is the failure path
    }
  } finally { s.cleanup(); }
});

test("--json never prompts: the plan comes back with needsApproval instead of a y/N nobody was shown", async () => {
  const s = scratch();
  try {
    // on a TTY. Without --json this prints the plan and asks; with it, the preview lives in the document,
    // so asking would mean asking someone to approve a plan that never reached their screen. The injected
    // `plain` in jsonRun throws, so a prompt here fails the test rather than hanging it.
    const i = await jsonRun(s, ["install", "skill:local-skill", "--json"], true);
    expect(i.code).toBe(1);
    const plan = i.doc as { ok: boolean; needsApproval: boolean; preview: string[] };
    expect(plan.ok).toBe(false);
    expect(plan.needsApproval).toBe(true);
    expect(plan.preview.length).toBeGreaterThan(0);   // what a person would have been shown

    await jsonRun(s, ["install", "skill:local-skill", "--yes", "--json"]);
    const r = await jsonRun(s, ["remove", "skill:local-skill", "--json"], true);
    expect(r.code).toBe(1);
    expect((r.doc as { needsApproval: boolean; path: string }).needsApproval).toBe(true);
    expect((r.doc as { path: string }).path).toContain("local-skill");   // WHAT would be deleted
  } finally { s.cleanup(); }
});

test("`verify <id>` with no record is a 1 in --json too — an empty array with a 0 reads as 'all fine'", async () => {
  const s = scratch();
  try {
    const missing = await jsonRun(s, ["verify", "skill:never-installed", "--json"]);
    expect(missing.code).toBe(1);
    expect(missing.doc).toEqual([]);

    // but verifying EVERYTHING when nothing is installed is a legitimate 0: the question was open-ended
    const all = await jsonRun(s, ["verify", "--json"]);
    expect(all.code).toBe(0);
    expect(all.doc).toEqual([]);
  } finally { s.cleanup(); }
});
