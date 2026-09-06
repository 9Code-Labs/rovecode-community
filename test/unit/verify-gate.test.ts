/** The verify gate (core/verify-gate.ts + the loop's "done" exit). Pinned, in the contract's order:
 *   1. runs ONLY when the run wrote files — a question answered, a file read: nothing runs, run_end byte-identical;
 *   2. never a guessed command: no resolution → nothing runs, run_end says "not verified: no check configured";
 *   3. bounded: its own timeout (a timed-out check is a FAILED check), output reduced to the failing part;
 *   4. ONE retry: the failing part goes back once; still failing → status "done" (not "error") with the failure on run_end,
 *      and a model that answers with prose (no new write) does not trigger a second two-minute run;
 *   5. the retry is a turn: a spent --max-turns ends "budget";
 *   6. OFF by default (measured: the projects edited here have no check to run); ROVECODE_VERIFY=1 is the way in, and
 *      plan mode removes it (applyModeToRun) — no `verify` on the config means nothing runs and nothing is added;
 *   7. composes with the finish check on ONE flag: whichever fires first takes the run's extra turn. */

import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { agentLoop, outstandingClause, outstandingTone, SteeringQueue } from "../../src/core/loop.ts";
import { SessionStore } from "../../src/core/session.ts";
import { ToolRegistry } from "../../src/core/tools.ts";
import { ModeManager } from "../../src/core/modes.ts";
import { applyModeToRun } from "../../src/tui/modes-cmd.ts";
import type { AgentDefinition, AssistantTurn, Message, RunConfig, RunEvent, StreamFn, Tool, VerifyGate } from "../../src/core/types.ts";
import { textTurn, toolTurn } from "../../src/providers/stream.ts";
import { createRuntime } from "../../src/cli/runtime.ts";
import { failingPart, runVerify, verifyNudgeText, verifyClause, type Exec, type VerifyOutcome } from "../../src/core/verify-gate.ts";

const dirs: string[] = [];
function tmp(prefix = "rovecode-verify-"): string { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; }
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
afterEach(() => { delete process.env.ROVECODE_VERIFY; delete process.env.ROVECODE_VERIFY_TIMEOUT; });

// ---------- failingPart: the failing part, never the log ----------
test("failingPart: the last 40 lines, preceded by earlier lines that name a failure, clipped from the front", () => {
  const lines = Array.from({ length: 200 }, (_, i) => `line ${i} ok`);
  lines[10] = "✗ math > adds: expected 4, received 5";
  lines[50] = "error: expect(received).toBe(expected)";
  const out = failingPart(lines.join("\n"));
  const got = out.split("\n");
  expect(got[0]).toBe("✗ math > adds: expected 4, received 5");
  expect(got[1]).toBe("error: expect(received).toBe(expected)");
  expect(got[2]).toBe("…");
  expect(got.at(-1)).toBe("line 199 ok");
  expect(got.length).toBe(3 + 40);
  // a clip keeps the END (test runners summarize there) and says how much went
  const big = failingPart(Array.from({ length: 40 }, (_, i) => `${"x".repeat(200)} ${i}`).join("\n"), 1_000);
  expect(big.startsWith("[… ")).toBe(true);
  expect(big.endsWith(" 39")).toBe(true);
  expect(big.length).toBeLessThan(1_100);
  // short output passes through whole; trailing blank lines dropped; CRLF normalised
  expect(failingPart("ok\r\nfine\r\n\r\n")).toBe("ok\nfine");
  // more than 20 earlier failure lines are counted, not dumped
  const many = Array.from({ length: 100 }, (_, i) => (i < 50 ? `FAIL case ${i}` : `tail ${i}`)).join("\n");
  expect(failingPart(many)).toContain("… 30 more lines naming a failure");
});

// ---------- runVerify: bounded, in order, honest about timeouts ----------
const exec = (script: Record<string, { code: number; text: string } | "hang">): { exec: Exec; calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    exec: async (cmd, _cwd, signal) => {
      calls.push(cmd);
      const r = script[cmd];
      if (r === undefined) throw new Error(`unexpected command ${cmd}`);
      if (r === "hang") return new Promise((resolve) => { signal.addEventListener("abort", () => resolve({ code: 143, text: "partial output\n[output truncated: process tree terminated on abort]" }), { once: true }); });
      return r;
    },
  };
};

