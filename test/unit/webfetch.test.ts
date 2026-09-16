/** Port #31 web_fetch: html→text extraction pinned byte-exact, JSON/XML/plain
 *  passthrough, charset decode, content-type gate BEFORE the body is read,
 *  redirect chain + hop cap, same-host-only redirects (a cross-host hop stops
 *  with the target so it re-enters policy as its own call), SSRF guard (literal
 *  private/loopback/link-local/metadata/unspecified/mapped targets refused before
 *  any connection, DNS-resolved private refused, redirect-to-private refused AT
 *  THE HOP with the target never reached), the ROVECODE_WEBFETCH_ALLOW_PRIVATE door,
 *  byte + char bounds with exact markers, the empty-chunk edge and the clamp
 *  contract, timeout via a ref'd timer that also bounds the DNS phase (deadline-
 *  raced so a hang fails instead of freezing the runner), mid-fetch abort, policy
 *  class (net.fetch, resource = CANONICAL host so `evil.com.` cannot dodge a deny,
 *  prompt-by-default under the runtime rules, allow-host auto-run, deny-* block),
 *  registration pins. Fixtures are a local Bun.serve on 127.0.0.1 and an injected
 *  resolver/fetch that refuses any host it does not rewrite onto the fixture —
 *  nothing here touches the real network or real DNS, even under a mutation. */

import { test, expect, afterAll } from "bun:test";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  webFetchTool, createWebFetchTool, isPrivateAddress, ssrfDenyReason, canonicalHost, clampChars,
  MAX_BYTES, CHARS_DEFAULT, CHARS_CAP, MAX_REDIRECTS, TIMEOUT_DEFAULT_MS,
} from "../../src/tools/webfetch.ts";
import { htmlToText, decodeEntities } from "../../src/tools/html-text.ts";
import { ToolRegistry } from "../../src/core/tools.ts";
import { createRuntime } from "../../src/cli/runtime.ts";
import type { ToolContext, ToolCallPart, PermissionRule, RunEvent, ApprovalFn } from "../../src/core/types.ts";

// ---------- fixture server (127.0.0.1, ephemeral port) ----------

const PAGE = `<!DOCTYPE html>
<html><head><title>Ignored Title</title>
<style>body { color: red }</style>
<script>var x = "<b>not text</b>";</script>
</head>
<body>
<noscript>Enable JS</noscript>
<h1>Hello &amp; Welcome</h1>
<p>First   paragraph with <b>bold</b>, an entity &lt;tag&gt;, &copy; 2026 &mdash; done.</p>
<p>See <a href="/docs/guide">the guide</a> and <a href="https://example.com/x">https://example.com/x</a>.</p>
<ul><li>one</li><li> two &nbsp; spaced</li></ul>
<pre>  indented
    code</pre>
<script type="text/javascript">alert(1)</script>
<!-- a comment -->
<table><tr><th>K</th><th>V</th></tr><tr><td>a</td><td>1</td></tr></table>
<div>Tail<br>text</div><div>next</div>
</body></html>`;
const PAGE_BYTES = Buffer.byteLength(PAGE);

/** The readable text PAGE must reduce to; `base` resolves the relative link. */
const extracted = (base: string): string => [
  "Hello & Welcome", "",
  "First paragraph with bold, an entity <tag>, © 2026 — done.", "",
  `See the guide (${base}/docs/guide) and https://example.com/x.`, "",
  "- one", "- two spaced", "",
  "  indented", "    code", "",
  "K V", "a 1", "",
  "Tail", "text", "next",
].join("\n");

const hits: Record<string, number> = {};
const pngPulls = { count: 0 };
const slowTimers = new Set<ReturnType<typeof setTimeout>>();
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const redirect = (to: string, status: number): Response => new Response(null, { status, headers: { location: to } });
const text = (body: string | Uint8Array, contentType: string, status = 200): Response =>
  new Response(body as BodyInit, { status, headers: { "content-type": contentType } });

const server = Bun.serve({
  port: 0, hostname: "127.0.0.1", idleTimeout: 0,
  fetch(req): Response | Promise<Response> {
    const u = new URL(req.url);
    hits[u.pathname] = (hits[u.pathname] ?? 0) + 1;
    switch (u.pathname) {
      case "/html": return text(PAGE, "text/html; charset=utf-8");
      case "/json": return text('{"a":1,"b":[1,2]}', "application/json");
      case "/xml": return text("<feed><entry>1</entry></feed>", "application/rss+xml");
      case "/latin1": return text(new Uint8Array([0x63, 0x61, 0x66, 0xe9]), "text/plain; charset=iso-8859-1"); // "café"
      case "/404": return text("missing page", "text/plain", 404);
      case "/text": return text("0123456789".repeat(100), "text/plain");
      case "/big": return text("€".repeat(700_000), "text/plain; charset=utf-8");          // 2,100,000 bytes, 3 per char
      case "/exact": return text("€".repeat(174_762) + "ab", "text/plain; charset=utf-8"); // exactly MAX_BYTES bytes
      case "/png": // slow 40×16-byte stream (~2s): a tool that reads it would be late
        return new Response(new ReadableStream<Uint8Array>({
          async pull(c) {
            pngPulls.count++;
            await sleep(50);
            try { c.enqueue(new Uint8Array(16)); if (pngPulls.count >= 40) c.close(); } catch { /* cancelled */ }
          },
        }), { headers: { "content-type": "image/png" } });
      case "/redir/1": return redirect("/redir/2", 302);
      case "/redir/2": return redirect("/html", 307);
      case "/loop": { const n = Number(u.searchParams.get("n") ?? "0"); return redirect(`/loop?n=${n + 1}`, 302); }
      case "/to-private": return redirect(`http://private.test:${server.port}/html`, 302);
      case "/to-other": return redirect(`http://other.test:${server.port}/json`, 302);        // a different host
      case "/to-same": return redirect(`http://PUBLIC.test.:${server.port}/json`, 302);       // same host, spelled differently
      case "/to-file": return redirect("file:///etc/passwd", 302);
      case "/no-location": return new Response(null, { status: 302 });
      case "/slow": // headers after 5s; timers are cleared in afterAll
        return new Promise<Response>((resolve) => { slowTimers.add(setTimeout(() => resolve(text("late", "text/plain")), 5000)); });
      default: return text("?", "text/plain", 500);
    }
  },
});
const base = `http://127.0.0.1:${server.port}`;
afterAll(() => { for (const t of slowTimers) clearTimeout(t); server.stop(true); });

