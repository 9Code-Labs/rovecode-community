/** One market, three kinds. `rovecode market …`, the sextant's /market and the site's market page all read
 *  the SAME item type: an MCP server, a skill and a plugin differ in what installing them means, not in how
 *  they are found, described or shown.
 *
 *  Design rules this file exists to hold:
 *  - MCP is WRAPPED, never rewritten: `install.kind === "mcp"` carries the existing `MarketEntry`
 *    (src/mcp/market.ts) untouched, so the curated shelf, the registry re-typing and the install planner
 *    keep working exactly as they do today. A new kind is a new arm of `InstallSpec`, not a new pipeline.
 *  - Everything a UI needs to draw a row is on the item itself (title, publisher, one line, tags, version,
 *    source). Anything that needs the local filesystem — installed? update available? — is a separate
 *    `InstalledState`, because it changes without the catalog changing.
 *  - Catalog data is UNTRUSTED. These types describe what a validator PRODUCES (registry.ts), never what a
 *    response happens to contain. The caps live here so every source is bounded the same way.
 *  - Nothing here reads a file, spawns a process or touches the network: types + pure helpers only, so
 *    importing this module costs nothing at boot (the lazy-import rule). */

import type { MarketEntry } from "../mcp/market.ts";

export type MarketKind = "mcp" | "skill" | "plugin";
/** where the item was found. "curated" = built into rovecode, hand-checked; "registry" = a live remote
 *  index (the MCP registry today); "catalog" = a rovecode-published catalog file for skills and plugins */
export type MarketSource = "curated" | "registry" | "catalog";
/** user = ~/.rovecode (every project sees it) · project = this repo (trust-gated, committed with the repo) */
export type MarketScope = "user" | "project";

/** Hard ceilings on anything a source contributes. A field past its cap is truncated (strings) or dropped
 *  (list items) — never an error, because one bad row must not blank a whole catalog. */
export const LIMITS = {
  /** response body accepted from a remote catalog */
  body: 2 * 1024 * 1024,
  /** items accepted from one source */
  items: 200,
  /** any short string (id, title, publisher, version, url) */
  str: 300,
  /** the one-line description a row shows */
  desc: 500,
  /** tags per item, and files per skill */
  list: 32,
  /** environment variables one item may declare */
  env: 24,
  /** an item's documentation body: markdown, not a label. Nothing else here is remotely this big, which is
   *  exactly why it needs its own cap — run a 24 KB body through `str()` and it comes back silently cut to
   *  300 characters, still a valid string, and nobody notices. */
  docs: 24 * 1024,
} as const;

/** An item's own documentation, fetched at BUILD time and carried in the catalog.
 *
 *  Never fetched at runtime. The market has to work offline and the site's page is static, and pulling
 *  third-party text into a UI at display time is not something worth doing for a docs pane. The body is
 *  carried as TEXT and nothing more: it is never executed, never evaluated, never parsed as HTML here —
 *  each surface renders it safely on its own side.
 *
 *  Absent when upstream had no readable doc. A row without docs is a normal row, not a broken one. */
export interface ItemDocs {
  /** the exact URL it was read from, so a reader can go to the original */
  source: string;
  format: "markdown";
  /** the body's length in bytes BEFORE truncation, so a UI can say how much is missing */
  bytes: number;
  truncated: boolean;
  /** Markdown text, capped at LIMITS.docs. OPTIONAL on purpose: the search path does not carry bodies
   *  (they are ~200 KB the search never reads), so a row from `searchMarket` has the metadata and
   *  `body === undefined`. `undefined` means "not carried on this call" and is not the same as an empty
   *  document — a UI must send the reader to `market docs <id>` rather than say there is nothing. */
  body?: string;
}

/** An environment variable an item needs. Same shape the MCP side already uses (mcp/market.ts EnvSpec):
 *  `secret: true` is asked masked on a shell and NEVER written into a project file — it is written as
 *  `${NAME}` and read from the environment at launch. */
export interface MarketEnv {
  name: string;
  description?: string;
  required: boolean;
  secret: boolean;
  /** a value the catalog already knows (a default port, a public URL): not a question */
  default?: string;
}

