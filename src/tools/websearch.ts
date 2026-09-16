/** web_search tool (PORT #56): query → up to N ranked web results as compact text.
 *  Ported from opencode (MIT, snapshot ebece6e, packages/opencode/src/tool/websearch.ts +
 *  mcp-websearch.ts). Backend = Exa's HOSTED MCP endpoint https://mcp.exa.ai/mcp, called KEYLESS by
 *  default with one JSON-RPC `tools/call` of `web_search_exa` (mcp-websearch.ts:66-96 `call`: POST, Accept
 *  json + event-stream, {jsonrpc:"2.0", id:1, method:"tools/call", params:{name, arguments}});
 *  arguments {query, type:"auto", numResults (default 8), livecrawl:"fallback", contextMaxCharacters
 *  (optional — omitted unless the model passes one)} (websearch.ts:83-96); 25s timeout (:95); the
 *  reader takes the first `result.content[].text` from
 *  a JSON body or an SSE `data:` line (mcp-websearch.ts:20-42 parsePayload/parseResponse). No key
 *  is needed; opencode appends an optional EXA_API_KEY as `?exaApiKey=` (mcp-websearch.ts:4-6) —
 *  mirrored by the optional `apiKey` dep, which the ONE registration line in cli/runtime.ts reads
 *  from the environment; this module reads no env at all, every URL it echoes into an output is
 *  shown without its query string, and error text that arrives through a seam (a rejecting fetch or
 *  resolver, a body stream, a non-2xx body, a JSON-RPC error) is scrubbed — the keyed URL → its
 *  display form, the key itself → `[key]` — so a key never leaks into a result the model (or a log) sees.
 *  Deviations: opencode hands the model Exa's context string verbatim; here it is PARSED into ranked
 *  results (Title/URL/Published/Author/Highlights blocks separated by `---`, or the raw {results:[…]}
 *  JSON older servers return) and re-rendered as `N. title · url · date` + a bounded snippet, with
 *  result-count, snippet, title/url and total-output caps; the Parallel provider, the per-session
 *  provider coin flip and the livecrawl/type/contextMaxCharacters args are dropped: livecrawl/type are
 *  fixed to opencode's defaults ("fallback"/"auto"), while contextMaxCharacters is ALWAYS sent as
 *  max(10000, n*1500) — opencode omits the key unless the model passes one, so Exa applies its own
 *  10000 default there; rovecode's value is pinned in websearch.test.ts (12000 at n=8, 30000 at n=20).
 *  Every request — the first and every same-host redirect hop (re-POSTed, ≤5) — passes the SAME SSRF
 *  guard as web_fetch (webfetch.ts ssrfDenyReason: private/loopback/link-local/reserved refused,
 *  names resolved through the injectable resolver, raced against the timeout) with NO allow-private
 *  door: the endpoint is fixed, so a private answer for it is a broken resolver or an attack. A
 *  cross-host redirect is refused. Non-2xx, timeout, abort, malformed body and backend errors are
 *  tool error results — the tool never throws and never writes files. Text in neither known result
 *  shape is passed through verbatim, bounded and flagged (format drift is not a dead tool).
 *  Policy: kind "network" → action net.fetch; the schema declares no url/path/command, so the
 *  resource is the tool name (core/tools.ts describeResource): `allow net.fetch web_search`
 *  auto-runs it and the runtime's default `prompt net.fetch *` makes it PROMPT by default, exactly
 *  like web_fetch. */

import type { Tool, ToolContext, ToolOutput } from "../core/types.ts";
import { abortable, canonicalHost, dnsResolver, readBounded, ssrfDenyReason, type FetchLike, type Resolver } from "./webfetch.ts";
import pkg from "../../package.json";

// ---------- bounds (advertised in the schema; args are clamped, never trusted) ----------

