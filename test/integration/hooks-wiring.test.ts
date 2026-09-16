/** Hooks v2 (port #29) WIRING tests: the typed hook set threaded through core/tools.ts dispatch
 *  (pre_tool after policy, post_tool after execute), the approval hook as HookRunner.approver INSIDE
 *  the execpolicy wrap (cli/runtime.ts buildCfg: rules → execpolicy → hook → human), core/loop.ts
 *  agentLoop (pre_run / compaction / post_run / on_event via the observer), cli/runtime.ts
 *  (.rovecode/hooks.ts + ~/.rovecode loaded at boot, session_open/close) and the surfaces (cmdRun as a
 *  subprocess against a scripted provider, serve stop(), ACP shutdown()). "Policy wins" and
 *  "fail-open to policy" are pinned here; the runner's own mechanics live in test/unit/hooks.test.ts. */

import { test, expect } from "bun:test";
import {
  ClientSideConnection, ndJsonStream, PROTOCOL_VERSION,
  type Client, type SessionNotification, type RequestPermissionRequest, type RequestPermissionResponse,
} from "@zed-industries/agent-client-protocol";
import { agentLoop, SteeringQueue, partsText } from "../../src/core/loop.ts";
import { ToolRegistry } from "../../src/core/tools.ts";
import { SessionStore } from "../../src/core/session.ts";
import { HookRunner, MAX_POST_TOOL_GROWTH_CHARS, type HookSet } from "../../src/core/hooks.ts";
import { bootRuntime } from "../../src/cli/runtime.ts";
import { startServer } from "../../src/server/http.ts";
import { serveAcp } from "../../src/acp/server.ts";
import { mockStream, textTurn, toolTurn } from "../../src/providers/stream.ts";
import type {
  AgentDefinition, ApprovalFn, Message, MessagePart, PermissionRule, RunConfig, RunEvent, StreamFn, Tool, ToolContext,
} from "../../src/core/types.ts";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { trustProjectFiles } from "../helpers/mcp-trust.ts";
import { randomUUID } from "node:crypto";

const allowAll: PermissionRule[] = [{ action: "*", resource: "*", effect: "allow" }];
const cfg = (over: Partial<RunConfig> = {}): RunConfig =>
  ({ maxTurns: 8, contextBudgetTokens: 100_000, compactionThreshold: 0.8, parallelTools: true, permissionRules: allowAll, ...over });
const def: AgentDefinition = { name: "t", systemPrompt: "test", tools: ["*"], maxTurns: 8 };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** counting tool with a fixed output; kind custom → policy action tool.probe */
function probeTool(): { tool: Tool; runs: () => number } {
  let n = 0;
  return {
    tool: { schema: { name: "probe", description: "probe", args: { type: "object" } }, kind: "custom", async execute() { n++; return { ok: true, output: "probe-output" }; } },
    runs: () => n,
  };
}
function dispatchCtx(cwd = process.cwd()): ToolContext {
  return { sessionId: "s", cwd, signal: new AbortController().signal, permissions: { effect: "allow" }, runId: "run-1" };
}
function runner(...sets: HookSet[]): HookRunner {
  const r = new HookRunner({ cwd: "/w", sessionId: "s" }, { timeoutMs: 2000 });
  sets.forEach((s, i) => r.add(s, `set${i}`));
  return r;
}
function newStore(): { store: SessionStore; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-hooks-w-"));
  return { store: new SessionStore(dir, randomUUID()), done: () => rmSync(dir, { recursive: true, force: true }) };
}
const toolResults = (store: SessionStore): Extract<MessagePart, { kind: "tool_result" }>[] =>
  store.messages().flatMap((m) => m.parts).filter((p): p is Extract<MessagePart, { kind: "tool_result" }> => p.kind === "tool_result");
/** two long user/assistant turns so a 60-token window compacts at turn 1 (loop.test.ts idiom) */
function seedLongHistory(store: SessionStore): void {
  let parent: string | null = null;
  for (let i = 0; i < 4; i++) {
    const m: Message = { id: randomUUID(), role: i % 2 === 0 ? "user" : "assistant", parts: [{ kind: "text", text: "x".repeat(200) }], parentId: parent, createdAt: Date.now() };
    store.append(m); parent = m.id;
  }
}
/** a project hooks file that appends `<tag>:<sessionId>` lines to <cwd>/hooks.log for the given hooks */
function markerHooks(cwd: string, hookNames: string[]): string {
  mkdirSync(join(cwd, ".rovecode"), { recursive: true });
  const log = join(cwd, "hooks.log");
  const body = hookNames.map((h) => `${h}(ctx) { appendFileSync(${JSON.stringify(log)}, ${JSON.stringify(h + ":")} + ctx.sessionId + "\\n"); }`).join(",\n  ");
  writeFileSync(join(cwd, ".rovecode", "hooks.ts"), `import { appendFileSync } from "node:fs";\nexport default { version: 1, hooks: {\n  ${body},\n} };\n`);
  trustProjectFiles(cwd); // approved in the CURRENT ROVECODE_HOME (set by the caller first): the gate is pinned in project-trust.test.ts
  return log;
}
const markers = (log: string): string[] => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : [];

// ── dispatch seams (core/tools.ts) ───────────────────────────────────────────

