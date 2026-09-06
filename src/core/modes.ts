/**
 * Plan/Act agent modes with per-mode model config — ported from cline
 * (snapshot: research/source_snapshots/cline-cline @ 8eb5f3d).
 * Citations are snapshot-relative path:line.
 *
 * Ported behavior:
 *  - Two modes, "plan" | "act", default "act"
 *    (apps/vscode/src/shared/storage/state-keys.ts:281  mode: { default: "act" }).
 *  - Plan mode is the read-only exploration mode: editor/patch tools are
 *    disabled (sdk/packages/core/src/extensions/tools/presets.ts:45-57), and
 *    the model cannot switch modes itself — the user flips the toggle
 *    (apps/vscode/src/sdk/sdk-session-config-builder.ts:12-18,
 *     sdk/packages/shared/src/prompt/cline.ts:52-59).
 *  - Per-mode provider+model slots (state-keys.ts:150,196,245-252
 *    planModeApiModelId / actModeApiModelId / planModeApiProvider /
 *    actModeApiProvider): each mode reads ITS OWN slot at run-build time
 *    (apps/vscode/src/sdk/cline-session-factory.ts:552-558 resolveModelId;
 *     :799-800 provider per mode), while `planActSeparateModels` (default
 *    false — state-keys.ts:272) gates WRITE-time sync only: with the flag
 *    off, setting a model in one mode mirrors it to the other
 *    (apps/vscode/src/core/controller/models/updateApiConfiguration.ts:104-131).
 *  - Toggling to the mode you are already in is a no-op
 *    (apps/vscode/src/sdk/sdk-mode-coordinator.ts:131-135).
 *  - A user-initiated switch stamps a <mode_notice> onto the next outbound
 *    message, and a round trip (plan→act→plan before sending) cancels out
 *    (sdk/packages/shared/src/prompt/format.ts:41-80, tracker semantics
 *     :61-80; per-session scoping of pending notices:
 *     apps/vscode/src/sdk/sdk-mode-coordinator.ts:79-81,101-112).
 *  - Plan-mode behavioral contract for the system prompt adapted from
 *    sdk/packages/shared/src/prompt/cline.ts:34-45 (base) + :52-59 (the
 *    no-self-switch tail used by hosts without a switch_to_act_mode tool).
 *
 * Deliberate deviations (rovecode-specific, per ADR-005 deny-default policy):
 *  - Enforcement rides the EXISTING permission pipeline: plan mode is a rule
 *    set appended to RunConfig.permissionRules and evaluated by the one
 *    evaluatePermissions ladder (src/core/tools.ts:17-27, last match wins).
 *    No second enforcement path.
 *  - Upstream plan mode keeps shell access with a file-editing command
 *    blacklist (presets.ts:48, sdk/packages/core/src/extensions/tools/
 *    command-guard.ts:1-74, runtime-builder.ts:477-489). rovecode plan mode
 *    denies shell.exec outright — the task bar mandates a read/grep-class
 *    toolset, and a blacklist is a weaker guarantee than a deny rule.
 *  - Upstream plan mode allows spawning sub-agents (presets.ts:55); rovecode
 *    denies spawn in plan mode because children could write.
 *  - memory.write is denied in plan mode EXCEPT `todo_write` (port #32): the
 *    todo list is the plan's own artifact (agent-private session metadata,
 *    never workspace state), so planning may record it; memory_edit stays denied.
 *  - The mode switch is preserved durably as a session entry (a system-role
 *    Message carrying the upstream notice text) instead of a prefix on the
 *    next user message — rovecode sessions are an append-only tree, so the entry
 *    lands exactly where the switch happened. Round-trip cancellation is
 *    kept: a cancelled switch never becomes an entry.
 *
 * Scope: modes are a TUI feature — only src/tui consumes this module;
 * `rovecode run`/acp/serve ignore .rovecode/modes.json (incl. defaultMode) and own
 * their RunConfig outright (R2 #20 LOW-4 decision: documented, not wired).
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Message, PermissionRule } from "./types.ts";

// ---------- Mode ----------

export type AgentMode = "plan" | "act";

/** Upstream default mode (state-keys.ts:281). */
export const DEFAULT_MODE: AgentMode = "act";

