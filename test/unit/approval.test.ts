/** Approval-cache semantics: "once" means once (re-prompt on the next identical call);
 *  only "always" persists for the session. Regression for the overlay label promise. */

import { test, expect } from "bun:test";
import { ToolRegistry } from "../../src/core/tools.ts";
import type { PermissionRule, Tool, ToolContext } from "../../src/core/types.ts";

// kind "custom" maps to action `tool.<name>` (core/tools.ts actionFor)
const gate: PermissionRule[] = [{ action: "tool.probe", resource: "*", effect: "prompt" }];

function fakeTool(): { tool: Tool; executions: () => number } {
  let n = 0;
  return {
    executions: () => n,
    tool: {
      schema: { name: "probe", description: "test probe", args: { type: "object" } },
      kind: "custom",
      async execute() { n++; return { ok: true, output: "done" }; },
    },
  };
}

function ctx(): ToolContext {
  return { sessionId: "s", cwd: process.cwd(), signal: new AbortController().signal, permissions: { effect: "allow" } };
}

async function dispatchTwice(verdict: "once" | "always"): Promise<{ prompts: number; executions: number }> {
  const reg = new ToolRegistry();
  const { tool, executions } = fakeTool();
  reg.register(tool);
  let prompts = 0;
  const approve = async () => { prompts++; return verdict; };
  const call = { kind: "tool_call" as const, id: "c1", tool: "probe", args: { x: 1 } };
  await reg.dispatchBatch([call], ctx(), undefined, gate, approve, () => {}, false);
  await reg.dispatchBatch([{ ...call, id: "c2" }], ctx(), undefined, gate, approve, () => {}, false);
  return { prompts, executions: executions() };
}

test('"once" re-prompts for the next identical call', async () => {
  const r = await dispatchTwice("once");
  expect(r.executions).toBe(2);
  expect(r.prompts).toBe(2);
});

test('"always" is cached for the session', async () => {
  const r = await dispatchTwice("always");
  expect(r.executions).toBe(2);
  expect(r.prompts).toBe(1);
});
