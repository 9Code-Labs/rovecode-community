/** Wave-2 fixes for port #2, TUI behavior (MED-1a, LOW-2, LOW-3, LOW-4).
 *  A scripted FakeRenderer drives runTui through the Renderer seam so each behavior
 *  is asserted directly: busy gates, /new replay, ambiguous /resume, boot replay,
 *  memory-tool rebinding, tool-card replay, root rewind, overlay ordering. */

import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { SessionStore } from "../../src/core/session.ts";
import { runTui } from "../../src/tui/app.ts";
import { NOTHING_TO_CONTINUE, resolveBoot } from "../../src/cli/resume.ts";
import { mockStream, textTurn, toolTurn } from "../../src/providers/stream.ts";
import type { StreamFn } from "../../src/core/types.ts";
import type {
  ApprovalAnswer, AssistantView, PickItem, Renderer, RendererHooks, SlashCommand, StatusInfo,
} from "../../src/tui/renderer.ts";

class FakeRenderer implements Renderer {
  hooks!: RendererHooks;
  notes: { text: string; tone: string }[] = [];
  users: string[] = [];
  assistants: string[] = [];
  toolStarts: { callId: string; tool: string }[] = [];
  toolEnds: { callId: string; ok: boolean }[] = [];
  pickCalls: { items: PickItem[]; title?: string }[] = [];
  prefilled: string[] = [];
  statuses: StatusInfo[] = [];
  busyFlags: boolean[] = [];
  cleared = 0;
  nextPick: (items: PickItem[]) => string | null = () => null;
  start(h: RendererHooks): void { this.hooks = h; }
  stop(): void {}
  setCommands(_c: SlashCommand[]): void {}
  addUser(text: string): void { this.users.push(text); }
  addSystemNote(text: string, tone: "info" | "warn" | "error" = "info"): void { this.notes.push({ text, tone }); }
  beginAssistant(): AssistantView {
    let buf = "";
    const sink = this.assistants;
    return { append(d: string) { buf += d; }, done() { sink.push(buf); } };
  }
  toolStart(callId: string, tool: string): void { this.toolStarts.push({ callId, tool }); }
  toolUpdate(): void {}
  toolEnd(callId: string, ok: boolean): void { this.toolEnds.push({ callId, ok }); }
  async askApproval(): Promise<ApprovalAnswer> { return "once"; }
  async askQuestion(): Promise<null> { return null; } // port #33 seam: no-op stub (declines)
  async pickOne(items: PickItem[], title?: string): Promise<string | null> {
    this.pickCalls.push({ items, title });
    return this.nextPick(items);
  }
  clearTranscript(): void { this.cleared++; this.users = []; this.assistants = []; this.toolStarts = []; this.toolEnds = []; }
  prefillEditor(text: string): void { this.prefilled.push(text); }
  setBusy(busy: boolean): void { this.busyFlags.push(busy); }
  setStatus(info: StatusInfo): void { this.statuses.push(info); }
  warns(): string[] { return this.notes.filter((n) => n.tone === "warn").map((n) => n.text); }
}

async function waitFor(cond: () => boolean, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  if (!cond()) throw new Error("waitFor timed out");
}

function umsg(text: string, parentId: string | null, id = randomUUID()) {
  return { id, role: "user" as const, parts: [{ kind: "text" as const, text }], parentId, createdAt: Date.now() };
}

const BUSY_WARN = "finish or interrupt the run first (Esc)";

// ── MED-1a + LOW-4: busy gates for /new //rewind //sessions, then /new replay semantics ──

