/** Port #44 integration: the sextant surface through the REAL app loop (runTui → agentLoop →
 *  SextantRenderer → Screen → an in-memory TerminalIO), exactly like tui-app.test.ts drives the pi-tui
 *  renderer through a VirtualTerminal. Covers the #44 bar: the approval card (deny leaves the file
 *  untouched, allow applies and the code panel flips to the diff view with real hunks + `+a −b`),
 *  renderer-local slash commands vs the ones that reach handleSlash, Esc-Esc interrupt, quit restores the
 *  terminal and clears the frame interval, onEvent ordering + attach-once (recording FakeRenderer), the
 *  #46 crew board over rt.tasks, resize re-layout, and the smoke module itself. */

import { test, expect, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { partsText } from "../../src/core/loop.ts";
import { resetExecutor } from "../../src/core/executor.ts";
import { fileTag, lineHash } from "../../src/coding/hashline.ts";
import { mockStream, textTurn, toolTurn } from "../../src/providers/stream.ts";
import { SextantRenderer } from "../../src/sextant/sextant-renderer.ts";
import type { SextantAttach, ToolRow } from "../../src/sextant/types.ts";
import { runTui } from "../../src/tui/app.ts";
import type { ApprovalAnswer, AssistantView, Renderer, RendererHooks, StatusInfo } from "../../src/tui/renderer.ts";
import { MemoryIO } from "../../src/tui/sextant-io.ts";
import { sextantSmoke } from "../../src/tui/sextant-smoke.ts";
import type { AssistantTurn, Message, ModelRef, RunEvent, StreamEvent, StreamFn, StreamOptions } from "../../src/core/types.ts";

afterEach(() => resetExecutor());

// ---------- helpers ----------

/** poll the renderer's frame (ticking it so no 40 ms interval has to elapse) until pred holds */
async function until(r: SextantRenderer, pred: (frame: string) => boolean, ms = 8000): Promise<string> {
  const deadline = Date.now() + ms;
  let text = "";
  while (Date.now() < deadline) {
    r.tick();
    text = r.frameText();
    if (pred(text)) return text;
    await new Promise((res) => setTimeout(res, 20));
  }
  return text;
}
async function waitFor(cond: () => boolean, ms = 8000, what = "condition"): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`${what}: not true within ${ms}ms`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
function deadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const bomb = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error(`${what}: not settled within ${ms}ms`)), ms); });
  return Promise.race([p, bomb]).finally(() => clearTimeout(t));
}
const turn = (t: AssistantTurn): StreamEvent => ({ type: "turn", turn: t });
const systemTexts = (r: SextantRenderer): string[] => r.state.messages.filter((m) => m.kind === "system").map((m) => (m as { text: string }).text);
const LEAVE = ["\x1b[?1049l", "\x1b[?25h", "\x1b[?1006l"];

function surface(cols = 160, rows = 44) {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-sextant-"));
  const io = new MemoryIO(cols, rows, { COLORTERM: "truecolor" });
  const renderer = new SextantRenderer({ io, cwd, pet: "rovecode" });
  return { cwd, io, renderer };
}

/** gated TUI whose first scripted turn is an anchored edit of notes.txt (old-line → new-line) — tui-app.test.ts gatedEditApp */
function gatedEditApp(cwd: string, io: MemoryIO, renderer: SextantRenderer, finalText: string) {
  const target = join(cwd, "notes.txt");
  const content = "keep-1\nold-line\nkeep-2\n";
  writeFileSync(target, content);
  const edit = { path: target, edits: [{ tag: fileTag(content), anchorLine: 2, anchorHash: lineHash("old-line"), newLines: ["new-line"] }] };
  const stream = mockStream({ turns: [toolTurn([{ id: "t1", tool: "edit", args: edit }]), textTurn(finalText)] });
  const app = runTui({ renderer, stream, cwd, yolo: false, exitOnClose: false, model: "scripted" });
  io.feed("edit it\r");
  return { app, target, content };
}

