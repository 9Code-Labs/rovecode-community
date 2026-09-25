/**
 * Evaluate-and-record: runs one gauntlet task through the scripted (offline) runner,
 * captures every loop event into a versioned trajectory JSONL (eval P0-1), then grades
 * the end state with patch/test-based graders (eval P0-2) and writes the result line.
 *
 * The existing deterministic gauntlet is NOT modified: runTask gains only an optional
 * event sink (same loop, same scripted stream, same verdict), and the grader layer is
 * additive — a recorded run can be graded without touching gauntlet.ts's own verify.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTask } from "./gauntlet-runner.ts";
import type { GauntletTask, GauntletTranscript } from "./gauntlet.ts";
import { runGraders, gradersPassed, type GraderOutcome, type GraderSpec } from "./grader.ts";
import {
  TrajectoryWriter,
  snapshotFixture,
  gitCommit,
  makeRunId,
  sha256Text,
  portablize,
  redactSafe,
  TRAJECTORY_SCHEMA_VERSION,
  type FailureTaxonomy,
  type FixtureSpec,
  type TrajectoryResultLine,
  type TrajectoryStepLine,
  type RecordedToolResult,
} from "./trajectory.ts";
import type { RunEvent, PermissionRule } from "../core/types.ts";

export interface EvalTaskSpec {
  id: string;
  category: string;
  prompt: string;
  task: GauntletTask;
  graderSpecs: GraderSpec[];
  model?: { provider: string; model: string } | null;
  seed?: number;
  commit?: string | null;
  permissionRules?: PermissionRule[];
}

export interface RecordOptions {
  /** output dir for the trajectory JSONL (created if missing) */
  dir: string;
  runId?: string;
  guard?: Parameters<typeof runTask>[2];
}

export interface RecordOutcome {
  runId: string;
  path: string;
  result: TrajectoryResultLine;
  transcript: GauntletTranscript;
  graderOutcomes: GraderOutcome[];
  fixture: FixtureSpec;
}

const EVIDENCE_TOOLCALLS = 64;

/** Map a loop event onto trajectory step lines. `seq` orders the file; tool outputs get
 *  their replay-comparable sha here (normalized RAW output, redaction is lossy). */
class StepBuilder {
  private seq = 0;
  private turn = 0;

  from(ev: RunEvent, workspace: string): TrajectoryStepLine[] {
    switch (ev.type) {
      case "run_start":
        this.turn = 0;
        return [this.step({ type: "user", text: ev.goal })];
      case "turn_start":
        this.turn = ev.turn;
        return [];
      case "tool_execution_start":
        return [this.step({ type: "assistant", turn: this.turn, toolCalls: [{ id: ev.callId, tool: ev.tool, args: ev.args }] })];
      case "tool_execution_end": {
        const normalized = portablize(ev.output, workspace) as unknown as string;
        const rec: RecordedToolResult = {
          callId: ev.callId,
          ok: ev.ok,
          output: normalized,
          outputSha: sha256Text(normalized),
        };
        return [this.step({ type: "tool", turn: this.turn, results: [rec] })];
      }
      case "tool_call_failed": {
        const output = `${ev.reason}: ${ev.detail}`;
        const rec: RecordedToolResult = { callId: ev.callId, ok: false, output, outputSha: sha256Text(portablize(output, workspace) as unknown as string) };
        return [this.step({ type: "tool", turn: this.turn, results: [rec] })];
      }
      case "turn_end":
        return [this.step({ type: "assistant", turn: ev.turn, stopReason: ev.stopReason })];
      case "run_end":
        return [this.step({ type: "assistant", stopReason: ev.status, text: ev.summary })];
      default:
        return [];
    }
  }

  private step(fields: Record<string, unknown>): TrajectoryStepLine {
    return { kind: "step", seq: this.seq++, ...fields } as TrajectoryStepLine;
  }
}

