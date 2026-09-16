/** Port #76 — `rovecode mcp login <name>` in-process (cli/mcp-login.ts runMcpLogin) against the ONE fake resource +
 *  authorization server (test/helpers/mcp-oauth-fixtures.ts), scratch ROVECODE_HOME, the test playing the browser: the probe's
 *  401 seeds resource_metadata + scope, discovery and dynamic registration (token_endpoint_auth_method none, redirect_uris =
 *  the BOUND callback — bound first) produce the PKCE authorize URL (client_id, redirect_uri, state = the path nonce, S256
 *  challenge) printed as the #66 notice; /token sees a verifier hashing to the challenge plus redirect_uri and client_id; the
 *  record lands under mcp:<name> (type mcp-oauth, url, access, refresh, expires, clientInformation, discovery; 0600 on
 *  POSIX); the verification connect is authorized initialize traffic only — /token stays 1, no further .well-known; `auth list`
 *  shows the row, `auth remove` deletes it, the chat seam never picks it; canaries (tokens, code, verifier) never reach a line.
 *  Negatives: wrong ?state / wrong path → 400 + exit 1 + /token 0; a second GET → 409; ?error → 1; abort → 130 + port closed;
 *  not-401 → 1; unknown / stdio / disabled → 1 (one line); unparsable project file → 2; a ServerError body is never echoed. */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expiryText, formatAuthList } from "../../src/cli/auth-login.ts";
import { MCP_LOGIN_USAGE, runMcpLogin, type McpLoginDeps } from "../../src/cli/mcp-login.ts";
import { trustMcpFile } from "../../src/mcp/trust.ts";
import { mcpConfigPath } from "../../src/mcp/config.ts";
import type { McpOAuthRecord } from "../../src/mcp/oauth.ts";
import { credentialsPath, readEntry, removeCredential, rovecodeHome } from "../../src/providers/auth.ts";
import { resolveOAuthProviderConfig } from "../../src/providers/oauth/seam.ts";
import { ACCESS_PREFIX, REFRESH_PREFIX, SCOPE, deadline, s256, startMcpOAuthFixture, type McpOAuthFixture } from "../helpers/mcp-oauth-fixtures.ts";
import { scratchDirs } from "../helpers/scratch.ts";

const scratch = scratchDirs();
const savedEnv = new Map<string, string | undefined>();
let cwd = "";
let fx: McpOAuthFixture;
beforeEach(() => {
  for (const k of ["ROVECODE_HOME"]) { savedEnv.set(k, process.env[k]); delete process.env[k]; }
  process.env.ROVECODE_HOME = scratch("rovecode-mcp-oauth-home-");
  cwd = scratch("rovecode-mcp-oauth-cwd-");
  fx = startMcpOAuthFixture();
});
afterEach(() => {
  fx.stop();
  for (const [k, v] of savedEnv) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

/** the project file, APPROVED in this test's scratch home the way `rovecode mcp trust` would (mcp/trust.ts) — the
 *  login reads config through the runtime's trust gate, so an unapproved file is invisible to it (pinned below) */
function writeProject(servers: Record<string, unknown>, trusted = true): void {
  const p = mcpConfigPath(cwd);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ mcpServers: servers }));
  if (trusted) { const r = trustMcpFile(rovecodeHome(), p); if (!r.ok) throw new Error(r.reason); }
}
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
const oauthDeps = () => ({ fetch: (i: string | URL, init?: RequestInit) => fetch(i, init), now: () => Date.now(), sleep: async () => {} });
async function expectClosed(url: string): Promise<void> {
  await expect(deadline(fetch(url), 10_000, "closed port")).rejects.toThrow();
}

