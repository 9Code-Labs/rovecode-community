import { test, expect } from "bun:test";
import {
  applyAnthropicCacheBoundaries,
  DEFAULT_MAX_BREAKPOINTS,
  DEFAULT_MIN_CHUNK_CHARS,
  type AnthropicishBody,
} from "../../src/providers/cache.ts";

const CC = { type: "ephemeral" };
type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => v as Rec;
const arr = (v: unknown): unknown[] => v as unknown[];

/** Wire-visible cache_control markers: system blocks + message content blocks + tools entries. */
function markerCount(body: AnthropicishBody): number {
  let n = 0;
  const inBlocks = (v: unknown): number =>
    Array.isArray(v) ? v.filter((b) => typeof b === "object" && b !== null && "cache_control" in (b as Rec)).length : 0;
  n += inBlocks(body.system);
  if (Array.isArray(body.messages)) for (const m of body.messages) n += inBlocks(rec(m)["content"]);
  n += inBlocks(body.tools);
  return n;
}

function sixMessageBody(): AnthropicishBody {
  return {
    model: "claude-test",
    max_tokens: 1024,
    system: "S".repeat(64),
    messages: [
      { role: "user", content: "u0 opening question" },
      { role: "assistant", content: [{ type: "text", text: "a1 reply" }] },
      { role: "user", content: "u2 follow-up" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "a3 thinking about it" },
          { type: "tool_use", id: "t1", name: "grep", input: { q: "x" } },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "match" }] },
      { role: "user", content: "u5 latest question" },
    ],
  };
}

test("6-message convo: boundary on system + last block of messages[length-3], count ≤ 4", () => {
  const body = sixMessageBody();
  const snapshot = structuredClone(body);
  const out = applyAnthropicCacheBoundaries(body, { minChunkChars: 1 });

  // system string → single text block carrying the marker, text preserved byte-for-byte
  expect(out.system).toEqual([{ type: "text", text: "S".repeat(64), cache_control: CC }]);

  // anchor is index 3 (≥2 messages after it); marker on its LAST content block only
  const msgs = arr(out.messages);
  const anchorContent = arr(rec(msgs[3])["content"]);
  expect(anchorContent[0]).toEqual({ type: "text", text: "a3 thinking about it" }); // first block unmarked
  expect(anchorContent[1]).toEqual({ type: "tool_use", id: "t1", name: "grep", input: { q: "x" }, cache_control: CC });

  // the churning tail (4, 5) and the earlier prefix (0..2) carry no markers
  for (const i of [0, 1, 2, 4, 5]) {
    const content = rec(msgs[i])["content"];
    if (Array.isArray(content)) for (const b of content) expect("cache_control" in rec(b)).toBe(false);
  }
  // untouched messages are shared by reference, not cloned
  expect(msgs[5]).toBe(arr(body.messages)[5]);

  expect(markerCount(out)).toBe(2);
  expect(markerCount(out)).toBeLessThanOrEqual(4);

  // unknown body fields pass through; input body is never mutated
  expect(out["model"]).toBe("claude-test");
  expect(out["max_tokens"]).toBe(1024);
  expect(body).toEqual(snapshot);
});

test("idempotent: applying twice equals applying once", () => {
  const once = applyAnthropicCacheBoundaries(sixMessageBody(), { minChunkChars: 1 });
  const twice = applyAnthropicCacheBoundaries(once, { minChunkChars: 1 });
  expect(twice).toEqual(once);
  expect(markerCount(twice)).toBe(2);
});

test("tiny system below default minChunkChars is skipped (marker would be silently ignored)", () => {
  const body: AnthropicishBody = { system: "you are terse", messages: [{ role: "user", content: "hi" }] };
  const out = applyAnthropicCacheBoundaries(body);
  expect(out).toBe(body); // nothing changed → same reference
  expect(out.system).toBe("you are terse");
  expect(markerCount(out)).toBe(0);
});

test("minChunkChars edge: exactly at the threshold converts, one below does not", () => {
  const atLimit: AnthropicishBody = { system: "x".repeat(DEFAULT_MIN_CHUNK_CHARS) };
  const converted = applyAnthropicCacheBoundaries(atLimit);
  expect(converted.system).toEqual([{ type: "text", text: "x".repeat(DEFAULT_MIN_CHUNK_CHARS), cache_control: CC }]);

  const below: AnthropicishBody = { system: "x".repeat(DEFAULT_MIN_CHUNK_CHARS - 1) };
  expect(applyAnthropicCacheBoundaries(below)).toBe(below);
});

