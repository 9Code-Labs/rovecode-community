/** Port #25: compaction strategy seam + adaptive trigger + persisted marker.
 *  Each strategy is pinned discriminatingly (head-summarize summarizes the head once and keeps
 *  the tail; keep-window never summarizes, respects N, never orphans a tool pair; provider-
 *  native uses the advertised double and falls back when absent/declining), the trigger
 *  boundary is pinned at exactly-threshold vs one-over, the emergency path is driven through
 *  agentLoop with a scripted overflow (one compaction, one re-drive, then a hard stop), and
 *  SessionStore.appendEvent's annotation semantics are pinned incl. reload. */

import { test, expect, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  compactionTrigger, planCompaction, applyCompaction, keepWindow, isContextOverflow,
  parseCompactionStrategy, planningBudget, DEFAULT_KEEP_TURNS, type CompactionCtx, type NativeCompactor,
} from "../../src/core/compaction.ts";
import { agentLoop, SteeringQueue, partsTokenText } from "../../src/core/loop.ts";
import { estimateTokens } from "../../src/core/context.ts";
import { SessionStore } from "../../src/core/session.ts";
import { ToolRegistry } from "../../src/core/tools.ts";
import { textTurn } from "../../src/providers/stream.ts";
import { createRuntime } from "../../src/cli/runtime.ts";
import type { AgentDefinition, AssistantTurn, Message, ModelRef, RunConfig, RunEvent, StreamEvent, StreamFn } from "../../src/core/types.ts";

// ---------- fixtures ----------

let seq = 0;
function msg(role: Message["role"], parts: Message["parts"], id = `m${++seq}`): Message {
  return { id, role, parts, parentId: null, createdAt: 0 };
}
const user = (text: string, id?: string) => msg("user", [{ kind: "text", text }], id);
const asst = (text: string, id?: string) => msg("assistant", [{ kind: "text", text }], id);
const call = (callId: string, tool: string, text = "", id?: string) =>
  msg("assistant", [...(text ? [{ kind: "text" as const, text }] : []), { kind: "tool_call" as const, id: callId, tool, args: {} }], id);
const result = (callId: string, output: string, id?: string) => msg("tool", [{ kind: "tool_result", callId, ok: true, output }], id);
const tokenText = (m: Message) => partsTokenText(m.parts);
const toks = (m: Message) => estimateTokens(tokenText(m));

function cfg(over: Partial<RunConfig> = {}): RunConfig {
  return {
    maxTurns: 8, contextBudgetTokens: 100, compactionThreshold: 0.5, parallelTools: true,
    permissionRules: [{ action: "*", resource: "*", effect: "allow" }], ...over,
  };
}
function ctx(over: Partial<CompactionCtx> = {}): CompactionCtx { return { trigger: "speculative", tokenText, ...over }; }

/** Every tool_result in `kept` has its tool_call in `kept`, and every tool_call its result. */
function pairsIntact(kept: Message[]): boolean {
  const calls = new Set(kept.flatMap((m) => m.parts.flatMap((p) => (p.kind === "tool_call" ? [p.id] : []))));
  const results = new Set(kept.flatMap((m) => m.parts.flatMap((p) => (p.kind === "tool_result" ? [p.callId] : []))));
  return [...results].every((c) => calls.has(c)) && [...calls].every((c) => results.has(c));
}

// ---------- trigger ----------

test("trigger boundary: AT budget×threshold nothing fires; one token over is speculative; an overflow is an emergency whatever the estimate", () => {
  const c = cfg({ contextBudgetTokens: 100, compactionThreshold: 0.5 });
  expect(compactionTrigger(49, c, false)).toBeNull();
  expect(compactionTrigger(50, c, false)).toBeNull();          // exactly at threshold: strict >
  expect(compactionTrigger(51, c, false)).toBe("speculative");
  expect(compactionTrigger(0, c, true)).toBe("emergency");     // provider said so; the estimate is moot
  expect(compactionTrigger(51, c, true)).toBe("emergency");
});

// ---------- head-summarize ----------