function isMode(v: unknown): v is AgentMode {
  return v === "plan" || v === "act";
}

// ---------- Per-mode model config (.rovecode/modes.json) ----------

/** One mode's provider/model selection (upstream planMode… / actMode… fields). */
export interface ModeModelSelection {
  provider?: string;
  model?: string;
}

export interface ModesConfig {
  /** Starting mode; default "act" (state-keys.ts:281). Read by the TUI only —
   *  headless entrypoints (run/acp/serve) never load modes.json (LOW-4). */
  defaultMode?: AgentMode;
  /** Write-time sync gate; default false (planActSeparateModelsSetting,
   *  state-keys.ts:272): false = setting a model in one mode mirrors it to
   *  the other (updateApiConfiguration.ts:119-131). */
  planActSeparateModels?: boolean;
  plan?: ModeModelSelection;
  act?: ModeModelSelection;
}

function asSelection(v: unknown): ModeModelSelection | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  const provider = typeof o.provider === "string" && o.provider.trim() !== "" ? o.provider.trim() : undefined;
  const model = typeof o.model === "string" && o.model.trim() !== "" ? o.model.trim() : undefined;
  if (provider === undefined && model === undefined) return undefined;
  return { provider, model };
}

/** Load `<cwd>/.rovecode/modes.json`. Missing, unreadable, or malformed files and
 *  junk fields all degrade to defaults — config can never crash startup
 *  (house pattern: src/core/config.ts tryReadFile / src/mcp config). */
export function loadModesConfig(cwd: string): ModesConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(cwd, ".rovecode", "modes.json"), "utf8"));
  } catch {
    return {};
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const o = raw as Record<string, unknown>;
  const out: ModesConfig = {};
  if (isMode(o.defaultMode)) out.defaultMode = o.defaultMode;
  if (typeof o.planActSeparateModels === "boolean") out.planActSeparateModels = o.planActSeparateModels;
  const plan = asSelection(o.plan);
  const act = asSelection(o.act);
  if (plan) out.plan = plan;
  if (act) out.act = act;
  return out;
}

// ---------- Plan-mode policy rule set (rides the existing pipeline) ----------

/**
 * Deny rules appended AFTER the base rules; evaluatePermissions is
 * last-match-wins (src/core/tools.ts:17-27), so these override any earlier
 * allow/prompt — including yolo's `* * allow`. Action names are the ones
 * actionFor() emits (src/core/tools.ts:145-154).
 *
 * Upstream basis: ToolPresets.plan disables editing (presets.ts:50-51); the
 * shell/spawn/memory denies are the rovecode deviations documented above.
 */
export function planModeRules(allowTools: readonly string[] = []): PermissionRule[] {
  const rules: PermissionRule[] = [
    // plan is the exploration mode: reads are guaranteed, whatever the base
    // rules said (ToolPresets.plan enableReadFiles/enableSearch, presets.ts:46-47)
    { action: "file.read", resource: "*", effect: "allow" },
    { action: "file.write", resource: "*", effect: "deny" },
    { action: "shell.exec", resource: "*", effect: "deny" },
    { action: "spawn", resource: "*", effect: "deny" },
    { action: "memory.write", resource: "*", effect: "deny" },
    // port #32: the session todo list IS the plan — todo_write (kind memory; its policy resource
    // is the tool name, tools/todo.ts) is re-allowed right after the memory deny, so plan mode can
    // record its plan while memory_edit and every other memory.write stay denied (one ladder)
    { action: "memory.write", resource: "todo_write", effect: "allow" },
    // blanket deny for custom tools (e.g. mcp_call) — MCP calls can mutate
    { action: "tool.*", resource: "*", effect: "deny" },
  ];
  // read-only custom tools a caller vouches for, re-allowed after the blanket
  // deny (last match wins)
  for (const name of allowTools) {
    rules.push({ action: `tool.${name}`, resource: "*", effect: "allow" });
  }
  return rules;
}

/** Mode-aware rule transform: act passes the base rules through untouched;
 *  plan appends the read-only rule set. Pure — never mutates `base`. */
