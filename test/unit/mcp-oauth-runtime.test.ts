/** Port #76 — the runtime half over the fake resource + authorization server (test/helpers/mcp-oauth-fixtures.ts), streamable
 *  HTTP wire, scratch ROVECODE_HOME: nothing stored → connect().failed carries the token-free remedy, the /mcp row keeps it
 *  unclipped, mcp_call output carries it, and /register + /token + /authorize + .well-known all stay 0; a stored record →
 *  connected with `Authorization: Bearer <canary>` on every request and no discovery or token traffic; a revoked token → ONE
 *  `grant_type=refresh_token`, the new tokens persisted BEFORE the retried request, connected, a second manager reuses them;
 *  invalid_grant → remedy, tokens cleared, client + discovery kept, /register 0; invalid_client (the SDK's invalidate-all
 *  retry) → remedy and STILL /register 0; a server_error refresh → remedy; a refresh answer without a refresh_token keeps
 *  the old one; a record for another url is no record (no bearer leaves the process). The sibling -2 file covers static
 *  headers, the sse wire, the circuit breaker, the chat seam and the provider class. */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { statSync } from "node:fs";
import type { ToolContext } from "../../src/core/types.ts";
import { McpManager } from "../../src/mcp/client.ts";
import type { McpServerConfig } from "../../src/mcp/config.ts";
import { needsLoginText, saveMcpOAuth, type McpOAuthRecord } from "../../src/mcp/oauth.ts";
import { formatMcpStatus } from "../../src/mcp/status.ts";
import { createMcpTools } from "../../src/mcp/tools.ts";
import { credentialsPath, readEntry } from "../../src/providers/auth.ts";
import { deadline, startMcpOAuthFixture, type McpOAuthFixture } from "../helpers/mcp-oauth-fixtures.ts";
import { scratchDirs } from "../helpers/scratch.ts";

