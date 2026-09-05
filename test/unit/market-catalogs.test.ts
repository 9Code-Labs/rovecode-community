/** The two catalogs rovecode publishes — src/market/catalogs/{skills,plugins}.json.
 *
 *  These are DATA, and data rots differently from code: nothing here type-checks, and a hand-edit or a
 *  drifting upstream shows up only when a user tries to install. So the tests below read the files that
 *  actually ship and put every row through the validator that actually reads them (registry.ts
 *  itemFromCatalog), which also makes this a contract test in both directions — if a5 tightens the
 *  validator or I regenerate a catalog, whichever side moved fails here rather than at install time.
 *
 *  The rule the catalogs are held to is "a shelf, not a mirror": every entry names a real, reachable
 *  source, and nothing is invented to pad the list. That is why the plugin catalog has three rows.
 *  Neither generator runs here — they need the network; `--check` is the CI job for that. */

import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { itemFromCatalog } from "../../src/market/registry.ts";
import { LIMITS } from "../../src/market/types.ts";
// @ts-expect-error - a build script, plain JS, no types alongside it
import { proseOnly } from "../../scripts/lib/docs.mjs";

const CATALOGS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "market", "catalogs");
const load = (name: string): { version: number; sources: string[]; items: Record<string, unknown>[] } =>
  JSON.parse(readFileSync(join(CATALOGS, `${name}.json`), "utf8")) as never;

const SLUG = /^[a-z0-9][a-z0-9._-]*$/;

