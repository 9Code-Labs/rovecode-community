/** Versioned edit ledger for skill/memory files (PORT #16, prime-agent MIT).
 *
 *  Port of the refinement/versioned-state machinery in prime-agent
 *  packages/coding-agent/src/core/refinement/refinement.ts:
 *    - per-edit before/after snapshots + version bump  (AppliedRefinementEdit:85,
 *      `version = before ? before.version + 1 : 1`:770, record push:788)
 *    - optimistic-concurrency baseline check → typed reject, no write  (735-749)
 *    - rollback built from recorded before/after, itself a new history entry
 *      (rollbackProposal:813-845, rollbackOf:100)
 *    - append-only JSONL history beside the store; malformed lines skipped so a
 *      bad append can never break rollback  (refinements.jsonl:25, 374-400)
 *
 *  Deliberately NOT ported (BLUEPRINT §5 + prime's reward-hacking findings):
 *  no auto-refinement loop (prime's reviewAutoRefine LLM gate stays out), no
 *  LLM proposal pass, and no grader/eval surface anywhere in this API
 *  (ouroboros rule: graders stay hidden from agent-facing code). Edits happen
 *  only when a human or an explicit tool call invokes commit()/rollback().
 *
 *  Storage: sidecar JSONL beside the target file — `<target>.versions.jsonl`
 *  (mirrors the house `SKILL.md.usage.json` sidecar). One line per edit:
 *  {version, baseVersion, before, after, reason, timestamp, rollbackTo?}.
 *  Every record carries FULL before/after content, so record v restores both
 *  content@v (`after`) and content@v-1 (`before`). With the newest K records
 *  retained, rollback covers versions [oldest.baseVersion .. newest.version].
 *  History is bounded: past `maxEdits` records the oldest are evicted, and
 *  versions older than the window become unreachable (typed reject).
 *  Versions are monotonic and never reused after eviction. */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const LEDGER_SUFFIX = ".versions.jsonl";
export const DEFAULT_MAX_EDITS = 20;

export interface VersionedEdit {
  /** version this edit produced (monotonic; = baseVersion + 1) */
  version: number;
  /** version the editor read before making the change */
  baseVersion: number;
  /** full target content before the edit (content at baseVersion) */
  before: string;
  /** full target content after the edit (content at version) */
  after: string;
  reason: string;
  /** ms epoch */
  timestamp: number;
  /** set when this edit was produced by rollback(): the restored version */
  rollbackTo?: number;
}

/** Inclusive range of versions rollback can currently restore. */
export interface VersionRange { from: number; to: number }

export type CommitResult =
  | { ok: true; edit: VersionedEdit }
  | { ok: false; code: "version-conflict"; baseVersion: number; currentVersion: number; message: string };

export type RollbackResult =
  | { ok: true; edit: VersionedEdit }
  | { ok: false; code: "unknown-version"; requested: number; available: VersionRange | null; message: string };

// ---------- internals ----------

/** Atomic write (house pattern, skills/index.ts writeUsageAtomic): tmp + rename. */
function atomicWrite(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

/** Parse one JSONL line into an edit, or null when malformed (prime: skip, never throw). */
function parseEdit(line: string): VersionedEdit | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (
    typeof r["version"] !== "number" || typeof r["baseVersion"] !== "number" ||
    typeof r["before"] !== "string" || typeof r["after"] !== "string" ||
    typeof r["reason"] !== "string" || typeof r["timestamp"] !== "number"
  ) return null;
  const edit: VersionedEdit = {
    version: r["version"], baseVersion: r["baseVersion"],
    before: r["before"], after: r["after"],
    reason: r["reason"], timestamp: r["timestamp"],
  };
  if (typeof r["rollbackTo"] === "number") edit.rollbackTo = r["rollbackTo"];
  return edit;
}

// ---------- ledger ----------

export interface VersionLedgerOptions {
  /** sidecar path (default: `<target>${LEDGER_SUFFIX}`) */
  ledgerPath?: string;
  /** bounded snapshot count; oldest records evicted past this (default 20, min 1) */
  maxEdits?: number;
}

export class VersionLedger {
  readonly ledgerPath: string;
  private readonly maxEdits: number;

  constructor(readonly targetPath: string, opts: VersionLedgerOptions = {}) {
    this.ledgerPath = opts.ledgerPath ?? targetPath + LEDGER_SUFFIX;
    this.maxEdits = Math.max(1, opts.maxEdits ?? DEFAULT_MAX_EDITS);
  }

