import { test, expect } from "bun:test";
import { extractTags, buildRepoMapChunk, findSrcFiles, RepoMap, type SrcScanStats } from "../../src/coding/repomap.ts";
import { estimateTokens } from "../../src/core/context.ts";
import { mkdtempSync, writeFileSync, rmSync, utimesSync, mkdirSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

// --- fixture repo: every file has outbound refs (like real code), one file
// (core.ts) defines symbols referenced across the repo, one (loner.ts) defines
// a symbol nobody references.
function makeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-rm-"));
  writeFileSync(join(dir, "core.ts"),
    "export function centralHelper(x: number) { return x + 1; }\n" +
    "export class DataStore { save(): void { centralHelper(0); } }\n");
  writeFileSync(join(dir, "fmt.ts"),
    "export function formatOutput(x: number) { return centralHelper(x) + 1; }\n");
  writeFileSync(join(dir, "a.ts"),
    "export const alphaRunner = () => centralHelper(1) + centralHelper(2);\n" +
    "export const alphaStore = new DataStore();\n");
  writeFileSync(join(dir, "b.ts"),
    "export function betaRunner(): DataStore { centralHelper(3); return new DataStore(); }\n");
  writeFileSync(join(dir, "loner.ts"),
    "export function lonelyFunction() { return formatOutput(9); }\n");
  return dir;
}

// --- symbol extraction fixture (bar: "symbol extraction fixture") ---

test("extractTags: TS defs and refs classified like aider's def/ref kinds", () => {
  const src = `
export function topFn(a: number) { return helper(a); }
export class Widget {
  render(): Item { return new Item(makeThing()); }
}
export interface Item { id: string }
export type Alias = Item | null;
export enum Color { Red }
export const arrowFn = (x: number) => topFn(x);
const notAFunction = 42;
obj.methodCall(1);
`;
  const tags = extractTags("f.ts", "f.ts", src);
  const defs = new Set(tags.filter((t) => t.kind === "def").map((t) => t.name));
  const refs = new Set(tags.filter((t) => t.kind === "ref").map((t) => t.name));
  expect(defs).toEqual(new Set(["topFn", "Widget", "render", "Item", "Alias", "Color", "arrowFn"]));
  // plain const is NOT a def (only function-valued declarators count)
  expect(defs.has("notAFunction")).toBe(false);
  // calls, new-expressions, member calls, and type usages are refs
  for (const r of ["helper", "makeThing", "methodCall", "topFn", "Item"]) expect(refs.has(r)).toBe(true);
  // definition names are not double-counted as type refs: Item def line is 5,
  // its type refs come from other lines
  const itemDef = tags.find((t) => t.kind === "def" && t.name === "Item")!;
  for (const t of tags.filter((t) => t.kind === "ref" && t.name === "Item"))
    expect(t.line).not.toBe(itemDef.line);
  // line numbers are 0-based tree-sitter rows (repomap.py L333)
  const topFn = tags.find((t) => t.kind === "def" && t.name === "topFn")!;
  expect(topFn.line).toBe(1);
});

test("extractTags: JS grammar works, unknown extensions yield nothing", () => {
  const js = "function jsThing() { return other(); }\nconst jsArrow = () => jsThing();\n";
  const tags = extractTags("f.js", "f.js", js);
  expect(tags.filter((t) => t.kind === "def").map((t) => t.name).sort()).toEqual(["jsArrow", "jsThing"]);
  expect(tags.filter((t) => t.kind === "ref").map((t) => t.name).sort()).toEqual(["jsThing", "other"]);
  expect(extractTags("f.py", "f.py", "def x(): pass")).toEqual([]);
});

// --- ranking (bar: def/ref graph boosts the definer) ---

test("ranking: file whose symbols are referenced elsewhere outranks unreferenced one", () => {
  const dir = makeFixture();
  const rm = new RepoMap(dir);
  const entries = rm.rankedTags([], findSrcFiles(dir), new Set());
  const defOrder = entries.filter((e) => e.tag).map((e) => `${e.relFname}#${e.tag!.name}`);
  // centralHelper (defined in core.ts, referenced by fmt/a/b) is the top definition
  expect(defOrder[0]).toBe("core.ts#centralHelper");
  // the unreferenced loner def sorts below every core.ts definition
  const idx = (s: string) => defOrder.indexOf(s);
  expect(idx("loner.ts#lonelyFunction")).toBeGreaterThan(idx("core.ts#centralHelper"));
  expect(idx("loner.ts#lonelyFunction")).toBeGreaterThan(idx("core.ts#DataStore"));
  rmSync(dir, { recursive: true, force: true });
});

