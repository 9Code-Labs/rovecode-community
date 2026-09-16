/** Port #65 fix (critic GAPS: 1 MED + 3 LOW) — the corrected behaviour at the real surfaces (real createRuntime, real
 *  shadow-git checkpoints, a real git repository + the real bash tool where /commit runs):
 *  MED  /undo right after the agent's own edit. Snapshots land AFTER a mutating tool call, so the last one IS the edit;
 *       /undo now steps back to the pre-edit snapshot (Checkpoints.position → the nearest differing ancestor), twice in
 *       a row one more, then says nothing older differs. A drifted workspace still goes back to the last snapshot
 *       first. The transcript is never touched.
 *  LOW  `/commit --amend` / `/commit --no-verify`: a dash-led message is refused before any git call — no junk commit.
 *  LOW  the card's `files (N)` list: three staged files, one ~30 KB → the diff fills the bash tool's 10k output cap;
 *       the list comes from `git diff --cached --name-only` (3 files, not the 2 the capped text names) and the card and
 *       the model are both told the diff was cut. A small diff makes no extra call and carries no such note.
 *  Mutations this file must catch: target = last always (T1 → the "nothing to undo" note instead of A), target =
 *  list.at(-2) always (T3 drift → A instead of B), the dash guard removed (T4 → a commit whose message is "--amend"),
 *  the name-only branch removed (T5 → files (2)), the cap note dropped (T5). */

import { test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime } from "../../src/cli/runtime.ts";
import type { Checkpoints } from "../../src/coding/checkpoints.ts";
import { resetExecutor } from "../../src/core/executor.ts";
import { partsText } from "../../src/core/loop.ts";
import type { Message, ModelRef, StreamFn, ToolCallPart, ToolContext } from "../../src/core/types.ts";
import { textTurn } from "../../src/providers/stream.ts";
import { cmdCommit, cmdUndo, type GitCmdCtx } from "../../src/tui/git-cmds.ts";
import type { ApprovalAnswer, AssistantView, Renderer, RendererHooks, StatusInfo } from "../../src/tui/renderer.ts";
import type { ApprovalFn } from "../../src/core/types.ts";

const KNOBS = ["MODEL_COMMIT", "MODEL_DEFAULT", "NO_CHECKPOINTS", "YOLO", "SANDBOX", "NO_HOOKS"].map((k) => `ROVECODE_${k}`);
const saved = new Map<string, string | undefined>();
beforeAll(() => { for (const k of KNOBS) { saved.set(k, process.env[k]); delete process.env[k]; } });
afterAll(() => { for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
afterEach(() => resetExecutor());

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function initRepo(dir: string): void {
  git(dir, "init", "-q");
  mkdirSync(join(dir, ".nohooks"));
  for (const [k, v] of [["user.name", "t"], ["user.email", "t@t"], ["commit.gpgsign", "false"], ["core.autocrlf", "false"], ["core.hooksPath", join(dir, ".nohooks")]]) git(dir, "config", k!, v!);
  writeFileSync(join(dir, "a.txt"), "one\n");
  git(dir, "add", "a.txt");
  git(dir, "commit", "-q", "-m", "init");
}
const lastMessage = (dir: string): string => git(dir, "log", "-1", "--pretty=%B");
const commits = (dir: string): number => Number(git(dir, "rev-list", "--count", "HEAD"));

class SpyRenderer implements Renderer {
  log: string[] = [];
  asks: { tool: string; preview: string; detail?: string }[] = [];
  prefills: string[] = [];
  clears = 0;
  constructor(private readonly answer: ApprovalAnswer) {}
  start(_h: RendererHooks): void {} stop(): void {} setCommands(): void {}
  addUser(text: string): void { this.log.push(`user:${text}`); }
  addSystemNote(text: string, tone = "info"): void { this.log.push(`note:${tone}:${text}`); }
  beginAssistant(): AssistantView { return { append() {}, done() {} }; }
  toolStart(id: string, tool: string, args: string): void { this.log.push(`start:${id}:${tool}:${args}`); }
  toolUpdate(): void {}
  toolEnd(id: string, ok: boolean): void { this.log.push(`end:${id}:${ok}`); }
  async askApproval(tool: string, preview: string, detail?: string): Promise<ApprovalAnswer> { this.asks.push({ tool, preview, detail }); return this.answer; }
  async askQuestion(): Promise<null> { return null; }
  async pickOne(): Promise<string | null> { return null; }
  clearTranscript(): void { this.clears++; } prefillEditor(text: string): void { this.prefills.push(text); }
  setBusy(busy: boolean, label?: string): void { this.log.push(`busy:${busy}:${label ?? ""}`); }
  setStatus(_i: StatusInfo): void {}
  get notes(): string[] { return this.log.filter((l) => l.startsWith("note:")); }
  /** the bash commands the seam ran, in order */
  get commands(): string[] { return this.log.filter((l) => l.startsWith("start:")).map((l) => (JSON.parse(l.split(":").slice(3).join(":")) as { command: string }).command); }
}

function scripted(reply: string) {
  const calls: { model: ModelRef; messages: Message[] }[] = [];
  const stream: StreamFn = async function* (model, messages) { calls.push({ model, messages }); yield { type: "turn", turn: textTurn(reply) }; };
  return { calls, stream };
}

function boot(over: { repo?: boolean; answer?: ApprovalAnswer; stream?: StreamFn | null } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "rove-p65-fix-"));
  if (over.repo) initRepo(cwd);
  const model = scripted("feat(core): drafted");
  const rt = createRuntime({ cwd, stream: over.stream === undefined ? model.stream : over.stream });
  const renderer = new SpyRenderer(over.answer ?? "once");
  const ctx: GitCmdCtx = { renderer, rt, store: () => rt.store, approve: (): ApprovalFn => async () => over.answer === "deny" ? "deny" : over.answer === "always" ? "always" : "once", yolo: () => false, busy: () => false, setBusy() {}, bindAbort() {} };
  const file = (name: string): string => join(cwd, name);
  const close = async (): Promise<void> => { await rt.hooks.close().catch(() => {}); try { rmSync(cwd, { recursive: true, force: true }); } catch { /* lingering git handle on Windows */ } };
  return { cwd, rt, ctx, renderer, calls: model.calls, file, close };
}

function deadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const bomb = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error(`${what}: not settled within ${ms}ms`)), ms); });
  return Promise.race([p, bomb]).finally(() => clearTimeout(t));
}
const undo = (ctx: GitCmdCtx): Promise<void> => deadline(cmdUndo(ctx), 40_000, "cmdUndo");
const commit = (ctx: GitCmdCtx, arg = ""): Promise<void> => deadline(cmdCommit(ctx, arg), 40_000, `cmdCommit(${arg})`);
const T = 90_000;
const short = (h: string): string => h.slice(0, 8);
const umsg = (text: string, parentId: string | null): Message => ({ id: randomUUID(), role: "user", parts: [{ kind: "text", text }], parentId, createdAt: Date.now() });

/** the AGENT's write: the registered `write` tool through ToolRegistry.dispatch — the #11 wrapper snapshots AFTER it */
async function agentWrites(b: ReturnType<typeof boot>, path: string, content: string): Promise<void> {
  const call: ToolCallPart = { kind: "tool_call", id: `w-${randomUUID().slice(0, 8)}`, tool: "write", args: { path, content } };
  const cfg = b.rt.buildCfg(true);
  const toolCtx: ToolContext = { sessionId: b.rt.store.id, cwd: b.cwd, signal: new AbortController().signal, permissions: { effect: "allow" } };
  const out = await deadline(b.rt.registry.dispatch(call, toolCtx, b.rt.hooks, cfg.permissionRules, cfg.approval, () => {}, undefined), 30_000, `write ${path}`);
  expect(out.ok).toBe(true);
}

