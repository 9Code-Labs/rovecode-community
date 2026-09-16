/** Bounded markdown memory blocks (hermes pattern): MEMORY.md + USER.md with hard char caps.
 *  The snapshot is frozen at boot (constructor) so the system prompt stays cache-stable and
 *  byte-identical across the turns of a run; tools mutate live state + disk only — an edit is in the
 *  prompt from the NEXT run. A threat-scan neutralizes injection lines in the rendered view — raw text
 *  on disk is never rewritten by the scan.
 *
 *  Scoping (2026-09-07): the two blocks may live in DIFFERENT directories (`BlockDirs` — MEMORY under
 *  the project's .rovecode, USER under the user home; memory/scope.ts resolves them), because a USER
 *  block written inside a repository is the wrong file in the wrong place. A plain string keeps both in
 *  one dir. Directories are created lazily by the first commit (the ledger's write), so constructing a
 *  store over the user scope never touches the home directory.
 *
 *  A block file is REPO DATA — `<cwd>/.rovecode/memory/MEMORY.md` is committable — so the boot read is
 *  bounded twice: at most READ_CAP_BYTES are read from disk (a longer file marks the block read-cut and
 *  every commit/rollback is refused — the store never rewrites a file it could not read whole), and the
 *  PROMPT view is cut at the block's char cap (line boundary) behind a visible `[truncated: …]` marker,
 *  so the prompt cannot balloon whatever the file holds; the live text (/memory, the tools) is what was
 *  read. A block may also be WITHHELD (`BlockStoreOptions.withhold`): read as usual, kept out of the
 *  prompt — memory/scope.ts withholds a project MEMORY block this machine has not approved. */

import { closeSync, existsSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { TRUST_HINT } from "../core/trust.ts";
import { VersionLedger } from "../skills/versioned.ts";

export type BlockName = "memory" | "user";

/** the directory each block's file (+ its `.versions.jsonl` ledger sidecar) lives in */
export type BlockDirs = Record<BlockName, string>;

/** the block file names — the ONE place that spells them (memory/scope.ts copies them by these names) */
export const BLOCK_FILES: Readonly<Record<BlockName, string>> = { memory: "MEMORY.md", user: "USER.md" };

export interface BlockCaps { memory: number; user: number }

export const defaultCaps: BlockCaps = { memory: 2_200, user: 1_375 };

/** the most a block file is read at boot (bytes); past it the block is read-cut: shown cut, never rewritten */
export const READ_CAP_BYTES = 64 * 1024;

export interface BlockStoreOptions {
  /** blocks read from disk but KEPT OUT of the prompt (a project MEMORY block this machine has not
   *  approved); live text and /memory see them as usual, and every WRITE to them is refused — appending
   *  our own note to a stranger's file would launder its content into the next prompt */
  withhold?: readonly BlockName[];
  /** called after a write THIS store performed landed on disk (commit or rollback), with the block and its
   *  file. memory/scope.ts uses it to keep the project block's trust digest current: the narrow self-trust —
   *  a file we just wrote, never "the file looks close enough". Never called for a refused write. */
  onCommit?: (block: BlockName, file: string) => void;
}

export interface BlockEditResult {
  ok: boolean;
  reason?: string;
  /** present on cap failures: current chars / cap */
  current?: number;
  limit?: number;
  /** present on version conflicts: ledger numbers for logs/data surfaces only —
   *  the model-facing `reason` stays generic (ouroboros: no ledger internals). */
  conflict?: { baseVersion: number; currentVersion: number };
}

/** Model-facing conflict reason — deliberately free of ledger internals. */
export const CONFLICT_REASON = "memory changed since it was read — re-read and retry";

const THREAT = /(?:ignore previous|disregard above|system prompt)/i;

function scan(text: string): string {
  return text.split("\n").map((l) => (THREAT.test(l) ? "[BLOCKED]" : l)).join("\n");
}

/** `text` cut to at most `cap` chars at a line boundary (a hard cut when the last newline sits in the first half) */
export function cutAtCap(text: string, cap: number): string {
  if (text.length <= cap) return text;
  let cut = text.lastIndexOf("\n", cap);
  if (cut < cap / 2) cut = cap;
  return text.slice(0, cut);
}

/** at most `cap + 1` bytes of `p` (existence checked by the caller): the text and whether the file went on past the cap */
function readBounded(p: string, cap: number): { text: string; cut: boolean } {
  const fd = openSync(p, "r");
  try {
    const buf = Buffer.alloc(cap + 1);
    let n = 0;
    while (n < buf.length) { const got = readSync(fd, buf, n, buf.length - n, n); if (got <= 0) break; n += got; }
    return { text: buf.subarray(0, Math.min(n, cap)).toString("utf8"), cut: n > cap };
  } finally { closeSync(fd); }
}

function occurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  let i = 0;
  while ((i = haystack.indexOf(needle, i)) !== -1) { n++; i += needle.length; }
  return n;
}

