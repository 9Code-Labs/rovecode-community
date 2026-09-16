/** Port #65 — `/commit` over a REAL createRuntime, a REAL git repository in a temp dir and the REAL bash tool (the
 *  executor's direct rung), with a scripted COMMIT model. Pins the bar: the staged diff reaches the model, the drafted
 *  message is the card's detail, `once` commits it (git log shows it), a denied card commits nothing and puts the draft
 *  in the prompt, `/commit <message>` never calls the model, nothing staged → the working-tree diff with a note and
 *  `commit -a`, a clean tree → a note, a non-repo → a note, yolo asks nothing, the COMMIT role model (ROVECODE_MODEL_COMMIT)
 *  is the one asked and the default chain stands in without it, --amend/--no-verify are never emitted, and the seam pin:
 *  git-cmds.ts owns no spawn path (source grep) and every git call goes through ToolRegistry.dispatch (a spy bash tool
 *  sees them all while the real repo stays untouched). Mutations this file must catch: a git call outside the seam
 *  (grep + spy), a skipped card (T3), a model call despite a given message (T4). */

import { test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime } from "../../src/cli/runtime.ts";
import { resetExecutor } from "../../src/core/executor.ts";
import { partsText } from "../../src/core/loop.ts";
import type { ApprovalFn, Message, ModelRef, RunEvent, StreamFn, Tool } from "../../src/core/types.ts";
import { textTurn } from "../../src/providers/stream.ts";
import { cleanMessage, cmdCommit, diffFiles, gitCommand, shellQuote, type GitCmdCtx } from "../../src/tui/git-cmds.ts";
import type { ApprovalAnswer, AssistantView, Renderer, RendererHooks, StatusInfo } from "../../src/tui/renderer.ts";

// ---------- hermetic env: the runtime reads these at construction; a developer's shell must not steer the tests ----------
const KNOBS = ["MODEL_COMMIT", "MODEL_DEFAULT", "NO_CHECKPOINTS", "YOLO", "SANDBOX", "NO_HOOKS"].map((k) => `ROVECODE_${k}`);
const saved = new Map<string, string | undefined>();
beforeAll(() => { for (const k of KNOBS) { saved.set(k, process.env[k]); delete process.env[k]; } });
afterAll(() => { for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
afterEach(() => resetExecutor()); // the executor seam is module-global

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
/** a repo with one commit of a.txt; identity, no gpg, no hooks, byte-exact line endings */
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
  events: RunEvent[] = [];
  onEvent?: (ev: RunEvent) => void;
  constructor(private readonly answer: ApprovalAnswer, withEvents = false) { if (withEvents) this.onEvent = (ev) => { this.events.push(ev); }; }
  start(_h: RendererHooks): void {} stop(): void {} setCommands(): void {}
  addUser(text: string): void { this.log.push(`user:${text}`); }
  addSystemNote(text: string, tone = "info"): void { this.log.push(`note:${tone}:${text}`); }
  beginAssistant(): AssistantView { this.log.push("assistant"); return { append() {}, done() {} }; }
  toolStart(id: string, tool: string, args: string): void { this.log.push(`start:${id}:${tool}:${args}`); }
  toolUpdate(): void {}
  toolEnd(id: string, ok: boolean, preview: string): void { this.log.push(`end:${id}:${ok}:${preview}`); }
  async askApproval(tool: string, preview: string, detail?: string): Promise<ApprovalAnswer> { this.asks.push({ tool, preview, detail }); this.log.push(`ask:${tool}:${preview}`); return this.answer; }
  async askQuestion(): Promise<null> { return null; }
  async pickOne(): Promise<string | null> { return null; }
  clearTranscript(): void { this.log.push("clear"); } prefillEditor(text: string): void { this.prefills.push(text); }
  setBusy(busy: boolean, label?: string): void { this.log.push(`busy:${busy}:${label ?? ""}`); }
  setStatus(_i: StatusInfo): void {}
  get notes(): string[] { return this.log.filter((l) => l.startsWith("note:")); }
}

/** the scripted COMMIT model: records every call (model + messages) and answers with `reply` */
function scripted(reply: string | { error: string }) {
  const calls: { model: ModelRef; messages: Message[] }[] = [];
  const stream: StreamFn = async function* (model, messages) {
    calls.push({ model, messages });
    yield { type: "turn", turn: typeof reply === "string" ? textTurn(reply) : { parts: [], stopReason: "error", usage: { input: 0, output: 0 }, error: reply.error } };
  };
  return { calls, stream };
}

function boot(over: { repo?: boolean; stage?: boolean; reply?: string | { error: string }; stream?: StreamFn | null; yolo?: boolean; busy?: boolean; answer?: ApprovalAnswer; onEvent?: boolean } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "rove-p65-commit-"));
  if (over.repo !== false) initRepo(cwd);
  if (over.stage !== false && over.repo !== false) { writeFileSync(join(cwd, "a.txt"), "one\nwidget\n"); git(cwd, "add", "a.txt"); }
  const model = scripted(over.reply ?? "feat(core): add widget");
  const rt = createRuntime({ cwd, stream: over.stream === undefined ? model.stream : over.stream });
  const renderer = new SpyRenderer(over.answer ?? "once", over.onEvent ?? false);
  const flags = { busy: over.busy ?? false, busySets: [] as boolean[], aborts: [] as (AbortController | null)[] };
  const ctx: GitCmdCtx = {
    renderer, rt, store: () => rt.store, approve: () => over.yolo ? undefined : (async () => (over.answer ?? "once") as "once" | "always" | "deny"), yolo: () => over.yolo ?? false, busy: () => flags.busy,
    setBusy: (b) => { flags.busy = b; flags.busySets.push(b); }, bindAbort: (ac) => { flags.aborts.push(ac); },
  };
  const close = async (): Promise<void> => { await rt.hooks.close().catch(() => {}); try { rmSync(cwd, { recursive: true, force: true }); } catch { /* a lingering git handle on Windows: the OS temp dir is swept later */ } };
  return { cwd, rt, ctx, renderer, calls: model.calls, flags, close };
}

