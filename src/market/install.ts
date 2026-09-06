/** One install entry, three kinds, one order of events — plan, show, ask, write.
 *
 *  The MCP market established the order and it is the whole point of this module: the human sees the exact
 *  command, folder or file list BEFORE anything lands, and the write happens only after a yes. A skill, a
 *  plugin and an MCP server say different things in that preview ("copies one file, runs nothing" vs
 *  "copies a folder whose code rovecode will run"), so the sentences differ per kind — but a caller only
 *  ever calls `planInstall` then `runInstall`, and neither can be skipped by a new kind arriving later.
 *
 *  Delegation, not reimplementation: MCP goes through mcp/market-install.ts (planner, `${NAME}` filling,
 *  trust-recording write), plugins through plugins/install.ts (shallow clone, manifest validation, project
 *  trust). Only skills are written here, because "copy files into a folder" had no installer yet.
 *
 *  Project scope is the trusted scope: a project MCP file or plugin folder installed through this path is
 *  recorded as trusted, because the human just approved the exact content. Skills are files, never code —
 *  they carry no trust gate, and the preview says so. */

import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep, resolve as resolvePath } from "node:path";
import { describePlan, fillPlan, namesWritten, planInstall as planMcp, removeServer, unfilledPending, writeServer, type InstallPlan as McpPlan } from "../mcp/market-install.ts";
import { mcpConfigFiles, parseConfigFile } from "../mcp/config.ts";
import { mcpTrustStatus } from "../mcp/trust.ts";
import { addPlugin, cloneKey, removePlugin, scopeRoot, type CopyTree, type Spawn } from "../plugins/install.ts";
import { discoverPlugins } from "../plugins/discover.ts";
import { checkPrereq, prereqLine, prereqOf, type PrereqEnv } from "./prereq.ts";
import { installLocalPackage, localLaunch } from "../mcp/local-package.ts";
import { buildRecord, forgetInstall, recordInstall } from "./manifest.ts";
import { cloneAtRef, type ResolvedBy } from "./clone.ts";
import { contextCostLines, contextCostOf } from "./context-cost.ts";
import { digestOf } from "./digest.ts";
import type { InstalledState, InstallOutcome, InstallPlanView, MarketItem, MarketRow, MarketScope } from "./types.ts";

export interface PlanOptions {
  scope: MarketScope;
  cwd: string;
  home: string;
  /** which of an MCP entry's install forms (default the first) */
  pick?: number;
  /** override the installed name */
  as?: string;
  /** PATH lookup for the prerequisite line — tests inject; production reads the real environment */
  prereqEnv?: PrereqEnv;
  /** pin a git source to a branch, tag or commit (`--ref`). clone.ts tells the three apart by asking git
   *  rather than by looking at the string, and records which one answered. */
  ref?: string;
  /** the model the plan is being drawn for, so the token estimate can be scaled to its tokenizer. Left
   *  undefined when nothing is configured — an unscaled number that says so beats one scaled to a model
   *  the person is not running. */
  model?: { provider: string; model: string };
  /** MCP only: install the npx package ONCE and launch it with node (mcp/local-package.ts). True after the
   *  human said yes to the offer (or passed --local); false or undefined writes today's npx line. Never
   *  decided here — the surfaces ask, this only carries the answer. */
  local?: boolean;
}

export interface RunDeps {
  /** how `git clone` runs — tests inject one that never touches the network */
  spawn?: Spawn;
  /** replace something already installed under that name */
  force?: boolean;
  /** no network, for real: an install whose source has to be fetched is refused rather than quietly
   *  cloning. `--offline` used to stop only the registry lookup, so `install --offline` still went to the
   *  network and succeeded — a flag that says "skips the network entirely" has to mean it. */
  offline?: boolean;
  /** Clones made during THIS command, shared with plugins/install.ts (same map, same `cloneKey`). Three
   *  plugins out of one monorepo become one clone. The CACHE owns every directory in it, so whoever
   *  created the map must call `disposeCloneCache` in a finally — otherwise the clones outlive the
   *  command in the temp directory. */
  cloneCache?: Map<string, string>;
  /** the copy step. Real installs leave it alone; a test injects one that fails part way through, which is
   *  the only way to observe that the staging directory actually protects the previous install. */
  copy?: CopyTree;
}

