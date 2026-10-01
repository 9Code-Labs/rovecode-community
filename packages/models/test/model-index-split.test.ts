/** The three-file model index (scripts/build-model-index.mjs) and what the split buys.
 *
 *  The split is a PERFORMANCE claim, so it is tested as one, and its two halves are tested apart:
 *
 *    the DATA   hot and extra are disjoint and together are the whole snapshot; every provider
 *               provider-map.ts can name is in hot. An overlapping partition would let catalog.ts's
 *               `hot[key] ?? extra[key]` skip the extra file for a key only extra has — a lookup
 *               returning undefined for a model that ships in the package.
 *    the LAZINESS   a session that stays on the mapped providers never parses models-index-extra.json.
 *               That is module-global state in catalog.ts, so it is asserted in a SUBPROCESS: in-process
 *               any earlier test file could have loaded the extra map, and the assertion would then be
 *               about the whole run rather than about the lookup.
 *
 *  Also here: the reachability the split paid for. Before it, resolve() had no candidate for a provider
 *  id the map did not translate, so 196 of the 213 shipped providers could never be looked up — a user
 *  who registered one got "unpriced" and no context window. The direct-id candidate is what makes them
 *  reachable, and it must not become a false-positive factory: an id that is NOT a models.dev key still
 *  resolves to nothing. */

import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ModelCatalog, indexState, mappedProviderKeys } from "@rovecode-labs/models";
import { providers as snapshot } from "@opencode-ai/models/snapshot";

type SnapProvider = { env?: string[]; models: Record<string, { limit?: { context?: number } }> };
type IndexFile = { generatedFrom: string; providers: Record<string, { env?: string[]; models: Record<string, unknown> | number }> };

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const readIndex = (f: string): IndexFile => JSON.parse(readFileSync(join(ROOT, "src", f), "utf8"));
const snap: Record<string, SnapProvider> = snapshot as unknown as Record<string, SnapProvider>;

const manifest = readIndex("models-manifest.json");
const hot = readIndex("models-index.json");
const extra = readIndex("models-index-extra.json");

/** a provider in the snapshot but in NEITHER table — what `rovecode provider add <vendor>` produces */
/** a provider in the snapshot but in NO table — what a hand-registered vendor id looks like */
const UNMAPPED_IN_SNAPSHOT = Object.keys(snap).filter((k) => !mappedProviderKeys().includes(k));

test("the partition is disjoint and exhaustive: hot ∪ extra is the whole snapshot, hot ∩ extra is empty", () => {
  const hotIds = Object.keys(hot.providers);
  const extraIds = Object.keys(extra.providers);
  expect(hotIds.filter((k) => extraIds.includes(k))).toEqual([]);             // disjoint — `hot[key] ?? extra[key]` is safe
  expect([...hotIds, ...extraIds].sort()).toEqual(Object.keys(snap).sort());  // exhaustive — nothing was dropped
  // provenance travels with the artefact: a generated file that cannot say what produced it is a liability
  for (const f of [manifest, hot, extra]) expect(f.generatedFrom).toMatch(/^@opencode-ai\/models@\d/);
});

test("every provider the catalog can name ships in the hot file — a mapped lookup never pays the extra parse", () => {
  const inSnapshot = mappedProviderKeys().filter((k) => k in snap);
  expect(inSnapshot.length).toBeGreaterThan(10);                              // the table is not vacuous
  for (const key of inSnapshot) expect(key in hot.providers).toBe(true);
  // the host app's built-in ids join the hot set too; that coupling is the monorepo's and is pinned
  // there (root test/unit/catalog.test.ts), not here. Here: the hot file holds nothing BEYOND the
  // mapped set plus those built-ins.
  for (const key of Object.keys(hot.providers)) expect(inSnapshot.includes(key)).toBe(true);
});

test("the manifest covers every provider with its env name and model count, and stays a summary", () => {
  expect(Object.keys(manifest.providers).sort()).toEqual(Object.keys(snap).sort());
  for (const [id, row] of Object.entries(manifest.providers)) {
    const s = snap[id]!;
    expect(row.models).toBe(Object.keys(s.models).length);
    // env[0] is the only name keyNameFor ever reads, so it is the only one kept
    if (s.env?.[0]) expect(row.env).toEqual([s.env[0]]);
    else expect(row.env).toBeUndefined();
    // the manifest is a SUMMARY: model rows in it would defeat the point of splitting
    expect(typeof row.models).toBe("number");
  }
  // the two consumers of env[0] agree with what auth.test.ts already pins
  expect(manifest.providers["anthropic"]!.env).toEqual(["ANTHROPIC_API_KEY"]);
  expect(manifest.providers["togetherai"]!.env).toEqual(["TOGETHER_API_KEY"]);
});

test("a hand-registered vendor id resolves through the extra file: context window and price, no table edit", () => {
  const id = UNMAPPED_IN_SNAPSHOT.find((k) => Object.keys(snap[k]!.models).length > 5)!;
  const withWindow = Object.keys(snap[id]!.models).find((m) => snap[id]!.models[m]!.limit?.context !== undefined)!;
  const c = new ModelCatalog();
  expect(c.lookup(id, "no-such-model-xyz")).toBeUndefined();                  // miss first: no false positive
  const info = c.lookup(id, withWindow)!;
  expect(info).toBeDefined();
  expect(info.provider).toBe(id);
  expect(info.source).toBe("models.dev");
  expect(info.contextWindow).toBe(snap[id]!.models[withWindow]!.limit!.context);
});

test("an unmapped id that is NOT a models.dev provider still resolves to nothing, cleanly", () => {
  const c = new ModelCatalog();
  for (const id of ["kaesra", "ollama", "vllm", "moondream", "my-corporate-proxy"]) {
    expect(id in snap).toBe(false);                                           // the ids really are off-catalog
    expect(() => c.lookup(id, "anything")).not.toThrow();
    expect(c.lookup(id, "anything")).toBeUndefined();
  }
});

/** module-global lazy state, asserted in a fresh process so nothing earlier in the suite can have
 *  warmed it: a session that stays on the mapped providers must never have opened the extra file. */
test("a mapped-only session never parses models-index-extra.json", () => {
  const script = `
    const { ModelCatalog, indexState } = await import(${JSON.stringify(join(ROOT, "src", "catalog.ts").replace(/\\/g, "/"))});
    const c = new ModelCatalog();
    for (const [p, m] of [["openai", "gpt-5.4"], ["anthropic", "claude-opus-5"], ["deepseek", "deepseek-v4-flash"], ["zai", "glm-5.3"]]) {
      if (!c.lookup(p, m)) { console.error("mapped lookup missed: " + p + "/" + m); process.exit(2); }
    }
    process.stdout.write(JSON.stringify(indexState()));
  `;
  const p = Bun.spawnSync([process.execPath, "-e", script], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`catalog subprocess failed (${p.exitCode}): ${p.stderr.toString()}`);
  const state = JSON.parse(p.stdout.toString()) as { hot: boolean; extra: boolean };
  expect(state.hot).toBe(true);
  expect(state.extra).toBe(false);
});
