/** TUI session navigation (port #2 session tree), extracted from app.ts for the ADR-002
 *  cap: /sessions + /resume pick or resolve a session to switch to, /rewind (alias /tree)
 *  jumps to an earlier turn for edit-and-resubmit, /new branches back to the session
 *  start. The CALLER owns the swappable store and the rebind routine (switchSession), so
 *  store reads and switches run through the injected ctx — same shape as checkpoints-cmd.
 *  Also home to the pure session helpers the app calls around a switch: transcript replay,
 *  usage recount, and the `--resume <prefix>` boot resolution (wiring pass, ADR-002 cap). */

import { partsText } from "../core/loop.ts";
import { listSessions, type SessionStore } from "../core/session.ts";
import { ambiguityMessage, matchSessions } from "../core/session-ops.ts";
import { userTurnLine } from "./attach.ts";
import { replayLabel } from "./modes-cmd.ts";
import { replayMarkerLine } from "./replay-marker.ts";
import { replayShellRecord } from "./shell-cmd.ts";
import type { Renderer } from "./renderer.ts";
import { randomUUID } from "node:crypto";

/** Re-render the whole transcript from the active session path (boot replay, /resume, /rewind,
 *  /new, checkpoint restores). Tool calls replay as start+end card pairs; mode switches render
 *  as a human line (port #20 LOW-3), never the raw <mode_notice> XML the entry carries; user
 *  turns carry their image chips (port #34), so an image-only turn is not a blank line; persisted
 *  compaction events replay as the live run's note (port #25 LOW-4, replay-marker.ts). */
export function replayTranscript(renderer: Renderer, store: SessionStore): void {
  renderer.clearTranscript();
  for (const m of store.path()) {
    if (!("role" in m)) { const line = replayMarkerLine(m); if (line !== null) renderer.addSystemNote(line); continue; } // event entry (appendEvent): marker or nothing
    const text = partsText(m.parts);
    // a `!cmd` record is a user message in the store, but it replays as the typed line plus its bash card pair
    // (tui/shell-cmd.ts) rather than as the raw <user_shell_command> block the model reads
    if (m.role === "user" && replayShellRecord(renderer, text)) continue;
    if (m.role === "user") { const line = userTurnLine(text, m.parts); if (line) renderer.addUser(line); }
    else if (m.role === "assistant") {
      if (text) { const v = renderer.beginAssistant(); v.append(text); v.done(); }
      for (const p of m.parts) {
        if (p.kind === "tool_call") renderer.toolStart(p.id, p.tool, JSON.stringify(p.args).slice(0, 120));
      }
    } else if (m.role === "tool") {
      for (const p of m.parts) {
        if (p.kind === "tool_result") renderer.toolEnd(p.callId, p.ok, p.output.slice(0, 160).replace(/\n/g, " ⏎ "), 0);
      }
    } else if (m.role === "system" && text) renderer.addSystemNote(replayLabel(m, text));
  }
}

/** Token usage summed over the active path — the status line's counters. */
export function usageOf(store: SessionStore): { tokensIn: number; tokensOut: number } {
  let tokensIn = 0, tokensOut = 0;
  for (const m of store.messages()) { tokensIn += m.usage?.input ?? 0; tokensOut += m.usage?.output ?? 0; }
  return { tokensIn, tokensOut };
}

/** The in-TUI /resume rule (matchSessions, core/session-ops.ts — the same one `--resume`, `trace`, `export` and the
 *  `sessions` verbs use): a unique match resolves, an AMBIGUOUS prefix must not silently pick one — start fresh (id
 *  undefined) and say so in `warn`. The CLI's `--resume <id>` no longer comes through here: cli/resume.ts refuses an
 *  unknown or ambiguous id before the TUI boots (2026-09-07). */
export function resolveBootSession(sessionsDir: string, id: string | undefined): { id: string | undefined; warn?: string } {
  if (id === undefined) return { id };
  const pre = matchSessions(listSessions(sessionsDir, { includeHollow: true }), id);
  if (pre.length === 1) return { id: pre[0]!.id };
  if (pre.length > 1) return { id: undefined, warn: `"${id}" matches ${pre.length} sessions — started fresh; use /resume to pick one` };
  return { id };
}

export interface SessionCmdCtx {
  renderer: Renderer;
  /** the run's cwd — `/sessions delete` removes the session's checkpoints shadow dir under it (session-manage.ts) */
  cwd: string;
  /** <cwd>/.rovecode/sessions — where listSessions looks */
  sessionsDir: string;
  busy(): boolean;
  /** the ACTIVE session store, read live: /sessions and a root /rewind swap it */
  store(): SessionStore;
  /** rebind the app to session id (store, memory, mode) and replay it; announce defaults on */
  switchSession(id: string, announce?: boolean): void;
  /** re-render the whole transcript from the active session path */
  replayHistory(): void;
  /** recount token usage from the active store */
  refreshUsage(): void;
  pushStatus(): void;
}

