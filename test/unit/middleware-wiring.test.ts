/** Port #7 wiring tests: drive the REAL runtime.ts + stream.ts path (no injected stream).
 *
 *  A local Bun.serve stub plays an OpenAI-compatible /chat/completions endpoint whose "model"
 *  has no native tool calling — it answers with hermes markup in message.content. Asserts:
 *  - createRuntime wraps provider streams in withToolCallParsing (markup → tool_call parts)
 *  - ROVECODE_NO_TOOL_MIDDLEWARE=1 disables the wrap (raw markup text passes through)
 *  - the SECOND hop's real request body (stream.ts toOpenAiMessages) carries no native tool
 *    artifacts: no `tools`, no `tool_calls`, no role:"tool" — history is lowered to protocol text
 *  - buildDef injects toolPromptBlock for catalog-known non-native models (and on
 *    ROVECODE_TOOL_MIDDLEWARE=1), and NOT for native models. */

import { test, expect, beforeAll, afterAll } from "bun:test";
import { createRuntime } from "../../src/cli/runtime.ts";
import type { AssistantTurn, Message, MessagePart, Role, StreamEvent, ToolSchema } from "../../src/core/types.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------- OpenAI-compatible stub endpoint ----------

interface WireBody {
  model?: string;
  tools?: unknown[];
  messages?: { role: string; content?: string | null; tool_calls?: unknown[] }[];
}

const requestBodies: WireBody[] = [];
let reply =
  'On it.\n<tool_call>\n{"name": "read", "arguments": {"path": "a.ts"}}\n</tool_call>';

