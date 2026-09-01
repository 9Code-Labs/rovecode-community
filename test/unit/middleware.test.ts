import { test, expect } from "bun:test";
import { parseToolCalls, toolPromptBlock, withToolCallParsing } from "../../src/providers/middleware.ts";
import type { AssistantTurn, Message, MessagePart, ModelRef, StreamEvent, StreamFn, ToolSchema } from "../../src/core/types.ts";

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

async function collect(stream: StreamFn, opts?: Parameters<typeof withToolCallParsing>[1]): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of withToolCallParsing(stream, opts)(model, messages)) out.push(e);
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
