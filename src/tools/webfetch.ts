/** web_fetch tool (PORT #31): bounded, SSRF-guarded GET → readable text.
 *  Ported from opencode (MIT, snapshot ebece6e, packages/opencode/src/tool/
 *  webfetch.ts): url arg + http/https scheme gate (:35-37), 30s default timeout
 *  (:10), response size cap via content-length + body (:96-104), content-type →
 *  mime split (:106-107), html-vs-passthrough branch (:129-152). SSRF handling
 *  follows gemini-cli (Apache-2.0, snapshot 0bd1d43): localhost/private host
 *  block BEFORE any request (packages/core/src/tools/web-fetch.ts:270-281,
 *  :618-631), resolve-then-check over ALL addresses (packages/core/src/utils/
 *  fetch.ts:150-169), IPv4-mapped unmapping + the 198.18/15 benchmark range
 *  (fetch.ts:94-145), timer-driven AbortController linked to the caller's signal
 *  (fetch.ts:190-230), streamed read under a byte limit (web-fetch.ts:555-587),
 *  per-mime handling (web-fetch.ts:686-721).
 *  Deviations: redirects are followed MANUALLY (≤5 hops) so the guard re-runs
 *  on every hop — upstreams let fetch follow them, the classic redirect-to-
 *  127.0.0.1 bypass — and only while the host stays the same: policy consented
 *  to net.fetch on the ORIGINAL host, so a hop to another host stops with the
 *  target URL for the model to fetch directly (its own policy decision);
 *  ipaddr.js / html-to-text / htmlparser2 are replaced by the ~50 lines of
 *  address parsing below and html-text.ts; the byte cap TRUNCATES with a marker
 *  instead of failing; no LLM pass, retries or rate limiter. The timeout covers
 *  the DNS phase too (the guard's lookup is raced against the controller).
 *  Known gap: DNS is resolved once for the guard and again inside fetch
 *  (rebinding TOCTOU); pinning the socket to the checked address needs a
 *  dispatcher hook Bun's fetch does not expose.
 *  Policy: kind "network" → action net.fetch, resource = canonical URL host
 *  (core/tools.ts hostOf); runtime.ts buildCfg makes it PROMPT by default.
 *  Env: ROVECODE_WEBFETCH_TIMEOUT_MS (default 30000), ROVECODE_WEBFETCH_ALLOW_PRIVATE=1
 *  (skip the private-address guard, for local dev servers). */

import { lookup } from "node:dns/promises";
import type { Tool, ToolContext, ToolOutput } from "../core/types.ts";
import { htmlToText } from "./html-text.ts";

// ---------- bounds (advertised in the schema; args are clamped, never trusted) ----------

export const MAX_BYTES = 512 * 1024;       // body bytes read before truncation
export const CHARS_DEFAULT = 50_000;       // text chars returned by default
export const CHARS_CAP = 250_000;          // ceiling for maxChars (gemini-cli MAX_CONTENT_LENGTH)
export const MAX_REDIRECTS = 5;
export const TIMEOUT_DEFAULT_MS = 30_000;  // opencode DEFAULT_TIMEOUT
const USER_AGENT = "Mozilla/5.0 (compatible; rovecode/0.2 web_fetch)";
const ACCEPT = "text/html, application/xhtml+xml, application/json;q=0.9, text/*;q=0.8, application/xml;q=0.7, */*;q=0.1";

/** files.ts clampLimit contract: ceiling CHARS_CAP; absent/NaN/non-positive → default; fractions floor. */
export function clampChars(v: number | undefined): number {
  return Number.isFinite(v) && v! > 0 ? Math.min(Math.floor(v!), CHARS_CAP) : CHARS_DEFAULT;
}
function timeoutMs(): number {
  const v = Number(process.env.ROVECODE_WEBFETCH_TIMEOUT_MS ?? "");
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : TIMEOUT_DEFAULT_MS;
}

// ---------- SSRF guard: address classification ----------

function parseIPv4(s: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  let n = 0;
  for (let i = 1; i <= 4; i++) { const o = Number(m[i]); if (o > 255) return null; n = (n << 8) | o; }
  return n >>> 0;
}

/** 8 × 16-bit groups, or null when not an IPv6 literal. Handles `::`, an embedded
 *  dotted IPv4 tail (::ffff:10.0.0.1) and zone ids (fe80::1%eth0). */
