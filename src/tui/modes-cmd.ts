/** TUI glue for plan/act modes (port #20), extracted from app.ts for the ADR-002 cap.
 *  Pure functions over the ModeManager + the app's mutable state slice. */

import { ModeManager, applyModeRules, buildModeChangeEntry, modeSwitchOf, planModePromptSection, type AgentMode } from "../core/modes.ts";
import type { SessionStore } from "../core/session.ts";
import type { AgentDefinition, RunConfig } from "../core/types.ts";
import type { Renderer } from "./renderer.ts";

export interface ModeStateSlice { provider: string; model: string; mode: AgentMode; busy: boolean }

/** /plan and /act — busy-gated toggle; updates the state slice from the mode's model slot. */
export function togglePlanAct(modes: ModeManager, cmd: AgentMode, state: ModeStateSlice, renderer: Renderer, pushStatus: () => void): void {
  if (state.busy) { renderer.addSystemNote("finish or interrupt the run first (Esc)", "warn"); return; }
  const sw = modes.toggle(cmd);
  if (!sw) { renderer.addSystemNote(`already in ${cmd} mode`); return; }
  const cur = modes.modelFor();
  state.mode = modes.mode; state.model = cur.model; state.provider = cur.provider;
  renderer.addSystemNote(cmd === "plan" ? "plan mode: read-only tools — writes/shell/spawn denied by policy" : "act mode: full toolset restored");
  pushStatus();
}

/** Run-start enforcement: plan mode appends read-only rules AFTER the base set
 *  (last-match-wins overrides even yolo) and steers the system prompt. */
export function applyModeToRun(modes: ModeManager, cfg: RunConfig, def: AgentDefinition): void {
  cfg.permissionRules = applyModeRules(modes.mode, cfg.permissionRules);
  if (modes.mode !== "plan") return;
  delete cfg.verify; // plan mode changes nothing and runs nothing: the verify gate (core/verify-gate.ts) is off here, not merely idle
  const base = def.systemPrompt;
  def.systemPrompt = (v) => (typeof base === "function" ? base(v) : base) + "\n\n" + planModePromptSection();
}

/** MED-2: a pending mode switch must survive quit and session swaps, not just the
 *  next submit — flush it as a durable entry so resume restores the last mode.
 *  Round-trip cancellations have no pending switch, so nothing lands for them. */
export function flushModeSwitch(modes: ModeManager, store: SessionStore): void {
  const sw = modes.consumeSwitchNotice();
  if (sw) store.append(buildModeChangeEntry(sw, store.messages().at(-1)?.id ?? null));
}

/** LOW-3: replay label for a system entry — mode switches render as a human line
 *  ("mode → plan"), never the raw <mode_notice> XML the entry carries. */
export function replayLabel(entry: unknown, text: string): string {
  const sw = modeSwitchOf(entry);
  return sw ? `mode → ${sw.to}` : text;
}
