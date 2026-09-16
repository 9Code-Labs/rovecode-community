/**
 * Loop-guard WIRING tests (port #4). The unit suite proves ToolGuard's
 * mechanics; these prove the guard is actually threaded through every
 * entrypoint and survives model iterations — the exact gap that shipped the
 * inert-guard bug (onTurn was called per model iteration, wiping the streak).
 *
 * Covered entrypoints: agentLoop itself, the gauntlet runner (with a
 * discriminating without-guard control), orchestrator runChild, and the CLI
 * `run` path end-to-end via a scripted OpenAI-compatible HTTP provider.
 *
 * The tail section pins other registry-dispatch seams that live on the same
 * pipeline (core/tools.ts dispatch): the out.ok argument into
 * guard.checkResult (FW2-O), ctx.onUpdate → tool_execution_update threading
 * (FW2-R), the describeResource schema gate for policy resources plus its
 * ctx.cwd fallback / relative-path resolution (port #22 MED-4), and the
 * post-approval abort re-check (port #21 LOW-1).
 */
import { test, expect } from "bun:test";
import { agentLoop, SteeringQueue, ABORTED_TOOL_RESULT } from "../../src/core/loop.ts";
import { ToolRegistry } from "../../src/core/tools.ts";
import { toolPath } from "../../src/core/workspace.ts";
import { readTool } from "../../src/coding/hashline.ts";
import { ToolGuard, GUARDRAIL_DEFAULTS } from "../../src/core/guardrails.ts";
import { SessionStore } from "../../src/core/session.ts";
import { runChild } from "../../src/core/orchestrator.ts";
import { runTask } from "../../src/eval/gauntlet-runner.ts";
import { adversarialTasks } from "../../src/eval/gauntlet.ts";
import { textTurn, toolTurn } from "../../src/providers/stream.ts";
import type { AgentDefinition, PermissionRule, RunConfig, RunEvent, StreamFn, Tool, ToolContext, ToolOutput } from "../../src/core/types.ts";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const allowAll = [{ action: "*", resource: "*", effect: "allow" as const }];
const STUB_AT = GUARDRAIL_DEFAULTS.stubAfterRepeats + 1; // 6th identical call is blocked

function cfg(over: Partial<RunConfig> = {}): RunConfig {
  return {
    maxTurns: 12, contextBudgetTokens: 100_000, compactionThreshold: 0.8,
    parallelTools: true,
    permissionRules: allowAll, ...over,
  };
}

const def: AgentDefinition = { name: "t", systemPrompt: "test", tools: ["*"], maxTurns: 12 };

/** Counting tool with a byte-identical result every call. */
function countingTool(): { tool: Tool; executed: () => number } {
  let n = 0;
  return {
    tool: {
      schema: { name: "probe", description: "probe", args: { type: "object" } },
      kind: "custom",
      async execute() { n++; return { ok: true, output: "same tiny output" }; },
    },
    executed: () => n,
  };
}

/** Scripted looping model: re-issues the identical call until a tool result
 *  carries the guard's blocked stub, then stops with `finalText`. Without a
 *  wired guard it loops until maxTurns. */
function loopingStream(tool: string, args: unknown, finalText: string): StreamFn {
  let n = 0;
  return async function* (_model, messages) {
    const last = messages.at(-1);
    const blocked = last?.role === "tool"
      && last.parts.some((p) => p.kind === "tool_result" && p.output.includes("loop guard: blocked"));
    if (blocked) { yield { type: "turn", turn: textTurn(finalText) }; return; }
    yield { type: "turn", turn: toolTurn([{ id: "c" + n++, tool, args }]) };
  };
}

// ── agentLoop wiring: the streak must SURVIVE model iterations ──────────────
// (closes the onTurn call-site gap: a per-iteration reset makes this test fail
// with 12 executions, no warn, no stub)

