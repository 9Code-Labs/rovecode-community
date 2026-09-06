/** Tool-call middleware: lets models WITHOUT native function calling drive rovecode's tools.
 *
 *  Port of senpi's tool-call middleware (research/source_snapshots/code-yeongyu-senpi @ a0f26a6,
 *  packages/ai/src/tool-call-middleware). Formats:
 *
 *  - "hermes-xml": <tool_call>{"name":"read","arguments":{...}}</tool_call>
 *      tags protocols/hermes.ts:6-7; regex scan protocols/json-mix.ts:643-670; JSON shape gate
 *      json-mix.ts:135-161; relaxed-JSON repair ladder json-mix.ts:114-133 (trailing commas :29-71,
 *      quote-mismatched keys :73-75, brace wrapping :77-88, excess closers :90-112).
 *  - "xml-function": <invoke name="tool"><parameter name="k">v</parameter></invoke>
 *      senpi has NO literal <function=name> syntax; its XML function-call protocol is the
 *      anthropic-xml/antml invoke form (optional antml: namespace, single or double quotes):
 *      tag grammar protocols/anthropic-xml/invoke-tag-syntax.ts:5-15, parse loop
 *      protocols/anthropic-xml/parse.ts:9-68. Schema-less value coercion (we have no schema at
 *      parse time): decode XML entities then try JSON.parse else keep string
 *      (coerce-parameters.ts:94-98), boundary newlines trimmed (:15-19), duplicate parameter
 *      name invalidates the call (:29-31). Entities per xml-entities.ts:32-41.
 *  - "json-fenced": ```json {"name":...,"arguments":{...}} ``` — rovecode extension; senpi itself has
 *      no fenced-JSON protocol (its recovery-code-mask.ts EXCLUDES code spans from scanning), so
 *      the fence body is gated on the exact hermes call shape with NO extraneous keys — an
 *      ordinary JSON code block is never consumed.
 *
 *  Shared edge cases ported:
 *  - args accept "arguments" or "parameters" keys ("arguments" wins when both present).
 *  - Markup inside fenced code blocks or inline `code` is NOT parsed (senpi recovery-code-mask.ts
 *    marks code spans non-scannable); an unclosed fence swallows the rest of the text.
 *  - Malformed markup (unparseable JSON, unclosed tags, duplicate params) never throws and never
 *    loses text: the raw block stays verbatim in cleanText (json-mix.ts:658-666 "keeping original
 *    text"; parse.ts:57-62).
 *  - Unknown-tool filtering (json-mix.ts:146): when a tool catalog is known (opts.tools, or
 *    derived from StreamOptions.tools in the wrapper), markup naming any other tool is NOT
 *    consumed — it stays as text. Without a catalog, gating is structural only.
 *  - Context round-trip for non-native models: once the middleware has minted a call, follow-up
 *    requests are lowered to text protocol (see middleware-context.ts / senpi transformContext).
 *
 *  STREAMING CAVEAT: parsing happens on the terminal "turn" event only. text_delta events pass
 *  through untouched, so live deltas may briefly show raw markup (this mirrors senpi's
 *  parseGeneratedText terminal path, not its incremental StreamParser). */

import type { MessagePart, StreamFn, ToolSchema } from "../core/types.ts";
import { lowerNonNativeContext, TEXTCALL_ID_PREFIX } from "./middleware-context.ts";
import { randomUUID } from "node:crypto";

export type TextToolCallFormat = "hermes-xml" | "json-fenced" | "xml-function";

export interface MiddlewareOptions {
  /** Formats to parse. Default: all three. */
  formats?: TextToolCallFormat[];
  /** Known tool names. When set, markup naming any OTHER tool is not consumed — it stays as
   *  text (json-mix.ts:146; an empty catalog parses nothing, parse.ts:15-17). The wrapper
   *  derives this from StreamOptions.tools when unset. Unset = structural gating only. */
  tools?: readonly string[];
  /** Lower native tool history to text protocol for non-native models (middleware-context.ts).
   *  true forces, false disables; unset auto-detects middleware-minted call ids in history. */
  lowerContext?: boolean;
}

