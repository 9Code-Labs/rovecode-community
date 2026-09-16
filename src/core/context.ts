/** Token accounting + ordered context assembly (ADR-007). */

export interface ContextChunk {
  name: string;          // "system" | "skills" | "repo-map" | "files" | "history" | "reminder"
  text: string;
  /** drop first under pressure; history is compacted not dropped */
  priority: number;      // higher = keep longer
  tokens: number;
}

/** Cheap estimator: ~4 chars/token, clamped. Accurate enough for budgeting;
 *  providers report exact usage which we feed back via usage accounting. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface AssemblyResult {
  chunks: ContextChunk[];      // kept, in prompt order
  dropped: ContextChunk[];     // non-history chunks evicted to fit budget (lowest priority first)
  totalTokens: number;         // tokens of kept chunks
  overBudget: boolean;         // true when even kept chunks exceed budget
}

/** Order: system > files > repo-map > skills > history > reminder (aider ChatChunks ordering).
 *  History is never dropped here (compaction owns it); non-history chunks are
 *  evicted lowest-priority-first until the budget holds — system last-dropped. */
export function assembleContext(chunks: ContextChunk[], budgetTokens: number): AssemblyResult {
  const ordered = [...chunks].sort((a, b) => b.priority - a.priority);
  const nonHistory = ordered.filter((c) => c.name !== "history");
  const dropped: ContextChunk[] = [];
  const kept = [...nonHistory];
  const hist = ordered.find((c) => c.name === "history");
  const histTokens = hist?.tokens ?? 0;
  while (kept.length > 0 && kept.reduce((n, c) => n + c.tokens, 0) + histTokens > budgetTokens) {
    // evict lowest-priority kept chunk (tail after priority sort = system last)
    const victim = kept.pop()!;
    dropped.push(victim);
  }
  const total = kept.reduce((n, c) => n + c.tokens, 0) + histTokens;
  const chunksOut = [...kept];              // prompt order: high priority first
  if (hist) chunksOut.push(hist);
  return { chunks: chunksOut, dropped, totalTokens: total, overBudget: total > budgetTokens };
}

/** Head/tail summarization plan (aider history.py:41): keep recent tail under
 *  half budget, summarize older head. Pure — callers do the LLM summarize. */
export function planCompaction(history: Message4Plan[], budgetTokens: number): { keep: Message4Plan[]; summarize: Message4Plan[] } {
  const total = history.reduce((n, m) => n + m.tokens, 0);
  if (total <= budgetTokens * 0.8) return { keep: history, summarize: [] };
  const half = Math.floor(budgetTokens / 2);
  let acc = 0; let cut = history.length;
  for (let i = history.length - 1; i >= 0; i--) {
    acc += history[i]!.tokens;
    if (acc > half) { cut = i + 1; break; }
    cut = i;
  }
  return { keep: history.slice(cut), summarize: history.slice(0, cut) };
}

export interface Message4Plan { id: string; tokens: number; text: string }
