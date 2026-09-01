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
import { createRuntime, type Runtime } from "../cli/runtime.ts";
import { agentLoop, SteeringQueue } from "../core/loop.ts";
import { listSessions } from "../core/session.ts";
import type { ModelRef, RunEvent, StreamFn } from "../core/types.ts";
import { buildOpenApiDoc } from "./openapi.ts";

export const DEFAULT_PORT = 4100;
export const DEFAULT_HOSTNAME = "127.0.0.1";

export interface ServerOptions {
  /** TCP port; default 4100; 0 = ephemeral (tests) */
  port?: number;
  /** bind address; default 127.0.0.1 (loopback-only, opencode cli/network.ts:15) */
  hostname?: string;
  /** project root; sessions live in <cwd>/.aion/sessions */
  cwd?: string;
  /** injectable provider stream (tests); undefined = resolve from env; null = no stream */
  stream?: StreamFn | null;
  /** allow-all permission rules; default false = policy rules with prompt-effect
   *  gates, which FAIL over HTTP (no approver) — see APPROVALS_NOTE */
  yolo?: boolean;
}

export interface AionServer {
  port: number;
  hostname: string;
  url: string;
  /** closes listener AND in-flight SSE sockets (tests: no orphan sockets) */
  stop(): Promise<void>;
}

interface SessionEntry { runtime: Runtime; running: boolean }

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
 *  Client disconnects cancel the generator, which aborts in-flight tools via
 *  the loop's cooperative-abort finally (core/loop.ts:199-203). */
function sseResponse(run: AsyncGenerator<RunEvent>, onSettled: () => void): Response {
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
      // client hung up mid-run: resume the generator's finally blocks (tool abort)
      void Promise.resolve(run.return(undefined)).catch(() => {});
      settle();
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

export function startServer(opts: ServerOptions = {}): AionServer {
  const hostname = opts.hostname ?? DEFAULT_HOSTNAME;
  const cwd = opts.cwd ?? process.cwd();
  const sessionsRoot = join(cwd, ".aion", "sessions");
  const yolo = opts.yolo ?? false;
  const sessions = new Map<string, SessionEntry>();

  const createSession = (): Response => {
    const id = randomUUID();
    // Reuse the ONE runtime construction every surface uses (cli/runtime.ts):
    // same stores, same tools, same provider resolution. Injectable stream for tests.
    const runtime = createRuntime({ cwd, sessionId: id, stream: opts.stream });
    sessions.set(id, { runtime, running: false });
    return json({ id }, 201);
  };

  const prompt = async (id: string, req: Request): Promise<Response> => {
    const entry = sessions.get(id);
    if (!entry) return json({ error: `unknown session ${id}` }, 404);
    let body: unknown;
    try { body = await req.json(); } catch { return json({ error: "body must be JSON" }, 400); }
    const text = bodyText(body);
    if (text === null) return json({ error: 'body must be {"text": string}' }, 400);
    if (entry.running) return json({ error: "a run is already in progress for this session" }, 409);
    const rt = entry.runtime;
    const stream = rt.stream;
    if (!stream) return json({ error: "no provider configured (set AION_BASE_URL/AION_API_KEY or a named provider key)" }, 503);
    const model: ModelRef = bodyModel(body) ?? { provider: rt.provider?.id ?? "mock", model: rt.defaultModel || "default" };
    const def = rt.buildDef(model);
    // policy-only approvals (bar): NO ApprovalFn — prompt-effect rules fail the
    // tool call as tool_call_failed/permission_denied (core/tools.ts:87-93)
    const cfg = rt.buildCfg(yolo, undefined);
    const run = agentLoop(def, text, {}, cfg, {
      stream, registry: rt.registry, store: rt.store,
      tools: rt.registry.list().map((t) => t.schema), guard: rt.guard,
    }, new SteeringQueue());
    entry.running = true;
    return sseResponse(run, () => { entry.running = false; });
  };

  const route = async (req: Request): Promise<Response> => {
    const path = new URL(req.url).pathname;
    if (req.method === "POST" && path === "/session") return createSession();
    const m = /^\/session\/([^/]+)\/prompt$/.exec(path);
    if (req.method === "POST" && m) return prompt(m[1]!, req);
    if (req.method === "GET" && path === "/sessions") return json(listSessions(sessionsRoot));
    if (req.method === "GET" && path === "/doc") return json(buildOpenApiDoc(api.url));
    return json({ error: `no route for ${req.method} ${path}` }, 404);
  };

  const server = Bun.serve({
    hostname,
    port: opts.port ?? DEFAULT_PORT,
    idleTimeout: 0, // SSE runs outlive Bun's default idle timeout
    async fetch(req) {
      // never-throw seam: handler exceptions become JSON 500s, the server survives
      try { return await route(req); }
      catch (e) { return json({ error: e instanceof Error ? e.message : String(e) }, 500); }
    },
  });

  const api: AionServer = {
    port: server.port ?? 0,
    hostname,
    url: `http://${hostname}:${server.port}`,
    async stop() { await server.stop(true); },
  };
  return api;
}
