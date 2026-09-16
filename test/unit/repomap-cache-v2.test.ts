/** The tags cache's on-disk shape (coding/repomap-cache.ts, CACHE_VERSION 2): tags as [line, name, kind]
 *  tuples with each file's two path strings stored once. Pins: a saved cache is compact and round-trips
 *  to identical Tag objects; a file of ANOTHER version (the v1 shape, or one from the future) is a cold
 *  cache that is rebuilt and overwritten — never a crash, never a half-read; a torn entry misses alone. */

import { test, expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RepoMap } from "../../src/coding/repomap.ts";
import { CACHE_VERSION, TagsDiskCache } from "../../src/coding/repomap-cache.ts";

function fixture(): { dir: string; p1: string; p2: string; cache: string } {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-rm-v2-"));
  const p1 = join(dir, "one.ts"), p2 = join(dir, "two.ts");
  writeFileSync(p1, "export function oneThing() { return 1; }\nexport const oneMore = oneThing();\n");
  writeFileSync(p2, "export function twoThing() { return oneThing(); }\n");
  return { dir, p1, p2, cache: join(dir, ".rovecode", "cache", "repomap.json") };
}

test("saved cache is version 2 and compact: tuples, paths once per file; a fresh instance round-trips identical tags with zero extractions", () => {
  const { dir, p1, p2, cache } = fixture();
  const rm1 = new RepoMap(dir);
  const t1 = rm1.getTags(p1, "one.ts"), t2 = rm1.getTags(p2, "two.ts");
  expect(rm1.extractCount).toBe(2);
  rm1.saveCache();
  const raw = JSON.parse(readFileSync(cache, "utf8")) as { version: number; entries: Record<string, { rel: string; abs: string; t: unknown[] }> };
  expect(raw.version).toBe(CACHE_VERSION);
  expect(CACHE_VERSION).toBe(2);
  const e1 = raw.entries[p1]!;
  expect(e1.rel).toBe("one.ts"); expect(e1.abs).toBe(p1);
  expect(e1.t.length).toBe(t1.length);
  expect(readFileSync(cache, "utf8")).not.toContain('"relFname"');       // the v1 per-tag shape is gone
  const rm2 = new RepoMap(dir);
  expect(rm2.getTags(p1, "one.ts")).toEqual(t1);
  expect(rm2.getTags(p2, "two.ts")).toEqual(t2);
  expect(rm2.extractCount).toBe(0);
  rmSync(dir, { recursive: true, force: true });
});

test("a version-1 cache file (whole Tags per entry) is a cold cache: rebuilt, then overwritten as version 2", () => {
  const { dir, p1, cache } = fixture();
  mkdirSync(join(dir, ".rovecode", "cache"), { recursive: true });
  const { mtimeMs, size } = require("node:fs").statSync(p1) as { mtimeMs: number; size: number };
  // exactly what version 1 wrote: { version: 1, entries: { [abs]: { mtimeMs, size, tags: Tag[] } } } — with a
  // WRONG tag, so a half-read that trusted it would be visible
  const v1 = { version: 1, entries: { [p1]: { mtimeMs, size, tags: [{ relFname: "one.ts", fname: p1, line: 0, name: "STALE_FROM_V1", kind: "def" }] } } };
  writeFileSync(cache, JSON.stringify(v1));
  const rm = new RepoMap(dir);
  const names = rm.getTags(p1, "one.ts").map((t) => t.name);
  expect(names).toContain("oneThing");
  expect(names).not.toContain("STALE_FROM_V1");
  expect(rm.extractCount).toBe(1);                                          // rebuilt, not read
  rm.saveCache();
  expect((JSON.parse(readFileSync(cache, "utf8")) as { version: number }).version).toBe(2);
  const rm2 = new RepoMap(dir);
  rm2.getTags(p1, "one.ts");
  expect(rm2.extractCount).toBe(0);                                         // the rewrite is a working v2 cache
  rmSync(dir, { recursive: true, force: true });
});

test("a cache from the future (version 99) and a torn v2 entry both miss without crashing; sound entries beside a torn one still hit", () => {
  const { dir, p1, p2, cache } = fixture();
  mkdirSync(join(dir, ".rovecode", "cache"), { recursive: true });
  writeFileSync(cache, JSON.stringify({ version: 99, entries: { [p1]: { m: 1, s: 1, rel: "one.ts", abs: p1, t: [[0, "x", 0]] } } }));
  const c99 = new TagsDiskCache(dir);
  expect(c99.get(p1, 1, 1)).toBeUndefined();
  // a real v2 file, then tear ONE entry's tuple
  const rm = new RepoMap(dir);
  rm.getTags(p1, "one.ts"); rm.getTags(p2, "two.ts"); rm.saveCache();
  const raw = JSON.parse(readFileSync(cache, "utf8")) as { version: number; entries: Record<string, { t: unknown[] }> };
  raw.entries[p1]!.t = [[0, "ok", 0], ["not-a-line", "bad", 7]];
  writeFileSync(cache, JSON.stringify(raw));
  const rm2 = new RepoMap(dir);
  rm2.getTags(p2, "two.ts");
  expect(rm2.extractCount).toBe(0);                                         // the sound entry hits
  rm2.getTags(p1, "one.ts");
  expect(rm2.extractCount).toBe(1);                                         // the torn one re-extracts, alone
  expect(existsSync(cache)).toBe(true);
  rmSync(dir, { recursive: true, force: true });
});
