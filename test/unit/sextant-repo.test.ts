/** Port #44 re-verify pass — sextant-repo.ts RepoWatcher: the renderer's git/fs work as a unit. Scans are
 *  scheduled from onTick as ONE setTimeout(0), run asynchronously, land with exactly one repaint request,
 *  never overlap (a request during a scan runs after it), stop mid-flight; the idle poll is porcelain-only
 *  after IDLE_SCAN_MS and never while a run is live; a non-repo walks and never polls; scheduleDiff
 *  overwrites the row's counts only from an edit-only base and flags a HEAD base; loadDiff never forces
 *  the mode back. Fake async git runners — nothing spawns here. */

import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileTag, lineHash } from "../../src/coding/hashline.ts";
import type { GitRunnerAsync } from "../../src/sextant/git-status.ts";
import { IDLE_SCAN_MS, RepoWatcher } from "../../src/sextant/sextant-repo.ts";
import type { ToolRow } from "../../src/sextant/types.ts";
import { baseState } from "../helpers/sextant-grid.ts";

const LS = "ls-files -z --cached --others --exclude-standard", STATUS = "status --porcelain=v1 -z --untracked-files=all", BRANCH = "rev-parse --abbrev-ref HEAD";
const macrotask = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) { if (Date.now() > deadline) throw new Error(`not true within ${ms}ms`); await new Promise((r) => setTimeout(r, 5)); }
}
/** a scripted async git: `started` records calls as they are made, `done` as they resolve (after `delay` ms) */
function fakeGit(o: { delay?: number; head?: string | null; branch?: string } = {}) {
  const started: string[] = [], done: string[] = [];
  const run: GitRunnerAsync = (args) => {
    const k = args.join(" ");
    started.push(k);
    return new Promise((res) => setTimeout(() => {
      done.push(k);
      res(k === LS ? { status: 0, stdout: "a.ts\0src/b.ts\0" } : k === STATUS ? { status: 0, stdout: " M a.ts\0" } : k === BRANCH ? { status: 0, stdout: `${o.branch ?? "main"}\n` }
        : k.startsWith("show ") ? (o.head === null || o.head === undefined ? { status: 128, stdout: "" } : { status: 0, stdout: o.head }) : { status: 128, stdout: "" });
    }, o.delay ?? 0));
  };
  return { run, started, done };
}
const none: GitRunnerAsync = async () => null;

test("start: the full scan is ONE setTimeout(0) from onTick, applied on completion (files, statuses, branch) with exactly one repaint; the idle poll re-reads the porcelain only after IDLE_SCAN_MS and never while a run is live", async () => {
  const s = baseState({ cwd: "C:/repo" });
  let dirty = 0;
  const g = fakeGit({ delay: 10 });
  const w = new RepoWatcher({ state: s, clock: () => 1000, git: g.run, dirty: () => dirty++ }, true);
  w.onTick(1000, false); w.onTick(1000, false);
  expect(g.started).toEqual([]);                                           // nothing before the macrotask
  await macrotask();
  expect([...g.started].sort()).toEqual([LS, BRANCH, STATUS].sort());      // the three calls, once (the second onTick did not double-arm)
  expect(w.scanning).toBe(true);
  expect(dirty).toBe(0);
  await until(() => dirty === 1);
  expect(w.scanning).toBe(false);
  expect(s.files.paths).toEqual(["a.ts", "src/b.ts"]);
  expect(s.files.statuses.get("a.ts")).toBe("M");
  expect(s.repo.branch).toBe("main");
  g.started.length = 0;
  w.onTick(1000 + IDLE_SCAN_MS - 1, false); await macrotask(); await macrotask();
  expect(g.started).toEqual([]);                                           // not due yet
  w.onTick(1000 + IDLE_SCAN_MS, true); await macrotask(); await macrotask();
  expect(g.started).toEqual([]);                                           // never while running
  w.onTick(1000 + IDLE_SCAN_MS, false);
  await until(() => dirty === 2);
  expect(g.started).toEqual([STATUS]);                                     // porcelain only (mutation: full → three calls)
  w.stop();
});

