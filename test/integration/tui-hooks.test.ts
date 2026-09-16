/** WIRING PASS 2b — port #29 hooks reach the interactive surfaces, port #25 LOW-4 replay marker.
 *  - TUI (runTui over a FakeRenderer, tui-wiring idiom): `hooks: rt.hooks` in the agentLoop deps means
 *    pre_tool deny (holds under yolo; the card carries the hook's reason; the tool never ran), the
 *    approval hook pre-answering a gated write without the overlay, post_tool annotating what the model
 *    sees, and on_event tapping every RunEvent incl. run_end. close() fires session_close ONCE — zero
 *    times before the quit, after the aborted run settled and its last tap landed — and the app
 *    promise resolves only after it. Hook load/runtime notes land as ONE warn note; a hooks-free
 *    runtime adds no line anywhere.
 *  - repl (`rovecode --plain --yolo` as a subprocess against a loopback provider, cli-wiring idiom): the
 *    same three, session_close on /exit, plus rt.steering threaded (a background task's completion
 *    note reaches the NEXT repl turn — with a fresh SteeringQueue it never did).
 *  - replay: a persisted compaction event (SessionStore.appendEvent, what loop.ts:176 writes) replays
 *    as the live note — same wording, same place — on boot --resume and on /resume; other persisted
 *    events and every event-free session replay exactly as before (pinned line by line).
 *  Every hooks file lives in a fresh temp cwd (Bun caches modules by path), talks back through a
 *  test-unique globalThis key, and ROVECODE_HOME points at an empty dir so the host's ~/.rovecode never leaks. */

import { test, expect, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { trustProjectFiles } from "../helpers/mcp-trust.ts";
import { randomUUID } from "node:crypto";
import { runTui } from "../../src/tui/app.ts";
import { SessionStore } from "../../src/core/session.ts";
import { compactionNote, replayMarkerLine, type EventEntry } from "../../src/tui/replay-marker.ts";
import { mockStream, textTurn, toolTurn } from "../../src/providers/stream.ts";
import { fileTag, lineHash } from "../../src/coding/hashline.ts";
import { resetExecutor, type SpawnRunner } from "../../src/core/executor.ts";
import { SandboxConfigError } from "../../src/core/sandbox-config.ts";
import type { Message, StreamEvent, StreamFn, StreamOptions } from "../../src/core/types.ts";
import type { ApprovalAnswer, AssistantView, Renderer, RendererHooks, StatusInfo } from "../../src/tui/renderer.ts";

afterEach(() => resetExecutor()); // the executor seam is module-global — the failing-probe test must not leak its rung desire

const ROOT = resolve(import.meta.dir, "..", "..");
const MAIN = join(ROOT, "src", "cli", "main.ts");
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Bounded poll — a never-true predicate FAILS here instead of hanging bun (house hazard). */
async function waitFor(cond: () => boolean, ms = 8000, what = "condition"): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error(`${what}: not true within ${ms}ms`);
    await sleep(10);
  }
}
function deadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const bomb = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error(`${what}: not settled within ${ms}ms`)), ms); });
  return Promise.race([p, bomb]).finally(() => clearTimeout(t));
}
/** Windows: a just-exited child can hold its cwd a beat longer — retry the cleanup. */
async function rmRetry(dir: string): Promise<void> {
  for (let i = 0; i < 20; i++) {
    try { rmSync(dir, { recursive: true, force: true }); return; } catch { await sleep(100); }
  }
}

/** Renderer over the seam that records EVERY transcript call in order — the assertions are about
 *  what lands and where (a marker between the turns it separated; not one stray line). */
