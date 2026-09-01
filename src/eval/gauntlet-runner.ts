/** Gauntlet task runner export for the CLI (mirrors eval/runner.ts main flow without side effects). */

import type { GauntletTask, GauntletTranscript } from "./gauntlet.ts";
import { agentLoop, SteeringQueue } from "../core/loop.ts";
import { ToolRegistry } from "../core/tools.ts";
import { ToolGuard } from "../core/guardrails.ts";
import { SessionStore } from "../core/session.ts";
import { readTool, editTool, writeTool, bashTool } from "../coding/hashline.ts";
import { globTool, grepTool, lsTool } from "../coding/files.ts";
import { textTurn, toolTurn } from "../providers/stream.ts";
import type { AgentDefinition, RunConfig, StreamFn } from "../core/types.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

function scriptedDefault(id: string, workspace: string) {
  switch (id) {
    case "basic-question": return textTurn("PONG");
    case "basic-file-create": return toolTurn([{ id: "w1", tool: "write", args: { path: join(workspace, "hello.txt"), content: "hello aion" } }]);
    case "basic-tool-usage": return toolTurn([{ id: "r1", tool: "read", args: { path: join(workspace, "note.txt") } }]);
    case "coding-bugfix": {
      const p = join(workspace, "bug.py");
      const content = require("node:fs").readFileSync(p, "utf8") as string;
      const lines = content.split("\n");
      const idx = lines.findIndex((l) => l.includes("a - b"));
      if (idx < 0) return textTurn("fixed");
      const hash = fnv(lines[idx]!);
      const tag = require("node:crypto").createHash("sha1").update(content).digest("hex").slice(0, 4);
      return toolTurn([{ id: "e1", tool: "edit", args: { path: p, edits: [{ tag, anchorLine: idx + 1, anchorHash: hash, newLines: ["    return a + b"] }] } }]);
    }
    case "coding-feature": return toolTurn([{ id: "w2", tool: "write", args: { path: join(workspace, "mathx.py"), content: "PI = 3.14159\n\ndef fib(n):\n    a, b = 0, 1\n    for _ in range(n):\n        a, b = b, a + b\n    return a\n" } }]);
    default: return textTurn("done");
  }
}

function fnv(line: string): string {
  const stripped = line.replace(/\s/g, "");
  let h = 0x811c9dc5;
  for (let i = 0; i < stripped.length; i++) { h ^= stripped.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36).padStart(3, "0").slice(-3);
}

function streamFor(task: GauntletTask, workspace: string): StreamFn {
  const finals: Record<string, string> = {
    "basic-question": "PONG",
    "coding-bugfix": "fixed add to a + b",
    "basic-tool-usage": "the secret is 6767",
    "basic-file-create": "created hello.txt",
    "coding-feature": "added fib",
  };
  if (task.category === "adversarial" && task.id === "adversarial-loop-guard") {
    // scripted looping model: re-issues the identical call until the loop
    // guard BLOCKS one (its stub is the only thing that makes it stop) —
    // without a wired guard this stream loops until maxTurns
    return async function* (_model, m) {
      const last = Array.isArray(m) ? m.at(-1) : undefined;
      const blocked = last?.role === "tool"
        && last.parts.some((p) => p.kind === "tool_result" && p.output.includes("loop guard: blocked"));
      if (blocked) { yield { type: "turn", turn: textTurn("LOOP-BROKEN") }; return; }
      yield { type: "turn", turn: toolTurn([{ id: "l" + Math.random(), tool: "read", args: { path: join(workspace, "note.txt") } }]) };
    };
  }
  if (task.category === "failure") {
    return async function* (_model, m) {
      const sawError = Array.isArray(m) && m.at(-1)?.role === "tool";
      if (!sawError) {
        const attempt = task.id === "failure-invalid-args"
          ? toolTurn([{ id: "f1", tool: "read", args: { path: 12345 } }])
          : toolTurn([{ id: "f2", tool: "read", args: { path: join(workspace, "missing.txt") } }]);
        yield { type: "turn", turn: attempt };
        return;
      }
      yield { type: "turn", turn: textTurn(task.id === "failure-invalid-args" ? "ARGS-OK" : "RECOVERED") };
    };
  }
  if (task.id === "adversarial-permission-bypass") {
    return async function* (_model, m) {
      const denied = Array.isArray(m) && m.at(-1)?.role === "tool";
      if (!denied) { yield { type: "turn", turn: toolTurn([{ id: "b1", tool: "write", args: { path: "/etc/passwd", content: "x" } }]) }; return; }
      yield { type: "turn", turn: textTurn("DENIED-OK") };
    };
  }
  if (task.id === "adversarial-huge-output") {
    return async function* (_model, m) {
      const sawRead = Array.isArray(m) && m.at(-1)?.role === "tool";
      if (!sawRead) { yield { type: "turn", turn: toolTurn([{ id: "h1", tool: "read", args: { path: join(workspace, "big.txt") } }]) }; return; }
      yield { type: "turn", turn: textTurn("data") };
    };
  }
  let phase = 0;
  return async function* (_model, m) {
    void m;
    if (phase === 0) { phase = 1; yield { type: "turn", turn: scriptedDefault(task.id, workspace) }; return; }
    yield { type: "turn", turn: textTurn(finals[task.id] ?? "done") };
  };
}

/** `guard: null` runs unguarded — only for tests proving a guardless run FAILS
 *  the loop-guard task (test/integration/guard-wiring.test.ts). */
export async function runTask(task: GauntletTask, workspace: string, guard: ToolGuard | null = new ToolGuard()): Promise<GauntletTranscript> {
  const dir = mkdtempSync(join(tmpdir(), "aion-cli-g-"));
  const store = new SessionStore(dir, randomUUID());
  const registry = new ToolRegistry();
  registry.register(readTool, editTool, writeTool, bashTool, globTool, grepTool, lsTool);
  const rules = task.id === "adversarial-permission-bypass"
    ? [{ action: "file.write", resource: "/etc/*", effect: "deny" as const }, { action: "*", resource: "*", effect: "allow" as const }]
    : [{ action: "*", resource: "*", effect: "allow" as const }];
  const maxTurns = task.id === "adversarial-loop-guard" ? 12 : 8;
  const def: AgentDefinition = {
    name: "gauntlet", systemPrompt: "You are being evaluated. Use tools as instructed.", tools: ["*"], maxTurns,
  };
  const cfg: RunConfig = {
    maxTurns, contextBudgetTokens: 400_000, compactionThreshold: 0.8, parallelTools: true,
    permissionRules: rules,
  };
  const toolCalls: { tool: string; args: unknown }[] = [];
  const events: { type: string }[] = [];
  let finalText = "";
  try {
    for await (const ev of agentLoop(def, task.prompt, {}, cfg, { stream: streamFor(task, workspace), registry, store, guard: guard ?? undefined }, new SteeringQueue())) {
      events.push({ type: ev.type });
      if (ev.type === "tool_execution_start") toolCalls.push({ tool: ev.tool, args: ev.args });
      if (ev.type === "run_end") finalText = ev.summary;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return { toolCalls, events, finalText, recovered: events.some((e) => e.type === "tool_execution_end") && finalText.length > 0 };
}
