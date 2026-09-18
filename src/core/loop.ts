/** The agent loop (ADR-003): one loop, generator-based, event-streaming.
 *  Steering drained between tool batches; follow-ups drained at stop.
 *  Errors cross the provider seam as stopReasons, never exceptions.
 *  Cancellation (port #21): ONE AbortController per run — its signal reaches
 *  the provider fetch, ToolContext.signal, and (by identity) child processes. */

import { randomUUID } from "node:crypto";
import type {
  AgentDefinition, Message, MessagePart, RunEvent, RunConfig, RunOutstanding, StreamEvent, StreamFn, VerifyState,
  ModelRef, ToolCallPart, AgentVars, ToolContext, ToolOutput, ToolSchema,
  StopReason, TokenUsage,
} from "./types.ts";
import { ToolRegistry, ABORTED_TOOL_RESULT, type ExtensionHooks } from "./tools.ts";
import type { ToolGuard } from "./guardrails.ts";
import { servedBy } from "../providers/router.ts";
import { SessionStore } from "./session.ts";
import { assembleContext, estimateTokens, type ContextChunk } from "./context.ts";
import { compactionTrigger, planCompaction, applyCompaction, isContextOverflow, type CompactionCtx, type NativeCompactor } from "./compaction.ts";
import { verifyClause, verifyDetail, verifyNudgeText } from "./verify-gate.ts";

export interface LoopDeps {
  stream: StreamFn;
  registry: ToolRegistry;
  store: SessionStore;
  hooks?: ExtensionHooks;
  summarize?: (texts: string[]) => Promise<string>;  // weak-model head summarizer
  /** port #25 provider-native compaction capability — set ONLY when the active provider does
   *  server-side compaction (none of rovecode's adapters do today; compaction.ts header) */
  compactNative?: NativeCompactor;
  tools?: ToolSchema[];
  /** orchestrator seam: run a child agent; receives parent depth + 1 */
  childRunner?: (agent: string, goal: string, vars: AgentVars | undefined, depth: number) => Promise<{ ok: boolean; summary: string; usage: TokenUsage }>;
  /** tool-loop guardrails (port #4): loop signatures + duplicate-result stubs */
  guard?: ToolGuard;
  /** The plan reminder: called once per turn with the history that is about to be sent, it returns a
   *  line the model should see again — the live todo list — or null. The result rides as ONE extra user
   *  message on this request only: it is never appended to `history` and never persisted, so the plan
   *  cannot pile up copies of itself in the transcript, and the system prefix (and its prompt cache)
   *  is untouched. Without it a list written 20 turns ago is buried under tool results and the model
   *  stops maintaining it. */
  planReminder?: (history: readonly Message[]) => string | null;
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
  /** the run's clock for RunConfig.maxSeconds (default Date.now) — tests inject a fake one */
  clock?: () => number;
}

/** Synthesized output for a tool_call the abort left unanswered — ONE owner, tools.ts (dispatch
 *  synthesizes the same text); re-exported here for the loop's consumers (surfaces, tests). */
