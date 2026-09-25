/**
 * Trajectory replay (eval P0-3): verify a recorded run WITHOUT a network or a model.
 *
 * The recorded trajectory carries a fixture snapshot (the pre-run workspace) and every
 * tool call the model made. Replay rebuilds the workspace from the snapshot, re-executes
 * the recorded calls through the REAL tool registry with the recorded permission rules,
 * and compares, per call, the ok flag and the sha256 of the path-normalized RAW output
 * against the recorded hashes. Then it re-runs the recorded grader specs and compares the
 * composite verdict with the recorded outcome. Anything that drifted — a tampered call,
 * a changed tool implementation, a nondeterministic command — is reported per step.
 *
 * Determinism guarantees this leans on: fixtures are files-on-disk, "<workspace>" tokens
 * make recorded paths machine-independent (portablize/deportablize), and grader specs
 * are workspace-relative. A tool whose output genuinely varies between machines (clocks,
 * line endings in shell output) will honestly fail replay — that is the point.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTrajectory, materializeFixture, portablize, sha256Text, deportablize } from "./trajectory.ts";
import { runGraders, gradersPassed, GraderConfigError, type GraderOutcome, type GraderSpec } from "./grader.ts";
import { ToolRegistry } from "../core/tools.ts";
import type { PermissionRule, RunEvent, ToolCallPart } from "../core/types.ts";
import { readTool, editTool, writeTool, bashTool } from "../coding/hashline.ts";
import { globTool, grepTool, lsTool } from "../coding/files.ts";

export const REPLAY_ALLOW_ALL: PermissionRule[] = [{ action: "*", resource: "*", effect: "allow" }];

export interface StepComparison {
  callId: string;
  tool: string;
  okMatch: boolean | null;       // null = no recorded result to compare against
  hashMatch: boolean | null;     // null = recorded result had no hash
  detail?: string;
}

export interface ReplayReport {
  ok: boolean;
  runId: string;
  task: { id: string; category: string };
  comparisons: StepComparison[];
  graderOutcomes: GraderOutcome[];
  /** replay's grader verdict vs the recorded outcome (null = nothing to compare) */
  outcomeMatch: boolean | null;
  mismatches: string[];
}

export interface ReplayOptions {
  /** extra/override tools — defaults to the standard coding set */
  registerTools?: (registry: ToolRegistry) => void;
  /** keep the rebuilt workspace dir for debugging (default: removed) */
  keepWorkspace?: boolean;
}

export async function replayTrajectory(path: string, opts?: ReplayOptions): Promise<ReplayReport> {
  const t = readTrajectory(path);
  const ws = mkdtempSync(join(tmpdir(), "rovecode-replay-"));
  try {
    materializeFixture(t.header.fixture, ws);

    const registry = new ToolRegistry();
    registry.register(readTool, editTool, writeTool, bashTool, globTool, grepTool, lsTool);
    opts?.registerTools?.(registry);

    const rules = t.header.permissionRules ?? REPLAY_ALLOW_ALL;
    const recordedResults = new Map<string, { ok: boolean; outputSha?: string; output?: string }>();
    for (const step of t.steps) {
      for (const r of step.results ?? []) recordedResults.set(r.callId, { ok: r.ok, outputSha: r.outputSha, output: r.output });
    }

    const comparisons: StepComparison[] = [];
    const mismatches: string[] = [];
    const emit = (_ev: RunEvent): void => { /* replay is not recorded */ };

    for (const step of t.steps) {
      for (const call of step.toolCalls ?? []) {
        const args = deportablize(call.args, ws);
        const recorded = recordedResults.get(call.id);
        const comparison: StepComparison = { callId: call.id, tool: call.tool, okMatch: null, hashMatch: null };
        if (!recorded) {
          comparison.detail = "no recorded result for this call";
          mismatches.push(`${call.tool}(${call.id}): no recorded result`);
          comparisons.push(comparison);
          continue;
        }
        const part: ToolCallPart = { kind: "tool_call", id: call.id, tool: call.tool, args };
        let out: { ok: boolean; output: string };
        try {
          out = await registry.dispatch(
            part,
            { sessionId: `replay-${t.header.runId}`, cwd: ws, signal: new AbortController().signal, permissions: { effect: "allow" } },
            undefined,
            rules,
            undefined,
            emit,
          );
        } catch (e) {
          out = { ok: false, output: `replay dispatch threw: ${e instanceof Error ? e.message : String(e)}` };
        }
        comparison.okMatch = out.ok === recorded.ok;
        const replaySha = sha256Text(portablize(out.output, ws) as unknown as string);
        comparison.hashMatch = recorded.outputSha !== undefined ? replaySha === recorded.outputSha : null;
        if (recorded.output !== undefined && comparison.hashMatch === false) {
          comparison.detail = `output drifted — recorded: ${recorded.output.slice(0, 120)} | replayed: ${(portablize(out.output, ws) as unknown as string).slice(0, 120)}`;
        }
        if (comparison.okMatch === false) mismatches.push(`${call.tool}(${call.id}): ok ${out.ok} vs recorded ${recorded.ok}`);
        if (comparison.hashMatch === false) mismatches.push(`${call.tool}(${call.id}): output hash drifted`);
        comparisons.push(comparison);
      }
    }

    let graderOutcomes: GraderOutcome[] = [];
    let outcomeMatch: boolean | null = null;
    const specs = (t.result?.graderSpecs ?? []) as GraderSpec[];
    if (specs.length > 0) {
      try {
        graderOutcomes = await runGraders(specs, {
          workspace: ws,
          fixture: t.header.fixture,
          transcript: { finalText: t.result?.evidence.finalText ?? "", toolCalls: [], events: [], recovered: true },
        });
        if (t.result) outcomeMatch = gradersPassed(graderOutcomes) === (t.result.outcome === "pass");
      } catch (e) {
        if (e instanceof GraderConfigError) {
          mismatches.push(`grader config: ${e.message}`);
        } else {
          mismatches.push(`grader run failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
    if (outcomeMatch === false) mismatches.push("replayed graders disagree with the recorded outcome");

    const stepMismatch = comparisons.some((c) => c.okMatch === false || c.hashMatch === false);
    return {
      ok: !stepMismatch && mismatches.length === 0 && outcomeMatch !== false,
      runId: t.header.runId,
      task: { id: t.header.task.id, category: t.header.task.category },
      comparisons,
      graderOutcomes,
      outcomeMatch,
      mismatches,
    };
  } finally {
    if (!opts?.keepWorkspace) rmSync(ws, { recursive: true, force: true });
  }
}