class FakeRenderer implements Renderer {
  hooks!: RendererHooks;
  log: string[] = [];
  approvals: string[] = [];
  busy: boolean[] = [];
  start(h: RendererHooks): void { this.hooks = h; }
  stop(): void {}
  setCommands(): void {}
  addUser(text: string): void { this.log.push(`user: ${text}`); }
  addSystemNote(text: string, tone: "info" | "warn" | "error" = "info"): void { this.log.push(`note(${tone}): ${text}`); }
  beginAssistant(): AssistantView { let buf = ""; const log = this.log; return { append(d: string) { buf += d; }, done() { log.push(`assistant: ${buf}`); } }; }
  toolStart(callId: string, tool: string, args: string): void { this.log.push(`tool_start: ${callId} ${tool} ${args}`); }
  toolUpdate(): void {}
  toolEnd(callId: string, ok: boolean, out: string): void { this.log.push(`tool_end: ${callId} ${ok ? "ok" : "FAIL"} ${out}`); }
  async askApproval(tool: string): Promise<ApprovalAnswer> { this.approvals.push(tool); return "once"; }
  async askQuestion(): Promise<null> { return null; }
  async pickOne(): Promise<string | null> { return null; }
  clearTranscript(): void { this.log.push("clear"); }
  prefillEditor(): void {}
  setBusy(b: boolean): void { this.busy.push(b); }
  setStatus(_i: StatusInfo): void {}
  /** the transcript slice a replay produced: after the last `clear`, up to and including `last` */
  replayed(last: string): string[] { const from = this.log.lastIndexOf("clear") + 1; return this.log.slice(from, this.log.indexOf(last, from) + 1); }
}

let seq = 0;
interface Rig { cwd: string; log: string[]; restore: () => void }
/** fresh cwd + hermetic ROVECODE_HOME + a globalThis channel; `hooksSource(key)` = the project hooks file */
function rig(hooksSource?: (key: string) => string): Rig {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-tuihooks-"));
  const home = mkdtempSync(join(tmpdir(), "rovecode-tuihooks-home-"));
  const saved = { home: process.env.ROVECODE_HOME, noHooks: process.env.ROVECODE_NO_HOOKS, reflection: process.env.ROVECODE_REFLECTION };
  process.env.ROVECODE_HOME = home;
  delete process.env.ROVECODE_NO_HOOKS;
  delete process.env.ROVECODE_REFLECTION; // the built-in reflection set (port #28) must be attached for the chain test below
  const key = `__rovecodeTuiHooks_${process.pid}_${++seq}`;
  const log: string[] = [];
  (globalThis as Record<string, unknown>)[key] = log;
  if (hooksSource) { mkdirSync(join(cwd, ".rovecode"), { recursive: true }); writeFileSync(join(cwd, ".rovecode", "hooks.ts"), hooksSource(key)); trustProjectFiles(cwd, home); } // approved in the rig's home (core/trust.ts)
  return {
    cwd, log,
    restore: () => {
      if (saved.home === undefined) delete process.env.ROVECODE_HOME; else process.env.ROVECODE_HOME = saved.home;
      if (saved.noHooks !== undefined) process.env.ROVECODE_NO_HOOKS = saved.noHooks;
      if (saved.reflection !== undefined) process.env.ROVECODE_REFLECTION = saved.reflection;
      delete (globalThis as Record<string, unknown>)[key];
      rmSync(cwd, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true });
    },
  };
}
/** the TUI hooks file: deny writes, tap every event, session_close after `closeDelayMs` (0 = sync) */
const tuiHooks = (closeDelayMs: number) => (key: string) => `const log = globalThis[${JSON.stringify(key)}];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export default { version: 1, hooks: {
  session_open() { log.push("session_open"); },
  pre_tool(_ctx, call) { log.push("pre_tool:" + call.tool); if (call.tool === "write") return { deny: "no writes from this project" }; },
  on_event(_ctx, ev) { log.push("on_event:" + ev.type); },
  async session_close(ctx) { if (${closeDelayMs} > 0) await sleep(${closeDelayMs}); log.push("session_close:" + ctx.sessionId); },
} };
`;
const umsg = (text: string, parentId: string | null): Message => ({ id: randomUUID(), role: "user", parts: [{ kind: "text", text }], parentId, createdAt: Date.now() });
const amsg = (text: string, parentId: string | null): Message => ({ id: randomUUID(), role: "assistant", parts: [{ kind: "text", text }], parentId, createdAt: Date.now() });
const closesOf = (log: string[]) => log.filter((l) => l.startsWith("session_close:"));

// ---------- TUI: hooks in the run deps + session_close at quit ----------

