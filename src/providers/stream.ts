/** Providers: StreamFn adapters (ADR-003 seam). Errors cross as stopReason "error", never throws.
 *
 *  Wire protocols supported:
 *  - OpenAI-compatible /chat/completions (JSON + SSE streaming), with tools
 *  - Anthropic /messages (x-api-key), with tools
 *  - Any custom base URL + key (ROVECODE_BASE_URL/ROVECODE_API_KEY or explicit config)
 *  Model catalogs are FETCHED from the endpoint (/v1/models) — never hard-coded (pi pattern).
 *  Error-turn shaping (abort vs error; HTTP status + Retry-After side-channel, port #23) lives in stream-errors.ts.
 *  Message lowering (harness parts → wire content, incl. port #34 image blocks) lives in wire-messages.ts. */

import type { StreamFn, Message, AssistantTurn, StreamEvent, ModelRef, StopReason, StreamOptions } from "../core/types.ts";
import { partsText } from "../core/loop.ts";
import { applyAnthropicCacheBoundaries } from "./cache.ts";
import { normalizeUsage } from "../core/usage.ts";
import { BUILTIN_PROVIDERS, buildSnapshot, pickDefault } from "./provider-config.ts";
import { failedTurn, fetchFirstByte, httpErrorTurn } from "./stream-errors.ts";
import { supportsImages } from "./catalog.ts";
import { profileWire } from "./profiles.ts";
import { anthropicThinking, thinkingBudget, thinkingPlan, type AnthropicThinkingShape } from "./thinking.ts";
import { toOpenAiMessages, toAnthropicMessages, toOpenAiToolSchemas, asToolSchema, type WireOptions } from "./wire-messages.ts";
import { sseData } from "./sse.ts";
import { rejectProviderError, openAiStop, anthropicStop, parseToolArgs, validateToolCalls } from "./response-validation.ts";
import { oauthStream, resolveOAuthProviderConfig, type OAuthSeamDeps } from "./oauth/seam.ts";
import { openaiResponsesStream } from "./responses.ts"; // the /responses wire (aion port #75)
import { openAiWire } from "./wire-select.ts"; // chat vs responses, per call

export { toOpenAiMessages, toAnthropicMessages, toOpenAiToolSchemas } from "./wire-messages.ts";

/** port #34: image parts go on the wire as image blocks unless the models.dev catalog says the
 *  model has no image input (then wire-messages.ts substitutes a text placeholder); an unknown
 *  model is given the image (catalog.ts supportsImages). */
const wireOptions = (model: ModelRef): WireOptions => ({ vision: supportsImages(model) !== false });

export interface ProviderConfig {
  id: string;             // provider id, e.g. "kaesra"
  baseUrl: string;        // e.g. https://api.example.invalid/v1
  apiKey: string;
  protocol: "openai" | "anthropic";
  defaultModel?: string;
  /** extra request headers (proxies, org ids) — providers.json `headers`; the protocol's own auth headers win.
   *  Also the OAuth providers' own headers (GitHub Copilot's editor headers, OpenAI's account id) */
  headers?: Record<string, string>;
  /** apiKey is a stored OAuth access token — providerStream/providerStreaming refresh it per request (oauth/seam.ts) */
  oauth?: true;
  /** pin the OpenAI wire for every request (the OpenAI OAuth token sets "responses" — a ChatGPT token is accepted by
   *  the Codex Responses backend only); unset = ROVECODE_OPENAI_WIRE, else the catalog rule (wire-select.ts) */
  wire?: "responses" | "chat";
}

/** What a wire adapter needs: endpoint root, key, optional extra headers (ProviderConfig.headers). */
export interface AdapterOptions {
  baseUrl: string;
  apiKey: string;
  headers?: Record<string, string>;
}

export interface ModelCatalogEntry {
  id: string;
  ownedBy?: string;
  type?: string;
}

// ---------- catalog (fetched, cached) ----------

const catalogCache = new Map<string, { models: ModelCatalogEntry[]; fetchedAt: number }>();
const CATALOG_TTL_MS = 5 * 60_000;