test("head-summarize: one summarize call over the head texts; the tail is kept as the SAME message objects behind the summary", async () => {
  // 6 × 25 tokens = 150 over a 100 window → aider plan keeps a tail ≤ 50 (the last two)
  const history = Array.from({ length: 6 }, (_, i) => (i % 2 === 0 ? user : asst)(String.fromCharCode(97 + i).repeat(100)));
  const calls: string[][] = [];
  const c = ctx({ summarize: async (texts) => { calls.push(texts); return "SUMMARY"; } });
  const conf = cfg({ contextBudgetTokens: 100 });
  const plan = planCompaction(history, conf, c)!;
  expect(plan.strategy).toBe("head-summarize");
  expect(plan.summaryNeeded).toBe(true);
  expect(plan.fallbackFrom).toBeUndefined();
  expect(plan.tokensBefore).toBe(150);
  expect(plan.keep).toEqual([history[4]!, history[5]!]);
  expect(plan.drop.map((m) => m.id)).toEqual(history.slice(0, 4).map((m) => m.id));
  const out = (await applyCompaction(history, plan, conf, c))!;
  expect(out.strategy).toBe("head-summarize");
  expect(calls.length).toBe(1);
  expect(calls[0]).toEqual(history.slice(0, 4).map(tokenText));   // the summarizer saw exactly the head
  expect(out.history.length).toBe(3);
  expect(out.history[0]!.role).toBe("system");
  expect(tokenText(out.history[0]!)).toBe("Summary of earlier conversation:\nSUMMARY");
  expect(out.history[1]).toBe(history[4]);   // identity: real messages, never projections
  expect(out.history[2]).toBe(history[5]);
});

test("head-summarize never plans an EMPTY tail: when the last message alone exceeds half the budget it is kept anyway (the summary is never persisted — an empty tail would orphan the next assistant)", async () => {
  const history = [user("hi"), user("g".repeat(1000))];   // 1 + 250 tokens; window 100 → the aider tail cap (50) holds nothing
  const summarize = async () => "S";
  const plan = planCompaction(history, cfg({ contextBudgetTokens: 100 }), ctx({ summarize }))!;
  expect(plan.strategy).toBe("head-summarize");
  expect(plan.keep).toEqual([history[1]!]);                 // the last real message survives, over cap
  expect(plan.drop).toEqual([history[0]!]);
  const out = (await applyCompaction(history, plan, cfg({ contextBudgetTokens: 100 }), ctx({ summarize })))!;
  expect(out.history.at(-1)).toBe(history[1]);              // the next assistant parents on a REAL message
  // the emergency budget (observed/2 → cap 62) squeezes harder still — the tail is still never empty
  const em = planCompaction(history, cfg({ contextBudgetTokens: 100_000 }), ctx({ summarize, trigger: "emergency" }))!;
  expect(em.strategy).toBe("head-summarize");
  expect(em.keep).toEqual([history[1]!]);
  // a forced tail that is a tool result drags its calling assistant along (a wire-valid pair, as keepWindow)
  const traffic = [user("go"), call("c1", "big"), result("c1", "R".repeat(400))];   // 1 + 2 + 100 tokens
  const tp = planCompaction(traffic, cfg({ contextBudgetTokens: 100 }), ctx({ summarize }))!;
  expect(tp.keep.map((m) => m.id)).toEqual([traffic[1]!.id, traffic[2]!.id]);
  expect(tp.drop).toEqual([traffic[0]!]);
  expect(pairsIntact(tp.keep)).toBe(true);
});

// ---------- keep-window ----------

