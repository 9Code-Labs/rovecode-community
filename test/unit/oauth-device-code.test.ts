/** Port #66 — the vendored device-code poller (RFC 8628) and the PKCE/state helpers, driven with a
 *  recording sleep and a fixed clock: the documented interval/backoff sequence is pinned exactly
 *  (pending → slow_down → complete), the server-stated interval wins, the 5 s default and 1 s floor
 *  hold, `failed` stops polling, the deadline and the abort surface as their messages, and the
 *  S256 challenge really is the SHA-256 of the verifier. No real timers except one short
 *  abortableSleep check. */

import { expect, test } from "bun:test";
import { abortableSleep, pollDeviceCodeFlow, type DeviceCodePollResult } from "../../src/providers/oauth/device-code.ts";
import { base64url, generatePKCE, randomState } from "../../src/providers/oauth/pkce.ts";

function withDeadline<T>(p: Promise<T>, ms = 5_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`exceeded ${ms} ms`)), ms); });
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer)) as Promise<T>;
}

function fakeClock(start = 1_700_000_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

/** a sleep that records the requested ms, advances the fake clock and returns at once */
function recordingSleep(clock: { advance: (ms: number) => void }) {
  const sleeps: number[] = [];
  return { sleeps, sleep: async (ms: number) => { sleeps.push(ms); clock.advance(ms); } };
}

function scripted<T>(results: DeviceCodePollResult<T>[]) {
  let polls = 0;
  return { polls: () => polls, poll: async () => { const r = results[polls]; polls++; if (!r) throw new Error("polled past the script"); return r; } };
}

test("pending → slow_down → complete: one interval before the first poll, the interval again after pending, +5 s after slow_down (RFC 8628 §3.5)", async () => {
  const clock = fakeClock();
  const { sleeps, sleep } = recordingSleep(clock);
  const script = scripted<string>([{ status: "pending" }, { status: "slow_down" }, { status: "complete", value: "the-value" }]);
  const value = await withDeadline(pollDeviceCodeFlow<string>({
    intervalSeconds: 5, expiresInSeconds: 900, waitBeforeFirstPoll: true, signal: new AbortController().signal, sleep, now: clock.now, poll: script.poll,
  }));
  expect(value).toBe("the-value");
  expect(script.polls()).toBe(3);
  // MUTATION TARGET: drop the +5 s increment → [5000, 5000, 5000]
  expect(sleeps).toEqual([5000, 5000, 10000]);
});

test("slow_down with a server-stated interval polls at THAT interval (GitHub reports the new minimum)", async () => {
  const clock = fakeClock();
  const { sleeps, sleep } = recordingSleep(clock);
  const script = scripted<number>([{ status: "slow_down", intervalSeconds: 12 }, { status: "pending" }, { status: "complete", value: 1 }]);
  await withDeadline(pollDeviceCodeFlow<number>({ intervalSeconds: 5, signal: new AbortController().signal, sleep, now: clock.now, poll: script.poll }));
  expect(sleeps).toEqual([12000, 12000]); // no wait-before-first-poll here; the stated interval sticks
});

test("no interval → the 5 s default (§3.2); sub-second intervals are floored to 1 s", async () => {
  const clock = fakeClock();
  const a = recordingSleep(clock);
  await withDeadline(pollDeviceCodeFlow<number>({ signal: new AbortController().signal, sleep: a.sleep, now: clock.now, poll: scripted<number>([{ status: "pending" }, { status: "complete", value: 1 }]).poll }));
  expect(a.sleeps).toEqual([5000]);
  const b = recordingSleep(clock);
  await withDeadline(pollDeviceCodeFlow<number>({ intervalSeconds: 0.2, signal: new AbortController().signal, sleep: b.sleep, now: clock.now, poll: scripted<number>([{ status: "pending" }, { status: "complete", value: 1 }]).poll }));
  expect(b.sleeps).toEqual([1000]);
});

test("failed → throws the server's message and polls no further", async () => {
  const clock = fakeClock();
  const { sleeps, sleep } = recordingSleep(clock);
  const script = scripted<number>([{ status: "failed", message: "device flow failed: expired_token" }, { status: "complete", value: 1 }]);
  await expect(withDeadline(pollDeviceCodeFlow<number>({ intervalSeconds: 5, signal: new AbortController().signal, sleep, now: clock.now, poll: script.poll }))).rejects.toThrow("device flow failed: expired_token");
  expect(script.polls()).toBe(1);
  expect(sleeps).toEqual([]);
});

test("deadline: expires_in elapses → 'device flow timed out'; after any slow_down the clock-drift variant; the last sleep is clipped to the remaining time", async () => {
  const clock = fakeClock();
  const a = recordingSleep(clock);
  const forever = { poll: async (): Promise<DeviceCodePollResult<number>> => ({ status: "pending" }) };
  await expect(withDeadline(pollDeviceCodeFlow<number>({ intervalSeconds: 5, expiresInSeconds: 12, signal: new AbortController().signal, sleep: a.sleep, now: clock.now, poll: forever.poll }))).rejects.toThrow("device flow timed out");
  expect(a.sleeps).toEqual([5000, 5000, 2000]); // 12 s budget: 5 + 5 + the 2 s remainder, then the deadline
  const b = recordingSleep(clock);
  const slow = { poll: async (): Promise<DeviceCodePollResult<number>> => ({ status: "slow_down" }) };
  await expect(withDeadline(pollDeviceCodeFlow<number>({ intervalSeconds: 5, expiresInSeconds: 8, signal: new AbortController().signal, sleep: b.sleep, now: clock.now, poll: slow.poll }))).rejects.toThrow(/slow_down responses/);
});

test("abort: an already-aborted signal or one that fires between polls → 'login cancelled'", async () => {
  const clock = fakeClock();
  const aborted = new AbortController();
  aborted.abort();
  await expect(withDeadline(pollDeviceCodeFlow<number>({ intervalSeconds: 5, signal: aborted.signal, sleep: recordingSleep(clock).sleep, now: clock.now, poll: async () => ({ status: "complete", value: 1 }) }))).rejects.toThrow("login cancelled");
  const ac = new AbortController();
  const sleep = async () => { ac.abort(); }; // the user hits Ctrl-C during the wait
  await expect(withDeadline(pollDeviceCodeFlow<number>({ intervalSeconds: 5, signal: ac.signal, sleep, now: clock.now, poll: async () => ({ status: "pending" }) }))).rejects.toThrow("login cancelled");
});

test("abortableSleep (the default timer): resolves after ms, rejects on abort with the timer cleared", async () => {
  const t0 = Date.now();
  await withDeadline(abortableSleep(20, new AbortController().signal));
  expect(Date.now() - t0).toBeGreaterThanOrEqual(15);
  const ac = new AbortController();
  const pending = abortableSleep(60_000, ac.signal);
  ac.abort();
  await expect(withDeadline(pending)).rejects.toThrow("login cancelled");
});

test("PKCE: 43-char base64url verifier, challenge = base64url(SHA-256(verifier)); state nonce is 43 chars and unique", async () => {
  const { verifier, challenge } = await generatePKCE();
  expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  expect(challenge).toBe(base64url(digest));
  expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const states = new Set(Array.from({ length: 50 }, () => randomState()));
  expect(states.size).toBe(50);
  for (const s of states) expect(s).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(base64url(new Uint8Array([251, 255, 191]))).toBe("-_-_"); // + and / become - and _, no padding
});