export async function fetchModels(cfg: ProviderConfig, force = false): Promise<ModelCatalogEntry[]> {
  const hit = catalogCache.get(cfg.id);
  if (!force && hit && Date.now() - hit.fetchedAt < CATALOG_TTL_MS) return hit.models;
  const url = cfg.baseUrl.replace(/\/$/, "") + "/models";
  let models: ModelCatalogEntry[] = [];
  try {
    const res = await fetch(url, { headers: authHeaders(cfg) });
    if (res.ok) {
      const json = (await res.json()) as { data?: { id: string; owned_by?: string; type?: string }[] };
      models = (json.data ?? []).map((m) => ({ id: m.id, ownedBy: m.owned_by, type: m.type }));
    }
  } catch { /* errors are empty catalog — provider seam never throws */ }
  catalogCache.set(cfg.id, { models, fetchedAt: Date.now() });
  return models;
}

function authHeaders(cfg: ProviderConfig): Record<string, string> {
  return {
    ...(cfg.headers ?? {}),
    ...(cfg.protocol === "anthropic"
      ? { "x-api-key": cfg.apiKey, "anthropic-version": "2023-06-01" }
      : { authorization: `Bearer ${cfg.apiKey}` }),
  };
}

// ---------- factories ----------

const optsOf = (cfg: ProviderConfig): AdapterOptions => ({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, ...(cfg.headers !== undefined ? { headers: cfg.headers } : {}) });

/** `oauth`: the seam's injectable clock/fetch/store/provider list (tests drive a fake endpoint); production passes nothing */
export function providerStream(cfg: ProviderConfig, oauth: OAuthSeamDeps = {}): StreamFn {
  if (cfg.oauth) return oauthStream(cfg, openAiWire(cfg, openaiCompatStream, openaiResponsesStream), oauth); // a stored OAuth token: refresh-once-if-expired, then the wire picked per call
  return cfg.protocol === "anthropic" ? anthropicStream(optsOf(cfg)) : openAiWire(cfg, openaiCompatStream, openaiResponsesStream)(optsOf(cfg));
}

/** The streaming twin of providerStream: text_delta as the model writes, the same final turn.
 *  This is what every surface gets by default — the one-shot JSON adapters above are the fallback.
 *  The ONE builder the CLI's SSE sites use, so an OAuth config's headers (GitHub Copilot's editor
 *  headers) reach the streaming request too; a headerless `openaiCompatStreaming({ baseUrl, apiKey })`
 *  at a call site is the bug test/unit/auth-login-sse.test.ts pins against. */
export function providerStreaming(cfg: ProviderConfig, oauth: OAuthSeamDeps = {}): StreamFn {
  if (cfg.oauth) return oauthStream(cfg, openAiWire(cfg, openaiCompatStreaming, openaiResponsesStream), oauth); // the TUI's default path: a long session outlives a 30-minute Copilot token, so it refreshes here too
  return cfg.protocol === "anthropic" ? anthropicStreaming(optsOf(cfg)) : openAiWire(cfg, openaiCompatStreaming, openaiResponsesStream)(optsOf(cfg)); // the Responses wire is SSE-only, so it is the same adapter on both factories
}

/** Streaming is ON unless ROVECODE_STREAM says otherwise: `off`/`json`/`0`/`false`/`none` fall back to
 *  the one-shot JSON adapters (a proxy with no SSE route, a recording harness that wants one body).
 *  `sse` is still accepted — it used to be the opt-IN spelling and some scripts still set it. */
export function wantsStreaming(env: { ROVECODE_STREAM?: string | undefined }): boolean {
  const v = (env.ROVECODE_STREAM ?? "").trim().toLowerCase();
  return !(v === "off" || v === "json" || v === "0" || v === "false" || v === "none");
}

/** Streaming requests ask for an UNCOMPRESSED body. Measured against the Anthropic endpoint: with the
 *  default `accept-encoding: gzip, deflate, br`, the decompressor holds the whole SSE stream and every
 *  event lands in one burst at the end (first text delta at 11.1 s of an 11.1 s response); with
 *  `identity` the same prompt starts writing at 1.4 s. Streaming is the point of these two adapters, so
 *  the extra bytes are the right trade — the JSON adapters below keep compression. */
const SSE_HEADERS = { "accept-encoding": "identity" } as const;

