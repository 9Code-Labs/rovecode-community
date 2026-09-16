/** OpenAI wire selection (aion port #75, brought over 2026-09-07): ONE rule that decides, PER CALL, whether an
 *  OpenAI-protocol request goes to `/responses` (providers/responses.ts) or `/chat/completions` (providers/stream.ts
 *  openaiCompatStream / openaiCompatStreaming). The two production factories — providerStream / providerStreaming —
 *  return ONE StreamFn built with `openAiWire`, so a router chain that streams different ModelRefs through the same
 *  StreamFn (providers/router.ts wrap) gets the right wire for each candidate, and the OAuth refresh wrap
 *  (oauth/seam.ts oauthStream) needs no change. The selection is static — no runtime 404 → chat re-issue
 *  (ADR-003: still ONE loop; errors cross as turns).
 *
 *  Precedence (`selectOpenAiWire`):
 *  1. `cfg.wire` — set by the OpenAI OAuth `toAuth` (a ChatGPT token is accepted by the Codex Responses
 *     backend only, oauth/openai.ts) → always that wire, whatever the model;
 *  2. `ROVECODE_OPENAI_WIRE=responses|chat` (read directly, like every ROVECODE_* knob here; no settings key yet)
 *     → that wire, for any provider id; an unrecognised value falls through;
 *  3. `cfg.id === "openai"` and the model is not marked non-reasoning — the runtime's stamp on the ModelRef
 *     (cli/runtime.ts buildDef sets `reasoning` from models.dev) first, else the offline catalog (catalog.ts
 *     supportsReasoning): `true` OR unknown (gpt-5, o3, gpt-5.3-codex, an unlisted gpt-5-codex — the #60/#34
 *     "unknown = fail loudly at the provider" rule, so a Responses-only id absent from the snapshot is not
 *     sent to a 404) → responses;
 *  4. else chat — `openai/gpt-4o`, `openai/gpt-4.1`, EVERY other provider id (`custom`, groq, deepseek,
 *     openrouter, ollama, mock …) keep today's byte-identical `/chat/completions` body. The Anthropic
 *     protocol never consults this module (the factories branch on protocol first).
 *  Pattern source (MIT): earendil-works/pi packages/ai/src/api/openai-responses.ts — pi routes by the model's
 *  declared `api` ("openai-responses" vs "openai-completions") from its model table; rovecode has no per-model
 *  api column, so the catalog's `reasoning` flag stands in for it, with the two explicit overrides above. */

import type { Message, ModelRef, StreamEvent, StreamOptions } from "../core/types.ts";
import { supportsReasoning } from "./catalog.ts";
import type { MakeStream } from "./oauth/seam.ts";
import type { ProviderConfig } from "./stream.ts";

export type OpenAiWire = "responses" | "chat";
/** the `ROVECODE_OPENAI_WIRE` values */
export const OPENAI_WIRES: readonly OpenAiWire[] = ["responses", "chat"];
export const OPENAI_WIRE_ENV = "ROVECODE_OPENAI_WIRE";

/** "responses" | "chat" (trimmed, any case), else undefined — an unrecognised env value falls through to the default rule */
export function parseWire(v: string | undefined): OpenAiWire | undefined {
  const t = (v ?? "").trim().toLowerCase();
  return t === "responses" || t === "chat" ? t : undefined;
}

/** the wire for THIS request (header precedence). `env` is injectable for tests; production reads process.env. */
export function selectOpenAiWire(cfg: Pick<ProviderConfig, "id" | "wire">, model: ModelRef, env: Record<string, string | undefined> = process.env): OpenAiWire {
  return cfg.wire ?? parseWire(env[OPENAI_WIRE_ENV]) ?? (cfg.id === "openai" && (model.reasoning ?? supportsReasoning(model)) !== false ? "responses" : "chat");
}

/** A MakeStream (oauth/seam.ts shape) whose StreamFn picks `responses` or `chat` per call from the ModelRef
 *  it is given — the same opts (base URL, key, headers) reach whichever adapter serves the call. */
export function openAiWire(cfg: Pick<ProviderConfig, "id" | "wire">, chat: MakeStream, responses: MakeStream): MakeStream {
  return (opts) => async function* (model: ModelRef, messages: Message[], options?: StreamOptions): AsyncGenerator<StreamEvent> {
    yield* (selectOpenAiWire(cfg, model) === "responses" ? responses : chat)(opts)(model, messages, options);
  };
}