export const ENDPOINT = "https://mcp.exa.ai/mcp";
export const RESULTS_DEFAULT = 8;          // opencode numResults default
export const RESULTS_CAP = 20;
export const QUERY_CHARS = 1000;           // longer queries are refused, not sent
export const SNIPPET_CHARS = 500;          // per result
export const TITLE_CHARS = 200;
export const URL_CHARS = 2000;
export const OUTPUT_CHARS_CAP = 16_000;    // whole output; trailing results are dropped whole to fit
export const MAX_BYTES = 1024 * 1024;      // response body read cap
export const MAX_REDIRECTS = 5;
export const TIMEOUT_DEFAULT_MS = 25_000;  // opencode "25 seconds"
const USER_AGENT = `Mozilla/5.0 (compatible; rovecode/${pkg.version} web_search)`; // port #48: was aion/0.2
const ACCEPT = "application/json, text/event-stream";
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MARKER_RESERVE = 96;                 // room kept for the truncation marker under the cap

/** files.ts clampLimit contract: ceiling RESULTS_CAP; absent/NaN/non-positive → default; fractions
 *  floor; numeric strings (non-native tool-call parsing) count. */
export function clampResults(v: unknown): number {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), RESULTS_CAP) : RESULTS_DEFAULT;
}

/** Surrogate-safe clip with an ellipsis. */
function clip(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1).replace(/[\uD800-\uDBFF]$/, "") + "…";
}

// ---------- MCP envelope ----------

export type McpPayload = { text: string } | { error: string };

/** One JSON-RPC envelope → its first text content, or the error it carries; null when it is
 *  neither (opencode parsePayload: `result.content.find(item => item.text)`). */
function envelopePayload(raw: string): McpPayload | null {
  let j: unknown;
  try { j = JSON.parse(raw); } catch { return null; }
  if (!j || typeof j !== "object") return null;
  const env = j as { error?: unknown; result?: unknown };
  if (env.error && typeof env.error === "object") {
    const m = (env.error as { message?: unknown }).message;
    return { error: typeof m === "string" && m !== "" ? m : JSON.stringify(env.error) };
  }
  if (!env.result || typeof env.result !== "object") return null;
  const r = env.result as { content?: unknown; isError?: unknown };
  const items: unknown[] = Array.isArray(r.content) ? r.content : [];
  const text = items
    .map((c) => (c && typeof c === "object" ? (c as { text?: unknown }).text : undefined))
    .find((t): t is string => typeof t === "string" && t !== "");
  if (r.isError === true) return { error: text ?? "backend reported an error without a message" };
  return text === undefined ? null : { text };
}

/** Body → payload: a JSON object body, else the first SSE `data:` line that carries one (opencode
 *  parseResponse). null = no envelope with text or error anywhere (malformed). */
export function parseMcpBody(body: string): McpPayload | null {
  const trimmed = body.trim();
  if (trimmed.startsWith("{")) { const p = envelopePayload(trimmed); if (p) return p; }
  for (const line of body.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const p = envelopePayload(line.slice(5).trim());
    if (p) return p;
  }
  return null;
}

// ---------- result text ----------

export interface SearchResult { title: string; url: string; snippet: string; publishedDate?: string }

/** Exa highlight text → one line: `...` gap-marker lines become ` … `, whitespace collapses. */
function cleanSnippet(raw: string): string {
  const out: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const l = line.trim();
    if (l === "") continue;
    if (l === "...") { if (out.length > 0 && out[out.length - 1] !== "…") out.push("…"); continue; }
    out.push(l);
  }
  while (out.length > 0 && out[out.length - 1] === "…") out.pop();
  return out.join(" ").replace(/\s+/g, " ").trim();
}

const KEY_LINE = /^(Title|URL|Published|Author|Score|ID|Image|Favicon):\s*(.*)$/;
const BODY_MARK = /^(Highlights|Text|Summary):\s*$/;

/** Exa's LLM context string — `Title: / URL: / Published: / Author: / Highlights:` blocks separated
 *  by `---` — → results in rank order. Blocks without an http(s) URL are skipped; `N/A` dates are
 *  dropped; the title falls back to the url. */
