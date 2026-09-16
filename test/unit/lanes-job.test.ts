/** PORT #47 critic fixes — src/lanes/job.ts runLaneJob over a FAKE process (test/helpers/fake-lane.ts) and a
 *  STUB isolation seam (LaneJobDeps.isolate): no CLI is ever spawned, no git repo is touched. Pins:
 *  MED-1 — isolation kind "none" (worktree AND copy failed → iso.dir IS the parent tree) fails the lane
 *  BEFORE any spawn with the parent-tree refusal; LOW-1 — a signal aborted while the isolation is in
 *  flight ends the lane `cancelled before the lane started`, 0 spawns, the worktree cleaned up; LOW-2 —
 *  two events 1 ms apart show the SECOND one within PROGRESS_MS through ONE trailing flush (the
 *  burst-then-silence CLI), and a lane that ends inside the window leaves no timer behind (no late
 *  onProgress). Every wait is deadline-bounded (a parked promise with no timer hangs the Bun runner). */

import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { IsolationWorkspace } from "../../src/core/orchestrator.ts";
import { PROGRESS_MS, SILENT_MS, runLaneJob, type LaneJobDeps } from "../../src/lanes/job.ts";
import { fakeLaneSpawn, fixtureLines } from "../helpers/fake-lane.ts";

const CODEX = fixtureLines(readFileSync(join(import.meta.dir, "..", "fixtures", "lanes", "codex.jsonl"), "utf8"));
const ENV = { ROVECODE_LANES_ALLOW: "codex" };
const CARD = "spawn codex lane · sandbox workspace-write · approval never · worktree";
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
function deadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const bomb = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error(`${what}: not settled within ${ms}ms`)), ms); });
  return Promise.race([p, bomb]).finally(() => clearTimeout(t));
}
async function until(pred: () => boolean, ms: number, what: string): Promise<void> {
  const t0 = Date.now();
  while (!pred()) { if (Date.now() - t0 > ms) throw new Error(`${what}: not true within ${ms}ms`); await sleep(10); }
}
/** a stub isolation workspace: the kind + dir the job sees, an empty diff, cleanup counted */
function stubIso(kind: IsolationWorkspace["kind"], dir: string): IsolationWorkspace & { cleaned: number } {
  const ws: IsolationWorkspace & { cleaned: number } = { dir, kind, cleaned: 0, diff: async () => "", cleanup: async () => { ws.cleaned++; } };
  return ws;
}
const signalOf = (ac = new AbortController()) => ac.signal;

test("MED-1: isolation kind \"none\" → the lane fails BEFORE any spawn with the parent-tree refusal (agent, usage 0, the card's permissions, no patch); cleanup still runs, no preview", async () => {
  const { spawn, cmds } = fakeLaneSpawn({ lines: CODEX });
  const iso = stubIso("none", "D:/live/tree");
  const previews: string[] = [];
  const r = await deadline(runLaneJob({ spawn, env: ENV, isolate: async () => iso }, "codex", "g", "D:/live/tree", signalOf(), (p) => previews.push(p)), 4_000, "refused lane");
  expect(r.ok).toBe(false);
  // mutation target: the kind "none" guard → the fake runs with cwd === the parent tree and the lane is ok:true
  expect(r.summary).toBe("isolation unavailable — an external lane never runs in the parent tree");
  expect(r).toMatchObject({ agent: "codex", usage: { input: 0, output: 0 }, permissions: CARD });
  expect(r.patch).toBeUndefined();
  expect(r.sessionId).toBeUndefined();
  expect(cmds).toHaveLength(0);
  expect(previews).toEqual([]);
  expect(iso.cleaned).toBe(1);
});

test("LOW-1: a cancel that lands while the isolation is in flight → `cancelled before the lane started`, the fake seam saw 0 commands, the worktree stub was cleaned up", async () => {
  const { spawn, cmds } = fakeLaneSpawn({ lines: CODEX, hold: true });
  const iso = stubIso("worktree", "D:/wt");
  const ac = new AbortController();
  let isolating = 0;
  const isolate: LaneJobDeps["isolate"] = async () => { isolating++; await sleep(60); return iso; };
  const run = runLaneJob({ spawn, env: ENV, isolate }, "codex", "g", "D:/root", ac.signal, () => {});
  await until(() => isolating === 1, 1_000, "isolation started");
  ac.abort(); // the worktree is still being created
  const r = await deadline(run, 4_000, "cancelled-before-start lane");
  expect(r.ok).toBe(false);
  // mutation target: the post-isolation abort check → the runner's own pre-spawn check answers plain "cancelled"
  expect(r.summary).toBe("cancelled before the lane started");
  expect(r).toMatchObject({ agent: "codex", usage: { input: 0, output: 0 }, permissions: CARD });
  expect(cmds).toHaveLength(0); // the CLI never started (both checks reverted: a spawn followed by a kill)
  expect(iso.cleaned).toBe(1);
});

