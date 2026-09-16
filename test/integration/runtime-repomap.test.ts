/** Port #12 runtime wiring (round-2 F1/F3): the repo-map chunk is built
 *  LAZILY at the first buildDef() — createRuntime stays cheap for `rovecode tools`
 *  and ACP session creation — memoized afterwards for prompt-cache stability,
 *  env-switchable (ROVECODE_NO_REPOMAP / ROVECODE_REPOMAP_TOKENS), persists its tags
 *  cache under .rovecode/cache/repomap.json, and reaches the model through the ONE
 *  assembleContext path (config-chunk.test.ts precedent). Deleting the
 *  repoMapChunk block in runtime.ts turns this file red. */

import { test, expect } from "bun:test";
import { createRuntime } from "../../src/cli/runtime.ts";
import { agentLoop, SteeringQueue } from "../../src/core/loop.ts";
import { textTurn } from "../../src/providers/stream.ts";
import type { Message, StreamFn } from "../../src/core/types.ts";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Hermetic cwd: the (invalid) .git dir stops the config ancestor walk AND
 *  makes `git ls-files` fail fast, so the bounded walk enumerates fixtures. */
function tmpCwd(): string {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-rtmap-"));
  mkdirSync(join(cwd, ".git"));
  return cwd;
}

const model = { provider: "p", model: "m" };

function seedSources(cwd: string): void {
  writeFileSync(join(cwd, "alpha.ts"), "export function alphaHelper() { return betaHelper(); }\n");
  writeFileSync(join(cwd, "beta.ts"), "export function betaHelper() { return 2; }\n");
}

test("repo-map chunk rides buildDef at priority 80 — built LAZILY, not in createRuntime", () => {
  const cwd = tmpCwd();
  const rt = createRuntime({ cwd, stream: null });
  // files land AFTER construction: an eager build would have frozen an empty map
  seedSources(cwd);
  const def = rt.buildDef(model);
  const chunk = def.contextChunks?.find((c) => c.name === "repo-map");
  expect(chunk).toBeDefined();
  expect(chunk!.priority).toBe(80);
  expect(chunk!.text).toContain("alphaHelper");
  expect(chunk!.text).toContain("betaHelper");
  rmSync(cwd, { recursive: true, force: true });
});

test("repo-map text reaches the ONE system message via assembleContext (config-chunk precedent)", async () => {
  const cwd = tmpCwd();
  seedSources(cwd);
  const rt = createRuntime({ cwd, stream: null });
  const seen: Message[][] = [];
  const stream: StreamFn = async function* (_model, messages) {
    seen.push(messages);
    yield { type: "turn", turn: textTurn("ok") };
  };
  const deps = { stream, registry: rt.registry, store: rt.store, tools: [] };
  for await (const _ of agentLoop(rt.buildDef(model), "go", {}, rt.buildCfg(true), deps, new SteeringQueue())) { /* drain */ }
  expect(seen.length).toBeGreaterThan(0);
  const systemMsgs = seen[0]!.filter((m) => m.role === "system");
  expect(systemMsgs).toHaveLength(1); // one prompt-assembly path (ADR-003/007)
  const sysText = systemMsgs[0]!.parts.map((p) => (p.kind === "text" ? p.text : "")).join("");
  expect(sysText).toContain("alphaHelper"); // repo-map chunk folded into the system message
  expect(sysText).toContain("betaHelper");
  rmSync(cwd, { recursive: true, force: true });
});

test("memoized after the first buildDef: later edits do NOT move the chunk (prompt-cache stability)", () => {
  const cwd = tmpCwd();
  const rt = createRuntime({ cwd, stream: null });
  seedSources(cwd);
  const first = rt.buildDef(model).contextChunks?.find((c) => c.name === "repo-map");
  expect(first).toBeDefined();
  writeFileSync(join(cwd, "gamma.ts"), "export function gammaLateArrival() { return 3; }\n");
  const second = rt.buildDef(model).contextChunks?.find((c) => c.name === "repo-map");
  expect(second!.text).toBe(first!.text); // byte-stable across builds
  expect(second!.text).not.toContain("gammaLateArrival");
  rmSync(cwd, { recursive: true, force: true });
});

test("ROVECODE_NO_REPOMAP=1 kill switch: no repo-map chunk", () => {
  const cwd = tmpCwd();
  seedSources(cwd);
  process.env.ROVECODE_NO_REPOMAP = "1";
  try {
    const rt = createRuntime({ cwd, stream: null });
    const def = rt.buildDef(model);
    expect(def.contextChunks?.find((c) => c.name === "repo-map")).toBeUndefined();
  } finally {
    delete process.env.ROVECODE_NO_REPOMAP;
  }
  rmSync(cwd, { recursive: true, force: true });
});

test("ROVECODE_REPOMAP_TOKENS caps the chunk budget", () => {
  const cwd = tmpCwd();
  seedSources(cwd);
  process.env.ROVECODE_REPOMAP_TOKENS = "40";
  try {
    const rt = createRuntime({ cwd, stream: null });
    const chunk = rt.buildDef(model).contextChunks?.find((c) => c.name === "repo-map");
    expect(chunk).toBeDefined();
    expect(chunk!.tokens).toBeLessThanOrEqual(40);
  } finally {
    delete process.env.ROVECODE_REPOMAP_TOKENS;
  }
  rmSync(cwd, { recursive: true, force: true });
});

test("first buildDef persists the tags cache under .rovecode/cache/repomap.json (F1)", () => {
  const cwd = tmpCwd();
  const rt = createRuntime({ cwd, stream: null });
  seedSources(cwd);
  const cachePath = join(cwd, ".rovecode", "cache", "repomap.json");
  expect(existsSync(cachePath)).toBe(false); // createRuntime alone writes nothing
  rt.buildDef(model);
  expect(existsSync(cachePath)).toBe(true);  // warm launches skip extraction
  rmSync(cwd, { recursive: true, force: true });
});
