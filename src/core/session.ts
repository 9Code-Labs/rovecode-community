/** Append-only JSONL session tree (ADR-004).
 *  Entries form a tree by (id, parentId); a leaf pointer selects the active path.
 *  One serde path (JSON) for every backend. Corruption is detected, classified, and reported. */

import { createHash } from "node:crypto";
import { mkdirSync, existsSync, readFileSync, writeFileSync, appendFileSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { Message, RunEvent, TextPart } from "./types.ts";

export type Entry = Message | ({ id: string; kind: "event"; parentId: string | null; createdAt: number; event: RunEvent });

export type CorruptionKind =
  | "orphan-entry"        // parentId points at nothing
  | "cycle"               // ancestry loop
  | "duplicate-id"
  | "malformed-json"
  | "unknown-shape";

export interface Corruption { kind: CorruptionKind; entryId?: string; line: number; detail: string }

/** `leaf` (optional, port #2): durable active-leaf pointer. Absent = legacy = last entry wins. */
export interface SessionMeta { id: string; createdAt: number; goal?: string; model?: string; leaf?: string }

/** Hash chain: each entry carries sha256(prevHash + canonical(entry)). Tamper-evident replay.
 *  Accepts the wrapped envelope too — the chain hashes the full wrapper (hash field empty). */
export function chainHash(prev: string, entry: Entry | object): string {
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

/** Single-line preview of a message's text parts; ≤80 chars, "" when no text. */
function previewText(m: Message): string {
  const joined = m.parts.filter((p): p is TextPart => p.kind === "text").map((p) => p.text).join(" ");
  const one = joined.replace(/\s+/g, " ").trim();
  return one.length > 80 ? one.slice(0, 79) + "…" : one;
}

export interface SessionSummary {
  id: string;
  createdAt: number;
  updatedAt: number;    // max entry createdAt, else meta createdAt
  entryCount: number;
  preview: string;      // first user-message text, single-line, ≤80 chars, "" if none
}

/** Scan rootDir for session dirs; skip (never throw on) corrupt/foreign dirs. Sorted updatedAt desc. */
export function listSessions(rootDir: string): SessionSummary[] {
  const out: SessionSummary[] = [];
  let names: string[];
  try { names = readdirSync(rootDir); } catch { return out; }
  for (const name of names) {
    try {
      const raw: unknown = JSON.parse(readFileSync(join(rootDir, name, "meta.json"), "utf8"));
      if (!raw || typeof raw !== "object") continue;
      const meta = raw as SessionMeta;
      if (typeof meta.id !== "string" || typeof meta.createdAt !== "number") continue;
      let updatedAt = meta.createdAt; let entryCount = 0; let preview = "";
      const entriesPath = join(rootDir, name, "entries.jsonl");
      if (existsSync(entriesPath)) {
        for (const line of readFileSync(entriesPath, "utf8").split("\n")) {
          if (!line.trim()) continue;
          let parsed: unknown;
          try { parsed = JSON.parse(line); } catch { continue; }
          if (!parsed || typeof parsed !== "object") continue;
          const w = parsed as Wrapped;
          entryCount++;
          if (typeof w.createdAt === "number" && w.createdAt > updatedAt) updatedAt = w.createdAt;
          const e: unknown = w.entry;
          if (!preview && e && typeof e === "object" && "role" in e && (e as Message).role === "user") {
            preview = previewText(e as Message);
          }
        }
      }
      out.push({ id: meta.id, createdAt: meta.createdAt, updatedAt, entryCount, preview });
    } catch { /* foreign or corrupt dir: skip, never throw */ }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

export interface TurnPoint {
  entryId: string;         // the user message's wrapped-entry id
  index: number;           // 1-based position among user turns on the active path
  text: string;            // single-line preview ≤80 chars
  parentId: string | null; // the entry's parent (rewind target: leaf moves HERE)
  branches: number;        // children of parentId in the whole tree MINUS the active-path child (0 = linear)
}

export class SessionStore {
  private readonly dir: string;
  private leaf = "root";
  private prevHash = "";
  private cache: Wrapped[] = [];
  private meta: SessionMeta;
  /** true once meta.json carries a leaf field — appends then keep it in step. */
  private leafPersisted = false;

  constructor(rootDir: string, public readonly id: string) {
    this.dir = join(rootDir, id);
    this.meta = { id, createdAt: Date.now() };
    mkdirSync(this.dir, { recursive: true });
    const metaP = join(this.dir, "meta.json");
    if (!existsSync(metaP)) {
      writeFileSync(metaP, JSON.stringify(this.meta, null, 2));
    }
    this.reload();
  }

  private get file() { return join(this.dir, "entries.jsonl"); }

  /** Replay JSONL → cache; detect corruption instead of crashing (pi reducer pattern).
   *  Restores a persisted leaf (durable branch) when meta.json names an existing entry;
   *  missing/invalid leaf falls back to the last entry, exactly as before port #2. */
  reload(): Corruption[] {
    this.cache = [];
    const seen = new Set<string>();
    const corrupt: Corruption[] = [];
    let persistedLeaf: string | undefined;
    this.leafPersisted = false;
    try {
      const raw: unknown = JSON.parse(readFileSync(join(this.dir, "meta.json"), "utf8"));
      if (raw && typeof raw === "object") {
        const m = raw as SessionMeta;
        if (typeof m.id === "string" && typeof m.createdAt === "number") this.meta = m;
        if (typeof m.leaf === "string") { persistedLeaf = m.leaf; this.leafPersisted = true; }
      }
    } catch { /* unreadable meta behaves as legacy (no persisted leaf) */ }
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
    if (persistedLeaf !== undefined) {
      const w = byId.get(persistedLeaf);
      if (w) { this.leaf = w.id; this.prevHash = w.hash; }
    }
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
    if (this.leafPersisted) this.persistLeaf(); // keep the durable leaf in step after a branch
  }

  /** Active path = root → leaf (omp buildSessionContext). */
  path(): Entry[] { return this.wrappedPath().map((w) => w.entry); }

  private wrappedPath(): Wrapped[] {
    const byId = new Map(this.cache.map((w) => [w.id, w]));
    const out: Wrapped[] = [];
    let cur = byId.get(this.leaf);
    while (cur) { out.unshift(cur); cur = cur.parentId ? byId.get(cur.parentId) : undefined; }
    return out;
  }

  /** User turns along the ACTIVE path only, root→leaf order. */
  turnPoints(): TurnPoint[] {
    const children = new Map<string | null, number>();
    for (const w of this.cache) children.set(w.parentId, (children.get(w.parentId) ?? 0) + 1);
    const out: TurnPoint[] = [];
    for (const w of this.wrappedPath()) {
      const e = w.entry;
      if (!("role" in e) || e.role !== "user") continue;
      out.push({
        entryId: w.id,
        index: out.length + 1,
        text: previewText(e),
        parentId: w.parentId,
        branches: (children.get(w.parentId) ?? 1) - 1,
      });
    }
    return out;
  }

  /** Branch: move leaf back to an earlier entry without deleting anything.
   *  Durable (port #2): the leaf survives restarts via meta.json. Unknown id → false. */
  branch(entryId: string): boolean {
    const target = this.cache.find((w) => w.id === entryId);
    if (!target) return false;
    this.leaf = target.id;
    this.prevHash = target.hash;
    this.persistLeaf();
    return true;
  }

  /** Atomically rewrite meta.json carrying the active leaf (write tmp + rename). */
  private persistLeaf(): void {
    this.meta = { ...this.meta, leaf: this.leaf };
    const metaP = join(this.dir, "meta.json");
    const tmp = metaP + ".tmp";
    writeFileSync(tmp, JSON.stringify(this.meta, null, 2));
    renameSync(tmp, metaP);
    this.leafPersisted = true;
  }

  messages(): Message[] { return this.path().filter((e): e is Message => "role" in e); }
}