const scratch = scratchDirs();
const savedEnv = new Map<string, string | undefined>();
let fx: McpOAuthFixture;
const managers: McpManager[] = [];
beforeEach(() => {
  for (const k of ["ROVECODE_HOME"]) { savedEnv.set(k, process.env[k]); delete process.env[k]; }
  process.env.ROVECODE_HOME = scratch("rovecode-mcp-oauth-rt-");
  fx = startMcpOAuthFixture();
});
afterEach(async () => {
  for (const m of managers.splice(0)) await m.close();
  fx.stop();
  for (const [k, v] of savedEnv) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

const REMEDY = "needs login — run `rovecode mcp login fx`";
const ctx = (): ToolContext => ({ sessionId: "test", cwd: process.cwd(), signal: new AbortController().signal, permissions: { effect: "allow" } });

/** a record as a login would have written it — the fixture's current tokens, a registered client, the stored discovery */
function seedRecord(over: Partial<McpOAuthRecord> = {}): McpOAuthRecord {
  const rec: McpOAuthRecord = {
    type: "mcp-oauth", url: fx.mcpUrl, access: fx.access, refresh: fx.refresh, expires: Date.now() + 3_600_000,
    clientInformation: { client_id: "dcr-seeded" }, discovery: fx.discoveryState(), ...over,
  };
  saveMcpOAuth("fx", rec);
  return rec;
}
function manager(config: Partial<McpServerConfig> = {}): McpManager {
  const m = new McpManager([{ name: "fx", transport: "http", url: fx.mcpUrl, ...config }], { connectTimeoutMs: 5_000 });
  managers.push(m);
  return m;
}
const connect = (m: McpManager) => deadline(m.connect(), 15_000, "connect");
const mcpPosts = () => fx.seen.filter((s) => s.path === "/mcp" && s.method === "POST");
const stored = () => readEntry("mcp:fx") as McpOAuthRecord;

test("nothing stored: connect().failed is the token-free remedy (≤ 80 chars), the /mcp row keeps it unclipped, mcp_call carries it; no registration, token, authorize or discovery request was made", async () => {
  const m = manager();
  const res = await connect(m);
  expect(res.connected).toEqual([]);
  expect(res.failed).toEqual([{ name: "fx", error: REMEDY }]);
  expect(REMEDY.length).toBeLessThanOrEqual(80);
  expect(needsLoginText("a".repeat(20)).length).toBeLessThanOrEqual(80);
  expect(fx.count("/register") + fx.count("/token") + fx.count("/authorize") + fx.count(".well-known")).toBe(0);
  expect(mcpPosts().every((s) => s.auth === null)).toBe(true);
  const status = formatMcpStatus(m, "/p");
  expect(status).toContain(`fx  failed (http): ${REMEDY}`);
  expect(status).not.toContain("…");
  expect(m.status()[0]).toMatchObject({ name: "fx", state: "failed", error: REMEDY });
  const call = createMcpTools(m).find((t) => t.schema.name === "mcp_call")!;
  const out = await call.execute({ server: "fx", tool: "ping" }, ctx());
  expect(out.ok).toBe(false);
  expect(out.output).toContain(REMEDY);
}, 20_000);

test("stored record for this url: connected over http, `Authorization: Bearer <access>` on every request, a tool call works; /token, .well-known and /register stay 0 (discovery is stored)", async () => {
  seedRecord();
  const m = manager();
  const res = await connect(m);
  expect(res.failed).toEqual([]);
  expect(res.connected).toEqual(["fx"]);
  expect(m.status()[0]).toMatchObject({ state: "connected", wire: "http" });
  expect(await deadline(m.callTool("fx", "ping", {}), 5_000, "call")).toEqual({ ok: true, output: "pong" });
  const posts = mcpPosts();
  expect(posts.length).toBeGreaterThan(1);
  expect(posts.every((s) => s.auth === `Bearer ${fx.access}`)).toBe(true);
  expect(fx.seen.filter((s) => s.path === "/mcp" && s.method === "GET").every((s) => s.auth === `Bearer ${fx.access}`)).toBe(true);
  expect(fx.count("/token")).toBe(0);
  expect(fx.count(".well-known")).toBe(0);
  expect(fx.count("/register")).toBe(0);
  expect(fx.count("/authorize")).toBe(0);
}, 20_000);

test("revoked/expired token: the 401 triggers exactly ONE refresh_token grant (client_id, the stored refresh), the new tokens are persisted BEFORE the retried request, the connect succeeds; a second manager reuses them (/token still 1)", async () => {
  const rec = seedRecord();
  const old = fx.access;
  fx.revoke();
  const storeAtRetry: string[] = [];
  fx.hooks.onAuthorized = () => { storeAtRetry.push(stored().access); };
  const m = manager();
  const res = await connect(m);
  expect(res.failed).toEqual([]);
  expect(res.connected).toEqual(["fx"]);
  expect(fx.count("/token")).toBe(1);
  expect(fx.tokenRequests[0]).toMatchObject({ grant_type: "refresh_token", refresh_token: rec.refresh, client_id: "dcr-seeded" });
  expect(fx.access).not.toBe(old);
  const s = stored();
  expect(s).toMatchObject({ type: "mcp-oauth", url: fx.mcpUrl, access: fx.access, refresh: fx.refresh, clientInformation: { client_id: "dcr-seeded" } });
  expect(s.expires).toBeGreaterThan(Date.now());
  expect(s.discovery?.authorizationServerUrl).toBe(fx.base);
  // MUTATION TARGET m4 (skip persistence in saveTokens): the store still holds the old token when the retried request lands
  expect(storeAtRetry[0]).toBe(fx.access);
  expect(mcpPosts().filter((s) => s.auth === `Bearer ${old}`)).toHaveLength(1); // the one rejected attempt
  expect(mcpPosts().filter((s) => s.auth === `Bearer ${fx.access}`).length).toBeGreaterThan(0);
  expect(fx.count(".well-known")).toBe(0);
  expect(fx.count("/register")).toBe(0);
  expect(fx.count("/authorize")).toBe(0);
  await m.close();
  const m2 = manager();
  expect((await connect(m2)).failed).toEqual([]);
  expect(fx.count("/token")).toBe(1); // MUTATION TARGET m4 again: an unpersisted refresh would refresh here a second time
}, 20_000);

test.skipIf(process.platform === "win32")("0600 on POSIX after the refresh REWRITE of the store (skipped on win32 — mode bits only drive the read-only attribute there)", async () => {
  seedRecord();
  fx.revoke();
  expect((await connect(manager())).failed).toEqual([]);
  expect(fx.count("/token")).toBe(1);
  expect(statSync(credentialsPath()).mode & 0o777).toBe(0o600);
}, 20_000);

test("invalid_grant on the refresh: the remedy, tokens cleared (client + discovery + url kept), no registration, no authorize, no discovery, no second /token", async () => {
  seedRecord();
  fx.revoke();
  fx.knobs.failRefresh = "invalid_grant";
  const m = manager();
  const res = await connect(m);
  expect(res.failed).toEqual([{ name: "fx", error: REMEDY }]);
  expect(fx.count("/token")).toBe(1);
  expect(fx.count("/register")).toBe(0);
  expect(fx.count("/authorize")).toBe(0);
  expect(fx.count(".well-known")).toBe(0);
  const s = stored();
  expect(s).toMatchObject({ type: "mcp-oauth", url: fx.mcpUrl, access: "", refresh: "", clientInformation: { client_id: "dcr-seeded" } });
  expect(s.discovery?.authorizationServerUrl).toBe(fx.base);
  expect(formatMcpStatus(m, "/p")).toContain(`fx  failed (http): ${REMEDY}`);
  // a tokenless record: the next connect is the remedy again with no traffic beyond the 401
  const m2 = manager();
  expect((await connect(m2)).failed).toEqual([{ name: "fx", error: REMEDY }]);
  expect(fx.count("/token")).toBe(1);
  expect(fx.count("/register")).toBe(0);
}, 20_000);

test("invalid_client on the refresh (the SDK invalidates ALL credentials and retries with a fresh discovery): the remedy and STILL no registration — clientInformation() refuses before the SDK's registerClient", async () => {
  seedRecord();
  fx.revoke();
  fx.knobs.failRefresh = "invalid_client";
  const res = await connect(manager());
  expect(res.failed).toEqual([{ name: "fx", error: REMEDY }]);
  // MUTATION TARGET m7 (a runtime clientInformation() that returns undefined + a persisting saveClientInformation): the
  // retry after invalidateCredentials('all') registers a new client here → /register 1 and a client_id in the store
  expect(fx.count("/register")).toBe(0);
  expect(fx.count("/authorize")).toBe(0);
  expect(fx.count("/token")).toBe(1);
  expect(fx.count(".well-known")).toBeGreaterThan(0); // 'all' dropped the stored discovery, so the SDK's retry re-discovered (public metadata)
  const s = stored();
  expect(s.access).toBe("");
  expect(s.refresh).toBe("");
  expect(s.clientInformation).toBeUndefined(); // the client was dropped and NOT re-registered
  expect(s.discovery?.authorizationServerUrl).toBe(fx.base); // the SDK re-saved what it re-discovered
  expect(s.url).toBe(fx.mcpUrl);
}, 20_000);

test("a server_error (500) on the refresh: the SDK gives up on the refresh, the runtime provider refuses the browser step → the remedy; /token 1, nothing registered", async () => {
  seedRecord();
  fx.revoke();
  fx.knobs.failRefresh = "server_error";
  const res = await connect(manager());
  expect(res.failed).toEqual([{ name: "fx", error: REMEDY }]);
  expect(fx.count("/token")).toBe(1);
  expect(fx.count("/register")).toBe(0);
  expect(fx.count("/authorize")).toBe(0);
}, 20_000);

test("a refresh answer without a refresh_token keeps the OLD refresh token in the store (the new access is persisted)", async () => {
  const rec = seedRecord();
  fx.revoke();
  fx.knobs.omitRefreshOnRefresh = true;
  expect((await connect(manager())).failed).toEqual([]);
  expect(fx.count("/token")).toBe(1);
  const s = stored();
  expect(s.access).toBe(fx.access);
  expect(s.access).not.toBe(rec.access);
  expect(s.refresh).toBe(rec.refresh);
}, 20_000);

test("a record bound to ANOTHER url is treated as no record: the remedy, and no bearer ever left the process for this server; a malformed record is skipped the same way", async () => {
  seedRecord({ url: `${fx.base}/other` });
  const res = await connect(manager());
  // MUTATION TARGET m3 (skip the url binding check): the other url's token would ride the /mcp requests
  expect(res.failed).toEqual([{ name: "fx", error: REMEDY }]);
  expect(mcpPosts().every((s) => s.auth === null)).toBe(true);
  expect(fx.count("/token")).toBe(0);
  seedRecord({ expires: Number.NaN } as Partial<McpOAuthRecord>);
  expect((await connect(manager())).failed).toEqual([{ name: "fx", error: REMEDY }]);
  expect(mcpPosts().every((s) => s.auth === null)).toBe(true);
}, 20_000);
