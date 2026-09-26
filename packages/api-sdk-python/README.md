# rovecode (Python SDK)

Official Python SDK for the [rovecode](https://rovecode.dev) AI platform.
Zero dependencies (stdlib only), Python 3.9+.

```bash
pip install rovecode
```

## Quickstart

```python
from rovecode import Rovecode

client = Rovecode(api_key="rove_live_...")

res = client.chat.completions.create(
    model="glm-5.3-flash",
    messages=[{"role": "user", "content": "Hello!"}],
)
print(res["choices"][0]["message"]["content"])
```

## Streaming

```python
for chunk in client.chat.completions.stream(
    model="deepseek-v4-pro",
    messages=[{"role": "user", "content": "Write a debounce fn"}],
):
    delta = chunk["choices"][0]["delta"]
    print(delta.get("content") or "", end="", flush=True)
```

Collect the whole stream (reasoning separated):

```python
out = client.chat.completions.collect(model="deepseek-v4-pro", messages=[...])
print(out["reasoning"])  # the thinking trace
print(out["content"])    # the answer
print(out["usage"])      # token counts
```

## Catalog, images, video

```python
models = client.models.list()["data"]

img = client.images.generate(model="anime-1", prompt="a cat samurai")

job = client.videos.generate(model="veo3", prompt="eagle over the ocean")
done = client.videos.wait(job["id"])     # polls until completed/failed
print(done["url"])
```

## Typed errors

```python
from rovecode import ContentFilterError, PermissionError, RateLimitError

try:
    client.chat.completions.create(model="grok-4.7-cyber", messages=[...])
except PermissionError as e:
    ...   # 403 — plan-gated; ask the operator to enroll your key
except ContentFilterError:
    ...   # provider flagged the conversation content
except RateLimitError as e:
    time.sleep(e.retry_after_ms / 1000)
```

Every error carries `.status` and `.incident` — quote the incident id in support tickets.

| Error class | Status | Meaning |
|---|---|---|
| `AuthenticationError` | 401 | key missing/unknown/revoked |
| `PermissionError` | 403 | plan gate, restricted model |
| `NotFoundError` | 404 | unknown model |
| `ContentFilterError` | 400 | provider flagged the content |
| `RateLimitError` | 429 | rate/quota — see `retry_after_ms` |
| `APIConnectionError` | 5xx | platform-side — retry with backoff |

The API is OpenAI-compatible, so the official `openai` package works too
(`base_url="https://api.rovecode.dev/v1"`). This SDK adds the typed catalog,
incident-id errors and the reasoning-aware `collect()` helper.

License: MIT
