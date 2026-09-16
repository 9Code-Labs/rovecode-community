/** Port #66 — the credentials store's oauth variant and the seam's precedence: save/load/remove
 *  round-trips next to api entries, malformed oauth records dropped but preserved raw, `auth list`
 *  shape (kind + expiry, redacted, no secret), the 0600 file mode pinned through the ONE constant
 *  (POSIX stat where enforceable; the structural pin on every platform), and resolveProvider's rank:
 *  explicit pair > stored api key > env key > stored OAuth token (registry order among tokens);
 *  providerStream over an oauth config is the refreshing wrapper. Hermetic: ROVECODE_HOME = mkdtemp. */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  CREDENTIALS_FILE_MODE, credentialsPath, listProviders, loadCredentials, loadOAuthCredentials, removeCredential, saveCredential, saveOAuthCredential,
} from "../../src/providers/auth.ts";
import { expiryText, formatAuthList } from "../../src/cli/auth-login.ts";
import { listBuiltinProviders, providerStream, resolveProvider } from "../../src/providers/stream.ts";
import { OAUTH_PROVIDER_IDS, OAUTH_REFUSED, oauthProvider, oauthProviders } from "../../src/providers/oauth/registry.ts";
import type { Message, StreamEvent } from "../../src/core/types.ts";

const NOW = 1_800_000_000_000;
const TOKEN = "copilot-CANARY-access-token-0123456789";
const GH = "gho_CANARY_refresh_0123456789";
const ENV_KEYS = ["ROVECODE_HOME", "ROVECODE_BASE_URL", "ROVECODE_API_KEY", "ROVECODE_MODEL", "OPENAI_API_KEY", ...listBuiltinProviders().map((p) => p.envKey)];
const savedEnv = new Map<string, string | undefined>();
let home = "";

beforeEach(() => {
  for (const k of ENV_KEYS) { savedEnv.set(k, process.env[k]); delete process.env[k]; }
  home = mkdtempSync(join(tmpdir(), "rovecode-oauth-store-"));
  process.env.ROVECODE_HOME = home;
});
afterEach(() => {
  for (const [k, v] of savedEnv) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  savedEnv.clear();
  rmSync(home, { recursive: true, force: true });
});

const oauth = (over: Partial<{ access: string; refresh: string; expires: number; accountId: string }> = {}) =>
  ({ type: "oauth" as const, access: TOKEN, refresh: GH, expires: NOW + 60_000, ...over });

test("save → load → replace → remove round-trip; api and oauth entries coexist; one entry per provider id (the later kind wins)", () => {
  saveCredential("deepseek", "sk-ds-0123456789");
  saveOAuthCredential("github-copilot", oauth());
  expect(loadOAuthCredentials()).toEqual({ "github-copilot": oauth() });
  expect(loadCredentials()).toEqual({ deepseek: { type: "api", key: "sk-ds-0123456789", keyName: "DEEPSEEK_API_KEY" } });
  saveOAuthCredential("github-copilot", oauth({ access: "second", expires: NOW + 1 }));
  expect(loadOAuthCredentials()["github-copilot"]).toEqual(oauth({ access: "second", expires: NOW + 1 }));
  // the same id flips kind when the other command runs
  saveOAuthCredential("openai", oauth({ accountId: "acct-1" }));
  expect(loadOAuthCredentials()["openai"]?.accountId).toBe("acct-1");
  saveCredential("openai", "sk-oai-0123456789");
  expect(loadOAuthCredentials()["openai"]).toBeUndefined();
  expect(loadCredentials()["openai"]?.key).toBe("sk-oai-0123456789");
  // remove works for oauth entries; removing the last entry removes the file
  expect(removeCredential("github-copilot")).toBe(true);
  expect(loadOAuthCredentials()).toEqual({});
  removeCredential("deepseek"); removeCredential("openai");
  expect(existsSync(credentialsPath())).toBe(false);
  expect(removeCredential("github-copilot")).toBe(false);
});

