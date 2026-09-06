/** Every source, one list. `searchMarket` here merges four of them — the curated MCP shelf, the live MCP
 *  registry, the skills catalog and the plugins catalog — into `MarketItem`s and reports, per source,
 *  whether the answer came from the network, from a cache, or not at all.
 *
 *  ON CACHING (deliberate, and worth reading before adding one): the only source that can be slow or
 *  unreachable is the MCP registry, and `src/mcp/market.ts` already caches it under
 *  ~/.rovecode/cache/mcp-market.json with a TTL and an offline switch. A second cache over the merged
 *  result would be a second source of staleness that can disagree with the first, so this module keeps
 *  none: it delegates the remote half to mcp/market.ts and reads the other three straight from disk.
 *  Skills and plugins live in JSON files inside the repo, so they are offline by construction. That means
 *  `market search` answers with something useful on a plane, which is the property that was actually asked
 *  for. `sources` reports "live" or "cache" honestly per source so a UI can draw the difference.
 *
 *  CATALOG DATA IS UNTRUSTED — including the JSON files, which arrive through a git pull like any other
 *  file. Every field is re-typed here against the caps in types.ts; a field that is too long is truncated,
 *  a list item past the cap is dropped, and a row that cannot be made valid is skipped with a note. One
 *  bad row never blanks a catalog, and nothing read here is ever executed. */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { searchMarket as searchMcp, marketInfo as mcpInfo, type MarketDeps as McpDeps, type MarketEntry } from "../mcp/market.ts";
import { LIMITS, type InstallSpec, type ItemDocs, type MarketEnv, type MarketItem, type MarketKind, type MarketResult, type SourceStatus } from "./types.ts";

/** where the skill and plugin catalogs live in the repo (written by the catalog owner, read here) */
export const CATALOG_DIR = new URL("./catalogs/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
export const CATALOG_FILES: Record<"skill" | "plugin", string> = {
  skill: join(CATALOG_DIR, "skills.json"),
  plugin: join(CATALOG_DIR, "plugins.json"),
};
/** MCP documentation arrives as a SIDECAR rather than in the shelf itself: `src/mcp/market-catalog.ts`
 *  stays hand-written because a publisher, a command and an env var are human decisions, while a README is
 *  generated data. Keyed by the curated entry's `key`. Absent file = no docs, which is not an error. */
export const MCP_DOCS_FILE = join(CATALOG_DIR, "mcp-docs.json");

export interface RegistryDeps {
  /** MCP registry access (fetch/offline/home/now) — passed through to mcp/market.ts unchanged */
  mcp?: McpDeps;
  /** skip every network call: curated + catalogs + whatever is cached */
  offline?: boolean;
  /** override the catalog file paths (tests write fixtures) */
  catalogFiles?: Partial<Record<"skill" | "plugin", string>>;
  /** read a catalog file (tests inject; default readFileSync) */
  readFile?: (path: string) => string | null;
  /** override the MCP documentation sidecar's path (tests write fixtures) */
  mcpDocsFile?: string;
  /** carry `docs.body`. Off for search/list, where the bodies are ~200 KB the caller never reads; the
   *  metadata comes either way. `findItem` turns it on. */
  withDocs?: boolean;
}

// ---------------------------------------------------------------- untrusted-data re-typing

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** a string, capped; anything else (number, object, missing) is undefined */
function str(v: unknown, max: number = LIMITS.str): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s.length === 0 ? undefined : s.slice(0, max);
}

/** a finite non-negative integer within `max`, or undefined — a catalog's numbers are untrusted too:
 *  "12", -1, NaN, 1e30 and {} all have to come back as "no number", not as a value that poisons a UI. */
function num(v: unknown, max: number): number | undefined {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return undefined;
  const n = Math.floor(v);
  return n > max ? undefined : n;
}

function strList(v: unknown, max: number = LIMITS.list, each: number = LIMITS.str): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v.slice(0, max)) { const s = str(x, each); if (s !== undefined) out.push(s); }
  return out;
}

