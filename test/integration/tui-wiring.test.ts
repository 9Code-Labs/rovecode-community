/** Wiring pass e2e through the real headless TUI (runTui → agentLoop → Renderer → pi-tui → xterm
 *  emulator), or a FakeRenderer (tui-session-nav idiom) where the seam itself is the assertion:
 *  - port #32: /todos empty → hint; after a scripted todo_write → checkbox rows + the status-bar
 *    label (the StatusInfo key is OMITTED while the list is empty); a corrupt file warns
 *  - port #26: /tasks list · cancel <id> · cancel all against scripted `task start`s; ONE settlement
 *    note per task; the completion steer reaches the NEXT model turn through rt.steering; quitting
 *    cancels live tasks (close → cancelAll)
 *  - port #30 critic: custom-command args reach the model RAW (whitespace runs, pasted newlines);
 *    /quit is reserved against a custom-command collision
 *  - port #27 critic: a failing rung probe rejects runTui (exitOnClose:false) with SandboxConfigError,
 *    reaps MCP children (LOW-3), AND a keystroke sent right after runTui() is still handled — the
 *    no-await-before-the-handlers invariant */

import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { VirtualTerminal } from "../../vendor/pi-tui/test/virtual-terminal.ts";
import { PiTuiRenderer } from "../../src/tui/pi-renderer.ts";
import { runTui } from "../../src/tui/app.ts";
import { partsText } from "../../src/core/loop.ts";
import { mockStream, textTurn, toolTurn } from "../../src/providers/stream.ts";
import { resetExecutor, type SpawnRunner } from "../../src/core/executor.ts";
import { SandboxConfigError } from "../../src/core/sandbox-config.ts";
import { McpManager } from "../../src/mcp/client.ts";
import { trustProjectFiles, writeTrustedMcpJson } from "../helpers/mcp-trust.ts";
import type { AssistantTurn, Message, ModelRef, StreamEvent, StreamFn, StreamOptions } from "../../src/core/types.ts";
import type { ApprovalAnswer, AssistantView, Renderer, RendererHooks, StatusInfo } from "../../src/tui/renderer.ts";

afterEach(() => resetExecutor()); // the executor seam is module-global — never leak a poisoned rung desire

// ---------- helpers ----------

async function until(term: VirtualTerminal, pred: (screen: string) => boolean, ms = 8000): Promise<string> {
  const deadline = Date.now() + ms;
  let text = "";
  while (Date.now() < deadline) {
    text = (await term.flushAndGetViewport()).join("\n");
    if (pred(text)) return text;
    await new Promise((r) => setTimeout(r, 25));
  }
  return text;
}

/** Bounded poll: a never-true predicate FAILS here instead of hanging bun (house hazard). */
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
const userTexts = (messages: Message[]): string[] => messages.filter((m) => m.role === "user").map((m) => partsText(m.parts));

/** Parks until the run's OWN signal aborts, then yields an aborted turn (tasks-wiring idiom). */
async function parkUntilAbort(opts: StreamOptions | undefined): Promise<StreamEvent> {
  const sig = opts?.signal;
  if (!sig?.aborted) await new Promise<void>((r) => sig?.addEventListener("abort", () => r(), { once: true }));
  return turn({ parts: [], stopReason: "aborted", usage: { input: 0, output: 0 } });
}

/** Minimal Renderer over the seam (tui-session-nav idiom): records notes, user echoes, statuses. */
class FakeRenderer implements Renderer {
  hooks!: RendererHooks;
  notes: { text: string; tone: string }[] = [];
  users: string[] = [];
  statuses: StatusInfo[] = [];
  start(h: RendererHooks): void { this.hooks = h; }
  stop(): void {}
  setCommands(): void {}
  addUser(text: string): void { this.users.push(text); }
  addSystemNote(text: string, tone: "info" | "warn" | "error" = "info"): void { this.notes.push({ text, tone }); }
  beginAssistant(): AssistantView { return { append() {}, done() {} }; }
  toolStart(): void {}
  toolUpdate(): void {}
  toolEnd(): void {}
  async askApproval(): Promise<ApprovalAnswer> { return "once"; }
  async askQuestion(): Promise<null> { return null; }
  async pickOne(): Promise<string | null> { return null; }
  clearTranscript(): void { this.users = []; }
  prefillEditor(): void {}
  setBusy(): void {}
  setStatus(info: StatusInfo): void { this.statuses.push(info); }
  warns(): string[] { return this.notes.filter((n) => n.tone === "warn").map((n) => n.text); }
}