/** The names an item may be installed under. `--as` is human input reaching a path join, so it is checked
 *  like one: `--as "../../../head-pwned"` wrote a skill outside ROVECODE_HOME entirely, `--as ""` targeted
 *  the skills root itself, and `--as "C:/x"` produced a raw ENOENT. Only a plain slug is a name. */
const INSTALL_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
export function validInstallName(name: string): boolean {
  return INSTALL_NAME.test(name) && name !== "." && name !== "..";
}

/** The prerequisite row, or nothing. Deliberately `requires`, not `needs`: `needs` was already spoken for
 *  by "this install needs an argument from YOU", and one word doing two jobs in the same paragraph is how a
 *  plan stops being read. `requires` is about the machine, `fill in` is about the human.
 *
 *  Placed right under `runs`/`connects`/`source`, because both answer the same question — what is going to
 *  be executed or fetched — while `writes` and `fill in` are about what happens to the disk. It never
 *  blocks: some people install the tool next, and a warning is not a gate. */
function requiresLine(item: MarketItem, opts: PlanOptions): string[] {
  // install-once runs npm now and node at every start — those are the programs to look for, not npx
  if (opts.local === true && item.install.kind === "mcp") {
    const both = ["npm", "node"].map((p) => prereqLine(checkPrereq(p, opts.prereqEnv))).filter((l): l is string => l !== undefined);
    return both.length === 0 ? [] : [`  requires   ${both.join("  ·  ")}`];
  }
  const line = prereqLine(prereqOf(item, opts.prereqEnv));
  return line === undefined ? [] : [`  requires   ${line}`];
}

/** describePlan's own pending rows say the same thing the market's `fill in` says, one line later and
 *  without the file path. Drop them here rather than change describePlan, which `rovecode mcp add` still
 *  uses and where there is no `fill in` to duplicate. */
const PENDING_ROW = /^ {2}needs {6}/;

/** How many skills this machine already has, for the "past 50 the index leaves the prompt" warning.
 *
 *  Counted from the two folders the market installs into. That UNDERCOUNTS: a plugin can contribute skills
 *  too, and those are not visible without loading the plugin. Undercounting is the safe direction — it can
 *  only make the warning silent, never make it wrong — and a warning that fires with a made-up number is
 *  worth less than no warning at all. */
function installedSkillCount(cwd: string, home: string): number {
  let n = 0;
  for (const root of [join(home, "skills"), join(cwd, ".rovecode", "skills")]) {
    if (!existsSync(root)) continue;
    try {
      for (const name of readdirSync(root)) if (existsSync(join(root, name, "SKILL.md"))) n += 1;
    } catch { /* unreadable folder: count what we could */ }
  }
  return n;
}

/** What this adds to every prompt, and what it adds only when the model opens it. Two numbers rather than
 *  one because a skill's index line and its body differ by roughly thirty times — a single "per turn"
 *  figure would overstate an unopened skill by that much. */
function contextLines(item: MarketItem, opts: PlanOptions): string[] {
  const installed = installedSkillCount(opts.cwd, opts.home);
  const cost = contextCostOf(item, { installedSkills: installed, ...(opts.model ? { model: opts.model } : {}) });
  const lines = contextCostLines(cost);
  return lines.length === 0 ? [] : lines.map((l, i) => (i === 0 ? `  context    ${l}` : `             ${l}`));
}

/** put the requires row directly after the line that says what will run or be fetched */
function withRequires(lines: string[], item: MarketItem, opts: PlanOptions): string[] {
  const requires = [...requiresLine(item, opts), ...contextLines(item, opts)];
  if (requires.length === 0) return lines;
  // `runs`/`connects` first when there is one — that is the line the requirement belongs to. `source` is
  // only the fallback, for a skill or plugin whose plan has no launch line at all.
  const at = lines.findIndex((l) => /^ {2}(runs|connects) {3,}/.test(l));
  const anchor = at >= 0 ? at : lines.findIndex((l) => /^ {2}source {3,}/.test(l));
  return anchor < 0 ? [...lines, ...requires] : [...lines.slice(0, anchor + 1), ...requires, ...lines.slice(anchor + 1)];
}

