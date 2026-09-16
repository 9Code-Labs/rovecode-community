/** tools/provider.ts: provider_edit refuses key-shaped arguments (nothing stored), add/use/remove round
 *  trip through a temp ROVECODE_HOME, provider_list never leaks a secret, kinds/actions match the policy
 *  split (read vs custom), and the CLI value flags are registered with parseCli. */

import { test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "../../src/core/types.ts";
import { ProviderRegistry, type AdapterFactory } from "../../src/providers/registry.ts";
import { BUILTIN_PROVIDERS, userProvidersPath } from "../../src/providers/provider-config.ts";
import { providerEditTool, providerListTool, looksLikeSecret } from "../../src/tools/provider.ts";
import { parseCli, VALUE_FLAGS } from "../../src/cli/dispatch.ts";

const ENV_KEYS = ["ROVECODE_HOME", "ROVECODE_BASE_URL", "ROVECODE_API_KEY", "ROVECODE_MODEL", "OPENAI_API_KEY", "P1_KEY", ...BUILTIN_PROVIDERS.map((p) => p.keyEnv!)];
let saved: Record<string, string | undefined> = {};
let home = "";
let cwd = "";
const CANARY = "sk-CANARY-never-in-output-0123456789";
const ctx: ToolContext = { sessionId: "s", cwd: ".", signal: new AbortController().signal, permissions: { effect: "allow" } };
const fake: AdapterFactory = (p) => async function* (model) {
  yield { type: "turn", turn: { parts: [{ kind: "text", text: `ok ${p.id}/${model.model}` }], stopReason: "end_turn", usage: { input: 1, output: 1 } } };
};

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  home = mkdtempSync(join(tmpdir(), "rovecode-ptool-home-"));
  cwd = mkdtempSync(join(tmpdir(), "rovecode-ptool-cwd-"));
  process.env.ROVECODE_HOME = home;
});
afterEach(() => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

test("kinds: provider_list is read (auto-allowed), provider_edit is custom (tool.provider_edit → prompt)", () => {
  const reg = new ProviderRegistry(cwd, { adapterFactory: fake, throttleMs: 0 });
  expect(providerListTool(reg).kind).toBe("read");
  expect(providerEditTool(reg).kind).toBe("custom");
  expect(providerEditTool(reg).sequential).toBe(true);
});

test("provider_edit refuses key-shaped arguments and stores nothing", async () => {
  const reg = new ProviderRegistry(cwd, { adapterFactory: fake, throttleMs: 0 });
  const edit = providerEditTool(reg);
  for (const args of [
    { action: "add", id: "p1", baseUrl: "https://p1.test/v1", apiKey: CANARY },
    { action: "add", id: "p1", baseUrl: "https://p1.test/v1", key: CANARY },
    { action: "add", id: "p1", baseUrl: "https://p1.test/v1", token: "abc" },
    { action: "add", id: "p1", baseUrl: "https://p1.test/v1", defaultModel: "sk-looks-like-a-key" },
  ]) {
    const out = await edit.execute(args, ctx);
    expect(out.ok).toBe(false);
    expect(out.output).toContain("never accepts API keys");
    expect(out.output).toContain("rovecode auth set");
    expect(out.output).not.toContain(CANARY);
  }
  expect(reg.get("p1")).toBeUndefined();
  expect(existsSync(userProvidersPath())).toBe(false);
  expect(looksLikeSecret({ action: "add", keyEnv: "P1_KEY", noKey: true })).toBeNull(); // the legitimate fields
});

test("provider_edit add → use → remove, live through the same registry; list never leaks the key", async () => {
  const reg = new ProviderRegistry(cwd, { adapterFactory: fake, throttleMs: 0 });
  const edit = providerEditTool(reg);
  const list = providerListTool(reg);
  let out = await edit.execute({ action: "add", id: "p1", baseUrl: "https://p1.test/v1", keyEnv: "P1_KEY", defaultModel: "glm" }, ctx);
  expect(out.ok).toBe(true);
  expect(out.output).toContain('added provider "p1"');
  expect(out.output).toContain("key: NOT SET");
  expect(out.output).toContain("rovecode auth set p1");
  expect(reg.get("p1")?.scope).toBe("user");
  process.env.P1_KEY = CANARY;
  reg.refresh();
  out = await list.execute({ action: "list" }, ctx);
  expect(out.ok).toBe(true);
  expect(out.output).toContain("key: env P1_KEY");
  expect(out.output).not.toContain(CANARY);
  out = await edit.execute({ action: "use", selector: "p1" }, ctx);   // bare id → its defaultModel
  expect(out.ok).toBe(true);
  expect(out.output).toContain("default → p1/glm");
  expect(reg.defaultRef()).toEqual({ provider: "p1", model: "glm" });
  out = await list.execute({ action: "test", id: "p1" }, ctx);
  expect(out.ok).toBe(true);
  expect(out.output).toContain("p1/glm: ok in");
  out = await list.execute({ action: "models", id: "anthropic" }, ctx);
  expect(out.ok).toBe(false);                                          // no key → hint, no network
  expect(out.output).toContain("rovecode auth set anthropic");
  out = await edit.execute({ action: "remove", id: "p1" }, ctx);
  expect(out.ok).toBe(true);
  expect(reg.get("p1")).toBeUndefined();
  out = await edit.execute({ action: "remove", id: "anthropic" }, ctx);
  expect(out.ok).toBe(false);
  expect(out.output).toContain("built in");
  out = await edit.execute({ action: "frobnicate" }, ctx);
  expect(out.ok).toBe(false);
});

test("CLI: the provider add value flags are registered so their values never become the command", () => {
  for (const f of ["--protocol", "--key-env", "--model", "--scope"]) expect(VALUE_FLAGS.has(f)).toBe(true);
  expect(parseCli(["bun", "main.ts", "--model", "glm", "provider", "list"]).cmd).toBe("provider");
  expect(parseCli(["bun", "main.ts", "provider", "add", "p1", "https://p1.test/v1", "--protocol", "openai", "--key-env", "P1_KEY"]).cmd).toBe("provider");
  expect(parseCli(["bun", "main.ts", "model", "use", "p1/glm"]).cmd).toBe("model");
});
