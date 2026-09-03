/** Persistent per-file tags cache (PORT #12, round-2 F1): aider persists its
 *  tags cache to disk via diskcache (.aider.tags.cache.v4, repomap.py
 *  L217-222) so extraction "only happens once" ACROSS launches, not per
 *  process. JSON equivalent under <root>/.rovecode/cache/repomap.json, keyed by
 *  absolute path -> { mtimeMs, size, tags }. mtime+size mismatch, a missing
 *  file, or corrupt JSON simply miss (aider recreates the cache on SQLITE
 *  errors, L241-264). Strictly advisory: every failure path degrades to
 *  re-extraction, never to a crash. */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Tag } from "./repomap.ts";

interface CacheEntry { mtimeMs: number; size: number; tags: Tag[] }

/** bump to invalidate wholesale on tag-shape/extraction changes (aider's .v4 suffix) */
const CACHE_VERSION = 1;

export class TagsDiskCache {
  readonly path: string;
  private entries = new Map<string, CacheEntry>();
  private dirty = false;

  constructor(root: string) {
    this.path = join(root, ".rovecode", "cache", "repomap.json");
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as
        { version?: number; entries?: Record<string, CacheEntry> };
      if (raw?.version === CACHE_VERSION && raw.entries && typeof raw.entries === "object") {
        for (const [fname, e] of Object.entries(raw.entries)) {
          if (typeof e?.mtimeMs === "number" && typeof e?.size === "number" && Array.isArray(e?.tags))
            this.entries.set(fname, e);
        }
      }
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
      writeFileSync(tmp, JSON.stringify({ version: CACHE_VERSION, entries: Object.fromEntries(this.entries) }));
      renameSync(tmp, this.path);
      this.dirty = false;
    } catch {
      try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
    }
  }
}
