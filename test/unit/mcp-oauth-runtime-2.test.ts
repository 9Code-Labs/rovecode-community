/** Port #76 — runtime half, sibling of mcp-oauth-runtime.test.ts (factories, no shared rig): a static `headers.Authorization`
 *  wins over a stored token (no provider, no /token) and a rejected static header names the header rather than a login;
 *  stdio never gets a provider; the legacy SSE wire connects with the bearer on the GET stream and every POST and refreshes
 *  ONCE through the same seam; a 401 AFTER a completed refresh is the remedy with /token capped at 1 on BOTH wires (the SDK's
 *  circuit breaker on http, the provider's one-refresh cap on sse); the chat seam never resolves an `mcp:*` record and
 *  `auth list` / `auth remove` handle it; the provider class on its own: redirectToAuthorization, saveClientInformation,
 *  codeVerifier and an unknown client all throw McpNeedsLoginError (never a URL, never a port), tokens() is
 *  `token_type: "Bearer"` with the refresh token offered ONCE, invalidateCredentials is field-level; describeError's mapping. */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { SseError } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { expiryText, formatAuthList } from "../../src/cli/auth-login.ts";
import { McpManager } from "../../src/mcp/client.ts";
import type { McpServerConfig } from "../../src/mcp/config.ts";
import { McpNeedsLoginError, McpRuntimeAuthProvider, loadMcpOAuth, needsLoginText, runtimeAuthProvider, saveMcpOAuth, type McpOAuthRecord } from "../../src/mcp/oauth.ts";
import { describeError } from "../../src/mcp/transport.ts";
import { isMcpOAuthRecord, listProviders, readEntry, removeCredential } from "../../src/providers/auth.ts";
import { resolveOAuthProviderConfig } from "../../src/providers/oauth/seam.ts";
import { deadline, startMcpOAuthFixture, type McpOAuthFixture } from "../helpers/mcp-oauth-fixtures.ts";
import { scratchDirs } from "../helpers/scratch.ts";

