/** The agent loop (ADR-003): one loop, generator-based, event-streaming.
 *  Steering drained between tool batches; follow-ups drained at stop.
 *  Errors cross the provider seam as stopReasons, never exceptions. */

import { randomUUID } from "node:crypto";
import type {
  AgentDefinition, Message, MessagePart, RunEvent, RunConfig, StreamFn,
  ModelRef, ToolCallPart, AgentVars, ToolContext, ToolOutput, ToolSchema,
  StopReason, TokenUsage,
} from "./types.ts";
import { ToolRegistry, type ExtensionHooks } from "./tools.ts";
import { SessionStore } from "./session.ts";
import { assembleContext, planCompaction, estimateTokens, type ContextChunk } from "./context.ts";

export interface LoopDeps {
  stream: StreamFn;
  registry: ToolRegistry;
  store: SessionStore;
  hooks?: ExtensionHooks;
  summarize?: (texts: string[]) => Promise<string>;  // weak-model head summarizer
  tools?: ToolSchema[];
  /** orchestrator seam: run a child agent; receives parent depth + 1 */
  childRunner?: (agent: string, goal: string, vars: AgentVars | undefined, depth: number) => Promise<{ ok: boolean; summary: string; usage: TokenUsage }>;
}

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

  for (let turn = 1; turn <= cfg.maxTurns; turn++) {
    // --- steering drain point: before the model call ---
    for (const s of steering.drainAll()) {
      const sm: Message = { id: randomUUID(), role: "user", parts: [{ kind: "text", text: s }], parentId: history.at(-1)?.id ?? null, createdAt: Date.now() };
      deps.store.append(sm); history.push(sm);
      yield { type: "steer", text: s };
    }

    yield { type: "turn_start", turn };

    // --- context assembly + compaction (ADR-007) ---
    const histTokens = history.reduce((n, m) => n + estimateTokens(partsText(m.parts)), 0);
    if (histTokens > cfg.contextBudgetTokens * cfg.compactionThreshold && deps.summarize) {
      const plan = planCompaction(history.map((m) => ({ id: m.id, tokens: estimateTokens(partsText(m.parts)), text: partsText(m.parts) })), cfg.contextBudgetTokens);
      const summary = await deps.summarize(plan.summarize.map((m) => m.text));
      const compactMsg: Message = {
        id: randomUUID(), role: "system",
        parts: [{ kind: "text", text: `Summary of earlier conversation:\n${summary}` }],
        parentId: history[0]?.id ?? null, createdAt: Date.now(),
      };
      // plan.keep holds {id,tokens,text} projections — map back to the real messages
      const keepIds = new Set(plan.keep.map((k) => k.id));
      const kept = history.filter((m) => keepIds.has(m.id));
      history.length = 0; history.push(compactMsg, ...kept);
      yield { type: "compaction", strategy: "head-summarize", tokensBefore: histTokens, tokensAfter: history.reduce((n, m) => n + estimateTokens(partsText(m.parts)), 0) };
    }

    const systemText = typeof def.systemPrompt === "function" ? def.systemPrompt(vars) : def.systemPrompt;
    const histNow = history.reduce((n, m) => n + estimateTokens(partsText(m.parts)), 0);
    const chunks: ContextChunk[] = [
      { name: "system", text: systemText, priority: 100, tokens: estimateTokens(systemText) },
      { name: "history", text: "", priority: 50, tokens: histNow }, // marker; history passed directly below
    ];
    const asm = assembleContext(chunks, cfg.contextBudgetTokens);
    if (asm.dropped.length > 0) {
      const droppedTokens = asm.dropped.reduce((n, c) => n + c.tokens, 0);
      yield { type: "compaction", strategy: "context-drop", tokensBefore: asm.totalTokens + droppedTokens, tokensAfter: asm.totalTokens };
    }
    const systemKept = asm.chunks.some((c) => c.name === "system");

    // --- provider turn (never throws; errors are stopReasons) ---
    const msgId = randomUUID();
    let turnResult: TurnOutcome;
    const sysMsg: Message = { id: "sys", role: "system", parts: [{ kind: "text", text: systemText }], parentId: null, createdAt: 0 };
    try {
      turnResult = await collectTurn(
        deps.stream, model,
        systemKept ? [sysMsg, ...history] : history,
        (delta) => { events.push({ type: "message_update", messageId: msgId, delta }); },
        deps.tools,
      );
    } catch (e) {
      turnResult = { parts: [], stopReason: "error", usage: { input: 0, output: 0 }, error: e instanceof Error ? e.message : String(e) };
    }
    yield* flush();
    const { parts, stopReason, usage } = turnResult;
    const assistant: Message = {
      id: msgId, role: "assistant", parts, parentId: history.at(-1)?.id ?? null,
      createdAt: Date.now(), origin: model, usage,
    };
    deps.store.append(assistant);
    history.push(assistant);
    yield { type: "turn_end", turn, stopReason };

    // --- error stops: the run ends in 'error', never a fake 'done' ---
    if (stopReason === "error") {
      const errText = turnResult.error ?? "provider stream failed";
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
        const rm: Message = {
          id: randomUUID(), role: "tool",
          parts: [{ kind: "tool_result", callId: c.id, ok: false, output: detail }],
          parentId: history.at(-1)?.id ?? null, createdAt: Date.now(),
        };
        deps.store.append(rm); history.push(rm);
      }
      continue;
    }
    if (calls.length === 0) {
      // --- follow-up drain point: a queued follow-up continues the run instead of ending it ---
      const follow = followUps ? followUps.drainAll() : [];
      if (follow.length > 0) {
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

    // --- tool execution with steering preserved via abort signals ---
    const ac = new AbortController();
    const ctx: ToolContext = {
      sessionId: deps.store.id, cwd: process.cwd(), signal: ac.signal,
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
    try {
      const batch = deps.registry.dispatchBatch(calls, ctx, deps.hooks, cfg.permissionRules, cfg.approval, emit, cfg.parallelTools);
      // stream batch events while tools run; each yield is also a suspension
      // point where a consumer .return()/.throw() lands and triggers the abort
      let settled = false;
      void batch.then(() => { settled = true; }, () => { settled = true; });
      while (!settled) {
        await Promise.race([batch, new Promise<void>((r) => setTimeout(r, 5))]);
        if (events.length > 0) yield* flush();
      }
      results = await batch;
      yield* flush();
    } finally {
      // cooperative abort: any exit from the batch region (normal completion,
      // consumer .return()/.throw()) cancels in-flight tools via the signal
      ac.abort();
    }
    for (const c of calls) {
      const out = results.get(c.id) ?? { ok: false, output: "missing result" };
      const rm: Message = {
        id: randomUUID(), role: "tool",
        parts: [{ kind: "tool_result", callId: c.id, ok: out.ok, output: out.output }],
        parentId: history.at(-1)?.id ?? null, createdAt: Date.now(),
      };
      deps.store.append(rm); history.push(rm);
    }
  }
  yield { type: "run_end", status: "budget", summary: `max turns (${cfg.maxTurns}) reached` };
}

export interface TurnOutcome { parts: MessagePart[]; stopReason: StopReason; usage: { input: number; output: number }; error?: string }

async function collectTurn(stream: StreamFn, model: ModelRef, messages: Message[], onText?: (delta: string) => void, tools?: ToolSchema[]): Promise<TurnOutcome> {
  let outcome: TurnOutcome = { parts: [], stopReason: "end_turn", usage: { input: 0, output: 0 } };
  for await (const ev of stream(model, messages, { tools })) {
    if (ev.type === "text_delta") onText?.(ev.text);
    else if (ev.type === "turn") { outcome = { parts: ev.turn.parts, stopReason: ev.turn.stopReason, usage: ev.turn.usage, error: ev.turn.error }; }
  }
  return outcome;
}

export function partsText(parts: MessagePart[]): string {
  return parts.filter((p) => p.kind === "text").map((p) => (p as { text: string }).text).join("");
}
