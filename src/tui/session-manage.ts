/** TUI `/sessions <verb>` (aion port #84): rename · delete · fork · search over core/session-ops.ts — the same ops as
 *  the headless `rovecode sessions …` (cli/sessions-cmd.ts, 5ceb21e), through the SessionCmdCtx seam app.ts already hands
 *  the session navigator (session-cmd.ts), so the classic and sextant surfaces share it via app.ts handleSlash. Rules:
 *   - every verb sits behind the /rewind busy gate (moving or removing session state mid-run is refused);
 *   - `rename <title…>` titles the CURRENT session through the LIVE store instance (`ctx.store().patchMeta`) — a second
 *     SessionStore on the same dir would be clobbered by this instance's next persistLeaf (/new, /rewind);
 *   - `delete <id|prefix>` resolves first, shows ONE askApproval card (deny → nothing removed); deleting the ACTIVE
 *     session switches the app to a fresh session first (the root-rewind pattern of session-cmd.ts cmdRewind) so no
 *     live store points at a removed dir; then session-ops.deleteSession removes the dir AND its checkpoints shadow
 *     repo — a half-delete leaves the space used with nothing pointing at it, so the test pins the shadow dir too;
 *   - `fork [<id|prefix>]` (default: the current session) forks and switches to the fork (announced, transcript replayed);
 *   - `search <terms…>` opens pickOne over the hits (label = preview, description = title · id8 · time); Enter switches
 *     to the hit's session, Esc replays the current transcript (the /sessions picker's cancel rule).
 *  Bare `/sessions` stays the picker (cmdSessions). `--plain` has none of this (README honesty). Pattern sources: see
 *  core/session-ops.ts (opencode MIT session.ts fork / remove / setTitle; codex Apache-2.0 DeleteConfirmation, pattern only). */

import { randomUUID } from "node:crypto";
import { deleteSession, forkSession, oneLineTitle, resolveSession, searchSessions } from "../core/session-ops.ts";
import { cmdSessions, type SessionCmdCtx } from "./session-cmd.ts";

const BUSY = "finish or interrupt the run first (Esc)";
const USAGE = "/sessions rename <title…> | delete <id|prefix> | fork [<id|prefix>] | search <terms…>";

/** app.ts `case "sessions"`: `arg` is the collapsed remainder after `/sessions` */
export async function cmdSessionsVerb(ctx: SessionCmdCtx, arg: string): Promise<void> {
  const [verb, ...rest] = arg.split(/\s+/).filter(Boolean);
  if (verb === undefined) return cmdSessions(ctx); // bare /sessions: the picker, unchanged (it carries its own busy gate)
  if (ctx.busy()) { ctx.renderer.addSystemNote(BUSY, "warn"); return; }
  switch (verb) {
    case "rename": return rename(ctx, rest.join(" "));
    case "delete": return remove(ctx, rest[0]);
    case "fork": return fork(ctx, rest[0]);
    case "search": return search(ctx, rest.join(" "));
    default: ctx.renderer.addSystemNote(`unknown /sessions verb "${verb}" — ${USAGE}`, "warn");
  }
}

function rename(ctx: SessionCmdCtx, raw: string): void {
  const title = oneLineTitle(raw);
  if (title === undefined) { ctx.renderer.addSystemNote("usage: /sessions rename <title…>", "warn"); return; }
  const store = ctx.store(); // the LIVE instance — its later persistLeaf carries the title forward
  store.patchMeta({ title });
  ctx.renderer.addSystemNote(`session ${store.id.slice(0, 8)} titled "${title}"`);
}

async function remove(ctx: SessionCmdCtx, ref: string | undefined): Promise<void> {
  if (ref === undefined) { ctx.renderer.addSystemNote("usage: /sessions delete <id|prefix>", "warn"); return; }
  const found = resolveSession(ctx.sessionsDir, ref);
  if (!found.ok) { ctx.renderer.addSystemNote(found.error, "warn"); return; }
  const s = found.summary;
  const active = found.id === ctx.store().id;
  const label = s.title ?? (s.preview || "(empty session)");
  const answer = await ctx.renderer.askApproval(
    "sessions delete",
    `${s.id.slice(0, 8)} · ${label} · ${s.entryCount} entries${active ? " · the current session" : ""}`,
    "removes the session directory (entries, meta, attachments, todos) and its checkpoints shadow repo — not undoable",
  );
  if (answer === "deny") { ctx.renderer.addSystemNote("delete cancelled — nothing removed", "warn"); return; }
  if (active) {
    // the root-rewind pattern (session-cmd.ts cmdRewind): the app moves to a fresh session BEFORE the old dir goes
    ctx.switchSession(randomUUID(), false);
    ctx.renderer.addSystemNote("deleting the active session — switched to a fresh one first");
  }
  const { removed } = deleteSession(ctx.cwd, ctx.sessionsDir, found.id);
  ctx.renderer.addSystemNote(`deleted session ${found.id.slice(0, 8)} (${removed.length} path${removed.length === 1 ? "" : "s"} removed)`);
}

function fork(ctx: SessionCmdCtx, ref: string | undefined): void {
  const found = resolveSession(ctx.sessionsDir, ref ?? ctx.store().id);
  if (!found.ok) { ctx.renderer.addSystemNote(found.error, "warn"); return; }
  let r: { id: string; from: string; title: string };
  try { r = forkSession(ctx.sessionsDir, found.summary); }
  catch (e) { ctx.renderer.addSystemNote(e instanceof Error ? e.message : String(e), "warn"); return; } // over FORK_MAX_ATTACHMENT_BYTES
  ctx.switchSession(r.id); // rebinds store / memory / mode / checkpoints, replays the copied transcript, announces
  ctx.renderer.addSystemNote(`forked ${r.from.slice(0, 8)} → ${r.id.slice(0, 8)} "${r.title}"`);
}

async function search(ctx: SessionCmdCtx, raw: string): Promise<void> {
  const query = raw.trim();
  if (query === "") { ctx.renderer.addSystemNote("usage: /sessions search <terms…>", "warn"); return; }
  const rows = searchSessions(ctx.sessionsDir, query, 10);
  if (rows.length === 0) { ctx.renderer.addSystemNote(`no matches for "${query}"`); return; }
  const current = ctx.store().id;
  const items = rows.map((r, i) => ({
    value: String(i), // several hits may share a session: the index is the unique pick value
    label: r.preview || r.title || "(empty session)",
    description: `${r.title !== undefined ? `${r.title} · ` : ""}${r.sessionId.slice(0, 8)}${r.sessionId === current ? " · current" : ""} · ${new Date(r.timestamp).toLocaleString()}`,
  }));
  const picked = await ctx.renderer.pickOne(items, "search hits (Enter = resume, Esc = cancel)");
  if (picked === null) { ctx.replayHistory(); return; } // cancel: clear the overlay title note
  const row = rows[Number(picked)];
  if (row === undefined) return;
  if (row.sessionId === current) { ctx.renderer.addSystemNote("that hit is in the current session"); return; }
  ctx.switchSession(row.sessionId);
}
