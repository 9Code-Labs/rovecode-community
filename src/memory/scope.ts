/** Memory scoping: WHERE a remembered fact lands, and the one-time move of the old per-session store.
 *
 *  Until 2026-09-07 both blocks were built over ONE directory, `<cwd>/.rovecode/sessions/<id>/memory`, which got
 *  two things wrong at once. Every fact died with the session id — a new session is a new uuid directory and
 *  nothing carried anything forward — and the USER block, whose entire purpose is preferences that follow the
 *  person from project to project, was written INSIDE the repository. A private preference in someone's checkout
 *  is the wrong file in the wrong place; that is what this module fixes.
 *
 *    MEMORY → `<cwd>/.rovecode/memory/MEMORY.md`  — this project, shared by every session in it (two sessions in
 *             the same checkout see the same facts; the ledger's optimistic concurrency serialises their edits)
 *    USER   → `<ROVECODE_HOME | ~/.rovecode>/memory/USER.md` — the person, across every project, never in a repo
 *
 *  A note with NO scope goes to MEMORY: an unscoped project fact landing in the user file could carry something
 *  private out of one project and into every other, while the reverse is only a nuisance. `#<text>` and
 *  `/memory <text>` append to MEMORY; `/memory --user <text>` is the only composer path to USER; the memory_edit
 *  tool has no default at all (`block` is a required enum).
 *
 *  LEGACY (the pre-2026-09-07 layout): `<sessions>/<id>/memory/`. Processed ONCE per legacy store — when a block's
 *  scoped target has never been used (neither its file nor its `.versions.jsonl` sidecar exists) the legacy file
 *  and sidecar are copied forward, history intact, BEFORE the BlockStore takes its boot snapshot, so a resumed
 *  session keeps its memory in the prompt. A target already in use is never overwritten; the block is reported as
 *  skipped. NOTHING OF THE USER'S IS EVER DELETED: the legacy files stay exactly where they are, and a small
 *  marker beside them records the outcome so the copy and its note happen once and are said once.
 *
 *  TRUST: `<cwd>/.rovecode/memory/MEMORY.md` is repo data — committable, and it goes into the system prompt — so a
 *  cloned repository could put text of its choosing in front of the model. The gate is core/trust.ts, the same
 *  digest store as project mcp.json and hooks.ts, with one adaptation that matters: a plain digest gate over a file
 *  that changes on every note would re-ask constantly and be switched off within a day, so the store SELF-TRUSTS
 *  the file after a write it performed itself (the `mcp add --project` precedent — what we wrote, we vouch for).
 *  Narrowly: only a write that actually landed through this store, never "the file looks close enough". A MEMORY.md
 *  that arrived from a clone or a hand-edit is READ but WITHHELD from the prompt with one boot note, and writes to
 *  it are REFUSED (memory/blocks.ts capCheck) — appending our own note to a stranger's file would launder its
 *  content into the next prompt. `rovecode trust` accepts it, exactly as for the other project files. The USER
 *  block lives in the user's own home and is never gated. */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isTrustedFile, trustFile, untrustedFileNote } from "../core/trust.ts";
import { rovecodeHome } from "../providers/auth.ts";
import { LEDGER_SUFFIX } from "../skills/versioned.ts";
import { BLOCK_FILES, BlockStore, cutAtCap, defaultCaps, type BlockCaps, type BlockDirs, type BlockName, type BlockStoreOptions } from "./blocks.ts";

/** the memory sub-directory of a scope's state dir */
export const MEMORY_DIR = "memory";
/** written beside a legacy store's files once it has been processed (copied or skipped) — the "once" of the header */
export const LEGACY_MARKER = ".copied-forward.json";
/** an over-cap legacy block is copied cut to this share of the cap, so the migrated store can still take a note */
export const LEGACY_CUT_RATIO = 0.9;
const BLOCKS: readonly BlockName[] = ["memory", "user"];