test("TUI run (yolo): pre_tool deny — the write never ran and its card carries the hook's reason; on_event tapped every event incl. run_end; session_close 0× before the quit, exactly 1× after it, after the last tap, and the app resolves only then", async () => {
  const r = rig(tuiHooks(30)); // an ASYNC session_close: only an awaited hooks.close() lands it before the app resolves
  const probe = join(r.cwd, "denied.txt");
  const fake = new FakeRenderer();
  try {
    const stream = mockStream({ turns: [toolTurn([{ id: "t1", tool: "write", args: { path: probe, content: "never\n" } }]), textTurn("after deny")] });
    const app = runTui({ renderer: fake, stream, cwd: r.cwd, yolo: true, exitOnClose: false, model: "scripted" });
    fake.hooks.onSubmit("go");
    await waitFor(() => fake.log.includes("assistant: after deny") && fake.busy.at(-1) === false, 8000, "run end");
    expect(existsSync(probe)).toBe(false);                                                        // the hook's deny stopped the write under yolo (mutation: drop `hooks:` from the deps → written)
    expect(fake.log).toContain("tool_end: t1 FAIL permission_denied: no writes from this project"); // the live card shows the hook's reason
    expect(fake.log.some((l) => l.startsWith("tool_start: t1"))).toBe(false);                      // never dispatched
    expect(r.log[0]).toBe("session_open");
    expect(r.log).toContain("pre_tool:write");
    for (const t of ["run_start", "turn_start", "tool_call_failed", "turn_end", "run_end"]) expect(r.log).toContain(`on_event:${t}`);
    expect(r.log).not.toContain("on_event:tool_execution_start");
    expect(closesOf(r.log)).toEqual([]);                                                          // zero before the quit
    fake.hooks.onExit(); fake.hooks.onExit();                                                       // a second quit is a no-op
    await deadline(app, 6000, "runTui after quit");
    const closes = closesOf(r.log);
    expect(closes.length).toBe(1);                                                                 // exactly once (mutation: drop hooks.close() → 0; resolve before awaiting it → 0 at this point)
    expect(r.log.at(-1)).toBe(closes[0]);                                                          // … after every tap
    expect(r.log.indexOf(closes[0]!)).toBeGreaterThan(r.log.lastIndexOf("on_event:run_end"));
  } finally { r.restore(); }
}, 20_000);

test("TUI run (gated): the approval hook pre-answers the write — no overlay — and post_tool's annotation reaches the card AND the stored tool_result the model sees", async () => {
  const r = rig((key) => `const log = globalThis[${JSON.stringify(key)}];
export default { version: 1, hooks: {
  approval(_ctx, req) { log.push("approval:" + req.tool); return "allow"; },
  post_tool(_ctx, call, r) { log.push("post_tool:" + call.tool + ":" + r.ok); return { output: r.output + " [hook-annotated]" }; },
} };
`);
  const sid = "approved-sess";
  const probe = join(r.cwd, "approved.txt");
  const fake = new FakeRenderer();
  try {
    const stream = mockStream({ turns: [toolTurn([{ id: "t1", tool: "write", args: { path: probe, content: "yes\n" } }]), textTurn("written")] });
    const app = runTui({ renderer: fake, stream, cwd: r.cwd, sessionId: sid, yolo: false, exitOnClose: false, model: "scripted" });
    fake.hooks.onSubmit("write it");
    await waitFor(() => fake.log.includes("assistant: written") && fake.busy.at(-1) === false, 8000, "run end");
    expect(fake.approvals).toEqual([]);                                                            // the human was never asked (mutation: drop `hooks:` → the overlay opens, approvals ["write"])
    expect(readFileSync(probe, "utf8")).toBe("yes\n");                                             // … and the write ran on the hook's allow
    expect(r.log).toEqual(["approval:write", "post_tool:write:true"]);
    expect(fake.log.some((l) => l.startsWith("tool_end: t1 ok") && l.endsWith("[hook-annotated]"))).toBe(true);
    const toolMsg = new SessionStore(join(r.cwd, ".rovecode", "sessions"), sid).messages().find((m) => m.role === "tool")!;
    const part = toolMsg.parts[0]!;
    if (part.kind !== "tool_result") throw new Error("expected tool_result");
    expect(part.output.endsWith(" [hook-annotated]")).toBe(true);                                  // what the model sees next turn
    fake.hooks.onExit();
    await deadline(app, 6000, "runTui after quit");
  } finally { r.restore(); }
}, 20_000);