export interface ParsedTextToolCall { tool: string; args: unknown }

const ALL_FORMATS: readonly TextToolCallFormat[] = ["hermes-xml", "json-fenced", "xml-function"];

// ---------- relaxed JSON (senpi json-mix.ts:29-133) ----------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** String-aware trailing-comma removal (json-mix.ts:29-71). */
function removeTrailingCommas(text: string): string {
  let out = "", inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] ?? "";
    if (inStr) {
      out += ch;
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; out += ch; continue; }
    if (ch === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j] ?? "")) j++;
      const next = text[j];
      if (next === "}" || next === "]") continue;
    }
    out += ch;
  }
  return out;
}

/** `"key':` → `"key":` (json-mix.ts:73-75). */
function normalizeMalformedObjectKeys(text: string): string {
  return text.replace(/"([A-Za-z0-9_.$-]+)'(?=\s*:)/g, '"$1"');
}

/** Wrap bare `k: v` bodies in braces (json-mix.ts:77-88). */
function ensureObjectDelimiters(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return trimmed;
  return trimmed.includes(":") ? `{${trimmed}}` : trimmed;
}

/** Trim `}` beyond the balance point (json-mix.ts:90-112). */
function trimExcessTrailingClosers(text: string): string {
  let open = 0, close = 0;
  for (const ch of text) {
    if (ch === "{") open++;
    else if (ch === "}") close++;
  }
  let excess = close - open, out = text;
  while (excess > 0 && out.endsWith("}")) { out = out.slice(0, -1); excess--; }
  return out;
}

/** Repair ladder (json-mix.ts:114-133); returns null instead of throwing. */
function parseRelaxedJson(text: string): unknown | null {
  const a = removeTrailingCommas(text);
  const b = normalizeMalformedObjectKeys(a);
  const c = ensureObjectDelimiters(b);
  for (const candidate of [text, a, b, c, trimExcessTrailingClosers(c)]) {
    try { return JSON.parse(candidate); } catch { /* next repair attempt */ }
  }
  return null;
}

/** Tool-call shape gate (json-mix.ts:135-161). `arguments` preferred; `parameters` accepted per
 *  spec. strict additionally rejects extraneous keys (json-fenced false-positive guard) —
 *  INCLUDING "parameters": {"name", "parameters"} is the canonical JSON-Schema function
 *  DEFINITION shape, so a model echoing a definition in a ```json fence must stay text. */
function toolCallShape(value: unknown, strict: boolean): ParsedTextToolCall | null {
  if (!isRecord(value) || typeof value.name !== "string") return null;
  const args = isRecord(value.arguments) ? value.arguments : isRecord(value.parameters) ? value.parameters : null;
  if (!args) return null;
  if (strict && Object.keys(value).some((k) => !["name", "arguments", "id"].includes(k))) return null;
  return { tool: value.name, args };
}

// ---------- XML entities + invoke value coercion (anthropic-xml) ----------

/** xml-entities.ts:32-41 (order matters: &amp; last). */
function decodeXmlEntities(value: string): string {
  return value
    .replaceAll("&#13;", "\r").replaceAll("&#10;", "\n")
    .replaceAll("&quot;", '"').replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}

/** coerce-parameters.ts:15-19 + 94-98: trim one boundary newline, decode, JSON else string. */
function coerceParameterValue(raw: string): unknown {
  const trimmed = raw.replace(/^(?:\r\n|\r|\n)/, "").replace(/(?:\r\n|\r|\n)$/, "");
  const decoded = decodeXmlEntities(trimmed);
  try { return JSON.parse(decoded); } catch { return decoded; }
}

// ---------- code-span segmentation (senpi recovery-code-mask.ts: code is never scanned) ----------

type FenceBlock =
  | { kind: "plain"; raw: string }
  | { kind: "fence"; raw: string; info: string; body: string; closed: boolean };

/** Line-anchored fences: 3+ backticks after ≤3 spaces (recovery-code-mask.ts:76-78,104).
 *  Also accepts the single-line form ```json {...} ```. Blocks rejoin with "\n" losslessly. */
function splitFences(text: string): FenceBlock[] {
  const lines = text.split("\n");
  const blocks: FenceBlock[] = [];
  let plain: string[] = [];
  const flush = () => { if (plain.length > 0) { blocks.push({ kind: "plain", raw: plain.join("\n") }); plain = []; } };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const oneLine = /^ {0,3}(`{3,})(\w*)[ \t]+([\s\S]*?)`{3,}\s*$/.exec(line);
    if (oneLine) {
      flush();
      blocks.push({ kind: "fence", raw: line, info: (oneLine[2] ?? "").trim(), body: oneLine[3] ?? "", closed: true });
      continue;
    }
    const open = /^ {0,3}(`{3,})(.*)$/.exec(line);
    if (!open) { plain.push(line); continue; }
    const ticks = (open[1] ?? "```").length;
    const closerRe = new RegExp(`^ {0,3}\`{${ticks},}\\s*$`);
    let j = i + 1;
    while (j < lines.length && !closerRe.test(lines[j] ?? "")) j++;
    const closed = j < lines.length;
    const end = closed ? j : lines.length - 1;
    flush();
    blocks.push({
      kind: "fence",
      raw: lines.slice(i, end + 1).join("\n"),
      info: (open[2] ?? "").trim(),
      body: lines.slice(i + 1, closed ? j : lines.length).join("\n"),
      closed,
    });
    i = end;
  }
  flush();
  return blocks;
}

/** Inline `code` spans (same line, matching tick runs) — masked from markup scanning. */
function inlineCodeRanges(text: string): { start: number; end: number }[] {
  return [...text.matchAll(/(`+)[^`\n]+?\1/g)].map((m) => ({ start: m.index, end: m.index + m[0].length }));
}

// ---------- format scanners ----------

interface Consumed { start: number; end: number; call: ParsedTextToolCall }

const HERMES_RE = /<tool_call>([\s\S]*?)<\/tool_call>/g; // hermes.ts:6-7 + json-mix.ts:650-653
const INVOKE_OPEN_RE = /<\s*(?:antml:)?invoke\b\s+name\s*=\s*(?:"([^"]+)"|'([^']+)')\s*>/g; // invoke-tag-syntax.ts:5-7
const INVOKE_CLOSE_RE = /<\s*\/\s*(?:antml:)?invoke\s*>/g; // invoke-tag-syntax.ts:8
const PARAM_OPEN_RE = /<\s*(?:antml:)?parameter\b\s+name\s*=\s*(?:"([^"]+)"|'([^']+)')\s*>/g; // invoke-tag-syntax.ts:11-14
const PARAM_CLOSE_RE = /<\s*\/\s*(?:antml:)?parameter\s*>/g; // invoke-tag-syntax.ts:15
const FUNCTION_CALLS_TAG_RE = /[ \t]*<\s*\/?\s*(?:antml:)?function_calls\s*>[ \t]*/g; // invoke-tag-syntax.ts:274