/** Hermetic user scope for the custom-command tests: the host's ~/.rovecode/commands must not leak in. */
function scopedHome(): { home: string; restore: () => void } {
  const home = mkdtempSync(join(tmpdir(), "rovecode-tuiwire-home-"));
  const saved = process.env.ROVECODE_HOME;
  process.env.ROVECODE_HOME = home;
  return { home, restore: () => { if (saved === undefined) delete process.env.ROVECODE_HOME; else process.env.ROVECODE_HOME = saved; rmSync(home, { recursive: true, force: true }); } };
}

const TODOS = [
  { id: "t1", content: "write tests", status: "completed" },
  { id: "t2", content: "implement tool", status: "in_progress", priority: "high" },
  { id: "t3", content: "update notes", status: "pending" },
];

// ---------- port #32: /todos + status-bar label ----------

test("/todos: empty → hint; after a scripted todo_write the checkbox rows render and the status bar shows `todos 1/3`; a corrupt todos.json warns and the TUI stays alive", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-tuiwire-"));
  const sid = randomUUID();
  const term = new VirtualTerminal(80, 24);
  const renderer = new PiTuiRenderer({ terminal: term, cwd });
  const stream = mockStream({ turns: [toolTurn([{ id: "w1", tool: "todo_write", args: { todos: TODOS } }]), textTurn("planned.")] });
  const app = runTui({ renderer, stream, cwd, sessionId: sid, yolo: true, exitOnClose: false, model: "scripted" });
  term.sendInput("/todos"); term.sendInput("\r");
  const empty = await until(term, (s) => s.includes("no todos"));
  expect(empty).toContain("(no todos — the agent maintains the list with todo_write)");
  expect(empty).not.toContain("todos 0/");                    // no label while the list is empty

  term.sendInput("make a plan"); term.sendInput("\r");
  const planned = await until(term, (s) => s.includes("planned.") && !s.includes("thinking"));
  expect(planned).toContain("todos 1/3");                     // status bar refreshed after the successful todo_write (mutation: drop the label → fails)
  term.sendInput("/todos"); term.sendInput("\r");
  const listed = await until(term, (s) => s.includes("[ ] t3: update notes")); // the tool card clips before t3; only /todos shows the full row
  expect(listed).toContain("todos: 3 total · 1 completed · 1 in progress · 1 pending");
  expect(listed).toContain("[x] t1: write tests");
  expect(listed).toContain("[>] t2: implement tool (high)");

  writeFileSync(join(cwd, ".rovecode", "sessions", sid, "todos.json"), "{not json");
  term.sendInput("/todos"); term.sendInput("\r");
  const corrupt = await until(term, (s) => s.includes("not valid JSON"));
  expect(corrupt).toContain("todos.json is not valid JSON");   // warning above…
  expect(corrupt).toContain("(no todos");                      // …the (empty) list
  term.sendInput("\x03");
  await app;
  rmSync(cwd, { recursive: true, force: true });
}, 20_000);

test("status seam: the `todos` key is OMITTED while the list is empty and reads `todos 1/3` once the run that wrote it settles — pushStatus at turn_start and in the run's finally recompute todoLabel, no per-tool bookkeeping (FakeRenderer pin)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-tuiwire-"));
  const fake = new FakeRenderer();
  const stream = mockStream({ turns: [toolTurn([{ id: "w1", tool: "todo_write", args: { todos: TODOS } }]), textTurn("planned.")] });
  const app = runTui({ renderer: fake, stream, cwd, yolo: true, exitOnClose: false, model: "scripted" });
  expect(fake.statuses.length).toBeGreaterThan(0);            // boot pushStatus (synchronous)
  expect(fake.statuses.every((s) => !("todos" in s))).toBe(true);
  fake.hooks.onSubmit("make a plan");
  await waitFor(() => fake.statuses.at(-1)?.todos === "todos 1/3", 8000, "todos label once the writing run settled");
  fake.hooks.onExit();
  await app;
  rmSync(cwd, { recursive: true, force: true });
}, 20_000);