test("built-in reflection set (port #28) reaches a TUI run: a failed edit → ONE `reflection:` nudge rides rt.steering into the NEXT request as a user message (steer note rendered live)", async () => {
  const r = rig(); // no hooks file: the reflection set is attached by createRuntime itself
  const target = join(r.cwd, "notes.txt");
  const content = "keep-1\nold-line\nkeep-2\n";
  writeFileSync(target, content);
  const badEdit = { path: target, edits: [{ tag: fileTag(content), anchorLine: 2, anchorHash: lineHash("not-the-line"), newLines: ["new-line"] }] }; // wrong anchor hash → "Edit rejected"
  const requests: string[][] = []; // user texts per provider request
  const stream: StreamFn = async function* (_m, messages): AsyncGenerator<StreamEvent> {
    const users = messages.filter((m) => m.role === "user").map((m) => m.parts.map((p) => (p.kind === "text" ? p.text : "")).join(""));
    requests.push(users);
    if (requests.length === 1) { yield { type: "turn", turn: toolTurn([{ id: "e1", tool: "edit", args: badEdit }]) }; return; }
    yield { type: "turn", turn: textTurn(users.some((u) => u.startsWith("reflection: ")) ? "REFLECTED" : "NO-REFLECTION") };
  };
  const fake = new FakeRenderer();
  try {
    const app = runTui({ renderer: fake, stream, cwd: r.cwd, sessionId: "reflect-sess", yolo: true, exitOnClose: false, model: "scripted" });
    fake.hooks.onSubmit("fix the line");
    await waitFor(() => fake.busy.at(-1) === false && fake.log.some((l) => l.startsWith("assistant: ")), 8000, "run end");
    expect(fake.log.some((l) => l.startsWith("tool_end: e1 FAIL Edit rejected"))).toBe(true);   // the edit really failed
    expect(fake.log).toContain("note(info): ↪ steering applied");                                // the live steer note for the nudge
    expect(fake.log).toContain("assistant: REFLECTED");                                          // the model's next request carried it (mutation: drop `hooks:` → NO-REFLECTION)
    const nudge = requests[1]!.find((u) => u.startsWith("reflection: "));
    expect(nudge?.startsWith("reflection: the edit call failed — Edit rejected")).toBe(true);
    expect(requests[1]!.filter((u) => u.startsWith("reflection: ")).length).toBe(1);             // exactly one nudge
    expect(readFileSync(target, "utf8")).toBe(content);                                          // nothing applied
    fake.hooks.onExit();
    await deadline(app, 6000, "quit");
  } finally { r.restore(); }
}, 20_000);

test("quit mid-run: the run is aborted and settles FIRST (its aborted turn is tapped), then session_close fires once as the last word; the app promise resolves", async () => {
  const r = rig(tuiHooks(0)); // SYNC session_close: a close() that does not wait for the generator would log it before the turn_end tap
  const fake = new FakeRenderer();
  const parked: StreamFn = async function* (_m, _msgs, opts?: StreamOptions): AsyncGenerator<StreamEvent> {
    const sig = opts?.signal;
    if (!sig?.aborted) await new Promise<void>((res) => sig?.addEventListener("abort", () => res(), { once: true }));
    await sleep(20); // a slow abort path: the aborted turn lands well after a hasty session_close would have
    yield { type: "turn", turn: { parts: [], stopReason: "aborted", usage: { input: 0, output: 0 } } };
  };
  try {
    const app = runTui({ renderer: fake, stream: parked, cwd: r.cwd, yolo: true, exitOnClose: false, model: "scripted" });
    fake.hooks.onSubmit("park");
    await waitFor(() => r.log.includes("on_event:turn_start"), 8000, "run in flight");
    fake.hooks.onExit();
    await deadline(app, 6000, "runTui after mid-run quit");
    expect(r.log).toContain("on_event:turn_end");                    // the aborted turn was tapped before the close (mutation: don't await the generator's return() → absent here)
    const closes = closesOf(r.log);
    expect(closes.length).toBe(1);
    expect(r.log.at(-1)).toBe(closes[0]);
    expect(r.log).not.toContain("on_event:run_end");                 // return() ended the generator at the abort — no fake "run_end"
  } finally { r.restore(); }
}, 20_000);

