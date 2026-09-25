/** Patch/test-based graders (eval P0-2): workspace-relative, fixture-baselined, JSON-serializable
 *  specs that replay can re-run. The composite gate rejects final-text (string-contains) as the
 *  sole grader — that alone never counts as success. */

import { describe, test, expect } from "bun:test";
import { runGraders, validateGraderSpecs, gradersPassed, GraderConfigError, type GraderSpec, type GraderContext } from "../../src/eval/grader.ts";
import { snapshotFixture, type FixtureSpec } from "../../src/eval/trajectory.ts";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function ctx(opts: { before?: Record<string, string>; after?: Record<string, string>; finalText?: string; created?: boolean }) {
  const ws = mkdtempSync(join(tmpdir(), "rovecode-eval-g-"));
  mkdirSync(ws, { recursive: true });
  for (const [p, c] of Object.entries(opts.before ?? {})) {
    const abs = join(ws, p);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, c);
  }
  const fixture: FixtureSpec = opts.created ? { files: {}, binary: {} } : snapshotFixture(ws);
  for (const [p, c] of Object.entries(opts.after ?? {})) {
    const abs = join(ws, p);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, c);
  }
  const gctx: GraderContext = {
    workspace: ws,
    fixture,
    transcript: { toolCalls: [], events: [], finalText: opts.finalText ?? "", recovered: true },
  };
  return { gctx, cleanup: () => rmSync(ws, { recursive: true, force: true }) };
}

const FILE_EQUALS: GraderSpec = { type: "file-equals", path: "out.txt", content: "exactly this" };

describe("file graders", () => {
  test("file-equals passes on exact content, fails otherwise", async () => {
    const pass = ctx({ before: {}, after: { "out.txt": "exactly this" }, created: true });
    const fail = ctx({ before: {}, after: { "out.txt": "something else" }, created: true });
    const [a] = await runGraders([FILE_EQUALS], pass.gctx);
    const [b] = await runGraders([FILE_EQUALS], fail.gctx);
    expect(a!.pass).toBe(true);
    expect(b!.pass).toBe(false);
    pass.cleanup();
    fail.cleanup();
  });

  test("file-matches applies the regex with flags", async () => {
    const spec: GraderSpec = { type: "file-matches", path: "code.py", pattern: "def\\s+fib\\s*\\(", flags: "i" };
    const pass = ctx({ before: { "code.py": "PI = 3.14" }, after: { "code.py": "PI = 3.14\ndef fib(n):\n    return n" } });
    const fail = ctx({ before: { "code.py": "PI = 3.14" }, after: { "code.py": "PI = 3.15" } });
    const [a] = await runGraders([spec], pass.gctx);
    const [b] = await runGraders([spec], fail.gctx);
    expect(a!.pass).toBe(true);
    expect(b!.pass).toBe(false);
    pass.cleanup();
    fail.cleanup();
  });

  test("file-changed passes on a real patch (changed + mustMatch), fails on no-op or wrong edit", async () => {
    const spec: GraderSpec = { type: "file-changed", path: "bug.py", mustMatch: "a \\+ b", mustNotMatch: "a - b" };
    const fixed = ctx({ before: { "bug.py": "def add(a, b):\n    return a - b" }, after: { "bug.py": "def add(a, b):\n    return a + b" } });
    const untouched = ctx({ before: { "bug.py": "def add(a, b):\n    return a - b" }, after: { "bug.py": "def add(a, b):\n    return a - b" } });
    const wrongEdit = ctx({ before: { "bug.py": "def add(a, b):\n    return a - b" }, after: { "bug.py": "def add(a, b):\n    return a * b" } });
    const [a] = await runGraders([spec], fixed.gctx);
    const [b] = await runGraders([spec], untouched.gctx);
    const [c] = await runGraders([spec], wrongEdit.gctx);
    expect(a!.pass).toBe(true);
    expect(b!.pass).toBe(false); // unchanged relative to the fixture baseline
    expect(c!.pass).toBe(false); // changed, but the new content does not match
    fixed.cleanup();
    untouched.cleanup();
    wrongEdit.cleanup();
  });

  test("file-changed counts a created file as changed, missing file fails", async () => {
    const created = ctx({ before: {}, after: { "hello.txt": "hello rovecode" }, created: true });
    const missing = ctx({ before: {}, after: {}, created: true });
    const [a] = await runGraders([{ type: "file-changed", path: "hello.txt" }], created.gctx);
    const [b] = await runGraders([{ type: "file-changed", path: "hello.txt" }], missing.gctx);
    expect(a!.pass).toBe(true);
    expect(b!.pass).toBe(false);
    created.cleanup();
    missing.cleanup();
  });

  test("file-changed evidence carries a unified diff", async () => {
    const c = ctx({ before: { "f.txt": "old line" }, after: { "f.txt": "new line" } });
    const [a] = await runGraders([{ type: "file-changed", path: "f.txt" }], c.gctx);
    expect(a!.pass).toBe(true);
    expect(a!.detail).toContain("+new line");
    expect(a!.detail).toContain("-old line");
    c.cleanup();
  });
});

