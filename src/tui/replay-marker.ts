/** Persisted RunEvent annotations → transcript lines (port #25 LOW-4). The loop persists a
 *  compaction as a `kind: "event"` entry (SessionStore.appendEvent) right where it happened, and
 *  the live TUI shows it as a system note; a resumed session (--resume, /resume, /sessions)
 *  replays the SAME line at the same place, so "was this context compacted?" has one answer on
 *  both paths. ONE wording, built here, used by app.ts (live) and session-cmd.ts replayTranscript
 *  (replay) — never two strings to keep in step. Any other persisted event type renders nothing:
 *  the live TUI shows nothing for a bare event either, and replay must never add a line the run
 *  did not (context-drop compactions are yielded but not persisted — loop.ts:191 — so a resumed
 *  session cannot show them; nothing to render). */

import type { Entry } from "../core/session.ts";
import type { Message, RunEvent } from "../core/types.ts";

export type CompactionEvent = Extract<RunEvent, { type: "compaction" }>;
/** SessionStore.appendEvent's entry shape — the non-message half of Entry */
export type EventEntry = Exclude<Entry, Message>;

/** the TUI's system note for a compaction — live (app.ts startRun) and replayed alike */
export function compactionNote(ev: CompactionEvent): string {
  return `compacted (${ev.strategy}): ${ev.tokensBefore} → ${ev.tokensAfter} tokens`;
}

/** the transcript line for a persisted event entry, or null when the live TUI shows nothing for
 *  it. Tolerant of a foreign/corrupt entry (session.ts never throws on shape; neither does replay). */
export function replayMarkerLine(entry: EventEntry): string | null {
  const ev = entry.event as RunEvent | undefined;
  if (!ev || typeof ev !== "object") return null;
  return ev.type === "compaction" ? compactionNote(ev) : null;
}
