/** OpenAI Responses API wire (aion port #75, brought over 2026-09-07) — the second OpenAI adapter beside stream.ts's
 *  /chat/completions pair. ADR-003 seam: ONE StreamFn, errors cross as stopReason "error" / "aborted", never a throw.
 *  Hand-rolled fetch + SSE exactly like stream.ts (no `openai` npm dependency). providers/wire-select.ts decides per
 *  call which of the two wires a request takes; this module never imports stream.ts at runtime (it shares sse.ts,
 *  stream-errors.ts, usage.ts, thinking.ts, catalog.ts and wire-responses.ts with it).
 *
 *  Request: POST <baseUrl>/responses `{ model, instructions?, input, tools?, stream: true, store: false,
 *  max_output_tokens?, reasoning? }`. `max_output_tokens` is max(cap, 16) — cap = model.maxTokens, the stream.ts rule
 *  — and is OMITTED on the ChatGPT Codex backend (a URL containing chatgpt.com/backend-api; pi's codex path never
 *  sends it), which also gets the `OpenAI-Beta: responses=experimental` + `originator: rovecode` headers.
 *  `reasoning: { effort, summary: "auto" }` is the Responses spelling of rovecode's ONE thinking dial
 *  (providers/thinking.ts thinkingPlan — the same dialect table stream.ts spreads as `reasoning_effort`; auto sends
 *  nothing, a model the catalog or the dialect marks without a reasoning mode sends nothing).
 *  NOT brought over: `include: ["reasoning.encrypted_content"]` and the reasoning item as a message part — rovecode
 *  has no reasoning MessagePart to replay it from (wire-responses.ts header), so asking the provider for encrypted
 *  content we would then discard is cost without product. Reasoning TEXT still streams live as reasoning_delta.
 *  Pattern sources, MIT — earendil-works/pi packages/ai/src/api: openai-responses.ts:290-302 (store:false,
 *  stream:true, max_output_tokens), :32-33 (the 16-token floor the API enforces), :323-332 (reasoning effort +
 *  summary "auto"); openai-codex-responses.ts:549-556 (`instructions`), :45 + :633-639 (chatgpt.com/backend-api →
 *  codex/responses), :1607-1609 + :1622 (chatgpt-account-id, originator, `OpenAI-Beta: responses=experimental`,
 *  accept text/event-stream); openai-responses-shared.ts:440,:463 (output slots keyed by output_index), :597-668
 *  (the deltas), :680-739 (output_item.done finalises a slot: message text authoritative, function_call arguments
 *  parsed), :757-759 (a stream without a terminal event is an error), :762-792 (stop mapping), :592-594 (a tool call
 *  overrides a completed stop), :742-755 (`<code>: <message>` for response.failed / error events).
 *  Pattern source, Apache-2.0 at pattern level (no code copied) — openai/codex: codex-rs/codex-api/src/sse/
 *  responses.rs:357-518 (the event set a client consumes; :843-845 fixtures pair `event:` and `data:` lines),
 *  codex-rs/model-provider-info/src/lib.rs:40 (CHATGPT_CODEX_BASE_URL), codex-rs/core/src/client.rs:688 (an
 *  `originator` header on every request — the value is `rovecode` here; codex's own OpenAI-Beta value is
 *  websocket-only, so `responses=experimental` is pi's). NOTICE entry: THIRD_PARTY_NOTICES.md, `## openai/codex`.
 *  NOT ported: `previous_response_id`, `prompt_cache_key` / `prompt_cache_retention`, `text.verbosity`,
 *  `service_tier`, `parallel_tool_calls`, `tool_choice`, strict / grammar / custom tools, developer-role items,
 *  the websocket and zstd transports, pi's retry loop (rovecode's withRetry + router classify the error turn as
 *  for chat completions) and codex's error taxonomy. Selection is static — no runtime 404 → chat re-issue.
 *
 *  Events (`data:` payloads through sse.ts; `event:` lines are ignored — `type` names the event):
 *  `response.output_text.delta` / `response.refusal.delta` → text_delta (and the abort-salvage buffer);
 *  `response.reasoning_summary_text.delta` / `response.reasoning_text.delta` → reasoning_delta — NEVER into the
 *  text buffer, never a text part (`…summary_part.done` → one "\n\n" reasoning_delta);
 *  `response.function_call_arguments.delta` accumulates per output_index (a tool_call_delta once the slot knows
 *  its call id and name); `response.output_item.done` finalises the slot (a reasoning item finalises to nothing);
 *  `response.completed` → tool_use when a tool_call part exists, else end_turn; `response.incomplete` → length for
 *  max_output_tokens, else error naming the reason; `response.failed` / `error` → error "<code>: <message>"; no
 *  terminal event → error. Usage: `response.usage` through core/usage.ts normalizeUsage (input_tokens −
 *  input_tokens_details.cached_tokens, cacheRead; reasoning_tokens are not carried — TokenUsage has no field for
 *  them and normalizeUsage does not expose them). Non-2xx → httpErrorTurn (status + Retry-After for withRetry / the
 *  router); a thrown fetch or abort → failedTurn (an aborted turn keeps the streamed text, never a tool_call
 *  fragment). No header, token or account id ever reaches an error text or an event (oauth/common.ts hygiene rule). */