test("runVerify: commands run in order and stop at the first failure; the outcome names the failing command and carries the failing part", async () => {
  const { exec: e, calls } = exec({ "bun test": { code: 1, text: "20 pass\n2 fail\nerror: expect(received).toBe(expected)" }, "bunx tsc --noEmit": { code: 0, text: "" } });
  const r = await runVerify({ commands: ["bun test", "bunx tsc --noEmit"] }, "/w", { exec: e, clock: (() => { let t = 0; return () => (t += 500); })() });
  expect(calls).toEqual(["bun test"]);
  expect(r).toMatchObject({ command: "bun test", ok: false, code: 1, timedOut: false, ran: 1 });
  expect(r.failure).toBe("20 pass\n2 fail\nerror: expect(received).toBe(expected)");
  expect(r.ms).toBe(500);
  const ok = await runVerify({ commands: ["bunx tsc --noEmit", "bun test"] }, "/w", { exec: exec({ "bunx tsc --noEmit": { code: 0, text: "" }, "bun test": { code: 0, text: "22 pass" } }).exec });
  expect(ok).toMatchObject({ command: "bun test", ok: true, code: 0, ran: 2, failure: "" });
});

test("runVerify: a check that outlives its timeout is stopped and reported as failed+timedOut, never as passed; an exec that throws is a failure with the message", async () => {
  const r = await runVerify({ commands: ["bun test"] }, "/w", { exec: exec({ "bun test": "hang" }).exec, timeoutMs: 30 });
  expect(r).toMatchObject({ ok: false, timedOut: true, code: 143, ran: 1 });
  expect(r.failure).toContain("partial output");
  const thrown = await runVerify({ commands: ["bun test"] }, "/w", { exec: async () => { throw new Error("no executor rung is configured"); } });
  expect(thrown).toMatchObject({ ok: false, code: -1, timedOut: false });
  expect(thrown.failure).toBe("could not run the check: no executor rung is configured");
  // the run's own abort ends the check too
  const ac = new AbortController();
  const p = runVerify({ commands: ["bun test"] }, "/w", { exec: exec({ "bun test": "hang" }).exec, signal: ac.signal, timeoutMs: 10_000 });
  ac.abort();
  expect(await p).toMatchObject({ ok: false, timedOut: false, code: 143 });
});

test("verifyNudgeText / verifyClause: the message names the command and carries the failing part; the clause is one line", () => {
  const o: VerifyOutcome = { command: "bun test", ok: false, code: 1, timedOut: false, ms: 900, failure: "✗ adds\n 2 fail", ran: 1 };
  const t = verifyNudgeText(o);
  expect(t.startsWith("<verify-check>")).toBe(true);
  expect(t).toContain("The project's check failed (exit 1) after your changes: `bun test`");
  expect(t).toContain("✗ adds\n 2 fail");
  expect(t).toContain("This check runs once per run");
  expect(verifyNudgeText({ ...o, timedOut: true }, 60_000)).toContain("did not finish within 60s");
  expect(verifyClause({ state: "failed", command: "bun test", code: 1, failure: "✗ adds\n 2 fail" })).toBe("check failed (bun test):  2 fail");
  expect(verifyClause({ state: "passed", command: "bun test", ms: 900 })).toBe("check passed (bun test)");
  expect(verifyClause({ state: "timeout", command: "bun test", seconds: 120 })).toBe("check timed out after 120s (bun test)");
  expect(verifyClause({ state: "unconfigured" })).toBe("not verified: no check configured");
  expect(verifyClause({ state: "unconfigured", reason: "no package.json here", refused: ["package.json test: runs deploy"] })).toBe("not verified: no package.json here · 1 check refused (package.json test: runs deploy)");
  expect(verifyClause({ state: "passed", command: "bun test", ms: 1, refused: ["scripts.check: --watch never exits"] })).toBe("check passed (bun test) · 1 check refused (scripts.check: --watch never exits)");
});

