/** Background shell jobs and the two new `bash` flags (port #55).
 *
 *  Every case here drives the REAL executor seam with an injected SpawnRunner, so the observer taps in
 *  bunRunner's collect() are the ones under test rather than a stand-in: a job's output only exists
 *  because the runner streamed it, and that is exactly the part a mock would have hidden. */

import { test, expect, afterEach } from "bun:test";
import { configureExecutor, resetExecutor, type RawResult, type SpawnRunner } from "../../src/core/executor.ts";
import { BashJobManager, installJobManager, jobManager, MAX_JOBS, RING_CHARS, MAX_READ } from "../../src/tools/bash-jobs.ts";
import { bashListTool, bashOutputTool, bashKillTool } from "../../src/tools/bash-bg.ts";
import { bashTool, MAX_TIMEOUT_MS } from "../../src/coding/bash.ts";
import { SteeringQueue } from "../../src/core/loop.ts";
import type { ToolContext } from "../../src/core/types.ts";

afterEach(() => { installJobManager(null); resetExecutor(); });

const enc = new TextEncoder();

/** A runner the test drives: it emits the given chunks through the observer, then settles. `hold`
 *  keeps it running until the returned resolve is called, which is how a "still running" job exists. */
function scriptedRunner(script: { chunks?: string[]; code?: number; hold?: boolean }): { runner: SpawnRunner; release: () => void; aborted: () => boolean } {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  let sawAbort = false;
  const runner: SpawnRunner = async (_argv, opts) => {
    opts.observe?.onSpawn?.(4242);
    // The observer is a TAP, not a diversion: bunRunner collects the same bytes AND returns them, so
    // a fake that only taps would let a foreground path pass a test the real runner would fail.
    let printed = "";
    for (const c of script.chunks ?? []) { printed += c; opts.observe?.onChunk?.("stdout", enc.encode(c)); }
    if (script.hold === true) {
      opts.signal?.addEventListener("abort", () => { sawAbort = true; release(); }, { once: true });
      await gate;
    }
    const r: RawResult = { code: sawAbort ? 143 : (script.code ?? 0), stdout: printed, stderr: "" };
    return r;
  };
  return { runner, release, aborted: () => sawAbort };
}

const ctx = (cwd = "C:/proj"): ToolContext => ({ cwd, signal: new AbortController().signal } as unknown as ToolContext);

async function withRunner(script: Parameters<typeof scriptedRunner>[0], fn: (h: ReturnType<typeof scriptedRunner>) => Promise<void>): Promise<void> {
  const h = scriptedRunner(script);
  await configureExecutor("direct", { runner: h.runner });
  try { await fn(h); } finally { h.release(); }
}

test("#55 a job's output is readable WHILE it runs, and each read returns only what is new", async () => {
  await withRunner({ chunks: ["first\n", "second\n"], hold: true }, async (h) => {
    const m = new BashJobManager();
    const started = m.start("tail -f log", "C:/proj");
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await Promise.resolve(); // let the runner's synchronous chunks land
    const r1 = m.read(started.info.id);
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    expect(r1.text).toBe("first\nsecond\n");
    expect(r1.info.status).toBe("running");     // readable before it finished — the whole point
    expect(r1.info.pid).toBe(4242);             // the pid came through onSpawn
    // A SECOND read must not re-send what was already read: a tool that re-sends its whole buffer
    // turns a long build into a context leak, and the model cannot tell a repeat from progress.
    const r2 = m.read(started.info.id);
    expect(r2.ok && r2.text).toBe("");
    h.release();
    await m.drain();
    expect(m.status(started.info.id)?.status).toBe("exited");
  });
});