// ---------- port #26: /tasks + settlement notes + steering ----------

/** Prompt-keyed script over ONE TUI session (every run appends to the same store, so the script keys
 *  on the LATEST real prompt — steers start with "task t…" — and counts only the tool messages after
 *  it): "PARENT <label>" starts a child task, then finishes; "CHILD ping" answers PONG; "CHILD …"
 *  otherwise parks until its run signal aborts; anything else echoes the steer it received. */
function taskStream(childSignals: Map<string, AbortSignal>): StreamFn {
  return async function* (_m: ModelRef, messages: Message[], opts?: StreamOptions): AsyncGenerator<StreamEvent> {
    const users = userTexts(messages);
    const prompt = [...users].reverse().find((u) => !u.startsWith("task t")) ?? "";
    const at = messages.findLastIndex((m) => m.role === "user" && partsText(m.parts) === prompt);
    const tools = messages.slice(at + 1).filter((m) => m.role === "tool").length;
    if (prompt.startsWith("PARENT")) {
      const label = prompt.split(" ")[1] ?? "x";
      if (tools === 0) { yield turn(toolTurn([{ id: `${label}-s`, tool: "task", args: { action: "start", goal: `CHILD ${label}`, label } }])); return; }
      yield turn(textTurn(`${prompt} done`)); return;
    }
    if (prompt === "CHILD ping") { yield turn(textTurn("PONG")); return; }
    if (prompt.startsWith("CHILD")) { childSignals.set(prompt, opts!.signal!); yield await parkUntilAbort(opts); return; }
    yield turn(textTurn(`MODEL-SAW ${users.find((u) => u.includes("task t1")) ?? "nothing"}`));
  };
}

test("/tasks: empty list, a scripted task runs to done with ONE settlement note, list rows, cancel on done/unknown/nothing, usage; the completion steer reaches the NEXT model turn (rt.steering)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-tuiwire-"));
  const term = new VirtualTerminal(80, 24);
  const renderer = new PiTuiRenderer({ terminal: term, cwd });
  const app = runTui({ renderer, stream: taskStream(new Map()), cwd, yolo: true, exitOnClose: false, model: "scripted" });
  term.sendInput("/tasks"); term.sendInput("\r");
  await until(term, (s) => s.includes("(no background tasks)"));

  term.sendInput("PARENT ping"); term.sendInput("\r");
  const done = await until(term, (s) => s.includes("task t1 (ping) finished: PONG"));   // subscription note (mutation: drop rt.tasks.subscribe → never)
  expect(done).toContain("PARENT ping done");
  expect(done.split("task t1 (ping) finished").length).toBe(2);                        // exactly one settlement note
  term.sendInput("/tasks"); term.sendInput("\r");
  const list = await until(term, (s) => /t1\s+done/.test(s));
  expect(list).toMatch(/t1\s+done\s+\d+s\s+ping — PONG/);                              // formatTaskList row (mutation: drop the /tasks case → "unknown command")
  term.sendInput("/tasks cancel t1"); term.sendInput("\r");
  await until(term, (s) => s.includes("task t1 already done"));
  term.sendInput("/tasks cancel t9"); term.sendInput("\r");
  await until(term, (s) => s.includes("unknown task 't9' — list with /tasks"));
  term.sendInput("/tasks cancel all"); term.sendInput("\r");
  await until(term, (s) => s.includes("no queued or running tasks to cancel"));
  term.sendInput("/tasks bogus"); term.sendInput("\r");
  await until(term, (s) => s.includes("usage: /tasks [cancel <id>|cancel all]"));

  // the completion note also waits in rt.steering: the next run drains it BEFORE its model turn
  term.sendInput("after"); term.sendInput("\r");
  const steered = await until(term, (s) => s.includes("MODEL-SAW"));
  expect(steered).toContain("↪ steering applied");
  expect(steered).toContain("MODEL-SAW task t1 (ping) finished: PONG");                // mutation: a fresh SteeringQueue instead of rt.steering → "MODEL-SAW nothing"
  term.sendInput("\x03");
  await app;
  rmSync(cwd, { recursive: true, force: true });
}, 30_000);