// ---------- the loop: a scripted model, a write tool, a fake gate ----------
const WRITE: Tool = { kind: "write", schema: { name: "write", description: "w", args: { type: "object" } }, async execute(args) { const a = args as { path: string }; return a.path.startsWith("bad/") ? { ok: false, output: "ENOENT: bad/ does not exist" } : { ok: true, output: `wrote ${a.path}` }; } };
const NOOP: Tool = { kind: "read", schema: { name: "noop", description: "n", args: { type: "object" } }, async execute() { return { ok: true, output: "ok" }; } };
const def: AgentDefinition = { name: "t", systemPrompt: "test", tools: ["*"] };
const cfg = (over: Partial<RunConfig>): RunConfig => ({ maxTurns: 60, contextBudgetTokens: 100_000, compactionThreshold: 0.8, parallelTools: true, permissionRules: [{ action: "*", resource: "*", effect: "allow" }], ...over });

function scripted(turns: AssistantTurn[]): { stream: StreamFn; lastUser: string[] } {
  const lastUser: string[] = [];
  let n = 0;
  const stream: StreamFn = async function* (_m, messages: Message[]) {
    const u = [...messages].reverse().find((m) => m.role === "user");
    lastUser.push(u?.parts.map((p) => (p.kind === "text" ? p.text : "")).join("") ?? "");
    yield { type: "turn", turn: turns[Math.min(n++, turns.length - 1)]! };
  };
  return { stream, lastUser };
}

/** a gate whose outcomes are scripted in order; records every call and the signal it was handed */
function gate(outcomes: (Partial<VerifyOutcome> | "hang")[], resolution: VerifyGate["resolution"] = { commands: ["bun test"] }): VerifyGate & { calls: number } {
  let i = 0;
  const g = {
    calls: 0, resolution, timeoutMs: 120_000,
    async run(signal: AbortSignal) {
      g.calls++;
      const o = outcomes[Math.min(i++, outcomes.length - 1)] ?? {};
      if (o === "hang") return new Promise<VerifyOutcome>((resolve) => signal.addEventListener("abort", () => resolve({ command: "bun test", ok: false, code: 143, timedOut: false, ms: 1, failure: "", ran: 1 }), { once: true }));
      return { command: "bun test", ok: true, code: 0, timedOut: false, ms: 1200, failure: "", ran: 1, ...o };
    },
  };
  return g;
}
const FAIL = { ok: false, code: 1, failure: "✗ math > adds\n 1 fail" };

async function run(turns: AssistantTurn[], over: Partial<RunConfig> = {}, opts: { signal?: AbortSignal; store?: SessionStore } = {}) {
  const registry = new ToolRegistry(); registry.register(WRITE); registry.register(NOOP);
  const store = opts.store ?? new SessionStore(tmp(), randomUUID());
  const { stream, lastUser } = scripted(turns);
  const events: RunEvent[] = [];
  for await (const ev of agentLoop(def, "fix the math", {}, cfg(over), { stream, registry, store, ...(opts.signal ? { signal: opts.signal } : {}) }, new SteeringQueue())) events.push(ev);
  const end = events.at(-1) as Extract<RunEvent, { type: "run_end" }>;
  expect(end.type).toBe("run_end");
  return { events, lastUser, end, verifyEvents: events.filter((e): e is Extract<RunEvent, { type: "verify" }> => e.type === "verify"), steers: events.filter((e) => e.type === "steer").length };
}
const WRITE_OK = toolTurn([{ id: "w1", tool: "write", args: { path: "src/math.ts", content: "x" } }]);
const WRITE_OK2 = toolTurn([{ id: "w2", tool: "write", args: { path: "src/math.ts", content: "y" } }]);
const DONE = textTurn("Fixed the math.");

test("(1) nothing written → the gate is never consulted and run_end is byte-identical", async () => {
  const g = gate([FAIL]);
  const r = await run([toolTurn([{ id: "n1", tool: "noop", args: {} }]), textTurn("Two servers are configured.")], { verify: g });
  expect(g.calls).toBe(0);
  expect(r.verifyEvents).toEqual([]);
  expect(r.end).toEqual({ type: "run_end", status: "done", summary: "Two servers are configured." });
});

