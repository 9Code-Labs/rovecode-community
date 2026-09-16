/** Port #34 TUI wiring: `/attach` through the real headless TUI (runTui → agentLoop → Renderer →
 *  pi-tui → xterm emulator) where the chip must be SEEN, and through a FakeRenderer (tui-session-nav
 *  idiom) where the seam itself is the assertion. Every StreamFn captures the messages the loop
 *  sends, so "the image reached the model" is checked on the wire-side history, not on notes.
 *  (a) attach → [text, image] parts, sidecar JSONL, chip shown, stage consumed
 *  (a2) image-only Enter sends nothing (text required — attach note + /help say so)
 *  (a3) a custom command rendering to "" reaches submit("") — no run, warn note, stage kept
 *  (b) a text file → error note, nothing staged   (c) the 9th image is refused; /attach clear
 *  (d) vision notes: no-image-input model warns, unknown model informs
 *  (e) attach while busy → the queued steer carries the image when the loop drains it
 *  (f) attach then /resume → carried over with a note (same-store /new keeps it)
 *  (g) resume replay shows chips (incl. an image-only turn)   (h) export markdown shows chip lines
 *  (k) /attach is a built-in: palette + /help, a custom attach.md loses */

import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { VirtualTerminal } from "../../vendor/pi-tui/test/virtual-terminal.ts";
import { PiTuiRenderer } from "../../src/tui/pi-renderer.ts";
import { runTui } from "../../src/tui/app.ts";
import { SessionStore } from "../../src/core/session.ts";
import { imageFromBytes } from "../../src/core/images.ts";
import { exportSession } from "../../src/cli/export.ts";
import { mockStream, textTurn, toolTurn } from "../../src/providers/stream.ts";
import type { ImagePart, Message, StreamFn } from "../../src/core/types.ts";
import type { ApprovalAnswer, AssistantView, PickItem, Renderer, RendererHooks, SlashCommand, StatusInfo } from "../../src/tui/renderer.ts";
import { PNG_1x1, PNG_1x1_B64 } from "../fixtures/images.ts";

const PNG_SHA = createHash("sha256").update(PNG_1x1).digest("hex");
const IMAGE_PART: ImagePart = { kind: "image", mime: "image/png", bytes: PNG_1x1_B64, width: 1, height: 1, name: "dot.png" };

// ---------- rig ----------

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

class FakeRenderer implements Renderer {
  hooks!: RendererHooks;
  notes: { text: string; tone: string }[] = [];
  users: string[] = [];
  assistants: string[] = [];
  commands: SlashCommand[] = [];
  statuses: StatusInfo[] = [];
  busyFlags: boolean[] = [];
  cleared = 0;
  start(h: RendererHooks): void { this.hooks = h; }
  stop(): void {}
  setCommands(c: SlashCommand[]): void { this.commands = c; }
  addUser(text: string): void { this.users.push(text); }
  addSystemNote(text: string, tone: "info" | "warn" | "error" = "info"): void { this.notes.push({ text, tone }); }
  beginAssistant(): AssistantView {
    let buf = "";
    const sink = this.assistants;
    return { append(d: string) { buf += d; }, done() { sink.push(buf); } };
  }
  toolStart(): void {}
  toolUpdate(): void {}
  toolEnd(): void {}
  async askApproval(): Promise<ApprovalAnswer> { return "once"; }
  async askQuestion(): Promise<null> { return null; }
  async pickOne(_items: PickItem[]): Promise<string | null> { return null; }
  clearTranscript(): void { this.cleared++; this.users = []; this.assistants = []; }
  prefillEditor(): void {}
  setBusy(busy: boolean): void { this.busyFlags.push(busy); }
  setStatus(info: StatusInfo): void { this.statuses.push(info); }
  texts(tone?: string): string[] { return this.notes.filter((n) => tone === undefined || n.tone === tone).map((n) => n.text); }
  has(fragment: string, tone?: string): boolean { return this.texts(tone).some((t) => t.includes(fragment)); }
}

