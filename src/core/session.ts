/** Append-only JSONL session tree (ADR-004).
 *  Entries form a tree by (id, parentId); a leaf pointer selects the active path.
 *  One serde path (JSON) for every backend. Corruption is detected, classified, and reported. */

import { createHash } from "node:crypto";
import { mkdirSync, existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import type { Message, RunEvent } from "./types.ts";

export type Entry = Message | ({ id: string; kind: "event"; parentId: string | null; createdAt: number; event: RunEvent });

export type CorruptionKind =
  | "orphan-entry"        // parentId points at nothing
  | "cycle"               // ancestry loop
  | "duplicate-id"
  | "malformed-json"
  | "unknown-shape";

export interface Corruption { kind: CorruptionKind; entryId?: string; line: number; detail: string }

export interface SessionMeta { id: string; createdAt: number; goal?: string; model?: string }

/** Hash chain: each entry carries sha256(prevHash + canonical(entry)). Tamper-evident replay. */
export function chainHash(prev: string, entry: Entry): string {
  const canon = JSON.stringify(sortKeys(entry));
  return createHash("sha256").update(prev + canon).digest("hex");
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, sortKeys(x)])
    );
  }
  return v;
}

interface Wrapped { id: string; parentId: string | null; createdAt: number; prevHash: string; hash: string; entry: Entry }

export class SessionStore {
  private readonly dir: string;
  private leaf = "root";
  private prevHash = "";
  private cache: Wrapped[] = [];

  constructor(rootDir: string, public readonly id: string) {
    this.dir = join(rootDir, id);
    mkdirSync(this.dir, { recursive: true });
    const metaP = join(this.dir, "meta.json");
    if (!existsSync(metaP)) {
      writeFileSync(metaP, JSON.stringify(<SessionMeta>{ id, createdAt: Date.now() }, null, 2));
    }
    this.reload();
  }

  private get file() { return join(this.dir, "entries.jsonl"); }

  /** Replay JSONL → cache; detect corruption instead of crashing (pi reducer pattern). */
  reload(): Corruption[] {
    this.cache = [];
    const seen = new Set<string>();
    const corrupt: Corruption[] = [];
    if (!existsSync(this.file)) return corrupt;
    const lines = readFileSync(this.file, "utf8").split("\n").filter(Boolean);
    lines.forEach((line, i) => {
      let w: Wrapped;
      try {
        w = JSON.parse(line) as Wrapped;
      } catch {
        corrupt.push({ kind: "malformed-json", line: i, detail: `unparseable line ${i}` });
        return;
      }
      if (seen.has(w.id)) corrupt.push({ kind: "duplicate-id", entryId: w.id, line: i, detail: "duplicate id" });
      seen.add(w.id);
      if (w.parentId !== null && !seen.has(w.parentId)) {
        corrupt.push({ kind: "orphan-entry", entryId: w.id, line: i, detail: `parent ${w.parentId} missing` });
      }
      this.cache.push(w);
    });
    // cycle check over ancestry
    const byId = new Map(this.cache.map((w) => [w.id, w]));
    for (const w of this.cache) {
      const anc = new Set<string>(); let cur: Wrapped | undefined = w;
      while (cur && cur.parentId !== null) {
        if (anc.has(cur.id)) { corrupt.push({ kind: "cycle", entryId: w.id, line: -1, detail: "ancestry cycle" }); break; }
        anc.add(cur.id); cur = byId.get(cur.parentId);
      }
    }
    const last = this.cache.at(-1);
    if (last) { this.leaf = last.id; this.prevHash = last.hash; }
    return corrupt;
  }

  append(entry: Entry): void {
    const w: Wrapped = {
      id: entry.id, parentId: "id" in entry && (entry as Message).parentId !== undefined ? (entry as Message).parentId : this.leaf,
      createdAt: entry.createdAt ?? Date.now(),
      prevHash: this.prevHash,
      hash: "",
      entry,
    };
    w.hash = chainHash(this.prevHash, w);
    appendFileSync(this.file, JSON.stringify(w) + "\n");
    this.cache.push(w);
    this.leaf = w.id; this.prevHash = w.hash;
  }

  /** Active path = root → leaf (omp buildSessionContext). */
  path(): Entry[] {
    const byId = new Map(this.cache.map((w) => [w.id, w]));
    const out: Entry[] = [];
    let cur = byId.get(this.leaf);
    while (cur) { out.unshift(cur.entry); cur = cur.parentId ? byId.get(cur.parentId) : undefined; }
    return out;
  }

  /** Branch: move leaf back to an earlier entry without deleting anything. */
  branch(entryId: string): boolean {
    if (!this.cache.some((w) => w.id === entryId)) return false;
    this.leaf = entryId;
    const idx = this.cache.findIndex((w) => w.id === entryId);
    const last = this.cache[idx]!;
    this.prevHash = last.hash;
    return true;
  }

  messages(): Message[] { return this.path().filter((e): e is Message => "role" in e); }
}
