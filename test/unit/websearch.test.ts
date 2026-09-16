/** Port #56 web_search (1/2: parsing, rendering, bounds, failures): opencode's Exa-MCP web search
 *  ported behind web_fetch's pipeline. Pins: the RECORDED live SSE body parses to 3 ranked results
 *  (title/url/snippet, `...` gaps → …, N/A dates dropped), JSON + SSE + error envelopes, the raw
 *  {results:[]} JSON shape, byte-exact rendering, the result-count clamp (default 8, cap 20 — sent to
 *  the backend AND applied to its answer), snippet/title/url caps, the whole-output cap with
 *  whole-result dropping and its marker, non-2xx / JSON-RPC error / isError / malformed → error
 *  results (never a throw), the JSON-RPC request shape. The guard, redirects, timeout, policy, key
 *  and registration pins live in websearch-guard.test.ts. Fixtures: the recorded body
 *  (test/fixtures/websearch.ts), constructed Responses, and one Bun.serve on 127.0.0.1 reached only
 *  through a host-rewriting fetch seam — globalThis.fetch is guarded for the whole file, so nothing
 *  here can reach the network or real DNS. */

import { test, expect, afterAll } from "bun:test";
import {
  webSearchTool, clampResults, parseMcpBody, parseExaContext, parseResultsText, formatResults,
  ENDPOINT, RESULTS_DEFAULT, RESULTS_CAP, QUERY_CHARS, SNIPPET_CHARS, TITLE_CHARS, URL_CHARS, OUTPUT_CHARS_CAP, TIMEOUT_DEFAULT_MS,
} from "../../src/tools/websearch.ts";
import { EXA_SSE_BODY, EXA_SSE_EXPECTED } from "../fixtures/websearch.ts";
import { ctx, within, seam, envelope, sse, json, blocks, recordedText, sentArgs, guardEgress, type Respond } from "../fixtures/websearch-seam.ts";

// ---------- fixture server (127.0.0.1, ephemeral port): the recorded SSE body over a real socket ----------

const seen: { path: string; method: string; accept: string | null; contentType: string | null; body: string }[] = [];
const server = Bun.serve({
  port: 0, hostname: "127.0.0.1", idleTimeout: 0,
  async fetch(req): Promise<Response> {
    const u = new URL(req.url);
    seen.push({ path: u.pathname, method: req.method, accept: req.headers.get("accept"), contentType: req.headers.get("content-type"), body: await req.text() });
    if (u.pathname === "/mcp") return new Response(EXA_SSE_BODY, { headers: { "content-type": "text/event-stream" } });
    return new Response("?", { status: 500, headers: { "content-type": "text/plain" } });
  },
});
const base = `http://127.0.0.1:${server.port}`;
// no network in tests: only the loopback fixture may be fetched; anything else is refused and tallied
const egress = guardEgress((url) => url.startsWith(base + "/"));
afterAll(() => { server.stop(true); egress.restore(); expect(egress.egress).toEqual([]); });

/** Real fetch, rewritten onto the fixture server; any other host is REFUSED rather than fetched. */
const live: Respond = (url, init) => {
  const onFixture = url.replace("https://mcp.exa.ai", base);
  if (onFixture === url) throw new Error(`fixture-only fetch seam: refusing ${url}`);
  return fetch(onFixture, init);
};

// ---------- envelope + result-text parsing ----------

test("parseMcpBody: the recorded SSE body → Exa's context text; a JSON body; a JSON-RPC error; isError content; garbage/empty/text-less → null; data lines without text are skipped", () => {
  const rec = parseMcpBody(EXA_SSE_BODY);
  expect(rec !== null && "text" in rec && rec.text.startsWith("Title: Node fs.mkdtempSync function | API Reference\nURL: https://bun.com/reference/node/fs/mkdtempSync\n")).toBe(true);
  expect(parseMcpBody(envelope("hi"))).toEqual({ text: "hi" });
  expect(parseMcpBody('{"jsonrpc":"2.0","id":1,"error":{"code":-32600,"message":"bad request"}}')).toEqual({ error: "bad request" });
  expect(parseMcpBody('{"jsonrpc":"2.0","id":1,"error":{"code":-32000}}')).toEqual({ error: '{"code":-32000}' });
  expect(parseMcpBody('{"result":{"content":[{"type":"text","text":"Search error: quota exceeded"}],"isError":true}}')).toEqual({ error: "Search error: quota exceeded" });
  for (const bad of ["<html>oops</html>", "", "{not json", '{"result":{"content":[]}}', '{"result":{"content":[{"type":"image","data":"x"}]}}', "event: message\n\n"]) expect([bad, parseMcpBody(bad)]).toEqual([bad, null]);
  expect(parseMcpBody('event: ping\ndata: {}\n\ndata:{"result":{"content":[{"type":"text","text":"second"}]}}\r\n')).toEqual({ text: "second" });
});

