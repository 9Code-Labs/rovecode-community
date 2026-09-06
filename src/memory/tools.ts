/** memory_edit tool (hermes memory_tool pattern): add/replace/remove on the bounded
 *  markdown blocks. Failures (bad match, cap overflow, bad args) count toward a
 *  per-turn cap of 3; at the cap the tool returns a terminal skip so the agent
 *  stops burning turns on memory writes (hermes #42405). */

import type { Tool, ToolContext, ToolOutput } from "../core/types.ts";
import { BlockStore, type BlockName } from "./blocks.ts";

const MAX_FAILURES_PER_TURN = 3;
const CAP_MESSAGE = "save skipped: memory at capacity or repeatedly failing";

let turnFailureCount = 0;

export function resetTurnFailureCount(): void { turnFailureCount = 0; }

export function turnFailures(): number { return turnFailureCount; }

export interface MemoryEditArgs {
  op: "add" | "replace" | "remove";
  block: BlockName;
  text?: string;
  oldText?: string;
  newText?: string;
}

/** Build the tool bound to a store instance (the store is per-session). */
export function memoryEditTool(store: BlockStore): Tool {
  return {
    schema: {
      name: "memory_edit",
      description:
        `Edit long-term memory blocks. Ops: add(text) appends a line; replace(oldText,newText) requires oldText to match exactly once; remove(oldText) same. ` +
        `block: "memory" (session/task facts, cap ${store.cap("memory")} chars) or "user" (stable user preferences, cap ${store.cap("user")} chars). ` +
        `Failures count toward a per-turn budget of ${MAX_FAILURES_PER_TURN}; after that saves are skipped until next turn.`,
      args: {
        type: "object",
        properties: {
          op: { type: "string", enum: ["add", "replace", "remove"] },
          block: { type: "string", enum: ["memory", "user"] },
          text: { type: "string", description: "text to add (op=add)" },
          oldText: { type: "string", description: "exact text to replace/remove; must match exactly once" },
          newText: { type: "string", description: "replacement text (op=replace; empty removes)" },
        },
        required: ["op", "block"],
      },
    },
    kind: "memory",
    sequential: true,
    async execute(args: unknown, _ctx: ToolContext): Promise<ToolOutput> {
      const a = args as MemoryEditArgs;
      if (turnFailureCount >= MAX_FAILURES_PER_TURN) {
        return { ok: false, output: CAP_MESSAGE };
      }
      const block = a.block === "user" ? "user" : a.block === "memory" ? "memory" : undefined;
      if (!block) return fail(`invalid block: ${String(a.block)}`);

      let res;
      switch (a.op) {
        case "add":
          if (typeof a.text !== "string" || a.text.trim().length === 0) {
            return fail("op=add requires non-empty text");
          }
          res = store.add(block, a.text);
          break;
        case "replace":
          if (typeof a.oldText !== "string" || a.oldText.length === 0) {
            return fail("op=replace requires oldText");
          }
          if (typeof a.newText !== "string") return fail("op=replace requires newText (use \"\" to delete)");
          res = store.replace(block, a.oldText, a.newText);
          break;
        case "remove":
          if (typeof a.oldText !== "string" || a.oldText.length === 0) {
            return fail("op=remove requires oldText");
          }
          res = store.remove(block, a.oldText);
          break;
        default:
          return fail(`invalid op: ${String(a.op)}`);
      }

      if (!res.ok) {
        return fail(res.reason ?? "edit failed", res.current, res.limit);
      }
      return {
        ok: true,
        output: `${a.op} ok: ${block} block now ${res.current}/${res.limit} chars`,
        data: { block, chars: res.current, limit: res.limit },
      };
    },
  };
}

/** Every failure path routes through here so the per-turn counter stays honest. */
function fail(reason: string, current?: number, limit?: number): ToolOutput {
  turnFailureCount++;
  const detail = current !== undefined && limit !== undefined ? ` (current ${current}/${limit} chars)` : "";
  return { ok: false, output: `memory_edit failed: ${reason}${detail}; failures this turn: ${turnFailureCount}/${MAX_FAILURES_PER_TURN}` };
}