export { ABORTED_TOOL_RESULT };

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
    // fix-wave 4 (#39 MED-1): the CONSUMER closed the generator before run_end (serve disconnect,
    // ACP session/cancel, TUI Esc all .return() it) — the run is over, nobody is listening, and the
    // run-level hooks would never learn it (no OTel export, no reflection sweep). This same loop's
    // teardown tells the observer once; it fires post_run with the abort shape and yields nothing
    // (ADR-003: no second loop, no fabricated event — a yielded run_end makes close() a no-op).
    if (obs) await obs.close();
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
  const runStart = history.length; // the finish check reads this run's transcript only — an aborted call from the last run is not this run's failure
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
  // aggressive compaction + re-drive for the next iteration; at most one re-drive per run. The
  // armed value is the rejected turn's run_end summary — yielded verbatim when the compaction
  // turns out to be a no-op (nothing droppable: re-driving the identical request is pointless)
  let emergencyPending: string | null = null;
  let emergencyRedrives = 0;
  const clock = deps.clock ?? Date.now;
  const startedAt = clock();
  // running spend for RunConfig.maxCostUsd (checked at the turn boundary below)
  let spentUsd = 0, unpricedTurns = 0;
  // the finish check fires at most once per run (see the "done" exit below)
  let nudged = false;
  // the verify gate's memory: the write count the last check saw, and how it ended — a model that answers the
  // failed check with prose (no new write) gets that answer represented, not a second two-minute run
  let verifiedAtWrites = -1;
  let lastVerify: VerifyState | undefined;

  for (let turn = 1; turn <= cfg.maxTurns; turn++) {
    // --- abort check: an abort that landed during the previous batch (or before
    // turn 1) must not consume steering or touch the provider again
    if (runAc.signal.aborted) { yield { type: "run_end", status: "stopped", summary: "run aborted" }; return; }
    // --- wall clock (RunConfig.maxSeconds): a turn boundary, never mid-tool, so the run ends with every
    // result it already has and the same "budget" status the turn cap uses — a spiral of short verification
    // turns ends in a result object instead of an external kill
    if (cfg.maxSeconds !== undefined && (clock() - startedAt) / 1000 >= cfg.maxSeconds) {
      yield { type: "run_end", status: "budget", summary: `wall clock (${cfg.maxSeconds}s) reached after ${turn - 1} turn${turn === 2 ? "" : "s"}` };
      return;
    }
    // --- spend cap (RunConfig.maxCostUsd): the same boundary, the same status. Priced from each turn's own
    // usage as it lands (below), so the cap is compared against dollars actually spent, never an estimate.
    // Turns the catalog cannot price add nothing; the summary says how many, so "$0.40 spent" is never read
    // as "$0.40 in total" when two turns were unpriced.
    if (cfg.maxCostUsd !== undefined && spentUsd >= cfg.maxCostUsd) {
      const unpriced = unpricedTurns > 0 ? `; ${unpricedTurns} turn${unpricedTurns === 1 ? "" : "s"} unpriced` : "";
      yield { type: "run_end", status: "budget", summary: `cost cap ($${cfg.maxCostUsd.toFixed(2)}) reached after ${turn - 1} turn${turn === 2 ? "" : "s"} — $${spentUsd.toFixed(4)} spent${unpriced}` };
      return;
    }

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
    const trigger = compactionTrigger(histTokens, cfg, emergencyPending !== null);
    const overflowSummary = emergencyPending;
    emergencyPending = null; // consumed: one compaction per overflow
    if (trigger) {
      const cctx: CompactionCtx = { trigger, tokenText: (m) => partsTokenText(m.parts), summarize: deps.summarize, native: deps.compactNative, model, signal: runAc.signal };
      const plan = planCompaction(history, cfg, cctx);
      const out = plan ? await applyCompaction(history, plan, cfg, cctx) : null;
      if (out) {
        history.length = 0; history.push(...out.history);
        const ev: RunEvent = { type: "compaction", strategy: out.strategy, trigger, tokensBefore: histTokens, tokensAfter: history.reduce((n, m) => n + estimateTokens(partsTokenText(m.parts)), 0) };
        deps.store.appendEvent(ev); // real sessions carry the marker (export + replay), not just fixtures
        yield ev;
      } else if (overflowSummary !== null) {
        // emergency with nothing droppable (a fresh session whose single turn overflows): the
        // re-drive would repeat the rejected request byte-for-byte — end with the provider's error
        yield { type: "run_end", status: "error", summary: overflowSummary };
        return;
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
      // request-only: appended to what goes on the wire, never to `history` or the store
      const reminder = deps.planReminder?.(history) ?? null;
      const withReminder: Message[] = reminder === null
        ? history
        : [...history, { id: `reminder-${turn}`, role: "user", parts: [{ kind: "text", text: reminder }], parentId: history.at(-1)?.id ?? null, createdAt: Date.now() }];
      // deltas yield LIVE, one RunEvent each, while the provider streams. The old shape awaited the
      // whole turn and flushed the buffered message_updates afterwards — a generator cannot yield
      // from a callback — so a 15 s reasoning phase (claude-opus-5 at --effort high, measured) put
      // nothing on screen and read as a hang. Order is unchanged: every delta still precedes turn_end.
      // the run's deadline rides into the provider call so a retry backoff cannot overshoot the clock the turn boundary enforces
      const live = collectTurn(deps.stream, model, systemKept ? [sysMsg, ...withReminder] : withReminder, deps.tools, runAc.signal, cfg.maxSeconds !== undefined ? startedAt + cfg.maxSeconds * 1000 : undefined);
      let reasoning = ""; // the reasoning text stays here: only its estimated size leaves the loop
      for (;;) {
        const step = await live.next();
        if (step.done) { turnResult = step.value; break; }
        if (step.value.type === "text_delta") yield { type: "message_update", messageId: msgId, delta: step.value.text };
        else { reasoning += step.value.text; yield { type: "reasoning_update", messageId: msgId, tokens: estimateTokens(reasoning) }; }
      }
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
    if (cfg.maxCostUsd !== undefined && (usage.input > 0 || usage.output > 0 || (usage.cacheRead ?? 0) > 0 || (usage.cacheWrite ?? 0) > 0)) {
      const c = cfg.priceUsd?.(usage, assistant.origin ?? model);
      if (c === undefined) unpricedTurns++; else spentUsd += c;
    }
    if (!aborted || parts.length > 0) { deps.store.append(assistant); history.push(assistant); }
    yield { type: "turn_end", turn, stopReason: aborted ? "aborted" : stopReason };
    if (aborted) {
      for (const p of parts) {
        if (p.kind === "tool_call") appendToolResult(deps.store, history, p.id, { ok: false, output: ABORTED_TOOL_RESULT });
      }
      yield { type: "run_end", status: "stopped", summary: "run aborted" };
      return;
    }

    // Error/budget turns can contain salvaged calls from custom streams. They must never execute,
    // but every persisted call still needs a result so a later resume is wire-well-formed.
    if (stopReason === "error" || stopReason === "budget") {
      for (const p of parts) if (p.kind === "tool_call") {
        appendToolResult(deps.store, history, p.id, { ok: false, output: `Tool not executed: provider ${stopReason}` });
      }
    }
    if (stopReason === "budget") {
      yield { type: "run_end", status: "budget", summary: partsText(parts) || "provider budget reached" };
      return;
    }
    // --- error stops: the run ends in 'error', never a fake 'done' ---
    if (stopReason === "error") {
      const errText = turnResult.error ?? "provider stream failed";
      const partial = partsText(parts);
      const summary = partial ? `${partial}\nerror: ${errText}` : `error: ${errText}`;
      // port #25: a context-overflow rejection arms an emergency compaction (next iteration's
      // compaction block) and re-drives ONCE per run — only while a turn is left to re-drive in
      // (on the last permitted turn the run ends HERE with the provider's text, not as "budget");
      // a second overflow ends the run below
      if (isContextOverflow(errText) && emergencyRedrives === 0 && turn < cfg.maxTurns) { emergencyRedrives++; emergencyPending = summary; continue; }
      yield { type: "run_end", status: "error", summary };
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
      // --- the "done" exit. This is the ONLY path to status "done", and until now its whole condition was
      // "this turn had no tool call" — the model's silence, ratified as completion. A write that failed, an
      // ask_user nobody answered, a run that changed nothing: all ended here as "done", exit 0, and no
      // surface could tell them from finished work (found 2026-09-06: "Done — I created src/a.ts" after the
      // write was rejected). Two things now happen here, and they are separate:
      //   1. REPRESENT: run_end carries `outstanding` — what the transcript says was left (assessOutstanding).
      //      Unconditional, so a surface can always say "done · 1 tool call failed in the last turn".
      //   2. NUDGE, once per run, on evidence the transcripts actually contain (a failed tool call in the last
      //      turn, an unanswered question — never "no files changed", which is what every answered question
      //      looks like): one user-role turn naming exactly what is open and asking the model to finish it or
      //      say why it is not needed. Both are acceptable answers. The next silence is accepted whatever it
      //      says: a loop that will not stop is worse than one that stops early. The nudge is a turn like any
      //      other — the turn, clock and cost ceilings above apply to it, so a spent budget ends as "budget".
      const outstanding = assessOutstanding(history.slice(runStart), cfg.todoState?.() ?? null, nudged);
      if (cfg.finishCheck !== false && !nudged && (outstanding.failed.length > 0 || outstanding.unansweredAsk)) {
        nudged = true;
        const text = finishCheckText(outstanding);
        const fm: Message = { id: randomUUID(), role: "user", parts: [{ kind: "text", text }], parentId: history.at(-1)?.id ?? null, createdAt: Date.now() };
        deps.store.append(fm); history.push(fm);
        yield { type: "steer", text };
        continue;
      }
      // --- the verify gate (core/verify-gate.ts): a run that wrote files runs the project's own check before it
      // may end "done". Composition with the finish check above is one flag, not two: whichever fires first takes
      // the run's single extra turn; if the finish check already fired, the gate still RUNS and represents, but
      // never asks again. Nothing configured → nothing runs, and run_end says so ("not verified") rather than
      // letting an unchecked change look finished. Nothing written → the gate is not consulted at all.
      if (cfg.verify !== undefined && outstanding.writes > 0) {
        const gate = cfg.verify;
        const refused = gate.resolution?.refused && gate.resolution.refused.length > 0 ? { refused: gate.resolution.refused } : {};
        if (gate.resolution === null || gate.resolution.commands.length === 0) {
          outstanding.verify = { state: "unconfigured", ...(gate.resolution?.reason ? { reason: gate.resolution.reason } : {}), ...refused };
        } else if (outstanding.writes === verifiedAtWrites && lastVerify !== undefined) {
          outstanding.verify = lastVerify; // nothing written since that check: its verdict stands, it is not re-run
        } else {
          yield { type: "verify", command: gate.resolution.commands.join(" && "), state: "running" };
          const r = await gate.run(runAc.signal);
          if (runAc.signal.aborted) { yield { type: "run_end", status: "stopped", summary: "run aborted" }; return; }
          verifiedAtWrites = outstanding.writes;
          const state: VerifyState = r.ok ? { state: "passed", command: r.command, ms: r.ms, ...refused }
            : r.timedOut ? { state: "timeout", command: r.command, seconds: Math.round(gate.timeoutMs / 1000), ...refused }
            : { state: "failed", command: r.command, code: r.code, failure: r.failure, ...refused };
          lastVerify = state;
          yield { type: "verify", command: r.command, state: state.state, ms: r.ms, detail: verifyDetail(r) };
          if (!r.ok && !nudged) {
            nudged = true;
            const text = verifyNudgeText(r, gate.timeoutMs);
            const fm: Message = { id: randomUUID(), role: "user", parts: [{ kind: "text", text }], parentId: history.at(-1)?.id ?? null, createdAt: Date.now() };
            deps.store.append(fm); history.push(fm);
            yield { type: "steer", text };
            continue;
          }
          outstanding.verify = state;
        }
      }
      // attached only when there IS something to say: a run that answered a question (no files, no failures) ends
      // byte-identical to before — "no files changed" is what every answered question looks like, not a finding
      const notable = outstanding.failed.length > 0 || outstanding.unansweredAsk || (outstanding.todosOpen ?? 0) > 0 || outstanding.nudged || outstanding.verify !== undefined;
      yield { type: "run_end", status: "done", summary: partsText(parts), ...(notable ? { outstanding } : {}) };
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

/** What the transcript says the run left behind, read at the "done" exit. `failed`/`unansweredAsk` look at
 *  the LAST turn that had tool calls — the one right before the final text — because that is the failure
 *  the model walked away from; an earlier failure it went on to retry is not outstanding. `writes` counts
 *  successful edit/write calls over the whole run. Pure over the history: no disk, no model. */
export function assessOutstanding(history: readonly Message[], todos: { open: number; total: number } | null, nudged: boolean): RunOutstanding {
  type Call = Extract<MessagePart, { kind: "tool_call" }>;
  const results = new Map<string, { ok: boolean; output: string }>();
  for (const m of history) if (m.role === "tool") for (const p of m.parts) if (p.kind === "tool_result") results.set(p.callId, { ok: p.ok, output: p.output });
  const describe = (c: Call, output: string): string => `${c.tool}: ${(output.split("\n")[0] ?? "").slice(0, 160)}`;
  const pathOf = (c: Call): string | null => { const a = c.args as { path?: unknown; file_path?: unknown } | null; const v = a?.path ?? a?.file_path; return typeof v === "string" ? v : null; };
  let writes = 0;
  let lastCalls: Call[] = [];
  // a file the model tried to change and never managed to: a failed edit/write to a path with no later successful
  // edit/write to the same path. Found in the scripted proof — write fails, todo_write marks the item completed,
  // "Done": the failure was one turn before the last, masked by bookkeeping, and "last turn only" let it through
  const unrecovered = new Map<string, string>();
  for (const m of history) {
    if (m.role !== "assistant") continue;
    const calls = m.parts.filter((p): p is Call => p.kind === "tool_call");
    if (calls.length === 0) continue;
    lastCalls = calls;
    for (const c of calls) {
      if (c.tool !== "edit" && c.tool !== "write") continue;
      const r = results.get(c.id); const path = pathOf(c) ?? c.id;
      if (r?.ok === true) { writes++; unrecovered.delete(path); }
      else if (r && !harnessVerdict(r.output)) unrecovered.set(path, describe(c, r.output));
    }
  }
  const failed = [...unrecovered.values()];
  let unansweredAsk = false;
  for (const c of lastCalls) {
    const r = results.get(c.id);
    if (r === undefined || r.ok) continue;
    if (c.tool === "ask_user") { unansweredAsk = true; continue; }
    if (harnessVerdict(r.output)) continue;
    const d = describe(c, r.output);
    if (!failed.includes(d)) failed.push(d);
  }
  return { failed, unansweredAsk, writes, ...(todos && todos.total > 0 ? { todosOpen: todos.open, todosTotal: todos.total } : {}), nudged };
}
/** ok:false results that are the harness's or the user's decision, not the model's failure: a permission denial,
 *  the loop guard's stub (it TOLD the model to stop repeating), an abort. Nudging "continue" past any of these would
 *  argue with the thing that stopped the call. */
function harnessVerdict(output: string): boolean {
  return output.startsWith("Permission denied") || output.includes("loop guard: blocked") || output.startsWith(ABORTED_TOOL_RESULT);
}
export function finishCheckText(o: RunOutstanding): string {
  const lines = ["<finish-check>", "You stopped, but this run is not in a finished state — this is a check by the harness, not a message from the user."];
  for (const f of o.failed) lines.push(`- a tool call failed and nothing after it recovered from that: ${f}`);
  if (o.unansweredAsk) lines.push("- your question to the user was not answered (there is no one to answer it in this run); decide with your best judgment instead of waiting");
  if ((o.todosOpen ?? 0) > 0) lines.push(`- your own todo list still has ${o.todosOpen} of ${o.todosTotal} items open`);
  lines.push("Either continue and finish the work now, or say plainly what is left undone and why it is not needed. This check runs once per run; your next reply ends it either way.", "</finish-check>");
  return lines.join("\n");
}

/** The one clause a surface appends to "done" — null when there is nothing a person needs to act on.
 *  "no files changed" is deliberately NOT here: every answered question looks like that, and a warning that
 *  fires on "what MCPs are configured" trains people to stop reading it. Headless text mode adds it itself,
 *  where a one-shot run that changed nothing is the whole complaint. */
export function outstandingClause(o: RunOutstanding): string | null {
  const parts: string[] = [];
  if (o.failed.length > 0) parts.push(`${o.failed.length} failed tool call${o.failed.length === 1 ? "" : "s"} not recovered (${[...new Set(o.failed.map((f) => f.split(":")[0]))].join(", ")})`);
  if (o.unansweredAsk) parts.push("its question to you went unanswered");
  if ((o.todosOpen ?? 0) > 0) parts.push(`${o.todosOpen} of ${o.todosTotal} items still open`);
  if (o.verify !== undefined) parts.push(verifyClause(o.verify));
  return parts.length > 0 ? parts.join(" · ") : null;
}
/** how a surface should colour the clause: a passed check is information, everything else is a warning */
export function outstandingTone(o: RunOutstanding): "info" | "warn" {
  const onlyPassed = o.failed.length === 0 && !o.unansweredAsk && (o.todosOpen ?? 0) === 0 && o.verify?.state === "passed";
  return onlyPassed ? "info" : "warn";
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

/** Drive one provider turn: yields the text and reasoning deltas as they arrive (the caller turns
 *  them into RunEvents), returns the terminal turn as the outcome. tool_call_delta is not surfaced. */
async function* collectTurn(stream: StreamFn, model: ModelRef, messages: Message[], tools?: ToolSchema[], signal?: AbortSignal, deadlineAt?: number): AsyncGenerator<Extract<StreamEvent, { type: "text_delta" | "reasoning_delta" }>, TurnOutcome> {
  let outcome: TurnOutcome | undefined;
  let text = "";
  let error = "provider stream ended without a terminal turn";
  try {
    for await (const ev of stream(model, messages, { tools, signal, ...(deadlineAt !== undefined ? { deadlineAt } : {}) })) {
      if (ev.type === "text_delta" || ev.type === "reasoning_delta") {
        if (ev.type === "text_delta") text += ev.text;
        yield ev;
      } else if (ev.type === "turn") {
        outcome = { parts: ev.turn.parts, stopReason: ev.turn.stopReason, usage: ev.turn.usage, error: ev.turn.error, origin: servedBy(ev.turn) };
      }
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
    // A throw after a provisional terminal event also invalidates that turn's tool calls.
    outcome = undefined;
  }
  if (!outcome) return { parts: text ? [{ kind: "text", text }] : [], stopReason: signal?.aborted ? "aborted" : "error", usage: { input: 0, output: 0 }, error };
  if (outcome.stopReason === "tool_use" && !outcome.parts.some((p) => p.kind === "tool_call")) {
    return { ...outcome, stopReason: "error", error: "provider requested tool use without any tool calls" };
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