/** /rewind (alias /tree) — pick an earlier turn in the overlay; Enter branches the session
 *  to before that turn and prefills the editor with its FULL text for edit-and-resubmit. */
export async function cmdRewind(ctx: SessionCmdCtx): Promise<void> {
  if (ctx.busy()) { ctx.renderer.addSystemNote("finish or interrupt the run first (Esc)", "warn"); return; }
  const points = ctx.store().turnPoints();
  if (points.length === 0) { ctx.renderer.addSystemNote("nothing to rewind — no turns yet"); return; }
  const items = [...points].reverse().map((p) => ({
    value: p.entryId,
    label: `#${p.index} ${p.text}`,
    description: p.branches > 0 ? `◆ ${p.branches} other branch${p.branches > 1 ? "es" : ""}` : undefined,
  }));
  const picked = await ctx.renderer.pickOne(items, "rewind to a turn (Enter = edit & resubmit, Esc = cancel)");
  if (!picked) { ctx.replayHistory(); return; } // cancel: clear the overlay title note
  const point = points.find((p) => p.entryId === picked);
  if (!point) return;
  if (point.parentId === null) {
    // pi resets the leaf to an empty conversation (sessions.md:116); root reset would need
    // core support — v1 approximates it with a fresh session, old one untouched
    ctx.switchSession(randomUUID(), false);
    ctx.renderer.addSystemNote("rewound to the start — fresh session, previous one kept");
  } else {
    if (!ctx.store().branch(point.parentId)) { ctx.renderer.addSystemNote("rewind failed: turn not found", "error"); return; }
    ctx.replayHistory();
    ctx.renderer.addSystemNote(`rewound to before turn #${point.index} — edit and resubmit (branch kept)`);
  }
  ctx.renderer.prefillEditor(point.fullText); // FULL text, never the ≤80-char overlay label
  ctx.pushStatus();
}

/** /sessions — pick a previous session in the overlay; /resume <id> resolves an exact id
 *  or a UNIQUE prefix directly (an ambiguous prefix must not silently pick one). */
export async function cmdSessions(ctx: SessionCmdCtx, directId?: string): Promise<void> {
  if (ctx.busy()) { ctx.renderer.addSystemNote("finish or interrupt the run first (Esc)", "warn"); return; }
  const all = listSessions(ctx.sessionsDir); // the picker: sessions that hold something (hollow dirs stay out of the list)
  if (directId) {
    // the ONE matching rule (core/session-ops.ts): exact id wins outright; a prefix must match exactly ONE session
    // — resolving an ambiguous prefix silently to the first hit resumed the wrong session
    const matches = matchSessions(listSessions(ctx.sessionsDir, { includeHollow: true }), directId);
    if (matches.length === 1) ctx.switchSession(matches[0]!.id);
    else if (matches.length > 1) ctx.renderer.addSystemNote(ambiguityMessage(directId, matches), "warn");
    else ctx.renderer.addSystemNote(`no session matching "${directId}"`, "warn");
    return;
  }
  const items = all.slice(0, 20).map((s) => ({
    value: s.id,
    label: s.title ?? (s.preview || "(empty session)"), // a title stands in for the first prompt, as `rovecode sessions list` does (cli/sessions-cmd.ts) — otherwise /sessions rename is invisible where you resume
    description: `${new Date(s.updatedAt).toLocaleString()} · ${s.entryCount} entries · ${s.id.slice(0, 8)}${s.id === ctx.store().id ? " · current" : ""}`,
  }));
  if (items.length === 0) { ctx.renderer.addSystemNote("no sessions found"); return; }
  const picked = await ctx.renderer.pickOne(items, "resume a session (Esc = cancel)");
  if (picked && picked !== ctx.store().id) ctx.switchSession(picked);
  else if (!picked) ctx.replayHistory(); // cancel: clear the overlay title note
}

/** /new — branch the leaf back to the session's first entry; the old turns stay in the
 *  tree. Synchronous on purpose: no overlay, nothing to await. */
export function cmdNew(ctx: SessionCmdCtx): void {
  // busy gate (same as /rewind //sessions): moving the leaf mid-run would make the
  // run's next append chain off a moved leaf while its parentId points elsewhere
  if (ctx.busy()) { ctx.renderer.addSystemNote("finish or interrupt the run first (Esc)", "warn"); return; }
  const store = ctx.store();
  if (store.branch(store.messages()[0]?.id ?? "")) {
    ctx.replayHistory(); ctx.refreshUsage(); ctx.pushStatus();
    ctx.renderer.addSystemNote("branched to session start");
  } else ctx.renderer.addSystemNote("nothing to branch — no turns yet");
}
