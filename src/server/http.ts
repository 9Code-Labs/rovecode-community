/** Headless HTTP server (port #19): pattern-level port of opencode's client/server
 *  split (MIT, snapshot research/source_snapshots/opencode-2026).
 *
 *  Patterns ported (citations against the snapshot):
 *  - client/server split: the TUI/CLI are HTTP clients of a headless server —
 *    packages/opencode/src/cli/cmd/serve.ts:6-24 (serve command → Server.listen),
 *    packages/sdk/js (client generated from the server's OpenAPI spec),
 *    packages/opencode/src/cli/cmd/tui.ts:11 (TUI imports @opencode-ai/sdk).
 *  - session surface: routes/instance/httpapi/groups/session.ts — root "/session"
 *    (:29), create POST (:203), prompt POST (:316), list GET (:111).
 *  - GET /doc serving the OpenAPI JSON: routes/instance/httpapi/server.ts:190
 *    (docRoute) + :188 (lazy spec build). We hand-author the object (openapi.ts).
 *  - SSE event streaming: routes/instance/httpapi/handlers/event.ts:69-85
 *    (text/event-stream response, no-cache headers).
 *  - loopback bind by default: cli/network.ts:12-15 (hostname default "127.0.0.1").
 *
 *  NOT ported: opencode's implementation is Effect-based (server.ts imports
 *  effect / @effect/platform-node / effect/unstable/httpapi). ADR-001 rejects
 *  Effect idioms — this file is plain Bun.serve + the ONE agentLoop (ADR-003)
 *  reused via createRuntime. v1 approvals are policy-only: no interactive
 *  approver over HTTP; a permission rule with effect "prompt" fails the tool
 *  call at the registry seam (core/tools.ts:87-93). See APPROVALS_NOTE in /doc.
 *
 *  Never-throw seam: route handlers are wrapped — an exception becomes a JSON
 *  500; a mid-stream loop error becomes a final run_end error frame, never a
 *  socket reset or a crashed server. */

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { bootRuntime, type Runtime } from "../cli/runtime.ts";
import { noModelHint } from "../core/voice.ts";
import { SandboxConfigError } from "../core/sandbox-config.ts";
import { agentLoop, SteeringQueue } from "../core/loop.ts";
import { listSessions } from "../core/session.ts";
import type { ModelRef, RunEvent, StreamFn } from "../core/types.ts";
import { buildOpenApiDoc } from "./openapi.ts";
import { dashboardHtml } from "./dashboard.ts";
import { agentTree } from "../sdk/client.ts";

/** Server-level event bus (SDK F2 — the visual-tracking surface): a LIVE TAP of
 *  everything the server does — session_created, agent_tree_update (from the
 *  per-session TaskManager.subscribe), and every RunEvent of every run. GET /events
 *  streams it as SSE; GET /ui serves the zero-build dashboard that consumes it.
 *  Render-only, NOT a log: replay is the session JSONL's job, so a client that
 *  connects mid-run gets a hello snapshot + live frames, nothing retroactive. */
type BusFrame =
  | { readonly type: "session_created"; readonly session: string }
  | { readonly type: "agent_tree_update"; readonly session: string; readonly tree: unknown }
  | { readonly type: "run_event"; readonly session: string; readonly event: RunEvent };

export const DEFAULT_PORT = 4100;
export const DEFAULT_HOSTNAME = "127.0.0.1";
/** request-body bound: prompt bodies over this fail with a clean JSON 413
 *  (checked against content-length before the body is read). Bun.serve's
 *  maxRequestBodySize is set to 2× this as a transport ceiling for clients
 *  that lie about / omit content-length (chunked): those are cut at the
 *  socket instead of ballooning RSS. */
export const MAX_BODY_BYTES = 1024 * 1024;

export interface ServerOptions {
  /** TCP port; default 4100; 0 = ephemeral (tests) */
  port?: number;
  /** bind address; default 127.0.0.1 (loopback-only, opencode cli/network.ts:15) */
  hostname?: string;
  /** project root; sessions live in <cwd>/.rovecode/sessions */
  cwd?: string;
  /** injectable provider stream (tests); undefined = resolve from env; null = no stream */
  stream?: StreamFn | null;
  /** allow-all permission rules; default false = policy rules with prompt-effect
   *  gates, which FAIL over HTTP (no approver) — see APPROVALS_NOTE */
  yolo?: boolean;
}

