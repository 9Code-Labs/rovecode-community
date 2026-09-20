/** Port #44 — SextantRenderer as a unit: an in-memory TerminalIO, an injected clock, spy hooks, no repo
 *  scan. Pins the Renderer → state mapping (rows, cards, picker, busy suppression vs replay rows, status
 *  → usage, prefill/clear), the local slash commands vs the ones that reach onSubmit, Esc-Esc and the
 *  two-press ⌃c, the ESC-hold on chunk boundaries, start/stop terminal hygiene (enter/leave sequences,
 *  raw mode, interval + subscriptions gone), attach (crew, todos, pet name), resize, and the frame
 *  budget over a 200-message transcript. */

import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunEvent } from "../../src/core/types.ts";
import type { TaskInfo } from "../../src/core/tasks.ts";
import type { GitRunner, GitRunnerAsync } from "../../src/sextant/git-status.ts";
import { enterSequence, leaveSequence, mouseOffSequence, mouseOnSequence } from "../../src/sextant/input.ts";
import { SextantRenderer } from "../../src/sextant/sextant-renderer.ts";
import type { SextantAttach, ToolRow } from "../../src/sextant/types.ts";
import type { RendererHooks } from "../../src/tui/renderer.ts";
import { MemoryIO } from "../../src/tui/sextant-io.ts";

const T0 = 1_700_000_000_000;
const CMDS = ["help", "exit", "plan", "act", "yolo", "new", "cost", "tasks", "status"].map((name) => ({ name, description: name }));

function make(o: { cols?: number; rows?: number; cwd?: string; env?: Record<string, string>; start?: boolean; git?: GitRunner | GitRunnerAsync } = {}) {
  let now = T0;
  const io = new MemoryIO(o.cols ?? 160, o.rows ?? 44, o.env ?? {});
  const renderer = new SextantRenderer({ io, clock: () => now, cwd: o.cwd ?? "C:/repo", scan: false, pet: "rovecode", ...(o.git ? { git: o.git } : {}) });
  const spy = { submits: [] as string[], interrupts: 0, exits: 0 };
  const hooks: RendererHooks = { onSubmit: (t) => { spy.submits.push(t); }, onInterrupt: () => { spy.interrupts++; }, onExit: () => { spy.exits++; } };
  renderer.setCommands(CMDS);
  const feed = (text: string): void => { io.feed(text); renderer.flushInput(); renderer.tick(); };
  const advance = (ms: number, tick = true): void => { now += ms; if (tick) renderer.tick(); };
  // started tests begin PAST the boot reveal (5 × 90 ms panel stagger): with a frozen clock the panels would never appear
  if (o.start !== false) { renderer.start(hooks); advance(600); }
  return { io, renderer, spy, hooks, feed, advance, at: () => now, frame: () => { renderer.tick(); return renderer.frameText(); } };
}
const ev = (r: SextantRenderer, e: RunEvent): void => r.onEvent(e);

test("/mouse: setMouse hands the drag to the terminal and takes it back, idempotently; a pre-start toggle rides into the enter sequence", () => {
  const { io, renderer } = make();
  const before = io.writes.length;
  renderer.setMouse(false);
  expect(io.writes.slice(before).join("")).toBe(mouseOffSequence()); // tracking off: the terminal selects again
  renderer.setMouse(false);
  expect(io.output().split(mouseOffSequence()).length - 1).toBe(1); // idempotent: one burst, not two
  const mid = io.writes.length;
  renderer.setMouse(true);
  expect(io.writes.slice(mid).join("")).toBe(mouseOnSequence());
  expect(renderer.mouse).toBe(true);

  const off = make({ start: false });
  off.renderer.setMouse(false);           // flipped BEFORE start...
  void off.renderer.start(off.hooks);
  expect(off.io.output().startsWith(enterSequence(false))).toBe(true); // ...so the enter sequence carries no mouse bytes
  off.renderer.stop();
});
/** let queued microtasks run (the approval queue opens a card through a promise chain) */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
/** a promise that must settle within `ms` — a hung card promise is a failure, not a stuck runner */
function deadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const bomb = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error(`${what}: not settled within ${ms}ms`)), ms); });
  return Promise.race([p, bomb]).finally(() => clearTimeout(t));
}
const systemRows = (r: SextantRenderer): string[] => r.state.messages.filter((m) => m.kind === "system").map((m) => (m as { text: string }).text);

// ---------- lifecycle ----------

