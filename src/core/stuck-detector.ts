/**
 * 5-pattern stuck detector core (eval P0-4 / gap G12).
 *
 * Ports OpenHands' agent-stuck-detector semantics (docs.openhands.dev/sdk/guides/
 * agent-stuck-detector.md, thresholds verified in the harness research, G12) as a PURE
 * module: no I/O, no clock, no loop imports, bounded memory (a 64-step window). The
 * loop integration has a SINGLE OWNER by coordinator decision (Orca msg_ef37004c2122,
 * 2026-09-14) — this file deliberately ships the detector + its API and stops there.
 * Wire it as a middleware by calling `observe` per loop step and `detect` where a
 * verdict is needed; nothing in the loop changes until that owner lands the seam.
 *
 * The five patterns (defaults follow the research: 4 / 3 / 3 / 6, context-window 2):
 *  1. repeated-action-observation — the same (action, observation) pair repeated
 *     ≥ 4 times consecutively; a CHANGED observation resets it (progress forgives).
 *  2. repeated-action-error       — the same failing action ≥ 3 times consecutively.
 *  3. monologue                   — ≥ 3 assistant turns with no tool call in a row
 *                                     (talking instead of working); any action or user
 *                                     turn resets.
 *  4. ping-pong                   — two action signatures strictly alternating
 *                                     ≥ 6 times (A,B,A,B,A,B); a third signature or a
 *                                     repeat breaks it.
 *  5. context-window-thrash       — ≥ 2 consecutive context-window errors (the G10
 *                                     "compacted and immediately full" signature,
 *                                     represented here via isContextWindowError).
 *
 * False-positive protections (the part that makes it shippable):
 *  - poller exemption: `process` and *_get_result / *_poll style tools legitimately
 *    repeat — they are exempt from the two repetition patterns (same list hermes'
 *    guard uses, GUARDRAIL_DEFAULTS.repeatableTools/Suffixes).
 *  - progress resets: a changed observation, a successful action or a user/steering
 *    turn resets the relevant streaks; detection degrades to FEWER detections on
 *    interleaved/parallel wiring, never to more.
 *  - bounded window: only the last `windowSize` steps are remembered, so a single
 *    stale pattern cannot shadow a fresh run forever — and a long clean history
 *    cannot be re-judged from memory it no longer holds.
 */

export type StuckPattern =
  | "repeated-action-observation"
  | "repeated-action-error"
  | "monologue"
  | "ping-pong"
  | "context-window-thrash";

/** OpenHands-derived defaults. "Fires at" semantics: the pattern is reported once the
 *  run reaches the threshold (4+ pairs, 3+ errors, 3+ turns, 6+ alternations, 2+ errors). */
export const STUCK_THRESHOLDS = {
  actionObservation: 4,
  actionError: 3,
  monologue: 3,
  pingPong: 6,
  contextWindowErrors: 2,
  windowSize: 64,
} as const;

export interface StuckStep {
  kind: "action" | "observation" | "assistant" | "user";
  /** tool name (action/observation) */
  tool?: string;
  /** caller-computed canonical signature: action = tool+args hash, observation = output
   *  hash. The detector compares signatures; it never sees payloads. */
  signature?: string;
  /** observation success flag (action-error pattern) */
  ok?: boolean;
  /** observation errored because the context window/limit was hit (thrash pattern) */
  isContextWindowError?: boolean;
  /** assistant text length — a no-tool turn (monologue pattern) */
  textLength?: number;
}

export interface StuckEvent {
  pattern: StuckPattern;
  /** how many consecutive steps/pairs the pattern has run (≥ threshold) */
  count: number;
  detail: string;
}

export interface StuckThresholds {
  actionObservation: number;
  actionError: number;
  monologue: number;
  pingPong: number;
  contextWindowErrors: number;
}

