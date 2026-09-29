/** P0 entegrasyonu (UYGULAMA-A): loop üzerinden uçtan uca —
 *  (1) unified output budget: devasa araç çıktısı store'a kırpılmış girer, wire'a kırpılmış gider,
 *      event'ler ham kalır; (2) view-only prune: eski büyük tool sonuçları wire'da stub, store'da tam;
 *      iyi bir prune LLM compaction'ını tamamen önleyebilir; (3) thrash cooldown: arka arkaya hızlı
 *      compaction'lar üç strike'ta durur, run devam eder. */

import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { agentLoop, SteeringQueue, partsTokenText } from "../../src/core/loop.ts";
import { ToolRegistry } from "../../src/core/tools.ts";
import { SessionStore } from "../../src/core/session.ts";
import { textTurn, toolTurn } from "../../src/providers/stream.ts";
import { PRUNE_STUB_MARK, DEFAULT_PRUNE_CONFIG } from "../../src/core/compaction.ts";
import { TRUNCATION_MARK, DEFAULT_OUTPUT_CAP } from "../../src/core/tool-output-budget.ts";
import type { AgentDefinition, AssistantTurn, Message, ModelRef, RunConfig, RunEvent, StreamEvent, StreamFn, Tool } from "../../src/core/types.ts";

const allowAll = [{ action: "*", resource: "*", effect: "allow" as const }];
function cfg(over: Partial<RunConfig> = {}): RunConfig {
  return {
    contextBudgetTokens: 100_000, compactionThreshold: 0.8,
    parallelTools: true, permissionRules: allowAll, ...over,
  };
}
const baseDef: AgentDefinition = { name: "t", systemPrompt: "test agent", tools: ["*"] };

/** records the exact messages array every provider call received */
function scripted(turns: AssistantTurn[]): { stream: StreamFn; calls: Message[][] } {
  const calls: Message[][] = [];
  const stream: StreamFn = async function* (_m: ModelRef, messages: Message[]): AsyncGenerator<StreamEvent> {
    calls.push([...messages]);
    yield { type: "turn", turn: turns[Math.min(calls.length - 1, turns.length - 1)]! };
  };
  return { stream, calls };
}

function tmpStore(): { dir: string; store: SessionStore } {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-ctx-eff-"));
  return { dir, store: new SessionStore(dir, randomUUID()) };
}
function seed(store: SessionStore, entries: { role: Message["role"]; text: string }[]): void {
  let parent: string | null = null;
  for (const e of entries) {
    const m: Message = { id: randomUUID(), role: e.role, parts: [{ kind: "text", text: e.text }], parentId: parent, createdAt: Date.now() };
    store.append(m); parent = m.id;
  }
}

const bigTool = (chars: number): Tool => ({
  schema: { name: "big", description: "big output", args: { type: "object", properties: { n: { type: "integer" } } } },
  kind: "custom",
  execute: async () => ({ ok: true, output: `HEADER-LINE\n${"R".repeat(chars)}\nTAIL-LINE` }),
});

// ---------- (1) unified output budget ----------

test("output budget: a 100k tool result is persisted TRUNCATED with the marker; small results stay byte-verbatim", async () => {
  const { dir, store } = tmpStore();
  const reg = new ToolRegistry();
  reg.register(bigTool(100_000));
  const { stream } = scripted([toolTurn([{ id: "c1", tool: "big", args: {} }]), textTurn("done")]);
  const events: RunEvent[] = [];
  for await (const ev of agentLoop(baseDef, "go", {}, cfg(), { stream, registry: reg, store }, new SteeringQueue())) events.push(ev);
  const results = store.messages().filter((m) => m.role === "tool");
  expect(results.length).toBe(1);
  const out = (results[0]!.parts[0] as { output: string }).output;
  expect(out.length).toBeLessThanOrEqual(DEFAULT_OUTPUT_CAP);
  expect(out).toContain(TRUNCATION_MARK);
  expect(out.startsWith("HEADER-LINE")).toBe(true);         // head survives
  expect(out).toContain("TAIL-LINE");                        // tail survives
  // the live event carried the RAW output (surface fidelity — documented divergence)
  const end = events.find((e) => e.type === "tool_execution_end") as { output: string } | undefined;
  expect(end!.output.length).toBeGreaterThan(100_000);
  expect(events.at(-1)).toMatchObject({ type: "run_end", status: "done" });
  rmSync(dir, { recursive: true, force: true });
});

test("output budget: false disables it — the raw output is persisted whole", async () => {
  const { dir, store } = tmpStore();
  const reg = new ToolRegistry();
  reg.register(bigTool(40_000));
  const { stream } = scripted([toolTurn([{ id: "c1", tool: "big", args: {} }]), textTurn("done")]);
  for await (const _ev of agentLoop(baseDef, "go", {}, cfg({ outputBudget: false }), { stream, registry: reg, store }, new SteeringQueue())) void _ev;
  const out = (store.messages().filter((m) => m.role === "tool")[0]!.parts[0] as { output: string }).output;
  expect(out.length).toBe(40_000 + "HEADER-LINE\n\nTAIL-LINE".length);
  expect(out).not.toContain(TRUNCATION_MARK);
  rmSync(dir, { recursive: true, force: true });
});

