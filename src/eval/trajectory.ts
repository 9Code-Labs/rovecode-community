/**
 * Eval trajectory/result persistence (eval P0-1): a VERSIONED JSONL schema, one file per run.
 *
 *   line 1   {"kind":"header", "schemaVersion":1, …run identity, task, model, seed, commit, fixture}
 *   …        {"kind":"step",   …user / assistant (tool calls) / tool (results) records}
 *   last     {"kind":"result", …outcome, duration, usage, cost, failure taxonomy, grader specs+results, evidence}
 *
 * Design rules the file is judged by:
 *  - Every string payload is REDACTED (eval/redact.ts) and workspace-relative-ized
 *    (portablize: absolute workspace paths become a "<workspace>" token) BEFORE it is
 *    written — a trajectory is safe to commit/share and replayable on another machine.
 *  - `outputSha` is the sha256 of the path-normalized RAW tool output, so replay compares
 *    substance while the stored text stays redacted evidence.
 *  - The reader CLASSIFIES problems (unsupported-version / missing-header / malformed-line
 *    with its line number / unknown line kinds tolerated) — never a raw JSON crash mid-file.
 *  - Fixture snapshots (fixtureSpec) record the pre-run workspace so replay can rebuild it
 *    deterministically; binaries are recorded by sha only, never embedded.
 *
 * Schema version 1. Adding optional fields is compatible; bump TRAJECTORY_SCHEMA_VERSION
 * and add the old version to SUPPORTED_TRAJECTORY_VERSIONS when reading old files.
 */

import { createHash, randomUUID } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { redactDeep } from "./redact.ts";
import type { PermissionRule } from "../core/types.ts";

export const TRAJECTORY_SCHEMA_VERSION = 1;
export const SUPPORTED_TRAJECTORY_VERSIONS: readonly number[] = [1];

export type FailureTaxonomy =
  | "verify-failed"      // a strict grader rejected the end state
  | "timeout"            // the run's deadline fired
  | "provider-error"     // the provider/stream failed (run_end "error" or thrown)
  | "budget"             // turn/second/cost budget exhausted (run_end "budget")
  | "loop-guard"         // the tool guard stubbed the run into submission
  | "invalid-args"       // tool calls the schema rejected
  | "permission-denied"  // policy/hook/user denied the needed tool call
  | "workspace-leak"     // the runner left temp dirs behind
  | "tool-error"         // tool failures without a more specific home
  | "unknown";

export interface FixtureSpec {
  /** workspace-relative path → full text content (redacted) */
  files: Record<string, string>;
  /** workspace-relative path → sha256 of content; the content itself is NOT persisted */
  binary: Record<string, string>;
}

export interface TrajectoryHeaderLine {
  kind: "header";
  schemaVersion: number;
  runId: string;
  startedAt: number;
  task: { id: string; category: string; prompt: string };
  model: { provider: string; model: string } | null;
  seed: number;
  commit: string | null;
  fixture: FixtureSpec;
  permissionRules?: PermissionRule[];
  env: { platform: string; runtime: string };
}

export interface RecordedToolCall { id: string; tool: string; args: unknown }

export interface RecordedToolResult {
  callId: string;
  ok: boolean;
  /** path-normalized + redacted text (evidence, bounded) */
  output: string;
  /** sha256 of the path-normalized RAW output — what replay compares */
  outputSha: string;
}

export interface TrajectoryStepLine {
  kind: "step";
  seq: number;
  type: "user" | "assistant" | "tool";
  turn?: number;
  text?: string;
  toolCalls?: RecordedToolCall[];
  results?: RecordedToolResult[];
  stopReason?: string;
  usage?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
}

export interface GraderOutcomeRecord { name: string; pass: boolean; detail: string }

export interface TrajectoryResultLine {
  kind: "result";
  schemaVersion: number;
  runId: string;
  outcome: "pass" | "fail" | "error" | "timeout";
  durationMs: number;
  toolCallCount: number;
  usage?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
  costUsd?: number;
  failure?: { taxonomy: FailureTaxonomy; detail: string };
  graderSpecs?: unknown[];
  graderResults?: GraderOutcomeRecord[];
  evidence: { finalText?: string; toolCalls?: { tool: string; args: unknown }[]; notes?: string[] };
}

export type TrajectoryLine = TrajectoryHeaderLine | TrajectoryStepLine | TrajectoryResultLine;

// ---------- path portability + stable hashing ----------