async function quit(io: MemoryIO, renderer: SextantRenderer, app: Promise<void>, cwd: string): Promise<string> {
  io.feed("\x03");
  await deadline(app, 8000, "runTui after ⌃c");
  const tail = io.output().slice(-400);
  expect(renderer.active).toBe(false);          // the frame interval is cleared — no live handle after runTui
  expect(io.listeners).toBe(0);                 // input + resize unsubscribed
  expect(io.raw).toBe(false);                   // raw mode left
  for (const seq of LEAVE) expect(tail).toContain(seq);
  await renderer.drain();  // the repo watcher's git children are gone — only then may the cwd go
  await rmTemp(cwd);
  return tail;
}

/** Remove the scratch repo. On Windows a child `git status` from the repo watcher can still hold the
 *  directory for a few ms after the surface stopped, and rmSync then throws EBUSY — that was THE
 *  "tui-sextant flake": every test in this file exits through quit(), so a different test failed each
 *  run. The renderer now waits for its git children (sextant-renderer stop → repo drain); this retry is
 *  the belt to that brace, because handle release on Windows lags the process exit itself. */
async function rmTemp(cwd: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { rmSync(cwd, { recursive: true, force: true }); return; }
    catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if ((code !== "EBUSY" && code !== "EPERM" && code !== "ENOTEMPTY") || attempt >= 20) throw e;
      await new Promise((r) => setTimeout(r, 25));
    }
  }
}

// ---------- approval card: deny / allow ----------

