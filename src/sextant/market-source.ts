/** The seam between the market overlay and the market module.
 *
 *  draw-market.ts is pure over (state, screen): it takes rows and a status and never fetches. This file is
 *  the only place that knows src/market/ exists — it lazily imports the module (the boot rule: nothing in
 *  the market's dependency tree is loaded until someone opens /market), maps src/market/types.ts onto the
 *  overlay's flattened view rows, and turns every failure into a status the overlay can draw.
 *
 *  Nothing here throws for a data problem, because the module it wraps does not either: a source that fails
 *  comes back as `SourceStatus {ok:false, reason}` and is shown as the error state, a source answered from
 *  the cache is shown as the offline state with its age, and an install that fails is a `{ok:false, error}`
 *  outcome printed on the plan card. The one thing this file DOES guard is the module not being there yet:
 *  while src/market/ is being written (types.ts landed first), an absent registry.ts must read as "the
 *  market module is not wired yet", not as a crash in the middle of a frame. */

import type { MarketDocLine, MarketPlan, MarketStatus, MarketViewRow } from "./draw-market.ts";
import { npxPackage } from "../mcp/local-package.ts";
import type { MarketInstall } from "../mcp/market.ts";

/** what the overlay needs to open: the rows, why they are what they are, and anything worth saying once */
export interface MarketLoad {
  rows: MarketViewRow[];
  status: MarketStatus;
  notes: string[];
}

/** src/market/types.ts, structurally — declared here so this file compiles before the module lands and so
 *  the overlay never imports the market's types directly */
interface Env { name: string; description?: string; required: boolean; secret: boolean; default?: string }
interface Item {
  id: string; kind: "mcp" | "skill" | "plugin"; title: string; publisher: string; description: string;
  version?: string; repository?: string; homepage?: string; tags: string[]; status?: string;
  env: Env[]; install: unknown; planNote?: string[];
  /** the item's own documentation, as the catalog carries it (nimbus-24's writer): third-party markdown */
  docs?: { source: string; format: string; bytes: number; truncated: boolean; body: string };
}
interface Row extends Item {
  installed?: { path: string; scope: "user" | "project"; version?: string; updateAvailable?: boolean; trusted?: boolean };
}
type Status =
  | { ok: true; from: "live" }
  | { ok: true; from: "cache"; ageMs: number }
  | { ok: true; from: "curated" }
  /** the source was not consulted at all (an empty query never asks the registry, --offline skips it) */
  | { ok: true; from: "skipped"; why: string }
  | { ok: false; reason: string };
interface Result { items: Item[]; sources: Record<string, Status>; notes: string[] }
interface PlanView {
  item: Item; target: string; scope: "user" | "project"; preview: string[];
  asks: Env[]; pending: string[]; replaces?: string;
}
type Outcome =
  | { ok: true; item: Item; target: string; scope: "user" | "project"; envNames: string[]; trusted?: boolean; next?: string;
      /** install-once: what npm put on disk (src/market/types.ts InstallOutcome.package) */
      package?: { name: string; version: string; prefix: string; integrity?: string; missing?: string[] } }
  | { ok: false; error: string };
/** the plan/install options the overlay passes through; `local` is the chooser's answer (mcp/local-package.ts) */
interface Ctx { scope: "user" | "project"; cwd: string; home: string; local?: boolean }

/** the module's public surface, as much of it as the overlay uses (src/market/registry.ts + install.ts;
 *  there is no barrel file, so the two are imported separately) */
interface RegistryModule {
  searchMarket(query: string, deps?: { offline?: boolean; withDocs?: boolean }): Promise<Result>;
  /** one item WITH its documentation body: search and list deliberately leave the bodies out (they are
   *  hundreds of kilobytes the list never reads), so the docs pane asks for the row it is about to show */
  findItem(kind: "mcp" | "skill" | "plugin", id: string, deps?: { offline?: boolean }): Promise<{ item?: Item; notes: string[] }>;
}
interface InstallModule {
  planInstall(item: Item, opts: Ctx): PlanView | { error: string };
  runInstall(plan: PlanView, answers: Record<string, string>, opts: Ctx, deps?: unknown): Promise<Outcome>;
  withInstalled(items: readonly Item[], cwd: string, home: string): Row[];
}