test("pre_tool deny through the loop: the tool never executes, the failure carries the hook's reason in the policy-deny shape, the run continues to done", async () => {
  const { store, done } = newStore();
  try {
    const reg = new ToolRegistry(); const probe = probeTool(); reg.register(probe.tool);
    const seen: unknown[] = [];
    const hooks = runner({ pre_tool: (ctx, call) => { seen.push([ctx.runId, call.tool, call.args]); if (call.tool === "probe") return { deny: "probe is off-limits today" }; } });
    const events: RunEvent[] = [];
    for await (const ev of agentLoop(def, "go", {}, cfg(), {
      stream: mockStream({ turns: [toolTurn([{ id: "c1", tool: "probe", args: { q: 1 } }]), textTurn("after deny")] }),
      registry: reg, store, hooks,
    }, new SteeringQueue())) events.push(ev);
    expect(probe.runs()).toBe(0);
    expect(events.find((e) => e.type === "tool_call_failed")).toEqual({ type: "tool_call_failed", callId: "c1", reason: "permission_denied", detail: "probe is off-limits today" });
    expect(events.some((e) => e.type === "tool_execution_start")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "run_end", status: "done", summary: "after deny" });
    // the model saw the deny as a failed tool_result carrying the hook's reason
    expect(toolResults(store)).toEqual([{ kind: "tool_result", callId: "c1", ok: false, output: "Permission denied by hook: probe is off-limits today" }]);
    // ctx carried the run id (the loop's ToolContext.runId) and the (revised) args
    const runId = (events[0] as Extract<RunEvent, { type: "run_start" }>).runId;
    expect(seen).toEqual([[runId, "probe", { q: 1 }]]);
    expect(hooks.warnings).toEqual([]);
  } finally { done(); }
});

test("policy still wins: a rule deny is never un-denied — pre_tool/approval hooks are not even consulted and the reason is the rule's; a hook deny holds under yolo", async () => {
  const reg = new ToolRegistry(); const probe = probeTool(); reg.register(probe.tool);
  const consulted: string[] = [];
  const hooks = runner({
    pre_tool: () => { consulted.push("pre_tool"); }, // no objection
    approval: () => { consulted.push("approval"); return "allow"; }, // would allow if it were asked
  });
  const denyRule: PermissionRule[] = [{ action: "*", resource: "*", effect: "allow" }, { action: "tool.probe", resource: "*", effect: "deny" }];
  const events: RunEvent[] = [];
  const out = await reg.dispatch({ kind: "tool_call", id: "d1", tool: "probe", args: {} }, dispatchCtx(), hooks, denyRule, async () => "once", (e) => events.push(e));
  expect(out).toEqual({ ok: false, output: "Permission denied: denied by rule tool.probe *" });
  expect(events).toEqual([{ type: "tool_call_failed", callId: "d1", reason: "permission_denied", detail: "denied by rule tool.probe *" }]);
  expect(consulted).toEqual([]); // policy first: hooks never see a rule-rejected call
  expect(probe.runs()).toBe(0);
  // yolo (allow-all rules) + hook deny → still denied: a hook is a stricter layer in every mode
  const strict = runner({ pre_tool: () => ({ deny: "hook says no" }) });
  const y = await reg.dispatch({ kind: "tool_call", id: "d2", tool: "probe", args: {} }, dispatchCtx(), strict, allowAll, undefined, () => {});
  expect(y).toEqual({ ok: false, output: "Permission denied by hook: hook says no" });
  expect(probe.runs()).toBe(0);
});

