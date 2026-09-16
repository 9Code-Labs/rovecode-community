/** The cooperative repo-map build (coding/repomap.ts buildRepoMapChunkAsync) behind the TUI's warm path.
 *  Pins: (1) byte-identical output to the synchronous build — git-listed repo AND the bounded walk, with the
 *  file cap and its note; (2) the event loop keeps turning while it runs: on a cold tags cache over a few
 *  hundred generated files the longest gap between two timer ticks stays far under the synchronous build's
 *  single multi-second block (the sextant froze at its first reveal step for exactly that long). */
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RepoMap, buildRepoMapChunk, buildRepoMapChunkAsync, findSrcFiles, findSrcFilesAsync } from "../../src/coding/repomap.ts";
import { scratchDirs } from "../helpers/scratch.ts";

const scratch = scratchDirs();

/** a non-git tree (the bounded walk): n source files across nested dirs, a skipped dir, a dot-dir, a non-source file */
function fixture(n: number): string {
  const cwd = scratch("rovecode-repomap-async-");
  mkdirSync(join(cwd, ".git")); // stops the ancestor walk; `git ls-files` fails fast here → walk path
  mkdirSync(join(cwd, "src", "deep"), { recursive: true });
  mkdirSync(join(cwd, "node_modules", "dep"), { recursive: true });
  mkdirSync(join(cwd, ".hidden"));
  writeFileSync(join(cwd, "node_modules", "dep", "index.js"), "export function skipped() {}\n");
  writeFileSync(join(cwd, ".hidden", "x.ts"), "export function hidden() {}\n");
  writeFileSync(join(cwd, "README.md"), "# fixture\n");
  for (let i = 0; i < n; i++) {
    const dir = i % 3 === 0 ? join(cwd, "src", "deep") : join(cwd, "src");
    const body = Array.from({ length: 40 }, (_, k) => `export function fn${i}_${k}(a: number): number { return helper${(i + k) % n}(a) + ${k}; }`).join("\n");
    writeFileSync(join(dir, `mod${String(i).padStart(4, "0")}.ts`), `${body}\nexport function helper${i}(a: number): number { return a; }\n`);
  }
  return cwd;
}

const clearCache = (cwd: string): void => rmSync(join(cwd, ".rovecode", "cache"), { recursive: true, force: true });

test("findSrcFilesAsync lists the same files in the same order as findSrcFiles (walk: skip dirs, dot dirs, cap + capped flag)", async () => {
  const cwd = fixture(30);
  const syncStats = { capped: false, viaGit: false }, asyncStats = { capped: false, viaGit: false };
  expect(await findSrcFilesAsync(cwd, asyncStats)).toEqual(findSrcFiles(cwd, syncStats));
  expect(asyncStats).toEqual(syncStats);
  expect(asyncStats.viaGit).toBe(false);
  const cappedSync = { capped: false, viaGit: false }, cappedAsync = { capped: false, viaGit: false };
  expect(await findSrcFilesAsync(cwd, cappedAsync, 10)).toEqual(findSrcFiles(cwd, cappedSync, 10));
  expect(cappedAsync).toEqual({ capped: true, viaGit: false });
  // the git path over this checkout: same list too
  const here = join(import.meta.dir, "..", "..");
  const gitSync = { capped: false, viaGit: false }, gitAsync = { capped: false, viaGit: false };
  expect(await findSrcFilesAsync(here, gitAsync)).toEqual(findSrcFiles(here, gitSync));
  expect(gitAsync).toEqual(gitSync);
});

test("buildRepoMapChunkAsync returns the synchronous build's chunk byte for byte — cold cache and warm, capped and not", async () => {
  const cwd = fixture(24);
  clearCache(cwd);
  const cold = await buildRepoMapChunkAsync(cwd, 800);
  const sync = buildRepoMapChunk(cwd, 800);
  expect(cold).toEqual(sync);
  expect(cold?.text).toContain("mod0000.ts");
  expect(await buildRepoMapChunkAsync(cwd, 800)).toEqual(sync); // warm (disk cache) run
  const cappedAsync = await buildRepoMapChunkAsync(cwd, 800, { maxFiles: 5 });
  expect(cappedAsync).toEqual(buildRepoMapChunk(cwd, 800, { maxFiles: 5 }));
  expect(cappedAsync?.text).toContain("(repo map truncated: 5-file cap reached)");
  expect(await buildRepoMapChunkAsync(cwd, 0)).toBeNull();
});

test("cancellation stops enumeration or cached ranking without writing a partial cache", async () => {
  const cwd = fixture(24);
  const stopped = new AbortController(); stopped.abort(new Error("closed"));
  await expect(buildRepoMapChunkAsync(cwd, 800, { signal: stopped.signal })).rejects.toThrow("closed");
  expect(existsSync(join(cwd, ".rovecode", "cache", "repomap.json"))).toBe(false);
  const files = await findSrcFilesAsync(cwd);
  const rm = new RepoMap(cwd);
  await rm.warmTags(files);
  const ac = new AbortController();
  const ranking = rm.rankedTagsMapAsync([], files, 800, new Set(), ac.signal);
  ac.abort(new Error("closed during ranking"));
  await expect(ranking).rejects.toThrow("closed during ranking");
  expect(existsSync(join(cwd, ".rovecode", "cache", "repomap.json"))).toBe(false);
});

test("the cooperative build keeps the event loop turning on a cold cache: the longest timer gap stays small while the synchronous build blocks for its whole duration", async () => {
  const cwd = fixture(160);
  clearCache(cwd);
  // the synchronous build: one block, measured as the gap it leaves in a 5 ms timer
  let last = performance.now(), syncGap = 0;
  const syncTimer = setInterval(() => { const now = performance.now(); syncGap = Math.max(syncGap, now - last); last = now; }, 5);
  await new Promise((r) => setTimeout(r, 30));
  const t0 = performance.now();
  buildRepoMapChunk(cwd, 1024);
  const syncMs = performance.now() - t0;
  await new Promise((r) => setTimeout(r, 30));
  clearInterval(syncTimer);
  expect(syncGap).toBeGreaterThanOrEqual(syncMs * 0.9); // the whole build sat on the loop
  // the cooperative build over the same cold tree
  clearCache(cwd);
  last = performance.now();
  let asyncGap = 0;
  const asyncTimer = setInterval(() => { const now = performance.now(); asyncGap = Math.max(asyncGap, now - last); last = now; }, 5);
  let chunk;
  try {
    chunk = await buildRepoMapChunkAsync(cwd, 1024);
    // Sample the tail too: ranking/cache writes immediately before resolution used to escape this pin.
    await new Promise((r) => setTimeout(r, 20));
  } finally { clearInterval(asyncTimer); }
  expect(chunk).not.toBeNull();
  // the slice is 12 ms of work; one parse can overrun it, the budget-search step is one tree render — but never
  // the multi-second block. 400 ms is the generous ceiling for a loaded CI box.
  expect(asyncGap).toBeLessThan(Math.max(400, syncMs * 0.5));
  expect(syncMs).toBeGreaterThan(asyncGap); // and the sync build's single block is longer than any cooperative gap
}, 60_000);