/** "the market module is not wired yet" rather than an exception mid-frame */
const NOT_WIRED = "the market module is not available in this build (src/market/ is still landing)";

async function load(): Promise<{ registry: RegistryModule; install: InstallModule } | null> {
  try {
    // two lazy imports, resolved at call time so a missing file is a null, not a boot failure
    const [registry, install] = await Promise.all([
      import("../market/registry.ts") as Promise<Partial<RegistryModule>>,
      import("../market/install.ts") as Promise<Partial<InstallModule>>,
    ]);
    if (typeof registry.searchMarket !== "function" || typeof install.planInstall !== "function") return null;
    return { registry: registry as RegistryModule, install: install as InstallModule };
  } catch {
    return null;
  }
}

/** what an item runs once installed, in one line — the install spec's own words, per arm */
function runsLine(item: Item): string {
  const spec = item.install as { kind?: string; entry?: { installs?: { kind?: string; url?: string; command?: string; args?: string[]; runtime?: string }[] }; source?: unknown; git?: boolean; files?: { path: string }[] } | undefined;
  if (!spec) return "";
  if (spec.kind === "mcp") {
    const first = spec.entry?.installs?.[0];
    if (!first) return "";
    return first.kind === "http" ? `remote ${first.url ?? ""}` : [first.command, ...(first.args ?? [])].join(" ");
  }
  if (spec.kind === "plugin") return `${spec.git ? "clone" : "copy"} ${String(spec.source ?? "")}`;
  if (spec.kind === "skill") {
    if (spec.files?.length) return `${spec.files.length} file(s), written verbatim — runs nothing`;
    const src = spec.source as { git?: string; subfolder?: string } | undefined;
    return src?.git ? `clone ${src.git}${src.subfolder ? ` (${src.subfolder})` : ""}` : "a SKILL.md the model reads when it matches";
  }
  return "";
}

/** the other ways in an MCP entry offers (a remote endpoint beside a local runtime) */
function alternatives(item: Item): string[] {
  const spec = item.install as { kind?: string; entry?: { installs?: { kind?: string; url?: string; command?: string; args?: string[]; runtime?: string }[] } } | undefined;
  if (spec?.kind !== "mcp") return [];
  return (spec.entry?.installs ?? []).slice(1).map((i) => (i.kind === "http" ? `remote ${i.url ?? ""}` : `${i.runtime ?? "stdio"}: ${[i.command, ...(i.args ?? [])].join(" ")}`));
}

/** the npm package an mcp row's first form would run through npx — the install-once offer's subject */
function localOfferOf(item: Item): string | undefined {
  const spec = item.install as { kind?: string; entry?: { installs?: unknown[] } } | undefined;
  if (spec?.kind !== "mcp") return undefined;
  const first = spec.entry?.installs?.[0];
  if (first === undefined || typeof first !== "object" || first === null) return undefined;
  return npxPackage(first as MarketInstall)?.spec;
}

export function toViewRow(row: Row): MarketViewRow {
  const localOffer = localOfferOf(row);
  return {
    ...(localOffer !== undefined ? { localOffer } : {}),
    id: row.id,
    kind: row.kind,
    title: row.title,
    publisher: row.publisher,
    description: row.description,
    ...(row.version !== undefined ? { version: row.version } : {}),
    runs: runsLine(row),
    env: row.env.map((v) => ({ name: v.name, required: v.required, secret: v.secret, ...(v.description !== undefined ? { description: v.description } : {}) })),
    alternatives: alternatives(row),
    pending: row.planNote ?? [],
    ...(row.installed ? { installed: row.installed } : {}),
    // search carries the metadata, not the body: the pane fills `lines` from docsFor() when it opens
    ...(row.docs ? { docs: { source: row.docs.source, truncated: row.docs.truncated === true, lines: typeof row.docs.body === "string" && row.docs.body !== "" ? docLines(row.docs.body) : [] } } : {}),
  };
}

/** ESC and the rest of C0 (tab and newline excepted), DEL, and the C1 range some terminals still read
 *  as CSI — a document must not be able to move the cursor, change a colour or clear the screen */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

/** A document, flattened to lines a cockpit can draw and stripped of everything a terminal would obey.
 *  The body is third-party text, so escape sequences and control characters go before anything else; then
 *  markdown is flattened rather than rendered — headings and fenced code keep their shape, and the rest is
 *  prose wrapped to a column. A README must not be able to move the cursor or repaint the screen. */