test("T1 MED: the agent writes a.txt=A then edits it to B through the REAL write tool (two snapshots land after the calls); /undo restores the PRE-EDIT content A — the card says it undoes the agent's last change — and leaves the transcript alone; a second /undo finds nothing older", async () => {
  const b = boot();
  try {
    await agentWrites(b, "a.txt", "A");
    await agentWrites(b, "a.txt", "B");
    const cp = (await b.rt.checkpointsFor(b.rt.store.id)) as Checkpoints;
    expect(cp.list().map((c) => c.label)).toEqual(["write", "write"]);
    const [pre, post] = cp.list();
    const m1 = umsg("first", null); b.rt.store.append(m1); b.rt.store.append(umsg("second", m1.id));
    expect(readFileSync(b.file("a.txt"), "utf8")).toBe("B");
    await undo(b.ctx);
    expect(b.renderer.asks).toHaveLength(1);
    expect(b.renderer.asks[0]!.tool).toBe("undo");
    expect(b.renderer.asks[0]!.preview).toBe(`restore checkpoint ${short(pre!.hash)} · files only`);
    expect(b.renderer.asks[0]!.detail).toStartWith(`undo the agent's last change (checkpoint ${short(post!.hash)}, write): restore ${short(pre!.hash)} (write, `);
    expect(b.renderer.asks[0]!.detail).toContain(" — 1 path:\n  M a.txt — rewritten\n\nthe conversation is untouched");
    expect(readFileSync(b.file("a.txt"), "utf8")).toBe("A");             // mutation "target = last" → the no-op note and B
    expect(b.rt.store.messages().map((m) => partsText(m.parts))).toEqual(["first", "second"]);
    expect(b.renderer.clears).toBe(0);
    expect(b.renderer.notes.at(-1)).toBe(`note:info:undo: restored 1 path: a.txt to checkpoint ${short(pre!.hash)} (write, ${new Date(pre!.createdAt).toLocaleTimeString()}) — files only; the conversation is untouched (snapshots keep history: /checkpoints)`);
    expect(cp.list()).toHaveLength(2);                                      // a restore adds no snapshot
    // twice in a row: the workspace now sits at the oldest snapshot → a note, no card, nothing changes
    await undo(b.ctx);
    expect(b.renderer.asks).toHaveLength(1);
    expect(b.renderer.notes.at(-1)).toBe(`note:info:nothing to undo — the workspace matches checkpoint ${short(pre!.hash)} (write, ${new Date(pre!.createdAt).toLocaleTimeString()}) and no older snapshot differs from it (/checkpoints lists them; /restore <ref> reaches any)`);
    expect(readFileSync(b.file("a.txt"), "utf8")).toBe("A");
  } finally { await b.close(); }
}, T);

test("T2 three edits and a no-op re-snapshot (a bash call that changed nothing): /undo walks 2 → 1 → 0, stepping over the unchanged snapshot, then reports nothing older; every card names where the workspace sits", async () => {
  const b = boot();
  try {
    const cp = (await b.rt.checkpointsFor(b.rt.store.id))!;
    writeFileSync(b.file("a.txt"), "0"); const s0 = await cp.snapshot("write");
    writeFileSync(b.file("a.txt"), "1"); const s1 = await cp.snapshot("edit");
    writeFileSync(b.file("a.txt"), "2"); const s2 = await cp.snapshot("edit");
    const s3 = await cp.snapshot("bash");                                    // same tree as s2
    await undo(b.ctx);
    expect(readFileSync(b.file("a.txt"), "utf8")).toBe("1");
    expect(b.renderer.asks[0]!.detail).toStartWith(`undo the agent's last change (checkpoint ${short(s3.hash)}, bash): restore ${short(s1.hash)} (edit, `);
    await undo(b.ctx);
    expect(readFileSync(b.file("a.txt"), "utf8")).toBe("0");
    expect(b.renderer.asks[1]!.detail).toStartWith(`undo the agent's last change (checkpoint ${short(s1.hash)}, edit): restore ${short(s0.hash)} (write, `);
    await undo(b.ctx);
    expect(b.renderer.asks).toHaveLength(2);
    expect(b.renderer.notes.at(-1)).toContain(`nothing to undo — the workspace matches checkpoint ${short(s0.hash)} (write, `);
    expect(readFileSync(b.file("a.txt"), "utf8")).toBe("0");
    expect(cp.list().map((c) => c.hash)).toEqual([s0.hash, s1.hash, s2.hash, s3.hash]);
  } finally { await b.close(); }
}, T);

test("T3 a DRIFTED workspace (edited by hand after the last snapshot) still goes back to the LAST snapshot first — the plain `restore the workspace to checkpoint` card — and only the next /undo walks to the pre-edit one", async () => {
  const b = boot();
  try {
    const cp = (await b.rt.checkpointsFor(b.rt.store.id))!;
    writeFileSync(b.file("a.txt"), "A"); const s1 = await cp.snapshot("write");
    writeFileSync(b.file("a.txt"), "B"); const s2 = await cp.snapshot("edit");
    writeFileSync(b.file("a.txt"), "C");
    await undo(b.ctx);
    expect(b.renderer.asks[0]!.detail).toStartWith(`restore the workspace to checkpoint ${short(s2.hash)} (edit, `);
    expect(b.renderer.asks[0]!.detail).not.toContain("agent's last change");
    expect(readFileSync(b.file("a.txt"), "utf8")).toBe("B");             // mutation "always list.at(-2)" → A here
    await undo(b.ctx);
    expect(b.renderer.asks[1]!.detail).toStartWith(`undo the agent's last change (checkpoint ${short(s2.hash)}, edit): restore ${short(s1.hash)} (write, `);
    expect(readFileSync(b.file("a.txt"), "utf8")).toBe("A");
  } finally { await b.close(); }
}, T);

