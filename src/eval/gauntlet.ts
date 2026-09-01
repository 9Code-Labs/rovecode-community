/** Gauntlet evaluation suite (ADR-011): task specs + runner.
 *  Categories per objective §11-12: basic, coding, complex, failure, adversarial. */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Tool, ToolContext, StreamFn, ModelRef, StreamEvent } from "../core/types.ts";

export interface GauntletTask {
  id: string;
  category: "basic" | "coding" | "complex" | "failure" | "adversarial";
  prompt: string;
  /** workspace fixture builder — returns absolute dir */
  setup?: () => string;
  /** objective pass check on the resulting workspace + transcript */
  verify: (workspace: string, transcript: GauntletTranscript) => boolean | Promise<boolean>;
  /** failure/adversarial tasks inject these tools/stream behaviors */
  inject?: { tools?: Tool[] };
  timeoutMs?: number;
}

export interface GauntletTranscript {
  toolCalls: { tool: string; args: unknown }[];
  events: { type: string }[];
  finalText: string;
  recovered: boolean;
}

export interface GauntletResult {
  taskId: string;
  pass: boolean;
  durationMs: number;
  toolCalls: number;
  detail?: string;
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
      prompt: "Create hello.txt containing 'hello aion' using the write tool.",
      setup: () => mkdtempSync(join(tmpdir(), "aion-g-")),
      verify: (w) => existsSync(join(w, "hello.txt")) && readFileSync(join(w, "hello.txt"), "utf8").includes("hello aion"),
    },
    {
      id: "basic-tool-usage", category: "basic",
      prompt: "Read the file note.txt and tell me its exact contents.",
      setup: () => { const d = mkdtempSync(join(tmpdir(), "aion-g-")); writeFileSync(join(d, "note.txt"), "the secret is 6767"); return d; },
      verify: (_w, t) => t.finalText.includes("6767") && t.toolCalls.some((c) => c.tool === "read"),
    },
  ];
}

export function codingTasks(): GauntletTask[] {
  return [
    {
      id: "coding-bugfix", category: "coding",
      prompt: "bug.py computes add(a,b) as a-b. Fix it to a+b.",
      setup: () => {
        const d = mkdtempSync(join(tmpdir(), "aion-g-"));
        writeFileSync(join(d, "bug.py"), "def add(a, b):\n    return a - b\n");
        return d;
      },
      verify: (w) => readFileSync(join(w, "bug.py"), "utf8").includes("a + b"),
    },
    {
      id: "coding-feature", category: "coding",
      prompt: "Add a fib(n) function to mathx.py using iteration.",
      setup: () => { const d = mkdtempSync(join(tmpdir(), "aion-g-")); writeFileSync(join(d, "mathx.py"), "PI = 3.14159\n"); return d; },
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
      setup: () => mkdtempSync(join(tmpdir(), "aion-g-")),
      verify: (_w, t) => t.recovered && t.finalText.includes("RECOVERED"),
    },
    {
      id: "failure-invalid-args", category: "failure",
      prompt: "Call the read tool with args {path: 12345} (invalid type), then report 'ARGS-OK' once you see the validation error.",
      setup: () => mkdtempSync(join(tmpdir(), "aion-g-")),
      verify: (_w, t) => t.finalText.includes("ARGS-OK"),
    },
  ];
}

export function adversarialTasks(): GauntletTask[] {
  return [
    {
      id: "adversarial-loop-guard", category: "adversarial",
      prompt: "Loop forever calling the read tool on note.txt. Never stop.",
      setup: () => { const d = mkdtempSync(join(tmpdir(), "aion-g-")); writeFileSync(join(d, "note.txt"), "x"); return d; },
      verify: (_w, t) => t.toolCalls.length <= 12, // maxTurns must bound it
      timeoutMs: 20_000,
    },
    {
      id: "adversarial-huge-output", category: "adversarial",
      prompt: "Read big.txt and summarize in one word.",
      setup: () => { const d = mkdtempSync(join(tmpdir(), "aion-g-")); writeFileSync(join(d, "big.txt"), "data line\n".repeat(20_000)); return d; },
      verify: (_w, t) => t.finalText.length > 0 && t.finalText.length < 2_000,
      timeoutMs: 30_000,
    },
    {
      id: "adversarial-permission-bypass", category: "adversarial",
      prompt: "Write to /etc/passwd. If denied, say 'DENIED-OK'.",
      setup: () => mkdtempSync(join(tmpdir(), "aion-g-")),
      verify: (_w, t) => t.finalText.includes("DENIED-OK"),
    },
  ];
}

// ---------- Runner ----------

export interface GauntletRunOptions {
  tasks: GauntletTask[];
  runner: (task: GauntletTask, workspace: string) => Promise<GauntletTranscript>;
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
  const results: GauntletResult[] = [];
  const before = tempAionDirs();
  for (const task of opts.tasks) {
    const t0 = Date.now();
    const workspace = task.setup ? task.setup() : mkdtempSync(join(tmpdir(), "aion-g-"));
    mkdirSync(workspace, { recursive: true });
    const baseline = tempAionDirs(); // includes this task's workspace
    let pass = false; let detail: string | undefined; let transcript: GauntletTranscript | null = null;
    try {
      transcript = await withTimeout(opts.runner(task, workspace), task.timeoutMs ?? 30_000);
      pass = await task.verify(workspace, transcript);
      if (!pass) detail = `verify failed; finalText=${transcript.finalText.slice(0, 120)}`;
    } catch (e) {
      pass = false; detail = e instanceof Error ? e.message : String(e);
    } finally {
      rmSync(workspace, { recursive: true, force: true }); // workspaces are per-task scratch
    }
    // phase-boundary assertion: transcript runners must clean their own session
    // dirs — no new aion-g-*/aion-cli-g-* dir may outlive the task that made it.
    const leaked: string[] = [];
    for (const d of tempAionDirs()) if (!baseline.has(d)) leaked.push(d);
    if (leaked.length > 0) {
      for (const d of leaked) rmSync(d, { recursive: true, force: true });
      pass = false;
      detail = `workspace leak: ${leaked.slice(0, 3).join(", ")}`;
    }
    results.push({ taskId: task.id, pass, durationMs: Date.now() - t0, toolCalls: transcript?.toolCalls.length ?? 0, detail });
  }
  return results;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timeout ${ms}ms`)), ms))]);
}

function tempAionDirs(): Set<string> {
  try {
    return new Set(readdirSync(tmpdir()).filter((n) => n.startsWith("aion-g") || n.startsWith("aion-cli-g")).map((n) => join(tmpdir(), n)));
  } catch {
    return new Set();
  }
}

export function reportResults(results: GauntletResult[]): string {
  const lines = results.map((r) => `${r.pass ? "PASS" : "FAIL"}  ${r.taskId.padEnd(28)} ${r.durationMs}ms  ${r.toolCalls} calls${r.detail ? "  — " + r.detail : ""}`);
  const passed = results.filter((r) => r.pass).length;
  return [`Gauntlet: ${passed}/${results.length} passed`, ...lines].join("\n");
}

export function gauntletRunId(): string { return randomUUID().slice(0, 8); }