function execFrom(re: RegExp, text: string, from: number): RegExpExecArray | null {
  re.lastIndex = from;
  return re.exec(text);
}

/** One invoke block starting at/after `from`. call === null → malformed, leave as text
 *  (senpi parse.ts:57-62 keeps original text; unclosed blocks are never consumed). */
function scanInvoke(text: string, from: number): { start: number; end: number; call: ParsedTextToolCall | null; nextFrom: number } | null {
  const open = execFrom(INVOKE_OPEN_RE, text, from);
  if (!open) return null;
  const start = open.index;
  const failed = { start, end: start, call: null, nextFrom: start + open[0].length };
  const tool = decodeXmlEntities(open[1] ?? open[2] ?? "");
  const args: Record<string, unknown> = {};
  let cursor = start + open[0].length;
  for (;;) {
    const close = execFrom(INVOKE_CLOSE_RE, text, cursor);
    if (!close) return failed; // unclosed invoke
    const param = execFrom(PARAM_OPEN_RE, text, cursor);
    if (!param || close.index < param.index) {
      // Stray body text outside <parameter> tags is discarded (senpi scanInvokeBlock:176-177).
      const end = close.index + close[0].length;
      return { start, end, call: { tool, args }, nextFrom: end };
    }
    const name = decodeXmlEntities(param[1] ?? param[2] ?? "");
    const valueStart = param.index + param[0].length;
    const paramClose = execFrom(PARAM_CLOSE_RE, text, valueStart);
    // Missing </parameter> before </invoke> → parameters unusable (invoke-tag-syntax.ts:190-196).
    if (!paramClose) return failed;
    const closeAfterValue = execFrom(INVOKE_CLOSE_RE, text, valueStart);
    if (closeAfterValue && closeAfterValue.index < paramClose.index) return failed;
    if (Object.hasOwn(args, name)) return failed; // duplicate param (coerce-parameters.ts:29-31)
    args[name] = coerceParameterValue(text.slice(valueStart, paramClose.index));
    cursor = paramClose.index + paramClose[0].length;
  }
}