export interface RovecodeServer {
  port: number;
  hostname: string;
  url: string;
  /** closes the listener and in-flight SSE sockets, aborts every in-flight
   *  run's controller (port #21: the in-flight provider fetch and tool
   *  subprocesses die mid-turn), then closes every session runtime's MCP
   *  children. Returns without awaiting the aborted generators' final settle. */
  stop(): Promise<void>;
}

interface SessionEntry {
  runtime: Runtime;
  running: boolean;
  /** the in-flight run's controller (port #21) — DELETE /session/:id/prompt and
   *  stop() abort it; null when idle. Cleared by the pump's settle, like `running`. */
  abort: AbortController | null;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** SSE framing (bar): `event: <type>\ndata: <json>\n\n`. */
function frame(ev: RunEvent): string {
  return `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`;
}

/** Pump loop events into an SSE response; the stream closes on run_end.
 *  Client disconnects abort the run's controller (port #21): the in-flight
 *  provider fetch dies and tool subprocesses are killed mid-turn, then the
 *  generator settles at its next suspension point. `running` is cleared ONLY
 *  from the pump's finally — when the generator has actually released the
 *  session — so the 409 one-run-per-session invariant holds across
 *  disconnects (MED-F1). */
function sseResponse(run: AsyncGenerator<RunEvent>, onSettled: () => void, abort: () => void): Response {
  const enc = new TextEncoder();
  let settled = false;
  const settle = () => { if (!settled) { settled = true; onSettled(); } };
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const ev of run) {
          controller.enqueue(enc.encode(frame(ev)));
          if (ev.type === "run_end") break; // bar: stream closes on run_end
        }
      } catch (e) {
        // never-throw seam: a loop/enqueue error becomes a terminal error frame
        const end: RunEvent = { type: "run_end", status: "error", summary: e instanceof Error ? e.message : String(e) };
        try { controller.enqueue(enc.encode(frame(end))); } catch { /* consumer gone */ }
      } finally {
        settle();
        try { controller.close(); } catch { /* cancelled/closed already */ }
      }
    },
    cancel() {
      // client hung up mid-run: abort the run's controller (kills the in-flight
      // fetch / tool subprocesses — port #21), then close the generator as the
      // follow-through. Do NOT settle here: the pump's finally settles
      // truthfully once the generator finishes; an eager settle let a second
      // run share this session's store (MED-F1).
      abort();
      void Promise.resolve(run.return(undefined)).catch(() => {});
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      // headers per opencode handlers/event.ts:78-83
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}

function bodyText(body: unknown): string | null {
  if (body && typeof body === "object" && typeof (body as { text?: unknown }).text === "string") {
    return (body as { text: string }).text;
  }
  return null;
}

function bodyModel(body: unknown): ModelRef | null {
  if (body && typeof body === "object" && (body as { model?: unknown }).model && typeof (body as { model?: unknown }).model === "object") {
    const m = (body as { model: { provider?: unknown; model?: unknown } }).model;
    if (typeof m.provider === "string" && typeof m.model === "string") return { provider: m.provider, model: m.model };
  }
  return null;
}