/** a promise that must settle within `ms` — a hung dispatch is a failure, not a stuck runner */
function deadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const bomb = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error(`${what}: not settled within ${ms}ms`)), ms); });
  return Promise.race([p, bomb]).finally(() => clearTimeout(t));
}
const commit = (ctx: GitCmdCtx, arg = ""): Promise<void> => deadline(cmdCommit(ctx, arg), 40_000, `cmdCommit(${arg})`);
const T = 60_000;

test("T1 staged diff → the COMMIT model drafts the message → the card detail shows it → `once` commits it through the bash tool; the model got the diff; no COMMIT role configured → the default chain's model", async () => {
  const b = boot();
  try {
    await commit(b.ctx);
    expect(b.calls).toHaveLength(1);
    expect(b.calls[0]!.model).toEqual(b.rt.router.resolve("default")); // no ROVECODE_MODEL_COMMIT → the default chain stands in
    expect(b.calls[0]!.model).toEqual(b.rt.router.resolve("commit"));
    expect(b.calls[0]!.messages.map((m) => m.role)).toEqual(["system", "user"]);
    expect(partsText(b.calls[0]!.messages[1]!.parts)).toContain("+widget");
    expect(b.renderer.asks).toHaveLength(1);
    expect(b.renderer.asks[0]!.tool).toBe("bash");
    expect(b.renderer.asks[0]!.preview).toBe(JSON.stringify({ command: "git commit -m 'feat(core): add widget'" }));
    const m = b.rt.router.resolve("commit");
    expect(b.renderer.asks[0]!.detail).toContain(`commit message (drafted by ${m.provider}/${m.model} — deny to edit it in the prompt):\n  feat(core): add widget`);
    expect(b.renderer.asks[0]!.detail).toContain("scope: the staged changes");
    expect(b.renderer.asks[0]!.detail).toContain("files (1): a.txt");
    expect(lastMessage(b.cwd)).toBe("feat(core): add widget"); // git log -1 shows it
    expect(commits(b.cwd)).toBe(2);
    expect(b.renderer.notes.at(-1)).toMatch(/^note:info:committed \[\S+ [0-9a-f]+\] feat\(core\): add widget · message by /);
    expect(b.renderer.log.at(-1)).toBe("busy:false:done");
    expect(b.flags.busySets).toEqual([true, false]);
    expect(b.flags.aborts.at(-1)).toBeNull();
    expect(b.renderer.log.filter((l) => l.startsWith("start:")).map((l) => l.split(":").slice(3).join(":"))).toEqual([JSON.stringify({ command: "git diff --cached" }), JSON.stringify({ command: "git commit -m 'feat(core): add widget'" })]); // the diff went through the seam too
  } finally { await b.close(); }
}, T);

test("T2 ROVECODE_MODEL_COMMIT names the COMMIT role's model — that is the ModelRef the draft is asked from", async () => {
  process.env.ROVECODE_MODEL_COMMIT = "mock/commit-model";
  let b: ReturnType<typeof boot> | null = null;
  try {
    b = boot();
    await commit(b.ctx);
    expect(b.calls.map((c) => c.model)).toEqual([{ provider: "mock", model: "commit-model" }]);
    expect(b.renderer.asks[0]!.detail).toContain("drafted by mock/commit-model");
    expect(lastMessage(b.cwd)).toBe("feat(core): add widget");
  } finally { delete process.env.ROVECODE_MODEL_COMMIT; await b?.close(); }
}, T);

