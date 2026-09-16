/** Port #56 web_search (2/2: guard, redirects, timeout, policy, key, registration). Pins: the SSRF
 *  guard on the endpoint AND every redirect hop (private, unresolvable, mixed, literal metadata IP,
 *  cross-host, scheme, hop cap, missing Location) with ZERO requests to a refused target, same-host
 *  redirects re-POSTed, the ref'd timeout (also over the DNS phase) + Esc abort, the policy class
 *  (net.fetch with the TOOL NAME as resource → prompt by default under the runtime rules, allow-by-
 *  name auto-runs, deny-* blocks, file.read never covers it, yolo allows), the optional Exa key
 *  (opencode's `?exaApiKey=`, injected at the ONE runtime registration line and never echoed into an
 *  output — including error text that arrives THROUGH a seam: a fetch/resolver/body-stream rejection
 *  or a backend body carrying the keyed URL or the key is scrubbed, fixer f56), that the tool writes
 *  NOTHING under its cwd on any path, registration in both registries
 *  (not the offline gauntlet runner), and source pins (≤400 lines, no fs/env/Bun.write, the guard
 *  imported from webfetch.ts, no NUL). Everything runs over constructed Responses through the seam;
 *  globalThis.fetch is guarded for the whole file, so nothing here can reach the network or DNS. */

import { test, expect, afterAll } from "bun:test";
import { readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENDPOINT, MAX_REDIRECTS, TIMEOUT_DEFAULT_MS } from "../../src/tools/websearch.ts";
import type { Resolver } from "../../src/tools/webfetch.ts";
import { ToolRegistry } from "../../src/core/tools.ts";
import { createRuntime } from "../../src/cli/runtime.ts";
import type { ToolCallPart, PermissionRule, RunEvent, ApprovalFn } from "../../src/core/types.ts";
import { ctx, within, seam, sse, json, redirect, blocks, PUBLIC, guardEgress, type Respond } from "../fixtures/websearch-seam.ts";

// no network in tests: this file never fetches anything real — every URL is refused and tallied
const egress = guardEgress(() => false);
afterAll(() => { egress.restore(); expect(egress.egress).toEqual([]); });

// ---------- SSRF guard: the endpoint and every hop ----------

