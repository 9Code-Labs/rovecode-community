/** Port #65 — `/undo` over a REAL createRuntime and REAL shadow-git checkpoints in a temp workspace (no user git repo
 *  needed). Pins the bar: /undo restores the LAST checkpoint's files through Checkpoints.restore(hash, "files") after a
 *  confirmation card that lists what will change, says what it restored, and leaves the conversation untouched; a
 *  denied card changes nothing; no checkpoint → a note; a workspace already at the last checkpoint → steps back to the pre-edit snapshot;
 *  ROVECODE_NO_CHECKPOINTS=1 → the unavailable note; a busy app is refused. Also Checkpoints.changedSince and the command
 *  table / sextant alias pins (TUI_COMMANDS lists commit + undo; ALIAS_NOTE no longer toasts /undo). Mutations this
 *  file must catch: the wrong checkpoint (log[0] instead of the last — T1 ends at "A" instead of "B"), a skipped card
 *  (T2), a conversation rewind (T1 message count). */

import { test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime } from "../../src/cli/runtime.ts";
import { Checkpoints } from "../../src/coding/checkpoints.ts";
import { resetExecutor } from "../../src/core/executor.ts";
import type { Message } from "../../src/core/types.ts";
import { ALIAS_NOTE } from "../../src/sextant/local-commands.ts";
import { cmdUndo, type GitCmdCtx } from "../../src/tui/git-cmds.ts";
import type { ApprovalAnswer, AssistantView, Renderer, RendererHooks, StatusInfo } from "../../src/tui/renderer.ts";
import type { ApprovalFn } from "../../src/core/types.ts";
import { TUI_COMMANDS } from "../../src/tui/app.ts";

const KNOBS = ["NO_CHECKPOINTS", "YOLO", "SANDBOX", "NO_HOOKS"].map((k) => `ROVECODE_${k}`);
const saved = new Map<string, string | undefined>();
beforeAll(() => { for (const k of KNOBS) { saved.set(k, process.env[k]); delete process.env[k]; } });
afterAll(() => { for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
afterEach(() => resetExecutor());

class SpyRenderer implements Renderer {
  log: string[] = [];
  asks: { tool: string; preview: string; detail?: string }[] = [];
  clears = 0;
  constructor(private readonly answer: ApprovalAnswer) {}
  start(_h: RendererHooks): void {} stop(): void {} setCommands(): void {}
  addUser(text: string): void { this.log.push(`user:${text}`); }
  addSystemNote(text: string, tone = "info"): void { this.log.push(`note:${tone}:${text}`); }
  beginAssistant(): AssistantView { return { append() {}, done() {} }; }
  toolStart(id: string, tool: string): void { this.log.push(`start:${id}:${tool}`); }
  toolUpdate(): void {}
  toolEnd(id: string, ok: boolean): void { this.log.push(`end:${id}:${ok}`); }
  async askApproval(tool: string, preview: string, detail?: string): Promise<ApprovalAnswer> { this.asks.push({ tool, preview, detail }); return this.answer; }
  async askQuestion(): Promise<null> { return null; }
  async pickOne(): Promise<string | null> { return null; }
  clearTranscript(): void { this.clears++; } prefillEditor(text: string): void { this.log.push(`prefill:${text}`); }
  setBusy(): void {} setStatus(_i: StatusInfo): void {}
  get notes(): string[] { return this.log.filter((l) => l.startsWith("note:")); }
}

const umsg = (text: string, parentId: string | null): Message => ({ id: randomUUID(), role: "user", parts: [{ kind: "text", text }], parentId, createdAt: Date.now() });

function boot(over: { answer?: ApprovalAnswer; busy?: boolean } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "rove-p65-undo-"));
  const rt = createRuntime({ cwd, stream: null });
  const renderer = new SpyRenderer(over.answer ?? "once");
  const ctx: GitCmdCtx = { renderer, rt, store: () => rt.store, approve: (): ApprovalFn => async () => over.answer === "deny" ? "deny" : over.answer === "always" ? "always" : "once", yolo: () => false, busy: () => over.busy ?? false, setBusy() {}, bindAbort() {} };
  const file = (name: string): string => join(cwd, name);
  const close = async (): Promise<void> => { await rt.hooks.close().catch(() => {}); try { rmSync(cwd, { recursive: true, force: true }); } catch { /* lingering git handle on Windows */ } };
  return { cwd, rt, ctx, renderer, file, close };
}

