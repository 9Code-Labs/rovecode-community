/** aion port #84 — TUI `/sessions rename|delete|fork|search` (src/tui/session-manage.ts) through runTui with a scripted
 *  FakeRenderer (the tui-session-nav seam plus an `approval` knob) and a mock stream: no provider, no network. Pins:
 *  rename goes through the LIVE store so a later /new (persistLeaf) keeps the title on disk; delete shows ONE askApproval
 *  card (deny → intact, once → gone, the checkpoints shadow dir with it — a half-delete leaves the space used and nothing
 *  pointing at it); deleting the ACTIVE session leaves the app on a fresh session and the old dir gone; fork switches to
 *  the fork (announced, replayed) with the source bytes untouched; search opens pickOne (label = preview, description =
 *  title · id8 · time), Enter switches, Esc replays, the live session is a candidate; the busy gate refuses all four;
 *  bare /sessions is still the picker; an unknown verb warns; a planted meta.json title reaches the picker label and a
 *  search item one-lined. Scratch dirs via scratchDirs() (#74). */

import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkpointShadowDir } from "../../src/coding/checkpoints.ts";
import { SessionStore } from "../../src/core/session.ts";
import type { Message, StreamFn } from "../../src/core/types.ts";
import { mockStream, textTurn } from "../../src/providers/stream.ts";
import { runTui } from "../../src/tui/app.ts";
import type { ApprovalAnswer, AssistantView, PickItem, Renderer, RendererHooks, SlashCommand, StatusInfo } from "../../src/tui/renderer.ts";
import { scratchDirs } from "../helpers/scratch.ts";

const scratch = scratchDirs(); // #74: every dir below is swept after its test, pass or fail

class FakeRenderer implements Renderer {
  hooks!: RendererHooks;
  notes: { text: string; tone: string }[] = [];
  users: string[] = [];
  assistants: string[] = [];
  pickCalls: { items: PickItem[]; title?: string }[] = [];
  approvals: { tool: string; preview: string; detail?: string }[] = [];
  /** what every askApproval card answers */
  approval: ApprovalAnswer = "once";
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
  toolStart(): void {}
  toolUpdate(): void {}
  toolEnd(): void {}
  async askApproval(tool: string, preview: string, detail?: string): Promise<ApprovalAnswer> { this.approvals.push({ tool, preview, detail }); return this.approval; }
  async askQuestion(): Promise<null> { return null; }
  async pickOne(items: PickItem[], title?: string): Promise<string | null> { this.pickCalls.push({ items, title }); return this.nextPick(items); }
  clearTranscript(): void { this.cleared++; this.users = []; this.assistants = []; }
  prefillEditor(): void {}
  setBusy(busy: boolean): void { this.busyFlags.push(busy); }
  setStatus(_info: StatusInfo): void {}
  warns(): string[] { return this.notes.filter((n) => n.tone === "warn").map((n) => n.text); }
  noted(pred: (text: string) => boolean): boolean { return this.notes.some((n) => pred(n.text)); }
}

async function waitFor(cond: () => boolean, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (cond()) return; await new Promise((r) => setTimeout(r, 10)); }
  if (!cond()) throw new Error("waitFor timed out");
}

const umsg = (text: string, parentId: string | null = null): Message =>
  ({ id: randomUUID(), role: "user", parts: [{ kind: "text", text }], parentId, createdAt: Date.now() });
function seed(root: string, id: string, texts: string[]): void {
  const s = new SessionStore(root, id);
  let parent: string | null = null;
  for (const t of texts) { const m = umsg(t, parent); s.append(m); parent = m.id; }
}
const metaOf = (root: string, id: string): Record<string, unknown> => JSON.parse(readFileSync(join(root, id, "meta.json"), "utf8")) as Record<string, unknown>;
const BUSY_WARN = "finish or interrupt the run first (Esc)";

/** a TUI on `sid` in a fresh cwd, every turn answered "ok" */
function boot(sid: string) {
  const cwd = scratch("rovecode-s84-tui-");
  const root = join(cwd, ".rovecode", "sessions");
  const fake = new FakeRenderer();
  const app = runTui({ renderer: fake, stream: mockStream({ turns: [textTurn("ok")] }), cwd, sessionId: sid, yolo: true, exitOnClose: false, model: "scripted" });
  return { cwd, root, fake, app };
}