test("/tasks cancel <id> on a RUNNING task: acknowledges, aborts the child's run, ONE 'cancelled' note; quitting the TUI cancels the remaining live task (close → cancelAll)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-tuiwire-"));
  const term = new VirtualTerminal(80, 24);
  const renderer = new PiTuiRenderer({ terminal: term, cwd });
  const childSignals = new Map<string, AbortSignal>();
  const app = runTui({ renderer, stream: taskStream(childSignals), cwd, yolo: true, exitOnClose: false, model: "scripted" });
  term.sendInput("PARENT one"); term.sendInput("\r");
  await until(term, (s) => s.includes("PARENT one done"));
  await waitFor(() => childSignals.has("CHILD one"), 8000, "child one parked in its provider turn");
  term.sendInput("/tasks"); term.sendInput("\r");
  const running = await until(term, (s) => /t1\s+running/.test(s));
  expect(running).toMatch(/t1\s+running\s+\d+s\s+one/);

  term.sendInput("/tasks cancel t1"); term.sendInput("\r");
  const cancelled = await until(term, (s) => s.includes("task t1 (one) cancelled"));
  expect(cancelled).toContain("cancelling task t1 (one)");                              // the request…
  expect(cancelled.split("task t1 (one) cancelled").length).toBe(2);                  // …then exactly ONE settlement note
  expect(childSignals.get("CHILD one")!.aborted).toBe(true);                            // the child's run really aborted

  term.sendInput("PARENT two"); term.sendInput("\r");
  await until(term, (s) => s.includes("PARENT two done"));
  await waitFor(() => childSignals.has("CHILD two"), 8000, "child two parked");
  expect(childSignals.get("CHILD two")!.aborted).toBe(false);                           // a normal run end leaves it running
  term.sendInput("\x03");                                                                // quit
  await app;
  await waitFor(() => childSignals.get("CHILD two")!.aborted, 4000, "close() cancelled the live task"); // mutation: drop rt.tasks.cancelAll() in close → stays parked
  rmSync(cwd, { recursive: true, force: true });
}, 30_000);

// ---------- port #30 critic: raw $ARGUMENTS, /quit reserved ----------

test("custom command args reach the model RAW (MED-2): whitespace runs, a tab and a newline survive $ARGUMENTS; built-ins still get the collapsed arg", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-tuiwire-"));
  const { restore } = scopedHome();
  mkdirSync(join(cwd, ".rovecode", "commands"), { recursive: true });
  writeFileSync(join(cwd, ".rovecode", "commands", "hello.md"), "Say hi to $ARGUMENTS\n", "utf8");
  const seen: string[] = [];
  const stream: StreamFn = async function* (_m: ModelRef, messages: Message[]): AsyncGenerator<StreamEvent> {
    seen.push(userTexts(messages).at(-1) ?? "");
    yield turn(textTurn("ok"));
  };
  const fake = new FakeRenderer();
  try {
    const app = runTui({ renderer: fake, stream, cwd, yolo: true, exitOnClose: false, model: "scripted" });
    fake.hooks.onSubmit("/hello a   b\nc\td");
    await waitFor(() => seen.length === 1, 8000, "model turn");
    expect(seen[0]).toBe("Say hi to a   b\nc\td");           // mutation: pass the collapsed `arg` → "Say hi to a b c d"
    expect(fake.users).toEqual(["Say hi to a   b\nc\td"]);   // the echoed user turn is the rendered prompt
    fake.hooks.onSubmit("/model   spaced   id");             // a built-in keeps the collapsed arg
    expect(fake.notes.at(-1)?.text).toBe("model → spaced id");
    fake.hooks.onExit();
    await app;
  } finally {
    restore();
    rmSync(cwd, { recursive: true, force: true });
  }
}, 20_000);