// ---------- (2) view-only prune ----------

test("prune: the wire carries stubs for OLD big results while the store keeps every byte", async () => {
  const { dir, store } = tmpStore();
  // output budget's 32k cap sits BELOW prune's 40k-token protect budget, so loop-executed results
  // never grow old-and-huge in the store. Seed the old turns directly (a resumed session's shape):
  // two 8k-char results (2k tokens each) with a test-scale prune config (protect 1k tokens).
  const pruneCfg = { protectTokens: 1_000, minGainTokens: 100, protectedTools: ["skill_view"], headChars: 40 };
  seed(store, [{ role: "user", text: "eski iş" }]);
  for (const [i, callId] of [[1, "old1"], [2, "old2"]] as const) {
    const cm: Message = { id: randomUUID(), role: "assistant", parts: [{ kind: "tool_call", id: callId, tool: "bash", args: { command: `cat log${i}` } }], parentId: store.messages().at(-1)!.id, createdAt: Date.now() };
    store.append(cm);
    const rm: Message = { id: randomUUID(), role: "tool", parts: [{ kind: "tool_result", callId, ok: true, output: `LOG${i}-HEAD\n${"R".repeat(8_000)}\nLOG${i}-TAIL` }], parentId: cm.id, createdAt: Date.now() };
    store.append(rm);
    const am: Message = { id: randomUUID(), role: "assistant", parts: [{ kind: "text", text: `tur ${i} tamam` }], parentId: rm.id, createdAt: Date.now() };
    store.append(am);
  }
  const events: RunEvent[] = [];
  const { stream, calls } = scripted([textTurn("answer")]);
  for await (const ev of agentLoop(baseDef, "yeni soru", {}, cfg({ prune: pruneCfg }), { stream, registry: new ToolRegistry(), store }, new SteeringQueue())) events.push(ev);
  expect(calls.length).toBe(1);
  const wire = calls[0]!.map((m) => partsTokenText(m.parts)).join("\n");
  expect(wire).toContain(PRUNE_STUB_MARK);
  expect(wire).toContain("LOG1-HEAD");                       // stub başı korunur
  expect(wire).not.toContain("R".repeat(1_000));             // kütleler wire'da değil
  expect(wire).toContain("yeni soru");
  const pruneEvents = events.filter((e) => e.type === "compaction" && e.strategy === "prune");
  expect(pruneEvents.length).toBe(1);
  expect((pruneEvents[0] as { tokensAfter: number }).tokensAfter).toBeLessThan((pruneEvents[0] as { tokensBefore: number }).tokensBefore);
  // the store is untouched: every tool result on disk is the FULL output
  for (const m of store.messages()) {
    if (m.role !== "tool") continue;
    const out = (m.parts[0] as { output: string }).output;
    expect(out).not.toContain(PRUNE_STUB_MARK);
    expect(out.length).toBeGreaterThan(8_000);
  }
  // and the prune event was NOT persisted as an annotation (the record did not change)
  expect(store.path().filter((e) => "kind" in e).length).toBe(0);
  rmSync(dir, { recursive: true, force: true });
});

test("prune can preempt an LLM compaction entirely: over-threshold raw, under-threshold after prune → no summarize", async () => {
  const { dir, store } = tmpStore();
  // THREE old 90k-char results (~22.5k tokens each ≈ 67.5k total) + prose. budget 50k tokens,
  // threshold 0.5 → trigger at 25k. Raw history ≈ 68k → over. Prune (protect 40k tokens) keeps the
  // newest result, stubs the older two: wire ≈ 22.7k → under. The summarizer must never run.
  seed(store, [{ role: "user", text: "eski iş" }, { role: "assistant", text: "bakıyorum" }]);
  for (const i of [1, 2, 3]) {
    const cm: Message = { id: randomUUID(), role: "assistant", parts: [{ kind: "tool_call", id: `old${i}`, tool: "bash", args: { command: `cat big${i}.log` } }], parentId: store.messages().at(-1)!.id, createdAt: Date.now() };
    store.append(cm);
    const rm: Message = { id: randomUUID(), role: "tool", parts: [{ kind: "tool_result", callId: `old${i}`, ok: true, output: "L".repeat(90_000) }], parentId: cm.id, createdAt: Date.now() };
    store.append(rm);
  }
  let summarized = 0;
  const events: RunEvent[] = [];
  const { stream, calls } = scripted([textTurn("ok")]);
  for await (const ev of agentLoop(baseDef, "yeni soru", {}, cfg({ contextBudgetTokens: 50_000, compactionThreshold: 0.5 }), {
    stream, store, registry: new ToolRegistry(),
    summarize: async () => { summarized++; return "S"; },
  }, new SteeringQueue())) events.push(ev);
  expect(summarized).toBe(0);                                            // LLM compaction preempted
  const strategies = events.filter((e) => e.type === "compaction").map((e) => (e as { strategy: string }).strategy);
  expect(strategies).toContain("prune");
  expect(strategies).not.toContain("head-summarize");
  const wire = calls[0]!.map((m) => partsTokenText(m.parts)).join("\n");
  expect(wire).toContain(PRUNE_STUB_MARK);
  // iki eski sonuç stub; protectTokens (40k token) penceresindeki EN YENİ 90k gövde bütün kalır
  expect(wire.split(PRUNE_STUB_MARK).length - 1).toBe(2);
  expect(wire.length).toBeGreaterThan(89_000);       // korunan gövde duruyor
  expect(wire.length).toBeLessThan(100_000);         // diğer ikisi (~180k) wire'da yok
  expect(wire).toContain("yeni soru");
  rmSync(dir, { recursive: true, force: true });
});