test("approval hook rides the approver chain (hooks.approver) for a policy PROMPT with nothing cached: 'allow' runs without the human (one-shot, not cached), 'deny' denies without the human, void asks the human; allow-rules and a cached 'always' never consult it; headless fails closed on void", async () => {
  const reg = new ToolRegistry(); const probe = probeTool(); reg.register(probe.tool);
  const promptRule: PermissionRule[] = [{ action: "tool.probe", resource: "*", effect: "prompt" }];
  let answer: "allow" | "deny" | undefined = "allow";
  const asked: string[] = []; const seenCtx: unknown[] = [];
  const hooks = runner({ approval: (c, req) => { asked.push(`hook:${req.reason}`); seenCtx.push(c); return answer; } });
  const human: string[] = [];
  const humanFn: ApprovalFn = async (req) => { human.push(req.tool); return "always"; };
  const approve = hooks.approver(humanFn); // the seam buildCfg wraps in execPolicyApprover
  const events: RunEvent[] = [];
  const go = (id: string, args: unknown, rules: PermissionRule[] = promptRule, ap: ApprovalFn = approve) =>
    reg.dispatch({ kind: "tool_call", id, tool: "probe", args }, dispatchCtx(), hooks, rules, ap, (e) => events.push(e));
  // 1. allow → executes, human not asked; the hook saw the runtime's ctx
  expect((await go("a1", { n: 1 })).ok).toBe(true);
  expect(human).toEqual([]); expect(probe.runs()).toBe(1);
  expect(asked).toEqual(["hook:permission required for tool.probe probe"]);
  expect(seenCtx).toEqual([{ cwd: "/w", sessionId: "s" }]);
  // 2. the same call again → NOT cached: the hook is asked again (one-shot semantics)
  expect((await go("a2", { n: 1 })).ok).toBe(true);
  expect(asked.length).toBe(2); expect(human).toEqual([]);
  // 3. deny → denied without the human, in the approver chain's deny shape (the same one an execpolicy forbid takes)
  answer = "deny";
  expect(await go("a3", { n: 2 })).toEqual({ ok: false, output: "Permission denied by user" });
  expect(events.at(-1)).toEqual({ type: "tool_call_failed", callId: "a3", reason: "permission_denied", detail: "user denied" });
  expect(human).toEqual([]); expect(probe.runs()).toBe(2);
  // 4. void → the human is asked, and the human's "always" caches as before
  answer = undefined;
  expect((await go("a4", { n: 3 })).ok).toBe(true);
  expect(human).toEqual(["probe"]); expect(asked.length).toBe(4);
  // 5. cached "always" for {n:3} → neither hook nor human is consulted (a hook deny cannot pre-empt it)
  answer = "deny";
  expect((await go("a5", { n: 3 })).ok).toBe(true);
  expect(asked.length).toBe(4); expect(human).toEqual(["probe"]);
  // 6. an allow rule never reaches the prompt branch → the hook is not consulted
  expect((await go("a6", { n: 9 }, allowAll)).ok).toBe(true);
  expect(asked.length).toBe(4);
  // 7. headless (no human behind the hook): hook "allow" runs the call; hook void fails closed (execpolicy's headless arm)
  const headless = hooks.approver(undefined);
  answer = "allow";
  expect((await go("a7", { n: 10 }, promptRule, headless)).ok).toBe(true);
  expect(human).toEqual(["probe"]); // still only the one human ask from step 4
  answer = undefined;
  expect(await go("a8", { n: 11 }, promptRule, headless)).toEqual({ ok: false, output: "Permission denied by user" });
  expect(asked.length).toBe(6); expect(probe.runs()).toBe(6); // a1 a2 a4 a5 a6 a7 ran; a3 a8 were denied
  expect(hooks.warnings).toEqual([]);
});

test("ordering (port #9 contract holds under hooks): execpolicy-forbidden argv hard-stops BEFORE the approval hook (never consulted), allow-listed argv runs without asking anyone, prompt-classified argv is the hook's to pre-answer — the human only on void", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-hooks-order-"));
  const home = mkdtempSync(join(tmpdir(), "rovecode-hooks-orderhome-"));
  const savedHome = process.env.ROVECODE_HOME;
  process.env.ROVECODE_HOME = home; // pinned: never load the developer's ~/.rovecode/hooks.ts
  try {
    const rt = await bootRuntime({ cwd, sessionId: "sess-order", stream: null });
    // spy executor: register() overwrites by schema name, so this replaces the REAL bash tool — nothing is spawned
    const executed: string[] = [];
    rt.registry.register({ schema: { name: "bash", description: "spy", args: {} }, kind: "execute", async execute(args) { executed.push(String((args as { command: string }).command)); return { ok: true, output: "ran" }; } });
    let answer: "allow" | undefined = "allow";
    const hookSaw: string[] = [];
    rt.hooks.add({ approval: (_c, req) => { hookSaw.push(String((req.revisedArgs as { command: string }).command)); return answer; } }, "allow-hook");
    // a pre_tool veto is the hook layer that DOES precede execpolicy's allow-list (policy → pre_tool → approve)
    rt.hooks.add({ pre_tool: (_c, call) => ((call.args as { command: string }).command === "pwd" ? { deny: "no pwd here" } : undefined) }, "veto-hook");
    const humanSaw: string[] = [];
    const cfg = rt.buildCfg(false, async (req) => { humanSaw.push(req.reason); return "once"; });
    const events: RunEvent[] = [];
    const dispatch = (command: string, id: string) => rt.registry.dispatch(
      { kind: "tool_call", id, tool: "bash", args: { command } },
      { sessionId: "sess-order", cwd, signal: new AbortController().signal, permissions: { effect: "allow" } },
      rt.hooks, cfg.permissionRules, cfg.approval, (e) => events.push(e));
    // forbidden (execpolicy-rules.ts DEFAULT_RULES; the critic's H1/H2 repro): denied before any hook or human
    // sees it, even though the hook would say "allow"
    for (const [id, cmd] of [["f1", "git push --force"], ["f2", "git reset --hard"], ["f3", "git push --force origin main"]] as const) {
      const out = await dispatch(cmd, id);
      expect(out.ok).toBe(false);
      expect(out.output).toBe("Permission denied by user");
    }
    expect(hookSaw).toEqual([]); expect(humanSaw).toEqual([]); expect(executed).toEqual([]);
    // allow-listed: runs, nobody asked
    expect((await dispatch("ls -la", "a1")).ok).toBe(true);
    expect(executed).toEqual(["ls -la"]); expect(hookSaw).toEqual([]); expect(humanSaw).toEqual([]);
    // allow-listed but pre_tool-vetoed: the veto holds (execpolicy's allow never un-denies a hook)
    expect(await dispatch("pwd", "v1")).toEqual({ ok: false, output: "Permission denied by hook: no pwd here" });
    expect(executed).toEqual(["ls -la"]); expect(hookSaw).toEqual([]);
    // prompt-classified: the hook pre-answers, the human is never reached
    expect((await dispatch("frobnicate --yes", "p1")).ok).toBe(true);
    expect(executed).toEqual(["ls -la", "frobnicate --yes"]);
    expect(hookSaw).toEqual(["frobnicate --yes"]); expect(humanSaw).toEqual([]);
    // prompt-classified + hook void: the human is asked (an unknown command carries the policy prompt — execpolicy has no justification for it)
    answer = undefined;
    expect((await dispatch("frobnicate --no", "p2")).ok).toBe(true);
    expect(hookSaw).toEqual(["frobnicate --yes", "frobnicate --no"]);
    expect(humanSaw).toEqual(["permission required for shell.exec bash"]);
    expect(executed).toEqual(["ls -la", "frobnicate --yes", "frobnicate --no"]);
    expect(events.filter((e) => e.type === "tool_call_failed").map((e) => (e as { callId: string }).callId)).toEqual(["f1", "f2", "f3", "v1"]);
    expect(rt.hooks.warnings).toEqual([]);
    await rt.hooks.close(); await rt.mcp?.close();
  } finally {
    if (savedHome === undefined) delete process.env.ROVECODE_HOME; else process.env.ROVECODE_HOME = savedHome;
    rmSync(cwd, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true });
  }
});