test("ranking: deterministic across fresh instances (stable order)", () => {
  const dir = makeFixture();
  const run = () => {
    const rm = new RepoMap(dir);
    return rm.rankedTags([], findSrcFiles(dir), new Set())
      .map((e) => (e.tag ? `${e.relFname}#${e.tag.name}@${e.tag.line}` : e.relFname)).join(";");
  };
  const first = run();
  expect(run()).toBe(first);
  expect(run()).toBe(first);
  const c1 = buildRepoMapChunk(dir, 200);
  const c2 = buildRepoMapChunk(dir, 200);
  expect(c1?.text).toBe(c2?.text);
  rmSync(dir, { recursive: true, force: true });
});

// --- token budgeting (bar: budget respected, truncates by rank) ---

test("budget respected: output token estimate never exceeds the budget", () => {
  const dir = makeFixture();
  for (const budget of [30, 60, 120, 500]) {
    const chunk = buildRepoMapChunk(dir, budget);
    if (chunk) {
      expect(estimateTokens(chunk.text)).toBeLessThanOrEqual(budget);
      expect(chunk.tokens).toBeLessThanOrEqual(budget);
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

test("budget truncates by rank: tight budget keeps top-ranked defs, drops loner", () => {
  const dir = makeFixture();
  const big = buildRepoMapChunk(dir, 2000)!;
  expect(big.text).toContain("centralHelper");
  expect(big.text).toContain("lonelyFunction"); // roomy budget includes everything
  // tight budget: highest-ranked definition survives, tail rank is cut
  const small = buildRepoMapChunk(dir, 40)!;
  expect(small.text).toContain("centralHelper");
  expect(small.text).not.toContain("lonelyFunction");
  expect(estimateTokens(small.text)).toBeLessThanOrEqual(40);
  rmSync(dir, { recursive: true, force: true });
});

test("empty/unusable inputs yield no chunk", () => {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-rm-empty-"));
  expect(buildRepoMapChunk(dir, 1000)).toBeNull();
  const fx = makeFixture();
  expect(buildRepoMapChunk(fx, 0)).toBeNull(); // aider get_repo_map L111-112
  rmSync(dir, { recursive: true, force: true });
  rmSync(fx, { recursive: true, force: true });
});

// --- mtime cache (bar: cache keyed by file mtimes + invalidation) ---

test("tags cache: same mtime is a hit, changed mtime re-extracts (repomap.py L233-264)", () => {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-rm-cache-"));
  const p = join(dir, "x.ts");
  writeFileSync(p, "export function firstThing() { return 1; }\n");
  const rm = new RepoMap(dir);
  const t1 = rm.getTags(p, "x.ts");
  expect(t1.map((t) => t.name)).toContain("firstThing");
  expect(rm.extractCount).toBe(1);
  // unchanged mtime -> cache hit, no re-extraction
  expect(rm.getTags(p, "x.ts")).toEqual(t1);
  expect(rm.extractCount).toBe(1);
  // rewrite with new content and force a distinct mtime -> invalidated
  writeFileSync(p, "export function secondThing() { return 2; }\n");
  const future = new Date(Date.now() + 5000);
  utimesSync(p, future, future);
  const t2 = rm.getTags(p, "x.ts");
  expect(rm.extractCount).toBe(2);
  expect(t2.map((t) => t.name)).toContain("secondThing");
  expect(t2.map((t) => t.name)).not.toContain("firstThing");
  // and hits again at the new mtime
  rm.getTags(p, "x.ts");
  expect(rm.extractCount).toBe(2);
  rmSync(dir, { recursive: true, force: true });
});

test("cache invalidation flows through to the built map", () => {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-rm-flow-"));
  writeFileSync(join(dir, "m.ts"), "export function originalName() { return 1; }\n");
  const rm = new RepoMap(dir);
  const before = rm.rankedTagsMap([], findSrcFiles(dir), 500);
  expect(before).toContain("originalName");
  writeFileSync(join(dir, "m.ts"), "export function replacementName() { return 2; }\n");
  const future = new Date(Date.now() + 5000);
  utimesSync(join(dir, "m.ts"), future, future);
  const after = rm.rankedTagsMap([], findSrcFiles(dir), 500);
  expect(after).toContain("replacementName");
  expect(after).not.toContain("originalName");
  rmSync(dir, { recursive: true, force: true });
});

// --- chunk contract (RESERVED repo-map chunk, ADR-007) ---

test("buildRepoMapChunk returns a well-formed repo-map ContextChunk", () => {
  const dir = makeFixture();
  const chunk = buildRepoMapChunk(dir, 400)!;
  expect(chunk.name).toBe("repo-map");
  expect(chunk.priority).toBe(80); // between files (90) and skills: system>files>repo-map>skills>history
  expect(chunk.tokens).toBe(estimateTokens(chunk.text));
  expect(chunk.text.length).toBeGreaterThan(0);
  rmSync(dir, { recursive: true, force: true });
});

// --- pagerank transitivity (round-2 F4: uniform-rank mutant must fail) ---

test("pagerank: multi-hop rank propagation, not raw in-degree (repomap.py L519-550)", () => {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-rm-pr-"));
  // hub.ts is referenced by THREE leaves -> high PageRank; its single outbound
  // reference passes that mass to midThing. popThing has MORE raw referencers
  // (two), but both are rank-poor leaf files nothing links to. PageRank ranks
  // midThing above popThing; a uniform-rank (1/n) mutant scores popThing 2u
  // vs midThing u and flips the order — this fixture discriminates.
  writeFileSync(join(dir, "hub.ts"), "export function hubThing() { return midThing(); }\n");
  writeFileSync(join(dir, "mid.ts"), "export function midThing() { return 1; }\n");
  writeFileSync(join(dir, "pop.ts"), "export function popThing() { return 2; }\n");
  writeFileSync(join(dir, "leaf1.ts"), "hubThing();\n");
  writeFileSync(join(dir, "leaf2.ts"), "hubThing();\n");
  writeFileSync(join(dir, "leaf3.ts"), "hubThing();\n");
  writeFileSync(join(dir, "pleaf1.ts"), "popThing();\n");
  writeFileSync(join(dir, "pleaf2.ts"), "popThing();\n");
  const rm = new RepoMap(dir);
  const defOrder = rm.rankedTags([], findSrcFiles(dir), new Set())
    .filter((e) => e.tag).map((e) => e.tag!.name);
  expect(defOrder.indexOf("midThing")).toBeGreaterThanOrEqual(0);
  expect(defOrder.indexOf("midThing")).toBeLessThan(defOrder.indexOf("popThing"));
  rmSync(dir, { recursive: true, force: true });
});

// --- persistent tags cache (round-2 F1; aider .aider.tags.cache.v4) ---

test("persistent tags cache: a fresh RepoMap reuses saved tags across 'launches' (repomap.py L217-222)", () => {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-rm-disk-"));
  const p1 = join(dir, "one.ts"), p2 = join(dir, "two.ts");
  writeFileSync(p1, "export function oneThing() { return 1; }\n");
  writeFileSync(p2, "export function twoThing() { return oneThing(); }\n");
  const rm1 = new RepoMap(dir);
  const t1 = rm1.getTags(p1, "one.ts");
  rm1.getTags(p2, "two.ts");
  expect(rm1.extractCount).toBe(2);
  rm1.saveCache();
  expect(existsSync(join(dir, ".rovecode", "cache", "repomap.json"))).toBe(true);
  // "second launch": brand-new instance, warm disk -> ZERO extractions
  const rm2 = new RepoMap(dir);
  expect(rm2.getTags(p1, "one.ts")).toEqual(t1);
  rm2.getTags(p2, "two.ts");
  expect(rm2.extractCount).toBe(0);
  // invalidation: content change (mtime+size move) -> exactly that file re-extracts
  writeFileSync(p1, "export function oneThingChanged() { return 3; }\n");
  const future = new Date(Date.now() + 5000);
  utimesSync(p1, future, future);
  const rm3 = new RepoMap(dir);
  expect(rm3.getTags(p1, "one.ts").map((t) => t.name)).toContain("oneThingChanged");
  rm3.getTags(p2, "two.ts");
  expect(rm3.extractCount).toBe(1);
  rmSync(dir, { recursive: true, force: true });
});

test("persistent tags cache: corrupt cache file degrades to cold and heals on save", () => {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-rm-corrupt-"));
  const p = join(dir, "c.ts");
  writeFileSync(p, "export function cThing() { return 1; }\n");
  mkdirSync(join(dir, ".rovecode", "cache"), { recursive: true });
  writeFileSync(join(dir, ".rovecode", "cache", "repomap.json"), "{not json!!");
  const rm = new RepoMap(dir);
  expect(rm.getTags(p, "c.ts").map((t) => t.name)).toContain("cThing");
  expect(rm.extractCount).toBe(1); // corrupt -> cold, no crash (aider recreates, L241-264)
  rm.saveCache();
  const rm2 = new RepoMap(dir);
  rm2.getTags(p, "c.ts");
  expect(rm2.extractCount).toBe(0); // healed
  rmSync(dir, { recursive: true, force: true });
});

// --- bounded enumeration (round-2 F2) ---

test("findSrcFiles: file-count cap stops enumeration and reports capping", () => {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-rm-cap-"));
  for (const n of ["a", "b", "c", "d", "e"]) writeFileSync(join(dir, `${n}.ts`), `export function ${n}Fn() {}\n`);
  const stats: SrcScanStats = { capped: false, viaGit: false };
  const files = findSrcFiles(dir, stats, 3);
  expect(files.length).toBe(3);
  expect(stats.capped).toBe(true);
  // deterministic: lexicographically first names survive the cap
  expect(files.map((f) => f.replaceAll("\\", "/").split("/").pop())).toEqual(["a.ts", "b.ts", "c.ts"]);
  const stats2: SrcScanStats = { capped: false, viaGit: false };
  expect(findSrcFiles(dir, stats2).length).toBe(5);
  expect(stats2.capped).toBe(false);
  rmSync(dir, { recursive: true, force: true });
});

test("findSrcFiles: oversized files are skipped (minified-bundle parse guard)", () => {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-rm-size-"));
  writeFileSync(join(dir, "small.ts"), "export function smallFn() {}\n");
  writeFileSync(join(dir, "huge.ts"), `export const blob = "${"x".repeat(300 * 1024)}";\n`);
  const files = findSrcFiles(dir).map((f) => f.replaceAll("\\", "/"));
  expect(files.length).toBe(1);
  expect(files[0]!.endsWith("/small.ts")).toBe(true);
  rmSync(dir, { recursive: true, force: true });
});

test("findSrcFiles: git repo enumerates via ls-files and honors .gitignore", () => {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-rm-git-"));
  const init = spawnSync("git", ["-C", dir, "init", "-q"], { encoding: "utf8" });
  expect(init.status).toBe(0);
  writeFileSync(join(dir, ".gitignore"), "gen/\nvendored.ts\n");
  writeFileSync(join(dir, "a.ts"), "export function aThing() {}\n");
  writeFileSync(join(dir, "vendored.ts"), "export function ignoredThing() {}\n");
  mkdirSync(join(dir, "gen"));
  writeFileSync(join(dir, "gen", "out.ts"), "export function genThing() {}\n");
  const stats: SrcScanStats = { capped: false, viaGit: false };
  const files = findSrcFiles(dir, stats).map((f) => f.replaceAll("\\", "/"));
  expect(stats.viaGit).toBe(true); // ls-files path, untracked-unignored included
  expect(files.length).toBe(1);
  expect(files[0]!.endsWith("/a.ts")).toBe(true);
  rmSync(dir, { recursive: true, force: true });
});

test("buildRepoMapChunk: cap appends a deterministic truncation note inside the budget", () => {
  const dir = makeFixture();
  const c1 = buildRepoMapChunk(dir, 300, { maxFiles: 2 })!;
  expect(c1.text).toContain("(repo map truncated: 2-file cap reached)");
  expect(estimateTokens(c1.text)).toBeLessThanOrEqual(300);
  expect(c1.tokens).toBeLessThanOrEqual(300);
  const c2 = buildRepoMapChunk(dir, 300, { maxFiles: 2 })!;
  expect(c2.text).toBe(c1.text); // note is part of the deterministic chunk text
  rmSync(dir, { recursive: true, force: true });
});

// --- special entries vs source files (round-2 F5) ---

test("readme.ts is a SOURCE file: its definitions survive instead of a bare special entry", () => {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-rm-readme-"));
  writeFileSync(join(dir, "readme.ts"), "export function readmeHelperFn() { return 1; }\n");
  writeFileSync(join(dir, "use.ts"), "readmeHelperFn();\n");
  writeFileSync(join(dir, "README.md"), "# docs\n");
  const rm = new RepoMap(dir);
  const text = rm.rankedTagsMap([], findSrcFiles(dir), 500);
  expect(text).toContain("readmeHelperFn"); // definition line rendered, not swallowed
  expect(text).toContain("README.md");      // the real docs README stays a bare special
  rmSync(dir, { recursive: true, force: true });
});

// --- docs-only repos (round-2 F6; aider returns early, repomap.py L113-114) ---

test("docs-only repo yields NO chunk instead of a junk specials-only map", () => {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-rm-docs-"));
  writeFileSync(join(dir, "README.md"), "# just docs\n");
  writeFileSync(join(dir, "package.json"), "{}\n");
  expect(buildRepoMapChunk(dir, 1000)).toBeNull();
  rmSync(dir, { recursive: true, force: true });
});

test("walker skips node_modules and dot/output dirs, sorted deterministic", () => {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-rm-walk-"));
  mkdirSync(join(dir, "src"));
  mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true });
  mkdirSync(join(dir, ".git"));
  writeFileSync(join(dir, "src", "keep.ts"), "export function kept() {}\n");
  writeFileSync(join(dir, "node_modules", "pkg", "skip.ts"), "export function skipped() {}\n");
  writeFileSync(join(dir, ".git", "skip2.ts"), "export function skipped2() {}\n");
  writeFileSync(join(dir, "notes.md"), "# not source\n");
  const files = findSrcFiles(dir).map((f) => f.replaceAll("\\", "/"));
  expect(files.length).toBe(1);
  expect(files[0]!.endsWith("src/keep.ts")).toBe(true);
  rmSync(dir, { recursive: true, force: true });
});
