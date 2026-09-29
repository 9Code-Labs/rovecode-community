/** probe-cache.ts: verdict caching (TTL differs ok/failed), bounded-concurrency probing, cache hits
 *  are never re-proven. ROVECODE_HOME is redirected so the real cache file is never touched. */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProbeCache, probeModels, PROBE_TTL_FAIL_MS, PROBE_TTL_OK_MS, saveProbeVerdict } from "../../src/providers/probe-cache.ts";

let home: string;
let saved: string | undefined;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "rovecode-probe-"));
  saved = process.env.ROVECODE_HOME;
  process.env.ROVECODE_HOME = home;
});
afterEach(() => {
  if (saved === undefined) delete process.env.ROVECODE_HOME; else process.env.ROVECODE_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});

const targets = ["a/m1", "a/m2", "b/m3"].map((id) => ({ id, provider: id.split("/")[0]!, model: id.split("/")[1]! }));

test("every model is probed once; verdicts come back keyed by id", async () => {
  const seen: string[] = [];
  const v = await probeModels(targets, async (p, m) => { seen.push(`${p}/${m}`); return { ok: m !== "m2", detail: m === "m2" ? "boom" : "ok in 3 ms" }; });
  expect(seen.sort()).toEqual(["a/m1", "a/m2", "b/m3"]);
  expect(v.get("a/m1")!.ok).toBe(true);
  expect(v.get("a/m2")).toMatchObject({ ok: false, detail: "boom" });
});

test("a cached-fresh verdict is NOT re-proven; an expired one is (ok 6h, fail 30min)", async () => {
  saveProbeVerdict("a/m1", { ok: true, detail: "old ok", at: Date.now() - 1000 });
  saveProbeVerdict("a/m2", { ok: false, detail: "old fail", at: Date.now() - PROBE_TTL_FAIL_MS - 1000 }); // expired
  const seen: string[] = [];
  const v = await probeModels(targets, async (p, m) => { seen.push(`${p}/${m}`); return { ok: true, detail: "fresh" }; });
  expect(seen.sort()).toEqual(["a/m2", "b/m3"]); // m1 came from the cache, m2's failure had expired
  expect(v.get("a/m1")!.detail).toBe("old ok");
  saveProbeVerdict("c/m9", { ok: true, detail: "x", at: Date.now() - PROBE_TTL_OK_MS - 1 }); // expired ok
  expect(loadProbeCache().has("c/m9")).toBe(false);
});

test("a throwing probe is a failed verdict, never a rejected promise; concurrency stays bounded", async () => {
  let live = 0, maxLive = 0;
  const many = Array.from({ length: 20 }, (_, i) => ({ id: `p/m${i}`, provider: "p", model: `m${i}` }));
  const v = await probeModels(many, async (_p, m) => {
    live++; maxLive = Math.max(maxLive, live);
    await new Promise((r) => setTimeout(r, 5));
    live--;
    if (m === "m7") throw new Error("kaboom");
    return { ok: true, detail: "ok" };
  }, { concurrency: 4 });
  expect(maxLive).toBeLessThanOrEqual(4);
  expect(v.get("p/m7")).toMatchObject({ ok: false, detail: "kaboom" });
  expect(v.size).toBe(20);
});