test("post_tool annotation: the stored tool_result (what the model sees) and tool_execution_end both carry the hook's text; growth is bounded", async () => {
  const { store, done } = newStore();
  try {
    const reg = new ToolRegistry(); const probe = probeTool(); reg.register(probe.tool);
    const hooks = runner({ post_tool: (_c, call, r) => ({ output: `${r.output}\n[hook] ${call.tool} ok=${r.ok}` }) });
    const events: RunEvent[] = [];
    for await (const ev of agentLoop(def, "go", {}, cfg(), {
      stream: mockStream({ turns: [toolTurn([{ id: "c1", tool: "probe", args: {} }]), textTurn("done")] }), registry: reg, store, hooks,
    }, new SteeringQueue())) events.push(ev);
    const end = events.find((e) => e.type === "tool_execution_end") as Extract<RunEvent, { type: "tool_execution_end" }>;
    expect(end.output).toBe("probe-output\n[hook] probe ok=true");
    expect(toolResults(store).map((r) => r.output)).toEqual(["probe-output\n[hook] probe ok=true"]);
    // bound: a hook that balloons the output is cut at original + cap with a marker
    const balloon = runner({ post_tool: (_c, _call, r) => ({ output: r.output + "z".repeat(MAX_POST_TOOL_GROWTH_CHARS * 2) }) });
    const out = await reg.dispatch({ kind: "tool_call", id: "b1", tool: "probe", args: {} }, dispatchCtx(), balloon, allowAll, undefined, () => {});
    expect(out.ok).toBe(true);
    expect(out.output.length).toBeLessThan("probe-output".length + MAX_POST_TOOL_GROWTH_CHARS + 200);
    expect(out.output).toContain("[post_tool output truncated");
  } finally { done(); }
});

test("hooks receive COPIES: a pre_tool that mutates call.args re-aims neither the executed call nor the persisted tool_call; a post_tool that ASSIGNS r.output dodges no bound; an approval hook that mutates req changes nothing that runs", async () => {
  const { store, done } = newStore();
  try {
    const reg = new ToolRegistry();
    const executedArgs: unknown[] = [];
    reg.register({ schema: { name: "probe", description: "probe", args: { type: "object" } }, kind: "custom", async execute(args) { executedArgs.push(args); return { ok: true, output: "probe-output" }; } });
    const hooks = runner({
      pre_tool: (_c, call) => { (call.args as { q: string }).q = "MUTATED"; },
      post_tool: (_c, _call, r) => { r.output = "Z".repeat(MAX_POST_TOOL_GROWTH_CHARS * 4); }, // an assignment, not a returned {output}
    });
    const events: RunEvent[] = [];
    for await (const ev of agentLoop(def, "go", {}, cfg(), {
      stream: mockStream({ turns: [toolTurn([{ id: "c1", tool: "probe", args: { q: "original" } }]), textTurn("done")] }), registry: reg, store, hooks,
    }, new SteeringQueue())) events.push(ev);
    expect(executedArgs).toEqual([{ q: "original" }]);                                  // policy evaluated {q:"original"}; so did the tool
    expect(store.messages().flatMap((m) => m.parts).find((p) => p.kind === "tool_call")).toMatchObject({ args: { q: "original" } });
    expect(toolResults(store).map((r) => r.output)).toEqual(["probe-output"]);        // the assignment landed on a copy
    expect((events.find((e) => e.type === "tool_execution_end") as Extract<RunEvent, { type: "tool_execution_end" }>).output).toBe("probe-output");
    expect(events.at(-1)).toMatchObject({ type: "run_end", status: "done" });
    // approval hook (through the approver chain): mutating req.args / req.revisedArgs changes nothing downstream
    const promptRule: PermissionRule[] = [{ action: "tool.probe", resource: "*", effect: "prompt" }];
    const mutating = runner({ approval: (_c, req) => { (req.revisedArgs as { q: string }).q = "MUTATED"; (req.args as { q: string }).q = "MUTATED"; return "allow"; } });
    const out = await reg.dispatch({ kind: "tool_call", id: "a1", tool: "probe", args: { q: "orig2" } }, dispatchCtx(), mutating, promptRule, mutating.approver(), () => {});
    expect(out.ok).toBe(true);
    expect(executedArgs.at(-1)).toEqual({ q: "orig2" });
    expect(hooks.warnings).toEqual([]); expect(mutating.warnings).toEqual([]);
  } finally { done(); }
});