test("agentLoop: identical calls escalate across turns — warn nudges, then the stub blocks execution", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-gw-"));
  const store = new SessionStore(dir, randomUUID());
  const reg = new ToolRegistry();
  const probe = countingTool();
  reg.register(probe.tool);
  const ends: Extract<RunEvent, { type: "tool_execution_end" }>[] = [];
  let final = "";
  for await (const ev of agentLoop(def, "loop it", {}, cfg(), {
    stream: loopingStream("probe", { q: "same" }, "guard fired LOOP-BROKEN"),
    registry: reg, store, guard: new ToolGuard(),
  }, new SteeringQueue())) {
    if (ev.type === "tool_execution_end") ends.push(ev);
    if (ev.type === "run_end") final = ev.summary;
  }
  expect(probe.executed()).toBe(GUARDRAIL_DEFAULTS.stubAfterRepeats); // 5 executed, 6th blocked
  expect(ends.length).toBe(STUB_AT);
  // calls 1-2 clean; 3-5 carry the warn nudge; 6 is the stub (unexecuted, ok:false)
  expect(ends[0]!.output).not.toContain("[loop-guard]");
  expect(ends[1]!.output).not.toContain("[loop-guard]");
  for (const i of [2, 3, 4]) {
    expect(ends[i]!.ok).toBe(true);
    expect(ends[i]!.output).toContain("[loop-guard]");
    expect(ends[i]!.output).toContain("consecutive call");
  }
  expect(ends[5]!.ok).toBe(false);
  expect(ends[5]!.output).toContain("loop guard: blocked");
  expect(final).toContain("LOOP-BROKEN"); // the model saw the stub and stopped
  rmSync(dir, { recursive: true, force: true });
});

test("agentLoop: guard resets at the follow-up boundary (per-USER-turn semantics, hermes reset_for_turn)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-gw-"));
  const store = new SessionStore(dir, randomUUID());
  const reg = new ToolRegistry();
  const probe = countingTool();
  reg.register(probe.tool);
  const args = { q: "same" };
  // 3 identical calls (3rd warns) → text stop → follow-up → same call again → end
  const turns = [
    toolTurn([{ id: "a1", tool: "probe", args }]),
    toolTurn([{ id: "a2", tool: "probe", args }]),
    toolTurn([{ id: "a3", tool: "probe", args }]),
    textTurn("pausing"),
    toolTurn([{ id: "a4", tool: "probe", args }]),
    textTurn("end"),
  ];
  let i = 0;
  const stream: StreamFn = async function* () { yield { type: "turn", turn: turns[i++]! }; };
  const followUps = new SteeringQueue();
  followUps.push("keep going");
  const warned: boolean[] = [];
  let final = "";
  for await (const ev of agentLoop(def, "go", {}, cfg(), {
    stream, registry: reg, store, guard: new ToolGuard(),
  }, new SteeringQueue(), 0, followUps)) {
    if (ev.type === "tool_execution_end") warned.push(ev.output.includes("[loop-guard]"));
    if (ev.type === "run_end") final = ev.summary;
  }
  // 3rd pre-follow-up call warns; the post-follow-up call is a FRESH user turn
  // (upstream: each user message = new run_conversation = reset) — no warn
  expect(warned).toEqual([false, false, true, false]);
  expect(final).toContain("end");
  rmSync(dir, { recursive: true, force: true });
});

// ── gauntlet runner wiring + the discriminating without-guard control ───────

test("gauntlet adversarial-loop-guard: FAILS without a guard, PASSES with one", async () => {
  const task = adversarialTasks().find((t) => t.id === "adversarial-loop-guard")!;

  // control: unguarded run must FAIL verify — proves the task exercises the
  // guard (previously verify was `<=12`, structurally true at maxTurns 12)
  const ws1 = task.setup!();
  const bare = await runTask(task, ws1, null);
  expect(await task.verify(ws1, bare)).toBe(false);
  expect(bare.toolCalls.length).toBe(12);            // burned maxTurns
  expect(bare.finalText).not.toContain("LOOP-BROKEN"); // model never saw a stub
  rmSync(ws1, { recursive: true, force: true });

  // guarded (default wiring): blocked at the 6th attempt, model stops
  const ws2 = task.setup!();
  const guarded = await runTask(task, ws2);
  expect(await task.verify(ws2, guarded)).toBe(true);
  expect(guarded.toolCalls.length).toBe(STUB_AT);
  expect(guarded.finalText).toContain("LOOP-BROKEN");
  rmSync(ws2, { recursive: true, force: true });
}, 30_000);

