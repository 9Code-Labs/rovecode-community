/** /mcp — the MCP market inside the TUI, through the two cards the surface already has. `/mcp [query]`
 *  opens the palette (Renderer.pickOne: the same box, keys and fuzzy filter as ⌃k) over the curated
 *  shelf plus the registry's matches; Enter on a row → if the server has several launch forms, one more
 *  pick; then the APPROVAL card (Renderer.askApproval) whose detail is the exact plan — command + args or
 *  URL, source, publisher, version, the env NAMES, the file — and only a yes writes. Kept out of app.ts
 *  (ADR-002 cap) like providers-cmd.ts.
 *
 *  Secrets: the TUI has no masked input, so nothing is ever asked here. An install that wants a key is
 *  written with `${NAME}` (config.ts fills it from the environment at launch) and the closing note says
 *  which names to export — or to run `rovecode mcp add <name>` on a shell, where the prompt is masked. */

import type { Renderer, PickItem } from "./renderer.ts";
import { installLabel, searchMarket, type MarketDeps, type MarketEntry } from "../mcp/market.ts";
import { describePlan, fillPlan, namesWritten, planInstall, serverLine, writeServer, type McpScope } from "../mcp/market-install.ts";
import { parseConfigFile } from "../mcp/config.ts";
import { mcpTrustStatus, projectMcpFiles, trustMcpFile } from "../mcp/trust.ts";
import { installLocalPackage, localLaunch, npxPackage } from "../mcp/local-package.ts";
import { buildRecord, recordInstall } from "../market/manifest.ts";
import { rovecodeHome } from "../providers/auth.ts";

/** the subcommands the sextant offers after `/mcp ` (Enter completes the word, the name comes next) */
export const MCP_SUBCOMMANDS = ["search", "info", "add", "remove", "list", "show", "trust", "untrust"] as const;
export const MCP_COMMAND = { name: "mcp", choices: MCP_SUBCOMMANDS, choicesThen: "complete" as const, description: "Find and install an MCP server: /mcp [query] [--project] — the curated shelf, then the registry · /mcp trust approves this repo's MCP files", group: "modes & safety" };

/** `/mcp trust` — one approval card per project MCP file: the file as preview, its servers as detail; a yes
 *  records the file's current bytes as trusted (mcp/trust.ts), so the NEXT launch loads it */
async function trustProjectFiles(ctx: McpCmdCtx, home: string): Promise<void> {
  const files = projectMcpFiles(ctx.cwd);
  if (files.length === 0) { ctx.renderer.addSystemNote("mcp: no project MCP files here (.rovecode/mcp.json, .mcp.json)"); return; }
  const anySet = new Proxy({}, { get: () => "set" }) as Record<string, string>;
  for (const file of files) {
    if (mcpTrustStatus(home, file) === "trusted") { ctx.renderer.addSystemNote(`mcp: ${file} is already trusted as it is now`); continue; }
    const warnings: string[] = [];
    const lines = parseConfigFile(file, warnings, anySet).map(serverLine).concat(warnings.map((w) => `! ${w}`));
    const answer = await ctx.renderer.askApproval("mcp trust", file, lines.join("\n") || "(no servers in it)");
    if (answer === "deny") { ctx.renderer.addSystemNote(`mcp: ${file} stays untrusted — nothing in it loads`); continue; }
    const r = trustMcpFile(home, file);
    ctx.renderer.addSystemNote(r.ok ? `mcp: trusted ${file} — restart me to connect; an edit asks again` : `mcp: ${r.reason}`, r.ok ? "info" : "warn");
  }
}

export interface McpCmdCtx {
  renderer: Renderer;
  cwd: string;
  home?: string;
  /** registry access — tests inject a fixture fetch or `offline` */
  market?: MarketDeps;
  /** how `npm install` runs for the install-once pick — tests inject one that writes a fake node_modules */
  spawn?: import("../mcp/local-package.ts").Spawn;
}

const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + "…" : s);

function pickItem(e: MarketEntry): PickItem {
  const src = e.source === "curated" ? "curated" : `registry · ${e.publisher ?? "?"}`;
  return { value: e.key, label: e.title ?? e.key, description: `${src}${e.status ? ` · ${e.status}` : ""} · ${clip(e.description, 60)}` };
}

