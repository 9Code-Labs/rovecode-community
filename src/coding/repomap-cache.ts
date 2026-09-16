/** Persistent per-file tags cache (PORT #12, round-2 F1): aider persists its
 *  tags cache to disk via diskcache (.aider.tags.cache.v4, repomap.py
 *  L217-222) so extraction "only happens once" ACROSS launches, not per
 *  process. JSON equivalent under <root>/.rovecode/cache/repomap.json, keyed by
 *  absolute path. mtime+size mismatch, a missing file, or corrupt JSON simply
 *  miss (aider recreates the cache on SQLITE errors, L241-264). Strictly
 *  advisory: every failure path degrades to re-extraction, never to a crash.
 *
 *  On-disk shape (version 2): each entry carries its two path strings ONCE and its
 *  tags as [line, name, kind] tuples. Version 1 stored every Tag whole — the relative
 *  and the absolute path repeated on each of ~75k tags — and this repository's cache
 *  was 13.3 MB, 78 ms to read and parse on every session's first prompt, +44 MB of
 *  resident memory once parsed (measured 2026-09-06, scripts/probe-turn.ts). A file of
 *  another version is treated as absent: the map re-extracts and the save overwrites
 *  it in the current shape. */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Tag } from "./repomap.ts";

interface CacheEntry { mtimeMs: number; size: number; tags: Tag[] }
/** the v2 line: [line, name, kind] with kind 0 = def, 1 = ref */
type TagTuple = [number, string, 0 | 1];
interface DiskEntry { m: number; s: number; rel: string; abs: string; t: TagTuple[] }
interface DiskFile { version: number; entries: Record<string, DiskEntry> }

/** bump to invalidate wholesale on tag-shape/extraction changes (aider's .v4 suffix) */
export const CACHE_VERSION = 2;

const toDisk = (e: CacheEntry): DiskEntry | null => {
  const first = e.tags[0];
  // a file with no tags has no path strings to carry; store it with the entry key's paths unknown →
  // keep both empty, the reader falls back to the key for the absolute path
  return {
    m: e.mtimeMs, s: e.size,
    rel: first?.relFname ?? "", abs: first?.fname ?? "",
    t: e.tags.map((t) => [t.line, t.name, t.kind === "def" ? 0 : 1] as TagTuple),
  };
};

const fromDisk = (fname: string, d: DiskEntry): CacheEntry | null => {
  if (typeof d?.m !== "number" || typeof d?.s !== "number" || !Array.isArray(d?.t)) return null;
  const relFname = typeof d.rel === "string" ? d.rel : "";
  const abs = typeof d.abs === "string" && d.abs.length > 0 ? d.abs : fname;
  const tags: Tag[] = [];
  for (const tu of d.t) {
    if (!Array.isArray(tu) || typeof tu[0] !== "number" || typeof tu[1] !== "string" || (tu[2] !== 0 && tu[2] !== 1)) return null; // a torn entry misses whole
    tags.push({ relFname, fname: abs, line: tu[0], name: tu[1], kind: tu[2] === 0 ? "def" : "ref" });
  }
  return { mtimeMs: d.m, size: d.s, tags };
};

export class TagsDiskCache {
  readonly path: string;
  private entries = new Map<string, CacheEntry>();
  private dirty = false;

  constructor(root: string) {
    this.path = join(root, ".rovecode", "cache", "repomap.json");
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as Partial<DiskFile> | null;
      if (raw?.version === CACHE_VERSION && raw.entries && typeof raw.entries === "object") {
        for (const [fname, d] of Object.entries(raw.entries)) {
          const e = fromDisk(fname, d);
          if (e) this.entries.set(fname, e);
        }
      }
      // any other version (older, newer, missing): cold — the next save writes this version
    } catch { /* absent or corrupt -> cold cache */ }
  }

  /** hit only when BOTH mtimeMs and size match the live stat */
  get(fname: string, mtimeMs: number, size: number): Tag[] | undefined {
    const e = this.entries.get(fname);
    return e && e.mtimeMs === mtimeMs && e.size === size ? e.tags : undefined;
  }

  set(fname: string, mtimeMs: number, size: number, tags: Tag[]): void {
    this.entries.set(fname, { mtimeMs, size, tags });
    this.dirty = true;
  }

  /** Write-if-dirty: a fully-warm run rewrites nothing. Atomic-ish tmp+rename
   *  (pid-suffixed) so a crash or a racing process never leaves torn JSON. */
  save(): void {
    if (!this.dirty) return;
    const tmp = `${this.path}.${process.pid}.tmp`;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const entries: Record<string, DiskEntry> = {};
      for (const [fname, e] of this.entries) { const d = toDisk(e); if (d) entries[fname] = d; }
      const file: DiskFile = { version: CACHE_VERSION, entries };
      writeFileSync(tmp, JSON.stringify(file));
      renameSync(tmp, this.path);
      this.dirty = false;
    } catch {
      try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
    }
  }
}
