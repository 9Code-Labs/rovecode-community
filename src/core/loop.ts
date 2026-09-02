/** The agent loop (ADR-003): one loop, generator-based, event-streaming.
 *  Steering drained between tool batches; follow-ups drained at stop.
 *  Errors cross the provider seam as stopReasons, never exceptions.
 *  Cancellation (port #21): ONE AbortController per run — its signal reaches
 *  the provider fetch, ToolContext.signal, and (by identity) child processes. */

import { randomUUID } from "node:crypto";
import type {
  AgentDefinition, Message, MessagePart, RunEvent, RunConfig, StreamFn,
  ModelRef, ToolCallPart, AgentVars, ToolContext, ToolOutput, ToolSchema,
  StopReason, TokenUsage,
} from "./types.ts";
import { ToolRegistry, type ExtensionHooks } from "./tools.ts";
import type { ToolGuard } from "./guardrails.ts";
import { servedBy } from "../providers/router.ts";
import { SessionStore } from "./session.ts";
import { assembleContext, estimateTokens, type ContextChunk } from "./context.ts";
import { compactionTrigger, planCompaction, applyCompaction, isContextOverflow, type CompactionCtx, type NativeCompactor } from "./compaction.ts";

export interface LoopDeps {
  stream: StreamFn;
  registry: ToolRegistry;
  store: SessionStore;
  hooks?: ExtensionHooks;
  summarize?: (texts: string[]) => Promise<string>;  // weak-model head summarizer
  /** port #25 provider-native compaction capability — set ONLY when the active provider does
   *  server-side compaction (none of aion's adapters do today; compaction.ts header) */
  compactNative?: NativeCompactor;
  tools?: ToolSchema[];
  /** orchestrator seam: run a child agent; receives parent depth + 1 */
  childRunner?: (agent: string, goal: string, vars: AgentVars | undefined, depth: number) => Promise<{ ok: boolean; summary: string; usage: TokenUsage }>;
  /** tool-loop guardrails (port #4): loop signatures + duplicate-result stubs */
  guard?: ToolGuard;
  /** ToolContext cwd for this run — surfaces with a session cwd (ACP, server)
   *  pass it here; default is the agent process dir */
  cwd?: string;
  /** mid-turn cancellation (port #21): when this aborts, the run's OWN
   *  controller aborts — the in-flight provider fetch dies, every
   *  ToolContext.signal consumer (bash subprocess trees, MCP calls) is
   *  cancelled, and the run ends with run_end status "stopped". Same seam as
   *  `cwd`: every surface already constructs LoopDeps, so one optional field
   *  keeps tui/repl/acp/serve uniform. The loop still owns the per-run
   *  controller so bare consumers that only .return() the generator
   *  (orchestrator children, cmdRun, gauntlet) keep in-flight-tool
   *  cancellation without constructing anything. */
  signal?: AbortSignal;
}

/** Synthesized output for a tool_call the abort left unanswered (opencode
 *  session/processor.ts:587 marks them "Tool execution aborted"; codex inserts
 *  a synthetic "aborted" function_call_output — context_manager/normalize.rs:51-67). */
export const ABORTED_TOOL_RESULT = "Tool execution aborted";

export class SteeringQueue {
  private queue: string[] = [];
  push(text: string): void { this.queue.push(text); }
  drainAll(): string[] { const q = this.queue; this.queue = []; return q; }
  drainOne(): string | undefined { return this.queue.shift(); }
  get size(): number { return this.queue.length; }
}

/** Deterministic toolCall part extraction + truncation safety (pi agent-loop.ts:344-380). */
export function extractToolCalls(parts: MessagePart[], stopReason: string): { calls: ToolCallPart[]; truncated: boolean } {
  const calls = parts.filter((p): p is ToolCallPart => p.kind === "tool_call");
  return { calls, truncated: stopReason === "length" };
}

