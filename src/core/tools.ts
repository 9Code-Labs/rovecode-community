/** Tool pipeline: validate → revise (extension hooks) → policy → approve → execute (ADR-005).
 *  Tool calls are recorded BEFORE execution; truncated responses fail calls unexecuted. */

import type {
  Tool, ToolContext, ToolOutput, PermissionRule, PermissionDecision,
  ApprovalRequest, ToolCallPart, RunEvent,
} from "./types.ts";
import type { ToolGuard } from "./guardrails.ts";
import { isAbsolute, join } from "node:path";

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
    guard?: ToolGuard,
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

    // 1b. loop guard (port #4, hermes): stub repeated identical calls BEFORE the user is
    // prompted for them; warn notes ride along on the result
    let warnNote: string | undefined;
    if (guard) {
      const verdict = guard.checkCall(call.tool, args);
      if (verdict.action === "stub") {
        const note = verdict.note ?? "call blocked by loop guard: identical call repeated too often";
        emit({ type: "tool_execution_start", callId: call.id, tool: call.tool, args });
        emit({ type: "tool_execution_end", callId: call.id, ok: false, output: note, durationMs: 0 });
        return { ok: false, output: note };
      }
      if (verdict.action === "warn") warnNote = verdict.note;
    }

    // 2. policy (deny-default)
    const resource = describeResource(tool, args, ctx.cwd);
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
        // "once" means once: only "always" verdicts persist across calls
        if (verdict === "always") this.approvalCache.set(cacheKey(call.tool, args), verdict);
      }
    }

    // 4. execute with typed error capture; ctx.onUpdate is wired here so a
    // tool's progress notes (MCP onprogress, LSP/checkpoint updates) become
    // real tool_execution_update events for ALL tools (port #3 LOW-6)
    emit({ type: "tool_execution_start", callId: call.id, tool: call.tool, args });
    let out: ToolOutput;
    try {
      out = await tool.execute(args, { ...ctx, onUpdate: (note) => emit({ type: "tool_execution_update", callId: call.id, note }) });
    } catch (e) {
      out = { ok: false, output: `Error: ${e instanceof Error ? e.message : String(e)}` };
    }
    // 4b. loop guard result pass: byte-identical duplicate results become stubs.
    // out.ok is threaded through so FAILED results are never stubbed (hermes
    // keeps errors verbatim) even when the text dodges the string sniff.
    if (guard) {
      const r = guard.checkResult(call.tool, args, out.output, out.ok);
      if (r.deduped) out = { ...out, output: r.output };
    }
    if (warnNote) out = { ...out, output: `${out.output}\n\n[loop-guard] ${warnNote}` };
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
    guard?: ToolGuard,
  ): Promise<Map<string, ToolOutput>> {
    const results = new Map<string, ToolOutput>();
    const run = async (c: ToolCallPart) => { results.set(c.id, await this.dispatch(c, ctx, hooks, rules, approve, emit, guard)); };
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

/** Resource for policy rules. An args key is only honored when the tool's
 *  DECLARED schema has that property: args are not schema-validated before
 *  policy, so a smuggled key ({query, path:"/tmp/x"} on recall, whose schema
 *  has no `path`) must not re-aim a tool-targeted deny rule at another
 *  resource. Policy runs pre-execute, so per-tool arg-stripping can't repair
 *  this — the gate belongs here.
 *  For a path-declared tool the resource is the path the tool will actually
 *  touch: a missing/empty `path` defaults to ctx.cwd and a relative one
 *  resolves against it (the tools' own resolvePath rule), so neither omitting
 *  nor relativizing the arg can dodge a path-targeted rule (port #22 MED-4).
 *  Command resources and the tool-name fallback are untouched. */
function describeResource(tool: Tool, args: unknown, cwd: string): string {
  const props = tool.schema.args["properties"];
  const declared = (key: string): boolean =>
    typeof props === "object" && props !== null && key in (props as Record<string, unknown>);
  const a = args && typeof args === "object" ? (args as Record<string, unknown>) : undefined;
  if (declared("path")) {
    const p = a?.["path"];
    if (p === undefined || p === null || p === "") return cwd;
    return isAbsolute(String(p)) ? String(p) : join(cwd, String(p));
  }
  if (a && declared("command") && "command" in a) return String(a["command"]);
  return tool.schema.name;
}

function cacheKey(tool: string, args: unknown): string { return tool + "|" + JSON.stringify(sortK(args)); }
function sortK(v: unknown): unknown {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)));
  }
  return v;
}
