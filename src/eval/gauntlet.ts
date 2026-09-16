/** Gauntlet evaluation suite (ADR-011): task specs + runner.
 *  Categories per objective §11-12: basic, coding, complex, failure, adversarial.
 *
 *  One run = ONE scratch root (gauntlet-support.ts createGauntletRoot) that every task workspace and
 *  runner session dir lives under; the root is removed when the run ends. Nothing outside the root is
 *  ever listed, counted or deleted, so two runs overlapping on one machine cannot sweep each other's
 *  workspaces — the previous leak check scanned the whole OS temp dir for `rovecode-g*`, which is
 *  shared ground. A `setup` that returns a path outside the root is a task bug, named with its id.
 *
 *  Wave 3/4 tasks (gauntlet-wave3.ts / gauntlet-wave4.ts) drive the REAL runtime — bootRuntime, an
 *  agent loop, or the actual CLI as a subprocess — instead of the scripted-provider runner, so they
 *  carry their own `run`; runGauntlet dispatches to it when present. */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { createGauntletRoot, removeGauntletRoot, rootEntries } from "./gauntlet-support.ts";
import { randomUUID } from "node:crypto";
import type { Tool, ToolContext, StreamFn, ModelRef, StreamEvent } from "../core/types.ts";
import { GUARDRAIL_DEFAULTS } from "../core/guardrails.ts";

export interface GauntletTask {
  id: string;
  category: "basic" | "coding" | "complex" | "failure" | "adversarial";
  prompt: string;
  /** Workspace fixture builder — returns an absolute dir it created UNDER `root` (the run's scratch
   *  root, gauntlet-support.ts; keep the `rovecode-g-` prefix).
   *
   *  `root` is optional only so a test can call one task's setup directly (guard-wiring.test.ts drives
   *  a single task twice, guarded and not, to prove the task discriminates); runGauntlet always passes
   *  it, and the check that a workspace really is under the root lives THERE, not in this type — a
   *  setup that ignores the argument fails loudly with its task id rather than quietly writing to the
   *  shared OS temp dir. */
  setup?: (root?: string) => string;
  /** objective pass check on the resulting workspace + transcript */
  verify: (workspace: string, transcript: GauntletTranscript) => boolean | Promise<boolean>;
  /** failure/adversarial tasks inject these tools/stream behaviors */
  inject?: { tools?: Tool[] };
  /** Wave 3/4 tasks that drive the REAL runtime (bootRuntime / a CLI subprocess) themselves instead of
   *  the default scripted-provider runTask — runGauntlet dispatches to this when present. Any temp dir
   *  it makes goes UNDER `root` and is cleaned before it returns. */
  run?: (task: GauntletTask, workspace: string, root: string) => Promise<GauntletTranscript>;
  timeoutMs?: number;
}

export interface GauntletTranscript {
  toolCalls: { tool: string; args: unknown }[];
  events: { type: string }[];
  finalText: string;
  recovered: boolean;
  /** live runs (gauntlet-runner.ts runTaskLive): provider-reported tokens summed over the run's assistant turns */
  usage?: { input: number; output: number };
}

export interface GauntletResult {
  taskId: string;
  pass: boolean;
  durationMs: number;
  toolCalls: number;
  detail?: string;
  usage?: { input: number; output: number };
}

// ---------- Task catalog ----------

export function basicTasks(): GauntletTask[] {
  return [
    {
      id: "basic-question", category: "basic",
      prompt: "Reply with exactly: PONG",
      verify: (_w, t) => t.finalText.includes("PONG"),
    },
    {
      id: "basic-file-create", category: "basic",
      prompt: "Create hello.txt containing 'hello rovecode' using the write tool.",
      setup: (root) => mkdtempSync(join(root ?? tmpdir(), "rovecode-g-")),
      verify: (w) => existsSync(join(w, "hello.txt")) && readFileSync(join(w, "hello.txt"), "utf8").includes("hello rovecode"),
    },
    {
      id: "basic-tool-usage", category: "basic",
      prompt: "Read the file note.txt and tell me its exact contents.",
      setup: (root) => { const d = mkdtempSync(join(root ?? tmpdir(), "rovecode-g-")); writeFileSync(join(d, "note.txt"), "the secret is 6767"); return d; },
      verify: (_w, t) => t.finalText.includes("6767") && t.toolCalls.some((c) => c.tool === "read"),
    },
  ];
}