export function applyModeRules(
  mode: AgentMode,
  base: readonly PermissionRule[],
  allowTools: readonly string[] = [],
): PermissionRule[] {
  if (mode !== "plan") return [...base];
  return [...base, ...planModeRules(allowTools)];
}

// ---------- Plan-mode system prompt section ----------

/**
 * Behavioral contract appended to the system prompt in plan mode. Adapted
 * from PLAN_MODE_INSTRUCTIONS_BASE (sdk/packages/shared/src/prompt/
 * cline.ts:34-45) with the no-self-switch tail (:52-59). The upstream
 * run_commands paragraph is replaced: rovecode plan mode has no shell at all.
 */
export function planModePromptSection(): string {
  return `# Plan Mode

You are in Plan mode. Your role is to explore, analyze, and plan -- not to execute.
- Read files and search the codebase to understand the task
- Present your plan as a structured outline with clear steps
- Editing tools, shell commands, and sub-agents are unavailable in plan mode: attempts are denied by policy. If the task requires a mutation, put it in the plan; it happens only after the user switches to act mode.

Once you have presented your plan, end your turn and wait for the user's response. You do NOT have the ability to switch to act mode yourself -- the user must do it manually with the Plan/Act toggle once they are satisfied with the plan. If the task requires tools that are only available in act mode, ask the user to "toggle to Act mode" (use those words).`;
}

// ---------- Mode-switch notice (format.ts:41-80, ported) ----------

export interface ModeSwitch {
  from: AgentMode;
  to: AgentMode;
}

/** Ports formatModeSwitchNotice (format.ts:41-46) verbatim. */
export function formatModeSwitchNotice(from: AgentMode, to: AgentMode): string {
  return `<mode_notice>The user switched from ${from} mode to ${to} mode before sending this message.</mode_notice>`;
}

/**
 * Ports createModeSwitchNoticeTracker (format.ts:61-80): tracks a
 * user-initiated switch so the next outbound turn can carry a notice. A
 * round trip (plan→act→plan before sending anything) cancels out, since the
 * mode the model last saw never effectively changed (:64-73).
 */
export function createModeSwitchNoticeTracker(): {
  record(from: AgentMode, to: AgentMode): void;
  consume(): ModeSwitch | null;
} {
  let pending: ModeSwitch | null = null;
  return {
    record(from: AgentMode, to: AgentMode): void {
      if (from === to) return;
      if (pending) {
        pending = pending.from === to ? null : { from: pending.from, to };
        return;
      }
      pending = { from, to };
    },
    consume(): ModeSwitch | null {
      const notice = pending;
      pending = null;
      return notice;
    },
  };
}

// ---------- Session entry (durable mode-switch record) ----------

/**
 * Mode switches persist as system-role Messages so the existing SessionStore
 * Entry union (src/core/session.ts:10) accepts them unchanged: `modeSwitch`
 * is an extra field that rides the JSONL round trip; replay renders the
 * notice text as a system note; the provider seam sees a system message
 * placed exactly where the switch happened.
 */
export interface ModeChangeEntry extends Message {
  role: "system";
  modeSwitch: ModeSwitch;
}

export function buildModeChangeEntry(sw: ModeSwitch, parentId: string | null): ModeChangeEntry {
  return {
    id: randomUUID(),
    role: "system",
    parts: [{ kind: "text", text: formatModeSwitchNotice(sw.from, sw.to) }],
    parentId,
    createdAt: Date.now(),
    modeSwitch: { from: sw.from, to: sw.to },
  };
}

/** The ModeSwitch a session entry carries, or null for anything else (plain
 *  system notes, junk fields). Lets replay render a switch as a human line
 *  ("mode → plan") instead of the raw <mode_notice> XML (R2 #20 LOW-3). */
export function modeSwitchOf(entry: unknown): ModeSwitch | null {
  if (!entry || typeof entry !== "object") return null;
  const e = entry as { role?: unknown; modeSwitch?: unknown };
  if (e.role !== "system") return null;
  const sw = e.modeSwitch as { from?: unknown; to?: unknown } | undefined;
  if (!sw || typeof sw !== "object") return null;
  return isMode(sw.from) && isMode(sw.to) ? { from: sw.from, to: sw.to } : null;
}