test("busy gates: /new, /rewind, /sessions refuse mid-run; /new after the run branches and replays", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-nav-"));
  const sid = "gate-session";
  let started!: () => void;
  const startedP = new Promise<void>((r) => { started = r; });
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const stream: StreamFn = async function* () {
    started();
    await gate;
    yield { type: "turn", turn: textTurn("answer") };
  };
  const fake = new FakeRenderer();
  const app = runTui({ renderer: fake, stream, cwd, sessionId: sid, yolo: true, exitOnClose: false, model: "scripted" });

  fake.hooks.onSubmit("go");
  await startedP;                                   // the run has appended its user message
  fake.hooks.onSubmit("/new");
  fake.hooks.onSubmit("/rewind");
  fake.hooks.onSubmit("/sessions");
  await new Promise((r) => setTimeout(r, 50));
  expect(fake.warns().filter((w) => w === BUSY_WARN).length).toBe(3);
  expect(fake.pickCalls.length).toBe(0);            // no overlay opened mid-run
  const metaP = join(cwd, ".rovecode", "sessions", sid, "meta.json");
  expect("leaf" in JSON.parse(readFileSync(metaP, "utf8"))).toBe(false); // leaf never moved mid-run

  release();
  await waitFor(() => fake.busyFlags.at(-1) === false && fake.assistants.some((a) => a.includes("answer")));
  expect(new SessionStore(join(cwd, ".rovecode", "sessions"), sid).reload()).toEqual([]); // chain intact

  fake.hooks.onSubmit("/new");                      // now allowed: branch to session start
  await waitFor(() => fake.notes.some((n) => n.text === "branched to session start"));
  const meta = JSON.parse(readFileSync(metaP, "utf8"));
  const firstId = JSON.parse(readFileSync(join(cwd, ".rovecode", "sessions", sid, "entries.jsonl"), "utf8").split("\n")[0]!).id;
  expect(meta.leaf).toBe(firstId);                  // durable leaf at the first entry
  expect(fake.users).toEqual(["go"]);               // transcript replayed to the branch point
  expect(fake.assistants).toEqual([]);

  fake.hooks.onExit();
  await app;
  rmSync(cwd, { recursive: true, force: true });
}, 20_000);

test("/new on an empty session reports nothing to branch", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-nav-"));
  const fake = new FakeRenderer();
  const app = runTui({ renderer: fake, stream: mockStream({ turns: [textTurn("x")] }), cwd, yolo: true, exitOnClose: false, model: "scripted" });
  fake.hooks.onSubmit("/new");
  await waitFor(() => fake.notes.some((n) => n.text.includes("nothing to branch")));
  expect(fake.notes.some((n) => n.text === "branched to session start")).toBe(false);
  fake.hooks.onExit();
  await app;
  rmSync(cwd, { recursive: true, force: true });
}, 20_000);

// ── LOW-2: ambiguous /resume prefix warns and stays; exact id still wins ──

test("/resume with an ambiguous prefix warns and does not switch; exact id resumes", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-nav-"));
  const root = join(cwd, ".rovecode", "sessions");
  new SessionStore(root, "sess-aab").append(umsg("in aab", null));
  new SessionStore(root, "sess-aabc").append(umsg("in aabc", null));
  const fake = new FakeRenderer();
  const app = runTui({ renderer: fake, stream: mockStream({ turns: [textTurn("x")] }), cwd, yolo: true, exitOnClose: false, model: "scripted" });

  const clearedBefore = fake.cleared;
  fake.hooks.onSubmit("/resume sess-aa");
  await waitFor(() => fake.warns().some((w) => w.includes("matches 2 sessions")));
  expect(fake.cleared).toBe(clearedBefore);         // no switchSession happened
  expect(fake.notes.some((n) => n.text.startsWith("session sess-aab"))).toBe(false);

  fake.hooks.onSubmit("/resume sess-aab");          // exact id, even though it prefixes sess-aabc
  await waitFor(() => fake.users.includes("in aab"));
  expect(fake.users).toEqual(["in aab"]);           // switched to sess-aab, not sess-aabc
  fake.hooks.onExit();
  await app;
  rmSync(cwd, { recursive: true, force: true });
}, 20_000);

// ── LOW-3: booting with opts.sessionId replays transcript and usage ──