test("keep-window: never calls summarize; keeps the last N user turns plus the current one; deterministic marker first", async () => {
  const history = [user("U1"), asst("A1"), user("U2"), asst("A2"), user("U3"), asst("A3"), user("U4"), asst("A4")];
  let summarized = 0;
  const c = ctx({ summarize: async () => { summarized++; return "NOPE"; } });
  for (const [n, firstKept, dropped] of [[1, "U3", 4], [0, "U4", 6], [2, "U2", 2]] as const) {
    const conf = cfg({ contextBudgetTokens: 100_000, compactionStrategy: "keep-window", compactionKeepTurns: n });
    const plan = planCompaction(history, conf, c)!;
    expect(plan.strategy).toBe("keep-window");
    expect(plan.summaryNeeded).toBe(false);
    expect(plan.drop.length).toBe(dropped);
    expect(tokenText(plan.keep[0]!)).toBe(firstKept);
    const out = (await applyCompaction(history, plan, conf, c))!;
    expect(out.strategy).toBe("keep-window");
    expect(out.history[0]!.role).toBe("system");
    expect(tokenText(out.history[0]!)).toContain(`(keep-window): ${dropped} earlier messages`);
    expect(out.history.slice(1)).toEqual(plan.keep);
  }
  expect(summarized).toBe(0);
  // N unset → DEFAULT_KEEP_TURNS previous turns
  const dflt = planCompaction(history, cfg({ contextBudgetTokens: 100_000, compactionStrategy: "keep-window" }), c)!;
  expect(dflt.drop.length).toBe(8 - 2 * (DEFAULT_KEEP_TURNS + 1));
  // nothing droppable → no-op (no marker, the loop yields no event)
  const tiny = [user("U1"), asst("A1")];
  const noop = planCompaction(tiny, cfg({ contextBudgetTokens: 100_000, compactionStrategy: "keep-window" }), c)!;
  expect(noop.drop.length).toBe(0);
  expect(await applyCompaction(tiny, noop, cfg({ compactionStrategy: "keep-window" }), c)).toBeNull();
});

test("keep-window never orphans a tool pair: a token cut inside the current turn drops call + result together and keeps the user's request", () => {
  // current turn alone: U1(1) A1(52: text + call c1) T1(1) A2(2) T2(1) A3(1) = 58 tokens; cap = 10
  const history = [user("go"), call("c1", "big", "X".repeat(200)), result("c1", "rrrr"), call("c2", "small"), result("c2", "ok"), asst("done")];
  const { keep, drop } = keepWindow(history, toks, 20, 2);
  expect(pairsIntact(keep)).toBe(true);
  expect(keep.map((m) => m.id)).toEqual([history[0]!.id, history[3]!.id, history[4]!.id, history[5]!.id]);
  expect(drop.map((m) => m.id)).toEqual([history[1]!.id, history[2]!.id]);   // A1 and ITS result leave together
  expect(keep[0]!.role).toBe("user");                                          // the request survives the cut
  // turn-level cuts land on user messages: pairs across earlier turns stay whole too
  const multi = [user("U0"), call("c0", "t"), result("c0", "r".repeat(400)), user("U1"), call("c1", "t"), result("c1", "ok")];
  const w = keepWindow(multi, toks, 40, 2); // 108 tokens vs cap 20 → shrink to the current turn
  expect(pairsIntact(w.keep)).toBe(true);
  expect(w.keep.map(tokenText)[0]).toBe("U1");
  expect(w.drop.length).toBe(3);
});

test("keep-window keeps a calling assistant with its results when only results remain after the cut (over cap is accepted over an orphan)", () => {
  const history = [user("U0"), asst("A0"), user("U1"), call("c1", "t"), result("c1", "R".repeat(400))];
  const { keep, drop } = keepWindow(history, toks, 20, 0);
  expect(pairsIntact(keep)).toBe(true);
  expect(keep.map((m) => m.id)).toEqual(history.slice(2).map((m) => m.id));   // U1 + A1 + T1 stay
  expect(drop.map((m) => m.id)).toEqual(history.slice(0, 2).map((m) => m.id));
  // no user turn at all (foreign history): message-level cut, pairs still intact
  const foreign = [asst("a".repeat(100)), call("c1", "t"), result("c1", "b".repeat(100)), asst("z")];
  const f = keepWindow(foreign, toks, 20, 2);
  expect(pairsIntact(f.keep)).toBe(true);
  expect(f.keep.map(tokenText)).toEqual(["z"]);
});

// ---------- provider-native ----------

