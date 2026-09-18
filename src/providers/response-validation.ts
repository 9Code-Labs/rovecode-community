/** Fail closed on malformed provider envelopes and tool calls, before any side effect. */
import type { AssistantTurn, StopReason } from "../core/types.ts";

export function rejectProviderError(json: unknown): void {
  if (json === null || typeof json !== "object") throw new Error("invalid provider response: expected an object");
  const error = (json as { error?: unknown }).error;
  if (error !== undefined) {
    const message = typeof error === "object" && error !== null ? (error as { message?: unknown }).message : error;
    throw new Error(`provider error: ${typeof message === "string" ? message : JSON.stringify(error)}`);
  }
}
export function openAiStop(reason: string | null | undefined): StopReason {
  if (reason === "length") return "length";
  if (reason === "tool_calls") return "tool_use";
  if (reason === "stop") return "end_turn";
  throw new Error(`OpenAI response has invalid or missing finish reason: ${reason ?? "missing"}`);
}
export function anthropicStop(reason: string | null | undefined): StopReason {
  if (reason === "max_tokens") return "length";
  if (reason === "tool_use") return "tool_use";
  if (reason === "end_turn" || reason === "stop_sequence") return "end_turn";
  throw new Error(`Anthropic response has invalid or missing finish reason: ${reason ?? "missing"}`);
}
export function parseToolArgs(raw: string, truncated: boolean): unknown {
  if (typeof raw !== "string") throw new Error("invalid tool arguments: expected JSON string");
  try { return JSON.parse(raw || "{}"); }
  catch {
    // Length-limited calls never execute; retain fragments for the loop's failed result.
    if (truncated) return { _raw: raw };
    throw new Error("invalid tool arguments: expected complete JSON object");
  }
}
export function validateToolCalls(parts: AssistantTurn["parts"], stop: StopReason): void {
  const ids = new Set<string>();
  for (const p of parts) {
    if (p.kind !== "tool_call") continue;
    if (typeof p.id !== "string" || !p.id.trim() || typeof p.tool !== "string" || !p.tool.trim()) {
      throw new Error("invalid tool call: missing id or name");
    }
    if (ids.has(p.id)) throw new Error(`invalid tool call: duplicate id ${p.id}`);
    ids.add(p.id);
    if (stop !== "length" && (p.args === null || typeof p.args !== "object" || Array.isArray(p.args))) {
      throw new Error("invalid tool arguments: expected JSON object");
    }
  }
  if (stop === "tool_use" && ids.size === 0) throw new Error("provider requested tool use without any tool calls");
}
