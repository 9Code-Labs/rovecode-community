/** `market validate` — the catalog checker we can hand to someone writing their own.
 *
 *  THE INVARIANT, and the reason most of this file exists: the validator must never call a row valid that
 *  `registry.ts` would drop. Any other bug here is a bad message; that one is a clean bill of health for a
 *  catalog that shows up empty, and the author would have no reason to look again. It is checked twice —
 *  once against the catalogs that ship, and once against a few hundred mutations of a real row, because
 *  the ways a hand-written catalog is wrong are exactly the ways nobody thinks to write a test for. */

import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { inferKind, reportLines, validateCatalog } from "../../src/market/validate.ts";
import { itemFromCatalog } from "../../src/market/registry.ts";

const CATALOGS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "market", "catalogs");
const raw = (name: string) => readFileSync(join(CATALOGS, `${name}.json`), "utf8");
const doc = (kind: "skill" | "plugin", items: unknown[]) => JSON.stringify({ version: 1, items });
const errorsOf = (r: ReturnType<typeof validateCatalog>) => r.findings.filter((f) => f.severity === "error").map((f) => f.path);

// ------------------------------------------------------------------ the catalogs that ship

test("the catalogs rovecode publishes validate clean, with no warnings either", () => {
  for (const [name, kind] of [["skills", "skill"], ["plugins", "plugin"]] as const) {
    const r = validateCatalog(raw(name), { kind });
    expect(r.ok, `${name}: ${JSON.stringify(r.findings.slice(0, 4))}`).toBe(true);
    expect(r.dropped).toBe(0);
    // generated data has no excuse for warnings: a warning here means the generator wrote something the
    // reader will quietly change, which is worth failing over
    expect(r.findings, name).toEqual([]);
  }
});

// ------------------------------------------------------------------ the invariant

/** Mutations of a real row: each field deleted, each field replaced with a wrong type, and a few shapes a
 *  person actually types by hand. For every one: if we reported no error, the real reader must accept it. */
test("no row is ever called valid that the real reader would drop", () => {
  for (const [name, kind] of [["skills", "skill"], ["plugins", "plugin"]] as const) {
    const real = (JSON.parse(raw(name)) as { items: Record<string, unknown>[] }).items[0]!;
    const keys = Object.keys(real);
    const mutations: Record<string, unknown>[] = [];

    for (const k of keys) {
      for (const value of [undefined, null, 42, [], {}, "", "x".repeat(700)]) {
        const m = { ...real };
        if (value === undefined) delete m[k]; else m[k] = value;
        mutations.push(m);
      }
    }
    // and a handful of hand-written shapes
    mutations.push({ ...real, id: "UPPER" }, { ...real, id: "" }, { ...real, id: "a".repeat(80) },
                   { ...real, source: { git: "not-a-url" } }, { ...real, install: { source: "x", git: true } },
                   { ...real, docs: { source: "ftp://x", format: "markdown", bytes: 1, truncated: false, body: "b" } });

    for (const m of mutations) {
      const report = validateCatalog(doc(kind, [m]), { kind });
      const item = itemFromCatalog(kind, m, []);
      if (report.ok) {
        expect(item, `${name}: called valid but the reader drops it: ${JSON.stringify(m).slice(0, 160)}`).not.toBeNull();
      }
      // the counts must agree with the reader too, in both directions
      expect(report.accepted, JSON.stringify(m).slice(0, 120)).toBe(item === null ? 0 : 1);
    }
  }
});

// ------------------------------------------------------------------ what it says, field by field

test("a row is faulted where the fault is, in the author's own path", () => {
  const r = validateCatalog(doc("skill", [
    { id: "Good Name", description: "fine", source: { git: "https://github.com/a/b" } },
    { id: "ok", source: { git: "https://github.com/a/b" } },
    { id: "esc", description: "d", source: { git: "https://github.com/a/b", subfolder: "../../etc" } },
    { id: "ok2", description: "d", source: { git: "ftp://nope/x" } },
    { id: "none", description: "d" },
  ]), { kind: "skill" });
  expect(r.ok).toBe(false);
  expect(errorsOf(r)).toEqual([
    "items[0].id", "items[1].description", "items[2].source.subfolder", "items[3].source.git", "items[4].source",
  ]);
});

test("a duplicate id names the row it collides with, because ids are how installs are addressed", () => {
  const r = validateCatalog(doc("skill", [
    { id: "same", description: "d", publisher: "p", source: { git: "https://github.com/a/b" } },
    { id: "same", description: "d", publisher: "p", source: { git: "https://github.com/a/b" } },
  ]), { kind: "skill" });
  expect(r.findings.some((f) => f.path === "items[1].id" && f.message.includes("items[0]"))).toBe(true);
});

/** A typo in a key is the failure a validator earns its place on: everything parses, the row loads, and
 *  the field is silently absent. Nothing else in the system will ever mention it. */
test("a key rovecode does not read is reported, so a typo cannot cost a field in silence", () => {
  const r = validateCatalog(doc("skill", [
    { id: "x", description: "d", publisher: "p", descriptoin: "the typo", source: { git: "https://github.com/a/b" } },
  ]), { kind: "skill" });
  expect(r.ok).toBe(true);                                   // it still loads
  expect(r.findings.some((f) => f.path === "items[0].descriptoin" && f.severity === "warning")).toBe(true);
});

