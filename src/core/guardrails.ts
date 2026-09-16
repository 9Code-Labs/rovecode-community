/**
 * Tool-loop guardrails — ported from hermes-agent `agent/tool_guardrails.py`
 * (snapshot: research/source_snapshots/hermes-agent). Bare `:N`
 * citations refer to that file; `run_agent.py:N` cites the runtime wiring.
 *
 * Pure and injectable: no I/O, no globals, no clock. State is one consecutive
 * identical-call streak plus a per-turn call ordinal — O(1) by construction
 * (upstream scalar fields :353-359, reset per user turn in `reset_for_turn`
 * :340-369). Only sha256 hashes are retained, never result payloads.
 *
 * Ported behavior:
 *  - Call signature = tool name + canonical JSON args (sorted keys, compact,
 *    unicode raw, `default=str`) — canonical_tool_args :285-295, hashed via
 *    ToolCallSignature.from_call :243-246 and _sha256 :849-855. Non-mapping
 *    args coerce to {} (:770-771).
 *  - Consecutive identical-call escalation, warn before stub: warn once the
 *    streak exceeds `warnAfterRepeats` (default 2, :119/:123 — first warn is
 *    the 3rd consecutive call, upstream's loop-notice threshold :85, fired
 *    :596-599); stub once it exceeds `stubAfterRepeats` (default 5,
 *    :120/:124 — before_call blocks :391-427 and the runtime substitutes a
 *    synthetic result, run_agent.py:8517-8519, :727-735 = "stub" here).
 *  - Duplicate-result dedup: from the 2nd consecutive identical call whose
 *    fresh result hashes identical (:608-616, :611), the payload becomes a
 *    reference stub (:629-657): min 512 chars (:93, :613), never for failed /
 *    error-looking results (:91-92, :612; classifier tail :326-328), args
 *    preview capped at 120 chars (:98, :642-643). A changed result flows
 *    through whole and resets the streak (:570-571, :585-591).
 *  - Poller exemption: repeatable tools (`process`, `*_get_result`, `*_poll`)
 *    never receive warn/stub verdicts (:63-80, :101-105) but their duplicate
 *    results ARE still dedup-stubbed (:562-567).
 *
 * Deliberate deviations (also listed in the port report):
 *  - `hardStop` defaults to true (upstream hard_stop_enabled false, :118):
 *    the rovecode GuardVerdict contract requires warn→stub escalation by
 *    default. Pass `hardStop: false` for upstream's warn-only default.
 *  - Upstream escalates on failed / idempotent-no-progress completions
 *    (:443-520); the port escalates on consecutive same-signature repetition
 *    (:344-359), forgiven when `checkResult` sees a changed result
 *    (progress-resets, :502-503, :585-591).
 *  - Hermes failure classifiers (:312-324), per-turn caps (:659-724), and
 *    spillover-path stubs (:619-627, :651-657) are out of scope here.
 *  - The dedup stub notes the original result length (task requirement;
 *    upstream omits it, :646-650) and points at the per-turn call ordinal
 *    instead of a tool_call_id (this API has none; upstream likewise omits
 *    the pointer when no id exists, :644-645).
 *  - Poller exemption reaches THROUGH rovecode's mcp_call indirection: every
 *    MCP tool is funneled via the single mcp_call house tool
 *    (src/mcp/tools.ts), so upstream's suffix exemption — aimed at
 *    "generated / MCP tool surfaces" (:74-76) — checks the INNER args.tool
 *    name for mcp_call. Signatures are unaffected (they hash full args).
 *
 * Wiring contract (sequential, as upstream executes tool batches): per tool
 * call run `checkCall` → execute when action !== "stub" → `checkResult` with
 * the RAW output (run_agent.py:8475-8478 — observe the raw result, before any
 * appended guidance). Interleaved/parallel wiring degrades gracefully to
 * fewer detections, never false positives.
 */

import { createHash } from "node:crypto";

export interface GuardVerdict {
  action: "allow" | "warn" | "stub";
  /** when warn/stub: text to surface to the model instead of/alongside execution */
  note?: string;
}

