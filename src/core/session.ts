/** Append-only JSONL session tree (ADR-004).
 *  Entries form a tree by (id, parentId); a leaf pointer selects the active path.
 *  One serde path (JSON) for every backend. Corruption is detected, classified, and reported. */

import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, existsSync, readFileSync, writeFileSync, appendFileSync, readdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ImagePart, Message, RunEvent, TextPart } from "./types.ts";
import { hydrateImageParts, sidecarImageParts } from "./session-images.ts";
import { oneLineTitle, previewText } from "./session-text.ts";

export type Entry = Message | ({ id: string; kind: "event"; parentId: string | null; createdAt: number; event: RunEvent });

/** Port #34 image sidecars (session-images.ts): `<session>/attachments/<sha256>.<ext>`. The store's
 *  sidecar writer references them from entries.jsonl in ONE form, the session-relative
 *  `attachments/<file>`, resolved to an absolute path in memory only. Any other persisted path —
 *  whatever wrote it — never resolves to a readable file: a non-canonical relative path stays
 *  relative (F2) and an absolute path is dropped at load (F3), so the part lowers to a "file
 *  unavailable" placeholder and no line in entries.jsonl can point a hydrated part at a file
 *  outside `<session>/attachments/`.
 *  `rovecode export --json` copies entries.jsonl ALONE — the attachments directory travels with the
 *  session directory, not with the export (the JSONL stays a small, verbatim-copyable record). */

export type CorruptionKind =
  | "orphan-entry"        // parentId points at nothing
  | "cycle"               // ancestry loop
  | "duplicate-id"
  | "malformed-json"
  | "unknown-shape"
  | "chain-broken";       // prevHash disagrees with the parent entry's hash (tree/chain fork)

export interface Corruption { kind: CorruptionKind; entryId?: string; line: number; detail: string }

/** `leaf` (optional, port #2): durable active-leaf pointer. Absent = legacy = last entry wins.
 *  `title` / `forkedFrom` (aion port #84, 2026-09-07): a user-given name (`rovecode sessions rename`, one-lined on
 *  write AND on read — session-text.ts) and the id a fork was copied from. Written only through patchMeta. */
export interface SessionMeta { id: string; createdAt: number; goal?: string; model?: string; leaf?: string; title?: string; forkedFrom?: string }

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

/** Shape of a loaded entry (ADR-004: classify foreign/corrupt lines, never crash on them):
 *  "event" = kind "event"; "message" = a role plus a parts ARRAY whose members are objects with a
 *  string kind; undefined = anything else (null, a scalar, `parts: [null]`, `parts: "x"`, `{}`) —
 *  reload reports it as unknown-shape, path()/turnPoints() skip it, hydration leaves it alone. */
export function entryShape(e: unknown): "message" | "event" | undefined {
  if (!e || typeof e !== "object") return undefined;
  if ((e as { kind?: unknown }).kind === "event") return "event";
  const m = e as { role?: unknown; parts?: unknown };
  if (!("role" in m) || !Array.isArray(m.parts)) return undefined;
  return m.parts.every((p: unknown) => !!p && typeof p === "object" && typeof (p as { kind?: unknown }).kind === "string") ? "message" : undefined;
}

/** Event entry (kind "event") vs message — tolerant of foreign/corrupt entry shapes. */
function isEventWrapped(w: Wrapped): boolean { return entryShape(w.entry) === "event"; }

export interface SessionSummary {
  id: string;
  createdAt: number;
  updatedAt: number;    // max entry createdAt, else meta createdAt
  entryCount: number;
  preview: string;      // first user-message text, single-line, ≤80 chars, "" if none
  /** user messages recorded in the session file (every branch) */
  turns: number;
  /** the user-given title (meta.json `title`, one-lined on read) — the key is present ONLY when one is set */
  title?: string;
}

export interface ScanOptions {
  /** read the details (meta + entries) of at most this many sessions, newest file first; the rest are not opened */
  limit?: number;
  /** also list the hollow directories (a meta.json and no entry ever written) as sessions with entryCount 0 */
  includeHollow?: boolean;
}

export interface SessionScan {
  /** the sessions that hold something, newest first (plus the hollow ones when asked) */
  sessions: SessionSummary[];
  /** directory names that have a meta.json but no entries.jsonl (or an empty one) — nothing was ever written
   *  to them. Counted from the stat alone, never opened; `rovecode sessions` prints the count so the question of
   *  deleting them stays askable (Berkay has not decided; 35 of 36 on his machine, 2026-09-07). */
  hollow: string[];
}

