/**
 * Offline eval gate (eval P0-6): the fast, deterministic quality gate for CI.
 * NO network, NO provider keys — everything runs against the scripted gauntlet
 * stream and real tools on temp fixtures.
 *
 * What it exercises (fails fast, non-zero exit on any failure):
 *   1. evaluate-and-record  — three gauntlet tasks through the real loop, recorded
 *      into versioned trajectory JSONL with redacted evidence, graded by
 *      patch/test-based graders (file-changed baselines, not string-contains).
 *   2. replay               — each recorded trajectory re-executed offline; recorded
 *      outcome must reproduce (tool-call ok flags + output hashes + grader verdict).
 *   3. stuck detector       — the five OpenHands patterns detected at threshold,
 *      false-positive protections included.
 *   4. redaction            — every credential shape wiped before persistence.
 *
 * Usage: bun scripts/eval-offline.ts [--out <dir>]   (default .eval-results/)
 * Budget: designed < 30 s; the CI job caps it at 10 min.
 */

import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { evaluateAndRecord } from "../src/eval/record.ts";
import { replayTrajectory } from "../src/eval/replay.ts";
import { basicTasks, codingTasks } from "../src/eval/gauntlet.ts";
import { detectStuck, STUCK_THRESHOLDS, type StuckStep } from "../src/core/stuck-detector.ts";
import { redactSecrets } from "../src/eval/redact.ts";
import type { GraderSpec } from "../src/eval/grader.ts";

interface Check { name: string; pass: boolean; detail: string }

const failures: Check[] = [];
function check(name: string, pass: boolean, detail = ""): void {
  (pass ? [] : failures).push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${pass ? "" : ` — ${detail}`}`);
}

async function main(): Promise<void> {
  const t0 = Date.now();
  const outDir = process.argv.includes("--out")
    ? join(process.cwd(), process.argv[process.argv.indexOf("--out") + 1] ?? ".eval-results")
    : join(process.cwd(), ".eval-results");
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  // ---------- 1. evaluate + record ----------
  const fileCreate = basicTasks().find((t) => t.id === "basic-file-create")!;
  const bugfix = codingTasks().find((t) => t.id === "coding-bugfix")!;
  const toolUsage = basicTasks().find((t) => t.id === "basic-tool-usage")!;

  const specs: { id: string; task: typeof fileCreate; graders: GraderSpec[] }[] = [
    {
      id: fileCreate.id,
      task: fileCreate,
      graders: [{ type: "file-changed", path: "hello.txt", mustMatch: "hello rovecode" }],
    },
    {
      id: bugfix.id,
      task: bugfix,
      graders: [{ type: "file-changed", path: "bug.py", mustMatch: "a \\+ b", mustNotMatch: "a - b" }],
    },
    {
      id: toolUsage.id,
      task: toolUsage,
      graders: [
        { type: "file-matches", path: "note.txt", pattern: "6767" }, // fixture untouched: baseline content
        { type: "final-text", pattern: "6767", flags: "i" }, // advisory corroboration only
      ],
    },
  ];

  const recorded: { id: string; path: string; outcome: string; ms: number }[] = [];
  for (const spec of specs) {
    const r = await evaluateAndRecord(
      { id: spec.id, category: spec.task.category, prompt: spec.task.prompt, task: spec.task, graderSpecs: spec.graders, seed: 1337 },
      { dir: outDir },
    );
    check(`eval:${spec.id} graded pass`, r.result.outcome === "pass", `outcome=${r.result.outcome} failure=${JSON.stringify(r.result.failure ?? null)}`);
    check(`eval:${spec.id} has behavioral grader`, r.graderOutcomes.some((o) => !o.advisory), "advisory-only grading is not allowed");
    recorded.push({ id: spec.id, path: r.path, outcome: r.result.outcome, ms: r.result.durationMs });
  }

  // ---------- 2. replay ----------
  for (const r of recorded) {
    const report = await replayTrajectory(r.path);
    check(
      `replay:${r.id} reproduces`,
      report.ok,
      report.mismatches.slice(0, 3).join("; ") || "mismatches",
    );
  }

  // ---------- 3. stuck detector: five patterns + protections ----------
  const pair = (tool: string, a: string, o: string, ok = true): StuckStep[] => [
    { kind: "action", tool, signature: a }, { kind: "observation", tool, signature: o, ok },
  ];
  const flat = (...lists: StuckStep[][]): StuckStep[] => lists.flat();

  const rep = (pattern: string, steps: StuckStep[]): boolean => detectStuck(steps).some((e) => e.pattern === pattern);

  check("stuck:action-observation fires at 4", rep("repeated-action-observation", flat(...Array.from({ length: STUCK_THRESHOLDS.actionObservation }, () => pair("read", "a", "o")))));
  check("stuck:action-error fires at 3", rep("repeated-action-error", flat(...Array.from({ length: STUCK_THRESHOLDS.actionError }, () => pair("bash", "a", "o", false)))));
  check("stuck:monologue fires at 3", rep("monologue", [{ kind: "assistant", textLength: 100 }, { kind: "assistant", textLength: 100 }, { kind: "assistant", textLength: 100 }]));
  check("stuck:ping-pong fires at 6", rep("ping-pong", flat(pair("read", "A", "oA"), pair("edit", "B", "oB"), pair("read", "A", "oA"), pair("edit", "B", "oB"), pair("read", "A", "oA"), pair("edit", "B", "oB"))));
  check("stuck:context-thrash fires at 2", rep("context-window-thrash", [
    { kind: "observation", tool: "read", signature: "e1", ok: false, isContextWindowError: true },
    { kind: "observation", tool: "read", signature: "e2", ok: false, isContextWindowError: true },
  ]));
  check("stuck:clean run is silent", detectStuck(flat(...Array.from({ length: 8 }, (_, i) => pair("read", `a${i}`, `o${i}`)))).length === 0, "false positive on a progressing run");
  check("stuck:poller exemption", !rep("repeated-action-observation", flat(...Array.from({ length: 6 }, () => pair("process", "a", "o")))));
  check("stuck:changed observation resets", !rep("repeated-action-observation", [
    ...pair("read", "a", "o1"), ...pair("read", "a", "o1"), ...pair("read", "a", "o1"),
    ...pair("read", "a", "o2"),
    ...pair("read", "a", "o1"), ...pair("read", "a", "o1"), ...pair("read", "a", "o1"),
  ]));

  // ---------- 4. redaction ----------
  const dirty = 'run with Bearer abc123def456 and key sk-ant-api03-AbCdEf0123456789GhIjKlMnOpQrStU';
  const clean = redactSecrets(dirty);
  check("redact:bearer gone", !clean.includes("abc123def456"), clean);
  check("redact:anthropic key gone", !clean.includes("sk-ant-api03"), clean);

  // ---------- summary ----------
  const ms = Date.now() - t0;
  console.log(`\nOffline eval: ${failures.length} failure(s) in ${ms}ms — artifacts: ${outDir}`);
  if (failures.length > 0) process.exit(1);
}

void main();