test("(2) nothing configured → nothing runs and run_end says 'not verified: no check configured'; refused commands are named", async () => {
  const g = gate([FAIL], null);
  const r = await run([WRITE_OK, DONE], { verify: g });
  expect(g.calls).toBe(0);
  expect(r.end.outstanding).toEqual({ failed: [], unansweredAsk: false, writes: 1, nudged: false, verify: { state: "unconfigured" } });
  expect(outstandingClause(r.end.outstanding!)).toBe("not verified: no check configured");
  expect(outstandingTone(r.end.outstanding!)).toBe("warn");
  const refused = await run([WRITE_OK, DONE], { verify: gate([FAIL], { commands: [], source: "none", reason: "nothing configured", refused: ["package.json test: runs deploy"] }) });
  expect(refused.end.outstanding?.verify).toEqual({ state: "unconfigured", reason: "nothing configured", refused: ["package.json test: runs deploy"] });
  expect(outstandingClause(refused.end.outstanding!)).toBe("not verified: nothing configured · 1 check refused (package.json test: runs deploy)");
});

test("passing check: running + passed events, run_end carries verify.passed, the clause is informational", async () => {
  const g = gate([{}]);
  const r = await run([WRITE_OK, DONE], { verify: g });
  expect(g.calls).toBe(1);
  expect(r.steers).toBe(0);
  expect(r.verifyEvents).toEqual([{ type: "verify", command: "bun test", state: "running" }, { type: "verify", command: "bun test", state: "passed", ms: 1200, detail: "passed in 1.2s" }]);
  expect(r.end.outstanding).toEqual({ failed: [], unansweredAsk: false, writes: 1, nudged: false, verify: { state: "passed", command: "bun test", ms: 1200 } });
  expect(outstandingClause(r.end.outstanding!)).toBe("check passed (bun test)");
  expect(outstandingTone(r.end.outstanding!)).toBe("info");
});

test("(4) failing check → ONE <verify-check> turn with the failing part; the model writes a fix → the check re-runs and passes", async () => {
  const g = gate([FAIL, {}]);
  const r = await run([WRITE_OK, DONE, WRITE_OK2, textTurn("Fixed for real.")], { verify: g });
  expect(g.calls).toBe(2);
  expect(r.steers).toBe(1);
  expect(r.lastUser.length).toBe(4);
  expect(r.lastUser[2]).toContain("<verify-check>");
  expect(r.lastUser[2]).toContain("`bun test`");
  expect(r.lastUser[2]).toContain("✗ math > adds\n 1 fail");
  expect(r.verifyEvents.map((e) => e.state)).toEqual(["running", "failed", "running", "passed"]);
  expect(r.verifyEvents[1]).toMatchObject({ detail: "exit 1 —  1 fail" });
  expect(r.end.status).toBe("done");
  expect(r.end.outstanding).toEqual({ failed: [], unansweredAsk: false, writes: 2, nudged: true, verify: { state: "passed", command: "bun test", ms: 1200 } });
});

test("(4) still failing after the fix → status done (not error), verify.failed on run_end, no second nudge", async () => {
  const g = gate([FAIL, { ok: false, code: 1, failure: "✗ math > adds\n still 1 fail" }]);
  const r = await run([WRITE_OK, DONE, WRITE_OK2, textTurn("I could not make it pass.")], { verify: g });
  expect(g.calls).toBe(2);
  expect(r.steers).toBe(1);
  expect(r.end.status).toBe("done");
  expect(r.end.summary).toBe("I could not make it pass.");
  expect(r.end.outstanding?.verify).toEqual({ state: "failed", command: "bun test", code: 1, failure: "✗ math > adds\n still 1 fail" });
  expect(outstandingClause(r.end.outstanding!)).toBe("check failed (bun test):  still 1 fail");
});

test("(4) the model answers the failed check with prose and no new write → the check is NOT re-run; its verdict stands on run_end", async () => {
  const g = gate([FAIL]);
  const r = await run([WRITE_OK, DONE, textTurn("The failing test expects the old behaviour; the change is intended.")], { verify: g });
  expect(g.calls).toBe(1);
  expect(r.steers).toBe(1);
  expect(r.end.outstanding).toEqual({ failed: [], unansweredAsk: false, writes: 1, nudged: true, verify: { state: "failed", command: "bun test", code: 1, failure: "✗ math > adds\n 1 fail" } });
});