export function docLines(body: string, width = 96): MarketDocLine[] {
  const safe = body
    .replace(/\r\n?/g, "\n")
    .replace(/<(script|style|iframe|object|embed|template|noscript)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<\/?[a-zA-Z][^>]*>/g, "")
    .replace(CONTROL, "")
    .replace(/\t/g, "  ")
    .replace(/^---\n[\s\S]*?\n---\n/, "");
  const out: MarketDocLine[] = [];
  let fence = false;
  for (const raw of safe.split("\n")) {
    if (/^\s*```/.test(raw)) { fence = !fence; out.push({ kind: "rule", text: "" }); continue; }
    if (fence) { out.push({ kind: "code", text: raw.slice(0, width) }); continue; }
    const h = /^(#{1,6})\s+(.*)$/.exec(raw);
    if (h) { out.push({ kind: "head", text: h[2]!.replace(/[`*]/g, "").slice(0, width) }); continue; }
    const text = raw.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[`*]/g, "");
    if (text.trim() === "") { out.push({ kind: "blank", text: "" }); continue; }
    let line = "";
    for (const word of text.split(/\s+/).filter(Boolean)) {
      const piece = word.length > width ? word.slice(0, width) : word;
      if (!line) { line = piece; continue; }
      if (line.length + 1 + piece.length <= width) line += ` ${piece}`;
      else { out.push({ kind: "text", text: line }); line = piece; }
    }
    if (line) out.push({ kind: "text", text: line });
  }
  return out;
}

/** the three drawn states, decided from the sources the module consulted — never from an empty list */
export function statusFrom(sources: Record<string, Status>): MarketStatus {
  const failed = Object.entries(sources).filter(([, v]) => !v.ok) as [string, { ok: false; reason: string }][];
  if (failed.length) {
    const [name, s] = failed[0]!;
    return { kind: "error", reason: failed.length === 1 ? `${name}: ${s.reason}` : `${name}: ${s.reason} (+${failed.length - 1} more)` };
  }
  const cached = Object.values(sources).find((v) => v.ok && v.from === "cache") as { ok: true; from: "cache"; ageMs: number } | undefined;
  if (cached) {
    const mins = Math.round(cached.ageMs / 60000);
    return { kind: "offline", note: `showing cached results${mins > 0 ? `, ${mins}m old` : ""}` };
  }
  // "skipped" is not a failure and not staleness: the source was left out on purpose, and `why` says so.
  // It is worth one line because a reader who does not see a registry row deserves to know it was not asked.
  const skipped = Object.values(sources).find((v) => v.ok && v.from === "skipped") as { ok: true; from: "skipped"; why: string } | undefined;
  if (skipped) return { kind: "offline", note: skipped.why };
  return { kind: "ready" };
}

/** Everything the overlay opens with. `offline` forces the no-network path (the curated shelf and the
 *  repository catalogs), which is also what a failed network falls back to. */
export async function loadMarket(cwd: string, home: string, opts: { offline?: boolean } = {}): Promise<MarketLoad> {
  const mod = await load();
  if (!mod) return { rows: [], status: { kind: "error", reason: NOT_WIRED }, notes: [] };
  const result = await mod.registry.searchMarket("", opts.offline === true ? { offline: true } : {});
  // installed state is disk truth, joined onto the catalog by withInstalled (never read from a catalog)
  let rows: Row[] = result.items as Row[];
  try { rows = mod.install.withInstalled(result.items, cwd, home); } catch { /* disk unreadable: the rows still list */ }
  return { rows: rows.map(toViewRow), status: statusFrom(result.sources), notes: result.notes };
}

/** The documentation for one row, fetched when the reader asks for it.
 *
 *  `searchMarket` carries docs METADATA but not the bodies — they are ~400 KB nobody reads while browsing —
 *  so the list cannot fill this in advance. `findItem` reads the one row with its body, and the body is
 *  flattened to terminal-safe lines here, once, at the moment the pane opens. */
export async function docsFor(row: MarketViewRow): Promise<{ source: string; truncated: boolean; lines: MarketDocLine[] } | null> {
  const mod = await load();
  if (!mod || typeof mod.registry.findItem !== "function") return null;
  const { item } = await mod.registry.findItem(row.kind, row.id, { offline: true });
  const docs = item?.docs;
  if (!docs || typeof docs.body !== "string" || docs.body.trim() === "") return null;
  return { source: docs.source, truncated: docs.truncated === true, lines: docLines(docs.body) };
}

/** the plan for one row, or the reason there is none. Writes nothing. `local` is the chooser's answer for an npx
 *  row: true draws the install-once plan (`node <bin>`, the `installs`/`records` rows), false or absent the npx
 *  line as today — and the plan remembers it, so the install runs the plan that was approved. */
export async function planFor(row: MarketViewRow, ctx: Ctx, local?: boolean): Promise<MarketPlan | { error: string }> {
  const mod = await load();
  if (!mod) return { error: NOT_WIRED };
  const result = await mod.registry.searchMarket(row.id, { offline: true });
  const item = result.items.find((i) => i.kind === row.kind && i.id === row.id);
  if (!item) return { error: `${row.kind}:${row.id} is not in the catalog any more` };
  const plan = mod.install.planInstall(item, { ...ctx, ...(local === true ? { local: true } : {}) });
  if ("error" in plan) return { error: plan.error };
  return {
    row,
    title: `${plan.item.kind}:${plan.item.id} — ${plan.item.title}`,
    target: plan.target,
    scope: plan.scope,
    preview: plan.preview,
    asks: plan.asks.map((a) => ({ name: a.name, required: a.required, secret: a.secret })),
    pending: plan.pending,
    ...(plan.replaces !== undefined ? { replaces: plan.replaces } : {}),
    ...(local === true ? { local: true } : {}),
  };
}

/** Run a plan the human has just confirmed. The overlay only ever sees the outcome sentence. `opts.local` must be
 *  the approved plan's own `local` — npm runs here, and only here, after the card said yes. `opts.deps` is the
 *  installer's seam (a fake `npm` in tests). */
export async function install(row: MarketViewRow, ctx: Ctx, opts: { local?: boolean; deps?: unknown } = {}): Promise<{ ok: boolean; text: string }> {
  const mod = await load();
  if (!mod) return { ok: false, text: NOT_WIRED };
  const result = await mod.registry.searchMarket(row.id, { offline: true });
  const item = result.items.find((i) => i.kind === row.kind && i.id === row.id);
  if (!item) return { ok: false, text: `${row.kind}:${row.id} is not in the catalog any more` };
  const withLocal: Ctx = { ...ctx, ...(opts.local === true ? { local: true } : {}) };
  const plan = mod.install.planInstall(item, withLocal);
  if ("error" in plan) return { ok: false, text: plan.error };
  // A SECRET cannot be finished inside the overlay: it has to be typed on a shell, masked, not into a
  // query line that echoes. The overlay says so and hands the exact command over.
  //
  // `pending` is not that, and treating it as if it were made six of the sixteen curated MCP servers
  // uninstallable from the cockpit — including `filesystem`, which is the first one anybody tries.
  // Nothing is asked for a pending value: it is a placeholder the installer writes into the config
  // (`<directory the server may touch>`) for the human to replace afterwards, and the CLI installs it
  // exactly that way. Refusing here was the overlay inventing a requirement the installer does not have.
  if (plan.asks.length > 0) {
    const what = plan.asks.map((a) => a.name).join(", ");
    return { ok: false, text: `${what} must be typed where it can be masked — run: rovecode market install ${item.kind}:${item.id}` };
  }
  const outcome = await mod.install.runInstall(plan, {}, withLocal, opts.deps);
  if (!outcome.ok) return { ok: false, text: outcome.error };
  const bits = [`installed into ${outcome.target}`];
  if (outcome.package) {
    bits.push(`${outcome.package.name} ${outcome.package.version} installed once → ${outcome.package.prefix}${outcome.package.integrity !== undefined ? " (integrity recorded)" : ""}`);
    if (outcome.package.missing?.length) bits.push(`record incomplete: ${outcome.package.missing.join("; ")}`);
  }
  if (outcome.envNames.length) bits.push(`export ${outcome.envNames.join(", ")}`);
  // the placeholder is the one thing between this install and a working server, so it leads
  for (const p of plan.pending) bits.push(`fill in ${p}`);
  if (outcome.next) bits.push(outcome.next);
  return { ok: true, text: bits.join(" · ") };
}