test("a field that will be truncated is a warning, not an error: the row loads, just not as written", () => {
  const r = validateCatalog(doc("skill", [
    { id: "x", description: "d".repeat(900), publisher: "p", source: { git: "https://github.com/a/b" } },
  ]), { kind: "skill" });
  expect(r.ok).toBe(true);
  expect(r.accepted).toBe(1);
  expect(r.findings.some((f) => f.path === "items[0].description" && f.message.includes("500"))).toBe(true);
});

test("broken documentation drops the documentation and keeps the row, and says exactly that", () => {
  const r = validateCatalog(doc("skill", [
    { id: "x", description: "d", publisher: "p", source: { git: "https://github.com/a/b" },
      docs: { source: "ftp://x", format: "html", bytes: 5, truncated: true, body: "hi" } },
  ]), { kind: "skill" });
  expect(r.ok).toBe(true);
  expect(r.accepted).toBe(1);
  expect(r.findings.map((f) => f.path)).toContain("items[0].docs.source");
  expect(r.findings.map((f) => f.path)).toContain("items[0].docs.format");
});

test("bytes smaller than a body it calls truncated is caught: it is the number a reader is shown", () => {
  const r = validateCatalog(doc("skill", [
    { id: "x", description: "d", publisher: "p", source: { git: "https://github.com/a/b" },
      docs: { source: "https://x.test/a.md", format: "markdown", bytes: 3, truncated: true, body: "much longer than three" } },
  ]), { kind: "skill" });
  expect(r.findings.some((f) => f.path === "items[0].docs.bytes")).toBe(true);
});

// ------------------------------------------------------------------ plugins

test("a plugin marked git: true with something that is not a URL is an error", () => {
  const r = validateCatalog(doc("plugin", [
    { id: "p", description: "d", publisher: "me", install: { source: "./local", git: true, subfolder: "plugins/p" } },
  ]), { kind: "plugin" });
  expect(errorsOf(r)).toContain("items[0].install.source");
});

test("a plugin without a subfolder is warned, not refused: a repository root is legal and rare", () => {
  const r = validateCatalog(doc("plugin", [
    { id: "p", description: "d", publisher: "me", install: { source: "https://github.com/a/b", git: true } },
  ]), { kind: "plugin" });
  expect(r.ok).toBe(true);
  expect(r.findings.some((f) => f.path === "items[0].install.subfolder" && f.severity === "warning")).toBe(true);
});

// ------------------------------------------------------------------ the file itself

test("a file that is not a catalog fails as a file, not as a hundred rows", () => {
  expect(validateCatalog("{ nope", { kind: "skill" }).findings[0]!.message).toContain("not valid JSON");
  expect(validateCatalog("[]", { kind: "skill" }).findings[0]!.message).toContain("top level must be an object");
  expect(validateCatalog(`{"version":1}`, { kind: "skill" }).findings[0]!.path).toBe("items");
  expect(validateCatalog(`{"version":2,"items":[]}`, { kind: "skill" }).findings[0]!.path).toBe("version");
});

test("the kind is taken from the flag, then the document, then the file name — and asked for otherwise", () => {
  expect(inferKind({}, { kind: "plugin", filename: "skills.json" })).toBe("plugin");
  expect(inferKind({ kind: "plugin" }, { filename: "skills.json" })).toBe("plugin");
  expect(inferKind({}, { filename: "/tmp/my-skills.json" })).toBe("skill");
  expect(inferKind({}, {})).toBeUndefined();
  const r = validateCatalog(`{"version":1,"items":[]}`, { filename: "catalog.json" });
  expect(r.ok).toBe(false);
  expect(r.findings[0]!.message).toContain("--kind");
});

test("a file too large to read is refused before it is parsed", () => {
  const r = validateCatalog("x".repeat(3 * 1024 * 1024), { kind: "skill" });
  expect(r.ok).toBe(false);
  expect(r.findings[0]!.message).toContain("KB");
});

// ------------------------------------------------------------------ the report

test("errors come before warnings, and a valid-with-warnings file says warnings do not stop it", () => {
  const r = validateCatalog(doc("skill", [
    { id: "x", description: "d", source: { git: "https://github.com/a/b" } },     // publisher warning only
  ]), { kind: "skill" });
  const lines = reportLines(r, "my.json");
  expect(lines[0]).toContain("valid");
  expect(lines.join("\n")).toContain("warnings do not stop a catalog loading");

  const bad = validateCatalog(doc("skill", [{ id: "Bad Id", source: { git: "https://github.com/a/b" } }]), { kind: "skill" });
  const badLines = reportLines(bad, "my.json");
  expect(badLines[0]).toContain("INVALID");
  // match the severity COLUMN, not the word: the summary line says "0 errors, 2 warnings" and would
  // otherwise count as the first warning
  const firstWarning = badLines.findIndex((l) => l.startsWith("  warning  "));
  const lastError = badLines.map((l) => l.startsWith("  error  ")).lastIndexOf(true);
  expect(firstWarning).toBeGreaterThan(0);
  expect(lastError).toBeLessThan(firstWarning);
});