const scratch = scratchDirs();
const savedEnv = new Map<string, string | undefined>();
let fx: McpOAuthFixture;
const managers: McpManager[] = [];
beforeEach(() => {
  for (const k of ["ROVECODE_HOME"]) { savedEnv.set(k, process.env[k]); delete process.env[k]; }
  process.env.ROVECODE_HOME = scratch("rovecode-mcp-oauth-rt2-");
  fx = startMcpOAuthFixture();
});
afterEach(async () => {
  for (const m of managers.splice(0)) await m.close();
  fx.stop();
  for (const [k, v] of savedEnv) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

const REMEDY = "needs login — run `rovecode mcp login fx`";
function seedRecord(over: Partial<McpOAuthRecord> = {}): McpOAuthRecord {
  const rec: McpOAuthRecord = {
    type: "mcp-oauth", url: fx.mcpUrl, access: fx.access, refresh: fx.refresh, expires: Date.now() + 3_600_000,
    clientInformation: { client_id: "dcr-seeded" }, discovery: fx.discoveryState(over.url === fx.sseUrl ? "/sse" : "/mcp"), ...over,
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
const config = (over: Partial<McpServerConfig> = {}): McpServerConfig => ({ name: "fx", transport: "http", url: fx.mcpUrl, ...over });

test("a static headers.Authorization WINS over a stored token: no provider is attached, every request carries the static header, /token stays 0; a rejected static header reads as a header problem, not a login", async () => {
  fx.acceptToken("static-CANARY-bearer");
  seedRecord();
  expect(runtimeAuthProvider(config({ headers: { Authorization: "Bearer static-CANARY-bearer" } }))).toBeUndefined();
  expect(runtimeAuthProvider(config({ headers: { authorization: "x" } }))).toBeUndefined(); // any case
  const m = manager({ headers: { Authorization: "Bearer static-CANARY-bearer" } });
  const res = await connect(m);
  expect(res.failed).toEqual([]);
  const posts = fx.seen.filter((s) => s.path === "/mcp" && s.method === "POST");
  expect(posts.length).toBeGreaterThan(0);
  // MUTATION TARGET m6 (let the stored token override the static header): the stored canary shows up here
  expect(posts.every((s) => s.auth === "Bearer static-CANARY-bearer")).toBe(true);
  expect(fx.count("/token")).toBe(0);
  await m.close();
  const bad = manager({ headers: { Authorization: "Bearer wrong" } });
  expect((await connect(bad)).failed).toEqual([{ name: "fx", error: "HTTP 401 — the configured Authorization header was rejected" }]);
  expect(fx.count("/token")).toBe(0);
}, 20_000);

test("stdio servers never get a provider, even with a stored record", () => {
  seedRecord();
  expect(runtimeAuthProvider({ name: "fx", transport: "stdio", command: "bun" })).toBeUndefined();
  expect(runtimeAuthProvider(config())).toBeInstanceOf(McpRuntimeAuthProvider);
});

test("legacy SSE wire: a stored record connects with the bearer on the GET stream and every POST; a revoked token refreshes ONCE through the same seam and connects", async () => {
  seedRecord({ url: fx.sseUrl });
  const m = manager({ transport: "sse", url: fx.sseUrl });
  expect((await connect(m)).failed).toEqual([]);
  expect(await deadline(m.callTool("fx", "ping", {}), 5_000, "call")).toEqual({ ok: true, output: "pong" });
  const gets = fx.seen.filter((s) => s.path === "/sse");
  const posts = fx.seen.filter((s) => s.path === "/messages");
  expect(gets.length).toBeGreaterThan(0);
  expect(posts.length).toBeGreaterThan(0);
  expect(gets.every((s) => s.auth === `Bearer ${fx.access}`)).toBe(true);
  expect(posts.every((s) => s.auth === `Bearer ${fx.access}`)).toBe(true);
  expect(fx.count("/token")).toBe(0);
  expect(m.status()[0]).toMatchObject({ state: "connected", wire: "sse" });
  await m.close();
  fx.revoke();
  const old = fx.access;
  const m2 = manager({ transport: "sse", url: fx.sseUrl });
  expect((await connect(m2)).failed).toEqual([]);
  expect(fx.count("/token")).toBe(1);
  expect(fx.tokenRequests[0]?.grant_type).toBe("refresh_token");
  expect((readEntry("mcp:fx") as McpOAuthRecord).access).toBe(fx.access);
  expect(fx.access).not.toBe(old);
  expect(fx.seen.filter((s) => s.path === "/messages").every((s) => s.auth === `Bearer ${fx.access}` || s.auth === `Bearer ${old}`)).toBe(true);
}, 30_000);

test("a 401 AFTER a completed refresh fails the connect with the remedy and /token stays 1 — http (the SDK's circuit breaker) and sse (the provider's one-refresh cap)", async () => {
  seedRecord();
  fx.revoke();
  fx.knobs.revokeAfterRefresh = true;
  expect((await connect(manager())).failed).toEqual([{ name: "fx", error: REMEDY }]);
  expect(fx.count("/token")).toBe(1);
  expect(fx.count("/register")).toBe(0);
  fx.tokenRequests.length = 0;
  fx.counts["/token"] = 0;
  seedRecord({ url: fx.sseUrl, access: fx.access, refresh: fx.refresh });
  fx.revoke();
  expect((await connect(manager({ transport: "sse", url: fx.sseUrl }))).failed).toEqual([{ name: "fx", error: REMEDY }]);
  expect(fx.count("/token")).toBe(1); // MUTATION TARGET (drop the one-refresh cap in tokens()): sse.js retries the POST forever, /token climbs
  expect(fx.count("/register")).toBe(0);
}, 30_000);

test("the chat seam never resolves an mcp:* record (m9); `auth list` shows `mcp:fx  oauth  mcp server token  …  expires …`; `auth remove mcp:fx` deletes it", () => {
  const rec = seedRecord();
  expect(resolveOAuthProviderConfig()).toBeNull();
  expect(listProviders()).toEqual([{ provider: "mcp:fx", kind: "oauth", keyName: "mcp server token", redacted: "mcp-…", expires: rec.expires }]);
  expect(formatAuthList()).toEqual([`${"mcp:fx".padEnd(14)} ${"oauth".padEnd(6)} ${"mcp server token".padEnd(24)} mcp-…  ${expiryText(rec.expires)}`]);
  expect(formatAuthList().join("\n")).not.toContain(rec.access);
  expect(removeCredential("mcp:fx")).toBe(true);
  expect(readEntry("mcp:fx")).toBeUndefined();
  expect(loadMcpOAuth("fx", fx.mcpUrl)).toBeUndefined();
});

test("the record validator: url binding, empty access allowed (invalidated), expires must be finite and inside Date's range, clientInformation needs a client_id, discovery must be an object", () => {
  const rec = seedRecord();
  expect(loadMcpOAuth("fx", fx.mcpUrl)).toEqual(rec);
  expect(loadMcpOAuth("fx", `${fx.base}/other`)).toBeUndefined();
  expect(loadMcpOAuth("fx", undefined)).toBeUndefined();
  expect(loadMcpOAuth("nope", fx.mcpUrl)).toBeUndefined();
  expect(isMcpOAuthRecord({ ...rec, access: "" })).toBe(true);
  expect(isMcpOAuthRecord({ ...rec, expires: 9e15 })).toBe(false);
  expect(isMcpOAuthRecord({ ...rec, expires: Number.MAX_SAFE_INTEGER })).toBe(true);
  expect(isMcpOAuthRecord({ ...rec, expires: "soon" })).toBe(false);
  expect(isMcpOAuthRecord({ ...rec, url: "" })).toBe(false);
  expect(isMcpOAuthRecord({ ...rec, type: "oauth" })).toBe(false);
  expect(isMcpOAuthRecord({ ...rec, clientInformation: {} })).toBe(false);
  expect(isMcpOAuthRecord({ ...rec, discovery: [] })).toBe(false);
  expect(isMcpOAuthRecord({ ...rec, clientInformation: undefined, discovery: undefined })).toBe(true);
});

test("the runtime provider on its own: redirectToAuthorization / saveClientInformation / codeVerifier / an unknown client THROW McpNeedsLoginError (no URL printed, no port); tokens() is Bearer + the refresh token offered ONCE; invalidateCredentials is field-level and url always stays", async () => {
  const rec = seedRecord();
  const p = new McpRuntimeAuthProvider(config(), rec, () => rec.expires - 600_000);
  // MUTATION TARGET m2 (print the URL / open a port instead of throwing): these expectations fail
  expect(() => p.redirectToAuthorization()).toThrow(McpNeedsLoginError);
  expect(() => p.redirectToAuthorization()).toThrow(REMEDY);
  expect(() => p.saveClientInformation()).toThrow(McpNeedsLoginError);
  expect(() => p.codeVerifier()).toThrow(McpNeedsLoginError);
  expect(p.saveCodeVerifier()).toBeUndefined();
  expect(p.redirectUrl).toBeTruthy();
  expect(p.clientMetadata).toMatchObject({ client_name: "rovecode", token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"] });
  expect(p.clientInformation()).toEqual({ client_id: "dcr-seeded" });
  expect(new McpRuntimeAuthProvider(config({ oauth: { clientId: "cfg-client" } }), rec).clientInformation()).toEqual({ client_id: "cfg-client" });
  const unknown = new McpRuntimeAuthProvider(config(), { ...rec, clientInformation: undefined });
  expect(() => unknown.clientInformation()).toThrow(McpNeedsLoginError);
  expect(p.discoveryState()).toEqual(rec.discovery as never);
  expect(p.tokens()).toEqual({ access_token: rec.access, token_type: "Bearer", refresh_token: rec.refresh, expires_in: 600 });
  p.saveTokens({ access_token: "mcp-access-CANARY-new", token_type: "Bearer", expires_in: 60 });
  const after = readEntry("mcp:fx") as McpOAuthRecord;
  expect(after).toMatchObject({ access: "mcp-access-CANARY-new", refresh: rec.refresh, url: fx.mcpUrl, clientInformation: { client_id: "dcr-seeded" } });
  expect(after.expires).toBe(rec.expires - 600_000 + 60_000);
  expect(p.tokens()).toEqual({ access_token: "mcp-access-CANARY-new", token_type: "Bearer", expires_in: 60 }); // the refresh token is offered once per connect
  p.invalidateCredentials("tokens");
  expect(readEntry("mcp:fx")).toMatchObject({ access: "", refresh: "", expires: 0, url: fx.mcpUrl, clientInformation: { client_id: "dcr-seeded" } });
  expect(p.tokens()).toBeUndefined();
  p.invalidateCredentials("all");
  const bare = readEntry("mcp:fx") as McpOAuthRecord;
  expect(bare.url).toBe(fx.mcpUrl);
  expect(bare.clientInformation).toBeUndefined();
  expect(bare.discovery).toBeUndefined();
  expect(isMcpOAuthRecord(bare)).toBe(true);
  // saveTokens without expires_in → never expires; a missing refresh keeps the old one
  const q = new McpRuntimeAuthProvider(config(), { ...rec, refresh: "keep-me" });
  q.saveTokens({ access_token: "a", token_type: "Bearer" });
  expect(readEntry("mcp:fx")).toMatchObject({ access: "a", refresh: "keep-me", expires: Number.MAX_SAFE_INTEGER });
});

test("describeError: a 401 on either url wire, the SDK's UnauthorizedError and McpNeedsLoginError all read as the remedy; a static header's 401 names the header; other codes keep the (HTTP n) suffix; the text is never clipped for names ≤ 20 chars", () => {
  const c = config();
  expect(describeError(new StreamableHTTPError(401, "Error POSTing to endpoint: nope"), c)).toBe(REMEDY);
  expect(describeError(new StreamableHTTPError(401, "Server returned 401 after successful authentication"), c)).toBe(REMEDY);
  expect(describeError(new SseError(401, "Unauthorized", {} as never), c)).toBe(REMEDY);
  expect(describeError(new Error("Error POSTing to endpoint (HTTP 401): nope"), c)).toBe(REMEDY);
  expect(describeError(new UnauthorizedError(), c)).toBe(REMEDY);
  expect(describeError(new McpNeedsLoginError("fx"), c)).toBe(REMEDY);
  expect(describeError(new StreamableHTTPError(401, "nope"), config({ headers: { Authorization: "Bearer x" } }))).toBe("HTTP 401 — the configured Authorization header was rejected");
  expect(describeError(new StreamableHTTPError(500, "Error POSTing to endpoint: nope"), c)).toBe("Streamable HTTP error: Error POSTing to endpoint: nope (HTTP 500)");
  expect(describeError(new Error("plain"), c)).toBe("plain");
  expect(needsLoginText("twenty-characters-xx")).toHaveLength(80 - (80 - needsLoginText("twenty-characters-xx").length));
  expect(needsLoginText("twenty-characters-xx").length).toBeLessThanOrEqual(80);
});
