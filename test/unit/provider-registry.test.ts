/** providers/registry.ts: the dispatching stream (config errors as non-retryable error turns, per-call
 *  provider resolution, adapter cache keyed on the key), add/remove/setDefault round trips through a
 *  temp ROVECODE_HOME, selector resolution, `add` arg parsing, and the redacted listing. */

import { test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message, StreamEvent, StreamFn } from "../../src/core/types.ts";
import { ProviderRegistry, parseAddArgs, formatProviderList, CONFIG_ERROR_PREFIX, type AdapterFactory } from "../../src/providers/registry.ts";
import { BUILTIN_PROVIDERS, userProvidersPath } from "../../src/providers/provider-config.ts";
import { classifyStreamError } from "../../src/providers/router.ts";
import { saveCredential } from "../../src/providers/auth.ts";

const ENV_KEYS = ["ROVECODE_HOME", "ROVECODE_BASE_URL", "ROVECODE_API_KEY", "ROVECODE_MODEL", "ROVECODE_STREAM", "OPENAI_API_KEY", "P1_KEY", "P1_API_KEY", ...BUILTIN_PROVIDERS.map((p) => p.keyEnv!)];
let saved: Record<string, string | undefined> = {};
let home = "";
let cwd = "";
const CANARY = "sk-CANARY-do-not-print-0123456789";

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  home = mkdtempSync(join(tmpdir(), "rovecode-reg-home-"));
  cwd = mkdtempSync(join(tmpdir(), "rovecode-reg-cwd-"));
  process.env.ROVECODE_HOME = home;
});
afterEach(() => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

/** fake adapter: echoes provider id + key, counts constructions (cache proof) */
function fakeFactory(): { factory: AdapterFactory; built: string[] } {
  const built: string[] = [];
  const factory: AdapterFactory = (p) => {
    built.push(p.id);
    return async function* (model, _messages: Message[]): AsyncGenerator<StreamEvent> {
      yield { type: "turn", turn: { parts: [{ kind: "text", text: `served ${p.id}/${model.model} key=${p.apiKey ?? "-"}` }], stopReason: "end_turn", usage: { input: 1, output: 1 } } };
    };
  };
  return { factory, built };
}
const user: Message = { id: "u", role: "user", parts: [{ kind: "text", text: "hi" }], parentId: null, createdAt: 0 };
async function turnOf(stream: StreamFn, provider: string, model = "m") {
  const evs: StreamEvent[] = [];
  for await (const ev of stream({ provider, model }, [user])) evs.push(ev);
  expect(evs.length).toBe(1);
  return evs[0]!.type === "turn" ? evs[0]!.turn : (() => { throw new Error("no turn"); })();
}

test("unknown provider → ONE `config:` error turn with the fix, classified non-retryable", async () => {
  const reg = new ProviderRegistry(cwd, { adapterFactory: fakeFactory().factory, throttleMs: 0 });
  const turn = await turnOf(reg.stream(), "nope");
  expect(turn.stopReason).toBe("error");
  expect(turn.error?.startsWith(CONFIG_ERROR_PREFIX)).toBe(true);
  expect(turn.error).toContain("rovecode provider add nope");
  expect(turn.error).toContain("/provider add");
  expect(classifyStreamError(turn.error).retryable).toBe(false);
});

test("known provider without a key → config error naming auth set, the TUI command and the env var", async () => {
  const reg = new ProviderRegistry(cwd, { adapterFactory: fakeFactory().factory, throttleMs: 0 });
  expect(reg.configured()).toBe(false);
  const turn = await turnOf(reg.stream(), "anthropic");
  expect(turn.stopReason).toBe("error");
  expect(turn.error).toContain("rovecode auth set anthropic");
  expect(turn.error).toContain("/provider key anthropic");
  expect(turn.error).toContain("ANTHROPIC_API_KEY");
  expect(classifyStreamError(turn.error).retryable).toBe(false);
});

test("dispatch: per-call provider, adapter cached per id, rebuilt when the key changes (live, same stream)", async () => {
  const { factory, built } = fakeFactory();
  const reg = new ProviderRegistry(cwd, { adapterFactory: factory, throttleMs: 0 });
  const stream = reg.stream();
  process.env.P1_KEY = "env-p1-0123456789";
  const added = reg.add({ id: "p1", baseUrl: "https://p1.test/v1", protocol: "openai", keyEnv: "P1_KEY" });
  expect("error" in added).toBe(false);
  expect(reg.configured()).toBe(true);
  let t = await turnOf(stream, "p1", "glm");
  expect(t.parts).toEqual([{ kind: "text", text: "served p1/glm key=env-p1-0123456789" }]);
  await turnOf(stream, "p1", "glm");
  expect(built).toEqual(["p1"]);                      // second call reused the adapter
  saveCredential("p1", "stored-p1-0123456789", "P1_KEY"); // key rotated through credentials.json
  t = await turnOf(stream, "p1", "glm");
  expect(t.parts).toEqual([{ kind: "text", text: "served p1/glm key=stored-p1-0123456789" }]);
  expect(built).toEqual(["p1", "p1"]);                // rebuilt once for the new key
  saveCredential("anthropic", "sk-ant-0123456789");
  t = await turnOf(stream, "anthropic", "claude-opus-5");
  expect(t.parts[0]).toEqual({ kind: "text", text: "served anthropic/claude-opus-5 key=sk-ant-0123456789" });
  expect(built).toEqual(["p1", "p1", "anthropic"]);   // a second provider through the SAME stream
});

test("add / setDefault / remove round-trip the user providers.json; builtins cannot be removed", () => {
  const reg = new ProviderRegistry(cwd, { adapterFactory: fakeFactory().factory, throttleMs: 0 });
  let changes = 0;
  reg.onChange(() => { changes++; });
  const r = reg.add({ id: "p1", baseUrl: "https://p1.test/v1/", protocol: "openai", defaultModel: "glm" });
  expect("error" in r).toBe(false);
  expect(JSON.parse(readFileSync(userProvidersPath(), "utf8"))).toEqual({ providers: { p1: { baseUrl: "https://p1.test/v1", protocol: "openai", defaultModel: "glm" } } });
  expect(reg.get("p1")?.scope).toBe("user");
  expect(reg.defaultRef()).toBeNull();                          // no key → not the default
  expect(reg.setDefault("p1")).toEqual({ provider: "p1", model: "glm" }); // bare id → its defaultModel
  expect(reg.defaultSelector()).toBe("p1/glm");
  process.env.P1_API_KEY = "k-0123456789"; // no keyEnv given → keyNameFor("p1") = P1_API_KEY
  reg.refresh();
  expect(reg.defaultRef()).toEqual({ provider: "p1", model: "glm" });
  process.env.ROVECODE_MODEL = "override";
  expect(reg.defaultRef()).toEqual({ provider: "p1", model: "override" }); // env ROVECODE_MODEL layers on top
  expect(reg.setDefault("nope/x")).toEqual({ error: expect.stringContaining("unknown provider") });
  expect(reg.setDefault("openai")).toEqual({ error: expect.stringContaining("names no model") });
  expect(reg.remove("anthropic")).toEqual({ error: expect.stringContaining("built in") });
  expect(reg.remove("p1")).toEqual({ removed: ["user"] });
  expect(reg.get("p1")).toBeUndefined();
  expect(JSON.parse(readFileSync(userProvidersPath(), "utf8"))).toEqual({ default: "p1/glm" }); // default survives; providers key dropped
  expect(changes).toBeGreaterThanOrEqual(3);
  expect(reg.add({ id: "Bad Id", baseUrl: "https://x.test", protocol: "openai" })).toEqual({ error: expect.stringContaining("lowercase slug") });
  expect(existsSync(join(cwd, ".rovecode", "providers.json"))).toBe(false); // user scope never touches the project file
});

test("resolveSelector: a leading segment is a provider only when it names one", () => {
  const reg = new ProviderRegistry(cwd, { adapterFactory: fakeFactory().factory, throttleMs: 0 });
  expect(reg.resolveSelector("anthropic/claude-opus-5", "kaesra")).toEqual({ provider: "anthropic", model: "claude-opus-5" });
  expect(reg.resolveSelector("zai-org/glm-5.3", "kaesra")).toEqual({ provider: "kaesra", model: "zai-org/glm-5.3" });
  expect(reg.resolveSelector("gpt-5", "openai")).toEqual({ provider: "openai", model: "gpt-5" });
  expect(reg.resolveSelector("anthropic/", "kaesra")).toEqual({ error: expect.stringContaining("names no model") });
  expect(reg.resolveSelector("x", "mock")).toEqual({ provider: "mock", model: "x" }); // current provider not validated (mock / injected streams)
  expect(reg.resolveSelector("  ", "kaesra")).toEqual({ error: "empty model selector" });
});

test("parseAddArgs: flags, scope, --key marker, validation", () => {
  const ok = parseAddArgs(["myproxy", "https://llm.test/v1", "--protocol", "anthropic", "--key-env", "MY_KEY", "--model", "m1", "--project", "--key"]);
  expect(ok).toEqual({ spec: { id: "myproxy", baseUrl: "https://llm.test/v1", protocol: "anthropic", keyEnv: "MY_KEY", defaultModel: "m1" }, scope: "project", promptKey: true });
  expect(parseAddArgs(["local", "http://127.0.0.1:11434/v1", "--no-key", "--scope", "user"])).toEqual({ spec: { id: "local", baseUrl: "http://127.0.0.1:11434/v1", protocol: "openai", noKey: true }, scope: "user", promptKey: false });
  expect(parseAddArgs(["onlyid"])).toEqual({ error: expect.stringContaining("usage: add <id> <baseUrl>") });
  expect(parseAddArgs(["a", "https://x.test", "--bogus"])).toEqual({ error: expect.stringContaining("unknown flag --bogus") });
  expect(parseAddArgs(["a", "https://x.test", "--protocol"])).toEqual({ error: expect.stringContaining("--protocol needs a value") });
  expect(parseAddArgs(["a", "https://x.test", "--scope", "global"])).toEqual({ error: "--scope must be user or project" });
});

test("formatProviderList: key sources only, never the secret; keyless builtins folded into a count", () => {
  const reg = new ProviderRegistry(cwd, { adapterFactory: fakeFactory().factory, throttleMs: 0 });
  saveCredential("anthropic", CANARY);
  process.env.P1_KEY = CANARY;
  reg.add({ id: "p1", baseUrl: "https://p1.test/v1", protocol: "openai", keyEnv: "P1_KEY" });
  const text = formatProviderList(reg);
  expect(text).not.toContain(CANARY);
  expect(text).toContain("default → anthropic/claude-opus-5");
  expect(text).toContain("anthropic");
  expect(text).toContain("key: stored");
  expect(text).toContain("key: env P1_KEY");
  expect(text).toContain("built-in providers without a key");
  expect(text.split("\n").length).toBeLessThan(8);                       // builtins folded
  expect(formatProviderList(reg, { all: true }).split("\n").length).toBeGreaterThan(BUILTIN_PROVIDERS.length);
});

test("probe: routes through the (fake) adapter and reports ok; no key → the hint", async () => {
  const reg = new ProviderRegistry(cwd, { adapterFactory: fakeFactory().factory, throttleMs: 0 });
  expect((await reg.probe("anthropic")).detail).toContain("rovecode auth set anthropic");
  saveCredential("anthropic", "sk-ant-0123456789");
  const r = await reg.probe("anthropic");
  expect(r.ok).toBe(true);
  expect(r.model).toBe("claude-opus-5");
  expect(r.detail).toContain("ok in");
  expect((await reg.probe("openai")).detail).toContain("no API key");
  expect((await reg.probe("ghost")).detail).toContain("unknown provider");
});

test("setModels: pins the active list on the file row (creating one for a builtin); empty un-pins back to the endpoint; a stale default is dropped; env provider refuses", async () => {
  const reg = new ProviderRegistry(cwd, { adapterFactory: fakeFactory().factory, throttleMs: 0 });
  const r = reg.setModels("anthropic", ["claude-opus-5", "claude-sonnet-5", "claude-opus-5"]);
  if ("error" in r) throw new Error(r.error);
  expect(r.models).toEqual(["claude-opus-5", "claude-sonnet-5"]); // deduped, order kept
  const onFile = JSON.parse(readFileSync(userProvidersPath(), "utf8")) as { providers?: { anthropic?: { models?: string[]; baseUrl?: string } } };
  expect(onFile.providers?.anthropic?.models).toEqual(["claude-opus-5", "claude-sonnet-5"]);
  expect(onFile.providers?.anthropic?.baseUrl).toBe("https://api.anthropic.com/v1"); // the created row carries the builtin's URL
  // the live registry answers /models from the FILE now, not the endpoint
  const listed = await reg.models("anthropic");
  expect(listed.ok && listed.source === "file" && listed.models).toEqual(["claude-opus-5", "claude-sonnet-5"]);
  // empty list removes the field — back to asking the endpoint each time ("use them all")
  reg.setModels("anthropic", []);
  const after = JSON.parse(readFileSync(userProvidersPath(), "utf8")) as { providers?: { anthropic?: { models?: string[] } } };
  expect(after.providers?.anthropic?.models).toBeUndefined();
  // a pinned list that no longer contains the row's default drops the stale default
  reg.add({ id: "myproxy", baseUrl: "https://p.test/v1", protocol: "openai", defaultModel: "m-big" });
  reg.setModels("myproxy", ["m-small"]);
  const row = JSON.parse(readFileSync(userProvidersPath(), "utf8")) as { providers?: { myproxy?: { models?: string[]; defaultModel?: string } } };
  expect(row.providers?.myproxy?.models).toEqual(["m-small"]);
  expect(row.providers?.myproxy?.defaultModel).toBeUndefined();
  // an empty-string id and an unknown provider refuse; the env provider refuses
  expect("error" in reg.setModels("ghost", ["m"])).toBe(true);
  expect("error" in reg.setModels("anthropic", [" "])).toBe(true);
  process.env.ROVECODE_BASE_URL = "https://env.test/v1";
  process.env.ROVECODE_API_KEY = "sk-env";
  reg.refresh();
  expect("error" in reg.setModels("custom", ["m"])).toBe(true);
});