test("intro preparation shares one initial scan and settles only after files/status/branch are applied", async () => {
  const s = baseState({ cwd: "C:/repo" });
  const g = fakeGit({ delay: 40 });
  let dirty = 0, ready = false;
  const w = new RepoWatcher({ state: s, clock: () => 1000, git: g.run, dirty: () => dirty++ }, true);
  w.onTick(1000, false); // preparation takes over this pending timer, not a second scan
  const pending = w.prepare();
  expect(w.prepare()).toBe(pending);
  void pending.then(() => { ready = true; });
  await macrotask(); expect(ready).toBe(false);
  expect(g.started).toHaveLength(3); expect(s.files.paths).toEqual([]);
  await pending;
  expect(s.files.paths).toEqual(["a.ts", "src/b.ts"]);
  expect(s.repo.branch).toBe("main"); expect(dirty).toBe(1);
  await w.stop();
});

test("one scan in flight at a time: a mutation during a scan does not spawn a concurrent one — it runs on the first tick after the scan settles; stop() mid-flight drops the result and the repaint", async () => {
  const s = baseState({ cwd: "C:/repo" });
  let dirty = 0;
  const g = fakeGit({ delay: 60 });
  const w = new RepoWatcher({ state: s, clock: () => 0, git: g.run, dirty: () => dirty++ }, true);
  w.onTick(0, false); await macrotask();
  expect(g.started).toHaveLength(3);
  w.afterMutation(); w.onTick(0, false); await macrotask(); await macrotask();
  expect(g.started).toHaveLength(3);                                       // no second scan beside the first (mutation: drop the inFlight guard → 6)
  await until(() => dirty === 1);
  w.onTick(0, false);
  await until(() => g.started.length === 6);                               // the queued full scan runs now
  await until(() => dirty === 2);
  // stop while a scan is pending
  const s2 = baseState({ cwd: "C:/repo", repo: { name: "repo", branch: null, modified: 0 } });
  let dirty2 = 0;
  const g2 = fakeGit({ delay: 40 });
  const w2 = new RepoWatcher({ state: s2, clock: () => 0, git: g2.run, dirty: () => dirty2++ }, true);
  w2.onTick(0, false); await macrotask();
  expect(w2.scanning).toBe(true);
  w2.stop();
  await until(() => g2.done.length === 3);
  await macrotask();
  expect(dirty2).toBe(0);
  expect(s2.files.paths).toEqual([]);                                      // the late result was dropped
  expect(s2.repo.branch).toBeNull();
  w.stop();
});