test("gated edit: the card names the edit + allow · always · all edits · deny (the approver runs BEFORE tool_execution_start, so no row yet); Esc denies, the file is untouched, the run continues", async () => {
  const { cwd, io, renderer } = surface();
  const { app, target, content } = gatedEditApp(cwd, io, renderer, "after denial.");
  const card = await until(renderer, (f) => f.includes("needs your permission"));
  expect(card).toMatch(/needs your permission\s+edit\s+\{/);      // the card header: tool + args preview
  expect(card).toMatch(/allow\s+always\s+all edits\s+deny/);      // the verdict buttons (an edit card carries the accept-edits door)
  expect(card).toContain("edit it");                             // the user echo
  expect(card).toContain("◆ needs you");                         // the frame header follows the card
  expect(readFileSync(target, "utf8")).toBe(content);            // nothing applied before consent
  io.feed("\x1b");                                               // Esc → deny (keys.ts onCardKey)
  const after = await until(renderer, (f) => f.includes("after denial."));
  expect(after).not.toContain("needs your permission");          // card gone
  expect(readFileSync(target, "utf8")).toBe(content);            // denied → file unchanged
  expect(renderer.state.messages.some((m) => m.kind === "tool")).toBe(false); // a refused call never executes: no tool row (#41 denied scenario)
  expect(systemTexts(renderer).some((t) => t.startsWith("permission denied"))).toBe(true); // the reducer's tool_call_failed row (mutation: onEvent not wired → absent)
  await quit(io, renderer, app, cwd);
}, 20_000);

test("gated edit: allow once applies exactly the previewed change; the code panel flips to the diff view with real hunks and the title carries +1 −1", async () => {
  const { cwd, io, renderer } = surface();
  const { app, target } = gatedEditApp(cwd, io, renderer, "applied.");
  const card = await until(renderer, (f) => f.includes("needs your permission"));
  expect(renderer.state.code.mode).toBe("diff");                 // pre-approval: the previewDiff hunks fill the diff view
  expect(renderer.state.code.diff?.file).toBe("notes.txt");
  expect(card).toContain("new-line");                            // the pending change is on screen before consent
  io.feed("\r");                                                 // Enter on `allow` = once
  // the diff view arrives one macrotask after the end event (deferred diffFor seam) — poll for the title, not just the text
  const done = await until(renderer, (f) => f.includes("applied.") && /─ diff ─+ notes\.txt\s+\+1 −1/.test(f));
  expect(done).toMatch(/~ edit\s+notes\.txt\s+\+1 −1/);          // the reducer's tool row with the landed diff's counts
  expect(readFileSync(target, "utf8")).toBe("keep-1\nnew-line\nkeep-2\n");
  expect(renderer.state.code.mode).toBe("diff");                 // post-edit: HEAD/pre-edit vs disk hunks (deferred diffFor seam)
  const d = renderer.state.code.diff!;
  expect(d.file).toBe("notes.txt");
  expect(d.add).toBe(1); expect(d.del).toBe(1);
  expect(d.hunks.flatMap((h) => h.rows).filter((r) => r.op === "+").map((r) => r.text)).toEqual(["new-line"]);
  expect(done).toMatch(/─ diff ─+ notes\.txt\s+\+1 −1/);        // the code title's +a −b
  const row = renderer.state.messages.find((m) => m.kind === "tool");
  expect(row).toMatchObject({ kind: "tool", verb: "edit", label: "notes.txt", path: "notes.txt", ok: true, add: 1, del: 1 });
  await quit(io, renderer, app, cwd);
}, 20_000);

// ---------- slash commands: renderer-local vs handleSlash ----------

test("/theme ember recolors with no model turn; /open /diff /focus stay local; /plan /act /yolo /new /cost /tasks reach handleSlash; /exit quits and restores the terminal", async () => {
  const { cwd, io, renderer } = surface();
  writeFileSync(join(cwd, "notes.txt"), "alpha\nbeta\n");
  let turns = 0;
  const inner = mockStream({ turns: [textTurn("never")] });
  const stream: StreamFn = (m, msgs, o) => { turns++; return inner(m, msgs, o); };
  const app = runTui({ renderer, stream, cwd, yolo: false, exitOnClose: false, model: "scripted" });
  await until(renderer, (f) => f.includes("/help lists commands"));
  const before = io.writes.length;
  io.feed("/theme ember\r");
  await until(renderer, () => renderer.themeName === "ember");
  expect(renderer.themeName).toBe("ember");
  expect(io.writes.slice(before).join("")).toContain("38;2;255;122;69"); // ember accent #ff7a45 reached the terminal (mutation: theme not rebuilt → night SGR only)
  expect(renderer.state.toasts.some((t) => t.text === "theme · ember")).toBe(true);
  await until(renderer, () => renderer.state.files.paths.includes("notes.txt")); // the file list lands from the async repo scan (git runs beside the loop)
  io.feed("/open notes.txt\r");
  await until(renderer, () => renderer.state.code.file === "notes.txt");
  expect(renderer.state.code.file).toBe("notes.txt");
  expect(renderer.state.code.content).toBe("alpha\nbeta\n");        // local: read from disk
  expect(renderer.state.focus).toBe("code");
  io.feed("/diff\r");
  await until(renderer, () => renderer.state.code.mode === "diff");
  io.feed("/focus messages\r");
  await until(renderer, () => renderer.state.focus === "messages");
  expect(turns).toBe(0);                                             // none of the local commands started a run
  expect(systemTexts(renderer).some((t) => t.startsWith("unknown command"))).toBe(false); // none leaked to handleSlash either
  for (const cmd of ["/plan", "/act", "/yolo", "/new", "/cost", "/tasks"]) { io.feed(`${cmd}\r`); }
  await until(renderer, () => systemTexts(renderer).some((t) => t.includes("(no background tasks)")));
  const notes = systemTexts(renderer).join("\n");
  expect(notes).toContain("read-only tools");                        // /plan → togglePlanAct
  expect(notes).toContain("mode: auto (never asks)");                // /yolo — the screen name (core/voice.ts)
  expect(notes).toContain("nothing to branch — no turns yet");       // /new → cmdNew
  expect(notes).toMatch(/tokens: 0 in \/ 0 out/);                    // /cost → buildCostNote
  expect(notes).toContain("(no background tasks)");                  // /tasks
  expect(renderer.state.yolo).toBe(true);                            // setStatus after /yolo
  expect(renderer.state.mode).toBe("act");                           // /plan then /act
  expect(turns).toBe(0);
  io.feed("/exit\r");
  await deadline(app, 8000, "runTui after /exit");
  expect(renderer.active).toBe(false);
  for (const seq of LEAVE) expect(io.output().slice(-400)).toContain(seq);
  rmSync(cwd, { recursive: true, force: true });
}, 20_000);

// ---------- Esc-Esc interrupts ----------

/** parks until the run's own signal aborts, then yields an aborted turn (tui-wiring idiom) */
async function parkUntilAbort(opts: StreamOptions | undefined): Promise<StreamEvent> {
  const sig = opts?.signal;
  if (!sig?.aborted) await new Promise<void>((r) => sig?.addEventListener("abort", () => r(), { once: true }));
  return turn({ parts: [], stopReason: "aborted", usage: { input: 0, output: 0 } });
}

test("Esc-Esc while a run is parked interrupts it exactly once: the first Esc only arms the footer hint, the second aborts the run and the surface settles idle", async () => {
  const { cwd, io, renderer } = surface();
  let aborted: AbortSignal | null = null;
  const stream: StreamFn = async function* (_m: ModelRef, _msgs: Message[], opts?: StreamOptions): AsyncGenerator<StreamEvent> {
    aborted = opts?.signal ?? null;
    yield await parkUntilAbort(opts);
  };
  const app = runTui({ renderer, stream, cwd, yolo: true, exitOnClose: false, model: "scripted" });
  io.feed("go\r");
  await waitFor(() => aborted !== null, 8000, "run parked in its provider turn");
  const running = await until(renderer, (f) => f.includes("esc stop"));
  expect(running).toContain("esc stop");
  io.feed("\x1b"); renderer.flushInput();                        // a lone ESC is held 20 ms; flush = the timer fired
  const armed = await until(renderer, (f) => f.includes("again to stop"));
  expect(armed).toContain("esc again to stop");
  expect(aborted!.aborted).toBe(false);                            // the first Esc only arms
  io.feed("\x1b"); renderer.flushInput();
  const after = await until(renderer, (f) => f.includes("run interrupted") && !f.includes("esc stop"));
  expect(aborted!.aborted).toBe(true);
  expect(after).toContain("run interrupted");
  expect(renderer.state.running).toBe(false);                      // setBusy(false) settled the run the reducer never saw end
  expect(renderer.state.activity.label).toBe("stopped");
  await quit(io, renderer, app, cwd);
}, 20_000);

// ---------- onEvent order + attach once (recording FakeRenderer) ----------

class RecordingRenderer implements Renderer {
  hooks!: RendererHooks;
  log: string[] = [];
  attachCalls = 0;
  ctx: SextantAttach | null = null;
  start(h: RendererHooks): void { this.hooks = h; }
  stop(): void { this.log.push("stop"); }
  setCommands(): void {}
  addUser(text: string): void { this.log.push(`addUser:${text}`); }
  addSystemNote(text: string): void { this.log.push(`note:${text.split("\n")[0]}`); }
  beginAssistant(): AssistantView { this.log.push("beginAssistant"); return { append() {}, done() {} }; }
  toolStart(): void { this.log.push("toolStart"); }
  toolUpdate(): void {}
  toolEnd(): void { this.log.push("toolEnd"); }
  async askApproval(): Promise<ApprovalAnswer> { return "once"; }
  async askQuestion(): Promise<null> { return null; }
  async pickOne(): Promise<string | null> { return null; }
  clearTranscript(): void {}
  prefillEditor(): void {}
  setBusy(b: boolean): void { this.log.push(`busy:${b}`); }
  setStatus(_i: StatusInfo): void { this.log.push("setStatus"); }
  onEvent(ev: RunEvent): void { this.log.push(`event:${ev.type}`); }
  attach(ctx: SextantAttach): void { this.attachCalls++; this.ctx = ctx; this.log.push("attach"); }
}

test("onEvent sees every RunEvent BEFORE the app's per-event handlers (order pinned); attach is called exactly once, before start, with the live runtime handles", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-sextant-"));
  const r = new RecordingRenderer();
  const probe = join(cwd, "o.txt");
  const stream = mockStream({ turns: [toolTurn([{ id: "t1", tool: "write", args: { path: probe, content: "x\n" } }]), textTurn("done text")] });
  const app = runTui({ renderer: r, stream, cwd, yolo: true, exitOnClose: false, model: "scripted" });
  expect(r.attachCalls).toBe(1);                                   // synchronous, before any input
  expect(r.log.indexOf("attach")).toBeLessThan(r.log.indexOf("setStatus")); // attach precedes start()/the boot status
  r.hooks.onSubmit("write it");
  await waitFor(() => r.log.includes("busy:false"), 8000, "run settled");
  const L = r.log;
  const at = (s: string, from = 0) => { const i = L.indexOf(s, from); if (i < 0) throw new Error(`${s} not logged: ${L.join(" ")}`); return i; };
  const runStart = at("event:run_start");
  expect(at("busy:true")).toBeLessThan(runStart);
  const turnStart = at("event:turn_start", runStart);
  expect(at("setStatus", runStart)).toBeGreaterThan(turnStart);   // turn_start's pushStatus comes AFTER onEvent(turn_start) (mutation: onEvent after the handlers → flips)
  const toolEv = at("event:tool_execution_start", runStart);
  expect(at("toolStart", runStart)).toBeGreaterThan(toolEv);      // toolStart follows its event
  expect(at("event:tool_execution_end", runStart)).toBeLessThan(at("toolEnd", runStart));
  expect(at("event:run_end", runStart)).toBeLessThan(at("busy:false", runStart));
  expect(L.filter((l) => l === "attach")).toHaveLength(1);
  const ctx = r.ctx!;
  expect(ctx.cwd).toBe(cwd);
  expect(ctx.sessionsDir).toBe(join(cwd, ".rovecode", "sessions"));
  expect(typeof ctx.store().id).toBe("string");
  expect(ctx.model().model).toBe("scripted");                     // the mode's model (the provider id follows the host env)
  expect(ctx.contextWindow()).toBeUndefined();                     // a scripted model is not in the catalog
  const u = ctx.usage!();
  expect(u.costUsd).toBeNull();
  expect(u.contextTokens).toBeGreaterThan(0);                      // the transcript has a user + assistant message now
  expect(ctx.tasks.list()).toEqual([]);
  r.hooks.onExit();
  await deadline(app, 8000, "runTui after exit");
  rmSync(cwd, { recursive: true, force: true });
}, 20_000);

