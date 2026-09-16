/** PORT #47 — src/lanes/runner.ts over a FAKE process (test/helpers/fake-lane.ts): no CLI is ever
 *  spawned. Pins: the spawn seam receives the adapter's exact command; the log ring is bounded; every
 *  event reaches the progress callback with the tail; done/fail/usage/session id; timeout → `timed out`;
 *  cancel → SIGINT first then the tree kill for interruptFirst adapters (order observed on the fake), a
 *  clean SIGINT exit skips the kill, straight kill otherwise; an orphaned pipe is abandoned; exit≠0 /
 *  exit 0 without a result → fail; a missing binary and a throwing parse are data. Every wait is
 *  deadline-bounded (a parked promise with no timer hangs the Bun runner). */

import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ABORT_GRACE_MS } from "../../src/core/executor.ts";
import { claudeAdapter } from "../../src/lanes/claude.ts";
import { codexAdapter } from "../../src/lanes/codex.ts";
import { opencodeAdapter } from "../../src/lanes/opencode.ts";
import { INTERRUPT_GRACE_MS, LOG_RING, LogRing, runExternalLane, type KillStep } from "../../src/lanes/runner.ts";
import type { AgentAdapter, LaneEvent, LaneOpts } from "../../src/lanes/types.ts";
import { fakeLaneSpawn, fixtureLines, type FakeScript } from "../helpers/fake-lane.ts";

const FIX = join(import.meta.dir, "..", "fixtures", "lanes");
const fixture = (id: string): string[] => fixtureLines(readFileSync(join(FIX, `${id}.jsonl`), "utf8"));
const CODEX = fixture("codex");
const opts = (over: Partial<LaneOpts> = {}): LaneOpts => ({ cwd: "D:/work/wt", timeoutMs: 5_000, ...over });

function deadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const bomb = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error(`${what}: not settled within ${ms}ms`)), ms); });
  return Promise.race([p, bomb]).finally(() => clearTimeout(t));
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** an adapter that logs every line verbatim and ends on "END" (ring/garbage tests) */
const echo: AgentAdapter = {
  id: "codex", interruptFirst: false,
  command: (t, o) => ({ bin: "echo", args: [t.goal], cwd: o.cwd }),
  permissionSummary: () => "echo",
  parse(line, st) {
    if (line === "BOOM") throw new Error("adapter bug");
    if (line === "END") return [{ kind: "done", summary: st.lastText ?? "" }];
    st.lastText = line;
    return [{ kind: "log", text: line }];
  },
};

test("happy path: the spawn seam gets the adapter's exact command; done + summary + usage + session id + exit 0; every event reaches onEvent with a ≤3-line tail; log = one line per event", async () => {
  const { spawn, cmds, procs } = fakeLaneSpawn({ lines: CODEX });
  const seen: { ev: LaneEvent; tail: string[] }[] = [];
  const r = await deadline(runExternalLane(codexAdapter, { goal: "write vitest cases" }, opts(), { spawn, onEvent: (ev, tail) => seen.push({ ev, tail: [...tail] }) }), 5_000, "lane");
  expect(cmds).toHaveLength(1);
  expect(cmds[0]!.bin).toBe("codex"); // mutation target: `deps.spawn ?? bunLaneSpawn` ignoring the injected seam (would spawn a real codex)
  expect(cmds[0]!.args.slice(0, 8)).toEqual(["-a", "never", "exec", "--json", "--sandbox", "workspace-write", "-C", "D:/work/wt"]);
  expect(cmds[0]!.args.at(-1)).toBe("write vitest cases");
  expect(r.status).toBe("done");
  expect(r.summary).toBe("Added 4 vitest cases for requireAuth."); // mutation target: the `done` capture
  expect(r.usage).toEqual({ input: 5300, output: 800, cacheRead: 2000 }); // mutation target: the usage fold
  expect(r.sessionId).toBe("thr-codex-1");
  expect(r.exitCode).toBe(0);
  expect(r.garbage).toBe(1); // the fixture header
  expect(r.error).toBeUndefined();
  expect(seen).toHaveLength(10);
  expect(seen.map((s) => s.ev.kind)).toEqual(["log", "log", "bash", "bash", "progress", "edit", "edit", "log", "usage", "done"]);
  expect(seen[0]!.tail).toEqual(["thread thr-codex-1"]);
  expect(seen[9]!.tail).toHaveLength(3);
  expect(seen[9]!.tail[2]).toBe("done: Added 4 vitest cases for requireAuth.");
  expect(r.log).toHaveLength(10);
  expect(r.log[3]).toBe("$ bash -lc 'ls tests' → exit 0 · guard.test.ts");
  expect(procs[0]!.steps).toEqual([]); // nothing was interrupted or killed
});