// ── bounded + isolated inside a real run ─────────────────────────────────────

test("timeout: a hanging pre_tool cannot deny — the tool runs (fail-open to policy, which already allowed it), the run completes, the warning lands at ~timeout", async () => {
  const { store, done } = newStore();
  try {
    const reg = new ToolRegistry(); const probe = probeTool(); reg.register(probe.tool);
    const hooks = new HookRunner({ cwd: "/w", sessionId: "s" }, { timeoutMs: 100 });
    hooks.add({ pre_tool: () => new Promise(() => {}) }, "hang");
    const t0 = Date.now();
    let status = "";
    const run = (async () => {
      for await (const ev of agentLoop(def, "go", {}, cfg(), {
        stream: mockStream({ turns: [toolTurn([{ id: "c1", tool: "probe", args: {} }]), textTurn("done")] }), registry: reg, store, hooks,
      }, new SteeringQueue())) { if (ev.type === "run_end") status = ev.status; }
    })();
    expect(await Promise.race([run.then(() => "ran"), sleep(4000).then(() => "DEADLINE")])).toBe("ran");
    expect(status).toBe("done");
    expect(probe.runs()).toBe(1);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(95);
    expect(hooks.warnings).toEqual(["hang: pre_tool hook timed out after 100ms — ignored, run continues"]);
  } finally { done(); }
});

test("isolation: hooks that throw at every seam (pre_run, pre_tool, post_tool, on_event, post_run) never kill the run — it ends 'done' with one warning per failure", async () => {
  const { store, done } = newStore();
  try {
    const reg = new ToolRegistry(); const probe = probeTool(); reg.register(probe.tool);
    const boom = (n: string) => () => { throw new Error(`${n} boom`); };
    const hooks = runner({
      pre_run: boom("pre_run"), pre_tool: boom("pre_tool"), post_run: boom("post_run"), on_event: boom("on_event"),
      post_tool: async () => { throw new Error("post_tool boom"); },
    });
    const events: RunEvent[] = [];
    for await (const ev of agentLoop(def, "go", {}, cfg(), {
      stream: mockStream({ turns: [toolTurn([{ id: "c1", tool: "probe", args: {} }]), textTurn("done")] }), registry: reg, store, hooks,
    }, new SteeringQueue())) events.push(ev);
    await hooks.settle();
    expect(events.at(-1)).toMatchObject({ type: "run_end", status: "done" });
    expect(probe.runs()).toBe(1);
    const kinds = hooks.warnings.map((w) => w.replace(/^set0: (\w+) hook threw: .*$/, "$1"));
    expect(kinds.filter((k) => k !== "on_event").sort()).toEqual(["post_run", "post_tool", "pre_run", "pre_tool"]);
    expect(kinds.filter((k) => k === "on_event").length).toBe(events.length);
  } finally { done(); }
});

// ── run-level hooks (core/loop.ts observer) ──────────────────────────────────

test("on_event receives every RunEvent of a scripted run in the consumer's order; pre_run/post_run fire once with the runId and the run_end result", async () => {
  const { store, done } = newStore();
  try {
    const reg = new ToolRegistry(); reg.register(probeTool().tool);
    const tapped: string[] = []; const lifecycle: unknown[] = [];
    const hooks = runner({
      on_event: (c, ev) => { tapped.push(`${c.runId}:${ev.type}`); },
      pre_run: (c) => { lifecycle.push(["pre_run", c.runId, c.sessionId]); },
      post_run: (c, r) => { lifecycle.push(["post_run", c.runId, r]); },
    });
    const consumer: string[] = [];
    let runId = "";
    for await (const ev of agentLoop(def, "go", {}, cfg(), {
      stream: mockStream({ turns: [toolTurn([{ id: "c1", tool: "probe", args: {} }]), textTurn("final")] }), registry: reg, store, hooks,
    }, new SteeringQueue())) {
      if (ev.type === "run_start") runId = ev.runId;
      consumer.push(`${runId}:${ev.type}`);
    }
    await hooks.settle();
    expect(tapped).toEqual(consumer);
    const types = new Set(consumer.map((s) => s.split(":")[1]));
    for (const t of ["run_start", "turn_start", "turn_end", "tool_execution_start", "tool_execution_end", "run_end"]) expect(types.has(t)).toBe(true);
    expect(lifecycle).toEqual([["pre_run", runId, store.id], ["post_run", runId, { status: "done", summary: "final" }]]);
  } finally { done(); }
});

test("compaction hook fires with the yielded compaction event (strategy + trigger + token counts)", async () => {
  const { store, done } = newStore();
  try {
    seedLongHistory(store);
    const got: unknown[] = [];
    const hooks = runner({ compaction: (c, ev) => { got.push([c.runId, ev]); } });
    const events: RunEvent[] = [];
    let runId = "";
    for await (const ev of agentLoop(def, "compact this run", {}, cfg({ contextBudgetTokens: 60, compactionThreshold: 0.5, compactionStrategy: "keep-window", compactionKeepTurns: 0 }), {
      stream: mockStream({ turns: [textTurn("done")] }), registry: new ToolRegistry(), store, hooks,
    }, new SteeringQueue())) { events.push(ev); if (ev.type === "run_start") runId = ev.runId; }
    const comp = events.filter((e) => e.type === "compaction");
    expect(comp.length).toBe(1);
    expect(comp[0]).toMatchObject({ strategy: "keep-window", trigger: "speculative" });
    expect(got).toEqual([[runId, comp[0]]]);
    expect(events.at(-1)).toMatchObject({ type: "run_end", status: "done" });
  } finally { done(); }
});

