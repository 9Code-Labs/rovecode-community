/** TUI session navigation (port #2 session tree), extracted from app.ts for the ADR-002
 *  cap: /sessions + /resume pick or resolve a session to switch to, /rewind (alias /tree)
 *  jumps to an earlier turn for edit-and-resubmit, /new branches back to the session
 *  start. The CALLER owns the swappable store and the rebind routine (switchSession), so
 *  store reads and switches run through the injected ctx — same shape as checkpoints-cmd. */

import { listSessions, type SessionStore } from "../core/session.ts";
import type { Renderer } from "./renderer.ts";
import { randomUUID } from "node:crypto";

export interface SessionCmdCtx {
  renderer: Renderer;
  /** <cwd>/.aion/sessions — where listSessions looks */
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
  const all = listSessions(ctx.sessionsDir);
  if (directId) {
    // exact id wins outright; a prefix must match exactly ONE session — resolving an
    // ambiguous prefix silently to the first hit resumed the wrong session
    const exact = all.find((s) => s.id === directId);
    const matches = exact ? [exact] : all.filter((s) => s.id.startsWith(directId));
    if (matches.length === 1) ctx.switchSession(matches[0]!.id);
    else if (matches.length > 1) ctx.renderer.addSystemNote(
      `"${directId}" matches ${matches.length} sessions: ${matches.slice(0, 4).map((s) => s.id.slice(0, 8)).join(", ")}${matches.length > 4 ? ", …" : ""} — be more specific`,
      "warn",
    );
    else ctx.renderer.addSystemNote(`no session matching "${directId}"`, "warn");
    return;
  }
  const items = all.slice(0, 20).map((s) => ({
    value: s.id,
    label: s.preview || "(empty session)",
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
