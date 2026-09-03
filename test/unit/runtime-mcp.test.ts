/** Runtime ↔ MCP wiring (port #3, HIGH-2): the block in cli/runtime.ts that
 *  loads .mcp.json, registers the two house tools behind a first-connect gate,
 *  and prompt-gates mcp_call must be load-bearing — delete it and these fail. */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime } from "../../src/cli/runtime.ts";
import type { ApprovalRequest, ToolCallPart, ToolContext } from "../../src/core/types.ts";

const tmpDirs: string[] = [];
function makeTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-rtmcp-"));
  tmpDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

function ctx(cwd: string): ToolContext {
  return { sessionId: "test", cwd, signal: new AbortController().signal, permissions: { effect: "allow" } };
}
function callPart(tool: string, args: unknown): ToolCallPart {
  return { kind: "tool_call", id: `call-${tool}`, tool, args };
}

describe("createRuntime MCP wiring", () => {
  test("cwd with .mcp.json registers exactly mcp_list + mcp_call; gated dispatch of mcp_call records a PROMPT", async () => {
    const dir = makeTmp();
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { toy: { command: "rovecode-not-a-real-binary-wiring" } } }));
    const rt = createRuntime({ cwd: dir, stream: null });

    const mcpNames = rt.registry.list().map((t) => t.schema.name).filter((n) => n.startsWith("mcp_"));
    expect(mcpNames).toEqual(["mcp_list", "mcp_call"]);
    expect(rt.mcp).not.toBeNull();
    expect(rt.mcp?.serverNames()).toEqual(["toy"]);

    // mcp_call under the default gated rules → the approver is prompted
    const prompts: ApprovalRequest[] = [];
    const approver = async (req: ApprovalRequest) => {
      prompts.push(req);
      return "deny" as const;
    };
    const cfg = rt.buildCfg(false, approver);
    const out = await rt.registry.dispatch(
      callPart("mcp_call", { server: "toy", tool: "x" }), ctx(dir), undefined, cfg.permissionRules, cfg.approval, () => {},
    );
    expect(prompts.length).toBe(1);
    expect(prompts[0]?.tool).toBe("mcp_call");
    expect(prompts[0]?.reason).toContain("tool.mcp_call");
    expect(out.ok).toBe(false);
    expect(out.output).toContain("Permission denied by user");

    // mcp_list is kind:"read" → rides the file.read allow, no prompt; and its
    // execute path (first-connect gate) answers even though connect failed.
    const listOut = await rt.registry.dispatch(
      callPart("mcp_list", {}), ctx(dir), undefined, cfg.permissionRules, cfg.approval, () => {},
    );
    expect(prompts.length).toBe(1); // unchanged — no second prompt
    expect(listOut.ok).toBe(true);
    expect(listOut.output).toContain("no MCP servers connected");
    await rt.mcp?.close();
  });

  test("cwd without any MCP config: no MCP tools, rt.mcp stays null", () => {
    const rt = createRuntime({ cwd: makeTmp(), stream: null });
    expect(rt.mcp).toBeNull();
    expect(rt.registry.list().some((t) => t.schema.name.startsWith("mcp_"))).toBe(false);
  });
});