// ---------- #46 crew board over rt.tasks ----------

/** prompt-keyed script (tui-wiring taskStream): "PARENT <label>" starts a child task parked until its
 *  run aborts; anything else echoes */
function taskStream(childSignals: Map<string, AbortSignal>): StreamFn {
  return async function* (_m: ModelRef, messages: Message[], opts?: StreamOptions): AsyncGenerator<StreamEvent> {
    const users = messages.filter((m) => m.role === "user").map((m) => partsText(m.parts));
    const prompt = [...users].reverse().find((u) => !u.startsWith("task t")) ?? "";
    const at = messages.findLastIndex((m) => m.role === "user" && partsText(m.parts) === prompt);
    const tools = messages.slice(at + 1).filter((m) => m.role === "tool").length;
    if (prompt.startsWith("PARENT")) {
      const label = prompt.split(" ")[1] ?? "x";
      if (tools === 0) { yield turn(toolTurn([{ id: `${label}-s`, tool: "task", args: { action: "start", goal: `CHILD ${label}`, label } }])); return; }
      yield turn(textTurn(`${prompt} done`)); return;
    }
    if (prompt.startsWith("CHILD")) { childSignals.set(prompt, opts!.signal!); yield await parkUntilAbort(opts); return; }
    yield turn(textTurn("ok"));
  };
}