// ---------- helpers ----------

const ctx = (signal: AbortSignal = new AbortController().signal): ToolContext =>
  ({ sessionId: "s-web", cwd: process.cwd(), signal, permissions: { effect: "allow" } });

async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) { saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally {
    for (const k of Object.keys(vars)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}
/** Positive tests reach the 127.0.0.1 fixture through the documented dev-server door. */
const local = <T>(fn: () => Promise<T>): Promise<T> => withEnv({ ROVECODE_WEBFETCH_ALLOW_PRIVATE: "1", ROVECODE_WEBFETCH_TIMEOUT_MS: undefined }, fn);

/** Races against a REF'D deadline: a hung fetch FAILS the test instead of freezing the runner. */
async function within<T>(ms: number, p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`no result within ${ms}ms`)), ms); });
  try { return await Promise.race([p, deadline]); } finally { clearTimeout(timer); }
}

/** A tool whose fetch records every request and rewrites fake public/private
 *  hosts onto the fixture, with a scripted resolver — so the guard sees real
 *  "public" and "private" answers while every socket stays local. Any other
 *  host is REFUSED rather than fetched: a broken gate must fail here, never
 *  reach the real network. */
function seamTool(resolve: (host: string) => Promise<string[]>): { tool: ReturnType<typeof createWebFetchTool>; calls: string[] } {
  const calls: string[] = [];
  const tool = createWebFetchTool({
    fetch: (url, init) => {
      calls.push(url);
      const onFixture = url.replace(/(public|private|mixed|other)\.test\.?/, "127.0.0.1");
      if (onFixture === url) throw new Error(`fixture-only fetch seam: refusing ${url}`);
      return fetch(onFixture, init);
    },
    resolve,
  });
  return { tool, calls };
}
const neverResolve = async (host: string): Promise<string[]> => { throw new Error(`DNS must not be consulted for ${host}`); };

// ---------- html → text ----------

test("htmlToText: script/style/noscript/head dropped, blocks → lines, entities decoded, links as `text (href)`, pre kept, table cells spaced", () => {
  expect(htmlToText(PAGE, "http://h.test/html")).toBe(extracted("http://h.test"));
});

test("htmlToText: raw-text elements survive '<' inside them; dropped subtrees; fragment/javascript/mailto links get no href; case-insensitive tags", () => {
  expect(htmlToText("<script>if (a<b) {}</script>after<style>a>b{}</style>tail")).toBe("aftertail");
  expect(htmlToText("<svg><text>hidden</text></svg><iframe src=x>inner</iframe>vis")).toBe("vis");
  expect(htmlToText("<a href='#top'>frag</a> <a href='javascript:x()'>js</a> <a href='mailto:a@b'>mail</a> <a>nohref</a>")).toBe("frag js mail nohref");
  expect(htmlToText("<P>Upper <A HREF='/x'>case</A></P><p>a &lt; b &amp;&amp; c</p>", "https://s.test/d/")).toBe("Upper case (https://s.test/x)\n\na < b && c");
  expect(htmlToText("<div><div>nested</div><span>s1</span><span>s2</span></div>")).toBe("nested\ns1s2");
  expect(htmlToText("")).toBe("");
});

test("decodeEntities: named subset, decimal, hex; unknown names and invalid code points kept verbatim", () => {
  expect(decodeEntities("&amp; &#169; &#xA9; &#x1F600; &nbsp;x &lt;&gt; &quot;&apos;")).toBe("& © © 😀  x <> \"'");
  expect(decodeEntities("&unknown; &#0; &#xD800; &#x110000;")).toBe("&unknown; &#0; &#xD800; &#x110000;");
});

// ---------- fetch pipeline: content handling ----------

