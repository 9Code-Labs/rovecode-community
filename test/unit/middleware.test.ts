import { test, expect } from "bun:test";
import { parseToolCalls, toolPromptBlock, withToolCallParsing } from "../../src/providers/middleware.ts";
import type { AssistantTurn, Message, MessagePart, ModelRef, Role, StreamEvent, StreamFn, StreamOptions, ToolSchema } from "../../src/core/types.ts";

const model: ModelRef = { provider: "test", model: "m" };
const messages: Message[] = [];

// The "antml:" namespace is assembled at runtime so this source file never contains
// namespaced tool-call markup literally (it would confuse markup-aware tooling).
const NS = "ant" + "ml:";
const nsOpen = (body: string) => `<${NS}${body}>`;
const nsClose = (name: string) => `</${NS}${name}>`;

function fakeStream(events: StreamEvent[]): StreamFn {
  return async function* () {
    for (const e of events) yield e;
  };
}

async function collect(stream: StreamFn, opts?: Parameters<typeof withToolCallParsing>[1], streamOptions?: StreamOptions): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of withToolCallParsing(stream, opts)(model, messages, streamOptions)) out.push(e);
  return out;
}

function mkTurn(parts: MessagePart[], stopReason: AssistantTurn["stopReason"] = "end_turn"): AssistantTurn {
  return { parts, stopReason, usage: { input: 11, output: 7 } };
}

function asTurn(e: StreamEvent | undefined): AssistantTurn {
  if (!e || e.type !== "turn") throw new Error(`expected turn event, got ${e?.type}`);
  return e.turn;
}

// ---------- hermes-xml (senpi hermes.ts:6-7; wire format json-mix.ts:635-641) ----------

test("hermes: senpi wire format round-trips, markup fully removed", () => {
  const wire = `<tool_call>\n${JSON.stringify({ name: "read", arguments: { path: "a.ts" } })}\n</tool_call>`;
  const r = parseToolCalls(wire);
  expect(r.calls).toEqual([{ tool: "read", args: { path: "a.ts" } }]);
  expect(r.cleanText).toBe("");
});

test("hermes: multiple blocks with surrounding prose kept in order", () => {
  const text = [
    "I'll read the file first.",
    '<tool_call>{"name":"read","arguments":{"path":"src/a.ts"}}</tool_call>',
    "Then search for the pattern.",
    '<tool_call>{"name":"grep","arguments":{"pattern":"foo"}}</tool_call>',
    "Done.",
  ].join("\n");
  const r = parseToolCalls(text);
  expect(r.calls).toEqual([
    { tool: "read", args: { path: "src/a.ts" } },
    { tool: "grep", args: { pattern: "foo" } },
  ]);
  for (const prose of ["I'll read the file first.", "Then search for the pattern.", "Done."]) {
    expect(r.cleanText).toContain(prose);
  }
  expect(r.cleanText).not.toContain("<tool_call>");
});

test("hermes: relaxed JSON repairs trailing commas (json-mix.ts:114-133 ladder)", () => {
  const r = parseToolCalls('<tool_call>{"name":"read","arguments":{"path":"x",},}</tool_call>');
  expect(r.calls).toEqual([{ tool: "read", args: { path: "x" } }]);
});

test("hermes: 'parameters' accepted as args key; 'arguments' wins when both present", () => {
  const p = parseToolCalls('<tool_call>{"name":"ls","parameters":{"dir":"/tmp"}}</tool_call>');
  expect(p.calls).toEqual([{ tool: "ls", args: { dir: "/tmp" } }]);
  const both = parseToolCalls('<tool_call>{"name":"ls","arguments":{"a":1},"parameters":{"b":2}}</tool_call>');
  expect(both.calls).toEqual([{ tool: "ls", args: { a: 1 } }]);
});

test("hermes: malformed JSON keeps the raw block in cleanText, never throws", () => {
  const bad = 'before <tool_call>{"name": "read", "arguments": {oops</tool_call> after';
  const r = parseToolCalls(bad);
  expect(r.calls).toEqual([]);
  expect(r.cleanText).toContain('<tool_call>{"name": "read", "arguments": {oops</tool_call>');
  expect(r.cleanText).toContain("before");
  expect(r.cleanText).toContain("after");
});

