import { describe, expect, it } from "bun:test";
import { Rovecode, AuthenticationError, ContentFilterError, PermissionError, RateLimitError, APIError } from "../src/index.ts";

function jsonRes(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function sseRes(events: unknown[]): Response {
  const body = events
    .map((e) => `data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`)
    .join("") + "data: [DONE]\n\n";
  return new Response(new TextEncoder().encode(body), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

const OPTS = { apiKey: "rove_live_test", baseURL: "https://api.test/v1" };

describe("chat.completions", () => {
  it("non-stream create returns the completion", async () => {
    const client = new Rovecode({
      ...OPTS,
      fetch: async () => jsonRes(200, {
        id: "x", object: "chat.completion", created: 1, model: "glm-5.3-flash",
        choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    });
    const res = await client.chat.completions.create({ model: "glm-5.3-flash", messages: [{ role: "user", content: "hi" }] });
    expect(res.choices[0]!.message.content).toBe("hi");
  });

  it("streams chunks and collect() accumulates content + reasoning", async () => {
    const client = new Rovecode({
      ...OPTS,
      fetch: async () => sseRes([
        { id: "c1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "dusun" }, finish_reason: null }] },
        { id: "c1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { content: "mer" }, finish_reason: null }] },
        { id: "c1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { content: "haba" }, finish_reason: null }] },
        { id: "c1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } },
      ]),
    });
    const out = await client.chat.completions.collect({ model: "m", messages: [{ role: "user", content: "x" }] });
    expect(out.content).toBe("merhaba");
    expect(out.reasoning).toBe("dusun");
    expect(out.usage?.total_tokens).toBe(5);
  });

  it("mid-stream error events throw APIError with incident id", async () => {
    const client = new Rovecode({
      ...OPTS,
      fetch: async () => sseRes([
        { error: { message: "stream ended early (incident abc123def456)", type: "api_error" } },
      ]),
    });
    const gen = await client.chat.completions.stream({ model: "m", messages: [{ role: "user", content: "x" }] });
    try {
      for await (const _ of gen) { /* consume */ }
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(APIError);
      expect((e as APIError).incident).toBe("abc123def456");
    }
  });
});

describe("errors", () => {
  it("401 -> AuthenticationError", async () => {
    const client = new Rovecode({ ...OPTS, maxRetries: 0, fetch: async () => jsonRes(401, { error: { message: "no key" } }) });
    await expect(client.models.list()).rejects.toBeInstanceOf(AuthenticationError);
  });

  it("403 -> PermissionError", async () => {
    const client = new Rovecode({ ...OPTS, maxRetries: 0, fetch: async () => jsonRes(403, { detail: "requires the Cyber plan" }) });
    await expect(client.models.list()).rejects.toBeInstanceOf(PermissionError);
  });

  it("400 content filter -> ContentFilterError", async () => {
    const client = new Rovecode({ ...OPTS, maxRetries: 0, fetch: async () => jsonRes(400, { error: { message: "The provider's content filter rejected this conversation (incident aabbccddeeff)" } }) });
    try {
      await client.models.list();
      throw new Error("nope");
    } catch (e) {
      expect(e).toBeInstanceOf(ContentFilterError);
      expect((e as ContentFilterError).incident).toBe("aabbccddeeff");
    }
  });

  it("429 retries then succeeds; Retry-After is honored", async () => {
    let calls = 0;
    const client = new Rovecode({
      ...OPTS,
      maxRetries: 1,
      fetch: async () => {
        calls++;
        if (calls === 1) return jsonRes(429, { error: { message: "slow down" } }, { "retry-after": "0" });
        return jsonRes(200, { object: "list", data: [] });
      },
    });
    const res = await client.models.list();
    expect(res.data).toEqual([]);
    expect(calls).toBe(2);
  });

  it("429 beyond maxRetries -> RateLimitError", async () => {
    const client = new Rovecode({ ...OPTS, maxRetries: 0, fetch: async () => jsonRes(429, { error: { message: "quota" } }) });
    await expect(client.models.list()).rejects.toBeInstanceOf(RateLimitError);
  });

  it("sends the bearer key", async () => {
    let auth = "";
    const client = new Rovecode({
      ...OPTS,
      fetch: async (_url, init) => {
        auth = (init?.headers as Record<string, string>).Authorization;
        return jsonRes(200, { object: "list", data: [] });
      },
    });
    await client.models.list();
    expect(auth).toBe("Bearer rove_live_test");
  });
});

describe("images & videos", () => {
  it("images.generate posts to /images/generations", async () => {
    let path = "";
    const client = new Rovecode({
      ...OPTS,
      fetch: async (url) => {
        path = String(url);
        return jsonRes(200, { created: 1, data: [{ url: "https://x/img.png" }] });
      },
    });
    const res = await client.images.generate({ model: "anime-1", prompt: "cat" });
    expect(path).toContain("/images/generations");
    expect(res.data[0]!.url).toBe("https://x/img.png");
  });

  it("videos.wait polls until completed", async () => {
    let n = 0;
    const client = new Rovecode({
      ...OPTS,
      fetch: async (url) => {
        n++;
        if (String(url).includes("/videos/generations")) return jsonRes(200, { id: "job1", status: "queued" });
        return jsonRes(200, { id: "job1", status: n > 2 ? "completed" : "running", url: "https://x/v.mp4" });
      },
    });
    const job = await client.videos.generate({ model: "veo3", prompt: "eagle" });
    expect(job.id).toBe("job1");
    const done = await client.videos.wait("job1", { intervalMs: 1 });
    expect(done.status).toBe("completed");
    expect(done.url).toBe("https://x/v.mp4");
  });
});