/** One controller per run (port #21 bar). agentLoop is a thin wrapper so the
 *  controller's lifetime is EXACTLY the generator's: it follows deps.signal
 *  while the run lives, and the finally aborts it on ANY settle — a returned/
 *  thrown/finished run owns nothing that may keep running (fetch, tools,
 *  subprocesses all hang off this one signal).
 *  Upstream shape: opencode threads one AbortSignal per task into every model
 *  call and tool (session/llm.ts:51,136,321; session/prompt.ts:323,329 with
 *  onInterrupt → taskAbort.abort()); codex aborts the active turn task from
 *  its Op loop (core/src/tasks/mod.rs:546-591 abort_turn_if_active). */
export async function* agentLoop(
  def: AgentDefinition,
  goal: string,
  vars: AgentVars,
  cfg: RunConfig,
  deps: LoopDeps,
  steering: SteeringQueue,
  depth = 0,
  followUps?: SteeringQueue,
): AsyncGenerator<RunEvent> {
  const runAc = new AbortController();
  const follow = () => runAc.abort();
  if (deps.signal?.aborted) runAc.abort();
  else deps.signal?.addEventListener("abort", follow, { once: true });
  // port #29: run-level hooks ride the event stream (core/hooks.ts observer): pre_run / compaction /
  // post_run are awaited BEFORE the event reaches the consumer (post_run must land before a cmdRun
  // exit), on_event is a fire-and-forget tap; timeout + isolation live in the runner, never here
  const obs = deps.hooks?.observer?.({ cwd: deps.cwd ?? process.cwd(), sessionId: deps.store.id });
  try {
    for await (const ev of runLoop(def, goal, vars, cfg, deps, steering, depth, followUps, runAc)) {
      if (obs) await obs.observe(ev);
      yield ev;
    }
  } finally {
    deps.signal?.removeEventListener("abort", follow);
    runAc.abort();
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function* runLoop(
  def: AgentDefinition,
  goal: string,
  vars: AgentVars,
  cfg: RunConfig,
  deps: LoopDeps,
  steering: SteeringQueue,
  depth: number,
  followUps: SteeringQueue | undefined,
  runAc: AbortController,
): AsyncGenerator<RunEvent> {
  const runId = randomUUID();
  yield { type: "run_start", runId, sessionId: deps.store.id, goal };
  const model: ModelRef = def.model ?? { provider: "mock", model: "default" };
  const history: Message[] = [...deps.store.messages()];
  const userMsg: Message = {
    id: randomUUID(), role: "user",
    parts: [{ kind: "text", text: goal }],
    parentId: history.at(-1)?.id ?? null, createdAt: Date.now(),
  };
  deps.store.append(userMsg);
  history.push(userMsg);

  const events: RunEvent[] = [];
  const emit = (e: RunEvent) => { events.push(e); };
  const flush = function* (): Generator<RunEvent> { yield* events.splice(0, events.length); };

  // guard resets once per USER turn — one agentLoop invocation ≈ one hermes
  // run_conversation (reset_for_turn at turn_context.py:700). The `turn` loop
  // below is model iterations; resetting there would wipe the streak and make
  // the guard inert. Follow-ups are new user turns (second reset below).
  deps.guard?.onTurn();

  // port #25 emergency compaction state: an overflow rejection (error-stop block) arms ONE
  // aggressive compaction + re-drive for the next iteration; at most one re-drive per run
  let emergencyPending = false;
  let emergencyRedrives = 0;

  for (let turn = 1; turn <= cfg.maxTurns; turn++) {
    // --- abort check: an abort that landed during the previous batch (or before
    // turn 1) must not consume steering or touch the provider again
    if (runAc.signal.aborted) { yield { type: "run_end", status: "stopped", summary: "run aborted" }; return; }

    // --- steering drain point: before the model call ---
    for (const s of steering.drainAll()) {
      const sm: Message = { id: randomUUID(), role: "user", parts: [{ kind: "text", text: s }], parentId: history.at(-1)?.id ?? null, createdAt: Date.now() };
      deps.store.append(sm); history.push(sm);
      yield { type: "steer", text: s };
    }

    yield { type: "turn_start", turn };

    // --- context assembly + compaction (ADR-007; strategy seam + adaptive trigger: port #25) ---
    // counted over ALL parts (partsTokenText): tool calls/results dominate agentic histories,
    // and a text-only count would keep this trigger permanently below threshold
    const histTokens = history.reduce((n, m) => n + estimateTokens(partsTokenText(m.parts)), 0);
    // speculative: the estimate crossed budget × threshold, before this turn's provider call;
    // emergency: the previous turn was REJECTED as a context overflow (error-stop block) — plan
    // against the observed size and re-drive once (compaction.ts header: senpi/opencode cites)
    const trigger = compactionTrigger(histTokens, cfg, emergencyPending);
    emergencyPending = false; // consumed: one compaction per overflow
    if (trigger) {
      const cctx: CompactionCtx = { trigger, tokenText: (m) => partsTokenText(m.parts), summarize: deps.summarize, native: deps.compactNative, model, signal: runAc.signal };
      const plan = planCompaction(history, cfg, cctx);
      const out = plan ? await applyCompaction(history, plan, cfg, cctx) : null;
      if (out) {
        history.length = 0; history.push(...out.history);
        const ev: RunEvent = { type: "compaction", strategy: out.strategy, trigger, tokensBefore: histTokens, tokensAfter: history.reduce((n, m) => n + estimateTokens(partsTokenText(m.parts)), 0) };
        deps.store.appendEvent(ev); // real sessions carry the marker (export + replay), not just fixtures
        yield ev;
      }
    }

    const systemText = typeof def.systemPrompt === "function" ? def.systemPrompt(vars) : def.systemPrompt;
    const histNow = history.reduce((n, m) => n + estimateTokens(partsTokenText(m.parts)), 0);
    const chunks: ContextChunk[] = [
      { name: "system", text: systemText, priority: 100, tokens: estimateTokens(systemText) },
      ...(def.contextChunks ?? []), // port #8: e.g. harvested config (priority 70) — evicted before system
      { name: "history", text: "", priority: 50, tokens: histNow }, // marker; history passed directly below
    ];
    const asm = assembleContext(chunks, cfg.contextBudgetTokens);
    if (asm.dropped.length > 0) {
      const droppedTokens = asm.dropped.reduce((n, c) => n + c.tokens, 0);
      yield { type: "compaction", strategy: "context-drop", tokensBefore: asm.totalTokens + droppedTokens, tokensAfter: asm.totalTokens };
    }
    // the system message = kept non-history chunks in priority order (system first);
    // ONE prompt-assembly path — dropped chunks (e.g. config) never reach the wire
    const promptChunks = asm.chunks.filter((c) => c.name !== "history");
    const systemKept = promptChunks.length > 0;
    const promptText = promptChunks.map((c) => c.text).join("\n\n");

    // --- provider turn (never throws; errors are stopReasons) ---
    // the run signal rides into the StreamFn options: both wire adapters hand it
    // to fetch, so an abort kills the in-flight request itself (≤500ms bar)
    const msgId = randomUUID();
    let turnResult: TurnOutcome;
    const sysMsg: Message = { id: "sys", role: "system", parts: [{ kind: "text", text: promptText }], parentId: null, createdAt: 0 };
    try {
      turnResult = await collectTurn(
        deps.stream, model,
        systemKept ? [sysMsg, ...history] : history,
        (delta) => { events.push({ type: "message_update", messageId: msgId, delta }); },
        deps.tools,
        runAc.signal,
      );
    } catch (e) {
      turnResult = { parts: [], stopReason: "error", usage: { input: 0, output: 0 }, error: e instanceof Error ? e.message : String(e) };
    }
    yield* flush();
    const { parts, stopReason, usage } = turnResult;
    // --- abort landed during the provider turn: the fetch is already dead (or the
    // stream reported "aborted" itself). Keep any partial text the adapter salvaged,
    // but a tool_call in an aborted turn will never execute — append a synthesized
    // failed result for each so the NEXT request carries no orphan tool_calls
    // (codex context_manager/normalize.rs:51-67; opencode message-v2.ts:349-360
    // "Anthropic/Claude APIs require every tool_use to have a corresponding tool_result").
    const aborted = runAc.signal.aborted || stopReason === "aborted";
    const assistant: Message = {
      id: msgId, role: "assistant", parts, parentId: history.at(-1)?.id ?? null,
      // origin = the model that SERVED the turn (router fallback may differ from the one
      // asked for; /cost prices per-message via origin — port #14 HIGH-2), else the request
      createdAt: Date.now(), origin: turnResult.origin ?? model, usage,
    };
    if (!aborted || parts.length > 0) { deps.store.append(assistant); history.push(assistant); }
    yield { type: "turn_end", turn, stopReason: aborted ? "aborted" : stopReason };
    if (aborted) {
      for (const p of parts) {
        if (p.kind === "tool_call") appendToolResult(deps.store, history, p.id, { ok: false, output: ABORTED_TOOL_RESULT });
      }
      yield { type: "run_end", status: "stopped", summary: "run aborted" };
      return;
    }

    // --- error stops: the run ends in 'error', never a fake 'done' ---
    if (stopReason === "error") {
      const errText = turnResult.error ?? "provider stream failed";
      // port #25: a context-overflow rejection arms an emergency compaction (next iteration's
      // compaction block) and re-drives ONCE per run; a second overflow ends the run below
      if (isContextOverflow(errText) && emergencyRedrives === 0) { emergencyRedrives++; emergencyPending = true; continue; }
      const partial = partsText(parts);
      yield { type: "run_end", status: "error", summary: partial ? `${partial}\nerror: ${errText}` : `error: ${errText}` };
      return;
    }

    const { calls, truncated } = extractToolCalls(parts, stopReason);
    if (truncated) {
      // fail all calls unexecuted — args may be silently truncated JSON.
      // still append tool_result{ok:false} so the next provider request stays valid
      const detail = "response hit length limit; tool calls not executed";
      for (const c of calls) {
        yield { type: "tool_call_failed", callId: c.id, reason: "truncated", detail };
        appendToolResult(deps.store, history, c.id, { ok: false, output: detail });
      }
      continue;
    }
    if (calls.length === 0) {
      // --- follow-up drain point: a queued follow-up continues the run instead of ending it ---
      const follow = followUps ? followUps.drainAll() : [];
      if (follow.length > 0) {
        deps.guard?.onTurn(); // a follow-up is a new user turn (upstream: new run_conversation → reset)
        for (const f of follow) {
          const fm: Message = { id: randomUUID(), role: "user", parts: [{ kind: "text", text: f }], parentId: history.at(-1)?.id ?? null, createdAt: Date.now() };
          deps.store.append(fm); history.push(fm);
          yield { type: "steer", text: f };
        }
        continue;
      }
      yield { type: "run_end", status: "done", summary: partsText(parts) };
      return;
    }

    // --- tool execution: ctx.signal IS the run controller's signal, so the ONE
    // per-run controller reaches child processes by identity (executor G4 seam)
    const ctx: ToolContext = {
      sessionId: deps.store.id, cwd: deps.cwd ?? process.cwd(), signal: runAc.signal, runId,
      spawn: undefined, permissions: { effect: "allow" },
    };
    const runChild = deps.childRunner;
    if (runChild) {
      ctx.spawn = async (req) => {
        const r = await runChild(req.agent, req.goal, req.vars, depth + 1);
        return { agent: req.agent, ok: r.ok, summary: r.summary, usage: r.usage };
      };
    }
    let results = new Map<string, ToolOutput>();
    let batchSettled = false;
    try {
      const batch = deps.registry.dispatchBatch(calls, ctx, deps.hooks, cfg.permissionRules, cfg.approval, emit, cfg.parallelTools, deps.guard);
      // stream batch events while tools run; each yield is also a suspension
      // point where a consumer .return()/.throw() lands. A mid-batch abort
      // breaks the pump so the run settles even if a tool ignores its signal.
      let settled = false;
      void batch.then(() => { settled = true; }, () => { settled = true; });
      while (!settled && !runAc.signal.aborted) {
        await Promise.race([batch, sleep(5)]);
        if (events.length > 0) yield* flush();
      }
      // aborted mid-batch: give the killed tools one bounded beat to report their
      // real (error) outputs before results are synthesized — opencode waits the
      // same way (session/processor.ts:571-575, 250ms) before marking calls interrupted
      if (!settled && runAc.signal.aborted) await Promise.race([batch, sleep(250)]);
      if (settled) { results = await batch; batchSettled = true; }
      if (events.length > 0) yield* flush();
    } finally {
      // Every exit — normal completion, consumer .return()/.throw() at a pump
      // yield, or a mid-batch abort — leaves the store WIRE-WELL-FORMED: the
      // assistant message carrying these tool_calls is already appended, so each
      // call gets a tool_result here. Ones the batch never delivered are
      // synthesized as failed (upstream policy: codex normalize.rs:51-67,
      // opencode message-v2.ts:349-360 + processor.ts:576-593).
      if (!batchSettled) runAc.abort(); // consumer left mid-batch: kill in-flight tools + subprocess trees
      for (const c of calls) {
        appendToolResult(deps.store, history, c.id, results.get(c.id) ?? { ok: false, output: batchSettled ? "missing result" : ABORTED_TOOL_RESULT });
      }
    }
    if (runAc.signal.aborted) { yield { type: "run_end", status: "stopped", summary: "run aborted" }; return; }
  }
  yield { type: "run_end", status: "budget", summary: `max turns (${cfg.maxTurns}) reached` };
}

function appendToolResult(store: SessionStore, history: Message[], callId: string, out: { ok: boolean; output: string }): void {
  const rm: Message = {
    id: randomUUID(), role: "tool",
    parts: [{ kind: "tool_result", callId, ok: out.ok, output: out.output }],
    parentId: history.at(-1)?.id ?? null, createdAt: Date.now(),
  };
  store.append(rm); history.push(rm);
}

export interface TurnOutcome {
  parts: MessagePart[]; stopReason: StopReason; usage: TokenUsage; error?: string;
  /** model that actually SERVED the turn (router servedBy tag) — unset for unwrapped streams */
  origin?: ModelRef;
}

async function collectTurn(stream: StreamFn, model: ModelRef, messages: Message[], onText?: (delta: string) => void, tools?: ToolSchema[], signal?: AbortSignal): Promise<TurnOutcome> {
  let outcome: TurnOutcome = { parts: [], stopReason: "end_turn", usage: { input: 0, output: 0 } };
  for await (const ev of stream(model, messages, { tools, signal })) {
    if (ev.type === "text_delta") onText?.(ev.text);
    else if (ev.type === "turn") { outcome = { parts: ev.turn.parts, stopReason: ev.turn.stopReason, usage: ev.turn.usage, error: ev.turn.error, origin: servedBy(ev.turn) }; }
  }
  return outcome;
}

export function partsText(parts: MessagePart[]): string {
  return parts.filter((p) => p.kind === "text").map((p) => (p as { text: string }).text).join("");
}

/** Token-bearing text of ALL parts — text, tool_call args, tool_result outputs. Context-size
 *  accounting must see what the provider sees: a tool-heavy history counted text-only reads
 *  near zero and never trips compaction / context-health. */
export function partsTokenText(parts: MessagePart[]): string {
  return parts.map((p) =>
    p.kind === "text" ? p.text
    : p.kind === "tool_call" ? `${p.tool} ${JSON.stringify(p.args)}`
    : p.kind === "tool_result" ? p.output
    : "", // port #34 image parts carry no token text (image token cost is provider-specific; not estimated here)
  ).join("\n");
}
