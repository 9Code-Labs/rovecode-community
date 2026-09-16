/** warmRepoMap (cli/runtime.ts): cooperative work behind the first frame, not a synchronous timer callback.
 *  Pending prompts get cheap chunks; successful maps are frozen. Cancellation drains file/git handles and
 *  prevents later cache writes. A runtime that never warmed keeps the synchronous build (headless `run`). */

import { test, expect } from "bun:test";
import { createRuntime } from "../../src/cli/runtime.ts";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
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
const hasMap = (rt: ReturnType<typeof createRuntime>): boolean => (rt.buildDef(model).contextChunks ?? []).some((c) => c.name === "repo-map");
/** the warm build is cooperative now (repomap.ts buildRepoMapChunkAsync) — many turns of the loop, not one tick; bounded */
async function warmed(rt: ReturnType<typeof createRuntime>, ms = 8000): Promise<void> {
  const until = Date.now() + ms;
  while (!hasMap(rt)) { if (Date.now() > until) throw new Error("the warm build did not land within the deadline"); await new Promise((r) => setTimeout(r, 5)); }
}

test("warmed: a buildDef before the timer has the map NOT in this prompt; after it, the map is there and frozen", async () => {
  const cwd = tmpCwd();
  const rt = createRuntime({ cwd, stream: null });
  rt.warmRepoMap();
  expect(hasMap(rt)).toBe(false);          // the request does not wait for the build
  expect(hasMap(rt)).toBe(false);          // and nothing got memoized by asking
  await warmed(rt);                        // the warm build ran (cooperatively, off the caller's stack)
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
  await warmed(rt);
  expect(hasMap(rt)).toBe(true);
  rt.warmRepoMap();                        // after the build: nothing to do
  expect(hasMap(rt)).toBe(true);
  rmSync(cwd, { recursive: true, force: true });
});

test("quitting cancels and drains warmup: no locked cwd, no cache recreation, no sync retry on a later definition", async () => {
  const cwd = tmpCwd();
  const rt = createRuntime({ cwd, stream: null });
  try {
    rt.warmRepoMap();
    await rt.stopRepoMapWarmup();
    expect(hasMap(rt)).toBe(false);
    rt.warmRepoMap(); // closed runtimes cannot restart the scan
    expect(hasMap(rt)).toBe(false);
    rmSync(cwd, { recursive: true, force: true }); // notably Windows: git must have released its cwd
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(existsSync(cwd)).toBe(false);
  } finally { await rt.stopRepoMapWarmup(); await rt.hooks.close(); rmSync(cwd, { recursive: true, force: true }); }
});

test("not warmed: buildDef builds synchronously and the first prompt has the map (headless `run` unchanged)", () => {
  const cwd = tmpCwd();
  const rt = createRuntime({ cwd, stream: null });
  expect(hasMap(rt)).toBe(true);
  rmSync(cwd, { recursive: true, force: true });
});
