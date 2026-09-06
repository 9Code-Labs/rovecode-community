/** Role router + provider fallback chains (port #14). ModelRef resolver + StreamFn wrapper —
 *  NO second agent loop (ADR-003): the wrapper makes one bounded pass over a chain's remaining
 *  candidates inside a single stream invocation; same-model retry/backoff is the port-#23
 *  withRetry wrapper, which sits INSIDE this wrap (retries exhaust before the chain advances).
 *
 *  Role table (oh-my-pi, MIT — research/source_snapshots/can1357-oh-my-pi):
 *  - Role names ported as the documented SUBSET default/smol/plan/commit/task of OMP's
 *    ModelRole union (packages/coding-agent/src/config/model-roles.ts:22-32; full set adds
 *    slow/vision/designer/tiny/advisor). Config shape mirrors OMP's `modelRoles` record
 *    (config/settings-schema.ts:668, :6315 — Record<role, selector>).
 *  - Missing/unknown role → the "default" role (config/model-resolver.ts:1017
 *    DEFAULT_MODEL_ROLE; configured-value-else-defaults resolution :1155-1189).
 *  - Precedence: explicit request selector > configured role chain > default chain, per
 *    OMP's resolveEffectiveAgentModelSelection (model-resolver.ts:1229-1261
 *    requestModel > settingsOverride > agentModel > default).
 *  - Selector grammar: "provider/model" split on the FIRST slash so model ids keep their own
 *    slashes (model-resolver.ts:214-216); comma-separated ordered candidate lists
 *    (model-resolver.ts:1051-1055 normalizeModelPatternList); per-role ordered chains as in
 *    OMP's priority.json:2-23 (rolePriorityDefaults, model-resolver.ts:1110-1113).
 *  - NOT ported: OMP's fuzzy/glob matching, thinking-level suffixes, custom role aliases and
 *    alias cycle guard (rovecode chains are flat ModelRefs — no aliases, so no cycles).
 *
 *  Fallback chains (gemini-cli, Apache-2.0 @0bd1d43 — research/source_snapshots/
 *  google-gemini-gemini-cli, packages/core/src):
 *  - Ordered chain, "the first model in the chain is the primary model"
 *    (availability/modelPolicy.ts:52-56 ModelPolicyChain).
 *  - Trigger conditions ported from utils/retry.ts isRetryableError (:170-209): advance on
 *    HTTP 429 or 5xx; NEVER on 400 (:193-194 "Explicitly do not retry 400"); non-HTTP
 *    transport failures (fetch failed / network codes / incomplete stream JSON) are
 *    retryable (:49-62, :122-123, :141-147, :180-189). gemini-cli additionally retries 499;
 *    the bar pins 429/5xx, so 499 is deliberately NOT retryable here (documented deviation).
 *  - Aborts never advance the chain (retry.ts:337-339 rethrows AbortError untouched).
 *  - On failure the handler picks the FIRST AVAILABLE later candidate and never falls back
 *    to the failed model itself (fallback/handler.ts:59-76); the switch is STICKY for the
 *    session via activateFallbackMode (handler.ts:163-169). Sticky here = per wrapped
 *    StreamFn, reset when a chain exhausts (rovecode simplification: gemini-cli instead tracks
 *    per-model health and marks models healthy again on success, retry.ts:330-334).
 *  - gemini-cli retries the new model immediately (retry.ts:404, :459 `attempt = 0; continue`)
 *    inside its retryWithBackoff loop; rovecode tries each candidate ONCE per invocation — no
 *    delays, no attempt reset (ADR-003: no second loop). Status is read from the seam's
 *    error TEXT ("HTTP <status>: <body>" — built by src/providers/stream-errors.ts httpErrorTurn), the same
 *    message-sniffing fallback gemini-cli itself uses (retry.ts:553-558).
 *  - Mid-stream failure: gemini-cli re-streams and signals the consumer with a RETRY event
 *    (core/geminiChat.ts:655-679). Rovecode's StreamEvent grammar (core/types.ts:47-50) has no
 *    such variant and is shared/untouchable, so forwarded text_delta events from a failed
 *    attempt simply stand; canonical content is the terminal turn only (core/loop.ts
 *    collectTurn:219-226), so the final message is never corrupted. The "note" on each
 *    advance is therefore an onNote CALLBACK, not a StreamEvent.
 *  - Exhausted chain → terminal turn with stopReason "error"; this wrapper NEVER throws
 *    (ADR-003 seam contract), even when the wrapped stream does.
 *  - A SINGLE-candidate chain has nothing to advance to: a retryable failure is yielded
 *    UNTOUCHED — no exhausted-rewrite, no note — so plain provider errors survive verbatim
 *    (R2 #14 LOW/MED-4).
 *  - A requested model outside every configured chain is a passthrough singleton, unless
 *    `looseFallback` is set (runtime sets it when chains are explicit user config): then the
 *    request is PREPENDED to the default chain — gemini-cli's shape, where "the first model
 *    in the chain is the primary model" is whatever was requested and configured fallbacks
 *    follow (R2 #14 MED-3).
 *  - The candidate that produced each terminal turn is recorded per turn object (servedBy)
 *    so the loop stamps Message.origin with the model that SERVED, not the one it asked
 *    for (R2 #14 HIGH-2). */