test("boot with sessionId replays the transcript and restores usage counters", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-nav-"));
  const root = join(cwd, ".rovecode", "sessions");
  const s = new SessionStore(root, "boot-replay");
  const u = umsg("old question", null); s.append(u);
  s.append({ id: randomUUID(), role: "assistant" as const, parts: [{ kind: "text" as const, text: "old answer" }], parentId: u.id, createdAt: Date.now(), usage: { input: 11, output: 7 } });

  const fake = new FakeRenderer();
  const app = runTui({ renderer: fake, stream: mockStream({ turns: [textTurn("x")] }), cwd, sessionId: "boot-replay", yolo: true, exitOnClose: false, model: "scripted" });
  await waitFor(() => fake.users.includes("old question") && fake.assistants.includes("old answer"));
  const st = fake.statuses.at(-1)!;
  expect(st.tokensIn).toBe(11);
  expect(st.tokensOut).toBe(7);
  fake.hooks.onExit();
  await app;
  rmSync(cwd, { recursive: true, force: true });
}, 20_000);

// Since 2026-09-07 the id typed after --resume is resolved in main.ts (cli/resume.ts resolveBoot) BEFORE any surface
// boots: a unique prefix becomes the full id the TUI opens; an unknown / ambiguous / malformed id is refused (exit 2)
// instead of opening a fresh session under that name. runTui itself only ever receives a full id or nothing.
test("boot with a unique id prefix: resolveBoot hands the TUI the full id, the transcript replays, no stray dir", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-nav-"));
  const root = join(cwd, ".rovecode", "sessions");
  new SessionStore(root, "resolv-target-1").append(umsg("prefix hello", null));
  const boot = resolveBoot(["bun", "main.ts", "--resume", "resolv"], root, (m) => { throw new Error(m); });
  expect(boot).toEqual({ id: "resolv-target-1" });
  const fake = new FakeRenderer();
  const app = runTui({ renderer: fake, stream: mockStream({ turns: [textTurn("x")] }), cwd, sessionId: boot.id, yolo: true, exitOnClose: false, model: "scripted" });
  await waitFor(() => fake.users.includes("prefix hello"));
  expect(existsSync(join(root, "resolv"))).toBe(false); // resolved, not created verbatim
  fake.hooks.onExit();
  await app;
  rmSync(cwd, { recursive: true, force: true });
}, 20_000);

test("boot with an ambiguous prefix is refused before the TUI exists (nothing resumed, nothing created); a boot with nothing to continue from shows the note on the startup card", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-nav-"));
  const root = join(cwd, ".rovecode", "sessions");
  new SessionStore(root, "amb-1").append(umsg("one", null));
  new SessionStore(root, "amb-2").append(umsg("two", null));
  expect(() => resolveBoot(["bun", "main.ts", "--resume", "amb"], root, (m) => { throw new Error(m); })).toThrow(/--resume: "amb" matches 2 sessions: amb-\d, amb-\d — be more specific/);
  expect(readdirSync(root).sort()).toEqual(["amb-1", "amb-2"]);
  const fake = new FakeRenderer();
  const app = runTui({ renderer: fake, stream: mockStream({ turns: [textTurn("x")] }), cwd, bootNote: NOTHING_TO_CONTINUE, yolo: true, exitOnClose: false, model: "scripted" });
  await waitFor(() => fake.notes.some((n) => n.text === NOTHING_TO_CONTINUE));
  expect(fake.notes.find((n) => n.text === NOTHING_TO_CONTINUE)!.tone).toBe("info"); // a note, not a warning — nothing went wrong
  expect(fake.users).toEqual([]);                   // neither session was silently resumed
  expect(existsSync(join(root, "amb"))).toBe(false);
  fake.hooks.onExit();
  await app;
  rmSync(cwd, { recursive: true, force: true });
}, 20_000);

// ── LOW-4: memory tool re-registration on session switch ──

