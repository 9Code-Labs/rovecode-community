/** Reflection loop (port #28) unit tests: the built-in hook set's logic in isolation — one nudge per
 *  failed edit/write with the actionable text, a second for a DIFFERENT failure, the per-run cap,
 *  identical-consecutive dedupe (with and without the loop guard's warn suffix), no nudge for aborted
 *  results / non-mutating tools / clean successes, the LSP diagnostics path (against the REAL gate
 *  formatter), pre_run reset + run-boundary sweep, the env knobs, and the runtime registration door
 *  (ROVECODE_HOME pinned to a temp dir: the developer's real ~/.rovecode/hooks.* must never load here). */

import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { SessionStore } from "../../src/core/session.ts";
import {
  createReflectionHooks, reflectionEnabled, reflectionMax, diagnosticsOf,
  DEFAULT_REFLECTION_MAX, REFLECTION_PREFIX, REFLECTION_ERROR_CHARS, REFLECTION_DIAG_CHARS,
} from "../../src/core/reflection.ts";
import { SteeringQueue } from "../../src/core/loop.ts";
import { HookRunner, type HookCtx } from "../../src/core/hooks.ts";
import { ABORTED_TOOL_RESULT } from "../../src/core/tools.ts";
import { formatGateNote, type Diagnostic } from "../../src/coding/lsp.ts";
import { createRuntime } from "../../src/cli/runtime.ts";

const ctx: HookCtx = { cwd: "/w", sessionId: "s1", runId: "run-A" };
/** hashline's actionable rejection (describeEditFailure shape) */
const REJECTED = 'Edit rejected: anchor mismatch at /w/f.txt:2 — line 2 now reads "beta" (hash 1ab), your anchor expected hash zzz. No line in the file has that hash now — the content changed since your read. Remedy: re-read the file with `read` to get fresh line hashes, then retry the edit.';
const RETRY = "Re-read the file, fix the anchors/content, and retry; if it cannot be fixed, say why and stop.";
const call = (tool: string, id = "c1") => ({ id, tool, args: { path: "f.txt" } });
const fail = (output: string) => ({ ok: false, output });
const ok = (output: string) => ({ ok: true, output });
const diag = (line: number, message: string, severity = 1): Diagnostic =>
  ({ range: { start: { line, character: 4 }, end: { line, character: 9 } }, severity, message });

function rig(over: { max?: number } = {}) {
  const steering = new SteeringQueue();
  const nudges: string[] = [];
  const set = createReflectionHooks({ steering, onNudge: (t) => nudges.push(t), ...over });
  const post = (tool: string, out: { ok: boolean; output: string }, c: HookCtx = ctx) => set.post_tool!(c, call(tool), out);
  return { steering, nudges, set, post };
}

test("a failed edit → exactly ONE steering push: the actionable error (first 300 chars) + the retry instruction; the hook returns void (the tool output is not altered)", () => {
  const r = rig();
  expect(r.post("edit", fail(REJECTED))).toBeUndefined();
  expect(r.steering.size).toBe(1);
  const [nudge] = r.steering.drainAll();
  expect(nudge).toBe(`${REFLECTION_PREFIX}the edit call failed — ${REJECTED.slice(0, -1)}. ${RETRY}`);
  expect(r.nudges).toEqual([nudge!]);
  // the excerpt is bounded: a long error contributes its first REFLECTION_ERROR_CHARS chars only
  const long = "Edit applied but lint failed — " + "e".repeat(1000) + " TAIL-MARKER";
  r.post("edit", fail(long));
  const [second] = r.steering.drainAll();
  expect(second).toContain(long.slice(0, REFLECTION_ERROR_CHARS - 1) + "…");
  expect(second).not.toContain("TAIL-MARKER");
  expect(second!.endsWith(RETRY)).toBe(true);
  // a failed write nudges with its own tool name
  const w = rig();
  w.post("write", fail("Write rejected: directory /w/missing does not exist — create it first."));
  expect(w.nudges[0]!.startsWith(`${REFLECTION_PREFIX}the write call failed — Write rejected: directory /w/missing does not exist`)).toBe(true);
});