/** Scan one plain (non-code) segment for hermes + invoke markup; returns leftover text and
 *  appends consumed calls in document order. `allowed` is the tool-catalog gate: an unknown
 *  tool name is treated like malformed markup — never consumed (json-mix.ts:146). */
function scanPlainSegment(text: string, formats: ReadonlySet<TextToolCallFormat>, calls: ParsedTextToolCall[], allowed: (tool: string) => boolean): string {
  const inline = inlineCodeRanges(text);
  const masked = (at: number) => inline.some((r) => at >= r.start && at < r.end);
  const found: Consumed[] = [];
  if (formats.has("hermes-xml")) {
    for (const m of text.matchAll(HERMES_RE)) {
      if (masked(m.index)) continue;
      const call = toolCallShape(parseRelaxedJson(m[1] ?? ""), false);
      if (call && allowed(call.tool)) found.push({ start: m.index, end: m.index + m[0].length, call });
      // else: malformed JSON / unknown tool → block stays in cleanText (json-mix.ts:658-666)
    }
  }
  let sawInvoke = false;
  if (formats.has("xml-function")) {
    let from = 0;
    for (let inv = scanInvoke(text, from); inv !== null; inv = scanInvoke(text, from)) {
      from = inv.nextFrom;
      if (inv.call && allowed(inv.call.tool) && !masked(inv.start)) { found.push({ start: inv.start, end: inv.end, call: inv.call }); sawInvoke = true; }
    }
  }
  found.sort((a, b) => a.start - b.start);
  let cursor = 0, out = "";
  for (const f of found) {
    if (f.start < cursor) continue; // overlapping match: earliest wins
    out += text.slice(cursor, f.start);
    calls.push(f.call);
    cursor = f.end;
  }
  out += text.slice(cursor);
  // A consumed invoke may be wrapped in antml-style <function_calls> tags — drop the bare
  // wrapper tags too (senpi antml protocol consumes them; invoke-tag-syntax.ts:274).
  if (sawInvoke) out = out.replace(FUNCTION_CALLS_TAG_RE, "");
  return out;
}

// ---------- public API ----------

/** Parse one assistant text into {cleanText, calls[]}. Never throws; unparseable or malformed
 *  markup stays verbatim in cleanText. Calls are returned in document order. */
export function parseToolCalls(text: string, opts?: MiddlewareOptions): { cleanText: string; calls: ParsedTextToolCall[] } {
  const formats = new Set<TextToolCallFormat>(opts?.formats ?? ALL_FORMATS);
  const known = opts?.tools === undefined ? null : new Set(opts.tools);
  const allowed = (tool: string): boolean => known === null || known.has(tool);
  const calls: ParsedTextToolCall[] = [];
  const chunks: string[] = [];
  for (const block of splitFences(text)) {
    if (block.kind === "fence") {
      if (block.closed && formats.has("json-fenced") && /^json$/i.test(block.info)) {
        const call = toolCallShape(parseRelaxedJson(block.body.trim()), true);
        if (call && allowed(call.tool)) { calls.push(call); continue; } // fence consumed
      }
      chunks.push(block.raw); // any other fence: kept verbatim, contents never scanned
    } else {
      chunks.push(scanPlainSegment(block.raw, formats, calls, allowed));
    }
  }
  return { cleanText: chunks.join("\n").trim(), calls };
}