/** where a skill of this id lives under a scope */
export function skillDir(id: string, opts: { scope: MarketScope; cwd: string; home: string }): string {
  const root = opts.scope === "project" ? join(opts.cwd, ".rovecode", "skills") : join(opts.home, "skills");
  const dir = join(root, id);
  // belt and braces: even a name that slipped past the check cannot land outside the skills root
  if (!resolvePath(dir).startsWith(resolvePath(root) + sep)) throw new Error(`"${id}" is not a usable skill name`);
  return dir;
}

// ---------------------------------------------------------------- planning (writes nothing)

/** The publisher's own status, said before anything else in the preview.
 *
 *  First line, not a row among the rows: `requires` and `context` describe what an install COSTS, and
 *  someone reading those has already decided they want the thing. "The publisher stopped maintaining
 *  this" is a reason not to want it, so it goes above the decision rather than inside it.
 *
 *  It never blocks. An archived skill is still a working skill, plenty of people install one on purpose,
 *  and a market that refuses is a market that gets worked around. The wording is deliberately the flag's
 *  own: GitHub says `archived`, so we say "archived on GitHub" — "abandoned" is a judgement about someone
 *  else's work that nobody upstream made and we are in no position to make for them. */
function statusLines(item: MarketItem): string[] {
  const status = item.status;
  if (status === undefined || status === "") return [];
  const said =
    status === "archived" ? "archived on GitHub — the publisher has stopped maintaining it"
    : status === "deprecated" ? "marked deprecated by its publisher"
    : `marked "${status}" by its publisher`;
  return [`  !  ${said}. It still installs; nothing here is blocked.`];
}

/** the whole preview for one item: the publisher's status first, then what the install does */
function previewFor(lines: string[], item: MarketItem, opts: PlanOptions): string[] {
  return [...statusLines(item), ...withRequires(lines, item, opts)];
}