test("custom command args via the real editor: a bracketed paste with a newline reaches the model verbatim through onSubmit → handleSlash", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-tuiwire-"));
  const { restore } = scopedHome();
  mkdirSync(join(cwd, ".rovecode", "commands"), { recursive: true });
  writeFileSync(join(cwd, ".rovecode", "commands", "hello.md"), "Say hi to $ARGUMENTS\n", "utf8");
  const term = new VirtualTerminal(80, 24);
  const renderer = new PiTuiRenderer({ terminal: term, cwd });
  const seen: string[] = [];
  const stream: StreamFn = async function* (_m: ModelRef, messages: Message[]): AsyncGenerator<StreamEvent> {
    seen.push(userTexts(messages).at(-1) ?? "");
    yield turn(textTurn("pasted-answer"));
  };
  try {
    const app = runTui({ renderer, stream, cwd, yolo: true, exitOnClose: false, model: "scripted" });
    await until(term, (s) => s.includes("rovecode"));
    term.sendInput("/hello ");
    await until(term, (s) => !s.includes("Say hi to"));                       // the space closed the command palette
    term.sendInput("\x1b[200~x  y\nz\x1b[201~");                                // bracketed paste: two spaces + a newline
    term.sendInput("\r");
    await until(term, (s) => s.includes("pasted-answer"));
    expect(seen).toEqual(["Say hi to x  y\nz"]);
    term.sendInput("\x03");
    await app;
  } finally {
    restore();
    rmSync(cwd, { recursive: true, force: true });
  }
}, 20_000);

test("LOW-1: a custom quit.md loses to the /quit alias — boot warning names it and /quit still exits (never submits a turn)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-tuiwire-"));
  const { restore } = scopedHome();
  mkdirSync(join(cwd, ".rovecode", "commands"), { recursive: true });
  writeFileSync(join(cwd, ".rovecode", "commands", "quit.md"), "bye from the impostor\n", "utf8");
  const fake = new FakeRenderer();
  try {
    const app = runTui({ renderer: fake, stream: mockStream({ turns: [textTurn("x")] }), cwd, yolo: true, exitOnClose: false, model: "scripted" });
    expect(fake.warns()).toContain(`/quit is a built-in command — built-in kept (${join(cwd, ".rovecode", "commands", "quit.md")})`); // mutation: "quit" not reserved → no warning
    fake.hooks.onSubmit("/quit");
    await deadline(app, 4000, "runTui after /quit");         // close() ran (an impostor dispatch would leave the app open)
    expect(fake.users).toEqual([]);                          // nothing was submitted as a user turn
  } finally {
    restore();
    rmSync(cwd, { recursive: true, force: true });
  }
}, 20_000);

// ---------- port #27 critic MED-1 / LOW-3: probe failure through the TUI ----------

test("wsl rung + failing fake probe: runTui({exitOnClose:false}) rejects with SandboxConfigError, reaps MCP children, and a keystroke sent RIGHT AFTER runTui() is still handled (no await before the handlers)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-tuiwire-"));
  mkdirSync(join(cwd, ".rovecode"), { recursive: true });
  writeFileSync(join(cwd, ".rovecode", "sandbox.json"), JSON.stringify({ rung: "wsl" }));
  const { restore: restoreHome } = scopedHome(); // the project .mcp.json spawns only once trusted (mcp/trust.ts) — approve it in the scoped home
  writeTrustedMcpJson(cwd, { toy: { command: "rovecode-not-a-real-binary-tui" } });
  trustProjectFiles(cwd); // the sandbox.json too: untrusted, it would be ignored and the wsl probe never asked
  const savedSandbox = process.env.ROVECODE_SANDBOX;
  delete process.env.ROVECODE_SANDBOX;                          // a host ROVECODE_SANDBOX would override the file under test
  const closed: McpManager[] = [];
  const origClose = McpManager.prototype.close;
  McpManager.prototype.close = async function (this: McpManager) { closed.push(this); return origClose.call(this); };
  const calls: string[][] = [];
  const runner: SpawnRunner = (argv) => { calls.push([...argv]); return Promise.resolve({ code: 1, stdout: "", stderr: "no wsl here" }); };
  const fake = new FakeRenderer();
  try {
    const app = runTui({ renderer: fake, stream: mockStream({ turns: [textTurn("x")] }), cwd, yolo: true, exitOnClose: false, model: "m1", spawnRunner: runner, platform: "win32" });
    fake.hooks.onSubmit("/status");                          // synchronously after runTui(): the handlers must already be wired
    await expect(deadline(app, 8000, "runTui with a failing probe")).rejects.toBeInstanceOf(SandboxConfigError);
    const status = fake.notes.find((n) => n.text.includes("sandbox:"))?.text ?? "";
    expect(status).toContain("model=m1");                    // the keystroke landed (mutation: an early await above renderer.start → lost)
    expect(status).toContain("sandbox: wsl (.rovecode/sandbox.json)");
    expect(calls).toEqual([["wsl.exe", "--exec", "bash", "-c", "true"]]); // the probe went through the injected runner (mutation: spawnRunner not threaded → a REAL wsl.exe probe, calls [])
    expect(closed).toHaveLength(1);                          // LOW-3: MCP children reaped before the rejection (mutation: drop rt.mcp?.close() → 0)
  } finally {
    McpManager.prototype.close = origClose;
    restoreHome();
    if (savedSandbox !== undefined) process.env.ROVECODE_SANDBOX = savedSandbox;
    rmSync(cwd, { recursive: true, force: true });
  }
}, 20_000);

