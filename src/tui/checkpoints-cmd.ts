/** TUI surface for shadow-git checkpoints (port #11, cline): /checkpoints lists the
 *  session's snapshots in a pickOne overlay; /restore <ref> [files|conversation|both]
 *  replays cline's three restore modes. Conversation/both restores branch the session
 *  tree to the checkpoint's recorded entryId (port #2 leaf machinery) — the CALLER
 *  owns the store, so branching + replay run through the injected ctx. */

import type { RestoreMode } from "../coding/checkpoints.ts";
import type { Checkpoints } from "../coding/checkpoints.ts";
import type { Renderer } from "./renderer.ts";

export interface CheckpointCmdCtx {
  renderer: Renderer;
  busy(): boolean;
  /** active session id (checkpoints are per-session) */
  sessionId(): string;
  checkpointsFor(sessionId: string): Promise<Checkpoints | null>;
  /** branch the ACTIVE session store to entryId; false when the entry is unknown */
  branchTo(entryId: string): boolean;
  /** re-render transcript + usage after a conversation restore */
  replayAndRefresh(): void;
}

const MODES: readonly RestoreMode[] = ["files", "conversation", "both"];

/** /checkpoints — list snapshots newest-first in the overlay; picking one prefills nothing
 *  and just prints the /restore hint (restore is deliberately an explicit second step). */
export async function cmdCheckpoints(ctx: CheckpointCmdCtx): Promise<void> {
  if (ctx.busy()) { ctx.renderer.addSystemNote("finish or interrupt the run first (Esc)", "warn"); return; }
  const cp = await ctx.checkpointsFor(ctx.sessionId());
  if (!cp) { ctx.renderer.addSystemNote("checkpoints unavailable (git missing or ROVECODE_NO_CHECKPOINTS=1)", "warn"); return; }
  const log = cp.list();
  if (log.length === 0) { ctx.renderer.addSystemNote("no checkpoints yet — snapshots land after each mutating tool call"); return; }
  const items = [...log].reverse().slice(0, 20).map((c, i) => ({
    value: c.hash,
    label: `#${log.length - i} ${c.label} · ${c.hash.slice(0, 8)}`,
    description: `${new Date(c.createdAt).toLocaleString()}${c.entryId ? " · conversation anchor" : ""}`,
  }));
  const picked = await ctx.renderer.pickOne(items, "checkpoints (Enter = show restore hint, Esc = close)");
  ctx.replayAndRefresh(); // clear the overlay title note
  if (picked) ctx.renderer.addSystemNote(`restore with: /restore ${picked.slice(0, 8)} [files|conversation|both]`);
}

/** /restore <hash-prefix> [mode] — files (workspace only), conversation (session branch
 *  only), or both. Cline's three modes, checkpoint-restore semantics. */
export async function cmdRestore(ctx: CheckpointCmdCtx, arg: string): Promise<void> {
  if (ctx.busy()) { ctx.renderer.addSystemNote("finish or interrupt the run first (Esc)", "warn"); return; }
  const [ref, modeArg] = arg.split(/\s+/);
  if (!ref) { ctx.renderer.addSystemNote("usage: /restore <checkpoint> [files|conversation|both] — list with /checkpoints", "warn"); return; }
  const mode = (modeArg || "files") as RestoreMode;
  if (!MODES.includes(mode)) { ctx.renderer.addSystemNote(`unknown restore mode "${modeArg}" (files|conversation|both)`, "warn"); return; }
  const cp = await ctx.checkpointsFor(ctx.sessionId());
  if (!cp) { ctx.renderer.addSystemNote("checkpoints unavailable (git missing or ROVECODE_NO_CHECKPOINTS=1)", "warn"); return; }
  // dedupe candidates BY HASH (identical content re-snapshotted shares one): counting
  // entries made even the full 40-char hash "match 2 checkpoints" forever. Latest entry
  // per hash wins, mirroring the module's own pick.
  const match = [...new Map(cp.list().filter((c) => c.hash.startsWith(ref)).map((c) => [c.hash, c])).values()];
  if (match.length !== 1) {
    ctx.renderer.addSystemNote(match.length === 0 ? `no checkpoint matching "${ref}"` : `"${ref}" matches ${match.length} checkpoints — be more specific`, "warn");
    return;
  }
  const res = await cp.restore(match[0]!.hash, mode);
  if (!res.ok) { ctx.renderer.addSystemNote(`restore failed: ${res.error}`, "error"); return; }
  let convNote = "";
  if (mode === "conversation" || mode === "both") {
    if (res.entryId && ctx.branchTo(res.entryId)) { ctx.replayAndRefresh(); convNote = " · conversation branched to the checkpoint's turn"; }
    else convNote = " · conversation anchor unavailable in this session tree (files unaffected by that)";
  }
  const fileNote = mode === "conversation" ? "" : "workspace rolled back";
  ctx.renderer.addSystemNote(`restored ${res.checkpoint.hash.slice(0, 8)} (${mode}) — ${fileNote}${convNote}; snapshots keep history`);
}
