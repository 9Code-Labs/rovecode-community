/** Port #65 — `/commit` and `/undo` in `nimbus --plain` (tui/git-plain.ts): the console adapter runs the SAME
 *  cmdCommit / cmdUndo over a real createRuntime — the approval card becomes the REPL's y/n question, notes and tool
 *  card lines become console lines, a denied draft is printed for resubmission. /commit runs against a spy bash tool
 *  (every git call still goes through ToolRegistry.dispatch; nothing is spawned); /undo against real checkpoints. */

import { test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime } from "../../src/cli/runtime.ts";
import { resetExecutor } from "../../src/core/executor.ts";
import type { StreamFn, Tool } from "../../src/core/types.ts";
import { textTurn } from "../../src/providers/stream.ts";
import { runPlainGitCommand } from "../../src/tui/git-plain.ts";

const KNOBS = ["MODEL_COMMIT", "NO_CHECKPOINTS", "YOLO", "SANDBOX", "NO_HOOKS"].map((k) => `ROVECODE_${k}`);
const saved = new Map<string, string | undefined>();
beforeAll(() => { for (const k of KNOBS) { saved.set(k, process.env[k]); delete process.env[k]; } });
afterAll(() => { for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
afterEach(() => resetExecutor());

function spyBash(executed: string[]): Tool {
  return {
    schema: { name: "bash", description: "spy", args: { type: "object", properties: { command: { type: "string" } } } },
    kind: "execute",
    async execute(args) {
      const c = String((args as { command: string }).command);
      executed.push(c);
      if (c === "git diff --cached") return { ok: true, output: "exit=0\ndiff --git a/a.txt b/a.txt\n+widget\n" };
      return { ok: true, output: "exit=0\n[main 1234567] spy\n" };
    },
  };
}

function deadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const bomb = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error(`${what}: not settled within ${ms}ms`)), ms); });
  return Promise.race([p, bomb]).finally(() => clearTimeout(t));
}

function boot(stream: StreamFn | null) {
  const cwd = mkdtempSync(join(tmpdir(), "rove-p65-plain-"));
  const rt = createRuntime({ cwd, stream });
  const out: string[] = [];
  const questions: string[] = [];
  const run = (text: string, answer: string, yolo = false): Promise<void> =>
    deadline(runPlainGitCommand({ rt, yolo, approve: answer === "y" || answer === "yes" ? async () => "once" : async () => "deny", ask: async (q) => { questions.push(q); return answer; }, out: (l) => out.push(l) }, text), 40_000, `plain ${text}`);
  const close = async (): Promise<void> => { await rt.hooks.close().catch(() => {}); try { rmSync(cwd, { recursive: true, force: true }); } catch { /* lingering git handle on Windows */ } };
  return { cwd, rt, out, questions, run, close };
}

test("--plain /commit <message>: the approval question shows the command and the message; `y` commits through the spy'd bash dispatch; `n` commits nothing and prints the resubmit line; a bare /commit with no provider prints the error", async () => {
  const b = boot(null);
  try {
    const executed: string[] = [];
    b.rt.registry.register(spyBash(executed));
    await b.run("/commit feat: x", "y");
    expect(executed).toEqual(["git diff --cached", "git commit -m 'feat: x'"]);
    expect(b.questions).toEqual(["  allow? [y]es / [n]o: "]);
    expect(b.out).toContain(`\n  approval needed: bash ${JSON.stringify({ command: "git commit -m 'feat: x'" })}`);
    expect(b.out).toContain("    commit message:");
    expect(b.out).toContain("      feat: x");
    expect(b.out.at(-1)).toBe("  committed [main 1234567] spy");
    expect(b.out.filter((l) => l.startsWith("\n  → bash"))).toHaveLength(2); // the tool card lines, like a run's
    b.out.length = 0; executed.length = 0;
    await b.run("/commit feat: y", "n");
    expect(executed).toEqual(["git diff --cached"]);        // the commit never ran
    expect(b.out).toContain("  warn: commit was denied at the approval card — nothing committed");
    expect(b.out).toContain("  resubmit with: /commit feat: y");
    b.out.length = 0;
    await b.run("/commit", "y");
    expect(b.out).toContain("  error: no provider configured — nothing can draft a message — pass the message yourself: /commit <message>");
  } finally { await b.close(); }
}, 60_000);

test("--plain /commit drafts through the COMMIT model like the TUI: the draft is in the question's detail and `y` commits it", async () => {
  const calls: string[] = [];
  const stream: StreamFn = async function* (model) { calls.push(model.model); yield { type: "turn", turn: textTurn("chore: tidy") }; };
  const b = boot(stream);
  try {
    const executed: string[] = [];
    b.rt.registry.register(spyBash(executed));
    await b.run("/commit", "y");
    expect(calls).toHaveLength(1);
    expect(executed).toEqual(["git diff --cached", "git commit -m 'chore: tidy'"]);
    expect(b.out.some((l) => l.startsWith("    commit message (drafted by ") && l.endsWith(" — deny to edit it in the prompt):"))).toBe(true);
    expect(b.out).toContain("      chore: tidy");
  } finally { await b.close(); }
}, 60_000);

test("--plain /undo: no checkpoint → the note; after snapshots the question names the checkpoint, `n` changes nothing, `y` restores the last snapshot's files", async () => {
  const b = boot(null);
  try {
    await b.run("/undo", "y");
    expect(b.out).toEqual(["  no checkpoint to undo to — snapshots land after each mutating tool call (edit, write, bash)"]);
    const cp = (await b.rt.checkpointsFor(b.rt.store.id))!;
    writeFileSync(join(b.cwd, "a.txt"), "A"); await cp.snapshot("edit");
    writeFileSync(join(b.cwd, "a.txt"), "B"); await cp.snapshot("write");
    writeFileSync(join(b.cwd, "a.txt"), "C");
    b.out.length = 0;
    await b.run("/undo", "n");
    expect(readFileSync(join(b.cwd, "a.txt"), "utf8")).toBe("C");
    expect(b.out[0]).toBe(`\n  approval needed: undo restore checkpoint ${cp.list().at(-1)!.hash.slice(0, 8)} · files only`);
    expect(b.out).toContain("      M a.txt — rewritten");
    expect(b.out.at(-1)).toBe("  warn: undo cancelled — nothing changed");
    b.out.length = 0;
    await b.run("/undo", "y");
    expect(readFileSync(join(b.cwd, "a.txt"), "utf8")).toBe("B");
    expect(b.out.at(-1)).toMatch(/^ {2}undo: restored 1 path: a\.txt to checkpoint [0-9a-f]{8} \(write, .*\) — files only; the conversation is untouched/);
    expect(b.questions).toEqual(["  allow? [y]es / [n]o: ", "  allow? [y]es / [n]o: "]);
  } finally { await b.close(); }
}, 60_000);

test("--plain: anything but /commit … or /undo is ignored by the adapter (the REPL routes only those two lines here)", async () => {
  const b = boot(null);
  try {
    await b.run("/committed", "y");
    await b.run("/undo now", "y");
    expect(b.out).toEqual([]);
    expect(b.questions).toEqual([]);
  } finally { await b.close(); }
}, 20_000);