test("provider-native: delegates to the advertised capability (summarize untouched); absent → head-summarize fallback; declining/throwing → local fallback", async () => {
  const history = [user("a".repeat(100)), asst("b".repeat(100)), user("c".repeat(100)), asst("d".repeat(100))];
  const conf = cfg({ contextBudgetTokens: 100, compactionStrategy: "provider-native" });
  let nativeCalls = 0; let summarized = 0;
  const replacement = [asst("server-side compacted"), history[3]!];
  const nativeOk: NativeCompactor = async (h, opts) => {
    nativeCalls++;
    expect(h).toBe(history);
    expect(opts).toMatchObject({ trigger: "speculative", budgetTokens: 100, model: { provider: "p", model: "m" } });
    return replacement;
  };
  const summarize = async () => { summarized++; return "S"; };
  const c = ctx({ native: nativeOk, model: { provider: "p", model: "m" }, summarize });
  const plan = planCompaction(history, conf, c)!;
  expect(plan).toMatchObject({ strategy: "provider-native", summaryNeeded: false });
  expect(plan.fallbackFrom).toBeUndefined();
  const out = (await applyCompaction(history, plan, conf, c))!;
  expect(out.strategy).toBe("provider-native");
  expect(out.history).toBe(replacement);
  expect(nativeCalls).toBe(1);
  expect(summarized).toBe(0);
  // no capability (every rovecode adapter today): the plan falls back and records where from
  const noNative = ctx({ summarize });
  const plan2 = planCompaction(history, conf, noNative)!;
  expect(plan2).toMatchObject({ strategy: "head-summarize", fallbackFrom: "provider-native", summaryNeeded: true });
  const out2 = (await applyCompaction(history, plan2, conf, noNative))!;
  expect(out2).toMatchObject({ strategy: "head-summarize", fallbackFrom: "provider-native" });
  expect(summarized).toBe(1);
  // declines at apply time (null) → local fallback, exactly one summarize
  const declining = ctx({ native: async () => null, summarize });
  const plan3 = planCompaction(history, conf, declining)!;
  expect(plan3.strategy).toBe("provider-native");
  const out3 = (await applyCompaction(history, plan3, conf, declining))!;
  expect(out3).toMatchObject({ strategy: "head-summarize", fallbackFrom: "provider-native" });
  expect(summarized).toBe(2);
  // throws → same as declining, never escapes the seam
  const throwing = ctx({ native: async () => { throw new Error("endpoint down"); }, summarize });
  expect((await applyCompaction(history, planCompaction(history, conf, throwing)!, conf, throwing))!.strategy).toBe("head-summarize");
});

test("no summarizer: speculative compaction stays off (pre-#25 gate); an emergency still shrinks via the deterministic window", () => {
  const history = [user("U1"), asst("A1"), user("U2"), asst("A2")];
  expect(planCompaction(history, cfg(), ctx())).toBeNull();
  expect(planCompaction(history, cfg({ compactionStrategy: "provider-native" }), ctx())).toBeNull();
  const em = planCompaction(history, cfg(), ctx({ trigger: "emergency" }))!;
  expect(em).toMatchObject({ strategy: "keep-window", fallbackFrom: "head-summarize", summaryNeeded: false });
  expect(em.keep.map(tokenText)).toEqual(["U2", "A2"]);   // an emergency keeps 0 previous turns
  const pn = planCompaction(history, cfg({ compactionStrategy: "provider-native" }), ctx({ trigger: "emergency" }))!;
  expect(pn).toMatchObject({ strategy: "keep-window", fallbackFrom: "provider-native" });
});

// ---------- emergency budget ----------

test("emergency plans against the OBSERVED size: a history a speculative pass keeps whole loses at least three quarters", () => {
  const history = Array.from({ length: 10 }, (_, i) => (i % 2 === 0 ? user : asst)("z".repeat(100)));   // 250 tokens
  const conf = cfg({ contextBudgetTokens: 100_000, compactionThreshold: 0.8 });   // estimate far below the window
  const summarize = async () => "S";
  expect(planningBudget(conf, 250, "speculative")).toBe(100_000);
  expect(planningBudget(conf, 250, "emergency")).toBe(125);
  expect(planningBudget(cfg({ contextBudgetTokens: 100 }), 250, "emergency")).toBe(50);   // never above half the window
  const spec = planCompaction(history, conf, ctx({ summarize }))!;
  expect(spec.drop.length).toBe(0);   // aider plan under 80% of the window: nothing to summarize
  const em = planCompaction(history, conf, ctx({ summarize, trigger: "emergency" }))!;
  expect(em.budgetTokens).toBe(125);
  expect(em.keep.length).toBe(2);
  expect(em.drop.length).toBe(8);
  expect(em.keep.reduce((n, m) => n + toks(m), 0)).toBeLessThanOrEqual(250 / 4);
});

