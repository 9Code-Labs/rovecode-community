/** Unified tool-output budget policy (P0-3; research: docs/research/harness-architecture-research.md G3).
 *
 *  Before this module every tool invented its own ceiling — bash truncates at 10k chars
 *  (coding/hashline.ts), MCP at OUTPUT_MAX (mcp/client.ts), webfetch at MAX_BYTES, evalcell at
 *  64 KiB, and `read` (2000 lines of unbounded width — one minified line is unbounded output)
 *  had none. The strategy differed too: hard clips lose the tail, and the tail is where the
 *  error usually is (test summaries, stack traces, "n lines omitted" footers).
 *
 *  One policy now backs them all:
 *    - at/under the cap the output passes BYTE-VERBATIM — a tool result the policy did nothing
 *      to is byte-identical, so nothing downstream (reflection, guardrails, transcripts) sees
 *      a difference;
 *    - over the cap the MIDDLE goes: head + tail are kept (the tail carries the diagnosis, the
 *      head carries the orientation), joined by a marker that names what was removed — chars
 *      and their estimate in the loop's own unit (estimateTokens, chars/4) — and how to see the
 *      omitted span (a narrower range/query; the read tool's offset/limit);
 *    - the cut is UTF-8/grapheme safe: it never splits a surrogate pair, a combining-mark
 *      sequence, a ZWJ emoji chain or a flag pair. A boundary that lands inside one backs off
 *      to the last whole grapheme — the model is never handed half an emoji.
 *
 *  Where it runs: the loop applies it ONCE per batch to the results it persists and re-sends
 *  (core/loop.ts, after dispatchBatch settles). Tool-side caps stay — a tighter tool cap wins
 *  by construction (its output is already under the ceiling). The live `tool_execution_end`
 *  event carries the RAW output (surface fidelity; the human can handle a wall of text, the
 *  context window cannot) — an accepted, documented divergence.
 *
 *  Sizing: DEFAULT_OUTPUT_CAP is a ceiling, not a target — it exists for the pathological
 *  output (a 2 MB log cat'd whole), not to shave normal ones. 32 KiB ≈ 8k tokens ≈ the room
 *  a whole small file takes; beyond it the middle of a tool result is almost never what the
 *  next turn needs. */

import { estimateTokens } from "./context.ts";

export interface OutputBudgetOptions {
  /** ceiling for a tool result in UTF-16 code units (string.length), default DEFAULT_OUTPUT_CAP */
  defaultCap?: number;
  /** per-tool ceilings; unlisted tools get defaultCap. A tool's own tighter cap wins by
   *  construction (its output never reaches the ceiling). */
  perTool?: Record<string, number>;
  /** share of the kept budget spent on the head; the tail gets the rest (0..1, default 0.7) */
  headShare?: number;
}

export interface TruncatedOutput {
  text: string;
  truncated: boolean;
  originalChars: number;
  /** chars of payload kept (head + tail, marker excluded) */
  keptChars: number;
  /** removed payload, estimated with the loop's own unit (estimateTokens) */
  estTokensCut: number;
}

export const DEFAULT_OUTPUT_CAP = 32_768;
export const DEFAULT_HEAD_SHARE = 0.7;
/** the marker opens with this — tests and the idempotence note key on it */
export const TRUNCATION_MARK = "[…output budget:";

const ZWJ = "‍";
const isCombining = (ch: string): boolean => /\p{M}/u.test(ch);
const isRI = (ch: string): boolean => /\p{Regional_Indicator}/u.test(ch);

/** Whole-grapheme slice by UTF-16 budget: take code points until `units` are spent, then back
 *  the boundary off so it never lands inside a combining sequence, a ZWJ chain, or a flag pair. */
