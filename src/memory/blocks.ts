/** Bounded markdown memory blocks (hermes pattern): MEMORY.md + USER.md with hard char caps.
 *  The snapshot is frozen at session start (constructor) so the system prompt stays
 *  cache-stable; tools mutate live state + disk only. A threat-scan neutralizes injection
 *  lines in the rendered view — raw text on disk is never rewritten by the scan. */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { VersionLedger } from "../skills/versioned.ts";

export type BlockName = "memory" | "user";

export interface BlockCaps { memory: number; user: number }

export const defaultCaps: BlockCaps = { memory: 2_200, user: 1_375 };

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

  constructor(
    private readonly dir: string,
    private readonly caps: BlockCaps = defaultCaps,
  ) {
    // no mkdir here: reads tolerate a missing directory and the ledger creates it on the first commit
    // (skills/versioned.ts). Creating `<session>/memory` at construction was what made every session
    // directory non-empty before anyone had said anything (core/session.ts materialize()).
    this.live.memory = this.read("MEMORY.md");
    this.live.user = this.read("USER.md");
    // snapshot is the threat-scanned view of what session start loaded
    this.frozen = { memory: scan(this.live.memory), user: scan(this.live.user) };
    this.ledgers = {
      memory: new VersionLedger(this.file("memory")),
      user: new VersionLedger(this.file("user")),
    };
    this.baseVersions = { memory: this.ledgers.memory.version(), user: this.ledgers.user.version() };
  }

  private read(name: string): string {
    const p = join(this.dir, name);
    return existsSync(p) ? readFileSync(p, "utf8") : "";
  }

  private file(block: BlockName): string {
    return join(this.dir, block === "memory" ? "MEMORY.md" : "USER.md");
  }

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

  /** Char-cap guard shared by commit() and rollback(); runs BEFORE any ledger write. */
  private capCheck(block: BlockName, next: string): BlockEditResult | null {
    const limit = this.caps[block];
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
    return { ok: true, current: this.live[block].length, limit: this.caps[block] };
  }

  /** port #16: version history access for status/debug surfaces. */
  ledger(block: BlockName): VersionLedger { return this.ledgers[block]; }

  /** Session-start snapshot (threat-scanned). Tool writes never change it. */
  renderForPrompt(): string {
    const parts: string[] = [];
    if (this.frozen.memory) parts.push(`# Memory\n${this.frozen.memory}`);
    if (this.frozen.user) parts.push(`# User\n${this.frozen.user}`);
    return parts.join("\n\n");
  }

  /** Live (post-snapshot) raw text — for reads/debug, not for the prompt. */
  liveText(block: BlockName): string { return this.live[block]; }

  cap(block: BlockName): number { return this.caps[block]; }
}