/** start a login and hand back the authorize URL once the `open …` notice is printed */
function startLogin(name = "fx", extra: Partial<McpLoginDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const opened = deferred<URL>();
  const code = runMcpLogin(name, cwd, {
    out: (l) => { out.push(l); const m = /^\s+open\s+(\S+)$/.exec(l); if (m) opened.resolve(new URL(m[1]!)); },
    err: (l) => err.push(l), oauth: oauthDeps(), connectTimeoutMs: 5_000, ...extra,
  });
  code.catch(() => {});
  return { out, err, code, authorize: deadline(opened.promise, 10_000, "authorize URL notice") };
}
/** the browser: a code bound to the authorize URL's PKCE binding, landing on the redirect with ?code&state */
async function browse(authorize: URL, o: { state?: string; path?: string } = {}) {
  const redirect = authorize.searchParams.get("redirect_uri")!;
  const code = fx.mintCode({ challenge: authorize.searchParams.get("code_challenge")!, redirectUri: redirect, clientId: authorize.searchParams.get("client_id")! });
  const target = new URL(o.path ?? redirect);
  target.searchParams.set("code", code);
  target.searchParams.set("state", o.state ?? authorize.searchParams.get("state")!);
  return { code, target, res: await deadline(fetch(target), 10_000, "callback GET") };
}
async function completeLogin() {
  writeProject({ fx: { url: fx.mcpUrl } });
  const login = startLogin();
  const authorize = await login.authorize;
  const wellKnownAtNotice = fx.count(".well-known");
  const browsed = await browse(authorize);
  const exit = await deadline(login.code, 20_000, "login exit");
  return { ...login, authorize, ...browsed, exit, wellKnownAtNotice };
}

test("happy path: probe 401 → discovery + fresh registration bound to the loopback callback → PKCE authorize URL printed (client_id, redirect_uri = the bound callback, state = the path nonce, S256, scope from WWW-Authenticate) → the browser's code is exchanged with the matching verifier → record under mcp:fx → verification connect → final line; canaries never printed; auth list / remove / chat seam", async () => {
  const l = await completeLogin();
  expect(l.out[0]).toBe(`rovecode mcp login fx — http ${fx.mcpUrl}`);
  const redirect = l.authorize.searchParams.get("redirect_uri")!;
  expect(redirect).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback\/[A-Za-z0-9_-]{43}$/);
  expect(l.out.join("\n")).toContain(`waiting for the browser to return to ${redirect}`);
  expect(l.authorize.origin + l.authorize.pathname).toBe(`${fx.base}/authorize`);
  expect(l.authorize.searchParams.get("response_type")).toBe("code");
  expect(l.authorize.searchParams.get("code_challenge_method")).toBe("S256");
  expect(l.authorize.searchParams.get("state")).toBe(redirect.slice(redirect.lastIndexOf("/") + 1)); // state == the path nonce
  expect(l.authorize.searchParams.get("client_id")).toBe("dcr-1");
  expect(l.authorize.searchParams.get("scope")).toBe(SCOPE);
  // registration happened AFTER the bind: the redirect it registered is the bound callback; a public client, no secret
  expect(fx.count("/register")).toBe(1);
  expect(fx.registrations[0]).toMatchObject({ client_name: "rovecode", redirect_uris: [redirect], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] });
  expect(fx.registrations[0]).not.toHaveProperty("client_secret");
  expect(l.wellKnownAtNotice).toBeGreaterThan(0);
  expect(fx.count("/authorize")).toBe(0); // the test played the browser
  // the browser landed: 200 page, exit 0, nothing on stderr
  expect(l.res.status).toBe(200);
  expect(await l.res.text()).toContain('Signed in to MCP server "fx"');
  expect(l.exit).toBe(0);
  expect(l.err).toEqual([]);
  // /token: ONE authorization_code grant carrying the verifier behind the advertised challenge, redirect_uri, client_id
  expect(fx.count("/token")).toBe(1);
  const t = fx.tokenRequests[0]!;
  expect(t).toMatchObject({ grant_type: "authorization_code", code: l.code, redirect_uri: redirect, client_id: "dcr-1" });
  expect(await s256(t.code_verifier!)).toBe(l.authorize.searchParams.get("code_challenge")!);
  // the record
  const rec = readEntry("mcp:fx") as McpOAuthRecord;
  expect(rec).toMatchObject({ type: "mcp-oauth", url: fx.mcpUrl, access: fx.access, refresh: fx.refresh, clientInformation: { client_id: "dcr-1", client_id_issued_at: 1_700_000_000 } });
  expect(rec.expires).toBeGreaterThan(Date.now());
  expect(rec.expires).toBeLessThanOrEqual(Date.now() + 3_600_000);
  expect(rec.discovery?.authorizationServerUrl).toBe(fx.base);
  expect(Object.keys(JSON.parse(readFileSync(credentialsPath(), "utf8")) as object)).toEqual(["mcp:fx"]);
  // verification connect: only authorized traffic after the probe, no further /token or .well-known
  const posts = fx.seen.filter((s) => s.path === "/mcp" && s.method === "POST");
  expect(posts[0]).toEqual({ method: "POST", path: "/mcp", auth: null }); // the probe
  expect(posts.length).toBeGreaterThan(1);
  expect(posts.slice(1).every((s) => s.auth === `Bearer ${fx.access}`)).toBe(true);
  expect(fx.count("/token")).toBe(1);
  expect(fx.count(".well-known")).toBe(l.wellKnownAtNotice);
  // final line
  expect(l.out.at(-1)).toBe(`stored OAuth token for MCP server "fx" in ${credentialsPath()} (${expiryText(rec.expires)}) — connected`);
  // canaries
  const all = [...l.out, ...l.err].join("\n");
  for (const c of [ACCESS_PREFIX, REFRESH_PREFIX, l.code, t.code_verifier!]) expect(all).not.toContain(c);
  // auth list / the chat seam / auth remove
  expect(formatAuthList()).toEqual([`${"mcp:fx".padEnd(14)} ${"oauth".padEnd(6)} ${"mcp server token".padEnd(24)} mcp-…  ${expiryText(rec.expires)}`]);
  expect(resolveOAuthProviderConfig()).toBeNull();
  expect(removeCredential("mcp:fx")).toBe(true);
  expect(existsSync(credentialsPath())).toBe(false);
}, 30_000);