test("string→block conversion preserves text exactly and is copy-on-write", () => {
  const text = "héllo 世界 — exact bytes\n\ttabs too";
  const body: AnthropicishBody = {
    messages: [
      { role: "user", content: text },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" },
    ],
  };
  const out = applyAnthropicCacheBoundaries(body, { minChunkChars: 1 });
  const msgs = arr(out.messages);
  expect(rec(msgs[0])["content"]).toEqual([{ type: "text", text, cache_control: CC }]);
  // input untouched: original message still has string content
  expect(rec(arr(body.messages)[0])["content"]).toBe(text);
  expect(out).not.toBe(body);
  expect(msgs[1]).toBe(arr(body.messages)[1]);
});

test("maxBreakpoints=1: system wins, conversation boundary skipped", () => {
  const out = applyAnthropicCacheBoundaries(sixMessageBody(), { maxBreakpoints: 1, minChunkChars: 1 });
  expect(Array.isArray(out.system)).toBe(true);
  expect(markerCount(out)).toBe(1);
  for (const m of arr(out.messages)) {
    const content = rec(m)["content"];
    if (Array.isArray(content)) for (const b of content) expect("cache_control" in rec(b)).toBe(false);
  }
});

test("pre-existing markers count toward the budget", () => {
  const body = sixMessageBody();
  arr(rec(arr(body.messages)[1])["content"])[0] = { type: "text", text: "a1 reply", cache_control: CC };
  body.tools = [{ name: "grep", cache_control: CC }];
  // existing 2 + system = 3 → budget exhausted before the conversation boundary
  const out = applyAnthropicCacheBoundaries(body, { maxBreakpoints: 3, minChunkChars: 1 });
  expect(markerCount(out)).toBe(3);
  const anchorContent = arr(rec(arr(out.messages)[3])["content"]);
  expect("cache_control" in rec(anchorContent[1])).toBe(false);

  // with maxBreakpoints=2 the two existing markers block even the system conversion
  const out2 = applyAnthropicCacheBoundaries(body, { maxBreakpoints: 2, minChunkChars: 1 });
  expect(typeof out2.system).toBe("string");
  expect(markerCount(out2)).toBe(2);
});

test("maxBreakpoints=0: body passes through by reference", () => {
  const body = sixMessageBody();
  expect(applyAnthropicCacheBoundaries(body, { maxBreakpoints: 0, minChunkChars: 1 })).toBe(body);
});

test("bodies without messages/system pass through untouched", () => {
  for (const body of [
    {},
    { model: "m", max_tokens: 5 },
    { messages: [] },
    { messages: "junk" },
    { system: "" },
  ] as AnthropicishBody[]) {
    expect(applyAnthropicCacheBoundaries(body, { minChunkChars: 1 })).toBe(body);
  }
});

test("fewer than 3 messages: no conversation boundary (whole tail churns)", () => {
  const body: AnthropicishBody = {
    system: "S".repeat(64),
    messages: [
      { role: "user", content: "u0" },
      { role: "assistant", content: "a1" },
    ],
  };
  const out = applyAnthropicCacheBoundaries(body, { minChunkChars: 1 });
  expect(markerCount(out)).toBe(1); // system only
  for (const m of arr(out.messages)) expect(typeof rec(m)["content"]).toBe("string"); // untouched
});

test("anchor that cannot carry a marker reallocates to the nearest earlier message", () => {
  const body: AnthropicishBody = {
    messages: [
      { role: "user", content: "u0 stable prefix" },
      { role: "assistant", content: "" }, // anchor candidate (index length-3) — empty, can't carry
      { role: "user", content: "u2" },
      { role: "assistant", content: "a3" },
    ],
  };
  const out = applyAnthropicCacheBoundaries(body, { minChunkChars: 1 });
  const msgs = arr(out.messages);
  expect(rec(msgs[0])["content"]).toEqual([{ type: "text", text: "u0 stable prefix", cache_control: CC }]);
  expect(rec(msgs[1])["content"]).toBe(""); // untouched
  expect(markerCount(out)).toBe(1);
});

