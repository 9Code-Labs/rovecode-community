/** Tool argument validation — the "validate" that ADR-005 names first in
 *  `validate → revise → policy → approve → sandbox → execute` and that nothing actually did.
 *
 *  Until this file existed, `call.args` went from the model straight into `execute`, where every tool
 *  casts it: `const a = args as { path: string; content: string }`. A cast is not a check. A model
 *  that sent `content` as an object got Node's own message back —
 *
 *      Error: The "data" argument must be of type string or an instance of Buffer, TypedArray, or DataView
 *
 *  — which names no tool, no property, and no fix, so the model's next attempt is a guess. Worse are
 *  the cases that do not throw: a number where a string belongs stringifies somewhere downstream and
 *  the wrong thing happens quietly.
 *
 *  This validates against the schema the tool already publishes (ToolSchema.args, the same object the
 *  provider is told about), so there is nothing new to maintain: a tool that documents its arguments
 *  is validated by that documentation. The message names the tool, the property, what was expected
 *  and what arrived — everything a model needs to fix the call on the next turn without a human.
 *
 *  Deliberately a SUBSET of JSON Schema — type, required, enum, array item type, nested objects —
 *  because that is what the tool schemas in this repo use. An unknown keyword is ignored rather than
 *  rejected: a schema this validator does not fully understand must never make a working tool
 *  unusable. Unknown PROPERTIES are likewise allowed through: policy already re-aims resources from
 *  declared keys only (tools.ts describeResource), and a strict-mode rejection here would break every
 *  provider that decorates calls with its own metadata. */

export interface ValidationIssue {
  /** dotted path from the argument root: "todos.3.status", "" for the root itself */
  path: string;
  message: string;
}

interface Schema {
  type?: unknown;
  properties?: unknown;
  required?: unknown;
  enum?: unknown;
  items?: unknown;
}

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** what a value IS, in the words the schema uses — so "expected string, got array" reads plainly */
export function jsonTypeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  const t = typeof v;
  if (t === "number") return Number.isInteger(v) ? "integer" : "number";
  return t === "object" || t === "boolean" || t === "string" ? t : t; // function/symbol/undefined pass through as themselves
}

/** JSON Schema's `type` accepts a string or a list of them */
function typeMatches(want: unknown, v: unknown): boolean {
  if (Array.isArray(want)) return want.some((w) => typeMatches(w, v));
  if (typeof want !== "string") return true; // no usable type keyword: nothing to check
  const actual = jsonTypeOf(v);
  if (want === "number") return actual === "number" || actual === "integer";
  if (want === "integer") return actual === "integer";
  if (want === "object") return isRec(v);
  return actual === want;
}

function join(base: string, key: string | number): string {
  return base === "" ? String(key) : `${base}.${key}`;
}

function check(schema: unknown, value: unknown, path: string, out: ValidationIssue[]): void {
  if (!isRec(schema)) return;
  const s = schema as Schema;

  if (s.type !== undefined && !typeMatches(s.type, value)) {
    const want = Array.isArray(s.type) ? s.type.join(" or ") : String(s.type);
    out.push({ path, message: `expected ${want}, got ${jsonTypeOf(value)}` });
    return; // one complaint per value: the nested checks below would only repeat it
  }

  if (Array.isArray(s.enum) && s.enum.length > 0 && !s.enum.includes(value as never)) {
    out.push({ path, message: `expected one of ${s.enum.map((e) => JSON.stringify(e)).join(" | ")}, got ${JSON.stringify(value)}` });
    return;
  }

  if (Array.isArray(value) && s.items !== undefined) {
    value.forEach((item, i) => check(s.items, item, join(path, i), out));
    return;
  }

  if (isRec(value)) {
    if (Array.isArray(s.required)) {
      for (const key of s.required) {
        // present-but-undefined is missing: a provider that serializes an omitted argument as
        // `{"path": undefined}` has not supplied it
        if (typeof key === "string" && (!(key in value) || value[key] === undefined)) {
          out.push({ path: join(path, key), message: "is required but was not provided" });
        }
      }
    }
    if (isRec(s.properties)) {
      for (const [key, sub] of Object.entries(s.properties)) {
        if (key in value && value[key] !== undefined) check(sub, value[key], join(path, key), out);
      }
    }
  }
}

/** Every problem with these arguments, in schema order. Empty = usable. */
export function validateArgs(schema: unknown, args: unknown): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  // a schema with no `type` still describes an object when it lists properties/required
  const root = isRec(schema) && (schema as Schema).type === undefined && ((schema as Schema).properties !== undefined || (schema as Schema).required !== undefined)
    ? { ...(schema as Record<string, unknown>), type: "object" }
    : schema;
  check(root, args, "", out);
  return out;
}

/** The line the model reads. Names the tool and each bad property; the model's next attempt is a
 *  correction, not a guess. Bounded: a list of 50 malformed todos must not become a 50-line error. */
export function formatIssues(tool: string, issues: readonly ValidationIssue[], max = 5): string {
  const shown = issues.slice(0, max).map((i) => (i.path === "" ? i.message : `${i.path} ${i.message}`));
  const more = issues.length > shown.length ? ` (+${issues.length - shown.length} more)` : "";
  return `Invalid arguments for ${tool}: ${shown.join("; ")}${more}`;
}
