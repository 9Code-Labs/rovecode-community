"""Typed errors — every API failure carries its `incident` id so a support
ticket can be resolved from the server logs without guessing."""
import re

_INCIDENT_RE = re.compile(r"\(incident ([0-9a-f]{6,})\)", re.I)


class RovecodeError(Exception):
    def __init__(self, message, status=None, incident=None, type=None):
        super().__init__(message)
        self.status = status
        self.incident = incident
        self.type = type


class AuthenticationError(RovecodeError):
    """401 — key missing, unknown or revoked."""


class PermissionError(RovecodeError):  # noqa: A001 — intentional, mirrors the API
    """403 — key valid but not allowed (plan gate, restricted model)."""


class NotFoundError(RovecodeError):
    """404 — unknown model id. Call client.models.list() for the live catalog."""


class ContentFilterError(RovecodeError):
    """400 with a provider content-filter signature — the conversation content
    was flagged upstream, not the request shape. Rephrase or switch model."""


class RateLimitError(RovecodeError):
    """429 — rate limited or quota exhausted. Retry after `retry_after_ms`."""

    def __init__(self, message, retry_after_ms=2000, **kw):
        super().__init__(message, **kw)
        self.retry_after_ms = retry_after_ms


class APIConnectionError(RovecodeError):
    """5xx / network — the platform side failed. Safe to retry with backoff."""


class APIError(RovecodeError):
    """Anything else the API returned as an error body."""


def error_from_response(status, body, headers=None):
    message = f"HTTP {status}"
    err_type = None
    if isinstance(body, dict):
        inner = body.get("error") if isinstance(body.get("error"), dict) else body
        message = inner.get("message") or body.get("detail") or message
        err_type = inner.get("type")
    elif isinstance(body, str) and body:
        message = body[:300]
    m = _INCIDENT_RE.search(message)
    incident = m.group(1) if m else None
    retry_ms = None
    if headers and headers.get("retry-after"):
        try:
            retry_ms = int(headers["retry-after"]) * 1000
        except ValueError:
            pass

    kw = {"status": status, "incident": incident, "type": err_type}
    if status == 401:
        return AuthenticationError(message, **kw)
    if status == 403:
        return PermissionError(message, **kw)
    if status == 404:
        return NotFoundError(message, **kw)
    if status == 429:
        return RateLimitError(message, retry_after_ms=retry_ms or 2000, **kw)
    if status == 400 and re.search(r"content filter|inappropriate content|data_inspection", message, re.I):
        return ContentFilterError(message, **kw)
    if status >= 500:
        return APIConnectionError(message, **kw)
    return APIError(message, **kw)
