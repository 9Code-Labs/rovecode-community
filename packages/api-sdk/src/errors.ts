/** Typed errors — every API failure carries its `incident` id so a support
 *  ticket can be resolved from the server logs without guessing. */

export class RovecodeError extends Error {
  readonly status: number | undefined;
  /** server-side incident id — quote this when contacting support */
  readonly incident: string | undefined;
  readonly type: string | undefined;

  constructor(message: string, opts: { status?: number; incident?: string; type?: string } = {}) {
    super(message);
    this.name = new.target.name;
    this.status = opts.status;
    this.incident = opts.incident;
    this.type = opts.type;
  }
}

/** 401 — key missing, unknown or revoked. */
export class AuthenticationError extends RovecodeError {}

/** 403 — key valid but not allowed (plan gate, restricted model, blocked account). */
export class PermissionError extends RovecodeError {}

/** 404 — unknown model id. Call `client.models.list()` for the live catalog. */
export class NotFoundError extends RovecodeError {}

/** 400 with a provider content-filter signature — the conversation content was
 *  flagged upstream, not the request shape. Rephrase or switch model. */
export class ContentFilterError extends RovecodeError {}

/** 429 — rate limited or daily quota exhausted. Retrying after `retryAfterMs` usually succeeds. */
export class RateLimitError extends RovecodeError {
  readonly retryAfterMs: number;
  constructor(message: string, opts: { status?: number; incident?: string; type?: string; retryAfterMs?: number } = {}) {
    super(message, opts);
    this.retryAfterMs = opts.retryAfterMs ?? 2_000;
  }
}

/** 5xx / network — the platform side failed. Safe to retry with backoff. */
export class APIConnectionError extends RovecodeError {}

/** Anything else the API returned as an error body. */
export class APIError extends RovecodeError {}

const INCIDENT_RE = /\(incident ([0-9a-f]{6,})\)/i;

export function errorFromResponse(status: number, body: unknown, headers?: Headers): RovecodeError {
  let message = `HTTP ${status}`;
  let type: string | undefined;
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    const inner = (b.error && typeof b.error === "object" ? b.error : b) as Record<string, unknown>;
    if (typeof inner.message === "string") message = inner.message;
    else if (typeof b.detail === "string") message = b.detail;
    if (typeof inner.type === "string") type = inner.type;
  } else if (typeof body === "string" && body) {
    message = body.slice(0, 300);
  }
  const incident = INCIDENT_RE.exec(message)?.[1];
  const retryAfterMs = headers?.get("retry-after") ? Number(headers.get("retry-after")) * 1000 : undefined;

  if (status === 401) return new AuthenticationError(message, { status, ...(incident ? { incident } : {}), ...(type ? { type } : {}) });
  if (status === 403) return new PermissionError(message, { status, ...(incident ? { incident } : {}), ...(type ? { type } : {}) });
  if (status === 404) return new NotFoundError(message, { status, ...(incident ? { incident } : {}), ...(type ? { type } : {}) });
  if (status === 429) return new RateLimitError(message, { status, ...(incident ? { incident } : {}), ...(type ? { type } : {}), ...(retryAfterMs ? { retryAfterMs } : {}) });
  if (status === 400 && /content filter|inappropriate content|data_inspection/i.test(message)) {
    return new ContentFilterError(message, { status, ...(incident ? { incident } : {}), ...(type ? { type } : {}) });
  }
  if (status >= 500) return new APIConnectionError(message, { status, ...(incident ? { incident } : {}), ...(type ? { type } : {}) });
  return new APIError(message, { status, ...(incident ? { incident } : {}), ...(type ? { type } : {}) });
}