export function planInstall(item: MarketItem, opts: PlanOptions): InstallPlanView | { error: string } {
  const { install } = item;
  // checked BEFORE any path is built from it, for every kind
  // `--ref` is only wired through the skill cloner. Accepting it for a plugin and ignoring it would be
  // the exact failure this feature exists to prevent: the human believes they pinned, and something else
  // is installed. Refuse until plugins/install.ts takes a ref.
  if (opts.ref !== undefined && item.install.kind === "plugin") {
    return { error: `--ref is not wired for plugins yet — it would be accepted and ignored, which is worse than not having it` };
  }
  if (opts.ref !== undefined && item.install.kind === "mcp") {
    return { error: `--ref applies to something that is cloned; an MCP entry is a config line, and its package version belongs in the entry itself` };
  }
  if (opts.as !== undefined && !validInstallName(opts.as)) {
    return { error: `"${opts.as}" is not a usable name — letters, digits, dot, dash and underscore only, and it must not be a path` };
  }
  if (install.kind === "mcp") {
    const inner = planMcp(install.entry, {
      scope: opts.scope, cwd: opts.cwd, home: opts.home,
      ...(opts.pick !== undefined ? { pick: opts.pick } : {}), ...(opts.as !== undefined ? { name: opts.as } : {}),
      ...(opts.local !== undefined ? { local: opts.local } : {}),
    });
    if ("error" in inner) return inner;
    const view: InstallPlanView = {
      item, target: inner.file, scope: opts.scope,
      preview: [
        ...previewFor(describePlan(inner, opts.scope === "project" ? "env" : "prompt").filter((l) => !PENDING_ROW.test(l)), item, opts),
        ...(item.planNote ?? []),
      ],
      asks: inner.asks.map((a) => ({ ...a })), pending: [...inner.pending],
    };
    const existing = existingMcpNames(opts.cwd, opts.home, opts.scope);
    if (existing.includes(inner.name)) view.replaces = `${inner.name} in ${inner.file}`;
    return view;
  }

  const id = opts.as ?? item.id;
  if (install.kind === "plugin") {
    // `--as` cannot be honoured here and must not be accepted silently: addPlugin writes under the name in
    // the plugin's own manifest, so a rename would put the folder somewhere the preview did not say.
    if (opts.as !== undefined) return { error: `--as does not apply to a plugin: it installs under the name in its own manifest` };
    const dir = join(scopeRoot(opts.scope, opts.cwd, opts.home), item.id);
    const preview = [
      `${item.title}${item.version ? ` ${item.version}` : ""}`,
      `  kind       plugin — a folder of CODE that rovecode loads and RUNS in this process`,
      `  source     ${install.git ? `git clone --depth 1 ${install.source}` : `copy of the folder ${install.source}`}${install.subfolder ? ` (subfolder ${install.subfolder})` : ""}`,
      `  publisher  ${item.publisher}`,
      ...(item.license ? [`  licence    ${item.license}`] : []),
      ...(item.repository ? [`  repo       ${item.repository}`] : []),
      `  writes     ${dir}${install.git ? "  (the folder is named by the plugin's manifest; this is the expected name)" : ""}`,
      opts.scope === "project"
        ? `  trust      installed into this repo — approving here records this exact content as trusted on this machine`
        : `  trust      user scope (~/.rovecode/plugins): loaded in every project you open`,
      `  a plugin can add tools, hooks, commands, skills and MCP servers. Install one only from a publisher you trust.`,
      ...(item.planNote ?? []),
    ];
    return { item, target: dir, scope: opts.scope, preview: previewFor(preview, item, opts), asks: item.env.map((e) => ({ ...e })), pending: [],
      ...(existsSync(dir) ? { replaces: dir } : {}) };
  }

  const dir = skillDir(id, opts);
  const fileList = install.files ?? [];
  // a skill IS a folder with a SKILL.md — without one nothing would ever find it again: installedState
  // looks for exactly that file, so it would install and then read as "not installed" forever
  if (install.source === undefined && !fileList.some((f) => f.path.replace(/\\/g, "/").toLowerCase() === "skill.md")) {
    return { error: `${item.id} carries no SKILL.md — a skill is a folder with a SKILL.md, and rovecode would never see this one` };
  }
  const preview = [
    `${item.title}${item.version ? ` ${item.version}` : ""}`,
    `  kind       skill — instructions the model reads. Files only: nothing here is executed on install.`,
    install.source
      ? `  source     git clone --depth 1 ${install.source.git}${install.source.subfolder ? ` (subfolder ${install.source.subfolder})` : ""}`
      : `  source     ${fileList.length} file${fileList.length === 1 ? "" : "s"} from rovecode's catalog`,
    `  publisher  ${item.publisher}`,
    ...(item.license ? [`  licence    ${item.license}`] : []),
    ...(item.repository ? [`  repo       ${item.repository}`] : []),
    `  writes     ${dir}`,
    ...fileList.slice(0, 8).map((f) => `             ${f.path}`),
    ...(fileList.length > 8 ? [`             … and ${fileList.length - 8} more`] : []),
    ...(item.planNote ?? []),
  ];
  return { item, target: dir, scope: opts.scope, preview: previewFor(preview, item, opts), asks: item.env.map((e) => ({ ...e })), pending: [],
    ...(existsSync(dir) ? { replaces: dir } : {}) };
}

// ---------------------------------------------------------------- writing (only after a yes)