test("/sessions rename <title…> titles the CURRENT session through the live store; a later /new (persistLeaf) keeps the title on disk; the /sessions picker label shows it; no title → usage warn", async () => {
  const sid = "live-1";
  const { root, fake, app } = boot(sid);
  fake.hooks.onSubmit("hello there");
  await waitFor(() => fake.assistants.includes("ok"));
  fake.hooks.onSubmit("/sessions rename   Big   Plan  ");
  await waitFor(() => fake.noted((t) => t.includes('titled "Big Plan"')));
  expect(metaOf(root, sid).title).toBe("Big Plan");
  fake.hooks.onSubmit("/new");
  await waitFor(() => fake.noted((t) => t === "branched to session start"));
  const meta = metaOf(root, sid);
  expect(meta.title).toBe("Big Plan"); // a rename through a SECOND SessionStore would be clobbered by this persistLeaf
  expect(typeof meta.leaf).toBe("string");
  expect(meta.id).toBe(sid);
  fake.nextPick = () => null;
  fake.hooks.onSubmit("/sessions");
  await waitFor(() => fake.pickCalls.length === 1);
  expect(fake.pickCalls[0]!.items.find((i) => i.value === sid)!.label).toBe("Big Plan");
  fake.hooks.onSubmit("/sessions rename");
  await waitFor(() => fake.warns().some((w) => w.includes("usage: /sessions rename")));
  expect(metaOf(root, sid).title).toBe("Big Plan");
  expect(readdirSync(root)).toEqual([sid]); // no second dir appeared
  fake.hooks.onExit();
  await app;
}, 20_000);

test("/sessions delete <prefix>: ONE approval card naming the session; deny → nothing removed; approve → the dir and its checkpoints shadow dir are gone, a sibling survives; ambiguous / unknown → warn, no card", async () => {
  const { cwd, root, fake, app } = boot("main-1");
  seed(root, "victim-1", ["doomed"]);
  seed(root, "sib-a", ["fine"]);
  seed(root, "sib-b", ["fine too"]);
  const shadow = checkpointShadowDir(cwd, "victim-1");
  mkdirSync(join(shadow, ".git"), { recursive: true }); writeFileSync(join(shadow, ".git", "HEAD"), "x");
  fake.approval = "deny";
  fake.hooks.onSubmit("/sessions delete victim");
  await waitFor(() => fake.warns().some((w) => w.includes("delete cancelled")));
  expect(fake.approvals.length).toBe(1);
  expect(fake.approvals[0]!.tool).toBe("sessions delete");
  expect(fake.approvals[0]!.preview).toContain("victim-1");
  expect(fake.approvals[0]!.preview).toContain("doomed");
  expect(existsSync(join(root, "victim-1"))).toBe(true);
  expect(existsSync(shadow)).toBe(true);
  fake.approval = "once";
  fake.hooks.onSubmit("/sessions delete victim");
  await waitFor(() => fake.noted((t) => t.startsWith("deleted session victim-1")));
  expect(fake.approvals.length).toBe(2);
  expect(existsSync(join(root, "victim-1"))).toBe(false);
  expect(existsSync(shadow)).toBe(false); // the shadow repo goes with the session: a half-delete leaves the space used
  expect(readdirSync(root).sort()).toEqual(["sib-a", "sib-b"]);
  fake.hooks.onSubmit("/sessions delete sib");
  await waitFor(() => fake.warns().some((w) => w.includes("matches 2 sessions")));
  fake.hooks.onSubmit("/sessions delete nobody");
  await waitFor(() => fake.warns().some((w) => w.includes('no session matching "nobody"')));
  fake.hooks.onSubmit("/sessions delete");
  await waitFor(() => fake.warns().some((w) => w.includes("usage: /sessions delete")));
  expect(fake.approvals.length).toBe(2); // no card for the refused ones
  expect(readdirSync(root).sort()).toEqual(["sib-a", "sib-b"]); // main-1 is the live session: its dir appears at its first append
  fake.hooks.onExit();
  await app;
}, 20_000);

