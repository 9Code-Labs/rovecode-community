/** The MCP market: where `rovecode mcp search|info|add` and the TUI's /mcp find servers to install.
 *  Two sources, merged: the built-in curated list (market-catalog.ts, offline, hand-checked) and the
 *  official registry at registry.modelcontextprotocol.io. Registry responses are UNTRUSTED DATA: every
 *  field is re-typed here, every string is capped, every list is capped, and nothing from a response is
 *  ever executed, evaluated or written to a config file without the human seeing it first
 *  (market-install.ts owns the preview + write). Responses are cached under ~/.rovecode/cache/
 *  mcp-market.json with a TTL so a flaky network or an offline train still leaves /mcp usable.
 *
 *  Registry API, verified live on 2026-09-04 (the shape is NOT assumed from docs):
 *    GET /v0/servers?search=<substring of name>&version=latest&limit=<=100[&cursor=]
 *      → { servers: [{ server: ServerJson, _meta: { "io.modelcontextprotocol.registry/official": { status, isLatest, … } } }],
 *          metadata: { nextCursor?, count } }
 *    GET /v0/servers/<url-encoded name>/versions/latest → { server: ServerJson, _meta }
 *    ServerJson: { name, description, title?, version, repository?: { url, source, subfolder? }, websiteUrl?,
 *      packages?: [{ registryType: npm|pypi|oci|nuget|mcpb, identifier, version?, runtimeHint?, transport: { type },
 *                    runtimeArguments?: Arg[], packageArguments?: Arg[], environmentVariables?: Var[] }],
 *      remotes?: [{ type: streamable-http|sse, url, headers?: Var[] }] }
 *    Arg: { type: positional|named, name?, value?, default?, isRequired?, valueHint?, description? }
 *    Var: { name, value?, default?, isRequired?, isSecret?, description? } — `value` may hold "{placeholder}"s. */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { rovecodeHome } from "../providers/auth.ts";
import { isRecord, message } from "./config.ts";
import { CURATED } from "./market-catalog.ts";

export const REGISTRY_URL = "https://registry.modelcontextprotocol.io/v0";
/** cache TTL: a day — registry entries change rarely and the human sees the version before installing */
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_QUERIES = 40;
/** the registry's detail route has been seen taking >8s from here; a CLI can wait this long once, the cache does the rest */
const FETCH_TIMEOUT_MS = 20_000;
/** hard ceilings on what a response may contribute — anything past them is dropped, never trusted */
export const LIMITS = { body: 2 * 1024 * 1024, servers: 100, str: 300, desc: 500, list: 32, packages: 8 } as const;

/** one environment variable (or header placeholder) a server wants; `secret` ones are asked masked */
export interface EnvSpec { name: string; description?: string; required: boolean; secret: boolean; default?: string }
/** one HTTP header a remote wants; `{name}` placeholders in `template` are asked as EnvSpecs */
export interface HeaderSpec { name: string; template?: string; description?: string; required: boolean; secret: boolean }
export type MarketInstall =
  | { kind: "stdio"; runtime: "npx" | "uvx" | "docker" | "other"; command: string; args: string[]; env: EnvSpec[];
      /** required arguments the registry could not fill (a path, a token on the command line): named for the human */
      pending: string[] }
  | { kind: "http"; url: string; headers: HeaderSpec[] };

export interface MarketEntry {
  /** what `mcp add <key>` takes: the curated short name, or the registry's reverse-DNS name */
  key: string;
  title?: string;
  description: string;
  version?: string;
  source: "curated" | "registry";
  /** who publishes it — a curated entry says so, a registry entry derives it from its namespace */
  publisher?: string;
  /** the registry's listing status when it is anything but active (e.g. "deprecated") */
  status?: string;
  repository?: string;
  homepage?: string;
  installs: MarketInstall[];
}

export interface MarketDeps {
  fetch?: typeof fetch;
  home?: string;
  now?: () => number;
  catalog?: readonly MarketEntry[];
  registryUrl?: string;
  /** skip the network entirely (curated + cache only) */
  offline?: boolean;
}
export interface MarketResult { entries: MarketEntry[]; notes: string[]; fromCache: boolean }