test("#55 a finished job posts ONE note into the steering queue the loop already drains, and never interrupts a turn", async () => {
  await withRunner({ chunks: ["done\n"], code: 0 }, async () => {
    const steering = new SteeringQueue();
    const m = new BashJobManager({ notify: steering });
    const started = m.start("bun test", "C:/proj");
    expect(started.ok).toBe(true);
    await m.drain();
    const notes = steering.drainAll();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("finished (exit=0)");
    expect(notes[0]).toContain("bash_output b1");   // it says how to read the output, not just that it ended
    expect(steering.drainAll()).toHaveLength(0);       // exactly once
  });
});

test("#55 the pool is bounded and a full pool is DATA, not a throw", async () => {
  await withRunner({ hold: true }, async () => {
    const m = new BashJobManager();
    for (let i = 0; i < MAX_JOBS; i++) expect(m.start(`sleep ${i}`, "C:/proj").ok).toBe(true);
    const over = m.start("one too many", "C:/proj");
    expect(over.ok).toBe(false);
    if (over.ok) return;
    expect(over.reason).toContain(`${MAX_JOBS} background jobs already running`);
    expect(over.reason).toContain("bash_kill");   // the refusal names the way out
    // killing one frees exactly one slot
    m.kill("b1");
    expect(m.start("now there is room", "C:/proj").ok).toBe(true);
  });
});

test("#55 kill aborts the run's own signal (the executor's tree-kill path), and the output stays readable", async () => {
  await withRunner({ chunks: ["partial\n"], hold: true }, async (h) => {
    const m = new BashJobManager();
    const s = m.start("npm run dev", "C:/proj");
    if (!s.ok) throw new Error("start refused");
    await Promise.resolve();
    const killed = m.kill(s.info.id);
    expect(killed.ok).toBe(true);
    expect(killed.info?.status).toBe("killed");
    await m.drain();
    expect(h.aborted()).toBe(true);               // the signal reached the runner: the TREE dies, not just us
    const after = m.read(s.info.id);
    expect(after.ok && after.text).toBe("partial\n");  // what it printed before the kill is not lost
    expect(m.status(s.info.id)?.status).toBe("killed"); // and a kill is not reported as a command failure
    expect(m.status(s.info.id)?.exitCode).toBeUndefined();
    // killing it again is not an error
    expect(m.kill(s.info.id).ok).toBe(true);
  });
});

test("#55 the ring is bounded and a read SAYS how much it lost, rather than handing over a silent gap", async () => {
  const big = "x".repeat(RING_CHARS + 5_000);
  await withRunner({ chunks: [big] }, async () => {
    const m = new BashJobManager();
    const s = m.start("yes", "C:/proj");
    if (!s.ok) throw new Error("start refused");
    await m.drain();
    const r = m.read(s.info.id);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.info.dropped).toBe(5_000);
    expect(r.lost).toBe(5_000);
    expect(r.text.length).toBe(MAX_READ);
    expect(r.more).toBe(true);                    // and it says there is more rather than truncating quietly
  });
});

test("#55 a finished job whose output nobody read is NEVER reaped — that output is the only record it ran", async () => {
  await withRunner({ chunks: ["hi\n"] }, async () => {
    const m = new BashJobManager();
    for (let i = 0; i < 12; i++) { const s = m.start(`echo ${i}`, "C:/proj"); expect(s.ok).toBe(true); await m.drain(); }
    // twelve finished jobs, none of them read: all twelve are still listed
    expect(m.list()).toHaveLength(12);
    expect(m.list().every((j) => !j.drained)).toBe(true);
    for (const j of m.list()) m.read(j.id);       // now they have all been seen
    expect(m.list().length).toBeLessThan(12);     // and only the newest few are kept
  });
});

// ---------- the tools ----------