/** What installing this item actually does. One arm per kind — the arm carries whatever the kind's existing
 *  installer needs, so `install.ts` can delegate without re-deriving anything. */
export type InstallSpec =
  /** the MCP entry as mcp/market.ts produced it; mcp/market-install.ts plans and writes it */
  | { kind: "mcp"; entry: MarketEntry }
  /** a plugin folder or git URL; src/plugins/install.ts addPlugin() clones and copies it.
   *  `subfolder` is where the plugin.json lives inside that repo — real plugins live in a monorepo
   *  (plugins/safety-net), so a repo root is the exception, not the rule. Same escape rules as a skill's. */
  | { kind: "plugin"; source: string; /** true when `source` is a git URL rather than a local folder */ git: boolean; subfolder?: string }
  /** a skill: a git repo (optionally a subfolder) or a set of files written verbatim.
   *  `files` is the offline form — a curated skill ships its SKILL.md in the catalog itself. */
  | { kind: "skill"; source?: { git: string; subfolder?: string }; files?: { path: string; text: string }[] };

/** One row in the market, whatever its kind. */
export interface MarketItem {
  /** what `market install <id>` takes. Unique per kind, not across kinds: `mcp:git` and `skill:git` may
   *  both exist, which is why resolve.ts accepts `kind:id` and lists candidates when a bare id is ambiguous. */
  id: string;
  kind: MarketKind;
  /** display name; falls back to `id` when a source has none */
  title: string;
  /** who publishes it — a namespace, an org, or "unknown" */
  publisher: string;
  /** one line, already capped at LIMITS.desc */
  description: string;
  source: MarketSource;
  version?: string;
  repository?: string;
  homepage?: string;
  /** free-form, lowercase, capped; a UI may filter on these but must not depend on any particular tag */
  tags: string[];
  /** the source's own status when it is anything but normal ("deprecated", "experimental") */
  status?: string;
  /** the licence as the publisher states it ("Apache-2.0", "source-available, not open source", "none stated").
   *  A field, not a note: a market that installs other people's work has to show this before the yes, and a
   *  UI will want to filter on it. Free text — an SPDX id is common but not required. */
  license?: string;
  /** the variables this item needs before it can run. Empty for most skills and plugins. */
  env: MarketEnv[];
  install: InstallSpec;
  /** the item's own documentation, carried in the catalog — see ItemDocs */
  docs?: ItemDocs;
  /** extra lines a catalog wants in the approval preview, in its own words ("copies one SKILL.md, runs
   *  nothing"). install.ts writes the standard plan from `install`; these are appended verbatim, capped
   *  like every other list. A catalog that has nothing special to say omits them. */
  planNote?: string[];
  /** what a plugin brings, as data rather than as a sentence: "commands", "skills", "agents", "hooks",
   *  "mcpServers", "tools". The catalog has carried this since the generator was written, but only the
   *  prose form ("contributes: commands, skills") ever reached a reader — so a caller wanting to filter
   *  on it had to parse English. The prose stays for the approval preview, which is written for a
   *  person; this is the same fact for anything that has to choose between two candidates. It describes
   *  what the catalog CLAIMS, exactly like every other field here, and is no more verified than they are. */
  contributes?: string[];
}

/** Local truth about one item, computed from disk (never from a catalog). Kept apart from `MarketItem`
 *  because it changes when the user installs something, not when the catalog updates. Its PRESENCE on a
 *  row means installed — `row.installed === undefined` is the not-installed case, so a UI draws the badge
 *  from one check and never from a boolean that could disagree with the path. */
export interface InstalledState {
  /** where it landed: the mcp.json, the plugin folder, the skill folder */
  path: string;
  scope: MarketScope;
  /** the version on disk when it is knowable (a plugin manifest, an mcp entry's recorded version) */
  version?: string;
  /** true when the catalog's version is a different string from the installed one. Not a semver compare:
   *  a UI says "update available", the human reads both numbers. */
  updateAvailable?: boolean;
  /** project-scope items only: the trust gate's answer. `undefined` for user scope, which is never gated. */
  trusted?: boolean;
}

