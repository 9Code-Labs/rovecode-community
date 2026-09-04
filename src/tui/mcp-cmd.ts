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
import { describePlan, fillPlan, planInstall, writeServer, type McpScope } from "../mcp/market-install.ts";
import { rovecodeHome } from "../providers/auth.ts";

export const MCP_COMMAND = { name: "mcp", description: "Find and install an MCP server: /mcp [query] [--project] — the curated shelf, then the registry", group: "modes & safety" };

export interface McpCmdCtx {
  renderer: Renderer;
  cwd: string;
  home?: string;
  /** registry access — tests inject a fixture fetch or `offline` */
  market?: MarketDeps;
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
  const plan = planInstall(entry, { scope, cwd: ctx.cwd, home, pick });
  if ("error" in plan) { renderer.addSystemNote(`mcp: ${plan.error}`, "warn"); return; }
  // the approval card: title = what is being done, preview = the one line that runs, detail = the whole plan
  const answer = await renderer.askApproval("mcp add", `${plan.name} ← ${installLabel(plan.install)}`, describePlan(plan, "env").join("\n"));
  if (answer === "deny") { renderer.addSystemNote("mcp: nothing written"); return; }
  try {
    writeServer(plan.file, plan.name, fillPlan(plan, {}));
  } catch (e) { renderer.addSystemNote(`mcp: ${e instanceof Error ? e.message : String(e)}`, "error"); return; }
  renderer.addSystemNote(`mcp: added "${plan.name}" → ${plan.file} — restart me to connect (servers are read once per process)`);
  if (plan.asks.length) renderer.addSystemNote(`mcp: set ${plan.asks.map((a) => a.name).join(", ")} in your environment before the restart — or run \`rovecode mcp add ${entry.key}\` on a shell, which asks for them masked`, "warn");
  if (plan.pending.length) renderer.addSystemNote(`mcp: fill in ${plan.pending.join(", ")} in that file's args before use`, "warn");
}