test("(3) a timed-out check is a failed check: nudged with the timeout wording, represented as verify.timeout", async () => {
  const g = gate([{ ok: false, code: 143, timedOut: true, ms: 120_000, failure: "partial" }]);
  const r = await run([WRITE_OK, DONE, textTurn("It hangs; I do not know why.")], { verify: g });
  expect(r.lastUser[2]).toContain("did not finish within 120s");
  expect(r.verifyEvents[1]).toMatchObject({ state: "timeout", detail: "timed out after 120s" });
  expect(r.end.outstanding?.verify).toEqual({ state: "timeout", command: "bun test", seconds: 120 });
  expect(outstandingClause(r.end.outstanding!)).toBe("check timed out after 120s (bun test)");
});

test("(5) the retry is a turn: --max-turns 2 spent on write+'done' with a failing check ends 'budget', not 'done'", async () => {
  const g = gate([FAIL]);
  const r = await run([WRITE_OK, DONE, WRITE_OK2, DONE], { verify: g, maxTurns: 2 });
  expect(g.calls).toBe(1);                       // the check ran, the nudge was queued, the cap was checked first
  expect(r.steers).toBe(1);
  expect(r.end).toEqual({ type: "run_end", status: "budget", summary: "max turns (2) reached" });
});

test("abort during the check → the run ends 'stopped', no nudge, no verify verdict", async () => {
  const ac = new AbortController();
  const g = gate(["hang"]);
  setTimeout(() => ac.abort(), 20);
  const r = await run([WRITE_OK, DONE], { verify: g }, { signal: ac.signal });
  expect(r.end).toEqual({ type: "run_end", status: "stopped", summary: "run aborted" });
  expect(r.steers).toBe(0);
});

test("(7) composition: the finish check fires first (failed write) and takes the run's one extra turn; the gate then RUNS and represents, but never asks", async () => {
  // write to bad/ fails → "Done" → finish check nudge → model writes src/ ok → "Done" → gate runs, FAILS → no second nudge
  const g = gate([FAIL]);
  const r = await run([toolTurn([{ id: "b1", tool: "write", args: { path: "bad/x.ts", content: "" } }]), textTurn("Done."), WRITE_OK, textTurn("Done, in src/.")], { verify: g });
  expect(r.steers).toBe(1);
  expect(r.lastUser[2]).toContain("<finish-check>");
  expect(g.calls).toBe(1);
  expect(r.lastUser.length).toBe(4);
  expect(r.end.status).toBe("done");
  // the write to bad/ was never recovered AT THAT PATH (the fix went to src/), so it stays in `failed` — the check's verdict sits beside it
  expect(r.end.outstanding).toEqual({ failed: ["write: ENOENT: bad/ does not exist"], unansweredAsk: false, writes: 1, nudged: true, verify: { state: "failed", command: "bun test", code: 1, failure: "✗ math > adds\n 1 fail" } });
  expect(outstandingClause(r.end.outstanding!)).toBe("1 failed tool call not recovered (write) · check failed (bun test):  1 fail");
});

test("(7) the other order: the gate fires first; a failed write after the fix does not earn a finish-check turn", async () => {
  const g = gate([FAIL, FAIL]);
  const r = await run([WRITE_OK, DONE, toolTurn([{ id: "b2", tool: "write", args: { path: "bad/y.ts", content: "" } }]), textTurn("Could not.")], { verify: g });
  expect(r.steers).toBe(1);
  expect(r.lastUser[2]).toContain("<verify-check>");
  expect(r.lastUser.length).toBe(4);
  expect(r.end.status).toBe("done");
  expect(g.calls).toBe(1);                       // the second exit has writes 1 = the count the check saw → its verdict stands, not re-run
  expect(r.end.outstanding).toMatchObject({ failed: ["write: ENOENT: bad/ does not exist"], nudged: true, verify: { state: "failed" } });
});

test("finishCheck:false does not disable the gate; the gate without a finish check still nudges once", async () => {
  const g = gate([FAIL, {}]);
  const r = await run([WRITE_OK, DONE, WRITE_OK2, DONE], { verify: g, finishCheck: false });
  expect(r.steers).toBe(1);
  expect(r.lastUser[2]).toContain("<verify-check>");
  expect(r.end.outstanding?.verify).toEqual({ state: "passed", command: "bun test", ms: 1200 });
});