test("a second, DIFFERENT failure → a second push; the third → capped (default 2, DEFAULT_REFLECTION_MAX); an explicit max applies", () => {
  expect(DEFAULT_REFLECTION_MAX).toBe(2);
  const r = rig();
  r.post("edit", fail("Edit rejected: failure A"));
  r.post("edit", fail("Edit rejected: failure B"));
  r.post("write", fail("Write rejected: failure C"));
  r.post("edit", fail("Edit rejected: failure D"));
  expect(r.nudges.length).toBe(2);
  expect(r.nudges[0]).toContain("failure A");
  expect(r.nudges[1]).toContain("failure B");
  expect(r.steering.size).toBe(2);
  const three = rig({ max: 3 });
  for (const t of ["A", "B", "C", "D", "E"]) three.post("edit", fail(`Edit rejected: ${t}`));
  expect(three.nudges.length).toBe(3);
  const silent = rig({ max: 0 }); // attached but silent
  silent.post("edit", fail("Edit rejected: nope"));
  expect(silent.nudges).toEqual([]);
});

test("identical consecutive failure → not re-pushed; the loop guard's warn suffix does not make it 'different'; a clean success in between makes the next identical failure new again", () => {
  const r = rig({ max: 5 });
  const X = "Edit rejected: anchor mismatch at /w/f.txt:2 — same thing";
  r.post("edit", fail(X));
  r.post("edit", fail(X));
  r.post("edit", fail(`${X}\n\n[loop-guard] [rovecode loop guard: this is the 3rd consecutive call to edit with identical arguments. This looks like a loop — change arguments, use a different tool, or proceed with what you have.]`));
  r.post("edit", fail(`${X}\n\n[loop-guard] [rovecode loop guard: this is the 4th consecutive call to edit with identical arguments. …]`));
  expect(r.nudges.length).toBe(1);
  r.post("edit", ok("applied 1 edit(s); new TAG abcd")); // clean success ends the streak
  r.post("edit", fail(X));
  expect(r.nudges.length).toBe(2);
  // a different tool with the same text is a different failure
  r.post("write", fail(X));
  expect(r.nudges.length).toBe(3);
});

test("aborted results never nudge; non-mutating tools never nudge, even when they fail", () => {
  const r = rig();
  r.post("edit", fail(ABORTED_TOOL_RESULT));
  r.post("write", fail(ABORTED_TOOL_RESULT));
  r.post("edit", fail(`${ABORTED_TOOL_RESULT}\n\n[loop-guard] note`));
  for (const t of ["read", "bash", "grep", "glob", "ls", "web_fetch", "task", "memory_edit", "todo_write"]) r.post(t, fail("Error: it broke"));
  for (const t of ["read", "bash"]) r.post(t, ok("fine\n\nlsp-gate (typescript-language-server): 1 error(s) in /w/a.ts — fix before proceeding:\nERROR [1:1] x"));
  expect(r.nudges).toEqual([]);
  expect(r.steering.size).toBe(0);
  // the watched set is configurable
  const custom = rig();
  const set = createReflectionHooks({ steering: custom.steering, tools: ["apply_patch"], onNudge: (t) => custom.nudges.push(t) });
  set.post_tool!(ctx, call("edit"), fail("Edit rejected: x"));
  set.post_tool!(ctx, call("apply_patch"), fail("patch failed: hunk 1 did not apply"));
  expect(custom.nudges.length).toBe(1);
  expect(custom.nudges[0]).toContain("the apply_patch call failed — patch failed: hunk 1 did not apply");
});

