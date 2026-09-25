/**
 * Secrets redaction for eval persistence (eval P0-5).
 *
 * Every string that lands in a trajectory JSONL — tool args, tool outputs, fixture
 * contents, evidence — goes through redactSecrets/redactDeep FIRST. The patterns cover
 * the credential shapes the harness actually handles (provider keys, Bearer/Basic auth
 * headers, JWTs, PEM private keys) plus the generic `key = "value"` assignments that
 * leak keys through tool output. Sensitive KEY names in structured args are redacted
 * regardless of value shape, because a value like `Bearer whatever` is not always
 * pattern-visible.
 *
 * Scope note (the research critique's premise, verified by
 * test/unit/eval-redact.test.ts): src/telemetry/otel.ts records ids, sizes and
 * outcomes only — it never carries args or output, so it needs no redaction pass and
 * this module deliberately does NOT touch it. If that contract ever erodes, the test
 * pins it red.
 *
 * Determinism matters more than recall here: replays compare hashes of redacted-
 * normalized text, so the replacement is a stable literal ("[REDACTED:<kind>]") and
 * redaction is idempotent — a second pass changes nothing.
 */

export interface RedactionPattern {
  name: string;
  re: RegExp;
  /** replacement for the whole match; $1… refer to capture groups */
  replace?: string;
}

/** Ordered: a pattern consumes its match before later ones see it, so the more
 *  specific provider shapes come first (sk-ant-… would otherwise be eaten by the
 *  generic openai pattern), and the generic assignment pass runs last over text
 *  that may already carry [REDACTED:…] tokens (still idempotent). */
export const REDACTION_PATTERNS: readonly RedactionPattern[] = [
  { name: "anthropic", re: /sk-ant-[A-Za-z0-9_-]{16,}/g },
  { name: "openai", re: /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g },
  { name: "aws-access-key", re: /AKIA[0-9A-Z]{16}/g },
  { name: "github", re: /(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{22,})/g },
  { name: "google", re: /AIza[0-9A-Za-z_-]{35,}/g },
  { name: "slack", re: /xox[bpars]-[A-Za-z0-9-]{10,}/g },
  { name: "private-key", re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----/g },
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{5,}\b/g },
  { name: "bearer", re: /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, replace: "$1 [REDACTED:bearer]" },
  { name: "basic-auth", re: /\b(Basic)\s+[A-Za-z0-9+/=]{8,}/gi, replace: "$1 [REDACTED:basic-auth]" },
];

/** The literal a redacted value becomes. Stable across runs so replay hashes match. */
export function redactionToken(kind: string): string {
  return `[REDACTED:${kind}]`;
}

/** `key = "value"` / `password: value` — keep the key, lose the value. Done in code (not one
 *  regex) because quoted and bare values end differently, and String.replace cannot consume
 *  text beyond the match; an unterminated quote is left alone (redaction must not corrupt
 *  non-secret text it cannot bound). */
const ASSIGNMENT_RE = /\b(api[_-]?key|apikey|secret|access[_-]?token|auth[_-]?token|refresh[_-]?token|token|pass(?:word)?|passwd|pwd|client[_-]?secret)\b(\s*[:=]\s*)/gi;

function redactAssignments(text: string, hits: Map<string, number>): string {
  let out = "";
  let last = 0;
  for (const m of text.matchAll(ASSIGNMENT_RE)) {
    const start = m.index ?? 0;
    const valueStart = start + m[0].length;
    const q = text[valueStart];
    let end = valueStart;
    let replacement: string;
    if (q === '"' || q === "'") {
      const close = text.indexOf(q, valueStart + 1);
      if (close === -1) continue; // unterminated: leave this one untouched
      end = close + 1;
      replacement = `${m[1]}${m[2]}${q}${redactionToken("assignment")}${q}`;
    } else {
      let j = valueStart;
      while (j < text.length && !/[\s,;)\]}]/.test(text[j]!)) j++;
      if (j === valueStart) continue; // separator with no value — nothing to hide
      end = j;
      replacement = `${m[1]}${m[2]}${redactionToken("assignment")}`;
    }
    out += text.slice(last, start) + replacement;
    last = end;
    hits.set("assignment", (hits.get("assignment") ?? 0) + 1);
  }
  return out + text.slice(last);
}

function applyPatterns(text: string, hits: Map<string, number>): string {
  let out = text;
  for (const p of REDACTION_PATTERNS) {
    const replacement = p.replace;
    out = out.replace(p.re, (...args: unknown[]) => {
      hits.set(p.name, (hits.get(p.name) ?? 0) + 1);
      if (replacement === undefined) return redactionToken(p.name);
      // expand $1…$9 against the callback's capture groups (args[0] is the match)
      return replacement.replace(/\$(\d)/g, (_, d: string) => {
        const g = args[Number(d)];
        return typeof g === "string" ? g : "";
      });
    });
  }
  return redactAssignments(out, hits);
}

/** Report form: the redacted text plus one count per pattern that hit. */
export function redactionReport(text: string): { text: string; matches: { kind: string; count: number }[] } {
  const hits = new Map<string, number>();
  const out = applyPatterns(text, hits);
  return { text: out, matches: [...hits].map(([kind, count]) => ({ kind, count })) };
}

/** Plain-text form: just the redacted text. */
export function redactSecrets(text: string): string {
  return redactionReport(text).text;
}

const SENSITIVE_KEY = /^(?:.*[-_])?(?:pass(?:word)?|passwd|pwd|secret|token|api[-_]?key|apikey|authorization|private[-_]?key|credentials?)$/i;

/** Deep form for structured payloads (tool args, fixture objects): every string value is
 *  pattern-redacted, and values under sensitive KEY names are replaced wholesale — a
 *  credential is still a credential when no pattern can name its shape. Cycles degrade to
 *  a marker instead of hanging; non-string leaves pass through untouched. */
export function redactDeep<T>(value: T, seen: Set<object> = new Set()): T {
  if (typeof value === "string") return redactSecrets(value) as unknown as T;
  if (value === null || typeof value !== "object") return value;
  const obj = value as object;
  if (seen.has(obj)) return "[circular]" as unknown as T;
  seen.add(obj);
  try {
    if (Array.isArray(obj)) return obj.map((v) => redactDeep(v, seen)) as unknown as T;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (typeof v === "string" && SENSITIVE_KEY.test(k)) {
        out[k] = redactionToken("key");
      } else {
        out[k] = redactDeep(v, seen);
      }
    }
    return out as unknown as T;
  } finally {
    seen.delete(obj);
  }
}
