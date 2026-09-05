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
import type { PrereqEnv } from "../market/prereq.ts";
import { originLine, readManifest, recordFor } from "../market/manifest.ts";
import { verifyDigest, verifyLine } from "../market/digest.ts";
import { disposeCloneCache } from "../plugins/install.ts";
import { reportLines, validateCatalog } from "../market/validate.ts";
import { readFileSync } from "node:fs";
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
  /** PATH lookup for the plan's prerequisite row — tests inject a fixed environment */
  prereqEnv?: PrereqEnv;
  /** the model to scale the plan's token estimate for; tests inject, production reads the configured one */
  model?: { provider: string; model: string };
}

export const MARKET_USAGE = [
  "usage: rovecode market <command>",
  "  search [query] [--kind mcp|skill|plugin]   every source at once: the curated MCP shelf, the MCP registry,",
  "                                             rovecode's skill and plugin catalogs (skills/plugins work offline)",
  "  info <id>                                  one item in full: publisher, version, what it installs, what it asks",
  "  docs <id>                                  the item's own documentation, as the catalog carries it",
  "  install <id|kind:id|git-url|npm-package> [--project] [--as <name>] [--pick N] [--ref <branch|tag|commit>] [--yes] [--force]",
  "                                             shows the plan, asks (masked) for keys by name, then writes",
  "  remove <id|kind:id> [--project]            undo an install of any kind",
  "  list [--all]                               what is installed here (--all: the whole market, with badges)",
  "  update [id] [--all] [--yes]                what is out of date; with an id or --all: plan, approve, reinstall",
  "                                             --all --yes skips plugins (new code): name one, or pass --yes-plugins",
  "  sources [probe]                            where rows come from right now; really asks the registry (--offline to skip)",
  "  verify [id]                                re-hash what is installed and say what has changed since",
  "  validate <path|url> [--kind skill|plugin]  check a catalog you wrote before anyone trusts it: what would",
  "                                             load, what would be dropped, and which fields will not survive",
  "every command takes --json · --offline skips the network entirely",
  "an id is a bare slug inside its kind (filesystem); say mcp:filesystem when two kinds share a name",
];

/** C0/C1 control characters, minus the three that are legitimately part of a text file (tab, newline,
 *  carriage return). A catalog body is UNTRUSTED text from a third party: printed raw it can clear the
 *  screen, retitle the window, or hide itself with ESC[8m. The TUI already strips this (sextant/
 *  market-source.ts, and again in screen.ts); stdout had no such pass. */
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
/** what `market docs` is allowed to put on a terminal */
export const safeForTerminal = (text: string): string => text.replace(/\r\n?/g, "\n").replace(CONTROL, "");

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
  // The clone cache lives exactly as long as ONE command: `update --all` out of a monorepo clones it once
  // instead of once per item. The cache OWNS every directory in it (plugins/install.ts), so disposing it
  // here is not tidiness — without this finally the clones outlive the process in the temp directory.
  const cloneCache = new Map<string, string>();
  try { return await runMarket(args, { ...deps, run: { ...deps.run, cloneCache } }); }
  catch (e) { (deps.err ?? ((l: string) => console.error(l)))(`market: ${e instanceof Error ? e.message : String(e)}`); return 1; }
  finally { disposeCloneCache(cloneCache); }
}