test("start: raw mode + the enter sequence, then a first frame; after the boot reveal every panel is on screen at 160×44; stop: leave sequence, raw off, interval + subscriptions gone, idempotent", async () => {
  const fresh = make({ start: false });
  fresh.renderer.start(fresh.hooks);
  const boot = fresh.renderer.frameText();
  expect(boot).toContain("─ files ─");                                     // frame + files paint at once…
  expect(boot).not.toContain("─ messages ─");                              // …the rest is revealed in 90 ms steps (frame.ts)
  fresh.renderer.stop();
  const { io, renderer, advance } = make();
  expect(io.raw).toBe(true);
  expect(io.output().startsWith(enterSequence(true))).toBe(true);
  expect(io.output().includes("\x1b[2J")).toBe(true);                    // the first flush clears
  expect(renderer.active).toBe(true);
  const f = renderer.frameText();
  for (const p of ["─ files ─", "─ code ─", "─ messages ─", "─ plan ─", "─ usage ─", "─ rovecode ─"]) expect(f).toContain(p);
  expect(f).toContain("◆ rovecode  ·  repo");                                // the cwd basename until attach()
  expect(f).toMatch(/night · v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)? ─╯$/);        // footer: theme · package version (a beta suffix is allowed)
  const before = renderer.frames;
  await new Promise((r) => setTimeout(r, 100));                           // the live 40 ms interval ticks (idle repaint after 170 ms of clock)
  advance(200);
  expect(renderer.frames).toBeGreaterThan(before);
  renderer.stop();
  expect(io.output().endsWith(leaveSequence())).toBe(true);
  expect(io.raw).toBe(false);
  expect(renderer.active).toBe(false);
  expect(io.listeners).toBe(0);
  const n = io.writes.length, painted = renderer.frames;
  advance(400, false);                                                    // clock only, past the idle-repaint threshold: only a live interval could paint now
  await new Promise((r) => setTimeout(r, 120));
  expect(renderer.frames).toBe(painted);                                  // the interval is really cleared (mutation: keep it ticking → paints)
  renderer.stop();
  expect(io.writes.length).toBe(n);                                       // a second stop writes nothing
});

test("ROVECODE_PET=0 removes the pet panel and the files column takes its rows; a 100×30 surface has neither side column", () => {
  const a = make({ env: { ROVECODE_PET: "0" } });
  expect(a.renderer.frameText()).not.toContain("─ rovecode ─");
  expect(a.renderer.frameText()).toContain("─ files ─");
  a.renderer.stop();
  const b = make({ cols: 100, rows: 30 });
  const f = b.renderer.frameText();
  // no side columns — and the main slot's title becomes the tab strip that pages to the hidden ones (draw-tabs.ts)
  expect(f).not.toContain("─ files ─"); expect(f).not.toContain("─ plan ─"); expect(f).toContain("─ messages ─");
  expect(f).toContain("─ code  ·  files  ·  plan ─");
  expect(f.split("\n")).toHaveLength(30);
  b.renderer.stop();
});

// ---------- slash routing ----------

test("renderer-local slash commands never reach onSubmit: /theme recolors (SGR + toast + pet), /open reads the file, /diff switches the mode, /focus moves focus, /help opens the card AND passes through", () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-sx-unit-"));
  writeFileSync(join(cwd, "a.ts"), "const a = 1;\n");
  const { io, renderer, spy, feed } = make({ cwd });
  renderer.state.files.paths = ["a.ts", "src/b.ts"];
  const before = io.writes.length;
  feed("/theme ember\r");
  expect(renderer.themeName).toBe("ember");
  expect(renderer.state.theme).toBe("ember");
  expect(io.writes.slice(before).join("")).toContain("38;2;255;122;69"); // ember accent #ff7a45 on the wire (mutation: buildTheme not rebuilt → absent)
  expect(renderer.state.toasts.map((t) => t.text)).toContain("theme · ember");
  feed("/theme bogus\r");
  expect(renderer.state.toasts.at(-1)?.text).toContain("unknown theme");
  feed("/open a.ts\r");
  expect(renderer.state.code).toMatchObject({ file: "a.ts", mode: "code", content: "const a = 1;\n" });
  expect(renderer.state.focus).toBe("code");
  expect(renderer.frameText()).toContain("const a = 1;");
  feed("/diff\r");
  expect(renderer.state.code.mode).toBe("diff");
  feed("/focus messages\r");
  expect(renderer.state.focus).toBe("messages");
  feed("/help\r");
  expect(renderer.state.help).toBe(true);
  expect(spy.submits).toEqual(["/help"]);                                 // only /help reaches the app (its transcript listing)
  renderer.stop();
  rmSync(cwd, { recursive: true, force: true });
});

test("/plan /act /yolo /new /cost /tasks /exit /status, an unknown /x and free text all reach onSubmit verbatim", () => {
  const { renderer, spy, feed } = make();
  for (const line of ["/plan", "/act", "/yolo", "/new", "/cost", "/tasks", "/status", "/x now", "fix the tests", "!ls"]) feed(`${line}\r`);
  expect(spy.submits).toEqual(["/plan", "/act", "/yolo", "/new", "/cost", "/tasks", "/status", "/x now", "fix the tests", "!ls"]);
  feed("/exit\r");
  expect(spy.submits.at(-1)).toBe("/exit");                               // the app's close() runs from handleSlash
  expect(spy.exits).toBe(0);
  renderer.stop();
});

// ---------- esc-esc · ⌃c ----------

test("Esc-Esc while busy: the first Esc only arms `again to stop` (1.5 s), the second calls onInterrupt exactly once; an expired arm re-arms", () => {
  const { renderer, spy, feed, advance } = make();
  renderer.setBusy(true, "thinking…");
  feed("\x1b");
  expect(spy.interrupts).toBe(0);
  expect(renderer.frameText()).toContain("esc again to stop");
  feed("\x1b");
  expect(spy.interrupts).toBe(1);
  feed("\x1b"); advance(1600); feed("\x1b");                               // arm, let it expire, arm again → no interrupt
  expect(spy.interrupts).toBe(1);
  expect(renderer.frameText()).toContain("esc again to stop");
  renderer.stop();
});