// Since 2026-09-07 memory is PROJECT-scoped (src/memory/scope.ts), so this pins the opposite of what it used to:
// a fact remembered after switching sessions lands in the ONE project file, because it is the same project — and
// the memory tool is still correctly rebound across the switch (the LOW-4 point). The old contract wrote it to
// <sessions>/<id>/memory, which meant every fact died with the session id.
test("memory_edit after /resume writes to the PROJECT memory file, not the switched session's directory", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-nav-"));
  const root = join(cwd, ".rovecode", "sessions");
  new SessionStore(root, "mem-b").append(umsg("b began here", null)); // pre-existing target session (on disk once it holds an entry)
  const stream = mockStream({
    turns: [
      toolTurn([{ id: "m1", tool: "memory_edit", args: { op: "add", block: "memory", text: "FROM-B-FACT" } }]),
      textTurn("saved"),
    ],
  });
  const fake = new FakeRenderer();
  const app = runTui({ renderer: fake, stream, cwd, sessionId: "mem-a", yolo: true, exitOnClose: false, model: "scripted" });

  fake.hooks.onSubmit("/resume mem-b");
  await waitFor(() => fake.notes.some((n) => n.text.startsWith("session mem-b")));
  fake.hooks.onSubmit("save it");
  await waitFor(() => fake.assistants.some((a) => a.includes("saved")));

  const projectFile = join(cwd, ".rovecode", "memory", "MEMORY.md");
  expect(existsSync(projectFile)).toBe(true);
  expect(readFileSync(projectFile, "utf8")).toContain("FROM-B-FACT");
  // neither session directory holds memory any more — that was the bug, not the design
  for (const id of ["mem-a", "mem-b"]) expect([id, existsSync(join(root, id, "memory"))]).toEqual([id, false]);
  fake.hooks.onExit();
  await app;
  rmSync(cwd, { recursive: true, force: true });
}, 20_000);

// ── LOW-4: tool cards replay after a session switch ──

test("tool cards replay after /resume: tool_call and tool_result parts render", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-nav-"));
  const root = join(cwd, ".rovecode", "sessions");
  const s = new SessionStore(root, "toolsess");
  const u = umsg("did tools", null); s.append(u);
  const a1 = {
    id: randomUUID(), role: "assistant" as const, parentId: u.id, createdAt: Date.now(),
    parts: [
      { kind: "text" as const, text: "running" },
      { kind: "tool_call" as const, id: "c1", tool: "write", args: { path: "x" } },
    ],
  }; s.append(a1);
  const t1 = {
    id: randomUUID(), role: "tool" as const, parentId: a1.id, createdAt: Date.now(),
    parts: [{ kind: "tool_result" as const, callId: "c1", ok: true, output: "done output" }],
  }; s.append(t1);
  s.append({ id: randomUUID(), role: "assistant" as const, parentId: t1.id, createdAt: Date.now(), parts: [{ kind: "text" as const, text: "finished" }] });

  const fake = new FakeRenderer();
  const app = runTui({ renderer: fake, stream: mockStream({ turns: [textTurn("x")] }), cwd, yolo: true, exitOnClose: false, model: "scripted" });
  fake.hooks.onSubmit("/resume toolsess");
  await waitFor(() => fake.users.includes("did tools"));
  expect(fake.toolStarts).toContainEqual({ callId: "c1", tool: "write" });
  expect(fake.toolEnds).toContainEqual({ callId: "c1", ok: true });
  expect(fake.assistants).toContain("finished");
  fake.hooks.onExit();
  await app;
  rmSync(cwd, { recursive: true, force: true });
}, 20_000);

// ── LOW-4: root-rewind path + pickOne overlay ordering ──

test("rewind to the ROOT turn opens a fresh session, keeps the old one, prefills the prompt", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-nav-"));
  const root = join(cwd, ".rovecode", "sessions");
  const sid = "root-rewind";
  const fake = new FakeRenderer();
  const app = runTui({ renderer: fake, stream: mockStream({ turns: [textTurn("first answer")] }), cwd, sessionId: sid, yolo: true, exitOnClose: false, model: "scripted" });
  fake.hooks.onSubmit("first question");
  await waitFor(() => fake.assistants.some((a) => a.includes("first answer")));
  const entriesBefore = readFileSync(join(root, sid, "entries.jsonl"), "utf8");

  fake.nextPick = (items) => items.at(-1)!.value;   // last overlay item = turn #1 = the root
  fake.hooks.onSubmit("/rewind");
  await waitFor(() => fake.notes.some((n) => n.text.includes("rewound to the start")));
  expect(fake.prefilled).toContain("first question");            // original prompt back in the editor
  expect(fake.users).toEqual([]);                                // fresh session transcript is empty
  const dirs = readdirSync(root).filter((d) => existsSync(join(root, d, "meta.json")));
  expect(dirs).toEqual([sid]);                                   // the old session; the fresh one reaches disk with its first entry, not before
  expect(readFileSync(join(root, sid, "entries.jsonl"), "utf8")).toBe(entriesBefore); // nothing deleted
  fake.hooks.onExit();
  await app;
  rmSync(cwd, { recursive: true, force: true });
}, 20_000);