test("parseExaContext on the recorded body: 3 results in rank order with exact titles/urls, N/A dates dropped, `...` gap lines → ` … `, one-line snippets", () => {
  const results = parseExaContext(recordedText());
  expect(results.map((r) => [r.title, r.url])).toEqual(EXA_SSE_EXPECTED.map((e) => [...e]));
  for (const r of results) {
    expect("publishedDate" in r).toBe(false);
    expect(r.snippet).not.toContain("\n");
    expect(r.snippet).not.toMatch(/(^| )\.\.\.( |$)/); // no standalone gap marker survives (the 3rd result's `...bunEnv` is real code, kept)
    expect(r.snippet).toContain(" … ");
  }
  expect(results[0]!.snippet.startsWith("Node fs.mkdtempSync function | API Reference | Bun … # fs.mkdtempSync … Returns the created directory path. … function mkdtempSync( … Synchronously creates a unique temporary directory.")).toBe(true);
  expect(results[0]!.snippet.endsWith("to create a unique temporary directory.")).toBe(true);
  expect(results[1]!.snippet.startsWith('import { accessSync, appendFileSync, existsSync, constants as fs,')).toBe(true);
});

test("parseExaContext synthetic: a real Published date is kept, Author ignored, Text: marker, CRLF, a block without an http url is skipped, the title falls back to the url, leading/trailing gap markers vanish", () => {
  const text = [
    "Title: A\r\nURL: https://a.test/x\r\nPublished: 2025-03-10T00:00:00.000Z\r\nAuthor: Bob\r\nHighlights:\r\n...\r\nfirst\r\n...\r\n...\r\nsecond\r\n...",
    "Title: no url here\r\nPublished: 2024\r\nHighlights:\r\nzzz",
    "URL: https://b.test/\r\nText:\r\nbody   text\r\nmore",
    "Title: bad scheme\r\nURL: ftp://c.test/\r\nHighlights:\r\nq",
  ].join("\r\n\r\n---\r\n\r\n");
  expect(parseExaContext(text)).toEqual([
    { title: "A", url: "https://a.test/x", publishedDate: "2025-03-10T00:00:00.000Z", snippet: "first … second" },
    { title: "https://b.test/", url: "https://b.test/", snippet: "body text more" },
  ]);
  expect(parseExaContext("")).toEqual([]);
  expect(parseExaContext("just prose\nno fields")).toEqual([]);
});

test("parseResultsText: raw {results:[…]} JSON (text | highlights | summary, publishedDate), empty results / the no-results sentence / blank → [], prose or foreign JSON → null", () => {
  const raw = JSON.stringify({ requestId: "r", results: [
    { title: "T1", url: "https://one.test/", publishedDate: "2024-01-02", text: "line one\nline two" },
    { url: "https://two.test/", highlights: ["h1", "h2"], publishedDate: "" },
    { title: "bad", url: "ftp://nope" },
    { title: "S", url: "https://three.test/", summary: "sum" },
    "garbage", null,
  ] });
  expect(parseResultsText(raw)).toEqual([
    { title: "T1", url: "https://one.test/", publishedDate: "2024-01-02", snippet: "line one line two" },
    { title: "https://two.test/", url: "https://two.test/", snippet: "h1 … h2" },
    { title: "S", url: "https://three.test/", snippet: "sum" },
  ]);
  expect(parseResultsText('{"results":[]}')).toEqual([]);
  expect(parseResultsText("No search results found. Please try a different query.")).toEqual([]);
  expect(parseResultsText("  \n")).toEqual([]);
  expect(parseResultsText("Sorry, nothing structured here.")).toBeNull();
  expect(parseResultsText('{"foo":1}')).toBeNull();
  expect(parseResultsText("{not json")).toBeNull();
  expect(parseResultsText(recordedText())).toHaveLength(3);
});

// ---------- rendering ----------

