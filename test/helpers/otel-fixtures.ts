/** Shared fixtures for test/unit/otel.test.ts and otel-2.test.ts (port #39 OTel exporter): the sleep /
 *  deadline pair, HookCtx + call stand-ins, the collector endpoint, the recording fake fetch, the +1 ms
 *  clock, assistant message builder (ids from a module counter — only uniqueness matters), flat pricing,
 *  `make` (a hook set over all of the above), span/attribute accessors and the scripted standard /
 *  minimal runs in the loop's real order. No tests live here. */

import { createOtelHooks, type OtelHooks, type OtlpTraceRequest, type OtlpSpan, type PricingSource } from "../../src/telemetry/otel.ts";
import type { HookCtx } from "../../src/core/hooks.ts";
import type { Message } from "../../src/core/types.ts";

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** house hazard: an awaited promise with no pending timer hangs the runner forever */
export const deadline = <T>(p: Promise<T>, ms: number) => Promise.race([p, sleep(ms).then(() => "DEADLINE" as const)]);
export const ctx = (runId: string, sessionId = "s1"): HookCtx => ({ cwd: "/w", sessionId, runId });
export const call = { id: "c1", tool: "probe", args: { q: 1 } };
export const ENDPOINT = "http://collector:4318";
export const URL_ = `${ENDPOINT}/v1/traces`;

export interface Posted<B = OtlpTraceRequest> { url: string; headers: Record<string, string>; body: B }
/** records every POST; `respond(n, url)` decides the n-th call's outcome (#82: the URL tells the signal apart) */
export function fakeFetch(respond: (n: number, url: string) => Response | Promise<Response> = () => new Response("{}", { status: 200 })) {
  const posts: Posted[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => { headers[k] = v; });
    posts.push({ url: String(input), headers, body: JSON.parse(String(init?.body)) as OtlpTraceRequest });
    return respond(posts.length, String(input));
  }) as unknown as typeof fetch;
  return { fn, posts };
}
/** #82: the POSTs that went to one signal path (`/v1/traces` | `/v1/metrics` | `/v1/logs`), typed by the caller */
export const postsTo = <B = OtlpTraceRequest>(ff: { posts: Posted[] }, path: string): Posted<B>[] =>
  ff.posts.filter((p) => new URL(p.url).pathname === path) as unknown as Posted<B>[];
/** #82: the traces POSTs (the #39 assertions re-pinned per URL — metrics/logs now share the fake) */
export const traces = (ff: { posts: Posted[] }): Posted[] => postsTo(ff, "/v1/traces");
/** +1ms per reading, so every span/event time is distinct and ordered */
export const clock = (start = 1_700_000_000_000) => { let t = start; return () => (t += 1); };
export let seq = 0;
export const assistant = (usage: Message["usage"], origin?: Message["origin"]): Message =>
  ({ id: `m${++seq}`, role: "assistant", parts: [{ kind: "text", text: "x" }], parentId: null, createdAt: 0, ...(usage ? { usage } : {}), ...(origin ? { origin } : {}) });
export const flat: PricingSource = { lookup: () => ({ pricing: { inputPerMTok: 1, outputPerMTok: 10, cacheReadPerMTok: 0.1, cacheWritePerMTok: 2 } }) };
export const PM = { provider: "p", model: "m" };
export function make(over: Partial<Parameters<typeof createOtelHooks>[0]> = {}) {
  const ff = fakeFetch(); const msgs: Message[] = []; const warnings: string[] = [];
  const set = createOtelHooks({ endpoint: ENDPOINT, fetch: ff.fn, now: clock(), messages: () => msgs, pricing: flat, onWarning: (w) => warnings.push(w), ...over });
  return { set, ff, msgs, warnings };
}
export const spansOf = (req: OtlpTraceRequest): OtlpSpan[] => req.resourceSpans[0]!.scopeSpans[0]!.spans;
export const attr = (s: OtlpSpan, key: string): unknown => { const a = s.attributes.find((x) => x.key === key); return a ? Object.values(a.value)[0] : undefined; };
export const named = (spans: OtlpSpan[], name: string) => spans.filter((s) => s.name === name);

/** the loop's order for: turn 1 (tool call) → tool runs → turn 2 (text) → done */
export async function standardRun(set: OtelHooks, c: HookCtx, msgs: Message[], toolOk = true): Promise<void> {
  await set.on_event!(c, { type: "run_start", runId: c.runId!, sessionId: c.sessionId, goal: "g" }); // observer taps on_event before pre_run
  await set.pre_run!(c);
  await set.on_event!(c, { type: "turn_start", turn: 1 });
  msgs.push(assistant({ input: 100, output: 10, cacheRead: 5, cacheWrite: 2 }, PM));
  await set.on_event!(c, { type: "turn_end", turn: 1, stopReason: "tool_use" });
  await set.pre_tool!(c, call);
  await set.post_tool!(c, call, { ok: toolOk, output: "héllo" }); // 6 utf-8 bytes
  await set.on_event!(c, { type: "tool_execution_start", callId: "c1", tool: "probe", args: call.args });
  await set.on_event!(c, { type: "tool_execution_end", callId: "c1", ok: toolOk, output: "héllo", durationMs: 7 });
  await set.on_event!(c, { type: "turn_start", turn: 2 });
  msgs.push(assistant({ input: 50, output: 5 }, PM));
  await set.on_event!(c, { type: "turn_end", turn: 2, stopReason: "end_turn" });
  await set.on_event!(c, { type: "run_end", status: "done", summary: "final" });
  await set.post_run!(c, { status: "done", summary: "final" });
}
export async function minimalRun(set: OtelHooks, c: HookCtx, status: "done" | "stopped" | "error" | "budget" = "done"): Promise<void> {
  await set.pre_run!(c);
  await set.post_run!(c, { status, summary: "" });
}
