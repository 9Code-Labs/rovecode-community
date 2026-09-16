/** Reflection loop for failed edits (port #28) — a BUILT-IN hook set on the hooks-v2 seam
 *  (core/hooks.ts HookSet: pre_run / post_tool / post_run), attached by cli/runtime.ts as
 *  "reflection" at createRuntime; core/loop.ts is untouched.
 *
 *  Mechanism: when a MUTATING tool (hashline edit / write) FAILS — or succeeds but carries the LSP
 *  gate's diagnostics note (coding/lsp.ts formatGateNote) — post_tool pushes ONE nudge into the
 *  runtime's SteeringQueue. The loop drains steering at the next turn start as a user message
 *  (core/loop.ts "steering drain point"), so the model's next request carries the failed tool_result
 *  AND a user-visible `reflection: …` message: re-read, fix, retry, or say why it cannot be fixed.
 *  That IS aider's reflected_message — the edit-failure / lint / test text becomes the next user
 *  message and the model gets a bounded number of tries.
 *
 *  Bounds (pure: no I/O, no clock, never touches the tool output — hashline's text is already the
 *  actionable one, describeEditFailure):
 *  - per-run cap: DEFAULT_REFLECTION_MAX (2) nudges per runId, ROVECODE_REFLECTION_MAX overrides (aider
 *    max_reflections = 3, base_coder.py:101); reset on pre_run (aider init_before_message resets
 *    reflected_message / num_reflections per user message, base_coder.py:864-871)
 *  - identical consecutive failures never re-nudge — repetition is the loop guard's territory
 *    (core/guardrails.ts keeps firing: post_tool runs AFTER the guard's result pass, and a stubbed
 *    call never reaches post_tool at all); the guard's own `[loop-guard]` warn suffix is stripped
 *    before comparing, so a warned repeat still counts as identical
 *  - never for an aborted result (ABORTED_TOOL_RESULT), never for non-mutating tools, never for a
 *    clean success (which also ends the "consecutive" streak — the next identical failure is new)
 *  - a nudge the loop never drained (budget / abort right after the failing call) is swept out of
 *    the queue at the run boundary (post_run, and pre_run of the next run) so it cannot open the
 *    next run's first turn; other steering messages (port #26 task notes) are preserved
 *  - ROVECODE_REFLECTION=0 → the set is not registered (cli/runtime.ts door)
 *  - ownership (fix-wave 4, #26 MED-A): ONE set serves ONE queue, so it acts only on runs it OWNS
 *    (opts.owns; cli/runtime.ts binds it to `ctx.sessionId === the ACTIVE session store's id`, which
 *    TUI session switches keep current via setSessionStore). Background-task children (port #26) run
 *    under the runtime's hooks since 0cf2992 with their OWN store ids: before this, a child's failed
 *    edit nudged the PARENT's next turn about an edit it never made, and a child's run boundary
 *    swept the parent's own pending nudge. Trade-off: children get NO reflection (a child's queue is
 *    unreachable from a hook — HookCtx carries no queue handle on purpose, hooks.ts header); their
 *    loop guard still bounds identical repeats and their failure text reaches the parent through the
 *    task note / `task_status result`.
 *
 *  Source (pattern only, no code copied; Apache-2.0, credited in THIRD_PARTY_NOTICES.md): aider
 *  @ 5dc9490 aider/coders/base_coder.py — run_one :924-944 (`while message: self.reflected_message
 *  = None; … if not self.reflected_message: break; if self.num_reflections >= self.max_reflections:
 *  tool_warning("Only N reflections allowed, stopping."); return; self.num_reflections += 1;
 *  message = self.reflected_message`), apply_updates :2296-2328 (an edit-format / apply error →
 *  `self.reflected_message = str(err)`), lint / test errors as the reflected message :1596-1623;
 *  editblock_coder.py:84-124 the actionable failed-block report the message carries.
 *  Deviations: the nudge rides the steering queue (the only way a hook can add a user message), the
 *  cap is 2 with the loop guard as the second bound, identical repeats are deduped, not re-sent. */

import type { HookCtx, HookSet } from "./hooks.ts";
import type { SteeringQueue } from "./loop.ts";
import { ABORTED_TOOL_RESULT } from "./tools.ts";

export const DEFAULT_REFLECTION_MAX = 2;
/** chars of the tool's error text carried in a failure nudge */
export const REFLECTION_ERROR_CHARS = 300;
/** chars of the diagnostics list carried in a diagnostics nudge */
export const REFLECTION_DIAG_CHARS = 400;
export const REFLECTION_PREFIX = "reflection: ";
/** the mutating tools watched by default — hashline's edit + write (kind "write") */
export const DEFAULT_REFLECTION_TOOLS: readonly string[] = ["edit", "write"];
const MAX_DIAG_LINES = 5;
const MAX_TRACKED_RUNS = 8;
const REMEDY = "Re-read the file, fix the anchors/content, and retry; if it cannot be fixed, say why and stop.";
/** the loop guard's warn suffix — core/tools.ts dispatch appends `\n\n[loop-guard] …` to the output */
const GUARD_NOTE = /\n\n\[loop-guard\] [\s\S]*$/;
/** coding/lsp.ts formatGateNote: `\n\nlsp-gate (<server>): N error(s) in <path> — fix before proceeding:\n<lines>` */
const LSP_NOTE = /\n\nlsp-gate \([^)\n]*\): \d+ error\(s\) in [^\n]* — fix before proceeding:\n([\s\S]*)$/;