// ---------- overflow detection ----------

test("isContextOverflow: provider overflow phrasings and 413 count; 429/5xx/transport/other 400s do not — also behind the router's exhausted-chain rewrite", () => {
  for (const s of [
    'HTTP 400: {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 213462 tokens > 200000 maximum"}}',
    "HTTP 400: This model's maximum context length is 128000 tokens. However, your messages resulted in 130000 tokens.",
    'HTTP 400: {"error":{"code":"context_length_exceeded","message":"..."}}',
    "HTTP 413: request entity too large",
    "HTTP 400: too many tokens",
    "input is too long for requested model",
    // router.ts wraps the last candidate's error: an overflow stays an overflow behind the prefix
    "model chain 'default' exhausted (2 candidates failed); last: HTTP 413: request entity too large",
    "model chain 'default' exhausted (2 candidates failed); last: HTTP 400: prompt is too long: 213462 tokens > 200000 maximum",
  ]) expect(isContextOverflow(s)).toBe(true);
  for (const s of [
    "HTTP 429: too many requests", "HTTP 429: rate limit exceeded, too many tokens per minute",
    "HTTP 500: internal error: too many tokens", "HTTP 503: service unavailable",
    "HTTP 400: invalid api key", "HTTP 401: unauthorized", "fetch failed", "", undefined,
    // the retry classes stay non-overflow inside the exhausted-chain rewrite too: a 5xx/429 body that
    // mentions tokens used to slip past the `^HTTP` anchor → phrase match → one spurious emergency compaction
    "model chain 'default' exhausted (2 candidates failed); last: HTTP 500: internal error: too many tokens",
    "model chain 'smol' exhausted (1 candidate failed); last: HTTP 529: overloaded; maximum context length",
    "model chain 'default' exhausted (3 candidates failed); last: HTTP 429: token limit exceeded for this minute",
  ]) expect(isContextOverflow(s)).toBe(false);
});

// ---------- config surface ----------

test("parseCompactionStrategy + ROVECODE_COMPACTION: known names (any case) select the RunConfig strategy in buildCfg; unknown → head-summarize + ONE stderr note; unset/blank → head-summarize silently", () => {
  const spy = spyOn(console, "error").mockImplementation(() => {});
  const prev = process.env.ROVECODE_COMPACTION;
  const prevHome = process.env.ROVECODE_HOME;
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-compaction-rt-"));
  const home = mkdtempSync(join(tmpdir(), "rovecode-compaction-home-"));
  process.env.ROVECODE_HOME = home; // pinned: createRuntime must never load the developer's ~/.rovecode/hooks.ts
  try {
    expect(parseCompactionStrategy("keep-window")).toBe("keep-window");
    expect(parseCompactionStrategy("KEEP-WINDOW")).toBe("keep-window");
    expect(parseCompactionStrategy(" Provider-Native ")).toBe("provider-native");
    expect(parseCompactionStrategy(undefined)).toBeUndefined();
    expect(parseCompactionStrategy("   ")).toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(0);                       // known / unset / blank: silent
    const bogus = `bogus-${process.pid}-${Date.now()}`;         // unique: the note is deduped per process and value
    expect(parseCompactionStrategy(bogus)).toBeUndefined();
    expect(parseCompactionStrategy(` ${bogus.toUpperCase()} `)).toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(1);                       // ONE note for the two parses of the same unknown value
    expect(String(spy.mock.calls[0]![0])).toContain(`unknown ROVECODE_COMPACTION "${bogus}"`);
    expect(String(spy.mock.calls[0]![0])).toContain("using head-summarize");
    process.env.ROVECODE_COMPACTION = "Keep-Window";
    expect(createRuntime({ cwd, stream: null }).buildCfg(true).compactionStrategy).toBe("keep-window");
    process.env.ROVECODE_COMPACTION = bogus;
    expect(createRuntime({ cwd, stream: null }).buildCfg(true).compactionStrategy).toBe("head-summarize");
    expect(spy).toHaveBeenCalledTimes(1);                       // buildCfg re-parses per run: still the one note
    delete process.env.ROVECODE_COMPACTION;
    expect(createRuntime({ cwd, stream: null }).buildCfg(false).compactionStrategy).toBe("head-summarize");
    expect(spy).toHaveBeenCalledTimes(1);
  } finally {
    spy.mockRestore();
    if (prev === undefined) delete process.env.ROVECODE_COMPACTION; else process.env.ROVECODE_COMPACTION = prev;
    if (prevHome === undefined) delete process.env.ROVECODE_HOME; else process.env.ROVECODE_HOME = prevHome;
    rmSync(cwd, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true });
  }
});

