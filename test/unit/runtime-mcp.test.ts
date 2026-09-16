/** Runtime ↔ MCP wiring (port #3, HIGH-2): the block in cli/runtime.ts that
 *  loads .mcp.json, registers the two house tools behind a first-connect gate,
 *  and prompt-gates mcp_call must be load-bearing — delete it and these fail. */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime } from "../../src/cli/runtime.ts";
import type { ApprovalRequest, ToolCallPart, ToolContext } from "../../src/core/types.ts";
import { scratchHome, writeTrustedMcpJson } from "../helpers/mcp-trust.ts";

const tmpDirs: string[] = [];
function makeTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-rtmcp-"));
  tmpDirs.push(dir);
  return dir;
}
// a project .mcp.json loads only once trusted (mcp/trust.ts): approvals go into a scratch home, never the host's
const restoreHome = scratchHome();
afterAll(() => {
  restoreHome();
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

function ctx(cwd: string): ToolContext {
  return { sessionId: "test", cwd, signal: new AbortController().signal, permissions: { effect: "allow" } };
}
function callPart(tool: string, args: unknown): ToolCallPart {
  return { kind: "tool_call", id: `call-${tool}`, tool, args };
}

describe("createRuntime MCP wiring", () => {
  test("cwd with .mcp.json registers exactly the six house tools (#3 pair + #57 quartet); gated dispatch of mcp_call records a PROMPT", async () => {
    const dir = makeTmp();
    writeTrustedMcpJson(dir, { toy: { command: "rovecode-not-a-real-binary-wiring" } });
    const rt = createRuntime({ cwd: dir, stream: null });

    const mcpNames = rt.registry.list().map((t) => t.schema.name).filter((n) => n.startsWith("mcp_"));
    expect(mcpNames).toEqual(["mcp_list", "mcp_call", "mcp_prompts", "mcp_prompt", "mcp_resources", "mcp_read"]);
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

/** The connect is kicked off on the next turn of the event loop, not inside createRuntime: runTui is synchronous
 *  from createRuntime through renderer.start() (the first painted frame), and connect()'s first step — loading
 *  the MCP SDK — used to run on the first microtask, still ahead of that paint. Nothing at boot awaits mcpReady;
 *  the two house tools do. */
describe("createRuntime does not connect MCP servers before the first frame", () => {
  test("McpManager.connect is untouched when createRuntime returns and has run after one timer turn; the tools still wait for it", async () => {
    const dir = makeTmp();
    writeTrustedMcpJson(dir, { toy: { command: "rovecode-not-a-real-binary-deferred" } });
    const { McpManager } = await import("../../src/mcp/client.ts");
    const origConnect = McpManager.prototype.connect;
    let connects = 0;
    let settled = false;
    McpManager.prototype.connect = async function (this: InstanceType<typeof McpManager>) {
      connects += 1;
      // a slow connect: the tool call below must not answer before it has settled
      await new Promise((r) => setTimeout(r, 30));
      settled = true;
      return { connected: [], failed: [{ name: "toy", error: "stubbed" }] };
    };
    try {
      const rt = createRuntime({ cwd: dir, stream: null });
      expect(connects).toBe(0);                                          // mutation: connect() called inline → 1
      await Promise.resolve();                                           // microtasks alone are not enough to start it…
      expect(connects).toBe(0);
      await new Promise((r) => setTimeout(r, 0));                        // …one timer turn is
      expect(connects).toBe(1);
      const cfg = rt.buildCfg(true);
      const out = await rt.registry.dispatch(callPart("mcp_list", {}), ctx(dir), undefined, cfg.permissionRules, cfg.approval, () => {});
      expect(settled).toBe(true);                                        // mcp_list awaited mcpReady (the gate survived the deferral)
      expect(out.ok).toBe(true);
      expect(out.output).toContain("no MCP servers connected");
      await rt.mcp?.close();
    } finally {
      McpManager.prototype.connect = origConnect;
    }
  });
});
