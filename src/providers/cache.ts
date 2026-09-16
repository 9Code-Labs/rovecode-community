/** Anthropic prompt-cache boundary placement — pure transform for the /messages request body.
 *
 *  Prompt caching is a PREFIX match: the API render order is tools → system → messages, and a
 *  `cache_control: {type:"ephemeral"}` marker on a content block caches everything from the start
 *  of the request up to and including that block. Any byte change before a marker invalidates it.
 *  Therefore boundaries only pay off on STABLE prefixes — a boundary after content that changes
 *  every turn is a wasted breakpoint (Anthropic allows at most 4 per request).
 *
 *  Pattern reference (hermes-agent snapshot, research/source_snapshots/hermes-agent):
 *  - agent/prompt_caching.py:1-8 — "The default layout uses 4 cache_control breakpoints: the static
 *    system prefix, the end of the system prompt, and the last 2 non-system messages."
 *  - agent/prompt_caching.py:157-162 (_build_marker) — the marker is `{"type": "ephemeral"}`.
 *  - agent/prompt_caching.py:113-121 (_apply_cache_marker) — string content is converted to a
 *    single text block carrying the marker; list content gets the marker on its LAST block.
 *  - agent/prompt_caching.py:99-103, 331-333 — volatile tails ride UNMARKED ("a changed ticket ID
 *    or timestamp no longer invalidates the whole skill body"), and empty text blocks are never
 *    emitted (HTTP 400 on native Anthropic).
 *  - agent/prompt_caching.py:567-573 (apply_anthropic_cache_control) — idempotence contract:
 *    re-application "can never accumulate past 4 markers".
 *  - agent/system_prompt.py:911-924 and agent/turn_context.py:214-217 — the stability principle:
 *    volatile per-turn facts are kept OUT of / AFTER the cached band so the prefix stays
 *    byte-stable turn-over-turn.
 *
 *  Placement policy implemented here (deliberately simpler than Hermes' 4-marker layout):
 *  (1) SYSTEM boundary — `system: string` is converted to
 *      `[{type:"text", text, cache_control:{type:"ephemeral"}}]` when it is ≥ minChunkChars.
 *      A system-block array already provided by the caller gets the marker on its last block
 *      (unless any block is already marked). Because caching is prefix-based, this single marker
 *      also covers the `tools` array rendered before `system` — no separate tools marker needed.
 *  (2) CONVERSATION-PREFIX boundary — the marker goes on the LAST content block of the most
 *      recent message that has ≥ 2 messages after it (index length-3): an agent turn appends
 *      the trailing exchange (assistant tool_use + tool_result, or user + assistant), so the
 *      tail churns every turn while the prefix up to there is CANONICALLY stable — not
 *      byte-identical. Two rewrites make consecutive requests differ in raw bytes: the marker
 *      moves forward each turn (dropped from the old anchor, added at the new one), and the
 *      marked message's string content is rewritten to [{type:"text",...}] by
 *      withMarkerOnLastBlock below. Anthropic's cache key normalizes exactly those two
 *      (cache_control is placement metadata, and string content is equivalent to a single
 *      text block), so the previous request's prefix still cache-hits. Pinned by the
 *      consecutive-turn stability test in test/unit/cache.test.ts.
 *      If the anchor message cannot carry a marker (empty content — cf. Hermes _can_carry_marker,
 *      prompt_caching.py:127-140, "so the breakpoints land on messages that count"), the
 *      boundary reallocates to the nearest earlier eligible message. String content is
 *      converted to a one-block array, preserving the text byte-for-byte.
 *  (3) BUDGET — never exceed maxBreakpoints total, counting markers already present in
 *      system/messages/tools before placing new ones. System wins over conversation prefix.
 *  (4) IDEMPOTENT — a position that already carries a marker is left untouched, existing markers
 *      count toward the budget, and untouched inputs are returned by reference, so
 *      apply(apply(body)) deep-equals apply(body).
 *  (5) Bodies without messages/system pass through untouched (same reference), as does anything
 *      whose shapes don't match — this is a best-effort decorator, never a validator.
 *
 *  minChunkChars default: 4096 chars ≈ 1024 tokens (~4 chars/token) — the documented minimum
 *  cacheable prefix for Sonnet/Opus-class models (model-dependent, 512–4096 tokens per the API
 *  docs). Prefixes below the model minimum are silently NOT cached, so spending a breakpoint on
 *  them is pure waste. For the message boundary the gate compares the CUMULATIVE prefix
 *  (system + messages[0..anchor]) against minChunkChars, since that whole span is what the
 *  marker would cache (tools text is not counted — a conservative undercount).
 *
 *  Pure: the input body is never mutated; modified paths are copied copy-on-write.
 */

export interface CacheOptions {
  /** Maximum cache_control markers allowed in the request. Anthropic's limit — and the default — is 4. */
  maxBreakpoints?: number;
  /** Don't spend a breakpoint on a prefix shorter than this many characters. Default 4096 (≈1024 tokens). */
  minChunkChars?: number;
}

export interface CacheControl { type: "ephemeral" }

/** Loose ("-ish") view of the body anthropicStream builds (src/providers/stream.ts:152-160):
 *  `{ model, max_tokens, system?: string, messages: [...], tools?: [...] }`. Every field is
 *  unknown-typed so the adapter's `Record<string, unknown>` is directly assignable; this module
 *  narrows at runtime and passes through anything it does not recognize. */
export interface AnthropicishBody {
  system?: unknown;
  messages?: unknown;
  tools?: unknown;
  [key: string]: unknown;
}

