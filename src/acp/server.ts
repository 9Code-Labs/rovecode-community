/** ACP agent endpoint (port #15): `rovecode acp` speaks Agent Client Protocol v1
 *  over stdio via the official SDK (@zed-industries/agent-client-protocol@0.4.5,
 *  Apache-2.0), mapped onto the ONE agentLoop (ADR-003).
 *
 *  Mapping:
 *    initialize            → protocol v1 + capabilities (no loadSession; text + image prompts, port #34)
 *    prompt image blocks   → ImagePart via imageFromBase64 (the bytes decide the type; the TUI's
 *                            per-image size cap and ≤8-per-message count cap apply), staged on the
 *                            session store so the loop's user message carries them (no loop change);
 *                            any bad block → JSON-RPC invalid params {error} before a run starts
 *    session/new           → bootRuntime (same stores/tools/config as repl/tui); a sandbox
 *                            misconfig / unavailable rung in the client's cwd (port #27)
 *                            → JSON-RPC invalid params {cwd, error: one-line message}
 *    session/prompt        → agentLoop run; RunEvents stream out as session/update
 *      message_update      → agent_message_chunk
 *      tool_execution_*    → tool_call / tool_call_update
 *      tool_call_failed    → tool_call created directly in "failed" status
 *    approval (ADR-005)    → session/request_permission; declined/cancelled/unsupported → deny
 *    run_end done/budget   → stopReason end_turn / max_turn_requests
 *    run_end error         → JSON-RPC error response (RequestError is the ACP error
 *                            channel — the SDK converts it to a wire-level response,
 *                            so the never-throw seam ends at this boundary by design)
 *    session/cancel        → aborts the run's AbortController (kills the in-flight
 *                            provider fetch and tool subprocesses mid-turn — port #21),
 *                            races any outstanding permission ask to deny, then closes
 *                            the generator → "cancelled"
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
import { basename } from "node:path";
import { noModelHint } from "../core/voice.ts";
import { Readable, Writable } from "node:stream";
import { agentLoop, SteeringQueue } from "../core/loop.ts";
import { bootRuntime, type Runtime } from "../cli/runtime.ts";
import { checkImageCount, imageFromBase64 } from "../core/images.ts";
import { SandboxConfigError } from "../core/sandbox-config.ts";
import type { ApprovalFn, ImagePart, RunEvent, StreamFn } from "../core/types.ts";

export interface AcpOptions {
  /** test/dev override threaded into createRuntime; undefined = provider from env */
  stream?: StreamFn | null;
  /** allow-all permissions: no ACP permission round-trips (ROVECODE_YOLO parity) */
  yolo?: boolean;
}

type SessionUpdate = SessionNotification["update"];
type RunStatus = "done" | "stopped" | "error" | "budget";

interface AcpSessionState {
  rt: Runtime;
  steering: SteeringQueue;
  active: {
    gen: AsyncGenerator<RunEvent>;
    cancelled: boolean;
    /** per-run controller (port #21): session/cancel aborts it, killing the
     *  in-flight provider fetch and every ToolContext.signal consumer */
    abort: AbortController;
    /** resolves null when session/cancel lands — raced against an outstanding
     *  request_permission so a hung client cannot wedge the session (HIGH-G2) */
    onCancel: Promise<null>;
    fireCancel: () => void;
  } | null;
  permSeq: number;
}

// ---------- translation helpers (RunEvent / house shapes → ACP shapes) ----------

export interface PromptParts {
  /** the loop's goal text: text blocks, resource links, inlined embedded text resources */
  goal: string;
  /** port #34: decoded image blocks, in prompt order */
  images: ImagePart[];
  /** the FIRST problem (unsupported/mismatched mime, oversize, more than 8 images) — the caller
   *  rejects the whole prompt, nothing is half-sent */
  error?: string;
}

/** Prompt content blocks → goal text + image parts. Baseline blocks (text, resource_link) per
 *  spec; embedded text resources are inlined; image blocks decode through imageFromBase64 (the
 *  bytes decide the type — a disagreeing mimeType is an error, like the TUI's loader) under the
 *  same per-image size cap and per-message count cap as /attach; audio stays unsupported. */