test("/rewind overlay lists turns newest-first (#2 above #1)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-nav-"));
  const fake = new FakeRenderer();
  const stream = mockStream({ turns: [textTurn("answer one"), textTurn("answer two")] });
  const app = runTui({ renderer: fake, stream, cwd, yolo: true, exitOnClose: false, model: "scripted" });
  fake.hooks.onSubmit("turn one");
  await waitFor(() => fake.assistants.some((a) => a.includes("answer one")));
  fake.hooks.onSubmit("turn two");
  await waitFor(() => fake.assistants.some((a) => a.includes("answer two")));

  fake.nextPick = () => null;                        // cancel; we only inspect the overlay
  fake.hooks.onSubmit("/rewind");
  await waitFor(() => fake.pickCalls.length === 1);
  const labels = fake.pickCalls[0]!.items.map((i) => i.label);
  expect(labels.length).toBe(2);
  expect(labels[0]!.startsWith("#2 ")).toBe(true);
  expect(labels[1]!.startsWith("#1 ")).toBe(true);
  fake.hooks.onExit();
  await app;
  rmSync(cwd, { recursive: true, force: true });
}, 20_000);

// ── LOW-3 (CLI flag): rovecode --resume <prefix> headlessly replays the session ──

test("CLI: `rovecode --resume <prefix>` boots the TUI on the resumed session (headless)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-cli-"));
  const root = join(cwd, ".rovecode", "sessions");
  const s = new SessionStore(root, "cliresume-full-id");
  const u = umsg("CLI-RESUME-PROBE hello", null); s.append(u);
  s.append({ id: randomUUID(), role: "assistant" as const, parts: [{ kind: "text" as const, text: "probe answer" }], parentId: u.id, createdAt: Date.now() });

  const main = join(import.meta.dir, "..", "..", "src", "cli", "main.ts");
  const proc = Bun.spawn([process.execPath, "run", main, "--resume", "cliresume"], {
    cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe",
    env: { ...process.env, NO_COLOR: "1" },
  });
  // Read via a single pump — NEVER race reader.read() against a timeout: a
  // raced-out read stays queued on the stream and CONSUMES the next chunk,
  // which is then dropped. That was this test's flake: once the child's boot
  // crossed 250ms (bun + the full TUI import graph is ~1-2s on this box),
  // every content chunk landed in an abandoned read and only a late cursor
  // sequence survived, so the 15s deadline burned on a transcript that HAD
  // been printed (~2s in). The deadline poll below just watches the buffer.
  let out = "";
  const dec = new TextDecoder();
  const pump = (async () => {
    for await (const chunk of proc.stdout) out += dec.decode(chunk, { stream: true });
  })().catch(() => {});
  const ready = () => out.includes("CLI-RESUME-PROBE") && out.includes("probe answer");
  const deadline = Date.now() + 20_000;
  try {
    while (Date.now() < deadline && !ready()) {
      await new Promise((r) => setTimeout(r, 50));
    }
  } finally {
    proc.kill();
    await proc.exited.catch(() => {});
    await pump; // stdout closes after kill; collect any tail bytes
  }
  expect(out).toContain("CLI-RESUME-PROBE hello");   // replayed user turn
  expect(out).toContain("probe answer");             // replayed assistant turn
  // Windows: the killed child can hold the cwd lock a beat longer — retry the cleanup
  for (let i = 0; i < 20; i++) {
    try { rmSync(cwd, { recursive: true, force: true }); break; }
    catch { await new Promise((r) => setTimeout(r, 100)); }
  }
}, 40_000);