test.skipIf(process.platform === "win32")("0600 on POSIX: stat of the credentials file after the login (skipped on win32 — mode bits only drive the read-only attribute there)", async () => {
  const l = await completeLogin();
  expect(l.exit).toBe(0);
  expect(statSync(credentialsPath()).mode & 0o777).toBe(0o600);
}, 30_000);

test("oauth.clientId configured: no registration — the authorize URL and /token carry the configured client_id; WWW-Authenticate's scope still wins over oauth.scope", async () => {
  writeProject({ fx: { url: fx.mcpUrl, oauth: { clientId: "pre-registered-client", scope: "cfg:scope" } } });
  const login = startLogin();
  const authorize = await login.authorize;
  expect(authorize.searchParams.get("client_id")).toBe("pre-registered-client");
  expect(authorize.searchParams.get("scope")).toBe(SCOPE);
  expect(fx.count("/register")).toBe(0);
  const { res } = await browse(authorize);
  expect(res.status).toBe(200);
  expect(await deadline(login.code, 20_000, "exit")).toBe(0);
  expect(fx.tokenRequests[0]).toMatchObject({ grant_type: "authorization_code", client_id: "pre-registered-client" });
  expect((readEntry("mcp:fx") as McpOAuthRecord).clientInformation).toEqual({ client_id: "pre-registered-client" });
  expect(fx.count("/register")).toBe(0);
}, 30_000);