test("T4 LOW: `/commit --amend` and `/commit --no-verify` are refused with a note before ANY git call — no card, no model call, no commit; a dash INSIDE a message is fine", async () => {
  const b = boot({ repo: true });
  try {
    writeFileSync(b.file("a.txt"), "one\nwidget\n"); git(b.cwd, "add", "a.txt");
    for (const bad of ["--amend", "--no-verify", "-m evil", "--amend\n\nbody"]) {
      await commit(b.ctx, bad);
      expect(b.renderer.notes.at(-1)).toBe("note:warn:a commit message cannot start with -; quote it or begin with a word — git would read a dash-led message as a flag, so nothing was committed");
    }
    expect(b.renderer.commands).toEqual([]);                                // mutation "guard removed" → git diff + git commit -m --amend ran
    expect(b.renderer.asks).toHaveLength(0);
    expect(b.calls).toHaveLength(0);
    expect(b.renderer.log.filter((l) => l.startsWith("busy:"))).toEqual([]); // refused before the busy state
    expect(commits(b.cwd)).toBe(1);
    expect(lastMessage(b.cwd)).toBe("init");
    expect(git(b.cwd, "diff", "--cached", "--name-only")).toBe("a.txt");   // the index is untouched
    await commit(b.ctx, "feat: keep --verbose");
    expect(lastMessage(b.cwd)).toBe("feat: keep --verbose");
    expect(b.renderer.commands).toEqual(["git diff --cached", "git commit -m 'feat: keep --verbose'"]);
  } finally { await b.close(); }
}, T);

const BIG = Array.from({ length: 600 }, (_, i) => `line ${String(i).padStart(4, "0")} ${"x".repeat(44)}`).join("\n") + "\n"; // ~30 KB

test("T5 LOW: three staged files, one ~30 KB → the diff hits the 10k cap: the card lists all 3 files from `git diff --cached --name-only` (the capped text names 2), says the diff was truncated, the model is told too; a small diff makes no extra call and no note", async () => {
  const b = boot({ repo: true });
  try {
    writeFileSync(b.file("a.txt"), "one\nwidget\n"); writeFileSync(b.file("big.txt"), BIG); writeFileSync(b.file("c.txt"), "c\n");
    git(b.cwd, "add", "a.txt", "big.txt", "c.txt");
    expect(git(b.cwd, "diff", "--cached").length).toBeGreaterThan(30_000);
    await commit(b.ctx);                                                    // drafted: the model sees the capped diff + the note
    expect(b.calls).toHaveLength(1);
    const seen = partsText(b.calls[0]!.messages[1]!.parts);
    expect(seen.length).toBeLessThan(10_200);
    expect(seen).toEndWith("… (diff truncated at the 10k output cap for the model)");
    expect(b.renderer.asks).toHaveLength(1);
    expect(b.renderer.asks[0]!.detail).toContain("files (3): a.txt, big.txt, c.txt"); // mutation "diffFiles only" → files (2): a.txt, big.txt
    expect(b.renderer.asks[0]!.detail).toContain("\n(diff truncated at the 10k output cap for the model)");
    expect(b.renderer.commands).toEqual(["git diff --cached", "git diff --cached --name-only", "git commit -m 'feat(core): drafted'"]);
    expect(lastMessage(b.cwd)).toBe("feat(core): drafted");
    expect(commits(b.cwd)).toBe(2);
    expect(git(b.cwd, "show", "--pretty=", "--name-only", "HEAD").split("\n").sort()).toEqual(["a.txt", "big.txt", "c.txt"]);
  } finally { await b.close(); }
  const s = boot({ repo: true });
  try {
    writeFileSync(s.file("a.txt"), "one\nwidget\n"); git(s.cwd, "add", "a.txt");
    await commit(s.ctx, "fix: small");
    expect(s.renderer.commands).toEqual(["git diff --cached", "git commit -m 'fix: small'"]); // no name-only call for a complete diff
    expect(s.renderer.asks[0]!.detail).toContain("files (1): a.txt");
    expect(s.renderer.asks[0]!.detail).not.toContain("truncated");
    expect(lastMessage(s.cwd)).toBe("fix: small");
  } finally { await s.close(); }
}, T);