// ── runtime + surfaces ───────────────────────────────────────────────────────

test("runtime: .rovecode/hooks.ts (project) + ~/.rovecode/hooks.ts (ROVECODE_HOME) load at boot, session_open fires once each, rt.hooks reaches dispatch, close() fires session_close once; a broken file is one warning", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-hooks-rt-"));
  const home = mkdtempSync(join(tmpdir(), "rovecode-hooks-rthome-"));
  const key = `__rovecodeHooksRt_${process.pid}_${Date.now()}`;
  const log: unknown[] = [];
  (globalThis as Record<string, unknown>)[key] = log;
  const savedHome = process.env.ROVECODE_HOME;
  process.env.ROVECODE_HOME = home;
  try {
    mkdirSync(join(cwd, ".rovecode"), { recursive: true });
    writeFileSync(join(cwd, ".rovecode", "hooks.ts"), `const log = globalThis[${JSON.stringify(key)}];
export default { version: 1, hooks: {
  session_open(ctx) { log.push(["open", ctx.sessionId, ctx.cwd]); },
  session_close(ctx) { log.push(["close", ctx.sessionId]); },
  pre_tool(ctx, call) { log.push(["pre_tool", call.tool]); if (call.tool === "bash") return { deny: "no shell from this project" }; },
} };
`);
    trustProjectFiles(cwd, home);
    writeFileSync(join(home, "hooks.ts"), `const log = globalThis[${JSON.stringify(key)}];\nexport default { version: 1, hooks: { session_open() { log.push("user-open"); } } };\n`);
    const rt = await bootRuntime({ cwd, sessionId: "sess-h", stream: null });
    expect(rt.hooks.size).toBe(3); // user file + project file + the built-in reflection set (port #28)
    expect(log).toEqual(["user-open", ["open", "sess-h", cwd]]); // user scope first; once each
    // rt.hooks IS the LoopDeps/dispatch seam: the real bash tool is denied by the project hook even under yolo rules
    const events: RunEvent[] = [];
    const yolo = rt.buildCfg(true);
    const out = await rt.registry.dispatch(
      { kind: "tool_call", id: "b1", tool: "bash", args: { command: "echo hi" } },
      { sessionId: "sess-h", cwd, signal: new AbortController().signal, permissions: { effect: "allow" } },
      rt.hooks, yolo.permissionRules, yolo.approval, (e) => events.push(e),
    );
    expect(out).toEqual({ ok: false, output: "Permission denied by hook: no shell from this project" });
    expect(events).toEqual([{ type: "tool_call_failed", callId: "b1", reason: "permission_denied", detail: "no shell from this project" }]);
    expect(log.at(-1)).toEqual(["pre_tool", "bash"]);
    await rt.hooks.close();
    await rt.hooks.close();
    expect(log.filter((e) => Array.isArray(e) && e[0] === "close")).toEqual([["close", "sess-h"]]);
    expect(rt.hooks.warnings).toEqual([]);
    await rt.mcp?.close();
  } finally {
    if (savedHome === undefined) delete process.env.ROVECODE_HOME; else process.env.ROVECODE_HOME = savedHome;
    delete (globalThis as Record<string, unknown>)[key];
    rmSync(cwd, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true });
  }
  // a broken project file: the runtime still boots, hooks.warnings names the file, nothing else changes
  const cwd2 = mkdtempSync(join(tmpdir(), "rovecode-hooks-rt2-"));
  const home2 = mkdtempSync(join(tmpdir(), "rovecode-hooks-rthome2-"));
  process.env.ROVECODE_HOME = home2;
  try {
    mkdirSync(join(cwd2, ".rovecode"), { recursive: true });
    writeFileSync(join(cwd2, ".rovecode", "hooks.ts"), "export default { version: 1, hooks: {\n");
    trustProjectFiles(cwd2, home2); // trusted, so the loader gets as far as the import — and THAT is what fails here
    const rt = await bootRuntime({ cwd: cwd2, stream: null });
    expect(rt.hooks.size).toBe(1); // the built-in reflection set only (port #28) — the broken file loaded nothing
    expect(rt.hooks.warnings.length).toBe(1);
    expect(rt.hooks.warnings[0]!.startsWith(`${join(cwd2, ".rovecode", "hooks.ts")}: failed to load — `)).toBe(true);
    await rt.hooks.close();
    await rt.mcp?.close();
  } finally {
    if (savedHome === undefined) delete process.env.ROVECODE_HOME; else process.env.ROVECODE_HOME = savedHome;
    rmSync(cwd2, { recursive: true, force: true }); rmSync(home2, { recursive: true, force: true });
  }
});

