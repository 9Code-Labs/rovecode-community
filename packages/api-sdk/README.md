# @rovecode-labs/api-sdk

Official TypeScript/JavaScript SDK for the [rovecode](https://rovecode.dev) AI platform.
Zero dependencies, works on Node 18+, Bun, Deno and edge runtimes.

```bash
npm install @rovecode-labs/api-sdk
```

## Quickstart

```ts
import { Rovecode } from "@rovecode-labs/api-sdk";

const client = new Rovecode({ apiKey: process.env.ROVECODE_API_KEY! });

// non-streaming
const res = await client.chat.completions.create({
  model: "glm-5.3-flash",
  messages: [{ role: "user", content: "Hello!" }],
});
console.log(res.choices[0].message.content);
```

## Streaming

```ts
for await (const chunk of await client.chat.completions.stream({
  model: "deepseek-v4-pro",
  messages: [{ role: "user", content: "Write a debounce fn" }],
})) {
  const delta = chunk.choices[0]?.delta;
  if (delta?.reasoning_content) process.stdout.write(dim(delta.reasoning_content));
  if (delta?.content) process.stdout.write(delta.content);
}
```

Or collect the whole stream in one call (reasoning separated):

```ts
const { content, reasoning, usage } = await client.chat.completions.collect({
  model: "deepseek-v4-pro",
  messages: [{ role: "user", content: "Explain Raft consensus" }],
});
```

## Model catalog

```ts
const { data } = await client.models.list();
for (const m of data) console.log(m.id, m.type, m.supports_tools);
```

## Images & video

```ts
const img = await client.images.generate({ model: "anime-1", prompt: "a cat samurai", size: "1024x1024" });

const job = await client.videos.generate({ model: "veo3", prompt: "eagle over the ocean at sunset" });
const done = await client.videos.wait(job.id);      // polls until completed/failed
console.log(done.url);
```

## Typed errors

Every failure carries its server-side `incident` id — quote it in support tickets.

```ts
import { ContentFilterError, RateLimitError, PermissionError } from "@rovecode-labs/api-sdk";

try {
  await client.chat.completions.create({ model: "grok-4.7-cyber", messages: [...] });
} catch (e) {
  if (e instanceof PermissionError) {
    // 403 — plan-gated model; ask the operator to enroll your key
  } else if (e instanceof ContentFilterError) {
    // upstream content filter rejected the conversation — rephrase or switch model
  } else if (e instanceof RateLimitError) {
    await sleep(e.retryAfterMs);                      // then retry
  }
  console.error(e.status, e.incident);
}
```

| Error class | Status | Meaning |
|---|---|---|
| `AuthenticationError` | 401 | key missing/unknown/revoked |
| `PermissionError` | 403 | plan gate, restricted model, blocked account |
| `NotFoundError` | 404 | unknown model — check `models.list()` |
| `ContentFilterError` | 400 | provider flagged the conversation content |
| `RateLimitError` | 429 | rate/quota — retry after `retryAfterMs` |
| `APIConnectionError` | 5xx | platform-side failure — retry with backoff |

## Options

```ts
new Rovecode({
  apiKey: "rove_live_...",
  baseURL: "https://api.rovecode.dev/v1",  // default
  timeoutMs: 600_000,                      // reasoning models think long
  maxRetries: 2,                           // auto-retries 429/5xx with backoff
});
```

## OpenAI SDK compatibility

The platform speaks the OpenAI wire format, so the official `openai` package works too:

```ts
import OpenAI from "openai";
const client = new OpenAI({ baseURL: "https://api.rovecode.dev/v1", apiKey: process.env.ROVECODE_API_KEY });
```

Use `@rovecode-labs/api-sdk` when you want the typed catalog (credits, engines, video jobs), incident-id errors and the reasoning-aware `collect()` helper.

License: MIT
