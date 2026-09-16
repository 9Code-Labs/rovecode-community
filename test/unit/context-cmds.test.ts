/** Port #53 context commands, store level (tui/context-cmds.ts compactSession + copyAssistantMessage)
 *  and the sextant pass-through. compactSession is pinned against the ONE strategy set: the core
 *  planCompaction/applyCompaction entry is called exactly once each (spied on the module namespace),
 *  with the surface's cfg, and nothing else summarizes (these store-level calls pass no summarizer →
 *  head-summarize falls back to keep-window at PLAN time — THIS TREE has no summarizer wired anywhere
 *  and aion's #68 apply-time fallback is not ported to core/compaction.ts; the marker is NOT tagged,
 *  the DETAIL line names the fallback). The outcome is DURABLE (a new branch the reloaded store returns
 *  as messages()), the marker is persisted the way loop.ts persists it (an event entry on the path;
 *  export renders it), the old entries are untouched (append-only), a staged attachment survives, an
 *  image sidecar path round-trips, and a short (or EMPTY) session is one note with no plan call.
 *  Also: the four names are reserved against custom command files (TUI_COMMANDS), and the sextant key
 *  layer passes them through. Mutations named inline. */

import { test, expect, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import * as compaction from "../../src/core/compaction.ts";
import { SessionStore } from "../../src/core/session.ts";
import { partsText } from "../../src/core/loop.ts";
import { renderSessionMarkdown } from "../../src/cli/export.ts";
import { ModelCatalog } from "../../src/providers/catalog.ts";
import { TUI_COMMANDS } from "../../src/tui/app.ts";
import { discoverCommands } from "../../src/tui/commands.ts";
import { compactSession, compactNoteLines, copyAssistantMessage, CONTEXT_COMMANDS, MIN_COMPACT_MESSAGES } from "../../src/tui/context-cmds.ts";
import type { EventEntry } from "../../src/tui/replay-marker.ts";
import type { Message, RunConfig } from "../../src/core/types.ts";
import { ALIAS_NOTE, runLocal } from "../../src/sextant/local-commands.ts";
import { makeState, spyCtx, type, press, key } from "../helpers/sextant-fixtures-keys.ts";

const cfg = (over: Partial<RunConfig> = {}): RunConfig => ({
  maxTurns: 60, contextBudgetTokens: 200_000, compactionThreshold: 0.8, compactionStrategy: "head-summarize",
  parallelTools: true, permissionRules: [{ action: "*", resource: "*", effect: "allow" }], ...over,
});

/** a linear session of `pairs` user/assistant exchanges (2 messages per pair) */
function seed(root: string, id: string, pairs: number): SessionStore {
  const s = new SessionStore(root, id);
  let parent: string | null = null;
  for (let i = 1; i <= pairs; i++) {
    const u: Message = { id: randomUUID(), role: "user", parts: [{ kind: "text", text: `question ${i} ${"lorem ipsum ".repeat(12)}` }], parentId: parent, createdAt: Date.now() };
    s.append(u);
    const a: Message = { id: randomUUID(), role: "assistant", parts: [{ kind: "text", text: `answer ${i} ${"dolor sit amet ".repeat(12)}` }], parentId: u.id, createdAt: Date.now(), usage: { input: 10, output: 5 } };
    s.append(a);
    parent = a.id;
  }
  return s;
}

test("short session (< MIN_COMPACT_MESSAGES): one 'nothing' note, planCompaction never called, nothing appended", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rv-ctx-"));
  const root = join(cwd, "sessions");
  const s = seed(root, "short", 2); // 4 messages
  const before = readFileSync(join(root, "short", "entries.jsonl"), "utf8");
  const plan = spyOn(compaction, "planCompaction");
  try {
    const res = await compactSession(s, cfg());
    expect(res.kind).toBe("nothing");
    expect(compactNoteLines(res, "x")).toEqual([`nothing to compact — 4 messages on the active path (compaction needs at least ${MIN_COMPACT_MESSAGES})`]);
    expect(plan).toHaveBeenCalledTimes(0);
    expect(readFileSync(join(root, "short", "entries.jsonl"), "utf8")).toBe(before);
  } finally { plan.mockRestore(); rmSync(cwd, { recursive: true, force: true }); }
});

