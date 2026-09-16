/** Port #62 — the surfaces of custom subagent definitions: `/agents list` (tui/agents-cmd.ts: one row per
 *  definition with SOURCE scope + path, model, mode, tools; the built-in main row; skipped files; tone warn
 *  only when something was skipped), the TUI_COMMANDS entry, and the sextant split — the BARE /agents is the
 *  crew board (a renderer-local command), only `/agents <anything>` passes through to handleSlash. The task
 *  tool's schema enumeration is rovecode's own (tools/task.ts, landed with the agents port) and is pinned in
 *  test/unit/agents.test.ts; not re-pinned here. */

import { test, expect } from "bun:test";
import { cmdAgents, formatAgentList, formatAgentRow, MAIN_AGENT_ROW } from "../../src/tui/agents-cmd.ts";
import { TUI_COMMANDS } from "../../src/tui/app.ts";
import { SEXTANT_LOCAL_NAMES } from "../../src/tui/sextant-attach.ts";
import { LOCAL_COMMANDS, allCommands } from "../../src/sextant/overlays.ts";
import type { CustomAgent, DiscoveredAgents } from "../../src/core/agents.ts";
import { makeState, spyCtx, type, key, press } from "../helpers/sextant-fixtures-keys.ts";

const explore: CustomAgent = { name: "explore", description: "Fast codebase explorer", model: "mock/scout", mode: "plan", tools: ["read", "grep", "glob"], body: "You explore.", path: "/p/.rovecode/agents/explore.md", scope: "project" };
const writer: CustomAgent = { name: "writer", description: "Writes files", tools: ["*"], body: "", path: "/h/agents/writer.md", scope: "user" };

function stubRenderer(): { r: import("../../src/tui/renderer.ts").Renderer; notes: { text: string; tone: string }[] } {
  const notes: { text: string; tone: string }[] = [];
  const r = { addSystemNote(text: string, tone: "info" | "warn" | "error" = "info") { notes.push({ text, tone }); } } as unknown as import("../../src/tui/renderer.ts").Renderer;
  return { r, notes };
}

test("/agents list: the main row first, then the definitions, then the skipped files; tone warn only when something was skipped", () => {
  const d: DiscoveredAgents = { agents: [explore, writer], warnings: ["/p/.rovecode/agents/bad.md: skipped — mode must be \"plan\" or \"act\" (got \"turbo\")"] };
  const { r, notes } = stubRenderer();
  cmdAgents({ renderer: r, agents: d });
  expect(notes).toHaveLength(1);
  const lines = notes[0]!.text.split("\n");
  expect(lines[0]).toBe(MAIN_AGENT_ROW);
  expect(lines[1]).toBe(formatAgentRow(explore));
  expect(lines[2]).toBe(formatAgentRow(writer));
  expect(lines[3]).toBe("skipped:");
  expect(lines[4]).toBe(`  ${d.warnings[0]}`);
  expect(notes[0]!.tone).toBe("warn");
  const clean = stubRenderer();
  cmdAgents({ renderer: clean.r, agents: { agents: [explore], warnings: [] } });
  expect(clean.notes[0]!.tone).toBe("info");
  expect(clean.notes[0]!.text).not.toContain("skipped");
});

test("a row carries the FOUR things a definition can vary: source (scope + path), model, mode, tools — `*` reads as words, not a glob", () => {
  expect(formatAgentRow(explore)).toBe("explore — Fast codebase explorer (project: /p/.rovecode/agents/explore.md; model mock/scout; mode plan; tools read, grep, glob)");
  expect(formatAgentRow(writer)).toContain("tools all child tools");
  expect(formatAgentRow(writer)).toContain("model inherited");
});

test("/agents with no definitions: the main row + the how-to hint naming .rovecode/agents/<name>.md and the four frontmatter keys", () => {
  const text = formatAgentList({ agents: [], warnings: [] });
  expect(text.startsWith(MAIN_AGENT_ROW)).toBe(true);
  expect(text).toContain("no custom definitions");
  expect(text).toContain(".rovecode/agents/<name>.md");
  for (const k of ["description:", "model:", "mode: plan|act", "tools:"]) expect(text).toContain(k);
});

test("/agents is a TUI_COMMANDS entry (palette + /help + reserved against custom command files) and a sextant-local name (the crew board)", () => {
  const entry = TUI_COMMANDS.find((c) => c.name === "agents");
  expect(entry).toBeDefined();
  expect(entry!.choices).toEqual(["list"]); // the palette offers the pass-through spelling, not the board
  expect(SEXTANT_LOCAL_NAMES).toContain("agents");
  // the sextant prompt table shows ONE agents row (its local one wins over the app's)
  const s = makeState({ commands: [...TUI_COMMANDS] });
  const rows = allCommands(s).filter((c) => c.name === "agents");
  expect(rows).toHaveLength(1);
  expect(rows[0]!.local).toBe(true);
  expect(LOCAL_COMMANDS.find((c) => c.name === "agents")!.description).toContain("crew board");
});

test("sextant: the bare /agents stays renderer-local (crew board, never onSubmit) while `/agents list` — any argument — reaches onSubmit for app.ts handleSlash", () => {
  const s = makeState({ commands: [...TUI_COMMANDS] }), spy = spyCtx();
  type(s, spy, "/agents"); press(s, spy, key("enter"));
  expect(s.code.mode).toBe("agents");
  expect(spy.submits).toEqual([]);
  s.code.mode = "code";
  // MUTATION TARGET: drop the `if (arg) return false` pass-through in local-commands.ts's case "agents" → the board opens and nothing is submitted
  type(s, spy, "/agents list"); press(s, spy, key("enter"));
  expect(spy.submits).toEqual(["/agents list"]);
  expect(s.code.mode).toBe("code");
});