test("non-repo (git → null): the bounded walk lists the files, statuses null, branch null, and there is no idle poll nor a rescan after a mutation; scan:false never touches git at all", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-sx-repo-"));
  try {
    writeFileSync(join(dir, "z.txt"), ""); mkdirSync(join(dir, "sub")); writeFileSync(join(dir, "sub", "a.ts"), "");
    const s = baseState({ cwd: dir });
    let dirty = 0;
    const w = new RepoWatcher({ state: s, clock: () => 0, git: none, dirty: () => dirty++ }, true);
    w.onTick(0, false);
    await until(() => dirty === 1);
    expect(s.files.paths).toEqual(["sub/a.ts", "z.txt"]);
    expect(s.files.statuses.size).toBe(0);
    expect(s.repo.branch).toBeNull();
    w.onTick(10 * IDLE_SCAN_MS, false); await macrotask(); await macrotask();
    w.afterMutation(); w.onTick(20 * IDLE_SCAN_MS, false); await macrotask(); await macrotask();
    expect(dirty).toBe(1);
    w.stop();
    const g = fakeGit();
    const off = new RepoWatcher({ state: baseState({ cwd: dir }), clock: () => 0, git: g.run, dirty: () => { throw new Error("no repaint expected"); } }, false);
    off.onTick(0, false); off.afterMutation(); off.afterAttach(); off.onTick(10 * IDLE_SCAN_MS, false);
    await macrotask(); await macrotask();
    expect(g.started).toEqual([]);
    off.stop();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("scheduleDiff: a captured pre-edit base → edit-only hunks overwrite the row's counts (no flag); ops → the base is rebuilt (same); no base → HEAD hunks are flagged `head` and the row keeps its counts; nothing at all → no change; loadDiff shows HEAD flagged without forcing the mode; stop() drops a pending diff", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-sx-diff-"));
  try {
    const before = "keep-1\nold-line\nkeep-2\nextra\n";                   // the file as the model read it (already dirty vs HEAD)
    writeFileSync(join(dir, "n.txt"), "keep-1\nnew-line\nkeep-2\nextra\n"); // after the edit
    const s = baseState({ cwd: dir });
    let dirty = 0;
    const g = fakeGit({ head: "keep-1\nold-line\nkeep-2\n" });
    const w = new RepoWatcher({ state: s, clock: () => 0, git: g.run, dirty: () => dirty++ }, false);
    const row: ToolRow = { kind: "tool", callId: "c", tool: "edit", verb: "edit", label: "n.txt", path: "n.txt", running: false, ok: true, add: 7, del: 7 };
    w.scheduleDiff(row, "n.txt", before, []);
    await until(() => s.code.diff !== null);
    expect(s.code.diff).toMatchObject({ file: "n.txt", add: 1, del: 1 });
    expect(s.code.diff!.base).toBeUndefined();
    expect(s.code.mode).toBe("diff");
    expect(row).toMatchObject({ add: 1, del: 1 });
    expect(dirty).toBe(1);
    s.code.diff = null; s.code.mode = "code"; row.add = 7; row.del = 7;
    w.scheduleDiff(row, "n.txt", undefined, [{ tag: fileTag(before), anchorLine: 2, anchorHash: lineHash("old-line"), newLines: ["new-line"] }]);
    await until(() => s.code.diff !== null);
    expect(s.code.diff).toMatchObject({ add: 1, del: 1 });                 // rebuilt from the ops (HEAD supplies `old-line`)
    expect(s.code.diff!.base).toBeUndefined();
    expect(row).toMatchObject({ add: 1, del: 1 });
    s.code.diff = null; s.code.mode = "code"; row.add = 7; row.del = 7;
    w.scheduleDiff(row, "n.txt", undefined, []);
    await until(() => s.code.diff !== null);
    expect(s.code.diff).toMatchObject({ add: 2, del: 1, base: "head" });   // HEAD → disk: new-line replaces old-line, extra added
    expect(String(s.code.mode)).toBe("diff");
    expect(row).toMatchObject({ add: 7, del: 7 });                         // untouched (mutation: overwritten → 2/1)
    const bare = new RepoWatcher({ state: s, clock: () => 0, git: none, dirty: () => dirty++ }, false);
    s.code.diff = null; s.code.mode = "code"; const n = dirty;
    bare.scheduleDiff(row, "n.txt", undefined, []);
    await macrotask(); await macrotask(); await macrotask();
    expect(s.code.diff).toBeNull(); expect(s.code.mode).toBe("code"); expect(dirty).toBe(n);
    s.code.mode = "run";
    w.loadDiff("n.txt");
    await until(() => s.code.diff !== null);
    expect(s.code.diff).toMatchObject({ file: "n.txt", add: 2, del: 1, base: "head" });
    expect(s.code.mode).toBe("run");                                       // the user moved on: not forced back to diff
    s.code.diff = null; const m = dirty;
    w.scheduleDiff(row, "n.txt", before, []);
    w.stop();
    await macrotask(); await macrotask(); await macrotask();
    expect(s.code.diff).toBeNull(); expect(dirty).toBe(m);
    bare.stop();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