test("formatResults: byte-exact `N. title · url · date` + indented snippet, blank-line separated under a header; a snippet-less result is one line; whitespace in titles collapses", () => {
  const results = [
    { title: "  Spaced\n Title ", url: "https://a.test/x", publishedDate: "2025-03-10", snippet: "snip" },
    { title: "B", url: "https://b.test/", snippet: "" },
  ];
  const r = formatResults("bun test", results);
  expect(r.output).toBe('2 results for "bun test" (Exa web search)\n\n1. Spaced Title · https://a.test/x · 2025-03-10\n   snip\n\n2. B · https://b.test/');
  expect(r).toMatchObject({ shown: 2, truncated: false });
  expect(formatResults("q", results.slice(0, 1)).output.startsWith('1 result for "q" (Exa web search)\n\n1. ')).toBe(true);
});

test("formatResults caps: whole trailing results are dropped (never split) with the exact marker and the output stays under the cap; long titles/urls/snippets clip to TITLE_CHARS/URL_CHARS/SNIPPET_CHARS with an ellipsis", () => {
  const results = [
    { title: "Spaced Title", url: "https://a.test/x", publishedDate: "2025-03-10", snippet: "snip" },
    { title: "B", url: "https://b.test/", snippet: "" },
  ];
  const small = formatResults("q", results, 200);
  expect(small).toMatchObject({ shown: 1, truncated: true });
  expect(small.output.endsWith("\n\n(Showing 1 of 2 results: output capped at 200 characters.)")).toBe(true);
  expect(small.output).toContain("1. Spaced Title");
  expect(small.output).not.toContain("2. B");
  expect(small.output.length).toBeLessThanOrEqual(200);
  const long = formatResults("q", [{ title: "T".repeat(TITLE_CHARS + 50), url: "https://x.test/" + "b".repeat(URL_CHARS + 500), snippet: "s".repeat(SNIPPET_CHARS * 2) }]);
  const [, , head, snippet] = long.output.split("\n");
  expect(head!.length).toBe("1. ".length + TITLE_CHARS + " · ".length + URL_CHARS);
  expect(head!.startsWith("1. " + "T".repeat(TITLE_CHARS - 1) + "… · https://x.test/bbb")).toBe(true);
  expect(head!.endsWith("…")).toBe(true);
  expect(snippet).toBe("   " + "s".repeat(SNIPPET_CHARS - 1) + "…");
  expect(long.truncated).toBe(false);
});

// ---------- the tool: happy path over a real socket ----------

test("happy path: the recorded SSE body over a real socket → header + 3 ranked entries with bounded snippets, data {count,total,results}; the request is ONE JSON-RPC tools/call of web_search_exa (POST, Accept json+SSE, opencode's argument defaults)", async () => {
  const { tool, calls } = seam(live);
  seen.length = 0;
  const query = "Bun test runner mkdtempSync temporary directory";
  const out = await within(5000, tool.execute({ query, max_results: 3 }, ctx()));
  expect(out.ok).toBe(true);
  expect(out.output.startsWith(`3 results for "${query}" (Exa web search)\n\n1. Node fs.mkdtempSync function | API Reference · https://bun.com/reference/node/fs/mkdtempSync\n   Node fs.mkdtempSync function | API Reference | Bun … # fs.mkdtempSync … Returns the created directory path.`)).toBe(true);
  expect(out.output).toContain("\n\n2. scripts/runner.node.mjs · https://github.com/oven-sh/bun/blob/88a63988/scripts/runner.node.mjs\n   import { accessSync, appendFileSync,");
  expect(out.output).toContain("\n\n3. test/bake/bake-harness.ts at 74e191b3 · oven-sh/bun · https://github.com/oven-sh/bun/blob/74e191b3/test/bake/bake-harness.ts\n   ");
  expect(out.output).not.toContain("Published: N/A");
  expect(out.output).not.toContain("Author:");
  for (const line of out.output.split("\n").filter((l) => l.startsWith("   "))) expect(line.length).toBeLessThanOrEqual(3 + SNIPPET_CHARS);
  const data = out.data as { query: string; count: number; total: number; truncated: boolean; results: { title: string; url: string; snippet: string; publishedDate?: string }[] };
  expect(data).toMatchObject({ query, count: 3, total: 3, truncated: false });
  expect(data.results.map((r) => [r.title, r.url])).toEqual(EXA_SSE_EXPECTED.map((e) => [...e]));
  expect(Object.keys(data.results[0]!).sort()).toEqual(["snippet", "title", "url"]);
  // the wire: exactly one POST to the endpoint path, JSON-RPC 2.0 tools/call, opencode's defaults + our contextMaxCharacters
  expect(calls.map((c) => c.url)).toEqual([ENDPOINT]);
  expect(calls[0]!.init.method).toBe("POST");
  expect(calls[0]!.init.redirect).toBe("manual");
  expect(seen).toHaveLength(1);
  expect(seen[0]).toMatchObject({ path: "/mcp", method: "POST", accept: "application/json, text/event-stream", contentType: "application/json" });
  expect(JSON.parse(seen[0]!.body)).toEqual({
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "web_search_exa", arguments: { query, type: "auto", numResults: 3, livecrawl: "fallback", contextMaxCharacters: 10_000 } },
  });
  expect(webSearchTool.kind).toBe("network");
  expect(webSearchTool.sequential).toBe(false);
});