export interface StuckDetectorOptions {
  thresholds?: Partial<StuckThresholds>;
  /** tools exempt from the repetition patterns (default: hermes' poller list) */
  repeatableTools?: readonly string[];
  /** name suffixes exempt likewise (default: ["_get_result", "_poll"]) */
  repeatableSuffixes?: readonly string[];
}

interface Resolved {
  thresholds: StuckThresholds;
  repeatableTools: ReadonlySet<string>;
  repeatableSuffixes: readonly string[];
  windowSize: number;
}

/** Severity order for report lists: hard errors first, chatty monologues last. */
const PATTERN_ORDER: readonly StuckPattern[] = [
  "context-window-thrash",
  "repeated-action-error",
  "repeated-action-observation",
  "ping-pong",
  "monologue",
];

function positiveInt(v: number | undefined, fallback: number): number {
  if (v === undefined || !Number.isFinite(v)) return fallback;
  const n = Math.trunc(v);
  return n >= 1 ? n : fallback;
}

export class StuckDetector {
  private readonly opts: Resolved;
  private window: StuckStep[] = [];

  constructor(opts?: StuckDetectorOptions) {
    const d = STUCK_THRESHOLDS;
    this.opts = {
      thresholds: {
        actionObservation: positiveInt(opts?.thresholds?.actionObservation, d.actionObservation),
        actionError: positiveInt(opts?.thresholds?.actionError, d.actionError),
        monologue: positiveInt(opts?.thresholds?.monologue, d.monologue),
        pingPong: positiveInt(opts?.thresholds?.pingPong, d.pingPong),
        contextWindowErrors: positiveInt(opts?.thresholds?.contextWindowErrors, d.contextWindowErrors),
      },
      repeatableTools: new Set(opts?.repeatableTools ?? ["process"]),
      repeatableSuffixes: opts?.repeatableSuffixes ?? ["_get_result", "_poll"],
      windowSize: d.windowSize,
    };
  }

  /** Feed one loop step (action = the assistant's tool call, observation = its result).
   *  Oldest steps beyond the window bound are forgotten. */
  observe(step: StuckStep): void {
    this.window.push(step);
    if (this.window.length > this.opts.windowSize) this.window.splice(0, this.window.length - this.opts.windowSize);
  }