test("LSP diagnostics on a SUCCESSFUL edit → one 'introduced diagnostics' nudge with the bounded list (real formatGateNote output); a clean success → none; the same diagnostics twice → deduped", () => {
  const note = formatGateNote("/w/a.ts", [diag(2, "Cannot find name 'foo'."), diag(5, "unused variable", 2)]); // the warning never reaches the note
  expect(note.startsWith("\n\nlsp-gate (typescript-language-server): 1 error(s) in /w/a.ts")).toBe(true);
  const r = rig();
  r.post("edit", ok("applied 1 edit(s); new TAG 1234" + note));
  expect(r.nudges).toEqual([`${REFLECTION_PREFIX}the edit introduced diagnostics — ERROR [3:5] Cannot find name 'foo'. Fix them or explain.`]);
  r.post("edit", ok("applied 1 edit(s); new TAG 1234" + note)); // identical diagnostics → no second nudge
  expect(r.nudges.length).toBe(1);
  r.post("edit", ok("applied 1 edit(s); new TAG 5678")); // clean
  r.post("write", ok("wrote /w/b.ts (12 bytes, TAG 9abc)"));
  expect(r.nudges.length).toBe(1);
  r.post("write", ok("wrote /w/b.ts (12 bytes, TAG 9abc)" + formatGateNote("/w/b.ts", [diag(0, "';' expected.")], "tsserver")));
  expect(r.nudges[1]).toBe(`${REFLECTION_PREFIX}the write introduced diagnostics — ERROR [1:5] ';' expected. Fix them or explain.`);
  // detection contract with coding/lsp.ts: the real note is recognised and bounded; no note / warnings-only → null
  expect(diagnosticsOf("applied 1 edit(s); new TAG 1234")).toBeNull();
  expect(diagnosticsOf("applied" + formatGateNote("/w/a.ts", [diag(1, "warn", 2)]))).toBeNull();
  const many = formatGateNote("/w/a.ts", Array.from({ length: 30 }, (_, i) => diag(i, `e${i} ${"m".repeat(40)}`)));
  const d = diagnosticsOf("applied 1 edit(s); new TAG 1234" + many)!;
  expect(d.startsWith("ERROR [1:5] e0 ")).toBe(true);
  expect(d).toContain("… and 16 more"); // 20 shown + the formatter's "... and 10 more" line = 21 lines, 5 carried
  expect(d.length).toBeLessThanOrEqual(REFLECTION_DIAG_CHARS);
});

test("pre_run resets the per-run counter (and a fresh runId starts fresh); post_run / pre_run sweep OUR undrained nudges out of the queue but preserve other steering messages", () => {
  const r = rig();
  r.post("edit", fail("Edit rejected: A"));
  r.post("edit", fail("Edit rejected: B"));
  r.post("edit", fail("Edit rejected: C")); // capped
  expect(r.nudges.length).toBe(2);
  expect(r.steering.size).toBe(2); // never drained (as if the run ended right here)
  r.set.pre_run!({ ...ctx, runId: "run-B" });
  expect(r.steering.size).toBe(0); // swept at the next run's start
  r.post("edit", fail("Edit rejected: A"), { ...ctx, runId: "run-B" });
  r.post("edit", fail("Edit rejected: B"), { ...ctx, runId: "run-B" });
  r.post("edit", fail("Edit rejected: C"), { ...ctx, runId: "run-B" });
  expect(r.nudges.length).toBe(4); // two more, capped again
  // a task note that lands after the last drain must survive the sweep, in order
  r.steering.push("task t1 (compute) finished: CHILD-RESULT");
  expect(r.steering.size).toBe(3);
  r.set.post_run!({ ...ctx, runId: "run-B" }, { status: "budget", summary: "max turns (1) reached" });
  expect(r.steering.drainAll()).toEqual(["task t1 (compute) finished: CHILD-RESULT"]);
  // the SAME runId without a pre_run stays capped; an unseen runId is fresh (lazy state)
  r.post("edit", fail("Edit rejected: D"), { ...ctx, runId: "run-A" });
  expect(r.nudges.length).toBe(4);
  r.post("edit", fail("Edit rejected: D"), { ...ctx, runId: "run-C" });
  expect(r.nudges.length).toBe(5);
  // no runId (bare dispatch) still works
  r.post("edit", fail("Edit rejected: E"), { cwd: "/w", sessionId: "s1" });
  expect(r.nudges.length).toBe(6);
});

