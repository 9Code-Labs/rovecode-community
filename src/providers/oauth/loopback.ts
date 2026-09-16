/** One-shot loopback OAuth callback server (port #66, extracted for port #76): binds 127.0.0.1 on an ephemeral
 *  port, waits for ONE browser GET on `/callback/<nonce>` and hands its `?code=` to the caller's `onCode`.
 *
 *  Extracted — behaviour unchanged — from the OpenRouter flow of port #66 (openrouter.ts, itself ported from pi
 *  packages/ai/src/auth/oauth/openrouter.ts: earendil-works/pi, MIT, Copyright (c) 2025 Mario Zechner; snapshot under
 *  research/source_snapshots/earendil-works-pi) so the MCP login (mcp/oauth.ts) shares every rule:
 *  - Bun.serve on CALLBACK_HOST (127.0.0.1) port 0 — never 0.0.0.0, never a fixed port (opencode's 19876 is the
 *    anti-pattern); the callback URL is built from the BOUND server (hostname + port), so a bind regression shows up
 *    in the URL the tests pin;
 *  - anything but GET is a 404 (pi: `request.method !== "GET"` → 404), so is a request whose Host is not the loopback
 *    host (a DNS-rebinding page reaching the port) and a request off the `/callback/` prefix (a favicon probe) —
 *    all three keep waiting;
 *  - the callback PATH carries a fresh 32-byte nonce (pi randomizes the path with a UUID): a GET on
 *    `/callback/<anything else>` is a STATE MISMATCH — 400 and the whole login rejects, not merely ignored, because a
 *    forged redirect is the one thing the nonce exists to catch;
 *  - `requireStateParam` (port #76; the MCP SDK appends `state` to the authorize URL): `?state=` must equal the nonce
 *    too, else the same 400 + reject. OpenRouter passes none — whether it preserves a query string on the redirect is
 *    not live-verified, and a wrong guess would abort every real login;
 *  - `?error=` (RFC 6749 §4.1.2.1) rejects with the provider's reason; a GET without `code` is a 400 that keeps waiting;
 *  - single use: once a callback is being exchanged (`claimed`) or the outcome is decided (`closing`, flipped
 *    synchronously; `settled` follows SETTLE_DELAY_MS later so the browser gets its page first) every later request —
 *    genuine or forged — is a 409 that never reaches `onCode`. The ONE accepted code runs `onCode` BEFORE the 200 is
 *    sent (exchange-before-200); a throwing `onCode` answers 502 and rejects the login;
 *  - the server closes when the login settles — success, mismatch, denial, `onCode` failure, abort (`signal`),
 *    `stop()` or the timeout (5 minutes by default) — and refuses connections afterwards.
 *  Every message is built from `what` ("OpenRouter", `MCP server "x"`) so OpenRouter's texts stay verbatim. */

import { loginCancelled } from "./common.ts";

/** the callback server binds loopback only — the browser must run on this machine */
export const CALLBACK_HOST = "127.0.0.1";
export const DEFAULT_LOGIN_TIMEOUT_MS = 5 * 60_000;
/** the browser's response is flushed before the server goes away */
const SETTLE_DELAY_MS = 20;

export interface LoopbackOptions<T> {
  /** the per-login nonce (pkce.ts randomState): the callback path is `/callback/<nonce>` */
  nonce: string;
  /** Ctrl-C — aborting rejects `result` with loginCancelled() */
  signal: AbortSignal;
  /** who is being signed in to; prefixes every message and page ("OpenRouter", `MCP server "x"`) */
  what: string;
  /** the sentence the 400 mismatch page ends with ("Run rovecode auth login openrouter again.") */
  retryHint: string;
  /** what `onCode` does, for the 502 page (default "key exchange") */
  exchange?: string;
  /** also require `?state=` to equal the nonce (the MCP SDK sends it; OpenRouter does not) */
  requireStateParam?: boolean;
  timeoutMs?: number;
  /** runs with the accepted code BEFORE the browser gets its 200 page; a throw answers 502 and rejects `result` */
  onCode: (code: string) => Promise<T>;
}

export interface LoopbackCallback<T> {
  /** `http://127.0.0.1:<port>/callback/<nonce>` from the BOUND server */
  callbackUrl: string;
  /** onCode's value; rejects on mismatch, denial, onCode failure, abort, stop() or timeout — never with a token */
  result: Promise<T>;
  /** stop the server now (idempotent; runs on its own once `result` settles) */
  stop(): void;
}