export interface ReflectionOptions {
  /** the runtime's ONE steering queue (cli/runtime.ts rt.steering) — the nudge lands on the next turn */
  steering: Pick<SteeringQueue, "push" | "drainAll">;
  /** nudges per run; default reflectionMax() (ROVECODE_REFLECTION_MAX → 2) */
  max?: number;
  /** tool names treated as mutating; default DEFAULT_REFLECTION_TOOLS */
  tools?: Iterable<string>;
  /** observer for every nudge pushed (tests, surfaces) */
  onNudge?: (text: string) => void;
  /** which runs this set serves — false → pre_run / post_run / post_tool return at once (no nudge, no
   *  sweep, no per-run state). Default: every run. cli/runtime.ts: the active session store's runs. */
  owns?: (ctx: HookCtx) => boolean;
}

/** ROVECODE_REFLECTION=0 disables the built-in set; anything else (incl. unset) enables it. */
export function reflectionEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env["ROVECODE_REFLECTION"] !== "0";
}

/** ROVECODE_REFLECTION_MAX: a non-negative integer (0 = attached but silent); blank/invalid → default. */
export function reflectionMax(env: Record<string, string | undefined> = process.env): number {
  const raw = (env["ROVECODE_REFLECTION_MAX"] ?? "").trim();
  if (raw === "") return DEFAULT_REFLECTION_MAX;
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : DEFAULT_REFLECTION_MAX;
}

interface RunState { nudges: number; lastKey: string | null }

export function createReflectionHooks(opts: ReflectionOptions): HookSet {
  const max = opts.max ?? reflectionMax();
  const owns = opts.owns ?? ((): boolean => true);
  const watched = new Set(opts.tools ?? DEFAULT_REFLECTION_TOOLS);
  const runs = new Map<string, RunState>(); // runId → state; bounded (bare dispatch has no runId → "")
  const pending = new Set<string>(); // nudges pushed this run that the loop may not have drained yet
  const keyOf = (ctx: HookCtx): string => ctx.runId ?? "";
  const fresh = (): RunState => ({ nudges: 0, lastKey: null });
  const stateFor = (ctx: HookCtx): RunState => {
    const k = keyOf(ctx);
    let s = runs.get(k);
    if (s === undefined) {
      s = fresh();
      runs.set(k, s);
      if (runs.size > MAX_TRACKED_RUNS) runs.delete(runs.keys().next().value!); // oldest first
    }
    return s;
  };
  /** run boundary: drop OUR undrained nudges, keep everything else in queue order */
  const sweep = (): void => {
    if (pending.size === 0) return;
    for (const s of opts.steering.drainAll()) if (!pending.has(s)) opts.steering.push(s);
    pending.clear();
  };
  return {
    pre_run(ctx) { if (!owns(ctx)) return; sweep(); runs.set(keyOf(ctx), fresh()); },
    post_run(ctx) { if (!owns(ctx)) return; sweep(); runs.delete(keyOf(ctx)); },
    post_tool(ctx, call, result) {
      if (!owns(ctx) || !watched.has(call.tool)) return;
      const st = stateFor(ctx);
      const core = result.output.replace(GUARD_NOTE, "");
      const diag = result.ok ? diagnosticsOf(core) : null;
      if (result.ok && diag === null) { st.lastKey = null; return; } // clean success: the streak ends
      if (!result.ok && isAborted(core)) return;
      const key = `${call.tool}\n${diag ?? core}`;
      if (st.lastKey === key) return; // identical consecutive failure: the loop guard's job
      st.lastKey = key;
      if (st.nudges >= max) return;
      st.nudges += 1;
      const text = diag !== null ? diagnosticsNudge(call.tool, diag) : failureNudge(call.tool, core);
      opts.steering.push(text);
      pending.add(text);
      opts.onNudge?.(text);
    },
  };
}

/** The bounded diagnostics list inside an LSP-gated tool output, or null when the gate note is
 *  absent (clean output, or a gate that saw warnings only — formatGateNote emits nothing then). */
export function diagnosticsOf(output: string): string | null {
  const m = LSP_NOTE.exec(output);
  if (m === null) return null;
  const lines = m[1]!.split("\n").filter((l) => l.trim().length > 0);
  const shown = lines.slice(0, MAX_DIAG_LINES).join("; ") + (lines.length > MAX_DIAG_LINES ? ` … and ${lines.length - MAX_DIAG_LINES} more` : "");
  return clip(shown, REFLECTION_DIAG_CHARS);
}

function isAborted(output: string): boolean { return output.startsWith(ABORTED_TOOL_RESULT); }

function failureNudge(tool: string, error: string): string {
  const excerpt = clip(error.trim(), REFLECTION_ERROR_CHARS).replace(/[.\s]+$/, "");
  return `${REFLECTION_PREFIX}the ${tool} call failed — ${excerpt}. ${REMEDY}`;
}

function diagnosticsNudge(tool: string, diag: string): string {
  return `${REFLECTION_PREFIX}the ${tool} introduced diagnostics — ${diag.replace(/[.\s]+$/, "")}. Fix them or explain.`;
}

function clip(s: string, max: number): string { return s.length <= max ? s : s.slice(0, Math.max(0, max - 1)) + "…"; }
