/**
 * PORT #18 — persistent eval cell (feature-flagged, ROVECODE_EVAL_CELL=1).
 *
 * Bar coverage, each test discriminating (fails if the property is faked):
 *   - flag OFF ⇒ tool ABSENT from the registry (unknown-tool dispatch), not erroring;
 *   - state persists across calls within a session, NOT across sessions;
 *   - stdout + trailing-expression value captured; explicit output byte budget;
 *   - kind "execute" ⇒ action shell.exec ⇒ deny-default / prompt-gated (ADR-005),
 *     proven by a cell-side counter that only advances when execution really happens;
 *   - lifecycle: timeout/reset destroy the worker and its state;
 *   - background crash (round 2 MED-1): a worker "error" with no call in flight is
 *     reported as a crash note on the NEXT call, never a silently-fresh cell;
 *   - unref is load-bearing (round 2 MED-2): an idle cell timer must not pin the
 *     HOST process open — proven by a subprocess that must exit on its own;
 *   - exact byte-budget boundary (round 2 mutant M6): == budget passes untouched;
 *   - ouroboros: bootstrap internals stay sealed and nothing host-side is
 *     PRE-EXPOSED on the cell's globals (a non-exposure claim, NOT unreachability).
 */

import { test, expect, afterAll } from "bun:test";
import {
  createEvalCellTool, disposeEvalCells, truncateToBudget, EVAL_CELL_FLAG,
} from "../../src/tools/evalcell.ts";
import { ToolRegistry } from "../../src/core/tools.ts";
import type { PermissionRule, Tool, ToolContext, ToolCallPart } from "../../src/core/types.ts";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const ON = { [EVAL_CELL_FLAG]: "1" };

function ctx(sessionId: string): ToolContext {
  return { sessionId, cwd: process.cwd(), signal: new AbortController().signal, permissions: { effect: "allow" } };
}

/** Registry built the way the runtime wires it: register only what the factory returns. */
function buildRegistry(env: Record<string, string | undefined>): ToolRegistry {
  const reg = new ToolRegistry();
  const cell = createEvalCellTool(env);
  if (cell) reg.register(cell);
  return reg;
}

function call(id: string, code: string): ToolCallPart {
  return { kind: "tool_call", id, tool: "eval_cell", args: { code } };
}

afterAll(async () => { await disposeEvalCells(); });

// ---------- flag gate: OFF by default, UNREGISTERED when off ----------

test("factory returns null unless ROVECODE_EVAL_CELL is exactly '1'", () => {
  expect(createEvalCellTool({})).toBeNull();
  expect(createEvalCellTool({ [EVAL_CELL_FLAG]: "0" })).toBeNull();
  expect(createEvalCellTool({ [EVAL_CELL_FLAG]: "true" })).toBeNull(); // strict opt-in, not truthiness
  expect(createEvalCellTool(ON)).not.toBeNull();
});

test("flag off ⇒ absent from the registry: dispatch fails as unknown tool, not as a gated tool", async () => {
  const off = buildRegistry({});
  expect(off.list().map((t) => t.schema.name)).not.toContain("eval_cell");
  const out = await off.dispatch(
    call("c1", "1 + 1"), ctx("p18-off"), undefined,
    [{ action: "*", resource: "*", effect: "allow" }], undefined, () => {},
  );
  expect(out.ok).toBe(false);
  expect(out.output).toContain("unknown tool 'eval_cell'"); // absence, not a permission/flag error

  // control: flag on ⇒ present (proves the off-case tested the flag, not a broken factory)
  expect(buildRegistry(ON).list().map((t) => t.schema.name)).toContain("eval_cell");
});

// ---------- persistence: one worker per session, state survives calls ----------

