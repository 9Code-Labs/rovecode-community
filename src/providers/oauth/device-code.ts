/** OAuth 2.0 device-authorization polling (RFC 8628 §3.4–3.5) — VENDORED from pi.
 *
 *  Source: earendil-works/pi, packages/ai/src/auth/oauth/device-code.ts (snapshot under
 *  research/source_snapshots/earendil-works-pi, @earendil-works/ai 0.84.4). License: MIT —
 *
 *    Copyright (c) 2025 Mario Zechner
 *
 *    Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
 *    associated documentation files (the "Software"), to deal in the Software without restriction,
 *    including without limitation the rights to use, copy, modify, merge, publish, distribute,
 *    sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
 *    furnished to do so, subject to the following conditions: The above copyright notice and this
 *    permission notice shall be included in all copies or substantial portions of the Software.
 *    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
 *    NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 *    NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
 *    DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 *    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 *
 *  Local changes (port #66): `sleep` and `now` are injectable (the tests drive pending → slow_down →
 *  complete with a recording sleep and a fixed clock, and pin the interval arithmetic); the default
 *  sleep is pi's abortableSleep; the messages lose the WSL clock-drift paragraph's second sentence.
 *  Semantics unchanged: a missing `interval` means 5 s (§3.2), `slow_down` adds 5 s (§3.5) unless the
 *  server states a new interval (GitHub does), never faster than 1 s, deadline = `expires_in`. */

const CANCEL_MESSAGE = "login cancelled";
const TIMEOUT_MESSAGE = "device flow timed out";
const SLOW_DOWN_TIMEOUT_MESSAGE = "device flow timed out after one or more slow_down responses (often clock drift in a WSL/VM — sync the clock and retry)";
const MINIMUM_INTERVAL_MS = 1000;
/** RFC 8628 §3.2: when the server omits `interval` the client polls every 5 s */
const DEFAULT_POLL_INTERVAL_SECONDS = 5;
/** RFC 8628 §3.5: `slow_down` means the interval grows by 5 s */
const SLOW_DOWN_INTERVAL_INCREMENT_MS = 5000;

type DeviceCodeIncompletePollResult =
  | { status: "pending" }
  | { status: "slow_down"; intervalSeconds?: number }
  | { status: "failed"; message: string };

export type DeviceCodePollResult<T> = DeviceCodeIncompletePollResult | { status: "complete"; value: T };

export interface DeviceCodePollOptions<T> {
  intervalSeconds?: number;
  expiresInSeconds?: number;
  /** wait one interval before the first poll (GitHub's flow; the user has not even seen the code yet) */
  waitBeforeFirstPoll?: boolean;
  poll: () => Promise<DeviceCodePollResult<T>>;
  signal: AbortSignal;
  /** injectable timer (default abortableSleep) */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** injectable clock (default Date.now) */
  now?: () => number;
}

export function abortableSleep(ms: number, signal: AbortSignal, cancelMessage: string = CANCEL_MESSAGE): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error(cancelMessage));
      return;
    }
    const onAbort = () => {
      clearTimeout(timeout);
      reject(new Error(cancelMessage));
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function pollDeviceCodeFlow<T>(options: DeviceCodePollOptions<T>): Promise<T> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? abortableSleep;
  const deadline = typeof options.expiresInSeconds === "number" ? now() + options.expiresInSeconds * 1000 : Number.POSITIVE_INFINITY;
  let intervalMs = Math.max(MINIMUM_INTERVAL_MS, Math.floor((options.intervalSeconds ?? DEFAULT_POLL_INTERVAL_SECONDS) * 1000));

  let slowDownResponses = 0;
  if (options.waitBeforeFirstPoll) {
    const remainingMs = deadline - now();
    if (remainingMs > 0) await sleep(Math.min(intervalMs, remainingMs), options.signal);
  }

  while (now() < deadline) {
    if (options.signal.aborted) throw new Error(CANCEL_MESSAGE);

    const result = await options.poll();
    if (result.status === "complete") return result.value;
    if (result.status === "failed") throw new Error(result.message);
    if (result.status === "slow_down") {
      slowDownResponses += 1;
      // Use the server-provided interval when given (GitHub reports the new required minimum in
      // `interval`); trusting only a client-tracked value risks polling early forever under WSL/VM
      // clock drift. Otherwise apply RFC 8628 §3.5: increase by 5 seconds.
      intervalMs = typeof result.intervalSeconds === "number" && Number.isFinite(result.intervalSeconds) && result.intervalSeconds > 0
        ? Math.max(MINIMUM_INTERVAL_MS, Math.floor(result.intervalSeconds * 1000))
        : Math.max(MINIMUM_INTERVAL_MS, intervalMs + SLOW_DOWN_INTERVAL_INCREMENT_MS);
    }

    const remainingMs = deadline - now();
    if (remainingMs <= 0) break;
    await sleep(Math.min(intervalMs, remainingMs), options.signal);
  }

  throw new Error(slowDownResponses > 0 ? SLOW_DOWN_TIMEOUT_MESSAGE : TIMEOUT_MESSAGE);
}
