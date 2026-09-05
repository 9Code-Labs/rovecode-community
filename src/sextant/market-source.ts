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

import type { MarketPlan, MarketStatus, MarketViewRow } from "./draw-market.ts";

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
  | { ok: true; item: Item; target: string; scope: "user" | "project"; envNames: string[]; trusted?: boolean; next?: string }
  | { ok: false; error: string };

/** the module's public surface, as much of it as the overlay uses (src/market/registry.ts + install.ts;
 *  there is no barrel file, so the two are imported separately) */
interface RegistryModule {
  searchMarket(query: string, deps?: { offline?: boolean }): Promise<Result>;
}
interface InstallModule {
  planInstall(item: Item, opts: { scope: "user" | "project"; cwd: string; home: string }): PlanView | { error: string };
  runInstall(plan: PlanView, answers: Record<string, string>, opts: { scope: "user" | "project"; cwd: string; home: string }, deps?: unknown): Promise<Outcome>;
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

export function toViewRow(row: Row): MarketViewRow {
  return {
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
  };
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

/** the plan for one row, or the reason there is none. Writes nothing. */
export async function planFor(row: MarketViewRow, ctx: { scope: "user" | "project"; cwd: string; home: string }): Promise<MarketPlan | { error: string }> {
  const mod = await load();
  if (!mod) return { error: NOT_WIRED };
  const result = await mod.registry.searchMarket(row.id, { offline: true });
  const item = result.items.find((i) => i.kind === row.kind && i.id === row.id);
  if (!item) return { error: `${row.kind}:${row.id} is not in the catalog any more` };
  const plan = mod.install.planInstall(item, ctx);
  if ("error" in plan) return { error: plan.error };
  return {
    title: `${plan.item.kind}:${plan.item.id} — ${plan.item.title}`,
    target: plan.target,
    scope: plan.scope,
    preview: plan.preview,
    asks: plan.asks.map((a) => ({ name: a.name, required: a.required, secret: a.secret })),
    pending: plan.pending,
    ...(plan.replaces !== undefined ? { replaces: plan.replaces } : {}),
  };
}

/** Run a plan the human has just confirmed. The overlay only ever sees the outcome sentence. */
export async function install(row: MarketViewRow, ctx: { scope: "user" | "project"; cwd: string; home: string }): Promise<{ ok: boolean; text: string }> {
  const mod = await load();
  if (!mod) return { ok: false, text: NOT_WIRED };
  const result = await mod.registry.searchMarket(row.id, { offline: true });
  const item = result.items.find((i) => i.kind === row.kind && i.id === row.id);
  if (!item) return { ok: false, text: `${row.kind}:${row.id} is not in the catalog any more` };
  const plan = mod.install.planInstall(item, ctx);
  if ("error" in plan) return { ok: false, text: plan.error };
  // a plan with unanswered questions cannot be finished inside the overlay: a secret must be typed on a
  // shell, masked, not into a TUI query line. The overlay says so and hands the exact command over.
  if (plan.asks.length > 0 || plan.pending.length > 0) {
    return { ok: false, text: `needs answers — run: rovecode market install ${item.kind}:${item.id}` };
  }
  const outcome = await mod.install.runInstall(plan, {}, ctx);
  if (!outcome.ok) return { ok: false, text: outcome.error };
  const bits = [`installed into ${outcome.target}`];
  if (outcome.envNames.length) bits.push(`export ${outcome.envNames.join(", ")}`);
  if (outcome.next) bits.push(outcome.next);
  return { ok: true, text: bits.join(" · ") };
}