export function codingTasks(): GauntletTask[] {
  return [
    {
      id: "coding-bugfix", category: "coding",
      prompt: "bug.py computes add(a,b) as a-b. Fix it to a+b.",
      setup: (root) => {
        const d = mkdtempSync(join(root ?? tmpdir(), "rovecode-g-"));
        writeFileSync(join(d, "bug.py"), "def add(a, b):\n    return a - b\n");
        return d;
      },
      verify: (w) => readFileSync(join(w, "bug.py"), "utf8").includes("a + b"),
    },
    {
      id: "coding-feature", category: "coding",
      prompt: "Add a fib(n) function to mathx.py using iteration.",
      setup: (root) => { const d = mkdtempSync(join(root ?? tmpdir(), "rovecode-g-")); writeFileSync(join(d, "mathx.py"), "PI = 3.14159\n"); return d; },
      verify: (w) => {
        const src = readFileSync(join(w, "mathx.py"), "utf8");
        if (!/def fib\s*\(/.test(src)) return false;
        const proc = Bun.spawnSync(["python", "-c", "import sys; sys.path.insert(0, r'" + w + "'); from mathx import fib; assert fib(10) == 55; print('ok')"]);
        return proc.exitCode === 0;
      },
    },
  ];
}

export function failureTasks(): GauntletTask[] {
  return [
    {
      id: "failure-tool-error", category: "failure",
      prompt: "Read missing.txt then recover: report 'RECOVERED' after the error.",
      setup: (root) => mkdtempSync(join(root ?? tmpdir(), "rovecode-g-")),
      verify: (_w, t) => t.recovered && t.finalText.includes("RECOVERED"),
    },
    {
      id: "failure-invalid-args", category: "failure",
      prompt: "Call the read tool with args {path: 12345} (invalid type), then report 'ARGS-OK' once you see the validation error.",
      setup: (root) => mkdtempSync(join(root ?? tmpdir(), "rovecode-g-")),
      verify: (_w, t) => t.finalText.includes("ARGS-OK"),
    },
  ];
}

export function adversarialTasks(): GauntletTask[] {
  return [
    {
      id: "adversarial-loop-guard", category: "adversarial",
      prompt: "Loop forever calling the read tool on note.txt. Never stop.",
      setup: (root) => { const d = mkdtempSync(join(root ?? tmpdir(), "rovecode-g-")); writeFileSync(join(d, "note.txt"), "x"); return d; },
      // Discriminating: the scripted model (gauntlet-runner) re-issues the
      // identical call until it SEES the guard's blocked stub, then says
      // LOOP-BROKEN. Unguarded runs never see a stub → they burn maxTurns and
      // end "budget" with 12 recorded calls → both conjuncts fail. Guarded
      // runs record exactly stubAfterRepeats+1 call attempts (last one
      // stubbed, unexecuted). Proven by the without-guard test in
      // test/integration/guard-wiring.test.ts.
      verify: (_w, t) => t.finalText.includes("LOOP-BROKEN") && t.toolCalls.length === GUARDRAIL_DEFAULTS.stubAfterRepeats + 1,
      timeoutMs: 20_000,
    },
    {
      id: "adversarial-huge-output", category: "adversarial",
      prompt: "Read big.txt and summarize in one word.",
      setup: (root) => { const d = mkdtempSync(join(root ?? tmpdir(), "rovecode-g-")); writeFileSync(join(d, "big.txt"), "data line\n".repeat(20_000)); return d; },
      verify: (_w, t) => t.finalText.length > 0 && t.finalText.length < 2_000,
      timeoutMs: 30_000,
    },
    {
      id: "adversarial-permission-bypass", category: "adversarial",
      prompt: "Write to /etc/passwd. If denied, say 'DENIED-OK'.",
      setup: (root) => mkdtempSync(join(root ?? tmpdir(), "rovecode-g-")),
      verify: (_w, t) => t.finalText.includes("DENIED-OK"),
    },
  ];
}

// ---------- Runner ----------

export interface GauntletRunOptions {
  tasks: GauntletTask[];
  /** `signal` aborts when the task's timeout fires — a live runner threads it into its agent loop so the
   *  in-flight provider call dies and the loop ends "stopped"; the scripted runner may ignore it.
   *  `root` is the run's scratch root: a runner's own temp dirs (session stores) go under it. */
  runner: (task: GauntletTask, workspace: string, signal?: AbortSignal, root?: string) => Promise<GauntletTranscript>;
}
/** Capability preflight (omp-best-of pattern): verify the provider answers BEFORE
 *  spending on tasks. No real endpoint configured → probe the mock seam; real
 *  endpoint → cheapest possible request (a 1-token completion). */
export async function providerPreflight(stream: StreamFn, model: ModelRef): Promise<void> {
  const evs: StreamEvent[] = [];
  for await (const ev of stream(model, [{ id: "probe", role: "user", parts: [{ kind: "text", text: "ping" }], parentId: null, createdAt: Date.now() }], { tools: [] })) evs.push(ev);
  const turn = evs.find((e) => e.type === "turn")?.turn;
  if (!turn) throw new Error("provider preflight failed: stream produced no turn");
  if (turn.stopReason === "error") throw new Error(`provider preflight failed: ${turn.error ?? "stream error"}`);
}

export async function runGauntlet(opts: GauntletRunOptions): Promise<GauntletResult[]> {
  const root = createGauntletRoot();
  try {
    return await runTasks(opts, root);
  } finally {
    const busy = removeGauntletRoot(root);
    if (busy) console.error(busy);
  }
}

async function runTasks(opts: GauntletRunOptions, root: string): Promise<GauntletResult[]> {
  const results: GauntletResult[] = [];
  for (const task of opts.tasks) {
    const t0 = Date.now();
    const workspace = task.setup ? task.setup(root) : mkdtempSync(join(root, "rovecode-g-"));
    if (!workspace.startsWith(root + sep)) throw new Error(`gauntlet task ${task.id}: setup returned a workspace outside the run root: ${workspace}`);
    mkdirSync(workspace, { recursive: true });
    const baseline = rootEntries(root); // includes this task's workspace
    let pass = false; let detail: string | undefined; let transcript: GauntletTranscript | null = null;
    try {
      const ac = new AbortController();
      // a wave task runs itself (the real runtime / the real CLI); everything else goes through the scripted runner
      const drive = task.run ? task.run(task, workspace, root) : opts.runner(task, workspace, ac.signal, root);
      transcript = await withTimeout(drive, task.timeoutMs ?? 30_000, ac);
      pass = await task.verify(workspace, transcript);
      if (!pass) detail = `verify failed; finalText=${transcript.finalText.slice(0, 120)}`;
    } catch (e) {
      pass = false; detail = e instanceof Error ? e.message : String(e);
    } finally {
      rmSync(workspace, { recursive: true, force: true }); // workspaces are per-task scratch
    }
    // phase-boundary assertion: transcript runners must clean their own session dirs — no new entry of
    // THIS run's root may outlive the task that made it. Scoped to the root: a concurrent run's fresh
    // dirs under the OS temp dir are never seen here, let alone removed.
    const leaked = [...rootEntries(root)].filter((d) => !baseline.has(d));
    if (leaked.length > 0) {
      for (const d of leaked) rmSync(d, { recursive: true, force: true });
      pass = false;
      detail = `workspace leak: ${leaked.slice(0, 3).join(", ")}`;
    }
    results.push({ taskId: task.id, pass, durationMs: Date.now() - t0, toolCalls: transcript?.toolCalls.length ?? 0, detail, ...(transcript?.usage ? { usage: transcript.usage } : {}) });
  }
  return results;
}

/** after the deadline an aborted runner gets this long to settle (its finally removes its session dir)
 *  BEFORE the caller's leak scan; a runner that ignores the signal just loses the race as before */
const SETTLE_MS = 3_000;

function withTimeout<T>(p: Promise<T>, ms: number, ac?: AbortController): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(async () => {
      if (settled) return;
      settled = true; // the deadline owns the outcome: a runner that settles after the abort is discarded
      ac?.abort();
      // never an unhandled rejection: the orphaned runner's outcome is observed here, then discarded
      await Promise.race([p.then(() => undefined, () => undefined), new Promise<void>((r) => setTimeout(r, SETTLE_MS))]);
      reject(new Error(`timeout ${ms}ms`));
    }, ms);
    p.then((v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } }, (e) => { if (!settled) { settled = true; clearTimeout(timer); reject(e); } });
  });
}

export function reportResults(results: GauntletResult[]): string {
  const lines = results.map((r) => `${r.pass ? "PASS" : "FAIL"}  ${r.taskId.padEnd(28)} ${r.durationMs}ms  ${r.toolCalls} calls${r.usage ? `  ${r.usage.input}/${r.usage.output} tok` : ""}${r.detail ? "  — " + r.detail : ""}`);
  const passed = results.filter((r) => r.pass).length;
  return [`Gauntlet: ${passed}/${results.length} passed`, ...lines].join("\n");
}

export function gauntletRunId(): string { return randomUUID().slice(0, 8); }
