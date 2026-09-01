/**
 * Loop-guard WIRING tests (port #4). The unit suite proves ToolGuard's
 * mechanics; these prove the guard is actually threaded through every
 * entrypoint and survives model iterations — the exact gap that shipped the
 * inert-guard bug (onTurn was called per model iteration, wiping the streak).
 *
 * Covered entrypoints: agentLoop itself, the gauntlet runner (with a
 * discriminating without-guard control), orchestrator runChild, and the CLI
 * `run` path end-to-end via a scripted OpenAI-compatible HTTP provider.
 */
import { test, expect } from "bun:test";
import { agentLoop, SteeringQueue } from "../../src/core/loop.ts";
import { ToolRegistry } from "../../src/core/tools.ts";
import { ToolGuard, GUARDRAIL_DEFAULTS } from "../../src/core/guardrails.ts";
import { SessionStore } from "../../src/core/session.ts";
import { runChild } from "../../src/core/orchestrator.ts";
import { runTask } from "../../src/eval/gauntlet-runner.ts";
import { adversarialTasks } from "../../src/eval/gauntlet.ts";
import { textTurn, toolTurn } from "../../src/providers/stream.ts";
import type { AgentDefinition, RunConfig, RunEvent, StreamFn, Tool } from "../../src/core/types.ts";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
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
  const dir = mkdtempSync(join(tmpdir(), "aion-gw-"));
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
  const dir = mkdtempSync(join(tmpdir(), "aion-gw-"));
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
  const root = mkdtempSync(join(tmpdir(), "aion-gw-root-"));
  const sessions = mkdtempSync(join(tmpdir(), "aion-gw-sess-"));
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
  const tmp = mkdtempSync(join(tmpdir(), "aion-gw-cli-"));
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
    const env = { ...process.env, AION_BASE_URL: `http://127.0.0.1:${server.port}`, AION_API_KEY: "test-key", AION_MODEL: "scripted" } as Record<string, string>;
    delete env["AION_STREAM"];
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
