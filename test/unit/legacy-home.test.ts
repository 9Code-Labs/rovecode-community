/** A scratch home must be scratch.
 *
 *  The config directory was renamed ~/.cumulus → ~/.rovecode, and the migration copies the old one into
 *  the new one on first use. It also honoured an EXPLICIT ROVECODE_HOME "which is what makes it testable"
 *  — so pointing ROVECODE_HOME at a fresh path, the ordinary way to isolate a test or a clean-room check,
 *  silently filled it with a copy of the user's credentials. During this repository's own release
 *  verification (2026-09-06) that billed two real API calls before anyone noticed the isolated home was
 *  not isolated. */

import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateLegacyHome } from "../../src/providers/auth.ts";

const dirs: string[] = [];
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** an old-style home holding a key nobody wants copied around */
function legacyHome(): string {
  const d = tmp("rovecode-legacy-");
  writeFileSync(join(d, "credentials.json"), JSON.stringify({ acme: { type: "api", key: "sk-from-the-old-home" } }));
  return d;
}

test("a path the user chose is never filled with a copy of the old home", () => {
  const legacy = legacyHome();
  const chosen = join(tmp("rovecode-scratch-"), "home");        // does not exist yet: the migration's trigger
  const notes: string[] = [];
  migrateLegacyHome(chosen, { explicit: true, legacyDir: legacy, note: (l) => notes.push(l) });
  expect(existsSync(chosen)).toBe(false);                        // nothing was created
  expect(notes).toEqual([]);
});

test("the default home still inherits it, and says so out loud", () => {
  const legacy = legacyHome();
  const dflt = join(tmp("rovecode-default-"), ".rovecode");
  const notes: string[] = [];
  migrateLegacyHome(dflt, { legacyDir: legacy, note: (l) => notes.push(l) });
  expect(JSON.parse(readFileSync(join(dflt, "credentials.json"), "utf8"))).toHaveProperty("acme");
  expect(notes).toHaveLength(1);
  expect(notes[0]).toContain(legacy);
  expect(notes[0]).toContain(dflt);
  expect(notes[0]).toContain("the old one is untouched");        // a copy, never a move
  expect(existsSync(join(legacy, "credentials.json"))).toBe(true);
});

test("an existing directory is left alone, however empty it is", () => {
  const legacy = legacyHome();
  const already = tmp("rovecode-existing-");                     // exists, empty — a common scratch shape
  const notes: string[] = [];
  migrateLegacyHome(already, { legacyDir: legacy, note: (l) => notes.push(l) });
  expect(existsSync(join(already, "credentials.json"))).toBe(false);
  expect(notes).toEqual([]);
});
