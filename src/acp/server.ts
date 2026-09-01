/** ACP agent endpoint (port #15): `aion acp` speaks Agent Client Protocol v1
 *  over stdio via the official SDK (@zed-industries/agent-client-protocol@0.4.5,
 *  Apache-2.0), mapped onto the ONE agentLoop (ADR-003).
 *
 *  Mapping:
 *    initialize            → protocol v1 + capabilities (no loadSession, text-only prompts)
 *    session/new           → createRuntime (same stores/tools/config as repl/tui)
 *    session/prompt        → agentLoop run; RunEvents stream out as session/update
 *      message_update      → agent_message_chunk
 *      tool_execution_*    → tool_call / tool_call_update
 *      tool_call_failed    → tool_call created directly in "failed" status
 *    approval (ADR-005)    → session/request_permission; declined/cancelled/unsupported → deny
 *    run_end done/budget   → stopReason end_turn / max_turn_requests
 *    run_end error         → JSON-RPC error response (RequestError is the ACP error
 *                            channel — the SDK converts it to a wire-level response,
 *                            so the never-throw seam ends at this boundary by design)
 *    session/cancel        → cooperative stop at the next event boundary → "cancelled"
 */

import {
  AgentSideConnection, RequestError, PROTOCOL_VERSION, ndJsonStream,
  type Agent, type Stream,
  type InitializeRequest, type InitializeResponse,
  type AuthenticateRequest, type AuthenticateResponse,
  type NewSessionRequest, type NewSessionResponse,
  type PromptRequest, type PromptResponse, type CancelNotification,
  type ContentBlock, type SessionNotification, type ToolCallContent,
  type ToolKind as AcpToolKind,
} from "@zed-industries/agent-client-protocol";
import { Readable, Writable } from "node:stream";
import { agentLoop, SteeringQueue } from "../core/loop.ts";
import { createRuntime, type Runtime } from "../cli/runtime.ts";
import type { ApprovalFn, RunEvent, StreamFn } from "../core/types.ts";

export interface AcpOptions {
  /** test/dev override threaded into createRuntime; undefined = provider from env */
  stream?: StreamFn | null;
  /** allow-all permissions: no ACP permission round-trips (AION_YOLO parity) */
  yolo?: boolean;
}

type SessionUpdate = SessionNotification["update"];
type RunStatus = "done" | "stopped" | "error" | "budget";

interface AcpSessionState {
  rt: Runtime;
  steering: SteeringQueue;
  active: { gen: AsyncGenerator<RunEvent>; cancelled: boolean } | null;
  permSeq: number;
}

// ---------- translation helpers (RunEvent / house shapes → ACP shapes) ----------

/** Flatten a prompt's content blocks to the loop's goal text. Baseline blocks
 *  (text, resource_link) per spec; embedded text resources are inlined. */
export function promptText(blocks: ContentBlock[]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.type === "text") parts.push(b.text);
    else if (b.type === "resource_link") parts.push(`[resource: ${b.uri}]`);
    else if (b.type === "resource" && "text" in b.resource) {
      parts.push(`<context uri="${b.resource.uri}">\n${b.resource.text}\n</context>`);
    } else parts.push(`[unsupported ${b.type} content omitted]`);
  }
  return parts.join("\n");
}

const TOOL_KINDS: Record<string, AcpToolKind> = {
  read: "read", edit: "edit", write: "edit", bash: "execute",
  skill_view: "read", skills_list: "search", mcp_list: "search",
  mcp_call: "other", memory_edit: "other",
};

export function kindFor(tool: string): AcpToolKind {
  return TOOL_KINDS[tool] ?? "other";
}

/** Human title for a tool call: name plus the most salient argument. */
export function titleFor(tool: string, args: unknown): string {
  if (args && typeof args === "object") {
    const a = args as Record<string, unknown>;
    const salient = a.path ?? a.command ?? a.name;
    if (salient !== undefined) return `${tool}: ${String(salient).slice(0, 120)}`;
  }
  return tool;
}

function asRawInput(args: unknown): Record<string, unknown> {
  if (args && typeof args === "object" && !Array.isArray(args)) return args as Record<string, unknown>;
  return args === undefined ? {} : { value: args };
}

function textContent(text: string): ToolCallContent[] {
  return [{ type: "content", content: { type: "text", text } }];
}

/** RunEvent → session/update payload; null for events with no ACP counterpart
 *  (run_start, turn_start/end, steer, compaction — lifecycle stays house-side). */
export function updateForEvent(ev: RunEvent): SessionUpdate | null {
  switch (ev.type) {
    case "message_update":
      return { sessionUpdate: "agent_message_chunk", content: { type: "text", text: ev.delta } };
    case "tool_execution_start":
      return {
        sessionUpdate: "tool_call", toolCallId: ev.callId, title: titleFor(ev.tool, ev.args),
        kind: kindFor(ev.tool), status: "in_progress", rawInput: asRawInput(ev.args),
      };
    case "tool_execution_update":
      return { sessionUpdate: "tool_call_update", toolCallId: ev.callId, content: textContent(ev.note) };
    case "tool_execution_end":
      return {
        sessionUpdate: "tool_call_update", toolCallId: ev.callId,
        status: ev.ok ? "completed" : "failed",
        content: textContent(ev.output), rawOutput: { output: ev.output },
      };
    case "tool_call_failed":
      // calls rejected before execution (permission_denied / truncated / not_found /
      // invalid_args) never got a tool_call create — create directly in failed status
      return {
        sessionUpdate: "tool_call", toolCallId: ev.callId, title: `tool call failed (${ev.reason})`,
        kind: "other", status: "failed", content: textContent(ev.detail),
      };
    default:
      return null;
  }
}

