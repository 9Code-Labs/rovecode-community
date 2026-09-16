/** Shared seams for the web_search suites (port #56: test/unit/websearch.test.ts and
 *  test/unit/websearch-guard.test.ts). Nothing here touches the network: `seam` builds the tool
 *  over a scripted, recording fetch plus a resolver that knows ONLY the endpoint; the Response
 *  builders synthesize Exa's SSE/JSON envelopes; `guardEgress` swaps globalThis.fetch for the life
 *  of a test file so any URL outside the allow-list (a production tool dispatched by mistake) is
 *  refused AND tallied — the file's afterAll asserts the tally is empty. */

import { createWebSearchTool, parseMcpBody } from "../../src/tools/websearch.ts";
import type { Resolver } from "../../src/tools/webfetch.ts";
import type { Tool, ToolContext } from "../../src/core/types.ts";
import { EXA_SSE_BODY } from "./websearch.ts";

export const ctx = (signal: AbortSignal = new AbortController().signal, cwd = process.cwd()): ToolContext =>
  ({ sessionId: "s-search", cwd, signal, permissions: { effect: "allow" } });

/** Races against a REF'D deadline: a hung tool FAILS the test instead of freezing the runner. */
export async function within<T>(ms: number, p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`no result within ${ms}ms`)), ms); });
  try { return await Promise.race([p, deadline]); } finally { clearTimeout(timer); }
}

export const PUBLIC = ["93.184.216.34"];
/** Scripted DNS: the endpoint is public; any OTHER name is an error (a hop to it must be refused before DNS or by it). */
export const endpointOnly: Resolver = async (host) => { if (host === "mcp.exa.ai") return PUBLIC; throw new Error(`unexpected lookup ${host}`); };
export type Respond = (url: string, init: RequestInit) => Response | Promise<Response>;
export interface SeamOptions { resolve?: Resolver; timeoutMs?: number; apiKey?: string }
/** A tool whose fetch is scripted and recorded; the default resolver knows only the endpoint. */
export function seam(respond: Respond, opts: SeamOptions = {}): { tool: Tool; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  const tool = createWebSearchTool({
    fetch: async (url, init) => { calls.push({ url, init }); return respond(url, init); },
    resolve: opts.resolve ?? endpointOnly,
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
  });
  return { tool, calls };
}

export const envelope = (text: string): string => JSON.stringify({ result: { content: [{ type: "text", text }] }, jsonrpc: "2.0", id: 1 });
export const sse = (text: string): Response => new Response(`event: message\ndata: ${envelope(text)}\n\n`, { headers: { "content-type": "text/event-stream" } });
export const json = (body: string, status = 200): Response => new Response(body, { status, headers: { "content-type": "application/json" } });
export const redirect = (to: string, status: number): Response => new Response(null, { status, headers: { location: to } });
export const block = (title: string, url: string, body: string, published = "N/A"): string => `Title: ${title}\nURL: ${url}\nPublished: ${published}\nAuthor: N/A\nHighlights:\n${body}`;
export const blocks = (n: number, url: (i: number) => string = (i) => `https://r${i}.test/p`): string =>
  Array.from({ length: n }, (_, i) => block(`R${i + 1}`, url(i + 1), `body ${i + 1}`)).join("\n\n---\n\n");
export const recordedText = (): string => { const p = parseMcpBody(EXA_SSE_BODY)!; return "text" in p ? p.text : ""; };
export const sentArgs = (init: RequestInit): Record<string, unknown> =>
  (JSON.parse(String(init.body)) as { params: { arguments: Record<string, unknown> } }).params.arguments;

/** Replaces globalThis.fetch until restore(): URLs the predicate rejects are recorded in `egress`
 *  and fail with a clear error instead of leaving the machine. The production webSearchTool
 *  resolves `fetch` at call time, so a stray dispatch of it lands here, never on the backend. */
export function guardEgress(allow: (url: string) => boolean): { egress: string[]; restore: () => void } {
  const real = globalThis.fetch;
  const egress: string[] = [];
  const guarded = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!allow(url)) { egress.push(url); return Promise.reject(new Error(`network egress blocked in tests: ${url}`)); }
    return real(input, init);
  };
  globalThis.fetch = guarded as unknown as typeof fetch;
  return { egress, restore: () => { globalThis.fetch = real; } };
}
