/** One-line text normalisers for the session surfaces (aion ports #59 previews and #84 titles, brought over
 *  2026-09-07). Both run on the way OUT of the store — listSessions (core/session.ts, the one scanner) applies them to
 *  what it READS — so no consumer (the `rovecode sessions` table and `--json` rows, `GET /sessions`, the TUI /sessions
 *  picker, `sessions search` rows) ever sees a raw multi-line or control-laden string from a repo-controlled meta.json
 *  or entries.jsonl: a planted title such as "line1\nremoved D:/x\n\u001b[31m…" can neither forge extra table rows nor
 *  reach the terminal as an escape sequence, and an empty one is "no title" (the key is absent). The rename path
 *  (session-ops.ts) applies the same oneLineTitle BEFORE it writes, so a title rovecode wrote is already in its read form. */

import type { Message, TextPart } from "./types.ts";

/** Single-line preview of a message's text parts; ≤80 chars, "" when no text. */
export function previewText(m: Message): string {
  const joined = m.parts.filter((p): p is TextPart => p.kind === "text").map((p) => p.text).join(" ");
  const one = joined.replace(/\s+/g, " ").trim();
  return one.length > 80 ? one.slice(0, 79) + "…" : one;
}

export const TITLE_MAX_CHARS = 120;

/** A title is ONE line: whitespace runs and control characters (C0, DEL and the C1 range — every ANSI escape, 7- or 8-bit,
 *  starts with one) collapse to a single space, trimmed, capped at TITLE_MAX_CHARS code points with an ellipsis marking
 *  the cut (an astral character — an emoji — is never split into a lone surrogate, so the result is always well-formed
 *  for JSON and the terminal); empty → undefined (the write path makes that a usage error, the read path omits the key). */
export function oneLineTitle(raw: string): string | undefined {
  const one = raw.replace(/[\s\u0000-\u001f\u007f-\u009f]+/g, " ").trim();
  if (one === "") return undefined;
  const cps = Array.from(one);
  return cps.length > TITLE_MAX_CHARS ? cps.slice(0, TITLE_MAX_CHARS - 1).join("") + "…" : one;
}
