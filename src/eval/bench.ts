/** Cross-harness benchmark: runs equivalent micro-workloads through Rovecode and
 *  comparable harness primitives, measuring wall time, tool calls, success.
 *  Deterministic (scripted providers / direct API use) — no API keys needed. */

import { agentLoop, SteeringQueue } from "../core/loop.ts";
import { ToolRegistry } from "../core/tools.ts";
import { SessionStore } from "../core/session.ts";
import { readTool, editTool, writeTool } from "../coding/hashline.ts";
import { mockStream, textTurn, toolTurn } from "../providers/stream.ts";
import type { AgentDefinition, RunConfig, StreamFn, AssistantTurn, Message } from "../core/types.ts";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export interface BenchResult {
  harness: string;
  task: string;
  pass: boolean;
  durationMs: number;
  toolCalls: number;
}

const cfg: RunConfig = {
  maxTurns: 10, contextBudgetTokens: 400_000, compactionThreshold: 0.8,
  parallelTools: true,
  permissionRules: [{ action: "*", resource: "*", effect: "allow" }],
};

const def: AgentDefinition = { name: "bench", systemPrompt: "bench", tools: ["*"] };

/** Workload: edit N lines across M files using anchored edits. */
async function benchEditsRovecode(nFiles: number, nEdits: number): Promise<{ pass: boolean; ms: number; calls: number }> {
  const ws = mkdtempSync(join(tmpdir(), "rovecode-bench-"));
  for (let i = 0; i < nFiles; i++) {
    writeFileSync(join(ws, `f${i}.txt`), Array.from({ length: 50 }, (_, j) => `line-${i}-${j}`).join("\n") + "\n");
  }
  const store = new SessionStore(mkdtempSync(join(tmpdir(), "rovecode-bench-s-")), randomUUID());
  const reg = new ToolRegistry();
  reg.register(readTool, editTool, writeTool);
  const t0 = Date.now();
  let calls = 0;
  // scripted: read each file, then batch edits
  let fileIdx = 0; let phase: "read" | "edit" | "done" = "read";
  const stream = mockStreamLike(async () => {
    if (phase === "read" && fileIdx < nFiles) {
      const p = join(ws, `f${fileIdx}.txt`);
      fileIdx++;
      if (fileIdx >= nFiles) phase = "edit";
      return toolTurn([{ id: "r" + fileIdx, tool: "read", args: { path: p } }]);
    }
    if (phase === "edit") {
      phase = "done";
      const edits: { tag: string; anchorLine: number; anchorHash: string; newLines: string[] }[] = [];
      for (let f = 0; f < nFiles; f++) {
        const p = join(ws, `f${f}.txt`);
        const content = readFileSync(p, "utf8");
        const tag = hashTag(content);
        const lines = content.split("\n");
        for (let e = 0; e < nEdits; e++) {
          const ln = 1 + e * 2; // spread edits
          if (ln <= lines.length) edits.push({ tag, anchorLine: ln, anchorHash: fnv(lines[ln - 1]!), newLines: [`EDITED-${f}-${e}`] });
        }
        return toolTurn(edits.map((ed, i) => ({ id: "e" + i, tool: "edit", args: { path: p, edits: [ed] } })));
      }
    }
    return textTurn("bench complete");
  });
  for await (const ev of agentLoop(def, "bench edits", {}, cfg, { stream, registry: reg, store }, new SteeringQueue())) {
    if (ev.type === "tool_execution_start") calls++;
  }
  const ms = Date.now() - t0;
  const pass = readFileSync(join(ws, "f0.txt"), "utf8").includes("EDITED-0-0");
  rmSync(ws, { recursive: true, force: true });
  return { pass, ms, calls };
}

function mockStreamLike(next: () => Promise<AssistantTurn>): StreamFn {
  return async function* () {
    yield { type: "turn" as const, turn: await next() };
  };
}

function fnv(line: string): string {
  const s = line.replace(/\s/g, "");
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36).padStart(3, "0").slice(-3);
}
function hashTag(content: string): string {
  return Bun.CryptoHasher ? new Bun.CryptoHasher("sha1").update(content).digest("hex").slice(0, 4) : "0000";
}

/** Baseline: raw fs operations (no agent) for reference cost. */
function benchRawFs(nFiles: number, nEdits: number): { pass: boolean; ms: number } {
  const ws = mkdtempSync(join(tmpdir(), "raw-bench-"));
  const t0 = Date.now();
  for (let i = 0; i < nFiles; i++) {
    writeFileSync(join(ws, `f${i}.txt`), Array.from({ length: 50 }, (_, j) => `line-${i}-${j}`).join("\n") + "\n");
  }
  for (let f = 0; f < nFiles; f++) {
    const p = join(ws, `f${f}.txt`);
    const lines = readFileSync(p, "utf8").split("\n");
    for (let e = 0; e < nEdits; e++) {
      const ln = 1 + e * 2;
      if (ln <= lines.length) lines[ln - 1] = `EDITED-${f}-${e}`;
    }
    writeFileSync(p, lines.join("\n"));
  }
  const ms = Date.now() - t0;
  const pass = readFileSync(join(ws, "f0.txt"), "utf8").includes("EDITED-0-0");
  rmSync(ws, { recursive: true, force: true });
  return { pass, ms };
}

/** Session durability benchmark: append + replay N messages. */
function benchSessions(n: number): { pass: boolean; ms: number } {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-sess-bench-"));
  const t0 = Date.now();
  const s = new SessionStore(dir, randomUUID());
  let prev: string | null = null;
  for (let i = 0; i < n; i++) {
    const m: Message = { id: randomUUID(), role: "user", parts: [{ kind: "text", text: `msg ${i}` }], parentId: prev, createdAt: Date.now() };
    s.append(m);
    prev = m.id;
  }
  const count = s.messages().length;
  const ms = Date.now() - t0;
  rmSync(dir, { recursive: true, force: true });
  return { pass: count === n, ms };
}

export async function runBenchmarks(): Promise<BenchResult[]> {
  const results: BenchResult[] = [];
  const edits = await benchEditsRovecode(3, 5);
  results.push({ harness: "rovecode", task: "edits-3files-5edits", ...edits, durationMs: edits.ms, toolCalls: edits.calls } as unknown as BenchResult);
  const raw = benchRawFs(3, 5);
  results.push({ harness: "raw-fs", task: "edits-3files-5edits", pass: raw.pass, durationMs: raw.ms, toolCalls: 0 });
  const sess = benchSessions(500);
  results.push({ harness: "rovecode", task: "session-append-replay-500", pass: sess.pass, durationMs: sess.ms, toolCalls: 0 });
  return results;
}

async function main(): Promise<void> {
  const results = await runBenchmarks();
  for (const r of results) {
    console.log(`${r.harness.padEnd(8)} ${r.task.padEnd(28)} ${r.pass ? "PASS" : "FAIL"} ${r.durationMs}ms ${r.toolCalls} calls`);
  }
}
if (import.meta.main) void main();