test("prune: false disables it (raw history on the wire, no prune events)", async () => {
  const { dir, store } = tmpStore();
  const reg = new ToolRegistry();
  reg.register(bigTool(120_000));
  const { stream, calls } = scripted([toolTurn([{ id: "c1", tool: "big", args: {} }]), textTurn("done")]);
  const events: RunEvent[] = [];
  for await (const ev of agentLoop(baseDef, "go", {}, cfg({ prune: false }), { stream, registry: reg, store }, new SteeringQueue())) events.push(ev);
  expect(events.filter((e) => e.type === "compaction" && (e as { strategy: string }).strategy === "prune").length).toBe(0);
  expect(calls.at(-1)!.map((m) => partsTokenText(m.parts)).join("\n")).not.toContain(PRUNE_STUB_MARK);
  rmSync(dir, { recursive: true, force: true });
});

// ---------- (3) thrash cooldown ----------

test("thrash cooldown: repeated rapid compactions stop after three strikes and the run goes on", async () => {
  const { dir, store } = tmpStore();
  const reg = new ToolRegistry();
  // every turn adds a FRESH ~40-token result (distinct args — the loop guard must not stub them)
  const noisy: Tool = {
    schema: { name: "noisy", description: "growing output", args: { type: "object", properties: { n: { type: "integer" } } } },
    kind: "custom",
    execute: async (args) => ({ ok: true, output: `result ${(args as { n: number }).n}: ${"N".repeat(160)}` }),
  };
  reg.register(noisy);
  // budget 100 tokens, trigger at >80: history crosses again ~every turn → compaction every turn
  const turns = Array.from({ length: 12 }, (_, i) => toolTurn([{ id: `c${i}`, tool: "noisy", args: { n: i } }]));
  turns.push(textTurn("finally done"));
  const { stream } = scripted(turns);
  const events: RunEvent[] = [];
  const conf = cfg({ contextBudgetTokens: 100, compactionThreshold: 0.8, compactionStrategy: "keep-window", compactionKeepTurns: 0 });
  for await (const ev of agentLoop(baseDef, "go", {}, conf, { stream, registry: reg, store }, new SteeringQueue())) events.push(ev);
  const compactions = events.filter((e) => e.type === "compaction" && e.strategy === "keep-window");
  const cooldowns = events.filter((e) => e.type === "compaction" && e.strategy === "cooldown");
  expect(compactions.length).toBeGreaterThanOrEqual(2);     // it DID compact repeatedly
  expect(compactions.length).toBeLessThanOrEqual(4);        // …but not every turn forever
  expect(cooldowns.length).toBe(1);                          // the cooldown note fired exactly once
  expect(events.at(-1)).toMatchObject({ type: "run_end" });  // the run ended on its feet
  rmSync(dir, { recursive: true, force: true });
});

test("thrash cooldown can be switched off (compactionRapidTurns: 0)", async () => {
  const { dir, store } = tmpStore();
  const reg = new ToolRegistry();
  const noisy: Tool = {
    schema: { name: "noisy", description: "x", args: { type: "object", properties: { n: { type: "integer" } } } },
    kind: "custom",
    execute: async (args) => ({ ok: true, output: `r${(args as { n: number }).n} ${"N".repeat(160)}` }),
  };
  reg.register(noisy);
  const turns = Array.from({ length: 8 }, (_, i) => toolTurn([{ id: `c${i}`, tool: "noisy", args: { n: i } }]));
  turns.push(textTurn("done"));
  const { stream } = scripted(turns);
  const events: RunEvent[] = [];
  const conf = cfg({ contextBudgetTokens: 100, compactionThreshold: 0.8, compactionStrategy: "keep-window", compactionKeepTurns: 0, compactionRapidTurns: 0 });
  for await (const ev of agentLoop(baseDef, "go", {}, conf, { stream, registry: reg, store }, new SteeringQueue())) events.push(ev);
  expect(events.filter((e) => e.type === "compaction" && e.strategy === "cooldown").length).toBe(0);
  rmSync(dir, { recursive: true, force: true });
});