test("≥6 messages with a summarizer: the core entry runs ONCE (plan + apply, the caller's cfg), head-summarize summarizes the dropped head, the marker is persisted like loop.ts, the branch is durable and the old entries are byte-identical", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rv-ctx-"));
  const root = join(cwd, "sessions");
  const s = seed(root, "six", 3); // 6 messages
  const entriesP = join(root, "six", "entries.jsonl");
  const before = readFileSync(entriesP, "utf8");
  const originalIds = s.messages().map((m) => m.id);
  const plan = spyOn(compaction, "planCompaction");
  const apply = spyOn(compaction, "applyCompaction");
  // a small window: the default 200k would keep the whole history (nothing droppable) and a summary
  // over an empty head is no compaction at all
  const c = cfg({ contextBudgetTokens: 300 });
  try {
    // WITH a summarizer injected (the #68 shape this tree will grow): the full durable path runs.
    // rovecode's Summarizer is (texts) => Promise<string>; it is called ONCE over the drop head.
    const summarize = async (texts: string[]): Promise<string> => `summary of ${texts.length} dropped messages`;
    const res = await compactSession(s, c, { summarize });
    expect(plan).toHaveBeenCalledTimes(1);                                   // mutation: skip the planner → 0
    expect(apply).toHaveBeenCalledTimes(1);
    expect(plan.mock.calls[0]![1]).toBe(c);                                   // the run's own RunConfig, not a private one
    expect(plan.mock.calls[0]![2].summarize).toBe(summarize);                 // the caller's summarizer is threaded (the ctxCmdCtx seam)
    if (res.kind !== "compacted") throw new Error(`expected a compaction, got ${res.reason}`);
    // PORT DELTA vs aion: strategy is "head-summarize" with a summarizer present; trigger is absent
    // from the marker (rovecode's union has no "manual" — #68); compactionNote renders strategy+counts.
    expect(res.event).toMatchObject({ type: "compaction", strategy: "head-summarize" });
    expect((res.event as { trigger?: string }).trigger).toBeUndefined();
    // no strict token-decrease assert: the summary's length is the model's choice, so "after < before"
    // is not the mechanism's guarantee — a summarizer call over a non-empty head and fewer messages is.
    expect(res.dropped).toBeGreaterThan(0);
    expect(res.dropped).toBe(3);                                            // 255-token history, 150-token half → the last 3 messages stay
    expect(res.kept).toBe(3);
    expect(res.fallbackFrom).toBeUndefined();                                 // nothing fell back: the summarizer ran
    const lines = compactNoteLines(res, "tests");
    expect(lines[0]).toBe(`compacted (head-summarize): ${res.event.tokensBefore} → ${res.event.tokensAfter} tokens`);
    expect(lines[1]).toContain("3 messages dropped, 3 kept");
    expect(lines[1]).toContain('focus "tests" not applied — the compaction strategies take no instructions');

    // durable: the live store AND a fresh reload see the compacted path — the summary message then the last exchange
    for (const st of [s, new SessionStore(root, "six")]) {
      const msgs = st.messages();
      expect(msgs.map((m) => m.role)).toEqual(["system", "assistant", "user", "assistant"]);
      expect(partsText(msgs[0]!.parts)).toContain("Summary of earlier conversation");
      expect(partsText(msgs[0]!.parts)).toContain("summary of 3 dropped messages");
      expect(partsText(msgs[1]!.parts)).toStartWith("answer 2");              // the backward tail starts mid-history
      expect(msgs[1]!.id).not.toBe(originalIds[4]);                           // a fresh-id copy, never a duplicate id
      expect(msgs[3]!.usage).toEqual({ input: 10, output: 5 });               // usage rides along (/cost prices the kept turns once)
      expect(st.reload()).toEqual([]);                                        // no orphan, no duplicate id, chain intact
    }
    // the marker: an event entry on the active path, the loop's exact shape (mutation: drop appendEvent → no event, export has no marker)
    const events = s.path().filter((e): e is EventEntry => !("role" in e));
    expect(events.length).toBe(1);
    expect(events[0]!.event).toEqual({ type: "compaction", strategy: "head-summarize", tokensBefore: res.event.tokensBefore, tokensAfter: res.event.tokensAfter });
    expect(renderSessionMarkdown(s.path(), "six", new ModelCatalog())).toContain(`> compacted (head-summarize): ${res.event.tokensBefore} → ${res.event.tokensAfter} tokens`);
    // append-only: the old bytes are a prefix of the new file; the leaf is durable in meta.json
    const after = readFileSync(entriesP, "utf8");
    expect(after.startsWith(before)).toBe(true);
    expect(after.length).toBeGreaterThan(before.length);
    expect(JSON.parse(readFileSync(join(root, "six", "meta.json"), "utf8")).leaf).toBe(s.messages().at(-1)!.id);
  } finally { plan.mockRestore(); apply.mockRestore(); rmSync(cwd, { recursive: true, force: true }); }
});