export const DEFAULT_MAX_BREAKPOINTS = 4;
export const DEFAULT_MIN_CHUNK_CHARS = 4096;

const EPHEMERAL: CacheControl = { type: "ephemeral" };

type Rec = Record<string, unknown>;

function isRec(v: unknown): v is Rec {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Marker presence on a content block / tool entry (block-level only — the shapes this module emits). */
function hasMarker(block: unknown): boolean {
  return isRec(block) && block["cache_control"] !== undefined;
}

function blockText(block: unknown): string {
  if (!isRec(block)) return "";
  return typeof block["text"] === "string" ? block["text"] : "";
}

function systemChars(system: unknown): number {
  if (typeof system === "string") return system.length;
  if (Array.isArray(system)) return system.reduce((n: number, b) => n + blockText(b).length, 0);
  return 0;
}

function contentChars(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const b of content) {
    n += blockText(b).length;
    // tool_result blocks carry their payload under "content" (string form only; arrays undercount)
    if (isRec(b) && typeof b["content"] === "string") n += b["content"].length;
  }
  return n;
}

function messageMarkerCount(msg: unknown): number {
  if (!isRec(msg)) return 0;
  const content = msg["content"];
  return Array.isArray(content) ? content.filter(hasMarker).length : 0;
}

function countExistingMarkers(system: unknown, messages: readonly unknown[] | null, tools: unknown): number {
  let n = 0;
  if (Array.isArray(system)) n += system.filter(hasMarker).length;
  for (const m of messages ?? []) n += messageMarkerCount(m);
  if (Array.isArray(tools)) n += tools.filter(hasMarker).length;
  return n;
}

/** A marker on this message would actually land on the wire: non-empty string content (an empty
 *  string would convert to an empty text block — HTTP 400), or a non-empty block array whose last
 *  element is an object. Mirrors Hermes _can_carry_marker (prompt_caching.py:127-154). */
function canCarryMarker(msg: unknown): boolean {
  if (!isRec(msg)) return false;
  const content = msg["content"];
  if (typeof content === "string") return content.length > 0;
  if (Array.isArray(content) && content.length > 0) return isRec(content[content.length - 1]);
  return false;
}

/** Copy of `msg` with the ephemeral marker on its last content block; string content becomes a
 *  one-block array with the text preserved byte-for-byte (Hermes prompt_caching.py:113-121). */
function withMarkerOnLastBlock(msg: Rec): Rec {
  const content = msg["content"];
  if (typeof content === "string") {
    return { ...msg, content: [{ type: "text", text: content, cache_control: EPHEMERAL }] };
  }
  if (Array.isArray(content) && content.length > 0) {
    const last = content[content.length - 1];
    if (isRec(last)) {
      const blocks = content.slice();
      blocks[blocks.length - 1] = { ...last, cache_control: EPHEMERAL };
      return { ...msg, content: blocks };
    }
  }
  return msg; // callers gate on canCarryMarker(); unreachable in practice
}

export function applyAnthropicCacheBoundaries(body: AnthropicishBody, opts?: CacheOptions): AnthropicishBody {
  const maxBreakpoints = opts?.maxBreakpoints ?? DEFAULT_MAX_BREAKPOINTS;
  const minChunkChars = opts?.minChunkChars ?? DEFAULT_MIN_CHUNK_CHARS;

  const system = body.system;
  const messages: readonly unknown[] | null = Array.isArray(body.messages) ? body.messages : null;

  const hasSystem = (typeof system === "string" && system.length > 0) || (Array.isArray(system) && system.length > 0);
  const hasMessages = messages !== null && messages.length > 0;
  if (!hasSystem && !hasMessages) return body; // policy (5): pass through untouched

  let used = countExistingMarkers(system, messages, body.tools);
  let out = body;
  const copyOnWrite = (): AnthropicishBody => (out === body ? (out = { ...body }) : out);

  // ---- policy (1): system boundary ------------------------------------------------------------
  if (used < maxBreakpoints && hasSystem) {
    if (typeof system === "string") {
      if (system.length >= minChunkChars) {
        copyOnWrite().system = [{ type: "text", text: system, cache_control: EPHEMERAL }];
        used += 1;
      }
    } else if (Array.isArray(system) && !system.some(hasMarker)) {
      const last = system[system.length - 1];
      if (isRec(last) && systemChars(system) >= minChunkChars) {
        const blocks = system.slice();
        blocks[blocks.length - 1] = { ...last, cache_control: EPHEMERAL };
        copyOnWrite().system = blocks;
        used += 1;
      }
    }
  }

  // ---- policy (2): conversation-prefix boundary ------------------------------------------------
  // Anchor = most recent message with ≥2 messages after it (index length-3); the trailing two
  // messages are this turn's churn. Reallocate backwards past marker-incapable messages.
  if (used < maxBreakpoints && messages !== null && messages.length >= 3) {
    let anchor = -1;
    for (let i = messages.length - 3; i >= 0; i -= 1) {
      if (canCarryMarker(messages[i])) { anchor = i; break; }
    }
    const msg = anchor >= 0 ? messages[anchor] : undefined;
    if (isRec(msg) && messageMarkerCount(msg) === 0) {
      let prefixChars = systemChars(system);
      for (let i = 0; i <= anchor; i += 1) {
        const m = messages[i];
        if (isRec(m)) prefixChars += contentChars(m["content"]);
      }
      if (prefixChars >= minChunkChars) {
        const next = messages.slice();
        next[anchor] = withMarkerOnLastBlock(msg);
        copyOnWrite().messages = next;
        used += 1;
      }
    }
  }

  return out;
}
