/** Hooks v2 (port #29) WIRING tests: the typed hook set threaded through core/tools.ts dispatch
 *  (pre_tool after policy, approval before the human, post_tool after execute), core/loop.ts
 *  agentLoop (pre_run / compaction / post_run / on_event via the observer), cli/runtime.ts
 *  (.aion/hooks.ts + ~/.aion loaded at boot, session_open/close) and the surfaces (cmdRun as a
 *  subprocess against a scripted provider, serve stop(), ACP shutdown()). "Policy wins" and
 *  "fail-open to policy" are pinned here; the runner's own mechanics live in test/unit/hooks.test.ts. */

import { test, expect } from "bun:test";
import {
  ClientSideConnection, ndJsonStream, PROTOCOL_VERSION,
  type Client, type SessionNotification, type RequestPermissionRequest, type RequestPermissionResponse,
} from "@zed-industries/agent-client-protocol";
import { agentLoop, SteeringQueue } from "../../src/core/loop.ts";
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
  const dir = mkdtempSync(join(tmpdir(), "aion-hooks-w-"));
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
  mkdirSync(join(cwd, ".aion"), { recursive: true });
  const log = join(cwd, "hooks.log");
  const body = hookNames.map((h) => `${h}(ctx) { appendFileSync(${JSON.stringify(log)}, ${JSON.stringify(h + ":")} + ctx.sessionId + "\\n"); }`).join(",\n  ");
  writeFileSync(join(cwd, ".aion", "hooks.ts"), `import { appendFileSync } from "node:fs";\nexport default { version: 1, hooks: {\n  ${body},\n} };\n`);
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