/** an https URL, or undefined — never a javascript:/file: URL, never a bare word */
function url(v: unknown): string | undefined {
  const s = str(v);
  if (s === undefined) return undefined;
  try { const u = new URL(s); return u.protocol === "https:" || u.protocol === "http:" ? s : undefined; } catch { return undefined; }
}

function envList(v: unknown): MarketEnv[] {
  if (!Array.isArray(v)) return [];
  const out: MarketEnv[] = [];
  for (const raw of v.slice(0, LIMITS.env)) {
    if (!isRecord(raw)) continue;
    const name = str(raw.name, 64);
    if (name === undefined || !ENV_NAME.test(name)) continue;
    const e: MarketEnv = { name, required: raw.required === true, secret: raw.secret === true };
    const d = str(raw.description, LIMITS.desc); if (d !== undefined) e.description = d;
    const def = str(raw.default); if (def !== undefined) e.default = def;
    out.push(e);
  }
  return out;
}

/** One definition of "this path leaves the folder", used by BOTH arms. They had drifted — one split on
 *  `[/]` and the other on `[\/]`, so `..\..\evil` passed the plugin check and failed the skill one.
 *  Two layers disagreeing about the same rule is how a hole opens later, even when today something
 *  downstream happens to catch it. */
function escapes(sub: string): boolean {
  const parts = sub.split(/[\/]/);
  return parts.includes("..") || sub.startsWith("/") || sub.startsWith("\\") || /^[A-Za-z]:/.test(sub);
}

/** the install arm for a catalog row, or null when the row describes nothing installable */
function catalogInstall(kind: "skill" | "plugin", raw: Record<string, unknown>, notes: string[], id: string): InstallSpec | null {
  const spec = isRecord(raw.install) ? raw.install : raw;
  if (kind === "plugin") {
    const source = str(spec.source, 512);
    if (source === undefined) { notes.push(`plugins catalog: "${id}" has no install source — skipped`); return null; }
    // a git source must look like one; a local path is accepted as written and checked at install time
    const git = spec.git === true || /^(?:https?:\/\/|git@|ssh:\/\/|git:\/\/)|\.git$/i.test(source);
    if (git && url(source) === undefined && !/^(?:git@|ssh:\/\/|git:\/\/)/.test(source)) {
      notes.push(`plugins catalog: "${id}" install source is not a usable URL — skipped`); return null;
    }
    const sub = str(spec.subfolder, 200);
    // a subfolder that climbs out of the clone is a path-traversal attempt, not a typo (same rule as a skill's)
    if (sub !== undefined && escapes(sub)) { notes.push(`plugins catalog: "${id}" subfolder escapes the clone (${sub}) — skipped`); return null; }
    return { kind: "plugin", source, git, ...(sub !== undefined ? { subfolder: sub } : {}) };
  }
  const files: { path: string; text: string }[] = [];
  if (Array.isArray(spec.files)) {
    for (const f of spec.files.slice(0, LIMITS.list)) {
      if (!isRecord(f)) continue;
      const path = str(f.path, 200), text = typeof f.text === "string" ? f.text : undefined;
      // a catalog file is written under the skill's own folder: no absolute path, no escape upwards
      if (path === undefined || text === undefined) continue;
      if (path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:/.test(path) || path.split(/[\\/]/).includes("..")) {
        notes.push(`skills catalog: "${id}" wants to write outside its folder (${path}) — skipped`); return null;
      }
      if (text.length > LIMITS.body) { notes.push(`skills catalog: "${id}" file ${path} is over the size cap — skipped`); return null; }
      files.push({ path, text });
    }
  }
  const gitSpec = isRecord(spec.source) ? spec.source : undefined;
  const git = gitSpec ? url(gitSpec.git) ?? (typeof gitSpec.git === "string" && /^(?:git@|ssh:\/\/)/.test(gitSpec.git) ? str(gitSpec.git, 512) : undefined) : undefined;
  if (git !== undefined) {
    const sub = str(gitSpec!.subfolder, 200);
    // a subfolder that climbs out of the clone is a path-traversal attempt, not a typo
    if (sub !== undefined && (sub.split(/[\\/]/).includes("..") || sub.startsWith("/"))) {
      notes.push(`skills catalog: "${id}" subfolder escapes the clone (${sub}) — skipped`); return null;
    }
    return { kind: "skill", source: { git, ...(sub !== undefined ? { subfolder: sub } : {}) }, ...(files.length ? { files } : {}) };
  }
  if (files.length === 0) { notes.push(`skills catalog: "${id}" has neither a git source nor files — skipped`); return null; }
  return { kind: "skill", files };
}

