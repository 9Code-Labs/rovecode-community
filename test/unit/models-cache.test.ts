/** The /models catalog cache (stream.ts fetchModels): memory -> disk -> network, stale-while-revalidate,
 *  and the blip guards — a sub-second network dropout must not empty the list, poison the disk cache,
 *  or hide the picker for the full TTL. fetch is stubbed per test (stream.test.ts idiom); every test
 *  gets its own ROVECODE_HOME so the disk layer starts empty and stays hers. */

import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearModelsCache, fetchModels, type ProviderConfig } from "../../src/providers/stream.ts";

let keySeq = 0;
function cfg(): ProviderConfig {
  keySeq += 1;
  return { id: `p${keySeq}`, baseUrl: `https://cache-test-${keySeq}.invalid/v1`, apiKey: "k", protocol: "openai" };
}

interface Stub { calls: string[]; restore: () => void }
function stubFetch(respond: (url: string) => Response): Stub {
  const calls: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: unknown) => {
    calls.push(String(url));
    return respond(String(url));
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = real; } };
}

const listResponse = (ids: string[]): Response =>
  new Response(JSON.stringify({ data: ids.map((id) => ({ id, owned_by: "o" })) }), { status: 200 });

/** run `fn` under a fresh ROVECODE_HOME with an empty in-memory layer, then restore both */
async function withHome(fn: (home: string) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "models-cache-"));
  const prev = process.env.ROVECODE_HOME;
  process.env.ROVECODE_HOME = home;
  clearModelsCache();
  try { await fn(home); } finally {
    clearModelsCache();
    if (prev === undefined) delete process.env.ROVECODE_HOME; else process.env.ROVECODE_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
}

const cacheFile = (home: string): string => join(home, "cache", "models.json");
async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

test("a cold fetch answers from the endpoint and lands on disk; the next call is a pure memory hit", async () => {
  await withHome(async (home) => {
    const p = cfg();
    const stub = stubFetch(() => listResponse(["m1", "m2"]));
    try {
      expect((await fetchModels(p)).map((m) => m.id)).toEqual(["m1", "m2"]);
      expect(stub.calls.length).toBe(1);
      expect(stub.calls[0]).toBe(`${p.baseUrl}/models`);
      const disk = JSON.parse(readFileSync(cacheFile(home), "utf8")) as Record<string, { models: { id: string }[] }>;
      const key = `${p.id} ${p.baseUrl}`;
      expect(disk[key]?.models.map((m) => m.id)).toEqual(["m1", "m2"]);
      expect((await fetchModels(p)).map((m) => m.id)).toEqual(["m1", "m2"]);
      expect(stub.calls.length).toBe(1); // TTL memory hit: no second round-trip
    } finally { stub.restore(); }
  });
});

test("a fresh process opens the picker from disk without touching the network", async () => {
  await withHome(async () => {
    const p = cfg();
    const warm = stubFetch(() => listResponse(["m1"]));
    try { await fetchModels(p); } finally { warm.restore(); }
    clearModelsCache(); // the process died; the disk cache is all that survives
    const cold = stubFetch(() => { throw new Error("the network must not be needed"); });
    try {
      expect((await fetchModels(p)).map((m) => m.id)).toEqual(["m1"]);
      expect(cold.calls.length).toBe(0);
    } finally { cold.restore(); }
  });
});

test("a stale disk entry is served instantly and revalidated in the background", async () => {
  await withHome(async (home) => {
    const p = cfg();
    const key = `${p.id} ${p.baseUrl}`;
    mkdirSync(join(home, "cache"), { recursive: true });
    writeFileSync(cacheFile(home), JSON.stringify({
      [key]: { models: [{ id: "old" }], fetchedAt: Date.now() - 6 * 60_000 }, // past the 5-min TTL, inside the stale window
    }));
    const stub = stubFetch(() => listResponse(["new"]));
    try {
      expect((await fetchModels(p)).map((m) => m.id)).toEqual(["old"]); // default: serve stale, leave NOTHING dangling (a one-shot CLI exits on its own)
      await new Promise((r) => setTimeout(r, 20));
      expect(stub.calls.length).toBe(0);
      expect((await fetchModels(p, { background: true })).map((m) => m.id)).toEqual(["old"]); // opt-in: the caller still never waits on the refresh
      await waitFor(() => stub.calls.length >= 1);
      await waitFor(() => {
        const disk = JSON.parse(readFileSync(cacheFile(home), "utf8")) as Record<string, { models: { id: string }[] }>;
        return disk[key]?.models[0]?.id === "new";
      });
      expect((await fetchModels(p)).map((m) => m.id)).toEqual(["new"]); // revalidation reached the memory layer too
      expect(stub.calls.length).toBe(1);
    } finally { stub.restore(); }
  });
});

test("a network blip is retried once; an HTTP status is a real answer and is not retried", async () => {
  await withHome(async () => {
    const blipped = cfg();
    let attempts = 0;
    const blip = stubFetch(() => {
      attempts += 1;
      if (attempts === 1) throw new Error("ECONNRESET"); // the socket a 1-2 s dropout kills
      return listResponse(["m1"]);
    });
    try {
      expect((await fetchModels(blipped)).map((m) => m.id)).toEqual(["m1"]);
      expect(attempts).toBe(2);
    } finally { blip.restore(); }

    const routed = cfg(); // an endpoint that answers 404 has no /models route: retrying changes nothing
    const notFound = stubFetch(() => new Response("nope", { status: 404 }));
    try {
      expect(await fetchModels(routed)).toEqual([]);
      expect(notFound.calls.length).toBe(1);
      // the empty answer is remembered briefly, so the next call inside the fail window stays off the network
      expect(await fetchModels(routed)).toEqual([]);
      expect(notFound.calls.length).toBe(1);
    } finally { notFound.restore(); }
  });
});

test("a dead endpoint never overwrites a good cache: force falls back to memory and the disk entry survives", async () => {
  await withHome(async (home) => {
    const p = cfg();
    const key = `${p.id} ${p.baseUrl}`;
    const warm = stubFetch(() => listResponse(["m1"]));
    try { await fetchModels(p, { force: true }); } finally { warm.restore(); }
    const diskBefore = readFileSync(cacheFile(home), "utf8");
    const down = stubFetch(() => { throw new Error("ECONNREFUSED"); });
    try {
      expect((await fetchModels(p, { force: true })).map((m) => m.id)).toEqual(["m1"]); // stale beats empty
      expect(down.calls.length).toBe(2); // the blip retry still happened, twice, and gave up
      expect(readFileSync(cacheFile(home), "utf8")).toBe(diskBefore); // an empty answer never reaches the disk
      expect(JSON.parse(diskBefore)[key].models[0].id).toBe("m1");
    } finally { down.restore(); }
  });
});