test("negatives on the callback: a wrong ?state= → 400, exit 1 with the mismatch line, /token 0, port closed; a wrong path nonce → the same", async () => {
  writeProject({ fx: { url: fx.mcpUrl } });
  const a = startLogin();
  const au = await a.authorize;
  const forgedState = await browse(au, { state: "z".repeat(43) });
  expect(forgedState.res.status).toBe(400);
  expect(await forgedState.res.text()).toContain("State mismatch — this login was aborted. Run rovecode mcp login fx again.");
  expect(await deadline(a.code, 10_000, "exit")).toBe(1);
  expect(a.err).toEqual(['error: MCP server "fx" OAuth: state mismatch on the callback — login aborted']);
  expect(fx.count("/token")).toBe(0);
  await expectClosed(au.searchParams.get("redirect_uri")!);

  const b = startLogin();
  const bu = await b.authorize;
  const redirect = bu.searchParams.get("redirect_uri")!;
  const forgedPath = await browse(bu, { path: redirect.replace(/\/callback\/[^/?]+$/, `/callback/${"x".repeat(43)}`) });
  expect(forgedPath.res.status).toBe(400);
  expect(await deadline(b.code, 10_000, "exit")).toBe(1);
  expect(b.err).toEqual(['error: MCP server "fx" OAuth: state mismatch on the callback — login aborted']);
  expect(fx.count("/token")).toBe(0);
  await expectClosed(redirect);
}, 30_000);

test("a second GET after the accepted one is a 409 (or the port is already gone) and /token stays 1; ?error=access_denied → exit 1 with the reason, nothing exchanged", async () => {
  writeProject({ fx: { url: fx.mcpUrl } });
  const a = startLogin();
  const au = await a.authorize;
  const first = await browse(au);
  expect(first.res.status).toBe(200);
  const replay = await deadline(fetch(first.target), 10_000, "replay").then((r) => r.status, () => "closed" as const);
  expect([409, "closed"]).toContain(replay);
  expect(await deadline(a.code, 20_000, "exit")).toBe(0);
  expect(fx.count("/token")).toBe(1);

  const b = startLogin();
  const bu = await b.authorize;
  const denied = new URL(bu.searchParams.get("redirect_uri")!);
  denied.searchParams.set("error", "access_denied");
  denied.searchParams.set("error_description", "User said no");
  denied.searchParams.set("state", bu.searchParams.get("state")!);
  expect((await deadline(fetch(denied), 10_000, "denial")).status).toBe(400);
  expect(await deadline(b.code, 10_000, "exit")).toBe(1);
  expect(b.err).toEqual(['error: MCP server "fx" authorization denied: User said no']);
  expect(fx.count("/token")).toBe(1);
}, 30_000);

test("Ctrl-C while waiting for the browser: exit 130, `login cancelled`, the callback port refuses connections, nothing exchanged or stored", async () => {
  writeProject({ fx: { url: fx.mcpUrl } });
  const ac = new AbortController();
  const a = startLogin("fx", { signal: ac.signal });
  const au = await a.authorize;
  ac.abort();
  expect(await deadline(a.code, 10_000, "exit")).toBe(130);
  expect(a.err).toEqual(["login cancelled"]);
  await expectClosed(au.searchParams.get("redirect_uri")!);
  expect(fx.count("/token")).toBe(0);
  expect(existsSync(credentialsPath())).toBe(false);
}, 30_000);

test("a url server that does not answer 401 → exit 1 `server does not require OAuth (HTTP 200)`; nothing registered, nothing stored", async () => {
  const plain = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }) });
  try {
    writeProject({ open: { url: `http://127.0.0.1:${plain.port}/mcp` } });
    const err: string[] = [];
    expect(await deadline(runMcpLogin("open", cwd, { out: () => {}, err: (l) => err.push(l), oauth: oauthDeps() }), 10_000, "exit")).toBe(1);
    expect(err).toEqual(["error: server does not require OAuth (HTTP 200)"]);
    expect(existsSync(credentialsPath())).toBe(false);
  } finally {
    plain.stop(true);
  }
});

test("unknown name / stdio server / enabled:false / no name → exit 1 with ONE stderr line each; no file written", async () => {
  writeProject({ tool: { command: "bun" }, off: { url: fx.mcpUrl, enabled: false } });
  const run = async (name: string) => { const err: string[] = []; const code = await runMcpLogin(name, cwd, { out: () => { throw new Error("no stdout expected"); }, err: (l) => err.push(l), oauth: oauthDeps() }); return { code, err }; };
  expect(await run("nope")).toEqual({ code: 1, err: [`error: no MCP server "nope" in ${mcpConfigPath(cwd)}, .mcp.json (trusted files only — rovecode mcp trust) or ${join(rovecodeHome(), "mcp.json")}`] });
  expect(await run("tool")).toEqual({ code: 1, err: ['error: MCP server "tool" is a stdio server — OAuth login applies to url servers only'] });
  expect(await run("off")).toEqual({ code: 1, err: ['error: MCP server "off" is disabled (enabled: false) — enable it first'] });
  expect(await run("")).toEqual({ code: 1, err: [MCP_LOGIN_USAGE] });
  expect(MCP_LOGIN_USAGE).toContain("rovecode mcp login <name>");
  expect(fx.seen).toEqual([]);
  expect(existsSync(credentialsPath())).toBe(false);
});