/** A market row as a UI receives it: the catalog item plus what this machine knows about it.
 *  `installed` present = on disk here; absent = not installed. */
export interface MarketRow extends MarketItem {
  installed?: InstalledState;
}

// ---------------------------------------------------------------- results, never exceptions

/** Why a source produced nothing. A UI draws these differently, so they are distinguishable values and not
 *  one error string: `offline` and `stale` still carry rows, `failed` carries the reason. */
export type SourceStatus =
  | { ok: true; from: "live" }
  /** the network was not tried (--offline, no network): rows come from the cache or the curated shelf */
  | { ok: true; from: "cache"; ageMs: number }
  | { ok: true; from: "curated" }
  /** the source was not consulted at all (an empty query never asks the registry): no rows, no failure */
  | { ok: true; from: "skipped"; why: string }
  /** the fetch failed and there was nothing cached: this source contributed no rows */
  | { ok: false; reason: string };

/** What every listing call returns. Never throws for a data problem — a caller that must distinguish
 *  "nothing matched" from "the registry is down" reads `sources`. */
export interface MarketResult {
  items: MarketItem[];
  /** one entry per source consulted, keyed by a stable name ("mcp:curated", "mcp:registry", "skills", "plugins") */
  sources: Record<string, SourceStatus>;
  /** human-readable notes worth showing once (a capped field, a dropped row, a stale cache) */
  notes: string[];
}

/** The three-step visibility the MCP market established, generalised: a plan is built and SHOWN, the human
 *  says yes, and only then is anything written. `preview` is the whole plan in the human's words. */
export interface InstallPlanView {
  item: MarketItem;
  /** where the write lands (an mcp.json, a plugins folder, a skills folder) */
  target: string;
  scope: MarketScope;
  /** the lines a CLI prints or a card shows — everything that must be seen before a yes */
  preview: string[];
  /** variables that will be asked (shell: masked for secrets) or written as `${NAME}` */
  asks: MarketEnv[];
  /** required values nobody can fill for the human (a directory to expose, a database URL) */
  pending: string[];
  /** true when this install replaces something already there */
  replaces?: string;
}

export type InstallOutcome =
  | { ok: true; item: MarketItem; target: string; scope: MarketScope;
      /** variable names the written config now refers to; the human must export them before a restart */
      envNames: string[];
      /** project scope only: whether the write was recorded as trusted */
      trusted?: boolean;
      /** MCP only: `<…>` placeholders the written entry still carries because nobody answered for them; the
       *  loader skips the server until a hand replaces them, so `next` says that instead of "restart" */
      fillIn?: string[];
      /** MCP install-once only (mcp/local-package.ts): the package npm put on disk, as recorded in
       *  installed.json — `missing` names anything the record could not carry (an integrity hash the lockfile
       *  did not supply), so a caller can say so rather than print a clean line over a hole */
      package?: { name: string; version: string; prefix: string; bin: string; integrity?: string; missing?: string[] };
      /** what the human must do for it to take effect ("restart rovecode — servers are read once per process") */
      next?: string }
  | { ok: false; error: string };

// ---------------------------------------------------------------- pure helpers (no I/O)

/** `mcp:filesystem` → {kind, id}; a bare word → {id} with no kind. Anything else → null. */
export function parseQualifiedId(text: string): { kind?: MarketKind; id: string } | null {
  const t = text.trim();
  if (t.length === 0 || t.length > LIMITS.str) return null;
  const m = /^(mcp|skill|plugin):(.+)$/.exec(t);
  if (m) return { kind: m[1] as MarketKind, id: m[2]!.trim() };
  return { id: t };
}

export const qualify = (item: Pick<MarketItem, "kind" | "id">): string => `${item.kind}:${item.id}`;

/** The one-line row every surface shows. Kept here so the CLI, the TUI and the site cannot drift. */
export function itemLine(item: MarketItem): string {
  const bits = [item.kind.padEnd(6), item.title];
  if (item.version) bits.push(item.version);
  bits.push(`· ${item.publisher}`);
  return `${bits.join(" ")} — ${item.description}`;
}
