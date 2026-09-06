/** PORT #21 — mid-turn cancellation. One AbortController per run threads
 *  loop → provider fetch → ToolContext.signal → child processes.
 *
 *  Bar items pinned here (each test names its mutation target):
 *  - Esc/abort mid-stream kills the in-flight fetch and the run settles ≤500ms
 *  - abort mid-bash: the shell's remaining side effects never happen
 *  - post-abort history is wire-well-formed through toOpenAiMessages
 *    (issued-but-unanswered tool_calls get synthesized failed results —
 *    codex context_manager/normalize.rs:51-67, opencode message-v2.ts:349-360)
 *  - the next run on the same session works (post-abort next-turn OK)
 *  - abort mid-fallback stops the router chain (no further candidates)
 *  - TUI Esc aborts for real (surface e2e through the pi renderer)
 *  Round-2 (critic HIGH-1 / MED-2):
 *  - abort mid-bash kills the TREE on Windows (job object): the tagged msys
 *    `sleep` the shell was waiting on is gone, not just the shell
 *  - an aborted sequential batch never starts (or prompts for) its queued
 *    calls; they persist as the aborted synthesis */

import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { agentLoop, SteeringQueue, partsText, ABORTED_TOOL_RESULT, type LoopDeps } from "../../src/core/loop.ts";
import { ToolRegistry, ABORTED_TOOL_RESULT as TOOLS_ABORTED_RESULT } from "../../src/core/tools.ts";
import { SessionStore } from "../../src/core/session.ts";
import { openaiCompatStreaming, toOpenAiMessages, mockStream, textTurn, toolTurn } from "../../src/providers/stream.ts";
import { createRouter } from "../../src/providers/router.ts";
import { bashTool } from "../../src/coding/hashline.ts";
import { VirtualTerminal } from "../../vendor/pi-tui/test/virtual-terminal.ts";
import { PiTuiRenderer } from "../../src/tui/pi-renderer.ts";
import { runTui } from "../../src/tui/app.ts";
import type {
  AgentDefinition, Message, ModelRef, PermissionRule, RunConfig, RunEvent,
  StreamEvent, StreamFn, StreamOptions, Tool,
} from "../../src/core/types.ts";

// ---------- Windows tree-kill probes: a tagged msys `sleep` findable via Win32_Process ----------
// msys `sleep` on purpose: after its exec the forked bash stub is gone, so
// `taskkill /T` (live parent links) never reaches it — a native child would
// die under taskkill alone and prove nothing about the job object.
const isWin = process.platform === "win32";
const sleepTag = () => "600." + String(Math.floor(Math.random() * 1e9)).padStart(9, "0");
async function taggedSleeps(tag: string): Promise<number[]> {
  const ps = Bun.spawn(["powershell", "-NoProfile", "-Command",
    `(Get-CimInstance Win32_Process -Filter "Name='sleep.exe' AND CommandLine LIKE '%${tag}%'").ProcessId`],
    { stdout: "pipe", stderr: "pipe" });
  const text = await new Response(ps.stdout).text();
  await ps.exited;
  return text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).map(Number);
}
async function killTagged(tag: string): Promise<void> {
  for (const pid of await taggedSleeps(tag)) await Bun.spawn(["taskkill", "/F", "/PID", String(pid)], { stdout: "ignore", stderr: "ignore" }).exited;
}
/** poll (≤ms) until no tagged sleep is alive; returns the survivors */
async function survivors(tag: string, ms: number): Promise<number[]> {
  const deadline = Date.now() + ms;
  let alive = await taggedSleeps(tag);
  while (alive.length > 0 && Date.now() < deadline) { await sleep(150); alive = await taggedSleeps(tag); }
  return alive;
}
/** the child must be RUNNING before the abort — a kill landing before the fork would pass vacuously */
async function untilRunning(tag: string): Promise<void> {
  const t0 = Date.now();
  let n = 0;
  while ((n = (await taggedSleeps(tag)).length) === 0 && Date.now() - t0 < 8000) await sleep(50);
  expect(n).toBeGreaterThan(0);
}