/** Truncate to a BYTE budget, not a character count. `LIMITS.docs` is 24 KB and `.slice()` counts UTF-16
 *  units, so a body of astral characters — emoji, CJK extensions, mathematical symbols — could be 24576
 *  units and roughly four times that many bytes, sailing straight through the cap it was supposed to hit.
 *  The generator measures in bytes (scripts/lib/docs.mjs), so this second line of defence has to as well.
 *  Cuts on a character boundary: never half a surrogate pair. */
export function capBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (Buffer.byteLength(text.slice(0, mid), "utf8") <= maxBytes) lo = mid; else hi = mid - 1;
  }
  // a lone leading surrogate at the cut would be an unpaired code unit: step back one
  const cut = text.slice(0, lo);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/** The item's own documentation, or undefined. A BROKEN doc drops the doc, never the row — the same rule
 *  as "a doc we could not reach is not an error": a shelf entry whose README moved is still installable.
 *  `withBody: false` keeps the ~200 KB of markdown out of the search path; the metadata still comes, so a
 *  row can carry its badge without its body. */
function docsOf(raw: unknown, notes: string[], id: string, withBody: boolean): ItemDocs | undefined {
  if (!isRecord(raw)) return undefined;
  const source = url(raw.source);
  if (source === undefined) { notes.push(`${id}: documentation source is not an http(s) URL — docs dropped, the row stays`); return undefined; }
  if (raw.format !== "markdown") { notes.push(`${id}: documentation format ${JSON.stringify(raw.format)} is not "markdown" — docs dropped, the row stays`); return undefined; }
  // NOT str(): that trims, and a document is a body rather than a label — trailing newlines and leading
  // indentation are part of markdown. Only the cap and the "is there anything here at all" check apply.
  const body = typeof raw.body === "string" && raw.body.trim().length > 0 ? capBytes(raw.body, LIMITS.docs) : undefined;
  if (body === undefined) { notes.push(`${id}: documentation body is empty — docs dropped, the row stays`); return undefined; }
  // `bytes` is the size upstream, before truncation, so it is normally LARGER than the body we carry.
  // A number that is missing or junk is replaced by what we can actually see rather than trusted.
  const declared = num(raw.bytes, 1024 * 1024 * 1024);
  const carried = Buffer.byteLength(body, "utf8");
  const bytes = declared === undefined || declared < carried ? carried : declared;
  const truncated = raw.truncated === true || bytes > carried;
  return { source, format: "markdown", bytes, truncated, ...(withBody ? { body } : {}) };
}

/** one catalog row → a MarketItem, or null (with a note) when it cannot be trusted into one */
export function itemFromCatalog(kind: "skill" | "plugin", raw: unknown, notes: string[], withDocs = true): MarketItem | null {
  if (!isRecord(raw)) return null;
  const id = str(raw.id ?? raw.name, 64);
  if (id === undefined || !ID.test(id)) { notes.push(`${kind}s catalog: a row has no usable id — skipped`); return null; }
  const description = str(raw.description, LIMITS.desc);
  if (description === undefined) { notes.push(`${kind}s catalog: "${id}" has no description — skipped`); return null; }
  const install = catalogInstall(kind, raw, notes, id);
  if (install === null) return null;
  const item: MarketItem = {
    id, kind, title: str(raw.title, LIMITS.str) ?? id,
    publisher: str(raw.publisher, LIMITS.str) ?? "unknown",
    description, source: "catalog", tags: strList(raw.tags, LIMITS.list, 40).map((t) => t.toLowerCase()),
    env: envList(raw.env), install,
  };
  const version = str(raw.version, 64); if (version !== undefined) item.version = version;
  const repository = url(raw.repository); if (repository !== undefined) item.repository = repository;
  const homepage = url(raw.homepage); if (homepage !== undefined) item.homepage = homepage;
  const status = str(raw.status, 64); if (status !== undefined) item.status = status;
  const license = str(raw.license, 120); if (license !== undefined) item.license = license;
  const planNote = strList(raw.planNote, 8, LIMITS.desc); if (planNote.length) item.planNote = planNote;
  // the generator has always written this array; until now only the sentence built from it was read
  const contributes = strList(raw.contributes, 12, 32); if (contributes.length) item.contributes = contributes;
  const docs = docsOf(raw.docs, notes, id, withDocs); if (docs) item.docs = docs;
  return item;
}