// ---------- emergency path through the loop ----------

const baseDef: AgentDefinition = { name: "t", systemPrompt: "test agent", tools: ["*"], maxTurns: 8 };
const OVERFLOW = 'HTTP 400: {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 213462 tokens > 200000 maximum"}}';
const overflowTurn: AssistantTurn = { parts: [], stopReason: "error", usage: { input: 0, output: 0 }, error: OVERFLOW };

/** Per-call script (last turn repeats) that records every messages array the provider saw. */
function scripted(turns: AssistantTurn[]): { stream: StreamFn; calls: Message[][] } {
  const calls: Message[][] = [];
  const stream: StreamFn = async function* (_m: ModelRef, messages: Message[]): AsyncGenerator<StreamEvent> {
    calls.push([...messages]);
    yield { type: "turn", turn: turns[Math.min(calls.length - 1, turns.length - 1)]! };
  };
  return { stream, calls };
}

/** Store pre-seeded with two long user/assistant turns (4 × 50 tokens) — something to drop. */
function seeded(): { dir: string; store: SessionStore } {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-compaction-loop-"));
  const store = new SessionStore(dir, randomUUID());
  let parent: string | null = null;
  for (let i = 0; i < 4; i++) {
    const m: Message = { id: randomUUID(), role: i % 2 === 0 ? "user" : "assistant", parts: [{ kind: "text", text: "x".repeat(200) }], parentId: parent, createdAt: Date.now() };
    store.append(m); parent = m.id;
  }
  return { dir, store };
}

test("emergency: an overflow rejection compacts ONCE with trigger emergency and the re-drive succeeds on the compacted history", async () => {
  const { dir, store } = seeded();
  const { stream, calls } = scripted([overflowTurn, textTurn("recovered")]);
  const events: RunEvent[] = [];
  for await (const ev of agentLoop(baseDef, "go", {}, cfg({ contextBudgetTokens: 100_000, compactionStrategy: "keep-window" }), { stream, registry: new ToolRegistry(), store }, new SteeringQueue())) events.push(ev);
  const comp = events.filter((e) => e.type === "compaction");
  expect(comp.length).toBe(1);
  expect(comp[0]).toMatchObject({ strategy: "keep-window", trigger: "emergency" });
  expect((comp[0] as { tokensAfter: number }).tokensAfter).toBeLessThan((comp[0] as { tokensBefore: number }).tokensBefore);
  expect(events.at(-1)).toEqual({ type: "run_end", status: "done", summary: "recovered" });
  expect(calls.length).toBe(2);
  expect(calls[1]!.length).toBeLessThan(calls[0]!.length);   // the re-drive carried the compacted history
  const wire = calls[1]!.map((m) => partsTokenText(m.parts)).join("\n");
  expect(wire).not.toContain("x".repeat(200));               // seeded head is off the wire
  expect(wire).toContain("context compacted (keep-window)");
  expect(wire).toContain("go");                              // the request survived
  const types = events.map((e) => e.type);
  expect(types.indexOf("compaction")).toBeGreaterThan(types.indexOf("turn_end"));   // rejected turn ended first
  rmSync(dir, { recursive: true, force: true });
});