for (const kind of ["skills", "plugins"] as const) {
  const one = kind === "skills" ? "skill" : "plugin";

  test(`${kind}.json: every row survives the validator that reads it`, () => {
    const doc = load(kind);
    expect(doc.version).toBe(1);
    expect(doc.items.length).toBeGreaterThan(0);
    const notes: string[] = [];
    const items = doc.items.map((raw) => itemFromCatalog(one, raw, notes));
    // a note here means a row was clipped or dropped: the catalog is generated, so it should be clean
    expect(notes).toEqual([]);
    expect(items.every((i) => i !== null)).toBe(true);
    expect(items.map((i) => i!.kind)).toEqual(doc.items.map(() => one));
  });

  test(`${kind}.json: ids are unique bare slugs and every row names a source`, () => {
    const doc = load(kind);
    const ids = doc.items.map((i) => String(i["id"]));
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(SLUG);
    for (const raw of doc.items) {
      expect(String(raw["publisher"] ?? "")).not.toBe("");
      expect(String(raw["description"] ?? "").length).toBeGreaterThan(0);
      expect(String(raw["description"] ?? "").length).toBeLessThanOrEqual(LIMITS.desc);
      // the source is the whole point: a row nobody can fetch is a row that should not be listed
      const item = itemFromCatalog(one, raw, [])!;
      if (item.install.kind === "skill") {
        expect(item.install.source?.git ?? item.install.files?.length).toBeTruthy();
      } else if (item.install.kind === "plugin") {
        expect(item.install.source).toMatch(/^https?:\/\//);
      }
    }
  });
}

test("skills.json: sourced from the repositories the generator declares, one subfolder each", () => {
  const doc = load("skills");
  expect(doc.sources).toContain("https://github.com/anthropics/skills");
  for (const raw of doc.items) {
    const item = itemFromCatalog("skill", raw, [])!;
    expect(item.install.kind).toBe("skill");
    if (item.install.kind !== "skill") return;
    expect(doc.sources).toContain(item.install.source!.git);
    // <root>/<name>: the layout every entry is read from, and the id is the folder
    expect(item.install.source!.subfolder).toBe(`skills/${item.id}`);
  }
});

/** 4 of the 19 skills upstream are "source-available, not open source" and one has no LICENSE.txt at
 *  all. A market that installs someone else's files should carry that, so the generator records it. */
test("skills.json: every row records a licence, and the source-available ones are not called open source", () => {
  const doc = load("skills");
  const lic = new Map(doc.items.map((i) => [String(i["id"]), String(i["license"] ?? "")]));
  for (const [, v] of lic) expect(v).not.toBe("");
  for (const id of ["docx", "pdf", "pptx", "xlsx"]) expect(lic.get(id)).toBe("source-available");
  expect(lic.get("doc-coauthoring")).toBe("unknown");     // no LICENSE.txt upstream; not guessed at
  expect([...lic.values()].filter((v) => v === "Apache-2.0").length).toBeGreaterThan(10);
});

/** The plugin catalog is short on purpose. If it ever grows, it should be because a real third-party
 *  plugin appeared — not because someone padded it with Claude Code plugins, which use a different
 *  manifest and would not install. */
test("plugins.json: first-party rows only, each with a subfolder and an honest note about running code", () => {
  const doc = load("plugins");
  expect(doc.items.map((i) => i["id"]).sort()).toEqual(["conventional-commits", "notes", "safety-net"]);
  for (const raw of doc.items) {
    const item = itemFromCatalog("plugin", raw, [])!;
    if (item.install.kind !== "plugin") return;
    expect(item.install.git).toBe(true);
    expect(item.install.subfolder).toBe(`plugins/${item.id}`);   // needs the subfolder arm to install at all
    expect(item.planNote?.length).toBeGreaterThan(0);
    // the one thing a reader must not miss is whether it runs code
    expect(item.planNote!.some((n) => /runs code|nothing is imported/.test(n))).toBe(true);
  }
  // the two that ship an entry module say so; the file-only one says the opposite
  const byId = new Map(doc.items.map((i) => [String(i["id"]), itemFromCatalog("plugin", i, [])!]));
  expect(byId.get("notes")!.planNote![0]).toContain("runs code");
  expect(byId.get("conventional-commits")!.planNote![0]).toContain("nothing is imported");
});

/** A catalog is untrusted input even when we generate it: a hand-edit lands in the same reader. */
test("a catalog row that climbs out of its folder is dropped, not normalised", () => {
  const notes: string[] = [];
  const escape = itemFromCatalog("skill", {
    id: "evil", title: "Evil", publisher: "x", description: "d",
    source: { git: "https://github.com/x/y", subfolder: "../../etc" },
  }, notes);
  expect(escape).toBeNull();
  expect(notes.join(" ")).toMatch(/escapes/);

  const absolute = itemFromCatalog("skill", {
    id: "evil2", title: "Evil", publisher: "x", description: "d",
    files: [{ path: "/etc/passwd", text: "x" }],
  }, []);
  expect(absolute).toBeNull();
});

/** Documentation on the shelf. These read what actually ships, so they are the thing that notices when a
 *  regenerated catalog quietly comes back blank — the generators refuse that, and this is the second pair
 *  of eyes on the file itself rather than on the run that produced it. */
test("every skill and plugin row carries documentation, within the cap and pointing at its original", () => {
  for (const kind of ["skills", "plugins"] as const) {
    const doc = load(kind);
    for (const raw of doc.items) {
      const d = raw["docs"] as { source: string; format: string; bytes: number; truncated: boolean; body: string } | undefined;
      expect(d, `${kind}/${String(raw["id"])} has no docs`).toBeDefined();
      expect(d!.format).toBe("markdown");
      expect(d!.source).toMatch(/^https:\/\//);
      expect(Buffer.byteLength(d!.body, "utf8")).toBeLessThanOrEqual(LIMITS.docs);
      expect(d!.bytes).toBeGreaterThan(0);
      // a cut body must say so in both places: the flag a UI reads and the line a reader sees
      if (d!.truncated) expect(d!.body).toContain(d!.source);
      else expect(d!.bytes).toBe(Buffer.byteLength(d!.body, "utf8"));
    }
  }
});

test("the docs that ship are cleaned: no script tags in prose, no relative links left", () => {
  for (const kind of ["skills", "plugins"] as const) {
    for (const raw of load(kind).items) {
      const body = (raw["docs"] as { body: string }).body;
      // fenced code is carried verbatim on purpose, so only prose is asked this question — via the
      // cleaner's own fence parser, because a regex pairs an opening ``` with a closing ~~~ and would
      // hand back fenced text as prose (a hidden finding in this direction, a false alarm in the other)
      const prose = proseOnly(body) as string;
      expect(prose, `${String(raw["id"])}`).not.toMatch(/<script\b/i);
      expect(prose, `${String(raw["id"])}`).not.toMatch(/<iframe\b/i);
      expect(prose, `${String(raw["id"])}`).not.toMatch(/\]\(\s*(?:\.{1,2}\/|javascript:|data:)/i);
    }
  }
});

/** The MCP sidecar: hand-written shelf, generated docs, joined by key. The join is the part that can rot
 *  silently — a key renamed on either side produces no error anywhere, just a row that lost its docs. */
test("mcp-docs.json is keyed by keys the curated shelf actually has", () => {
  const sidecar = JSON.parse(readFileSync(join(CATALOGS, "mcp-docs.json"), "utf8")) as
    { version: number; docs: Record<string, { source: string; format: string; bytes: number; body: string }> };
  expect(sidecar.version).toBe(1);

  const shelf = readFileSync(join(CATALOGS, "..", "..", "mcp", "market-catalog.ts"), "utf8");
  const keys = new Set([...shelf.matchAll(/\bkey:\s*"([^"]+)"/g)].map((m) => m[1]!));
  expect(keys.size).toBeGreaterThan(10);

  const documented = Object.keys(sidecar.docs);
  expect(documented.length).toBeGreaterThan(0);
  for (const k of documented) expect(keys.has(k), `sidecar documents "${k}", which is not on the shelf`).toBe(true);

  // deepwiki is the one entry with no repository at all — homepage only — so it has no README to carry
  const missing = [...keys].filter((k) => !documented.includes(k));
  expect(missing).toEqual(["deepwiki"]);

  for (const [k, d] of Object.entries(sidecar.docs)) {
    expect(d.format, k).toBe("markdown");
    expect(d.source, k).toMatch(/^https:\/\/raw\.githubusercontent\.com\//);
    expect(Buffer.byteLength(d.body, "utf8")).toBeLessThanOrEqual(LIMITS.docs);
  }
});

/** `contributes` is the structured half of the sentence the approval preview prints. The generator has
 *  always written the array; until it was read, a caller choosing between two plugins had to parse
 *  English out of `planNote`. These pin that the two stay the same fact — a plugin whose prose says it
 *  brings skills while its array does not is a catalog lying to one of its two readers. */
test("a plugin's contributes array reaches the reader, and agrees with the sentence", () => {
  const raw = JSON.parse(readFileSync(join(CATALOGS, "plugins.json"), "utf8")) as { items: Record<string, unknown>[] };
  let checked = 0;
  for (const row of raw.items) {
    const item = itemFromCatalog("plugin", row, []);
    if (!item) continue;
    const declared = (row["contributes"] as string[] | undefined) ?? [];
    if (declared.length === 0) {
      expect(item.contributes).toBeUndefined(); // absent, not an empty array nobody can distinguish
      continue;
    }
    checked += 1;
    expect(item.contributes).toEqual(declared);
    // the prose is built from the array at generation time; if they diverge, one of the two is stale
    const sentence = (item.planNote ?? []).find((l) => l.startsWith("contributes:"));
    if (sentence) for (const kind of declared) expect(sentence).toContain(kind);
  }
  expect(checked).toBeGreaterThan(0); // a green test over zero rows proves nothing
});

test("contributes is capped and re-typed like every other untrusted list", () => {
  const item = itemFromCatalog("plugin", { id: "x", title: "X", description: "d", install: { source: "https://example.com/r", git: true }, contributes: [...Array(40)].map((_, i) => `k${i}`) }, []);
  expect(item?.contributes?.length).toBeLessThanOrEqual(12);
  const junk = itemFromCatalog("plugin", { id: "y", title: "Y", description: "d", install: { source: "https://example.com/r", git: true }, contributes: [1, null, { a: 1 }] }, []);
  expect(junk?.contributes).toBeUndefined(); // nothing survived the retyping, so the field is absent
});