test("startup error (exit-2 path): a failing rung probe rejects runTui with SandboxConfigError AND fires session_close exactly once — the runtime existed, so session_open had fired", async () => {
  const r = rig(tuiHooks(0));
  mkdirSync(join(r.cwd, ".rovecode"), { recursive: true });
  writeFileSync(join(r.cwd, ".rovecode", "sandbox.json"), JSON.stringify({ rung: "wsl" }));
  trustProjectFiles(r.cwd); // an untrusted sandbox.json is ignored (core/trust.ts) — this test is about a TRUSTED rung that cannot be provided
  const savedSandbox = process.env.ROVECODE_SANDBOX;
  delete process.env.ROVECODE_SANDBOX; // a host ROVECODE_SANDBOX would override the file under test
  const runner: SpawnRunner = () => Promise.resolve({ code: 1, stdout: "", stderr: "no wsl here" });
  const fake = new FakeRenderer();
  try {
    const app = runTui({ renderer: fake, stream: mockStream({ turns: [textTurn("x")] }), cwd: r.cwd, yolo: true, exitOnClose: false, model: "m1", spawnRunner: runner, platform: "win32" });
    await expect(deadline(app, 8000, "runTui with a failing probe")).rejects.toBeInstanceOf(SandboxConfigError);
    expect(r.log[0]).toBe("session_open");
    expect(closesOf(r.log).length).toBe(1);                          // mutation: drop hooks.close() on the exit-2 path → 0
    expect(r.log.at(-1)).toBe(closesOf(r.log)[0]);
  } finally {
    if (savedSandbox !== undefined) process.env.ROVECODE_SANDBOX = savedSandbox;
    r.restore();
  }
}, 20_000);

test("hook notes reach the transcript: a broken .rovecode/hooks.ts → ONE warn note naming the file; a hooks-free runtime adds no `hooks:` line before, during or after a run and the quit", async () => {
  const r = rig(() => "export default { version: 1, hooks: {\n"); // syntax error → loader warning, never a throw
  const fake = new FakeRenderer();
  try {
    const app = runTui({ renderer: fake, stream: mockStream({ turns: [textTurn("x")] }), cwd: r.cwd, yolo: true, exitOnClose: false, model: "scripted" });
    await waitFor(() => fake.log.some((l) => l.startsWith("note(warn): hooks: ")), 8000, "hooks warning note");
    const warns = fake.log.filter((l) => l.includes("hooks: "));
    expect(warns.length).toBe(1);                                                                  // mutation: drop rt.hooks.onWarning → never surfaces
    expect(warns[0]!.startsWith(`note(warn): hooks: ${join(r.cwd, ".rovecode", "hooks.ts")}: failed to load — `)).toBe(true);
    fake.hooks.onExit();
    await deadline(app, 6000, "runTui after quit");
  } finally { r.restore(); }
  const r2 = rig();
  const fake2 = new FakeRenderer();
  try {
    const app = runTui({ renderer: fake2, stream: mockStream({ turns: [textTurn("plain")] }), cwd: r2.cwd, yolo: true, exitOnClose: false, model: "scripted" });
    fake2.hooks.onSubmit("go");
    await waitFor(() => fake2.log.includes("assistant: plain") && fake2.busy.at(-1) === false, 8000, "run end");
    fake2.hooks.onExit();
    await deadline(app, 6000, "runTui after quit");
    expect(fake2.log.some((l) => l.includes("hooks:"))).toBe(false);
    expect(fake2.log.filter((l) => l.startsWith("user: "))).toEqual(["user: go"]);
  } finally { r2.restore(); }
}, 20_000);