/** Scan rootDir WITHOUT opening every file (2026-09-07): one readdir, one stat of entries.jsonl per directory, and
 *  meta.json + entries are read only for the directories that hold something — and only the newest `limit` of those
 *  when a limit is given (`--continue` needs one session, the picker twenty; the file's mtime orders the candidates
 *  before anything is opened, so a limit trusts the filesystem clock rather than the entries' own timestamps). The
 *  scan used to read the whole entries.jsonl of every directory to answer "which is newest": 36 directories on one
 *  machine, 35 of them empty, for one answer. A directory with neither file is foreign and skipped silently as
 *  before; corrupt files never throw. Sorted updatedAt desc. */
export function scanSessions(rootDir: string, opts: ScanOptions = {}): SessionScan {
  const hollow: string[] = [];
  const candidates: { name: string; mtime: number }[] = [];
  let names: string[];
  try { names = readdirSync(rootDir); } catch { return { sessions: [], hollow }; }
  for (const name of names) {
    let size = -1, mtime = 0;
    try { const st = statSync(join(rootDir, name, "entries.jsonl")); if (st.isFile()) { size = st.size; mtime = st.mtimeMs; } } catch { /* no entries file */ }
    if (size > 0) { candidates.push({ name, mtime }); continue; }
    try { if (statSync(join(rootDir, name, "meta.json")).isFile()) hollow.push(name); } catch { /* neither file: foreign, skipped */ }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  const chosen = opts.limit !== undefined ? candidates.slice(0, Math.max(0, opts.limit)) : candidates;
  const sessions: SessionSummary[] = [];
  for (const { name } of chosen) { const s = summarize(rootDir, name); if (s) sessions.push(s); }
  if (opts.includeHollow) for (const name of hollow) { const s = summarize(rootDir, name); if (s) sessions.push(s); }
  return { sessions: sessions.sort((a, b) => b.updatedAt - a.updatedAt), hollow };
}

/** one directory's summary: meta.json (identity = the DIRECTORY name, never meta.id — a copied/tampered meta.json
 *  must not redirect resume to another path) plus a pass over entries.jsonl; undefined for a corrupt or foreign dir */
function summarize(rootDir: string, name: string): SessionSummary | undefined {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(rootDir, name, "meta.json"), "utf8"));
    if (!raw || typeof raw !== "object") return undefined;
    const meta = raw as SessionMeta;
    if (typeof meta.id !== "string" || typeof meta.createdAt !== "number") return undefined;
    let updatedAt = meta.createdAt; let entryCount = 0; let preview = ""; let turns = 0;
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
        if (entryShape(e) === "message" && (e as Message).role === "user") {
          turns++;
          if (!preview) preview = previewText(e as Message);
        }
      }
    }
    const title = typeof meta.title === "string" ? oneLineTitle(meta.title) : undefined; // one-lined on READ; "" → no key
    return { id: name, createdAt: meta.createdAt, updatedAt, entryCount, preview, turns, ...(title !== undefined ? { title } : {}) };
  } catch { return undefined; /* foreign or corrupt dir: skip, never throw */ }
}

/** The sessions that hold something, newest first — scanSessions without the hollow count. `opts.includeHollow`
 *  lists the hollow directories too (the TUI picker and the CLI table do not; an exact id still opens one). */
export function listSessions(rootDir: string, opts: ScanOptions = {}): SessionSummary[] {
  return scanSessions(rootDir, opts).sessions;
}

/** The session `rovecode --continue` (or `--resume` with no id) reopens: the most recently updated one that
 *  HOLDS something. Costs one readdir, one stat per directory and ONE read (the newest file); a newest file made
 *  only of unparseable lines falls back to the full list rather than answering "nothing". */
export function newestSession(rootDir: string): SessionSummary | undefined {
  const first = scanSessions(rootDir, { limit: 1 }).sessions[0];
  if (first !== undefined && first.entryCount > 0) return first;
  return listSessions(rootDir).find((s) => s.entryCount > 0);
}

export interface TurnPoint {
  entryId: string;         // the user message's wrapped-entry id
  index: number;           // 1-based position among user turns on the active path
  text: string;            // single-line preview ≤80 chars (overlay label ONLY)
  /** untruncated message text — the edit-and-resubmit prefill (pi sessions.md:113) */
  fullText: string;
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
  /** port #34: image parts waiting for the next user message (stageAttachments) */
  private staged: ImagePart[] = [];