test("SSRF: an endpoint that resolves private / mixed / not at all is refused with ZERO requests (mutation: drop the guard → the request is sent)", async () => {
  const priv = seam(() => sse(blocks(1)), { resolve: async () => ["10.0.0.5"] });
  expect(await priv.tool.execute({ query: "q" }, ctx())).toEqual({ ok: false, output: `web_search: refused ${ENDPOINT}: mcp.exa.ai resolves to 10.0.0.5, a private, loopback, link-local or reserved address` });
  expect(priv.calls).toEqual([]);
  const mixed = seam(() => sse(blocks(1)), { resolve: async () => [...PUBLIC, "::1"] });
  expect((await mixed.tool.execute({ query: "q" }, ctx())).output).toBe(`web_search: refused ${ENDPOINT}: mcp.exa.ai resolves to ::1, a private, loopback, link-local or reserved address`);
  expect(mixed.calls).toEqual([]);
  const nx = seam(() => sse(blocks(1)), { resolve: async (h) => { throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${h}`), { code: "ENOTFOUND" }); } });
  expect(await nx.tool.execute({ query: "q" }, ctx())).toEqual({ ok: false, output: `web_search: refused ${ENDPOINT}: could not resolve mcp.exa.ai: getaddrinfo ENOTFOUND mcp.exa.ai` });
  expect(nx.calls).toEqual([]);
  const none = seam(() => sse(blocks(1)), { resolve: async () => [] });
  expect((await none.tool.execute({ query: "q" }, ctx())).output).toBe(`web_search: refused ${ENDPOINT}: could not resolve mcp.exa.ai`);
  expect(none.calls).toEqual([]);
});

test("SSRF at the hop: a redirect to a host resolving private, or to a literal metadata IP, is refused AT THE HOP — one request, the target never sees it, no DNS for literals", async () => {
  const lookups: string[] = [];
  const resolve: Resolver = async (host) => { lookups.push(host); if (host === "mcp.exa.ai") return PUBLIC; if (host === "private.test") return ["10.0.0.5"]; throw new Error(`unexpected lookup ${host}`); };
  const toPrivate = seam((url) => (url === ENDPOINT ? redirect("https://private.test/mcp", 307) : sse(blocks(1))), { resolve });
  expect(await toPrivate.tool.execute({ query: "q" }, ctx())).toEqual({ ok: false, output: "web_search: refused https://private.test/mcp: private.test resolves to 10.0.0.5, a private, loopback, link-local or reserved address" });
  expect(toPrivate.calls.map((c) => c.url)).toEqual([ENDPOINT]);
  expect(lookups).toEqual(["mcp.exa.ai", "private.test"]);
  lookups.length = 0;
  const toMeta = seam((url) => (url === ENDPOINT ? redirect("http://169.254.169.254/latest/meta-data/", 302) : sse(blocks(1))), { resolve });
  expect(await toMeta.tool.execute({ query: "q" }, ctx())).toEqual({ ok: false, output: "web_search: refused http://169.254.169.254/latest/meta-data/: 169.254.169.254 is a private, loopback, link-local or reserved address" });
  expect(toMeta.calls.map((c) => c.url)).toEqual([ENDPOINT]);
  expect(lookups).toEqual(["mcp.exa.ai"]); // the literal never touched DNS
  const toLocal = seam((url) => (url === ENDPOINT ? redirect("http://localhost:8080/mcp", 302) : sse(blocks(1))), { resolve });
  expect((await toLocal.tool.execute({ query: "q" }, ctx())).output).toBe("web_search: refused http://localhost:8080/mcp: localhost is a loopback name");
  expect(toLocal.calls).toHaveLength(1);
});

test("redirects: same-host hops are followed and RE-POSTED with the same body (≤5); a cross-host hop, a non-http scheme, a missing Location and an over-long chain are clean errors with no request to the target", async () => {
  const same = seam((url) => (url === ENDPOINT ? redirect("/mcp2", 308) : url === "https://mcp.exa.ai/mcp2" ? sse(blocks(2)) : new Response("?", { status: 500 })));
  const out = await same.tool.execute({ query: "hop" }, ctx());
  expect(out.ok).toBe(true);
  expect(out.output.startsWith('2 results for "hop"')).toBe(true);
  expect(same.calls.map((c) => c.url)).toEqual([ENDPOINT, "https://mcp.exa.ai/mcp2"]);
  expect(same.calls.map((c) => c.init.method)).toEqual(["POST", "POST"]);
  expect(same.calls[1]!.init.body).toBe(same.calls[0]!.init.body);
  const other = seam((url) => (url === ENDPOINT ? redirect("https://other.test/mcp", 302) : sse(blocks(1))), { resolve: async () => PUBLIC });
  expect(await other.tool.execute({ query: "q" }, ctx())).toEqual({ ok: false, output: "web_search: backend redirected to https://other.test/mcp (other.test is not mcp.exa.ai); not followed" });
  expect(other.calls.map((c) => c.url)).toEqual([ENDPOINT]);
  const dotted = seam((url) => (url === ENDPOINT ? redirect("https://MCP.exa.ai./mcp", 301) : sse(blocks(1))), { resolve: async () => PUBLIC });
  expect((await dotted.tool.execute({ query: "q" }, ctx())).ok).toBe(true); // same canonical host: followed
  expect(dotted.calls).toHaveLength(2);
  const file = seam((url) => (url === ENDPOINT ? redirect("file:///etc/passwd", 302) : sse(blocks(1))));
  expect(await file.tool.execute({ query: "q" }, ctx())).toEqual({ ok: false, output: "web_search: backend redirected to unsupported URL scheme file: (http/https only)" });
  expect(file.calls).toHaveLength(1);
  const noLoc = seam(() => new Response(null, { status: 302 }));
  expect(await noLoc.tool.execute({ query: "q" }, ctx())).toEqual({ ok: false, output: `web_search: HTTP 302 redirect from ${ENDPOINT} without a Location header` });
  const loop = seam(() => redirect(`/mcp?n=${loop.calls.length}`, 302));
  expect(await loop.tool.execute({ query: "q" }, ctx())).toEqual({ ok: false, output: `web_search: too many redirects (more than ${MAX_REDIRECTS}) from ${ENDPOINT}` });
  expect(loop.calls).toHaveLength(MAX_REDIRECTS + 1);
  expect(MAX_REDIRECTS).toBe(5);
});

// ---------- timeout + abort ----------

test("timeout: timeoutMs 200 against a backend that never answers → 'timed out after 200ms' promptly (ref'd timer); the DNS phase is bounded too; Esc mid-request → 'aborted'; a pre-aborted signal sends nothing", async () => {
  const hang: Respond = (_u, init) => new Promise<Response>((_, reject) => init.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
  const slow = seam(hang, { timeoutMs: 200 });
  let t0 = Date.now();
  expect(await within(3000, slow.tool.execute({ query: "q" }, ctx()))).toEqual({ ok: false, output: "web_search: timed out after 200ms" });
  let elapsed = Date.now() - t0;
  expect(elapsed).toBeGreaterThanOrEqual(150);
  expect(elapsed).toBeLessThan(1000);
  const pending = new Set<ReturnType<typeof setTimeout>>();
  try {
    const slowDns = seam(() => sse(blocks(1)), { timeoutMs: 200, resolve: () => new Promise((r) => { pending.add(setTimeout(() => r(PUBLIC), 1500)); }) });
    t0 = Date.now();
    expect(await within(3000, slowDns.tool.execute({ query: "q" }, ctx()))).toEqual({ ok: false, output: "web_search: timed out after 200ms" });
    elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(150);
    expect(elapsed).toBeLessThan(1000);
    expect(slowDns.calls).toEqual([]);
    const ac = new AbortController();
    pending.add(setTimeout(() => ac.abort(), 100));
    const esc = seam(hang);
    t0 = Date.now();
    expect(await within(3000, esc.tool.execute({ query: "q" }, ctx(ac.signal)))).toEqual({ ok: false, output: "web_search: aborted" });
    expect(Date.now() - t0).toBeLessThan(1000);
  } finally { for (const t of pending) clearTimeout(t); }
  const pre = new AbortController();
  pre.abort();
  const quiet = seam(() => sse(blocks(1)));
  expect(await quiet.tool.execute({ query: "q" }, ctx(pre.signal))).toEqual({ ok: false, output: "web_search: aborted" });
  expect(quiet.calls).toEqual([]);
  expect(TIMEOUT_DEFAULT_MS).toBe(25_000);
});

// ---------- policy: kind network → net.fetch, resource = the tool name ----------

const call = (id: string, query = "q"): ToolCallPart => ({ kind: "tool_call", id, tool: "web_search", args: { query } });
function seamRegistry(): { r: ToolRegistry; calls: { url: string }[] } {
  const { tool, calls } = seam(() => sse(blocks(2)));
  const r = new ToolRegistry();
  r.register(tool);
  return { r, calls };
}

test("policy: deny-default; a prompt rule with NO approver fails closed (no request); the approver is asked about `net.fetch web_search`; a denying approver blocks", async () => {
  const { r, calls } = seamRegistry();
  const events: RunEvent[] = [];
  const denied = await r.dispatch(call("p1"), ctx(), undefined, [], undefined, (e) => events.push(e));
  expect(denied).toEqual({ ok: false, output: "Permission denied: no rule allows net.fetch" });
  expect(events).toEqual([{ type: "tool_call_failed", callId: "p1", reason: "permission_denied", detail: "no rule allows net.fetch" }]);
  const prompt: PermissionRule[] = [{ action: "net.fetch", resource: "*", effect: "prompt" }];
  expect(await r.dispatch(call("p2"), ctx(), undefined, prompt, undefined, () => {})).toEqual({ ok: false, output: "Permission denied: approval required, no approver available" });
  expect(calls).toEqual([]);
  const asked: string[] = [];
  const approved = await r.dispatch(call("p3"), ctx(), undefined, prompt, async (req) => { asked.push(`${req.tool}|${req.reason}`); return "once"; }, () => {});
  expect(approved.ok).toBe(true);
  expect(asked).toEqual(["web_search|permission required for net.fetch web_search"]);
  expect(calls).toHaveLength(1);
  expect(await r.dispatch(call("p4", "other"), ctx(), undefined, prompt, async () => "deny", () => {})).toEqual({ ok: false, output: "Permission denied by user" });
  expect(calls).toHaveLength(1);
});

test("policy: `allow net.fetch web_search` auto-runs; a HOST-named allow does not (the resource is the tool name, not the backend host); `deny net.fetch *` wins under allow-all; the file.read allow never covers it", async () => {
  const { r, calls } = seamRegistry();
  const byName: PermissionRule[] = [{ action: "net.fetch", resource: "web_search", effect: "allow" }];
  expect((await r.dispatch(call("a1"), ctx(), undefined, byName, undefined, () => {})).ok).toBe(true);
  expect(calls).toHaveLength(1);
  const byHost: PermissionRule[] = [{ action: "net.fetch", resource: "mcp.exa.ai", effect: "allow" }];
  expect((await r.dispatch(call("a2"), ctx(), undefined, byHost, undefined, () => {})).output).toBe("Permission denied: no rule allows net.fetch");
  const denyAll: PermissionRule[] = [{ action: "*", resource: "*", effect: "allow" }, { action: "net.fetch", resource: "*", effect: "deny" }];
  expect((await r.dispatch(call("a3"), ctx(), undefined, denyAll, undefined, () => {})).output).toBe("Permission denied: denied by rule net.fetch *");
  const readOnly: PermissionRule[] = [{ action: "file.read", resource: "*", effect: "allow" }, { action: "memory.write", resource: "*", effect: "allow" }];
  expect((await r.dispatch(call("a4"), ctx(), undefined, readOnly, undefined, () => {})).ok).toBe(false);
  expect(calls).toHaveLength(1);
});

test("policy: under the runtime's default gated rules web_search is PROMPT class exactly like web_fetch (fails closed headless, runs with an approver); yolo auto-runs — dispatched through a seam registry so nothing leaves the machine", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-search-rt-"));
  try {
    const rt = createRuntime({ cwd, stream: null });
    const { r, calls } = seamRegistry();
    const headless = rt.buildCfg(false);
    expect(headless.permissionRules).toContainEqual({ action: "net.fetch", resource: "*", effect: "prompt" });
    const closed = await r.dispatch(call("r1"), ctx(), undefined, headless.permissionRules, headless.approval, () => {});
    expect(closed).toEqual({ ok: false, output: "Permission denied by user" }); // execPolicyApprover with no inner approver fails closed
    expect(calls).toEqual([]);
    const seenTools: string[] = [];
    const approver: ApprovalFn = async (req) => { seenTools.push(req.tool); return "once"; };
    const gated = rt.buildCfg(false, approver);
    expect((await r.dispatch(call("r2"), ctx(), undefined, gated.permissionRules, gated.approval, () => {})).ok).toBe(true);
    expect(seenTools).toEqual(["web_search"]);
    const yolo = rt.buildCfg(true);
    expect((await r.dispatch(call("r3"), ctx(), undefined, yolo.permissionRules, yolo.approval, () => {})).ok).toBe(true);
    expect(calls).toHaveLength(2);
    // the runtime's own registration: kind network, parallel-safe (the production tool — never dispatched here)
    const registered = rt.registry.list().find((t) => t.schema.name === "web_search");
    expect(registered?.kind).toBe("network");
    expect(registered?.sequential).toBe(false);
    expect(rt.registry.list().find((t) => t.schema.name === "web_fetch")?.kind).toBe("network");
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

// ---------- the optional key: injected at the registration line, sent as opencode does, never echoed ----------

test("apiKey: a key rides the endpoint URL as opencode's `?exaApiKey=` (encoded) and nowhere else; blank/absent → the bare endpoint; NO output — success, refusal, cross-host redirect, missing Location, non-2xx, same-host hop — ever contains the key (mutation: echo current.href → leaks)", async () => {
  const KEY = "sk-exa-SECRET/+=1";
  const withKey = `${ENDPOINT}?exaApiKey=${encodeURIComponent(KEY)}`;
  const ok = seam(() => sse(blocks(1)), { apiKey: KEY });
  const good = await ok.tool.execute({ query: "q" }, ctx());
  expect(good.ok).toBe(true);
  expect(ok.calls.map((c) => c.url)).toEqual([withKey]);
  expect(String(ok.calls[0]!.init.body)).not.toContain(KEY);           // not in the JSON-RPC body
  expect(JSON.stringify(ok.calls[0]!.init.headers)).not.toContain(KEY); // nor in a header
  const outputs: string[] = [good.output];
  const refused = seam(() => sse(blocks(1)), { apiKey: KEY, resolve: async () => ["10.0.0.5"] });
  outputs.push((await refused.tool.execute({ query: "q" }, ctx())).output);
  expect(outputs[1]).toBe(`web_search: refused ${ENDPOINT}: mcp.exa.ai resolves to 10.0.0.5, a private, loopback, link-local or reserved address`);
  const hop = seam((url) => (url === withKey ? redirect(`https://other.test/mcp?exaApiKey=${encodeURIComponent(KEY)}`, 302) : sse(blocks(1))), { apiKey: KEY, resolve: async () => PUBLIC });
  outputs.push((await hop.tool.execute({ query: "q" }, ctx())).output);
  expect(outputs[2]).toBe("web_search: backend redirected to https://other.test/mcp (other.test is not mcp.exa.ai); not followed");
  const noLoc = seam(() => new Response(null, { status: 302 }), { apiKey: KEY });
  outputs.push((await noLoc.tool.execute({ query: "q" }, ctx())).output);
  expect(outputs[3]).toBe(`web_search: HTTP 302 redirect from ${ENDPOINT} without a Location header`);
  const bad = seam(() => new Response("nope", { status: 500 }), { apiKey: KEY });
  outputs.push((await bad.tool.execute({ query: "q" }, ctx())).output);
  const same = seam((url) => (url === withKey ? redirect("/mcp2", 308) : sse(blocks(1))), { apiKey: KEY });
  const hopped = await same.tool.execute({ query: "q" }, ctx());
  expect(hopped.ok).toBe(true);
  expect(same.calls.map((c) => c.url)).toEqual([withKey, "https://mcp.exa.ai/mcp2"]); // a relative Location drops the query, as in any client
  outputs.push(hopped.output);
  expect(outputs).toHaveLength(6);
  for (const o of outputs) { expect(o).not.toContain(KEY); expect(o).not.toContain(encodeURIComponent(KEY)); expect(o).not.toContain("exaApiKey"); }
  for (const blank of [undefined, "", "   "]) {
    const bare = seam(() => sse(blocks(1)), blank === undefined ? {} : { apiKey: blank });
    expect((await bare.tool.execute({ query: "q" }, ctx())).ok).toBe(true);
    expect(bare.calls.map((c) => c.url)).toEqual([ENDPOINT]);
  }
});

test("apiKey: error text arriving THROUGH a seam is scrubbed before it is echoed — a fetch that rejects with the keyed URL in its message (a wrapped/injected fetch, a proxy) shows the bare endpoint, the bare or URL-encoded key shows `[key]`, a later hop is scrubbed against ITS href, and the resolver, body-stream, non-2xx-body and JSON-RPC-error texts pass the same scrub; keyless it rewrites nothing (mutation: drop the scrub in fail() → the keyed URL leaks)", async () => {
  const KEY = "sk-exa-SECRET/+=1";
  const ENC = encodeURIComponent(KEY);
  const withKey = `${ENDPOINT}?exaApiKey=${ENC}`;
  const outputs: string[] = [];
  const urlInMsg = seam((url) => Promise.reject(new TypeError(`fetch failed: connect ECONNREFUSED ${url}`)), { apiKey: KEY });
  outputs.push((await urlInMsg.tool.execute({ query: "q" }, ctx())).output);
  expect(outputs[0]).toBe(`web_search: request failed: fetch failed: connect ECONNREFUSED ${ENDPOINT}`);
  const keyInMsg = seam(() => Promise.reject(new Error(`proxy refused credential ${KEY} (${ENC})`)), { apiKey: KEY });
  outputs.push((await keyInMsg.tool.execute({ query: "q" }, ctx())).output);
  expect(outputs[1]).toBe("web_search: request failed: proxy refused credential [key] ([key])");
  const nonError = seam(() => Promise.reject(withKey), { apiKey: KEY }); // a non-Error rejection is String()ed, then scrubbed
  outputs.push((await nonError.tool.execute({ query: "q" }, ctx())).output);
  expect(outputs[2]).toBe(`web_search: request failed: ${ENDPOINT}`);
  const hop = seam((url) => (url === withKey ? redirect(`/mcp2?exaApiKey=${ENC}`, 308) : Promise.reject(new Error(`reset by peer: ${url}`))), { apiKey: KEY });
  outputs.push((await hop.tool.execute({ query: "q" }, ctx())).output);
  expect(outputs[3]).toBe("web_search: request failed: reset by peer: https://mcp.exa.ai/mcp2"); // the hop's own href, not only the first
  expect(hop.calls.map((c) => c.url)).toEqual([withKey, `https://mcp.exa.ai/mcp2?exaApiKey=${ENC}`]);
  const resolver = seam(() => sse(blocks(1)), { apiKey: KEY, resolve: async () => { throw new Error(`lookup failed for ${withKey}`); } });
  outputs.push((await resolver.tool.execute({ query: "q" }, ctx())).output);
  expect(outputs[4]).toBe(`web_search: refused ${ENDPOINT}: could not resolve mcp.exa.ai: lookup failed for ${ENDPOINT}`);
  const stream = new ReadableStream<Uint8Array>({ pull(c) { c.error(new Error(`stream reset while reading ${withKey}`)); } });
  const body = seam(() => new Response(stream, { status: 200 }), { apiKey: KEY });
  outputs.push((await within(3000, body.tool.execute({ query: "q" }, ctx()))).output);
  expect(outputs[5]).toBe(`web_search: request failed: stream reset while reading ${ENDPOINT}`);
  const echo = seam(() => new Response(`Cannot POST /mcp?exaApiKey=${ENC} (${KEY})\nsecond line ${KEY}`, { status: 404 }), { apiKey: KEY });
  outputs.push((await echo.tool.execute({ query: "q" }, ctx())).output);
  expect(outputs[6]).toBe("web_search: backend HTTP 404: Cannot POST /mcp?exaApiKey=[key] ([key])");
  const rpcErr = seam(() => json(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: `unauthorized: ${withKey}` } })), { apiKey: KEY });
  outputs.push((await rpcErr.tool.execute({ query: "q" }, ctx())).output);
  expect(outputs[7]).toBe(`web_search: backend error: unauthorized: ${ENDPOINT}`);
  expect(outputs).toHaveLength(8);
  for (const o of outputs) { expect(o).not.toContain(KEY); expect(o).not.toContain(ENC); expect(o).not.toContain("exaApiKey=" + ENC); }
  // keyless: the scrub is inert — the message passes through byte-for-byte (no accidental rewriting)
  const bare = seam(() => Promise.reject(new Error(`boom ${ENDPOINT}?x=1 [key] sk-`)));
  expect((await bare.tool.execute({ query: "q" }, ctx())).output).toBe(`web_search: request failed: boom ${ENDPOINT}?x=1 [key] sk-`);
  // source pin: the fail path echoes ONLY through scrub, and the module still uses the keyed href once (as the request target)
  const src = readFileSync(join(import.meta.dir, "../../src/tools/websearch.ts"), "utf8");
  expect(src).toMatch(/request failed: \$\{scrub\(e instanceof Error \? e\.message : String\(e\), current\)\}/);
  expect(src).not.toMatch(/request failed: \$\{e instanceof Error/);
});

// ---------- the tool never writes files ----------

test("the tool never writes files: across success, non-2xx, malformed, a redirect chain, a refusal and a timeout, the cwd it is handed stays EMPTY (mutation: log the query to <cwd>/web_search.log → fails)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-search-fs-"));
  try {
    let respond: Respond = () => sse(blocks(2));
    const { tool } = seam((u, i) => respond(u, i));
    expect((await tool.execute({ query: "write me down" }, ctx(undefined, cwd))).ok).toBe(true);
    respond = () => new Response("boom", { status: 503 });
    expect((await tool.execute({ query: "q" }, ctx(undefined, cwd))).ok).toBe(false);
    respond = () => new Response("<html>", { status: 200 });
    expect((await tool.execute({ query: "q" }, ctx(undefined, cwd))).ok).toBe(false);
    respond = () => redirect("/mcp?again", 302);
    expect((await tool.execute({ query: "q" }, ctx(undefined, cwd))).output).toContain("too many redirects");
    const priv = seam(() => sse(blocks(1)), { resolve: async () => ["10.0.0.5"] });
    expect((await priv.tool.execute({ query: "q" }, ctx(undefined, cwd))).output).toContain("refused");
    const hang = seam((_u, init) => new Promise<Response>((_, rej) => init.signal!.addEventListener("abort", () => rej(new Error("aborted")), { once: true })), { timeoutMs: 100 });
    expect((await within(3000, hang.tool.execute({ query: "q" }, ctx(undefined, cwd)))).output).toBe("web_search: timed out after 100ms");
    expect(readdirSync(cwd)).toEqual([]);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

// ---------- registration + source pins ----------

test("registration: runtime.ts (createRuntime's tool block) registers createWebSearchTool({ apiKey: process.env.EXA_API_KEY }) on ONE line — the only EXA_API_KEY read anywhere in src; main.ts cmdTools lists webSearchTool and `rovecode help` documents the key; the offline gauntlet runner has neither; websearch.ts: ≤400 lines, no node:fs / Bun.write / process.env / ROVECODE_, URLs echoed only through displayUrl, the SSRF guard IMPORTED from webfetch.ts (not re-implemented), no NUL", () => {
  const srcRoot = join(import.meta.dir, "../../src");
  const read = (rel: string): string => readFileSync(join(srcRoot, rel), "utf8");
  const mainSrc = read("cli/main.ts");
  expect(mainSrc).toMatch(/registry\.register\([^)\n]*\bwebSearchTool\b[^)\n]*\)/); // mutation: drop it → `rovecode tools` loses web_search (cli-wiring pins the listing)
  // The upstream harness imported it statically at the top of main.ts; here that would be a regression,
  // not a port. This file's own header forbids it in as many words — "every command handler lazily
  // imports what it needs so that `rovecode --help` does not pay for the TUI, eval suite, loop, runtime,
  // or plugin scanner" — and webFetchTool sits two lines above under exactly that rule. So the pin is on
  // the import EXISTING in the tools handler, not on its form.
  expect(mainSrc).toContain('const { webSearchTool } = await import("../tools/websearch.ts");');
  expect(mainSrc).not.toMatch(/^import .*websearch\.ts/m); // a static import would put it on the --help path
  expect(read("cli/help.ts")).toMatch(/^\s*EXA_API_KEY\s+optional Exa key for web_search/m); // the env table lives in cli/help.ts next to the ROVECODE_WEBFETCH_* lines
  const bootToolsSrc = read("cli/runtime.ts");
  const keyLines = bootToolsSrc.split("\n").filter((l) => l.includes("EXA_API_KEY"));
  expect(keyLines).toHaveLength(1);
  expect(keyLines[0]).toMatch(/^\s*registry\.register\(webFetchTool, createWebSearchTool\(\{ apiKey: process\.env\.EXA_API_KEY \}\)\); \/\/ port #31 web_fetch \+ #56 web_search/);
  expect(bootToolsSrc).toContain('import { createWebSearchTool } from "../tools/websearch.ts";');
  const readers = (readdirSync(srcRoot, { recursive: true }) as string[])
    .map((p) => p.replace(/\\/g, "/"))
    .filter((p) => p.endsWith(".ts") && read(p).includes("process.env.EXA_API_KEY"));
  expect(readers).toEqual(["cli/runtime.ts"]);
  const gauntletSrc = read("eval/gauntlet-runner.ts");
  for (const s of ["webSearchTool", "createWebSearchTool", "web_search", "websearch"]) expect(gauntletSrc).not.toContain(s);
  const src = read("tools/websearch.ts");
  expect(src.split("\n").length).toBeLessThanOrEqual(400); // ADR-002
  expect(src).not.toMatch(/from "node:fs|from "fs"|require\(/);
  expect(src).not.toMatch(/\bBun\.write\b|writeFile|appendFile|mkdir|createWriteStream/);
  expect(src).not.toContain("process.env");
  expect(src).not.toContain("ROVECODE_");
  // the full URL (query = key) is used ONCE — as the request target; every URL echoed into an output goes through displayUrl
  expect(src.split("\n").filter((l) => l.includes("current.href"))).toEqual(["          res = await fetchImpl(current.href, {"]);
  expect(src).toMatch(/import \{[^}]*\bssrfDenyReason\b[^}]*\} from "\.\/webfetch\.ts";/);
  expect(src).toMatch(/await abortable\(ssrfDenyReason\(current\.hostname, resolve\), ac\.signal\)/);
  expect(src).not.toContain(String.fromCharCode(0));
  expect(src.startsWith("/** web_search tool (PORT #56)")).toBe(true);
  expect(src).toContain("opencode (MIT, snapshot ebece6e");
  // the header states the request-shape deviation truthfully (fixer f56): contextMaxCharacters is always sent, opencode omits it
  expect(src).toContain("contextMaxCharacters is ALWAYS sent as\n *  max(10000, n*1500) — opencode omits the key unless the model passes one");
  expect(src).not.toContain("livecrawl/type/context args are dropped (fixed to opencode's defaults)");
  for (const rel of ["tools/websearch.ts", "../test/fixtures/websearch.ts", "../test/fixtures/websearch-seam.ts", "../test/unit/websearch.test.ts", "../test/unit/websearch-guard.test.ts"]) {
    const text = read(rel);
    expect([rel, text.split("\n").length <= 400]).toEqual([rel, true]);
    expect([rel, text.includes(String.fromCharCode(0))]).toEqual([rel, false]);
  }
});