/** A cwd with dot.png (the 70-byte 1x1 PNG) and notes.txt (text under an image-looking name too). */
function cwdWithImage(): string {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-attach-"));
  writeFileSync(join(cwd, "dot.png"), PNG_1x1);
  writeFileSync(join(cwd, "notes.txt"), "hello, plain text");
  writeFileSync(join(cwd, "fake.png"), "hello, i am text pretending to be an image");
  return cwd;
}

/** StreamFn that records every history the loop sends and delegates to a scripted mock. */
function capturing(turns: Parameters<typeof mockStream>[0]["turns"]): { stream: StreamFn; seen: Message[][] } {
  const seen: Message[][] = [];
  const inner = mockStream({ turns });
  const stream: StreamFn = (m, msgs, o) => { seen.push(msgs); return inner(m, msgs, o); };
  return { stream, seen };
}

const lastUser = (msgs: Message[]): Message => msgs.filter((m) => m.role === "user").at(-1)!;
function dot(): ImagePart { const r = imageFromBytes(PNG_1x1, { name: "dot.png" }); if ("error" in r) throw new Error(r.error); return r; }

// ---------- (a) the happy path, on screen ----------

test("(a) /attach dot.png → the run's user message carries [text, image] (inline bytes, 1x1, name); the JSONL has attachments/<sha>.png and no base64; the transcript shows the [image: dot.png] chip; the stage is consumed by that one message", async () => {
  const cwd = cwdWithImage();
  const sid = randomUUID();
  const term = new VirtualTerminal(120, 30);
  const renderer = new PiTuiRenderer({ terminal: term, cwd });
  const { stream, seen } = capturing([textTurn("a dot"), textTurn("plain answer")]);
  const app = runTui({ renderer, stream, cwd, sessionId: sid, yolo: true, exitOnClose: false, model: "scripted" });

  term.sendInput("/attach dot.png"); term.sendInput("\r");
  const noted = await until(term, (s) => s.includes("attached dot.png"));
  expect(noted).toContain("attached dot.png, 1x1, 70 B (1/8)");
  expect(noted).toContain("type your message and press Enter to send it"); // text required (a2)
  expect(noted).toContain("image sent as-is (provider may reject)");       // "scripted" is not in the catalog

  term.sendInput("what is this?"); term.sendInput("\r");
  const screen = await until(term, (s) => s.includes("a dot") && !s.includes("thinking"));
  expect(screen).toContain("> what is this?");
  expect(screen).toContain("[image: dot.png]");                           // the chip under the user line
  expect(lastUser(seen[0]!).parts).toEqual([{ kind: "text", text: "what is this?" }, IMAGE_PART]); // what the model got
  const sessionDir = join(cwd, ".rovecode", "sessions", sid);
  const raw = readFileSync(join(sessionDir, "entries.jsonl"), "utf8");
  expect(raw).toContain(`attachments/${PNG_SHA}.png`);
  expect(raw).not.toContain(PNG_1x1_B64);
  expect(readFileSync(join(sessionDir, "attachments", `${PNG_SHA}.png`)).equals(PNG_1x1)).toBe(true);

  // consumed: the stage is empty and the next message rides alone
  term.sendInput("/attach"); term.sendInput("\r");
  await until(term, (s) => s.includes("no images attached"));
  term.sendInput("and now?"); term.sendInput("\r");
  await until(term, (s) => s.includes("plain answer") && !s.includes("thinking"));
  expect(lastUser(seen[1]!).parts).toEqual([{ kind: "text", text: "and now?" }]);

  term.sendInput("\x03"); await app;
  rmSync(cwd, { recursive: true, force: true });
}, 30_000);

