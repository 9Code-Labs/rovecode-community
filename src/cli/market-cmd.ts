/** `rovecode market …` — one command for all three kinds. search · info · install · remove · list ·
 *  update · sources, each with `--json` so a script or another surface reads the same data the terminal
 *  shows. A pure function over injected cwd/home/streams/prompts: tests drive it without a process, a
 *  network or a TTY.
 *
 *  The rule install lives by is the MCP market's, unchanged: the human SEES the plan — the exact command,
 *  the folder, the file list, the source, the publisher, what it will ask for — then says yes, on a
 *  terminal through y/N or in a script through `--yes`. Without a TTY and without --yes nothing is
 *  written. Secrets are asked by NAME through the masked prompt: never echoed, never on the command line,
 *  never into a project file (there they are written as `${NAME}` and read from the environment).
 *
 *  `rovecode mcp …` keeps working and is not deprecated here — it is the MCP-only door into the same
 *  code; `market` is the door that also sees skills and plugins. */

import { readSecret, rovecodeHome } from "../providers/auth.ts";
import { itemLine, qualify, type MarketItem, type MarketKind, type MarketRow, type MarketScope } from "../market/types.ts";
import { allItems, searchMarket, type RegistryDeps } from "../market/registry.ts";
import { resolveTarget } from "../market/resolve.ts";
import { installedState, planInstall, removeItem, runInstall, withInstalled, type PlanOptions, type RunDeps } from "../market/install.ts";
import { createInterface } from "node:readline";

export interface MarketCliDeps {
  cwd?: string;
  home?: string;
  out?: (line: string) => void;
  err?: (line: string) => void;
  /** source access (offline / fixture fetch / catalog paths) */
  registry?: RegistryDeps;
  /** how a clone runs, and force */
  run?: RunDeps;
  /** one masked line (default readSecret) */
  secret?: (prompt: string) => Promise<string>;
  /** one plain line (default: readline on stdin) */
  plain?: (prompt: string) => Promise<string>;
  /** default process.stdin.isTTY === true; a pipe is never consumed by a prompt */
  tty?: boolean;
}

export const MARKET_USAGE = [
  "usage: rovecode market <command>",
  "  search [query] [--kind mcp|skill|plugin]   every source at once: the curated MCP shelf, the MCP registry,",
  "                                             rovecode's skill and plugin catalogs (skills/plugins work offline)",
  "  info <id>                                  one item in full: publisher, version, what it installs, what it asks",
  "  docs <id>                                  the item's own documentation, as the catalog carries it",
  "  install <id|kind:id|git-url|npm-package> [--project] [--as <name>] [--pick N] [--yes] [--force]",
  "                                             shows the plan, asks (masked) for keys by name, then writes",
  "  remove <id|kind:id> [--project]            undo an install of any kind",
  "  list [--all]                               what is installed here (--all: the whole market, with badges)",
  "  update [id] [--all] [--yes]                what is out of date; with an id or --all: plan, approve, reinstall",
  "  sources                                    where rows come from right now, and whether each answered",
  "every command takes --json · --offline skips the network entirely",
  "an id is a bare slug inside its kind (filesystem); say mcp:filesystem when two kinds share a name",
];