test("crew board (#46): a running task from rt.tasks appears as a ∷ lane cell within one frame; `/tasks cancel <id>` flips the cell to cancelled", async () => {
  const { cwd, io, renderer } = surface();
  const childSignals = new Map<string, AbortSignal>();
  const app = runTui({ renderer, stream: taskStream(childSignals), cwd, yolo: true, exitOnClose: false, model: "scripted" });
  io.feed("PARENT one\r");
  await until(renderer, (f) => f.includes("PARENT one done"));
  await waitFor(() => childSignals.has("CHILD one"), 8000, "child one parked");
  expect(renderer.state.crew.map((t) => [t.id, t.label, t.status])).toEqual([["t1", "one", "running"]]); // setCrew from tasks.subscribe/list
  io.feed("\x01");                                                 // ⌃a → agents mode
  renderer.tick();
  const board = renderer.frameText();
  expect(board).toMatch(/─ agents ─+ 1 running/);                  // code title (mutation: drop setAgentsPainter → the crew summary text instead of cells)
  expect(board).toMatch(/[◇◈◆] one\s+00:0\d · —/);                 // the lane cell header: glyph + label + clock · tokens
  expect(board).toMatch(/t1 · \S+/);                               // id · agent row (the cancel handle)
  expect(board).toContain("running");
  io.feed("/tasks cancel t1\r");
  const cancelled = await until(renderer, (f) => f.includes("▪ one") && f.includes("cancelled"));
  expect(cancelled).toContain("▪ one");                            // laneGlyph cancelled
  expect(renderer.state.crew[0]!.status).toBe("cancelled");
  expect(childSignals.get("CHILD one")!.aborted).toBe(true);       // the child's run really aborted
  expect(systemTexts(renderer).some((t) => t.includes("task t1 (one) cancelled"))).toBe(true); // the settlement note
  await quit(io, renderer, app, cwd);
}, 30_000);