/** A proxy that ignores `stream: true` and answers with one JSON body would otherwise leave the SSE
 *  reader with nothing to parse and the turn empty. Content-type decides: an explicit application/json
 *  is read whole through the same parser the one-shot adapters use (no deltas — there is nothing to
 *  stream), anything else is treated as an event stream. */
const isJsonBody = (res: Response): boolean => (res.headers.get("content-type") ?? "").includes("application/json");

/** Thinking, per protocol.
 *
 *  Anthropic has TWO request shapes and no model exposes both reliably — measured against the live
 *  API on 2026-09-03:
 *
 *      model                     output_config.effort      thinking.type=enabled
 *      claude-opus-5             200                       400 "not supported for this model"
 *      claude-sonnet-5           200                       400
 *      claude-opus-4-5           200                       200
 *      claude-sonnet-4-5         400 "does not support…"   200  → [thinking, text]
 *      claude-haiku-4-5          400                       200
 *
 *  So the shape is a property of the model, and guessing wrong is a hard 400, not a downgrade. There
 *  is no capability field to read (the /models list carries ids only), and a hard-coded table would
 *  rot with the next release — this file's rule is that catalogs are fetched, never hard-coded. So:
 *  try the newer shape, and when the endpoint says that shape is unsupported, flip and retry ONCE,
 *  remembering the answer per model id for the rest of the process. One wasted round trip the first
 *  time a model is used, never again.
 *
 *  `off` is not "send nothing": opus-5 thinks by DEFAULT (measured — a bare request streams
 *  thinking_delta), so off has to say so with thinking.type=disabled.
 *
 *  Extended thinking and tool use: the thinking blocks are NOT echoed back on the next turn, and
 *  measurement says they need not be — a tool_result turn that omits them answers 200 on both shapes
 *  and both model generations. */
// the dial itself (budgets, both Anthropic shapes, every OpenAI-compatible dialect) lives in thinking.ts;
// re-exported so the adapters' callers and tests keep one import
export { anthropicThinking, thinkingBudget, type AnthropicThinkingShape };

/** what the endpoint said when the shape was wrong — both spellings it uses. The message must ALSO name
 *  the dial (thinking/effort/budget): "not supported for this model" alone is how the API refuses other
 *  things too (a tool feature, an image), and flipping the shape on those would cost every later request
 *  a wasted round trip. */
const WRONG_SHAPE = /not supported for this model|does not support the effort parameter/i;
const ABOUT_THINKING = /thinking|effort|budget_tokens|output_config/i;
const wrongShape = (text: string): boolean => WRONG_SHAPE.test(text) && ABOUT_THINKING.test(text);

/** per provider+model, learned from a 400. Process-lifetime: a model's shape does not change under us.
 *  Keyed with the provider so a gateway that fronts the same model id differently cannot poison the
 *  direct endpoint's memory (or the other way round). Exported for tests only. */
export const shapeByModel = new Map<string, AnthropicThinkingShape>();
export const shapeKey = (model: ModelRef): string => `${model.provider}/${model.model}`;

/** the answer needs room BESIDE the thinking budget — never less than the caller asked for */
export function anthropicMaxTokens(model: ModelRef): number {
  const base = model.maxTokens ?? 8192; // buildDef normally sets maxTokens from the catalog; 8192 is the floor every current Claude accepts
  const budget = thinkingBudget(model.effort);
  return budget === null ? base : Math.max(base, budget + 4096);
}

/** the shape the next request for this model will use (for /effort and `model show` to say the truth) */
export function anthropicShapeFor(model: ModelRef): AnthropicThinkingShape { return shapeByModel.get(shapeKey(model)) ?? "effort"; }

/** POST to Anthropic, learning the model's thinking shape from a wrong-shape 400 and retrying ONCE.
 *  `build` is called per attempt because the shape changes the body. A failure that is NOT about the
 *  shape is returned as-is — the adapters turn it into an error turn (httpErrorTurn). Bounded: at most
 *  two sends per request, and the flipped shape is remembered only when the retry was not the same
 *  refusal — two wrong-shape 400s in a row (a model that takes neither) leave no memory, so the next
 *  request does not oscillate between two guaranteed failures. */