test("⌃c: idle → onExit; busy → onInterrupt and the arm; a second ⌃c inside the 1.5 s window quits even though the run has not settled (two-press guarantee); setBusy(false) clears the arm", () => {
  const idle = make();
  idle.feed("\x03");
  expect(idle.spy.exits).toBe(1);
  idle.renderer.stop();
  const { renderer, spy, feed, advance, at } = make();
  renderer.setBusy(true);
  feed("\x03");
  expect(spy).toMatchObject({ interrupts: 1, exits: 0 });
  expect(renderer.state.ctrlCUntil).toBe(at() + 1500);
  feed("\x03");                                                             // still busy: keys.ts alone would interrupt again
  expect(spy).toMatchObject({ interrupts: 1, exits: 1 });
  renderer.setBusy(false);
  expect(renderer.state.ctrlCUntil).toBeUndefined();
  renderer.setBusy(true);
  feed("\x03"); advance(1600); feed("\x03");                                // window expired → interrupt again, no exit
  expect(spy).toMatchObject({ interrupts: 3, exits: 1 });
  renderer.stop();
});

// ---------- cards ----------

test("askApproval: the card renders (tool, preview, allow · always · deny) and resolves once on Enter, always via →, deny on Esc; stop() denies a pending card; a second approval waits its turn", async () => {
  const { renderer, feed, frame } = make();
  const detail = "--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b";
  const p1 = renderer.askApproval("edit", '{"path":"x.ts"}', detail);
  await settle();                                                                                         // the card opens through the one-at-a-time queue
  expect(frame()).toMatch(/needs your permission\s+edit/);
  expect(frame()).toMatch(/allow\s+always\s+all edits\s+deny/); // an edit card carries the accept-edits door
  expect(renderer.state.code).toMatchObject({ mode: "diff", diff: { file: "x.ts", add: 1, del: 1 } }); // the preview fills the diff view
  const p2 = renderer.askApproval("bash", '{"command":"ls"}');
  await settle();
  expect(renderer.state.card).toMatchObject({ kind: "approval", verdicts: ["once", "always", "all-edits", "deny"], tool: "edit" });                          // one card at a time
  feed("\r");
  expect(await p1).toBe("once");
  await settle();
  expect(renderer.state.card).toMatchObject({ kind: "approval", verdicts: ["once", "always", "deny"], tool: "bash" });                          // the queued one opened
  feed("\x1b[C"); feed("\r");                                                                             // → then Enter = always
  expect(await p2).toBe("always");
  const p3 = renderer.askApproval("write", "{}");
  await settle();
  feed("\x1b");
  expect(await p3).toBe("deny");
  expect(renderer.state.card).toBeNull();
  const p4 = renderer.askApproval("write", "{}");
  await settle();
  expect(renderer.state.card).not.toBeNull();
  renderer.stop();
  expect(await p4).toBe("deny");                                                                          // a stopped surface cannot answer
  expect(await renderer.askApproval("write", "{}")).toBe("deny");                                         // asked after stop
});

test("askQuestion: options + free text + skip render; ↓ Enter picks; the free-text row takes typed text; the abort signal dismisses (null); a second concurrent ask is rejected", async () => {
  const { renderer, feed, frame } = make();
  const q = { question: "Which database?", options: ["postgres", "sqlite"], allowFreeText: true };
  const p1 = renderer.askQuestion(q);
  const f = frame();
  expect(f).toContain("Which database?"); expect(f).toContain("postgres"); expect(f).toContain("type an answer…"); expect(f).toContain("skip this question");
  await expect(deadline(renderer.askQuestion(q), 300, "second ask")).rejects.toThrow(/already open/); // (mutation: accept it → it never settles)
  expect(renderer.state.card).toMatchObject({ kind: "question", selected: 0 });                        // the first card is untouched
  feed("\x1b[B"); feed("\r");
  expect(await deadline(p1, 1000, "first question")).toEqual({ choice: 1, label: "sqlite" });
  const p2 = renderer.askQuestion(q);
  feed("\x1b[B"); feed("\x1b[B"); feed("use mysql"); feed("\r");           // third row = free text
  expect(await deadline(p2, 1000, "free-text question")).toEqual({ text: "use mysql" });
  const ac = new AbortController();
  const p3 = renderer.askQuestion(q, ac.signal);
  expect(renderer.state.card).not.toBeNull();
  ac.abort();
  expect(await p3).toBeNull();
  expect(renderer.state.card).toBeNull();                                  // card gone with the run
  const aborted = new AbortController(); aborted.abort();
  expect(await renderer.askQuestion(q, aborted.signal)).toBeNull();        // nobody to ask
  const p4 = renderer.askQuestion(q);
  feed("\x1b");
  expect(await p4).toBeNull();                                             // Esc declines (the app decides whether to interrupt)
  renderer.stop();
});

test("pickOne: the palette lists the items under the title; typing filters, Enter resolves the selected value, Esc / ⌃k resolve null; a new picker cancels the old one; stop() resolves null", async () => {
  const { renderer, feed, frame } = make();
  const items = [{ value: "id-1", label: "#1 first question", description: "◆ 1 other branch" }, { value: "id-2", label: "#2 second question" }];
  const p1 = renderer.pickOne(items, "rewind to a turn");
  const f = frame();
  expect(f).toContain("rewind to a turn"); expect(f).toContain("#1 first question"); expect(f).toContain("◆ 1 other branch");
  feed("second"); feed("\r");
  expect(await p1).toBe("id-2");
  expect(renderer.state.palette).toBeNull();
  const p2 = renderer.pickOne(items);
  feed("\x1b");
  expect(await p2).toBeNull();
  const p3 = renderer.pickOne(items);
  feed("\x0b");                                                             // ⌃k toggles the palette closed
  expect(await p3).toBeNull();
  const p4 = renderer.pickOne(items);
  const p5 = renderer.pickOne(items);
  expect(await p4).toBeNull();                                             // superseded
  expect(await renderer.pickOne([])).toBeNull();
  renderer.stop();
  expect(await p5).toBeNull();
});