test("html page: header line (final URL, status, content-type, bytes) then the extracted text; script/style/title/noscript gone", async () => local(async () => {
  const out = await webFetchTool.execute({ url: `${base}/html` }, ctx());
  expect(out.ok).toBe(true);
  expect(out.output).toBe(`${base}/html (HTTP 200, text/html, ${PAGE_BYTES} bytes)\n\n${extracted(base)}`);
  for (const gone of ["color: red", "alert(1)", "Ignored Title", "Enable JS", "not text"]) expect(out.output).not.toContain(gone);
  expect(out.data).toEqual({ url: `${base}/html`, status: 200, contentType: "text/html", bytes: PAGE_BYTES, redirects: 0, truncated: false });
}));

test("JSON, +xml and plain text pass through byte-for-byte; declared charset is honored", async () => local(async () => {
  const json = await webFetchTool.execute({ url: `${base}/json` }, ctx());
  expect(json.output).toBe(`${base}/json (HTTP 200, application/json, 17 bytes)\n\n{"a":1,"b":[1,2]}`);
  const xml = await webFetchTool.execute({ url: `${base}/xml` }, ctx());
  expect(xml.ok).toBe(true);
  expect(xml.output.endsWith("\n\n<feed><entry>1</entry></feed>")).toBe(true);
  const latin1 = await webFetchTool.execute({ url: `${base}/latin1` }, ctx());
  expect(latin1.output.endsWith("\n\ncafé")).toBe(true);
}));

test("missing content-type: HTML is sniffed and extracted, anything else passes through as text", async () => {
  // Bun.serve stamps text/plain on string bodies, so a header-less response can
  // only come through the fetch seam (a constructed Response carries no content-type)
  const html = "<!doctype html><html><body><p>Sniffed</p><script>x()</script></body></html>";
  let body = html;
  const tool = createWebFetchTool({ fetch: async () => new Response(body), resolve: async () => ["93.184.216.34"] });
  const sniffed = await tool.execute({ url: "http://public.test/page" }, ctx());
  expect(sniffed.output).toBe(`http://public.test/page (HTTP 200, no content-type, ${Buffer.byteLength(html)} bytes)\n\nSniffed`);
  body = "just text";
  const plain = await tool.execute({ url: "http://public.test/plain" }, ctx());
  expect(plain.output).toBe("http://public.test/plain (HTTP 200, no content-type, 9 bytes)\n\njust text");
});

test("content-type gate: image/png is refused from the headers alone — the body is never read", async () => local(async () => {
  pngPulls.count = 0;
  const t0 = Date.now();
  const out = await within(4000, webFetchTool.execute({ url: `${base}/png` }, ctx()));
  const elapsed = Date.now() - t0;
  expect(out.ok).toBe(false);
  expect(out.output).toBe("web_fetch: unsupported content-type: image/png (only text/*, JSON, XML and XHTML are fetched)");
  expect(elapsed).toBeLessThan(1000);   // reading the 40×50ms stream would take ≥2s
  expect(pngPulls.count).toBeLessThan(40);
}));

test("HTTP 4xx: ok=false but the header and (bounded) body are still returned for diagnosis", async () => local(async () => {
  const out = await webFetchTool.execute({ url: `${base}/404` }, ctx());
  expect(out.ok).toBe(false);
  expect(out.output).toBe(`${base}/404 (HTTP 404, text/plain, 12 bytes)\n\nmissing page`);
}));

// ---------- redirects ----------

test("redirects: a 2-hop chain is followed manually; header shows the FINAL url and hop count", async () => local(async () => {
  const before = { r1: hits["/redir/1"] ?? 0, r2: hits["/redir/2"] ?? 0, html: hits["/html"] ?? 0 };
  const out = await webFetchTool.execute({ url: `${base}/redir/1` }, ctx());
  expect(out.ok).toBe(true);
  expect(out.output.startsWith(`${base}/html (HTTP 200, text/html, ${PAGE_BYTES} bytes, 2 redirects)\n\n`)).toBe(true);
  expect((out.data as { redirects: number }).redirects).toBe(2);
  expect([hits["/redir/1"], hits["/redir/2"], hits["/html"]]).toEqual([before.r1 + 1, before.r2 + 1, before.html + 1]);
}));

test(`redirects: more than ${MAX_REDIRECTS} hops → clean error after exactly ${MAX_REDIRECTS + 1} requests`, async () => local(async () => {
  hits["/loop"] = 0;
  const out = await webFetchTool.execute({ url: `${base}/loop?n=0` }, ctx());
  expect(out.ok).toBe(false);
  expect(out.output).toBe(`web_fetch: too many redirects (more than ${MAX_REDIRECTS}) starting from ${base}/loop?n=0`);
  expect(hits["/loop"]).toBe(MAX_REDIRECTS + 1);
}));

test("redirects: a 3xx without Location, or to a non-http scheme, is a clean error (no fetch of the target)", async () => local(async () => {
  const noLoc = await webFetchTool.execute({ url: `${base}/no-location` }, ctx());
  expect(noLoc.ok).toBe(false);
  expect(noLoc.output).toBe(`web_fetch: HTTP 302 redirect from ${base}/no-location without a Location header`);
  const toFile = await webFetchTool.execute({ url: `${base}/to-file` }, ctx());
  expect(toFile.ok).toBe(false);
  expect(toFile.output).toBe("web_fetch: unsupported URL scheme file: (http/https only)");
}));

