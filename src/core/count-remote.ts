/** Ask the provider to count the prompt, instead of estimating it.
 *
 *  Our meter is o200k: exact for OpenAI models, an approximation everywhere else, and materially low on
 *  Anthropic's newer tokenizer. Anthropic publishes the arithmetic itself — `POST /v1/messages/count_tokens`
 *  takes the same body a request would (model, system, messages, tools) and returns `input_tokens`, the
 *  number the window and the bill are computed from. When it can be asked, asking beats guessing.
 *
 *  Deliberately narrow:
 *  - **Anthropic protocol only.** OpenAI publishes no counting endpoint, and inventing one per gateway
 *    would produce a number whose provenance nobody could explain. An unsupported provider returns a
 *    reason, not a fallback that looks like an answer.
 *  - **Opt-in.** It is a network call with the user's key; nothing in this file runs unless a caller asks.
 *  - **Never throws.** A refusal, a timeout, a gateway that does not implement the route — all become a
 *    stated reason, because a token count is not worth failing a command over.
 *  The body is built by the same wire functions a real request uses, so the count describes the prompt
 *  that would actually be sent rather than a reconstruction of it. */

import type { Message } from "./types.ts";
import { toAnthropicMessages, toOpenAiToolSchemas } from "../providers/wire-messages.ts";

export interface RemoteCountRequest {
  provider: { baseUrl: string; apiKey?: string; protocol: string; headers?: Record<string, string> };
  model: string;
  messages: readonly Message[];
  system?: string;
  /** tool schemas as the registry holds them; converted to the wire shape here */
  tools?: readonly unknown[];
  /** injected in tests */
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

export type RemoteCount =
  | { ok: true; inputTokens: number; endpoint: string; placeholder?: true }
  | { ok: false; reason: string };

/** The API rejects an empty `messages` list, so a session with no turns yet — exactly the case where
 *  the fixed cost of the system prompt and the tool schemas is the most interesting number — could not
 *  be counted at all. One minimal user turn stands in for the transcript; the result says so, because
 *  a couple of tokens of scaffolding in a number presented as exact has to be disclosed, not absorbed. */
const PLACEHOLDER_TURN = { role: "user", content: "." };

const DEFAULT_TIMEOUT_MS = 15_000;

/** `{"input_tokens": 1234}` and nothing else is trusted from the response. */
function readCount(raw: unknown): number | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const v = (raw as Record<string, unknown>)["input_tokens"];
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined;
}

export async function countPromptRemotely(req: RemoteCountRequest): Promise<RemoteCount> {
  if (req.provider.protocol !== "anthropic") {
    return { ok: false, reason: `${req.provider.protocol} publishes no token-counting endpoint — only the Anthropic protocol does` };
  }
  if (!req.provider.apiKey) return { ok: false, reason: "no API key for this provider — the count needs one" };

  const base = req.provider.baseUrl.replace(/\/+$/, "");
  const endpoint = `${base}/messages/count_tokens`;
  const wire = toAnthropicMessages([...req.messages]);
  const placeholder = wire.length === 0;
  const body: Record<string, unknown> = {
    model: req.model,
    messages: placeholder ? [PLACEHOLDER_TURN] : wire,
    ...(req.system ? { system: req.system } : {}),
  };
  // the same schemas the run would send, in Anthropic's shape: {name, description, input_schema}
  if (req.tools && req.tools.length > 0) {
    body["tools"] = toOpenAiToolSchemas([...req.tools]).map((t) => {
      const fn = (t as { function?: Record<string, unknown> }).function ?? t;
      const params = fn["parameters"];
      // an argument-less tool converts to `{}`, and Anthropic rejects a schema without a `type` —
      // one such tool in the registry would turn the whole count into a 400
      const usable = typeof params === "object" && params !== null && "type" in params;
      return { name: fn["name"], description: fn["description"], input_schema: usable ? params : { type: "object", properties: {} } };
    });
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), req.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await (req.fetchFn ?? fetch)(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": req.provider.apiKey,
        "anthropic-version": "2023-06-01",
        ...(req.provider.headers ?? {}),
      },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    if (!res.ok) {
      const text = (await res.text().catch(() => "")).slice(0, 200);
      return { ok: false, reason: `the endpoint answered ${res.status}${text ? ` — ${text}` : ""}` };
    }
    const count = readCount(await res.json().catch(() => null));
    return count === undefined
      ? { ok: false, reason: "the endpoint answered without an input_tokens number" }
      : { ok: true, inputTokens: count, endpoint, ...(placeholder ? { placeholder: true as const } : {}) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: ac.signal.aborted ? `no answer within ${(req.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000}s` : msg };
  } finally {
    clearTimeout(timer);
  }
}
