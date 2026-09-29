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
/** The leading balanced {...} of `s`, or null — bracket/brace counting that respects strings and
 *  escapes. Only ever called on arguments that FAILED JSON.parse, to test one specific pathology. */
function leadingJsonObject(s: string): string | null {
  const start = s.indexOf("{");
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) return s.slice(0, i + 1); }
  }
  return null;
}

export function parseToolArgs(raw: string, truncated: boolean): unknown {
  if (typeof raw !== "string") throw new Error("invalid tool arguments: expected JSON string");
  try { return JSON.parse(raw || "{}"); }
  catch {
    // A proxy family REPEATS the whole arguments object in every SSE delta instead of streaming
    // fragments (the same bug that repeats the tool NAME — stream.ts absorbs that half), so the
    // accumulator holds the identical JSON two or more times: "{…}{…}". An EXACT repeat of a
    // parseable leading object is that pathology and nothing a model can legitimately produce —
    // rescue the first copy instead of failing the whole turn.
    const first = leadingJsonObject(raw);
    if (first !== null) {
      const rest = raw.slice(first.length);
      if (rest.length > 0 && rest.length % first.length === 0 && rest === first.repeat(rest.length / first.length)) {
        try { return JSON.parse(first); } catch { /* not the pathology after all — fall through */ }
      }
    }
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