test("MED-1: a redirect to a DIFFERENT host is not followed — the tool stops and names the target for a direct fetch; the same host spelled with case/trailing dot still follows", async () => {
  const { tool, calls } = seamTool(async (host) => {
    if (host === "public.test") return ["93.184.216.34"];
    if (host === "other.test") return ["93.184.216.35"];
    throw new Error(`unexpected lookup ${host}`);
  });
  const before = hits["/json"] ?? 0;
  const cross = await tool.execute({ url: `http://public.test:${server.port}/to-other` }, ctx());
  expect(cross.ok).toBe(false);
  expect(cross.output).toBe(`web_fetch: redirected to http://other.test:${server.port}/json; fetch it directly (a redirect from public.test to other.test needs its own net.fetch permission)`);
  expect(calls).toEqual([`http://public.test:${server.port}/to-other`]); // the hop was never issued
  expect(hits["/json"]).toBe(before);
  const same = await tool.execute({ url: `http://public.test:${server.port}/to-same` }, ctx());
  expect(same.ok).toBe(true);
  expect(same.output.startsWith(`http://public.test.:${server.port}/json (HTTP 200, application/json, 17 bytes, 1 redirect)\n\n`)).toBe(true);
  expect(calls).toHaveLength(3);
  expect(hits["/json"]).toBe(before + 1);
  expect(webFetchTool.schema.description).toContain("only within the same host");
});

test("MED-1 via policy: `allow net.fetch public.test` cannot reach other.test through a redirect — the direct fetch is denied and the hop stops before any request to it", async () => {
  const { tool, calls } = seamTool(async (host) => (host === "public.test" ? ["93.184.216.34"] : ["93.184.216.35"]));
  const r = new ToolRegistry();
  r.register(tool);
  const rules: PermissionRule[] = [{ action: "net.fetch", resource: "public.test", effect: "allow" }];
  const direct = await r.dispatch(call("m1", `http://other.test:${server.port}/json`), ctx(), undefined, rules, undefined, () => {});
  expect(direct.output).toBe("Permission denied: no rule allows net.fetch");
  const before = hits["/json"] ?? 0;
  const via = await r.dispatch(call("m2", `http://public.test:${server.port}/to-other`), ctx(), undefined, rules, undefined, () => {});
  expect(via.ok).toBe(false);
  expect(via.output).toContain(`web_fetch: redirected to http://other.test:${server.port}/json; fetch it directly`);
  expect(calls).toEqual([`http://public.test:${server.port}/to-other`]);
  expect(hits["/json"]).toBe(before);
});

// ---------- SSRF guard ----------

test("SSRF: redirect from a public host to a host resolving private is refused AT THE HOP — the private target never sees the request", async () => {
  const { tool, calls } = seamTool(async (host) => {
    if (host === "public.test") return ["93.184.216.34"];
    if (host === "private.test") return ["10.0.0.5"];
    throw new Error(`unexpected lookup ${host}`);
  });
  const before = hits["/html"] ?? 0;
  const out = await tool.execute({ url: `http://public.test:${server.port}/to-private` }, ctx());
  expect(out.ok).toBe(false);
  expect(out.output).toContain(`web_fetch: refused http://private.test:${server.port}/html: private.test resolves to 10.0.0.5, a private`);
  expect(calls).toEqual([`http://public.test:${server.port}/to-private`]); // one request; the hop was never issued
  expect(hits["/html"]).toBe(before);
});

test("SSRF: literal private/loopback/link-local/unspecified/mapped targets and localhost names are refused before any connection or DNS query", async () => {
  const { tool, calls } = seamTool(neverResolve);
  const targets = [
    "http://127.0.0.1:1/", "http://localhost:1/x", "http://LOCALHOST./", "http://foo.localhost/", "http://10.0.0.1/",
    "http://[::1]:1/", "http://0.0.0.0:1/", "http://0/", "http://192.168.1.1/", "http://172.16.0.1/", "http://100.64.0.1/",
    "http://[fe80::1]/", "http://[fc00::1]/", "http://[::ffff:127.0.0.1]/", "http://[::]/", "http://[2002:7f00:1::]/",
    "http://0x7f000001/", "http://127.1/", "http://2130706433/", "http://012.0.0.1/",
  ];
  for (const url of targets) {
    const out = await tool.execute({ url }, ctx());
    expect(out.ok).toBe(false);
    expect(out.output.startsWith(`web_fetch: refused ${new URL(url).href}: `)).toBe(true);
    expect(out.output).toContain("(set ROVECODE_WEBFETCH_ALLOW_PRIVATE=1 for local dev servers)");
  }
  expect(calls).toEqual([]);
});

test("SSRF: the cloud metadata address 169.254.169.254 (link-local) is refused", async () => {
  const { tool, calls } = seamTool(neverResolve);
  const out = await tool.execute({ url: "http://169.254.169.254/latest/meta-data/" }, ctx());
  expect(out.ok).toBe(false);
  expect(out.output).toBe("web_fetch: refused http://169.254.169.254/latest/meta-data/: 169.254.169.254 is a private, loopback, link-local or reserved address (set ROVECODE_WEBFETCH_ALLOW_PRIVATE=1 for local dev servers)");
  expect(calls).toEqual([]);
  expect(isPrivateAddress("169.254.169.254")).toBe(true);
  expect(isPrivateAddress("169.253.255.255")).toBe(false);
});