test("(a2) image-only submit is not a thing: Enter on an empty editor with a staged image starts no run and keeps the stage; /help documents the text requirement", async () => {
  const cwd = cwdWithImage();
  const term = new VirtualTerminal(120, 30);
  const renderer = new PiTuiRenderer({ terminal: term, cwd });
  const { stream, seen } = capturing([textTurn("never")]);
  const app = runTui({ renderer, stream, cwd, yolo: true, exitOnClose: false, model: "scripted" });
  term.sendInput("/attach dot.png"); term.sendInput("\r");
  await until(term, (s) => s.includes("attached dot.png"));
  term.sendInput("\r");                                  // empty editor: pi-renderer drops it before onSubmit
  await new Promise((r) => setTimeout(r, 300));
  expect(seen.length).toBe(0);                           // no run started
  term.sendInput("/attach"); term.sendInput("\r");
  const listed = await until(term, (s) => s.includes("attached (1/8)"));
  expect(listed).toContain("1. dot.png, 1x1, 70 B");     // still staged
  term.sendInput("/help"); term.sendInput("\r");
  const help = await until(term, (s) => s.includes("/attach —"));
  expect(help).toContain("/attach — Attach an image to your next message (text required)");
  term.sendInput("\x03"); await app;
  rmSync(cwd, { recursive: true, force: true });
}, 20_000);