/** an MCP entry (curated or registry) → a MarketItem, wrapping the entry untouched */
export function itemFromMcp(entry: MarketEntry): MarketItem {
  const stdio = entry.installs.find((i) => i.kind === "stdio");
  const item: MarketItem = {
    id: entry.key, kind: "mcp", title: entry.title ?? entry.key,
    publisher: entry.publisher ?? "unknown", description: entry.description,
    source: entry.source === "curated" ? "curated" : "registry",
    tags: [], env: stdio?.kind === "stdio" ? stdio.env.map((e) => ({ ...e })) : [],
    install: { kind: "mcp", entry },
  };
  if (entry.version !== undefined) item.version = entry.version;
  if (entry.repository !== undefined) item.repository = entry.repository;
  if (entry.homepage !== undefined) item.homepage = entry.homepage;
  if (entry.status !== undefined) item.status = entry.status;
  return item;
}

// ---------------------------------------------------------------- reading the catalogs

function readFileOr(path: string, deps: RegistryDeps): string | null {
  const read = deps.readFile ?? ((p: string) => (existsSync(p) ? readFileSync(p, "utf8") : null));
  try { return read(path); } catch { return null; }
}

/** the MCP documentation sidecar, keyed by curated key. A missing or broken file is silently no docs. */
function mcpDocs(deps: RegistryDeps, notes: string[], withBody: boolean): Record<string, ItemDocs> {
  const text = readFileOr(deps.mcpDocsFile ?? MCP_DOCS_FILE, deps);
  if (text === null || text.length > LIMITS.body) return {};
  let json: unknown;
  try { json = JSON.parse(text); } catch { notes.push("mcp documentation sidecar is not valid JSON — MCP rows keep their docs off"); return {}; }
  const rows = isRecord(json) && isRecord(json.docs) ? json.docs : isRecord(json) && !Array.isArray(json) ? json : null;
  if (rows === null) return {};
  const out: Record<string, ItemDocs> = {};
  for (const [key, raw] of Object.entries(rows).slice(0, LIMITS.items)) {
    const d = docsOf(raw, notes, `mcp:${key}`, withBody);
    if (d) out[key] = d;
  }
  return out;
}

function readCatalog(kind: "skill" | "plugin", deps: RegistryDeps): { items: MarketItem[]; status: SourceStatus; notes: string[] } {
  const path = deps.catalogFiles?.[kind] ?? CATALOG_FILES[kind];
  const notes: string[] = [];
  const read = deps.readFile ?? ((p: string) => (existsSync(p) ? readFileSync(p, "utf8") : null));
  let text: string | null;
  try { text = read(path); } catch (e) { return { items: [], status: { ok: false, reason: `${kind}s catalog unreadable: ${e instanceof Error ? e.message : String(e)}` }, notes }; }
  const withDocs = deps.withDocs === true;
  // a catalog that is not there yet is not an error: rovecode ships without one until it is written
  if (text === null) return { items: [], status: { ok: true, from: "curated" }, notes };
  if (text.length > LIMITS.body) return { items: [], status: { ok: false, reason: `${kind}s catalog is over ${LIMITS.body} bytes` }, notes };
  let json: unknown;
  try { json = JSON.parse(text); } catch { return { items: [], status: { ok: false, reason: `${kind}s catalog is not valid JSON` }, notes }; }
  const rows = isRecord(json) && Array.isArray(json.items) ? json.items : Array.isArray(json) ? json : null;
  if (rows === null) return { items: [], status: { ok: false, reason: `${kind}s catalog has no "items" array` }, notes };
  const items: MarketItem[] = [];
  const seen = new Set<string>();
  for (const raw of rows.slice(0, LIMITS.items)) {
    const item = itemFromCatalog(kind, raw, notes, withDocs);
    if (item === null) continue;
    if (seen.has(item.id)) { notes.push(`${kind}s catalog: "${item.id}" appears twice — first kept`); continue; }
    seen.add(item.id);
    items.push(item);
  }
  return { items, status: { ok: true, from: "curated" }, notes };
}

