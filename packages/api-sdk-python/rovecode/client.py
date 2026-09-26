"""rovecode Python SDK — zero-dependency client (urllib only).

    from rovecode import Rovecode

    client = Rovecode(api_key="rove_live_...")
    res = client.chat.completions.create(model="glm-5.3-flash",
                                         messages=[{"role": "user", "content": "hi"}])

    for chunk in client.chat.completions.stream(model="deepseek-v4-pro", messages=[...]):
        print(chunk["choices"][0]["delta"].get("content") or "", end="")
"""
import json
import time
import urllib.request
import urllib.error

from .errors import (
    APIError,
    RateLimitError,
    RovecodeError,
    error_from_response,
)

_RETRYABLE = {429, 500, 502, 503, 504}


def _backoff(attempt):
    return min(2 ** attempt * 0.5, 8.0)


class Rovecode:
    def __init__(self, api_key, base_url="https://api.rovecode.dev/v1",
                 timeout=600, max_retries=2, headers=None):
        if not api_key:
            raise RovecodeError("api_key is required — get one at rovecode.dev dashboard")
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.max_retries = max_retries
        self.headers = headers or {}
        self.chat = _Chat(self)
        self.models = _Models(self)
        self.images = _Images(self)
        self.videos = _Videos(self)

    # ---- transport --------------------------------------------------------

    def _open(self, method, path, body=None, stream=False):
        payload = None if body is None else json.dumps(body).encode()
        attempt = 0
        while True:
            req = urllib.request.Request(
                self.base_url + path, data=payload, method=method,
                headers={"Authorization": f"Bearer {self.api_key}",
                         "Content-Type": "application/json", **self.headers})
            try:
                resp = urllib.request.urlopen(req, timeout=self.timeout)
            except urllib.error.HTTPError as e:
                parsed = None
                try:
                    parsed = json.loads(e.read())
                except Exception:
                    pass
                err = error_from_response(e.code, parsed, e.headers)
                if attempt < self.max_retries and e.code in _RETRYABLE:
                    time.sleep(err.retry_after_ms / 1000 if isinstance(err, RateLimitError) else _backoff(attempt))
                    attempt += 1
                    continue
                raise err
            except Exception as e:
                if attempt < self.max_retries:
                    time.sleep(_backoff(attempt))
                    attempt += 1
                    continue
                raise RovecodeError(f"network error: {e}") from e
            if stream:
                return resp
            try:
                return json.loads(resp.read())
            except json.JSONDecodeError:
                raise RovecodeError("upstream returned non-JSON")

    # ---- SSE --------------------------------------------------------------

    def _sse(self, path, body):
        resp = self._open("POST", path, {**body, "stream": True}, stream=True)
        buf = b""
        for raw in resp:
            buf += raw
            while b"\n\n" in buf:
                frame, buf = buf.split(b"\n\n", 1)
                for line in frame.decode("utf-8", "replace").splitlines():
                    if not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if not data:
                        continue
                    if data == "[DONE]":
                        return
                    try:
                        parsed = json.loads(data)
                    except json.JSONDecodeError:
                        continue
                    err = parsed.get("error") if isinstance(parsed, dict) else None
                    if isinstance(err, dict) and err.get("message"):
                        raise APIError(err["message"], type=err.get("type"))
                    yield parsed


class _Completions:
    def __init__(self, client):
        self._c = client

    def create(self, model, messages, stream=False, **kw):
        body = {"model": model, "messages": messages, **kw}
        if stream:
            return self._c._sse("/chat/completions", body)
        return self._c._open("POST", "/chat/completions", body)

    def stream(self, model, messages, **kw):
        return self._c._sse("/chat/completions", {"model": model, "messages": messages, **kw})

    def collect(self, model, messages, **kw):
        """Stream and accumulate: returns {"content", "reasoning", "usage"}."""
        content, reasoning, usage = "", "", None
        for chunk in self.stream(model, messages, **kw):
            delta = (chunk.get("choices") or [{}])[0].get("delta") or {}
            content += delta.get("content") or ""
            reasoning += delta.get("reasoning_content") or ""
            if chunk.get("usage"):
                usage = chunk["usage"]
        out = {"content": content, "reasoning": reasoning}
        if usage:
            out["usage"] = usage
        return out


class _Chat:
    def __init__(self, client):
        self.completions = _Completions(client)


class _Models:
    def __init__(self, client):
        self._c = client

    def list(self):
        return self._c._open("GET", "/models")


class _Images:
    def __init__(self, client):
        self._c = client

    def generate(self, prompt, model="anime-1", n=1, size="1024x1024"):
        return self._c._open("POST", "/images/generations",
                             {"prompt": prompt, "model": model, "n": n, "size": size})


class _Videos:
    def __init__(self, client):
        self._c = client

    def generate(self, prompt, model, **kw):
        return self._c._open("POST", "/videos/generations",
                             {"prompt": prompt, "model": model, **kw})

    def wait(self, job_id, interval=5.0, timeout=600.0):
        deadline = time.time() + timeout
        while True:
            job = self._c._open("GET", f"/videos/{job_id}")
            if job.get("status") in ("completed", "failed"):
                return job
            if time.time() > deadline:
                raise RovecodeError(f"video job {job_id} did not finish in time")
            time.sleep(interval)