// ── orchestrator wiring: subagents get their own guard ──────────────────────

test("runChild: a looping subagent is stopped by its own guard", async () => {
  const root = mkdtempSync(join(tmpdir(), "rovecode-gw-root-"));
  const sessions = mkdtempSync(join(tmpdir(), "rovecode-gw-sess-"));
  const probe = countingTool();
  const res = await runChild({
    defs: new Map([["worker", { name: "worker", systemPrompt: "w", tools: ["*"] }]]),
    stream: loopingStream("probe", { job: 1 }, "child saw the stub: LOOP-BROKEN"),
    registryFactory: () => { const r = new ToolRegistry(); r.register(probe.tool); return r; },
    rootDir: root, sessionsDir: sessions, baseConfig: cfg(),
  }, { agent: "worker", goal: "loop forever" });
  expect(res.ok).toBe(true);
  // The LOOP-BROKEN text can only appear after a tool_result carrying the
  // guard's blocked stub reached the child's history — an unguarded child
  // burns maxTurns and summarizes "(no output)". The child's rules derive
  // from the allow-all parent with the deny-rest default FIRST (FW2-P fix:
  // last-match-wins, so parent allows override it; the old trailing catch-all
  // denied every child call), so the identical calls now EXECUTE and the
  // guard — not a permissions accident — is what breaks the loop: 5 run,
  // the 6th is stubbed unexecuted.
  expect(res.summary).toContain("LOOP-BROKEN");
  expect(probe.executed()).toBe(GUARDRAIL_DEFAULTS.stubAfterRepeats); // 5 executed, 6th blocked by the guard
  rmSync(root, { recursive: true, force: true });
  rmSync(sessions, { recursive: true, force: true });
}, 30_000);

// ── CLI `run` wiring: full subprocess against a scripted HTTP provider ───────