test("SSRF: a name is refused when ANY resolved address is private; unresolvable names are a clean error; public names are fetched", async () => {
  const seen: string[] = [];
  const { tool, calls } = seamTool(async (host) => {
    seen.push(host);
    if (host === "mixed.test") return ["93.184.216.34", "10.0.0.7"];
    if (host === "public.test") return ["93.184.216.34", "2606:4700::1111"];
    throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
  });
  const mixed = await tool.execute({ url: `http://mixed.test:${server.port}/json` }, ctx());
  expect(mixed.ok).toBe(false);
  expect(mixed.output).toContain("mixed.test resolves to 10.0.0.7, a private, loopback, link-local or reserved address");
  const nx = await tool.execute({ url: "http://nx.test/" }, ctx());
  expect(nx.ok).toBe(false);
  expect(nx.output).toBe("web_fetch: refused http://nx.test/: could not resolve nx.test: getaddrinfo ENOTFOUND nx.test (set ROVECODE_WEBFETCH_ALLOW_PRIVATE=1 for local dev servers)");
  expect(calls).toEqual([]);
  const pub = await tool.execute({ url: `http://PUBLIC.test:${server.port}/json` }, ctx());
  expect(pub.ok).toBe(true);
  expect(pub.output.endsWith('\n\n{"a":1,"b":[1,2]}')).toBe(true);
  expect(calls).toEqual([`http://public.test:${server.port}/json`]);
  expect(seen).toEqual(["mixed.test", "nx.test", "public.test"]); // canonical (lowercased) host reaches the resolver
});

test("scheme gate: non-http(s) and malformed URLs are rejected without a request", async () => {
  const { tool, calls } = seamTool(neverResolve);
  for (const url of ["ftp://example.com/", "file:///etc/passwd", "javascript:alert(1)", "data:text/plain,hi"]) {
    const out = await tool.execute({ url }, ctx());
    expect(out.ok).toBe(false);
    expect(out.output.startsWith("web_fetch: unsupported URL scheme ")).toBe(true);
  }
  expect((await tool.execute({ url: "not a url" }, ctx())).output).toBe("web_fetch: invalid URL: not a url");
  expect((await tool.execute({}, ctx())).output).toBe("web_fetch: url is required");
  expect(calls).toEqual([]);
});

test("ROVECODE_WEBFETCH_ALLOW_PRIVATE=1 opens the door to 127.0.0.1; unset, the same URL is refused", async () => {
  const refused = await withEnv({ ROVECODE_WEBFETCH_ALLOW_PRIVATE: undefined }, () => webFetchTool.execute({ url: `${base}/json` }, ctx()));
  expect(refused.ok).toBe(false);
  expect(refused.output).toBe(`web_fetch: refused ${base}/json: 127.0.0.1 is a private, loopback, link-local or reserved address (set ROVECODE_WEBFETCH_ALLOW_PRIVATE=1 for local dev servers)`);
  const allowed = await local(() => webFetchTool.execute({ url: `${base}/json` }, ctx()));
  expect(allowed.ok).toBe(true);
});

test("isPrivateAddress: v4 ranges, v6 non-global space, IPv4-mapped/6to4 unmapping, fail-closed on garbage", () => {
  const priv = ["127.0.0.1", "10.0.0.1", "172.16.5.5", "172.31.255.255", "192.168.1.1", "169.254.169.254", "0.0.0.0", "100.64.0.1",
    "224.0.0.1", "255.255.255.255", "198.18.0.1", "192.0.2.1", "::", "::1", "fe80::1", "fe80::1%eth0", "fd12::1", "fc00::1",
    "::ffff:10.0.0.1", "::ffff:7f00:1", "2002:7f00:0001::", "64:ff9b::7f00:1", "2001:db8::1", "ff02::1", "garbage", "256.1.1.1", "1:2:3:4:5:6:7::8"];
  const pub = ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.32.0.1", "198.20.0.1", "::ffff:8.8.8.8", "::ffff:1.2.3.4", "2002:0808:0808::", "2606:4700::1111", "2a00:1450:4001:80b::200e"];
  for (const ip of priv) expect([ip, isPrivateAddress(ip)]).toEqual([ip, true]);
  for (const ip of pub) expect([ip, isPrivateAddress(ip)]).toEqual([ip, false]);
});

test("canonicalHost + ssrfDenyReason: brackets and trailing dots stripped, lowercased; literals skip DNS", async () => {
  expect(canonicalHost("[::1]")).toBe("::1");
  expect(canonicalHost("LOCALHOST.")).toBe("localhost");
  expect(canonicalHost("Example.COM")).toBe("example.com");
  expect(await ssrfDenyReason("[::1]", neverResolve)).toBe("::1 is a private, loopback, link-local or reserved address");
  expect(await ssrfDenyReason("foo.localhost", neverResolve)).toBe("foo.localhost is a loopback name");
  expect(await ssrfDenyReason("8.8.8.8", neverResolve)).toBeNull();
  expect(await ssrfDenyReason("ok.test", async () => ["8.8.8.8"])).toBeNull();
  expect(await ssrfDenyReason("empty.test", async () => [])).toBe("could not resolve empty.test");
});

// ---------- bounds ----------

