/** Shared JSONL helpers for the lane adapters (#47): a parse that never throws, tolerant field
 *  readers (each CLI names its token fields differently), the one-line rendering of a LaneEvent
 *  (the runner's log ring / the TaskInfo preview), and the usage fold. */

import type { TokenUsage } from "../core/types.ts";
import type { LaneEvent } from "./types.ts";

export type Obj = Record<string, unknown>;

export const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
export const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
export const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
export const obj = (v: unknown): Obj | undefined => (isObj(v) ? v : undefined);
export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** One JSONL line → its object, or null for anything that is not a JSON object (never throws). */
export function parseJsonLine(line: string): Obj | null {
  const t = line.trim();
  if (!t.startsWith("{")) return null;
  try {
    const v: unknown = JSON.parse(t);
    return isObj(v) ? v : null;
  } catch {
    return null;
  }
}

/** First non-empty line, clipped with an ellipsis. */
export function clip(text: string | undefined, max = 160): string {
  const one = (text ?? "").split("\n").map((l) => l.trim()).find((l) => l !== "") ?? "";
  return one.length > max ? one.slice(0, max - 1) + "…" : one;
}

/** Text of a content field that may be a string or an array of {type:"text", text} blocks. */
export function contentText(v: unknown): string {
  if (typeof v === "string") return v;
  return arr(v).map((b) => (isObj(b) && b["type"] === "text" ? str(b["text"]) ?? "" : "")).filter(Boolean).join("\n");
}

/** Tolerant token reader: Anthropic/claude `input_tokens`/`output_tokens`/`cache_read_input_tokens`/
 *  `cache_creation_input_tokens` + `total_cost_usd`; codex `input_tokens`/`cached_input_tokens`/
 *  `output_tokens`; opencode `input`/`output`/`cache.read`/`cache.write` + `cost`; agy `usage`/`stats`
 *  shapes. undefined when nothing token-like is present. */
export function usageFrom(v: unknown, costHolder?: unknown): TokenUsage | undefined {
  const u = obj(v);
  if (!u) return undefined;
  const input = num(u["input_tokens"]) ?? num(u["prompt_tokens"]) ?? num(u["input"]);
  const output = num(u["output_tokens"]) ?? num(u["completion_tokens"]) ?? num(u["output"]);
  if (input === undefined && output === undefined) return undefined;
  const cache = obj(u["cache"]);
  const cacheRead = num(u["cache_read_input_tokens"]) ?? num(u["cached_input_tokens"]) ?? num(cache?.["read"]);
  const cacheWrite = num(u["cache_creation_input_tokens"]) ?? num(cache?.["write"]);
  const c = obj(costHolder) ?? u;
  const costUsd = num(c["total_cost_usd"]) ?? num(c["cost_usd"]) ?? num(c["cost"]);
  const out: TokenUsage = { input: input ?? 0, output: output ?? 0 };
  if (cacheRead !== undefined) out.cacheRead = cacheRead;
  if (cacheWrite !== undefined) out.cacheWrite = cacheWrite;
  if (costUsd !== undefined) out.costUsd = costUsd;
  return out;
}

/** Sum two usages (opencode reports per message; the others once). */
export function addUsage(a: TokenUsage | undefined, b: TokenUsage): TokenUsage {
  if (!a) return { ...b };
  const out: TokenUsage = { input: a.input + b.input, output: a.output + b.output };
  const cr = (a.cacheRead ?? 0) + (b.cacheRead ?? 0), cw = (a.cacheWrite ?? 0) + (b.cacheWrite ?? 0);
  if (a.cacheRead !== undefined || b.cacheRead !== undefined) out.cacheRead = cr;
  if (a.cacheWrite !== undefined || b.cacheWrite !== undefined) out.cacheWrite = cw;
  if (a.costUsd !== undefined || b.costUsd !== undefined) out.costUsd = (a.costUsd ?? 0) + (b.costUsd ?? 0);
  return out;
}

/** One log line per event — the shape the log ring, the running preview and the board tail show. */
export function renderEvent(ev: LaneEvent): string {
  switch (ev.kind) {
    case "log": return clip(ev.text, 200);
    case "edit": return `${ev.op} ${ev.path}${ev.wrote === true ? " (ok)" : ""}`;
    case "bash": {
      const code = ev.exitCode !== undefined ? ` → exit ${ev.exitCode}` : "";
      const out = ev.output ? ` · ${clip(ev.output, 80)}` : "";
      return `$ ${clip(ev.command, 100)}${code}${out}`;
    }
    case "tool": return `tool ${ev.name}${ev.detail ? `: ${ev.detail}` : ""}`;
    case "ask": return `ask: ${clip(ev.text, 160)}`;
    case "progress": return `progress: ${clip(ev.text, 160)}`;
    case "done": return `done: ${clip(ev.summary, 160) || "(no output)"}`;
    case "fail": return `fail: ${clip(ev.error, 160) || "(no reason)"}`;
    case "usage": {
      const cost = ev.usage.costUsd !== undefined ? ` · $${ev.usage.costUsd.toFixed(4)}` : "";
      return `usage: ${ev.usage.input} in · ${ev.usage.output} out${cost}`;
    }
  }
}

/** Which lane-event kind a tool name maps to — the one place the four CLIs' tool vocabularies meet. */
export type ToolShape = "bash" | "write" | "edit" | "other";
export function toolShape(name: string): ToolShape {
  const n = name.toLowerCase();
  if (/^(bash|shell|command|run_command|run_shell_command|execute)$/.test(n)) return "bash";
  if (/^(write|write_file|create_file|notebookedit)$/.test(n)) return "write";
  if (/^(edit|multiedit|edit_file|replace|str_replace|patch|apply_patch)$/.test(n)) return "edit";
  return "other";
}

/** The path a tool's arguments name, under any of the four spellings ("?" when none). */
export function toolPath(input: Obj | undefined): string {
  return str(input?.["file_path"]) ?? str(input?.["filePath"]) ?? str(input?.["path"]) ?? str(input?.["file"]) ?? "?";
}

/** Tool-name → lane event for the file/shell tools every CLI has under some name.
 *
 *  `o.wrote` is the caller's promise that the CLI CONFIRMED the write (see types.ts LaneEvent): pass it
 *  only from a tool RESULT or a completed change, never from the call. `o.callId` is the CLI's own id for
 *  the call, which is what keeps lanes/progress.ts from counting one call twice when a CLI reports it
 *  at both its start and its end. */
export function toolEvent(name: string, input: Obj | undefined, output?: string, exitCode?: number, o: { callId?: string; wrote?: true } = {}): LaneEvent {
  const id = o.callId !== undefined && o.callId !== "" ? { callId: o.callId } : {};
  const path = toolPath(input);
  switch (toolShape(name)) {
    case "bash": {
      const ev: LaneEvent = { kind: "bash", command: str(input?.["command"]) ?? str(input?.["cmd"]) ?? "?", ...id };
      if (output !== undefined) ev.output = output;
      if (exitCode !== undefined) ev.exitCode = exitCode;
      return ev;
    }
    case "write": return { kind: "edit", path, op: "write", ...id, ...(o.wrote ? { wrote: true } : {}) };
    case "edit": return { kind: "edit", path, op: "edit", ...id, ...(o.wrote ? { wrote: true } : {}) };
    default: return { kind: "tool", name, ...id, ...(output ? { detail: clip(output, 120) } : {}) };
  }
}