test("malformed oauth records are dropped on load (missing expiry, blank access, non-string refresh) but preserved raw through a rewrite; save refuses them", () => {
  mkdirSync(home, { recursive: true });
  writeFileSync(credentialsPath(), JSON.stringify({
    good: oauth(),
    noExpiry: { type: "oauth", access: "a", refresh: "r" },
    blank: { type: "oauth", access: "  ", refresh: "r", expires: 1 },
    badRefresh: { type: "oauth", access: "a", refresh: 5, expires: 1 },
    infinite: { type: "oauth", access: "a", refresh: "r", expires: Number.POSITIVE_INFINITY },
  }), "utf8");
  expect(Object.keys(loadOAuthCredentials())).toEqual(["good"]);
  saveOAuthCredential("openrouter", oauth({ refresh: "", expires: Number.MAX_SAFE_INTEGER }));
  const raw = JSON.parse(readFileSync(credentialsPath(), "utf8")) as Record<string, unknown>;
  expect(raw["noExpiry"]).toEqual({ type: "oauth", access: "a", refresh: "r" });
  expect(raw["openrouter"]).toEqual({ type: "oauth", access: TOKEN, refresh: "", expires: Number.MAX_SAFE_INTEGER });
  expect(() => saveOAuthCredential("x", { type: "oauth", access: "", refresh: "", expires: 1 })).toThrow(/malformed OAuth credential/);
  expect(() => saveOAuthCredential("x", { type: "oauth", access: "a", refresh: "", expires: Number.NaN })).toThrow(/malformed OAuth credential/);
  expect(() => saveOAuthCredential(" ", oauth())).toThrow(/must not be empty/);
});

test("auth list shape: kind + key name + redacted prefix (+ expiry for oauth), sorted by provider; no secret in the records or the rows", () => {
  saveCredential("openai", "sk-oai-CANARY-0123456789");
  saveOAuthCredential("github-copilot", oauth({ expires: NOW - 1 }));
  saveOAuthCredential("openrouter", oauth({ access: "sk-or-CANARY-key-0123456789", refresh: "", expires: Number.MAX_SAFE_INTEGER }));
  saveOAuthCredential("kaesra", oauth({ expires: NOW + 3_600_000 }));
  const entries = listProviders();
  expect(entries.map((e) => e.provider)).toEqual(["github-copilot", "kaesra", "openai", "openrouter"]);
  expect(entries[0]).toEqual({ provider: "github-copilot", kind: "oauth", keyName: "oauth token", redacted: "copi…", expires: NOW - 1 });
  expect(entries[2]).toEqual({ provider: "openai", kind: "api", keyName: "OPENAI_API_KEY", redacted: "sk-o…" });
  expect(JSON.stringify(entries)).not.toContain("CANARY");
  const rows = formatAuthList(entries, NOW);
  expect(rows).toEqual([
    "github-copilot oauth  oauth token              copi…  EXPIRED 2027-01-15T07:59:59.999Z",
    "kaesra         oauth  oauth token              copi…  expires 2027-01-15T09:00:00.000Z",
    "openai         api    OPENAI_API_KEY           sk-o…",
    "openrouter     oauth  oauth token              sk-o…  never expires",
  ]);
  expect(rows.join("\n")).not.toContain("CANARY");
  expect(expiryText(Number.MAX_SAFE_INTEGER, NOW)).toBe("never expires");
  expect(expiryText(9e15, NOW)).toBe("never expires");
  expect(expiryText(NOW, NOW)).toBe("EXPIRED 2027-01-15T08:00:00.000Z");
  expect(expiryText(NOW + 1, NOW)).toBe("expires 2027-01-15T08:00:00.001Z");
});

test("0600: the store is written with CREDENTIALS_FILE_MODE on create AND re-asserted on rewrite, through the one constant (structural pin, every platform)", () => {
  // MUTATION TARGET (store 0644): flipping the constant or bypassing it at either call site fails here
  expect(CREDENTIALS_FILE_MODE).toBe(0o600);
  const src = readFileSync(resolve(import.meta.dir, "..", "..", "src", "providers", "auth.ts"), "utf8");
  expect(src).toContain("{ mode: CREDENTIALS_FILE_MODE }");
  expect(src).toContain("chmodSync(path, CREDENTIALS_FILE_MODE)");
  const modeLiterals = src.split("\n").filter((l) => /\b0o[0-7]{3}\b/.test(l) && !l.includes("export const CREDENTIALS_FILE_MODE") && !/^\s*(\/\/|\*|\/\*\*)/.test(l));
  expect(modeLiterals).toEqual(["  mkdirSync(rovecodeHome(), { recursive: true, mode: 0o700 });"]); // the directory's 0700 is the only other mode
});

test.skipIf(process.platform === "win32")("0600 on POSIX: stat of the written file (skipped on win32 — mode bits only drive the read-only attribute there; see auth.ts writeStore)", () => {
  saveOAuthCredential("github-copilot", oauth());
  expect(statSync(credentialsPath()).mode & 0o777).toBe(0o600);
  saveCredential("openai", "sk-rewrite-0123456789"); // rewrite path re-asserts
  expect(statSync(credentialsPath()).mode & 0o777).toBe(0o600);
});

