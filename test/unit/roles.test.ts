/** agents/roles.ts: the built-in role table, the defs they compile to, and the registry filter that
 *  ENFORCES a role's tool set (a researcher has no edit to call, whatever the model asks). */
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { filterToolsForDef, roleDefs, roleHint, ROLES } from "../../src/agents/roles.ts";
import type { AgentDefinition } from "../../src/core/types.ts";

const base: AgentDefinition = { name: "main", systemPrompt: "base", tools: ["*"] };

test("four roles ship: researcher + planner are read-only, implementer keeps the code set, reviewer can run checks but not edit", () => {
  expect(ROLES.map((r) => r.name)).toEqual(["researcher", "planner", "implementer", "reviewer"]);
  const defs = roleDefs(base);
  for (const r of ROLES) {
    const d = defs.get(r.name)!;
    expect(d.spawns).toBeUndefined();                 // spawnable like main; the DEPTH cap bounds recursion (orchestrator preflightSpawn)
    expect(d.systemPrompt.length).toBeGreaterThan(200); // a real prompt, not a label
  }
  for (const readOnly of ["researcher", "planner"]) {
    const tools = defs.get(readOnly)!.tools;
    expect(tools).not.toContain("edit");
    expect(tools).not.toContain("write");
    expect(tools).not.toContain("bash");
  }
  expect(defs.get("implementer")!.tools).toContain("edit");
  const reviewer = defs.get("reviewer")!.tools;
  expect(reviewer).toContain("bash");   // run the project's checks
  expect(reviewer).not.toContain("edit");
  expect(defs.get("researcher")!.tools).toContain("mcp_call"); // MCP prioritized where it helps
});

test("filterToolsForDef: the allowlist is the enforcement, \"*\" keeps everything", () => {
  const all = ["read", "edit", "write", "bash"].map((name) => ({ schema: { name } }));
  const researcher = roleDefs(base).get("researcher")!;
  expect(filterToolsForDef(all, researcher).map((t) => t.schema.name)).toEqual(["read"]);
  expect(filterToolsForDef(all, base).map((t) => t.schema.name)).toEqual(["read", "edit", "write", "bash"]);
});

test("the task tool's description advertises the roles", () => {
  const hint = roleHint();
  for (const r of ROLES) expect(hint).toContain(r.name);
});

// ---------- enforcement through a REAL child run (orchestrator runChild) ----------

test("a researcher child that tries to edit CANNOT: its registry has no edit tool (loop answers unknown tool, no file is written)", async () => {
  const { runChild } = await import("../../src/core/orchestrator.ts");
  const { ToolRegistry } = await import("../../src/core/tools.ts");
  const { readTool, editTool } = await import("../../src/coding/hashline.ts");
  const { mockStream, toolTurn, textTurn } = await import("../../src/providers/stream.ts");
  const dir = mkdtempSync(join(tmpdir(), "rovecode-roles-"));
  try {
    const defs = roleDefs({ name: "main", systemPrompt: "base", tools: ["*"] });
    const stream = mockStream({ turns: [
      toolTurn([{ id: "e1", tool: "edit", args: { path: "x.txt", edits: [] } }]), // the model tries…
      textTurn("I cannot edit — here is my report instead"),
    ] });
    const r = await runChild({
      defs, stream,
      registryFactory: (def, cwd) => {
        const reg = new ToolRegistry();
        reg.register(...filterToolsForDef([readTool, editTool], def)); // the runtime's own filter
        return reg;
      },
      rootDir: dir, sessionsDir: join(dir, "sessions"),
      baseConfig: { contextBudgetTokens: 100_000, compactionThreshold: 0.8, parallelTools: true, permissionRules: [{ action: "*", resource: "*", effect: "allow" }] },
    }, { agent: "researcher", goal: "review x" }, 1);
    expect(r.ok).toBe(true);
    expect(r.summary).toContain("report");
    expect(existsSync(join(dir, "x.txt"))).toBe(false); // the edit never existed to run
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