const server = Bun.serve({
  port: 0,
  fetch: async (req) => {
    requestBodies.push((await req.json()) as WireBody);
    return Response.json({
      choices: [{ message: { content: reply }, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 5 },
    });
  },
});

// ---------- env harness (bun runs test files in one process — always restore) ----------

const ENV_KEYS = [
  "ROVECODE_BASE_URL", "ROVECODE_API_KEY", "ROVECODE_MODEL",
  "ROVECODE_NO_TOOL_MIDDLEWARE", "ROVECODE_TOOL_MIDDLEWARE",
] as const;
const savedEnv = new Map<string, string | undefined>();
const tmpDirs: string[] = [];

beforeAll(() => {
  for (const k of ENV_KEYS) savedEnv.set(k, process.env[k]);
  delete process.env.ROVECODE_NO_TOOL_MIDDLEWARE;
  delete process.env.ROVECODE_TOOL_MIDDLEWARE;
  process.env.ROVECODE_BASE_URL = `http://127.0.0.1:${server.port}/v1`;
  process.env.ROVECODE_API_KEY = "test-key";
});

afterAll(() => {
  for (const k of ENV_KEYS) {
    const v = savedEnv.get(k);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  server.stop(true);
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

// ---------- helpers ----------

function tmpCwd(): string {
  const d = mkdtempSync(join(tmpdir(), "rovecode-mw-wiring-"));
  tmpDirs.push(d);
  return d;
}

function mkMsg(role: Role, parts: MessagePart[]): Message {
  return { id: crypto.randomUUID(), role, parts, parentId: null, createdAt: Date.now() };
}

const readSchema: ToolSchema = {
  name: "read",
  description: "Read a file",
  args: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
};

/** Drive one turn through the runtime's REAL provider stream. `withTools` mirrors the loop's
 *  LoopDeps.tools shape (plain ToolSchema[], repl.ts:85 / main.ts:91 / tui/app.ts:257).
 *  KNOWN LIMITATION (pre-existing stream.ts bug, outside this port's file ownership):
 *  toOpenAiToolSchemas expects `{schema}`-wrapped tools, so a request that still CARRIES tools
 *  crashes into an error turn. Hop 1 therefore drives without tools; hop 2 passes them and
 *  relies on MED-2 lowering to strip them before the provider adapter ever sees them. */
async function driveTurn(rt: ReturnType<typeof createRuntime>, messages: Message[], withTools = false): Promise<AssistantTurn> {
  if (!rt.stream) throw new Error("runtime has no stream — provider not resolved from env");
  let turn: AssistantTurn | undefined;
  const events: StreamEvent[] = [];
  const options = withTools ? { tools: [readSchema] } : {};
  for await (const ev of rt.stream({ provider: "custom", model: "no-tools-model" }, messages, options)) {
    events.push(ev);
    if (ev.type === "turn") turn = ev.turn;
  }
  if (!turn) throw new Error(`no terminal turn (got ${events.map((e) => e.type).join(",")})`);
  return turn;
}

// ---------- provider stream wrapping ----------

test("real wiring: provider stream is wrapped — hermes markup becomes tool_call parts", async () => {
  const rt = createRuntime({ cwd: tmpCwd() });
  const turn = await driveTurn(rt, [mkMsg("user", [{ kind: "text", text: "read a.ts" }])]);
  expect(turn.stopReason).toBe("tool_use");
  const call = turn.parts.find((p) => p.kind === "tool_call");
  if (call?.kind !== "tool_call") throw new Error(`expected tool_call part, got ${JSON.stringify(turn.parts)}`);
  expect(call.tool).toBe("read");
  expect(call.args).toEqual({ path: "a.ts" });
  expect(call.id).toMatch(/^textcall_[0-9a-f]{8}_\d+$/);
  expect(turn.parts[0]).toEqual({ kind: "text", text: "On it." });
});

test("real wiring: ROVECODE_NO_TOOL_MIDDLEWARE=1 leaves the raw stream unwrapped", async () => {
  process.env.ROVECODE_NO_TOOL_MIDDLEWARE = "1";
  try {
    const rt = createRuntime({ cwd: tmpCwd() });
    const turn = await driveTurn(rt, [mkMsg("user", [{ kind: "text", text: "read a.ts" }])]);
    expect(turn.stopReason).toBe("end_turn");
    expect(turn.parts.some((p) => p.kind === "tool_call")).toBe(false);
    expect(turn.parts).toEqual([{ kind: "text", text: reply }]); // markup stays raw text
  } finally {
    delete process.env.ROVECODE_NO_TOOL_MIDDLEWARE;
  }
});

test("real wiring: second-hop request BODY is lowered — no tools / tool_calls / role tool", async () => {
  const rt = createRuntime({ cwd: tmpCwd() });
  // hop 1 mints the textcall id
  const user = mkMsg("user", [{ kind: "text", text: "read a.ts" }]);
  const turn1 = await driveTurn(rt, [user]);
  const minted = turn1.parts.find((p) => p.kind === "tool_call");
  if (minted?.kind !== "tool_call") throw new Error("expected minted tool_call");

  // hop 2 exactly as core/loop.ts builds it
  const history: Message[] = [
    user,
    mkMsg("assistant", turn1.parts),
    mkMsg("tool", [{ kind: "tool_result", callId: minted.id, ok: true, output: "file contents" }]),
  ];
  reply = "Thanks, done.";
  try {
    // hop 2 passes tools like the loop does; MED-2 lowering must strip them from the request
    const turn2 = await driveTurn(rt, history, true);
    expect(turn2.stopReason).toBe("end_turn");
  } finally {
    reply = 'On it.\n<tool_call>\n{"name": "read", "arguments": {"path": "a.ts"}}\n</tool_call>';
  }

  const body = requestBodies.at(-1);
  if (!body) throw new Error("stub saw no request");
  // a genuinely non-native model can consume every part of this body
  expect(body.tools).toBeUndefined();
  expect(body.messages?.some((m) => m.role === "tool")).toBe(false);
  expect(body.messages?.some((m) => Array.isArray(m.tool_calls))).toBe(false);
  const assistant = body.messages?.find((m) => m.role === "assistant");
  expect(assistant?.content).toContain("<tool_call>");
  expect(assistant?.content).toContain('"name":"read"');
  const responses = (body.messages ?? []).filter((m) => m.role === "user" && typeof m.content === "string" && m.content.includes("<tool_response>"));
  expect(responses).toHaveLength(1);
  expect(responses[0]?.content).toContain('"content":"file contents"');
});

// ---------- buildDef prompt injection ----------

test("buildDef: catalog-known non-native model gets the toolPromptBlock", () => {
  const rt = createRuntime({ cwd: tmpCwd(), stream: null });
  const def = rt.buildDef({ provider: "openai", model: "gpt-3.5-turbo" }); // snapshot: tool_call false
  if (typeof def.systemPrompt !== "string") throw new Error("expected string systemPrompt");
  expect(def.systemPrompt).toContain("# Tool calling");
  expect(def.systemPrompt).toContain("<tool_call>"); // advertises the exact markup we parse
  expect(def.systemPrompt).toContain('"name": "read"'); // registry tools rendered
});

test("buildDef: native model gets NO toolPromptBlock; ROVECODE_TOOL_MIDDLEWARE=1 forces it", () => {
  const rt = createRuntime({ cwd: tmpCwd(), stream: null });
  const native = rt.buildDef({ provider: "openai", model: "gpt-4o" }); // snapshot: tool_call true
  if (typeof native.systemPrompt !== "string") throw new Error("expected string systemPrompt");
  expect(native.systemPrompt).not.toContain("# Tool calling");

  // unknown models attempt native first — no block either
  const unknown = rt.buildDef({ provider: "custom", model: "no-tools-model" });
  if (typeof unknown.systemPrompt !== "string") throw new Error("expected string systemPrompt");
  expect(unknown.systemPrompt).not.toContain("# Tool calling");

  process.env.ROVECODE_TOOL_MIDDLEWARE = "1";
  try {
    const forced = rt.buildDef({ provider: "openai", model: "gpt-4o" });
    if (typeof forced.systemPrompt !== "string") throw new Error("expected string systemPrompt");
    expect(forced.systemPrompt).toContain("# Tool calling");
    expect(forced.systemPrompt).toContain("<tool_call>");
  } finally {
    delete process.env.ROVECODE_TOOL_MIDDLEWARE;
  }
});