// ---------- rows: the event stream while busy, the Renderer methods when not ----------

test("busy: onEvent builds the rows (`~ edit notes.txt`, streaming text, run_end summary) and the app's duplicate calls are ignored — beginAssistant views, toolStart/toolEnd, and exactly the compaction / steer / run_end notes", () => {
  const { renderer, frame } = make();
  renderer.setBusy(true, "thinking…");
  expect(renderer.state.running).toBe(true);
  ev(renderer, { type: "run_start", runId: "r1", sessionId: "s", goal: "go" });
  ev(renderer, { type: "turn_start", turn: 1 });
  ev(renderer, { type: "message_update", messageId: "m1", delta: "Let me edit." });
  const v = renderer.beginAssistant(); v.append("Let me edit."); v.done();                         // the app's mirror of the same delta
  ev(renderer, { type: "tool_execution_start", callId: "c1", tool: "edit", args: { path: "C:/repo/notes.txt", edits: [{ tag: "t", anchorLine: 1, anchorHash: "h", newLines: ["x"] }] } });
  renderer.toolStart("c1", "edit", '{"path":"C:/repo/notes.txt"}');
  ev(renderer, { type: "tool_execution_end", callId: "c1", ok: true, output: "applied 1 edit(s); new TAG ab", durationMs: 3 });
  renderer.toolEnd("c1", true, "applied 1 edit(s)", 3);
  ev(renderer, { type: "compaction", strategy: "head-summarize", tokensBefore: 1000, tokensAfter: 500 });
  renderer.addSystemNote("history compacted: 1000 → 500 tokens");                                 // dropped: the reducer's compaction row exists
  ev(renderer, { type: "steer", text: "task done" });
  renderer.addSystemNote("↪ steering applied");                                                      // dropped
  renderer.addSystemNote("queued as steering");                                                     // kept: not a duplicate
  ev(renderer, { type: "run_end", status: "stopped", summary: "user interrupt" });
  renderer.addSystemNote("run stopped: user interrupt", "warn");                                    // dropped
  renderer.setBusy(false);
  const kinds = renderer.state.messages.map((m) => m.kind);
  expect(kinds).toEqual(["assistant", "tool", "compaction", "steer", "system", "system"]);
  expect(renderer.state.messages.filter((m) => m.kind === "assistant")).toHaveLength(1);           // no duplicate assistant row
  expect(renderer.state.messages.filter((m) => m.kind === "tool")).toHaveLength(1);                // no duplicate tool row
  expect(systemRows(renderer)).toEqual(["queued as steering", "run stopped: user interrupt"]);       // the reducer's own warn row + the kept note
  expect(frame()).toMatch(/~ edit\s+notes\.txt\s+\+1 −1/);
  expect(frame()).toContain("Let me edit.");
  expect(renderer.state.running).toBe(false);
  renderer.addSystemNote("after the run");                                                          // no stale counter
  expect(systemRows(renderer).at(-1)).toBe("after the run");
  renderer.stop();
});

test("not busy (history replay): beginAssistant streams a row, toolStart/toolEnd build a settled row from the args preview, addUser splits image chips, clearTranscript empties, prefillEditor fills the prompt", () => {
  const { renderer, frame, at } = make();
  const v = renderer.beginAssistant(); v.append("hello "); v.append("world"); v.done();
  expect(renderer.state.messages[0]).toMatchObject({ kind: "assistant", text: "hello world", streaming: false });
  renderer.toolStart("c1", "read", '{"path":"C:/repo/src/a.ts","offset":1,"limit":20}');
  renderer.toolEnd("c1", true, "src/a.ts#ab\n1#cd|x\n(showing lines 1-20 of 40)", 12);
  expect(renderer.state.messages[1]).toMatchObject({ kind: "tool", verb: "read", label: "a.ts", path: "src/a.ts", running: false, ok: true, detail: "20 lines", ms: 12 });
  renderer.toolStart("c2", "bash", '{"command":"bun test","cwd":"/x/y/z/very/long/path/that/gets/cut/off/by/the/preview/slice/at/one/hundred/twenty');
  expect(renderer.state.messages[2]).toMatchObject({ kind: "tool", verb: "run", label: "bun test" });     // recovered from the truncated preview
  renderer.toolEnd("c2", false, "exit=1\nFAIL x", 40);
  expect(renderer.state.messages[2]).toMatchObject({ ok: false, detail: "FAIL x" });
  renderer.addUser("look at this\n[image: shot.png] [image: b.jpg]");
  expect(renderer.state.messages[3]).toEqual({ kind: "user", text: "look at this", images: ["shot.png", "b.jpg"], at: at() });
  expect(frame()).toContain("▣ shot.png");
  renderer.prefillEditor("edit me");
  expect(renderer.state.input).toMatchObject({ text: "edit me", cur: 7 });
  expect(frame()).toContain("▌ edit me");
  renderer.clearTranscript();
  expect(renderer.state.messages).toEqual([]);
  renderer.stop();
});