test("TRUST GATE: the same server in an UNAPPROVED project file does not exist for `mcp login` — exit 1, the untrusted warning naming the approval command, NO request to its url; approving the file makes the same call proceed to the probe", async () => {
  writeProject({ fx: { url: fx.mcpUrl } }, false); // hand-written, never approved
  const err: string[] = [];
  const code = await runMcpLogin("fx", cwd, { out: () => { throw new Error("no stdout expected"); }, err: (l) => err.push(l), oauth: oauthDeps() });
  expect(code).toBe(1);
  expect(err).toHaveLength(2);
  expect(err[0]).toStartWith("warning: ");
  expect(err[0]).toContain("not trusted on this machine");
  expect(err[0]).toContain("rovecode mcp trust");
  expect(err[1]).toStartWith('error: no MCP server "fx"');
  expect(fx.seen).toEqual([]); // MUTATION TARGET: drop `trusted` from the loadMcpConfig call → the probe POSTs to an unapproved url
  expect(existsSync(credentialsPath())).toBe(false);
  // the approval is the only difference: the same file, trusted, reaches the server (probe 401 → the authorize notice)
  const r = trustMcpFile(rovecodeHome(), mcpConfigPath(cwd));
  expect(r.ok).toBe(true);
  const ac = new AbortController();
  const login = startLogin("fx", { signal: ac.signal });
  await login.authorize;
  expect(fx.seen.some((s) => s.path === "/mcp" && s.method === "POST")).toBe(true);
  ac.abort(); // Ctrl-C: the loopback closes, exit 130 — nothing left listening
  expect(await deadline(login.code, 10_000, "cancelled exit")).toBe(130);
});

test("an unparsable project mcp.json → exit 2 with the parse error (the `mcp list` rule), the file's bytes untouched, no request made", async () => {
  const p = mcpConfigPath(cwd);
  mkdirSync(dirname(p), { recursive: true });
  const broken = '{ "mcpServers": { "fx": { "url": "http://127.0.0.1:1/mcp" }, ';
  writeFileSync(p, broken);
  const err: string[] = [];
  expect(await runMcpLogin("fx", cwd, { out: () => {}, err: (l) => err.push(l), oauth: oauthDeps() })).toBe(2);
  expect(err).toHaveLength(1);
  expect(err[0]).toStartWith("error:");
  expect(err[0]).toContain("invalid JSON");
  expect(err[0]).toContain("refusing to overwrite");
  expect(readFileSync(p, "utf8")).toBe(broken);
  expect(fx.seen).toEqual([]);
});

test("a ServerError from the authorization server (registration answers 500 with a body) is reported as class + code — the body never reaches a line", async () => {
  fx.knobs.registerBody = "BODY-CANARY-secret-material";
  writeProject({ fx: { url: fx.mcpUrl } });
  const out: string[] = [];
  const err: string[] = [];
  expect(await deadline(runMcpLogin("fx", cwd, { out: (l) => out.push(l), err: (l) => err.push(l), oauth: oauthDeps() }), 10_000, "exit")).toBe(1);
  expect(err).toEqual(['error: MCP server "fx" authorization failed (ServerError: server_error)']);
  expect([...out, ...err].join("\n")).not.toContain("BODY-CANARY");
  expect(fx.count("/register")).toBe(1);
  expect(fx.count("/token")).toBe(0);
  expect(existsSync(credentialsPath())).toBe(false);
});