test("hermes: JSON without the tool-call shape stays as text (json-mix.ts:135-161)", () => {
  const r = parseToolCalls('<tool_call>{"foo": 1}</tool_call>');
  expect(r.calls).toEqual([]);
  expect(r.cleanText).toContain('{"foo": 1}');
});

// ---------- json-fenced ----------

test("json-fenced: fenced tool call consumed, prose kept", () => {
  const text = 'Running the write now.\n```json\n{"name": "write", "arguments": {"path": "b.ts", "content": "hi"}}\n```';
  const r = parseToolCalls(text);
  expect(r.calls).toEqual([{ tool: "write", args: { path: "b.ts", content: "hi" } }]);
  expect(r.cleanText).toBe("Running the write now.");
});

test("json-fenced: single-line fence form", () => {
  const r = parseToolCalls('```json {"name":"read","arguments":{"path":"x"}} ```');
  expect(r.calls).toEqual([{ tool: "read", args: { path: "x" } }]);
  expect(r.cleanText).toBe("");
});

test("json-fenced: a random JSON block is NOT eaten", () => {
  const text = 'Sample response:\n```json\n{"users": [1, 2], "total": 2}\n```';
  const r = parseToolCalls(text);
  expect(r.calls).toEqual([]);
  expect(r.cleanText).toContain('{"users": [1, 2], "total": 2}');
  expect(r.cleanText).toContain("```json");
});

test("json-fenced: tool-shaped JSON with extraneous keys is NOT eaten (strict gate)", () => {
  const r = parseToolCalls('```json\n{"name": "cfg", "arguments": {}, "version": 3}\n```');
  expect(r.calls).toEqual([]);
  expect(r.cleanText).toContain('"version": 3');
});

test("json-fenced: unclosed fence is never parsed and text is preserved", () => {
  const r = parseToolCalls('```json\n{"name":"read","arguments":{}}');
  expect(r.calls).toEqual([]);
  expect(r.cleanText).toContain('{"name":"read","arguments":{}}');
});

// ---------- xml-function (senpi anthropic-xml invoke, invoke-tag-syntax.ts:5-15) ----------

test("xml-function: invoke block with coerced values round-trips", () => {
  const text =
    '<invoke name="grep"><parameter name="pattern">foo bar</parameter><parameter name="limit">5</parameter>' +
    '<parameter name="ci">true</parameter><parameter name="globs">["a/**","b/**"]</parameter></invoke>';
  const r = parseToolCalls(text);
  expect(r.calls).toEqual([{ tool: "grep", args: { pattern: "foo bar", limit: 5, ci: true, globs: ["a/**", "b/**"] } }]);
  expect(r.cleanText).toBe("");
});

test("xml-function: antml namespace, single quotes, XML entities decoded", () => {
  const text =
    nsOpen("invoke name='read'") +
    nsOpen("parameter name='path'") +
    "a &amp; b &lt;c&gt;.ts" +
    nsClose("parameter") +
    nsClose("invoke");
  const r = parseToolCalls(text);
  expect(r.calls).toEqual([{ tool: "read", args: { path: "a & b <c>.ts" } }]);
  expect(r.cleanText).toBe("");
});

test("xml-function: zero-parameter invoke yields empty args", () => {
  const r = parseToolCalls('please wait <invoke name="list_files"></invoke>');
  expect(r.calls).toEqual([{ tool: "list_files", args: {} }]);
  expect(r.cleanText).toBe("please wait");
});

test("xml-function: duplicate parameter names invalidate the call (coerce-parameters.ts:29-31)", () => {
  const text = '<invoke name="x"><parameter name="k">1</parameter><parameter name="k">2</parameter></invoke>';
  const r = parseToolCalls(text);
  expect(r.calls).toEqual([]);
  expect(r.cleanText).toContain('<invoke name="x">');
});

test("xml-function: unclosed invoke stays as text", () => {
  const text = '<invoke name="read"><parameter name="path">x';
  const r = parseToolCalls(text);
  expect(r.calls).toEqual([]);
  expect(r.cleanText).toBe(text);
});

test("xml-function: function_calls wrapper tags removed once an invoke is consumed", () => {
  const text = '<function_calls>\n<invoke name="read"><parameter name="path">x</parameter></invoke>\n</function_calls>';
  const r = parseToolCalls(text);
  expect(r.calls).toEqual([{ tool: "read", args: { path: "x" } }]);
  expect(r.cleanText).toBe("");
});