test("setBusy(false) after a run the reducer never saw end (interrupted generator): running off, clock frozen, activity `stopped`, running tool rows marked interrupted", () => {
  const { renderer, advance, at } = make();
  const t = at();
  renderer.setBusy(true);
  ev(renderer, { type: "run_start", runId: "r", sessionId: "s", goal: "g" });
  ev(renderer, { type: "tool_execution_start", callId: "c", tool: "bash", args: { command: "sleep 9" } });
  advance(2000);
  renderer.setBusy(false);
  expect(renderer.state.running).toBe(false);
  expect(renderer.state.activity).toMatchObject({ state: "IDLE", label: "stopped", startedAt: t, endedAt: t + 2000 });
  expect(renderer.state.messages[0]).toMatchObject({ kind: "tool", running: false, ok: false, detail: "interrupted" });
  renderer.stop();
});

// ---------- status · attach ----------

test("setStatus → usage panel (tokens, model, mode + yolo markers) with `?`/`—` while no attach supplies a window or a cost", () => {
  const { renderer, frame } = make();
  renderer.setStatus({ provider: "anthropic", model: "claude-x", yolo: true, turns: 3, tokensIn: 4200, tokensOut: 1300, mode: "plan" });
  const f = frame();
  expect(f).toContain("tokens    5.5k  4.2k/1.3k");
  expect(f).toContain("context   ?");
  expect(f).toContain("cost      —  claude-x");                            // provider/model does not fit the 30-cell row → model alone (fitText)
  expect(f).toContain("plan mode  ·  auto  ·  claude-x · night"); // the yolo flag shows as "auto" (core/voice.ts)
  expect(renderer.state).toMatchObject({ mode: "plan", yolo: true, usage: { turns: 3, provider: "anthropic" } });
  renderer.stop();
});

test("attach: cwd + repo name, crew from tasks.list/subscribe (newest lane selected), todos.json → plan panel, usage() → cost + context bar, petName renames the pet; unsubscribed on stop", () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-sx-attach-"));
  const sessionsDir = join(cwd, ".rovecode", "sessions");
  mkdirSync(join(sessionsDir, "sess-1"), { recursive: true });
  writeFileSync(join(sessionsDir, "sess-1", "todos.json"), JSON.stringify({ version: 1, items: [{ id: "a", content: "read", status: "completed" }, { id: "b", content: "write", status: "pending" }] }));
  const { renderer, frame, advance } = make({ start: false });
  const subs = new Set<(t: TaskInfo) => void>();
  let tasks: TaskInfo[] = [];
  const ctx: SextantAttach = {
    cwd, sessionsDir, store: () => ({ id: "sess-1" }),
    tasks: { list: () => tasks.map((t) => ({ ...t })), subscribe: (fn) => { subs.add(fn); return () => { subs.delete(fn); }; } },
    model: () => ({ provider: "p", model: "m" }), contextWindow: () => 200_000,
    usage: () => ({ costUsd: 0.03, contextTokens: 24_000 }), petName: "stormy",
  };
  renderer.attach(ctx);
  renderer.start({ onSubmit() {}, onInterrupt() {}, onExit() {} });
  renderer.setStatus({ provider: "p", model: "m", yolo: false, turns: 1, tokensIn: 100, tokensOut: 50 });
  advance(600);
  let f = frame();
  expect(f).toContain("─ stormy ─");                                       // the pet's name
  expect(f).toContain("steps  1/2");                                       // todos.json loaded through sessionsDir/store().id
  expect(f).toMatch(/context   ━+─+ +24k\/200k 12%/);                       // the counts are on the row, not only the percent
  expect(f).toContain("cost      $0.030");
  expect(renderer.state.cwd).toBe(cwd);
  expect(subs.size).toBe(1);
  tasks = [{ id: "t1", label: "tests", agent: "worker", goal: "write tests", isolated: false, depth: 1, status: "running", createdAt: T0 }];
  for (const fn of subs) fn(tasks[0]!);
  expect(renderer.state.crew).toHaveLength(1);
  expect(renderer.state.code.lane).toBe(0);
  tasks = [...tasks, { id: "t2", label: "docs", agent: "worker", goal: "docs", isolated: false, depth: 1, status: "queued", createdAt: T0 }];
  for (const fn of subs) fn(tasks[1]!);
  expect(renderer.state.crew).toHaveLength(2);
  expect(renderer.state.code.lane).toBe(1);                                // the newest lane is selected
  f = frame();
  expect(f).toContain("crew  2 working");
  renderer.stop();
  expect(subs.size).toBe(0);                                               // unsubscribed
  rmSync(cwd, { recursive: true, force: true });
});

// ---------- input plumbing ----------

test("ESC hold: a chunk ending in a lone ESC waits for its continuation, so a mouse report split after its ESC byte is one event, not typed text; a lone ESC still becomes Escape when the hold elapses", () => {
  const { io, renderer } = make();
  io.feed("abc");
  io.feed("\x1b"); io.feed("[<0;1;1M");                                    // an SGR mouse press on the frame border, split after its ESC byte
  renderer.tick();
  expect(renderer.state.input.text).toBe("abc");                            // nothing typed from the report (parseInput alone would type `[<0;1;1M`)
  expect(renderer.state.focus).toBe("messages");
  io.feed("\x1b");                                                          // a real Escape, alone
  expect(renderer.state.input.text).toBe("abc");                            // held (20 ms), not yet an Escape
  renderer.flushInput();                                                    // = the hold timer fired
  expect(renderer.state.input.text).toBe("");                               // Esc cleared the prompt
  renderer.stop();
});

