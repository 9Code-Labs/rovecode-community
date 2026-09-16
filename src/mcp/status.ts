/** MCP status text (port #57). Cache-only by default — SHOWING status never connects
 *  anything, so an idle session stays idle; `connectAndPrefetch` forces the connect plus
 *  one listing per kind so the counts are real. Pattern (Apache-2.0, pattern only):
 *  gemini-cli's /mcp per-server status rows.
 *  Rovecode: a pure module with no TUI adapter — rovecode's `/mcp` is the MCP market
 *  (tui/mcp-cmd.ts), so the verb a row points the reader at (`connectVerb`) and the
 *  empty-state hint are the CALLER's words, passed in; the defaults are what a
 *  `/mcp connect` verb would read once a surface adds one. Nothing here is wired yet. */

import type { McpManager } from "./client.ts";
import { depthFor } from "./prompts-resources.ts";

const ERROR_CLIP = 80;

/** One line, whitespace folded, hard-capped (error text from a server is unbounded). */
export function clip(text: string, max = ERROR_CLIP): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length <= max ? one : `${one.slice(0, max - 1)}…`;
}

/** The connect verb: connect every enabled server, then warm tools/prompts/resources.
 *  Returns human notes (connect failures, per-server listing errors). */
export async function connectAndPrefetch(manager: McpManager, signal?: AbortSignal): Promise<string[]> {
  const res = await manager.connect();
  const notes = res.failed.map((f) => `${f.name}: ${clip(f.error)}`);
  notes.push(...(await depthFor(manager).prefetch(signal)));
  return notes;
}

/** The surface's own words: the verb that connects + prefetches, and how a server gets configured. */
export interface StatusHints {
  /** what a not-yet-connected / not-yet-fetched row tells the reader to run (default `/mcp connect`) */
  connectVerb: string;
  /** how to add a server (default: the market's shell commands) */
  addHint: string;
}
export const DEFAULT_STATUS_HINTS: StatusHints = { connectVerb: "/mcp connect", addHint: "rovecode mcp search <query> · rovecode mcp add <name>" };

/** One row per configured server. `configPath` (mcpConfigPath(cwd)) feeds the empty-state hint. */
export function formatMcpStatus(manager: McpManager | null, configPath: string, hints: StatusHints = DEFAULT_STATUS_HINTS): string {
  if (!manager || manager.serverNames().length === 0) {
    return `no MCP servers configured — ${hints.addHint} (project config: ${configPath}; a harvested .mcp.json is read too)`;
  }
  const depth = depthFor(manager);
  const rows = manager.status();
  const lines = rows.map((s) => {
    const wire = s.wire === undefined || s.wire === "custom" ? s.transport : s.fellBack ? `${s.transport} → ${s.wire} fallback` : s.wire;
    switch (s.state) {
      case "disabled": return `${s.name}  disabled (${s.transport})`;
      case "pending": return `${s.name}  not connected yet (${s.transport}) — ${hints.connectVerb}`;
      case "failed": return `${s.name}  failed (${s.transport}): ${clip(s.error ?? "unknown error")}`;
      default: {
        const c = depth.counts(s.name);
        const counts = s.tools === undefined && c.prompts === undefined && c.resources === undefined
          ? `tools/prompts/resources not fetched yet — ${hints.connectVerb}`
          : [
              `tools ${s.tools ?? "not fetched"}`,
              `prompts ${c.prompts ?? "not fetched"}`,
              `resources ${c.resources ?? "not fetched"}${c.templates ? ` (+${c.templates} template${c.templates === 1 ? "" : "s"})` : ""}`,
            ].join(" · ");
        return `${s.name}  connected (${wire}) · ${counts}`;
      }
    }
  });
  const connected = rows.filter((s) => s.state === "connected").length;
  return [`MCP servers: ${rows.length} configured, ${connected} connected`, ...lines].join("\n");
}
