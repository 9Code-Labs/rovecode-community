/** Wiring test for R2 #9 LOW-3: src/cli/runtime.ts buildCfg installs
 *  execPolicyApprover UNCONDITIONALLY on gated (non-yolo) configs, so a
 *  HEADLESS runtime (run/serve — no approver passed) still gets policy-refined
 *  approvals instead of every shell call dying on "no approver connected".
 *  Reverting the wrap to `approval ? execPolicyApprover(approval) : undefined`
 *  fails every case below (cfg.approval becomes undefined → the allow-listed
 *  argv is refused instead of run). */

import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime } from "../../src/cli/runtime.ts";
import type { RunEvent, Tool, ToolCallPart, ToolContext } from "../../src/core/types.ts";

// Spy executor: registry.register overwrites by schema name, so this replaces
// the REAL bash tool (and its checkpoint wrapper) — nothing is ever spawned.
function spyBash(executed: string[]): Tool {
  return {
    schema: { name: "bash", description: "spy", args: {} },
    kind: "execute",
    async execute(args) {
      executed.push(String((args as { command: string }).command));
      return { ok: true, output: "ran" };
    },
  };
}
const ctx = (cwd: string): ToolContext =>
  ({ sessionId: "wiring", cwd, signal: new AbortController().signal, permissions: { effect: "allow" } });
const call = (command: string, id: string): ToolCallPart =>
  ({ kind: "tool_call", id, tool: "bash", args: { command } });

test("headless gated runtime (no approver): allow-listed argv auto-runs, forbidden argv hard-stops, unknown argv fails closed — never silently run", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-execpolicy-wiring-"));
  try {
    const rt = createRuntime({ cwd, stream: null });
    const cfg = rt.buildCfg(false); // headless: NO approver — the wrap must still be installed
    expect(cfg.approval).toBeDefined();

    const executed: string[] = [];
    const events: RunEvent[] = [];
    rt.registry.register(spyBash(executed));
    const dispatch = (command: string, id: string) =>
      rt.registry.dispatch(call(command, id), ctx(cwd), undefined, cfg.permissionRules, cfg.approval, (e) => events.push(e));

    // 1. allow-listed → policy answers "once", the command runs without any human
    const allowed = await dispatch("ls -la", "w1");
    expect(allowed.ok).toBe(true);
    expect(executed).toEqual(["ls -la"]);
    expect(events.some((e) => e.type === "tool_call_failed")).toBe(false);

    // 2. forbidden → hard stop before execution
    const forbidden = await dispatch("git push --force", "w2");
    expect(forbidden.ok).toBe(false);
    expect(forbidden.output).toContain("Permission denied");
    expect(executed).toEqual(["ls -la"]);

    // 3. unknown → prompt-classified, and with no human the wrapper fails closed
    //    (deliberate headless semantics: denied, NOT silently run)
    const unknown = await dispatch("frobnicate --yes", "w3");
    expect(unknown.ok).toBe(false);
    expect(unknown.output).toContain("Permission denied");
    expect(executed).toEqual(["ls -la"]);
    expect(events.filter((e) => e.type === "tool_call_failed" && e.reason === "permission_denied")).toHaveLength(2);
    expect(events.filter((e) => e.type === "tool_execution_start")).toHaveLength(1); // only the allow-listed call
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