test("emergency is bounded: a second overflow ends the run in error after exactly two provider calls (no compact-retry loop)", async () => {
  const { dir, store } = seeded();
  const { stream, calls } = scripted([overflowTurn]);   // every call overflows
  const events: RunEvent[] = [];
  for await (const ev of agentLoop(baseDef, "go", {}, cfg({ contextBudgetTokens: 100_000, compactionStrategy: "keep-window", maxTurns: 8 }), { stream, registry: new ToolRegistry(), store }, new SteeringQueue())) events.push(ev);
  expect(calls.length).toBe(2);
  expect(events.filter((e) => e.type === "compaction").length).toBe(1);
  const end = events.at(-1)!;
  expect(end).toMatchObject({ type: "run_end", status: "error" });
  expect((end as { summary: string }).summary).toContain("prompt is too long");
  rmSync(dir, { recursive: true, force: true });
});

test("emergency under the default strategy summarizes aggressively (observed/2 budget) and re-drives once", async () => {
  const { dir, store } = seeded();
  const { stream, calls } = scripted([overflowTurn, textTurn("ok")]);
  const summarized: string[][] = [];
  const events: RunEvent[] = [];
  for await (const ev of agentLoop(baseDef, "go", {}, cfg({ contextBudgetTokens: 100_000 }), {
    stream, registry: new ToolRegistry(), store, summarize: async (t) => { summarized.push(t); return "SUMMARY"; },
  }, new SteeringQueue())) events.push(ev);
  expect(summarized.length).toBe(1);
  expect(summarized[0]!.join("\n")).toContain("x".repeat(200));   // the seeded head went to the summarizer
  expect(events.find((e) => e.type === "compaction")).toMatchObject({ strategy: "head-summarize", trigger: "emergency" });
  expect(calls.length).toBe(2);
  expect(events.at(-1)).toMatchObject({ type: "run_end", status: "done" });
  rmSync(dir, { recursive: true, force: true });
});

test("a non-overflow provider error is not an emergency: one call, error stop, no compaction", async () => {
  const { dir, store } = seeded();
  const bad: AssistantTurn = { parts: [], stopReason: "error", usage: { input: 0, output: 0 }, error: "HTTP 400: invalid api key" };
  const { stream, calls } = scripted([bad, textTurn("never")]);
  const events: RunEvent[] = [];
  for await (const ev of agentLoop(baseDef, "go", {}, cfg({ contextBudgetTokens: 100_000, compactionStrategy: "keep-window" }), { stream, registry: new ToolRegistry(), store }, new SteeringQueue())) events.push(ev);
  expect(calls.length).toBe(1);
  expect(events.some((e) => e.type === "compaction")).toBe(false);
  expect(events.at(-1)).toMatchObject({ type: "run_end", status: "error" });
  rmSync(dir, { recursive: true, force: true });
});

test("overflow on the LAST permitted turn ends the run in error with the provider's text — no re-drive, no compaction, never a silent 'budget' stop", async () => {
  const { dir, store } = seeded();
  const { stream, calls } = scripted([overflowTurn, textTurn("never")]);
  const events: RunEvent[] = [];
  for await (const ev of agentLoop(baseDef, "go", {}, cfg({ contextBudgetTokens: 100_000, compactionStrategy: "keep-window", maxTurns: 1 }), { stream, registry: new ToolRegistry(), store }, new SteeringQueue())) events.push(ev);
  expect(calls.length).toBe(1);
  expect(events.some((e) => e.type === "compaction")).toBe(false);
  expect(events.at(-1)).toEqual({ type: "run_end", status: "error", summary: `error: ${OVERFLOW}` });
  rmSync(dir, { recursive: true, force: true });
});

test("no-op emergency: a fresh session whose only turn overflows makes exactly ONE provider call and ends in error — nothing is droppable, so the identical request is not re-driven", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-compaction-loop-"));
  const store = new SessionStore(dir, randomUUID());   // empty store: the goal IS the whole history
  const { stream, calls } = scripted([overflowTurn, textTurn("never")]);
  const events: RunEvent[] = [];
  for await (const ev of agentLoop(baseDef, "g".repeat(1000), {}, cfg({ contextBudgetTokens: 100_000 }), { stream, registry: new ToolRegistry(), store }, new SteeringQueue())) events.push(ev);
  expect(calls.length).toBe(1);
  expect(events.some((e) => e.type === "compaction")).toBe(false);
  expect(events.at(-1)).toEqual({ type: "run_end", status: "error", summary: `error: ${OVERFLOW}` });
  rmSync(dir, { recursive: true, force: true });
});