export async function cmdMcp(ctx: McpCmdCtx, arg: string): Promise<void> {
  const { renderer } = ctx;
  const words = arg.split(/\s+/).filter(Boolean);
  const scope: McpScope = words.includes("--project") ? "project" : "user";
  const query = words.filter((w) => !w.startsWith("--")).join(" ");
  const home = ctx.home ?? rovecodeHome();
  if (words[0] === "trust") { await trustProjectFiles(ctx, home); return; }
  const market: MarketDeps = { home, ...ctx.market };
  const found = await searchMarket(query, market);
  for (const n of found.notes) renderer.addSystemNote(`mcp: ${n}`, "warn");
  if (found.entries.length === 0) { renderer.addSystemNote(`mcp: nothing matches "${query}" — the registry matches on the server's name`, "warn"); return; }
  const key = await renderer.pickOne(found.entries.map(pickItem), query ? `mcp market · ${query}` : "mcp market");
  if (key === null) return;
  const entry = found.entries.find((e) => e.key === key);
  if (!entry) return;
  let pick = 0;
  if (entry.installs.length > 1) {
    const how = await renderer.pickOne(entry.installs.map((i, ix) => ({ value: String(ix), label: i.kind === "stdio" ? `run  ${installLabel(i)}` : `connect  ${i.url}` })), `${entry.title ?? entry.key} · how`);
    if (how === null) return;
    pick = Number(how);
  }
  // the install-once offer (mcp/local-package.ts) as one more pick, BEFORE the plan: the card the human
  // approves is then the plan that runs. Esc here writes nothing; "as today" is the npx line unchanged.
  const chosen = entry.installs[pick];
  const offer = chosen !== undefined ? npxPackage(chosen) : undefined;
  let local = false;
  if (offer !== undefined && scope === "user") { // a project file is shared: install-once's absolute path has no place in it (planInstall refuses it too)
    const how = await renderer.pickOne([
      { value: "local", label: `install once — node starts it in ~0.4 s`, description: `runs npm install now: ${offer.spec}'s code lands under ~/.rovecode/mcp (typically 20–30 MB, one time); no network needed to start` },
      { value: "npx", label: `run through npx at every start — as today`, description: `~2 s per start, re-resolves the package and asks the npm registry each time; nothing installed now` },
    ], `${entry.title ?? entry.key} · how to start it`);
    if (how === null) return;
    local = how === "local";
  }
  const plan = planInstall(entry, { scope, cwd: ctx.cwd, home, pick, ...(local ? { local: true } : {}) });
  if ("error" in plan) { renderer.addSystemNote(`mcp: ${plan.error}`, "warn"); return; }
  // the approval card: title = what is being done, preview = the one line that runs, detail = the whole plan
  // (for install-once the detail says, in words, that npm runs and code lands on this machine)
  const answer = await renderer.askApproval("mcp add", `${plan.name} ← ${plan.local ? `node ${plan.local.pkg.spec} (installed once)` : installLabel(plan.install)}`, describePlan(plan, "env").join("\n"));
  if (answer === "deny") { renderer.addSystemNote("mcp: nothing written"); return; }
  // install-once: npm first; only its success reaches the file, and what landed goes on record
  let launch: { command: string; args: string[] } | undefined;
  let pkgRecord: NonNullable<Parameters<typeof buildRecord>[1]["package"]> | undefined;
  if (plan.local) {
    renderer.addSystemNote(`mcp: npm install ${plan.local.pkg.spec} → ${plan.local.prefix} …`);
    const lr = await installLocalPackage(plan.local.pkg, plan.local.prefix, ctx.spawn ? { spawn: ctx.spawn } : {});
    if (!lr.ok) { renderer.addSystemNote(`mcp: ${lr.error} — nothing written`, "error"); return; }
    launch = localLaunch(lr.pkg, plan.local.pkg.rest);
    pkgRecord = { name: lr.pkg.name, version: lr.pkg.version, prefix: plan.local.prefix, bin: lr.pkg.bin, missing: lr.pkg.missing,
      ...(lr.pkg.integrity !== undefined ? { integrity: lr.pkg.integrity } : {}), ...(lr.pkg.resolved !== undefined ? { resolved: lr.pkg.resolved } : {}) };
  }
  let trusted: boolean | undefined;
  const raw = fillPlan(plan, {}, launch); // no answers: required asks become ${NAME}, optional ones are left out — the file works without them
  try {
    // the card just approved this exact content: a project file is trusted as written (mcp/trust.ts)
    trusted = writeServer(plan.file, plan.name, raw, scope === "project" ? { trustHome: home } : {}).trusted;
  } catch (e) { renderer.addSystemNote(`mcp: ${e instanceof Error ? e.message : String(e)}`, "error"); return; }
  renderer.addSystemNote(`mcp: added "${plan.name}" → ${plan.file}${trusted === true ? " (trusted as written)" : ""} — restart me to connect (servers are read once per process)`);
  if (pkgRecord) {
    recordInstall(buildRecord({ kind: "mcp", id: entry.key, source: entry.source, ...(entry.version !== undefined ? { version: entry.version } : {}) },
      { scope, target: plan.file, package: pkgRecord, installedBy: "mcp add" }), { cwd: ctx.cwd, home });
    renderer.addSystemNote(`mcp: installed ${pkgRecord.name} ${pkgRecord.version} once → ${plan.local!.prefix}${pkgRecord.integrity !== undefined ? " (integrity recorded in installed.json)" : ""}`);
    if (pkgRecord.missing?.length) renderer.addSystemNote(`mcp: record incomplete: ${pkgRecord.missing.join("; ")}`, "warn");
  }
  if (trusted === false) renderer.addSystemNote("mcp: that file already held servers you have not approved, so it is NOT trusted yet — /mcp trust shows them", "warn");
  // only the names the FILE now refers to: an optional ask that was left out is not something to go and set
  const named = namesWritten(plan, raw);
  if (named.length) renderer.addSystemNote(`mcp: set ${named.join(", ")} in your environment before the restart — or run \`rovecode mcp add ${entry.key}\` on a shell, which asks for them masked`, "warn");
  if (plan.pending.length) renderer.addSystemNote(`mcp: fill in ${plan.pending.join(", ")} in that file's args before use`, "warn");
}