// ------------------------------------------------------------------ validated re-typing of registry JSON

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;
const COMMAND = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_-]*)\}/g;

function str(v: unknown, max: number = LIMITS.str): string | undefined {
  if (typeof v !== "string" || v.length === 0) return undefined;
  const flat = v.replace(/[\u0000-\u001f\u007f]/g, " ");
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}
function list(v: unknown, max: number = LIMITS.list): unknown[] { return Array.isArray(v) ? v.slice(0, max) : []; }
function httpUrl(v: unknown): string | undefined {
  const s = str(v, 2000);
  if (s === undefined) return undefined;
  try { const u = new URL(s); return u.protocol === "http:" || u.protocol === "https:" ? s : undefined; } catch { return undefined; }
}

function envSpec(raw: unknown): EnvSpec | undefined {
  if (!isRecord(raw)) return undefined;
  const name = str(raw.name, 128);
  if (name === undefined || !ENV_NAME.test(name)) return undefined;
  const def = str(raw.value) ?? str(raw.default);
  const out: EnvSpec = { name, required: raw.isRequired === true, secret: raw.isSecret === true };
  const d = str(raw.description, LIMITS.desc);
  if (d !== undefined) out.description = d;
  if (def !== undefined && !PLACEHOLDER.test(def)) out.default = def; // a "{placeholder}" is a question, not a value
  PLACEHOLDER.lastIndex = 0;
  return out;
}
function headerSpec(raw: unknown): HeaderSpec | undefined {
  if (!isRecord(raw)) return undefined;
  const name = str(raw.name, 64);
  if (name === undefined || !HEADER_NAME.test(name)) return undefined;
  const out: HeaderSpec = { name, required: raw.isRequired === true, secret: raw.isSecret === true };
  const t = str(raw.value) ?? str(raw.default);
  if (t !== undefined) out.template = t;
  const d = str(raw.description, LIMITS.desc);
  if (d !== undefined) out.description = d;
  return out;
}

/** the angle brackets are what marks a hole, here and in mcp/config.ts — a value already wearing them
 *  keeps the wording the registry chose */
function hole(hint: string): string { return hint.startsWith("<") && hint.endsWith(">") ? hint : `<${hint}>`; }

/** registry Arg[] → argv words; what has no value but is required goes to `pending` for the human */
function argWords(raws: unknown[], pending: string[]): string[] {
  const words: string[] = [];
  for (const raw of raws) {
    if (!isRecord(raw)) continue;
    const value = str(raw.value) ?? str(raw.default);
    const name = str(raw.name, 128);
    const hint = str(raw.valueHint, 64) ?? name ?? "<argument>";
    if (raw.type === "named") {
      if (name === undefined) continue;
      if (value !== undefined) words.push(name, value);
      // a required flag with no value is "--root <path>", not "--root": pending entries are argv
      // FRAGMENTS the installer appends, and the <angle-bracketed> part is the hole a human fills.
      // Appending the bare flag would write a server that launches and then rejects its own arguments.
      else if (raw.isRequired === true) pending.push(`${name} ${hole(str(raw.valueHint, 64) ?? "value")}`);
    } else if (value !== undefined) words.push(value);
    else if (raw.isRequired === true) pending.push(hole(hint));
  }
  return words;
}