test("/sessions delete of the ACTIVE session switches the app to a fresh session first, then removes the old dir; the next turn lands in the fresh session", async () => {
  const sid = "active-1";
  const { root, fake, app } = boot(sid);
  fake.hooks.onSubmit("first turn");
  await waitFor(() => fake.assistants.includes("ok"));
  fake.hooks.onSubmit(`/sessions delete ${sid}`);
  await waitFor(() => fake.noted((t) => t.startsWith("deleted session active-1")));
  expect(fake.approvals[0]!.preview).toContain("the current session");
  expect(fake.noted((t) => t.includes("switched to a fresh one first"))).toBe(true);
  expect(existsSync(join(root, sid))).toBe(false);
  expect(readdirSync(root)).toEqual([]); // the fresh session's dir appears at its first append (SessionStore's constructor writes nothing)
  expect(fake.users).toEqual([]);        // its transcript is empty (the switch replayed it)
  expect(fake.assistants).toEqual([]);
  fake.hooks.onSubmit("second turn");
  await waitFor(() => fake.assistants.length === 1);
  const dirs = readdirSync(root);
  expect(dirs.length).toBe(1);
  expect(dirs[0]).not.toBe(sid);
  expect(readFileSync(join(root, dirs[0]!, "entries.jsonl"), "utf8")).toContain("second turn");
  expect(existsSync(join(root, sid))).toBe(false);
  fake.hooks.onExit();
  await app;
}, 20_000);

test("/sessions fork (default: current) copies the session and switches to the fork — announced and replayed — the source bytes untouched, later turns land in the fork; /sessions fork <prefix> forks another session", async () => {
  const { root, fake, app } = boot("fsrc-1");
  fake.hooks.onSubmit("fork me");
  await waitFor(() => fake.assistants.includes("ok"));
  const srcEntries = readFileSync(join(root, "fsrc-1", "entries.jsonl"), "utf8");
  fake.hooks.onSubmit("/sessions fork");
  await waitFor(() => fake.noted((t) => t.startsWith("forked fsrc-1 →")));
  const forkId = readdirSync(root).find((d) => d !== "fsrc-1")!;
  expect(readdirSync(root).length).toBe(2);
  expect(readFileSync(join(root, forkId, "entries.jsonl"), "utf8")).toBe(srcEntries);
  expect(metaOf(root, forkId)).toMatchObject({ id: forkId, forkedFrom: "fsrc-1", title: "fork me (fork #1)" });
  expect(fake.noted((t) => t.startsWith(`session ${forkId.slice(0, 8)}`))).toBe(true); // switchSession announced it
  expect(fake.users).toEqual(["fork me"]);   // replayed from the copy
  expect(fake.assistants).toEqual(["ok"]);
  fake.hooks.onSubmit("after fork");
  await waitFor(() => fake.assistants.length === 2);
  expect(readFileSync(join(root, "fsrc-1", "entries.jsonl"), "utf8")).toBe(srcEntries);
  expect(readFileSync(join(root, forkId, "entries.jsonl"), "utf8")).toContain("after fork");
  seed(root, "other-9", ["elsewhere"]);
  fake.hooks.onSubmit("/sessions fork other");
  await waitFor(() => fake.noted((t) => t.startsWith("forked other-9 →")));
  await waitFor(() => fake.users.includes("elsewhere"));
  expect(readdirSync(root).length).toBe(4);
  fake.hooks.onSubmit("/sessions fork nobody");
  await waitFor(() => fake.warns().some((w) => w.includes('no session matching "nobody"')));
  expect(readdirSync(root).length).toBe(4);
  fake.hooks.onExit();
  await app;
}, 20_000);

