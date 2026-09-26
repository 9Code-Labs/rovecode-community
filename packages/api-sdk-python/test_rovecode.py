"""Smoke tests with a stubbed transport — no network."""
import io
import json
import unittest
import urllib.error

from rovecode import (AuthenticationError, ContentFilterError, PermissionError,
                      RateLimitError, Rovecode)


def make_client(handler):
    c = Rovecode(api_key="rove_live_test", base_url="https://api.test/v1", max_retries=0)
    c._open_orig = c._open

    import urllib.request
    class FakeResp(io.BytesIO):
        def __init__(self, data, code=200):
            super().__init__(data)
            self.code = code
            self.headers = {}
        def __enter__(self):
            return self
        def __exit__(self, *a):
            return False

    def fake_urlopen(req, timeout=None):
        return handler(req, FakeResp)

    import rovecode.client as rc
    rc.urllib.request.urlopen = fake_urlopen
    return c


class SdkTest(unittest.TestCase):
    def test_chat_non_stream(self):
        def h(req, resp_cls):
            return resp_cls(json.dumps({"id": "x", "choices": [{"index": 0, "message": {"role": "assistant", "content": "hi"}, "finish_reason": "stop"}]}).encode())
        c = make_client(h)
        res = c.chat.completions.create(model="m", messages=[{"role": "user", "content": "hi"}])
        self.assertEqual(res["choices"][0]["message"]["content"], "hi")

    def test_stream_collect(self):
        chunks = [
            {"choices": [{"delta": {"reasoning_content": "dusun"}, "finish_reason": None}]},
            {"choices": [{"delta": {"content": "mer"}, "finish_reason": None}]},
            {"choices": [{"delta": {"content": "haba"}, "finish_reason": None}]},
            {"choices": [{"delta": {}, "finish_reason": "stop"}], "usage": {"total_tokens": 5}},
        ]
        body = "".join(f"data: {json.dumps(x)}\n\n" for x in chunks) + "data: [DONE]\n\n"
        c = make_client(lambda req, rc: rc(body.encode()))
        out = c.chat.completions.collect(model="m", messages=[{"role": "user", "content": "x"}])
        self.assertEqual(out["content"], "merhaba")
        self.assertEqual(out["reasoning"], "dusun")
        self.assertEqual(out["usage"]["total_tokens"], 5)

    def test_typed_errors(self):
        cases = [
            (401, AuthenticationError),
            (403, PermissionError),
            (429, RateLimitError),
            (400, ContentFilterError),  # body mentions content filter
        ]
        for status, cls in cases:
            def h(req, resp_cls, s=status):
                msg = "The provider's content filter rejected this conversation" if s == 400 else "err"
                raise urllib.error.HTTPError(req.full_url, s, "", {}, io.BytesIO(json.dumps({"error": {"message": msg}}).encode()))
            c = make_client(h)
            with self.assertRaises(cls):
                c.models.list()


if __name__ == "__main__":
    unittest.main()
