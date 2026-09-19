/** FW2-P regression: deriveChildRules × evaluatePermissions (LAST-match-wins,
 *  tools.ts). The child's deny-rest catch-all must sit FIRST (lowest priority)
 *  so parent-derived rules override it. The old code appended it LAST, making
 *  `{*,*,deny}` the final match for EVERY action — all child tool calls were
 *  denied even under an allow-all parent. These tests prove the fixed order at
 *  the rules level and end-to-end through runChild. */

import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveChildRules, runChild } from "../../src/core/orchestrator.ts";
import { evaluatePermissions, ToolRegistry } from "../../src/core/tools.ts";
import { textTurn, toolTurn } from "../../src/providers/stream.ts";
import type { PermissionRule, RunConfig, StreamFn, Tool } from "../../src/core/types.ts";

const allowAll: PermissionRule[] = [{ action: "*", resource: "*", effect: "allow" }];

// ---------- rules level ----------

test("allow-all parent: child file.read is ALLOWED (FW2-P: trailing catch-all used to deny it)", () => {
  const child = deriveChildRules(allowAll);
  expect(evaluatePermissions(child, "file.read", "src/app.ts").effect).toBe("allow");
  expect(evaluatePermissions(child, "shell.exec", "ls -la").effect).toBe("allow");
});

test("catch-all sits FIRST; specific parent allows win; unlisted actions fall through to deny", () => {
  const parent: PermissionRule[] = [{ action: "file.read", resource: "*", effect: "allow" }];
  const child = deriveChildRules(parent);
  expect(child[0]).toEqual({ action: "*", resource: "*", effect: "deny" });
  expect(child.filter((r) => r.action === "*" && r.resource === "*")).toHaveLength(1);
  expect(evaluatePermissions(child, "file.read", "notes.md").effect).toBe("allow");
  const denied = evaluatePermissions(child, "shell.exec", "rm -rf /");
  expect(denied.effect).toBe("deny"); // unlisted → deny-rest default
  expect(evaluatePermissions(child, "spawn", "worker").effect).toBe("deny");
  expect(evaluatePermissions(child, "file.write", "notes.md").effect).toBe("deny");
});

test("prompt→deny narrowing still overrides a broader parent allow (parent rule order preserved)", () => {
  const parent: PermissionRule[] = [
    { action: "*", resource: "*", effect: "allow" },
    { action: "shell.exec", resource: "*", effect: "prompt" },
  ];
  const child = deriveChildRules(parent);
  // non-interactive child: prompt became deny, and it still matches LAST for shell.exec
  expect(evaluatePermissions(child, "shell.exec", "ls").effect).toBe("deny");
  expect(evaluatePermissions(child, "file.read", "x.ts").effect).toBe("allow");
});

// ---------- end-to-end through runChild ----------

function cfg(rules: PermissionRule[]): RunConfig {
  return {
    maxTurns: 6, contextBudgetTokens: 100_000, compactionThreshold: 0.8,
    parallelTools: false,
    permissionRules: rules,
  };
}

function countedTool(name: string, kind: Tool["kind"]): { tool: Tool; executed: () => number } {
  let n = 0;
  return {
    tool: {
      schema: { name, description: name, args: { type: "object" } },
      kind,
      async execute() { n++; return { ok: true, output: `${name}-ran` }; },
    },
    executed: () => n,
  };
}

function scriptedStream(turns: ReturnType<typeof textTurn>[]): StreamFn {
  let i = 0;
  return async function* () { yield { type: "turn", turn: turns[i++]! }; };
}

test("runChild: child CAN file.read under an allow-all parent, unlisted kinds still denied", async () => {
  const root = mkdtempSync(join(tmpdir(), "rovecode-rules-root-"));
  const sessions = mkdtempSync(join(tmpdir(), "rovecode-rules-sess-"));
  const peek = countedTool("peek", "read");     // action file.read
  const sh = countedTool("sh", "execute");      // action shell.exec
  try {
    const res = await runChild({
      defs: new Map([["worker", { name: "worker", systemPrompt: "w", tools: ["*"] }]]),
      stream: scriptedStream([
        toolTurn([{ id: "c1", tool: "peek", args: { path: "notes.md" } }]),
        toolTurn([{ id: "c2", tool: "sh", args: { command: "ls" } }]),
        textTurn("child finished"),
      ]),
      registryFactory: () => { const r = new ToolRegistry(); r.register(peek.tool, sh.tool); return r; },
      rootDir: root, sessionsDir: sessions,
      // parent grants file.read only: the child inherits that allow and NOTHING more
      baseConfig: cfg([{ action: "file.read", resource: "*", effect: "allow" }]),
    }, { agent: "worker", goal: "read the notes" });
    expect(res.ok).toBe(true);
    expect(res.summary).toContain("child finished");
    expect(peek.executed()).toBe(1); // FW2-P: was 0 — the trailing catch-all denied even granted actions
    expect(sh.executed()).toBe(0);   // unlisted for this parent → deny-rest default holds
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(sessions, { recursive: true, force: true });
  }
}, 30_000);

test("runChild: allow-all parent actually lets the child execute tools (FW2-P end-to-end)", async () => {
  const root = mkdtempSync(join(tmpdir(), "rovecode-rules-root-"));
  const sessions = mkdtempSync(join(tmpdir(), "rovecode-rules-sess-"));
  const peek = countedTool("peek", "read");
  try {
    const res = await runChild({
      defs: new Map([["worker", { name: "worker", systemPrompt: "w", tools: ["*"] }]]),
      stream: scriptedStream([
        toolTurn([{ id: "c1", tool: "peek", args: { path: "a.txt" } }]),
        textTurn("done under allow-all"),
      ]),
      registryFactory: () => { const r = new ToolRegistry(); r.register(peek.tool); return r; },
      rootDir: root, sessionsDir: sessions,
      baseConfig: cfg(allowAll),
    }, { agent: "worker", goal: "read a file" });
    expect(res.ok).toBe(true);
    expect(res.summary).toContain("done under allow-all");
    expect(peek.executed()).toBe(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(sessions, { recursive: true, force: true });
  }
}, 30_000);

test("runChild advertises the child's own registry to the child's model (options.tools) — a native child used to see NO tools at all", async () => {
  const root = mkdtempSync(join(tmpdir(), "rovecode-rules-root-"));
  const sessions = mkdtempSync(join(tmpdir(), "rovecode-rules-sess-"));
  const peek = countedTool("peek", "read");
  const seen: string[][] = [];
  const watching: StreamFn = async function* (_m, _msgs, options) {
    seen.push((options?.tools ?? []).map((t) => t.name));
    yield { type: "turn", turn: textTurn("done") };
  };
  try {
    const res = await runChild({
      defs: new Map([["worker", { name: "worker", systemPrompt: "w", tools: ["*"] }]]),
      stream: watching,
      registryFactory: () => { const r = new ToolRegistry(); r.register(peek.tool); return r; },
      rootDir: root, sessionsDir: sessions,
      baseConfig: cfg(allowAll),
    }, { agent: "worker", goal: "advertise" });
    expect(res.ok).toBe(true);
    expect(seen.length).toBeGreaterThan(0);
    for (const names of seen) expect(names).toEqual(["peek"]); // the child registry, on EVERY turn
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(sessions, { recursive: true, force: true });
  }
}, 30_000);