/** substring match over the fields a person would type: id, title, description, tags */
function matches(item: MarketItem, words: string[]): boolean {
  if (words.length === 0) return true;
  const hay = `${item.id} ${item.title} ${item.description} ${item.tags.join(" ")}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}

/** Search every source. Never throws: a source that fails contributes no rows and one `sources` entry. */
export async function searchMarket(query: string, deps: RegistryDeps = {}): Promise<MarketResult> {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const sources: Record<string, SourceStatus> = {};
  const notes: string[] = [];
  const items: MarketItem[] = [];

  for (const kind of ["skill", "plugin"] as const) {
    const r = readCatalog(kind, deps);
    sources[`${kind}s`] = r.status;
    notes.push(...r.notes);
    for (const item of r.items) if (matches(item, words)) items.push(item);
  }

  const mcpDeps: McpDeps = { ...deps.mcp, ...(deps.offline === true ? { offline: true } : {}) };
  try {
    const r = await searchMcp(query, mcpDeps);
    const docs = mcpDocs(deps, notes, deps.withDocs === true);
    for (const e of r.entries) {
      const item = itemFromMcp(e);
      const d = docs[e.key];
      if (d) item.docs = d;
      items.push(item);
    }
    const curatedOnly = r.entries.every((e) => e.source === "curated");
    sources["mcp:curated"] = { ok: true, from: "curated" };
    // mcp/market.ts asks the registry only for a query of two characters or more
    sources["mcp:registry"] = query.trim().length < 2
      ? { ok: true, from: "skipped", why: "a search term of two characters or more asks the registry; the curated shelf answers an empty one" }
      : mcpDeps.offline === true ? { ok: true, from: "skipped", why: "offline: the network was not tried" }
      : r.fromCache ? { ok: true, from: "cache", ageMs: 0 }
      : { ok: true, from: "live" };
    void curatedOnly;
    // the MCP module's own notes are already human sentences ("the registry did not answer …")
    notes.push(...r.notes);
    if (r.notes.some((n) => /registry/i.test(n) && /(fail|not answer|error|timed out)/i.test(n))) {
      sources["mcp:registry"] = { ok: false, reason: r.notes.find((n) => /registry/i.test(n))! };
    }
  } catch (e) {
    sources["mcp:curated"] = { ok: false, reason: e instanceof Error ? e.message : String(e) };
    sources["mcp:registry"] = { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }

  return { items, sources, notes };
}

/** One item by kind + id, for `market info` and `market install`. Consults the catalogs first (offline,
 *  exact), then the MCP module (which knows how to fetch one registry name). */
export async function findItem(kind: MarketKind, id: string, deps: RegistryDeps = {}): Promise<{ item?: MarketItem; notes: string[] }> {
  const notes: string[] = [];
  if (kind === "skill" || kind === "plugin") {
    const r = readCatalog(kind, { ...deps, withDocs: true }); // one item: the body is the point
    notes.push(...r.notes);
    const item = r.items.find((i) => i.id === id);
    return { ...(item ? { item } : {}), notes };
  }
  const mcpDeps: McpDeps = { ...deps.mcp, ...(deps.offline === true ? { offline: true } : {}) };
  const r = await mcpInfo(id, mcpDeps);
  notes.push(...r.notes);
  if (!r.entry) return { notes };
  const item = itemFromMcp(r.entry);
  const d = mcpDocs(deps, notes, true)[r.entry.key];
  if (d) item.docs = d;
  return { item, notes };
}

/** Every item from every source, unfiltered — what `market list --all` and the site page render. */
export async function allItems(deps: RegistryDeps = {}): Promise<MarketResult> {
  return searchMarket("", deps);
}