// ---------- resize ----------

test("resize mid-session re-layouts: the files column disappears at 139 columns and returns at 160", async () => {
  const { cwd, io, renderer } = surface();
  const app = runTui({ renderer, stream: mockStream({ turns: [textTurn("x")] }), cwd, yolo: true, exitOnClose: false, model: "scripted" });
  const wide = await until(renderer, (f) => f.includes("─ files ─") && f.includes("─ rovecode ─")); // past the boot reveal (every panel shown)
  expect(wide).toContain("─ files ─");
  io.resize(139, 44); renderer.tick();
  const narrow = renderer.frameText();
  expect(narrow).not.toContain("─ files ─");
  expect(narrow).toContain("─ plan ─");                            // the right column stays at 139
  expect(narrow.split("\n")).toHaveLength(44);
  for (const line of narrow.split("\n")) expect([...line].length).toBeLessThanOrEqual(139);
  io.resize(160, 44); renderer.tick();
  expect(renderer.frameText()).toContain("─ files ─");
  await quit(io, renderer, app, cwd);
}, 20_000);

// ---------- the smoke module ----------

test("sextantSmoke(): the CLI smoke passes in-process (two approval cards, both tool rows, every panel, terminal restored)", async () => {
  const r = await sextantSmoke();
  expect(r.reasons).toEqual([]);
  expect(r.ok).toBe(true);
  expect(r.frame).toContain("Smoke OK");
  expect(r.cardFrame).toMatch(/needs your permission\s+edit\b/);
}, 30_000);

// ---------- re-verify pass: #43 HIGH — a modified wheel over the suggestion row ----------

test("`/ex` + shift+wheel over the `/exit` suggestion row scrolls instead of clicking: the session stays open and the prompt keeps its text; a plain click on that row still runs /exit", async () => {
  const { cwd, io, renderer } = surface();
  const app = runTui({ renderer, stream: mockStream({ turns: [textTurn("never")] }), cwd, yolo: true, exitOnClose: false, model: "scripted" });
  await until(renderer, (f) => f.includes("/help lists commands"));
  io.feed("/ex"); renderer.tick();
  const rowOf = (): { x: number; y: number } => {
    const lines = renderer.frameText().split("\n");
    const y = lines.findLastIndex((l) => l.includes("/exit"));
    return { x: lines[y]!.indexOf("/exit"), y };
  };
  let at = rowOf();
  expect(at.y).toBeGreaterThan(0);                                              // the suggestion box lists /exit
  io.feed(`\x1b[<68;${at.x + 1};${at.y + 1}M`); renderer.flushInput(); renderer.tick(); // shift + wheel-up over the row
  io.feed(`\x1b[<69;${at.x + 1};${at.y + 1}M`); renderer.flushInput(); renderer.tick(); // shift + wheel-down
  io.feed(`\x1b[<80;${at.x + 1};${at.y + 1}M`); renderer.flushInput(); renderer.tick(); // ctrl + wheel-up
  await new Promise((r) => setTimeout(r, 60));
  expect(renderer.active).toBe(true);                                           // still running (mutation: the wheel clicked the row → /exit quit)
  expect(renderer.state.input.text).toBe("/ex");
  expect(renderer.state.messages.some((m) => m.kind === "user")).toBe(false);   // nothing was submitted
  at = rowOf();
  io.feed(`\x1b[<0;${at.x + 1};${at.y + 1}M`); renderer.flushInput();           // press: the chat drag-select gesture holds it…
  io.feed(`\x1b[<0;${at.x + 1};${at.y + 1}m`); renderer.flushInput();           // …release: the click runs the row (a real click is always press+release)
  await deadline(app, 8000, "runTui after clicking /exit");
  expect(renderer.active).toBe(false);
  for (const seq of LEAVE) expect(io.output().slice(-400)).toContain(seq);
  rmSync(cwd, { recursive: true, force: true });
}, 20_000);

