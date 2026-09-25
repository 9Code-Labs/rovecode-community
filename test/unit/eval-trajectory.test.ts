/** Versioned JSONL trajectory/result persistence (eval P0-1): header + steps + result,
 *  one file per run, redacted on write, tolerant reader, fixture snapshots for replay. */

import { describe, test, expect } from "bun:test";
import {
  TrajectoryWriter,
  readTrajectory,
  EvalTrajectoryError,
  snapshotFixture,
  materializeFixture,
  TRAJECTORY_SCHEMA_VERSION,
  gitCommit,
  portablize,
  deportablize,
  sha256Text,
} from "../../src/eval/trajectory.ts";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "rovecode-eval-t-"));
}

/** The writer's workspace argument only feeds path portability; a stable fake keeps
 *  expectations readable. */
const WS = join("C:", "fake", "ws");

function headerLine() {
  return {
    kind: "header" as const,
    schemaVersion: TRAJECTORY_SCHEMA_VERSION,
    runId: "testrun01",
    startedAt: 1_700_000_000_000,
    task: { id: "basic-file-create", category: "basic", prompt: "create hello.txt" },
    model: { provider: "mock", model: "scripted" },
    seed: 42,
    commit: null,
    fixture: { files: { "note.txt": "plain" }, binary: {} },
    env: { platform: "test", runtime: "test" },
  };
}

function stepLine(seq: number) {
  return {
    kind: "step" as const,
    seq,
    type: "tool" as const,
    turn: 1,
    results: [{ callId: "c1", ok: true, output: "wrote <workspace>/hello.txt", outputSha: "abc" }],
  };
}

function resultLine() {
  return {
    kind: "result" as const,
    schemaVersion: TRAJECTORY_SCHEMA_VERSION,
    runId: "testrun01",
    outcome: "pass" as const,
    durationMs: 12,
    toolCallCount: 1,
    graderSpecs: [{ type: "file-changed" as const, path: "hello.txt" }],
    graderResults: [{ name: "file-changed:hello.txt", pass: true, detail: "created" }],
    evidence: { finalText: "created hello.txt" },
  };
}

