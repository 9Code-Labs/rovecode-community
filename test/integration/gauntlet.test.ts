/** Gauntlet + CLI eval-surface tests: preflight, the per-run scratch root, the leak assertion, runner
 *  cutover, and the wave dispatch.
 *
 *  The leak assertion is scoped to ONE run's root (gauntlet-support.ts) rather than scanning the OS temp
 *  dir for `rovecode-g*`, so these tests simulate a leak INSIDE the root the run made — which is also the
 *  only place a leak can now be detected. The old shape counted shared ground: two runs on one machine
 *  saw, and could delete, each other's workspaces. */

import { describe, test, expect } from "bun:test";
import { runGauntlet, providerPreflight, basicTasks, type GauntletTask, type GauntletTranscript } from "../../src/eval/gauntlet.ts";
import { GAUNTLET_ROOT_PREFIX } from "../../src/eval/gauntlet-support.ts";
import { runTask } from "../../src/eval/gauntlet-runner.ts";
import { mockStream, textTurn } from "../../src/providers/stream.ts";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function okRunner(_task: GauntletTask, _workspace: string): Promise<GauntletTranscript> {
  return Promise.resolve({ toolCalls: [], events: [], finalText: "ok", recovered: false });
}

/** every gauntlet ROOT currently under the OS temp dir — what must not grow across a run */
function gauntletRoots(): string[] {
  return readdirSync(tmpdir()).filter((n) => n.startsWith(GAUNTLET_ROOT_PREFIX)).map((n) => join(tmpdir(), n));
}

describe("providerPreflight (verify-before-spend)", () => {
  test("healthy stream passes", async () => {
    await providerPreflight(mockStream({ turns: [textTurn("hi")] }), { provider: "mock", model: "default" });
  });

  test("erroring stream fails with the provider's message", async () => {
    const bad = async function* () {
      yield { type: "turn" as const, turn: { parts: [], stopReason: "error" as const, usage: { input: 0, output: 0 }, error: "HTTP 401" } };
    };
    expect(providerPreflight(bad, { provider: "x", model: "y" })).rejects.toThrow("HTTP 401");
  });

  test("silent stream (no turn event) fails", async () => {
    const silent = async function* () {};
    expect(providerPreflight(silent, { provider: "x", model: "y" })).rejects.toThrow("no turn");
  });
});

describe("runGauntlet phase-boundary cleanup", () => {
  test("runner leaking a session dir INSIDE the run's root fails the task; a stray dir in the OS temp dir does not", async () => {
    // a stray from someone else's run: under the old whole-tmpdir scan this alone failed the task
    const stray = mkdtempSync(join(tmpdir(), "rovecode-cli-g-"));
    const task: GauntletTask = {
      id: "leak-probe", category: "basic", prompt: "x",
      verify: () => true,
    };
    const results = await runGauntlet({
      tasks: [task],
      runner: async (_t, _ws, _signal, root) => {
        mkdtempSync(join(root!, "rovecode-cli-g-leak-")); // session dir the runner forgot to rmSync
        return { toolCalls: [], events: [], finalText: "ok", recovered: false };
      },
    });
    expect(results[0]!.pass).toBe(false);
    expect(results[0]!.detail).toContain("workspace leak");
    expect(existsSync(stray)).toBe(true); // MUTATION TARGET: scan tmpdir() again → a concurrent run's dir is swept
    rmSync(stray, { recursive: true, force: true });
  });

  test("the run's root is removed when it ends, and the runner is handed that root", async () => {
    const before = new Set(gauntletRoots());
    let seenRoot = "";
    const task: GauntletTask = { id: "root-probe", category: "basic", prompt: "x", verify: () => true };
    const results = await runGauntlet({
      tasks: [task],
      runner: async (_t, workspace, _signal, root) => {
        seenRoot = root ?? "";
        expect(workspace.startsWith(seenRoot)).toBe(true); // every workspace lives under the root
        return { toolCalls: [], events: [], finalText: "ok", recovered: false };
      },
    });
    expect(results[0]!.pass).toBe(true);
    expect(seenRoot).toContain(GAUNTLET_ROOT_PREFIX);
    expect(existsSync(seenRoot)).toBe(false); // swept, workspaces and all
    expect(gauntletRoots().filter((d) => !before.has(d))).toEqual([]);
  });

  test("a setup that returns a workspace OUTSIDE the root is a task bug, named with its id", async () => {
    const outside = mkdtempSync(join(tmpdir(), "rovecode-g-outside-"));
    const task: GauntletTask = { id: "escapee", category: "basic", prompt: "x", setup: () => outside, verify: () => true };
    expect(runGauntlet({ tasks: [task], runner: okRunner })).rejects.toThrow(/gauntlet task escapee: setup returned a workspace outside the run root/);
    rmSync(outside, { recursive: true, force: true });
  });

  test("a task carrying `run` drives itself and the scripted runner is never called", async () => {
    let runnerCalls = 0;
    let ranWith = { workspace: "", root: "" };
    const task: GauntletTask = {
      id: "wave-probe", category: "adversarial", prompt: "x",
      run: async (_t, workspace, root) => {
        ranWith = { workspace, root };
        return { toolCalls: [], events: [{ type: "run_end" }], finalText: "SELF-DRIVEN", recovered: true };
      },
      verify: (_w, t) => t.finalText === "SELF-DRIVEN",
    };
    const results = await runGauntlet({ tasks: [task], runner: async () => { runnerCalls++; return okRunner(task, ""); } });
    expect(results[0]!.pass).toBe(true);
    expect(runnerCalls).toBe(0); // MUTATION TARGET: ignore task.run → the scripted runner answers and verify fails
    expect(ranWith.workspace.startsWith(ranWith.root)).toBe(true);
  });

  test("clean runner passes and no gauntlet root outlives the run", async () => {
    const before = new Set(gauntletRoots());
    const results = await runGauntlet({ tasks: basicTasks(), runner: okRunner });
    // okRunner satisfies only basic-question's verify; the file tasks legitimately fail verify —
    // what must hold: zero leak failures and no temp growth.
    for (const r of results) expect(r.detail ?? "").not.toContain("workspace leak");
    const after = gauntletRoots();
    for (const d of after) expect(before.has(d)).toBe(true);
  });

  test("real transcript runner (runTask) leaves no session dirs", async () => {
    const before = new Set(gauntletRoots());
    const results = await runGauntlet({ tasks: basicTasks(), runner: (task, workspace) => runTask(task, workspace) });
    expect(results.filter((r) => r.pass).length).toBeGreaterThan(0);
    for (const r of results) expect(r.detail ?? "").not.toContain("workspace leak");
    const after = gauntletRoots();
    for (const d of after) expect(before.has(d)).toBe(true);
  });
});