function parseIPv6(input: string): number[] | null {
  const s = input.includes("%") ? input.slice(0, input.indexOf("%")) : input;
  if (!/^[0-9a-fA-F:.]+$/.test(s) || !s.includes(":")) return null;
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const groups = (part: string): number[] | null => {
    if (part === "") return [];
    const g: number[] = [];
    for (const piece of part.split(":")) {
      if (piece.includes(".")) { const v4 = parseIPv4(piece); if (v4 === null) return null; g.push(v4 >>> 16, v4 & 0xffff); }
      else if (/^[0-9a-fA-F]{1,4}$/.test(piece)) g.push(parseInt(piece, 16));
      else return null;
    }
    return g;
  };
  const head = groups(halves[0]!);
  const tail = halves.length === 2 ? groups(halves[1]!) : [];
  if (!head || !tail) return null;
  const fill = 8 - head.length - tail.length;
  if (halves.length === 2 ? fill < 1 : fill !== 0) return null;
  return [...head, ...(new Array<number>(fill).fill(0)), ...tail];
}

/** Non-global IPv4 space: RFC 1918, loopback, link-local (incl. 169.254.169.254
 *  metadata), "this" network, CGNAT, IETF/TEST-NETs, benchmarking, multicast, reserved. */
const V4_BLOCKED: [number, number][] = ([
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as [string, number][]).map(([p, bits]) => [parseIPv4(p)!, bits]);
function v4Blocked(n: number): boolean {
  return V4_BLOCKED.some(([p, bits]) => (n >>> (32 - bits)) === (p >>> (32 - bits)));
}

/** True for any address a fetch must not reach: loopback, private, link-local,
 *  unspecified, multicast/reserved, IPv4-mapped/6to4 forms of those, and anything
 *  outside IPv6 global unicast (2000::/3). Unparseable input is treated as
 *  private (fail closed). */
export function isPrivateAddress(ip: string): boolean {
  const v4 = parseIPv4(ip);
  if (v4 !== null) return v4Blocked(v4);
  const g = parseIPv6(ip);
  if (!g) return true;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [number, number, number, number, number, number, number, number];
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) return v4Blocked(((g6 << 16) | g7) >>> 0); // ::ffff:a.b.c.d
  if ((g0 & 0xe000) !== 0x2000) return true; // ::, ::1, fc00::/7, fe80::/10, ff00::/8, 64:ff9b::/96, 100::/64 …
  if (g0 === 0x2002) return v4Blocked(((g1 << 16) | g2) >>> 0); // 6to4 embeds an IPv4
  return g0 === 0x2001 && g1 === 0x0db8; // documentation prefix
}

/** Resolver seam: every address a host maps to (default node:dns lookup, all: true). */
export type Resolver = (host: string) => Promise<string[]>;
export const dnsResolver: Resolver = async (host) => (await lookup(host, { all: true })).map((a) => a.address);
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** Guard host form: brackets and trailing dot stripped, lowercased. */
export function canonicalHost(hostname: string): string {
  let h = hostname.toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  return h.endsWith(".") ? h.slice(0, -1) : h;
}

/** null when the host may be fetched; otherwise the reason it is refused. Literal
 *  IPs and localhost names never touch DNS; names are resolved and refused when
 *  ANY address is private (gemini-cli fetch.ts:159-160). */
export async function ssrfDenyReason(hostname: string, resolve: Resolver): Promise<string | null> {
  const host = canonicalHost(hostname);
  const kind = "a private, loopback, link-local or reserved address";
  if (host === "") return "empty host";
  if (host === "localhost" || host.endsWith(".localhost")) return `${host} is a loopback name`;
  if (parseIPv4(host) !== null || host.includes(":")) return isPrivateAddress(host) ? `${host} is ${kind}` : null;
  let addrs: string[];
  try { addrs = await resolve(host); } catch (e) { return `could not resolve ${host}: ${e instanceof Error ? e.message : String(e)}`; }
  if (addrs.length === 0) return `could not resolve ${host}`;
  const bad = addrs.find(isPrivateAddress);
  return bad === undefined ? null : `${host} resolves to ${bad}, ${kind}`;
}

// ---------- response handling ----------

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function isTextual(mime: string): boolean {
  return mime === "" || mime.startsWith("text/") || mime === "application/json" || mime === "application/xml"
    || mime === "application/xhtml+xml" || mime === "application/javascript" || mime === "application/ecmascript"
    || mime.endsWith("+json") || mime.endsWith("+xml");
}
function looksLikeHtml(mime: string, text: string): boolean {
  if (mime === "text/html" || mime === "application/xhtml+xml") return true;
  return mime === "" && /^\s*<(!doctype\s+html|html|head|body)[\s>]/i.test(text.slice(0, 1024));
}