  /** Active stuck patterns over the current window, most severe first. */
  detect(): StuckEvent[] {
    const events: StuckEvent[] = [];
    const push = (pattern: StuckPattern, count: number, detail: string): void => {
      events.push({ pattern, count, detail });
    };

    // 1+2. consecutive (action, observation) pairs — by action signature, split ok / error
    type Pair = { actionSig: string; obsSig: string | null; ok: boolean; tool: string };
    const pairs: Pair[] = [];
    let pending: { tool: string; sig: string } | null = null;
    for (const step of this.window) {
      if (step.kind === "action") {
        pending = { tool: step.tool ?? "?", sig: step.signature ?? "" };
        continue;
      }
      if (step.kind === "observation" && pending !== null) {
        pairs.push({ actionSig: pending.sig, obsSig: step.signature ?? null, ok: step.ok !== false, tool: pending.tool });
        pending = null;
      } else if (step.kind === "user" || step.kind === "assistant") {
        pending = null; // an interleaved non-observation breaks the pairing
      }
    }
    const exempt = (tool: string): boolean =>
      this.opts.repeatableTools.has(tool) || this.opts.repeatableSuffixes.some((s) => tool.endsWith(s));

    let okStreak: { sig: string; obs: string | null; tool: string; count: number } | null = null;
    let errStreak: { sig: string; tool: string; count: number } | null = null;
    let okMax: { count: number; tool: string } | null = null;
    let errMax: { count: number; tool: string } | null = null;
    for (const p of pairs) {
      const repeatable = exempt(p.tool);
      // ok-pairs: same action AND same observation signature — changed obs = progress
      if (!repeatable && p.ok && p.actionSig === okStreak?.sig && p.obsSig === okStreak.obs) {
        okStreak.count++;
      } else {
        okStreak = p.ok && !repeatable ? { sig: p.actionSig, obs: p.obsSig, tool: p.tool, count: 1 } : null;
      }
      if (okStreak !== null && (okMax === null || okStreak.count > okMax.count)) {
        okMax = { count: okStreak.count, tool: okStreak.tool };
      }
      // error-pairs: same action failing repeatedly
      if (!repeatable && !p.ok && p.actionSig === errStreak?.sig) {
        errStreak.count++;
      } else {
        errStreak = !p.ok && !repeatable ? { sig: p.actionSig, tool: p.tool, count: 1 } : null;
      }
      if (errStreak !== null && (errMax === null || errStreak.count > errMax.count)) {
        errMax = { count: errStreak.count, tool: errStreak.tool };
      }
    }
    if (okMax !== null && okMax.count >= this.opts.thresholds.actionObservation) {
      push("repeated-action-observation", okMax.count, `identical action+observation pair repeated ${okMax.count}× (tool ${okMax.tool})`);
    }
    if (errMax !== null && errMax.count >= this.opts.thresholds.actionError) {
      push("repeated-action-error", errMax.count, `the same failing action repeated ${errMax.count}× (tool ${errMax.tool})`);
    }

    // 3. monologue: consecutive assistant turns with no action in between
    let mono = 0;
    let monoMax = 0;
    for (const step of this.window) {
      if (step.kind === "assistant") {
        mono++;
        monoMax = Math.max(monoMax, mono);
      } else if (step.kind === "action" || step.kind === "user") {
        mono = 0;
      }
      // observations belong to their action; they do not reset the count
    }
    if (monoMax >= this.opts.thresholds.monologue) {
      push("monologue", monoMax, `${monoMax} consecutive assistant turns with no tool call`);
    }

    // 4. ping-pong: strict two-signature alternation (a repeat or a third signature breaks it)
    let cycle: string[] = [];
    let cycleMax = 0;
    for (const step of this.window) {
      if (step.kind !== "action" || step.signature === undefined || exempt(step.tool ?? "?")) {
        continue;
      }
      const sig = step.signature;
      if (cycle.length >= 2 && cycle[cycle.length - 1] === sig) {
        cycle = [sig]; // immediate repeat — that is pattern 1's territory, not alternation
      } else if (cycle.length >= 2 && cycle[cycle.length - 2] === sig) {
        cycle.push(sig); // continues the A,B,A… alternation
      } else if (cycle.length < 2) {
        cycle.push(sig);
      } else {
        cycle = [sig]; // a third signature broke it
      }
      cycleMax = Math.max(cycleMax, cycle.length);
    }
    if (cycleMax >= this.opts.thresholds.pingPong) {
      push("ping-pong", cycleMax, `two actions strictly alternating ${cycleMax}× without progress`);
    }

    // 5. context-window thrash: consecutive context-window errors
    let cw = 0;
    let cwMax = 0;
    for (const step of this.window) {
      if (step.isContextWindowError === true) {
        cw++;
        cwMax = Math.max(cwMax, cw);
      } else {
        cw = 0;
      }
    }
    if (cwMax >= this.opts.thresholds.contextWindowErrors) {
      push("context-window-thrash", cwMax, `${cwMax} consecutive context-window errors — the window refills as fast as it compacts`);
    }

    return events.sort((a, b) => PATTERN_ORDER.indexOf(a.pattern) - PATTERN_ORDER.indexOf(b.pattern));
  }

  isStuck(): boolean {
    return this.detect().length > 0;
  }

  /** Full reset (new run / new user turn). */
  reset(): void {
    this.window = [];
  }
}

/** Stateless form over a recorded step list (eval/replay, tests, offline analysis). */
export function detectStuck(steps: readonly StuckStep[], opts?: StuckDetectorOptions): StuckEvent[] {
  const d = new StuckDetector(opts);
  for (const s of steps) d.observe(s);
  return d.detect();
}