export function classifyFailure(input: {
  graderOutcomes?: readonly GraderOutcome[];
  events?: readonly RunEvent[];
  error?: unknown;
  transcript?: Pick<GauntletTranscript, "finalText" | "events" | "toolCalls" | "recovered">;
}): { taxonomy: FailureTaxonomy; detail: string } {
  if (input.error !== undefined) {
    const msg = input.error instanceof Error ? input.error.message : String(input.error);
    return { taxonomy: /timeout/i.test(msg) ? "timeout" : "provider-error", detail: msg };
  }
  const failed = (input.graderOutcomes ?? []).find((o) => !o.advisory && !o.pass);
  if (failed) return { taxonomy: "verify-failed", detail: `${failed.name}: ${failed.detail.slice(0, 300)}` };
  const events = input.events ?? [];
  for (const ev of events) {
    if (ev.type === "tool_call_failed" && ev.reason === "invalid_args") return { taxonomy: "invalid-args", detail: ev.detail.slice(0, 300) };
    if (ev.type === "tool_call_failed" && ev.reason === "permission_denied") return { taxonomy: "permission-denied", detail: ev.detail.slice(0, 300) };
  }
  const guardBlocked = events.some((ev) => ev.type === "tool_execution_end" && ev.output.includes("loop guard: blocked"));
  if (guardBlocked) return { taxonomy: "loop-guard", detail: "the tool guard stubbed repeated identical calls until the run ended" };
  if (input.transcript && /error:/i.test(input.transcript.finalText)) {
    return { taxonomy: "provider-error", detail: input.transcript.finalText.slice(0, 300) };
  }
  return { taxonomy: "unknown", detail: "run failed without a recognized signature" };
}

/** Run one task offline (scripted provider), record its trajectory, grade its end state. */
export async function evaluateAndRecord(spec: EvalTaskSpec, opts: RecordOptions): Promise<RecordOutcome> {
  const runId = opts.runId ?? makeRunId(spec.id);
  const ws = spec.task.setup ? spec.task.setup() : mkdtempSync(join(tmpdir(), "rovecode-eval-"));
  const t0 = Date.now();
  const builder = new StepBuilder();
  const events: RunEvent[] = [];
  let transcript: GauntletTranscript | null = null;
  let error: unknown;
  try {
    const fixture = snapshotFixture(ws);
    const writer = new TrajectoryWriter(opts.dir, runId, ws);
    writer.writeHeader({
      kind: "header",
      schemaVersion: TRAJECTORY_SCHEMA_VERSION,
      runId,
      startedAt: t0,
      task: { id: spec.id, category: spec.category, prompt: spec.prompt },
      model: spec.model ?? null,
      seed: spec.seed ?? 0,
      commit: spec.commit !== undefined ? spec.commit : gitCommit(),
      fixture,
      ...(spec.permissionRules ? { permissionRules: spec.permissionRules } : {}),
      env: { platform: process.platform, runtime: "bun" },
    });
    const onEvent = (ev: RunEvent): void => {
      events.push(ev);
      for (const step of builder.from(ev, ws)) writer.writeStep(step);
    };
    try {
      transcript = await runTask(spec.task, ws, opts.guard ?? undefined, onEvent);
    } catch (e) {
      error = e;
    }
    const graderOutcomes = error === undefined
      ? await runGraders(spec.graderSpecs, { workspace: ws, fixture, transcript: transcript ?? { toolCalls: [], events: [], finalText: "", recovered: false } })
      : [];
    const pass = error === undefined && transcript !== null && gradersPassed(graderOutcomes);
    const failure = pass ? undefined : classifyFailure({ graderOutcomes, events, error, transcript: transcript ?? undefined });
    const result: TrajectoryResultLine = {
      kind: "result",
      schemaVersion: TRAJECTORY_SCHEMA_VERSION,
      runId,
      outcome: pass ? "pass" : failure?.taxonomy === "timeout" || failure?.taxonomy === "provider-error" ? "error" : "fail",
      durationMs: Date.now() - t0,
      toolCallCount: transcript?.toolCalls.length ?? 0,
      ...(transcript?.usage ? { usage: transcript.usage } : {}),
      graderSpecs: spec.graderSpecs as unknown[],
      graderResults: graderOutcomes.map((o) => ({ name: o.name, pass: o.pass, detail: redactSafe(o.detail).slice(0, 400) })),
      evidence: {
        finalText: transcript?.finalText,
        ...(transcript ? { toolCalls: transcript.toolCalls.slice(0, EVIDENCE_TOOLCALLS).map((c) => ({ tool: c.tool, args: c.args })) } : {}),
        ...(failure ? { notes: [`${failure.taxonomy}: ${failure.detail}`] } : {}),
      },
      ...(failure ? { failure } : {}),
    };
    writer.writeResult(result);
    return {
      runId,
      path: writer.path,
      result,
      transcript: transcript ?? { toolCalls: [], events: [], finalText: "", recovered: false },
      graderOutcomes,
      fixture,
    };
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
}
