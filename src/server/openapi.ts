/** Hand-authored OpenAPI 3.1 document for the rovecode server surface (port #19).
 *  opencode serves its spec at GET /doc — packages/opencode/src/server/routes/
 *  instance/httpapi/server.ts:190 (route) + :188 (lazy OpenApi.fromApi(PublicApi))
 *  — and generates its client SDK from that spec (packages/sdk/js, @hey-api/openapi-ts).
 *  Their spec is derived from Effect httpapi endpoint schemas; ADR-001 rejects Effect
 *  idioms, and this surface is five routes, so the object is written by hand — no
 *  codegen dependency, the doc IS the source of truth for what the server exposes. */

/** Honesty note (bar requirement): served verbatim in the doc so HTTP clients know
 *  interactive approvals do not exist in v1. */
export const APPROVALS_NOTE =
  "v1 approvals are policy-only: the server runs with rule-based permissions and has no " +
  "interactive approver over HTTP. A tool call whose permission rule resolves to effect " +
  "\"prompt\" is NOT paused for approval — it surfaces as a failed tool call " +
  "(tool_call_failed, reason permission_denied, \"approval required but no approver " +
  "connected\") and the run continues. Start the server with --yolo (allow-all rules) " +
  "or provide allow rules to let gated tools run.";

/** RunEvent discriminator values (src/core/types.ts RunEvent union). Hand-listed:
 *  types are erased at runtime, and the doc is hand-authored by design. */
export const RUN_EVENT_TYPES = [
  "run_start", "turn_start", "message_update", "reasoning_update",
  "tool_execution_start", "tool_execution_update", "tool_execution_end",
  "tool_call_failed", "compaction", "turn_end", "steer", "run_end",
] as const;

const errorResponse = (description: string) => ({
  description,
  content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
});