/** one registry package → a stdio install, or undefined (unsupported type, non-stdio transport, bad hint) */
export function installFromPackage(raw: unknown, notes: string[]): MarketInstall | undefined {
  if (!isRecord(raw)) return undefined;
  const type = str(raw.registryType, 32), id = str(raw.identifier, 200), version = str(raw.version, 64);
  if (type === undefined || id === undefined) return undefined;
  const transport = isRecord(raw.transport) ? str(raw.transport.type, 32) : "stdio";
  if (transport !== undefined && transport !== "stdio") return undefined; // an http package is "run it yourself, then connect": not an install
  const hint = str(raw.runtimeHint, 64);
  if (hint !== undefined && !COMMAND.test(hint)) { notes.push(`${id}: runtime hint "${hint}" refused (not a bare command name)`); return undefined; }
  const pending: string[] = [];
  const runtimeArgs = argWords(list(raw.runtimeArguments), pending);
  const pkgArgs = argWords(list(raw.packageArguments), pending);
  const env = list(raw.environmentVariables).map(envSpec).filter((e): e is EnvSpec => e !== undefined);
  const pinned = version !== undefined && version !== "latest";
  let command: string, args: string[], runtime: Extract<MarketInstall, { kind: "stdio" }>["runtime"];
  switch (type) {
    case "npm":
      command = hint ?? "npx"; runtime = command === "npx" ? "npx" : "other";
      args = [...(command === "npx" && !runtimeArgs.includes("-y") ? ["-y"] : []), ...runtimeArgs, pinned ? `${id}@${version}` : id, ...pkgArgs];
      break;
    case "pypi":
      command = hint ?? "uvx"; runtime = command === "uvx" ? "uvx" : "other";
      args = [...runtimeArgs, pinned ? `${id}==${version}` : id, ...pkgArgs];
      break;
    case "oci":
      // docker gets `-e NAME` per variable so the value travels through the environment, never argv
      command = hint ?? "docker"; runtime = command === "docker" ? "docker" : "other";
      args = ["run", "-i", "--rm", ...env.flatMap((e) => ["-e", e.name]), ...runtimeArgs, pinned ? `${id}:${version}` : id, ...pkgArgs];
      break;
    default:
      notes.push(`${id}: package type "${type}" is not something rovecode can launch`);
      return undefined;
  }
  return { kind: "stdio", runtime, command, args, env, pending };
}

/** one registry remote → an http install, or undefined (sse is legacy and the loader refuses it anyway) */
export function installFromRemote(raw: unknown, notes: string[] = []): MarketInstall | undefined {
  if (!isRecord(raw)) return undefined;
  const type = str(raw.type, 32);
  const url = httpUrl(raw.url);
  if (type !== "streamable-http" && type !== "http") {
    // the human asked why nothing was written: an sse (legacy) remote is the usual answer — say so, like the package path does
    notes.push(`${url ?? "a remote"}: ${type === "sse" ? "sse remote (legacy transport) is not something rovecode can connect to" : `remote type "${type ?? "?"}" is not something rovecode can connect to`}`);
    return undefined;
  }
  if (url === undefined) return undefined;
  return { kind: "http", url, headers: list(raw.headers).map(headerSpec).filter((h): h is HeaderSpec => h !== undefined) };
}

/** `io.github.owner/repo` → "github.com/owner"; `com.example/x` → "example.com" — the namespace the
 *  registry verified ownership of, shown beside every registry result so the human knows who published it */
export function publisherOf(name: string): string {
  const ns = name.split("/")[0] ?? name;
  if (ns.startsWith("io.github.")) return `github.com/${ns.slice("io.github.".length)}`;
  return ns.split(".").reverse().join(".");
}

/** one `{ server, _meta }` item → a MarketEntry; undefined when it is not an active, well-formed server */
export function entryFromRegistry(item: unknown, notes: string[]): MarketEntry | undefined {
  if (!isRecord(item) || !isRecord(item.server)) return undefined;
  const s = item.server;
  const name = str(s.name, 200);
  if (name === undefined || !/^[a-z0-9][a-z0-9.-]*\/[A-Za-z0-9._-]+$/.test(name)) return undefined;
  // the registry's own verdict on the listing (active · deprecated · deleted): a deleted server is gone,
  // anything else is kept WITH its status so the human sees "deprecated" before installing
  const meta = isRecord(item._meta) ? item._meta["io.modelcontextprotocol.registry/official"] : undefined;
  const status = isRecord(meta) ? str(meta.status, 32) : undefined;
  if (status === "deleted") return undefined;
  const installs: MarketInstall[] = [];
  for (const p of list(s.packages, LIMITS.packages)) { const i = installFromPackage(p, notes); if (i) installs.push(i); }
  for (const r of list(s.remotes, LIMITS.packages)) { const i = installFromRemote(r, notes); if (i) installs.push(i); }
  const out: MarketEntry = { key: name, description: str(s.description, LIMITS.desc) ?? "", source: "registry", publisher: publisherOf(name), installs };
  const title = str(s.title, 120), version = str(s.version, 64), home = httpUrl(s.websiteUrl);
  const repo = isRecord(s.repository) ? httpUrl(s.repository.url) : undefined;
  if (title !== undefined) out.title = title;
  if (version !== undefined) out.version = version;
  if (status !== undefined && status !== "active") out.status = status;
  if (repo !== undefined) out.repository = repo;
  if (home !== undefined) out.homepage = home;
  return out;
}