// ---------- bounds ----------

test("max_results: absent → 8 requested AND applied; 100 → 20 (the cap) — a backend surplus is cut, never rendered; the clamp contract; the schema advertises every bound", async () => {
  const { tool, calls } = seam(() => sse(blocks(30)));
  const dflt = await tool.execute({ query: "q" }, ctx());
  expect(dflt.ok).toBe(true);
  expect(sentArgs(calls[0]!.init)["numResults"]).toBe(RESULTS_DEFAULT);
  expect(dflt.output.startsWith('8 results for "q" (Exa web search)\n\n1. R1 · https://r1.test/p\n   body 1\n\n')).toBe(true);
  expect(dflt.output).toContain("\n\n8. R8 · https://r8.test/p\n   body 8");
  expect(dflt.output).not.toContain("9. R9");
  expect(dflt.data).toMatchObject({ count: 8, total: 30, truncated: true });
  const capped = await tool.execute({ query: "q", max_results: 100 }, ctx());
  expect(sentArgs(calls[1]!.init)).toMatchObject({ numResults: RESULTS_CAP, contextMaxCharacters: RESULTS_CAP * 1500 });
  expect(capped.output.startsWith('20 results for "q"')).toBe(true);
  expect(capped.output).toContain("\n\n20. R20 · ");
  expect(capped.output).not.toContain("21. R21");
  expect((capped.data as { results: unknown[] }).results).toHaveLength(20);
  const two = await tool.execute({ query: "q", max_results: 2.9 }, ctx());
  expect(sentArgs(calls[2]!.init)["numResults"]).toBe(2);
  expect(two.output.startsWith('2 results for "q"')).toBe(true);
  expect(RESULTS_DEFAULT).toBe(8);
  expect(RESULTS_CAP).toBe(20);
  for (const bad of [undefined, 0, -1, Number.NaN, "abc", "", null, {}]) expect([bad, clampResults(bad)]).toEqual([bad, RESULTS_DEFAULT]);
  expect(clampResults("5")).toBe(5);
  expect(clampResults(1e9)).toBe(RESULTS_CAP);
  expect(clampResults(RESULTS_CAP + 1)).toBe(RESULTS_CAP);
  const d = webSearchTool.schema.description;
  for (const s of [`default ${RESULTS_DEFAULT}`, `cap ${RESULTS_CAP}`, `${SNIPPET_CHARS} characters`, `${OUTPUT_CHARS_CAP} characters`, `${TIMEOUT_DEFAULT_MS / 1000}s`, ENDPOINT, "no API key", "web_fetch", String(new Date().getFullYear())]) expect(d).toContain(s);
  const props = webSearchTool.schema.args["properties"] as Record<string, { description: string }>;
  expect(props["max_results"]!.description).toBe(`results to return (default ${RESULTS_DEFAULT}, cap ${RESULTS_CAP})`);
  expect(props["query"]!.description).toContain(`${QUERY_CHARS} characters`);
  expect(webSearchTool.schema.args["required"]).toEqual(["query"]);
  expect(Object.keys(props).sort()).toEqual(["max_results", "query"]); // no url/path/command: the policy resource is the tool name
});

test(`output cap: 20 results with ~1.9K-char urls → whole results dropped, output ≤ ${OUTPUT_CHARS_CAP} chars, marker names the counts, data.truncated`, async () => {
  const { tool } = seam(() => sse(blocks(20, (i) => `https://long.test/${"a".repeat(1900)}${i}`)));
  const out = await tool.execute({ query: "q", max_results: 20 }, ctx());
  expect(out.ok).toBe(true);
  expect(out.output.length).toBeLessThanOrEqual(OUTPUT_CHARS_CAP);
  const data = out.data as { count: number; total: number; truncated: boolean; results: unknown[] };
  expect(data.total).toBe(20);
  expect(data.count).toBeGreaterThanOrEqual(6);
  expect(data.count).toBeLessThan(20);
  expect(data.truncated).toBe(true);
  expect(data.results).toHaveLength(data.count);
  expect(out.output).toContain(`\n\n${data.count}. R${data.count} · `);
  expect(out.output).not.toContain(`\n\n${data.count + 1}. R${data.count + 1} · `);
  expect(out.output.endsWith(`\n\n(Showing ${data.count} of 20 results: output capped at ${OUTPUT_CHARS_CAP} characters.)`)).toBe(true);
});