// ---------- the ACP agent ----------

export class AionAcpAgent implements Agent {
  private readonly sessions = new Map<string, AcpSessionState>();

  constructor(private readonly conn: AgentSideConnection, private readonly opts: AcpOptions = {}) {}

  async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
    // we implement exactly v1: reply with our version; older clients disconnect (spec rule)
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: { image: false, audio: false, embeddedContext: true },
      },
      authMethods: [],
    };
  }

  async authenticate(_params: AuthenticateRequest): Promise<AuthenticateResponse> {
    return {}; // no auth methods advertised; provider credentials come from env
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    // v1 scope: params.mcpServers is not wired into the runtime — the runtime
    // already loads project-level .aion/mcp.json + .mcp.json (port #3)
    const rt = createRuntime({ cwd: params.cwd, stream: this.opts.stream });
    if (!rt.stream) {
      throw RequestError.authRequired({
        details: "no provider configured: set AION_BASE_URL/AION_API_KEY or a <NAME>_API_KEY",
      });
    }
    this.sessions.set(rt.sessionId, { rt, steering: new SteeringQueue(), active: null, permSeq: 0 });
    return { sessionId: rt.sessionId };
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const s = this.sessions.get(params.sessionId);
    if (!s) throw RequestError.invalidParams({ sessionId: params.sessionId, error: "unknown session" });
    if (s.active) throw RequestError.invalidRequest({ error: "a prompt is already running for this session" });
    const stream = s.rt.stream;
    if (!stream) throw RequestError.authRequired();

    const goal = promptText(params.prompt);
    const model = { provider: s.rt.provider?.id ?? "mock", model: s.rt.defaultModel || "default" };
    const def = s.rt.buildDef(model);
    const cfg = s.rt.buildCfg(this.opts.yolo ?? false, this.approvalFor(params.sessionId, s));
    const deps = {
      stream, registry: s.rt.registry, store: s.rt.store,
      tools: s.rt.registry.list().map((t) => t.schema), guard: s.rt.guard,
    };

    const gen = agentLoop(def, goal, {}, cfg, deps, s.steering);
    const active = { gen, cancelled: false };
    s.active = active;
    let end: { status: RunStatus; summary: string } | null = null;
    try {
      for await (const ev of gen) {
        if (active.cancelled) break; // session/cancel landed; loop finally aborts tools
        if (ev.type === "run_end") { end = { status: ev.status, summary: ev.summary }; break; }
        const update = updateForEvent(ev);
        if (update) await this.conn.sessionUpdate({ sessionId: params.sessionId, update });
      }
    } finally {
      s.active = null;
    }

    if (active.cancelled || end === null) return { stopReason: "cancelled" };
    switch (end.status) {
      case "done": return { stopReason: "end_turn" };
      case "budget": return { stopReason: "max_turn_requests" };
      case "stopped": return { stopReason: "cancelled" };
      case "error": throw RequestError.internalError({ details: end.summary });
    }
  }

  async cancel(params: CancelNotification): Promise<void> {
    const active = this.sessions.get(params.sessionId)?.active;
    if (!active) return;
    active.cancelled = true;
    // close the generator: runs the loop's finally blocks (aborts in-flight tools).
    // Queues behind any pending next(), so the stop is cooperative (SHOULD per spec).
    await active.gen.return(undefined as never).then(() => undefined, () => undefined);
  }

  /** ADR-005 approval seam → session/request_permission. Deny is the safe default:
   *  declined, cancelled, unknown option, or a client that errors (unsupported). */
  private approvalFor(sessionId: string, s: AcpSessionState): ApprovalFn {
    return async (req) => {
      const toolCallId = `perm-${++s.permSeq}`;
      let outcome: { outcome: "cancelled" } | { outcome: "selected"; optionId: string };
      try {
        const resp = await this.conn.requestPermission({
          sessionId,
          toolCall: {
            toolCallId, title: titleFor(req.tool, req.revisedArgs), kind: kindFor(req.tool),
            status: "pending", rawInput: asRawInput(req.revisedArgs),
          },
          options: [
            { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
            { optionId: "allow-always", name: "Allow always", kind: "allow_always" },
            { optionId: "reject-once", name: "Deny", kind: "reject_once" },
          ],
        });
        outcome = resp.outcome;
      } catch {
        return "deny"; // client rejected the request itself → unsupported → deny
      }
      if (outcome.outcome !== "selected") return "deny";
      if (outcome.optionId === "allow-once") return "once";
      if (outcome.optionId === "allow-always") return "always";
      return "deny";
    };
  }
}

// ---------- wiring ----------

/** Attach an ACP agent to a bidirectional message stream (tests use an
 *  in-process duplex; the CLI uses stdio via runAcpStdio). */
export function serveAcp(io: Stream, opts: AcpOptions = {}): AgentSideConnection {
  return new AgentSideConnection((conn) => new AionAcpAgent(conn, opts), io);
}

/** `aion acp`: serve ACP v1 over stdio until the client closes stdin.
 *  stdout carries protocol frames only — nothing else may print there. */
export function runAcpStdio(opts: AcpOptions = {}): Promise<void> {
  // node:stream/web and lib.dom stream types diverge on getReader() overloads;
  // the runtime objects are the same web streams, so bridge via unknown
  const io = ndJsonStream(
    Writable.toWeb(process.stdout) as unknown as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>,
  );
  serveAcp(io, opts);
  return new Promise<void>((resolve) => {
    process.stdin.once("end", () => resolve());
    process.stdin.once("close", () => resolve());
  });
}
