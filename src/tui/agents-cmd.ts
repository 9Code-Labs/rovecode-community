/** `/agents list` (port #62): the custom subagent definitions the runtime loaded at boot (core/agents.ts —
 *  `.rovecode/agents/<name>.md`, project shadows `<home>/agents`), one row each with its SOURCE (scope + path),
 *  model, mode and tool allow-list, after the built-in `main` row; the files skipped at boot follow under
 *  "skipped:". Read-only over the runtime snapshot — definitions are loaded once per runtime (restart rovecode
 *  to pick up edits). In the sextant surface the bare `/agents` is the crew board (its renderer-local command,
 *  local-commands.ts); only `/agents list` reaches handleSlash here — and the pass-through is sextant/keys.ts's
 *  `if (arg) return false`, already landed. */

import type { CustomAgent, DiscoveredAgents } from "../core/agents.ts";
import { AGENTS_DIR, PROJECT_STATE_DIR } from "../core/agents.ts";
import type { Renderer } from "./renderer.ts";

export interface AgentsCmdCtx {
  renderer: Renderer;
  /** the runtime's boot snapshot (Runtime.agents) */
  agents: DiscoveredAgents;
}

/** the built-in definition every runtime has — `task start` without `agent` runs it */
export const MAIN_AGENT_ROW = "main — built-in: the starting run's model and system prompt, every child tool (default for `task start`)";

/** `name — description (scope: path; model …; mode …; tools …)` */
export function formatAgentRow(a: CustomAgent): string {
  const tools = a.tools.includes("*") ? "all child tools" : a.tools.join(", ");
  return `${a.name} — ${a.description} (${a.scope}: ${a.path}; model ${a.model ?? "inherited"}; mode ${a.mode ?? "act"}; tools ${tools})`;
}

/** The whole note: main + custom rows, a hint when there are none, then the skipped files. */
export function formatAgentList(d: DiscoveredAgents): string {
  const rows = [MAIN_AGENT_ROW, ...d.agents.map(formatAgentRow)];
  const hint = d.agents.length === 0
    ? `\n(no custom definitions — add ${PROJECT_STATE_DIR}/${AGENTS_DIR}/<name>.md: frontmatter description: / model: / mode: plan|act / tools: <allow-list>, body = system prompt)`
    : "";
  const skipped = d.warnings.length > 0 ? "\nskipped:\n" + d.warnings.map((w) => `  ${w}`).join("\n") : "";
  return rows.join("\n") + hint + skipped;
}

/** `/agents [list]` — the argument is accepted (the sextant's pass-through spelling) and ignored. */
export function cmdAgents(ctx: AgentsCmdCtx): void {
  ctx.renderer.addSystemNote(formatAgentList(ctx.agents), ctx.agents.warnings.length > 0 ? "warn" : "info");
}