test(`byte bound: a 2.1MB body is read up to exactly MAX_BYTES (${MAX_BYTES}) with the marker; a mid-sequence cut leaves no replacement char`, async () => local(async () => {
  const out = await webFetchTool.execute({ url: `${base}/big`, maxChars: CHARS_CAP }, ctx());
  expect(out.ok).toBe(true);
  expect((out.data as { bytes: number; truncated: boolean }).bytes).toBe(MAX_BYTES);
  expect((out.data as { truncated: boolean }).truncated).toBe(true);
  const [header, body, notes] = out.output.split("\n\n");
  expect(header).toBe(`${base}/big (HTTP 200, text/plain, ${MAX_BYTES} bytes)`);
  expect(body!.length).toBe(Math.floor(MAX_BYTES / 3)); // 3-byte chars; the partial 4th-byte sequence is dropped
  expect(body!.endsWith("€")).toBe(true);
  expect(notes).toBe(`(Body truncated at ${MAX_BYTES} bytes of 2100000.)`);
  expect(out.output).not.toContain("(Text truncated");
}));

test("byte bound: a body of exactly MAX_BYTES is NOT truncated and carries no marker", async () => local(async () => {
  const out = await webFetchTool.execute({ url: `${base}/exact`, maxChars: CHARS_CAP }, ctx());
  expect(out.data).toEqual({ url: `${base}/exact`, status: 200, contentType: "text/plain", bytes: MAX_BYTES, redirects: 0, truncated: false });
  expect(out.output).not.toContain("truncated");
  expect(out.output.endsWith("€ab")).toBe(true);
}));

test("LOW-8: a zero-length chunk after exactly MAX_BYTES is not overflow (no marker); a real byte after the cap still truncates", async () => {
  const exact = new TextEncoder().encode("€".repeat(174_762) + "ab");
  expect(exact.length).toBe(MAX_BYTES);
  let tail: Uint8Array[] = [new Uint8Array(0)];
  const tool = createWebFetchTool({
    fetch: async () => new Response(new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(exact); for (const t of tail) c.enqueue(t); c.close(); },
    }), { headers: { "content-type": "text/plain; charset=utf-8" } }),
    resolve: async () => ["93.184.216.34"],
  });
  const clean = await tool.execute({ url: "http://public.test/exact", maxChars: CHARS_CAP }, ctx());
  expect(clean.data).toEqual({ url: "http://public.test/exact", status: 200, contentType: "text/plain", bytes: MAX_BYTES, redirects: 0, truncated: false });
  expect(clean.output).not.toContain("truncated");
  expect(clean.output.endsWith("€ab")).toBe(true);
  tail = [new Uint8Array(0), new Uint8Array([0x63])];
  const over = await tool.execute({ url: "http://public.test/over", maxChars: CHARS_CAP }, ctx());
  expect((over.data as { bytes: number; truncated: boolean }).bytes).toBe(MAX_BYTES);
  expect((over.data as { truncated: boolean }).truncated).toBe(true);
  expect(over.output).toContain(`(Body truncated at ${MAX_BYTES} bytes.)`);
});

test("char bound: maxChars truncates the text with the exact marker; absurd values clamp to CHARS_CAP; the schema advertises default and cap", async () => local(async () => {
  const cut = await webFetchTool.execute({ url: `${base}/text`, maxChars: 100 }, ctx());
  expect(cut.output).toBe(`${base}/text (HTTP 200, text/plain, 1000 bytes)\n\n${"0123456789".repeat(10)}\n\n(Text truncated: showing first 100 of 1000 characters.)`);
  expect((cut.data as { truncated: boolean }).truncated).toBe(true);
  const clamped = await webFetchTool.execute({ url: `${base}/text`, maxChars: 10_000_000 }, ctx());
  expect(clamped.output).not.toContain("truncated");
  expect(CHARS_CAP).toBe(250_000);
  expect(clampChars(1e9)).toBe(CHARS_CAP);
  expect(clampChars(CHARS_CAP + 1)).toBe(CHARS_CAP);
  expect(clampChars(CHARS_CAP)).toBe(CHARS_CAP);
  for (const bad of [undefined, 0, -1, Number.NaN]) expect(clampChars(bad)).toBe(CHARS_DEFAULT);
  expect(clampChars(2.9)).toBe(2);
  const props = webFetchTool.schema.args["properties"] as Record<string, { description: string }>;
  expect(props["maxChars"]!.description).toContain(`default ${CHARS_DEFAULT}`);
  expect(props["maxChars"]!.description).toContain(`cap ${CHARS_CAP}`);
  expect(webFetchTool.schema.description).toContain(`${MAX_REDIRECTS} redirects`);
  expect(webFetchTool.schema.description).toContain(`${MAX_BYTES} bytes`);
}));

// ---------- timeout + abort ----------

test("timeout: ROVECODE_WEBFETCH_TIMEOUT_MS=200 against a 5s-silent server → clean timeout error promptly (ref'd timer, no hang)", async () => {
  await withEnv({ ROVECODE_WEBFETCH_ALLOW_PRIVATE: "1", ROVECODE_WEBFETCH_TIMEOUT_MS: "200" }, async () => {
    const t0 = Date.now();
    const out = await within(3000, webFetchTool.execute({ url: `${base}/slow` }, ctx()));
    const elapsed = Date.now() - t0;
    expect(out.ok).toBe(false);
    expect(out.output).toBe("web_fetch: timed out after 200ms");
    expect(elapsed).toBeGreaterThanOrEqual(150);
    expect(elapsed).toBeLessThan(1000);
  });
  expect(TIMEOUT_DEFAULT_MS).toBe(30_000);
});

