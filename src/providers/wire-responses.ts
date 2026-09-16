/** Responses-API message lowering (aion port #75, brought over 2026-09-07) — the `/responses` twin of
 *  wire-messages.ts: harness Message[] → `{ instructions?, input[] }`, ToolSchema[] → flat function tools.
 *  Pattern source (MIT): earendil-works/pi packages/ai/src/api/openai-responses-shared.ts convertResponsesMessages
 *  :184-246 and convertResponsesTools :382-394, with these deviations:
 *  - system text → the request's `instructions` (joined "\n"; omitted when empty — pi :174-181 pushes a
 *    developer/system item instead; codex openai-codex-responses.ts:553 uses `instructions` like this);
 *  - user → `{ role: "user", content: [input_text | input_image] }` (pi :186-206): the image blocks are
 *    `{ type: "input_image", detail: "auto", image_url: "data:<mime>;base64,…" }` under the port #34 vision gate
 *    of wire-messages.ts lowerContent — placeholder text on a model without image input or for a sidecar that
 *    cannot be read (never a throw); an image-free message is ONE input_text;
 *  - assistant → `message , function_call*`: the text becomes `{ type: "message", role: "assistant",
 *    status: "completed", id: "msg_rovecode_<i>", content: [{ type: "output_text", text, annotations: [] }] }`
 *    (pi :229-230 fallback ids; ≤ 64 chars); every tool call is `{ type: "function_call", call_id, name,
 *    arguments }` with NO `id` (pi :253-263 drops the item id when it cannot be paired — rovecode never stores
 *    one, so it is always omitted);
 *  - tool results → `{ type: "function_call_output", call_id, output }`, empty output → "(no tool output)" (pi :89);
 *  - tools are FLAT `{ type: "function", name, description, parameters }` (pi :382-394) — never nested under
 *    `function` like the chat-completions shape (wire-messages.ts toOpenAiToolSchemas).
 *  NOT brought over from aion: reasoning REPLAY. aion stores each Responses reasoning item as a `reasoning`
 *  MessagePart (signature = the item JSON) and replays it verbatim ahead of the assistant message next turn, so
 *  the model gets its own prior chain back. rovecode's MessagePart has no reasoning kind; adding one touches every
 *  exhaustive switch on part.kind (store, export, TUIs, both other wires) and is its own change. Until then each
 *  turn on this wire reasons afresh; the gap is named in `rovecode help env` under ROVECODE_OPENAI_WIRE.
 *  Not ported either: pi's `phase`, text signatures, custom_tool_call / deferred tools, strict mode, surrogate sanitising. */

import type { ImagePart, Message, ModelRef } from "../core/types.ts";
import { partsText } from "../core/loop.ts";
import { imageData } from "../core/images.ts";
import { asToolSchema, lowerContent, type WireOptions } from "./wire-messages.ts";

type Item = Record<string, unknown>;

export interface ResponsesInput { instructions?: string; input: Item[] }

/** what a tool result with empty output is sent as (pi :89 — the API rejects an empty output string) */
export const NO_TOOL_OUTPUT = "(no tool output)";

/** the Responses input_image block; undefined when the bytes are unavailable (lowerContent then substitutes text) */
function inputImage(p: ImagePart): Item | undefined {
  const data = imageData(p);
  return data === undefined ? undefined : { type: "input_image", detail: "auto", image_url: `data:${p.mime};base64,${data}` };
}

/** a user message's content list: wire-messages.ts lowerContent's blocks with `text` → `input_text` */
function userContent(m: Message, vision: boolean): Item[] {
  const content = lowerContent(m, vision, inputImage);
  if (typeof content === "string") return content ? [{ type: "input_text", text: content }] : [];
  return content.map((b) => (b.type === "text" ? { type: "input_text", text: b.text } : b));
}

export function toResponsesInput(messages: Message[], opts: WireOptions & { model: ModelRef }): ResponsesInput {
  const vision = opts.vision ?? true;
  const input: Item[] = [];
  const instructions = messages.filter((m) => m.role === "system").map((m) => partsText(m.parts)).join("\n");
  messages.forEach((m, i) => {
    if (m.role === "system") return;
    if (m.role === "tool") {
      for (const p of m.parts) if (p.kind === "tool_result") input.push({ type: "function_call_output", call_id: p.callId, output: p.output || NO_TOOL_OUTPUT });
      return;
    }
    if (m.role === "user") {
      const content = userContent(m, vision);
      if (content.length > 0) input.push({ role: "user", content });
      return;
    }
    const text = partsText(m.parts);
    if (text) input.push({ type: "message", role: "assistant", status: "completed", id: `msg_rovecode_${i}`, content: [{ type: "output_text", text, annotations: [] }] });
    for (const p of m.parts) if (p.kind === "tool_call") input.push({ type: "function_call", call_id: p.id, name: p.tool, arguments: JSON.stringify(p.args ?? {}) });
  });
  return { ...(instructions ? { instructions } : {}), input };
}

/** flat function tools (pi :382-394); tolerates the {schema} wrapper like toOpenAiToolSchemas */
export function toResponsesTools(tools: unknown[]): Item[] {
  return tools.map((t) => {
    const s = asToolSchema(t);
    return { type: "function", name: s.name, description: s.description, parameters: s.args };
  });
}