test("log ring: bounded at LOG_RING lines, newest kept; LogRing unit", async () => {
  const ring = new LogRing(2);
  ring.push("a"); ring.push("b"); ring.push("c");
  expect(ring.tail()).toEqual(["b", "c"]); expect(ring.length).toBe(2); expect(ring.tail(1)).toEqual(["c"]);
  const lines = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`);
  const { spawn } = fakeLaneSpawn({ lines: [...lines, "END"] });
  const r = await deadline(runExternalLane(echo, { goal: "g" }, opts(), { spawn }), 5_000, "ring lane");
  expect(r.status).toBe("done");
  expect(r.summary).toBe("line 500");
  expect(LOG_RING).toBe(200);
  expect(r.log).toHaveLength(LOG_RING); // mutation target: the splice in LogRing.push
  expect(r.log[0]).toBe("line 302"); // 500 logs + "done: …" = 501 entries, the last 200 kept
  expect(r.log.at(-1)).toBe("done: line 500");
});

test("verdicts: a fail event → failed with its error; exit≠0 without a result → failed with code + stderr tail; exit 0 without a result event → failed, honestly", async () => {
  const fail = await runExternalLane(codexAdapter, { goal: "g" }, opts(), { spawn: fakeLaneSpawn({ lines: [CODEX[1]!, '{"type":"turn.failed","error":{"message":"sandbox denied write"}}'] }).spawn });
  expect(fail.status).toBe("failed");
  expect(fail.error).toBe("sandbox denied write");
  expect(fail.summary).toBe("");
  expect(fail.sessionId).toBe("thr-codex-1");
  const crash = await runExternalLane(codexAdapter, { goal: "g" }, opts(), { spawn: fakeLaneSpawn({ lines: [CODEX[1]!], exitCode: 2, stderr: "codex: not logged in" }).spawn });
  expect(crash.status).toBe("failed");
  expect(crash.error).toBe("codex exited with code 2 without a result: codex: not logged in"); // mutation target: `code !== 0` branch
  expect(crash.exitCode).toBe(2);
  const silent = await runExternalLane(codexAdapter, { goal: "g" }, opts(), { spawn: fakeLaneSpawn({ lines: [CODEX[1]!, CODEX[2]!] }).spawn });
  expect(silent.status).toBe("failed");
  expect(silent.error).toBe("codex exited 0 without a result event"); // mutation target: exit 0 → done
  expect(silent.log).toEqual(["thread thr-codex-1"]);
});

test("timeout: the wall-clock cutter kills the lane (straight kill for a non-interruptFirst adapter) and reports `timed out`", async () => {
  const { spawn, procs } = fakeLaneSpawn({ lines: [CODEX[1]!], hold: true });
  const steps: KillStep[] = [];
  const t0 = Date.now();
  const r = await deadline(runExternalLane(codexAdapter, { goal: "g" }, opts({ timeoutMs: 100 }), { spawn, steps }), 4_000, "timed-out lane");
  expect(r.status).toBe("failed");
  expect(r.error).toBe("timed out after 100ms"); // mutation target: the timeout timer / the timedOut verdict
  expect(Date.now() - t0).toBeLessThan(2_000);
  expect(steps).toEqual(["kill"]); // codex: no SIGINT-finishes-turn contract → no interrupt step
  expect(procs[0]!.steps).toEqual(["kill"]);
  expect(r.exitCode).toBe(143);
  expect(r.log).toEqual(["thread thr-codex-1"]);
});

test("cancel, interruptFirst adapter: SIGINT first, the tree kill after the grace when the CLI ignores it — order observed on the fake; a SIGINT that ends the turn skips the kill", async () => {
  const ignoring = fakeLaneSpawn({ lines: [CODEX[1]!], hold: true, interruptExits: false });
  const ac = new AbortController();
  const steps: KillStep[] = [];
  const run = runExternalLane(claudeAdapter, { goal: "g" }, opts(), { spawn: ignoring.spawn, signal: ac.signal, graceMs: 60, steps });
  await sleep(30);
  ac.abort();
  const r = await deadline(run, 4_000, "cancelled lane");
  expect(r.status).toBe("cancelled");
  expect(r.error).toBe("cancelled");
  expect(steps).toEqual(["interrupt", "kill"]); // mutation target: skip the interrupt / kill at once
  expect(ignoring.procs[0]!.steps).toEqual(["interrupt", "kill"]);
  expect(r.exitCode).toBe(143);
  // the CLI finishes its turn on SIGINT: exits 130 inside the grace → the pending kill is cancelled
  const polite = fakeLaneSpawn({ lines: [CODEX[1]!], hold: true, interruptExits: true });
  const ac2 = new AbortController();
  const steps2: KillStep[] = [];
  const run2 = runExternalLane(claudeAdapter, { goal: "g" }, opts(), { spawn: polite.spawn, signal: ac2.signal, graceMs: 1_000, steps: steps2 });
  await sleep(30);
  const t0 = Date.now();
  ac2.abort();
  const r2 = await deadline(run2, 4_000, "polite lane");
  expect(Date.now() - t0).toBeLessThan(800); // did not wait out the grace
  expect(r2.status).toBe("cancelled");
  expect(steps2).toEqual(["interrupt"]); // the pending kill timer was cleared when the runner returned
  expect(polite.procs[0]!.steps).toEqual(["interrupt"]);
  await sleep(1_100); // past the grace: a leaked kill timer would show up on the fake now
  expect(polite.procs[0]!.steps).toEqual(["interrupt"]); // mutation target: the finally that clears `timers`
  expect(r2.exitCode).toBe(130);
  expect(INTERRUPT_GRACE_MS).toBe(3_000);
});

test("cancel, non-interruptFirst adapter → straight kill; a non-deliverable interrupt (the win32 shape) also falls straight to the kill; a pre-aborted signal cancels at once WITHOUT spawning", async () => {
  const codex = fakeLaneSpawn({ lines: [CODEX[1]!], hold: true });
  const ac = new AbortController();
  const steps: KillStep[] = [];
  const run = runExternalLane(codexAdapter, { goal: "g" }, opts(), { spawn: codex.spawn, signal: ac.signal, graceMs: 60, steps });
  await sleep(30);
  ac.abort();
  expect((await deadline(run, 4_000, "codex cancel")).status).toBe("cancelled");
  expect(steps).toEqual(["kill"]);
  expect(codex.procs[0]!.steps).toEqual(["kill"]); // never interrupted
  const win = fakeLaneSpawn({ lines: [CODEX[1]!], hold: true, interruptDeliverable: false });
  const ac2 = new AbortController();
  const steps2: KillStep[] = [];
  const run2 = runExternalLane(claudeAdapter, { goal: "g" }, opts(), { spawn: win.spawn, signal: ac2.signal, graceMs: 60, steps: steps2 });
  await sleep(30);
  ac2.abort();
  expect((await deadline(run2, 4_000, "win32-shape cancel")).status).toBe("cancelled");
  expect(steps2).toEqual(["kill"]); // the runner records only a DELIVERED interrupt
  expect(win.procs[0]!.steps).toEqual(["interrupt", "kill"]); // it was attempted, reported undeliverable
  const pre = new AbortController(); pre.abort();
  const never = fakeLaneSpawn({ lines: CODEX, hold: true });
  const steps3: KillStep[] = [];
  const r3 = await deadline(runExternalLane(codexAdapter, { goal: "g" }, opts(), { spawn: never.spawn, signal: pre.signal, steps: steps3 }), 4_000, "pre-aborted");
  expect(r3).toEqual({ status: "cancelled", summary: "", error: "cancelled", exitCode: null, log: [], garbage: 0, progress: { toolCalls: 0, filesWritten: [], filesWrittenTotal: 0 } });
  // critic LOW-1: an already-aborted signal (the job awaited its worktree meanwhile) spawns NOTHING
  // (mutation target: the pre-spawn check → a spawn followed by a kill, exitCode 143, steps ["kill"])
  expect(never.cmds).toHaveLength(0);
  expect(never.procs).toHaveLength(0);
  expect(steps3).toEqual([]);
});

test("an orphan holding the pipe: after the kill the reader is abandoned (ABORT_GRACE_MS) so the lane settles with exitCode null instead of parking", async () => {
  const { spawn, procs } = fakeLaneSpawn({ lines: [CODEX[1]!], hold: true, ignoreKill: true });
  const ac = new AbortController();
  const steps: KillStep[] = [];
  const run = runExternalLane(codexAdapter, { goal: "g" }, opts(), { spawn, signal: ac.signal, steps });
  await sleep(30);
  const t0 = Date.now();
  ac.abort();
  const r = await deadline(run, 4_000, "abandoned lane");
  expect(r.status).toBe("cancelled");
  expect(steps).toEqual(["kill", "abandon"]); // mutation target: drop the abandon timer → the runner parks (deadline trips)
  expect(procs[0]!.steps).toEqual(["kill", "abandon"]);
  expect(r.exitCode).toBeNull();
  expect(Date.now() - t0).toBeGreaterThanOrEqual(ABORT_GRACE_MS - 5);
  expect(Date.now() - t0).toBeLessThan(ABORT_GRACE_MS * 2 + 500);
});

test("a missing binary is a failed lane (never a throw); a throwing adapter parse counts as garbage and the lane still completes; resume routes through adapter.resume()", async () => {
  const r = await runExternalLane(codexAdapter, { goal: "g" }, opts(), { spawn: fakeLaneSpawn({ throwOnSpawn: "ENOENT: codex not found" }).spawn });
  expect(r.status).toBe("failed");
  expect(r.error).toBe("spawn failed: codex: ENOENT: codex not found");
  expect(r.exitCode).toBeNull();
  const r2 = await deadline(runExternalLane(echo, { goal: "g" }, opts(), { spawn: fakeLaneSpawn({ lines: ["one", "BOOM", "two", "END"] }).spawn }), 4_000, "throwing parse");
  expect(r2.status).toBe("done");
  expect(r2.summary).toBe("two");
  expect(r2.garbage).toBe(1); // mutation target: the try/catch around adapter.parse
  const { spawn, cmds } = fakeLaneSpawn({ lines: fixture("claude") });
  const r3 = await deadline(runExternalLane(claudeAdapter, { goal: "now add tests" }, opts({ resume: "sess-claude-1" }), { spawn }), 4_000, "resume");
  expect(r3.status).toBe("done");
  expect(cmds[0]!.args.slice(-2)).toEqual(["--resume", "sess-claude-1"]); // mutation target: `opts.resume && adapter.resume` → command()
  expect(cmds[0]!.args[2]).toBe("now add tests");
  expect(r3.usage?.costUsd).toBe(0.0421);
});

test("REAL opencode capture through the runner: the flat stream ends in `done` (summary DONE), per-step usage is summed, the session id is kept, exit 0 — the verdict the live run O2 lacked before the flat-shape fix", async () => {
  const { spawn } = fakeLaneSpawn({ lines: fixture("opencode-live-run") });
  const r = await deadline(runExternalLane(opencodeAdapter, { goal: "create hello.txt" }, opts(), { spawn }), 4_000, "real opencode replay");
  expect(r.status).toBe("done");
  expect(r.summary).toBe("DONE");
  expect(r.usage).toEqual({ input: 27184, output: 121, cacheRead: 27008, cacheWrite: 0, costUsd: 0 }); // mutation target: the usage fold over two step_finish parts
  expect(r.sessionId).toBe("ses_f9befaa3fffeABBp5svat5C9w9");
  expect(r.exitCode).toBe(0);
  expect(r.garbage).toBe(1);
  expect(r.log).toEqual(["[N] he wants a hello.txt. trivial. shipping.", "write D:\\scratch\\lane-live\\.aion\\worktrees\\1bf74c13\\hello.txt (ok)", "usage: 27035 in · 106 out · $0.0000", "DONE", "usage: 149 in · 15 out · $0.0000", "done: DONE"]);
});

/** every test above must leave no live timer: a mutant that forgets clearTimeout shows up as a runner hang, not here */
test("sanity: the fake scripts used above are all settled", async () => {
  const s: FakeScript = { lines: ["END"] };
  const { spawn, procs } = fakeLaneSpawn(s);
  await runExternalLane(echo, { goal: "g" }, opts(), { spawn });
  expect(procs[0]!.alive).toBe(false);
});