/** a size a person reads, from a byte count */
const kb = (bytes: number): string => (bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`);

const jsonOut = (deps: MarketCliDeps, value: unknown): void => (deps.out ?? console.log)(JSON.stringify(value, null, 2));

function badge(row: MarketRow): string {
  if (!row.installed) return "";
  if (row.installed.updateAvailable) return `  [installed ${row.installed.version ?? "?"} · update ${"available"}]`;
  if (row.installed.trusted === false) return "  [installed · NOT approved on this machine]";
  return "  [installed]";
}

/** everything about one item, in the order a person asks it */
export function infoLines(item: MarketItem, cwd: string, home: string): string[] {
  const lines = [
    `${item.title}${item.version ? `  ${item.version}` : ""}${item.status ? `  [${item.status}]` : ""}`,
    `  id         ${qualify(item)}`,
    `  kind       ${item.kind === "mcp" ? "MCP server — rovecode launches it and the model gets its tools" : item.kind === "skill" ? "skill — instructions the model reads; files only, nothing runs" : "plugin — a folder of code rovecode loads and runs"}`,
    `  publisher  ${item.publisher}`,
    `  source     ${item.source === "curated" ? "curated list (built into rovecode)" : item.source === "registry" ? "MCP registry (registry.modelcontextprotocol.io)" : "rovecode catalog (in the repository)"}`,
    `  ${item.description}`,
  ];
  if (item.license) lines.push(`  licence    ${item.license}`);
  lines.push(item.docs
    ? `  docs       ${kb(item.docs.bytes)} from ${item.docs.source}${item.docs.truncated ? " (truncated)" : ""} — rovecode market docs ${qualify(item)}`
    : `  docs       none${item.repository ? ` — try ${item.repository}` : ""}`);
  if (item.repository) lines.push(`  repo       ${item.repository}`);
  if (item.homepage) lines.push(`  home       ${item.homepage}`);
  if (item.tags.length) lines.push(`  tags       ${item.tags.join(", ")}`);
  const { install } = item;
  if (install.kind === "mcp") {
    for (const i of install.entry.installs) lines.push(i.kind === "stdio" ? `  runs       ${i.command} ${i.args.join(" ")}` : `  connects   ${i.url}`);
  } else if (install.kind === "plugin") {
    lines.push(`  installs   ${install.git ? `git clone ${install.source}` : `copy of ${install.source}`}${install.subfolder ? ` (subfolder ${install.subfolder})` : ""}`);
  } else {
    lines.push(install.source ? `  installs   git clone ${install.source.git}${install.source.subfolder ? ` (${install.source.subfolder})` : ""}` : `  installs   ${(install.files ?? []).length} file(s) from the catalog`);
  }
  for (const e of item.env) lines.push(`  needs      ${e.name}${e.secret ? " (secret, asked masked)" : ""}${e.required ? "" : " (optional)"}${e.description ? ` — ${e.description}` : ""}`);
  const state = installedState(item, cwd, home);
  lines.push(state ? `  installed  ${state.path} (${state.scope}${state.version ? `, ${state.version}` : ""}${state.trusted === false ? ", NOT approved here" : ""})` : `  installed  no`);
  return lines;
}

/** ask for the plan's variables; null = the human said no or there is no way to ask */
async function askFor(plan: { asks: { name: string; secret: boolean; description?: string }[] }, deps: { secret: (p: string) => Promise<string>; plain: (p: string) => Promise<string>; tty: boolean; err: (l: string) => void }): Promise<Record<string, string>> {
  const answers: Record<string, string> = {};
  for (const a of plan.asks) {
    if (!deps.tty) { deps.err(`${a.name} is not set — it will be written as \${${a.name}} and read from your environment`); continue; }
    const label = `${a.name}${a.description ? ` (${a.description})` : ""}: `;
    const v = (await (a.secret ? deps.secret(label) : deps.plain(label))).trim();
    if (v.length > 0) answers[a.name] = v;
  }
  return answers;
}

/** One item, the whole ceremony: plan → show → ask → write. Shared by `install` and `update`, so an
 *  update can never become a quieter install that skips the preview. Returns the process exit code. */
async function installOne(item: MarketItem, opts: PlanOptions, ctx: {
  out: (l: string) => void; err: (l: string) => void; json: boolean; yes: boolean; tty: boolean;
  secret: (p: string) => Promise<string>; plain: (p: string) => Promise<string>;
  run: RunDeps; verb: string;
}): Promise<number> {
  const plan = planInstall(item, opts);
  if ("error" in plan) { ctx.err(plan.error); return 1; }
  for (const l of plan.preview) ctx.out(l);
  if (plan.replaces) ctx.out(`  replaces   ${plan.replaces}`);
  for (const p of plan.pending) ctx.out(`  fill in    ${p} — after the install, in ${plan.target}`);
  if (!ctx.yes) {
    if (!ctx.tty) { ctx.err(`nothing written: rerun on a terminal, or pass --yes to accept this plan in a script`); return 1; }
    const answer = (await ctx.plain(`${ctx.verb} this? [y/N] `)).trim().toLowerCase();
    if (answer !== "y" && answer !== "yes") { ctx.out("nothing written"); return 1; }
  }
  const answers = await askFor(plan, {
    secret: ctx.secret, plain: ctx.plain,
    // a project scope never takes a typed secret: it is written as ${NAME}
    tty: ctx.tty && !(opts.scope === "project" && plan.asks.some((a) => a.secret)), err: ctx.err,
  });
  const outcome = await runInstall(plan, answers, opts, ctx.run);
  if (!outcome.ok) { ctx.err(outcome.error); if (ctx.json) jsonOut({ out: ctx.out }, outcome); return 1; }
  if (ctx.json) { jsonOut({ out: ctx.out }, outcome); return 0; }
  ctx.out(`${ctx.verb === "update" ? "updated" : "installed"} ${qualify(item)} → ${outcome.target}${outcome.trusted === true ? " (trusted as written)" : ""}`);
  if (outcome.trusted === false) ctx.err(`that file already held entries you have not approved, so it is NOT trusted yet — rovecode mcp trust`);
  if (outcome.envNames.length) ctx.err(`set ${outcome.envNames.join(", ")} in your environment before the restart`);
  if (outcome.next) ctx.out(outcome.next);
  return 0;
}

export async function cmdMarket(args: string[], deps: MarketCliDeps = {}): Promise<number> {
  const out = deps.out ?? console.log;
  const err = deps.err ?? ((l: string) => console.error(l));
  const cwd = deps.cwd ?? process.cwd();
  const home = deps.home ?? rovecodeHome();
  const json = args.includes("--json");
  const offline = args.includes("--offline");
  const scope: MarketScope = args.includes("--project") ? "project" : "user";
  const registry: RegistryDeps = { ...deps.registry, ...(offline ? { offline: true } : {}) };
  const flag = (name: string): string | undefined => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const KNOWN = new Set(["--json", "--offline", "--project", "--yes", "--force", "--all", "--as", "--pick", "--kind"]);
  const positional = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && ["--as", "--pick", "--kind"].includes(args[i - 1]!)));
  for (const a of args) if (a.startsWith("--") && !KNOWN.has(a)) { err(`unknown flag ${a}`); err(MARKET_USAGE.join("\n")); return 2; }

  const sub = positional[0];
  if (sub === undefined || sub === "help") { (sub === undefined ? err : out)(MARKET_USAGE.join("\n")); return sub === undefined ? 2 : 0; }

  // ---------------- search
  if (sub === "search") {
    const kind = flag("--kind") as MarketKind | undefined;
    if (kind !== undefined && !["mcp", "skill", "plugin"].includes(kind)) { err(`--kind takes mcp, skill or plugin`); return 2; }
    const query = positional.slice(1).join(" ");
    const r = await searchMarket(query, registry);
    const items = kind ? r.items.filter((i) => i.kind === kind) : r.items;
    const rows = withInstalled(items, cwd, home);
    if (json) { jsonOut(deps, { items: rows, sources: r.sources, notes: r.notes }); return 0; }
    for (const n of r.notes) err(`market: ${n}`);
    if (rows.length === 0) {
      const dead = Object.entries(r.sources).filter(([, s]) => !s.ok);
      err(query ? `nothing matches "${query}"` : "the market is empty");
      for (const [name, s] of dead) if (!s.ok) err(`  ${name}: ${s.reason}`);
      return 1;
    }
    for (const row of rows) out(`${itemLine(row)}${badge(row)}`);
    return 0;
  }

  // ---------------- sources
  if (sub === "sources") {
    const r = await allItems(registry);
    if (json) { jsonOut(deps, { sources: r.sources, notes: r.notes, count: r.items.length }); return 0; }
    for (const [name, s] of Object.entries(r.sources)) {
      const how = !s.ok ? `FAILED — ${s.reason}`
        : s.from === "live" ? "answered just now"
        : s.from === "cache" ? `from the cache${s.ageMs ? ` (${Math.round(s.ageMs / 1000)}s old)` : ""}`
        : s.from === "skipped" ? `not consulted — ${s.why}`
        : "built in / on disk";
      out(`${name.padEnd(14)} ${how}`);
    }
    out(`${String(r.items.length).padStart(14)} items visible right now`);
    return Object.values(r.sources).every((s) => s.ok) ? 0 : 1;
  }

  // ---------------- list
  if (sub === "list") {
    const all = args.includes("--all");
    const r = await allItems(registry);
    const rows = withInstalled(r.items, cwd, home).filter((row) => all || row.installed);
    if (json) { jsonOut(deps, rows); return 0; }
    if (rows.length === 0) { out(all ? "the market is empty" : "nothing installed here yet — `rovecode market search` to look around"); return 0; }
    for (const row of rows) out(`${itemLine(row)}${badge(row)}`);
    return 0;
  }

  // ---------------- update
  if (sub === "update") {
    const r = await allItems(registry);
    const installed = withInstalled(r.items, cwd, home).filter((row) => row.installed);
    // "stale" is either a version that differs, or a version nobody can compare — a skill without one in
    // its SKILL.md is NOT silently skipped, it is offered as a reinstall and says why
    const stale = installed.filter((row) => row.installed!.updateAvailable === true || row.version === undefined || row.installed!.version === undefined);
    const which = positional[1];
    const all = args.includes("--all");

    if (which === undefined && !all) {           // the dry list
      if (json) { jsonOut(deps, stale); return 0; }
      if (stale.length === 0) { out("everything installed is at the catalog's version"); return 0; }
      for (const row of stale) {
        const from = row.installed!.version, to = row.version;
        out(from !== undefined && to !== undefined
          ? `${qualify(row)}  ${from} → ${to}`
          : `${qualify(row)}  version unknown (${from === undefined ? "nothing on disk says one" : "the catalog states none"}) — updating reinstalls it`);
      }
      out(`rovecode market update <id> · rovecode market update --all`);
      return 0;
    }

    let targets = stale;
    if (which !== undefined) {
      const pick = await resolveTarget(which, registry);
      if (!pick.ok) { err(pick.error); return pick.ambiguous ? 2 : 1; }
      const row = installed.find((x) => x.id === pick.item.id && x.kind === pick.item.kind);
      if (row === undefined) { err(`${qualify(pick.item)} is not installed here — rovecode market install ${qualify(pick.item)}`); return 1; }
      targets = [row];
    }
    if (targets.length === 0) { out("everything installed is at the catalog's version"); return 0; }

    const ctx = {
      out, err, json, yes: args.includes("--yes"), tty: deps.tty ?? process.stdin.isTTY === true,
      secret: deps.secret ?? readSecret, plain: deps.plain ?? defaultPlain, run: { ...deps.run, force: true }, verb: "update",
    };
    let worst = 0;
    for (const row of targets) {
      // an item is updated in the scope it is installed in, not the flag's default
      const opts: PlanOptions = { scope: row.installed!.scope, cwd, home };
      const code = await installOne(row, opts, ctx);
      if (code !== 0) worst = code;
    }
    return worst;
  }

  const target = positional[1];
  if (["info", "install", "remove", "docs"].includes(sub) && target === undefined) { err(`market ${sub} needs a name`); return 2; }

  // ---------------- info
  if (sub === "info") {
    const r = await resolveTarget(target!, registry);
    if (!r.ok) { err(r.error); if (json) jsonOut(deps, { error: r.error, candidates: r.ambiguous ?? [] }); return r.ambiguous ? 2 : 1; }
    if (json) { jsonOut(deps, { ...r.item, installed: installedState(r.item, cwd, home) }); return 0; }
    for (const l of infoLines(r.item, cwd, home)) out(l);
    return 0;
  }

  // ---------------- docs
  if (sub === "docs") {
    const r = await resolveTarget(target!, registry);
    if (!r.ok) { err(r.error); if (json) jsonOut(deps, { error: r.error, candidates: r.ambiguous ?? [] }); return r.ambiguous ? 2 : 1; }
    const d = r.item.docs;
    if (!d || d.body === undefined) {
      // never silently empty: say where the documentation would be if the reader wants to go looking
      const where = r.item.repository ?? r.item.homepage;
      err(`${qualify(r.item)} carries no documentation in the catalog${where ? ` — the publisher's own is at ${where}` : ""}`);
      if (json) jsonOut(deps, { id: qualify(r.item), docs: null, ...(where ? { repository: where } : {}) });
      return 1;
    }
    if (json) { jsonOut(deps, { id: qualify(r.item), docs: d }); return 0; }
    out(d.body);
    if (d.truncated) err(`— truncated: ${kb(d.bytes)} upstream, read the rest at ${d.source}`);
    return 0;
  }

  // ---------------- remove
  if (sub === "remove") {
    const r = await resolveTarget(target!, registry);
    if (!r.ok) { err(r.error); return r.ambiguous ? 2 : 1; }
    const done = removeItem(r.item, cwd, home);
    if (!done.ok) { err(done.error); return 1; }
    if (json) { jsonOut(deps, { removed: qualify(r.item), path: done.path }); return 0; }
    out(`removed ${qualify(r.item)} from ${done.path}`);
    return 0;
  }

  // ---------------- install
  if (sub === "install") {
    const r = await resolveTarget(target!, registry);
    if (!r.ok) {
      err(r.error);
      if (json) jsonOut(deps, { error: r.error, candidates: r.ambiguous ?? [] });
      else for (const c of r.ambiguous ?? []) err(`  ${qualify(c)}  ${c.description}`);
      return r.ambiguous ? 2 : 1;
    }
    const pickRaw = flag("--pick");
    const pick = pickRaw === undefined ? undefined : Number(pickRaw);
    if (pick !== undefined && !Number.isInteger(pick)) { err(`--pick takes a number`); return 2; }
    const asName = flag("--as");
    const opts = { scope, cwd, home, ...(pick !== undefined ? { pick } : {}), ...(asName !== undefined ? { as: asName } : {}) };
    return installOne(r.item, opts, {
      out, err, json, yes: args.includes("--yes"), tty: deps.tty ?? process.stdin.isTTY === true,
      secret: deps.secret ?? readSecret, plain: deps.plain ?? defaultPlain, run: deps.run ?? {}, verb: "install",
    });
  }

  err(`unknown command "${sub}"`);
  err(MARKET_USAGE.join("\n"));
  return 2;
}

async function defaultPlain(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try { return await new Promise<string>((res) => rl.question(prompt, res)); } finally { rl.close(); }
}
