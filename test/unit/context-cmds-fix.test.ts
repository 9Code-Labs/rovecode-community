/** Port #53/#68 fix wave (critic LOW) — /compact is cancellable on the TUI/REPL surfaces. cmdCompact owns an
 *  AbortController bound through the app's interrupt seam (ctx.bindAbort → runAbort, the same seam `!cmd` uses in
 *  shell-cmd.ts) and threads its signal into compactSession, so Esc / ⌃c abort the in-flight summarize call and the
 *  documented cancel path ("compaction failed: … — the session is unchanged") is real, not test-only.
 *  PORT DELTA vs aion: rovecode's Summarizer is (texts) => Promise<string> — NO signal parameter (aion #68's
 *  summarizer takes one). The signal still flows into applyCompaction's ctx (core/compaction.ts carries it), so
 *  when #68's summarizer-with-signal lands the abort path is already wired end to end; what THIS tree can pin is
 *  that cmdCompact binds a controller then clears it, and that a summarizer that REJECTS with the bound controller
 *  aborted produces the cancel note and an untouched session. Pinned three ways here: bind/clear, the cancel note,
 *  and the wiring present at the source lines. Store level uses a temp session; nothing here touches the network. */

import { expect, test, spyOn } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { SessionStore } from "../../src/core/session.ts";
import { ModeManager, loadModesConfig } from "../../src/core/modes.ts";
import { cmdCompact, compactSession, type ContextCmdCtx } from "../../src/tui/context-cmds.ts";
import type { Message, RunConfig } from "../../src/core/types.ts";

const MODEL = { provider: "mock", model: "default" };
function deadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const bomb = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error(`${what}: not settled within ${ms}ms`)), ms); });
  return Promise.race([p, bomb]).finally(() => { if (t !== undefined) clearTimeout(t); });
}
const cfg = (): RunConfig => ({ maxTurns: 60, contextBudgetTokens: 300, compactionThreshold: 0.8, compactionStrategy: "head-summarize", parallelTools: true, permissionRules: [{ action: "*", resource: "*", effect: "allow" }] });

function seedPairs(store: SessionStore, pairs: number): void {
  let parent: string | null = null;
  for (let i = 1; i <= pairs; i++) {
    const u: Message = { id: randomUUID(), role: "user", parts: [{ kind: "text", text: `question ${i} ${"lorem ipsum ".repeat(12)}` }], parentId: parent, createdAt: Date.now() };
    store.append(u);
    const a: Message = { id: randomUUID(), role: "assistant", parts: [{ kind: "text", text: `answer ${i} ${"dolor sit amet ".repeat(12)}` }], parentId: u.id, createdAt: Date.now(), usage: { input: 10, output: 5 } };
    store.append(a); parent = a.id;
  }
}

function makeCtx(store: SessionStore, cwd: string, summarize: ContextCmdCtx["summarize"], sink: { bound: (AbortController | null)[]; notes: { text: string; tone: string }[] }): ContextCmdCtx {
  const modes = new ModeManager(loadModesConfig(cwd), MODEL);
  return {
    renderer: { addSystemNote: (t: string, tone = "info") => { sink.notes.push({ text: t, tone }); } } as unknown as ContextCmdCtx["renderer"],
    cwd, busy: () => false, store: () => store, modes,
    state: { yolo: true, provider: MODEL.provider, model: MODEL.model, mode: "act", busy: false } as unknown as ContextCmdCtx["state"],
    defaultMode: "act", buildCfg: () => cfg(), summarize,
    bindAbort: (ac) => { sink.bound.push(ac); },
    switchSession: () => {}, replayHistory: () => {}, refreshUsage: () => {}, pushStatus: () => {}, submit: async () => {},
  } satisfies ContextCmdCtx;
}

test("cmdCompact binds an AbortController through ctx.bindAbort (then clears it); a summarizer that rejects WHILE the bound controller is aborted → the cancel note, the session unchanged", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rv-p68-cancel-"));
  try {
    const store = new SessionStore(join(cwd, ".rovecode", "sessions"), "cancel-68");
    seedPairs(store, 3);
    const entriesPath = join(cwd, ".rovecode", "sessions", "cancel-68", "entries.jsonl");
    const before = readFileSync(entriesPath, "utf8");
    const sink = { bound: [] as (AbortController | null)[], notes: [] as { text: string; tone: string }[] };
    // the summarizer is the only reachable model call: it aborts the BOUND controller (as Esc does) then rejects
    const summarize: ContextCmdCtx["summarize"] = async (_texts) => {
      const ac = sink.bound.find((b): b is AbortController => b !== null)!;
      ac.abort();
      throw new Error("summarize cancelled");
    };
    const ctx = makeCtx(store, cwd, summarize, sink);
    await deadline(cmdCompact(ctx, ""), 5_000, "cmdCompact cancel");
    expect(sink.bound.some((b) => b !== null)).toBe(true);        // a controller was bound (Esc has a target)
    expect(sink.bound.at(-1)).toBeNull();                         // and cleared afterwards
    const failNote = sink.notes.find((n) => n.text.startsWith("compaction failed"));
    expect(failNote).toBeDefined();
    expect(failNote!.text).toContain("summarize cancelled");
    expect(failNote!.text).toContain("the session is unchanged");
    expect(failNote!.tone).toBe("error");
    expect(readFileSync(entriesPath, "utf8")).toBe(before);       // nothing written — no branch, no marker
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("compactSession threads the CALLER's signal into the compaction ctx (source of the future #68 abort path)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rv-p68-signal-"));
  try {
    const store = new SessionStore(join(cwd, ".rovecode", "sessions"), "signal-68");
    seedPairs(store, 3);
    const ac = new AbortController();
    // the signal must reach the compaction ctx; spyOn the module namespace (bun allows this where a
    // plain property assign hits a readonly ESM binding)
    const mod = await import("../../src/core/compaction.ts");
    const seen: unknown[] = [];
    const planOriginal = mod.planCompaction;
    const plan = spyOn(mod, "planCompaction").mockImplementation(((h: Parameters<typeof mod.planCompaction>[0], c: Parameters<typeof mod.planCompaction>[1], ctx: Parameters<typeof mod.planCompaction>[2]) => { seen.push(ctx.signal); return planOriginal(h, c, ctx); }) as typeof mod.planCompaction);
    try {
      const res = await compactSession(store, cfg(), { summarize: async () => "s", signal: ac.signal });
      expect(res.kind).toBe("compacted");
      expect(seen[0]).toBe(ac.signal);                            // MUTATION: drop deps.signal from CompactDeps → undefined
    } finally {
      plan.mockRestore();
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("the surface wiring is present: app.ts hands bindAbort into the context-command ctx and repl.ts binds Ctrl-C to a running /compact's controller (source pins)", () => {
  const src = resolve(import.meta.dir, "..", "..", "src");
  const app = readFileSync(join(src, "tui", "app.ts"), "utf8");
  expect(app).toContain("bindAbort:");                            // ctxCmdCtx carries the app's interrupt seam — MUTATION: drop it → cmdCompact's ac has no Esc target
  expect(app).toMatch(/runContextCommand\(ctxCmdCtx/);
  const repl = readFileSync(join(src, "cli", "repl.ts"), "utf8");
  expect(repl).toContain("compacting.abort()");                  // Ctrl-C aborts a running /compact
  expect(repl).toMatch(/signal:\s*compacting\.signal/);          // the REPL threads that controller into compactSession
});