/** `<cwd>/.rovecode/memory` — the MEMORY block's home for this project */
export function projectMemoryDir(cwd: string): string { return join(cwd, ".rovecode", MEMORY_DIR); }
/** `<ROVECODE_HOME | ~/.rovecode>/memory` — the USER block's home, the same home providers.json and plugins.json use */
export function userMemoryDir(home: string = rovecodeHome()): string { return join(home, MEMORY_DIR); }
/** the pre-2026-09-07 per-session store: `<sessions>/<id>/memory` */
export function legacySessionMemoryDir(sessionsDir: string, sessionId: string): string { return join(sessionsDir, sessionId, MEMORY_DIR); }
/** the scoped directories a runtime's BlockStore is built over */
export function scopedBlockDirs(cwd: string, home?: string): BlockDirs {
  return { memory: projectMemoryDir(cwd), user: userMemoryDir(home) };
}

/** true when `block` has never been written under `dir`: neither its file nor its ledger sidecar exists */
export function blockUnused(dir: string, block: BlockName): boolean {
  const file = join(dir, BLOCK_FILES[block]);
  return !existsSync(file) && !existsSync(file + LEDGER_SUFFIX);
}

export interface MigrationResult {
  /** the legacy store that was read */
  from: string;
  /** blocks copied forward (file + sidecar when present) */
  copied: BlockName[];
  /** blocks the legacy store had but whose scoped target is already in use — left alone */
  skipped: BlockName[];
  /** copied blocks whose legacy file was over the block cap: the copy is cut at the cap (present only when non-empty) */
  cut?: BlockName[];
}

/** Copy a legacy `<session>/memory` store forward into the scoped dirs, block by block, only where the target is
 *  unused (header rules), then leave the marker. The legacy files are never modified or removed. null when the
 *  legacy dir holds no block file (nothing to migrate) or was processed before — the caller stays silent in both. */
export function migrateLegacyMemory(legacyDir: string, dirs: BlockDirs, caps: BlockCaps = defaultCaps): MigrationResult | null {
  if (existsSync(join(legacyDir, LEGACY_MARKER))) return null;
  const result: MigrationResult = { from: legacyDir, copied: [], skipped: [] };
  const cut: BlockName[] = [];
  for (const block of BLOCKS) {
    const src = join(legacyDir, BLOCK_FILES[block]);
    if (!existsSync(src)) continue;
    if (!blockUnused(dirs[block], block)) { result.skipped.push(block); continue; }
    mkdirSync(dirs[block], { recursive: true });
    const text = readFileSync(src, "utf8");
    // over the cap: the copy is cut to LEGACY_CUT_RATIO of the cap (line boundary) so the store has room for notes
    // — the legacy file keeps the whole text, because nothing of the user's is deleted by a migration
    if (text.length > caps[block]) { writeFileSync(join(dirs[block], BLOCK_FILES[block]), cutAtCap(text, Math.floor(caps[block] * LEGACY_CUT_RATIO))); cut.push(block); }
    else copyFileSync(src, join(dirs[block], BLOCK_FILES[block]));
    if (existsSync(src + LEDGER_SUFFIX)) copyFileSync(src + LEDGER_SUFFIX, join(dirs[block], BLOCK_FILES[block] + LEDGER_SUFFIX));
    result.copied.push(block);
  }
  if (result.copied.length + result.skipped.length === 0) return null;
  if (cut.length > 0) result.cut = cut;
  writeFileSync(join(legacyDir, LEGACY_MARKER), JSON.stringify({ at: new Date().toISOString(), copied: result.copied, skipped: result.skipped, cut }) + "\n");
  return result;
}

/** The transcript note for a processed legacy store; null when there was nothing to process (or it was processed
 *  before). A pure skip — every block's target already in use — says so once instead of dropping silently. */
export function migrationNote(r: MigrationResult | null, dirs: BlockDirs): string | null {
  if (!r) return null;
  const files = (blocks: readonly BlockName[]): string => blocks.map((b) => BLOCK_FILES[b]).join(", ");
  if (r.copied.length === 0) {
    return `memory: legacy per-session store ${r.from} not copied — ${files(r.skipped)} already ${r.skipped.length === 1 ? "has" : "have"} content in the scoped store (/memory shows it; the legacy files are still there if you need the text — this note shows once)`;
  }
  const copied = r.copied.map((b) => `${BLOCK_FILES[b]} → ${dirs[b]}`).join(", ");
  const cut = r.cut && r.cut.length > 0 ? ` (${files(r.cut)} cut to fit the block cap — the legacy file keeps the whole text)` : "";
  const skipped = r.skipped.length > 0 ? `; ${files(r.skipped)} not copied — the scoped store already has content` : "";
  return `memory: copied ${copied} forward from the legacy per-session store ${r.from} (left in place; in the prompt from this run on)${cut}${skipped}`;
}