export function parseExaContext(text: string): SearchResult[] {
  const results: SearchResult[] = [];
  for (const block of text.split(/\r?\n\s*---\s*\r?\n/)) {
    const lines = block.split(/\r?\n/);
    const fields: Record<string, string> = {};
    let i = 0;
    for (; i < lines.length; i++) {
      const line = lines[i]!.trim();
      if (line === "") { if (Object.keys(fields).length > 0) break; continue; }
      const m = KEY_LINE.exec(line);
      if (!m) break;
      fields[m[1]!] = m[2]!.trim();
    }
    while (i < lines.length && lines[i]!.trim() === "") i++;
    if (i < lines.length && BODY_MARK.test(lines[i]!.trim())) i++;
    const url = fields["URL"] ?? "";
    if (!/^https?:\/\//i.test(url)) continue;
    const published = fields["Published"];
    results.push({
      title: fields["Title"] || url,
      url,
      snippet: cleanSnippet(lines.slice(i).join("\n")),
      ...(published && published.toUpperCase() !== "N/A" ? { publishedDate: published } : {}),
    });
  }
  return results;
}

/** Raw Exa search JSON ({results:[{title,url,publishedDate,text|highlights|summary}]}) → results;
 *  null when the text is not that shape. */
function parseExaJson(text: string): SearchResult[] | null {
  let j: unknown;
  try { j = JSON.parse(text); } catch { return null; }
  const list = j && typeof j === "object" ? (j as { results?: unknown }).results : undefined;
  if (!Array.isArray(list)) return null;
  const out: SearchResult[] = [];
  for (const r of list as unknown[]) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const url = typeof o["url"] === "string" ? o["url"] : "";
    if (!/^https?:\/\//i.test(url)) continue;
    const highlights = Array.isArray(o["highlights"]) ? (o["highlights"] as unknown[]).filter((h): h is string => typeof h === "string") : [];
    const body = typeof o["text"] === "string" ? o["text"] : highlights.length > 0 ? highlights.join("\n...\n") : typeof o["summary"] === "string" ? o["summary"] : "";
    const published = typeof o["publishedDate"] === "string" && o["publishedDate"] !== "" ? o["publishedDate"] : undefined;
    out.push({ title: typeof o["title"] === "string" && o["title"] !== "" ? o["title"] : url, url, snippet: cleanSnippet(body), ...(published ? { publishedDate: published } : {}) });
  }
  return out;
}

/** Backend text → results ([] = a recognized no-result answer); null when the text is in neither
 *  known shape (the tool then renders it verbatim, bounded). */
export function parseResultsText(text: string): SearchResult[] | null {
  const t = text.trim();
  if (t === "" || /^No search results found/i.test(t)) return [];
  if (t.startsWith("{")) return parseExaJson(t);
  const ctx = parseExaContext(t);
  return ctx.length > 0 ? ctx : null;
}

export interface Rendered { output: string; shown: number; truncated: boolean }

/** Header line, then `N. title · url[ · date]` + an indented snippet per result, blank-line
 *  separated. Whole trailing results are dropped (never split) so the output stays under `cap`. */
export function formatResults(query: string, results: SearchResult[], cap = OUTPUT_CHARS_CAP): Rendered {
  const header = `${results.length} result${results.length === 1 ? "" : "s"} for "${clip(query, TITLE_CHARS)}" (Exa web search)`;
  const entries = results.map((r, i) => {
    const head = `${i + 1}. ${clip(r.title.replace(/\s+/g, " ").trim(), TITLE_CHARS)} · ${clip(r.url, URL_CHARS)}${r.publishedDate ? ` · ${r.publishedDate}` : ""}`;
    const snippet = clip(r.snippet, SNIPPET_CHARS);
    return snippet === "" ? head : `${head}\n   ${snippet}`;
  });
  let output = header;
  let shown = 0;
  for (const e of entries) {
    if (output.length + 2 + e.length + MARKER_RESERVE > cap) break;
    output += `\n\n${e}`;
    shown++;
  }
  const truncated = shown < entries.length;
  if (truncated) output += `\n\n(Showing ${shown} of ${results.length} results: output capped at ${cap} characters.)`;
  return { output, shown, truncated };
}

// ---------- the tool ----------

/** A URL as outputs show it: origin + path only — the query may carry the api key. */
function displayUrl(u: URL): string { return u.origin + u.pathname; }

export interface WebSearchDeps {
  fetch?: FetchLike; resolve?: Resolver; timeoutMs?: number;
  /** optional Exa key, sent as opencode does (`?exaApiKey=`); blank/undefined = keyless */
  apiKey?: string;
}

/** Builds the tool; `deps` are test seams (fixture-mapping fetch, scripted resolver, short timeout)
 *  plus the optional apiKey the runtime registration injects. The module-level webSearchTool is the
 *  keyless instance (listing surfaces). */
export function createWebSearchTool(deps: WebSearchDeps = {}): Tool {
  const fetchImpl: FetchLike = deps.fetch ?? ((u, i) => fetch(u, i));
  const resolve: Resolver = deps.resolve ?? dnsResolver;
  const limitMs = typeof deps.timeoutMs === "number" && Number.isFinite(deps.timeoutMs) && deps.timeoutMs > 0 ? Math.floor(deps.timeoutMs) : TIMEOUT_DEFAULT_MS;
  const key = typeof deps.apiKey === "string" ? deps.apiKey.trim() : "";
  const endpoint = key === "" ? ENDPOINT : `${ENDPOINT}?exaApiKey=${encodeURIComponent(key)}`;
  // Error text that arrives through a seam may embed the request URL or the key: a wrapped/injected
  // fetch or proxy that puts the URL in its message (Bun's own errors keep it in err.path today), a
  // resolver, a body stream, a non-2xx body, a JSON-RPC error. Scrubbed before it reaches an output:
  // the keyed endpoint and the CURRENT request URL → their display form (origin+path), then the key
  // itself (raw and URL-encoded) → `[key]`. Keyless, this rewrites nothing.
  const scrub = (text: string, u: URL): string => {
    let out = text.split(endpoint).join(ENDPOINT).split(u.href).join(displayUrl(u));
    if (key !== "") for (const k of new Set([key, encodeURIComponent(key)])) out = out.split(k).join("[key]");
    return out;
  };

  async function run(a: { query?: unknown; max_results?: unknown }, ctx: ToolContext): Promise<ToolOutput> {
    const query = typeof a.query === "string" ? a.query.trim() : "";
    if (query === "") return { ok: false, output: "web_search: query is required" };
    if (query.length > QUERY_CHARS) return { ok: false, output: `web_search: query too long (${query.length} characters; max ${QUERY_CHARS})` };
    const n = clampResults(a.max_results);
    if (ctx.signal.aborted) return { ok: false, output: "web_search: aborted" };
    const rpc = JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "web_search_exa", arguments: { query, type: "auto", numResults: n, livecrawl: "fallback", contextMaxCharacters: Math.max(10_000, n * 1_500) } },
    });

    // Timeout: a REF'D setTimeout drives the controller (Bun's AbortSignal.timeout timer is unref'd
    // and never fires on an idle loop); the caller's signal is chained so Esc aborts the socket too.
    const ac = new AbortController();
    let timedOut = false;
    let current = new URL(endpoint); // the URL in flight: the endpoint, then each redirect target
    const timer = setTimeout(() => { timedOut = true; ac.abort(); }, limitMs);
    (timer as unknown as { ref?: () => void }).ref?.();
    const onAbort = (): void => ac.abort();
    ctx.signal.addEventListener("abort", onAbort, { once: true });
    // a rejection from the resolver, the fetch or the body read; its message is scrubbed against the URL in flight
    const fail = (e: unknown): ToolOutput => {
      if (ac.signal.aborted) return { ok: false, output: timedOut ? `web_search: timed out after ${limitMs}ms` : "web_search: aborted" };
      return { ok: false, output: `web_search: request failed: ${scrub(e instanceof Error ? e.message : String(e), current)}` };
    };

    try {
      const origin = canonicalHost(current.hostname);
      let hops = 0;
      for (;;) {
        // scheme + SSRF gate on the endpoint AND every redirect target; no allow-private door
        if (current.protocol !== "http:" && current.protocol !== "https:") {
          return { ok: false, output: `web_search: backend redirected to unsupported URL scheme ${current.protocol} (http/https only)` };
        }
        let reason: string | null;
        try { reason = await abortable(ssrfDenyReason(current.hostname, resolve), ac.signal); } catch (e) { return fail(e); }
        if (reason !== null) return { ok: false, output: `web_search: refused ${displayUrl(current)}: ${scrub(reason, current)}` };
        // the policy decision covered the fixed backend; another host never gets the request
        if (canonicalHost(current.hostname) !== origin) {
          return { ok: false, output: `web_search: backend redirected to ${displayUrl(current)} (${canonicalHost(current.hostname)} is not ${origin}); not followed` };
        }
        let res: Response;
        try {
          res = await fetchImpl(current.href, {
            method: "POST", redirect: "manual", signal: ac.signal, body: rpc,
            headers: { "User-Agent": USER_AGENT, Accept: ACCEPT, "Content-Type": "application/json" },
          });
        } catch (e) { return fail(e); }

        if (REDIRECT_STATUSES.has(res.status)) {
          const location = res.headers.get("location");
          await res.body?.cancel().catch(() => {});
          if (!location) return { ok: false, output: `web_search: HTTP ${res.status} redirect from ${displayUrl(current)} without a Location header` };
          if (++hops > MAX_REDIRECTS) return { ok: false, output: `web_search: too many redirects (more than ${MAX_REDIRECTS}) from ${ENDPOINT}` };
          try { current = new URL(location, current); } catch { return { ok: false, output: `web_search: invalid redirect target ${location}` }; }
          continue;
        }

        let body: { bytes: Uint8Array; truncated: boolean };
        try { body = await readBounded(res, res.ok ? MAX_BYTES : 2048); } catch (e) { return fail(e); }
        const text = new TextDecoder().decode(body.bytes);
        if (!res.ok) {
          const detail = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== "") ?? "";
          return { ok: false, output: `web_search: backend HTTP ${res.status}${detail === "" ? "" : `: ${clip(scrub(detail, current), 200)}`}` };
        }
        const payload = parseMcpBody(text);
        if (payload === null) {
          return { ok: false, output: `web_search: malformed backend response (${body.truncated ? `body truncated at ${MAX_BYTES} bytes` : `${body.bytes.length} bytes, no JSON-RPC result with text`})` };
        }
        if ("error" in payload) return { ok: false, output: `web_search: backend error: ${clip(scrub(payload.error, current).replace(/\s+/g, " ").trim(), 300)}` };
        const parsed = parseResultsText(payload.text);
        if (parsed === null) {
          const raw = payload.text.trim();
          const shown = clip(raw, OUTPUT_CHARS_CAP);
          return {
            ok: true,
            output: `web_search "${clip(query, TITLE_CHARS)}": the backend answered in an unrecognized format; shown verbatim${shown.length < raw.length ? ` (capped at ${OUTPUT_CHARS_CAP} characters)` : ""}:\n\n${shown}`,
            data: { query, count: 0, total: 0, unstructured: true, truncated: shown.length < raw.length },
          };
        }
        if (parsed.length === 0) {
          return { ok: true, output: `No results for "${clip(query, TITLE_CHARS)}" (Exa web search). Try different or fewer terms.`, data: { query, count: 0, total: 0, results: [], truncated: false } };
        }
        const r = formatResults(query, parsed.slice(0, n));
        return {
          ok: true,
          output: r.output,
          data: { query, count: r.shown, total: parsed.length, results: parsed.slice(0, r.shown), truncated: r.shown < parsed.length },
        };
      }
    } finally {
      clearTimeout(timer);
      ctx.signal.removeEventListener("abort", onAbort);
    }
  }

  return {
    schema: {
      name: "web_search",
      description: `Search the web and return up to max_results ranked results (default ${RESULTS_DEFAULT}, cap ${RESULTS_CAP}), each as "N. title · url · published date (when known)" followed by a snippet of at most ${SNIPPET_CHARS} characters; the whole output is capped at ${OUTPUT_CHARS_CAP} characters (trailing results dropped, with a marker). Results are search snippets, not pages: call web_fetch on a result's url to read it. Backend: Exa via its hosted MCP endpoint (${ENDPOINT}); no API key is required. Times out after ${TIMEOUT_DEFAULT_MS / 1000}s; a backend that redirects elsewhere or resolves to a private address is refused. The current year is ${new Date().getFullYear()}: put it in queries about recent events.`,
      args: {
        type: "object",
        properties: {
          query: { type: "string", description: `search query in plain words (at most ${QUERY_CHARS} characters)` },
          max_results: { type: "integer", description: `results to return (default ${RESULTS_DEFAULT}, cap ${RESULTS_CAP})` },
        },
        required: ["query"],
      },
    },
    kind: "network",
    sequential: false,
    execute: (args, ctx) => run((args ?? {}) as { query?: unknown; max_results?: unknown }, ctx),
  };
}

export const webSearchTool: Tool = createWebSearchTool();