describe("command grader", () => {
  test("passes when the process exits with the expected code", async () => {
    const c = ctx({});
    const [a] = await runGraders([{ type: "command", command: "bun", args: ["-e", "process.exit(0)"] }], c.gctx);
    expect(a!.pass).toBe(true);
    c.cleanup();
  });

  test("fails on a nonzero exit", async () => {
    const c = ctx({});
    const [a] = await runGraders([{ type: "command", command: "bun", args: ["-e", "process.exit(3)"] }], c.gctx);
    expect(a!.pass).toBe(false);
    expect(a!.detail).toContain("3");
    c.cleanup();
  });

  test("runs inside the workspace (cwd-relative fixture)", async () => {
    const c = ctx({ after: { "probe.txt": "here" }, created: true });
    const [a] = await runGraders([{ type: "command", command: "bun", args: ["-e", 'const fs = require("node:fs"); process.exit(fs.existsSync("probe.txt") ? 0 : 1)'] }], c.gctx);
    expect(a!.pass).toBe(true);
    c.cleanup();
  });

  test("timeout fails the grader instead of hanging", async () => {
    const c = ctx({});
    const [a] = await runGraders([{ type: "command", command: "bun", args: ["-e", "setTimeout(() => {}, 30_000)"], timeoutMs: 500 }], c.gctx);
    expect(a!.pass).toBe(false);
    expect(a!.detail).toContain("timeout");
    c.cleanup();
  }, 10_000);
});

describe("final-text is advisory, never sufficient", () => {
  test("advisory-only specs are rejected by the composite gate", () => {
    const v = validateGraderSpecs([{ type: "final-text", pattern: "PONG" }]);
    expect(v.ok).toBe(false);
    expect(v.ok === false ? v.reason : "").toContain("string-contains");
  });

  test("empty spec list is rejected", () => {
    expect(validateGraderSpecs([]).ok).toBe(false);
  });

  test("runGraders throws GraderConfigError for advisory-only or unknown specs", async () => {
    const c = ctx({ finalText: "PONG" });
    expect(runGraders([{ type: "final-text", pattern: "PONG" }], c.gctx)).rejects.toThrow(GraderConfigError);
    expect(runGraders([{ type: "nope" } as unknown as GraderSpec], c.gctx)).rejects.toThrow(GraderConfigError);
    c.cleanup();
  });

  test("advisory passes alongside behavioral specs and is recorded", async () => {
    const c = ctx({ before: {}, after: { "out.txt": "exactly this" }, created: true, finalText: "all done" });
    const outcomes = await runGraders([FILE_EQUALS, { type: "final-text", pattern: "never matches" }], c.gctx);
    expect(outcomes.length).toBe(2);
    expect(outcomes[1]!.advisory).toBe(true);
    expect(outcomes[1]!.pass).toBe(false);
    expect(gradersPassed(outcomes)).toBe(true); // advisory failure does not sink the composite
    c.cleanup();
  });

  test("strict failure sinks the composite", async () => {
    const c = ctx({ before: {}, after: { "out.txt": "wrong" }, created: true });
    const outcomes = await runGraders([FILE_EQUALS, { type: "final-text", pattern: "all done" }], c.gctx);
    expect(gradersPassed(outcomes)).toBe(false);
    c.cleanup();
  });
});