test("LOW-2: two events 1 ms apart → the first flushes at once, the second shows within PROGRESS_MS through ONE trailing flush; nothing more while the CLI is silent, nothing after the lane ends", async () => {
  const { spawn, procs } = fakeLaneSpawn({ lines: [CODEX[1]!, CODEX[3]!], hold: true, delayMs: 1 });
  const ac = new AbortController();
  const previews: { at: number; text: string }[] = [];
  const t0 = Date.now();
  const run = runLaneJob({ spawn, env: ENV, isolate: async () => stubIso("worktree", "D:/wt") }, "codex", "g", "D:/root", ac.signal, (p) => previews.push({ at: Date.now() - t0, text: p }));
  // mutation target: no trailing timer → the second event never shows while the lane is held (the stale tail)
  await until(() => previews.length >= 2, 2_000, "the trailing flush shows the second line");
  expect(previews[0]!.text).toBe("thread thr-codex-1");
  expect(previews[1]!.text).toBe("thread thr-codex-1\nthinking: Look at the guard first.");
  const gap = previews[1]!.at - previews[0]!.at;
  expect(gap).toBeGreaterThanOrEqual(PROGRESS_MS - 25); // coalesced to the end of the window, not a flush per event
  expect(gap).toBeLessThan(1_500);
  await sleep(PROGRESS_MS + 50);
  expect(previews).toHaveLength(2); // silence: the one trailing flush, no periodic re-flush
  ac.abort();
  const r = await deadline(run, 4_000, "held lane cancelled");
  expect(r.ok).toBe(false);
  expect(r.summary.startsWith("cancelled")).toBe(true);
  expect(procs[0]!.alive).toBe(false);
  await sleep(PROGRESS_MS + 50);
  expect(previews).toHaveLength(2); // no timer outlived the lane
});

test("LOW-2: a lane that ends inside the throttle window (a burst, then exit 0) leaves no trailing timer — the result replaces the preview, no late onProgress", async () => {
  const { spawn } = fakeLaneSpawn({ lines: CODEX }); // 10 events in one burst, then exit 0
  const previews: string[] = [];
  const r = await deadline(runLaneJob({ spawn, env: ENV, isolate: async () => stubIso("worktree", "D:/wt") }, "codex", "g", "D:/root", signalOf(), (p) => previews.push(p)), 4_000, "burst lane");
  expect(r.ok).toBe(true);
  expect(r.summary).toBe("Added 4 vitest cases for requireAuth.");
  expect(r.patch).toBe("");
  expect(previews[0]).toBe("thread thr-codex-1"); // the first event flushed; the rest fell inside the window
  const n = previews.length;
  await sleep(PROGRESS_MS + 100);
  expect(previews).toHaveLength(n); // mutation target: the clearTimeout in the job's finally → a flush after the lane ended
});

test("silent lane (live 2026-09-03: opencode retrying a dead provider prints nothing): no stdout for silentMs → a waiting note with the lane timeout as the preview, once; a lane whose first event arrives in time never shows it; nothing after the lane ends", async () => {
  const mute = fakeLaneSpawn({ lines: [], hold: true });
  const ac = new AbortController();
  const previews: string[] = [];
  const run = runLaneJob({ spawn: mute.spawn, env: ENV, isolate: async () => stubIso("worktree", "D:/wt"), silentMs: 60, timeoutMs: 5_000 }, "codex", "g", "D:/root", ac.signal, (p) => previews.push(p));
  await until(() => previews.length >= 1, 2_000, "waiting note");
  expect(previews[0]).toBe("no output from codex after 60ms — still waiting (lane timeout 5s)"); // mutation target: the silent timer / `seen` guard
  await sleep(150);
  expect(previews).toHaveLength(1); // once, not periodic
  ac.abort();
  expect((await deadline(run, 4_000, "silent lane cancelled")).ok).toBe(false);
  await sleep(150);
  expect(previews).toHaveLength(1); // no note after the lane ended (mutation target: clearTimeout(silent) in finally)
  expect(SILENT_MS).toBe(30_000);
  // an event before silentMs: the real tail is the preview and the note never shows
  const talking = fakeLaneSpawn({ lines: [CODEX[1]!], hold: true });
  const ac2 = new AbortController();
  const previews2: string[] = [];
  const run2 = runLaneJob({ spawn: talking.spawn, env: ENV, isolate: async () => stubIso("worktree", "D:/wt"), silentMs: 80, timeoutMs: 5_000 }, "codex", "g", "D:/root", ac2.signal, (p) => previews2.push(p));
  await until(() => previews2.length >= 1, 2_000, "first event");
  await sleep(200);
  expect(previews2).toEqual(["thread thr-codex-1"]); // mutation target: `seen = true` dropped → the note overwrites a live preview
  ac2.abort();
  await deadline(run2, 4_000, "talking lane cancelled");
  // a lane that exits (0, no events) BEFORE the note is due: the result replaces the preview, the note never fires
  const brief = fakeLaneSpawn({ lines: [] });
  const previews3: string[] = [];
  const r3 = await deadline(runLaneJob({ spawn: brief.spawn, env: ENV, isolate: async () => stubIso("worktree", "D:/wt"), silentMs: 60, timeoutMs: 5_000 }, "codex", "g", "D:/root", signalOf(), (p) => previews3.push(p)), 4_000, "brief lane");
  expect(r3.ok).toBe(false);
  expect(r3.summary).toBe("codex exited 0 without a result event");
  await sleep(150);
  expect(previews3).toEqual([]); // mutation target: clearTimeout(silent) in the job's finally → a note after the lane ended
});