test("T3 the card denied: nothing is committed, the draft lands in the prompt as `/commit <message>` for editing, the note says so", async () => {
  const b = boot({ answer: "deny" });
  try {
    await commit(b.ctx);
    expect(b.calls).toHaveLength(1);
    expect(b.renderer.asks).toHaveLength(1);
    expect(commits(b.cwd)).toBe(1);                       // mutation "skip the card / commit anyway" fails here
    expect(lastMessage(b.cwd)).toBe("init");
    expect(git(b.cwd, "diff", "--cached", "--name-only")).toBe("a.txt"); // the index is untouched
    expect(b.renderer.prefills).toEqual(["/commit feat(core): add widget"]);
    expect(b.renderer.notes).toEqual(["note:warn:commit was denied at the approval card — nothing committed", "note:info:the message is in the prompt — edit it and press Enter to commit"]);
    expect(b.renderer.log.at(-1)).toBe("busy:false:error");
  } finally { await b.close(); }
}, T);

test("T4 `/commit <message>` skips the draft: zero stream calls; the message (with a body, newlines intact) is what git records", async () => {
  const b = boot();
  try {
    await commit(b.ctx, "  fix(tui): it's the widget\n\nsecond paragraph  ");
    expect(b.calls).toHaveLength(0);                      // mutation "always ask the model" fails here
    expect(lastMessage(b.cwd)).toBe("fix(tui): it's the widget\n\nsecond paragraph");
    expect(b.renderer.asks[0]!.preview).toBe(JSON.stringify({ command: "git commit -m 'fix(tui): it'\\''s the widget\n\nsecond paragraph'" }).slice(0, 140));
    expect(b.renderer.asks[0]!.detail).toStartWith("commit message:\n  fix(tui): it's the widget\n  \n  second paragraph\n");
  } finally { await b.close(); }
}, T);

test("T5 nothing staged, a tracked file modified: a note, the working-tree diff drafts the message, `git commit -a -m` commits it", async () => {
  const b = boot({ stage: false });
  try {
    writeFileSync(join(b.cwd, "a.txt"), "one\nwidget\n");
    await commit(b.ctx);
    expect(b.renderer.notes[0]).toBe("note:info:nothing staged — committing the working-tree changes to tracked files instead (`git commit -a`)");
    expect(b.renderer.asks[0]!.preview).toBe(JSON.stringify({ command: "git commit -a -m 'feat(core): add widget'" }));
    expect(b.renderer.asks[0]!.detail).toContain("scope: working-tree changes to tracked files (git commit -a)");
    expect(lastMessage(b.cwd)).toBe("feat(core): add widget");
    expect(git(b.cwd, "status", "--porcelain", "a.txt")).toBe("");
  } finally { await b.close(); }
}, T);

test("T6 a clean tree: one note, no model call, no card; T7 not a git repository: an error note naming the cwd, no model call", async () => {
  const b = boot({ stage: false });
  try {
    await commit(b.ctx);
    expect(b.calls).toHaveLength(0);
    expect(b.renderer.asks).toHaveLength(0);
    expect(b.renderer.notes).toEqual(["note:info:nothing to commit — the index and the tracked working tree are clean (untracked files need `git add` first)"]);
    expect(b.renderer.log.at(-1)).toBe("busy:false:done");
  } finally { await b.close(); }
  const n = boot({ repo: false });
  try {
    await commit(n.ctx);
    expect(n.calls).toHaveLength(0);
    expect(n.renderer.asks).toHaveLength(0);
    expect(n.renderer.notes).toHaveLength(1);
    // outside a repository git diff degrades to --no-index usage (129) or says "not a git repository" (128) — either way the note names the cwd
    expect(n.renderer.notes[0]).toMatch(/^note:error:git diff failed \(exit 12[89]\): \S.* — .* is not inside a git repository$/);
    expect(n.renderer.notes[0]).not.toContain("stderr:"); // the executor's label is never the "error line"
    expect(n.renderer.notes[0]).toContain(n.cwd);
  } finally { await n.close(); }
}, T);

test("T8 busy app: refused with a note, nothing runs; T9 yolo: no card, the commit runs; T12 a model error / no provider → an error note, nothing committed", async () => {
  const busy = boot({ busy: true });
  try {
    await commit(busy.ctx);
    expect(busy.renderer.log).toEqual(["note:warn:finish or interrupt the run first (Esc) — /commit and /undo run only while the agent is idle"]);
    expect(busy.calls).toHaveLength(0);
    expect(commits(busy.cwd)).toBe(1);
  } finally { await busy.close(); }
  const y = boot({ yolo: true });
  try {
    await commit(y.ctx);
    expect(y.renderer.asks).toHaveLength(0);
    expect(lastMessage(y.cwd)).toBe("feat(core): add widget");
  } finally { await y.close(); }
  const e = boot({ reply: { error: "HTTP 500: boom" } });
  try {
    await commit(e.ctx);
    expect(e.renderer.asks).toHaveLength(0);
    expect(commits(e.cwd)).toBe(1);
    expect(e.renderer.notes).toEqual(["note:error:commit model failed: HTTP 500: boom — pass the message yourself: /commit <message>"]);
  } finally { await e.close(); }
  const p = boot({ stream: null });
  try {
    await commit(p.ctx);
    expect(commits(p.cwd)).toBe(1);
    expect(p.renderer.notes).toEqual(["note:error:no provider configured — nothing can draft a message — pass the message yourself: /commit <message>"]);
  } finally { await p.close(); }
}, T);