test("child runs (port #26 task) run under the parent runtime's hooks: a pre_tool bash veto holds INSIDE the child, and post_tool/on_event see the child's calls under the child's own session", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-hooks-child-"));
  const home = mkdtempSync(join(tmpdir(), "rovecode-hooks-childhome-"));
  const savedHome = process.env.ROVECODE_HOME;
  process.env.ROVECODE_HOME = home; // pinned: never load the developer's ~/.rovecode/hooks.ts
  const goalOf = (ms: Message[]): string => { const u = ms.find((m) => m.role === "user"); return u ? partsText(u.parts) : ""; };
  const outputs = (ms: Message[]): string => ms.flatMap((m) => m.parts).filter((p): p is Extract<MessagePart, { kind: "tool_result" }> => p.kind === "tool_result").map((p) => p.output).join(" | ");
  // one scripted provider for parent and child — a run's identity is its goal (tasks-wiring idiom)
  const stream: StreamFn = async function* (_m, messages) {
    const goal = goalOf(messages); const tools = messages.filter((m) => m.role === "tool").length;
    if (goal.startsWith("PARENT")) {
      if (tools === 0) { yield { type: "turn", turn: toolTurn([{ id: "p1", tool: "task", args: { action: "start", goal: "CHILD shell", label: "sh" } }]) }; return; }
      if (tools === 1) { yield { type: "turn", turn: toolTurn([{ id: "p2", tool: "task_status", args: { action: "result", id: "t1", timeout_ms: 20_000 } }]) }; return; } // #26 fix wave split reads onto task_status
      yield { type: "turn", turn: textTurn(`PARENT-DONE: ${outputs(messages)}`) }; return;
    }
    // the child: a shell call (vetoed by the parent's hook) and a read-only ls (allowed), then report what came back
    if (tools === 0) { yield { type: "turn", turn: toolTurn([{ id: "c1", tool: "bash", args: { command: "echo CHILD-BASH-RAN" } }, { id: "c2", tool: "ls", args: {} }]) }; return; }
    yield { type: "turn", turn: textTurn(`CHILD-SAW: ${outputs(messages)}`) };
  };
  try {
    const rt = await bootRuntime({ cwd, sessionId: "sess-parent", stream });
    const preTool: string[] = []; const postTool: string[] = []; const eventSessions = new Set<string>();
    rt.hooks.add({
      pre_tool: (c, call) => { preTool.push(`${c.sessionId}:${call.tool}`); if (call.tool === "bash") return { deny: "no shell anywhere" }; },
      post_tool: (c, call) => { postTool.push(`${c.sessionId}:${call.tool}`); },
      on_event: (c, ev) => { if (ev.type === "tool_execution_start" || ev.type === "tool_call_failed") eventSessions.add(c.sessionId); },
    }, "parent-hooks");
    const def = rt.buildDef({ provider: "mock", model: "default" });
    const cfg = rt.buildCfg(true); // yolo: nothing but the hook stands between the child and its shell
    const events: RunEvent[] = [];
    for await (const ev of agentLoop(def, "PARENT delegate", {}, cfg, {
      stream, registry: rt.registry, store: rt.store, tools: rt.registry.list().map((t) => t.schema), guard: rt.guard, cwd: rt.cwd, hooks: rt.hooks,
    }, rt.steering)) events.push(ev);
    await rt.hooks.settle();
    const end = events.at(-1) as Extract<RunEvent, { type: "run_end" }>;
    expect(end).toMatchObject({ type: "run_end", status: "done" });
    expect(end.summary).toContain("CHILD-SAW: Permission denied by hook: no shell anywhere"); // the veto held INSIDE the child
    expect(end.summary).not.toContain("CHILD-BASH-RAN");
    expect(rt.tasks.status("t1")).toMatchObject({ status: "done" });
    // the hooks saw the child's calls under the CHILD's session (its own store id), not the parent's
    const childSessions = [...new Set(preTool.map((s) => s.split(":")[0]!))].filter((s) => s !== "sess-parent");
    expect(childSessions).toHaveLength(1);
    const child = childSessions[0]!;
    expect(preTool.filter((s) => s.startsWith("sess-parent:"))).toEqual(["sess-parent:task", "sess-parent:task_status"]); // start on `task`, result on `task_status` (#26 split)
    expect(preTool.filter((s) => s.startsWith(`${child}:`)).sort()).toEqual([`${child}:bash`, `${child}:ls`]);
    expect(postTool).toContain(`${child}:ls`);        // post_tool saw the child's allowed call
    expect(postTool).not.toContain(`${child}:bash`);  // a vetoed call never reaches post_tool
    expect(eventSessions).toEqual(new Set(["sess-parent", child])); // on_event tapped both runs
    expect(rt.hooks.warnings).toEqual([]);
    await rt.tasks.drain(4_000); await rt.hooks.close(); await rt.mcp?.close();
  } finally {
    if (savedHome === undefined) delete process.env.ROVECODE_HOME; else process.env.ROVECODE_HOME = savedHome;
    rmSync(cwd, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true });
  }
}, 30_000);