import type { AssistantTurn, ModelRef, StreamFn, StreamEvent, TokenUsage } from "../core/types.ts";

// ---------- roles (OMP subset, documented above) ----------

export type ModelRole = "default" | "smol" | "plan" | "commit" | "task";

export const MODEL_ROLES: readonly ModelRole[] = ["default", "smol", "plan", "commit", "task"];

export interface RouterNote {
  /** Chain identity: role name when the model belongs to a configured role chain,
   *  else "provider/model" of the loose (passthrough) model. */
  chain: string;
  from: ModelRef;
  /** Next candidate, or null when this failure exhausted the chain. */
  to: ModelRef | null;
  /** The failed turn's error text, e.g. "HTTP 429: ...". */
  reason: string;
}

export interface RouterConfig {
  /** Role → primary ModelRef or ordered fallback chain (first = primary,
   *  gemini-cli modelPolicy.ts:52-56). `default` is required; other roles optional. */
  roles: Partial<Record<ModelRole, ModelRef | readonly ModelRef[]>> & { default: ModelRef | readonly ModelRef[] };
  /** Keep fallback switches for later calls on the same wrapped stream (gemini-cli
   *  activateFallbackMode, handler.ts:163-169). Default true; exhaustion resets. */
  sticky?: boolean;
  /** Treat the default chain as the fallback pool for models outside EVERY configured
   *  chain: the requested model is prepended as the primary (header: MED-3). Default
   *  false — a synthesized single-model default (no explicit chain config) must not
   *  drag loose models onto a placeholder ref. */
  looseFallback?: boolean;
  /** Advance notification — see header for why this is a callback, not a StreamEvent. */
  onNote?: (note: RouterNote) => void;
}

export interface Router {
  /** Full ordered chain for a role; unknown/unconfigured roles get the default chain. */
  chain(role: string): readonly ModelRef[];
  /** Primary ModelRef for a role. `explicit` (request selector or ModelRef) wins over the
   *  role table — OMP request>config precedence (model-resolver.ts:1229-1261). */
  resolve(role: string, explicit?: string | ModelRef): ModelRef;
  /** Wrap a StreamFn with chain-advance-on-failure. Non-turn events pass through live. */
  wrap(stream: StreamFn): StreamFn;
}

// ---------- selector parsing (OMP model-resolver.ts:214-216, :1051-1055) ----------

/** "provider/model" split on the FIRST slash (model ids keep their own slashes, e.g.
 *  "kaesra/zai-org/glm-5.3-flash"); no slash → model on `defaultProvider`. */
export function parseModelRef(selector: string, defaultProvider: string): ModelRef {
  const s = selector.trim();
  const slash = s.indexOf("/");
  if (slash <= 0) return { provider: defaultProvider, model: s };
  return { provider: s.slice(0, slash), model: s.slice(slash + 1) };
}

/** Comma-separated ordered candidate list → ModelRef chain. */
export function parseModelChain(selectors: string, defaultProvider: string): ModelRef[] {
  return selectors
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => parseModelRef(s, defaultProvider));
}

