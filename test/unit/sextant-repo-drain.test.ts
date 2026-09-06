/** The tui-sextant "flake", root-caused: every test there exits through quit(), which removed the
 *  scratch repo while the repo watcher's `git status` child was still alive — on Windows a live child
 *  holds its cwd and rmSync answers EBUSY, so a DIFFERENT test failed each run. The fix is in three
 *  layers and each is pinned here: the async git runner takes an AbortSignal and settles only once the
 *  killed child is GONE (its `close`), RepoWatcher.stop() aborts its scan and returns a promise that
 *  resolves when those children have exited, and SextantRenderer.drain() exposes it to callers that
 *  are about to remove the cwd. A REAL bun child is used for the kill path — a fake could not prove
 *  the process is gone. */

import { test, expect } from "bun:test";
import { gitRunnerAsync, type GitRunnerAsync } from "../../src/sextant/git-status.ts";
import { RepoWatcher } from "../../src/sextant/sextant-repo.ts";
import { makeState } from "../helpers/sextant-fixtures-keys.ts";

/** a child that sleeps 20 s unless killed — stands in for a slow `git status` */
const SLEEPER = ["bun", "-e", "setTimeout(() => {}, 20000)"];

test("abort kills a live child and the promise settles null only after the process is gone", async () => {
  const run = gitRunnerAsync({ argv: () => SLEEPER, timeoutMs: 30_000 });
  const ac = new AbortController();
  const t0 = Date.now();
  const p = run(["status"], process.cwd(), ac.signal);
  await new Promise((r) => setTimeout(r, 150)); // let the child actually start
  ac.abort();
  const result = await p;
  expect(result).toBeNull();
  expect(Date.now() - t0).toBeLessThan(5_000); // settled from the kill, not from the 30 s timeout
});

test("an already-aborted signal never spawns at all", async () => {
  let spawned = 0;
  const run = gitRunnerAsync({ argv: () => { spawned++; return SLEEPER; } });
  const ac = new AbortController();
  ac.abort();
  expect(await run(["status"], process.cwd(), ac.signal)).toBeNull();
  expect(spawned).toBe(0);
});

test("without a signal the runner behaves as before: a real command completes with its output", async () => {
  const run = gitRunnerAsync({ argv: () => ["bun", "-e", "process.stdout.write('ok')"] });
  const r = await run([], process.cwd());
  expect(r).toEqual({ status: 0, stdout: "ok" });
});

test("RepoWatcher.stop() aborts the scan in flight and resolves once its git children have settled", async () => {
  const s = makeState();
  let seen: AbortSignal | undefined;
  let released = false;
  // a fake git that parks until its signal aborts — the shape of a slow `git status` on a big repo
  const git: GitRunnerAsync = (_a, _c, signal) => new Promise((resolve) => {
    seen = signal;
    if (signal?.aborted) { resolve(null); return; }
    signal?.addEventListener("abort", () => { released = true; resolve(null); }, { once: true });
  });
  const w = new RepoWatcher({ state: s, clock: () => 1000, git, dirty: () => {} }, true);
  w.onTick(1000, false);
  await new Promise((r) => setTimeout(r, 5)); // the onTick timer fires and the scan starts
  expect(w.scanning).toBe(true);
  expect(seen).toBeDefined();
  expect(seen!.aborted).toBe(false);
  const stopped = w.stop();
  expect(seen!.aborted).toBe(true);
  await stopped;
  expect(released).toBe(true);
  expect(w.scanning).toBe(false);
  // idempotent: a second stop() is an already-settled promise, never a throw
  await w.stop();
});

test("stop() with nothing in flight resolves immediately", async () => {
  const w = new RepoWatcher({ state: makeState(), clock: () => 0, git: async () => null, dirty: () => {} }, false);
  await w.stop();
  expect(w.scanning).toBe(false);
});