/** Build the OpenAPI 3.1 object. `serverUrl` is the actually-bound base URL. */
export function buildOpenApiDoc(serverUrl: string): Record<string, unknown> {
  return {
    openapi: "3.1.0",
    info: {
      title: "rovecode server",
      version: "0.1.0",
      description:
        "Headless HTTP surface over the one rovecode agent loop (ADR-003). " +
        "Five routes: create a session, prompt it (SSE stream of typed run events; " +
        "DELETE the same path cancels the in-flight run mid-turn), " +
        "list its background tasks, list sessions, and this document. " + APPROVALS_NOTE,
    },
    servers: [{ url: serverUrl }],
    paths: {
      "/session": {
        post: {
          operationId: "session.create",
          summary: "Create a new session",
          description: "Creates a session backed by the append-only JSONL session store and returns its id.",
          responses: {
            "201": {
              description: "Session created",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["id"],
                    properties: { id: { type: "string", description: "Session id (also the session directory name)" } },
                  },
                },
              },
            },
          },
        },
      },
      "/session/{id}/prompt": {
        post: {
          operationId: "session.prompt",
          summary: "Run the agent loop on a session and stream its events",
          description:
            "Runs one agent loop over the session with the given text as the goal. " +
            "The response is a Server-Sent Events stream: each event is framed as " +
            "`event: <RunEvent.type>` + `data: <RunEvent JSON>`, and the stream closes " +
            "after the terminal run_end event. " + APPROVALS_NOTE,
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" }, description: "Session id from POST /session" },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["text"],
                  properties: {
                    text: { type: "string", description: "The user goal for this run" },
                    model: {
                      type: "object",
                      description: "Optional model override; defaults to the server's resolved provider/model",
                      required: ["provider", "model"],
                      properties: { provider: { type: "string" }, model: { type: "string" } },
                    },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "SSE stream of RunEvent frames; closes after run_end",
              content: { "text/event-stream": { schema: { $ref: "#/components/schemas/RunEvent" } } },
            },
            "400": errorResponse("Body is not JSON or lacks a string `text`"),
            "404": errorResponse("Unknown session id"),
            "409": errorResponse("A run is already in progress for this session"),
            "503": errorResponse("No provider configured — run `rovecode setup` (or rovecode provider add + rovecode auth set, or set ROVECODE_BASE_URL/ROVECODE_API_KEY)"),
          },
        },
        delete: {
          operationId: "session.cancel",
          summary: "Cancel the in-flight run on a session",
          description:
            "Aborts the running prompt's AbortController: the in-flight provider fetch and " +
            "tool subprocesses are killed mid-turn, and the run's SSE stream ends with a " +
            "run_end event of status \"stopped\". The session stays busy (409 on new prompts) " +
            "until that stream has actually settled. Idempotent: cancelling an idle session " +
            "returns cancelled: false.",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" }, description: "Session id from POST /session" },
          ],
          responses: {
            "200": {
              description: "Cancellation signalled (cancelled: true) or nothing was running (cancelled: false)",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["cancelled"],
                    properties: { cancelled: { type: "boolean" } },
                  },
                },
              },
            },
            "404": errorResponse("Unknown session id"),
          },
        },
      },
      "/session/{id}/tasks": {
        get: {
          operationId: "session.tasks",
          summary: "List the session's background subagent tasks",
          description:
            "Snapshot of the session's background tasks (port #26): child agent sessions started by " +
            "the `task` tool, oldest first, with status queued|running|done|failed|cancelled, timing, " +
            "the child's final text (done) or error (failed). Tasks are process-local and not durable " +
            "across server restarts. Completion notes reach the model as steering on the session's next prompt.",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" }, description: "Session id from POST /session" },
          ],
          responses: {
            "200": {
              description: "Task snapshots",
              content: {
                "application/json": {
                  schema: { type: "array", items: { $ref: "#/components/schemas/TaskInfo" } },
                },
              },
            },
            "404": errorResponse("Unknown session id"),
          },
        },
      },
      "/sessions": {
        get: {
          operationId: "session.list",
          summary: "List sessions",
          description: "Scans the session root and returns summaries, sorted by updatedAt descending. Corrupt or foreign directories are skipped, never errors.",
          responses: {
            "200": {
              description: "Session summaries",
              content: {
                "application/json": {
                  schema: { type: "array", items: { $ref: "#/components/schemas/SessionSummary" } },
                },
              },
            },
          },
        },
      },
      "/doc": {
        get: {
          operationId: "doc",
          summary: "This OpenAPI 3.1 document",
          description: "Returns the OpenAPI 3.1 JSON describing exactly this server surface.",
          responses: {
            "200": { description: "OpenAPI 3.1 document", content: { "application/json": { schema: { type: "object" } } } },
          },
        },
      },
    },
    components: {
      schemas: {
        Error: {
          type: "object",
          required: ["error"],
          properties: { error: { type: "string" } },
        },
        SessionSummary: {
          type: "object",
          required: ["id", "createdAt", "updatedAt", "entryCount", "preview"],
          properties: {
            id: { type: "string" },
            createdAt: { type: "number" },
            updatedAt: { type: "number" },
            entryCount: { type: "number" },
            preview: { type: "string", description: "First user-message text, single line, ≤80 chars" },
          },
        },
        RunEvent: {
          type: "object",
          description:
            "Typed agent-loop event (src/core/types.ts RunEvent union), discriminated by `type`. " +
            "The SSE `event:` field always equals this `type` field.",
          required: ["type"],
          properties: {
            type: { type: "string", enum: [...RUN_EVENT_TYPES] },
          },
          additionalProperties: true,
        },
        TaskInfo: {
          type: "object",
          description: "Background subagent task snapshot (src/core/tasks.ts TaskInfo).",
          required: ["id", "label", "agent", "goal", "isolated", "depth", "status", "createdAt"],
          properties: {
            id: { type: "string", description: "Task id (t1, t2, …; scoped to the session)" },
            label: { type: "string" },
            agent: { type: "string", description: "Agent definition the child runs" },
            goal: { type: "string", description: "Bounded preview of the child's goal (≤200 chars)" },
            isolated: { type: "boolean", description: "Ran in a worktree copy; file changes merge back as a patch on success" },
            depth: { type: "number", description: "Child depth (root-started tasks run at 1)" },
            status: { type: "string", enum: ["queued", "running", "done", "failed", "cancelled"] },
            createdAt: { type: "number" },
            startedAt: { type: "number" },
            finishedAt: { type: "number" },
            summary: { type: "string", description: "The child's final text (status done), ≤4000 chars" },
            error: { type: "string", description: "Failure reason (status failed) or \"cancelled\"" },
            usage: { type: "object", properties: { input: { type: "number" }, output: { type: "number" } } },
            patchLines: { type: "number", description: "Isolated children: line count of the merged-back patch" },
          },
        },
      },
    },
  };
}