describe("TrajectoryWriter + readTrajectory", () => {
  test("roundtrip preserves header, step order and result", () => {
    const dir = scratch();
    const w = new TrajectoryWriter(dir, "testrun01", WS);
    w.writeHeader(headerLine());
    w.writeStep(stepLine(0));
    w.writeStep({ kind: "step", seq: 1, type: "assistant", turn: 1, text: "created hello.txt", stopReason: "done" });
    w.writeResult(resultLine());
    const t = readTrajectory(w.path);
    expect(t.header?.runId).toBe("testrun01");
    expect(t.header?.schemaVersion).toBe(TRAJECTORY_SCHEMA_VERSION);
    expect(t.steps.map((s) => s.seq)).toEqual([0, 1]);
    expect(t.steps[0]!.results![0]!.callId).toBe("c1");
    expect(t.result?.outcome).toBe("pass");
    expect(t.unknown).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  test("secrets in args/output/evidence are redacted before they hit disk", () => {
    const dir = scratch();
    const w = new TrajectoryWriter(dir, "testrun01", WS);
    w.writeHeader(headerLine());
    w.writeStep({
      kind: "step", seq: 0, type: "assistant", turn: 0,
      toolCalls: [{ id: "c0", tool: "bash", args: { command: "curl -H 'Authorization: Bearer abc123def456' https://x" } }],
    });
    w.writeStep({
      kind: "step", seq: 1, type: "tool", turn: 0,
      results: [{ callId: "c0", ok: true, output: "ok sk-ant-api03-AbCdEf0123456789GhIjKlMnOpQrStU", outputSha: "deadbeef" }],
    });
    w.writeResult({ ...resultLine(), evidence: { finalText: "done api_key = \"supersecretvalue1\"" } });
    const raw = readFileSync(w.path, "utf8");
    expect(raw).not.toContain("abc123def456");
    expect(raw).not.toContain("sk-ant-api03");
    expect(raw).not.toContain("supersecretvalue1");
    expect(raw).toContain("[REDACTED");
    rmSync(dir, { recursive: true, force: true });
  });

  test("fixture file contents are redacted too", () => {
    const dir = scratch();
    const w = new TrajectoryWriter(dir, "testrun01", WS);
    w.writeHeader({
      ...headerLine(),
      fixture: { files: { "sdk.ts": "const k = 'sk-abcdefghij0123456789';" }, binary: {} },
    });
    const raw = readFileSync(w.path, "utf8");
    expect(raw).not.toContain("sk-abcdefghij0123456789");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("readTrajectory corruption classification", () => {
  test("unsupported schema version is an error, not a crash later", () => {
    const dir = scratch();
    const p = join(dir, "future.jsonl");
    writeFileSync(p, JSON.stringify({ ...headerLine(), schemaVersion: 99 }) + "\n");
    try {
      readTrajectory(p);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(EvalTrajectoryError);
      expect((e as EvalTrajectoryError).kind).toBe("unsupported-version");
    }
    rmSync(dir, { recursive: true, force: true });
  });

  test("file with no header line → missing-header", () => {
    const dir = scratch();
    const p = join(dir, "headless.jsonl");
    writeFileSync(p, JSON.stringify(stepLine(0)) + "\n");
    expect(() => readTrajectory(p)).toThrow(EvalTrajectoryError);
    try {
      readTrajectory(p);
    } catch (e) {
      expect((e as EvalTrajectoryError).kind).toBe("missing-header");
    }
    rmSync(dir, { recursive: true, force: true });
  });

  test("malformed line reports its line number", () => {
    const dir = scratch();
    const p = join(dir, "torn.jsonl");
    writeFileSync(p, JSON.stringify(headerLine()) + "\n{not json\n");
    try {
      readTrajectory(p);
      expect.unreachable();
    } catch (e) {
      expect((e as EvalTrajectoryError).kind).toBe("malformed-line");
      expect((e as EvalTrajectoryError).line).toBe(2);
    }
    rmSync(dir, { recursive: true, force: true });
  });

  test("unknown line kinds are counted, never fatal", () => {
    const dir = scratch();
    const p = join(dir, "mixed.jsonl");
    writeFileSync(p, JSON.stringify(headerLine()) + "\n" + JSON.stringify({ kind: "future-kind", x: 1 }) + "\n" + JSON.stringify(stepLine(0)) + "\n");
    const t = readTrajectory(p);
    expect(t.unknown).toBe(1);
    expect(t.steps.length).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });

  test("missing file → missing-file", () => {
    expect(() => readTrajectory(join(tmpdir(), "rovecode-eval-nope", "x.jsonl"))).toThrow(EvalTrajectoryError);
  });
});

describe("fixture snapshot/materialize", () => {
  test("text files round-trip, nested dirs included", () => {
    const ws = scratch();
    mkdirSync(join(ws, "sub"), { recursive: true });
    writeFileSync(join(ws, "a.txt"), "alpha");
    writeFileSync(join(ws, "sub", "b.txt"), "beta");
    const spec = snapshotFixture(ws);
    expect(spec.files["a.txt"]).toBe("alpha");
    expect(spec.files["sub/b.txt"]).toBe("beta"); // fixture keys are always slash-relative
    const out = scratch();
    materializeFixture(spec, out);
    expect(readFileSync(join(out, "a.txt"), "utf8")).toBe("alpha");
    expect(readFileSync(join(out, "sub", "b.txt"), "utf8")).toBe("beta");
    rmSync(ws, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  });

  test("binary files are recorded by sha only (never embedded)", () => {
    const ws = scratch();
    writeFileSync(join(ws, "img.bin"), Buffer.from([0x00, 0xff, 0x00, 0x13]));
    const spec = snapshotFixture(ws);
    expect(spec.files["img.bin"]).toBeUndefined();
    expect(spec.binary["img.bin"]).toMatch(/^[0-9a-f]{64}$/);
    rmSync(ws, { recursive: true, force: true });
  });

  test("oversized files are not embedded", () => {
    const ws = scratch();
    writeFileSync(join(ws, "big.txt"), "x".repeat(600_000));
    const spec = snapshotFixture(ws, { maxFileBytes: 100_000 });
    expect(spec.files["big.txt"]).toBeUndefined();
    expect(spec.binary["big.txt"]).toMatch(/^[0-9a-f]{64}$/);
    rmSync(ws, { recursive: true, force: true });
  });

  test(".git and node_modules are never walked", () => {
    const ws = scratch();
    mkdirSync(join(ws, ".git"), { recursive: true });
    mkdirSync(join(ws, "node_modules", "x"), { recursive: true });
    writeFileSync(join(ws, ".git", "HEAD"), "ref");
    writeFileSync(join(ws, "node_modules", "x", "i.js"), "j");
    const spec = snapshotFixture(ws);
    expect(Object.keys(spec.files).length).toBe(0);
    rmSync(ws, { recursive: true, force: true });
  });
});

describe("path portability (replay across machines)", () => {
  test("portablize replaces the workspace path in nested strings, both slash styles", () => {
    const ws = scratch();
    const args = { path: join(ws, "a.txt"), cmd: `cat ${ws.replace(/\\/g, "/")}/a.txt`, n: 1 };
    const p = portablize(args, ws) as typeof args;
    expect(p.path).toBe(join("<workspace>", "a.txt"));
    expect(p.cmd).toContain("<workspace>/a.txt");
    expect(p.n).toBe(1);
    expect(deportablize(p, ws).path).toBe(join(ws, "a.txt"));
    rmSync(ws, { recursive: true, force: true });
  });

  test("sha256Text is stable and hex", () => {
    expect(sha256Text("abc")).toBe(sha256Text("abc"));
    expect(sha256Text("abc")).not.toBe(sha256Text("abd"));
    expect(sha256Text("x")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("gitCommit", () => {
  test("returns a hash or null, never throws", () => {
    const c = gitCommit();
    expect(c === null || /^[0-9a-f]{7,40}$/.test(c)).toBe(true);
  });
});

describe("TrajectoryWriter basics", () => {
  test("path lands in dir named after runId", () => {
    const dir = scratch();
    const w = new TrajectoryWriter(dir, "myrun99", WS);
    expect(w.path).toBe(join(dir, "myrun99.trajectory.jsonl"));
    expect(existsSync(w.path)).toBe(false); // nothing written until a record is added
    w.writeHeader(headerLine());
    expect(existsSync(w.path)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});