test("xml-function: multiline parameter value keeps interior newlines, trims boundary ones", () => {
  const text = '<invoke name="write"><parameter name="content">\nline1\nline2\n</parameter></invoke>';
  const r = parseToolCalls(text);
  expect(r.calls).toEqual([{ tool: "write", args: { content: "line1\nline2" } }]);
});

// ---------- mixed prose + formats, masking, options ----------

test("prose with two calls of different formats, document order preserved", () => {
  const text = [
    "First I read:",
    '<tool_call>{"name":"read","arguments":{"path":"a.ts"}}</tool_call>',
    "then I search:",
    '<invoke name="grep"><parameter name="pattern">foo</parameter></invoke>',
    "and report back.",
  ].join("\n");
  const r = parseToolCalls(text);
  expect(r.calls).toEqual([
    { tool: "read", args: { path: "a.ts" } },
    { tool: "grep", args: { pattern: "foo" } },
  ]);
  expect(r.cleanText).toContain("First I read:");
  expect(r.cleanText).toContain("then I search:");
  expect(r.cleanText).toContain("and report back.");
  expect(r.cleanText).not.toContain("<invoke");
});

test("markup inside inline code is not parsed (recovery-code-mask.ts semantics)", () => {
  const text = 'Use `<tool_call>{"name":"read","arguments":{}}</tool_call>` to call tools.';
  const r = parseToolCalls(text);
  expect(r.calls).toEqual([]);
  expect(r.cleanText).toBe(text);
});

test("markup inside a non-json code fence is not parsed", () => {
  const text = 'Example:\n```\n<tool_call>{"name":"read","arguments":{}}</tool_call>\n```';
  const r = parseToolCalls(text);
  expect(r.calls).toEqual([]);
  expect(r.cleanText).toContain("<tool_call>");
});

test("formats option restricts which parsers run", () => {
  const hermes = '<tool_call>{"name":"read","arguments":{}}</tool_call>';
  const invoke = '<invoke name="read"><parameter name="path">x</parameter></invoke>';
  expect(parseToolCalls(hermes, { formats: ["json-fenced"] }).calls).toEqual([]);
  expect(parseToolCalls(hermes, { formats: ["json-fenced"] }).cleanText).toBe(hermes);
  expect(parseToolCalls(invoke, { formats: ["hermes-xml"] }).calls).toEqual([]);
  expect(parseToolCalls(hermes, { formats: ["hermes-xml"] }).calls).toHaveLength(1);
});

// ---------- withToolCallParsing (StreamFn wrapper) ----------

test("turn with native tool_call parts passes through byte-identical", async () => {
  const nativeTurn: StreamEvent = {
    type: "turn",
    turn: mkTurn(
      [
        { kind: "text", text: 'ignore this markup: <tool_call>{"name":"read","arguments":{}}</tool_call>' },
        { kind: "tool_call", id: "native-1", tool: "read", args: { path: "a" } },
      ],
      "tool_use",
    ),
  };
  const out = await collect(fakeStream([nativeTurn]));
  expect(out).toHaveLength(1);
  expect(out[0]).toBe(nativeTurn); // same object reference: untouched
});

test("turn without markup passes through by reference", async () => {
  const plain: StreamEvent = { type: "turn", turn: mkTurn([{ kind: "text", text: "just words" }]) };
  const out = await collect(fakeStream([plain]));
  expect(out[0]).toBe(plain);
});

test("end-to-end: deltas pass through raw, terminal turn is rewritten", async () => {
  const markup = 'I will read it.\n<tool_call>{"name":"read","arguments":{"path":"a.ts"}}</tool_call>';
  const events: StreamEvent[] = [
    { type: "text_delta", text: "I will read it.\n<tool_call>" },
    { type: "text_delta", text: '{"name":"read","arguments":{"path":"a.ts"}}</tool_call>' },
    { type: "turn", turn: mkTurn([{ kind: "text", text: markup }]) },
  ];
  const out = await collect(fakeStream(events));
  expect(out).toHaveLength(3);
  expect(out[0]).toBe(events[0]); // text_delta passthrough unchanged (raw markup allowed)
  expect(out[1]).toBe(events[1]);
  const turn = asTurn(out[2]);
  expect(turn.stopReason).toBe("tool_use");
  expect(turn.usage).toEqual({ input: 11, output: 7 }); // usage preserved
  expect(turn.parts).toHaveLength(2);
  expect(turn.parts[0]).toEqual({ kind: "text", text: "I will read it." });
  const call = turn.parts[1];
  if (call?.kind !== "tool_call") throw new Error("expected tool_call part");
  expect(call.tool).toBe("read");
  expect(call.args).toEqual({ path: "a.ts" });
  expect(call.id.length).toBeGreaterThan(0);
});