// ---------- re-verify pass: #44 MED-1 — ungated edits get an edit-only diff, never cumulative HEAD numbers ----------

const haveGit = spawnSync("git", ["--version"], { encoding: "utf8", windowsHide: true }).status === 0;
const git = (cwd: string, ...args: string[]): void => {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true, timeout: 20_000 });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
};
/** a repo with notes.txt COMMITTED as `committed`, then dirtied on disk by appending `dirty` (uncommitted) */
function dirtyRepo(committed: string, dirty: string): { cwd: string; target: string; content: string } {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-sextant-git-"));
  git(cwd, "init", "-q"); git(cwd, "config", "user.email", "t@example.com"); git(cwd, "config", "user.name", "t"); git(cwd, "config", "core.autocrlf", "false");
  const target = join(cwd, "notes.txt");
  writeFileSync(target, committed);
  git(cwd, "add", "-A"); git(cwd, "commit", "-q", "-m", "init");
  appendFileSync(target, dirty);
  return { cwd, target, content: readFileSync(target, "utf8") };
}
const editOf = (target: string, content: string, line: number, newLines: string[]) =>
  ({ path: target, edits: [{ tag: fileTag(content), anchorLine: line, anchorHash: lineHash(content.split("\n")[line - 1]!), newLines }] });
const changes = (r: SextantRenderer) => r.state.code.diff!.hunks.flatMap((h) => h.rows).filter((x) => x.op !== " ").map((x) => [x.op, x.text]);

test.if(haveGit)("yolo edit of ONE committed line in a file dirtied by 5 uncommitted lines: the row stays `+1 −1`, the diff view holds exactly that hunk and the title reads `+1 −1` with no `vs HEAD` (the base is rebuilt from the hashline ops — git itself would say +6 −1)", async () => {
  const { cwd, target, content } = dirtyRepo("keep-1\nold-line\nkeep-2\n", "extra-1\nextra-2\nextra-3\nextra-4\nextra-5\n");
  const io = new MemoryIO(160, 44, { COLORTERM: "truecolor" });
  const renderer = new SextantRenderer({ io, cwd, pet: "rovecode" });
  const stream = mockStream({ turns: [toolTurn([{ id: "t1", tool: "edit", args: editOf(target, content, 2, ["new-line"]) }]), textTurn("edited.")] });
  const app = runTui({ renderer, stream, cwd, yolo: true, exitOnClose: false, model: "scripted" });
  io.feed("edit it\r");
  const done = await until(renderer, (f) => f.includes("edited.") && /─ diff ─+ notes\.txt\s+\+1 −1/.test(f));
  expect(done).toMatch(/~ edit\s+notes\.txt\s+\+1 −1/);                        // the row (mutation: HEAD base overwrites → +6 −1)
  expect(done).toMatch(/─ diff ─+ notes\.txt\s+\+1 −1 ╮/);                     // the title: the ONE edit, nothing flagged after the counts
  expect(done).not.toContain("vs HEAD");
  expect(readFileSync(target, "utf8")).toBe("keep-1\nnew-line\nkeep-2\nextra-1\nextra-2\nextra-3\nextra-4\nextra-5\n");
  const d = renderer.state.code.diff!;
  expect(d).toMatchObject({ file: "notes.txt", add: 1, del: 1 });
  expect(d.base).toBeUndefined();
  expect(d.hunks).toHaveLength(1);
  expect(changes(renderer)).toEqual([["-", "old-line"], ["+", "new-line"]]);  // exactly the landed change, none of the dirty lines
  expect(renderer.state.messages.find((m) => m.kind === "tool")).toMatchObject({ verb: "edit", ok: true, add: 1, del: 1 } satisfies Partial<ToolRow>);
  await quit(io, renderer, app, cwd);
}, 30_000);