// ---------- #82: the lane facts the rovecode.lane span needs ride the job result ----------

test("#82: the result carries the CLI's exit code as the runner saw it (0, and 1 when the CLI exits non-zero after its result event) and the model knob when ROVECODE_LANE_CODEX_MODEL set it; without the knob `model` is absent", async () => {
  const ok = fakeLaneSpawn({ lines: CODEX });
  const r0 = await deadline(runLaneJob({ spawn: ok.spawn, env: { ...ENV, ROVECODE_LANE_CODEX_MODEL: "o4-mini" }, isolate: async () => stubIso("worktree", "D:/wt") }, "codex", "g", "D:/root", signalOf(), () => {}), 4_000, "exit 0 lane");
  expect(r0.ok).toBe(true);
  expect(r0.exitCode).toBe(0); // MUTATION TARGET: drop `exitCode: r.exitCode` from base → undefined
  expect(r0.model).toBe("o4-mini"); // MUTATION TARGET: drop the opts.model spread → undefined
  expect(ok.cmds[0]!.args).toContain("o4-mini"); // the same knob shaped the argv (-m o4-mini)
  const one = fakeLaneSpawn({ lines: CODEX, exitCode: 1 });
  const r1 = await deadline(runLaneJob({ spawn: one.spawn, env: ENV, isolate: async () => stubIso("worktree", "D:/wt") }, "codex", "g", "D:/root", signalOf(), () => {}), 4_000, "exit 1 lane");
  expect(r1.exitCode).toBe(1); // reported as seen — the verdict (done, from the result event) is the runner's business
  expect(r1.model).toBeUndefined();
  expect("model" in r1).toBe(false);
});

test("#82: a lane refused before any spawn (isolation kind \"none\") carries NO exitCode and no model — nothing ran, so nothing is guessed", async () => {
  const { spawn, cmds } = fakeLaneSpawn({ lines: CODEX });
  const r = await deadline(runLaneJob({ spawn, env: { ...ENV, ROVECODE_LANE_CODEX_MODEL: "o4-mini" }, isolate: async () => stubIso("none", "D:/live/tree") }, "codex", "g", "D:/live/tree", signalOf(), () => {}), 4_000, "refused lane");
  expect(r.ok).toBe(false);
  expect(cmds).toHaveLength(0);
  expect("exitCode" in r).toBe(false); // MUTATION TARGET: put exitCode on the refusal shape (e.g. null → the span would say "never observed" for a lane that never existed)
  expect(r.exitCode).toBeUndefined();
  expect(r.model).toBeUndefined();
});

/** A MEASURED WRITE IS NOT A LANDED WRITE (progress.ts rule 4). The worktree diff says what the lane
 *  wrote; only the merge-back says what the parent tree now contains, and the two come apart in three
 *  reachable ways. The third is the one status cannot see: a lane that finished cleanly whose patch would
 *  not apply because a concurrent task had already touched those lines still returns ok, so a surface
 *  reading `ok` (or TaskInfo.patchLines, which is set on exactly that path) would report files that are
 *  not in the tree. `progress.applied` is written by the call that did the applying, so it cannot drift. */
const PATCHED = [
  "diff --git a/src/auth/session.ts b/src/auth/session.ts",
  "index 1111111..2222222 100644",
  "--- a/src/auth/session.ts",
  "+++ b/src/auth/session.ts",
  "@@ -1 +1,2 @@",
  " const a = 1;",
  "+const b = 2;",
  "",
].join("\n");

/** a worktree stub that really did change a file */
function isoWithPatch(): IsolationWorkspace & { cleaned: number } {
  const ws: IsolationWorkspace & { cleaned: number } = {
    dir: "D:/wt", kind: "worktree", cleaned: 0, diff: async () => PATCHED, cleanup: async () => { ws.cleaned++; },
  };
  return ws;
}