import type { AssistantTurn, Message, MessagePart, ModelRef, StopReason, StreamEvent, StreamFn, StreamOptions, TokenUsage } from "../core/types.ts";
import { normalizeUsage } from "../core/usage.ts";
import { supportsImages } from "./catalog.ts";
import { sseLines } from "./sse.ts";
import { failedTurn, fetchFirstByte, httpErrorTurn } from "./stream-errors.ts";
import { thinkingPlan } from "./thinking.ts";
import { toResponsesInput, toResponsesTools } from "./wire-responses.ts";

/** the same opts as openaiCompatStreaming — oauth/seam.ts MakeStream is unchanged */
export interface ResponsesAdapterOptions { baseUrl: string; apiKey: string; headers?: Record<string, string> }

/** the API rejects max_output_tokens below 16 (pi openai-responses.ts:32-33) */
export const RESPONSES_MIN_OUTPUT_TOKENS = 16;
/** the ChatGPT Codex backend: no max_output_tokens, plus the two headers below (pi openai-codex-responses.ts) */
export const CODEX_BACKEND = /chatgpt\.com\/backend-api/;
export const CODEX_HEADERS: Readonly<Record<string, string>> = { "OpenAI-Beta": "responses=experimental", originator: "rovecode" };
export const NO_TERMINAL_EVENT = "OpenAI Responses stream ended before a terminal response event";

export interface ResponsesRequest { url: string; headers: Record<string, string>; body: Record<string, unknown> }

/** the Responses spelling of the thinking dial: the word the OpenAI-compatible dialect would put in `reasoning_effort`
 *  (or OpenRouter's `reasoning.effort`) becomes `reasoning: { effort, summary: "auto" }`; nothing when the dial sends
 *  nothing (auto, a model without a reasoning mode, the catalog's `reasoning: false` stamp) */
export function responsesReasoning(model: ModelRef): { reasoning?: { effort: string; summary: "auto" } } {
  const fields = thinkingPlan(model, "openai").fields;
  const nested = fields.reasoning as { effort?: unknown } | undefined;
  const word = typeof fields.reasoning_effort === "string" ? fields.reasoning_effort : typeof nested?.effort === "string" ? nested.effort : undefined;
  return word === undefined ? {} : { reasoning: { effort: word, summary: "auto" } };
}

/** URL, headers and body for one call (header rules); exported so the request shape is testable without fetch */
export function responsesRequest(opts: ResponsesAdapterOptions, model: ModelRef, messages: Message[], options?: StreamOptions): ResponsesRequest {
  const url = opts.baseUrl.replace(/\/$/, "") + "/responses";
  const codex = CODEX_BACKEND.test(url);
  const { instructions, input } = toResponsesInput(messages, { vision: supportsImages(model) !== false, model }); // port #34 vision gate (stream.ts wireOptions rule)
  const cap = model.maxTokens;
  const body: Record<string, unknown> = {
    model: model.model,
    ...(instructions !== undefined ? { instructions } : {}),
    input,
    ...(options?.tools?.length ? { tools: toResponsesTools(options.tools) } : {}),
    stream: true,
    store: false,
    ...(cap && !codex ? { max_output_tokens: Math.max(cap, RESPONSES_MIN_OUTPUT_TOKENS) } : {}),
    ...responsesReasoning(model),
  };
  const headers: Record<string, string> = { "content-type": "application/json", accept: "text/event-stream", ...(codex ? CODEX_HEADERS : {}), ...opts.headers, authorization: `Bearer ${opts.apiKey}` };
  return { url, headers, body };
}

// ---------- SSE state ----------

type Slot = { kind: "message"; text: string } | { kind: "function_call"; callId: string; name: string; args: string } | { kind: "reasoning" };
interface Item { type?: string; id?: string; call_id?: string; name?: string; arguments?: string; content?: { type?: string; text?: string; refusal?: string }[]; summary?: { text?: string }[] }
interface Event {
  type?: string; output_index?: number; delta?: string; arguments?: string; item?: Item; code?: string; message?: string;
  response?: { usage?: unknown; incomplete_details?: { reason?: string } | null; error?: { code?: string; message?: string } | null };
}

function newSlot(item: Item | undefined): Slot | undefined {
  if (item?.type === "message") return { kind: "message", text: "" };
  if (item?.type === "function_call") return { kind: "function_call", callId: item.call_id ?? "", name: item.name ?? "", args: item.arguments ?? "" };
  if (item?.type === "reasoning") return { kind: "reasoning" };
  return undefined;
}

/** the part an `output_item.done` item finalises to (pi shared.ts:680-739); undefined for an empty message and for a
 *  reasoning item (no reasoning MessagePart here — header) */