export const WORKSPACE_TOKEN = "<workspace>";

/** Deep-walk a JSON value and replace the workspace's absolute path (both slash styles) inside
 *  string values with the "<workspace>" token — the recorded file becomes machine-independent. */
export function portablize<T>(value: T, workspace: string): T {
  const win = workspace;
  const fwd = workspace.replace(/\\/g, "/");
  const swap = (s: string): string => {
    let out = s.split(win).join(WORKSPACE_TOKEN);
    if (fwd !== win) out = out.split(fwd).join(WORKSPACE_TOKEN);
    return out;
  };
  const walk = (v: unknown, seen: Set<object>): unknown => {
    if (typeof v === "string") return swap(v);
    if (v === null || typeof v !== "object") return v;
    const o = v as object;
    if (seen.has(o)) return "[circular]";
    seen.add(o);
    try {
      if (Array.isArray(o)) return o.map((x) => walk(x, seen));
      const rec = o as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(rec)) out[k] = walk(x, seen);
      return out;
    } finally {
      seen.delete(o);
    }
  };
  return walk(value, new Set()) as T;
}

/** Inverse of portablize: "<workspace>" tokens in a recorded value become real paths again. */
export function deportablize<T>(value: T, workspace: string): T {
  const walk = (v: unknown, seen: Set<object>): unknown => {
    if (typeof v === "string") return v.split(WORKSPACE_TOKEN).join(workspace);
    if (v === null || typeof v !== "object") return v;
    const o = v as object;
    if (seen.has(o)) return "[circular]";
    seen.add(o);
    try {
      if (Array.isArray(o)) return o.map((x) => walk(x, seen));
      const rec = o as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(rec)) out[k] = walk(x, seen);
      return out;
    } finally {
      seen.delete(o);
    }
  };
  return walk(value, new Set()) as T;
}

export function sha256Text(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf16le")).digest("hex");
}

// ---------- fixture snapshots (the deterministic replay input) ----------

const FIXTURE_SKIP = new Set([".git", "node_modules", "dist", "out", ".rovecode", ".cumulus", "__pycache__"]);

export function snapshotFixture(workspace: string, opts?: { maxFileBytes?: number }): FixtureSpec {
  const maxFileBytes = opts?.maxFileBytes ?? 256 * 1024;
  const files: Record<string, string> = {};
  const binary: Record<string, string> = {};
  const walk = (dir: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (FIXTURE_SKIP.has(name)) continue;
      const abs = join(dir, name);
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!st.isFile()) continue;
      const rel = relative(workspace, abs).replace(/\\/g, "/");
      try {
        if (st.size > maxFileBytes) {
          binary[rel] = createHash("sha256").update(readFileSync(abs)).digest("hex");
          continue;
        }
        const buf = readFileSync(abs);
        if (buf.subarray(0, 1024).includes(0)) {
          binary[rel] = createHash("sha256").update(buf).digest("hex");
          continue;
        }
        files[rel] = buf.toString("utf8");
      } catch {
        // unreadable file: skip, the fixture is a best-effort snapshot of a test workspace
      }
    }
  };
  walk(workspace);
  return { files, binary };
}

export function materializeFixture(fixture: FixtureSpec, dir: string): void {
  for (const [rel, content] of Object.entries(fixture.files)) {
    const abs = join(dir, ...rel.split("/"));
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }
}

// ---------- writer ----------

/** Evidence outputs are bounded: the full redacted text would bloat JSONL for huge tool
 *  results; the sha (unbounded input) is what replay actually compares. */
const EVIDENCE_OUTPUT_CHARS = 2000;

export class TrajectoryWriter {
  readonly path: string;
  private readonly workspace: string;

  constructor(dir: string, runId: string, workspace: string) {
    mkdirSync(dir, { recursive: true });
    this.path = join(dir, `${runId}.trajectory.jsonl`);
    this.workspace = workspace;
  }

  private write(line: TrajectoryLine): void {
    appendFileSync(this.path, JSON.stringify(line) + "\n", "utf8");
  }

  writeHeader(header: TrajectoryHeaderLine): void {
    const fixture = {
      files: redactDeep(portablize(header.fixture.files, this.workspace)) as Record<string, string>,
      binary: header.fixture.binary,
    };
    this.write({ ...header, task: redactDeep(header.task), fixture, permissionRules: header.permissionRules });
  }