/** a list page → entries (deduped by name, capped at LIMITS.servers) */
/** The cursor for the NEXT page, if the registry says there is one. Kept apart from parseRegistryPage so
 *  that function's shape (and every caller of it) stays as it was. A cursor is opaque, so it is only
 *  length-capped and type-checked — never interpreted. */
export function nextCursorOf(json: unknown): string | undefined {
  if (!isRecord(json) || !isRecord(json.metadata)) return undefined;
  const c = json.metadata.nextCursor;
  return typeof c === "string" && c.length > 0 && c.length <= LIMITS.str ? c : undefined;
}

/** how many pages one search will follow. 5 x 50 = 250 servers is far past what a person reads, and the
 *  ceiling matters more than the reach: a cursor loop with no bound is a request amplifier pointed at us
 *  by whatever the registry returns. */
export const MAX_PAGES = 5;

export function parseRegistryPage(json: unknown, notes: string[]): MarketEntry[] {
  if (!isRecord(json)) { notes.push("registry: response is not an object"); return []; }
  const seen = new Set<string>(), out: MarketEntry[] = [];
  for (const item of list(json.servers, LIMITS.servers)) {
    const e = entryFromRegistry(item, notes);
    if (e && !seen.has(e.key)) { seen.add(e.key); out.push(e); }
  }
  return out;
}

// ------------------------------------------------------------------ cache (~/.rovecode/cache/mcp-market.json)

interface CacheFile { version: 1; queries: Record<string, { at: number; entries: MarketEntry[] }> }
export function cachePath(home: string): string { return join(home, "cache", "mcp-market.json"); }

function readCache(home: string): CacheFile {
  const path = cachePath(home);
  if (!existsSync(path)) return { version: 1, queries: {} };
  try {
    const json: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (isRecord(json) && json.version === 1 && isRecord(json.queries)) return json as unknown as CacheFile;
  } catch { /* a broken cache is an empty cache */ }
  return { version: 1, queries: {} };
}
function writeCache(home: string, cache: CacheFile): void {
  // keep the newest CACHE_QUERIES; the file is a convenience, never a source of truth
  const keep = Object.entries(cache.queries).sort((a, b) => b[1].at - a[1].at).slice(0, CACHE_QUERIES);
  try {
    mkdirSync(dirname(cachePath(home)), { recursive: true });
    writeFileSync(cachePath(home), JSON.stringify({ version: 1, queries: Object.fromEntries(keep) }) + "\n");
  } catch { /* read-only home: the search still answered */ }
}

// ------------------------------------------------------------------ registry client

