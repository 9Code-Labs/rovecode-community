/** Sextant diff base (port #44 fix wave): the PRE-EDIT content of a file the agent edited without a
 *  gate (yolo, `always`, an auto-allowed rule), rebuilt after the fact. Why after: the renderer sees
 *  tool_execution_start only when the loop's event pump flushes (core/loop.ts pumps every 5 ms), and
 *  rovecode's edit/write tools have already written synchronously by then (core/tools.ts: emit → await
 *  execute, whose first statements are the fs calls) — a disk snapshot taken at the start event IS the
 *  post-edit file. What the ops carry is enough to walk the edit back: each hashline op replaced ONE
 *  anchored line (anchorLine in the original, verified by lineHash) with newLines, applied bottom-up
 *  (coding/hashline.ts applyEditsToContent), so undoing them top-down puts every new block at
 *  anchorLine − 1 of the partially restored file. The only unknown per op is the replaced line's text;
 *  any line whose lineHash equals the anchor — in git HEAD, or elsewhere in the file — is a candidate,
 *  and the file TAG the ops carry (fileTag of the content the model read) proves a rebuild right or
 *  rejects it. Pure: no I/O, no clock. */

import { fileTag, lineHash, type EditOp } from "../coding/hashline.ts";

export type HashlineOp = Pick<EditOp, "tag" | "anchorLine" | "anchorHash" | "newLines">;

/** candidate combinations tried before giving up (whitespace variants of one line share a hash) */
const MAX_TRIES = 8;

/** the hashline ops of an edit call's args (tool_execution_start.args); [] when any op is malformed */
export function editOpsOf(args: unknown): HashlineOp[] {
  const a = args && typeof args === "object" && !Array.isArray(args) ? (args as { edits?: unknown }) : {};
  if (!Array.isArray(a.edits)) return [];
  const out: HashlineOp[] = [];
  for (const e of a.edits) {
    const r = e && typeof e === "object" && !Array.isArray(e) ? (e as Record<string, unknown>) : {};
    const lines = Array.isArray(r.newLines) && r.newLines.every((l) => typeof l === "string") ? (r.newLines as string[]) : null;
    if (typeof r.tag !== "string" || typeof r.anchorLine !== "number" || !Number.isInteger(r.anchorLine) || typeof r.anchorHash !== "string" || !lines) return [];
    out.push({ tag: r.tag, anchorLine: r.anchorLine, anchorHash: r.anchorHash, newLines: lines });
  }
  return out;
}

/** The content before `ops` were applied to it, given the file on disk NOW (`disk`) and the committed
 *  content when git has one (`head`) — or null when it cannot be proven: no op, ops that disagree on the
 *  TAG or share a line, a block on disk that is not its op's newLines, an anchor no known line hashes to,
 *  or no candidate combination that reproduces the TAG. Null means "no pre-edit base" — never a guess. */
export function reconstructBefore(disk: string, ops: readonly HashlineOp[], head: string | null): string | null {
  if (!ops.length) return null;
  const tag = ops[0]!.tag;
  if (ops.some((o) => o.tag !== tag)) return null;
  const sorted = [...ops].sort((a, b) => a.anchorLine - b.anchorLine);
  if (sorted.some((o, i) => i > 0 && o.anchorLine === sorted[i - 1]!.anchorLine)) return null;
  const post = disk.split("\n");
  // HEAD lines first: the replaced line is most likely intact there; then the file itself (an unchanged twin)
  const pool = [...(head ?? "").split("\n"), ...post];
  const candidates = sorted.map((o) => [...new Set(pool.filter((l) => lineHash(l) === o.anchorHash))]);
  if (candidates.some((c) => c.length === 0)) return null;
  let tries = 0;
  const attempt = (i: number, lines: string[]): string | null => {
    if (i === sorted.length) { const text = lines.join("\n"); return fileTag(text) === tag ? text : null; }
    const o = sorted[i]!, at = o.anchorLine - 1, n = o.newLines.length;
    if (at < 0 || at > lines.length || o.newLines.some((l, k) => lines[at + k] !== l)) return null;
    for (const text of candidates[i]!) {
      if (++tries > MAX_TRIES) return null;
      const r = attempt(i + 1, [...lines.slice(0, at), text, ...lines.slice(at + n)]);
      if (r !== null) return r;
    }
    return null;
  };
  return attempt(0, post);
}