test("ownership (#26 MED-A): with `owns`, a run the set does not own gets no nudge and its pre_run/post_run sweep nothing (the owner's pending nudge survives a foreign run boundary); owned runs behave as before and keep their own cap", () => {
  const steering = new SteeringQueue();
  const nudges: string[] = [];
  const set = createReflectionHooks({ steering, onNudge: (t) => nudges.push(t), owns: (c) => c.sessionId === "parent" });
  const child: HookCtx = { cwd: "/w", sessionId: "child-store", runId: "child-run" };
  const parent: HookCtx = { cwd: "/w", sessionId: "parent", runId: "parent-run" };
  set.pre_run!(child);
  set.post_tool!(child, call("edit"), fail("Edit rejected: file not found: /w/does-not-exist.txt — check the path"));
  expect(nudges).toEqual([]); expect(steering.size).toBe(0); // MUTATION TARGET: drop the owns check in post_tool → 1
  set.post_tool!(parent, call("edit"), fail(REJECTED));
  expect(nudges.length).toBe(1); expect(steering.size).toBe(1);
  set.post_run!(child, { status: "done", summary: "" }); // a child's run boundary must not sweep the parent's pending nudge
  set.pre_run!({ ...child, runId: "child-run-2" });
  expect(steering.size).toBe(1); // MUTATION TARGET: drop the owns check in post_run / pre_run → 0
  set.post_run!(parent, { status: "budget", summary: "" });
  expect(steering.size).toBe(0); // the owner's own boundary still sweeps
  set.pre_run!({ ...parent, runId: "p2" });
  for (const t of ["A", "B", "C"]) set.post_tool!({ ...parent, runId: "p2" }, call("edit"), fail(`Edit rejected: ${t}`));
  expect(nudges.length).toBe(3); // the cap (2) applies per owned run; the child's failures consumed nothing
  const dflt = createReflectionHooks({ steering: new SteeringQueue(), onNudge: (t) => nudges.push(t) }); // no owns: every run is served
  dflt.post_tool!(child, call("edit"), fail("Edit rejected: x"));
  expect(nudges.length).toBe(4);
});