test("cmdRun: guard events reach the one-shot CLI path end-to-end", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "rovecode-gw-cli-"));
  const notePath = join(tmp, "note.txt");
  writeFileSync(notePath, "loop guard e2e\n");
  let calls = 0;
  const server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(req) {
      const body = await req.json() as { messages: { role: string; content?: string | null }[] };
      const blocked = body.messages.some((m) => m.role === "tool" && typeof m.content === "string" && m.content.includes("loop guard: blocked"));
      if (blocked) {
        return Response.json({ choices: [{ message: { content: "LOOP-BROKEN" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
      }
      return Response.json({
        choices: [{
          message: { content: null, tool_calls: [{ id: `call_${calls++}`, type: "function", function: { name: "read", arguments: JSON.stringify({ path: notePath }) } }] },
          finish_reason: "tool_calls",
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    },
  });
  try {
    const main = join(import.meta.dir, "..", "..", "src", "cli", "main.ts");
    const env = { ...process.env, ROVECODE_BASE_URL: `http://127.0.0.1:${server.port}`, ROVECODE_API_KEY: "test-key", ROVECODE_MODEL: "scripted" } as Record<string, string>;
    delete env["ROVECODE_STREAM"];
    const proc = Bun.spawn([process.execPath, main, "run", "read note.txt forever", "--yolo"], {
      cwd: tmp, env, stdout: "pipe", stderr: "pipe",
    });
    const exit = await proc.exited;
    const out = await new Response(proc.stdout).text();
    expect(out).toContain("loop guard: blocked");                      // stub surfaced on the run path
    expect(out).toContain("LOOP-BROKEN");                              // model reacted and finished
    expect(out.split("→ read").length - 1).toBe(STUB_AT);              // 5 executed + 1 blocked attempt
    expect(exit).toBe(0);                                              // run ended "done", not budget
  } finally {
    server.stop(true);
    rmSync(tmp, { recursive: true, force: true });
  }
}, 40_000);

// ── registry dispatch seams (core/tools.ts dispatch) ─────────────────────────

function dispatchCtx(): ToolContext {
  return { sessionId: "s", cwd: process.cwd(), signal: new AbortController().signal, permissions: { effect: "allow" } };
}

// FW2-O: the out.ok argument at the guard.checkResult call (tools.ts ~:115) is
// what exempts FAILED results from dedup. The fixture text dodges the string
// sniff (no "Error" prefix, no '"error"'/'"failed"' head), so ONLY the
// threaded ok:false keeps it verbatim — deleting the out.ok argument stubs
// calls 2 and 3 and this test fails.
test("registry dispatch: three identical FAILING calls all return the failure verbatim — ok:false results are dedup-exempt", async () => {
  const FAILURE = "Permission denied by user. " + "d".repeat(600); // ≥ dedupMinChars, sniff-dodging
  const reg = new ToolRegistry();
  let runs = 0;
  reg.register({
    schema: { name: "flaky", description: "always fails", args: { type: "object" } },
    kind: "custom",
    async execute() { runs++; return { ok: false, output: FAILURE }; },
  });
  const guard = new ToolGuard();
  const outs: ToolOutput[] = [];
  for (const id of ["f1", "f2", "f3"]) {
    outs.push(await reg.dispatch({ kind: "tool_call", id, tool: "flaky", args: { q: 1 } }, dispatchCtx(), undefined, allowAll, undefined, () => {}, guard));
  }
  expect(runs).toBe(3); // all executed (stub verdicts only start at the 6th) — dedup is the hazard here
  for (const o of outs) {
    expect(o.ok).toBe(false);
    expect(o.output).toContain(FAILURE);               // the 3rd (and 2nd) stay verbatim…
    expect(o.output).not.toContain("byte-identical");  // …never the dedup reference stub
  }
  // contrast: the SAME text with ok:true dedups through the registry — the ok
  // flag, not the text, decides (and the dedup wiring itself is live)
  const reg2 = new ToolRegistry();
  reg2.register({
    schema: { name: "chatty", description: "same text, ok", args: { type: "object" } },
    kind: "custom",
    async execute() { return { ok: true, output: FAILURE }; },
  });
  const guard2 = new ToolGuard();
  await reg2.dispatch({ kind: "tool_call", id: "s1", tool: "chatty", args: { q: 1 } }, dispatchCtx(), undefined, allowAll, undefined, () => {}, guard2);
  const second = await reg2.dispatch({ kind: "tool_call", id: "s2", tool: "chatty", args: { q: 1 } }, dispatchCtx(), undefined, allowAll, undefined, () => {}, guard2);
  expect(second.output).toContain("byte-identical");
});

// FW2-R: ctx.onUpdate is wired at the execute site (tools.ts ~:108) so a
// tool's progress notes become real tool_execution_update events — previously
// NOTHING in src/ emitted that event and MCP onprogress hit a dead callback.
test("registry dispatch: a tool's ctx.onUpdate('x') surfaces as a tool_execution_update with the right callId", async () => {
  const reg = new ToolRegistry();
  reg.register({
    schema: { name: "prog", description: "emits progress", args: { type: "object" } },
    kind: "custom",
    async execute(_args, ctx) {
      ctx.onUpdate?.("x");
      ctx.onUpdate?.("half way");
      return { ok: true, output: "done" };
    },
  });
  const events: RunEvent[] = [];
  const out = await reg.dispatch(
    { kind: "tool_call", id: "call-77", tool: "prog", args: {} },
    dispatchCtx(), undefined, allowAll, undefined, (e) => events.push(e),
  );
  expect(out.ok).toBe(true);
  const updates = events.filter((e) => e.type === "tool_execution_update");
  expect(updates).toEqual([
    { type: "tool_execution_update", callId: "call-77", note: "x" },
    { type: "tool_execution_update", callId: "call-77", note: "half way" },
  ]);
  // ordering: update events land between start and end
  expect(events.findIndex((e) => e.type === "tool_execution_start")).toBeLessThan(events.findIndex((e) => e.type === "tool_execution_update"));
  expect(events.findIndex((e) => e.type === "tool_execution_end")).toBeGreaterThan(events.findLastIndex((e) => e.type === "tool_execution_update"));
});

// describeResource schema gate: an args key aims the policy resource ONLY when
// the tool's declared schema has that property. A smuggled path on a path-less
// tool must not re-aim a tool-targeted deny rule (policy runs pre-execute, so
// per-tool arg-stripping can never repair this).
test("policy: a deny rule on a path-less tool holds when the call smuggles path/command keys", async () => {
  const reg = new ToolRegistry();
  let ran = 0;
  reg.register({
    schema: { name: "lookup", description: "read-class, no path arg", args: { type: "object", properties: { query: { type: "string" } } } },
    kind: "read",
    async execute() { ran++; return { ok: true, output: "secret" }; },
  });
  const rules: PermissionRule[] = [
    { action: "file.read", resource: "*", effect: "allow" },
    { action: "file.read", resource: "lookup", effect: "deny" }, // precise tool-targeted deny
  ];
  for (const args of [{ query: "q", path: "/elsewhere" }, { query: "q", command: "echo hi" }]) {
    const out = await reg.dispatch({ kind: "tool_call", id: "d1", tool: "lookup", args }, dispatchCtx(), undefined, rules, undefined, () => {});
    expect(out.ok).toBe(false);
    expect(out.output).toContain("Permission denied");
  }
  expect(ran).toBe(0); // never executed
});

test("policy: a tool whose schema declares `path` still resolves its resource from args.path", async () => {
  const reg = new ToolRegistry();
  const reads: string[] = [];
  reg.register({
    schema: { name: "readfile", description: "file read", args: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
    kind: "read",
    async execute(args) { reads.push(String((args as { path: string }).path)); return { ok: true, output: "content" }; },
  });
  // rules speak the ladder's ONE spelling (core/workspace.ts toolPath = path.resolve): on Windows a rooted path without a
  // drive lands on the process drive, which is where node:fs would open it — so the rule is written the same way
  const ws = (p: string): string => toolPath(dispatchCtx().cwd, p);
  const rules: PermissionRule[] = [
    { action: "file.read", resource: ws("/workspace/*"), effect: "allow" },
    { action: "file.read", resource: ws("/workspace/locked.txt"), effect: "deny" },
  ];
  const ok = await reg.dispatch({ kind: "tool_call", id: "r1", tool: "readfile", args: { path: "/workspace/notes.md" } }, dispatchCtx(), undefined, rules, undefined, () => {});
  expect(ok.ok).toBe(true);
  expect(reads).toEqual(["/workspace/notes.md"]);      // path-scoped allow matched the real path
  const denied = await reg.dispatch({ kind: "tool_call", id: "r2", tool: "readfile", args: { path: "/workspace/locked.txt" } }, dispatchCtx(), undefined, rules, undefined, () => {});
  expect(denied.ok).toBe(false);                       // path-scoped deny still lands
  expect(reads).toEqual(["/workspace/notes.md"]);
});

// MED-4 (port #22): path-declared tools resolve a RELATIVE path against ctx.cwd
// (hashline/files resolvePath) and default a MISSING one to ctx.cwd, so the
// policy resource is built the same way — `read {path:"secrets/creds.txt"}`
// used to dodge a deny on the absolute path (the resource was the raw string).
test("policy: a relative `path` is resolved against ctx.cwd before matching — an absolute-path deny holds for the real read tool", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-gw-rel-"));
  mkdirSync(join(cwd, "secrets"));
  writeFileSync(join(cwd, "secrets", "creds.txt"), "TOPSECRET\n");
  writeFileSync(join(cwd, "public.txt"), "PUBLIC-OK\n");
  const reg = new ToolRegistry();
  reg.register(readTool);
  const rules: PermissionRule[] = [
    { action: "file.read", resource: "*", effect: "allow" },
    { action: "file.read", resource: join(cwd, "secrets", "creds.txt"), effect: "deny" },
  ];
  const c: ToolContext = { ...dispatchCtx(), cwd };
  const read = (id: string, path: string) =>
    reg.dispatch({ kind: "tool_call", id, tool: "read", args: { path } }, c, undefined, rules, undefined, () => {});
  const relative = await read("rel", "secrets/creds.txt");
  expect(relative.ok).toBe(false);
  expect(relative.output).toContain("Permission denied");
  expect(relative.output).not.toContain("TOPSECRET");
  const absolute = await read("abs", join(cwd, "secrets", "creds.txt"));
  expect(absolute.ok).toBe(false);                     // the absolute form, as before
  const open = await read("pub", "public.txt");
  expect(open.ok).toBe(true);                          // relative path to an un-denied file still reads
  expect(open.output).toContain("PUBLIC-OK");
  rmSync(cwd, { recursive: true, force: true });
});

// LOW-1 (port #21): an approval that resolves AFTER the run aborted must not
// execute the tool. The loop has synthesized ABORTED for the call and returned
// after its grace while the dispatch stayed parked in approve(). Mutation
// target: the `ctx.signal.aborted` re-check between approval and execute
// (tools.ts step 3b) — without it the late "allow" runs the tool detached
// from any run.
test("registry dispatch: an approval answered AFTER the run aborted never executes the tool; the result is the aborted synthesis", async () => {
  const reg = new ToolRegistry();
  let executed = 0;
  reg.register({
    schema: { name: "gated", description: "needs approval", args: { type: "object" } },
    kind: "custom",
    async execute() { executed++; return { ok: true, output: "ran" }; },
  });
  const rules: PermissionRule[] = [{ action: "tool.gated", resource: "*", effect: "prompt" }];
  let release!: (v: "once" | "always" | "deny") => void;
  const parked = new Promise<"once" | "always" | "deny">((r) => { release = r; });
  let asked = 0;
  const approve = () => { asked++; return parked; };
  const ac = new AbortController();
  const events: RunEvent[] = [];
  const out = reg.dispatch(
    { kind: "tool_call", id: "g1", tool: "gated", args: { n: 1 } },
    { ...dispatchCtx(), signal: ac.signal }, undefined, rules, approve, (e) => events.push(e),
  );
  await new Promise((r) => setTimeout(r, 30));
  expect(asked).toBe(1);      // parked in approve()
  expect(executed).toBe(0);
  ac.abort();                 // the run is gone…
  release("always");          // …then the human clicks allow
  const result = await Promise.race([out, new Promise<"deadline">((r) => setTimeout(() => r("deadline"), 3000))]);
  if (result === "deadline") throw new Error("dispatch did not settle after the late approval");
  expect(executed).toBe(0);
  expect(result).toEqual({ ok: false, output: ABORTED_TOOL_RESULT });
  expect(events.some((e) => e.type === "tool_execution_start")).toBe(false);
  // the "always" verdict was the user's decision about tool+args, not about
  // this run: a fresh, live run reuses it without re-prompting and executes
  const live = await reg.dispatch({ kind: "tool_call", id: "g2", tool: "gated", args: { n: 1 } }, dispatchCtx(), undefined, rules, approve, () => {});
  expect(asked).toBe(1);
  expect(live).toEqual({ ok: true, output: "ran" });
  expect(executed).toBe(1);
});
