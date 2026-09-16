/** Prompt-cache breakpoints as the Anthropic adapter actually sends them (providers/stream.ts →
 *  providers/cache.ts applyAnthropicCacheBoundaries), captured off a fake fetch. Anthropic renders a request
 *  as tools → system → messages and a cache_control marker caches everything up to and including its block, so
 *  the layout that pays is: ONE marker on the system block (it covers the tool definitions rendered before it),
 *  ONE on the last stable message of the conversation prefix (index length-3: the trailing exchange churns
 *  every turn, the prefix above it is canonically stable and the previous marker sits inside the API's
 *  look-back). Pinned here because the design run's numbers depended on it: 293k cache-read tokens against
 *  15k fresh input over 16 turns — every turn re-read the prefix and wrote only its own tail. */

import { afterEach, expect, test } from "bun:test";
import type { Message, ModelRef, ToolSchema } from "../../src/core/types.ts";
import { anthropicStreaming } from "../../src/providers/stream.ts";

const real = globalThis.fetch;
afterEach(() => { globalThis.fetch = real; });

const ANTHROPIC_OK = [
  'data: {"type":"message_start","message":{"usage":{"input_tokens":3}}}',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}',
  'data: {"type":"content_block_stop","index":0}',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}',
  'data: {"type":"message_stop"}', "",
].join("\n\n");

type Block = { type: string; text?: string; cache_control?: { type: string } };
type Body = { system?: Block[] | string; tools?: { name: string; cache_control?: unknown }[]; messages: { role: string; content: string | Block[] }[] };

function capture(): { bodies: Body[] } {
  const bodies: Body[] = [];
  globalThis.fetch = (async (_u: unknown, init?: RequestInit) => { bodies.push(JSON.parse(String(init?.body)) as Body); return new Response(ANTHROPIC_OK, { status: 200 }); }) as typeof fetch;
  return { bodies };
}
const M: ModelRef = { provider: "anthropic", model: "claude-opus-5" };
const text = (role: Message["role"], t: string, id: string): Message => ({ id, role, parts: [{ kind: "text", text: t }], parentId: null, createdAt: 0 });
const TOOLS: ToolSchema[] = [{ name: "read", description: "read a file", args: { type: "object", properties: { path: { type: "string" } } } }, { name: "bash", description: "run", args: { type: "object" } }];
const SYSTEM = "You are Rovecode. " + "The working agreement, the skills index, the memory index and the design rules. ".repeat(80); // ≈ 6.5k chars: past the 4096-char cache floor

async function send(history: Message[]): Promise<Body> {
  const { bodies } = capture();
  for await (const _ of anthropicStreaming({ baseUrl: "http://stub.invalid/v1", apiKey: "k" })(M, history, { tools: TOOLS })) { /* drain */ }
  return bodies[0]!;
}
const markers = (b: Body): string[] => {
  const out: string[] = [];
  if (Array.isArray(b.system)) b.system.forEach((blk, i) => { if (blk.cache_control) out.push(`system[${i}]`); });
  for (const t of b.tools ?? []) if (t.cache_control) out.push(`tool:${t.name}`);
  b.messages.forEach((m, i) => { if (Array.isArray(m.content)) m.content.forEach((blk, j) => { if (blk.cache_control) out.push(`messages[${i}].content[${j}]`); }); });
  return out;
};

test("turn 1 (system + one user message): the system block carries the ONE marker — it covers the tools rendered before it; no conversation marker yet (nothing stable to cache below the system)", async () => {
  const b = await send([text("system", SYSTEM, "s"), text("user", "hello", "u1")]);
  expect(Array.isArray(b.system)).toBe(true);
  expect((b.system as Block[])[0]!.text).toBe(SYSTEM); // byte-identical text, converted to a block to carry the marker
  expect(b.tools?.map((t) => t.name)).toEqual(["read", "bash"]);
  expect(markers(b)).toEqual(["system[0]"]);
});

test("a tool loop in flight: system marker + one marker on the last STABLE message (length-3), never on the churning tail; at most 4 markers; the next turn's prefix is unchanged above the moved marker", async () => {
  const history: Message[] = [
    text("system", SYSTEM, "s"),
    text("user", "build the page", "u1"),
    { id: "a1", role: "assistant", parts: [{ kind: "tool_call", id: "c1", tool: "read", args: { path: "x" } }], parentId: null, createdAt: 0 },
    { id: "t1", role: "tool", parts: [{ kind: "tool_result", callId: "c1", ok: true, output: "x".repeat(2000) }], parentId: null, createdAt: 0 },
    { id: "a2", role: "assistant", parts: [{ kind: "tool_call", id: "c2", tool: "bash", args: { command: "ls" } }], parentId: null, createdAt: 0 },
    { id: "t2", role: "tool", parts: [{ kind: "tool_result", callId: "c2", ok: true, output: "y".repeat(2000) }], parentId: null, createdAt: 0 },
  ];
  const b = await send(history);
  const n = b.messages.length; // the system message is not in `messages` on the wire
  expect(markers(b)).toEqual(["system[0]", `messages[${n - 3}].content[${(b.messages[n - 3]!.content as Block[]).length - 1}]`]);
  expect(markers(b).length).toBeLessThanOrEqual(4);
  // the next turn appends one exchange: the marker moves forward one exchange, everything above the OLD marker is byte-identical
  const next = await send([...history,
    { id: "a3", role: "assistant", parts: [{ kind: "tool_call", id: "c3", tool: "read", args: { path: "z" } }], parentId: null, createdAt: 0 },
    { id: "t3", role: "tool", parts: [{ kind: "tool_result", callId: "c3", ok: true, output: "z" }], parentId: null, createdAt: 0 },
  ]);
  const strip = (m: { role: string; content: string | Block[] }) => JSON.stringify(m, (k, v) => (k === "cache_control" ? undefined : v));
  expect(next.system).toEqual(b.system);
  expect(next.tools).toEqual(b.tools);
  for (let i = 0; i < n - 3; i++) expect(strip(next.messages[i]!)).toBe(strip(b.messages[i]!)); // the cached prefix is stable modulo marker placement (what the API normalizes)
  expect(markers(next)).toEqual(["system[0]", `messages[${n - 1}].content[${(next.messages[n - 1]!.content as Block[]).length - 1}]`]);
});