test("resize re-layouts the next frame: 139 columns drops the files column, 109 drops the right column too; the frame never exceeds the new size", () => {
  const { io, renderer } = make();
  expect(renderer.frameText()).toContain("─ files ─");
  io.resize(139, 44); renderer.tick();
  let f = renderer.frameText();
  // the files column is gone and the main slot's title is now the tab strip that pages to it (draw-tabs.ts)
  expect(f).not.toContain("─ files ─"); expect(f).toContain("─ plan ─"); expect(f).toContain("─ code  ·  files ─");
  for (const line of f.split("\n")) expect([...line].length).toBeLessThanOrEqual(139);
  io.resize(109, 30); renderer.tick();
  f = renderer.frameText();
  expect(f).not.toContain("─ plan ─"); expect(f).toContain("─ code  ·  files  ·  plan ─");
  expect(f.split("\n")).toHaveLength(30);
  renderer.stop();
});

test("#46 wiring: ∷ paints the crew board through setAgentsPainter; an open lane's scroll is written back through agentsScrollTop (codeScrollTop would pin it to 0); lane cells are click zones", () => {
  const { io, renderer, feed, frame } = make();
  renderer.state.crew = [{ id: "t1", label: "tests", agent: "worker", goal: "write tests", isolated: false, depth: 1, status: "done", createdAt: T0, finishedAt: T0 + 5000, summary: Array.from({ length: 80 }, (_, i) => `summary line ${i}`).join("\n") },
    { id: "t2", label: "docs", agent: "worker", goal: "docs", isolated: false, depth: 1, status: "running", createdAt: T0, startedAt: T0 }];
  feed("\x01");                                                              // ⌃a → agents mode
  let f = frame();
  expect(f).toMatch(/─ agents ─+ 1 running  1 done/);
  expect(f).toContain("t1 · worker");                                        // a lane cell (mutation: setAgentsPainter not called → the crew summary list)
  expect(f).toContain("t2 · worker");
  io.feed("\x1b[<0;40;5M");                                                  // click inside the first cell (code body starts at x=35,y=2)
  renderer.flushInput(); renderer.tick();
  expect(renderer.state.code.lane).toBe(0);
  feed("\r");                                                                // open the lane full-size (keys.ts: scroll = SCROLL_TAIL)
  f = frame();
  expect(renderer.state.code.laneOpen).toBe(true);
  expect(renderer.state.code.scroll).toBeGreaterThan(0);                    // the tail clamp, not 0
  expect(renderer.state.code.scroll).toBeLessThan(1e9);
  expect(f).toContain("summary line 79");                                    // the last line is on screen
  expect(f).not.toContain("summary line 30");                                // the middle scrolled away (the result row still quotes line 0)
  renderer.stop();
});

// ---------- re-verify pass: #44 LOW-2 · LOW-3 · MED-1 side fix ----------

test("no `cannot read` flash: the file reload runs BEFORE the paint, so the first frame after an edit's start shows the old content and the first frame after its end shows the new one — never the placeholder", () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-sx-flash-"));
  const file = join(cwd, "a.ts");
  writeFileSync(file, "const a = 1;\n");
  const { renderer, frame } = make({ cwd, git: () => null });
  renderer.setBusy(true);
  ev(renderer, { type: "run_start", runId: "r", sessionId: "s", goal: "g" });
  ev(renderer, { type: "tool_execution_start", callId: "c1", tool: "edit", args: { path: file, edits: [{ tag: "t", anchorLine: 1, anchorHash: "h", newLines: ["const a = 2;"] }] } });
  let f = frame();                                                          // the very next tick (mutation: paint before onTick → `cannot read a.ts`)
  expect(f).not.toContain("cannot read");
  expect(f).toContain("const a = 1;");
  writeFileSync(file, "const a = 2;\n");                                    // the tool wrote
  ev(renderer, { type: "tool_execution_end", callId: "c1", ok: true, output: "applied 1 edit(s); new TAG x", durationMs: 1 });
  f = frame();
  expect(f).not.toContain("cannot read");
  expect(f).toContain("const a = 2;");                                      // reloaded in the same tick
  renderer.stop();
  rmSync(cwd, { recursive: true, force: true });
});