async function runMarket(args: string[], deps: MarketCliDeps): Promise<number> {
  const out = deps.out ?? console.log;
  const err = deps.err ?? ((l: string) => console.error(l));
  const cwd = deps.cwd ?? process.cwd();
  const home = deps.home ?? rovecodeHome();
  const json = args.includes("--json");
  const offline = args.includes("--offline");
  const scope: MarketScope = args.includes("--project") ? "project" : "user";
  const registry: RegistryDeps = { ...deps.registry, ...(offline ? { offline: true } : {}) };
  const flag = (name: string): string | undefined => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const KNOWN = new Set(["--json", "--offline", "--project", "--yes", "--yes-plugins", "--force", "--all", "--as", "--pick", "--kind", "--ref"]);
  const positional = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && ["--as", "--pick", "--kind", "--ref"].includes(args[i - 1]!)));
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
    // exit code carries the same signal as the text form: a script piping --json must not read "no
    // matches" as success when the human-readable run would have said otherwise
    if (json) { jsonOut(deps, { items: rows, sources: r.sources, notes: r.notes }); return rows.length === 0 ? 1 : 0; }
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
    // `sources` exists to answer "is the registry up?", and it was the one command that never asked: it
    // ran the empty query, which by design never leaves the machine, and then reported the registry as
    // "not consulted". A real probe with a real term is the whole job.
    const probe = positional.slice(1).join(" ") || "mcp";
    const r = offline ? await allItems(registry) : await searchMarket(probe, registry);
    if (json) { jsonOut(deps, { sources: r.sources, notes: r.notes, count: r.items.length, probe: offline ? null : probe, offline }); return Object.values(r.sources).every((x) => x.ok) ? 0 : 1; }
    if (offline) out(`--offline: the registry was not asked`);
    else out(`probed with "${probe}"`);
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

  // ---------------- verify
  if (sub === "verify") {
    // `--ref` pins what was ASKED for. This is what ARRIVED, checked again now. It detects drift; it does
    // not prove provenance, and nothing here claims otherwise — nobody in this space signs anything yet.
    const which = positional[1];
    const rows: { id: string; result: ReturnType<typeof verifyDigest> }[] = [];
    for (const scope of ["user", "project"] as const) {
      for (const record of readManifest(scope, cwd, home)) {
        const id = `${record.kind}:${record.id}`;
        if (which !== undefined && which !== id && which !== record.id) continue;
        rows.push({ id, result: record.kind === "mcp"
          ? { state: "not-applicable", why: "an MCP entry is a line inside a shared mcp.json, not a folder of its own" }
          : verifyDigest(record.digest, record.target) });
      }
    }
    if (json) { jsonOut(deps, rows); return rows.some((r) => r.result.state === "changed" || r.result.state === "missing") ? 1 : 0; }
    if (rows.length === 0) {
      out(which !== undefined ? `nothing recorded for "${which}"` : "nothing installed through the market yet");
      return which !== undefined ? 1 : 0;
    }
    for (const r of rows) out(verifyLine(r.id, r.result));
    const bad = rows.filter((r) => r.result.state === "changed" || r.result.state === "missing").length;
    if (bad > 0) err(`${bad} item${bad === 1 ? " is" : "s are"} not what was installed — reinstall with \`market install <id> --force\`, or keep the edit`);
    return bad > 0 ? 1 : 0;
  }

  // ---------------- list
  if (sub === "list") {
    const all = args.includes("--all");
    const r = await allItems(registry);
    const rows = withInstalled(r.items, cwd, home).filter((row) => all || row.installed);
    // where each installed row came from: the catalog row, the clone URL, the commit. The disk still says
    // WHETHER it is installed; the manifest says where it came from, and says so honestly when it cannot.
    const withOrigin = rows.map((row) => row.installed
      ? { ...row, origin: recordFor(row, row.installed.scope, cwd, home) ?? null }
      : row);
    if (json) { jsonOut(deps, withOrigin); return 0; }
    if (rows.length === 0) { out(all ? "the market is empty" : "nothing installed here yet — `rovecode market search` to look around"); return 0; }
    for (const row of rows) {
      out(`${itemLine(row)}${badge(row)}`);
      if (row.installed) out(`         from ${originLine(recordFor(row, row.installed.scope, cwd, home))}`);
    }
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

    // `--all --yes` must not silently re-clone every PLUGIN from whatever its source's HEAD says today and
    // re-record project trust for the result: that is running new code with no question asked. A skill is
    // text and a server entry is config, so those go; plugins need `--yes-plugins` or a named update.
    const skipPlugins = all && args.includes("--yes") && !args.includes("--yes-plugins");
    let targets = stale;
    if (which !== undefined) {
      const pick = await resolveTarget(which, registry);
      if (!pick.ok) { err(pick.error); return pick.ambiguous ? 2 : 1; }
      const row = installed.find((x) => x.id === pick.item.id && x.kind === pick.item.kind);
      if (row === undefined) { err(`${qualify(pick.item)} is not installed here — rovecode market install ${qualify(pick.item)}`); return 1; }
      targets = [row];
    }
    const skipped = skipPlugins ? targets.filter((r) => r.kind === "plugin") : [];
    if (skipped.length) targets = targets.filter((r) => r.kind !== "plugin");
    if (targets.length === 0 && skipped.length === 0) { out("everything installed is at the catalog's version"); return 0; }

    const ctx = {
      out, err, json, yes: args.includes("--yes"), tty: deps.tty ?? process.stdin.isTTY === true,
      secret: deps.secret ?? readSecret, plain: deps.plain ?? defaultPlain, verb: "update",
      run: { ...deps.run, force: true, ...(offline ? { offline: true } : {}) },
    };
    let worst = 0;
    if (skipped.length) {
      out(`${skipped.length} plugin${skipped.length > 1 ? "s" : ""} skipped — a plugin update runs new code: ${skipped.map(qualify).join(", ")}`);
      out(`  rovecode market update <id> --yes   ·   or --yes-plugins to take them all`);
    }
    for (const row of targets) {
      // an item is updated in the scope it is installed in, not the flag's default
      const opts: PlanOptions = { scope: row.installed!.scope, cwd, home, ...(deps.prereqEnv !== undefined ? { prereqEnv: deps.prereqEnv } : {}) };
      const code = await installOne(row, opts, ctx);
      if (code !== 0) worst = code;
    }
    return worst;
  }

  const target = positional[1];
  if (["info", "install", "remove", "docs"].includes(sub) && target === undefined) { err(`market ${sub} needs a name`); return 2; }

  // ---------------- info
  if (sub === "info") {
    // `install` may reasonably treat an unknown dashed word as an npm package — the human is naming a
    // package to install. `info` and `docs` must NOT: a typo would come back as a confident record for a
    // server nobody has ever published ("runs npx -y totally-bogus-name") with exit 0, and there would be
    // no way left to ask "does this exist?".
    const r = await resolveTarget(target!, registry);
    if (r.ok && r.item.source === "catalog" && r.item.publisher.startsWith("unknown (") && r.item.kind === "mcp") {
      err(`"${target}" is not in the catalog or the registry — \`market install\` would treat it as an npm package, but there is nothing here to describe`);
      if (json) jsonOut(deps, { error: "not found", id: target });
      return 1;
    }
    if (!r.ok) { err(r.error); if (json) jsonOut(deps, { error: r.error, candidates: r.ambiguous ?? [] }); return r.ambiguous ? 2 : 1; }
    if (json) { jsonOut(deps, { ...r.item, installed: installedState(r.item, cwd, home) }); return 0; }
    for (const l of infoLines(r.item, cwd, home)) out(l);
    return 0;
  }

  // ---------------- docs
  if (sub === "docs") {
    const r = await resolveTarget(target!, registry);
    if (r.ok && r.item.source === "catalog" && r.item.publisher.startsWith("unknown (") && r.item.kind === "mcp") {
      err(`"${target}" is not in the catalog or the registry — nothing here has documentation`);
      if (json) jsonOut(deps, { error: "not found", id: target });
      return 1;
    }
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
    out(safeForTerminal(d.body));
    if (d.truncated) err(`— truncated: ${kb(d.bytes)} upstream, read the rest at ${d.source}`);
    return 0;
  }

  // ---------------- validate
  if (sub === "validate") {
    if (target === undefined) { err("usage: rovecode market validate <path|url> [--kind skill|plugin]"); return 2; }
    const kindFlag = flag("--kind");
    if (kindFlag !== undefined && kindFlag !== "skill" && kindFlag !== "plugin") { err("validate takes --kind skill or --kind plugin"); return 2; }

    let text: string;
    const isUrl = /^https?:\/\//i.test(target);
    if (isUrl) {
      // a URL is the network, so --offline means it: the flag says "skips the network entirely"
      if (offline) { err(`--offline and a URL cannot both be meant — give a local path, or drop --offline`); return 2; }
      try {
        const res = await fetch(target, { headers: { "user-agent": "rovecode-market-validate" } });
        if (!res.ok) { err(`${target}: HTTP ${res.status}`); return 1; }
        text = await res.text();
      } catch (e) { err(`${target}: ${e instanceof Error ? e.message : String(e)}`); return 1; }
    } else {
      try { text = readFileSync(target, "utf8"); }
      catch (e) { err(`${target}: ${e instanceof Error ? e.message : String(e)}`); return 1; }
    }

    const report = validateCatalog(text, {
      ...(kindFlag ? { kind: kindFlag as "skill" | "plugin" } : {}),
      filename: target,
    });
    if (json) { jsonOut(deps, report); return report.ok ? 0 : 1; }
    for (const line of reportLines(report, target)) out(line);
    return report.ok ? 0 : 1;
  }

  // ---------------- remove
  if (sub === "remove") {
    const r = await resolveTarget(target!, registry);
    if (!r.ok) { err(r.error); return r.ambiguous ? 2 : 1; }
    // install writes nothing without a yes; remove deleted a folder in silence. Same rule both ways.
    const state = installedState(r.item, cwd, home, args.includes("--project") ? "project" : undefined);
    if (state === undefined) { err(`${qualify(r.item)} is not installed here`); return 1; }
    const tty = deps.tty ?? process.stdin.isTTY === true;
    if (!args.includes("--yes")) {
      if (!tty) { err(`nothing removed: ${qualify(r.item)} lives at ${state.path} — rerun on a terminal, or pass --yes`); return 1; }
      out(`${qualify(r.item)}  ${state.path}${state.scope === "project" ? "  (this repo)" : ""}`);
      const answer = (await (deps.plain ?? defaultPlain)("remove this? [y/N] ")).trim().toLowerCase();
      if (answer !== "y" && answer !== "yes") { out("nothing removed"); return 1; }
    }
    const done = removeItem(r.item, cwd, home, args.includes("--project") ? "project" : undefined);
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
    // the configured default model, so the estimate is scaled to the tokenizer the person actually runs.
    // Nothing configured → undefined, and the line says the numbers are unscaled rather than guessing.
    const model = deps.model ?? (await defaultModelRef());
    const ref = flag("--ref");
    if (ref !== undefined && ref.trim() === "") { err(`--ref needs a branch, tag or commit`); return 2; }
    const opts = { scope, cwd, home, ...(pick !== undefined ? { pick } : {}), ...(asName !== undefined ? { as: asName } : {}),
      ...(ref !== undefined ? { ref } : {}), ...(deps.prereqEnv !== undefined ? { prereqEnv: deps.prereqEnv } : {}),
      ...(model !== undefined ? { model } : {}) };
    return installOne(r.item, opts, {
      out, err, json, yes: args.includes("--yes"), tty: deps.tty ?? process.stdin.isTTY === true,
      secret: deps.secret ?? readSecret, plain: deps.plain ?? defaultPlain, verb: "install",
      // --force was accepted, documented, and read by nobody: the plan said "replaces …" and the write
      // then refused with "already exists (use --force to replace)" — asking for the flag the user passed.
      run: { ...deps.run, ...(args.includes("--force") ? { force: true } : {}), ...(offline ? { offline: true } : {}) },
    });
  }

  err(`unknown command "${sub}"`);
  err(MARKET_USAGE.join("\n"));
  return 2;
}

/** The configured default provider/model, or undefined. Imported lazily: `market search` has no business
 *  loading the provider stack, and this is only wanted while drawing an install plan. Never throws — a
 *  broken provider config must not stop an install. */
async function defaultModelRef(): Promise<{ provider: string; model: string } | undefined> {
  try {
    const { resolveProvider } = await import("../providers/stream.ts");
    const cfg = resolveProvider();
    if (!cfg) return undefined;
    const model = process.env.ROVECODE_MODEL ?? cfg.defaultModel;
    return model ? { provider: cfg.id, model } : undefined;
  } catch { return undefined; }
}

async function defaultPlain(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try { return await new Promise<string>((res) => rl.question(prompt, res)); } finally { rl.close(); }
}