const allowAll = [{ action: "*", resource: "*", effect: "allow" as const }];

function cfg(over: Partial<RunConfig> = {}): RunConfig {
  return {
    maxTurns: 8, contextBudgetTokens: 100_000, compactionThreshold: 0.8,
    parallelTools: true,
    permissionRules: allowAll, ...over,
  };
}

const baseDef: AgentDefinition = {
  name: "t", systemPrompt: "test agent", tools: ["*"], maxTurns: 8,
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function collect(gen: AsyncGenerator<RunEvent>): Promise<RunEvent[]> {
  const evs: RunEvent[] = [];
  for await (const ev of gen) evs.push(ev);
  return evs;
}

function runEnd(evs: RunEvent[]): { status: string; summary: string } | null {
  const last = evs.at(-1);
  return last?.type === "run_end" ? { status: last.status, summary: last.summary } : null;
}

/** Orphan tool_calls in the WIRE shape: every assistant tool_calls id must be
 *  answered by a following role:"tool" entry (providers 400 otherwise). */
function orphanCallIds(messages: Message[]): string[] {
  const wire = toOpenAiMessages(messages);
  const answered = new Set(
    wire.filter((m) => m.role === "tool").map((m) => m.tool_call_id as string),
  );
  const orphans: string[] = [];
  for (const m of wire) {
    for (const c of (m.tool_calls as { id: string }[] | undefined) ?? []) {
      if (!answered.has(c.id)) orphans.push(c.id);
    }
  }
  return orphans;
}

/** StreamFn that parks until ITS OWN options.signal aborts, then yields an
 *  aborted turn — only a REAL controller abort can release it, so a surface
 *  that merely .return()s the generator hangs the test instead of passing.
 *  Later calls answer immediately (post-abort next-turn probes). */
function parkedUntilAbort(): { stream: StreamFn; seen: Promise<AbortSignal> } {
  let seenR!: (s: AbortSignal) => void;
  const seen = new Promise<AbortSignal>((r) => { seenR = r; });
  let calls = 0;
  const stream: StreamFn = async function* (_m: ModelRef, _msgs: Message[], options?: StreamOptions): AsyncGenerator<StreamEvent> {
    if (++calls > 1) { yield { type: "turn", turn: textTurn("RESUMED-FINE") }; return; }
    const sig = options?.signal;
    if (sig) {
      seenR(sig);
      if (!sig.aborted) await new Promise<void>((r) => sig.addEventListener("abort", () => r(), { once: true }));
      yield { type: "turn", turn: { parts: [], stopReason: "aborted", usage: { input: 0, output: 0 } } };
      return;
    }
    // no signal threaded (mutation): park forever — the test times out
    await new Promise<void>(() => {});
  };
  return { stream, seen };
}

// ---------- mid-stream: the in-flight fetch dies ≤500ms after abort ----------

test("abort mid-SSE-stream kills the REAL fetch: run settles <500ms, server sees the abort, partial text survives", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-abort-"));
  let firstChunkSent!: () => void;
  const firstChunk = new Promise<void>((r) => { firstChunkSent = r; });
  const sawAbort = { value: false };
  const enc = new TextEncoder();
  // slow OpenAI-compatible SSE endpoint: 80 chunks × 50ms ≈ 4s of streaming.
  // Mutation target: drop `signal` from the loop's stream() options (collectTurn)
  // → the fetch runs to completion → settle takes ~4s → the <500ms assert fails.
  const server = Bun.serve({
    port: 0,
    idleTimeout: 0,
    fetch(req) {
      req.signal.addEventListener("abort", () => { sawAbort.value = true; });
      const body = new ReadableStream<Uint8Array>({
        async start(c) {
          try {
            for (let i = 0; i < 80; i++) {
              c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: `chunk${i} ` } }] })}\n\n`));
              if (i === 0) firstChunkSent();
              await sleep(50);
            }
            c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`));
            c.enqueue(enc.encode("data: [DONE]\n\n"));
            c.close();
          } catch { /* client gone mid-stream — expected on abort */ }
        },
      });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    },
  });
  try {
    const store = new SessionStore(dir, randomUUID());
    const stream = openaiCompatStreaming({ baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: "k" });
    const ac = new AbortController();
    const done = collect(agentLoop(baseDef, "go", {}, cfg(), {
      stream, registry: new ToolRegistry(), store, signal: ac.signal,
    }, new SteeringQueue()));
    await firstChunk;
    await sleep(150); // let the client buffer a few chunks (partial-salvage assert below)
    const t0 = Date.now();
    ac.abort();
    const evs = await done;
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(500); // bar: mid-stream kill ≤500ms
    expect(runEnd(evs)?.status).toBe("stopped");
    expect(evs.some((e) => e.type === "turn_end" && e.stopReason === "aborted")).toBe(true);
    // the fetch was REALLY killed at the server, not just abandoned client-side
    for (let i = 0; i < 20 && !sawAbort.value; i++) await sleep(25);
    expect(sawAbort.value).toBe(true);
    // partial assistant text salvaged into the session (SSE adapter abort path)
    const assistant = store.messages().filter((m) => m.role === "assistant").at(-1);
    expect(assistant).toBeDefined();
    expect(partsText(assistant!.parts)).toContain("chunk0");
    expect(orphanCallIds(store.messages())).toEqual([]);
  } finally {
    await server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
}, 15_000);