test("rewritten turn: multiple calls get unique generated ids; pure-markup text part dropped", async () => {
  const text =
    '<tool_call>{"name":"read","arguments":{"path":"a"}}</tool_call>\n' +
    '<tool_call>{"name":"read","arguments":{"path":"b"}}</tool_call>';
  const out = await collect(fakeStream([{ type: "turn", turn: mkTurn([{ kind: "text", text }]) }]));
  const turn = asTurn(out[0]);
  expect(turn.stopReason).toBe("tool_use");
  const kinds = turn.parts.map((p) => p.kind);
  expect(kinds).toEqual(["tool_call", "tool_call"]); // cleanText empty → no text part
  const ids = turn.parts.flatMap((p) => (p.kind === "tool_call" ? [p.id] : []));
  expect(new Set(ids).size).toBe(2);
});

test("turn with unparseable markup only is not rewritten", async () => {
  const ev: StreamEvent = {
    type: "turn",
    turn: mkTurn([{ kind: "text", text: "<tool_call>{nope}</tool_call>" }]),
  };
  const out = await collect(fakeStream([ev]));
  expect(out[0]).toBe(ev);
  expect(asTurn(out[0]).stopReason).toBe("end_turn");
});

test("wrapper honours the formats option", async () => {
  const ev: StreamEvent = {
    type: "turn",
    turn: mkTurn([{ kind: "text", text: '<tool_call>{"name":"read","arguments":{}}</tool_call>' }]),
  };
  const out = await collect(fakeStream([ev]), { formats: ["xml-function"] });
  expect(out[0]).toBe(ev); // hermes disabled → untouched
});

// ---------- toolPromptBlock (senpi hermes.ts:27-40) ----------

const tools: ToolSchema[] = [
  { name: "read", description: "Read a file", args: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "grep", description: "Search files", args: { type: "object", properties: { pattern: { type: "string" } } } },
];

test("toolPromptBlock is deterministic and mentions every tool name", () => {
  const a = toolPromptBlock(tools);
  const b = toolPromptBlock(tools);
  expect(a).toBe(b);
  for (const t of tools) {
    expect(a).toContain(`"name": ${JSON.stringify(t.name)}`);
    expect(a).toContain(JSON.stringify(t.description));
  }
  // Advertises the exact markup the parser accepts (senpi hermes prompt, hermes.ts:36-39).
  expect(a).toContain("<tool_call>");
  expect(a).toContain('{"name": "<function-name>", "arguments": <args-dict>}');
  expect(a).toContain("<tools>");
});

test("toolPromptBlock: prompt output parses back to a call (prompt/parser agreement)", () => {
  // A model following the advertised format emits exactly this shape:
  const emission = `<tool_call>\n{"name": "read", "arguments": {"path": "x.ts"}}\n</tool_call>`;
  const r = parseToolCalls(emission);
  expect(r.calls).toEqual([{ tool: "read", args: { path: "x.ts" } }]);
});

test("toolPromptBlock: empty tool list yields empty block (hermes.ts:28-30)", () => {
  expect(toolPromptBlock([])).toBe("");
});

// ---------- strict fence gate: function DEFINITIONS are not calls (MED-1) ----------

test("json-fenced: echoed function DEFINITION ({name, parameters} JSON-Schema shape) stays text", () => {
  // "parameters" is the canonical JSON-Schema function-definition key. A model ECHOING a
  // definition in a ```json fence must keep its text — no phantom call minted from the schema.
  const def = '{"name": "get_weather", "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}}';
  const text = "The tool is declared like this:\n```json\n" + def + "\n```";
  const r = parseToolCalls(text);
  expect(r.calls).toEqual([]);
  expect(r.cleanText).toBe(text);
  // hermes markup (non-strict) still accepts "parameters" as the args key — only the fence gate changed
  expect(parseToolCalls('<tool_call>{"name":"ls","parameters":{"dir":"/"}}</tool_call>').calls)
    .toEqual([{ tool: "ls", args: { dir: "/" } }]);
});