test("LOW-7: the timeout bounds the DNS phase — a 1.5s resolver under ROVECODE_WEBFETCH_TIMEOUT_MS=200 fails at ~200ms, not 1500; Esc during DNS aborts promptly; nothing is sent", async () => {
  const pending = new Set<ReturnType<typeof setTimeout>>();
  const slow = (): Promise<string[]> => new Promise((r) => { pending.add(setTimeout(() => r(["93.184.216.34"]), 1500)); });
  const { tool, calls } = seamTool(slow);
  try {
    await withEnv({ ROVECODE_WEBFETCH_ALLOW_PRIVATE: undefined, ROVECODE_WEBFETCH_TIMEOUT_MS: "200" }, async () => {
      const t0 = Date.now();
      const out = await within(3000, tool.execute({ url: "http://public.test/json" }, ctx()));
      const elapsed = Date.now() - t0;
      expect(out.ok).toBe(false);
      expect(out.output).toBe("web_fetch: timed out after 200ms");
      expect(elapsed).toBeGreaterThanOrEqual(150);
      expect(elapsed).toBeLessThan(1000);
    });
    await withEnv({ ROVECODE_WEBFETCH_ALLOW_PRIVATE: undefined, ROVECODE_WEBFETCH_TIMEOUT_MS: undefined }, async () => {
      const ac = new AbortController();
      pending.add(setTimeout(() => ac.abort(), 100));
      const t0 = Date.now();
      const out = await within(3000, tool.execute({ url: "http://public.test/json" }, ctx(ac.signal)));
      expect(out.output).toBe("web_fetch: aborted");
      expect(Date.now() - t0).toBeLessThan(1000);
    });
    expect(calls).toEqual([]);
  } finally { for (const t of pending) clearTimeout(t); }
});

test("abort: ctx.signal aborted mid-fetch → prompt 'aborted' failure (not a timeout); a pre-aborted signal sends nothing", async () => local(async () => {
  const ac = new AbortController();
  const kick = setTimeout(() => ac.abort(), 100);
  try {
    const t0 = Date.now();
    const out = await within(3000, webFetchTool.execute({ url: `${base}/slow` }, ctx(ac.signal)));
    expect(out.ok).toBe(false);
    expect(out.output).toBe("web_fetch: aborted");
    expect(Date.now() - t0).toBeLessThan(1000);
  } finally { clearTimeout(kick); }
  const pre = new AbortController();
  pre.abort();
  const before = hits["/slow"] ?? 0;
  const out = await webFetchTool.execute({ url: `${base}/slow` }, ctx(pre.signal));
  expect(out.output).toBe("web_fetch: aborted");
  expect(hits["/slow"]).toBe(before);
}));

// ---------- policy: kind network → net.fetch, resource = host ----------

const call = (id: string, url = `${base}/json`): ToolCallPart => ({ kind: "tool_call", id, tool: "web_fetch", args: { url } });
function registry(): ToolRegistry { const r = new ToolRegistry(); r.register(webFetchTool); return r; }

test("policy: deny-default with no rules; a prompt rule with NO approver is denied as prompt-class — the request is never made", async () => local(async () => {
  const before = hits["/json"] ?? 0;
  const events: RunEvent[] = [];
  const denied = await registry().dispatch(call("p1"), ctx(), undefined, [], undefined, (e) => events.push(e));
  expect(denied.ok).toBe(false);
  expect(denied.output).toBe("Permission denied: no rule allows net.fetch");
  expect(events).toEqual([{ type: "tool_call_failed", callId: "p1", reason: "permission_denied", detail: "no rule allows net.fetch" }]);
  const prompt: PermissionRule[] = [{ action: "net.fetch", resource: "*", effect: "prompt" }];
  const unapproved = await registry().dispatch(call("p2"), ctx(), undefined, prompt, undefined, () => {});
  expect(unapproved.ok).toBe(false);
  expect(unapproved.output).toBe("Permission denied: approval required, no approver available");
  expect(hits["/json"]).toBe(before);
  // an approver turns the prompt into a run; it is asked about net.fetch on the HOST
  const asked: string[] = [];
  const approved = await registry().dispatch(call("p3"), ctx(), undefined, prompt, async (req) => { asked.push(`${req.tool}|${req.reason}`); return "once"; }, () => {});
  expect(approved.ok).toBe(true);
  expect(asked).toEqual(["web_fetch|permission required for net.fetch 127.0.0.1"]);
  expect(hits["/json"]).toBe(before + 1);
}));