// ---------- the seam pin ----------

const SRC = join(import.meta.dir, "..", "..", "src", "tui");
const stripComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

test("T10 grep pin: git-cmds.ts / git-plain.ts own no spawn path (no child_process, Bun.spawn, exec*, getExecutor) and never spell --amend / --no-verify in code", () => {
  for (const f of ["git-cmds.ts", "git-plain.ts"]) {
    const code = stripComments(readFileSync(join(SRC, f), "utf8"));
    expect(code).not.toMatch(/child_process|Bun\.spawn|execFile|spawnSync|execSync|getExecutor|\bspawn\(/);
    expect(code).not.toMatch(/--amend|--no-verify/);
  }
  expect(stripComments(readFileSync(join(SRC, "git-cmds.ts"), "utf8"))).toContain("registry.dispatch("); // the ONE way git runs
});

/** the spy bash tool: records every command, spawns nothing, answers like git would */
function spyBash(executed: string[]): Tool {
  return {
    schema: { name: "bash", description: "spy", args: { type: "object", properties: { command: { type: "string" } } } },
    kind: "execute",
    async execute(args) {
      const c = String((args as { command: string }).command);
      executed.push(c);
      if (c === "git diff --cached") return { ok: true, output: "exit=0\ndiff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1,2 @@\n one\n+widget\n" };
      return { ok: true, output: `exit=0\n[main 1234567] spy\n` };
    },
  };
}

test("T11 spy pin: with the registry's bash tool replaced, EVERY git call /commit makes reaches the spy and the real repository is never touched — a git call outside ToolRegistry.dispatch would commit for real here", async () => {
  const b = boot({ onEvent: true });
  try {
    const executed: string[] = [];
    b.rt.registry.register(spyBash(executed));
    await commit(b.ctx);
    expect(executed).toEqual(["git diff --cached", "git commit -m 'feat(core): add widget'"]);
    expect(commits(b.cwd)).toBe(1);                       // the spy ran nothing: still the init commit
    expect(git(b.cwd, "diff", "--cached", "--name-only")).toBe("a.txt");
    expect(b.renderer.events.map((e) => e.type)).toEqual(["tool_execution_start", "tool_execution_end", "tool_execution_start", "tool_execution_end"]); // a renderer with onEvent sees the seam's events first
    expect(b.renderer.notes.at(-1)).toBe(`note:info:committed [main 1234567] spy · message by ${b.rt.router.resolve("commit").provider}/${b.rt.router.resolve("commit").model}`);
  } finally { await b.close(); }
}, T);

// ---------- pure helpers ----------

test("shellQuote / gitCommand: safe words pass bare, everything else is single-quoted with the POSIX quote escape; cleanMessage strips fences, quotes and labels; diffFiles reads the headers", () => {
  expect(shellQuote("feat")).toBe("feat");
  expect(shellQuote("a/b.c-d_e:f=g@h%i+j,k")).toBe("a/b.c-d_e:f=g@h%i+j,k");
  expect(shellQuote("feat: x")).toBe("'feat: x'");
  expect(shellQuote("it's")).toBe("'it'\\''s'");
  expect(shellQuote("a\nb")).toBe("'a\nb'");
  expect(shellQuote("")).toBe("''");
  expect(gitCommand(["commit", "-m", "feat(core): add widget"])).toBe("git commit -m 'feat(core): add widget'");
  expect(gitCommand(["diff", "--cached"])).toBe("git diff --cached");
  expect(cleanMessage("```\nfeat: x\n\nbody\n```")).toBe("feat: x\n\nbody");
  expect(cleanMessage("```text\nfeat: x```")).toBe("feat: x");
  expect(cleanMessage('"feat: x"')).toBe("feat: x");
  expect(cleanMessage("Commit message: fix: y\r\n\r\n\r\n\r\nbody  ")).toBe("fix: y\n\nbody");
  expect(cleanMessage("   ")).toBe("");
  expect(diffFiles("diff --git a/a.txt b/a.txt\n+x\ndiff --git a/src/y.ts b/src/y.ts\n")).toEqual(["a.txt", "src/y.ts"]);
  expect(diffFiles("")).toEqual([]);
});