  /** Opening a store touches nothing on disk. The directory and meta.json appear with the FIRST entry
   *  (append, appendEvent, branch) — see materialize(). Constructing used to write both immediately, so
   *  every start that never got a prompt (`rovecode --help` paths that boot a runtime, `rovecode context`,
   *  a TUI opened and closed, every test) left `<sessions>/<uuid>/meta.json` behind: dozens of empty
   *  directories that listSessions offered as sessions with nothing in them. Deleting them afterwards was
   *  the other option, and it races: process B prunes the directory process A has just opened and not
   *  yet written to. Not creating it has no such window. An existing session (meta.json + entries) opens
   *  exactly as before; nothing is ever deleted. */
  constructor(rootDir: string, public readonly id: string) {
    this.dir = join(rootDir, id);
    this.meta = { id, createdAt: Date.now() };
    this.reload();
  }

  private get file() { return join(this.dir, "entries.jsonl"); }

  /** Make the session real on disk: the directory plus meta.json (once). Called on every write path,
   *  before the write. Idempotent and cheap (a mkdir on an existing directory and one stat), so it also
   *  means a session whose empty directory was swept away by hand recovers on its next entry instead of
   *  throwing ENOENT from appendFileSync. `createdAt` is the construction time, written whenever the first
   *  entry lands — the session began when it was opened, not when someone first spoke. */
  private materialize(): void {
    mkdirSync(this.dir, { recursive: true });
    const metaP = join(this.dir, "meta.json");
    if (!existsSync(metaP)) writeFileSync(metaP, JSON.stringify(this.meta, null, 2));
  }