test("resolveProvider: a stored OAuth token is used when no API key is set — as the provider's config with oauth:true, the token as apiKey, derived base URL + headers", () => {
  expect(resolveProvider()).toBeNull();
  saveOAuthCredential("github-copilot", oauth({ access: "tid=x;proxy-ep=proxy.business.githubcopilot.com;rest" }));
  const cfg = resolveProvider();
  expect(cfg).toMatchObject({ id: "github-copilot", oauth: true, protocol: "openai", baseUrl: "https://api.business.githubcopilot.com", apiKey: "tid=x;proxy-ep=proxy.business.githubcopilot.com;rest", defaultModel: "gpt-4o" });
  expect(cfg!.headers?.["Editor-Version"]).toBe("vscode/1.107.0");
  removeCredential("github-copilot");
  saveOAuthCredential("openrouter", oauth({ access: "sk-or-key", refresh: "", expires: Number.MAX_SAFE_INTEGER }));
  saveOAuthCredential("openai", oauth({ accountId: "acct-9" }));
  const or = resolveProvider();
  expect(or).toMatchObject({ id: "openrouter", oauth: true, baseUrl: "https://openrouter.ai/api/v1", apiKey: "sk-or-key" }); // registry order: github-copilot, openrouter, openai
  expect(or!.headers).toBeUndefined();
  removeCredential("openrouter");
  // the ChatGPT token takes the codex Responses wire (providers/responses.ts) — resolvable since the wire landed
  expect(resolveProvider()).toMatchObject({ id: "openai", oauth: true, baseUrl: "https://chatgpt.com/backend-api/codex", wire: "responses", headers: { "chatgpt-account-id": "acct-9", "OpenAI-Beta": "responses=experimental", originator: "rovecode" } });
});

test("resolveProvider rank: any API key beats a stored token — env key, stored api key, and the explicit pair each win over an oauth entry", () => {
  saveOAuthCredential("github-copilot", oauth());
  process.env.DEEPSEEK_API_KEY = "env-ds-0123456789";
  expect(resolveProvider()).toMatchObject({ id: "deepseek", apiKey: "env-ds-0123456789" });
  expect(resolveProvider()!.oauth).toBeUndefined();
  saveCredential("xai", "sk-xai-stored-0123456789");
  expect(resolveProvider()).toMatchObject({ id: "xai", apiKey: "sk-xai-stored-0123456789" });
  process.env.ROVECODE_BASE_URL = "https://example.test/v1";
  process.env.ROVECODE_API_KEY = "explicit-0123456789";
  expect(resolveProvider()).toMatchObject({ id: "custom", apiKey: "explicit-0123456789" });
});

test("providerStream over an oauth config is the refreshing wrapper: with nothing stored it yields a clean error turn instead of a request", async () => {
  const stream = providerStream({ id: "openrouter", baseUrl: "http://127.0.0.1:9/api/v1", apiKey: "stale", protocol: "openai", oauth: true });
  const msg: Message = { id: "m1", role: "user", parts: [{ kind: "text", text: "hi" }], parentId: null, createdAt: NOW };
  let turn: Extract<StreamEvent, { type: "turn" }>["turn"] | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("exceeded 5000 ms")), 5_000); });
  try {
    await Promise.race([(async () => { for await (const ev of stream({ provider: "openrouter", model: "x" }, [msg])) if (ev.type === "turn") turn = ev.turn; })(), deadline]);
  } finally {
    clearTimeout(timer);
  }
  expect(turn?.stopReason).toBe("error");
  expect(turn?.error).toBe("openrouter: no stored OAuth credential — run `rovecode auth login openrouter`");
});

test("registry: the three ToS-safe ids in precedence order (openai back in since the Responses wire landed); anthropic is the one refusal, with the owner-decision note citing the landscape lines", () => {
  expect([...OAUTH_PROVIDER_IDS]).toEqual(["github-copilot", "openrouter", "openai"]);
  expect(oauthProviders().map((p) => p.id)).toEqual([...OAUTH_PROVIDER_IDS]);
  expect(oauthProvider("openai")?.label).toContain("device code");
  expect(oauthProvider("anthropic")).toBeUndefined();
  expect(Object.keys(OAUTH_REFUSED)).toEqual(["anthropic"]);
  expect(OAUTH_REFUSED["anthropic"]).toContain("research/round3_landscape.md:64-66");
  expect(OAUTH_REFUSED["anthropic"]).toContain("owner decision");
});
