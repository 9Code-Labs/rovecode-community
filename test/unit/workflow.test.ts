/** Workflow engine (F3): the DAG scheduler over an injected executor — no provider, no fs
 *  outside a tmpdir checkpoint. Bars: linear chains run in order; independent steps fan out
 *  (maxConcurrency respected); a failed step skips its dependents and fails the run; retry
 *  re-attempts before failing; gates approve/reject; resume skips checkpointed steps; cycles
 *  and unknown deps are definition-time errors; the budget stops scheduling. */

import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineWorkflow, runWorkflow, resumeWorkflow, readCheckpoint, type WorkflowExecutor, type WorkflowEvent } from "../../src/workflow/engine.ts";

const scratch: string[] = [];
afterAll(() => { for (const d of scratch) rmSync(d, { recursive: true, force: true }); });
const fresh = (): string => { const d = mkdtempSync(join(tmpdir(), "rovecode-wf-")); scratch.push(d); return d; };

function fakeExec(opts: { fail?: Record<string, number>; gate?: boolean; log?: string[] } = {}): WorkflowExecutor {
  const attempts = new Map<string, number>();
  return {
    async runAgent(step) {
      opts.log?.push(step.name);
      const n = (attempts.get(step.name) ?? 0) + 1;
      attempts.set(step.name, n);
      const failTimes = opts.fail?.[step.name] ?? 0;
      const ok = n > failTimes;
      return { ok, summary: ok ? `${step.name} done` : `${step.name} boom`, usage: { input: 10, output: 5 } };
    },
    async askGate() { return opts.gate !== false; },
  };
}

describe("workflow engine", () => {
  test("linear chain runs in dependency order", async () => {
    const log: string[] = [];
    const spec = defineWorkflow({
      name: "lin",
      steps: {
        a: { kind: "agent", goal: "g" },
        b: { kind: "agent", goal: "g", after: ["a"] },
        c: { kind: "agent", goal: "g", after: ["b"] },
      },
    });
    const r = await runWorkflow(spec, fakeExec({ log }), { dir: fresh() });
    expect(r.status).toBe("done");
    expect(log).toEqual(["a", "b", "c"]);
  });

  test("independent steps run, dependents of a failure are skipped", async () => {
    const log: string[] = [];
    const spec = defineWorkflow({
      name: "dag",
      steps: {
        a: { kind: "agent", goal: "g" },
        b: { kind: "agent", goal: "g" },
        c: { kind: "agent", goal: "g", after: ["a"] },
      },
    });
    const r = await runWorkflow(spec, fakeExec({ log, fail: { a: 99 } }), { dir: fresh() });
    expect(r.status).toBe("failed");
    expect(r.steps.a?.status).toBe("failed");
    expect(r.steps.b?.status).toBe("done");
    expect(r.steps.c?.status).toBe("skipped");
    expect(log).not.toContain("c");
  });

  test("retry: a step failing once succeeds on attempt 2 when maxAttempts=2", async () => {
    const spec = defineWorkflow({ name: "retry", steps: { a: { kind: "agent", goal: "g" } }, retry: { maxAttempts: 2 } });
    const events: WorkflowEvent[] = [];
    const r = await runWorkflow(spec, fakeExec({ fail: { a: 1 } }), { dir: fresh(), emit: (e) => events.push(e) });
    expect(r.status).toBe("done");
    expect(r.steps.a?.attempts).toBe(2);
    expect(events.filter((e) => e.type === "step_started")).toHaveLength(2);
  });

  test("gate: approval completes, rejection fails the run", async () => {
    const spec = defineWorkflow({
      name: "gated",
      steps: {
        work: { kind: "agent", goal: "g" },
        ok: { kind: "gate", prompt: "proceed?", after: ["work"] },
      },
    });
    const yes = await runWorkflow(spec, fakeExec({ gate: true }), { dir: fresh() });
    expect(yes.status).toBe("done");
    const no = await runWorkflow(spec, fakeExec({ gate: false }), { dir: fresh() });
    expect(no.status).toBe("failed");
    expect(no.steps.ok?.error).toBe("gate rejected");
  });

  test("resume skips checkpointed steps", async () => {
    const dir = fresh();
    const spec = defineWorkflow({
      name: "resumable",
      steps: {
        a: { kind: "agent", goal: "g" },
        b: { kind: "agent", goal: "g", after: ["a"] },
      },
    });
    const first = await runWorkflow(spec, fakeExec({ fail: { b: 99 } }), { dir });
    expect(first.status).toBe("failed");
    expect(readCheckpoint(join(dir, `${first.runId}.jsonl`)).has("a")).toBe(true);
    const log: string[] = [];
    const second = await resumeWorkflow(first.runId, spec, fakeExec({ log }), { dir });
    expect(second.status).toBe("done");
    expect(log).toEqual(["b"]); // a was checkpointed, never re-ran
  });

  test("budget stops scheduling new steps", async () => {
    const spec = defineWorkflow({
      name: "spend",
      steps: {
        a: { kind: "agent", goal: "g" },
        b: { kind: "agent", goal: "g", after: ["a"] },
        c: { kind: "agent", goal: "g", after: ["b"] },
      },
      budget: { maxTokens: 15 }, // one step spends 15
    });
    const log: string[] = [];
    const r = await runWorkflow(spec, fakeExec({ log }), { dir: fresh() });
    expect(r.status).toBe("budget");
    expect(log.length).toBeLessThan(3);
  });

  test("definition-time errors: cycles, unknown deps, empty steps", () => {
    expect(() => defineWorkflow({ name: "x", steps: {} })).toThrow();
    expect(() => defineWorkflow({ name: "x", steps: { a: { kind: "agent", goal: "g", after: ["ghost"] } } })).toThrow(/unknown dependency/);
    expect(() => defineWorkflow({ name: "x", steps: { a: { kind: "agent", goal: "g", after: ["b"] }, b: { kind: "agent", goal: "g", after: ["a"] } } })).toThrow(/cycle/);
    expect(() => defineWorkflow({ name: "x", steps: { a: { kind: "agent", goal: " " } } })).toThrow(/goal/);
  });

  test("concurrency bound is respected", async () => {
    let live = 0, peak = 0;
    const exec: WorkflowExecutor = {
      async runAgent(step) {
        live++; peak = Math.max(peak, live);
        await new Promise((r) => setTimeout(r, 20));
        live--;
        return { ok: true, summary: step.name };
      },
      async askGate() { return true; },
    };
    const spec = defineWorkflow({
      name: "wide",
      steps: Object.fromEntries(["a", "b", "c", "d", "e"].map((n) => [n, { kind: "agent" as const, goal: "g" }])),
    });
    const r = await runWorkflow(spec, exec, { dir: fresh(), maxConcurrency: 2 });
    expect(r.status).toBe("done");
    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBe(2); // the bound is used, not just respected
  });
});