/** Minted ids are `textcall_<nonce>_<n>`: the per-process nonce keeps replayed history (session
 *  resume after restart) from colliding with freshly minted ids — Anthropic 400s on duplicate
 *  tool_use ids. The counter is module-global, so ids stay unique across wrapper instances. */
const runNonce = randomUUID().slice(0, 8);
let nextTextCallId = 0;

/** Wrap a StreamFn: when a terminal turn has NO tool_call parts but its text contains parseable
 *  tool-call markup, rewrite it — text part(s) minus the markup, plus tool_call parts with
 *  generated ids, stopReason → "tool_use". Turns with native tool calls (and all non-turn
 *  events, including text_delta) pass through untouched — see streaming caveat in header.
 *
 *  Request side (senpi transformContext): once middleware mode is active (see
 *  middleware-context.ts) the outgoing request is lowered — prior tool calls/results become
 *  protocol text and options.tools is stripped, so a non-native model never sees native tool
 *  artifacts. Parsed calls are gated against the tool catalog (opts.tools, else the names in
 *  the ORIGINAL StreamOptions.tools): unknown-tool markup stays as text. */
export function withToolCallParsing(stream: StreamFn, opts?: MiddlewareOptions): StreamFn {
  return async function* (model, messages, options) {
    const known = opts?.tools ?? options?.tools?.map((t) => t.name);
    const parseOpts = known === undefined ? opts : { ...opts, tools: known };
    const lowered = lowerNonNativeContext(messages, options, opts?.lowerContext);
    for await (const event of stream(model, lowered.messages, lowered.options)) {
      if (event.type !== "turn" || event.turn.parts.some((p) => p.kind === "tool_call")) {
        yield event; // native tool calls / deltas: byte-identical passthrough
        continue;
      }
      const parts: MessagePart[] = [];
      let total = 0;
      for (const part of event.turn.parts) {
        if (part.kind !== "text") { parts.push(part); continue; }
        const { cleanText, calls } = parseToolCalls(part.text, parseOpts);
        if (calls.length === 0) { parts.push(part); continue; }
        total += calls.length;
        if (cleanText.length > 0) parts.push({ kind: "text", text: cleanText });
        for (const call of calls) {
          parts.push({ kind: "tool_call", id: `${TEXTCALL_ID_PREFIX}${runNonce}_${nextTextCallId++}`, tool: call.tool, args: call.args });
        }
      }
      if (total === 0) { yield event; continue; }
      yield { type: "turn", turn: { ...event.turn, parts, stopReason: "tool_use" } };
    }
  };
}

/** Prompt block advertising tools to non-native models. Ported near-verbatim from senpi's
 *  Hermes prompt (hermes.ts:27-40; tool definitions rendered per hermes.ts:13-20) — senpi
 *  advertises exactly one protocol per model, and hermes-xml is our canonical emission format.
 *  Pure function of `tools` → deterministic. */
export function toolPromptBlock(tools: ToolSchema[]): string {
  if (tools.length === 0) return "";
  const rendered = tools
    .map((t) => `{"type": "function", "function": {"name": ${JSON.stringify(t.name)}, "description": ${JSON.stringify(t.description)}, "parameters": ${JSON.stringify(t.args)}}}`)
    .join("\n");
  return `You are a function calling AI model. You are provided with function signatures within <tools></tools> XML tags. You may call one or more functions to assist with the user query. Don't make assumptions about what values to plug into functions. Here are the available tools: <tools> ${rendered} </tools>
Use the following pydantic model json schema for each tool call you will make: {"properties": {"name": {"title": "Name", "type": "string"}, "arguments": {"title": "Arguments", "type": "object"}}, "required": ["name", "arguments"], "title": "FunctionCall", "type": "object"}
For each function call return a json object with function name and arguments within <tool_call></tool_call> XML tags as follows:
<tool_call>
{"name": "<function-name>", "arguments": <args-dict>}
</tool_call>`;
}
