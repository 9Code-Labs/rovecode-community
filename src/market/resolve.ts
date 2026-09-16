/** What `market install <what>` means. One argument, five shapes, and the rule that an ambiguous name is
 *  never guessed:
 *    filesystem              a bare id — looked up in every kind; two kinds owning the name is a question,
 *                            not a coin toss (the caller prints the candidates and exits 2)
 *    mcp:filesystem          a qualified id — exact, no search
 *    https://…/repo.git      a git URL — a plugin by default (a plugin is a folder with a manifest, which
 *                            is what a repo usually is); `skill:<url>` says otherwise
 *    @scope/server-github    an npm package — an MCP server launched with npx, the way the registry's own
 *                            npm entries run
 *    ./some/folder           a local folder — a plugin, validated at install time by plugins/install.ts
 *  Nothing here touches the network except through `findItem`/`searchMarket`, and nothing here writes. */

import { parseQualifiedId, qualify, type InstallSpec, type MarketItem, type MarketKind } from "./types.ts";
import { findItem, searchMarket, type RegistryDeps } from "./registry.ts";
import { defaultServerName } from "../mcp/market-install.ts";

export type Resolution =
  /** exactly one item: install it */
  | { ok: true; item: MarketItem }
  /** the name exists in more than one kind — the human picks, we do not */
  | { ok: false; ambiguous: MarketItem[]; error: string }
  | { ok: false; error: string; ambiguous?: undefined };

const GIT_URL = /^(?:https?:\/\/|git@|ssh:\/\/|git:\/\/)|\.git$/i;
/** npm package name, scoped or not: @scope/name or name */
const NPM_PKG = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i;
const LOCAL_PATH = /^(?:\.{1,2}[\\/]|[A-Za-z]:[\\/]|[\\/])/;

const looksLikeGit = (s: string): boolean => GIT_URL.test(s);
const looksLikeLocalPath = (s: string): boolean => LOCAL_PATH.test(s);
/** an npm package only when it carries a scope or a dash — a bare word is an id first, always */
const looksLikeNpm = (s: string): boolean => NPM_PKG.test(s) && (s.startsWith("@") || s.includes("-"));

/** a synthetic item for something the human named directly (a URL, a package, a folder). It is not in any
 *  catalog, so it says so: publisher "unknown (you named it)" is the honest line above an approval card. */
function directItem(kind: MarketKind, id: string, install: InstallSpec, description: string): MarketItem {
  return { id, kind, title: id, publisher: "unknown (you named this source)", description, source: "catalog", tags: [], env: [], install };
}

export function resolveDirect(text: string, kind?: MarketKind): MarketItem | null {
  const s = text.trim();
  // The requested kind is honoured FIRST, every time. Ordering this by shape instead let
  // `resolveDirect("./my-skill", "skill")` fall into the local-folder branch and come back as a PLUGIN:
  // the human asks for a skill (text, nothing runs) and is handed code that rovecode loads into its own
  // process — and, in project scope, records as trusted. A kind that cannot serve the source says no.
  if (looksLikeGit(s)) {
    if (kind === "mcp") return null;   // an MCP server is a package or a URL, not a repo to clone
    return kind === "skill"
      ? directItem("skill", skillIdFromUrl(s), { kind: "skill", source: { git: s } }, `a skill cloned from ${s}`)
      : directItem("plugin", skillIdFromUrl(s), { kind: "plugin", source: s, git: true }, `a plugin cloned from ${s}`);
  }
  if (looksLikeLocalPath(s)) {
    // only a plugin can be installed from a local folder: a skill's install spec carries a git source or
    // literal files, and an MCP server is launched, not copied. Saying no is the honest answer.
    if (kind !== undefined && kind !== "plugin") return null;
    return directItem("plugin", s.split(/[\\/]/).filter(Boolean).pop() ?? "plugin", { kind: "plugin", source: s, git: false }, `a plugin copied from ${s}`);
  }
  if ((kind === undefined || kind === "mcp") && looksLikeNpm(s)) {
    // The id MUST be the name the server is written under, or nothing lines up afterwards: `market list`
    // would report it missing and `market remove <id>` would either refuse or delete a DIFFERENT curated
    // server that happens to own the shortened name. defaultServerName() is that name.
    const entry = {
      key: s, title: s, description: `an MCP server run with npx ${s}`, source: "registry" as const,
      publisher: s.startsWith("@") ? s.slice(1).split("/")[0]! : "unknown",
      installs: [{ kind: "stdio" as const, runtime: "npx" as const, command: "npx", args: ["-y", s], env: [], pending: [] }],
    };
    return directItem("mcp", defaultServerName(s), { kind: "mcp", entry }, `an MCP server run with npx ${s}`);
  }
  return null;
}

function skillIdFromUrl(u: string): string {
  const tail = u.replace(/\.git$/i, "").split(/[\\/]/).filter(Boolean).pop() ?? "item";
  return tail.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+/, "").slice(0, 64) || "item";
}

/** Resolve one `market install` argument. Catalog names win over direct sources: an id that a catalog owns
 *  is never re-interpreted as a package of the same name. */
export async function resolveTarget(text: string, deps: RegistryDeps = {}): Promise<Resolution> {
  const parsed = parseQualifiedId(text);
  if (parsed === null) return { ok: false, error: `"${text.slice(0, 60)}" is not something rovecode can install` };
  const { kind, id } = parsed;

  if (kind !== undefined) {
    const found = await findItem(kind, id, deps);
    if (found.item) return { ok: true, item: found.item };
    const direct = resolveDirect(id, kind);
    if (direct) return { ok: true, item: direct };
    return { ok: false, error: `no ${kind} called "${id}"${found.notes.length ? ` — ${found.notes[0]}` : ""}` };
  }

  // a bare word: ask every kind for an EXACT id, then decide
  const hits: MarketItem[] = [];
  for (const k of ["mcp", "skill", "plugin"] as const) {
    const r = await findItem(k, id, deps);
    if (r.item && r.item.id === id) hits.push(r.item);
  }
  if (hits.length === 1) return { ok: true, item: hits[0]! };
  if (hits.length > 1) {
    return { ok: false, ambiguous: hits, error: `"${id}" exists in ${hits.length} kinds — say which: ${hits.map(qualify).join(" · ")}` };
  }

  const direct = resolveDirect(id);
  if (direct) return { ok: true, item: direct };

  // nothing exact: offer what a search would have found, so the human is not left with "no"
  const near = await searchMarket(id, deps);
  const suggestions = near.items.slice(0, 5);
  if (suggestions.length === 0) return { ok: false, error: `nothing in the market matches "${id}"` };
  return { ok: false, ambiguous: suggestions, error: `no item is called "${id}" — did you mean: ${suggestions.map(qualify).join(" · ")}` };
}