test("state persists across calls in a session; other sessions see nothing", async () => {
  const tool = createEvalCellTool(ON)!;
  const r1 = await tool.execute({ code: "var acc: number = 40; console.log('side-effect'); acc" }, ctx("p18-a"));
  expect(r1.ok).toBe(true);
  expect(r1.output).toBe("side-effect\n=> 40"); // stdout AND trailing-expression value

  const r2 = await tool.execute({ code: "acc += 2; acc" }, ctx("p18-a"));
  expect(r2.output).toBe("=> 42"); // discriminating: a fresh worker would throw ReferenceError

  const other = await tool.execute({ code: "typeof acc" }, ctx("p18-b"));
  expect(other.output).toBe('=> "undefined"'); // per-session isolation, not one shared realm
});

test("cell errors are reported but do NOT reset the worker", async () => {
  const tool = createEvalCellTool(ON)!;
  await tool.execute({ code: "var kept = 7" }, ctx("p18-err"));
  const boom = await tool.execute({ code: "throw new Error('boom')" }, ctx("p18-err"));
  expect(boom.ok).toBe(false);
  expect(boom.output).toContain("Error: boom");
  const after = await tool.execute({ code: "kept" }, ctx("p18-err"));
  expect(after.output).toBe("=> 7");
});

test("top-level await + bare return run via the async-IIFE retry (transpile-stage regression)", async () => {
  const tool = createEvalCellTool(ON)!;
  // bare `return` is a BuildMessage error at TRANSPILE time (cells parse as modules);
  // the wrapped-retry must cover that stage, not just eval's SyntaxError
  const r = await tool.execute({ code: "await Promise.resolve(7); return 7 * 6" }, ctx("p18-async"));
  expect(r.ok).toBe(true);
  expect(r.output).toBe("=> 42");
});

test("no-output cells return the '(no output)' placeholder", async () => {
  const tool = createEvalCellTool(ON)!;
  const r = await tool.execute({ code: "void 0" }, ctx("p18-void"));
  expect(r).toEqual({ ok: true, output: "(no output)" });
});

// ---------- output budget ----------

test("output is truncated to the explicit byte budget, with a marker", async () => {
  const tool = createEvalCellTool(ON)!;
  const code = "console.log('x'.repeat(5000))";
  const r = await tool.execute({ code, max_output_bytes: 256 }, ctx("p18-trunc"));
  expect(r.ok).toBe(true);
  const [kept = "", marker = ""] = r.output.split("\n");
  expect(kept).toBe("x".repeat(256)); // content capped AT the budget, not merely "shorter"
  expect(marker).toMatch(/^\[output truncated: sent 256 of \d+ bytes\]$/);

  // control: same cell under a big budget is NOT truncated (truncation tracks the arg)
  const big = await tool.execute({ code, max_output_bytes: 65_536 }, ctx("p18-trunc"));
  expect(big.output).toBe("x".repeat(5000));
});

test("truncateToBudget is UTF-8 safe: never emits a torn multibyte sequence", () => {
  const text = "é".repeat(100); // 2 bytes each; budget 5 falls mid-character
  const out = truncateToBudget(text, 5);
  expect(out).toContain("[output truncated: sent 4 of 200 bytes]");
  expect(out).not.toContain("�");
  expect(out.startsWith("éé\n")).toBe(true);
  expect(truncateToBudget("short", 256)).toBe("short"); // under budget: untouched, no marker
});

test("budget boundary is inclusive: exactly-at-budget passes untouched, one byte over truncates (mutant M6)", () => {
  // pins `bytes.length <= budget` — a surviving `<` mutant would truncate the == case
  const exact = "a".repeat(300);
  expect(truncateToBudget(exact, 300)).toBe(exact); // == budget: byte-identical, NO marker
  expect(truncateToBudget("a".repeat(301), 300))
    .toBe("a".repeat(300) + "\n[output truncated: sent 300 of 301 bytes]"); // one byte over
});

// ---------- policy: kind execute ⇒ shell.exec ⇒ deny-default / prompt (ADR-005) ----------

const promptTier: PermissionRule[] = [{ action: "shell.exec", resource: "*", effect: "prompt" }];
// A cell-side counter: it only advances when the cell REALLY executed, so denied
// dispatches are proven unexecuted (not merely error-labelled).
const COUNTER = "globalThis.hits = ((globalThis.hits as number | undefined) ?? 0) + 1; globalThis.hits";

