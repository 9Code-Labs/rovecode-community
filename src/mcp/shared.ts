/** Shared MCP plumbing (port #57, split out of client.ts for the ADR-002 cap):
 *  the ONE render cap every MCP payload fed back to the model shares (tool
 *  results, prompt messages, resource contents — mirroring the bash tool's 10k
 *  output cap in coding/hashline.ts runOnce), the bounded pagination walk, the
 *  timeout race, and the per-call abort signal every SDK request goes through
 *  (client.ts for tools, prompts-resources.ts for the rest — the leak it stops is
 *  documented on perCallSignal). Also the token-free "needs login" remedy, kept
 *  here so transport.ts can name it without loading oauth.ts (which imports the SDK).
 *  SDK-free by design: this module is on the boot path through tools.ts. */

import { isRecord } from "./config.ts";

/** Pagination guard: no sane server needs 50 list pages; beyond this we assume
 *  a misbehaving server and stop instead of looping forever. */
export const MAX_LIST_PAGES = 50;
/** Chars of any one MCP result the conversation ever sees. */
export const OUTPUT_MAX = 10_000;

/** Cap text at OUTPUT_MAX chars; the marker names what was cut. */
export function capOutput(text: string, what = "mcp output"): string {
  if (text.length <= OUTPUT_MAX) return text;
  return `${text.slice(0, OUTPUT_MAX)}\n[${what} truncated: showing ${OUTPUT_MAX} of ${text.length} chars]`;
}

/** Flatten an MCP content array to text; non-text parts become markers. Falls
 *  back to structuredContent JSON when there is no text at all. Capped. */
export function renderContent(content: unknown, structured: unknown): string {
  const parts: string[] = [];
  if (Array.isArray(content)) {
    for (const item of content) {
      if (!isRecord(item)) continue;
      if (item.type === "text" && typeof item.text === "string") parts.push(item.text);
      else if (typeof item.type === "string") parts.push(`[${item.type} content]`);
    }
  }
  if (parts.length === 0 && structured !== undefined) {
    try {
      parts.push(JSON.stringify(structured));
    } catch {
      /* unserializable structured content */
    }
  }
  return capOutput(parts.join("\n"));
}

/** One call's signal, linked to the caller's and thrown away with the call.
 *
 *  The SDK does `options.signal.addEventListener("abort", …)` per request (shared/protocol.js:709) and
 *  never removes it. Every surface passes the RUN's signal, which lives for the whole run, so the
 *  listeners pile up on one emitter: at eleven, Node fires MaxListenersExceededWarning and prints the
 *  emitter it is complaining about — a whole Writable, pages of it — on stderr, straight over the TUI's
 *  alternate screen. Observed on a Playwright MCP session, twelve calls in.
 *
 *  A per-call controller ends that: the SDK's listener belongs to a signal nobody keeps, and the link
 *  back to the run's signal is removed in the caller's finally. Aborting still works in both directions
 *  — the run aborts the call; the call finishing does not touch the run. Every request the manager or
 *  the depth index makes (tools/list, tools/call, prompts/list, prompts/get, resources/list,
 *  resources/templates/list, resources/read) goes through one of these; mcp-signal-leak.test.ts counts. */
export function perCallSignal(outer?: AbortSignal): { signal: AbortSignal; dispose: () => void } {
  const ac = new AbortController();
  if (outer === undefined) return { signal: ac.signal, dispose: () => {} };
  if (outer.aborted) { ac.abort(outer.reason); return { signal: ac.signal, dispose: () => {} }; }
  const forward = () => ac.abort(outer.reason);
  outer.addEventListener("abort", forward, { once: true });
  return { signal: ac.signal, dispose: () => outer.removeEventListener("abort", forward) };
}

/** Run one SDK request under a per-call signal: `fn` gets the throwaway signal, the link is dropped in finally. */
export async function withCallSignal<T>(outer: AbortSignal | undefined, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const per = perCallSignal(outer);
  try {
    return await fn(per.signal);
  } finally {
    per.dispose();
  }
}

/** JSON-RPC -32601 from the server (the SDK throws McpError with `.code`): a resources-capable server
 *  without a templates/list handler. Duck-typed so this module never imports the SDK's error class. */
export function isMethodNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === -32601;
}

/** the ONE remedy text — token-free, ≤ 80 chars for names ≤ 20 chars so status.ts's clip keeps it whole */
export function needsLoginText(name: string): string {
  return `needs login — run \`rovecode mcp login ${name}\``;
}

/** Thrown by the runtime OAuth provider (oauth.ts) wherever the SDK would need a browser or a registration;
 *  transport.ts describeError passes the message through as-is. */
export class McpNeedsLoginError extends Error {
  constructor(name: string) {
    super(needsLoginText(name));
    this.name = "McpNeedsLoginError";
  }
}

/** a configured `headers.Authorization` (any case) — static auth, never overridden by a stored token */
export function hasStaticAuthorization(config: { headers?: Record<string, string> | undefined }): boolean {
  return config.headers !== undefined && Object.keys(config.headers).some((k) => k.toLowerCase() === "authorization");
}

export async function withTimeout<T>(p: Promise<T>, ms: number, note: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const gate = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(note)), ms);
  });
  try {
    return await Promise.race([p, gate]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** One page of a paginated MCP list (tools / prompts / resources / templates). */
export interface ListPage<T> { items: T[]; nextCursor?: string | undefined }

/** Walk a paginated list under the house bounds: a repeated cursor or more than
 *  MAX_LIST_PAGES pages throws (partial count in the message) instead of hanging
 *  the agent; the signal is checked between pages (the page fetcher hands it to
 *  the SDK for in-flight cancellation). `what` is the singular noun for messages. */
export async function walkPages<T>(
  what: string,
  server: string,
  fetchPage: (cursor: string | undefined) => Promise<ListPage<T>>,
  signal?: AbortSignal,
): Promise<T[]> {
  const items: T[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let pages = 0;
  do {
    if (signal?.aborted) throw new Error(`${what} listing on "${server}" aborted`);
    const page = await fetchPage(cursor);
    pages += 1;
    items.push(...page.items);
    cursor = typeof page.nextCursor === "string" ? page.nextCursor : undefined;
    if (cursor !== undefined) {
      if (seenCursors.has(cursor)) {
        throw new Error(`${what} listing on "${server}" stopped: server repeated pagination cursor ${JSON.stringify(cursor)} (partial: ${items.length} ${what}s in ${pages} pages)`);
      }
      seenCursors.add(cursor);
      if (pages >= MAX_LIST_PAGES) {
        throw new Error(`${what} listing on "${server}" stopped after ${MAX_LIST_PAGES} pages without a final page (partial: ${items.length} ${what}s)`);
      }
    }
  } while (cursor !== undefined);
  return items;
}