export class BlockStore {
  private live: Record<BlockName, string> = { memory: "", user: "" };
  private readonly frozen: Record<BlockName, string>;
  /** port #16: versioned edits — every commit lands through a sidecar ledger
   *  (<file>.versions.jsonl), enabling one-call rollback + drift detection. */
  private readonly ledgers: Record<BlockName, VersionLedger>;
  /** Optimistic-concurrency baseline (prime baselineState, refinement.ts:735-749):
   *  the version THIS store last saw. Passing ledger.version() to commit would
   *  compare the guard to itself and silently drop a concurrent store's edit. */
  private readonly baseVersions: Record<BlockName, number>;

  private readonly dirs: BlockDirs;
  /** the block's file went on past READ_CAP_BYTES at boot — shown cut, never rewritten */
  private readonly readCut: Record<BlockName, boolean> = { memory: false, user: false };
  private readonly withheld: ReadonlySet<BlockName>;
  private readonly onCommit: ((block: BlockName, file: string) => void) | undefined;

  /** `dir`: one directory for both blocks, or a per-block map (the scoped layout). Nothing is created here. */
  constructor(
    dir: string | BlockDirs,
    private readonly caps: BlockCaps = defaultCaps,
    opts: BlockStoreOptions = {},
  ) {
    // no mkdir here: reads tolerate a missing directory and the ledger creates it on the first commit
    // (skills/versioned.ts). Creating `<session>/memory` at construction was what made every session
    // directory non-empty before anyone had said anything (core/session.ts materialize()).
    this.dirs = typeof dir === "string" ? { memory: dir, user: dir } : { memory: dir.memory, user: dir.user };
    this.withheld = new Set(opts.withhold ?? []);
    this.onCommit = opts.onCommit;
    this.live.memory = this.read("memory");
    this.live.user = this.read("user");
    // snapshot is the threat-scanned view of what boot loaded
    this.frozen = { memory: scan(this.live.memory), user: scan(this.live.user) };
    this.ledgers = {
      memory: new VersionLedger(this.file("memory")),
      user: new VersionLedger(this.file("user")),
    };
    this.baseVersions = { memory: this.ledgers.memory.version(), user: this.ledgers.user.version() };
  }

  /** the bounded boot read (header): at most READ_CAP_BYTES; a longer file marks the block read-cut */
  private read(block: BlockName): string {
    const p = this.file(block);
    if (!existsSync(p)) return "";
    const r = readBounded(p, READ_CAP_BYTES);
    this.readCut[block] = r.cut;
    return r.text;
  }

  private file(block: BlockName): string {
    return join(this.dirs[block], BLOCK_FILES[block]);
  }

  /** the block's file path (where edits land) — for notes, /memory and tests. */
  path(block: BlockName): string { return this.file(block); }

  add(block: BlockName, text: string): BlockEditResult {
    const t = text.trim();
    if (!t) return { ok: false, reason: "empty text" };
    const next = this.live[block] ? this.live[block] + "\n" + t : t;
    return this.commit(block, next);
  }

  replace(block: BlockName, oldText: string, newText: string): BlockEditResult {
    const found = this.locate(block, oldText);
    if (!found.ok) return found;
    const t = newText.trim();
    const next = t ? this.live[block].replace(oldText, t) : this.live[block].replace(oldText, "");
    return this.commit(block, next.trim());
  }

  remove(block: BlockName, oldText: string): BlockEditResult {
    const found = this.locate(block, oldText);
    if (!found.ok) return found;
    const next = this.live[block].replace(oldText, "").replace(/\n{3,}/g, "\n\n").trim();
    return this.commit(block, next);
  }

  /** oldText must match exactly once: 0 → not found, >1 → ambiguous. */
  private locate(block: BlockName, oldText: string): BlockEditResult {
    if (!oldText) return { ok: false, reason: "oldText required" };
    const n = occurrences(this.live[block], oldText);
    if (n === 0) return { ok: false, reason: "oldText not found" };
    if (n > 1) return { ok: false, reason: `oldText matches ${n} times; must match exactly once` };
    return { ok: true };
  }