// ---------- TuiAppOptions.permission: an in-process caller can ASK for ask-mode ----------

/** The asymmetry nobody will remember in three months: `yolo: false` is "no flag" and lets a user settings
 *  file that says "auto" win, while `permission: "ask"` is the flag rung and beats that file AND the env var.
 *  The env var keeps working for people who use it — this adds a way in, it does not replace one. */
test("permission option: 'ask' beats a user settings file saying auto and beats ROVECODE_PERMISSION; passing nothing still lets the env, then the file, win", async () => {
  const { home, restore } = scopedHome();
  writeFileSync(join(home, "settings.json"), JSON.stringify({ permission: "auto" }));
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-tuiwire-"));
  const savedEnv = { P: process.env.ROVECODE_PERMISSION, Y: process.env.ROVECODE_YOLO, A: process.env.ROVECODE_ACCEPT_EDITS };
  delete process.env.ROVECODE_PERMISSION; delete process.env.ROVECODE_YOLO; delete process.env.ROVECODE_ACCEPT_EDITS;
  /** boot one TUI, read the level the first status carried, quit */
  const startLevelOf = async (opts: { permission?: "ask" | "accept-edits" | "auto"; yolo?: boolean }): Promise<string> => {
    const fake = new FakeRenderer();
    const app = runTui({ renderer: fake, stream: mockStream({ turns: [textTurn("x")] }), cwd, ...opts, exitOnClose: false, model: "scripted" });
    await waitFor(() => fake.statuses.length > 0, 8000, "first status");
    const s = fake.statuses[0]!;
    fake.hooks.onExit();
    await app;
    return s.permission ?? (s.yolo ? "auto" : "ask");
  };
  try {
    expect(await startLevelOf({})).toBe("auto");                          // nothing said → the user file wins
    expect(await startLevelOf({ yolo: false })).toBe("auto");             // false is "no flag", NOT "ask" — the wart the option exists for
    expect(await startLevelOf({ permission: "ask" })).toBe("ask");        // mutation: drop opts.permission from flagLevel → "auto"
    process.env.ROVECODE_PERMISSION = "accept-edits";
    expect(await startLevelOf({})).toBe("accept-edits");                  // the env var still works and still beats the file
    expect(await startLevelOf({ permission: "ask" })).toBe("ask");        // and the option beats the env var, like a CLI flag does
  } finally {
    if (savedEnv.P === undefined) delete process.env.ROVECODE_PERMISSION; else process.env.ROVECODE_PERMISSION = savedEnv.P;
    if (savedEnv.Y === undefined) delete process.env.ROVECODE_YOLO; else process.env.ROVECODE_YOLO = savedEnv.Y;
    if (savedEnv.A === undefined) delete process.env.ROVECODE_ACCEPT_EDITS; else process.env.ROVECODE_ACCEPT_EDITS = savedEnv.A;
    restore();
    rmSync(cwd, { recursive: true, force: true });
  }
}, 30_000);