test("(a3) a custom command that renders to \"\" (`/ask` on a bare `$ARGUMENTS`) reaches submit(\"\"): with a staged image it starts no run, warns that text is required and keeps the stage — the next real /ask carries the image; with nothing staged it starts no run either (empty text never runs)", async () => {
  const cwd = cwdWithImage();
  const home = mkdtempSync(join(tmpdir(), "rovecode-attach-home-"));
  const savedHome = process.env.ROVECODE_HOME;
  process.env.ROVECODE_HOME = home;                          // hermetic user scope
  mkdirSync(join(cwd, ".rovecode", "commands"), { recursive: true });
  writeFileSync(join(cwd, ".rovecode", "commands", "ask.md"), "$ARGUMENTS\n", "utf8");
  try {
    const fake = new FakeRenderer();
    const { stream, seen } = capturing([textTurn("x")]);
    const app = runTui({ renderer: fake, stream, cwd, yolo: true, exitOnClose: false, model: "scripted" });
    fake.hooks.onSubmit("/ask");                         // renders "" — nothing staged
    await waitFor(() => fake.has("nothing to send"), 8000, "empty note");
    expect(fake.texts("warn")).toEqual(["nothing to send — the message is empty"]);
    fake.hooks.onSubmit("/attach dot.png");
    await waitFor(() => fake.has("attached dot.png"), 8000, "attach note");
    fake.hooks.onSubmit("/ask");                         // renders "" — one image staged
    await waitFor(() => fake.has("type a message to send with the attached image"), 8000, "text-required note");
    expect(fake.texts("warn").at(-1)).toBe("type a message to send with the attached image");
    await new Promise((r) => setTimeout(r, 200));
    expect(seen.length).toBe(0);                         // neither empty submit started a run
    expect(fake.users).toEqual([]);                      // no empty user echo
    expect(fake.busyFlags).toEqual([]);                  // never went busy
    fake.hooks.onSubmit("/attach");
    await waitFor(() => fake.has("attached (1/8):"), 8000, "listing"); // still staged
    fake.hooks.onSubmit("/ask what is this?");           // renders "what is this?" — this run carries the image
    await waitFor(() => fake.assistants.includes("x") && fake.busyFlags.at(-1) === false, 10_000, "run end");
    expect(seen.length).toBe(1);
    expect(lastUser(seen[0]!).parts).toEqual([{ kind: "text", text: "what is this?" }, IMAGE_PART]);
    expect(fake.users).toEqual(["what is this?\n[image: dot.png]"]);
    fake.hooks.onExit(); await app;
  } finally {
    if (savedHome === undefined) delete process.env.ROVECODE_HOME; else process.env.ROVECODE_HOME = savedHome;
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}, 20_000);

// ---------- (b) (c) (d): refusals and notes through the seam ----------

test("(b) a text file (even named .png) and a missing file are error notes — nothing staged", async () => {
  const cwd = cwdWithImage();
  const fake = new FakeRenderer();
  const app = runTui({ renderer: fake, stream: mockStream({ turns: [textTurn("x")] }), cwd, yolo: true, exitOnClose: false, model: "scripted" });
  fake.hooks.onSubmit("/attach notes.txt");
  fake.hooks.onSubmit("/attach fake.png");
  fake.hooks.onSubmit("/attach nope.png");
  fake.hooks.onSubmit("/attach");
  await waitFor(() => fake.has("no images attached"), 8000, "listing note");
  expect(fake.texts("error")).toEqual([
    "notes.txt: not a png/jpeg/gif/webp image (magic bytes: 68 65 6c 6c)",
    "fake.png: not a png/jpeg/gif/webp image (magic bytes: 68 65 6c 6c)",
    expect.stringMatching(/^nope\.png: cannot read \(/),
  ]);
  expect(fake.texts().some((t) => t.startsWith("attached "))).toBe(false); // no success note of any kind
  expect(fake.texts().at(-1)).toBe("no images attached — /attach <path>");
  fake.hooks.onExit(); await app;
  rmSync(cwd, { recursive: true, force: true });
}, 20_000);

test("(c) eight images stage, the 9th is refused with the cap message and the stage stays at 8; /attach clear empties it", async () => {
  const cwd = cwdWithImage();
  const fake = new FakeRenderer();
  const app = runTui({ renderer: fake, stream: mockStream({ turns: [textTurn("x")] }), cwd, yolo: true, exitOnClose: false, model: "scripted" });
  for (let i = 0; i < 9; i++) fake.hooks.onSubmit("/attach dot.png");
  fake.hooks.onSubmit("/attach");
  await waitFor(() => fake.has("attached (8/8):"), 8000, "listing note");
  expect(fake.texts("info").filter((t) => t.startsWith("attached dot.png")).length).toBe(8);
  expect(fake.has("attached dot.png, 1x1, 70 B (8/8)")).toBe(true);
  expect(fake.texts("error")).toEqual(["at most 8 images per message (9 attached)"]);
  const listing = fake.texts().find((t) => t.startsWith("attached (8/8):"))!;
  expect(listing.split("\n").length).toBe(9);           // header + 8 rows
  expect(listing).toContain("8. dot.png, 1x1, 70 B");
  fake.hooks.onSubmit("/attach clear");
  fake.hooks.onSubmit("/attach");
  await waitFor(() => fake.has("no images attached — /attach <path>"), 8000, "empty listing");
  expect(fake.has("attachments cleared (8 images removed)")).toBe(true);
  fake.hooks.onExit(); await app;
  rmSync(cwd, { recursive: true, force: true });
}, 20_000);

test("(d) vision notes at attach time: a catalog model without image input warns (placeholder will be sent); an unknown model gets the info note only", async () => {
  const cwd = cwdWithImage();
  // deepseek-ai/deepseek-v4-pro: models.dev modalities.input = ["text"] — resolved through the
  // vendor prefix under ANY provider id, so the note does not depend on the host env's provider
  const fake = new FakeRenderer();
  const app = runTui({ renderer: fake, stream: mockStream({ turns: [textTurn("x")] }), cwd, yolo: true, exitOnClose: false, model: "deepseek-ai/deepseek-v4-pro" });
  fake.hooks.onSubmit("/attach dot.png");
  await waitFor(() => fake.has("has no image input"), 8000, "warn note");
  expect(fake.texts("warn")).toEqual([expect.stringMatching(/^model .*deepseek-ai\/deepseek-v4-pro has no image input — it will be sent as a text placeholder$/)]);
  expect(fake.has("image sent as-is")).toBe(false);
  fake.hooks.onExit(); await app;

  const fake2 = new FakeRenderer();
  const app2 = runTui({ renderer: fake2, stream: mockStream({ turns: [textTurn("x")] }), cwd, yolo: true, exitOnClose: false, model: "scripted" });
  fake2.hooks.onSubmit("/attach dot.png");
  await waitFor(() => fake2.has("image sent as-is"), 8000, "info note");
  expect(fake2.texts("info").at(-1)).toMatch(/^unknown model .*\/scripted; image sent as-is \(provider may reject\)$/);
  expect(fake2.texts("warn")).toEqual([]);
  fake2.hooks.onExit(); await app2;
  rmSync(cwd, { recursive: true, force: true });
}, 20_000);

// ---------- (e) busy: the steer carries the image ----------

test("(e) /attach while a run is busy → the queued steer carries the image when the loop drains it; the busy note says so", async () => {
  const cwd = cwdWithImage();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let parked!: () => void;
  const parkedP = new Promise<void>((r) => { parked = r; });
  const seen: Message[][] = [];
  const probe = join(cwd, "notes.txt");
  const stream: StreamFn = async function* (_m, msgs) {
    seen.push(msgs);
    if (seen.length === 1) { parked(); await gate; yield { type: "turn", turn: toolTurn([{ id: "r1", tool: "read", args: { path: probe } }]) }; return; }
    yield { type: "turn", turn: textTurn("done") };
  };
  const fake = new FakeRenderer();
  const app = runTui({ renderer: fake, stream, cwd, yolo: true, exitOnClose: false, model: "scripted" });
  fake.hooks.onSubmit("go");
  await parkedP;                                         // turn 1 is inside the provider call
  fake.hooks.onSubmit("/attach dot.png");
  await waitFor(() => fake.has("attached dot.png"), 8000, "attach note");
  fake.hooks.onSubmit("look at this");
  await waitFor(() => fake.has("queued as steering"), 8000, "busy note");
  expect(fake.texts().at(-1)).toBe("queued as steering (applies before the next model turn) — 1 image attached to your queued message");
  expect(fake.users.at(-1)).toBe("look at this\n[image: dot.png]");
  release();                                             // turn 1 → read tool → turn 2 drains the steer
  await waitFor(() => fake.assistants.some((a) => a.includes("done")) && fake.busyFlags.at(-1) === false, 10_000, "run end");
  expect(seen.length).toBe(2);
  const steer = lastUser(seen[1]!);
  expect(steer.parts).toEqual([{ kind: "text", text: "look at this" }, IMAGE_PART]); // the steer, not the goal, carries it
  expect(lastUser(seen[0]!).parts).toEqual([{ kind: "text", text: "go" }]);
  expect(fake.has("↪ steering applied")).toBe(true);
  fake.hooks.onExit(); await app;
  rmSync(cwd, { recursive: true, force: true });
}, 20_000);

// ---------- (f) store swap ----------

test("(f) /attach then /resume <other>: the stage is carried to the new store with a note and rides on the next message THERE; a same-store /new keeps it; nothing is written under the old session", async () => {
  const cwd = cwdWithImage();
  const root = join(cwd, ".rovecode", "sessions");
  new SessionStore(root, "other-sess").appendEvent({ type: "turn_start", turn: 0 }); // pre-existing target: on disk once it holds an entry
  const fake = new FakeRenderer();
  const { stream, seen } = capturing([textTurn("x")]);
  const app = runTui({ renderer: fake, stream, cwd, sessionId: "first-sess", yolo: true, exitOnClose: false, model: "scripted" });
  fake.hooks.onSubmit("/attach dot.png");
  fake.hooks.onSubmit("/new");                           // same store: only the leaf moves (nothing to branch here)
  fake.hooks.onSubmit("/attach");
  await waitFor(() => fake.has("attached (1/8):"), 8000, "listing after /new");
  expect(fake.has("nothing to branch")).toBe(true);

  fake.hooks.onSubmit("/resume other-sess");
  await waitFor(() => fake.has("session other-se"), 8000, "switch note");
  expect(fake.texts().at(-1)).toBe("1 image still attached — carried over to this session, rides on your next message");
  fake.hooks.onSubmit("go");
  await waitFor(() => fake.assistants.some((a) => a.includes("x")) && fake.busyFlags.at(-1) === false, 10_000, "run end");
  expect(lastUser(seen[0]!).parts).toEqual([{ kind: "text", text: "go" }, IMAGE_PART]);
  expect(readFileSync(join(root, "other-sess", "entries.jsonl"), "utf8")).toContain(`attachments/${PNG_SHA}.png`);
  expect(existsSync(join(root, "other-sess", "attachments", `${PNG_SHA}.png`))).toBe(true);
  expect(existsSync(join(root, "first-sess", "attachments"))).toBe(false);
  fake.hooks.onExit(); await app;
  rmSync(cwd, { recursive: true, force: true });
}, 20_000);

// ---------- (g) (h): replay + export of persisted images ----------

/** A session with [text+image] user, assistant, [image-only] user — the persisted (sidecar) form. */
function seedImageSession(root: string, id: string): void {
  const s = new SessionStore(root, id);
  const u1: Message = { id: randomUUID(), role: "user", parts: [{ kind: "text", text: "what" }, dot()], parentId: null, createdAt: Date.UTC(2026, 8, 1, 10, 0, 0) };
  s.append(u1);
  const a1: Message = { id: randomUUID(), role: "assistant", parts: [{ kind: "text", text: "a dot" }], parentId: u1.id, createdAt: Date.UTC(2026, 8, 1, 10, 1, 0) };
  s.append(a1);
  s.append({ id: randomUUID(), role: "user", parts: [dot()], parentId: a1.id, createdAt: Date.UTC(2026, 8, 1, 10, 2, 0) });
}

test("(g) resume replay renders user turns with chips — an image-only turn is a chip line, not blank", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-attach-"));
  seedImageSession(join(cwd, ".rovecode", "sessions"), "img-sess");
  const fake = new FakeRenderer();
  const app = runTui({ renderer: fake, stream: mockStream({ turns: [textTurn("x")] }), cwd, sessionId: "img-sess", yolo: true, exitOnClose: false, model: "scripted" });
  await waitFor(() => fake.assistants.includes("a dot"), 8000, "boot replay");
  expect(fake.users).toEqual(["what\n[image: dot.png]", "[image: dot.png]"]);
  fake.hooks.onExit(); await app;
  rmSync(cwd, { recursive: true, force: true });
}, 20_000);

test("(h) export markdown shows one chip line per image under ## User (describeImage text); an image-only turn is not dropped; --json stays byte-verbatim", () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-attach-"));
  const root = join(cwd, ".rovecode", "sessions");
  seedImageSession(root, "img-export");
  const md = readFileSync(exportSession(root, "img-export", { cwd }).path, "utf8");
  expect(md).toContain("## User\n\nwhat\n\n[image: dot.png, 1x1, 70 B]\n\n## Assistant\n\na dot\n\n## User\n\n[image: dot.png, 1x1, 70 B]\n\n## Costs");
  expect(md).not.toContain(PNG_1x1_B64);
  const src = readFileSync(join(root, "img-export", "entries.jsonl"));
  expect(Buffer.compare(readFileSync(exportSession(root, "img-export", { cwd, json: true }).path), src)).toBe(0);
  rmSync(cwd, { recursive: true, force: true });
});