/** The copy-forward is OUR OWN write of the user's own file, so the file it produces is trusted at the moment it is
 *  written — exactly like a note we append. Without this, migrating a legacy store would hand the person a MEMORY.md
 *  that this machine then refused to put in the prompt, which is the opposite of what the migration is for. */
function trustMigrated(r: MigrationResult | null, dirs: BlockDirs, home: string): void {
  if (r?.copied.includes("memory")) trustFile(home, join(dirs.memory, BLOCK_FILES.memory));
}

/** The store options for `cwd`: withhold a project MEMORY.md this machine has not approved, and keep the digest
 *  current for the writes we perform ourselves (header — the narrow self-trust). A MEMORY.md that does not exist
 *  yet is not withheld: the first note creates it, and creating it is our own write. */
export function scopedStoreOptions(cwd: string, home: string = rovecodeHome()): BlockStoreOptions {
  const file = join(projectMemoryDir(cwd), BLOCK_FILES.memory);
  const withhold: BlockName[] = existsSync(file) && !isTrustedFile(home, file) ? ["memory"] : [];
  return {
    ...(withhold.length > 0 ? { withhold } : {}),
    // only the project block needs a digest: USER.md lives in the user's own home and is never gated
    onCommit: (block, path) => { if (block === "memory") trustFile(home, path); },
  };
}

/** The boot notes about the store itself: a withheld project block, a block over its cap. */
export function storeNotes(blocks: BlockStore, cwd: string): string[] {
  const notes: string[] = [];
  void cwd;
  for (const b of BLOCKS) {
    if (blocks.isWithheld(b)) {
      notes.push(untrustedFileNote(blocks.path(b), "it is not in the prompt and cannot be written to (it came with this repository, and a repo file would be choosing what the model reads); /memory still shows it"));
    }
    const over = blocks.overCap(b);
    if (over) notes.push(`memory: ${blocks.path(b)} holds ${over.readCut ? "more than the read cap" : `${over.chars} chars`} — over the ${over.cap}-char cap; the prompt shows the first ${over.cap} and memory_edit is refused until the file is trimmed`);
  }
  return notes;
}

export interface ScopedMemory {
  blocks: BlockStore;
  /** the boot notes for the surface's transcript (the one-time copy-forward, a withheld or over-cap block), else null */
  note: string | null;
}

/** Build the runtime's BlockStore over the scoped dirs AFTER the one-time legacy copy for `sessionId`, so the boot
 *  snapshot already carries a resumed session's migrated memory. */
export function openScopedMemory(d: { cwd: string; sessionsDir: string; sessionId: string; home?: string }): ScopedMemory {
  const home = d.home ?? rovecodeHome();
  const dirs = scopedBlockDirs(d.cwd, home);
  const migrated = migrateLegacyMemory(legacySessionMemoryDir(d.sessionsDir, d.sessionId), dirs);
  trustMigrated(migrated, dirs, home); // before the store reads: what we just copied is ours, not the repo's
  const migration = migrationNote(migrated, dirs);
  const blocks = new BlockStore(dirs, defaultCaps, scopedStoreOptions(d.cwd, home));
  const notes = [...(migration ? [migration] : []), ...storeNotes(blocks, d.cwd)];
  return { blocks, note: notes.length > 0 ? notes.join("\n") : null };
}

/** TUI session switch (tui/app.ts): memory is project-scoped, so the store STAYS — unless the switched-to session
 *  carries a legacy store that copies forward, in which case a FRESH BlockStore is handed back so the migrated text
 *  is in the prompt now rather than only next run. A pure-skip note returns without a new store. */
export function adoptLegacyMemory(cwd: string, sessionsDir: string, sessionId: string, home: string = rovecodeHome()): { blocks?: BlockStore; note: string | null } {
  const dirs = scopedBlockDirs(cwd, home);
  const r = migrateLegacyMemory(legacySessionMemoryDir(sessionsDir, sessionId), dirs);
  trustMigrated(r, dirs, home);
  const note = migrationNote(r, dirs);
  if (r && r.copied.length > 0) return { blocks: new BlockStore(dirs, defaultCaps, scopedStoreOptions(cwd, home)), note };
  return { note };
}
