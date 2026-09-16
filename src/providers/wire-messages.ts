/** Wire message lowering (ADR-003 seam; extracted from stream.ts for the 400-line cap): harness
 *  Message[] → OpenAI chat-completions / Anthropic Messages request shapes. Text and tool shapes
 *  are byte-identical to the pre-#34 stream.ts lowering. Port #34 adds image parts:
 *  - vision model: a USER message carrying images becomes a content-block array in part order —
 *    OpenAI `{type:"image_url", image_url:{url:"data:<mime>;base64,<data>", detail:"auto"}}`,
 *    Anthropic `{type:"image", source:{type:"base64", media_type, data}}`; image-free messages
 *    keep their plain-string content, so nothing changes for existing histories;
 *  - no vision (`vision: false` — stream.ts asks the models.dev catalog): each image lowers to
 *    imagePlaceholder() text and the message stays a plain string. The session keeps the real
 *    image; only the request is substituted (cline media.ts:6-12 pattern, opencode
 *    provider/transform.ts:409-441 unsupportedParts);
 *  - a sidecar that cannot be read lowers to a placeholder too — a request body never throws.
 *  Images on assistant/tool messages are nothing this harness produces (tool results with images
 *  are out of scope for #34): an assistant message WITHOUT tool calls lowers them to placeholder
 *  text (lowerContent's non-user branch); a tool-role message emits its tool_result parts only and
 *  an assistant message WITH tool calls emits partsText + tool_calls, so image parts on those two
 *  shapes are dropped from the request — never turned into blocks. */

import type { Message, ImagePart } from "../core/types.ts";
import { partsText } from "../core/loop.ts";
import { anthropicImageBlock, openaiImageBlock, imagePlaceholder } from "../core/images.ts";

export interface WireOptions {
  /** the target model accepts image input; default true (unknown models are given the image —
   *  a wrong guess fails loudly at the provider instead of silently dropping the user's image) */
  vision?: boolean;
}

type Block = Record<string, unknown>;

/** Content for a non-tool message: the pre-#34 plain string when no image is present; blocks in
 *  part order for a user message the model can see; placeholder text otherwise (text parts glue
 *  with "" exactly as partsText does, each image is its own line). */
export function lowerContent(m: Message, vision: boolean, toBlock: (p: ImagePart) => Block | undefined): string | Block[] {
  if (!m.parts.some((p) => p.kind === "image")) return partsText(m.parts);
  if (vision && m.role === "user") {
    const blocks: Block[] = [];
    for (const p of m.parts) {
      if (p.kind === "text") { if (p.text) blocks.push({ type: "text", text: p.text }); }
      else if (p.kind === "image") blocks.push(toBlock(p) ?? { type: "text", text: imagePlaceholder(p, "file unavailable") });
    }
    return blocks;
  }
  const pieces: string[] = [];
  let text = "";
  for (const p of m.parts) {
    if (p.kind === "text") text += p.text;
    else if (p.kind === "image") {
      if (text) { pieces.push(text); text = ""; }
      pieces.push(imagePlaceholder(p, vision ? "file unavailable" : undefined));
    }
  }
  if (text) pieces.push(text);
  return pieces.join("\n");
}

export function toOpenAiMessages(messages: Message[], opts: WireOptions = {}): Record<string, unknown>[] {
  const vision = opts.vision ?? true;
  const out: Record<string, unknown>[] = [];
  for (const m of messages) {
    const calls = m.parts.filter((p) => p.kind === "tool_call");
    const results = m.parts.filter((p) => p.kind === "tool_result");
    if (m.role === "tool") {
      for (const r of results) {
        if (r.kind === "tool_result") out.push({ role: "tool", tool_call_id: r.callId, content: r.output });
      }
      continue;
    }
    if (m.role === "assistant" && calls.length > 0) {
      out.push({
        role: "assistant",
        content: partsText(m.parts) || null,
        tool_calls: calls.map((c) => c.kind === "tool_call" ? {
          id: c.id, type: "function", function: { name: c.tool, arguments: JSON.stringify(c.args) },
        } : {}),
      });
    } else {
      const content = lowerContent(m, vision, (p) => openaiImageBlock(p));
      if (content.length > 0 || m.role === "system") out.push({ role: m.role, content });
    }
  }
  return out;
}

/** StreamOptions.tools carries bare ToolSchema entries (name/description/args) — that is what
 *  every call site (loop → adapters) passes. Tolerate a {schema} wrapper (a full Tool object)
 *  too, so a mis-passed registry entry degrades gracefully instead of throwing mid-request. */
export function asToolSchema(t: unknown): { name: string; description: string; args: Record<string, unknown> } {
  const o = t as { name?: string; description?: string; args?: Record<string, unknown>; schema?: { name: string; description: string; args: Record<string, unknown> } };
  return o.schema ?? { name: o.name ?? "unknown", description: o.description ?? "", args: o.args ?? {} };
}

export function toOpenAiToolSchemas(tools: unknown[]): Record<string, unknown>[] {
  return tools.map((t) => {
    const s = asToolSchema(t);
    return { type: "function", function: { name: s.name, description: s.description, parameters: s.args } };
  });
}

export function toAnthropicMessages(messages: Message[], opts: WireOptions = {}): Record<string, unknown>[] {
  const vision = opts.vision ?? true;
  const out: Record<string, unknown>[] = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    const calls = m.parts.filter((p) => p.kind === "tool_call");
    const results = m.parts.filter((p) => p.kind === "tool_result");
    if (m.role === "tool") {
      for (const r of results) {
        if (r.kind === "tool_result") {
          out.push({ role: "user", content: [{ type: "tool_result", tool_use_id: r.callId, content: r.output, is_error: !r.ok }] });
        }
      }
      continue;
    }
    if (m.role === "assistant" && calls.length > 0) {
      const text = partsText(m.parts);
      const content: Block[] = [];
      if (text) content.push({ type: "text", text });
      for (const c of calls) {
        if (c.kind === "tool_call") content.push({ type: "tool_use", id: c.id, name: c.tool, input: c.args });
      }
      out.push({ role: "assistant", content });
    } else {
      const content = lowerContent(m, vision, anthropicImageBlock);
      if (content.length > 0) out.push({ role: m.role === "user" ? "user" : "assistant", content });
    }
  }
  return out;
}