// ---------- failures are results, never throws ----------

test("non-2xx → error result with the status and the first body line; JSON-RPC error, isError content, malformed and text-less bodies → error results; nothing throws", async () => {
  let respond: Respond = () => new Response("upstream exploded\nmore detail", { status: 500, headers: { "content-type": "text/plain" } });
  const { tool } = seam((u, i) => respond(u, i));
  expect(await tool.execute({ query: "q" }, ctx())).toEqual({ ok: false, output: "web_search: backend HTTP 500: upstream exploded" });
  respond = () => new Response(null, { status: 429 });
  expect(await tool.execute({ query: "q" }, ctx())).toEqual({ ok: false, output: "web_search: backend HTTP 429" });
  respond = () => json('{"jsonrpc":"2.0","id":1,"error":{"code":-32600,"message":"bad   request\\nsecond line"}}'); // JSON-escaped newline: the message is whitespace-collapsed
  expect(await tool.execute({ query: "q" }, ctx())).toEqual({ ok: false, output: "web_search: backend error: bad request second line" });
  respond = () => json('{"result":{"content":[{"type":"text","text":"Search error: quota exceeded"}],"isError":true}}');
  expect(await tool.execute({ query: "q" }, ctx())).toEqual({ ok: false, output: "web_search: backend error: Search error: quota exceeded" });
  respond = () => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } });
  expect(await tool.execute({ query: "q" }, ctx())).toEqual({ ok: false, output: "web_search: malformed backend response (6 bytes, no JSON-RPC result with text)" });
  const empty = '{"result":{"content":[]}}';
  respond = () => json(empty);
  expect(await tool.execute({ query: "q" }, ctx())).toEqual({ ok: false, output: `web_search: malformed backend response (${Buffer.byteLength(empty)} bytes, no JSON-RPC result with text)` });
  respond = () => { throw new TypeError("fetch failed"); };
  expect(await tool.execute({ query: "q" }, ctx())).toEqual({ ok: false, output: "web_search: request failed: fetch failed" });
});

test("unrecognized backend text → ok result with the verbatim text, flagged and capped; a recognized no-result answer → ok 'No results'", async () => {
  let text = "Here is some prose without structure.";
  const { tool } = seam(() => sse(text));
  const prose = await tool.execute({ query: "q" }, ctx());
  expect(prose.ok).toBe(true);
  expect(prose.output).toBe('web_search "q": the backend answered in an unrecognized format; shown verbatim:\n\nHere is some prose without structure.');
  expect(prose.data).toEqual({ query: "q", count: 0, total: 0, unstructured: true, truncated: false });
  text = "x".repeat(OUTPUT_CHARS_CAP + 4000);
  const big = await tool.execute({ query: "q" }, ctx());
  expect(big.output).toContain(`shown verbatim (capped at ${OUTPUT_CHARS_CAP} characters):\n\n`);
  expect(big.output.length).toBeLessThan(OUTPUT_CHARS_CAP + 200);
  expect(big.output.endsWith("…")).toBe(true);
  for (const none of ['{"results":[]}', "No search results found. Please try a different query."]) {
    text = none;
    expect(await tool.execute({ query: "bun" }, ctx())).toEqual({ ok: true, output: 'No results for "bun" (Exa web search). Try different or fewer terms.', data: { query: "bun", count: 0, total: 0, results: [], truncated: false } });
  }
});

test("query validation: missing / blank / non-string → 'query is required'; over QUERY_CHARS → 'too long'; nothing is sent either way", async () => {
  const { tool, calls } = seam(() => sse(blocks(1)));
  for (const args of [{}, { query: "" }, { query: "   " }, { query: 42 }, null, undefined]) {
    expect(await tool.execute(args, ctx())).toEqual({ ok: false, output: "web_search: query is required" });
  }
  expect(await tool.execute({ query: "q".repeat(QUERY_CHARS + 1) }, ctx())).toEqual({ ok: false, output: `web_search: query too long (${QUERY_CHARS + 1} characters; max ${QUERY_CHARS})` });
  expect(calls).toEqual([]);
  expect((await tool.execute({ query: "  padded  " }, ctx())).ok).toBe(true);
  expect(sentArgs(calls[0]!.init)["query"]).toBe("padded");
});