export async function runInstall(plan: InstallPlanView, answers: Record<string, string>, opts: PlanOptions, deps: RunDeps = {}): Promise<InstallOutcome> {
  const { item } = plan;
  const { install } = item;
  try {
    if (install.kind === "mcp") {
      const inner = planMcp(install.entry, {
        scope: opts.scope, cwd: opts.cwd, home: opts.home,
        ...(opts.pick !== undefined ? { pick: opts.pick } : {}), ...(opts.as !== undefined ? { name: opts.as } : {}),
        ...(opts.local !== undefined ? { local: opts.local } : {}),
      });
      if ("error" in inner) return { ok: false, error: inner.error };
      // install-once (mcp/local-package.ts): npm runs FIRST, and only its success reaches mcp.json. A failed
      // npm leaves the file as it was — no half-entry pointing at a bin that never arrived — and says why.
      let launch: { command: string; args: string[] } | undefined;
      let pkg: NonNullable<Extract<InstallOutcome, { ok: true }>["package"]> | undefined;
      if (inner.local) {
        if (deps.offline === true) return { ok: false, error: `--offline: installing ${inner.local.pkg.spec} once means npm fetching it now; drop --local to write the npx line, which fetches at launch instead` };
        const r = await installLocalPackage(inner.local.pkg, inner.local.prefix, deps.spawn ? { spawn: deps.spawn } : {});
        if (!r.ok) return { ok: false, error: r.error };
        launch = localLaunch(r.pkg, inner.local.pkg.rest);
        pkg = { name: r.pkg.name, version: r.pkg.version, prefix: inner.local.prefix, bin: r.pkg.bin,
          ...(r.pkg.integrity !== undefined ? { integrity: r.pkg.integrity } : {}),
          ...(r.pkg.missing.length > 0 ? { missing: r.pkg.missing } : {}) };
      }
      const raw = fillPlan(inner, answers, launch);
      const written = writeServer(inner.file, inner.name, raw, {
        ...(deps.force === true ? { replace: true } : {}),
        ...(opts.scope === "project" ? { trustHome: opts.home } : {}),
      });
      recordInstall(buildRecord(item, { scope: opts.scope, target: inner.file, ...(pkg ? { package: { ...pkg, missing: pkg.missing ?? [] } } : {}) }),
        { cwd: opts.cwd, home: opts.home, stillInstalled: recordStillInstalled(opts.cwd, opts.home) });
      // The same closing line `rovecode mcp add` prints (cli/mcp-market-cmd.ts), for the same two reasons: an
      // entry still carrying a placeholder is skipped by the loader, so "restart rovecode" would send the
      // person to a restart that changes nothing; and the placeholder is the one thing they must go and
      // edit, so it is named here, not left for them to discover in a skipped-server warning later.
      const fillIn = unfilledPending(inner, raw);
      return {
        ok: true, item, target: inner.file, scope: opts.scope, envNames: namesWritten(inner, raw),
        ...(written.trusted !== undefined ? { trusted: written.trusted } : {}),
        ...(pkg ? { package: pkg } : {}),
        ...(fillIn.length ? { fillIn } : {}),
        next: fillIn.length
          ? `fill in before use: ${fillIn.join(", ")} — edit the args in ${inner.file}; until then this server is skipped`
          : "restart rovecode to connect — MCP servers are read once per process (a session that installs from /market connects it on the spot)",
      };
    }

    if (deps.offline === true && needsNetwork(install)) {
      return { ok: false, error: `--offline: ${item.id} would have to be fetched (${sourceOf(install)}) and nothing local can stand in for it` };
    }
    if (install.kind === "plugin") {
      // a monorepo plugin lives in plugins/<name>; plugins/install.ts validates the subfolder again
      const r = await addPlugin(install.source, {
        cwd: opts.cwd, home: opts.home, scope: opts.scope,
        ...(deps.force === true ? { force: true } : {}), ...(deps.spawn ? { spawn: deps.spawn } : {}),
        ...(install.subfolder !== undefined ? { subfolder: install.subfolder } : {}),
        ...(deps.cloneCache !== undefined ? { cloneCache: deps.cloneCache } : {}),
      });
      if (!r.ok) return { ok: false, error: r.error };
      recordInstall(buildRecord(item, { scope: opts.scope, target: r.dir,
        ...(() => { const d = digestOf(r.dir); return d ? { digest: d } : {}; })(),
        ...(install.git ? { git: { source: install.source } } : {}) }),
        { cwd: opts.cwd, home: opts.home, stillInstalled: recordStillInstalled(opts.cwd, opts.home) });
      return {
        ok: true, item, target: r.dir, scope: opts.scope, envNames: item.env.filter((e) => e.required).map((e) => e.name),
        ...(opts.scope === "project" ? { trusted: true } : {}),
        next: "restart rovecode — plugins are loaded once at startup",
      };
    }

    const dir = plan.target;
    if (existsSync(dir) && deps.force !== true) return { ok: false, error: `${dir} already exists (use --force to replace)` };
    let clonedSha: string | undefined;
    let clonedBy: ResolvedBy | undefined;
    if (install.source) {
      const r = await cloneSkill(install.source, dir, deps, opts.ref);
      if (!r.ok) return { ok: false, error: r.error };
      clonedSha = r.sha;
      clonedBy = r.resolvedBy;
    } else {
      // Build the whole thing beside the target and swap at the end. Writing in place meant deleting the
      // installed copy FIRST and then failing half way through the loop — the caller saw a clean
      // {ok:false} while the previous version was already gone and a partial one sat in its place.
      mkdirSync(dirname(dir), { recursive: true });   // the scope's skills/ folder may not exist yet
      const staging = mkdtempSync(join(dirname(dir), `.rovecode-skill-${item.id}-`));
      try {
        for (const f of install.files ?? []) {
          const dest = join(staging, f.path);
          // checked BEFORE anything is removed, not after — the catalog reader is the first lock, this the second
          if (!resolvePath(dest).startsWith(resolvePath(staging) + sep) ) return { ok: false, error: `${f.path} escapes the skill's folder` };
          mkdirSync(dirname(dest), { recursive: true });
          writeFileSync(dest, f.text);
        }
        if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
        renameSync(staging, dir);
      } finally {
        rmSync(staging, { recursive: true, force: true }); // no-op once it has been renamed into place
      }
    }
    recordInstall(buildRecord(item, { scope: opts.scope, target: dir,
      ...(() => { const d = digestOf(dir); return d ? { digest: d } : {}; })(),
      ...(install.source ? { git: { source: install.source.git,
        ...(clonedSha !== undefined ? { sha: clonedSha } : {}),
        ...(opts.ref !== undefined ? { ref: opts.ref } : {}),
        ...(clonedBy !== undefined ? { resolvedBy: clonedBy } : {}) } } : {}) }),
      { cwd: opts.cwd, home: opts.home, stillInstalled: recordStillInstalled(opts.cwd, opts.home) });
    return {
      ok: true, item, target: dir, scope: opts.scope, envNames: [],
      next: "restart rovecode — skills are indexed at startup",
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Is what this record describes still on disk? Used to prune orphans on every write — a record whose
 *  thing was deleted by hand is ignored anyway, and dropping it keeps the file from growing forever.
 *  Asked through `installedState`, so it answers the same question `list` does rather than a second
 *  approximation of it (an MCP record's target is the shared mcp.json, which exists whether or not the
 *  entry inside it does — `existsSync` would be wrong here). */
function recordStillInstalled(cwd: string, home: string) {
  return (r: { kind: MarketItem["kind"]; id: string; scope: MarketScope }): boolean =>
    installedState({ kind: r.kind, id: r.id } as MarketItem, cwd, home, r.scope) !== undefined;
}

/** The commit a clone is sitting on, read from the git directory rather than from stdout — `Spawn` gives
 *  us an exit code and stderr, not stdout, and adding a channel to that seam for one string is not worth
 *  it. Undefined when it cannot be read; provenance is best-effort. */
function readSha(clone: string): string | undefined {
  try {
    const head = readFileSync(join(clone, ".git", "HEAD"), "utf8").trim();
    const ref = /^ref:\s*(.+)$/.exec(head)?.[1];
    if (ref === undefined) return /^[0-9a-f]{40}$/i.test(head) ? head : undefined;
    const direct = join(clone, ".git", ...ref.split("/"));
    if (existsSync(direct)) { const v = readFileSync(direct, "utf8").trim(); return /^[0-9a-f]{40}$/i.test(v) ? v : undefined; }
    const packed = join(clone, ".git", "packed-refs");
    if (!existsSync(packed)) return undefined;
    for (const line of readFileSync(packed, "utf8").split("\n")) {
      const m = /^([0-9a-f]{40})\s+(.+)$/i.exec(line.trim());
      if (m && m[2] === ref) return m[1]!;
    }
    return undefined;
  } catch { return undefined; }
}

/** does installing this reach the network? A catalog's literal files and a local folder do not. */
export function needsNetwork(install: MarketItem["install"]): boolean {
  if (install.kind === "plugin") return install.git;
  if (install.kind === "skill") return install.source !== undefined;
  return false;   // an MCP install writes a config entry; the server is fetched when it launches, not now
}
function sourceOf(install: MarketItem["install"]): string {
  if (install.kind === "plugin") return install.source;
  if (install.kind === "skill") return install.source?.git ?? "its catalog files";
  return "an mcp.json entry";
}

/** true for a symbolic link (never throws: an unreadable entry is not copied either) */
function isLink(p: string): boolean {
  try { return lstatSync(p).isSymbolicLink(); } catch { return true; }
}

async function cloneSkill(source: { git: string; subfolder?: string }, dir: string, deps: RunDeps, ref?: string): Promise<{ ok: true; sha?: string; resolvedBy?: ResolvedBy } | { ok: false; error: string }> {
  let resolvedBy: ResolvedBy | undefined;
  const spawn: Spawn = deps.spawn ?? (async (cmd, cwd) => {
    const p = Bun.spawn(cmd, { cwd, stdout: "ignore", stderr: "pipe", stdin: "ignore" });
    return { code: await p.exited, stderr: await new Response(p.stderr).text() };
  });
  const copy: CopyTree = deps.copy ?? ((from, to, filter) => cpSync(from, to, { recursive: true, filter }));

  // The same key and the same map as plugins/install.ts: a skill and a plugin out of one repository, or
  // three skills out of one, are cloned once. Clone straight INTO the temp directory (`… <url> .`) so the
  // cached value is the clone itself — a cache disposer should never have to take dirname() of what it was
  // given and remove a directory nobody handed it.
  const key = cloneKey(source.git, ref);
  let owned: string | null = null;

  // the clone itself is INSIDE the try: `spawn` does not only return a non-zero code, it can throw
  // outright — no git on PATH is an ENOENT, not an exit status — and a temp directory created one line
  // earlier would otherwise be left behind on the one failure a user is most likely to hit.
  try {
    const cached = deps.cloneCache?.get(key);
    let clone: string;
    if (cached !== undefined) {
      clone = cached;
    } else {
      owned = mkdtempSync(join(tmpdir(), "rovecode-skill-"));
      const r = await cloneAtRef(spawn, source.git, owned, ref);
      if (!r.ok) return { ok: false, error: r.error };   // the finally clears `owned`
      resolvedBy = r.resolvedBy;
      clone = owned;
    }

    const from = source.subfolder ? join(clone, source.subfolder) : clone;
    if (!resolvePath(from).startsWith(resolvePath(clone))) return { ok: false, error: `subfolder escapes the clone` };
    if (!existsSync(join(from, "SKILL.md"))) return { ok: false, error: `no SKILL.md in ${source.subfolder ?? "the repository root"} — a skill is a folder with a SKILL.md` };
    // built beside the target and swapped in, never written over the top: `rmSync` then `cpSync` means a
    // failure half way through (full disk, a locked file on Windows, the process killed during
    // `update --all`) has already destroyed the working copy and leaves a partial tree in its place.
    // The catalog-files path below learned this the hard way; this is the same fix for the clone path.
    mkdirSync(dirname(dir), { recursive: true });
    const staging = mkdtempSync(join(dirname(dir), `.rovecode-clone-`));
    try {
      copy(from, staging, (p) => !/(?:^|[\\/])\.git(?:[\\/]|$)/.test(p) && !isLink(p));
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
      renameSync(staging, dir);
    } finally {
      rmSync(staging, { recursive: true, force: true });   // a no-op once it has been renamed into place
    }
    // the commit this actually resolved to, for the record. Best effort: a clone whose HEAD cannot be
    // read still installed fine, and a made-up sha would be worse than none.
    const head = await spawn(["git", "rev-parse", "HEAD"], clone).catch(() => ({ code: 1, stderr: "" }));
    const sha = head.code === 0 ? readSha(clone) : undefined;
    if (owned !== null && deps.cloneCache !== undefined) { deps.cloneCache.set(key, owned); owned = null; }   // ownership moves to the cache
    return { ok: true, ...(sha !== undefined ? { sha } : {}), ...(resolvedBy !== undefined ? { resolvedBy } : {}) };
  } finally {
    if (owned !== null) rmSync(owned, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- what is installed here

function existingMcpNames(cwd: string, home: string, scope: MarketScope): string[] {
  const files = mcpConfigFiles(cwd, home);
  const file = scope === "project" ? files.project : files.user;
  if (file === undefined || !existsSync(file)) return [];
  const anySet = new Proxy({}, { get: () => "set" }) as Record<string, string>;
  return parseConfigFile(file, [], anySet).map((s) => s.name);
}

/** Local truth for one item: is it on disk, where, and does the version differ from the catalog's. */
export function installedState(item: MarketItem, cwd: string, home: string, only?: MarketScope): InstalledState | undefined {
  const scopes: readonly MarketScope[] = only ? [only] : ["project", "user"];
  if (item.kind === "mcp") {
    const files = mcpConfigFiles(cwd, home);
    const byScope: Record<MarketScope, string | undefined> = { project: files.project, user: files.user };
    for (const scope of scopes) {
      const file = byScope[scope];
      if (file === undefined || !existsSync(file)) continue;
      const anySet = new Proxy({}, { get: () => "set" }) as Record<string, string>;
      const hit = parseConfigFile(file, [], anySet).find((s) => s.name === item.id);
      if (hit) {
        const state: InstalledState = { path: file, scope };
        if (scope === "project") state.trusted = mcpTrustStatus(home, file) === "trusted";
        return state;
      }
    }
    return undefined;
  }
  if (item.kind === "plugin") {
    const found = discoverPlugins(cwd, { home }).plugins.find((p) => p.name === item.id && (only === undefined || p.scope === only));
    if (!found) return undefined;
    const state: InstalledState = { path: found.dir, scope: found.scope };
    const version = found.manifest?.version;
    if (version !== undefined) {
      state.version = version;
      if (item.version !== undefined && item.version !== version) state.updateAvailable = true;
    }
    if (found.scope === "project") state.trusted = found.status !== "untrusted";
    return state;
  }
  for (const scope of scopes) {
    const dir = skillDir(item.id, { scope, cwd, home });
    if (!existsSync(join(dir, "SKILL.md"))) continue;
    const state: InstalledState = { path: dir, scope };
    const version = skillVersion(join(dir, "SKILL.md"));
    if (version !== undefined) {
      state.version = version;
      if (item.version !== undefined && item.version !== version) state.updateAvailable = true;
    }
    return state;
  }
  return undefined;
}

function skillVersion(file: string): string | undefined {
  try {
    const head = readFileSync(file, "utf8").slice(0, 2000);
    return /^version:\s*(.+)$/m.exec(head)?.[1]?.trim().slice(0, 64);
  } catch { return undefined; }
}

/** Attach local state to every item — what a UI renders. */
export function withInstalled(items: readonly MarketItem[], cwd: string, home: string): MarketRow[] {
  return items.map((item) => {
    const installed = installedState(item, cwd, home);
    return installed ? { ...item, installed } : { ...item };
  });
}

/** `market remove <kind:id>` — undo an install, whichever kind it is. */
export function removeItem(item: MarketItem, cwd: string, home: string, scope?: MarketScope): { ok: true; path: string } | { ok: false; error: string } {
  const state = installedState(item, cwd, home, scope);
  if (state === undefined) return { ok: false, error: `${item.kind} "${item.id}" is not installed here${scope ? ` in ${scope} scope` : ""}` };
  if (item.kind === "mcp") {
    // `trustHome` is not optional bookkeeping: removeServer re-records the file's trust after the edit, and
    // without it every OTHER server in a project file silently drops to "not approved" for having changed.
    const ok = removeServer(state.path, item.id, { trustHome: home });
    if (ok) forgetInstall(item.kind, item.id, state.scope, { cwd, home });
    return ok ? { ok: true, path: state.path } : { ok: false, error: `no server "${item.id}" in ${state.path}` };
  }
  if (item.kind === "plugin") {
    // through the plugin remover, which also drops the folder's trust entry — a plain rmSync leaves a
    // recorded digest pointing at a directory that no longer exists, and the next install is compared to it
    const r = removePlugin(item.id, { cwd, home, scope: state.scope });
    if (r.ok) forgetInstall(item.kind, item.id, state.scope, { cwd, home });
    return r.ok ? { ok: true, path: r.dir } : { ok: false, error: r.error };
  }
  rmSync(state.path, { recursive: true, force: true });
  forgetInstall(item.kind, item.id, state.scope, { cwd, home });
  return { ok: true, path: state.path };
}

export type { McpPlan };
