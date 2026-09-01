/** Gauntlet + CLI eval-surface tests: preflight, leak assertion, runner cutover. */

import { describe, test, expect } from "bun:test";
import { runGauntlet, providerPreflight, basicTasks, type GauntletTask, type GauntletTranscript } from "../../src/eval/gauntlet.ts";
import { runTask } from "../../src/eval/gauntlet-runner.ts";
import { mockStream, textTurn } from "../../src/providers/stream.ts";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function okRunner(_task: GauntletTask, _workspace: string): Promise<GauntletTranscript> {
  return Promise.resolve({ toolCalls: [], events: [], finalText: "ok", recovered: false });
}

function aionTempDirs(): string[] {
  return readdirSync(tmpdir()).filter((n) => n.startsWith("aion-g") || n.startsWith("aion-cli-g")).map((n) => join(tmpdir(), n));
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
  test("runner leaking a session dir fails the task", async () => {
    const leakedDir = mkdtempSync(join(tmpdir(), "aion-cli-g-")); // simulate a runner that forgets rmSync
    const task: GauntletTask = {
      id: "leak-probe", category: "basic", prompt: "x",
      verify: () => true,
    };
    const results = await runGauntlet({
      tasks: [task],
      runner: async () => {
        mkdtempSync(join(tmpdir(), "aion-cli-g-leak-")); // session dir the runner forgot to rmSync
        return { toolCalls: [], events: [], finalText: "ok", recovered: false };
      },
    });
    expect(results[0]!.pass).toBe(false);
    expect(results[0]!.detail).toContain("workspace leak");
    rmSync(leakedDir, { recursive: true, force: true }); // pre-baseline strays are the caller's, not the gauntlet's
  });

  test("clean runner passes and no aion-g-* dirs outlive the run", async () => {
    const before = new Set(aionTempDirs());
    const results = await runGauntlet({ tasks: basicTasks(), runner: okRunner });
    // okRunner satisfies only basic-question's verify; the file tasks legitimately fail verify —
    // what must hold: zero leak failures and no temp growth.
    for (const r of results) expect(r.detail ?? "").not.toContain("workspace leak");
    const after = aionTempDirs();
    for (const d of after) expect(before.has(d)).toBe(true);
  });

  test("real transcript runner (runTask) leaves no session dirs", async () => {
    const before = new Set(aionTempDirs());
    const results = await runGauntlet({ tasks: basicTasks(), runner: runTask });
    expect(results.filter((r) => r.pass).length).toBeGreaterThan(0);
    for (const r of results) expect(r.detail ?? "").not.toContain("workspace leak");
    const after = aionTempDirs();
    for (const d of after) expect(before.has(d)).toBe(true);
  });
});