test("deny-default: with no rules the call is denied and the approver is never consulted", async () => {
  const reg = buildRegistry(ON);
  let prompts = 0;
  const out = await reg.dispatch(
    call("c1", COUNTER), ctx("p18-deny"), undefined, [],
    async () => { prompts++; return "once"; }, () => {},
  );
  expect(out.ok).toBe(false);
  expect(out.output).toBe("Permission denied: no rule allows shell.exec");
  expect(prompts).toBe(0); // deny short-circuits BEFORE approval (pipeline order)
});

test("prompt-gated by default: only the shell.exec prompt rule reaches eval_cell, and a deny verdict blocks execution", async () => {
  const reg = buildRegistry(ON);
  const tool = reg.list().find((t: Tool) => t.schema.name === "eval_cell")!;
  expect(tool.kind).toBe("execute"); // the mapping under test: execute ⇒ action shell.exec

  const prompts: string[] = [];
  const approve = (verdict: "once" | "deny") => async (req: { reason: string }) => {
    prompts.push(req.reason);
    return verdict;
  };

  const denied = await reg.dispatch(call("c1", COUNTER), ctx("p18-gate"), undefined, promptTier, approve("deny"), () => {});
  expect(denied).toEqual({ ok: false, output: "Permission denied by user" });
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toContain("shell.exec"); // matched via the execute→shell.exec action, not a tool.* rule

  const approved = await reg.dispatch(call("c2", COUNTER), ctx("p18-gate"), undefined, promptTier, approve("once"), () => {});
  expect(approved.ok).toBe(true);
  expect(approved.output).toBe("=> 1"); // counter at 1: the DENIED dispatch never ran the cell
  expect(prompts).toHaveLength(2);
});

// ---------- lifecycle: destructive cancellation + explicit reset ----------

test("timeout kills the worker and resets session state", async () => {
  const tool = createEvalCellTool(ON)!;
  await tool.execute({ code: "var alive = true" }, ctx("p18-t"));
  const t = await tool.execute({ code: "while (true) {}", timeout_ms: 300 }, ctx("p18-t"));
  expect(t.ok).toBe(false);
  expect(t.output).toContain("timed out after 300ms");
  expect(t.output).toContain("cell state was reset");
  const after = await tool.execute({ code: "typeof alive" }, ctx("p18-t"));
  expect(after.output).toBe('=> "undefined"'); // a survived worker would say "boolean"
});

test("reset: true discards prior state before running", async () => {
  const tool = createEvalCellTool(ON)!;
  await tool.execute({ code: "var stale = 1" }, ctx("p18-r"));
  const r = await tool.execute({ code: "typeof stale", reset: true }, ctx("p18-r"));
  expect(r.output).toBe('=> "undefined"');
});

test("background crash with NO call in flight is reported as a note on the next call, not a silently fresh cell (round 2 MED-1)", async () => {
  const tool = createEvalCellTool(ON)!;
  // arm a delayed throw: the call itself succeeds, the worker dies later, idle
  const armed = await tool.execute(
    { code: "var pre = 1; setTimeout(() => { throw new Error('bg-boom') }, 10); 'armed'" }, ctx("p18-crash"),
  );
  expect(armed).toEqual({ ok: true, output: '=> "armed"' });
  await new Promise((r) => setTimeout(r, 750)); // let the timer throw and the "error" event land
  const next = await tool.execute({ code: "typeof pre" }, ctx("p18-crash"));
  expect(next.ok).toBe(true); // the note rides on a normal, still-executed call
  expect(next.output).toStartWith("note: previous cell worker crashed (");
  expect(next.output).toContain("bg-boom"); // the parked reason survives to the report
  expect(next.output).toContain('); state was reset\n=> "undefined"'); // fresh state, EXPLAINED
  // consumed exactly once: the note does not haunt later calls
  const clean = await tool.execute({ code: "1 + 1" }, ctx("p18-crash"));
  expect(clean).toEqual({ ok: true, output: "=> 2" });
});