  /** Char-cap guard shared by commit() and rollback(); runs BEFORE any ledger write. A read-cut block
   *  (header) refuses every write: the store never rewrites a file it could not read whole. */
  private capCheck(block: BlockName, next: string): BlockEditResult | null {
    const limit = this.caps[block];
    if (this.withheld.has(block)) {
      return { ok: false, reason: `${BLOCK_FILES[block]} came with this repository and is not approved on this machine — it is not in the prompt and cannot be written to (${TRUST_HINT})`, current: this.live[block].length, limit };
    }
    if (this.readCut[block]) {
      return { ok: false, reason: `${BLOCK_FILES[block]} on disk is longer than the ${READ_CAP_BYTES}-byte read cap — trim it by hand before editing`, current: this.live[block].length, limit };
    }
    if (next.length <= limit) return null;
    return {
      ok: false, reason: `block would exceed cap (${next.length} > ${limit} chars)`,
      current: this.live[block].length, limit,
    };
  }

  private commit(block: BlockName, next: string): BlockEditResult {
    const capped = this.capCheck(block, next);
    if (capped) return capped;
    // ledger-first write (port #16): version record appended, then the target
    // is written atomically by the ledger — never writeFileSync directly. The
    // baseline is what THIS store last saw, so a concurrent store's commit is
    // caught here instead of being silently overwritten.
    const r = this.ledgers[block].commit(next, "memory_edit", this.baseVersions[block]);
    if (!r.ok) {
      // conflict: another store/process advanced the block. Re-read reality so
      // the next edit builds on the merged state; the reason stays generic —
      // ledger numbers ride the structured field only.
      this.live[block] = this.ledgers[block].read();
      this.baseVersions[block] = r.currentVersion;
      return {
        ok: false, reason: CONFLICT_REASON,
        conflict: { baseVersion: r.baseVersion, currentVersion: r.currentVersion },
      };
    }
    this.baseVersions[block] = r.edit.version;
    this.live[block] = next;
    this.onCommit?.(block, this.file(block)); // the write landed and it was ours (memory/scope.ts self-trust)
    return { ok: true, current: next.length, limit: this.caps[block] };
  }

  /** port #16: one-call rollback of a block to any retained version.
   *  Restored content re-enters through the same cap guard as commits. */
  rollback(block: BlockName, toVersion: number): BlockEditResult {
    const restored = this.ledgers[block].contentAt(toVersion);
    const capped = restored !== undefined ? this.capCheck(block, restored) : null;
    if (capped) return capped;
    const r = this.ledgers[block].rollback(toVersion, "memory_rollback");
    if (!r.ok) return { ok: false, reason: r.message };
    this.baseVersions[block] = r.edit.version;
    this.live[block] = this.ledgers[block].read();
    this.onCommit?.(block, this.file(block)); // a rollback rewrites the file too — same self-trust
    return { ok: true, current: this.live[block].length, limit: this.caps[block] };
  }

  /** port #16: version history access for status/debug surfaces. */
  ledger(block: BlockName): VersionLedger { return this.ledgers[block]; }

  /** the prompt text of one block: the boot snapshot, cut at the block's cap (header) behind a visible marker */
  private promptView(block: BlockName): string {
    const text = this.frozen[block], cap = this.caps[block];
    if (text.length <= cap && !this.readCut[block]) return text;
    const size = this.readCut[block] ? `more than ${READ_CAP_BYTES} bytes` : `${this.live[block].length} chars`;
    return `${cutAtCap(text, cap)}\n[truncated: ${BLOCK_FILES[block]} holds ${size}; the first ${cap} chars are shown — trim the file]`;
  }

  /** Boot snapshot (threat-scanned, cut at the cap; withheld blocks absent). Tool writes never change it. */
  renderForPrompt(): string {
    const parts: string[] = [];
    if (this.frozen.memory && !this.withheld.has("memory")) parts.push(`# Memory\n${this.promptView("memory")}`);
    if (this.frozen.user && !this.withheld.has("user")) parts.push(`# User\n${this.promptView("user")}`);
    return parts.join("\n\n");
  }

  /** Live (post-snapshot) raw text — for reads/debug, not for the prompt. */
  liveText(block: BlockName): string { return this.live[block]; }

  /** true when the block's live text no longer matches the boot snapshot the prompt shows
   *  (an edit this run — the prompt picks it up on the next run). */
  edited(block: BlockName): boolean { return scan(this.live[block]) !== this.frozen[block]; }

  cap(block: BlockName): number { return this.caps[block]; }

  /** the block's boot read against its cap — null when it fits; `readCut` = the file went past READ_CAP_BYTES */
  overCap(block: BlockName): { chars: number; cap: number; readCut: boolean } | null {
    if (this.live[block].length <= this.caps[block] && !this.readCut[block]) return null;
    return { chars: this.live[block].length, cap: this.caps[block], readCut: this.readCut[block] };
  }

  /** true when the block is read (live, /memory, memory_edit) but kept out of the prompt (an unapproved project file) */
  isWithheld(block: BlockName): boolean { return this.withheld.has(block); }
}