test("/sessions search <terms…> opens pickOne (label = preview, description = title · id8 · time); Enter switches; Esc replays; the CURRENT session is a candidate; no hits / no terms → note / usage warn", async () => {
  const { root, fake, app } = boot("cur-1");
  seed(root, "far-1", ["quantum tunnel notes"]);
  new SessionStore(root, "far-1").patchMeta({ title: "Physics" });
  fake.hooks.onSubmit("quantum leap here");
  await waitFor(() => fake.assistants.includes("ok"));
  const clearedBefore = fake.cleared;
  fake.nextPick = () => null;
  fake.hooks.onSubmit("/sessions search quantum");
  await waitFor(() => fake.pickCalls.length === 1);
  expect(fake.pickCalls[0]!.title).toContain("Enter = resume");
  const items = fake.pickCalls[0]!.items;
  expect(items.length).toBe(2);
  const far = items.find((i) => i.description!.includes("far-1"))!, cur = items.find((i) => i.description!.includes("cur-1"))!;
  expect(far.label).toContain("quantum tunnel notes");
  expect(far.description).toContain("Physics · far-1");
  expect(cur.description).toContain("cur-1 · current"); // the live session is not excluded from its own search
  expect(cur.label).toContain("quantum leap here");
  await waitFor(() => fake.cleared === clearedBefore + 1); // Esc → replayHistory
  expect(fake.users).toEqual(["quantum leap here"]);
  fake.nextPick = (its) => its.find((i) => i.description!.includes("far-1"))!.value;
  fake.hooks.onSubmit("/sessions search quantum");
  await waitFor(() => fake.users.includes("quantum tunnel notes"));
  expect(fake.noted((t) => t.startsWith("session far-1"))).toBe(true);
  fake.hooks.onSubmit("/sessions search zzzzunknown");
  await waitFor(() => fake.noted((t) => t.includes("no matches")));
  fake.hooks.onSubmit("/sessions search");
  await waitFor(() => fake.warns().some((w) => w.includes("usage: /sessions search")));
  expect(fake.pickCalls.length).toBe(2);
  fake.hooks.onExit();
  await app;
}, 20_000);

test("busy gate: all four verbs refuse mid-run with the shared note and touch nothing; an unknown verb warns; bare /sessions is still the picker", async () => {
  const cwd = scratch("rovecode-s84-tui-");
  const root = join(cwd, ".rovecode", "sessions");
  const sid = "gate-1";
  let started!: () => void;
  const startedP = new Promise<void>((r) => { started = r; });
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const stream: StreamFn = async function* () { started(); await gate; yield { type: "turn", turn: textTurn("answer") }; };
  const fake = new FakeRenderer();
  const app = runTui({ renderer: fake, stream, cwd, sessionId: sid, yolo: true, exitOnClose: false, model: "scripted" });
  fake.hooks.onSubmit("go");
  await startedP;
  for (const v of ["rename Mid Run", `delete ${sid}`, "fork", "search go"]) fake.hooks.onSubmit(`/sessions ${v}`);
  await waitFor(() => fake.warns().filter((w) => w === BUSY_WARN).length === 4);
  expect(fake.approvals.length).toBe(0);
  expect(fake.pickCalls.length).toBe(0);
  expect("title" in metaOf(root, sid)).toBe(false);
  expect(readdirSync(root)).toEqual([sid]);
  release();
  await waitFor(() => fake.busyFlags.at(-1) === false && fake.assistants.some((a) => a.includes("answer")));
  fake.hooks.onSubmit("/sessions bogus now");
  await waitFor(() => fake.warns().some((w) => w.includes('unknown /sessions verb "bogus"')));
  fake.nextPick = () => null;
  fake.hooks.onSubmit("/sessions");
  await waitFor(() => fake.pickCalls.length === 1);
  expect(fake.pickCalls[0]!.title).toBe("resume a session (Esc = cancel)");
  fake.hooks.onExit();
  await app;
}, 20_000);

test("a planted meta.json title (newlines, ANSI) reaches the TUI one-lined: the /sessions picker label and the /sessions search item description carry no newline or escape byte", async () => {
  const { root, fake, app } = boot("cur-9");
  seed(root, "evil-9", ["planted"]);
  const m = metaOf(root, "evil-9"); m.title = "line1\nremoved D:/fake/injected/path\n\u001b[31mRED\u001b[0m";
  writeFileSync(join(root, "evil-9", "meta.json"), JSON.stringify(m, null, 2));
  fake.nextPick = () => null;
  fake.hooks.onSubmit("/sessions");
  await waitFor(() => fake.pickCalls.length === 1);
  expect(fake.pickCalls[0]!.items.find((i) => i.value === "evil-9")!.label).toBe("line1 removed D:/fake/injected/path [31mRED [0m");
  fake.hooks.onSubmit("/sessions search removed");
  await waitFor(() => fake.pickCalls.length === 2);
  const items = fake.pickCalls[1]!.items;
  expect(items.length).toBe(1);
  expect(items[0]!.description).toContain("line1 removed D:/fake/injected/path [31mRED [0m · evil-9");
  expect(items[0]!.description).not.toMatch(/[\n\u001b]/);
  fake.hooks.onExit();
  await app;
}, 20_000);