function finishedPart(item: Item, slot: Slot | undefined, index: number): MessagePart | undefined {
  if (item.type === "message") {
    const text = item.content ? item.content.map((c) => (c.type === "refusal" ? c.refusal ?? "" : c.text ?? "")).join("") : slot?.kind === "message" ? slot.text : "";
    return text ? { kind: "text", text } : undefined;
  }
  if (item.type === "function_call") {
    const fc = slot?.kind === "function_call" ? slot : undefined;
    const raw = item.arguments ?? fc?.args ?? "";
    let args: unknown = {};
    try { args = JSON.parse(raw || "{}"); } catch { args = { _raw: raw }; }
    return { kind: "tool_call", id: item.call_id || fc?.callId || item.id || `fc${index}`, tool: item.name || fc?.name || "unknown", args };
  }
  return undefined;
}

/** the same normalization the stream.ts adapters apply (cached share subtracted, zero fields dropped) */
function turnUsage(raw: unknown): TokenUsage {
  const u = normalizeUsage(raw);
  return { input: u.input, output: u.output, cacheRead: u.cacheRead || undefined, cacheWrite: u.cacheWrite || undefined };
}

// ---------- the adapter ----------

export function openaiResponsesStream(opts: ResponsesAdapterOptions): StreamFn {
  return async function* (model: ModelRef, messages: Message[], options?: StreamOptions): AsyncGenerator<StreamEvent> {
    let turn: AssistantTurn;
    let buffer = ""; // text deltas only — the abort salvage (failedTurn); reasoning deltas never land here
    try {
      const req = responsesRequest(opts, model, messages, options);
      const res = await fetchFirstByte(req.url, { method: "POST", headers: req.headers, body: JSON.stringify(req.body), signal: options?.signal });
      if (!res.ok || !res.body) {
        yield { type: "turn", turn: await httpErrorTurn(res) }; // status + Retry-After recorded for withRetry (stream-errors.ts)
        return;
      }
      const slots = new Map<number, Slot>();
      const parts = new Map<number, MessagePart>();
      let usage: TokenUsage = { input: 0, output: 0 };
      let terminal: { stop: StopReason; error?: string } | undefined;
      for await (const line of sseLines(res.body)) {
        const ev = JSON.parse(line) as Event;
        const idx = ev.output_index ?? 0;
        switch (ev.type) {
          case "response.output_item.added": { const s = newSlot(ev.item); if (s) slots.set(idx, s); break; }
          case "response.output_text.delta":
          case "response.refusal.delta": {
            if (!ev.delta) break;
            const s: Slot = slots.get(idx) ?? { kind: "message", text: "" };
            if (s.kind === "message") { s.text += ev.delta; slots.set(idx, s); }
            buffer += ev.delta;
            yield { type: "text_delta", text: ev.delta };
            break;
          }
          case "response.reasoning_summary_text.delta":
          case "response.reasoning_text.delta": if (ev.delta) yield { type: "reasoning_delta", text: ev.delta }; break;
          case "response.reasoning_summary_part.done": yield { type: "reasoning_delta", text: "\n\n" }; break;
          case "response.function_call_arguments.delta": {
            if (!ev.delta) break;
            const s: Slot = slots.get(idx) ?? { kind: "function_call", callId: "", name: "", args: "" };
            if (s.kind !== "function_call") break;
            s.args += ev.delta;
            slots.set(idx, s);
            if (s.callId && s.name) yield { type: "tool_call_delta", id: s.callId, tool: s.name, argsDelta: ev.delta };
            break;
          }
          case "response.function_call_arguments.done": { const s = slots.get(idx); if (s?.kind === "function_call" && typeof ev.arguments === "string") s.args = ev.arguments; break; }
          case "response.output_item.done": {
            if (ev.item) { const p = finishedPart(ev.item, slots.get(idx), idx); if (p) parts.set(idx, p); }
            slots.delete(idx);
            break;
          }
          case "response.completed":
          case "response.incomplete": {
            if (ev.response?.usage) usage = turnUsage(ev.response.usage);
            const reason = ev.response?.incomplete_details?.reason;
            terminal = ev.type === "response.completed" ? { stop: "end_turn" } : reason === "max_output_tokens" ? { stop: "length" } : { stop: "error", error: `Response incomplete: ${reason ?? "no reason given"}` };
            break;
          }
          case "response.failed": { const e = ev.response?.error; terminal = { stop: "error", error: `${e?.code || "unknown"}: ${e?.message || "no message"}` }; break; }
          case "error": terminal = { stop: "error", error: `${ev.code || "unknown"}: ${ev.message || "no message"}` }; break;
          default: break; // response.created / in_progress / content_part.* / *_part.added / *.done text echoes: nothing to do
        }
      }
      if (!terminal) terminal = { stop: "error", error: NO_TERMINAL_EVENT }; // pi shared.ts:757-759 — never end_turn
      const ordered = [...parts].sort((a, b) => a[0] - b[0]).map(([, p]) => p);
      turn = terminal.stop === "error"
        ? { parts: [], stopReason: "error", usage, error: terminal.error }
        : { parts: ordered, stopReason: terminal.stop === "end_turn" && ordered.some((p) => p.kind === "tool_call") ? "tool_use" : terminal.stop, usage };
    } catch (e) {
      turn = failedTurn(e, options?.signal, buffer); // mid-stream abort: the text already streamed survives, tool fragments do not
    }
    yield { type: "turn", turn };
  };
}