async function anthropicPost(url: string, headers: Record<string, string>, model: ModelRef, build: (extra: Record<string, unknown>) => unknown, signal: AbortSignal | undefined): Promise<Response> {
  const wanted = model.effort;
  const key = shapeKey(model);
  let shape: AnthropicThinkingShape = shapeByModel.get(key) ?? "effort";
  const send = (): Promise<Response> => fetchFirstByte(url, { method: "POST", headers, body: JSON.stringify(build(anthropicThinking(wanted, shape))), ...(signal ? { signal } : {}) });
  const res = await send();
  // nothing to learn when the request carried no level (auto/off/unset use one shape-free field), or when it worked
  if (res.ok || wanted === undefined || wanted === "auto" || wanted === "off" || res.status !== 400) return res;
  const text = await res.clone().text().catch(() => "");
  if (!wrongShape(text)) return res;
  shape = shape === "effort" ? "budget" : "effort";
  const retry = await send();
  if (retry.status === 400 && wrongShape(await retry.clone().text().catch(() => ""))) shapeByModel.delete(key);
  else shapeByModel.set(key, shape);
  return retry;
}

/** OpenAI-compatible endpoints name the dial in a dozen vocabularies (thinking.ts): the plan's fields are
 *  spread into the body after the profile's own wire fields (profiles.ts), so the dial wins a clash. */
function reasoningEffort(model: ModelRef): Record<string, unknown> {
  return thinkingPlan(model, "openai").fields;
}