/** Thresholds mirror upstream defaults; all overridable. */
export interface GuardrailsOptions {
  /** gate for warn verdicts (upstream warnings_enabled :117; default true) */
  warningsEnabled?: boolean;
  /** gate for stub verdicts (upstream hard_stop_enabled :118 — false there,
   *  true here; see module doc "deviations") */
  hardStop?: boolean;
  /** identical consecutive calls tolerated before warns start; default 2
   *  (:119/:123) — first warn is the 3rd consecutive call (:85) */
  warnAfterRepeats?: number;
  /** identical consecutive calls tolerated before further ones are stubbed;
   *  default 5 (:120/:124) — the 6th consecutive call is the first blocked */
  stubAfterRepeats?: number;
  /** duplicate results shorter than this are never dedup-stubbed; default 512
   *  (IDENTICAL_RESULT_STUB_MIN_CHARS :93) */
  dedupMinChars?: number;
  /** canonical-args preview length inside the dedup stub; default 120
   *  (_RESULT_STUB_ARGS_PREVIEW_CHARS :98) */
  argsPreviewChars?: number;
  /** poller tools exempt from warn/stub verdicts
   *  (STALL_GUARD_REPEATABLE_TOOLS :68-72) */
  repeatableTools?: readonly string[];
  /** poller name suffixes exempt likewise (:77-80) */
  repeatableSuffixes?: readonly string[];
}

/** Upstream defaults (citations above), exported for tests and callers. */
export const GUARDRAIL_DEFAULTS = {
  warningsEnabled: true,
  hardStop: true,
  warnAfterRepeats: 2,
  stubAfterRepeats: 5,
  dedupMinChars: 512,
  argsPreviewChars: 120,
  repeatableTools: ["process"],
  repeatableSuffixes: ["_get_result", "_poll"],
} as const satisfies Required<GuardrailsOptions>;

interface ResolvedOptions {
  warningsEnabled: boolean;
  hardStop: boolean;
  warnAfterRepeats: number;
  stubAfterRepeats: number;
  dedupMinChars: number;
  argsPreviewChars: number;
  repeatableTools: ReadonlySet<string>;
  repeatableSuffixes: readonly string[];
}

/** The single consecutive identical-call streak (upstream fields :353-359). */
interface Streak {
  sig: string;
  /** consecutive identical-signature calls, current call included */
  count: number;
  /** hash of the streak's last observed result; null until one is seen */
  resultHash: string | null;
  /** 1-based per-turn ordinal of the streak's first call — the dedup stub
   *  pointer (_identical_streak_first_call_id :357-359) */
  firstCallIndex: number;
  /** ordinal of the most recent call — becomes the new first when a changed
   *  result starts a fresh streak (:589-591) */
  lastCallIndex: number;
}

/** Sorted-key compact JSON — ports canonical_tool_args (:285-295): sort_keys,
 *  separators (",",":"), unicode kept raw, default=str for non-JSON values.
 *  Key sort is UTF-16 code-unit order (deterministic; differs from Python's
 *  code-point sort only for astral-plane keys). Cycles degrade to a marker
 *  instead of throwing: a guardrail must never take down the loop. */