test("policy: `allow net.fetch <host>` auto-runs for that host only; `deny net.fetch *` blocks even under allow-all", async () => local(async () => {
  const before = hits["/json"] ?? 0;
  const allowHost: PermissionRule[] = [{ action: "net.fetch", resource: "127.0.0.1", effect: "allow" }];
  const ran = await registry().dispatch(call("a1"), ctx(), undefined, allowHost, undefined, () => {});
  expect(ran.ok).toBe(true);
  expect(hits["/json"]).toBe(before + 1);
  const otherHost: PermissionRule[] = [{ action: "net.fetch", resource: "docs.example.com", effect: "allow" }];
  const other = await registry().dispatch(call("a2"), ctx(), undefined, otherHost, undefined, () => {});
  expect(other.output).toBe("Permission denied: no rule allows net.fetch");
  const denyAll: PermissionRule[] = [{ action: "*", resource: "*", effect: "allow" }, { action: "net.fetch", resource: "*", effect: "deny" }];
  const blocked = await registry().dispatch(call("a3"), ctx(), undefined, denyAll, undefined, () => {});
  expect(blocked.output).toBe("Permission denied: denied by rule net.fetch *");
  // the read-class allow that auto-runs glob/grep/ls must NOT cover web_fetch
  const readOnly: PermissionRule[] = [{ action: "file.read", resource: "*", effect: "allow" }];
  expect((await registry().dispatch(call("a4"), ctx(), undefined, readOnly, undefined, () => {})).ok).toBe(false);
  expect(hits["/json"]).toBe(before + 1);
}));

test("MED-2: policy sees the CANONICAL host — `deny net.fetch evil.com` holds for evil.com., EVIL.COM and a port; `allow net.fetch public.test` covers PUBLIC.test.", async () => {
  const { tool, calls } = seamTool(async () => ["93.184.216.34"]);
  const r = new ToolRegistry();
  r.register(tool);
  const deny: PermissionRule[] = [{ action: "net.fetch", resource: "*", effect: "allow" }, { action: "net.fetch", resource: "evil.com", effect: "deny" }];
  for (const url of ["http://evil.com./json", "http://EVIL.COM/json", "http://EVIL.com.:8080/json"]) {
    const out = await r.dispatch(call(`d:${url}`, url), ctx(), undefined, deny, undefined, () => {});
    expect([url, out.output]).toEqual([url, "Permission denied: denied by rule net.fetch evil.com"]);
  }
  expect(calls).toEqual([]); // denied before execution; the seam would have refused evil.com anyway
  const allow: PermissionRule[] = [{ action: "net.fetch", resource: "public.test", effect: "allow" }];
  const dotted = await r.dispatch(call("a:dot", `http://PUBLIC.test.:${server.port}/json`), ctx(), undefined, allow, undefined, () => {});
  expect(dotted.ok).toBe(true);
  expect(calls).toEqual([`http://public.test.:${server.port}/json`]);
});

test("policy: under the runtime's default gated rules web_fetch is PROMPT class (fails closed headless, runs with an approver); yolo auto-runs", async () => local(async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-web-rt-"));
  try {
    const rt = createRuntime({ cwd, stream: null });
    const before = hits["/json"] ?? 0;
    const headless = rt.buildCfg(false);
    const closed = await rt.registry.dispatch(call("r1"), ctx(), undefined, headless.permissionRules, headless.approval, () => {});
    expect(closed.ok).toBe(false);
    expect(closed.output).toBe("Permission denied by user"); // execPolicyApprover with no inner approver fails closed
    expect(hits["/json"]).toBe(before);
    const seen: string[] = [];
    const approver: ApprovalFn = async (req) => { seen.push(req.tool); return "once"; };
    const gated = rt.buildCfg(false, approver);
    const ran = await rt.registry.dispatch(call("r2"), ctx(), undefined, gated.permissionRules, gated.approval, () => {});
    expect(ran.ok).toBe(true);
    expect(seen).toEqual(["web_fetch"]);
    const yolo = rt.buildCfg(true);
    const auto = await rt.registry.dispatch(call("r3"), ctx(), undefined, yolo.permissionRules, yolo.approval, () => {});
    expect(auto.ok).toBe(true);
    expect(hits["/json"]).toBe(before + 2);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
}));

// ---------- registration ----------

test("registration: createRuntime registers web_fetch with kind network; main.ts cmdTools registers it; the offline gauntlet runner does not", () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-web-reg-"));
  try {
    const rt = createRuntime({ cwd, stream: null });
    const tool = rt.registry.list().find((t) => t.schema.name === "web_fetch");
    expect(tool?.kind).toBe("network");
    expect(tool?.sequential).toBe(false);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
  const mainSrc = readFileSync(join(import.meta.dir, "../../src/cli/main.ts"), "utf8");
  // #56 put web_search on the same registration call — the pin follows the line rather than freezing
  // web_fetch's old solitude, which was never the property worth protecting
  expect(mainSrc).toMatch(/registry\.register\([^)\n]*\bwebFetchTool\b[^)\n]*\)/);
  // The invariant is that the offline runner cannot REACH the network, so it is asserted on the
  // identifier that would import or register the tool — not on the tool's NAME appearing anywhere in
  // the file. A bare substring scan failed the moment a comment explained which tools the runner
  // deliberately leaves out, which is documentation working exactly as intended.
  const gauntletSrc = readFileSync(join(import.meta.dir, "../../src/eval/gauntlet-runner.ts"), "utf8");
  expect(gauntletSrc).not.toContain("webFetchTool");
  const code = gauntletSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  expect(code).not.toContain("web_fetch");
});
