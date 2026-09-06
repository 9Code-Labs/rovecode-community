/** count-remote: asking the provider for the real prompt size instead of estimating it.
 *
 *  The module's contract is narrow and every clause of it is load-bearing, so each is pinned here:
 *  Anthropic protocol only, a key is required, the body carries the same shape a request would, and
 *  no path throws — a token count that cannot be obtained must come back as a stated reason, never as
 *  a zero and never as an exception that fails the command it was decorating. */

import { describe, expect, it } from "bun:test";
import { countPromptRemotely } from "../../src/core/count-remote.ts";
import { renderExact } from "../../src/cli/context-cmd.ts";
import type { Message } from "../../src/core/types.ts";

const ANTHROPIC = { baseUrl: "https://api.anthropic.com/v1", protocol: "anthropic", apiKey: "sk-test" };
const MESSAGES: Message[] = [
  { id: "m1", role: "user", parts: [{ kind: "text", text: "how big is this prompt" }], parentId: null, createdAt: 1 },
];

/** a fetch that records the one call it is given and answers with `body` at `status` */
function stubFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: unknown, init: unknown) => {
    calls.push({ url: String(url), init: init as RequestInit });
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return new Response(text, { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe("countPromptRemotely", () => {
  it("refuses a protocol that publishes no counting endpoint, rather than inventing one", async () => {
    const r = await countPromptRemotely({
      provider: { baseUrl: "https://api.openai.com/v1", protocol: "openai", apiKey: "sk" },
      model: "gpt-5.5",
      messages: MESSAGES,
      fetchFn: (() => { throw new Error("must not be called"); }) as unknown as typeof fetch,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("only the Anthropic protocol does");
  });

  it("says a key is missing instead of sending an unauthenticated request", async () => {
    const r = await countPromptRemotely({
      provider: { baseUrl: ANTHROPIC.baseUrl, protocol: "anthropic" },
      model: "claude-sonnet-5",
      messages: MESSAGES,
      fetchFn: (() => { throw new Error("must not be called"); }) as unknown as typeof fetch,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("no API key");
  });

  it("returns input_tokens and the endpoint it asked", async () => {
    const { fn, calls } = stubFetch(200, { input_tokens: 4242 });
    const r = await countPromptRemotely({ provider: ANTHROPIC, model: "claude-sonnet-5", messages: MESSAGES, fetchFn: fn });
    expect(r).toEqual({ ok: true, inputTokens: 4242, endpoint: "https://api.anthropic.com/v1/messages/count_tokens" });
    expect(calls).toHaveLength(1);
  });

  it("sends the body a real request would: model, system, messages, and tools in Anthropic's shape", async () => {
    const { fn, calls } = stubFetch(200, { input_tokens: 10 });
    await countPromptRemotely({
      provider: ANTHROPIC,
      model: "claude-sonnet-5",
      messages: MESSAGES,
      system: "you are rovecode",
      // the shape the registry holds: `args`, the same one a real request converts
      tools: [{ name: "read", description: "read a file", args: { type: "object", properties: { path: { type: "string" } } } }],
      fetchFn: fn,
    });
    const sent = JSON.parse(String(calls[0]?.init.body));
    expect(sent.model).toBe("claude-sonnet-5");
    expect(sent.system).toBe("you are rovecode");
    expect(sent.messages[0].role).toBe("user");
    // input_schema, not parameters — the OpenAI key would be silently ignored and the count would
    // come back describing a prompt with no tools in it, which is the failure hardest to notice.
    expect(sent.tools).toEqual([{ name: "read", description: "read a file", input_schema: { type: "object", properties: { path: { type: "string" } } } }]);
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-test");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
  });

  it("gives an argument-less tool a schema Anthropic accepts, not a bare {}", async () => {
    const { fn, calls } = stubFetch(200, { input_tokens: 10 });
    await countPromptRemotely({
      provider: ANTHROPIC, model: "m", messages: MESSAGES,
      tools: [{ name: "ping", description: "no arguments" }], fetchFn: fn,
    });
    expect(JSON.parse(String(calls[0]?.init.body)).tools[0].input_schema).toEqual({ type: "object", properties: {} });
  });

  it("accepts a tool given in the registry's wrapped form (`{schema:{…}}`)", async () => {
    const { fn, calls } = stubFetch(200, { input_tokens: 10 });
    await countPromptRemotely({
      provider: ANTHROPIC, model: "m", messages: MESSAGES,
      tools: [{ schema: { name: "grep", description: "search", args: { type: "object", properties: {} } } }], fetchFn: fn,
    });
    expect(JSON.parse(String(calls[0]?.init.body)).tools[0].name).toBe("grep");
  });

  it("omits tools entirely when there are none, rather than sending an empty list", async () => {
    const { fn, calls } = stubFetch(200, { input_tokens: 10 });
    await countPromptRemotely({ provider: ANTHROPIC, model: "claude-sonnet-5", messages: MESSAGES, tools: [], fetchFn: fn });
    expect(JSON.parse(String(calls[0]?.init.body))).not.toHaveProperty("tools");
  });

  it("carries the provider's extra headers (a gateway that needs one still answers)", async () => {
    const { fn, calls } = stubFetch(200, { input_tokens: 10 });
    await countPromptRemotely({
      provider: { ...ANTHROPIC, headers: { "x-gateway": "on" } },
      model: "claude-sonnet-5", messages: MESSAGES, fetchFn: fn,
    });
    expect((calls[0]?.init.headers as Record<string, string>)["x-gateway"]).toBe("on");
  });

  it("does not double the slash when the base URL ends in one", async () => {
    const { fn, calls } = stubFetch(200, { input_tokens: 1 });
    await countPromptRemotely({ provider: { ...ANTHROPIC, baseUrl: "https://api.anthropic.com/v1/" }, model: "m", messages: MESSAGES, fetchFn: fn });
    expect(calls[0]?.url).toBe("https://api.anthropic.com/v1/messages/count_tokens");
  });

  it("counts a session with no turns yet, and says the placeholder is there", async () => {
    // the API rejects an empty messages list, and a fresh session is precisely when the fixed cost of
    // the system prompt and the tool schemas is worth asking about — so it must not be uncountable
    const { fn, calls } = stubFetch(200, { input_tokens: 12_283 });
    const r = await countPromptRemotely({ provider: ANTHROPIC, model: "m", messages: [], system: "you are rovecode", fetchFn: fn });
    expect(r).toMatchObject({ ok: true, inputTokens: 12_283, placeholder: true });
    expect(JSON.parse(String(calls[0]?.init.body)).messages).toEqual([{ role: "user", content: "." }]);
    expect(renderExact({ inputTokens: 12_283, placeholder: true }, 7_790).join("\n")).toContain("placeholder message");
  });

  it("does not claim a placeholder when the transcript supplied the turns", async () => {
    const { fn } = stubFetch(200, { input_tokens: 10 });
    const r = await countPromptRemotely({ provider: ANTHROPIC, model: "m", messages: MESSAGES, fetchFn: fn });
    expect(r.ok && r.placeholder).toBeUndefined();
  });

  it("reports a refusal with its status and a slice of the body", async () => {
    const { fn } = stubFetch(404, "not found on this gateway");
    const r = await countPromptRemotely({ provider: ANTHROPIC, model: "m", messages: MESSAGES, fetchFn: fn });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("the endpoint answered 404 — not found on this gateway");
  });

  it("does not invent a count from a 200 that carries no input_tokens", async () => {
    for (const body of [{}, { input_tokens: "many" }, { input_tokens: -3 }, "not json at all"]) {
      const { fn } = stubFetch(200, body);
      const r = await countPromptRemotely({ provider: ANTHROPIC, model: "m", messages: MESSAGES, fetchFn: fn });
      expect(r.ok).toBe(false);
    }
  });

  it("turns a thrown fetch into a reason — a token count never fails its command", async () => {
    const r = await countPromptRemotely({
      provider: ANTHROPIC, model: "m", messages: MESSAGES,
      fetchFn: (() => Promise.reject(new Error("ENOTFOUND api.anthropic.com"))) as unknown as typeof fetch,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("ENOTFOUND");
  });

  it("gives up on a hung endpoint and says how long it waited", async () => {
    const hang = ((_u: unknown, init: unknown) =>
      new Promise((_res, rej) => {
        (init as { signal: AbortSignal }).signal.addEventListener("abort", () => rej(new Error("aborted")));
      })) as unknown as typeof fetch;
    const r = await countPromptRemotely({ provider: ANTHROPIC, model: "m", messages: MESSAGES, fetchFn: hang, timeoutMs: 20 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("no answer within");
  });
});

describe("renderExact", () => {
  it("names the direction our meter is wrong in, and flags it past the tolerance", () => {
    const low = renderExact({ inputTokens: 10_000 }, 8_000).join("\n");
    expect(low).toContain("the provider counted 10,000");
    expect(low).toContain("reads low by 2,000 (20.0%)");
    expect(low).toContain("beyond the 5.0% tolerance");

    const close = renderExact({ inputTokens: 10_000 }, 10_200).join("\n");
    expect(close).toContain("reads high by 200 (2.0%)");
    expect(close).not.toContain("beyond");

    expect(renderExact({ inputTokens: 10_000 }, 10_000).join("\n")).toContain("agrees exactly");
  });

  it("prints the reason a count was not obtained rather than a zero", () => {
    const out = renderExact({ reason: "no API key for this provider — the count needs one" }, 8_000).join("\n");
    expect(out).toContain("not counted — no API key");
    expect(out).not.toContain("0");
  });
});