// ---------- repair ladder: one discriminating case per rung (json-mix.ts:73-112) ----------

test("repair ladder: quote-mismatched key is the ONLY repair needed (normalizeMalformedObjectKeys)", () => {
  // `"path':` — raw parse fails, no trailing commas, already braced, closers balanced:
  // only the quote-normalization rung can save this input.
  const r = parseToolCalls(`<tool_call>{"name":"read","arguments":{"path':"x"}}</tool_call>`);
  expect(r.calls).toEqual([{ tool: "read", args: { path: "x" } }]);
});

test("repair ladder: bare key:value body is the ONLY repair needed (ensureObjectDelimiters)", () => {
  // No outer braces — raw parse fails, no trailing commas, no quote mismatch, no excess
  // closers: only the brace-wrapping rung can save this input.
  const r = parseToolCalls('<tool_call>"name": "read", "arguments": {"path": "x"}</tool_call>');
  expect(r.calls).toEqual([{ tool: "read", args: { path: "x" } }]);
});

test("repair ladder: excess trailing closer is the ONLY repair needed (trimExcessTrailingClosers)", () => {
  // One `}` too many — every earlier rung leaves the string unparseable; only the
  // excess-closer trim rung can save this input.
  const r = parseToolCalls('<tool_call>{"name":"read","arguments":{"path":"x"}}}</tool_call>');
  expect(r.calls).toEqual([{ tool: "read", args: { path: "x" } }]);
});

// ---------- masking + fence info edge cases ----------

test("invoke markup inside inline code is not parsed (antml/xml path of the masked() guard)", () => {
  const text = 'Call it like `<invoke name="read"><parameter name="path">x</parameter></invoke>` in one line.';
  const r = parseToolCalls(text);
  expect(r.calls).toEqual([]);
  expect(r.cleanText).toBe(text); // markup intact, function_calls scrub NOT applied
});

test("fence info matching is case-insensitive: ```JSON parses like ```json", () => {
  const r = parseToolCalls('```JSON\n{"name":"read","arguments":{"path":"x"}}\n```');
  expect(r.calls).toEqual([{ tool: "read", args: { path: "x" } }]);
  expect(r.cleanText).toBe("");
});

// ---------- tool-catalog gating (MED-3; senpi json-mix.ts:146, parse.ts:15-17) ----------

test("catalog gating: hermes markup naming an unknown tool stays as text", () => {
  // Prose EXPLAINING the format must not mint a call for a nonexistent tool.
  const text = 'To call a tool, emit\n<tool_call>{"name":"launch_missiles","arguments":{}}</tool_call>\nand wait.';
  const r = parseToolCalls(text, { tools: ["read", "grep"] });
  expect(r.calls).toEqual([]);
  expect(r.cleanText).toBe(text);
  // the same markup with a known tool still parses
  const ok = parseToolCalls('<tool_call>{"name":"read","arguments":{"path":"x"}}</tool_call>', { tools: ["read", "grep"] });
  expect(ok.calls).toEqual([{ tool: "read", args: { path: "x" } }]);
});

test("catalog gating applies to invoke and json-fenced formats too", () => {
  const inv = '<invoke name="ghost"><parameter name="x">1</parameter></invoke>';
  const rInv = parseToolCalls(inv, { tools: ["read"] });
  expect(rInv.calls).toEqual([]);
  expect(rInv.cleanText).toBe(inv);
  const fence = '```json\n{"name":"ghost","arguments":{}}\n```';
  const rFence = parseToolCalls(fence, { tools: ["read"] });
  expect(rFence.calls).toEqual([]);
  expect(rFence.cleanText).toBe(fence);
  expect(parseToolCalls('<invoke name="read"><parameter name="path">x</parameter></invoke>', { tools: ["read"] }).calls)
    .toEqual([{ tool: "read", args: { path: "x" } }]);
});