test("git runs beside the frame loop: while a 300 ms git call is pending the painter keeps painting (a synchronous scan would paint nothing), and the scan's result lands afterwards — branch, files and statuses on the next frame", async () => {
  // What this test is about is ORDER, not deadlines: the scan must not be on the painter's thread of
  // control. It used to say that in wall-clock terms — "no gap between frames longer than 200 ms" — and a
  // wall-clock claim measures the machine, so under a full suite (frames at 28 ms against a 40 ms budget)
  // it failed while the code it guards was fine. The runner is ours, so it can mark the frame counter when
  // each git call goes out and again when it comes back: frames painted in between is the real invariant,
  // and it is the same number on a fast machine and a loaded one.
  let resolved = 0;
  let renderer!: SextantRenderer;
  const marks: { branchAtCall: string | null; painted: number }[] = [];
  const slow: GitRunnerAsync = (args) => {
    const framesAtCall = renderer.frames;
    const branchAtCall = renderer.state.repo.branch;
    return new Promise((res) => setTimeout(() => {
      resolved++;
      marks.push({ branchAtCall, painted: renderer.frames - framesAtCall });
      const k = args.join(" ");
      res(k.startsWith("ls-files") ? { status: 0, stdout: "a.ts\0src/b.ts\0" } : k.startsWith("status") ? { status: 0, stdout: " M a.ts\0" } : k === "rev-parse --abbrev-ref HEAD" ? { status: 0, stdout: "feature/slow\n" } : { status: 128, stdout: "" });
    }, 300));
  };
  const io = new MemoryIO(160, 44, {});
  renderer = new SextantRenderer({ io, cwd: "C:/repo", git: slow, pet: "rovecode" });   // the real clock; the scan is on
  renderer.start({ onSubmit() {}, onInterrupt() {}, onExit() {} });

  const t0 = Date.now();
  let last = t0, maxGap = 0, frames = renderer.frames;
  while (resolved < 3 && Date.now() - t0 < 20_000) {
    await new Promise((r) => setTimeout(r, 5));
    if (renderer.frames !== frames) { const t = Date.now(); maxGap = Math.max(maxGap, t - last); last = t; frames = renderer.frames; }
  }
  expect(resolved).toBe(3);                                                 // ls-files, status, rev-parse — all landed
  expect(marks).toHaveLength(3);
  expect(marks[0]!.branchAtCall).toBeNull();                                // the scan was genuinely pending when it went out
  // A synchronous 300 ms scan paints 0 frames while it runs; an asynchronous one paints whatever the
  // interval manages. The floor is therefore ONE, not two: one is the whole distinction between
  // blocking and not blocking, and every number above it is the machine's, not the painter's. It was
  // two, and two failed under a loaded suite — the timer loop was starved, not the code under test,
  // so the test reported the machine again in a different unit. What it may never see is zero.
  for (const m of marks) expect(m.painted).toBeGreaterThanOrEqual(1);
  expect(renderer.frames).toBeGreaterThan(5);                               // the boot reveal animates: a frame every tick
  expect(renderer.state).toMatchObject({ repo: { branch: "feature/slow" }, files: { paths: ["a.ts", "src/b.ts"] } });
  expect(renderer.state.files.statuses.get("a.ts")).toBe("M");
  renderer.tick();
  expect(renderer.frameText()).toContain("feature/slow");                   // painted, not just stored
  renderer.stop();
  // the gap is worth knowing and worth not gating on: it is the machine's number, not the painter's
  console.log(`sextant git-async: frames painted per pending call ${marks.map((m) => m.painted).join("/")}, longest frame gap ${maxGap} ms`);
}, 30_000);

test("a DENIED approval drops its pre-edit snapshot: a later ungated edit of the same file never diffs against that stale base (the row keeps the reducer's counts)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-sx-deny-"));
  const file = join(cwd, "x.ts");
  writeFileSync(file, "a\n");
  const { renderer, feed } = make({ cwd, git: () => null });
  const p = renderer.askApproval("edit", JSON.stringify({ path: file }), "--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b");
  await settle();
  feed("\x1b");                                                               // deny
  expect(await p).toBe("deny");
  await settle();
  writeFileSync(file, "a\nb\nc\n");                                           // a later ungated edit landed (yolo)
  renderer.setBusy(true);
  ev(renderer, { type: "run_start", runId: "r", sessionId: "s", goal: "g" });
  ev(renderer, { type: "tool_execution_start", callId: "c1", tool: "edit", args: { path: file, edits: [{ tag: "stale", anchorLine: 1, anchorHash: "zzz", newLines: ["a"] }] } });
  ev(renderer, { type: "tool_execution_end", callId: "c1", ok: true, output: "applied 1 edit(s); new TAG y", durationMs: 1 });
  await settle(); await settle(); await settle();
  const row = renderer.state.messages.find((m) => m.kind === "tool") as ToolRow;
  expect(row).toMatchObject({ add: 1, del: 1 });                             // (mutation: snapshot kept → diffed against "a\n" → +2 −0)
  renderer.stop();
  rmSync(cwd, { recursive: true, force: true });
});

test("frame budget: a 200-message transcript (user, assistant, tool rows) paints in well under 40 ms per frame headless", () => {
  const { renderer, advance } = make();
  renderer.setBusy(true);
  ev(renderer, { type: "run_start", runId: "r", sessionId: "s", goal: "g" });
  for (let i = 0; i < 200; i++) {
    if (i % 3 === 0) renderer.addUser(`question ${i} about the ${"x".repeat(i % 40)} module`);
    else if (i % 3 === 1) ev(renderer, { type: "message_update", messageId: `m${i}`, delta: `answer ${i} — ${"lorem ipsum dolor sit amet ".repeat(4)}` });
    else { ev(renderer, { type: "tool_execution_start", callId: `c${i}`, tool: "read", args: { path: `src/f${i}.ts` } }); ev(renderer, { type: "tool_execution_end", callId: `c${i}`, ok: true, output: "(showing lines 1-9 of 9)", durationMs: 1 }); }
  }
  renderer.setBusy(false);
  expect(renderer.state.messages.length).toBeGreaterThanOrEqual(200);
  // Median, not mean, and two warm-up frames first. The claim is "this code can paint a frame in
  // budget", and a mean over ten frames fails that claim whenever the machine preempts one of them —
  // which it does whenever another test file (or another agent's suite) is running beside this one.
  // A median needs half the frames to be slow before it moves, so it measures the painter and not the load.
  advance(40); advance(40);
  const N = 11;
  const times: number[] = [];
  for (let i = 0; i < N; i++) { const t = performance.now(); advance(40); times.push(performance.now() - t); }
  const sorted = [...times].sort((a, b) => a - b);
  const median = sorted[Math.floor(N / 2)] ?? 0;
  console.log(`sextant frame budget: median ${median.toFixed(2)} ms/frame (min ${sorted[0]?.toFixed(2)}, max ${sorted[N - 1]?.toFixed(2)}) over ${renderer.state.messages.length} messages at 160×44`);
  expect(median).toBeLessThan(40);
  renderer.stop();
});