  /** Retained edits, oldest → newest. Malformed lines are skipped; duplicate
   *  versions keep the last occurrence (append order wins). */
  history(): VersionedEdit[] {
    if (!existsSync(this.ledgerPath)) return [];
    const byVersion = new Map<number, VersionedEdit>();
    for (const line of readFileSync(this.ledgerPath, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const edit = parseEdit(trimmed);
      if (edit) byVersion.set(edit.version, edit);
    }
    return [...byVersion.values()].sort((a, b) => a.version - b.version);
  }

  /** Current version: 0 until the first recorded edit; unaffected by eviction. */
  version(): number {
    return this.history().at(-1)?.version ?? 0;
  }

  /** Current on-disk content of the target ("" when the file does not exist). */
  read(): string {
    return existsSync(this.targetPath) ? readFileSync(this.targetPath, "utf8") : "";
  }

  /** Versions rollback can restore right now, or null before the first edit.
   *  Derived from the CONTIGUOUS suffix of retained records: a corruption hole
   *  (missing/garbled record) breaks before/after coverage, so a naive
   *  first..last span would advertise versions rollback cannot restore. */
  range(): VersionRange | null {
    const edits = this.history();
    const last = edits.at(-1);
    if (!last) return null;
    let start = edits.length - 1;
    while (start > 0 && edits[start - 1]!.version === edits[start]!.baseVersion) start--;
    return { from: edits[start]!.baseVersion, to: last.version };
  }

  /** Content at a recorded version, or undefined when evicted/unknown. Besides a
   *  record's own `after`, any record with baseVersion === version restores it via
   *  `before` — recoverable even when the record that PRODUCED it was corrupted. */
  contentAt(version: number): string | undefined {
    const edits = this.history();
    const direct = edits.find((e) => e.version === version);
    if (direct) return direct.after;
    return edits.find((e) => e.baseVersion === version)?.before;
  }

  /** True when the target was modified outside the ledger since the last edit. */
  drifted(): boolean {
    const last = this.history().at(-1);
    return last !== undefined && this.read() !== last.after;
  }

  /** Record an edit and write the target. Optimistic concurrency: `baseVersion`
   *  must equal the current version or the commit is rejected BEFORE any disk
   *  mutation — no partial write. `before` is read from disk here, so the
   *  record stays truthful even if the target drifted externally. */
  commit(after: string, reason: string, baseVersion: number, now: number = Date.now()): CommitResult {
    const currentVersion = this.version();
    if (baseVersion !== currentVersion) {
      return {
        ok: false, code: "version-conflict", baseVersion, currentVersion,
        message: `baseVersion ${baseVersion} does not match current version ${currentVersion}; re-read and retry`,
      };
    }
    return { ok: true, edit: this.write(after, reason, currentVersion, now) };
  }

  /** One-call rollback to any retained version. Recorded as a NEW edit with
   *  `rollbackTo` (prime `rollbackOf` pattern) — history is append-only, and
   *  the restored content is byte-exact from the stored snapshot. */
  rollback(toVersion: number, reason?: string, now: number = Date.now()): RollbackResult {
    const content = this.contentAt(toVersion);
    if (content === undefined) {
      const available = this.range();
      return {
        ok: false, code: "unknown-version", requested: toVersion, available,
        message: available
          ? `version ${toVersion} is not restorable; available: ${available.from}..${available.to}`
          : `version ${toVersion} is not restorable; no recorded edits`,
      };
    }
    const edit = this.write(content, reason ?? `rollback to v${toVersion}`, this.version(), now, toVersion);
    return { ok: true, edit };
  }

  /** Append the record, evict past the bound, then atomically write the target.
   *  Ledger-first ordering: a crash between the two leaves an honest record
   *  (visible via drifted()) rather than an unrecorded content change. */
  private write(after: string, reason: string, currentVersion: number, now: number, rollbackTo?: number): VersionedEdit {
    const edit: VersionedEdit = {
      version: currentVersion + 1, baseVersion: currentVersion,
      before: this.read(), after, reason, timestamp: now,
      ...(rollbackTo !== undefined ? { rollbackTo } : {}),
    };
    mkdirSync(dirname(this.ledgerPath), { recursive: true });
    // Heal a torn trailing append: a crash mid-append can leave the last line
    // without "\n" — appending straight on would concatenate this record into the
    // torn line, making the NEW commit invisible to history()/version().
    let record = JSON.stringify(edit) + "\n";
    if (existsSync(this.ledgerPath)) {
      const raw = readFileSync(this.ledgerPath);
      if (raw.length > 0 && raw[raw.length - 1] !== 0x0a) record = "\n" + record;
    }
    appendFileSync(this.ledgerPath, record, "utf8");
    const edits = this.history();
    if (edits.length > this.maxEdits) {
      const kept = edits.slice(edits.length - this.maxEdits);
      atomicWrite(this.ledgerPath, kept.map((e) => JSON.stringify(e)).join("\n") + "\n");
    }
    atomicWrite(this.targetPath, after);
    return edit;
  }
}