// ---------- mid-bash: the subprocess dies, its later side effects never land ----------

test("abort mid-bash kills the shell AND the child it waits on: pending side effects never happen, the tagged sleep is gone (Windows), run ends stopped, history wire-well-formed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-abort-bash-"));
  const tag = sleepTag();
  try {
    const store = new SessionStore(dir, randomUUID());
    const reg = new ToolRegistry();
    reg.register(bashTool);
    const startTxt = join(dir, "start.txt");
    const doneTxt = join(dir, "done.txt");
    // Windows: a 600s msys sleep — the grandchild `taskkill /T` alone never
    // reached (critic HIGH-1: it survived and held stdout). POSIX: sleep 2, so
    // a SURVIVING shell would write done.txt inside the window checked below.
    const hold = isWin ? `sleep ${tag}` : "sleep 2";
    // signal-DEAF scripted stream: if the loop kept going after the abort it
    // would fetch turn 2 ("late") and end "done" — the "stopped" assert below
    // also kills a deleted top-of-turn abort check.
    const stream = mockStream({
      turns: [
        toolTurn([{ id: "b1", tool: "bash", args: { command: `echo started > "${startTxt}"; ${hold}; echo done > "${doneTxt}"` } }]),
        textTurn("late"),
      ],
    });
    const ac = new AbortController();
    const done = collect(agentLoop(baseDef, "go", {}, cfg(), {
      stream, registry: reg, store, cwd: dir, signal: ac.signal,
    }, new SteeringQueue()));
    // wait for the shell to prove it is running, then abort — NO .return():
    // the mutation `ctx.signal ≠ run controller signal` must fail this test,
    // and a consumer-return would mask it via the batch-exit abort.
    const t0 = Date.now();
    while (!existsSync(startTxt) && Date.now() - t0 < 4000) await sleep(20);
    expect(existsSync(startTxt)).toBe(true);
    if (isWin) await untilRunning(tag);
    const tAbort = Date.now();
    ac.abort();
    const evs = await done;
    expect(Date.now() - tAbort).toBeLessThan(1500); // kill + bounded 250ms grace + settle
    expect(runEnd(evs)?.status).toBe("stopped");
    if (isWin) {
      // the TREE died, not just the shell: the sleep the shell was waiting on
      // is gone (a shell-only kill leaves it running for 600s)
      expect(await survivors(tag, 3000)).toEqual([]);
    } else {
      // wait past the point where a SURVIVING shell would have written done.txt
      await sleep(Math.max(0, tAbort + 2600 - Date.now()));
    }
    // the killed shell never reached its second side effect (a shell that
    // outlived a killed sleep would have written it immediately)
    expect(existsSync(doneTxt)).toBe(false);
    // the issued call has an answer in the store (real killed-exit output or
    // the synthesized one) and the wire shape carries no orphans
    const toolMsgs = store.messages().filter((m) => m.role === "tool");
    expect(toolMsgs.length).toBe(1);
    const part = toolMsgs[0]!.parts[0]!;
    if (part.kind === "tool_result") { expect(part.callId).toBe("b1"); expect(part.ok).toBe(false); }
    else throw new Error("expected tool_result part");
    expect(orphanCallIds(store.messages())).toEqual([]);
  } finally {
    if (isWin) await killTagged(tag);
    rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);