// ---------- (k) built-in registration ----------

test("(k) /attach is a built-in: it is in the palette, a custom attach.md is refused (built-in kept), and /attach clear on an empty stage is honest", async () => {
  const cwd = cwdWithImage();
  const home = mkdtempSync(join(tmpdir(), "rovecode-attach-home-"));
  const savedHome = process.env.ROVECODE_HOME;
  process.env.ROVECODE_HOME = home;                          // hermetic user scope
  mkdirSync(join(cwd, ".rovecode", "commands"), { recursive: true });
  writeFileSync(join(cwd, ".rovecode", "commands", "attach.md"), "must lose to the built-in\n", "utf8");
  try {
    const fake = new FakeRenderer();
    const app = runTui({ renderer: fake, stream: mockStream({ turns: [textTurn("x")] }), cwd, yolo: true, exitOnClose: false, model: "scripted" });
    await waitFor(() => fake.has("built-in kept"), 8000, "boot warning");
    expect(fake.texts("warn").some((t) => t.includes("/attach is a built-in command"))).toBe(true);
    expect(fake.commands.map((c) => c.name)).toContain("attach");
    expect(fake.commands.filter((c) => c.name === "attach").length).toBe(1); // the custom one did not join the palette
    fake.hooks.onSubmit("/attach clear");
    await waitFor(() => fake.has("no images attached"), 8000, "clear note");
    expect(fake.texts().at(-1)).toBe("no images attached");
    fake.hooks.onExit(); await app;
  } finally {
    if (savedHome === undefined) delete process.env.ROVECODE_HOME; else process.env.ROVECODE_HOME = savedHome;
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}, 20_000);