test("a lane that finishes and merges back: progress.applied === true, and the merge-back was offered the PARENT tree (not the worktree it came from)", async () => {
  const { spawn } = fakeLaneSpawn({ lines: CODEX });
  const seen: Array<{ patch: string; dir: string }> = [];
  const apply: LaneJobDeps["apply"] = (patch, dir) => { seen.push({ patch, dir }); return true; };
  const r = await deadline(runLaneJob({ spawn, env: ENV, isolate: async () => isoWithPatch(), apply }, "codex", "g", "D:/root", signalOf(), () => {}), 4_000, "landed lane");
  expect(r.ok).toBe(true);
  expect(r.summary).not.toContain("patch-apply-failed");
  expect(r.progress?.applied).toBe(true);
  expect(r.progress?.filesWritten).toEqual(["src/auth/session.ts"]);
  expect(seen).toEqual([{ patch: PATCHED, dir: "D:/root" }]); // mutation target: pass iso.dir → the lane patches its own worktree and the parent tree never changes
});

test("a lane that finishes but whose patch WILL NOT APPLY: ok stays true and the files stay measured, yet applied === false — the case `ok` and TaskInfo.patchLines both get wrong", async () => {
  const { spawn } = fakeLaneSpawn({ lines: CODEX });
  let attempts = 0;
  const apply: LaneJobDeps["apply"] = () => { attempts++; return false; }; // a concurrent task already touched those lines
  const r = await deadline(runLaneJob({ spawn, env: ENV, isolate: async () => isoWithPatch(), apply }, "codex", "g", "D:/root", signalOf(), () => {}), 4_000, "conflicted lane");
  expect(attempts).toBe(1);
  expect(r.ok).toBe(true); // unchanged: the CLI did its job, the merge-back is what failed
  expect(r.summary).toContain("patch-apply-failed");
  // the writes are real, so they stay named — they are simply not in the parent tree
  expect(r.progress?.filesWritten).toEqual(["src/auth/session.ts"]);
  expect(r.progress?.filesWrittenTotal).toBe(1);
  expect(r.progress?.applied).toBe(false); // MUTATION TARGET: derive applied from r.ok / r.status → true, and the surface claims a file that is not there
});

test("a lane that never finished: applied === false and the merge-back is never even attempted, so a discarded worktree cannot read as a landed one", async () => {
  const { spawn } = fakeLaneSpawn({ lines: [] }); // exits 0 with no result event → not `done`
  let attempts = 0;
  const apply: LaneJobDeps["apply"] = () => { attempts++; return true; };
  const iso = isoWithPatch();
  const r = await deadline(runLaneJob({ spawn, env: ENV, isolate: async () => iso, apply }, "codex", "g", "D:/root", signalOf(), () => {}), 4_000, "unfinished lane");
  expect(r.ok).toBe(false);
  expect(attempts).toBe(0); // MUTATION TARGET: apply before the done fork → a cancelled CLI's half-done edits land in the parent tree
  expect(r.progress?.applied).toBe(false);
  expect(r.progress?.filesWritten).toEqual(["src/auth/session.ts"]); // what it wrote, into the worktree that is now gone
  expect(iso.cleaned).toBe(1);
});

test("the result's own `applied` (core/types.ts SpawnResult) agrees with progress.applied and is ABSENT where no merge-back was attempted", async () => {
  const { spawn } = fakeLaneSpawn({ lines: CODEX });
  const landed = await deadline(runLaneJob({ spawn, env: ENV, isolate: async () => isoWithPatch(), apply: () => true }, "codex", "g", "D:/root", signalOf(), () => {}), 4_000, "landed");
  expect(landed.applied).toBe(true);
  expect(landed.applied).toBe(landed.progress?.applied); // one variable feeds both: they cannot drift
  const refused = await deadline(runLaneJob({ spawn, env: ENV, isolate: async () => isoWithPatch(), apply: () => false }, "codex", "g", "D:/root", signalOf(), () => {}), 4_000, "refused");
  expect(refused.applied).toBe(false); // MUTATION TARGET: report `ok` here → tasks.ts `r.applied ?? true` claims a file that is not in the tree
  expect(refused.applied).toBe(refused.progress?.applied);
  // a lane that never finished: no merge-back was ATTEMPTED, which SpawnResult spells absent — while
  // progress.applied is false, because the surface question ("are these files in your tree") has an answer
  const unfinished = await deadline(runLaneJob({ spawn: fakeLaneSpawn({ lines: [] }).spawn, env: ENV, isolate: async () => isoWithPatch(), apply: () => true }, "codex", "g", "D:/root", signalOf(), () => {}), 4_000, "unfinished");
  expect(unfinished.applied).toBeUndefined();
  expect(unfinished.progress?.applied).toBe(false);
});