export function startServer(opts: ServerOptions = {}): RovecodeServer {
  const hostname = opts.hostname ?? DEFAULT_HOSTNAME;
  const cwd = opts.cwd ?? process.cwd();
  const sessionsRoot = join(cwd, ".rovecode", "sessions");
  const yolo = opts.yolo ?? false;
  const sessions = new Map<string, SessionEntry>();
  // bus frames are pre-encoded SSE "data:" lines so one send reaches every client
  const bus = new Set<(frame: string) => void>();
  const busSend = (frame: BusFrame): void => {
    const line = `data: ${JSON.stringify(frame)}\n\n`;
    for (const listener of [...bus]) { try { listener(line); } catch { bus.delete(listener); } }
  };

  const createSession = async (): Promise<Response> => {
    const id = randomUUID();
    // Reuse the ONE runtime construction every surface uses (cli/runtime.ts):
    // same stores, same tools, same provider resolution. Injectable stream for tests.
    let runtime: Runtime;
    try {
      runtime = await bootRuntime({ cwd, sessionId: id, stream: opts.stream });
    } catch (e) {
      // port #27: sandbox misconfig / unavailable configured rung → 503 with the
      // one-line message (the server cwd cannot provide the requested executor)
      if (e instanceof SandboxConfigError) return json({ error: e.message }, 503);
      throw e; // never-throw seam below turns anything else into a JSON 500
    }
    sessions.set(id, { runtime, running: false, abort: null });
    busSend({ type: "session_created", session: id });
    // agent-tree frames: the runtime's TaskManager emits {tasks} on every change;
    // agentTree() (sdk/client.ts) shapes them into the parent→children tree the
    // dashboard renders. Same synthesis the SDK does in-process (SdkEvent).
    // agent-tree frames: the runtime's TaskManager emits the changed task on every
    // transition; agentTree() (sdk/client.ts) shapes the full list into the
    // parent→children tree the dashboard renders. Same synthesis the SDK does in-process.
    runtime.tasks.subscribe(() => busSend({ type: "agent_tree_update", session: id, tree: agentTree(runtime.tasks.list()) }));
    return json({ id }, 201);
  };

  const prompt = async (id: string, req: Request): Promise<Response> => {
    const entry = sessions.get(id);
    if (!entry) return json({ error: `unknown session ${id}` }, 404);
    // LOW-MED-F4: bound the request body BEFORE reading it (declared size), and
    // the parsed text after — an unbounded body was a local RSS balloon.
    const declared = Number(req.headers.get("content-length") ?? "0");
    if (declared > MAX_BODY_BYTES) return json({ error: `request body too large (max ${MAX_BODY_BYTES} bytes)` }, 413);
    let body: unknown;
    try { body = await req.json(); } catch { return json({ error: "body must be JSON" }, 400); }
    const text = bodyText(body);
    if (text === null) return json({ error: 'body must be {"text": string}' }, 400);
    if (text.length > MAX_BODY_BYTES) return json({ error: `text too large (max ${MAX_BODY_BYTES} chars)` }, 413);
    if (entry.running) return json({ error: "a run is already in progress for this session" }, 409);
    const rt = entry.runtime;
    const stream = rt.stream;
    // live: a provider added after boot (rovecode provider add / auth set) serves the next request
    const noProvider = rt.noProviderReason();
    if (!stream || noProvider !== null) return json({ error: noProvider ?? noModelHint("cli") }, 503);
    const model: ModelRef = bodyModel(body) ?? { provider: rt.provider?.id ?? "mock", model: rt.defaultModel || "default" };
    const def = rt.buildDef(model);
    // no interactive ApprovalFn — buildCfg installs the port-#9 exec-policy wrapper:
    // allow-listed argv auto-runs, forbidden is denied, prompt-classified fails closed
    // as tool_call_failed/permission_denied (core/tools.ts:87-93)
    const cfg = rt.buildCfg(yolo, undefined);
    const ac = new AbortController(); // port #21: one controller per run
    rt.tasks.bindRun(ac.signal); // port #26: DELETE / disconnect / stop() also cancel the run's background tasks
    const run = agentLoop(def, text, {}, cfg, {
      stream, registry: rt.registry, store: rt.store,
      tools: rt.registry.list().map((t) => t.schema), guard: rt.guard, planReminder: rt.planReminder,
      hooks: rt.hooks, // port #29: .rovecode/hooks.{ts,js} of the server cwd
      cwd: rt.cwd, // session cwd reaches ToolContext (same gap as ACP HIGH-G1)
      signal: ac.signal, // port #21: DELETE / disconnect / stop() kill in-flight work
    }, rt.steering); // port #26: the session's queue — background-task notes land on the next prompt
    entry.running = true;
    entry.abort = ac;
    return sseResponse(tapped(run, (event) => busSend({ type: "run_event", session: id, event })), () => { entry.running = false; entry.abort = null; }, () => ac.abort());
  };

  /** The tap: a passthrough async generator that also forwards every event to the
   *  bus. Delegation (yield* → return/throw) preserves cancel semantics — the SSE
   *  pump aborting the original generator still unwinds it exactly once. */
  async function* tapped(run: AsyncGenerator<RunEvent>, send: (event: RunEvent) => void): AsyncGenerator<RunEvent> {
    const it = run[Symbol.asyncIterator]();
    try {
      while (true) {
        const r = await it.next();
        if (r.done) return;
        send(r.value);
        yield r.value;
      }
    } finally {
      if (it.return) await it.return(undefined);
    }
  }

  /** GET /events — the bus as SSE. First frame is a hello snapshot (known session
   *  ids); from then on frames are live. idleTimeout 0 keeps it open forever — the
   *  stream is the server lifetime, not a run lifetime. */
  const events = (): Response => {
    const stream = new ReadableStream<string>({
      start(controller) {
        const listener = (frame: string): void => {
          try { controller.enqueue(frame); } catch { bus.delete(listener); }
        };
        bus.add(listener);
        controller.enqueue(`data: ${JSON.stringify({ type: "hello", sessions: [...sessions.keys()] })}\n\n`);
      },
    });
    return new Response(
      stream.pipeThrough(new TransformStream<string, Uint8Array>({ transform(chunk, c) { c.enqueue(new TextEncoder().encode(chunk)); } })),
      { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" } },
    );
  };

  /** DELETE /session/:id/prompt — cancel the in-flight run (port #21). Aborting
   *  the controller kills the provider fetch / tool subprocesses; the run's own
   *  SSE stream then ends with run_end status "stopped". `running` still clears
   *  only from the pump's settle, so the 409 invariant is untouched: the session
   *  frees when the generator has actually released it. opencode exposes the
   *  same operation as POST /session/:sessionID/abort → SessionPrompt.cancel
   *  (routes/instance/httpapi/groups/session.ts:91,253; handlers/session.ts:232). */
  const cancelPrompt = (id: string): Response => {
    const entry = sessions.get(id);
    if (!entry) return json({ error: `unknown session ${id}` }, 404);
    const live = entry.abort !== null;
    entry.abort?.abort();
    return json({ cancelled: live });
  };

  /** GET /session/:id/tasks — background-task status (port #26): the session runtime's
   *  TaskManager snapshot (TaskInfo[], oldest first). opencode exposes the same registry
   *  through its job service (packages/core/src/background-job.ts list/get). */
  const listTasks = (id: string): Response => {
    const entry = sessions.get(id);
    if (!entry) return json({ error: `unknown session ${id}` }, 404);
    return json(entry.runtime.tasks.list());
  };

  const route = async (req: Request): Promise<Response> => {
    const path = new URL(req.url).pathname;
    if (req.method === "POST" && path === "/session") return createSession();
    const m = /^\/session\/([^/]+)\/prompt$/.exec(path);
    if (req.method === "POST" && m) return prompt(m[1]!, req);
    if (req.method === "DELETE" && m) return cancelPrompt(m[1]!);
    const t = /^\/session\/([^/]+)\/tasks$/.exec(path);
    if (req.method === "GET" && t) return listTasks(t[1]!);
    if (req.method === "GET" && path === "/sessions") return json(listSessions(sessionsRoot));
    if (req.method === "GET" && path === "/events") return events();
    if (req.method === "GET" && path === "/ui") return new Response(dashboardHtml(), { headers: { "content-type": "text/html; charset=utf-8" } });
    if (req.method === "GET" && path === "/doc") return json(buildOpenApiDoc(api.url));
    return json({ error: `no route for ${req.method} ${path}` }, 404);
  };

  const server = Bun.serve({
    hostname,
    port: opts.port ?? DEFAULT_PORT,
    idleTimeout: 0, // SSE runs outlive Bun's default idle timeout
    // transport ceiling (LOW-MED-F4): bodies without/with a lying content-length
    // are cut here (socket close); declared oversizes get a clean 413 in prompt()
    maxRequestBodySize: MAX_BODY_BYTES * 2,
    async fetch(req) {
      // never-throw seam: handler exceptions become JSON 500s, the server survives
      try { return await route(req); }
      catch (e) { return json({ error: e instanceof Error ? e.message : String(e) }, 500); }
    },
  });

  const api: RovecodeServer = {
    port: server.port ?? 0,
    hostname,
    url: `http://${hostname}:${server.port}`,
    async stop() {
      await server.stop(true);
      // port #21: abort every in-flight run — the provider fetch and tool
      // subprocesses die now instead of running on after the sockets closed.
      for (const entry of sessions.values()) entry.abort?.abort();
      for (const { runtime } of sessions.values()) runtime.tasks.cancelAll(); // port #26: background children die with the server, never after it
      // MED-F3: reap MCP children — every POST /session spawns one set via
      // createRuntime; without this an unauthenticated loopback port is an
      // unbounded local spawn primitive that outlives the server.
      const closing: Promise<unknown>[] = [];
      for (const { runtime } of sessions.values()) {
        runtime.bashJobs.dispose(); // #55: background shell jobs die with their session
        closing.push(runtime.hooks.close()); // port #29: session_close per session runtime
        if (runtime.mcp) closing.push(runtime.mcp.close().catch(() => {}));
      }
      await Promise.all(closing);
    },
  };
  return api;
}
