/**
 * PORT #18 (round 2 LOW-4) — the flag-ON createRuntime wiring path.
 *
 * evalcell.test.ts proves the tool against a HAND-BUILT registry; this file proves
 * the REAL runtime door: src/cli/runtime.ts registers withCheckpoint(createEvalCellTool())
 * — the factory reading live process.env — only when ROVECODE_EVAL_CELL=1, and dispatch
 * runs under the real buildCfg(false, approver) rule set:
 *   - env set   ⇒ registry CONTAINS eval_cell; dispatch prompts as shell.exec;
 *                 a deny verdict blocks execution (cell-side counter never advances),
 *                 an allow verdict executes (counter lands at exactly 1);
 *   - env unset ⇒ absent (control; complements runtime.test.ts's exact-set pin).
 * process.env is mutated ONLY inside save+restore try/finally blocks.
 */

import { test, expect, afterAll } from "bun:test";
import { createRuntime } from "../../src/cli/runtime.ts";
import { disposeEvalCells, EVAL_CELL_FLAG } from "../../src/tools/evalcell.ts";
import type { ApprovalFn, ToolCallPart, ToolContext } from "../../src/core/types.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

afterAll(async () => { await disposeEvalCells(); });

function tmpCwd(): string { return mkdtempSync(join(tmpdir(), "rovecode-rt-evalcell-")); }

function tctx(sessionId: string, cwd: string): ToolContext {
  return { sessionId, cwd, signal: new AbortController().signal, permissions: { effect: "allow" } };
}

function cellCall(id: string, code: string): ToolCallPart {
  return { kind: "tool_call", id, tool: "eval_cell", args: { code } };
}

// cell-side counter (as in evalcell.test.ts): only advances when execution REALLY happened,
// so a denied dispatch is proven unexecuted rather than merely error-labelled
const COUNTER = "globalThis.hits = ((globalThis.hits as number | undefined) ?? 0) + 1; globalThis.hits";

test("createRuntime registers eval_cell iff ROVECODE_EVAL_CELL=1 (the real runtime door)", () => {
  const saved = process.env[EVAL_CELL_FLAG];
  const cwd = tmpCwd();
  try {
    process.env[EVAL_CELL_FLAG] = "1";
    const on = createRuntime({ cwd, stream: null });
    expect(on.registry.list().map((t) => t.schema.name)).toContain("eval_cell");

    delete process.env[EVAL_CELL_FLAG];
    const off = createRuntime({ cwd, stream: null });
    expect(off.registry.list().map((t) => t.schema.name)).not.toContain("eval_cell");
  } finally {
    if (saved === undefined) delete process.env[EVAL_CELL_FLAG]; else process.env[EVAL_CELL_FLAG] = saved;
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("flag-ON dispatch under buildCfg(false): the shell.exec prompt gates the cell; deny blocks execution, allow runs it", async () => {
  const saved = { flag: process.env[EVAL_CELL_FLAG], cp: process.env.ROVECODE_NO_CHECKPOINTS };
  const cwd = tmpCwd();
  try {
    process.env[EVAL_CELL_FLAG] = "1";
    process.env.ROVECODE_NO_CHECKPOINTS = "1"; // keep the withCheckpoint wrapper inert (no shadow-git in tmp)
    const rt = createRuntime({ cwd, stream: null });

    const reasons: string[] = [];
    const verdicts: ("once" | "deny")[] = ["deny", "once"];
    const approver: ApprovalFn = async (req) => { reasons.push(req.reason); return verdicts.shift() ?? "deny"; };
    const cfg = rt.buildCfg(false, approver); // real gated config, incl. the execPolicyApprover wrap
    const ctx = tctx("p18-rt-gate", cwd);

    // deny verdict: prompted via the execute→shell.exec action, and the cell NEVER executed
    const denied = await rt.registry.dispatch(cellCall("c1", COUNTER), ctx, undefined, cfg.permissionRules, cfg.approval, () => {});
    expect(denied).toEqual({ ok: false, output: "Permission denied by user" });
    expect(reasons).toHaveLength(1); // the human approver WAS consulted (execpolicy delegates non-bash tools)
    expect(reasons[0]).toContain("shell.exec");

    // allow verdict: executes for real — counter at 1 proves the denied dispatch never ran the cell
    const approved = await rt.registry.dispatch(cellCall("c2", COUNTER), ctx, undefined, cfg.permissionRules, cfg.approval, () => {});
    expect(approved).toEqual({ ok: true, output: "=> 1" });
    expect(reasons).toHaveLength(2); // "once" verdicts are never cached: prompted again
  } finally {
    if (saved.flag === undefined) delete process.env[EVAL_CELL_FLAG]; else process.env[EVAL_CELL_FLAG] = saved.flag;
    if (saved.cp === undefined) delete process.env.ROVECODE_NO_CHECKPOINTS; else process.env.ROVECODE_NO_CHECKPOINTS = saved.cp;
    rmSync(cwd, { recursive: true, force: true });
  }
});