test("catalog gating: empty catalog parses nothing; absent catalog keeps structural gating", () => {
  const markup = '<tool_call>{"name":"read","arguments":{}}</tool_call>';
  const gated = parseToolCalls(markup, { tools: [] });
  expect(gated.calls).toEqual([]);
  expect(gated.cleanText).toBe(markup);
  expect(parseToolCalls(markup).calls).toHaveLength(1); // no catalog → structural only
});

test("wrapper: parsed calls are gated by the names in StreamOptions.tools", async () => {
  const text =
    'unknown: <tool_call>{"name":"ghost","arguments":{}}</tool_call>\n' +
    'known: <tool_call>{"name":"read","arguments":{"path":"x"}}</tool_call>';
  const ev: StreamEvent = { type: "turn", turn: mkTurn([{ kind: "text", text }]) };
  const out = await collect(fakeStream([ev]), undefined, { tools });
  const turn = asTurn(out[0]);
  const calls = turn.parts.filter((p) => p.kind === "tool_call");
  expect(calls).toEqual([expect.objectContaining({ kind: "tool_call", tool: "read", args: { path: "x" } })]);
  const rest = turn.parts.filter((p) => p.kind === "text").map((p) => p.text).join("\n");
  expect(rest).toContain('<tool_call>{"name":"ghost","arguments":{}}</tool_call>'); // unknown markup kept as text
});

// ---------- minted ids (LOW-4: resume-collision guard) ----------

test("minted ids carry a per-process nonce and stay unique across wrapper instances", async () => {
  const mkEvents = (): StreamEvent[] => [
    { type: "turn", turn: mkTurn([{ kind: "text", text: '<tool_call>{"name":"read","arguments":{}}</tool_call>' }]) },
  ];
  const a = asTurn((await collect(fakeStream(mkEvents())))[0]); // collect() builds a fresh wrapper
  const b = asTurn((await collect(fakeStream(mkEvents())))[0]); // second, independent wrapper
  const ids = [...a.parts, ...b.parts].flatMap((p) => (p.kind === "tool_call" ? [p.id] : []));
  expect(ids).toHaveLength(2);
  expect(new Set(ids).size).toBe(2); // no collision between instances
  for (const id of ids) expect(id).toMatch(/^textcall_[0-9a-f]{8}_\d+$/);
  // same process → same nonce ("textcall_" + 8 hex chars); a restart re-seeds it, so
  // replayed textcall ids from a resumed session can never collide with fresh ones.
  expect(ids[0]?.slice(0, 17)).toBe(ids[1]?.slice(0, 17));
});

// ---------- context lowering (MED-2; senpi context-transformer.ts:165-181, 209-261) ----------

function mkMsg(role: Role, parts: MessagePart[]): Message {
  return { id: crypto.randomUUID(), role, parts, parentId: null, createdAt: Date.now() };
}

function capturingStream(events: StreamEvent[]): { stream: StreamFn; seen: { messages: Message[]; options: StreamOptions | undefined }[] } {
  const seen: { messages: Message[]; options: StreamOptions | undefined }[] = [];
  const stream: StreamFn = async function* (_model, msgs, options) {
    seen.push({ messages: msgs, options });
    for (const e of events) yield e;
  };
  return { stream, seen };
}

async function drain(stream: AsyncIterable<StreamEvent>): Promise<void> {
  for await (const _ of stream) { /* drain */ }
}