// ---------- runtime wiring and plan mode ----------
test("(6) runtime.buildCfg: OFF by default (no `verify` key at all); ROVECODE_VERIFY=1 wires the injected resolver's answer; the timeout knob is honoured", () => {
  const cwd = tmp("rovecode-verify-cwd-");
  // default off: measured on this machine, the projects edited with rovecode have no check to run (see runtime.ts)
  expect("verify" in createRuntime({ cwd, sessionId: "s-v0", stream: null, verifyResolver: () => ({ commands: ["bun test"] }) }).buildCfg(true)).toBe(false);
  process.env.ROVECODE_VERIFY = "1";
  const seen: string[] = [];
  const rt = createRuntime({ cwd, sessionId: "s-v", stream: null, verifyResolver: (c) => { seen.push(c); return { commands: ["bun test"], source: "test" }; } });
  const on = rt.buildCfg(true);
  expect(on.verify?.resolution).toEqual({ commands: ["bun test"], source: "test" });
  expect(on.verify?.timeoutMs).toBe(120_000);
  expect(seen).toEqual([cwd]);
  // no injected resolver → core/verify.ts decides; an empty directory has nothing to run and says why (never a guess)
  const real = createRuntime({ cwd, sessionId: "s-v2", stream: null }).buildCfg(true).verify?.resolution;
  expect(real).toMatchObject({ commands: [], source: "none" });
  expect(typeof real?.reason).toBe("string");
  process.env.ROVECODE_VERIFY_TIMEOUT = "30";
  expect(createRuntime({ cwd, sessionId: "s-v3", stream: null }).buildCfg(true).verify?.timeoutMs).toBe(30_000);
  process.env.ROVECODE_VERIFY = "0";
  expect("verify" in createRuntime({ cwd, sessionId: "s-v4", stream: null }).buildCfg(true)).toBe(false);
});

test("the cached prefix is untouched: the system message and the tool list the model sees are byte-identical on every request, before and after the gate fires", async () => {
  // a fresh session writes the prefix once and reads it every turn after (58% of a run's bill is that one write);
  // the gate's result must land at the TAIL as a user message — anything that changes the prefix mid-run turns
  // every gate into a full rewrite. Pinned here by recording exactly what the StreamFn is handed.
  const prefixes: string[] = [];
  let n = 0;
  const turns = [WRITE_OK, DONE, WRITE_OK2, textTurn("Fixed for real.")];
  const stream: StreamFn = async function* (_m, messages: Message[], options) {
    prefixes.push(JSON.stringify({ system: messages.filter((m) => m.role === "system").map((m) => m.parts), tools: options?.tools ?? null }));
    yield { type: "turn", turn: turns[Math.min(n++, turns.length - 1)]! };
  };
  const registry = new ToolRegistry(); registry.register(WRITE); registry.register(NOOP);
  const events: RunEvent[] = [];
  const d: AgentDefinition = { ...def, systemPrompt: "You are the test agent. Fixed at turn 1." };
  for await (const ev of agentLoop(d, "fix the math", {}, cfg({ verify: gate([FAIL, {}]) }), { stream, registry, store: new SessionStore(tmp(), randomUUID()), tools: registry.list().map((t) => t.schema) }, new SteeringQueue())) events.push(ev);
  expect(events.filter((e) => e.type === "steer").length).toBe(1);
  expect(prefixes.length).toBe(4);
  expect(new Set(prefixes).size).toBe(1);
  expect(prefixes[0]).toContain("You are the test agent. Fixed at turn 1.");
});

test("(6) plan mode: applyModeToRun removes the gate from the run's config; act keeps it", () => {
  const g = gate([]);
  const modes = new ModeManager({}, { provider: "p", model: "m0" });
  const act = cfg({ verify: g }); applyModeToRun(modes, act, { ...def });
  expect(act.verify).toBe(g);
  modes.toggle("plan");
  const plan = cfg({ verify: g }); applyModeToRun(modes, plan, { ...def });
  expect("verify" in plan).toBe(false);
});
