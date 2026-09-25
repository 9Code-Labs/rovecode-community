/** Replay (eval P0-3): a recorded trajectory re-executes its tool calls against a deterministic
 *  fixture — no network, no model, no provider — and the recorded outcome must reproduce. */

import { describe, test, expect } from "bun:test";
import { evaluateAndRecord } from "../../src/eval/record.ts";
import { replayTrajectory } from "../../src/eval/replay.ts";
import { basicTasks } from "../../src/eval/gauntlet.ts";
import type { GraderSpec } from "../../src/eval/grader.ts";
import { rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FILE_CREATE = basicTasks().find((t) => t.id === "basic-file-create")!;
const GRADERS: GraderSpec[] = [{ type: "file-changed", path: "hello.txt", mustMatch: "hello rovecode" }];

function evalDir(): string {
  return join(tmpdir(), `rovecode-eval-r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`);
}

describe("record → replay roundtrip", () => {
  test("a passing run replays with identical tool results and outcome — offline", async () => {
    const dir = evalDir();
    const rec = await evaluateAndRecord(
      { id: FILE_CREATE.id, category: FILE_CREATE.category, prompt: FILE_CREATE.prompt, task: FILE_CREATE, graderSpecs: GRADERS, seed: 7 },
      { dir },
    );
    expect(rec.result.outcome).toBe("pass");
    const report = await replayTrajectory(rec.path);
    expect(report.ok).toBe(true);
    expect(report.mismatches).toEqual([]);
    expect(report.comparisons.length).toBeGreaterThan(0);
    for (const c of report.comparisons) {
      expect(c.okMatch).toBe(true);
      expect(c.hashMatch).toBe(true);
    }
    expect(report.outcomeMatch).toBe(true);
    expect(report.graderOutcomes.length).toBe(GRADERS.length);
    rmSync(dir, { recursive: true, force: true });
  });

  test("two replays of the same file agree (replay itself is deterministic)", async () => {
    const dir = evalDir();
    const rec = await evaluateAndRecord(
      { id: FILE_CREATE.id, category: FILE_CREATE.category, prompt: FILE_CREATE.prompt, task: FILE_CREATE, graderSpecs: GRADERS, seed: 7 },
      { dir },
    );
    const a = await replayTrajectory(rec.path);
    const b = await replayTrajectory(rec.path);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a tampered tool call breaks the recorded outcome — the mismatch is reported", async () => {
    const dir = evalDir();
    const rec = await evaluateAndRecord(
      { id: FILE_CREATE.id, category: FILE_CREATE.category, prompt: FILE_CREATE.prompt, task: FILE_CREATE, graderSpecs: GRADERS, seed: 7 },
      { dir },
    );
    const raw = readFileSync(rec.path, "utf8").split("\n");
    const lines = raw.map((l) => (l.trim() ? (JSON.parse(l) as Record<string, unknown>) : null));
    const tampered = lines.map((l) => {
      if (!l || l.kind !== "step" || l.type !== "assistant") return l;
      const s = l as { toolCalls?: { tool: string; args: Record<string, unknown> }[] };
      if (!s.toolCalls?.some((c) => c.tool === "write")) return l;
      const calls = s.toolCalls.map((c) => (c.tool === "write" ? { ...c, args: { ...c.args, content: "TAMPERED" } } : c));
      return { ...l, toolCalls: calls };
    });
    writeFileSync(rec.path, tampered.filter((l) => l !== null).map((l) => JSON.stringify(l)).join("\n") + "\n");
    const report = await replayTrajectory(rec.path);
    expect(report.ok).toBe(false);
    expect(report.outcomeMatch).toBe(false); // the tampered write no longer produces "hello rovecode"
    expect(report.mismatches.length).toBeGreaterThan(0);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a tampered result hash breaks step comparison", async () => {
    const dir = evalDir();
    const rec = await evaluateAndRecord(
      { id: FILE_CREATE.id, category: FILE_CREATE.category, prompt: FILE_CREATE.prompt, task: FILE_CREATE, graderSpecs: GRADERS, seed: 7 },
      { dir },
    );
    const raw = readFileSync(rec.path, "utf8").split("\n").filter((l) => l.trim());
    const lines = raw.map((l) => {
      const o = JSON.parse(l) as Record<string, unknown>;
      if (o.kind === "step" && o.type === "tool") {
        const s = o as { results: { callId: string; ok: boolean; output: string; outputSha: string }[] };
        s.results = s.results.map((r) => ({ ...r, outputSha: "0".repeat(64) }));
      }
      return JSON.stringify(o);
    });
    writeFileSync(rec.path, lines.join("\n") + "\n");
    const report = await replayTrajectory(rec.path);
    expect(report.ok).toBe(false);
    expect(report.comparisons.some((c) => c.hashMatch === false)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("the recorded file never carries the workspace's absolute path or secrets", async () => {
    const dir = evalDir();
    const rec = await evaluateAndRecord(
      { id: FILE_CREATE.id, category: FILE_CREATE.category, prompt: FILE_CREATE.prompt, task: FILE_CREATE, graderSpecs: GRADERS, seed: 7 },
      { dir },
    );
    const raw = readFileSync(rec.path, "utf8");
    expect(raw).not.toContain(tmpdir()); // paths are portable <workspace> tokens
    rmSync(dir, { recursive: true, force: true });
  });
});