const ROLE_ENV: Record<ModelRole, string> = {
  default: "ROVECODE_MODEL_DEFAULT",
  smol: "ROVECODE_MODEL_SMOL",
  plan: "ROVECODE_MODEL_PLAN",
  commit: "ROVECODE_MODEL_COMMIT",
  task: "ROVECODE_MODEL_TASK",
};

/** Role table from env (ROVECODE_MODEL_DEFAULT/SMOL/PLAN/COMMIT/TASK, each a comma-separated
 *  "provider/model" chain). Unset default → [fallback] (the provider-derived model). */
export function roleTableFromEnv(
  fallback: ModelRef,
  env: Record<string, string | undefined> = process.env,
): RouterConfig["roles"] {
  const roles: Partial<Record<ModelRole, ModelRef[]>> = {};
  for (const role of MODEL_ROLES) {
    const raw = env[ROLE_ENV[role]];
    if (raw && raw.trim().length > 0) {
      const chain = parseModelChain(raw, fallback.provider);
      if (chain.length > 0) roles[role] = chain;
    }
  }
  return { ...roles, default: roles.default ?? [fallback] };
}

// ---------- failure classification (gemini-cli retry.ts:170-209; rovecode stream.ts:78,109,171) ----------

export interface StreamErrorClass {
  /** HTTP status parsed from the seam's "HTTP <status>: ..." error text, if present. */
  status?: number;
  /** Advance-the-chain eligible: 429, 5xx, or a non-HTTP transport failure. */
  retryable: boolean;
}

export function classifyStreamError(error: string | undefined): StreamErrorClass {
  const m = /^HTTP (\d{3})\b/.exec(error ?? "");
  if (m) {
    const status = Number(m[1]);
    return { status, retryable: status === 429 || (status >= 500 && status < 600) };
  }
  // `config: …` (providers/registry.ts dispatcher: unknown provider, missing key) — a configuration
  // mistake neither a retry nor the next chain candidate can fix; the human can. Never retryable.
  if ((error ?? "").startsWith("config: ")) return { retryable: false };
  // No HTTP prefix → the fetch itself failed (network/SSL/parse) — retryable per
  // gemini-cli retry.ts:49-62,122-123,141-147,180-189.
  return { retryable: true };
}

// ---------- served-model tagging (R2 #14 HIGH-2) ----------

/** ModelRef that actually produced a terminal turn, keyed on the turn object itself — a
 *  WeakMap side-channel because the StreamEvent grammar (core/types.ts:49-52) is shared/
 *  untouchable (no new event variant, no new turn field). Per-invocation by construction:
 *  each terminal turn is a distinct object. Unwrapped streams never mark their turns, so
 *  consumers fall back to the model they asked for. */
const SERVED = new WeakMap<AssistantTurn, ModelRef>();

/** The chain candidate that served `turn`, when the router produced it. loop.ts stamps
 *  Message.origin with this so /cost prices the model that ANSWERED after a fallback. */
export function servedBy(turn: AssistantTurn): ModelRef | undefined {
  return SERVED.get(turn);
}

// ---------- router ----------

const sameRef = (a: ModelRef, b: ModelRef): boolean => a.provider === b.provider && a.model === b.model;
const refKey = (m: ModelRef): string => `${m.provider}/${m.model}`;
const zeroUsage = (): TokenUsage => ({ input: 0, output: 0 });
const errorTurn = (error: string): AssistantTurn => ({ parts: [], stopReason: "error", usage: zeroUsage(), error });