export function promptParts(blocks: ContentBlock[]): PromptParts {
  const parts: string[] = [];
  const images: ImagePart[] = [];
  let error: string | undefined;
  for (const b of blocks) {
    if (b.type === "text") parts.push(b.text);
    else if (b.type === "resource_link") parts.push(`[resource: ${b.uri}]`);
    else if (b.type === "resource" && "text" in b.resource) {
      parts.push(`<context uri="${b.resource.uri}">\n${b.resource.text}\n</context>`);
    } else if (b.type === "image") {
      const name = b.uri && !b.uri.startsWith("data:") ? basename(b.uri) : undefined; // display name: the file the client sent
      const res = imageFromBase64(b.data, b.mimeType, name !== undefined ? { name } : {});
      if ("error" in res) error ??= res.error; else images.push(res);
    } else parts.push(`[unsupported ${b.type} content omitted]`);
  }
  error ??= checkImageCount(images.length);
  const goal = parts.join("\n");
  return error === undefined ? { goal, images } : { goal, images, error };
}

/** Text-only view of a prompt (image blocks travel separately — promptParts). */
export function promptText(blocks: ContentBlock[]): string { return promptParts(blocks).goal; }

const TOOL_KINDS: Record<string, AcpToolKind> = {
  read: "read", edit: "edit", write: "edit", bash: "execute",
  skill_view: "read", skills_list: "search", mcp_list: "search",
  mcp_call: "other", memory_edit: "other", web_fetch: "fetch",
};

export function kindFor(tool: string): AcpToolKind {
  return TOOL_KINDS[tool] ?? "other";
}

