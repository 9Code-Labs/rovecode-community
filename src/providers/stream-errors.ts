/** Error-turn shaping for the wire adapters (extracted from stream.ts, port #23). ADR-003: the
 *  seam never throws — failures cross as AssistantTurn{stopReason:"error"|"aborted"}.
 *
 *  Non-2xx responses keep the exact error text the router classifies ("HTTP <status>: <body>",
 *  router.ts classifyStreamError) and additionally record the status + Retry-After header in a
 *  WeakMap side-channel keyed on the turn object — the same shape as the router's servedBy tag
 *  (router.ts:174-185), because AssistantTurn (core/types.ts) is shared/untouchable (no new turn
 *  field). The tool-call middleware passes error turns through by identity (empty parts → no
 *  rewrite, middleware.ts:352), so withRetry (providers/retry.ts) reads the header off the very
 *  object the adapter produced. */

import type { AssistantTurn } from "../core/types.ts";

export interface HttpErrorMeta {
  status: number;
  /** Raw Retry-After header value when the response carried one (RFC 9110 §10.2.3:
   *  delay-seconds or HTTP-date). Parsing is the consumer's job (retry.ts parseRetryAfter). */
  retryAfter?: string;
}

const HTTP_META = new WeakMap<AssistantTurn, HttpErrorMeta>();

/** Turn for a non-2xx response. Error text and the 300-char body bound are unchanged from the
 *  inline shape the adapters used before the extraction. */
export async function httpErrorTurn(res: Response): Promise<AssistantTurn> {
  const turn: AssistantTurn = { parts: [], stopReason: "error", usage: { input: 0, output: 0 }, error: `HTTP ${res.status}: ${(await res.text()).slice(0, 300)}` };
  const retryAfter = res.headers.get("retry-after");
  HTTP_META.set(turn, retryAfter === null ? { status: res.status } : { status: res.status, retryAfter });
  return turn;
}

/** Status + Retry-After recorded for an adapter-produced HTTP error turn; undefined for every
 *  other turn (transport failures, aborts, synthesized errors). */
export function httpErrorMeta(turn: AssistantTurn): HttpErrorMeta | undefined {
  return HTTP_META.get(turn);
}

/** Turn for a thrown fetch/stream error. options.signal abort (port #21) → honest "aborted" keeping SSE text already
 *  streamed (tool-call fragments dropped — truncated JSON); other errors keep parts empty (a router re-drive would dup). */
export function failedTurn(e: unknown, signal: AbortSignal | undefined, salvaged = ""): AssistantTurn {
  if (signal?.aborted) return { parts: salvaged ? [{ kind: "text", text: salvaged }] : [], stopReason: "aborted", usage: { input: 0, output: 0 } };
  return { parts: [], stopReason: "error", usage: { input: 0, output: 0 }, error: e instanceof Error ? e.message : String(e) };
}