export function openaiCompatStream(opts: AdapterOptions): StreamFn {
  return async function* (model: ModelRef, messages: Message[], options?: { signal?: AbortSignal; tools?: unknown[] }): AsyncGenerator<StreamEvent> {
    let turn: AssistantTurn;
    try {
      const res = await fetchFirstByte(opts.baseUrl.replace(/\/$/, "") + "/chat/completions", {
        method: "POST",
        headers: { ...(opts.headers ?? {}), "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` },
        body: JSON.stringify({
          model: model.model,
          messages: toOpenAiMessages(messages, wireOptions(model)),
          ...(options?.tools?.length ? { tools: toOpenAiToolSchemas(options.tools) } : {}),
          stream: false,
          ...profileWire(model, false), // per-family endpoint fields (providers/profiles.ts); the effort word below wins a clash
          ...reasoningEffort(model),
          ...(model.maxTokens ? { max_tokens: model.maxTokens } : {}),
        }),
        signal: options?.signal,
      });
      if (!res.ok) {
        turn = await httpErrorTurn(res); // status + Retry-After recorded for withRetry (stream-errors.ts)
      } else {
        turn = parseOpenAiResponse(await res.json());
      }
    } catch (e) {
      turn = failedTurn(e, options?.signal);
    }
    yield { type: "turn", turn };
  };
}

/** Streaming variant: emits text_delta events as they arrive, then the final turn. */
export function openaiCompatStreaming(opts: AdapterOptions): StreamFn {
  return async function* (model: ModelRef, messages: Message[], options?: StreamOptions): AsyncGenerator<StreamEvent> {
    let turn: AssistantTurn;
    let buffer = "";
    const toolArgs = new Map<number, { id: string; name: string; args: string }>();
    try {
      const res = await fetchFirstByte(opts.baseUrl.replace(/\/$/, "") + "/chat/completions", {
        method: "POST",
        headers: { ...(opts.headers ?? {}), ...SSE_HEADERS, "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` },
        body: JSON.stringify({
          model: model.model,
          messages: toOpenAiMessages(messages, wireOptions(model)),
          ...(options?.tools?.length ? { tools: toOpenAiToolSchemas(options.tools) } : {}),
          stream: true,
          // ask for the final usage chunk — without it most OpenAI-compat SSE streams omit usage
          stream_options: { include_usage: true },
          ...profileWire(model, true), // per-family endpoint fields, streaming variant (tool_stream for GLM)
          ...reasoningEffort(model),
          ...(model.maxTokens ? { max_tokens: model.maxTokens } : {}),
        }),
        signal: options?.signal,
      });
      if (!res.ok || !res.body) {
        turn = await httpErrorTurn(res); // status + Retry-After recorded for withRetry (stream-errors.ts)
        yield { type: "turn", turn };
        return;
      }
      if (isJsonBody(res)) { yield { type: "turn", turn: parseOpenAiResponse(await res.json()) }; return; }
      let finish: StopReason | undefined;
      let usage: AssistantTurn["usage"] = { input: 0, output: 0 };
      for await (const line of sseData(res.body, options)) {
        const ev = JSON.parse(line) as {
          error?: unknown;
          choices?: { delta?: { content?: string | null; reasoning_content?: string | null; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string | null }[];
          usage?: unknown;
        };
        rejectProviderError(ev);
        const c = ev.choices?.[0];
        if (c?.delta?.content) { buffer += c.delta.content; yield { type: "text_delta", text: c.delta.content }; }
        // reasoning slices (GLM / DeepSeek-style `reasoning_content`): surfaced exactly like Anthropic's
        // thinking_delta — the live status line counts them, the turn's parts never carry them
        if (c?.delta?.reasoning_content) yield { type: "reasoning_delta", text: c.delta.reasoning_content };
        for (const tc of c?.delta?.tool_calls ?? []) {
          const idx = tc.index ?? 0;
          // Start empty: the first name fragment is appended below, just like later fragments.
          const cur = toolArgs.get(idx) ?? { id: tc.id ?? "", name: "", args: "" };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name += tc.function.name;
          if (tc.function?.arguments) cur.args += tc.function.arguments;
          toolArgs.set(idx, cur);
        }
        if (c?.finish_reason) finish = openAiStop(c.finish_reason);
        if (ev.usage) {
          // same normalization as the JSON adapters (parseOpenAiResponse/parseAnthropicResponse):
          // cached_tokens subtracted from the inclusive prompt count, cacheRead/Write carried
          const u = normalizeUsage(ev.usage);
          usage = { input: u.input, output: u.output, cacheRead: u.cacheRead || undefined, cacheWrite: u.cacheWrite || undefined };
        }
      }
      if (finish === undefined) throw new Error("OpenAI stream ended without a finish reason");
      const parts: AssistantTurn["parts"] = [];
      if (buffer) parts.push({ kind: "text", text: buffer });
      for (const [, tc] of [...toolArgs].sort((a, b) => a[0] - b[0])) {
        parts.push({ kind: "tool_call", id: tc.id, tool: tc.name, args: parseToolArgs(tc.args, finish === "length") });
      }
      validateToolCalls(parts, finish);
      turn = { parts, stopReason: finish, usage };
    } catch (e) {
      turn = failedTurn(e, options?.signal, buffer); // mid-stream abort: the deltas already streamed survive as the turn's text
    }
    yield { type: "turn", turn };
  };
}

/** Streaming variant of the Anthropic adapter: emits text_delta as the model writes, then the final
 *  turn. The Messages SSE stream is a sequence of numbered content blocks — `content_block_start`
 *  opens one (text or tool_use), `content_block_delta` carries `text_delta` for prose and
 *  `input_json_delta` for a tool call's arguments (streamed as JSON text, one fragment at a time),
 *  `content_block_stop` closes it. Usage arrives in two halves: the input side on `message_start`,
 *  the output count on the final `message_delta` — they are merged so /cost sees the same shape the
 *  JSON adapter produces. Block ORDER is preserved: parts are emitted by block index, so a text
 *  block before a tool_use stays before it. */
export function anthropicStreaming(opts: AdapterOptions): StreamFn {
  return async function* (model: ModelRef, messages: Message[], options?: StreamOptions): AsyncGenerator<StreamEvent> {
    let turn: AssistantTurn;
    let buffer = "";
    /** open + finished blocks by wire index; `json` accumulates an input_json_delta */
    const blocks = new Map<number, { kind: "text"; text: string } | { kind: "tool"; id: string; name: string; json: string; input: unknown } | { kind: "thinking" }>();
    try {
      const system = messages.filter((m) => m.role === "system").map((m) => partsText(m.parts)).join("\n");
      const rest: Record<string, unknown> = {};
      if (options?.tools?.length) rest.tools = options.tools.map((t) => { const sc = asToolSchema(t); return { name: sc.name, description: sc.description, input_schema: sc.args }; });
      if (system) rest.system = system;
      const body = (extra: Record<string, unknown>): Record<string, unknown> => ({
        model: model.model,
        max_tokens: anthropicMaxTokens(model),
        messages: toAnthropicMessages(messages, wireOptions(model)),
        stream: true,
        ...rest,
        ...extra,
      });
      const res = await anthropicPost(
        opts.baseUrl.replace(/\/$/, "") + "/messages",
        { ...(opts.headers ?? {}), ...SSE_HEADERS, "content-type": "application/json", "x-api-key": opts.apiKey, "anthropic-version": "2023-06-01" },
        model,
        (extra) => applyAnthropicCacheBoundaries(body(extra)),
        options?.signal,
      );
      if (!res.ok || !res.body) {
        turn = await httpErrorTurn(res); // status + Retry-After recorded for withRetry (stream-errors.ts)
        yield { type: "turn", turn };
        return;
      }
      if (isJsonBody(res)) { yield { type: "turn", turn: parseAnthropicResponse(await res.json()) }; return; }
      let stop: StopReason | undefined;
      let usage: AssistantTurn["usage"] = { input: 0, output: 0 };
      events: for await (const line of sseData(res.body, options)) {
        const ev = JSON.parse(line) as {
          type?: string;
          index?: number;
          message?: { usage?: unknown };
          content_block?: { type?: string; id?: string; name?: string; text?: string; input?: unknown };
          delta?: { type?: string; text?: string; partial_json?: string; thinking?: string; stop_reason?: string | null };
          usage?: unknown;
          error?: { type?: string; message?: string };
        };
        switch (ev.type) {
          case "message_start": {
            const u = normalizeUsage(ev.message?.usage);
            usage = { input: u.input, output: u.output, cacheRead: u.cacheRead || undefined, cacheWrite: u.cacheWrite || undefined };
            break;
          }
          case "content_block_start": {
            const i = ev.index ?? 0;
            if (ev.content_block?.type === "tool_use") blocks.set(i, { kind: "tool", id: ev.content_block.id ?? "", name: ev.content_block.name ?? "", json: "", input: ev.content_block.input === undefined ? {} : ev.content_block.input });
            else if (ev.content_block?.type === "thinking" || ev.content_block?.type === "redacted_thinking") blocks.set(i, { kind: "thinking" });
            else {
              const text = ev.content_block?.text ?? "";
              blocks.set(i, { kind: "text", text });
              if (text) { buffer += text; yield { type: "text_delta", text }; }
            }
            break;
          }
          case "content_block_delta": {
            const i = ev.index ?? 0;
            const b = blocks.get(i);
            if (ev.delta?.type === "text_delta" && ev.delta.text !== undefined) {
              buffer += ev.delta.text;
              if (b?.kind === "text") b.text += ev.delta.text;
              else blocks.set(i, { kind: "text", text: ev.delta.text }); // a delta without its start
              yield { type: "text_delta", text: ev.delta.text };
            } else if (ev.delta?.type === "input_json_delta" && ev.delta.partial_json !== undefined && b?.kind === "tool") {
              b.json += ev.delta.partial_json;
            } else if (ev.delta?.type === "thinking_delta" && ev.delta.thinking !== undefined) {
              // the model is reasoning: surface the slice so the TUI can prove work is happening, keep
              // nothing — thinking is not the answer (signature_delta carries no tokens and is skipped)
              yield { type: "reasoning_delta", text: ev.delta.thinking };
            }
            break;
          }
          case "message_delta": {
            if (ev.delta?.stop_reason) stop = anthropicStop(ev.delta.stop_reason);
            // the output count only exists here; the input side stays as message_start reported it
            if (ev.usage !== undefined) {
              const u = normalizeUsage(ev.usage);
              usage = { ...usage, output: u.output || usage.output, cacheRead: usage.cacheRead ?? (u.cacheRead || undefined), cacheWrite: usage.cacheWrite ?? (u.cacheWrite || undefined) };
            }
            break;
          }
          case "message_stop":
            break events;
          // a mid-stream `error` event ends the turn with what was already streamed
          case "error":
            throw new Error(ev.error?.message ?? "anthropic stream error");
          default:
            break;
        }
      }
      if (stop === undefined) throw new Error("Anthropic stream ended without a finish reason");
      const parts: AssistantTurn["parts"] = [];
      for (const [, b] of [...blocks].sort((a, z) => a[0] - z[0])) {
        if (b.kind === "thinking") continue; // reasoning never becomes a part
        if (b.kind === "text") { if (b.text) parts.push({ kind: "text", text: b.text }); continue; }
        const args = b.json ? parseToolArgs(b.json, stop === "length") : b.input;
        parts.push({ kind: "tool_call", id: b.id, tool: b.name, args });
      }
      validateToolCalls(parts, stop);
      turn = { parts, stopReason: stop, usage };
    } catch (e) {
      turn = failedTurn(e, options?.signal, buffer); // mid-stream abort: the deltas already streamed survive as the turn's text
    }
    yield { type: "turn", turn };
  };
}

/** Anthropic Messages protocol adapter. */
export function anthropicStream(opts: AdapterOptions): StreamFn {
  return async function* (model: ModelRef, messages: Message[], options?: { signal?: AbortSignal; tools?: unknown[] }): AsyncGenerator<StreamEvent> {
    let turn: AssistantTurn;
    try {
      const system = messages.filter((m) => m.role === "system").map((m) => partsText(m.parts)).join("\n");
      const rest: Record<string, unknown> = {};
      if (options?.tools?.length) rest.tools = options.tools.map((t) => { const sc = asToolSchema(t); return { name: sc.name, description: sc.description, input_schema: sc.args }; });
      if (system) rest.system = system;
      const body = (extra: Record<string, unknown>): Record<string, unknown> => ({
        model: model.model,
        max_tokens: anthropicMaxTokens(model),
        messages: toAnthropicMessages(messages, wireOptions(model)),
        ...rest,
        ...extra,
      });
      // port #5: place prompt-cache breakpoints on the stable prefix (hermes pattern)
      const res = await anthropicPost(
        opts.baseUrl.replace(/\/$/, "") + "/messages",
        { ...(opts.headers ?? {}), "content-type": "application/json", "x-api-key": opts.apiKey, "anthropic-version": "2023-06-01" },
        model,
        (extra) => applyAnthropicCacheBoundaries(body(extra)),
        options?.signal,
      );
      if (!res.ok) {
        turn = await httpErrorTurn(res); // status + Retry-After recorded for withRetry (stream-errors.ts)
      } else {
        turn = parseAnthropicResponse(await res.json());
      }
    } catch (e) {
      turn = failedTurn(e, options?.signal);
    }
    yield { type: "turn", turn };
  };
}

// ---------- parsing ----------

function parseOpenAiResponse(json: unknown): AssistantTurn {
  rejectProviderError(json);
  const j = json as {
    choices: { message: { content: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] }; finish_reason: string | null }[];
    usage?: { prompt_tokens: number; completion_tokens: number };
  };
  const c = j.choices?.[0];
  if (!c?.message) throw new Error("invalid OpenAI response: missing assistant message");
  const stop = openAiStop(c.finish_reason);
  const parts: AssistantTurn["parts"] = [];
  if (c?.message.content) parts.push({ kind: "text", text: c.message.content });
  for (const tc of c?.message.tool_calls ?? []) {
    const args = parseToolArgs(tc.function.arguments, stop === "length");
    parts.push({ kind: "tool_call", id: tc.id, tool: tc.function.name, args });
  }
  validateToolCalls(parts, stop);
  const u = normalizeUsage(j.usage);
  return { parts, stopReason: stop, usage: { input: u.input, output: u.output, cacheRead: u.cacheRead || undefined, cacheWrite: u.cacheWrite || undefined } };
}

function parseAnthropicResponse(json: unknown): AssistantTurn {
  rejectProviderError(json);
  const j = json as {
    content: { type: string; text?: string; id?: string; name?: string; input?: unknown }[];
    stop_reason: string | null;
    usage: { input_tokens: number; output_tokens: number };
  };
  if (!Array.isArray(j.content)) throw new Error("invalid Anthropic response: missing content array");
  const stop = anthropicStop(j.stop_reason);
  const parts: AssistantTurn["parts"] = [];
  for (const b of j.content) {
    if (b.type === "text" && b.text) parts.push({ kind: "text", text: b.text });
    if (b.type === "tool_use") parts.push({ kind: "tool_call", id: b.id ?? "", tool: b.name ?? "", args: b.input });
  }
  validateToolCalls(parts, stop);
  const u = normalizeUsage(j.usage);
  return { parts, stopReason: stop, usage: { input: u.input, output: u.output, cacheRead: u.cacheRead || undefined, cacheWrite: u.cacheWrite || undefined } };
}

// ---------- SSE: the line reader lives in sse.ts (shared with any future wire that must not import this file) ----------

// ---------- mock (test seam) ----------

export interface MockScript { turns: AssistantTurn[] }

export function mockStream(script: MockScript): StreamFn {
  let i = 0;
  return async function* (_model: ModelRef, _messages: Message[]): AsyncGenerator<StreamEvent> {
    const turn = script.turns[Math.min(i, script.turns.length - 1)]!;
    i++;
    yield { type: "turn", turn };
  };
}

export function textTurn(text: string): AssistantTurn {
  return { parts: [{ kind: "text", text }], stopReason: "end_turn", usage: { input: 0, output: 1 } };
}

export function toolTurn(calls: { id: string; tool: string; args: unknown }[]): AssistantTurn {
  return { parts: calls.map((c) => ({ kind: "tool_call" as const, ...c })), stopReason: "tool_use", usage: { input: 0, output: 1 } };
}

// ---------- registry: named providers from env/config ----------
// The provider table and the providers.json merge live in provider-config.ts (data) and the live
// dispatcher in registry.ts. resolveProvider() is the ONE-SHOT default lookup the CLI uses at boot.

/** Resolve the default provider config: ROVECODE_BASE_URL/ROVECODE_API_KEY override, else the
 *  providers.json `default` selector (when that provider has a key), else stored credential
 *  (`rovecode auth set`, port #37) in provider order, else a named env key, else a stored OAuth
 *  token (`rovecode auth login`, oauth/seam.ts — "a stored token is used when no API key is set"), else null.
 *
 *  Precedence follows opencode provider.ts @ ebece6e: stored api keys are merged AFTER env
 *  (provider.ts:1578-1602, later mergeProvider patch wins) so a stored credential beats a
 *  named env key; the explicit pair keeps its documented "always wins" rank, like opencode's
 *  config source re-applied last (provider.ts:1643-1651). provider-config.ts pickDefault is
 *  the single implementation; the live registry shares it. */
export function resolveProvider(overrides: { baseUrl?: string; apiKey?: string; id?: string; protocol?: "openai" | "anthropic"; defaultModel?: string } = {}): ProviderConfig | null {
  const base = overrides.baseUrl ?? process.env.ROVECODE_BASE_URL;
  const key = overrides.apiKey ?? process.env.ROVECODE_API_KEY ?? process.env.OPENAI_API_KEY;
  if (base && key) {
    const looksAnthropic = overrides.protocol === "anthropic" || base.includes("anthropic.com");
    const defaultModel = overrides.defaultModel ?? process.env.ROVECODE_MODEL;
    return { id: overrides.id ?? "custom", baseUrl: base, apiKey: key, protocol: looksAnthropic ? "anthropic" : "openai", ...(defaultModel !== undefined ? { defaultModel } : {}) };
  }
  const pick = pickDefault(buildSnapshot(process.cwd()));
  if (pick === null) return resolveOAuthProviderConfig(); // a stored OAuth token is used when no API key is set; else null
  const p = pick.provider;
  return {
    id: p.id, baseUrl: p.baseUrl, apiKey: p.apiKey ?? "", protocol: p.protocol,
    ...(pick.model !== undefined ? { defaultModel: pick.model } : {}),
    ...(p.headers !== undefined ? { headers: p.headers } : {}),
  };
}

export function listBuiltinProviders(): { id: string; baseUrl: string; protocol: string; envKey: string; configured: boolean }[] {
  return BUILTIN_PROVIDERS.map((p) => {
    const envKey = p.keyEnv ?? `${p.id.toUpperCase()}_API_KEY`;
    return { id: p.id, baseUrl: p.baseUrl, protocol: p.protocol, envKey, configured: Boolean(process.env[envKey]) };
  });
}
