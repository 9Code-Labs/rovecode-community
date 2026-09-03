/** Context lowering for non-native tool calling (MED-2 of port #7).
 *
 *  Port of senpi's transformContext (research/source_snapshots/code-yeongyu-senpi @ a0f26a6,
 *  packages/ai/src/tool-call-middleware/context-transformer.ts:165-181, 209-261): once the
 *  middleware is driving a conversation, follow-up requests must not contain native tool
 *  artifacts — a genuinely non-native model cannot consume `tool_calls` parts, `role:"tool"`
 *  messages, or a `tools` array. So, per upstream:
 *
 *  - assistant tool_call parts  → protocol TEXT via formatToolCall (hermes; json-mix.ts:635-641)
 *  - tool-result messages       → user-role text via formatToolResponse (hermes.ts:46-60)
 *  - options.tools              → stripped (provider sees a tool-free request;
 *                                 context-transformer.ts:170)
 *
 *  Rovecode split vs upstream: transformContext also injects the tools system prompt; rovecode does
 *  that in runtime.buildDef (toolPromptBlock), so this module only lowers messages + options.
 *
 *  Activation: upstream applies transformContext whenever a text protocol is configured for
 *  the model. Rovecode wraps every provider stream, so default is AUTO-DETECT — middleware mode is
 *  observable exactly when history contains a tool call the middleware itself minted (ids are
 *  prefixed "textcall_"; native providers never produce that prefix because native turns pass
 *  through byte-identical). `lowerContext: true|false` in MiddlewareOptions overrides. */

import type { Message, MessagePart, StreamOptions } from "../core/types.ts";

/** Prefix of middleware-minted tool-call ids (withToolCallParsing). */
export const TEXTCALL_ID_PREFIX = "textcall_";

/** Hermes formatToolCall — the exact markup parseToolCalls accepts (json-mix.ts:635-641). */
export function formatToolCallText(tool: string, args: unknown): string {
  return `<tool_call>\n${JSON.stringify({ name: tool, arguments: args })}\n</tool_call>`;
}

/** Hermes formatToolResponse (hermes.ts:46-60): tool NAME + content, call id dropped. */
export function formatToolResponseText(tool: string, output: string): string {
  return `<tool_response>${JSON.stringify({ name: tool, content: output })}</tool_response>`;
}

function middlewareMintedCallsIn(messages: readonly Message[]): boolean {
  return messages.some(
    (m) => m.role === "assistant" && m.parts.some((p) => p.kind === "tool_call" && p.id.startsWith(TEXTCALL_ID_PREFIX)),
  );
}

/** Lower native tool history to text protocol. No-op (same references) unless middleware mode
 *  is active: `mode` true forces, false disables, undefined auto-detects minted ids (above).
 *  Never mutates inputs — lowered messages/options are fresh objects (upstream: "original is
 *  not mutated", context-transformer.ts:163). */
export function lowerNonNativeContext(
  messages: Message[],
  options: StreamOptions | undefined,
  mode?: boolean,
): { messages: Message[]; options: StreamOptions | undefined } {
  const active = mode ?? middlewareMintedCallsIn(messages);
  if (!active) return { messages, options };

  // callId → tool name, so tool results can be rendered under the NAME hermes expects
  // (rovecode ToolResultPart carries only callId; upstream ToolResultMessage carries toolName).
  const toolNames = new Map<string, string>();
  for (const m of messages) {
    for (const p of m.parts) if (p.kind === "tool_call") toolNames.set(p.id, p.tool);
  }

  const lowered = messages.map((m): Message => {
    if (m.role === "assistant" && m.parts.some((p) => p.kind === "tool_call")) {
      // transformAssistantMessage (:209-246): text/thinking kept, toolCall → text.
      const parts: MessagePart[] = m.parts.map((p) =>
        p.kind === "tool_call" ? { kind: "text", text: formatToolCallText(p.tool, p.args) } : p,
      );
      return { ...m, parts };
    }
    if (m.role === "tool") {
      // transformToolResultMessage (:251-261): tool result → user message with text content.
      const parts: MessagePart[] = m.parts.map((p) =>
        p.kind === "tool_result"
          ? { kind: "text", text: formatToolResponseText(toolNames.get(p.callId) ?? p.callId, p.output) }
          : p,
      );
      return { ...m, role: "user", parts };
    }
    return m;
  });

  if (options === undefined || options.tools === undefined) return { messages: lowered, options };
  const { tools: _stripped, ...toolFree } = options; // strip tools key entirely (:170)
  return { messages: lowered, options: toolFree };
}
