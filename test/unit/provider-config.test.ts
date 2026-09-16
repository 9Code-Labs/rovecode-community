/** providers/provider-config.ts: builtin < user file < project file < env pair merge, key resolution
 *  (stored > env), the `default` selector, malformed-entry tolerance, selector grammar, and the
 *  mtime-driven hot reload of ProviderConfig (same instance, no restart). */

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUILTIN_PROVIDERS, ProviderConfig, buildSnapshot, isConfigured, parseSelector, pickDefault, projectProvidersPath,
  readProvidersFile, userProvidersPath, validateSpec, writeProvidersFile,
} from "../../src/providers/provider-config.ts";
import { saveCredential } from "../../src/providers/auth.ts";

const ENV_KEYS = ["ROVECODE_HOME", "ROVECODE_BASE_URL", "ROVECODE_API_KEY", "ROVECODE_MODEL", "OPENAI_API_KEY", "MYPROXY_KEY", ...BUILTIN_PROVIDERS.map((p) => p.keyEnv!)];
let saved: Record<string, string | undefined> = {};
let home = "";
let cwd = "";

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  home = mkdtempSync(join(tmpdir(), "rovecode-pc-home-"));
  cwd = mkdtempSync(join(tmpdir(), "rovecode-pc-cwd-"));
  process.env.ROVECODE_HOME = home;
});
afterEach(() => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

const userFile = (data: unknown): void => { mkdirSync(home, { recursive: true }); writeFileSync(userProvidersPath(), JSON.stringify(data)); };
const projectFile = (data: unknown): void => { mkdirSync(join(cwd, ".rovecode"), { recursive: true }); writeFileSync(projectProvidersPath(cwd), JSON.stringify(data)); };

test("builtins only: every table entry present in order, none configured, no default", () => {
  const snap = buildSnapshot(cwd);
  expect(snap.providers.map((p) => p.id)).toEqual(BUILTIN_PROVIDERS.map((p) => p.id));
  expect(snap.providers.every((p) => p.scope === "builtin" && p.keySource === "none" && !isConfigured(p))).toBe(true);
  expect(snap.providers.find((p) => p.id === "anthropic")?.defaultModel).toBe("claude-opus-5");
  expect(pickDefault(snap)).toBeNull();
  expect(snap.warnings).toEqual([]);
});

test("user file adds a provider; keyEnv resolves from env; `default` selects it with its model", () => {
  userFile({ default: "myproxy/glm-5", providers: { myproxy: { baseUrl: "https://llm.example.test/v1/", keyEnv: "MYPROXY_KEY", headers: { "x-org": "9code" } } } });
  let snap = buildSnapshot(cwd);
  const p = snap.providers.find((x) => x.id === "myproxy")!;
  expect(p.scope).toBe("user");
  expect(p.baseUrl).toBe("https://llm.example.test/v1"); // trailing slash stripped
  expect(p.protocol).toBe("openai");                    // inferred
  expect(p.keySource).toBe("none");
  expect(pickDefault(snap)).toBeNull();                 // default names an unconfigured provider → ignored
  process.env.MYPROXY_KEY = "env-proxy-key-0123456789";
  snap = buildSnapshot(cwd);
  const d = pickDefault(snap)!;
  expect(d.via).toBe("default");
  expect(d.provider.id).toBe("myproxy");
  expect(d.provider.apiKey).toBe("env-proxy-key-0123456789");
  expect(d.provider.headers).toEqual({ "x-org": "9code" });
  expect(d.model).toBe("glm-5");
});

test("project file overrides the user file per id, and its `default` wins", () => {
  userFile({ default: "anthropic", providers: { myproxy: { baseUrl: "https://user.example.test/v1", keyEnv: "MYPROXY_KEY", defaultModel: "u-model" } } });
  projectFile({ default: "myproxy", providers: { myproxy: { baseUrl: "https://project.example.test/v1" } } });
  process.env.MYPROXY_KEY = "k-0123456789";
  const snap = buildSnapshot(cwd);
  const p = snap.providers.find((x) => x.id === "myproxy")!;
  expect(p.scope).toBe("project");
  expect(p.baseUrl).toBe("https://project.example.test/v1");
  expect(p.keyEnv).toBe("MYPROXY_KEY");        // inherited from the user layer
  expect(p.defaultModel).toBe("u-model");      // inherited too
  expect(snap.defaultSelector).toBe("myproxy");
  expect(snap.defaultScope).toBe("project");
  expect(pickDefault(snap)?.model).toBe("u-model"); // bare-id selector → the provider's defaultModel
});

test("env pair beats every file and credential; stored credential beats a named env key", () => {
  userFile({ default: "kaesra/x" });
  process.env.KAESRA_API_KEY = "env-kaesra-0123456789";
  saveCredential("anthropic", "sk-stored-ant-0123456789");
  let d = pickDefault(buildSnapshot(cwd))!;
  expect(d.via).toBe("default");               // the selector points at kaesra, which has an env key
  expect(d.provider.id).toBe("kaesra");
  userFile({});
  d = pickDefault(buildSnapshot(cwd))!;
  expect(d.via).toBe("stored");                // no selector → stored beats env (auth.test parity)
  expect(d.provider.id).toBe("anthropic");
  process.env.ROVECODE_BASE_URL = "https://pair.example.test/v1";
  process.env.ROVECODE_API_KEY = "pair-key-0123456789";
  process.env.ROVECODE_MODEL = "pair-model";
  d = pickDefault(buildSnapshot(cwd))!;
  expect(d.via).toBe("env-pair");
  expect(d.provider.id).toBe("custom");
  expect(d.provider.scope).toBe("env");
  expect(d.model).toBe("pair-model");
});

test("malformed entries are dropped with a warning, valid ones survive; noKey providers count as configured", () => {
  userFile({ default: 7, providers: { "Bad Id": { baseUrl: "https://x.test" }, nourl: { baseUrl: "not-a-url" }, badproto: { baseUrl: "https://x.test", protocol: "grpc" }, local: { baseUrl: "http://127.0.0.1:9/v1", noKey: true } } });
  const snap = buildSnapshot(cwd);
  expect(snap.warnings.length).toBe(4);
  expect(snap.providers.some((p) => p.id === "local")).toBe(true);
  expect(snap.providers.some((p) => p.id === "nourl" || p.id === "badproto" || p.id === "Bad Id")).toBe(false);
  const local = snap.providers.find((p) => p.id === "local")!;
  expect(isConfigured(local)).toBe(true);
  expect(pickDefault(snap)?.via).toBe("no-key");
  const r = readProvidersFile(userProvidersPath());
  expect(Object.keys(r.data.providers ?? {})).toEqual(["local"]);
  expect(validateSpec("ok", { baseUrl: "https://a.test", keyEnv: "lower" })).toEqual({ error: expect.stringContaining("keyEnv") });
});

test("parseSelector splits on the first slash; a bare id is a provider", () => {
  expect(parseSelector("kaesra/zai-org/glm-5.3")).toEqual({ provider: "kaesra", model: "zai-org/glm-5.3" });
  expect(parseSelector("anthropic")).toEqual({ provider: "anthropic" });
  expect(parseSelector("anthropic/")).toEqual({ provider: "anthropic" });
});

test("hot reload: the SAME ProviderConfig sees a file written after its first snapshot, and notifies", () => {
  const cfg = new ProviderConfig(cwd, process.env, 0);
  let fired = 0;
  cfg.onChange(() => { fired++; });
  expect(cfg.snapshot().providers.some((p) => p.id === "late")).toBe(false);
  writeProvidersFile(userProvidersPath(), { providers: { late: { baseUrl: "https://late.test/v1", noKey: true } } });
  expect(cfg.snapshot().providers.some((p) => p.id === "late")).toBe(true);
  expect(fired).toBe(1);
  expect(cfg.snapshot()).toBe(cfg.snapshot()); // unchanged files → the cached object
  expect(fired).toBe(1);
  saveCredential("late", "stored-late-key-0123456789"); // credentials.json is a source too
  expect(cfg.snapshot().providers.find((p) => p.id === "late")?.keySource).toBe("stored");
  expect(fired).toBe(2);
});

test("hot reload is throttled; invalidate() forces the re-read", () => {
  const cfg = new ProviderConfig(cwd, process.env, 60_000);
  expect(cfg.snapshot().providers.some((p) => p.id === "late")).toBe(false);
  writeProvidersFile(userProvidersPath(), { providers: { late: { baseUrl: "https://late.test/v1" } } });
  expect(cfg.snapshot().providers.some((p) => p.id === "late")).toBe(false); // within the throttle window
  cfg.invalidate();
  expect(cfg.snapshot().providers.some((p) => p.id === "late")).toBe(true);
});