test("head-summarize with a single oversized turn keeps the store's chain intact: the reply parents on a REAL message, reload reports no corruption, messages() keeps every real message", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-compaction-loop-"));
  const sid = randomUUID();
  const store = new SessionStore(dir, sid);
  store.append({ id: randomUUID(), role: "user", parts: [{ kind: "text", text: "hi" }], parentId: null, createdAt: Date.now() });
  const { stream } = scripted([textTurn("reply")]);
  const events: RunEvent[] = [];
  for await (const ev of agentLoop(baseDef, "g".repeat(1000), {}, cfg({ contextBudgetTokens: 100, compactionThreshold: 0.5 }), {
    stream, registry: new ToolRegistry(), store, summarize: async () => "SUMMARY",
  }, new SteeringQueue())) events.push(ev);
  expect(events.find((e) => e.type === "compaction")).toMatchObject({ strategy: "head-summarize", trigger: "speculative" });
  expect(events.at(-1)).toEqual({ type: "run_end", status: "done", summary: "reply" });
  const re = new SessionStore(dir, sid);
  expect(re.reload()).toEqual([]);                                                       // no orphan-entry: the reply's parent exists
  expect(re.messages().map((m) => partsTokenText(m.parts))).toEqual(["hi", "g".repeat(1000), "reply"]);   // nothing collapsed
  rmSync(dir, { recursive: true, force: true });
});

// ---------- persisted marker (SessionStore.appendEvent) ----------

test("appendEvent annotates the leaf: folded into path() right after its message, invisible to messages(), no phantom branch, survives reload corruption-free", () => {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-compaction-store-"));
  const s = new SessionStore(dir, "ev");
  s.append(user("U1", "u1"));
  s.append({ ...asst("A1", "a1"), parentId: "u1" });
  const ev: RunEvent = { type: "compaction", strategy: "keep-window", trigger: "speculative", tokensBefore: 10, tokensAfter: 4 };
  const e = s.appendEvent(ev);
  expect(e.parentId).toBe("a1");
  s.append({ ...user("U2", "u2"), parentId: "a1" });   // the loop parents its next message on the last MESSAGE
  expect(s.path().map((x) => x.id)).toEqual(["u1", "a1", e.id, "u2"]);
  expect(s.messages().map((m) => m.id)).toEqual(["u1", "a1", "u2"]);
  expect(s.turnPoints().map((p) => p.branches)).toEqual([0, 0]);   // an annotation is not a sibling branch
  const re = new SessionStore(dir, "ev");
  expect(re.reload()).toEqual([]);                                 // chain intact: no orphan / chain-broken
  expect(re.path().map((x) => x.id)).toEqual(["u1", "a1", e.id, "u2"]);
  const stored = re.path()[2]!;
  expect("kind" in stored ? stored.event : null).toEqual(ev);
  rmSync(dir, { recursive: true, force: true });
});

test("chain-linked event entries (export fixture convention) stay single on the path; a root annotation leads it", () => {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-compaction-store-"));
  const s = new SessionStore(dir, "link");
  s.append(user("U1", "u1"));
  s.append({ id: "e1", kind: "event", parentId: "u1", createdAt: 1, event: { type: "steer", text: "s" } });
  s.append({ ...user("U2", "u2"), parentId: "e1" });
  expect(s.path().map((x) => x.id)).toEqual(["u1", "e1", "u2"]);
  const empty = new SessionStore(dir, "rooted");
  const e = empty.appendEvent({ type: "compaction", strategy: "keep-window", trigger: "emergency", tokensBefore: 1, tokensAfter: 1 });
  expect(e.parentId).toBeNull();
  empty.append(user("U1", "r1"));
  expect(empty.path().map((x) => x.id)).toEqual([e.id, "r1"]);
  expect(empty.messages().map((m) => m.id)).toEqual(["r1"]);
  expect(new SessionStore(dir, "rooted").reload()).toEqual([]);
  rmSync(dir, { recursive: true, force: true });
});