export function createRouter(config: RouterConfig): Router {
  const table = new Map<ModelRole, readonly ModelRef[]>();
  for (const role of MODEL_ROLES) {
    const entry = config.roles[role];
    if (!entry) continue;
    const chain: readonly ModelRef[] = Array.isArray(entry) ? entry : [entry];
    if (chain.length > 0) table.set(role, chain);
  }
  const defaults = table.get("default");
  // Factory-time misconfiguration (empty default chain) is a programmer error and may
  // throw; the ADR-003 never-throw contract applies to the stream path below.
  if (!defaults) throw new Error("router: roles.default must contain at least one ModelRef");

  const chainFor = (role: string): readonly ModelRef[] => table.get(role as ModelRole) ?? defaults;

  /** Chain containing `model`: prefer the role whose chain HEAD is the model (that is what
   *  resolve() hands the loop), else the first role chain containing it anywhere, else —
   *  under `looseFallback` — the model PREPENDED to the default chain (header: MED-3; the
   *  request stays the primary, configured models become its fallbacks), else a singleton
   *  passthrough chain. Scan order = MODEL_ROLES order (deterministic). */
  const locate = (model: ModelRef): { key: string; chain: readonly ModelRef[]; index: number } => {
    let containing: { key: string; chain: readonly ModelRef[]; index: number } | null = null;
    for (const role of MODEL_ROLES) {
      const chain = table.get(role);
      if (!chain) continue;
      const idx = chain.findIndex((c) => sameRef(c, model));
      if (idx === 0) return { key: role, chain, index: 0 };
      if (idx > 0 && containing === null) containing = { key: role, chain, index: idx };
    }
    if (containing) return containing;
    // model ∉ any chain (the scan above covered `default`), so the prepend never duplicates
    const chain = config.looseFallback === true ? [model, ...defaults] : [model];
    return { key: refKey(model), chain, index: 0 };
  };

  return {
    chain: chainFor,

    resolve(role: string, explicit?: string | ModelRef): ModelRef {
      const chain = chainFor(role);
      const head = chain[0]!; // chains in `table` are never empty
      if (explicit !== undefined) {
        return typeof explicit === "string" ? parseModelRef(explicit, head.provider) : explicit;
      }
      return head;
    },

    wrap(stream: StreamFn): StreamFn {
      const sticky = config.sticky ?? true;
      const survivors = new Map<string, number>(); // chain key → sticky start index
      return async function* (model, messages, options): AsyncGenerator<StreamEvent> {
        const { key, chain, index } = locate(model);
        const start = sticky
          ? Math.min(Math.max(index, survivors.get(key) ?? 0), chain.length - 1)
          : index;
        let last: AssistantTurn | null = null;
        for (let i = start; i < chain.length; i++) {
          const candidate = chain[i]!;
          let turn: AssistantTurn | null = null;
          let streamed = false; // any delta reached the consumer from THIS candidate
          try {
            for await (const ev of stream(candidate, messages, options)) {
              if (ev.type === "turn") turn = ev.turn;
              else { if (ev.type === "text_delta" || ev.type === "reasoning_delta") streamed = true; yield ev; } // deltas pass through live (header: mid-stream failure note)
            }
          } catch (e) {
            // Defensive: the seam contract says streams never throw; if one does, keep the
            // never-throw guarantee here by folding it into an error turn.
            turn = errorTurn(e instanceof Error ? e.message : String(e));
          }
          const t: AssistantTurn = turn ?? errorTurn("stream ended without a terminal turn");
          const aborted = options?.signal?.aborted === true; // retry.ts:337-339: aborts never advance
          // chain.length === 1: nothing to advance to — surface the provider error untouched,
          // no exhausted-rewrite, no note (header: LOW/MED-4).
          // streamed: part of an answer already reached the screen — a re-drive on the next candidate would
          // print a second answer under the first; the failure stands (retry.ts applies the same rule)
          if (t.stopReason !== "error" || aborted || streamed || !classifyStreamError(t.error).retryable || chain.length === 1) {
            SERVED.set(t, candidate); // header: HIGH-2 — this candidate produced the turn
            yield { type: "turn", turn: t }; // success or non-retryable: NO advance
            return;
          }
          last = t;
          const next = i + 1 < chain.length ? chain[i + 1]! : null;
          if (sticky && next !== null) survivors.set(key, i + 1); // handler.ts:163-169 sticky switch
          config.onNote?.({ chain: key, from: candidate, to: next, reason: t.error ?? "error" });
        }
        if (sticky) survivors.delete(key); // exhausted: reset so recovered models get retried
        const tried = chain.length - start;
        const exhausted = errorTurn(
          `model chain '${key}' exhausted (${tried} candidate${tried === 1 ? "" : "s"} failed); last: ${last?.error ?? "unknown error"}`,
        );
        SERVED.set(exhausted, chain[chain.length - 1]!); // last candidate attempted (status honesty)
        yield { type: "turn", turn: exhausted };
      };
    },
  };
}