test("message-boundary gate uses the CUMULATIVE prefix (system + messages up to anchor)", () => {
  // system alone is below the default gate, but system+m0 clears it → message boundary only
  const body: AnthropicishBody = {
    system: "s".repeat(3000),
    messages: [
      { role: "user", content: "u".repeat(2000) },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" },
    ],
  };
  const out = applyAnthropicCacheBoundaries(body);
  expect(typeof out.system).toBe("string"); // 3000 < 4096: no system marker
  const msgs = arr(out.messages);
  expect("cache_control" in rec(arr(rec(msgs[0])["content"])[0])).toBe(true);
  expect(markerCount(out)).toBe(1);

  // everything tiny → no markers at all, pass-through by reference
  const tiny: AnthropicishBody = {
    system: "small",
    messages: [
      { role: "user", content: "u0" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" },
    ],
  };
  expect(applyAnthropicCacheBoundaries(tiny)).toBe(tiny);
});

test("DEFAULT_MAX_BREAKPOINTS is 4 (Anthropic's per-request limit) and is the operative default", () => {
  expect(DEFAULT_MAX_BREAKPOINTS).toBe(4);
  // 4 pre-existing markers exhaust the default budget: even a ≥minChunkChars system string
  // stays unconverted and the body passes through by reference. A default of 5+ would convert.
  const body: AnthropicishBody = {
    system: "S".repeat(DEFAULT_MIN_CHUNK_CHARS),
    messages: [
      { role: "user", content: [{ type: "text", text: "u0", cache_control: CC }] },
      { role: "assistant", content: [{ type: "text", text: "a1", cache_control: CC }] },
      { role: "user", content: [{ type: "text", text: "u2", cache_control: CC }] },
      { role: "assistant", content: [{ type: "text", text: "a3", cache_control: CC }] },
      { role: "user", content: "u4" },
      { role: "user", content: "u5" },
    ],
  };
  expect(applyAnthropicCacheBoundaries(body)).toBe(body);
  expect(markerCount(body)).toBe(4);
});

// ---------- consecutive-turn stability (the property the boundary placement exists FOR) ----------

const isObj = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);

/** Anthropic's cache key normalizes exactly two rewrites this transform performs between
 *  consecutive requests: cache_control markers (placement metadata) and string content vs a
 *  single [{type:"text",...}] block. Canonicalize both sides before comparing — the raw bytes
 *  of consecutive requests are NOT equal and must not be required to be. */
function canonicalMsg(m: unknown): unknown {
  if (!isObj(m)) return m;
  const { content, ...rest } = m;
  const blocks = typeof content === "string" ? [{ type: "text", text: content }] : content;
  const scrubbed = Array.isArray(blocks)
    ? blocks.map((b) => {
        if (!isObj(b)) return b;
        const { cache_control: _drop, ...keep } = b;
        return keep;
      })
    : blocks;
  return { ...rest, content: scrubbed };
}

function canonicalSystem(system: unknown): unknown {
  return canonicalMsg({ content: system });
}

test("5-turn simulation: the prefix above the previous boundary stays cache-canonically equal", () => {
  const system = "S".repeat(5000);
  const conv: unknown[] = [{ role: "user", content: "u0 " + "x".repeat(4200) }];
  const request = () => applyAnthropicCacheBoundaries({ system, messages: conv.slice() });
  let prev = request();
  for (let turn = 1; turn <= 5; turn += 1) {
    // an agent turn appends assistant tool_use + user tool_result
    conv.push({ role: "assistant", content: [{ type: "text", text: `a${turn}` }, { type: "tool_use", id: `t${turn}`, name: "grep", input: { turn } }] });
    conv.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `t${turn}`, content: `r${turn}` }] });
    const next = request();
    const prevMsgs = arr(prev.messages);
    const overlap = arr(next.messages).slice(0, prevMsgs.length);
    // raw bytes of the shared prefix are NOT equal (the marker moved forward; marked string
    // content was rewritten to a block array) — byte-stability is the wrong bar…
    expect(JSON.stringify(overlap)).not.toBe(JSON.stringify(prevMsgs));
    // …but the CACHE-CANONICAL forms are identical, so the previous prefix still cache-hits
    expect(overlap.map(canonicalMsg)).toEqual(prevMsgs.map(canonicalMsg));
    expect(canonicalSystem(next.system)).toEqual(canonicalSystem(prev.system));
    // and every request carries both boundaries on the wire
    expect(markerCount(next)).toBe(2);
    prev = next;
  }
});

test("system given as a block array: marker on the LAST block; already-marked arrays untouched", () => {
  const body: AnthropicishBody = {
    system: [
      { type: "text", text: "A".repeat(10) },
      { type: "text", text: "B".repeat(10) },
    ],
  };
  const out = applyAnthropicCacheBoundaries(body, { minChunkChars: 1 });
  const blocks = arr(out.system);
  expect(blocks[0]).toEqual({ type: "text", text: "A".repeat(10) });
  expect(blocks[1]).toEqual({ type: "text", text: "B".repeat(10), cache_control: CC });
  expect(markerCount(out)).toBe(1);

  const marked = applyAnthropicCacheBoundaries(out, { minChunkChars: 1 });
  expect(marked).toBe(out); // idempotent, same reference
});
