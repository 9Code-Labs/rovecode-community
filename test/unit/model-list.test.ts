/** The readable model list: registry.models() three-rung precedence (file → endpoint → catalog),
 *  the annotated table formatModelList renders, and `provider add --context-window`.
 *
 *  The catalog rung is the behavior that matters: `rovecode model list anthropic` used to answer
 *  "the endpoint listed no models" (Anthropic has no /models route) when the shipped catalog knew
 *  every answer. The rung must not change the OTHER two — a providers.json list and a live endpoint
 *  still win, in that order — and it must never reach the network for a provider with no key. */

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderRegistry, parseAddArgs, formatModelList, formatContextTokens, annotateModel, type ModelListRow } from "../../src/providers/registry.ts";
import { BUILTIN_PROVIDERS } from "../../src/providers/provider-config.ts";

const ENV_KEYS = ["ROVECODE_HOME", "ROVECODE_BASE_URL", "ROVECODE_API_KEY", "ROVECODE_MODEL", ...BUILTIN_PROVIDERS.map((p) => p.keyEnv!)];
let saved: Record<string, string | undefined> = {};
let home = "";
let cwd = "";
beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  home = mkdtempSync(join(tmpdir(), "rovecode-mlist-home-"));
  cwd = mkdtempSync(join(tmpdir(), "rovecode-mlist-cwd-"));
  process.env.ROVECODE_HOME = home;
});
afterEach(() => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

test("models(): an unconfigured but catalog-known provider lists from the catalog, no key and no network asked", async () => {
  const reg = new ProviderRegistry(cwd, { throttleMs: 0 });
  const r = await reg.models("anthropic"); // no key stored; Anthropic has no /models route regardless
  expect(r).toMatchObject({ ok: true, source: "catalog" });
  if (r.ok) {
    expect(r.models).toContain("claude-opus-5");
    expect(r.models.length).toBeGreaterThan(5);
  }
});

test("models(): a providers.json list still wins over both the endpoint and the catalog", async () => {
  const reg = new ProviderRegistry(cwd, { throttleMs: 0 });
  const added = reg.add({ id: "deepseek", baseUrl: "http://127.0.0.1:9/v1", protocol: "openai", noKey: true, models: ["only-this-one"] });
  expect("error" in added).toBe(false);
  const r = await reg.models("deepseek");
  expect(r).toMatchObject({ ok: true, source: "file", models: ["only-this-one"] });
});

test("models(): a dead endpoint falls through to the catalog; a catalog-unknown provider answers empty, not wrong", async () => {
  const reg = new ProviderRegistry(cwd, { throttleMs: 0 });
  reg.add({ id: "deepseek", baseUrl: "http://127.0.0.1:9/v1", protocol: "openai", noKey: true }); // port 9 refuses fast
  const r = await reg.models("deepseek");
  expect(r).toMatchObject({ ok: true, source: "catalog" });
  if (r.ok) expect(r.models).toContain("deepseek-v4-flash");

  reg.add({ id: "zork", baseUrl: "http://127.0.0.1:9/v1", protocol: "openai", noKey: true });
  const z = await reg.models("zork");
  expect(z).toMatchObject({ ok: true, source: "endpoint", models: [] });
});

test("models(): an unknown id is still an error that names the known providers", async () => {
  const reg = new ProviderRegistry(cwd, { throttleMs: 0 });
  const r = await reg.models("nope");
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toContain('unknown provider "nope"');
});

test("formatContextTokens: the column is six wide — 1M/1.05M/131k/8k, undefined is a dash not a guess", () => {
  expect(formatContextTokens(1_000_000)).toBe("1M");
  expect(formatContextTokens(1_050_000)).toBe("1.05M");
  expect(formatContextTokens(131_072)).toBe("131k");
  expect(formatContextTokens(8_000)).toBe("8k");
  expect(formatContextTokens(512)).toBe("512");
  expect(formatContextTokens(undefined)).toBe("—");
});

test("formatModelList: default marker, aligned columns, local pricing footnoted, unknowns as dashes", () => {
  const rows: ModelListRow[] = [
    annotateModel("claude-opus-5", true, { provider: "anthropic", model: "claude-opus-5", contextWindow: 1_000_000, supportsReasoning: true, supportsTools: true, pricing: { inputPerMTok: 5, outputPerMTok: 25 } }, true),
    annotateModel("claude-opus-4-5", false, { provider: "anthropic", model: "claude-opus-4-5", contextWindow: 200_000, supportsReasoning: true, supportsTools: true, pricing: { inputPerMTok: 5, outputPerMTok: 25 }, source: "local" }),
    annotateModel("custom-build-9", false, undefined), // off-catalog: every fact a dash, never a guess
  ];
  const out = formatModelList("anthropic", rows, "catalog");
  const lines = out.split("\n");
  expect(lines[0]).toBe("anthropic — 3 models (rovecode's model catalog — the endpoint has no /models route, or no key is stored yet)");
  expect(lines[1]).toMatch(/^\* claude-opus-5\s+1M\s+\$5\/\$25\s+reasoning · tools · vision$/);
  expect(lines[2]).toMatch(/^  claude-opus-4-5\s+200k\s+\$5\/\$25\s+reasoning · tools †$/);
  expect(lines[3]).toMatch(/^  custom-build-9\s+—\s+—$/);
  expect(lines[4]).toContain("† priced from rovecode's own table");
  // alignment is the point of the table: the context column is right-aligned, so every row's token
  // ENDS at the same offset (starts differ — that is what right-aligned means)
  const ctxEnd = (l: string, tok: string) => l.indexOf(tok, 2) + tok.length;
  const ends = [ctxEnd(lines[1]!, "1M"), ctxEnd(lines[2]!, "200k"), ctxEnd(lines[3]!, "—")];
  expect(new Set(ends).size).toBe(1);
});

test("formatModelList: the big-list tip appears only past sixty rows", () => {
  const many = Array.from({ length: 61 }, (_, i) => ({ id: `m-${i}`, default: false }));
  expect(formatModelList("openrouter", many, "endpoint")).toContain("narrow it: rovecode model list openrouter | grep");
  expect(formatModelList("openrouter", many.slice(0, 60), "endpoint")).not.toContain("narrow it");
});

test("parseAddArgs: --context-window lands on the spec, and rejects non-counts", () => {
  const ok = parseAddArgs(["acme", "http://127.0.0.1:9/v1", "--context-window", "131072"]);
  expect("error" in ok).toBe(false);
  if (!("error" in ok)) expect(ok.spec.contextWindow).toBe(131072);
  for (const bad of [["acme", "http://x/v1", "--context-window", "abc"], ["acme", "http://x/v1", "--context-window", "-5"], ["acme", "http://x/v1", "--context-window"]]) {
    const r = parseAddArgs(bad);
    expect("error" in r).toBe(true);
    if ("error" in r) expect(r.error).toContain("--context-window");
  }
});