/** Human title for a tool call: name plus the most salient argument. */
export function titleFor(tool: string, args: unknown): string {
  if (args && typeof args === "object") {
    const a = args as Record<string, unknown>;
    const salient = a.path ?? a.command ?? a.name ?? a.url;
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

export class RovecodeAcpAgent implements Agent {
  private readonly sessions = new Map<string, AcpSessionState>();

  constructor(private readonly conn: AgentSideConnection, private readonly opts: AcpOptions = {}) {}

  async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
    // we implement exactly v1: reply with our version; older clients disconnect (spec rule)
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: { image: true, audio: false, embeddedContext: true }, // image: port #34 (promptParts)
      },
      authMethods: [],
    };
  }

  async authenticate(_params: AuthenticateRequest): Promise<AuthenticateResponse> {
    return {}; // no auth methods advertised; provider credentials come from env
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    // v1 scope: params.mcpServers is not wired into the runtime — the runtime
    // already loads project-level .rovecode/mcp.json + .mcp.json (port #3)
    let rt: Runtime;
    try {
      rt = await bootRuntime({ cwd: params.cwd, stream: this.opts.stream });
    } catch (e) {
      // port #27: the client's cwd asked for a rung this machine cannot provide (or
      // its sandbox.json is broken) — invalid params carrying the one-line message,
      // the same shape as "unknown session" below (the parameter names something
      // we cannot serve); the agent process stays up for the next session/new
      if (e instanceof SandboxConfigError) throw RequestError.invalidParams({ cwd: params.cwd, error: e.message });
      throw e;
    }
    // live registry: once the user runs `rovecode provider add` / `rovecode auth set`, the next
    // session/new succeeds without restarting the agent process
    const noProvider = rt.noProviderReason();
    if (!rt.stream || noProvider !== null) {
      throw RequestError.authRequired({
        details: noProvider ?? noModelHint("cli"),
      });
    }
    this.sessions.set(rt.sessionId, { rt, steering: rt.steering, active: null, permSeq: 0 }); // port #26: runtime queue → task notes reach the next prompt
    return { sessionId: rt.sessionId };
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const s = this.sessions.get(params.sessionId);
    if (!s) throw RequestError.invalidParams({ sessionId: params.sessionId, error: "unknown session" });
    if (s.active) throw RequestError.invalidRequest({ error: "a prompt is already running for this session" });
    const stream = s.rt.stream;
    const noProvider = s.rt.noProviderReason();
    if (!stream || noProvider !== null) throw RequestError.authRequired(noProvider !== null ? { details: noProvider } : undefined);

    const { goal, images, error } = promptParts(params.prompt);
    // port #34: a bad image block (not png/jpeg/gif/webp, mime disagrees with the bytes, oversize,
    // 9+ images) rejects the prompt as invalid params BEFORE any run — same "nothing staged" outcome
    // as the TUI's error note; the session stays usable for the corrected prompt
    if (error !== undefined) throw RequestError.invalidParams({ error });
    const model = { provider: s.rt.provider?.id ?? "mock", model: s.rt.defaultModel || "default" };
    const def = s.rt.buildDef(model);
    const cfg = s.rt.buildCfg(this.opts.yolo ?? false, this.approvalFor(params.sessionId, s));
    const abort = new AbortController(); // port #21: one controller per run
    s.rt.tasks.bindRun(abort.signal); // port #26: session/cancel also cancels the run's background tasks
    const deps = {
      stream, registry: s.rt.registry, store: s.rt.store,
      tools: s.rt.registry.list().map((t) => t.schema), guard: s.rt.guard,
      hooks: s.rt.hooks, // port #29: .rovecode/hooks.{ts,js} of the session cwd
      cwd: s.rt.cwd, // HIGH-G1: the client's authoritative session cwd reaches ToolContext
      signal: abort.signal, // port #21: session/cancel kills in-flight fetch/tools mid-turn
    };

    // port #34: the store folds the staged images into the loop's user message when it lands in
    // append() — the same seam TUI /attach uses; the active guard above means no other user entry
    // can slip in between (task steers drain AFTER the goal message, loop.ts)
    if (images.length > 0) s.rt.store.stageAttachments(images);
    const gen = agentLoop(def, goal, {}, cfg, deps, s.steering);
    let fireCancel: () => void = () => {};
    const onCancel = new Promise<null>((resolve) => { fireCancel = () => resolve(null); });
    const active = { gen, cancelled: false, abort, onCancel, fireCancel };
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
    // port #21: abort the run's controller FIRST — the in-flight provider fetch
    // dies and tool subprocesses are killed mid-turn, so the generator below
    // reaches a settle point quickly instead of finishing the turn.
    active.abort.abort();
    // HIGH-G2: unblock an outstanding request_permission (→ deny) — without
    // this a crashed client / closed popup leaves the run suspended inside the
    // approval await forever and the session permanently "already running".
    active.fireCancel();
    // close the generator as the follow-through: runs the loop's finally blocks.
    // Queues behind any pending next(), so the settle stays cooperative.
    await active.gen.return(undefined as never).then(() => undefined, () => undefined);
  }

  /** MED-G3: close every session runtime's MCP children. runAcpStdio calls this
   *  when stdin closes — without it, `rovecode acp` in an MCP-configured project
   *  outlives the client (children keep running until the parent is killed). */
  async shutdown(): Promise<void> {
    const closing: Promise<unknown>[] = [];
    for (const s of this.sessions.values()) {
      s.rt.tasks.cancelAll(); // port #26: background children die with the agent, never after it
      s.rt.bashJobs.dispose(); // #55: background shell jobs die with their session
      closing.push(s.rt.hooks.close()); // port #29: session_close per session runtime
      if (s.rt.mcp) closing.push(s.rt.mcp.close().catch(() => {}));
    }
    await Promise.all(closing);
  }

  /** ADR-005 approval seam → session/request_permission. Deny is the safe default:
   *  declined, cancelled, unknown option, or a client that errors (unsupported). */
  private approvalFor(sessionId: string, s: AcpSessionState): ApprovalFn {
    return async (req) => {
      const toolCallId = `perm-${++s.permSeq}`;
      let outcome: { outcome: "cancelled" } | { outcome: "selected"; optionId: string };
      try {
        const ask = this.conn.requestPermission({
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
        void ask.then(() => undefined, () => undefined); // raced loser must not surface as unhandled
        // HIGH-G2: session/cancel must be able to interrupt an outstanding ask
        // (client crash / closed popup) — cancel wins the race and maps to deny
        const resp = s.active ? await Promise.race([ask, s.active.onCancel]) : await ask;
        if (resp === null) return "deny"; // cancelled mid-permission
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
 *  in-process duplex; the CLI uses stdio via runAcpStdio). The agent handle is
 *  returned alongside the connection so callers can shutdown() its sessions. */
export function serveAcp(io: Stream, opts: AcpOptions = {}): { conn: AgentSideConnection; agent: RovecodeAcpAgent } {
  let agent!: RovecodeAcpAgent; // the factory runs synchronously inside the ctor
  const conn = new AgentSideConnection((c) => (agent = new RovecodeAcpAgent(c, opts)), io);
  return { conn, agent };
}

/** `rovecode acp`: serve ACP v1 over stdio until the client closes stdin.
 *  stdout carries protocol frames only — nothing else may print there. */
export function runAcpStdio(opts: AcpOptions = {}): Promise<void> {
  // node:stream/web and lib.dom stream types diverge on getReader() overloads;
  // the runtime objects are the same web streams, so bridge via unknown
  const io = ndJsonStream(
    Writable.toWeb(process.stdout) as unknown as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>,
  );
  const { agent } = serveAcp(io, opts);
  return new Promise<void>((resolve) => {
    // MED-G3: reap MCP children before resolving, or the process outlives a
    // closed editor in MCP-configured projects (children hold the event loop)
    const done = () => { void agent.shutdown().then(() => resolve(), () => resolve()); };
    process.stdin.once("end", done);
    process.stdin.once("close", done);
  });
}