test("NO summarizer (this tree's real TUI/REPL path): head-summarize cannot plan — one honest 'nothing' note naming the strategy; nothing appended", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rv-ctx-"));
  const root = join(cwd, "sessions");
  const s = seed(root, "nosumm", 3);
  const entriesP = join(root, "nosumm", "entries.jsonl");
  const before = readFileSync(entriesP, "utf8");
  const plan = spyOn(compaction, "planCompaction");
  const apply = spyOn(compaction, "applyCompaction");
  try {
    const res = await compactSession(s, cfg(), { model: { provider: "p", model: "m" } });
    // aion's planner falls back to keep-window with a tag; rovecode's resolveStrategy returns null for a
    // summarizer-less speculative trigger (pre-#25 gate). compactSession reports it as a nothing-note.
    expect(plan).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledTimes(0);
    expect(res.kind).toBe("nothing");
    if (res.kind !== "nothing") throw new Error("unreachable");
    expect(res.reason).toContain("head-summarize found nothing droppable");
    expect(readFileSync(entriesP, "utf8")).toBe(before);                      // the session is untouched
  } finally { plan.mockRestore(); apply.mockRestore(); rmSync(cwd, { recursive: true, force: true }); }
});

test("keep-window cfg compacts directly with NO summarizer (keep-window never consults one); provider-native without a native compactor or summarizer cannot plan", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rv-ctx-"));
  const root = join(cwd, "sessions");
  try {
    const kw = await compactSession(seed(root, "kw", 4), cfg({ compactionStrategy: "keep-window" }));
    if (kw.kind !== "compacted") throw new Error(kw.reason);
    expect(kw.event.strategy).toBe("keep-window");
    expect(kw.fallbackFrom).toBeUndefined();
    expect(compactNoteLines(kw, "")[1]).not.toContain("could not run");       // nothing fell back
    const pn = await compactSession(seed(root, "pn", 4), cfg({ compactionStrategy: "provider-native" }));
    // no native compactor AND no summarizer: resolveStrategy has nothing to fall back TO on this tree
    // (aion's would run keep-window; that is #68 core) — one honest nothing-note naming the strategy
    expect(pn).toEqual({ kind: "nothing", reason: expect.stringContaining("provider-native found nothing droppable") });
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("a staged attachment is NOT folded into the copied user turns and is still staged afterwards; an image sidecar path round-trips through the copy", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rv-ctx-"));
  const root = join(cwd, "sessions");
  const s = seed(root, "img", 3);
  // a real sidecar on the LAST user turn's copy source: stage an image, append a user message, then let /compact copy it
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").toString("base64");
  s.stageAttachments([{ kind: "image", mime: "image/png", bytes: png, name: "tiny.png" }]);
  const last = s.messages().at(-1)!;
  s.append({ id: randomUUID(), role: "user", parts: [{ kind: "text", text: "look at this " + "x".repeat(200) }], parentId: last.id, createdAt: Date.now() });
  s.append({ id: randomUUID(), role: "assistant", parts: [{ kind: "text", text: "seen " + "y".repeat(200) }], parentId: s.messages().at(-1)!.id, createdAt: Date.now() });
  const sidecar = s.messages().find((m) => m.parts.some((p) => p.kind === "image"))!.parts.find((p) => p.kind === "image")!;
  expect(sidecar.kind === "image" && sidecar.path !== undefined && existsSync(sidecar.path)).toBe(true); // hydrated absolute path
  // now a NEW stage that must survive the compaction untouched
  s.stageAttachments([{ kind: "image", mime: "image/png", bytes: png, name: "pending.png" }]);
  try {
    const res = await compactSession(s, cfg({ compactionStrategy: "keep-window" }));
    expect(res.kind).toBe("compacted");
    expect(s.stagedAttachments.map((p) => p.name)).toEqual(["pending.png"]);                // stage preserved (mutation: drop the park → folded into a copy)
    const copiedUsers = s.messages().filter((m) => m.role === "user");
    expect(copiedUsers.some((m) => m.parts.some((p) => p.kind === "image" && p.name === "pending.png"))).toBe(false);
    const img = new SessionStore(root, "img").messages().flatMap((m) => m.parts).find((p) => p.kind === "image" && p.name === "tiny.png");
    expect(img !== undefined && img.kind === "image" && img.path !== undefined && existsSync(img.path)).toBe(true); // mutation: persist the absolute path → dropped at load
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("copyAssistantMessage: n-th from the end among assistant messages WITH text; tool-call-only turns skipped; fake spawner receives the exact text; out-of-range and empty are notes, never throws", async () => {
  const msgs: Message[] = [
    { id: "u1", role: "user", parts: [{ kind: "text", text: "q1" }], parentId: null, createdAt: 1 },
    { id: "a1", role: "assistant", parts: [{ kind: "text", text: "first answer ✓" }], parentId: "u1", createdAt: 2 },
    { id: "a2", role: "assistant", parts: [{ kind: "tool_call", id: "c1", tool: "read", args: {} }], parentId: "a1", createdAt: 3 }, // no text: does not count
    { id: "a3", role: "assistant", parts: [{ kind: "text", text: "second answer" }], parentId: "a2", createdAt: 4 },
  ];
  const inputs: string[] = [];
  const spawn = async (_argv: readonly string[], input: string) => { inputs.push(input); return { ok: true }; };
  expect((await copyAssistantMessage(msgs, 1, { platform: "darwin", spawn })).text).toBe("copied the last assistant message (13 chars) to the clipboard via pbcopy");
  expect((await copyAssistantMessage(msgs, 2, { platform: "darwin", spawn })).text).toBe("copied assistant message 2 from the end (14 chars) to the clipboard via pbcopy");
  expect(inputs).toEqual(["second answer", "first answer ✓"]);
  expect(await copyAssistantMessage(msgs, 3, { platform: "darwin", spawn })).toEqual({ text: "nothing to copy — only 2 assistant messages with text (asked for number 3 from the end)", tone: "warn" });
  expect(await copyAssistantMessage([msgs[0]!], 1, { platform: "darwin", spawn })).toEqual({ text: "nothing to copy — no assistant message with text yet", tone: "warn" });
  const dead = async () => ({ ok: false, detail: "exit 1" });
  const fail = await copyAssistantMessage(msgs, 1, { platform: "linux", spawn: dead });
  expect(fail.tone).toBe("warn");
  expect(fail.text).toBe("clipboard unavailable — tried pbcopy, wl-copy, xclip, xsel (exit 1); the text stays in the transcript");
});

test("EMPTY session (0 messages): the no-op note says 0 messages, planCompaction is never called, nothing is written", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rv-ctx-"));
  const root = join(cwd, "sessions");
  const s = new SessionStore(root, "empty");
  const plan = spyOn(compaction, "planCompaction");
  try {
    const res = await compactSession(s, cfg());
    // mutation: drop the MIN_COMPACT_MESSAGES guard → a plan call and the "found nothing droppable" wording
    expect(res).toEqual({ kind: "nothing", reason: `nothing to compact — 0 messages on the active path (compaction needs at least ${MIN_COMPACT_MESSAGES})` });
    expect(plan).toHaveBeenCalledTimes(0);
    expect(existsSync(join(root, "empty", "entries.jsonl"))).toBe(false);
    expect(s.messages()).toEqual([]);
  } finally { plan.mockRestore(); rmSync(cwd, { recursive: true, force: true }); }
});

test("manual keeps the CONFIGURED turns like a speculative one, NOT an emergency's 0: one huge early pair + three tiny pairs → the default 2 prior turns + the current session", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rv-ctx-"));
  const root = join(cwd, "sessions");
  // pair 1 is ~4200 tokens, pairs 2–4 a handful each: the tail sits far under observed/4 (the manual and
  // emergency cap alike), so ONLY the turn count decides the cut — the uniform `seed` fixtures let the cap
  // dominate, which is why a trigger-shaped cap would survive every other case
  const seedSkewed = (id: string): SessionStore => {
    const s = new SessionStore(root, id);
    let parent: string | null = null;
    for (let i = 1; i <= 4; i++) {
      const pad = i === 1 ? " lorem ipsum".repeat(700) : "";
      const u: Message = { id: randomUUID(), role: "user", parts: [{ kind: "text", text: `q${i}${pad}` }], parentId: parent, createdAt: Date.now() };
      s.append(u);
      const a: Message = { id: randomUUID(), role: "assistant", parts: [{ kind: "text", text: `a${i}${pad}` }], parentId: u.id, createdAt: Date.now() };
      s.append(a);
      parent = a.id;
    }
    return s;
  };
  const users = (id: string): string[] => new SessionStore(root, id).messages().filter((m) => m.role === "user").map((m) => partsText(m.parts));
  try {
    // the TUI's real path for an explicitly keep-window cfg (head-summarize cannot plan without a
    // summarizer on this tree — see the no-summarizer test above): DEFAULT_KEEP_TURNS prior turns + the current
    const dflt = await compactSession(seedSkewed("kt-default"), cfg({ compactionStrategy: "keep-window" }));
    if (dflt.kind !== "compacted") throw new Error(dflt.reason);
    expect(dflt.kept).toBe(2 * (compaction.DEFAULT_KEEP_TURNS + 1));       // mutation: emergency-style 0 turns → 2
    expect(dflt.dropped).toBe(2);
    expect(users("kt-default")).toEqual(["q2", "q3", "q4"]);               // the durable branch carries exactly those turns
    // the CONFIGURED count, not the default
    const one = await compactSession(seedSkewed("kt-one"), cfg({ compactionStrategy: "keep-window", compactionKeepTurns: 1 }));
    if (one.kind !== "compacted") throw new Error(one.reason);
    expect(one.kept).toBe(4);                                                // mutation: ignore cfg.compactionKeepTurns → 6; emergency-style 0 → 2
    expect(one.dropped).toBe(4);
    expect(users("kt-one")).toEqual(["q3", "q4"]);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("reservation: the four names are TUI_COMMANDS entries, so a custom compact.md / clear.md / init.md / copy.md is skipped with the built-in warning (app.ts reserves every palette name)", () => {
  const cwd = mkdtempSync(join(tmpdir(), "rv-ctx-"));
  const home = mkdtempSync(join(tmpdir(), "rv-ctx-home-"));
  try {
    const dir = join(cwd, ".rovecode", "commands");
    mkdirSync(dir, { recursive: true });
    for (const n of ["compact", "clear", "init", "copy"]) writeFileSync(join(dir, `${n}.md`), `shadow ${n}\n`, "utf8");
    const names = TUI_COMMANDS.map((c) => c.name);
    for (const c of CONTEXT_COMMANDS) expect(names).toContain(c.name);        // mutation: drop the CONTEXT_COMMANDS spread → missing
    const { commands, warnings } = discoverCommands(cwd, { home, reserved: names });
    expect(commands.map((c) => c.name)).toEqual([]);
    expect([...warnings].sort()).toEqual(["clear", "compact", "copy", "init"].map((n) => `/${n} is a built-in command — built-in kept (${join(dir, `${n}.md`)})`).sort());
  } finally { rmSync(cwd, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("sextant: /compact /clear /init /copy are not renderer-local and carry no alias toast — they reach onSubmit verbatim (app.ts handleSlash owns them)", () => {
  for (const line of ["/compact focus on tests", "/clear", "/init", "/copy 2"]) {
    const s = makeState(), spy = spyCtx();
    type(s, spy, line); press(s, spy, key("enter"));
    expect(spy.submits).toEqual([line]);
    expect(spy.toasts).toEqual([]);
  }
  expect(Object.keys(ALIAS_NOTE)).not.toContain("compact");
  const s = makeState(), spy = spyCtx();
  expect(runLocal(s, "compact", "", spy.ctx)).toBe(false);
});