/** two snapshots (a.txt = "A", then "B") and two transcript entries, then un-snapshotted changes: a.txt = "C", extra.txt created */
async function seed(b: ReturnType<typeof boot>): Promise<Checkpoints> {
  const cp = (await b.rt.checkpointsFor(b.rt.store.id))!;
  expect(cp).toBeInstanceOf(Checkpoints);
  writeFileSync(b.file("a.txt"), "A");
  await cp.snapshot("edit");
  writeFileSync(b.file("a.txt"), "B");
  await cp.snapshot("write");
  const m1 = umsg("first", null); b.rt.store.append(m1); b.rt.store.append(umsg("second", m1.id));
  writeFileSync(b.file("a.txt"), "C");
  writeFileSync(b.file("extra.txt"), "new");
  return cp;
}

function deadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const bomb = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error(`${what}: not settled within ${ms}ms`)), ms); });
  return Promise.race([p, bomb]).finally(() => clearTimeout(t));
}
const undo = (ctx: GitCmdCtx): Promise<void> => deadline(cmdUndo(ctx), 40_000, "cmdUndo");
const T = 60_000;

test("T1 /undo: the card names the LAST checkpoint and lists the paths; `once` restores the files to that snapshot (B, not the earlier A), removes the file created after it, leaves the transcript alone and says what it restored", async () => {
  const b = boot();
  try {
    const cp = await seed(b);
    const last = cp.list().at(-1)!;
    expect(cp.list()).toHaveLength(2);
    const before = b.rt.store.messages().length;
    await undo(b.ctx);
    expect(b.renderer.asks).toHaveLength(1);
    expect(b.renderer.asks[0]!.tool).toBe("undo");
    expect(b.renderer.asks[0]!.preview).toBe(`restore checkpoint ${last.hash.slice(0, 8)} · files only`);
    expect(b.renderer.asks[0]!.detail).toContain(`restore the workspace to checkpoint ${last.hash.slice(0, 8)} (write, `);
    expect(b.renderer.asks[0]!.detail).toContain("— 2 paths:\n  M a.txt — rewritten\n  ? extra.txt — removed (created after the checkpoint)\n\nthe conversation is untouched");
    expect(readFileSync(b.file("a.txt"), "utf8")).toBe("B");   // mutation "wrong checkpoint" (log[0]) → "A" here
    expect(existsSync(b.file("extra.txt"))).toBe(false);
    expect(b.rt.store.messages()).toHaveLength(before);         // conversation untouched
    expect(b.rt.store.messages().map((m) => (m.parts[0] as { text: string }).text)).toEqual(["first", "second"]);
    expect(b.renderer.clears).toBe(0);
    expect(b.renderer.notes).toEqual([`note:info:undo: restored 2 paths: a.txt, extra.txt to checkpoint ${last.hash.slice(0, 8)} (write, ${new Date(last.createdAt).toLocaleTimeString()}) — files only; the conversation is untouched (snapshots keep history: /checkpoints)`]);
    expect(cp.list()).toHaveLength(2);                          // a restore adds no snapshot
    // a second /undo: the workspace now sits AT the last snapshot → the pre-edit one (A) is the target (#65 fix, MED; git-cmds-fix.test.ts pins the walk)
    const first = cp.list()[0]!;
    await undo(b.ctx);
    expect(b.renderer.asks).toHaveLength(2);
    expect(b.renderer.asks[1]!.detail).toStartWith(`undo the agent's last change (checkpoint ${last.hash.slice(0, 8)}, write): restore ${first.hash.slice(0, 8)} (edit, `);
    expect(readFileSync(b.file("a.txt"), "utf8")).toBe("A");
  } finally { await b.close(); }
}, T);