test("#55 bash_list / bash_output / bash_kill refuse an unknown id with a reason, and say so without a manager", async () => {
  installJobManager(null);
  expect((await bashListTool.execute({}, ctx())).ok).toBe(false);
  expect((await bashOutputTool.execute({ id: "b1" }, ctx())).output).toContain("not available on this surface");

  await withRunner({ chunks: ["x"] }, async () => {
    const m = new BashJobManager();
    installJobManager(m);
    expect((await bashListTool.execute({}, ctx())).output).toBe("no background jobs in this session");
    const bad = await bashOutputTool.execute({ id: "nope" }, ctx());
    expect(bad.ok).toBe(false);
    expect(bad.output).toContain('no background job "nope"');
    expect((await bashOutputTool.execute({ id: "" }, ctx())).output).toContain("needs an id");
    expect((await bashKillTool.execute({ id: "nope" }, ctx())).ok).toBe(false);
    expect(jobManager()).toBe(m);
  });
});

test("#55 `bash run_in_background` returns an id at once, and tells the model NOT to poll", async () => {
  await withRunner({ chunks: ["building\n"], hold: true }, async () => {
    installJobManager(new BashJobManager());
    const out = await bashTool.execute({ command: "bun run build", run_in_background: true }, ctx());
    expect(out.ok).toBe(true);
    expect(out.output).toContain("started background job b1");
    expect(out.output).toContain("do NOT poll");
    const listed = await bashListTool.execute({}, ctx());
    expect(listed.output).toContain("b1 running");
    expect(listed.output).toContain("bun run build");
  });
});

test("#55 with no manager, run_in_background is REFUSED rather than silently run in the foreground", async () => {
  await withRunner({ chunks: ["ran\n"] }, async () => {
    installJobManager(null);
    const out = await bashTool.execute({ command: "echo hi", run_in_background: true }, ctx());
    // The caller asked not to be blocked. Quietly blocking it is the wrong answer to a request we
    // cannot honour — and it would block a surface that has no way to read the result either.
    expect(out.ok).toBe(false);
    expect(out.output).toContain("not available on this surface");
    expect(out.output).toContain("drop run_in_background");
  });
});

test("#55 the safety blocklist is checked BEFORE the background flag — asking for it in the background does not get it past the guard", async () => {
  await withRunner({ chunks: [""] }, async () => {
    installJobManager(new BashJobManager());
    const out = await bashTool.execute({ command: "rm -rf /", run_in_background: true }, ctx());
    expect(out.ok).toBe(false);
    expect(out.output).toContain("safety blocklist");
    expect(jobManager()?.list()).toHaveLength(0);   // nothing was started
  });
});

test("#55 timeout_ms is validated as DATA: junk, zero, negative and over-cap are refusals that name the fix", async () => {
  await withRunner({ chunks: ["ok\n"] }, async () => {
    for (const bad of [0, -1, "soon", Number.NaN]) {
      const out = await bashTool.execute({ command: "echo hi", timeout_ms: bad }, ctx());
      expect(out.ok).toBe(false);
      expect(out.output).toContain("timeout_ms must be a positive number");
    }
    const over = await bashTool.execute({ command: "echo hi", timeout_ms: MAX_TIMEOUT_MS + 1 }, ctx());
    expect(over.ok).toBe(false);
    expect(over.output).toContain("run_in_background");   // the refusal points at the tool that CAN do it
  });
});

test("#55 a timed-out command keeps its partial output, is not retried, and its tree is killed", async () => {
  await withRunner({ chunks: ["step 1 of 9\n"], hold: true }, async (h) => {
    let starts = 0;
    const counting: SpawnRunner = async (argv, opts) => { starts++; return h.runner(argv, opts); };
    await configureExecutor("direct", { runner: counting });
    const out = await bashTool.execute({ command: "bun run build", timeout_ms: 25 }, ctx());
    expect(out.ok).toBe(false);
    expect(out.output).toContain("timed out after 25ms");
    expect(out.output).toContain("step 1 of 9");   // the partial output is the point: it says WHY it was slow
    expect(h.aborted()).toBe(true);                // the deadline went through the executor's kill path
    expect(starts).toBe(1);                        // a command that needed more time needs more time, not twice
  });
});