  writeStep(step: TrajectoryStepLine): void {
    const s: TrajectoryStepLine = { ...step };
    if (s.text !== undefined) s.text = redactSafe(portablize(s.text, this.workspace));
    if (s.toolCalls !== undefined) s.toolCalls = redactDeep(portablize(s.toolCalls, this.workspace)) as RecordedToolCall[];
    if (s.results !== undefined) {
      s.results = (portablize(s.results, this.workspace) as RecordedToolResult[]).map((r) => ({
        ...r,
        output: redactSafe(r.output).slice(0, EVIDENCE_OUTPUT_CHARS),
      }));
    }
    this.write(s);
  }

  writeResult(result: TrajectoryResultLine): void {
    const evidence = redactDeep(portablize(result.evidence, this.workspace)) as TrajectoryResultLine["evidence"];
    if (evidence.finalText !== undefined) evidence.finalText = evidence.finalText.slice(0, EVIDENCE_OUTPUT_CHARS);
    const graderSpecs = result.graderSpecs !== undefined
      ? (redactDeep(portablize(result.graderSpecs, this.workspace)) as unknown[])
      : undefined;
    this.write({ ...result, graderSpecs, evidence });
  }
}

/** String convenience for redactDeep — redacts every pattern hit in one string. */
export function redactSafe(s: string): string {
  return redactDeep(s) as unknown as string;
}

// ---------- reader ----------

export type EvalTrajectoryErrorKind = "missing-file" | "unsupported-version" | "missing-header" | "malformed-line";

export class EvalTrajectoryError extends Error {
  readonly kind: EvalTrajectoryErrorKind;
  readonly line?: number;

  constructor(kind: EvalTrajectoryErrorKind, message: string, line?: number) {
    super(line === undefined ? message : `${message} (line ${line})`);
    this.name = "EvalTrajectoryError";
    this.kind = kind;
    this.line = line;
  }
}

export interface Trajectory {
  header: TrajectoryHeaderLine;
  steps: TrajectoryStepLine[];
  result: TrajectoryResultLine | null;
  /** foreign line kinds (a newer writer) — tolerated and counted, never fatal */
  unknown: number;
}

export function readTrajectory(path: string): Trajectory {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new EvalTrajectoryError("missing-file", `trajectory file not readable: ${path}`);
  }
  const lines = raw.split("\n");
  let header: TrajectoryHeaderLine | null = null;
  const steps: TrajectoryStepLine[] = [];
  let result: TrajectoryResultLine | null = null;
  let unknown = 0;
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]!.trim();
    if (text === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new EvalTrajectoryError("malformed-line", "trajectory line is not valid JSON", i + 1);
    }
    if (!parsed || typeof parsed !== "object" || !("kind" in parsed)) {
      unknown++;
      continue;
    }
    const kind = (parsed as { kind: unknown }).kind;
    if (kind === "header") {
      header = parsed as TrajectoryHeaderLine;
      continue;
    }
    if (kind === "step") {
      steps.push(parsed as TrajectoryStepLine);
      continue;
    }
    if (kind === "result") {
      result = parsed as TrajectoryResultLine;
      continue;
    }
    unknown++;
  }
  if (header === null) throw new EvalTrajectoryError("missing-header", "trajectory has no header line");
  if (!SUPPORTED_TRAJECTORY_VERSIONS.includes(header.schemaVersion)) {
    throw new EvalTrajectoryError(
      "unsupported-version",
      `trajectory schemaVersion ${header.schemaVersion} not supported (supported: ${SUPPORTED_TRAJECTORY_VERSIONS.join(", ")})`,
    );
  }
  steps.sort((a, b) => a.seq - b.seq);
  return { header, steps, result, unknown };
}

// ---------- run identity helpers ----------

/** Best-effort HEAD commit for the header; null when git is absent (never throws). */
export function gitCommit(): string | null {
  try {
    const proc = Bun.spawnSync(["git", "rev-parse", "HEAD"], { stdout: "pipe", stderr: "pipe" });
    if (proc.exitCode !== 0) return null;
    const out = proc.stdout.toString().trim();
    return /^[0-9a-f]{7,40}$/.test(out) ? out : null;
  } catch {
    return null;
  }
}

/** Filesystem-safe run id with the task prefix and a time+random suffix. */
export function makeRunId(taskId: string): string {
  const safe = taskId.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
  const t = Date.now().toString(36);
  return `${safe}-${t}-${randomUUID().slice(0, 4)}`;
}