function takeUnits(cps: string[], from: number, dir: 1 | -1, units: number): number {
  let i = from;
  let spent = 0;
  while (i >= 0 && i < cps.length) {
    const w = cps[i]!.length; // 1 or 2 UTF-16 units — a code point is never split
    if (spent + w > units) break;
    spent += w;
    i += dir;
  }
  // back off: not after a ZWJ, not before/after a combining mark run, not inside a flag pair
  if (dir === 1) {
    let end = i; // exclusive
    while (end > from && (cps[end - 1] === ZWJ || (end < cps.length && isCombining(cps[end]!)))) end--;
    // flag pairs: an odd run of regional indicators before the cut means the last one is unpaired
    if (end > from && end < cps.length && isRI(cps[end - 1]!) && isRI(cps[end]!)) {
      let run = 0;
      for (let j = end - 1; j >= 0 && isRI(cps[j]!); j--) run++;
      if (run % 2 === 1) end--;
    }
    return end;
  }
  let start = i + 1; // inclusive
  while (start <= from && (cps[start] === ZWJ || isCombining(cps[start]!))) start++;
  if (start > 0 && start < cps.length && isRI(cps[start - 1]!) && isRI(cps[start]!)) {
    let run = 0;
    for (let j = start; j < cps.length && isRI(cps[j]!); j++) run++;
    if (run % 2 === 1) start++;
  }
  return start;
}

function marker(removedChars: number, originalChars: number): string {
  const est = estimateTokens("x".repeat(removedChars));
  return `\n\n${TRUNCATION_MARK} removed ${removedChars} of ${originalChars} chars (~${est} tokens) from the middle — re-run the tool with a narrower range/query (read: offset/limit) to see any part in full…]\n\n`;
}

/** The pure core: one output, one cap. Two-pass because the marker names the cut and is itself
 *  bounded by the cap — the second pass sizes the cut against the real marker length. */
export function applyBudget(output: string, cap: number, headShare: number = DEFAULT_HEAD_SHARE): TruncatedOutput {
  const originalChars = output.length;
  const verbatim: TruncatedOutput = { text: output, truncated: false, originalChars, keptChars: originalChars, estTokensCut: 0 };
  if (originalChars <= cap) return verbatim;
  if (cap < 32) {
    // degenerate: no room for a useful marker — hard-clip with an ellipsis, still bounded
    const text = output.slice(0, Math.max(0, cap - 1)) + "…";
    return { text, truncated: true, originalChars, keptChars: text.length, estTokensCut: estimateTokens("x".repeat(originalChars - text.length)) };
  }
  const cps = Array.from(output);
  // pass 1 with an estimated marker, pass 2 with the real one (digit-count stable)
  let mk = marker(0, originalChars);
  let headEnd = 0, tailStart = cps.length;
  for (let pass = 0; pass < 2; pass++) {
    const room = Math.max(0, cap - mk.length);
    const headUnits = Math.floor(room * Math.min(1, Math.max(0, headShare)));
    headEnd = takeUnits(cps, 0, 1, headUnits);
    tailStart = takeUnits(cps, cps.length - 1, -1, room - unitsOf(cps, 0, headEnd));
    if (tailStart <= headEnd) tailStart = headEnd; // pathological: marker ≈ cap → no tail
    const removedUnits = unitsOf(cps, headEnd, tailStart);
    mk = marker(removedUnits, originalChars);
  }
  const head = cps.slice(0, headEnd).join("");
  const tail = cps.slice(tailStart).join("");
  const text = head + mk + tail;
  const removed = originalChars - (head.length + tail.length);
  return {
    text,
    truncated: true,
    originalChars,
    keptChars: head.length + tail.length,
    estTokensCut: estimateTokens("x".repeat(removed)),
  };
}

function unitsOf(cps: string[], from: number, to: number): number {
  let n = 0;
  for (let i = from; i < to; i++) n += cps[i]!.length;
  return n;
}

/** The first `units` UTF-16 units of text, cut at a whole-grapheme boundary (compaction.ts's prune
 *  stub head reuses it — a stub prefix must never open with half an emoji either). */
export function safeHead(text: string, units: number): string {
  const cps = Array.from(text);
  return cps.slice(0, takeUnits(cps, 0, 1, units)).join("");
}

export interface ToolOutputBudgetPolicy {
  capFor(tool: string): number;
  apply(tool: string, output: string): TruncatedOutput;
}

/** The policy the loop holds for a run. `undefined` options = the defaults; the policy is a pure
 *  function of its options — no I/O, no clock, no state. */
export function createOutputBudget(opts: OutputBudgetOptions = {}): ToolOutputBudgetPolicy {
  const defaultCap = opts.defaultCap ?? DEFAULT_OUTPUT_CAP;
  const headShare = opts.headShare ?? DEFAULT_HEAD_SHARE;
  const capFor = (tool: string): number => opts.perTool?.[tool] ?? defaultCap;
  return {
    capFor,
    apply: (tool, output) => applyBudget(output, capFor(tool), headShare),
  };
}