async function registryGet(path: string, deps: MarketDeps): Promise<unknown> {
  const f = deps.fetch ?? fetch;
  const base = deps.registryUrl ?? process.env.ROVECODE_MCP_REGISTRY ?? REGISTRY_URL;
  const res = await f(`${base}${path}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`registry answered ${res.status}`);
  const text = await res.text();
  if (text.length > LIMITS.body) throw new Error(`registry response too large (${text.length} bytes)`);
  return JSON.parse(text) as unknown;
}

/** cache-through: a fresh cached answer is served as is; otherwise the network, then the cache; a
 *  failed network falls back to a STALE cached answer with a note, else to nothing with the reason */
async function cached(key: string, load: () => Promise<MarketEntry[]>, deps: MarketDeps, notes: string[]): Promise<{ entries: MarketEntry[]; fromCache: boolean }> {
  const home = deps.home ?? rovecodeHome(), now = (deps.now ?? Date.now)();
  const cache = readCache(home), hit = cache.queries[key];
  if (hit && now - hit.at < CACHE_TTL_MS) return { entries: hit.entries, fromCache: true };
  if (deps.offline) { if (hit) notes.push("offline: showing cached registry results"); return { entries: hit?.entries ?? [], fromCache: hit !== undefined }; }
  try {
    const entries = await load();
    cache.queries[key] = { at: now, entries };
    writeCache(home, cache);
    return { entries, fromCache: false };
  } catch (err) {
    notes.push(`registry unreachable (${message(err)})${hit ? " — showing cached results" : ""}`);
    return { entries: hit?.entries ?? [], fromCache: hit !== undefined };
  }
}

/** curated first (all of them for an empty query; substring on key/title/description otherwise), then
 *  the registry's name matches for a query of two+ characters, minus anything the curated list already names */
export async function searchMarket(query: string, deps: MarketDeps = {}): Promise<MarketResult> {
  const notes: string[] = [];
  const q = query.trim().toLowerCase();
  const catalog = deps.catalog ?? CURATED;
  const words = q.split(/\s+/).filter(Boolean);
  const curated = catalog.filter((e) => words.every((w) => `${e.key} ${e.title ?? ""} ${e.description}`.toLowerCase().includes(w)));
  if (q.length < 2) return { entries: curated, notes, fromCache: false };
  const { entries, fromCache } = await cached(`search:${q}`, async () => {
    // FOLLOW THE CURSOR. A single page was not a smaller result, it was a WRONG one: the registry answers
    // "here are the first 50 and there is more", and stopping there tells the human their server does not
    // exist when it is on page two. Bounded three ways — page count, total entries, and a cursor that must
    // actually change — because a paginating client that trusts the server's cursor can be walked forever.
    const parseNotes: string[] = [];
    const all: MarketEntry[] = [];
    const seenKeys = new Set<string>();   // parseRegistryPage dedupes WITHIN a page; this spans pages
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const url = `/servers?search=${encodeURIComponent(q)}&version=latest&limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const json = await registryGet(url, deps);
      for (const e of parseRegistryPage(json, parseNotes)) {
        if (seenKeys.has(e.key)) continue;
        seenKeys.add(e.key);
        all.push(e);
      }
      if (all.length >= LIMITS.servers) break;
      const next = nextCursorOf(json);
      if (next === undefined || seenCursors.has(next)) break;   // no more, or the registry is looping us
      seenCursors.add(next);
      cursor = next;
    }
    return all.slice(0, LIMITS.servers);
  }, deps, notes);
  const taken = new Set(curated.flatMap((e) => [e.key, ...(e.repository ? [e.repository] : [])]));
  return { entries: [...curated, ...entries.filter((e) => !taken.has(e.key) && !(e.repository && taken.has(e.repository)))], notes, fromCache };
}

/** one entry by key: the curated one if the key is a curated short name, else the registry's latest version */
export async function marketInfo(key: string, deps: MarketDeps = {}): Promise<{ entry?: MarketEntry; notes: string[] }> {
  const notes: string[] = [];
  const name = key.trim();
  const catalog = deps.catalog ?? CURATED;
  const hit = catalog.find((e) => e.key === name);
  if (hit) return { entry: hit, notes };
  if (!name.includes("/")) { notes.push(`"${name}" is not a curated name and not a registry name (those look like io.github.owner/repo) — try: rovecode mcp search ${name}`); return { notes }; }
  const { entries } = await cached(`info:${name}`, async () => {
    const json = await registryGet(`/servers/${encodeURIComponent(name)}/versions/latest`, deps);
    const e = entryFromRegistry(json, notes);
    return e ? [e] : [];
  }, deps, notes);
  const entry = entries[0];
  if (!entry && notes.length === 0) notes.push(`"${name}" is not in the registry`);
  return entry ? { entry, notes } : { notes };
}

/** what a stdio install runs / an http install connects to — one line, exact, for lists and cards */
export function installLabel(i: MarketInstall): string {
  return i.kind === "stdio" ? [i.command, ...i.args].join(" ") : i.url;
}