test("T2 the card denied: nothing changes — a.txt keeps C, extra.txt stays, the note says cancelled", async () => {
  const b = boot({ answer: "deny" });
  try {
    await seed(b);
    await undo(b.ctx);
    expect(b.renderer.asks).toHaveLength(1);
    expect(readFileSync(b.file("a.txt"), "utf8")).toBe("C");   // mutation "restore without the card" fails here
    expect(existsSync(b.file("extra.txt"))).toBe(true);
    expect(b.renderer.notes).toEqual(["note:warn:undo cancelled — nothing changed"]);
  } finally { await b.close(); }
}, T);

test("T3 no checkpoint yet → one note, no card; T4 ROVECODE_NO_CHECKPOINTS=1 → the unavailable note; T5 busy → refused", async () => {
  const b = boot();
  try {
    writeFileSync(b.file("a.txt"), "X");
    await undo(b.ctx);
    expect(b.renderer.asks).toHaveLength(0);
    expect(b.renderer.notes).toEqual(["note:info:no checkpoint to undo to — snapshots land after each mutating tool call (edit, write, bash)"]);
    expect(readFileSync(b.file("a.txt"), "utf8")).toBe("X");
    process.env.ROVECODE_NO_CHECKPOINTS = "1";
    try { await undo(b.ctx); } finally { delete process.env.ROVECODE_NO_CHECKPOINTS; }
    expect(b.renderer.notes.at(-1)).toBe("note:warn:checkpoints unavailable (git missing or ROVECODE_NO_CHECKPOINTS=1) — nothing to undo");
  } finally { await b.close(); }
  const busy = boot({ busy: true });
  try {
    await undo(busy.ctx);
    expect(busy.renderer.log).toEqual(["note:warn:finish or interrupt the run first (Esc) — /commit and /undo run only while the agent is idle"]);
  } finally { await busy.close(); }
}, T);

test("T6 Checkpoints.changedSince: M for a rewritten tracked file, D for a deleted one, ? for a new untracked file; [] when the workspace matches; state-dir paths never listed", async () => {
  const b = boot();
  try {
    const cp = (await b.rt.checkpointsFor(b.rt.store.id))!;
    writeFileSync(b.file("a.txt"), "A"); writeFileSync(b.file("b.txt"), "B");
    const c = await cp.snapshot("edit");
    expect(await cp.changedSince(c.hash)).toEqual([]);
    writeFileSync(b.file("a.txt"), "A2"); unlinkSync(b.file("b.txt")); writeFileSync(b.file("c.txt"), "C");
    expect(await cp.changedSince(c.hash)).toEqual([{ status: "M", path: "a.txt" }, { status: "D", path: "b.txt" }, { status: "?", path: "c.txt" }]);
    expect(await cp.changedSince("0000000000000000000000000000000000000000")).toBeNull(); // git fails → null, never a throw
  } finally { await b.close(); }
}, T);

test("command table + sextant alias: /commit and /undo are TUI_COMMANDS entries (palette, /help, reserved against custom commands); ALIAS_NOTE no longer intercepts /undo", () => {
  const names = TUI_COMMANDS.map((c) => c.name);
  expect(names).toContain("commit");
  expect(names).toContain("undo");
  expect(TUI_COMMANDS.find((c) => c.name === "commit")!.description).toContain("/commit [message]");
  expect(TUI_COMMANDS.find((c) => c.name === "undo")!.description).toContain("last checkpoint");
  expect(Object.keys(ALIAS_NOTE)).toEqual(["permissions", "mode"]); // mutation "keep the /undo toast" fails here
});