test.if(haveGit)("yolo edit of a line that is itself uncommitted (no line in HEAD or on disk carries its hash): the row keeps the reducer's `+1 −1` while the view falls back to HEAD vs disk, flagged `vs HEAD`", async () => {
  const { cwd, target, content } = dirtyRepo("keep-1\nkeep-2\n", "extra-1\nextra-2\n");
  const io = new MemoryIO(160, 44, { COLORTERM: "truecolor" });
  const renderer = new SextantRenderer({ io, cwd, pet: "rovecode" });
  const stream = mockStream({ turns: [toolTurn([{ id: "t1", tool: "edit", args: editOf(target, content, 3, ["changed"]) }]), textTurn("edited.")] });
  const app = runTui({ renderer, stream, cwd, yolo: true, exitOnClose: false, model: "scripted" });
  io.feed("edit it\r");
  const done = await until(renderer, (f) => f.includes("edited.") && renderer.state.code.diff?.base === "head");
  expect(renderer.state.code.diff).toMatchObject({ file: "notes.txt", add: 2, del: 0, base: "head" }); // HEAD → disk: two new lines
  expect(done).toMatch(/─ diff ─+ notes\.txt\s+\+2\s+vs HEAD ╮/);              // the view says what it compares
  expect(done).toMatch(/~ edit\s+notes\.txt\s+\+1 −1/);                        // the row keeps its args-derived counts (mutation: overwritten → +2)
  expect(renderer.state.messages.find((m) => m.kind === "tool")).toMatchObject({ add: 1, del: 1 } satisfies Partial<ToolRow>);
  await quit(io, renderer, app, cwd);
}, 30_000);

test.if(haveGit)("gated edit in a dirty repo: the pre-approval snapshot beats HEAD as the base — allow → the row and the view show the ONE landed change, not the file's whole uncommitted delta", async () => {
  const { cwd, target, content } = dirtyRepo("keep-1\nold-line\nkeep-2\n", "extra-1\nextra-2\nextra-3\n");
  const io = new MemoryIO(160, 44, { COLORTERM: "truecolor" });
  const renderer = new SextantRenderer({ io, cwd, pet: "rovecode" });
  const stream = mockStream({ turns: [toolTurn([{ id: "t1", tool: "edit", args: editOf(target, content, 2, ["new-line"]) }]), textTurn("applied.")] });
  const app = runTui({ renderer, stream, cwd, yolo: false, exitOnClose: false, model: "scripted" });
  io.feed("edit it\r");
  await until(renderer, (f) => f.includes("needs your permission"));
  io.feed("\r");                                                                 // allow once
  const done = await until(renderer, (f) => f.includes("applied.") && /─ diff ─+ notes\.txt\s+\+1 −1 ╮/.test(f));
  expect(done).toMatch(/~ edit\s+notes\.txt\s+\+1 −1/);
  expect(done).not.toContain("vs HEAD");
  expect(changes(renderer)).toEqual([["-", "old-line"], ["+", "new-line"]]);  // (mutation: HEAD preferred over the snapshot → +4 −1 with the extras)
  await quit(io, renderer, app, cwd);
}, 30_000);

test("the write tool's approval leaves the file absent until allowed (mirror of tui-app's gated write)", async () => {
  const { cwd, io, renderer } = surface();
  const probe = join(cwd, "fresh.txt");
  const stream = mockStream({ turns: [toolTurn([{ id: "t1", tool: "write", args: { path: probe, content: "alpha\nbeta\n" } }]), textTurn("created.")] });
  const app = runTui({ renderer, stream, cwd, yolo: false, exitOnClose: false, model: "scripted" });
  io.feed("make it\r");
  const card = await until(renderer, (f) => /needs your permission\s+write\b/.test(f));
  expect(existsSync(probe)).toBe(false);
  expect(card).toContain("+ alpha");                              // the pre-approval preview fills the diff view (all adds)
  expect(renderer.state.code.diff).toMatchObject({ file: "fresh.txt", add: 2, del: 0 });
  io.feed("\r");
  const done = await until(renderer, (f) => f.includes("created.") && /\+ write\s+fresh\.txt/.test(f));
  expect(done).toMatch(/\+ write\s+fresh\.txt/);                  // the tool row appears once the approved call executes
  expect(readFileSync(probe, "utf8")).toBe("alpha\nbeta\n");
  await quit(io, renderer, app, cwd);
}, 20_000);
