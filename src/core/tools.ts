/** Tool pipeline: validate → revise (extension hooks) → policy → approve → execute (ADR-005).
 *  Tool calls are recorded BEFORE execution; truncated responses fail calls unexecuted. */

import type {
  Tool, ToolContext, ToolOutput, PermissionRule, PermissionDecision,
  ApprovalRequest, ToolCallPart, RunEvent,
} from "./types.ts";

export interface ExtensionHooks {
  /** May revise args; returns revised args (omp revision gate). */
  reviseToolArgs?: (tool: string, args: unknown) => Promise<unknown>;
  onToolResult?: (tool: string, args: unknown, out: ToolOutput) => Promise<void>;
}

/** Deny-by-default wildcard rules, last match wins (opencode permission.ts:126). */
export function evaluatePermissions(rules: PermissionRule[], action: string, resource: string): PermissionDecision {
  let decision: PermissionDecision = { effect: "deny", reason: `no rule allows ${action}` };
  for (const r of rules) {
    if (matchesGlob(r.action, action) && matchesGlob(r.resource, resource)) {
      decision = r.effect === "allow" ? { effect: "allow" }
        : r.effect === "deny" ? { effect: "deny", reason: `denied by rule ${r.action} ${r.resource}` }
        : { effect: "prompt", prompt: `permission required for ${action} ${resource}` };
    }
  }
  return decision;
}

function matchesGlob(pattern: string, value: string): boolean {
  if (pattern === "*") return true;
  const rx = new RegExp("^" + pattern.split("*").map(escapeRx).join(".*") + "$");
  return rx.test(value);
}
function escapeRx(s: string): string { return s.replace(/[.+^${}()|[\]\\]/g, "\\$&"); }

export class ToolRegistry {
  private tools = new Map<string, Tool>();
  private approvalCache = new Map<string, "once" | "always">();

  register(...tools: Tool[]): void { for (const t of tools) this.tools.set(t.schema.name, t); }
  list(): Tool[] { return [...this.tools.values()]; }

  /** ADR-005 ladder. Emits events; never lets tool exceptions escape as control flow. */
  async dispatch(
    call: ToolCallPart,
    ctx: ToolContext,
    hooks: ExtensionHooks | undefined,
    rules: PermissionRule[],
    approve: ((req: ApprovalRequest) => Promise<"once" | "always" | "deny">) | undefined,
    emit: (e: RunEvent) => void,
  ): Promise<ToolOutput> {
    const t0 = Date.now();
    const tool = this.tools.get(call.tool);
    if (!tool) {
      emit({ type: "tool_call_failed", callId: call.id, reason: "not_found", detail: `unknown tool ${call.tool}` });
      return { ok: false, output: `Error: unknown tool '${call.tool}'` };
    }

    // 1. extension revision
    let args = call.args;
    if (hooks?.reviseToolArgs) args = await hooks.reviseToolArgs(call.tool, args);

    // 2. policy (deny-default)
    const resource = describeResource(call.tool, args);
    const decision = evaluatePermissions(rules, actionFor(tool), resource);
    if (decision.effect === "deny") {
      emit({ type: "tool_call_failed", callId: call.id, reason: "permission_denied", detail: decision.reason });
      return { ok: false, output: `Permission denied: ${decision.reason}` };
    }

    // 3. approval — always resolved against the REVISED args (omp wrapper.ts:205-247)
    if (decision.effect === "prompt") {
      const cached = this.approvalCache.get(cacheKey(call.tool, args));
      if (!cached) {
        if (!approve) {
          emit({ type: "tool_call_failed", callId: call.id, reason: "permission_denied", detail: "approval required but no approver connected" });
          return { ok: false, output: "Permission denied: approval required, no approver available" };
        }
        const verdict = await approve({ tool: call.tool, args, revisedArgs: args, reason: decision.prompt });
        if (verdict === "deny") {
          emit({ type: "tool_call_failed", callId: call.id, reason: "permission_denied", detail: "user denied" });
          return { ok: false, output: "Permission denied by user" };
        }
        this.approvalCache.set(cacheKey(call.tool, args), verdict);
      }
    }

    // 4. execute with typed error capture
    emit({ type: "tool_execution_start", callId: call.id, tool: call.tool, args });
    let out: ToolOutput;
    try {
      out = await tool.execute(args, ctx);
    } catch (e) {
      out = { ok: false, output: `Error: ${e instanceof Error ? e.message : String(e)}` };
    }
    emit({ type: "tool_execution_end", callId: call.id, ok: out.ok, output: out.output, durationMs: Date.now() - t0 });
    if (hooks?.onToolResult) await hooks.onToolResult(call.tool, args, out).catch(() => {});
    return out;
  }

  /** Batch executor: concurrent for parallel-safe tools, sequential otherwise (pi executionMode). */
  async dispatchBatch(
    calls: ToolCallPart[],
    ctx: ToolContext,
    hooks: ExtensionHooks | undefined,
    rules: PermissionRule[],
    approve: ((req: ApprovalRequest) => Promise<"once" | "always" | "deny">) | undefined,
    emit: (e: RunEvent) => void,
    parallelEnabled: boolean,
  ): Promise<Map<string, ToolOutput>> {
    const results = new Map<string, ToolOutput>();
    const run = async (c: ToolCallPart) => { results.set(c.id, await this.dispatch(c, ctx, hooks, rules, approve, emit)); };
    if (!parallelEnabled || calls.some((c) => this.tools.get(c.tool)?.sequential !== false)) {
      for (const c of calls) await run(c);
    } else {
      await Promise.all(calls.map(run));
    }
    return results;
  }
}

function actionFor(tool: Tool): string {
  switch (tool.kind) {
    case "read": return "file.read";
    case "write": return "file.write";
    case "execute": return "shell.exec";
    case "spawn": return "spawn";
    case "memory": return "memory.write";
    default: return `tool.${tool.schema.name}`;
  }
}

function describeResource(tool: string, args: unknown): string {
  if (args && typeof args === "object" && "path" in (args as Record<string, unknown>)) {
    return String((args as Record<string, unknown>).path);
  }
  if (args && typeof args === "object" && "command" in (args as Record<string, unknown>)) {
    return String((args as Record<string, unknown>).command);
  }
  return tool;
}

function cacheKey(tool: string, args: unknown): string { return tool + "|" + JSON.stringify(sortK(args)); }
function sortK(v: unknown): unknown {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)));
  }
  return v;
}