  /** Replay JSONL → cache; detect corruption instead of crashing (pi reducer pattern).
   *  Restores a persisted leaf (durable branch) when meta.json names an existing entry;
   *  missing/invalid leaf falls back to the last tree-linked, well-shaped entry (LOW-A below). */
  reload(): Corruption[] {
    this.cache = [];
    this.leaf = "root"; this.prevHash = ""; // a replay that finds no leaf (no file, only foreign lines) is a fresh root
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
    const byLine = new Map<string, Wrapped>(); // ids seen so far (first occurrence wins)
    // LOW-A (#34): the fallback leaf = the last entry that is BOTH tree-linked (a root, or its parent seen
    // above it) AND a message/event. As cache.at(-1) it was whatever id-bearing line came last, so a
    // foreign `{"id":"ghost","parentId":"nope",…}` hijacked the active path (messages() shrank to the
    // ghost, the next append parented on it) and a bare `{"id":"bare"}` emptied it and re-rooted the next
    // append — silently: only `rovecode trace` shows these findings, the constructor discards them. Such
    // lines stay in the cache for chain/reporting and keep their orphan-entry / unknown-shape findings.
    let tail: Wrapped | undefined;
    lines.forEach((line, i) => {
      let w: Wrapped;
      try {
        w = JSON.parse(line) as Wrapped;
      } catch {
        corrupt.push({ kind: "malformed-json", line: i, detail: `unparseable line ${i}` });
        return;
      }
      // F1: a line that parses but is not an entry object (null, a number, a string) is reported, never dereferenced
      if (!w || typeof w !== "object") { corrupt.push({ kind: "unknown-shape", line: i, detail: "line is not an entry object" }); return; }
      // F4: an object line with no string id (`{"entry":null}`) is not a tree node either — reported and
      // skipped; cached, it became the leaf (cache.at(-1)) with id undefined, emptied messages() and
      // re-rooted the next append (the loop parents on history.at(-1) ?? null)
      if (typeof w.id !== "string") { corrupt.push({ kind: "unknown-shape", line: i, detail: "entry line has no string id" }); return; }
      if (seen.has(w.id)) corrupt.push({ kind: "duplicate-id", entryId: w.id, line: i, detail: "duplicate id" });
      seen.add(w.id);
      const orphan = w.parentId !== null && !seen.has(w.parentId);
      if (orphan) corrupt.push({ kind: "orphan-entry", entryId: w.id, line: i, detail: `parent ${w.parentId} missing` });
      // chain linkage: prevHash must equal the PARENT's hash ("" for roots). A leaf moved
      // mid-run used to fork the hash chain away from the parent pointer — detect it.
      // Missing parents are skipped here (already reported as orphan-entry above).
      const expected = w.parentId === null ? "" : byLine.get(w.parentId)?.hash;
      if (expected !== undefined && w.prevHash !== expected) {
        corrupt.push({ kind: "chain-broken", entryId: w.id, line: i, detail: `prevHash disagrees with parent ${w.parentId ?? "(root)"}` });
      }
      if (!byLine.has(w.id)) byLine.set(w.id, w);
      // F1: a foreign/corrupt entry (null, a scalar, parts:[null], …) is reported and kept in the tree
      // for chain purposes; path()/turnPoints() skip it and hydrateImages leaves it untouched
      const shape = entryShape(w.entry);
      if (shape === undefined) corrupt.push({ kind: "unknown-shape", entryId: w.id, line: i, detail: "entry is neither a message nor an event" });
      w.entry = this.hydrateImages(w.entry); // session-relative sidecar paths → absolute (in memory only)
      this.cache.push(w);
      if (!orphan && shape !== undefined) tail = w;
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
    if (tail) { this.leaf = tail.id; this.prevHash = tail.hash; }
    if (persistedLeaf !== undefined) {
      const w = byId.get(persistedLeaf);
      if (w) { this.leaf = w.id; this.prevHash = w.hash; }
    }
    return corrupt;
  }

  append(entry: Entry): void {
    // A supplied parentId can lag the leaf (the loop snapshots history at run start;
    // /new and /rewind may move the leaf mid-run). The chain must follow the PARENT
    // pointer, never the moved leaf, or hash chain and tree silently disagree.
    this.materialize();
    const supplied = (entry as { parentId?: string | null }).parentId;
    const parentId = supplied !== undefined ? supplied : this.leaf;
    let prevHash = this.prevHash;
    if (parentId !== this.leaf) {
      prevHash = parentId === null ? "" : (this.cache.find((c) => c.id === parentId)?.hash ?? this.prevHash);
    }
    // port #34: staged attachments ride on this user message — folded into the caller's parts
    // array IN PLACE, because the loop persists the very object it keeps in its history
    // (loop.ts:116-122); that is what puts the image on the wire this run without a loop change
    if (this.staged.length > 0 && "role" in entry && entry.role === "user") {
      entry.parts.push(...this.staged);
      this.staged = [];
    }
    const persisted = this.sidecarImages(entry); // inline bytes → sidecar files; entries.jsonl stays small
    const w: Wrapped = {
      id: entry.id, parentId,
      createdAt: entry.createdAt ?? Date.now(),
      prevHash,
      hash: "",
      entry: persisted,
    };
    w.hash = chainHash(prevHash, w);
    appendFileSync(this.file, JSON.stringify(w) + "\n");
    this.cache.push(persisted === entry ? w : { ...w, entry: this.hydrateImages(persisted) });
    this.leaf = w.id; this.prevHash = w.hash;
    if (this.leafPersisted) this.persistLeaf(); // keep the durable leaf in step after a branch
  }

  /** Port #34 TUI attach path (`/attach <path>` → next submit): image parts staged here are
   *  appended to the parts of the NEXT user message that lands in append(), then cleared.
   *  System/assistant/tool entries in between (a pending mode switch, tool results) leave the
   *  stage untouched. Replaces any earlier stage; `[]` clears it. */
  stageAttachments(parts: readonly ImagePart[]): void { this.staged = [...parts]; }

  get stagedAttachments(): readonly ImagePart[] { return this.staged; }

  /** The on-disk form (session-images.ts sidecarImageParts): inline image bytes → sidecar files +
   *  session-relative paths. Same object when there is nothing to do or the shape is foreign (F1). */
  private sidecarImages(entry: Entry): Entry {
    if (entryShape(entry) !== "message" || !("role" in entry)) return entry;
    const parts = sidecarImageParts(this.dir, entry.parts);
    return parts === undefined ? entry : { ...entry, parts };
  }

  /** The in-memory form (session-images.ts hydrateImageParts): canonical sidecar paths → absolute
   *  under this session's dir; a persisted absolute path is dropped (F3), any other relative one
   *  stays put (F2). Same object when there is nothing to do or the shape is foreign (F1). */
  private hydrateImages(entry: Entry): Entry {
    if (entryShape(entry) !== "message" || !("role" in entry)) return entry;
    const parts = hydrateImageParts(this.dir, entry.parts);
    return parts === undefined ? entry : { ...entry, parts };
  }

  /** Persist a RunEvent as an ANNOTATION of the current leaf (port #25: the loop's compaction
   *  marker). The entry hangs off the leaf without becoming one — the loop parents its next
   *  message on the last real message (history.at(-1)), so a chain-linked event would turn
   *  into a dead sibling the moment that message lands. Hash-chained like any entry; path()
   *  folds it back in right after the message it annotates; messages() never sees it. */
  appendEvent(event: RunEvent): Entry {
    this.materialize();
    const parentId = this.leaf === "root" ? null : this.leaf;
    const entry: Entry = { id: randomUUID(), kind: "event", parentId, createdAt: Date.now(), event };
    const w: Wrapped = { id: entry.id, parentId, createdAt: entry.createdAt, prevHash: this.prevHash, hash: "", entry };
    w.hash = chainHash(this.prevHash, w);
    appendFileSync(this.file, JSON.stringify(w) + "\n");
    this.cache.push(w);
    return entry;
  }

  /** Active path = root → leaf (omp buildSessionContext); unknown-shape entries (reload F1) are skipped. */
  path(): Entry[] { return this.wrappedPath().filter((w) => entryShape(w.entry) !== undefined).map((w) => w.entry); }

  private wrappedPath(): Wrapped[] {
    const byId = new Map(this.cache.map((w) => [w.id, w]));
    const out: Wrapped[] = [];
    let cur = byId.get(this.leaf);
    // A tampered or corrupt file can carry an ancestry cycle (reload() already reports it as `cycle`);
    // walking it here looped forever and died with `RangeError: Out of memory`, so ANY surface that
    // resumed such a session — run --resume, trace, export, context — crashed instead of reporting the
    // corruption. Found by the gauntlet's session-tamper case (eval/gauntlet-wave4.ts), 2026-09-07. The
    // walk now stops at the first id it has already seen: the path truncates there, the finding stays on
    // reload()'s list, and nothing hangs.
    const seen = new Set<string>();
    while (cur && !seen.has(cur.id)) { seen.add(cur.id); out.unshift(cur); cur = cur.parentId ? byId.get(cur.parentId) : undefined; }
    // event annotations (appendEvent) are children of path entries but never parents: fold each
    // in right after the entry it annotates, file order. Chain-linked events (a supplied
    // parentId via append, e.g. the export fixture) are already on the path and stay put.
    const onPath = new Set(out.map((w) => w.id));
    const notes = new Map<string | null, Wrapped[]>();
    for (const w of this.cache) {
      if (onPath.has(w.id) || !isEventWrapped(w)) continue;
      if (w.parentId !== null && !onPath.has(w.parentId)) continue;
      const list = notes.get(w.parentId) ?? []; list.push(w); notes.set(w.parentId, list);
    }
    if (notes.size === 0) return out;
    const folded: Wrapped[] = [...(notes.get(null) ?? [])];
    for (const w of out) folded.push(w, ...(notes.get(w.id) ?? []));
    return folded;
  }

  /** User turns along the ACTIVE path only, root→leaf order. */
  turnPoints(): TurnPoint[] {
    const children = new Map<string | null, number>();
    // event annotations hang off entries without forking them: not a branch (port #25)
    for (const w of this.cache) if (!isEventWrapped(w)) children.set(w.parentId, (children.get(w.parentId) ?? 0) + 1);
    const out: TurnPoint[] = [];
    for (const w of this.wrappedPath()) {
      const e = w.entry;
      if (entryShape(e) !== "message" || !("role" in e) || e.role !== "user") continue; // F1: foreign shapes skipped
      out.push({
        entryId: w.id,
        index: out.length + 1,
        text: previewText(e),
        fullText: e.parts.filter((p): p is TextPart => p.kind === "text").map((p) => p.text).join(""),
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
    this.materialize();
    this.meta = { ...this.meta, leaf: this.leaf };
    this.writeMeta(this.meta);
    this.leafPersisted = true;
  }

  /** The ONE meta writer for everything that is not the leaf (aion port #84): `title`, `forkedFrom`, `createdAt`.
   *  Reads the file as it is on disk so unknown keys and their order survive byte-for-byte, applies the patch, and
   *  forces `id` = the directory name (a meta.json copied from another session self-heals). The entries file is
   *  untouched. Materialises the directory first, so a fork that copied meta.json in already exists. */
  patchMeta(patch: Partial<Pick<SessionMeta, "title" | "forkedFrom" | "createdAt">>): void {
    this.materialize();
    let current: Record<string, unknown> = {};
    try {
      const raw: unknown = JSON.parse(readFileSync(join(this.dir, "meta.json"), "utf8"));
      if (raw && typeof raw === "object" && !Array.isArray(raw)) current = raw as Record<string, unknown>;
    } catch { /* unreadable: rebuild from what this store knows */ current = { ...this.meta }; }
    const next = { ...current, ...patch, id: this.id } as Record<string, unknown>;
    this.writeMeta(next);
    this.meta = { ...this.meta, ...patch, id: this.id };
  }

  private writeMeta(meta: object): void {
    const metaP = join(this.dir, "meta.json");
    const tmp = metaP + ".tmp";
    writeFileSync(tmp, JSON.stringify(meta, null, 2));
    renameSync(tmp, metaP);
  }

  messages(): Message[] { return this.path().filter((e): e is Message => "role" in e); }
}
