/** The head summarizer — the missing wire for auto-compaction (core/compaction.ts head-summarize)
 *  and the manual /compact. ONE provider call over the dropped text: no tools, no streaming needs,
 *  the loop's own model (a weak-model variant can come later — the seam takes any StreamFn+ref). */

import type { Message, ModelRef, StreamFn } from "./types.ts";

const PROMPT = `Summarize this conversation transcript for a coding agent that will continue the work without seeing it.
Preserve, in order of importance: (1) the current task and its state — what is done, what is in flight, what is blocked;
(2) files created/edited and what each contains or why; (3) decisions made and why; (4) errors hit and how they were resolved;
(5) commands/tooling facts learned (build, test, run). Drop greetings, filler, and tool-call mechanics.
Be dense: bullets, file paths with line refs where known, exact error texts where they matter. Write in the transcript's language.`;

/** texts → one dense summary. Never throws: a summarizer failure returns "" and the caller's
 *  fallback (keep-window) engages — compaction must not crash the run it was saving. */
export function createHeadSummarizer(stream: StreamFn, model: ModelRef, signal?: AbortSignal): (texts: string[]) => Promise<string> {
  return async (texts: string[]): Promise<string> => {
    // guard BEFORE joining — the separators alone would survive a trim ("---")
    if (texts.every((t) => !t.trim())) return "";
    const body = texts.join("\n\n---\n\n");
    const msg: Message = { id: "summarize", role: "user", parts: [{ kind: "text", text: `${PROMPT}\n\n${body}` }], parentId: null, createdAt: Date.now() };
    let out = "";
    try {
      for await (const ev of stream(model, [msg], { ...(signal !== undefined ? { signal } : {}), tools: [] })) {
        if (ev.type === "turn") {
          if (ev.turn.stopReason === "error") return "";
          out = ev.turn.parts.filter((p) => p.kind === "text").map((p) => p.text).join("");
        }
      }
    } catch {
      return "";
    }
    return out.trim();
  };
}