/** Rejects as soon as `signal` aborts, so a phase that is not itself abortable
 *  (the guard's DNS lookup) cannot outlive the tool's timeout or the user's Esc.
 *  Exported (with readBounded) for tools/websearch.ts, which shares this pipeline. */
export function abortable<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("aborted"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** Streams the body up to `cap` bytes, then cancels the stream (gemini-cli
 *  web-fetch.ts:568-585 loop, truncating instead of throwing). An abort mid-body
 *  rejects out of reader.read() and is handled by the caller. */
export async function readBounded(res: Response, cap: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!res.body) return { bytes: new Uint8Array(0), truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.length === 0) continue; // an empty chunk carries no bytes: not overflow even at the cap
      if (total >= cap) { truncated = true; break; }
      const room = cap - total;
      if (value.length > room) { chunks.push(value.subarray(0, room)); total = cap; truncated = true; break; }
      chunks.push(value);
      total += value.length;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { bytes.set(c, off); off += c.length; }
  return { bytes, truncated };
}

function decodeBody(bytes: Uint8Array, contentType: string, truncated: boolean): string {
  const charset = /charset=["']?([\w.:-]+)/i.exec(contentType)?.[1];
  let decoder: TextDecoder;
  try { decoder = new TextDecoder(charset ?? "utf-8"); } catch { decoder = new TextDecoder(); }
  const text = decoder.decode(bytes);
  return truncated ? text.replace(/�$/, "") : text; // a cut mid-sequence leaves one replacement char
}

export interface WebFetchDeps { fetch?: FetchLike; resolve?: Resolver }

/** Builds the tool; `deps` are test seams (fixture-mapping fetch, scripted resolver).
 *  Production registrations use the module-level webFetchTool. */
export function createWebFetchTool(deps: WebFetchDeps = {}): Tool {
  const fetchImpl: FetchLike = deps.fetch ?? ((u, i) => fetch(u, i));
  const resolve: Resolver = deps.resolve ?? dnsResolver;

  async function run(a: { url: string; maxChars?: number }, ctx: ToolContext): Promise<ToolOutput> {
    if (typeof a.url !== "string" || a.url.trim() === "") return { ok: false, output: "web_fetch: url is required" };
    let current: URL;
    try { current = new URL(a.url.trim()); } catch { return { ok: false, output: `web_fetch: invalid URL: ${a.url}` }; }
    const maxChars = clampChars(a.maxChars);
    const allowPrivate = process.env.ROVECODE_WEBFETCH_ALLOW_PRIVATE === "1";
    if (ctx.signal.aborted) return { ok: false, output: "web_fetch: aborted" };

    // Timeout: a REF'D setTimeout drives the controller (Bun's AbortSignal.timeout
    // timer is unref'd and never fires on an idle loop — see executor.ts trialSpawn);
    // the caller's signal is chained so Esc mid-fetch aborts the socket too.
    const ac = new AbortController();
    const limitMs = timeoutMs();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ac.abort(); }, limitMs);
    (timer as unknown as { ref?: () => void }).ref?.();
    const onAbort = (): void => ac.abort();
    ctx.signal.addEventListener("abort", onAbort, { once: true });
    const fail = (e: unknown): ToolOutput => {
      if (ac.signal.aborted) return { ok: false, output: timedOut ? `web_fetch: timed out after ${limitMs}ms` : "web_fetch: aborted" };
      return { ok: false, output: `web_fetch: request failed: ${e instanceof Error ? e.message : String(e)}` };
    };

    try {
      let hops = 0;
      const origin = canonicalHost(current.hostname);
      for (;;) {
        // scheme + SSRF gate on the initial URL AND every redirect target
        if (current.protocol !== "http:" && current.protocol !== "https:") {
          return { ok: false, output: `web_fetch: unsupported URL scheme ${current.protocol} (http/https only)` };
        }
        if (!allowPrivate) {
          let reason: string | null;
          try { reason = await abortable(ssrfDenyReason(current.hostname, resolve), ac.signal); } catch (e) { return fail(e); }
          if (reason !== null) {
            return { ok: false, output: `web_fetch: refused ${current.href}: ${reason} (set ROVECODE_WEBFETCH_ALLOW_PRIVATE=1 for local dev servers)` };
          }
        }
        // Policy consented to net.fetch on the host of the ORIGINAL url only
        // (core/tools.ts hostOf), so a redirect to a different host is not
        // followed: the target is reported for a direct fetch that gets its own
        // decision. Checked AFTER the guard so a private target keeps its precise
        // refusal instead of advice to fetch it. Same canonical host (case and
        // trailing dot ignored, any port) still follows, so http→https upgrades
        // and path moves stay seamless.
        const host = canonicalHost(current.hostname);
        if (host !== origin) {
          return { ok: false, output: `web_fetch: redirected to ${current.href}; fetch it directly (a redirect from ${origin} to ${host} needs its own net.fetch permission)` };
        }
        let res: Response;
        try {
          res = await fetchImpl(current.href, { method: "GET", redirect: "manual", signal: ac.signal, headers: { "User-Agent": USER_AGENT, Accept: ACCEPT } });
        } catch (e) { return fail(e); }

        if (REDIRECT_STATUSES.has(res.status)) {
          const location = res.headers.get("location");
          await res.body?.cancel().catch(() => {});
          if (!location) return { ok: false, output: `web_fetch: HTTP ${res.status} redirect from ${current.href} without a Location header` };
          if (++hops > MAX_REDIRECTS) return { ok: false, output: `web_fetch: too many redirects (more than ${MAX_REDIRECTS}) starting from ${a.url}` };
          try { current = new URL(location, current); } catch { return { ok: false, output: `web_fetch: invalid redirect target ${location}` }; }
          continue;
        }

        const contentType = res.headers.get("content-type") ?? "";
        const mime = (contentType.split(";")[0] ?? "").trim().toLowerCase();
        if (!isTextual(mime)) {
          await res.body?.cancel().catch(() => {}); // gate BEFORE the body is read
          return { ok: false, output: `web_fetch: unsupported content-type: ${mime} (only text/*, JSON, XML and XHTML are fetched)` };
        }
        let body: { bytes: Uint8Array; truncated: boolean };
        try { body = await readBounded(res, MAX_BYTES); } catch (e) { return fail(e); }
        const raw = decodeBody(body.bytes, contentType, body.truncated);
        let text = looksLikeHtml(mime, raw) ? htmlToText(raw, current.href) : raw;

        const notes: string[] = [];
        if (body.truncated) {
          const declared = Number(res.headers.get("content-length"));
          notes.push(`(Body truncated at ${MAX_BYTES} bytes${Number.isFinite(declared) && declared > 0 ? ` of ${declared}` : ""}.)`);
        }
        const totalChars = text.length;
        const charsTruncated = totalChars > maxChars;
        if (charsTruncated) {
          text = text.slice(0, maxChars).replace(/[\uD800-\uDBFF]$/, "");
          notes.push(`(Text truncated: showing first ${maxChars} of ${totalChars} characters.)`);
        }
        const header = `${current.href} (HTTP ${res.status}, ${mime || "no content-type"}, ${body.bytes.length} bytes${hops > 0 ? `, ${hops} redirect${hops === 1 ? "" : "s"}` : ""})`;
        const output = [header, text, ...(notes.length > 0 ? [notes.join("\n")] : [])].filter((s) => s !== "").join("\n\n");
        return {
          ok: res.status < 400,
          output,
          data: { url: current.href, status: res.status, contentType: mime, bytes: body.bytes.length, redirects: hops, truncated: body.truncated || charsTruncated },
        };
      }
    } finally {
      clearTimeout(timer);
      ctx.signal.removeEventListener("abort", onAbort);
    }
  }

  return {
    schema: {
      name: "web_fetch",
      description: `Fetch a public http(s) URL with GET and return its content as readable text. HTML is reduced to text (scripts/styles dropped, headings/paragraphs/lists kept, links as "text (href)"); JSON, XML and plain text pass through unchanged. Follows at most ${MAX_REDIRECTS} redirects, and only within the same host: a redirect to another host stops with that URL — fetch it directly. Only text/*, JSON, XML and XHTML responses are accepted. The body is read up to ${MAX_BYTES} bytes and the text is capped at maxChars (default ${CHARS_DEFAULT}, cap ${CHARS_CAP}); both truncations leave a marker. Times out after ${TIMEOUT_DEFAULT_MS / 1000}s. Private, loopback, link-local and unresolvable hosts are refused. Output starts with a header line: final URL, HTTP status, content-type, bytes read.`,
      args: {
        type: "object",
        properties: {
          url: { type: "string", description: "absolute http:// or https:// URL to fetch" },
          maxChars: { type: "integer", description: `max characters of text returned (default ${CHARS_DEFAULT}, cap ${CHARS_CAP})` },
        },
        required: ["url"],
      },
    },
    kind: "network",
    sequential: false,
    execute: (args, ctx) => run((args ?? {}) as { url: string; maxChars?: number }, ctx),
  };
}

export const webFetchTool: Tool = createWebFetchTool();