// ---------- MED-2: an aborted sequential batch never starts its queued calls ----------

test("abort mid-batch (sequential [bash, prompt-gated tool]): the queued call is never started or prompted for; it persists as the aborted synthesis", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-abort-batch-"));
  const tag = sleepTag();
  try {
    const store = new SessionStore(dir, randomUUID());
    const reg = new ToolRegistry();
    reg.register(bashTool);
    const secondTxt = join(dir, "second.txt");
    let executed = 0;
    const mark: Tool = {
      schema: { name: "mark", description: "writes a marker file", args: { type: "object" } },
      kind: "custom", async execute() { executed++; writeFileSync(secondTxt, "ran"); return { ok: true, output: "wrote" }; },
    };
    reg.register(mark);
    // bash is allowed outright; the queued call needs a human. A post-abort
    // prompt for it IS the detached-work bug — mutation target: the
    // ctx.signal.aborted check in dispatchBatch's sequential loop (without it
    // the approver is asked for b1 after the run has ended; the dispatch-level
    // re-check would still stop the execution, so `prompts` is the discriminator)
    const rules: PermissionRule[] = [
      { action: "shell.exec", resource: "*", effect: "allow" },
      { action: "tool.mark", resource: "*", effect: "prompt" },
    ];
    let prompts = 0;
    const approval = async () => { prompts++; return "once" as const; };
    const startTxt = join(dir, "start.txt");
    const hold = isWin ? `sleep ${tag}` : "sleep 2";
    const stream = mockStream({
      turns: [
        toolTurn([
          { id: "a1", tool: "bash", args: { command: `echo started > "${startTxt}"; ${hold}` } },
          { id: "b1", tool: "mark", args: {} },
        ]),
        textTurn("late"),
      ],
    });
    const ac = new AbortController();
    const done = collect(agentLoop(baseDef, "go", {}, cfg({ permissionRules: rules, approval }), {
      stream, registry: reg, store, cwd: dir, signal: ac.signal,
    }, new SteeringQueue()));
    const t0 = Date.now();
    while (!existsSync(startTxt) && Date.now() - t0 < 4000) await sleep(20);
    expect(existsSync(startTxt)).toBe(true);
    ac.abort();
    const evs = await done;
    expect(runEnd(evs)?.status).toBe("stopped");
    // give a wrongly-started b1 every chance to land: the killed bash settles
    // inside the runner's 500ms grace while the loop returns after 250ms
    await sleep(800);
    expect(prompts).toBe(0);
    expect(executed).toBe(0);
    expect(existsSync(secondTxt)).toBe(false);
    expect(evs.some((e) => e.type === "tool_execution_start" && e.callId === "b1")).toBe(false);
    const results = new Map<string, { ok: boolean; output: string }>();
    for (const m of store.messages()) {
      if (m.role !== "tool") continue;
      for (const p of m.parts) if (p.kind === "tool_result") results.set(p.callId, { ok: p.ok, output: p.output });
    }
    expect(results.get("a1")?.ok).toBe(false);
    expect(results.get("b1")).toEqual({ ok: false, output: ABORTED_TOOL_RESULT });
    expect(TOOLS_ABORTED_RESULT).toBe(ABORTED_TOOL_RESULT); // one owner (tools.ts); loop.ts re-exports it
    expect(orphanCallIds(store.messages())).toEqual([]);
  } finally {
    if (isWin) await killTagged(tag);
    rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);

// ---------- consumer .return() mid-batch: synthesized results, no orphans ----------

test("consumer .return() mid-batch synthesizes failed results for issued calls (no orphan tool_calls)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-abort-syn-"));
  try {
    const store = new SessionStore(dir, randomUUID());
    const reg = new ToolRegistry();
    const parked: Tool = {
      schema: { name: "parked", description: "parks until aborted", args: { type: "object" } },
      kind: "custom", async execute(_args, ctx) {
        await new Promise<void>((r) => {
          if (ctx.signal.aborted) return r();
          ctx.signal.addEventListener("abort", () => r(), { once: true });
        });
        return { ok: true, output: "too late" };
      },
    };
    reg.register(parked);
    const stream = mockStream({ turns: [toolTurn([{ id: "p1", tool: "parked", args: {} }]), textTurn("late")] });
    const gen = agentLoop(baseDef, "go", {}, cfg(), { stream, registry: reg, store }, new SteeringQueue());
    for await (const ev of gen) {
      if (ev.type === "tool_execution_start") break; // .return() lands mid-batch
    }
    // the store answered the dangling call with the synthesized abort result
    // (mutation target: the batch-finally append — deleting it orphans p1)
    const toolMsgs = store.messages().filter((m) => m.role === "tool");
    expect(toolMsgs.length).toBe(1);
    const part = toolMsgs[0]!.parts[0]!;
    if (part.kind === "tool_result") {
      expect(part.callId).toBe("p1");
      expect(part.ok).toBe(false);
      expect(part.output).toBe(ABORTED_TOOL_RESULT);
    } else throw new Error("expected tool_result part");
    expect(orphanCallIds(store.messages())).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- abort racing a COMPLETE tool_use turn: calls stored + synthesized ----------

test("abort landing with a complete tool_use turn: calls are never executed, results synthesized", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-abort-race-"));
  try {
    const store = new SessionStore(dir, randomUUID());
    const reg = new ToolRegistry();
    let executed = 0;
    const probe: Tool = {
      schema: { name: "probe", description: "probe", args: { type: "object" } },
      kind: "custom", async execute() { executed++; return { ok: true, output: "ran" }; },
    };
    reg.register(probe);
    // yields a COMPLETE tool_use turn, but only after the signal aborted — the
    // exact shape of an abort racing the end of a provider turn
    const stream: StreamFn = async function* (_m: ModelRef, _msgs: Message[], options?: StreamOptions): AsyncGenerator<StreamEvent> {
      const sig = options!.signal!;
      if (!sig.aborted) await new Promise<void>((r) => sig.addEventListener("abort", () => r(), { once: true }));
      yield { type: "turn", turn: toolTurn([{ id: "r1", tool: "probe", args: {} }]) };
    };
    const ac = new AbortController();
    const done = collect(agentLoop(baseDef, "go", {}, cfg(), {
      stream, registry: reg, store, signal: ac.signal,
    }, new SteeringQueue()));
    await sleep(30);
    ac.abort();
    const evs = await done;
    expect(runEnd(evs)?.status).toBe("stopped");
    expect(executed).toBe(0); // an aborted run never dispatches the batch
    const toolMsgs = store.messages().filter((m) => m.role === "tool");
    expect(toolMsgs.length).toBe(1);
    const part = toolMsgs[0]!.parts[0]!;
    if (part.kind === "tool_result") { expect(part.callId).toBe("r1"); expect(part.output).toBe(ABORTED_TOOL_RESULT); }
    else throw new Error("expected tool_result part");
    expect(orphanCallIds(store.messages())).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- post-abort next-turn OK ----------

test("post-abort next-turn OK: the next run on the same session completes and its request is wire-well-formed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-abort-next-"));
  try {
    const store = new SessionStore(dir, randomUUID());
    const reg = new ToolRegistry();
    const parked: Tool = {
      schema: { name: "parked", description: "parks until aborted", args: { type: "object" } },
      kind: "custom", async execute(_args, ctx) {
        await new Promise<void>((r) => ctx.signal.addEventListener("abort", () => r(), { once: true }));
        return { ok: true, output: "too late" };
      },
    };
    reg.register(parked);
    // run 1: aborted mid-batch (fresh controller, abort + return like the surfaces do)
    const stream1 = mockStream({ turns: [toolTurn([{ id: "a1", tool: "parked", args: {} }])] });
    const ac1 = new AbortController();
    const gen1 = agentLoop(baseDef, "first", {}, cfg(), { stream: stream1, registry: reg, store, signal: ac1.signal }, new SteeringQueue());
    for await (const ev of gen1) {
      if (ev.type === "tool_execution_start") { ac1.abort(); void gen1.return(undefined as never); }
    }
    // run 2: NEW controller, same store — must see a valid history and finish
    const requests: Message[][] = [];
    const stream2: StreamFn = async function* (_m: ModelRef, msgs: Message[]): AsyncGenerator<StreamEvent> {
      requests.push([...msgs]);
      yield { type: "turn", turn: textTurn("second answer") };
    };
    const evs = await collect(agentLoop(baseDef, "second", {}, cfg(), {
      stream: stream2, registry: reg, store, signal: new AbortController().signal,
    }, new SteeringQueue()));
    expect(runEnd(evs)?.status).toBe("done");
    expect(runEnd(evs)?.summary).toBe("second answer");
    // the request the NEXT turn actually sent has no orphan tool_calls
    expect(requests.length).toBe(1);
    expect(orphanCallIds(requests[0]!)).toEqual([]);
    expect(orphanCallIds(store.messages())).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- pre-aborted signal: the provider is never touched ----------

test("pre-aborted deps.signal: run ends stopped without a provider call", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-abort-pre-"));
  try {
    const store = new SessionStore(dir, randomUUID());
    let calls = 0;
    const stream: StreamFn = async function* (): AsyncGenerator<StreamEvent> {
      calls++;
      yield { type: "turn", turn: textTurn("should never stream") };
    };
    const ac = new AbortController();
    ac.abort();
    const evs = await collect(agentLoop(baseDef, "go", {}, cfg(), {
      stream, registry: new ToolRegistry(), store, signal: ac.signal,
    }, new SteeringQueue()));
    expect(runEnd(evs)?.status).toBe("stopped");
    expect(calls).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- abort mid-fallback stops the router chain ----------

test("abort mid-fallback stops the chain: no further candidate after the aborted one", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-abort-router-"));
  try {
    const store = new SessionStore(dir, randomUUID());
    const m = (model: string): ModelRef => ({ provider: "p", model });
    let reached2!: () => void;
    const atSecond = new Promise<void>((r) => { reached2 = r; });
    const seen: string[] = [];
    const base: StreamFn = async function* (model: ModelRef, _msgs: Message[], options?: StreamOptions): AsyncGenerator<StreamEvent> {
      seen.push(model.model);
      if (model.model === "one") {
        yield { type: "turn", turn: { parts: [], stopReason: "error", usage: { input: 0, output: 0 }, error: "HTTP 500: down" } };
        return;
      }
      if (model.model === "two") {
        reached2();
        const sig = options!.signal!;
        if (!sig.aborted) await new Promise<void>((r) => sig.addEventListener("abort", () => r(), { once: true }));
        // a killed fetch surfaces as a retryable-SHAPED error; only the abort
        // guard (options.signal.aborted) may stop the advance to "three"
        yield { type: "turn", turn: { parts: [], stopReason: "error", usage: { input: 0, output: 0 }, error: "HTTP 500: killed mid-flight" } };
        return;
      }
      yield { type: "turn", turn: textTurn("three answered") };
    };
    const router = createRouter({ roles: { default: [m("one"), m("two"), m("three")] } });
    const ac = new AbortController();
    const done = collect(agentLoop({ ...baseDef, model: m("one") }, "go", {}, cfg(), {
      stream: router.wrap(base), registry: new ToolRegistry(), store, signal: ac.signal,
    }, new SteeringQueue()));
    await atSecond; // candidate one failed, candidate two is in flight
    ac.abort();
    const evs = await done;
    expect(seen).toEqual(["one", "two"]); // the chain NEVER advanced to "three"
    expect(runEnd(evs)?.status).toBe("stopped");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- loop-owned controller: bare .return() still cancels (no deps.signal) ----------

test("no deps.signal: consumer .return() still aborts in-flight tools via the loop-owned controller", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-abort-bare-"));
  try {
    const store = new SessionStore(dir, randomUUID());
    const reg = new ToolRegistry();
    let observed: AbortSignal | undefined;
    const parked: Tool = {
      schema: { name: "parked", description: "parks until aborted", args: { type: "object" } },
      kind: "custom", async execute(_args, ctx) {
        observed = ctx.signal;
        await new Promise<void>((r) => ctx.signal.addEventListener("abort", () => r(), { once: true }));
        return { ok: true, output: "released" };
      },
    };
    reg.register(parked);
    const stream = mockStream({ turns: [toolTurn([{ id: "q1", tool: "parked", args: {} }]), textTurn("late")] });
    const deps: LoopDeps = { stream, registry: reg, store }; // NO signal — orchestrator/cmdRun shape
    const gen = agentLoop(baseDef, "go", {}, cfg(), deps, new SteeringQueue());
    for await (const ev of gen) {
      if (ev.type === "tool_execution_start") break;
    }
    expect(observed?.aborted).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- TUI surface: Esc aborts the run's controller for real ----------

test("TUI Esc mid-run: the run controller aborts (parked provider turn released) and the run settles stopped", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-abort-tui-"));
  const term = new VirtualTerminal(80, 24);
  const renderer = new PiTuiRenderer({ terminal: term, cwd });
  const { stream, seen } = parkedUntilAbort();
  const app = runTui({ renderer, stream, cwd, yolo: true, exitOnClose: false, model: "scripted" });
  const until = async (pred: (s: string) => boolean, ms = 8000): Promise<string> => {
    const deadline = Date.now() + ms;
    let text = "";
    while (Date.now() < deadline) {
      text = (await term.flushAndGetViewport()).join("\n");
      if (pred(text)) return text;
      await sleep(25);
    }
    return text;
  };
  try {
    term.sendInput("park this run");
    term.sendInput("\r");
    await until((s) => s.includes("park this run"));
    await seen; // the provider turn is in flight, parked on ITS signal
    term.sendInput("\x1b"); // Esc → onInterrupt → runAbort.abort() + run.return()
    const noted = await until((s) => s.includes("run interrupted"));
    expect(noted).toContain("run interrupted");
    expect((await seen).aborted).toBe(true); // the run's controller REALLY aborted
    // …and the run actually SETTLED (busy cleared): a new submission starts a
    // fresh run instead of queueing as steering. Only a real abort releases the
    // parked stream — mutations (drop the abort from onInterrupt, or the signal
    // from the TUI's LoopDeps) leave the app busy and this times out.
    term.sendInput("run again");
    term.sendInput("\r");
    const screen = await until((s) => s.includes("RESUMED-FINE"));
    expect(screen).toContain("RESUMED-FINE");
  } finally {
    term.sendInput("\x03");
    await app;
    rmSync(cwd, { recursive: true, force: true });
  }
}, 20_000);