test("cmdRun e2e: hooks fire on the one-shot CLI path in order (session_open, pre_run, pre_tool deny, post_run, session_close); the deny reached the model; a broken user-scope file is one stderr warning", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-hooks-cli-"));
  const home = mkdtempSync(join(tmpdir(), "rovecode-hooks-clihome-"));
  const log = join(cwd, "hooks.log");
  mkdirSync(join(cwd, ".rovecode"), { recursive: true });
  writeFileSync(join(cwd, ".rovecode", "hooks.ts"), `import { appendFileSync } from "node:fs";
const mark = (s) => appendFileSync(${JSON.stringify(log)}, s + "\\n");
export default { version: 1, hooks: {
  session_open() { mark("session_open"); },
  pre_run(ctx) { mark("pre_run:" + (ctx.runId ? "with-run-id" : "NO-RUN-ID")); },
  pre_tool(_ctx, call) { mark("pre_tool:" + call.tool); return { deny: "no shell in e2e" }; },
  post_run(_ctx, r) { mark("post_run:" + r.status); },
  session_close() { mark("session_close"); },
} };
`);
  trustProjectFiles(cwd, home);
  writeFileSync(join(home, "hooks.ts"), "export default { version: 1, hooks: {\n"); // broken user-scope file → one warning
  // scripted OpenAI-compatible provider: first a bash tool call; once the tool message carries the hook's deny, finish
  const server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(req) {
      const body = await req.json() as { messages: { role: string; content?: string | null }[] };
      const denied = body.messages.some((m) => m.role === "tool" && typeof m.content === "string" && m.content.includes("Permission denied by hook: no shell in e2e"));
      if (denied) return Response.json({ choices: [{ message: { content: "DONE-E2E" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
      if (body.messages.some((m) => m.role === "tool")) return Response.json({ choices: [{ message: { content: "UNEXPECTED-TOOL-RESULT" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
      return Response.json({
        choices: [{ message: { content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "echo hi" }) } }] }, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    },
  });
  try {
    const main = join(import.meta.dir, "..", "..", "src", "cli", "main.ts");
    const env = { ...process.env, ROVECODE_BASE_URL: `http://127.0.0.1:${server.port}`, ROVECODE_API_KEY: "test-key", ROVECODE_MODEL: "scripted", ROVECODE_HOME: home } as Record<string, string>;
    delete env["ROVECODE_STREAM"]; delete env["ROVECODE_NO_HOOKS"];
    const proc = Bun.spawn([process.execPath, main, "run", "hooks e2e", "--yolo"], { cwd, env, stdout: "pipe", stderr: "pipe" });
    const exit = await proc.exited;
    const out = await new Response(proc.stdout).text();
    const err = await new Response(proc.stderr).text();
    expect(exit).toBe(0);
    expect(out).toContain("DONE-E2E"); // the provider only says this after seeing the hook's deny in the tool message
    expect(out).not.toContain("UNEXPECTED");
    expect(markers(log)).toEqual(["session_open", "pre_run:with-run-id", "pre_tool:bash", "post_run:done", "session_close"]);
    expect(err).toContain(`hooks: ${join(home, "hooks.ts")}: failed to load — `);
    expect(err.split("\n").filter((l) => l.startsWith("hooks: ")).length).toBe(1);
  } finally {
    server.stop(true);
    rmSync(cwd, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true });
  }
}, 40_000);

test("serve: runs use the server cwd's hooks; stop() fires session_close once per session runtime", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-hooks-srv-"));
  const log = markerHooks(cwd, ["pre_run", "session_close"]);
  const pong: StreamFn = async function* () { yield { type: "turn", turn: textTurn("PONG") }; };
  const srv = startServer({ port: 0, cwd, stream: pong });
  try {
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const res = await fetch(`${srv.url}/session`, { method: "POST" });
      ids.push(((await res.json()) as { id: string }).id);
    }
    const res = await fetch(`${srv.url}/session/${ids[0]}/prompt`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "hi" }) });
    expect(res.status).toBe(200);
    await res.text(); // stream closed on run_end
    expect(markers(log)).toEqual([`pre_run:${ids[0]}`]);
    await srv.stop();
    expect(markers(log).slice(1).sort()).toEqual([`session_close:${ids[0]}`, `session_close:${ids[1]}`].sort());
  } finally {
    await srv.stop().catch(() => {});
    rmSync(cwd, { recursive: true, force: true });
  }
});

class QuietClient implements Client {
  async sessionUpdate(_n: SessionNotification): Promise<void> {}
  async requestPermission(_req: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    return { outcome: { outcome: "selected", optionId: "allow-once" } };
  }
}

test("acp: shutdown() fires session_close once per session runtime (hooks of the session cwd)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-hooks-acp-"));
  const log = markerHooks(cwd, ["session_open", "session_close"]);
  const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
  const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
  const { agent } = serveAcp(ndJsonStream(agentToClient.writable, clientToAgent.readable), { stream: mockStream({ turns: [textTurn("hi")] }) });
  const conn = new ClientSideConnection(() => new QuietClient(), ndJsonStream(clientToAgent.writable, agentToClient.readable));
  try {
    await conn.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    const s1 = (await conn.newSession({ cwd, mcpServers: [] })).sessionId;
    const s2 = (await conn.newSession({ cwd, mcpServers: [] })).sessionId;
    expect(markers(log).sort()).toEqual([`session_open:${s1}`, `session_open:${s2}`].sort());
    await agent.shutdown();
    expect(markers(log).filter((m) => m.startsWith("session_close:")).sort()).toEqual([`session_close:${s1}`, `session_close:${s2}`].sort());
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