test("unref is load-bearing: an idle cell timer must not hold the HOST process open (round 2 MED-2)", async () => {
  // Deleting the worker.unref() call leaves every in-process test green while the
  // host hangs forever on exit — so the proof is a SUBPROCESS that must exit alone.
  const dir = mkdtempSync(join(tmpdir(), "rovecode-evalcell-unref-"));
  const script = join(dir, "unref-probe.ts");
  const evalcellUrl = pathToFileURL(join(import.meta.dir, "..", "..", "src", "tools", "evalcell.ts")).href;
  writeFileSync(script, [
    `import { createEvalCellTool } from ${JSON.stringify(evalcellUrl)};`,
    `const tool = createEvalCellTool({ ROVECODE_EVAL_CELL: "1" })!;`,
    `const out = await tool.execute(`,
    `  { code: "setInterval(() => {}, 1000); 'armed'" },`,
    `  { sessionId: "unref-probe", cwd: process.cwd(), signal: new AbortController().signal, permissions: { effect: "allow" } },`,
    `);`,
    `console.log(JSON.stringify(out));`,
    `// deliberately NO disposeEvalCells(): only worker.unref() lets this process exit`,
  ].join("\n"));
  try {
    const t0 = Date.now();
    const proc = Bun.spawn([process.execPath, "run", script], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    let guard: ReturnType<typeof setTimeout> | undefined;
    const hang = new Promise<"hang">((res) => { guard = setTimeout(() => res("hang"), 8_000); });
    const outcome = await Promise.race([proc.exited, hang]);
    clearTimeout(guard);
    if (outcome === "hang") { proc.kill(); await proc.exited; }
    const elapsed = Date.now() - t0;
    expect(outcome).toBe(0); // exited by itself, exit code 0 — "hang" means unref is gone
    expect(elapsed).toBeLessThan(3000); // promptly, not after some interval-driven stall
    // not vacuous: the cell really ran and armed the interval before the host ended
    expect(await new Response(proc.stdout).text()).toContain('"output":"=> \\"armed\\""');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 15_000);

// ---------- ouroboros: nothing host-side is PRE-EXPOSED inside the cell ----------
// These tests certify the NARROW claim the header makes: no bootstrap internal leaks
// and no host object is handed to the worker's global scope. They do NOT (and could
// not) prove src/** unreachable — cell code can still `await import()` or Bun.file-
// read any file on disk, exactly like the bash tool can run `bun -e`; the execute-
// kind policy gate is the control for that, not the worker boundary.

test("cell code cannot reach bootstrap internals or any rovecode/gauntlet host state", async () => {
  const tool = createEvalCellTool(ON)!;
  // bootstrap closure must not leak: capture buffer, transpiler, caps are unreachable
  const closure = await tool.execute(
    { code: "[typeof transpiler, typeof buf, typeof capture, typeof MAX_CAPTURE].join()" },
    ctx("p18-ouro"),
  );
  expect(closure.output).toBe('=> "undefined,undefined,undefined,undefined"');
  // and no host handle was parked on the worker's globalThis under an rovecode/gauntlet
  // name — the weaker "not pre-exposed" property, per the section note above
  // (NB: /registry/ would false-positive on the builtin FinalizationRegistry)
  const globals = await tool.execute(
    { code: "JSON.stringify(Object.getOwnPropertyNames(globalThis).filter((k) => /rovecode|gauntlet|grader/i.test(k)))" },
    ctx("p18-ouro"),
  );
  expect(globals.output).toBe('=> "[]"');
});

// ---------- argument validation ----------

test("missing or empty code is a typed failure, not a throw", async () => {
  const tool = createEvalCellTool(ON)!;
  expect((await tool.execute({}, ctx("p18-v"))).ok).toBe(false);
  expect((await tool.execute({ code: "   " }, ctx("p18-v"))).ok).toBe(false);
});
