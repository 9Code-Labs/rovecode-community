/** warmRepoMap (cli/runtime.ts): the TUI asks for the repo map to be built on the next turn of the event
 *  loop, behind its first frame, instead of inside the first submit's buildDef (720–850 ms in this repository,
 *  2026-09-06). The contract: a buildDef that arrives while that timer is pending gets a definition WITHOUT
 *  the map — the map is not in that prompt, the request never waits — and every later buildDef has it. A
 *  runtime that never warmed keeps the synchronous build (headless `run`). */

import { test, expect } from "bun:test";
import { createRuntime } from "../../src/cli/runtime.ts";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function tmpCwd(): string {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-rtwarm-"));
  mkdirSync(join(cwd, ".git")); // stops the config ancestor walk; `git ls-files` fails fast → bounded walk
  writeFileSync(join(cwd, "alpha.ts"), "export function alphaHelper() { return betaHelper(); }\n");
  writeFileSync(join(cwd, "beta.ts"), "export function betaHelper() { return 2; }\n");
  return cwd;
}
const model = { provider: "p", model: "m" };
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const hasMap = (rt: ReturnType<typeof createRuntime>): boolean => (rt.buildDef(model).contextChunks ?? []).some((c) => c.name === "repo-map");

test("warmed: a buildDef before the timer has the map NOT in this prompt; after it, the map is there and frozen", async () => {
  const cwd = tmpCwd();
  const rt = createRuntime({ cwd, stream: null });
  rt.warmRepoMap();
  expect(hasMap(rt)).toBe(false);          // the request does not wait for the build
  expect(hasMap(rt)).toBe(false);          // and nothing got memoized by asking
  await tick(); await tick();              // the warm build ran
  expect(hasMap(rt)).toBe(true);
  writeFileSync(join(cwd, "gamma.ts"), "export function gammaHelper() { return 3; }\n");
  const text = rt.buildDef(model).contextChunks!.find((c) => c.name === "repo-map")!.text;
  expect(text).not.toContain("gammaHelper"); // memoized: prompt-cache stability, as before
  rmSync(cwd, { recursive: true, force: true });
});

test("warmRepoMap is idempotent and a no-op once the map exists", async () => {
  const cwd = tmpCwd();
  const rt = createRuntime({ cwd, stream: null });
  rt.warmRepoMap(); rt.warmRepoMap();
  await tick(); await tick();
  expect(hasMap(rt)).toBe(true);
  rt.warmRepoMap();                        // after the build: nothing to do
  expect(hasMap(rt)).toBe(true);
  rmSync(cwd, { recursive: true, force: true });
});

test("not warmed: buildDef builds synchronously and the first prompt has the map (headless `run` unchanged)", () => {
  const cwd = tmpCwd();
  const rt = createRuntime({ cwd, stream: null });
  expect(hasMap(rt)).toBe(true);
  rmSync(cwd, { recursive: true, force: true });
});