// ---------- port #25 LOW-4: the persisted compaction marker in replay ----------

test("replay marker: a persisted compaction entry replays as the live note, between the turns it separated, on boot --resume and on /resume; a bare persisted event adds nothing", async () => {
  const r = rig();
  const root = join(r.cwd, ".rovecode", "sessions");
  const sid = "compacted-sess";
  const s = new SessionStore(root, sid);
  const u1 = umsg("first question", null); s.append(u1);
  const a1 = amsg("first answer", u1.id); s.append(a1);
  s.appendEvent({ type: "compaction", strategy: "keep-window", trigger: "speculative", tokensBefore: 1234, tokensAfter: 56 }); // exactly what loop.ts:176 persists
  s.appendEvent({ type: "turn_start", turn: 3 }); // the live TUI shows nothing for a bare event → replay shows nothing
  const u2 = umsg("second question", a1.id); s.append(u2);
  s.append(amsg("second answer", u2.id));
  const expected = [
    "user: first question", "assistant: first answer",
    "note(info): compacted (keep-window): 1234 → 56 tokens", // the marker (mutation: iterate messages() → absent; wording must equal the live note)
    "user: second question", "assistant: second answer",
  ];
  const fake = new FakeRenderer();
  try {
    const app = runTui({ renderer: fake, stream: mockStream({ turns: [textTurn("x")] }), cwd: r.cwd, sessionId: sid, yolo: true, exitOnClose: false, model: "scripted" });
    await waitFor(() => fake.log.includes("assistant: second answer"), 8000, "boot replay");
    expect(fake.replayed("assistant: second answer")).toEqual(expected);
    fake.hooks.onExit();
    await deadline(app, 6000, "quit");
  } finally { /* keep the cwd for the /resume half */ }
  const fake2 = new FakeRenderer();
  try {
    const app = runTui({ renderer: fake2, stream: mockStream({ turns: [textTurn("x")] }), cwd: r.cwd, yolo: true, exitOnClose: false, model: "scripted" });
    fake2.hooks.onSubmit("/resume compacted");
    await waitFor(() => fake2.log.includes("assistant: second answer"), 8000, "/resume replay");
    expect(fake2.replayed("assistant: second answer")).toEqual(expected);
    fake2.hooks.onExit();
    await deadline(app, 6000, "quit");
  } finally { r.restore(); }
}, 20_000);

test("replay of an event-free session is unchanged: user / assistant text / tool cards / system note, same order, not one extra line", async () => {
  const r = rig();
  const root = join(r.cwd, ".rovecode", "sessions");
  const s = new SessionStore(root, "plain-sess");
  const u1 = umsg("did tools", null); s.append(u1);
  const a1: Message = { id: randomUUID(), role: "assistant", parentId: u1.id, createdAt: Date.now(), parts: [{ kind: "text", text: "running" }, { kind: "tool_call", id: "c1", tool: "write", args: { path: "x" } }] };
  s.append(a1);
  const t1: Message = { id: randomUUID(), role: "tool", parentId: a1.id, createdAt: Date.now(), parts: [{ kind: "tool_result", callId: "c1", ok: true, output: "done output" }] };
  s.append(t1);
  const sys: Message = { id: randomUUID(), role: "system", parentId: t1.id, createdAt: Date.now(), parts: [{ kind: "text", text: "plain system note" }] };
  s.append(sys);
  s.append(amsg("finished", sys.id));
  const fake = new FakeRenderer();
  try {
    const app = runTui({ renderer: fake, stream: mockStream({ turns: [textTurn("x")] }), cwd: r.cwd, sessionId: "plain-sess", yolo: true, exitOnClose: false, model: "scripted" });
    await waitFor(() => fake.log.includes("assistant: finished"), 8000, "boot replay");
    expect(fake.replayed("assistant: finished")).toEqual([
      "user: did tools", "assistant: running", 'tool_start: c1 write {"path":"x"}', "tool_end: c1 ok done output",
      "note(info): plain system note", "assistant: finished",
    ]);
    fake.hooks.onExit();
    await deadline(app, 6000, "quit");
  } finally { r.restore(); }
}, 20_000);