/** the thrown text for a callback on a wrong path (or, with requireStateParam, a wrong `?state=`) */
export function stateMismatchMessage(what: string): string {
  return `${what} OAuth: state mismatch on the callback — login aborted`;
}

function html(status: number, text: string): Response {
  return new Response(`<!doctype html><meta charset="utf-8"><title>rovecode</title><p>${text}</p>`, {
    status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

function minutes(ms: number): string {
  return ms >= 60_000 ? `${Math.round(ms / 60_000)} minutes` : `${ms} ms`;
}

export function startLoopbackCallback<T>(opts: LoopbackOptions<T>): LoopbackCallback<T> {
  type Outcome = { value: T } | { error: Error };
  const callbackPath = `/callback/${opts.nonce}`;
  const exchange = opts.exchange ?? "key exchange";
  let settle: (o: Outcome) => void = () => {};
  const outcome = new Promise<Outcome>((resolve) => { settle = resolve; });
  let settled = false;
  let claimed = false;
  /** the outcome is decided but `settled` waits SETTLE_DELAY_MS — flipped synchronously so no callback that lands in
   *  that window is exchanged (a forged mismatch first, the genuine redirect 5 ms later) */
  let closing = false;
  const finish = (o: Outcome): void => {
    if (settled) return;
    settled = true;
    settle(o);
  };
  // the browser gets its page before the login settles and the server stops
  const finishAfterResponse = (o: Outcome): void => { closing = true; setTimeout(() => finish(o), SETTLE_DELAY_MS); };
  const mismatch = (): Response => {
    finishAfterResponse({ error: new Error(stateMismatchMessage(opts.what)) });
    return html(400, `State mismatch — this login was aborted. ${opts.retryHint}`);
  };

  const server = Bun.serve({
    port: 0,
    hostname: CALLBACK_HOST,
    async fetch(req) {
      // pi: the redirect is a browser GET — anything else is not a callback (404, keep waiting)
      if (req.method !== "GET") return html(404, "Not an OAuth callback.");
      const url = new URL(req.url);
      // a foreign Host header (a page at evil.example resolving to 127.0.0.1) is never the redirect we issued
      if (url.hostname !== CALLBACK_HOST) return html(404, "Not an OAuth callback.");
      if (!url.pathname.startsWith("/callback/")) return html(404, "Not an OAuth callback.");
      // single use: once a callback is being exchanged (claimed) or the outcome is decided (closing / settled),
      // every later request — genuine or forged — is a 409 that never reaches onCode
      if (settled || claimed || closing) return html(409, "This OAuth callback has already been used.");
      if (url.pathname !== callbackPath) return mismatch();
      if (opts.requireStateParam === true && url.searchParams.get("state") !== opts.nonce) return mismatch();
      const denied = url.searchParams.get("error");
      if (denied) {
        finishAfterResponse({ error: new Error(`${opts.what} authorization denied: ${(url.searchParams.get("error_description") ?? denied).slice(0, 160)}`) });
        return html(400, `${opts.what} authorization was denied.`);
      }
      const code = url.searchParams.get("code");
      if (!code) return html(400, `${opts.what} returned no authorization code.`);
      claimed = true;
      try {
        const value = await opts.onCode(code);
        finishAfterResponse({ value });
        return html(200, `Signed in to ${opts.what} — you can close this tab and return to rovecode.`);
      } catch (e) {
        finishAfterResponse({ error: e instanceof Error ? e : new Error(String(e)) });
        return html(502, `${opts.what} ${exchange} failed — see the rovecode terminal.`);
      }
    },
  });

  // from the BOUND server, not the constant: a bind regression (0.0.0.0) shows up in the printed URL the tests pin
  const callbackUrl = `http://${server.hostname}:${server.port}${callbackPath}`;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS;
  const onAbort = (): void => finish({ error: loginCancelled() });
  opts.signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => finish({ error: new Error(`${opts.what} OAuth login timed out (${minutes(timeoutMs)})`) }), timeoutMs);
  let stopped = false;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    opts.signal.removeEventListener("abort", onAbort);
    server.stop(true);
    finish({ error: new Error(`${opts.what} OAuth login aborted`) }); // no-op when the outcome is already in
  };
  if (opts.signal.aborted) onAbort();
  const result = outcome.then((o) => {
    stop();
    if ("error" in o) throw o.error;
    return o.value;
  });
  result.catch(() => {}); // observed by the caller; a caller that stopped early must not leave it unhandled
  return { callbackUrl, result, stop };
}