test("approval hook pre-answers only a policy PROMPT with nothing cached: 'allow' runs without the human (one-shot, not cached), 'deny' denies without the human, void asks the human; allow-rules and a cached 'always' never consult it", async () => {
  const reg = new ToolRegistry(); const probe = probeTool(); reg.register(probe.tool);
  const promptRule: PermissionRule[] = [{ action: "tool.probe", resource: "*", effect: "prompt" }];
  let answer: "allow" | "deny" | undefined = "allow";
  const asked: string[] = [];
  const hooks = runner({ approval: (_c, req) => { asked.push(`hook:${req.reason}`); return answer; } });
  const human: string[] = [];
  const approve: ApprovalFn = async (req) => { human.push(req.tool); return "always"; };
  const events: RunEvent[] = [];
  // `null` = no approver (an explicit `undefined` would re-apply the default parameter)
  const go = (id: string, args: unknown, rules: PermissionRule[] = promptRule, ap: ApprovalFn | null = approve) =>
    reg.dispatch({ kind: "tool_call", id, tool: "probe", args }, dispatchCtx(), hooks, rules, ap ?? undefined, (e) => events.push(e));
  // 1. allow → executes, human not asked
  expect((await go("a1", { n: 1 })).ok).toBe(true);
  expect(human).toEqual([]); expect(probe.runs()).toBe(1);
  expect(asked).toEqual(["hook:permission required for tool.probe probe"]);
  // 2. the same call again → NOT cached: the hook is asked again (one-shot semantics)
  expect((await go("a2", { n: 1 })).ok).toBe(true);
  expect(asked.length).toBe(2); expect(human).toEqual([]);
  // 3. deny → denied without the human, hook-deny shape
  answer = "deny";
  expect(await go("a3", { n: 2 })).toEqual({ ok: false, output: "Permission denied by hook" });
  expect(events.at(-1)).toEqual({ type: "tool_call_failed", callId: "a3", reason: "permission_denied", detail: "denied by hook" });
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
  // 7. headless (no approver): hook "allow" runs the call; hook void → the old no-approver failure, unchanged
  answer = "allow";
  expect((await go("a7", { n: 10 }, promptRule, null)).ok).toBe(true);
  expect(human).toEqual(["probe"]); // still only the one human ask from step 4
  answer = undefined;
  expect(await go("a8", { n: 11 }, promptRule, null)).toEqual({ ok: false, output: "Permission denied: approval required, no approver available" });
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

test("runtime: .aion/hooks.ts (project) + ~/.aion/hooks.ts (AION_HOME) load at boot, session_open fires once each, rt.hooks reaches dispatch, close() fires session_close once; a broken file is one warning", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "aion-hooks-rt-"));
  const home = mkdtempSync(join(tmpdir(), "aion-hooks-rthome-"));
  const key = `__aionHooksRt_${process.pid}_${Date.now()}`;
  const log: unknown[] = [];
  (globalThis as Record<string, unknown>)[key] = log;
  const savedHome = process.env.AION_HOME;
  process.env.AION_HOME = home;
  try {
    mkdirSync(join(cwd, ".aion"), { recursive: true });
    writeFileSync(join(cwd, ".aion", "hooks.ts"), `const log = globalThis[${JSON.stringify(key)}];
export default { version: 1, hooks: {
  session_open(ctx) { log.push(["open", ctx.sessionId, ctx.cwd]); },
  session_close(ctx) { log.push(["close", ctx.sessionId]); },
  pre_tool(ctx, call) { log.push(["pre_tool", call.tool]); if (call.tool === "bash") return { deny: "no shell from this project" }; },
} };
`);
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
    if (savedHome === undefined) delete process.env.AION_HOME; else process.env.AION_HOME = savedHome;
    delete (globalThis as Record<string, unknown>)[key];
    rmSync(cwd, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true });
  }
  // a broken project file: the runtime still boots, hooks.warnings names the file, nothing else changes
  const cwd2 = mkdtempSync(join(tmpdir(), "aion-hooks-rt2-"));
  const home2 = mkdtempSync(join(tmpdir(), "aion-hooks-rthome2-"));
  process.env.AION_HOME = home2;
  try {
    mkdirSync(join(cwd2, ".aion"), { recursive: true });
    writeFileSync(join(cwd2, ".aion", "hooks.ts"), "export default { version: 1, hooks: {\n");
    const rt = await bootRuntime({ cwd: cwd2, stream: null });
    expect(rt.hooks.size).toBe(1); // the built-in reflection set only (port #28) — the broken file loaded nothing
    expect(rt.hooks.warnings.length).toBe(1);
    expect(rt.hooks.warnings[0]!.startsWith(`${join(cwd2, ".aion", "hooks.ts")}: failed to load — `)).toBe(true);
    await rt.hooks.close();
    await rt.mcp?.close();
  } finally {
    if (savedHome === undefined) delete process.env.AION_HOME; else process.env.AION_HOME = savedHome;
    rmSync(cwd2, { recursive: true, force: true }); rmSync(home2, { recursive: true, force: true });
  }
});

test("cmdRun e2e: hooks fire on the one-shot CLI path in order (session_open, pre_run, pre_tool deny, post_run, session_close); the deny reached the model; a broken user-scope file is one stderr warning", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "aion-hooks-cli-"));
  const home = mkdtempSync(join(tmpdir(), "aion-hooks-clihome-"));
  const log = join(cwd, "hooks.log");
  mkdirSync(join(cwd, ".aion"), { recursive: true });
  writeFileSync(join(cwd, ".aion", "hooks.ts"), `import { appendFileSync } from "node:fs";
const mark = (s) => appendFileSync(${JSON.stringify(log)}, s + "\\n");
export default { version: 1, hooks: {
  session_open() { mark("session_open"); },
  pre_run(ctx) { mark("pre_run:" + (ctx.runId ? "with-run-id" : "NO-RUN-ID")); },
  pre_tool(_ctx, call) { mark("pre_tool:" + call.tool); return { deny: "no shell in e2e" }; },
  post_run(_ctx, r) { mark("post_run:" + r.status); },
  session_close() { mark("session_close"); },
} };
`);
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
    const env = { ...process.env, AION_BASE_URL: `http://127.0.0.1:${server.port}`, AION_API_KEY: "test-key", AION_MODEL: "scripted", AION_HOME: home } as Record<string, string>;
    delete env["AION_STREAM"]; delete env["AION_NO_HOOKS"];
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
  const cwd = mkdtempSync(join(tmpdir(), "aion-hooks-srv-"));
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
  const cwd = mkdtempSync(join(tmpdir(), "aion-hooks-acp-"));
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