test("compactionNote / replayMarkerLine: ONE wording for live and replay; null for any other persisted event and for a foreign entry without an event", () => {
  const ev = { type: "compaction", strategy: "head-summarize", trigger: "emergency", tokensBefore: 90000, tokensAfter: 4000 } as const;
  expect(compactionNote(ev)).toBe("compacted (head-summarize): 90000 → 4000 tokens");
  const entry = (event: unknown): EventEntry => ({ id: "e", kind: "event", parentId: null, createdAt: 0, event } as EventEntry);
  expect(replayMarkerLine(entry(ev))).toBe(compactionNote(ev));
  expect(replayMarkerLine(entry({ type: "compaction", strategy: "context-drop", tokensBefore: 10, tokensAfter: 5 }))).toBe("compacted (context-drop): 10 → 5 tokens"); // trigger-less shape
  expect(replayMarkerLine(entry({ type: "steer", text: "x" }))).toBeNull();
  expect(replayMarkerLine(entry({ type: "run_end", status: "done", summary: "s" }))).toBeNull();
  expect(replayMarkerLine(entry(undefined))).toBeNull();
});

// ---------- repl: `rovecode --plain --yolo` as a subprocess against a loopback provider ----------

/** hermetic child env (output-modes idiom): ROVECODE_* and *_API_KEY scrubbed, then this test's provider */
function hermeticEnv(home: string, extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^ROVECODE_/i.test(k) && !/_API_KEY$/i.test(k)) env[k] = v;
  return Object.assign(env, { ROVECODE_HOME: home, NO_COLOR: "1" }, extra);
}
/** long-lived CLI child with ONE stdout pump (never a raced read — tui-session-nav lesson) */
function spawnRepl(cwd: string, env: Record<string, string>) {
  const p = Bun.spawn([process.execPath, MAIN, "--plain", "--yolo"], { cwd, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const buf = { out: "" };
  const dec = new TextDecoder();
  const pump = (async () => { for await (const chunk of p.stdout) buf.out += dec.decode(chunk, { stream: true }); })().catch(() => {});
  const waitOut = async (pred: (out: string) => boolean, ms = 20_000): Promise<void> => {
    const until = Date.now() + ms;
    while (Date.now() < until && !pred(buf.out)) await sleep(50);
    if (!pred(buf.out)) throw new Error(`repl output did not match within ${ms}ms:\n${buf.out.slice(-2000)}`);
  };
  const type = (line: string): void => { const sink = p.stdin as import("bun").FileSink; sink.write(line); sink.flush(); };
  const stop = async (): Promise<void> => { try { (p.stdin as import("bun").FileSink).end(); } catch { /* closed */ } p.kill(); await p.exited.catch(() => {}); await pump; };
  return { p, buf, waitOut, type, stop, pump };
}
const markers = (log: string): string[] => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : [];

test("--plain repl: pre_tool deny (under --yolo) reached the model, on_event saw each run_end, session_close 0× before /exit and exactly 1× after; rt.steering is threaded — a background task's completion note reaches the NEXT repl turn", async () => {
  const work = mkdtempSync(join(tmpdir(), "rovecode-replhooks-"));
  const home = mkdtempSync(join(tmpdir(), "rovecode-replhooks-home-"));
  const log = join(work, "hooks.log");
  mkdirSync(join(work, ".rovecode"), { recursive: true });
  writeFileSync(join(work, ".rovecode", "hooks.ts"), `import { appendFileSync } from "node:fs";
const mark = (s) => appendFileSync(${JSON.stringify(log)}, s + "\\n");
export default { version: 1, hooks: {
  session_open() { mark("session_open"); },
  pre_tool(_ctx, call) { mark("pre_tool:" + call.tool); if (call.tool === "bash") return { deny: "no shell in the repl" }; },
  on_event(_ctx, ev) { if (ev.type === "run_end") mark("on_event:run_end:" + ev.status); },
  session_close() { mark("session_close"); },
} };
`);
  trustProjectFiles(work, home);
  // scripted OpenAI-compatible provider keyed on the LATEST user message (a steer becomes one):
  // "run it" → bash call, then DONE-REPL once the tool message carries the hook's deny;
  // "PARENT …" → task start, then "PARENT done"; "CHILD ping" (the task's own run) → PONG;
  // anything else (the "after" turn — or the steer that rode in behind it) → echoed back
  const served: string[] = [];
  const server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(req) {
      const body = await req.json() as { messages: { role: string; content?: string | null }[] };
      const at = body.messages.findLastIndex((m) => m.role === "user");
      const last = String(body.messages[at]?.content ?? "");
      const toolsAfter = body.messages.slice(at + 1).filter((m) => m.role === "tool");
      served.push(last);
      const text = (content: string) => Response.json({ choices: [{ message: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
      const call = (name: string, args: unknown) => Response.json({ choices: [{ message: { content: null, tool_calls: [{ id: `call_${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
      if (last === "run it") {
        if (toolsAfter.length === 0) return call("bash", { command: "echo hi" });
        return text(toolsAfter.some((m) => typeof m.content === "string" && m.content.includes("Permission denied by hook: no shell in the repl")) ? "DONE-REPL" : "UNEXPECTED-TOOL-RESULT");
      }
      if (last === "CHILD ping") return text("PONG");
      if (last.startsWith("PARENT")) return toolsAfter.length === 0 ? call("task", { action: "start", goal: "CHILD ping", label: "ping" }) : text("PARENT done");
      return text(`MODEL-SAW ${last}`);
    },
  });
  const child = spawnRepl(work, hermeticEnv(home, { ROVECODE_BASE_URL: `http://127.0.0.1:${server.port}`, ROVECODE_API_KEY: "test-key", ROVECODE_MODEL: "scripted", ROVECODE_NO_REPOMAP: "1", ROVECODE_NO_CHECKPOINTS: "1" }));
  try {
    await child.waitOut((o) => o.includes("rovecode>"));
    child.type("run it\n");
    await child.waitOut((o) => o.includes("DONE-REPL") || o.includes("UNEXPECTED"));
    expect(child.buf.out).toContain("DONE-REPL");                        // the provider only says this after seeing the hook's deny in the tool message (mutation: drop `hooks:` → the bash runs, UNEXPECTED)
    expect(child.buf.out).not.toContain("UNEXPECTED");
    expect(markers(log)).toEqual(["session_open", "pre_tool:bash", "on_event:run_end:done"]); // no session_close yet
    // port #26 steering through the repl: the task's completion note waits in rt.steering and the
    // next run drains it BEFORE its model turn, so the provider sees it as the latest user message
    child.type("PARENT ping\n");
    await child.waitOut((o) => o.includes("PARENT done"));
    await waitFor(() => served.includes("CHILD ping"), 8000, "child task served");
    await sleep(400);                                                     // child run_end → TaskManager.finish → rt.steering.push (sub-ms; generous)
    child.type("after\n");
    await child.waitOut((o) => o.includes("MODEL-SAW"));
    expect(child.buf.out).toContain("MODEL-SAW task t1 (ping) finished: PONG"); // mutation: a fresh SteeringQueue instead of rt.steering → "MODEL-SAW after"
    expect(markers(log).filter((m) => m === "session_close")).toEqual([]);
    child.type("/exit\n");
    expect(await deadline(child.p.exited, 15_000, "repl exit")).toBe(0);
    expect(child.buf.out).toContain("bye — session");
    const all = markers(log);
    expect(all.filter((m) => m === "session_close")).toEqual(["session_close"]);            // exactly once (mutation: drop hooks.close() in rl "close" → [])
    expect(all.at(-1)).toBe("session_close");
    expect(all.filter((m) => m.startsWith("on_event:run_end")).length).toBe(4);             // the repl's three runs + the child task's run (0cf2992: children run under the parent runtime's hooks)
    expect(all.filter((m) => m.startsWith("pre_tool:"))).toEqual(["pre_tool:bash", "pre_tool:task"]); // the child issued no tool call
  } finally {
    await child.stop();
    server.stop(true);
    await rmRetry(work); await rmRetry(home);
  }
}, 60_000);