test("runtime door (#26 MED-A): the built-in set owns the ACTIVE session store's runs only — a child-shaped ctx (another store id, the same hooks) lands nothing and sweeps nothing; setSessionStore re-points ownership (TUI session switch)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-refl-own-"));
  const home = mkdtempSync(join(tmpdir(), "rovecode-refl-ownhome-"));
  const savedHome = process.env.ROVECODE_HOME, savedRefl = process.env.ROVECODE_REFLECTION;
  process.env.ROVECODE_HOME = home;
  delete process.env.ROVECODE_REFLECTION;
  try {
    const rt = createRuntime({ cwd, stream: null });
    await rt.hooks.ready;
    await rt.hooks.run("post_tool", { cwd, sessionId: `child-${randomUUID()}`, runId: "c1" }, call("edit"), fail(REJECTED));
    expect(rt.steering.size).toBe(0); // MUTATION TARGET: `owns` not wired in runtime.ts → 1
    await rt.hooks.run("post_tool", { cwd, sessionId: rt.sessionId, runId: "r1" }, call("edit"), fail(REJECTED));
    expect(rt.steering.size).toBe(1);
    await rt.hooks.run("post_run", { cwd, sessionId: `child-${randomUUID()}`, runId: "c1" }, { status: "done", summary: "" });
    expect(rt.steering.size).toBe(1); // a child's boundary sweeps nothing
    await rt.hooks.run("post_run", { cwd, sessionId: rt.sessionId, runId: "r1" }, { status: "budget", summary: "" });
    expect(rt.steering.size).toBe(0);
    const other = new SessionStore(join(cwd, ".rovecode", "sessions"), randomUUID());
    rt.setSessionStore(other);
    await rt.hooks.run("post_tool", { cwd, sessionId: other.id, runId: "r2" }, call("edit"), fail(REJECTED));
    expect(rt.steering.size).toBe(1); // the switched-to session owns the queue now…
    await rt.hooks.run("post_tool", { cwd, sessionId: rt.sessionId, runId: "r3" }, call("edit"), fail("Edit rejected: other"));
    expect(rt.steering.size).toBe(1); // …and the boot session no longer does
    expect(rt.hooks.warnings).toEqual([]);
    await rt.hooks.close();
    await rt.mcp?.close();
  } finally {
    if (savedHome === undefined) delete process.env.ROVECODE_HOME; else process.env.ROVECODE_HOME = savedHome;
    if (savedRefl === undefined) delete process.env.ROVECODE_REFLECTION; else process.env.ROVECODE_REFLECTION = savedRefl;
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("through a HookRunner: the set runs as a post_tool hook with no decision and no warnings; pre_run/post_run are void", async () => {
  const steering = new SteeringQueue();
  const runner = new HookRunner({ cwd: "/w", sessionId: "s1" }, { timeoutMs: 1000 });
  runner.add(createReflectionHooks({ steering }), "reflection");
  expect(runner.has("post_tool")).toBe(true);
  expect(runner.has("pre_run")).toBe(true);
  expect(runner.has("post_run")).toBe(true);
  expect(runner.has("pre_tool")).toBe(false);
  expect(await runner.run("pre_run", ctx)).toBeUndefined();
  expect(await runner.run("post_tool", ctx, call("edit"), fail(REJECTED))).toBeUndefined(); // the output stays the tool's
  expect(steering.size).toBe(1);
  expect(await runner.run("post_run", ctx, { status: "done", summary: "ok" })).toBeUndefined();
  expect(steering.size).toBe(0); // swept
  expect(runner.warnings).toEqual([]);
});

test("env knobs: ROVECODE_REFLECTION=0 disables; ROVECODE_REFLECTION_MAX parses a non-negative integer, blank/invalid/negative fall back to 2; createReflectionHooks reads it when no max is given", () => {
  expect(reflectionEnabled({})).toBe(true);
  expect(reflectionEnabled({ ROVECODE_REFLECTION: "1" })).toBe(true);
  expect(reflectionEnabled({ ROVECODE_REFLECTION: "0" })).toBe(false);
  expect(reflectionMax({})).toBe(2);
  expect(reflectionMax({ ROVECODE_REFLECTION_MAX: "" })).toBe(2);
  expect(reflectionMax({ ROVECODE_REFLECTION_MAX: "abc" })).toBe(2);
  expect(reflectionMax({ ROVECODE_REFLECTION_MAX: "-1" })).toBe(2);
  expect(reflectionMax({ ROVECODE_REFLECTION_MAX: "0" })).toBe(0);
  expect(reflectionMax({ ROVECODE_REFLECTION_MAX: "3.7" })).toBe(3);
  const saved = process.env.ROVECODE_REFLECTION_MAX;
  process.env.ROVECODE_REFLECTION_MAX = "1";
  try {
    const r = rig();
    r.post("edit", fail("Edit rejected: A"));
    r.post("edit", fail("Edit rejected: B"));
    expect(r.nudges.length).toBe(1);
  } finally {
    if (saved === undefined) delete process.env.ROVECODE_REFLECTION_MAX; else process.env.ROVECODE_REFLECTION_MAX = saved;
  }
});

test("runtime door: createRuntime attaches the built-in set once (a failed edit through rt.hooks lands in rt.steering); ROVECODE_REFLECTION=0 → not attached", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-refl-rt-"));
  const home = mkdtempSync(join(tmpdir(), "rovecode-refl-rthome-"));
  const savedHome = process.env.ROVECODE_HOME, savedRefl = process.env.ROVECODE_REFLECTION;
  process.env.ROVECODE_HOME = home; // hermetic user scope
  delete process.env.ROVECODE_REFLECTION;
  try {
    const rt = createRuntime({ cwd, stream: null });
    await rt.hooks.ready;
    expect(rt.hooks.size).toBe(1);
    expect(rt.hooks.has("post_tool")).toBe(true);
    expect(rt.hooks.has("pre_run")).toBe(true);
    expect(rt.hooks.has("post_run")).toBe(true);
    expect(rt.hooks.has("pre_tool")).toBe(false);
    await rt.hooks.run("post_tool", { cwd, sessionId: rt.sessionId, runId: "r1" }, call("edit"), fail(REJECTED));
    expect(rt.steering.drainAll().map((s) => s.startsWith(`${REFLECTION_PREFIX}the edit call failed — Edit rejected:`))).toEqual([true]);
    expect(rt.hooks.warnings).toEqual([]);
    await rt.hooks.close();
    await rt.mcp?.close();
    process.env.ROVECODE_REFLECTION = "0";
    const off = createRuntime({ cwd, stream: null });
    await off.hooks.ready;
    expect(off.hooks.size).toBe(0);
    expect(off.hooks.has("post_tool")).toBe(false);
    await off.hooks.run("post_tool", { cwd, sessionId: off.sessionId, runId: "r1" }, call("edit"), fail(REJECTED));
    expect(off.steering.size).toBe(0);
    await off.hooks.close();
    await off.mcp?.close();
  } finally {
    if (savedHome === undefined) delete process.env.ROVECODE_HOME; else process.env.ROVECODE_HOME = savedHome;
    if (savedRefl === undefined) delete process.env.ROVECODE_REFLECTION; else process.env.ROVECODE_REFLECTION = savedRefl;
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