/** Mode a resumed session should restore to: the LAST mode-change entry on
 *  the active path wins; null when the session never switched. */
export function modeFromEntries(entries: readonly unknown[]): AgentMode | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const sw = modeSwitchOf(entries[i]);
    if (sw) return sw.to;
  }
  return null;
}

// ---------- ModeManager (session-scoped mode + per-mode model slots) ----------

interface Slots {
  plan: ModeModelSelection;
  act: ModeModelSelection;
}

/**
 * Holds the current mode plus one provider/model slot per mode.
 *
 * Model resolution precedence per field (highest wins), tested:
 *   1. runtime writes via setModel() to that mode's slot (latest wins —
 *      upstream: the settings UI writes the current mode's field,
 *      updateApiConfiguration.ts:108-117)
 *   2. `.rovecode/modes.json` per-mode entry (seeds the slot — upstream reads
 *      planMode… / actMode… fields per mode, cline-session-factory.ts:552-558)
 *   3. constructor fallback (session default provider/model)
 *
 * With planActSeparateModels=false (the default, state-keys.ts:272),
 * setModel() mirrors the write into BOTH slots (updateApiConfiguration.ts:
 * 119-131); config seeds still resolve per mode, matching upstream's
 * read-side behavior which never consults the flag.
 */
export class ModeManager {
  private currentMode: AgentMode;
  private readonly slots: Slots;
  private readonly fallback: ModeModelSelection;
  private readonly separateModels: boolean;
  private readonly tracker = createModeSwitchNoticeTracker();

  constructor(cfg: ModesConfig = {}, fallback: ModeModelSelection = {}) {
    this.currentMode = cfg.defaultMode ?? DEFAULT_MODE;
    this.separateModels = cfg.planActSeparateModels ?? false;
    this.fallback = { provider: fallback.provider, model: fallback.model };
    this.slots = {
      plan: { provider: cfg.plan?.provider, model: cfg.plan?.model },
      act: { provider: cfg.act?.provider, model: cfg.act?.model },
    };
  }

  get mode(): AgentMode {
    return this.currentMode;
  }

  get separate(): boolean {
    return this.separateModels;
  }

  /** Switch modes. Already in `to` → null, nothing recorded
   *  (sdk-mode-coordinator.ts:131-135). Otherwise records the pending notice
   *  (round trips cancel, format.ts:64-73) and returns the switch. */
  toggle(to: AgentMode): ModeSwitch | null {
    if (to === this.currentMode) return null;
    const sw: ModeSwitch = { from: this.currentMode, to };
    this.currentMode = to;
    this.tracker.record(sw.from, sw.to);
    return sw;
  }

  /** Restore a mode on session resume WITHOUT recording a notice: a pending
   *  notice must not leak across sessions (sdk-mode-coordinator.ts:79-81,
   *  101-112 scope notices to the session they were recorded for). */
  restore(mode: AgentMode): void {
    this.currentMode = mode;
    this.tracker.consume();
  }

  /** Pending user-initiated switch for the NEXT outbound turn, cleared on
   *  read (format.ts:74-78). Null after a cancelled round trip. */
  consumeSwitchNotice(): ModeSwitch | null {
    return this.tracker.consume();
  }

  /** Provider+model the given (default: current) mode runs with. */
  modelFor(mode: AgentMode = this.currentMode): { provider: string; model: string } {
    const slot = this.slots[mode];
    return {
      provider: slot.provider ?? this.fallback.provider ?? "",
      model: slot.model ?? this.fallback.model ?? "",
    };
  }

  /** Write the current mode's slot; with separate models OFF the write is
   *  mirrored into the other mode's slot (updateApiConfiguration.ts:119-131).
   *  Only fields present in `sel` are written. */
  setModel(sel: ModeModelSelection): void {
    const targets: AgentMode[] = this.separateModels
      ? [this.currentMode]
      : ["plan", "act"];
    for (const m of targets) {
      if (sel.provider !== undefined) this.slots[m].provider = sel.provider;
      if (sel.model !== undefined) this.slots[m].model = sel.model;
    }
  }
}