test("a keystroke paints without waiting for the frame timer — the echo must not depend on a tick", async () => {
  // Input was always HANDLED on the stdin event; only the paint waited for the next 40 ms tick. That is
  // invisible on an idle machine and it is the whole symptom on a loaded one, where setInterval is
  // starved: the prompt looks like it has stopped accepting input while the state behind it is fine.
  // So this drives the renderer the way a starved loop sees it — feed bytes, never tick — and requires
  // the screen to have been written.
  const { renderer, io } = make();
  for (let i = 0; i < 50; i++) renderer.addUser(`question ${i}`);
  renderer.tick();

  let paints = 0;
  const write = (io as unknown as { write(s: string): void }).write.bind(io);
  (io as unknown as { write(s: string): void }).write = (s: string) => { if (s.length > 0) paints += 1; write(s); };

  for (const ch of "hello") io.feed(ch);            // no flushInput, no tick
  expect(renderer.state.input.text).toBe("hello");
  expect(paints).toBeGreaterThanOrEqual(5);          // one per keystroke, not zero

  // ...and a paste arriving as ONE chunk still paints once, so the saving is not undone by echoing
  // every character of a two-hundred-character paste separately
  paints = 0;
  io.feed("a paste of many characters arriving together");
  expect(paints).toBe(1);

  // ...and once the loop is stopped, input paints NOTHING. A key can end the session — ⌃c, /exit, a
  // click on the exit row — and by the time the chunk finishes the terminal has been handed back, so a
  // frame written then lands on the shell the user was just returned to. An integration test caught
  // this the first time; it belongs here too, next to the behaviour that caused it.
  renderer.stop();
  paints = 0;
  io.feed("typed after the session ended");
  expect(paints).toBe(0);
});

// ---------- chat text selection (selection.ts): drag copies, a click still clicks ----------

/** SGR mouse bytes (1-based on the wire, parseInput makes them 0-based events) */
const mPress = (x: number, y: number): string => `\x1b[<0;${x + 1};${y + 1}M`;
const mDrag = (x: number, y: number): string => `\x1b[<32;${x + 1};${y + 1}M`;
const mRelease = (x: number, y: number): string => `\x1b[<0;${x + 1};${y + 1}m`;

test("drag over the chat selects and copies on release (OSC 52 + a toast); the transcript is untouched", () => {
  const { io, renderer, feed, advance } = make();
  renderer.state.messages.push({ kind: "assistant", text: "COPYME-TOKEN-123", streaming: false, id: "sel-1" });
  advance(200); // a direct state push marks nothing dirty; the idle-repaint window makes the tick paint
  const frame = renderer.frameText().split("\n");
  const y = frame.findIndex((l) => l.includes("COPYME-TOKEN-123"));
  expect(y).toBeGreaterThan(0);
  const x0 = frame[y]!.indexOf("COPYME-TOKEN-123");
  const x1 = x0 + "COPYME-TOKEN-123".length - 1;

  feed(mPress(x0, y));
  feed(mDrag(Math.floor((x0 + x1) / 2), y));
  feed(mDrag(x1, y));
  const mid = io.output();
  expect(mid).not.toContain("\x1b]52;c;"); // nothing is copied until the button is released
  feed(mRelease(x1, y));

  const m = /\x1b\]52;c;([A-Za-z0-9+/=]+)\x07/.exec(io.output());
  expect(m).not.toBeNull();
  const copied = Buffer.from(m![1]!, "base64").toString("utf8");
  expect(copied).toBe("COPYME-TOKEN-123");
  expect(renderer.state.toasts.some((t) => t.text.includes("copied 16 characters"))).toBe(true);
  expect(renderer.state.messages.filter((m) => m.kind === "system" && (m as { text: string }).text.includes("copied")).length).toBe(0); // the toast is a toast, not a transcript row
});

test("a press that never moves is replayed on release: the click still clicks (messages focus)", () => {
  const { renderer, feed } = make();
  renderer.state.focus = "code";
  const r = renderer.state; // the messages panel: a bare press+release lands in its fall-through
  renderer.tick();
  const frame = renderer.frameText().split("\n");
  const y = frame.findIndex((l) => l.includes("─ messages ─")) + 3; // inside the panel, below its border
  feed(mPress(60, y));
  expect(r.focus).toBe("code"); // held: the press has not fired yet
  feed(mRelease(60, y));
  expect(r.focus).toBe("messages"); // released without a drag: replayed verbatim
});

test("any key cancels a selection in progress; Esc-hold and wheel are untouched by the gesture", () => {
  const { io, renderer, feed, advance } = make();
  renderer.state.messages.push({ kind: "assistant", text: "COPYME-TOKEN-123", streaming: false, id: "sel-2" });
  advance(200);
  const frame = renderer.frameText().split("\n");
  const y = frame.findIndex((l) => l.includes("COPYME-TOKEN-123"));
  const x0 = frame[y]!.indexOf("COPYME-TOKEN-123");
  feed(mPress(x0, y));
  feed(mDrag(x0 + 8, y));
  feed("\x1b"); // a key mid-gesture: the selection dies with it
  feed(mRelease(x0 + 8, y));
  expect(io.output()).not.toContain("\x1b]52;c;"); // no copy after a cancel
});