export function canonicalJson(value: unknown, seen: Set<object> = new Set()): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      // Python json emits NaN/Infinity literally (allow_nan default) — match it
      return Number.isFinite(value) ? JSON.stringify(value) : String(value);
    case "string":
      return JSON.stringify(value);
    case "object":
      break;
    default:
      // default=str (:294): undefined / bigint / function / symbol → quoted str()
      return JSON.stringify(String(value));
  }
  const obj = value as object;
  if (seen.has(obj)) return '"[circular]"';
  seen.add(obj);
  try {
    if (Array.isArray(obj)) {
      return `[${obj.map((v) => canonicalJson(v, seen)).join(",")}]`;
    }
    const record = obj as Record<string, unknown>;
    const parts = Object.keys(record)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k], seen)}`);
    return `{${parts.join(",")}}`;
  } finally {
    seen.delete(obj); // DAG-safe: only true cycles hit the marker
  }
}

/** Non-mapping args (arrays included) coerce to {} — ports _coerce_args (:770-771). */
function coerceArgs(args: unknown): Record<string, unknown> {
  if (typeof args === "object" && args !== null && !Array.isArray(args)) {
    return args as Record<string, unknown>;
  }
  return {};
}

/** Deterministic content hash. Upstream hashes utf-8 with surrogatepass
 *  (:849-855); hashing UTF-16LE code units is likewise lossless for lone
 *  surrogates (utf-8 would collapse them to U+FFFD) and never throws. */
function sha256(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf16le")).digest("hex");
}

/** Signature = tool name + hash of canonical args (ToolCallSignature.from_call
 *  :243-246). Same tool + same canonical args ⇒ same signature; different
 *  args ⇒ different signature ⇒ never a loop. */
function signatureOf(tool: string, args: unknown): string {
  return `${tool}\u0000${sha256(canonicalJson(coerceArgs(args)))}`;
}

/** Poller-exemption name: rovecode routes all MCP tools through the one `mcp_call`
 *  house tool, so upstream's MCP-surface poller suffixes (:74-80) can never
 *  match the outer name — unwrap to inner args.tool (module doc "deviations").
 *  Exemption only; signatures stay outer name + full args. */
function exemptionName(tool: string, args: unknown): string {
  if (tool === "mcp_call") {
    const inner = coerceArgs(args)["tool"];
    if (typeof inner === "string" && inner.length > 0) return inner;
  }
  return tool;
}

/** Ports _result_hash (:774-789): JSON results are canonicalized before
 *  hashing; non-JSON hashes raw. Upstream's safe_json_loads yields None for
 *  invalid JSON and literal null alike, so parsed null also hashes raw. */
function resultHash(output: string): string {
  let canonical = output;
  try {
    const parsed: unknown = JSON.parse(output);
    if (parsed !== null) canonical = canonicalJson(parsed);
  } catch {
    // not JSON → hash the raw string (:787-788)
  }
  return sha256(canonical);
}

/** Generic error sniff, ported from classify_tool_failure's fallback tail
 *  (:326-328); errors are never dedup-stubbed (:91-92, :612). Hermes-specific
 *  branches (:312-324) are not ported. */
function looksFailed(output: string): boolean {
  if (output.startsWith("Error")) return true;
  const head = output.slice(0, 500).toLowerCase();
  return head.includes('"error"') || head.includes('"failed"');
}

/** English ordinal ("3rd", "11th") — ports the notice's inline ordinal (:600). */
function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

/** Junk / non-positive threshold values fall back to the default — ports
 *  _positive_int (:808-815), including float truncation via int(). */
function positiveInt(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  const parsed = Math.trunc(value);
  return parsed >= 1 ? parsed : fallback;
}

export class ToolGuard {
  private readonly opts: ResolvedOptions;
  private streak: Streak | null = null;
  private callIndex = 0;

  constructor(opts?: GuardrailsOptions) {
    const d = GUARDRAIL_DEFAULTS;
    this.opts = {
      warningsEnabled: typeof opts?.warningsEnabled === "boolean" ? opts.warningsEnabled : d.warningsEnabled,
      hardStop: typeof opts?.hardStop === "boolean" ? opts.hardStop : d.hardStop,
      warnAfterRepeats: positiveInt(opts?.warnAfterRepeats, d.warnAfterRepeats),
      stubAfterRepeats: positiveInt(opts?.stubAfterRepeats, d.stubAfterRepeats),
      dedupMinChars: positiveInt(opts?.dedupMinChars, d.dedupMinChars),
      argsPreviewChars: positiveInt(opts?.argsPreviewChars, d.argsPreviewChars),
      repeatableTools: new Set(opts?.repeatableTools ?? d.repeatableTools),
      repeatableSuffixes: [...(opts?.repeatableSuffixes ?? d.repeatableSuffixes)],
    };
  }

  /** Count of signature records retained. Typed `number` (not `0 | 1`) so
   *  tests of the O(1) bound are not type-system tautologies; the
   *  single-streak design (:353-359) keeps it ≤ 1. */
  get trackedSignatures(): number {
    return this.streak ? 1 : 0;
  }

  /** Before execution: same-signature repetition tracking (tool + canonical
   *  args). Any different call resets the streak (:344-351); pollers are
   *  never annotated (:63-72). Escalation: allow → warn (> warnAfterRepeats)
   *  → stub (> stubAfterRepeats), upstream's warn-before-block order. */
  checkCall(tool: string, args: unknown): GuardVerdict {
    this.callIndex += 1;
    const sig = signatureOf(tool, args);
    if (this.streak !== null && this.streak.sig === sig) {
      this.streak.count += 1;
      this.streak.lastCallIndex = this.callIndex;
    } else {
      this.streak = {
        sig,
        count: 1,
        resultHash: null,
        firstCallIndex: this.callIndex,
        lastCallIndex: this.callIndex,
      };
    }
    if (this.isRepeatable(exemptionName(tool, args))) return { action: "allow" };
    const count = this.streak.count;
    if (this.opts.hardStop && count > this.opts.stubAfterRepeats) {
      // block message modeled on before_call's (:396-399, :416-419); surfaced
      // as a synthetic result upstream (run_agent.py:8517-8519, :727-735)
      return {
        action: "stub",
        note:
          `[rovecode loop guard: blocked ${tool} — this is the ${ordinal(count)} consecutive call ` +
          `with identical arguments. Stop repeating it unchanged; change arguments or strategy, ` +
          `use a different tool, or proceed with what you already have.]`,
      };
    }
    if (this.opts.warningsEnabled && count > this.opts.warnAfterRepeats) {
      // warn text modeled on the identical-call loop notice (:600-606)
      return {
        action: "warn",
        note:
          `[rovecode loop guard: this is the ${ordinal(count)} consecutive call to ${tool} ` +
          `with identical arguments. This looks like a loop — change arguments, use a ` +
          `different tool, or proceed with what you have.]`,
      };
    }
    return { action: "allow" };
  }

  /** After execution: byte-identical duplicate result detection (:608-616);
   *  from the 2nd consecutive identical call the payload becomes a reference
   *  stub; a changed result passes whole and resets the streak (:570-571,
   *  :585-591). Call with the RAW output (run_agent.py:8475-8478). `ok` is
   *  the caller's structured success flag: FAILED results (ok=false) are
   *  NEVER stubbed — upstream keeps every error verbatim (:91-92, :612) —
   *  the string sniff is only a fallback when `ok` is not given. */
  checkResult(tool: string, args: unknown, output: string, ok?: boolean): { output: string; deduped: boolean } {
    const sig = signatureOf(tool, args);
    const hash = resultHash(output);
    if (this.streak === null || this.streak.sig !== sig) {
      // Result for a call this guard did not see via checkCall (out-of-order
      // wiring) — adopt it as a fresh streak baseline; detection degrades
      // gracefully, never false-positives.
      const idx = Math.max(1, this.callIndex);
      this.streak = { sig, count: 1, resultHash: hash, firstCallIndex: idx, lastCallIndex: idx };
      return { output, deduped: false };
    }
    const s = this.streak;
    if (s.resultHash === null) {
      s.resultHash = hash; // first result of the streak = baseline
      return { output, deduped: false };
    }
    if (s.resultHash !== hash) {
      // Changed result = progress: the current call starts a new streak
      // (:585-591) — this also forgives checkCall's warn/stub escalation,
      // mirroring upstream's reset-on-changed-hash (:502-503).
      s.count = 1;
      s.resultHash = hash;
      s.firstCallIndex = s.lastCallIndex;
      return { output, deduped: false };
    }
    // Identical result (byte-identical; canonically identical for JSON, :774-789).
    if (
      s.count < 2 || // stub only from the 2nd identical call (:611)
      output.length < this.opts.dedupMinChars || // (:93, :613)
      ok === false || // structured failure: errors always pass verbatim (:91-92, :612)
      looksFailed(output) // string-sniff fallback when the caller gave no ok flag
    ) {
      return { output, deduped: false };
    }
    return { output: this.buildDedupStub(tool, args, output.length, s.firstCallIndex), deduped: true };
  }

  /** USER-turn boundary — call once per agentLoop invocation (and per queued
   *  follow-up), NEVER per model iteration inside the loop: upstream
   *  reset_for_turn runs at the start of each run_conversation
   *  (turn_context.py:700), once per user message; the streak must survive
   *  model iterations or the guard is inert (:338, :340-369). */
  onTurn(): void {
    this.reset();
  }

  /** Full reset — same as onTurn (all upstream state is per-user-turn). */
  reset(): void {
    this.streak = null;
    this.callIndex = 0;
  }

  /** Ports is_stall_guard_repeatable (:101-105): allowlisted background-job
   *  pollers (:68-72) plus vendor poller suffixes (:77-80). Exempt from
   *  warn/stub verdicts; NOT exempt from result dedup (:562-567). */
  private isRepeatable(tool: string): boolean {
    if (this.opts.repeatableTools.has(tool)) return true;
    return this.opts.repeatableSuffixes.some((suffix) => tool.endsWith(suffix));
  }

  /** Ports _build_result_reference_stub (:629-657): tool name + pointer to the
   *  first occurrence + canonical-args preview so the model still knows WHAT
   *  the call was if compression later evicts the referenced result (:96-98).
   *  Deviations: per-turn call ordinal instead of tool_call_id (:644-645) and
   *  the original length is noted (task requirement; upstream omits it). */
  private buildDedupStub(tool: string, args: unknown, originalLen: number, firstCallIndex: number): string {
    let preview = canonicalJson(coerceArgs(args));
    if (preview.length > this.opts.argsPreviewChars) {
      preview = preview.slice(0, this.opts.argsPreviewChars) + "…"; // (:642-643)
    }
    return (
      `[rovecode note: this result is byte-identical to the ${tool} result of call ` +
      `#${firstCallIndex} earlier this turn (original ${originalLen} chars). ` +
      `Refer to that result; it has not changed. Args: ${preview}]`
    );
  }
}