test("two-hop round-trip: follow-up request is lowered to text protocol", async () => {
  // hop 1: non-native model emits markup; the wrapper mints textcall_* tool_call parts
  const markup = 'Reading now.\n<tool_call>\n{"name":"read","arguments":{"path":"a.ts"}}\n</tool_call>';
  const hop1 = await collect(fakeStream([{ type: "turn", turn: mkTurn([{ kind: "text", text: markup }]) }]), undefined, { tools });
  const turn1 = asTurn(hop1[0]);
  const minted = turn1.parts.find((p) => p.kind === "tool_call");
  if (minted?.kind !== "tool_call") throw new Error("expected minted tool_call");
  expect(minted.id.startsWith("textcall_")).toBe(true);

  // hop 2: history exactly as core/loop.ts appends it (assistant turn parts + role:"tool" result)
  const history: Message[] = [
    mkMsg("user", [{ kind: "text", text: "read a.ts please" }]),
    mkMsg("assistant", turn1.parts),
    mkMsg("tool", [{ kind: "tool_result", callId: minted.id, ok: true, output: "file contents" }]),
  ];
  const { stream, seen } = capturingStream([{ type: "turn", turn: mkTurn([{ kind: "text", text: "done" }]) }]);
  const options: StreamOptions = { tools };
  await drain(withToolCallParsing(stream)(model, history, options));

  const req = seen[0];
  if (!req) throw new Error("underlying stream never called");
  // the second request contains NO native tool artifacts a non-native model can't consume
  expect("tools" in (req.options ?? {})).toBe(false);
  for (const m of req.messages) {
    expect(m.role).not.toBe("tool");
    for (const p of m.parts) expect(p.kind).toBe("text");
  }
  // assistant tool_call lowered to the EXACT hermes markup the parser accepts; prose kept
  const assistant = req.messages[1];
  expect(assistant?.role).toBe("assistant");
  const loweredText = (assistant?.parts ?? []).flatMap((p) => (p.kind === "text" ? [p.text] : [])).join("\n");
  expect(loweredText).toContain("Reading now.");
  expect(loweredText).toContain('<tool_call>\n{"name":"read","arguments":{"path":"a.ts"}}\n</tool_call>');
  expect(parseToolCalls(loweredText).calls).toEqual([{ tool: "read", args: { path: "a.ts" } }]); // round-trips
  // tool result became a user-role text message rendered under the tool NAME (hermes.ts:46-60)
  expect(req.messages[2]?.role).toBe("user");
  expect(req.messages[2]?.parts).toEqual([
    { kind: "text", text: '<tool_response>{"name":"read","content":"file contents"}</tool_response>' },
  ]);
  // originals were not mutated (upstream: "original is not mutated")
  expect(history[1]?.parts.some((p) => p.kind === "tool_call")).toBe(true);
  expect(history[2]?.role).toBe("tool");
  expect(options.tools).toBe(tools);
});

test("native tool history passes through unlowered (same references, tools intact)", async () => {
  const history: Message[] = [
    mkMsg("user", [{ kind: "text", text: "go" }]),
    mkMsg("assistant", [{ kind: "tool_call", id: "toolu_abc", tool: "read", args: { path: "x" } }]),
    mkMsg("tool", [{ kind: "tool_result", callId: "toolu_abc", ok: true, output: "x" }]),
  ];
  const { stream, seen } = capturingStream([{ type: "turn", turn: mkTurn([{ kind: "text", text: "ok" }]) }]);
  const options: StreamOptions = { tools };
  await drain(withToolCallParsing(stream)(model, history, options));
  expect(seen[0]?.messages).toBe(history); // byte-identical passthrough: same array reference
  expect(seen[0]?.options).toBe(options);  // tools NOT stripped for native conversations
});

test("lowerContext option: false disables auto-detection, true forces lowering", async () => {
  const textcallHistory: Message[] = [
    mkMsg("assistant", [{ kind: "tool_call", id: "textcall_deadbeef_9", tool: "read", args: {} }]),
    mkMsg("tool", [{ kind: "tool_result", callId: "textcall_deadbeef_9", ok: true, output: "y" }]),
  ];
  const off = capturingStream([{ type: "turn", turn: mkTurn([{ kind: "text", text: "ok" }]) }]);
  await drain(withToolCallParsing(off.stream, { lowerContext: false })(model, textcallHistory, { tools }));
  expect(off.seen[0]?.messages).toBe(textcallHistory);
  expect(off.seen[0]?.options?.tools).toBe(tools);

  const nativeHistory: Message[] = [
    mkMsg("assistant", [{ kind: "tool_call", id: "toolu_1", tool: "grep", args: { pattern: "p" } }]),
    mkMsg("tool", [{ kind: "tool_result", callId: "toolu_1", ok: false, output: "boom" }]),
  ];
  const on = capturingStream([{ type: "turn", turn: mkTurn([{ kind: "text", text: "ok" }]) }]);
  await drain(withToolCallParsing(on.stream, { lowerContext: true })(model, nativeHistory, { tools }));
  const req = on.seen[0];
  expect(req?.messages.every((m) => m.role !== "tool")).toBe(true);
  expect(req?.messages.every((m) => m.parts.every((p) => p.kind === "text"))).toBe(true);
  expect("tools" in (req?.options ?? {})).toBe(false);
});
