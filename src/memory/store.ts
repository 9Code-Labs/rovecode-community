/** Bounded memory (ADR-008): typed records with budgets, decay, dedup, provenance.
 *  Memory edits flow through the tool pipeline so policy applies. */

import { createHash } from "node:crypto";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type MemoryKind = "task" | "episodic" | "semantic";

export interface MemoryRecord {
  id: string;
  kind: MemoryKind;
  text: string;
  createdAt: number;
  lastAccessedAt: number;
  accessCount: number;
  /** where this came from: session id, tool call, user */
  provenance: string;
  tags: string[];
}

export interface MemoryLimits {
  maxRecords: number;
  maxCharsPerRecord: number;
  /** records unused for this many ms get decayed (deleted at the tail) */
  decayAfterMs: number;
}

export const defaultLimits: MemoryLimits = { maxRecords: 500, maxCharsPerRecord: 2_000, decayAfterMs: 1000 * 60 * 60 * 24 * 14 };

function dedupKey(r: MemoryRecord): string {
  return createHash("sha256").update(r.kind + "|" + r.text.replace(/\s+/g, " ").trim().toLowerCase()).digest("hex").slice(0, 16);
}

export class MemoryStore {
  private records: MemoryRecord[] = [];
  private seen = new Set<string>();

  constructor(private readonly dir: string, private readonly limits: MemoryLimits = defaultLimits) {
    mkdirSync(dir, { recursive: true });
    const p = join(dir, "memory.json");
    if (existsSync(p)) {
      this.records = JSON.parse(readFileSync(p, "utf8")) as MemoryRecord[];
      this.seen = new Set(this.records.map(dedupKey));
    }
  }

  private persist(): void {
    writeFileSync(join(this.dir, "memory.json"), JSON.stringify(this.records, null, 2));
  }

  add(kind: MemoryKind, text: string, provenance: string, tags: string[] = []): { ok: boolean; reason?: string } {
    const trimmed = text.trim();
    if (trimmed.length === 0) return { ok: false, reason: "empty record" };
    if (trimmed.length > this.limits.maxCharsPerRecord) return { ok: false, reason: `record exceeds ${this.limits.maxCharsPerRecord} chars` };
    const rec: MemoryRecord = {
      id: createHash("sha256").update(kind + trimmed + Date.now()).digest("hex").slice(0, 12),
      kind, text: trimmed, createdAt: Date.now(), lastAccessedAt: Date.now(), accessCount: 0, provenance, tags,
    };
    const key = dedupKey(rec);
    if (this.seen.has(key)) return { ok: false, reason: "duplicate" };
    this.seen.add(key);
    this.records.push(rec);
    this.enforceLimits();
    this.persist();
    return { ok: true };
  }

  private enforceLimits(): void {
    const now = Date.now();
    // decay: drop stale records beyond the cap, oldest-accessed first
    this.records = this.records.filter((r) => now - r.lastAccessedAt < this.limits.decayAfterMs);
    if (this.records.length > this.limits.maxRecords) {
      this.records.sort((a, b) => a.lastAccessedAt - b.lastAccessedAt);
      this.records = this.records.slice(this.records.length - this.limits.maxRecords);
    }
  }

  /** Recency × access × simple lexical relevance. */
  retrieve(query: string, limit = 5, kind?: MemoryKind): MemoryRecord[] {
    const terms = query.toLowerCase().split(/\W+/).filter((t) => t.length > 2);
    const now = Date.now();
    const scored = this.records
      .filter((r) => !kind || r.kind === kind)
      .map((r) => {
        const text = r.text.toLowerCase();
        const hits = terms.reduce((n, t) => n + (text.includes(t) ? 1 : 0), 0);
        const recency = 1 / (1 + (now - r.lastAccessedAt) / 3_600_000);
        const score = hits * 2 + Math.log1p(r.accessCount) + recency;
        return { r, score };
      })
      .filter((s) => s.score > 0.3)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    for (const s of scored) { s.r.accessCount++; s.r.lastAccessedAt = now; }
    this.persist();
    return scored.map((s) => s.r);
  }

  stats(): { count: number; byKind: Record<string, number> } {
    const byKind: Record<string, number> = {};
    for (const r of this.records) byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
    return { count: this.records.length, byKind };
  }
}
