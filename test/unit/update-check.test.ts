/** update-check: the rule under all of these is that "up to date" must mean somebody looked.
 *
 *  A version check that answers "current" when it could not reach anything is indistinguishable, to the
 *  reader, from one that checked — which makes it worse than no check at all. So every path that fails
 *  carries a reason and `latest` stays absent, and the line a surface prints stays silent unless there
 *  is genuinely something new. */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkForUpdate, isNewer, updateLine } from "../../src/core/update-check.ts";

const cache = () => join(mkdtempSync(join(tmpdir(), "rovecode-upd-")), "update-check.json");
const release = (tag: string, status = 200) =>
  (async () => new Response(JSON.stringify({ tag_name: tag, html_url: `https://example.com/${tag}` }), { status })) as unknown as typeof fetch;

describe("isNewer", () => {
  test("compares numerically, not as text", () => {
    expect(isNewer("0.10.0", "0.9.0")).toBe(true);    // the classic: "0.10.0" < "0.9.0" as strings
    expect(isNewer("1.0.0", "0.99.99")).toBe(true);
    expect(isNewer("0.2.0", "0.2.0")).toBe(false);
    expect(isNewer("0.1.9", "0.2.0")).toBe(false);
  });

  test("tolerates a leading v and uneven part counts", () => {
    expect(isNewer("v0.3.0", "0.2.0")).toBe(true);
    expect(isNewer("0.2", "0.2.0")).toBe(false);
    expect(isNewer("0.2.0.1", "0.2.0")).toBe(true);
  });

  test("a prerelease never wins against the release of the same number", () => {
    // the conservative direction: this must not invent an update
    expect(isNewer("0.3.0-beta.1", "0.3.0")).toBe(false);
    expect(isNewer("0.3.0", "0.3.0-beta.1")).toBe(true);
  });
});

describe("checkForUpdate", () => {
  test("reports a newer release, with where to get it", async () => {
    const s = await checkForUpdate("0.2.0", { token: "t", fetchFn: release("v0.3.0"), cacheFile: cache() });
    expect(s).toMatchObject({ current: "0.2.0", latest: "0.3.0", newer: true, from: "network" });
    expect(updateLine(s)).toContain("0.2.0 → 0.3.0");
  });

  test("says nothing when the running version is the newest", async () => {
    const s = await checkForUpdate("0.3.0", { token: "t", fetchFn: release("v0.3.0"), cacheFile: cache() });
    expect(s.newer).toBe(false);
    expect(updateLine(s)).toBeNull();                       // silence is the point
    expect(updateLine(s, true)).toContain("up to date");    // unless asking WAS the point
  });

  test("the gh CLI's token counts as a token — nobody exports a variable to be told about an update", async () => {
    const s = await checkForUpdate("0.2.0", {
      token: undefined, ghToken: async () => "from-gh", fetchFn: release("v0.3.0"), cacheFile: cache(),
    });
    expect(s).toMatchObject({ latest: "0.3.0", newer: true });
  });

  test("without a token it asks ANONYMOUSLY — the community repository is public; a token would only raise the rate limit", async () => {
    let auth: unknown = "sentinel";
    const s = await checkForUpdate("0.2.0", {
      token: undefined, ghToken: async () => undefined, cacheFile: cache(),
      fetchFn: (async (_u: unknown, init?: RequestInit) => {
        auth = (init?.headers as Record<string, string> | undefined)?.["authorization"];
        return new Response(JSON.stringify({ tag_name: "v0.3.0", html_url: "https://x" }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    expect(s).toMatchObject({ latest: "0.3.0", newer: true });
    expect(auth).toBeUndefined(); // no authorization header on the anonymous request
  });

  test("a repository with no releases yet is a reason, not a failure", async () => {
    const s = await checkForUpdate("0.2.0", { token: "t", fetchFn: release("", 404), cacheFile: cache() });
    expect(s).toMatchObject({ newer: false, reason: "no release published yet" });
  });

  test("every network failure becomes a reason — startup is never blocked by this", async () => {
    for (const fetchFn of [
      (() => Promise.reject(new Error("ENOTFOUND api.github.com"))) as unknown as typeof fetch,
      (async () => new Response("rate limited", { status: 403 })) as unknown as typeof fetch,
      (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,   // 200 without a tag
    ]) {
      const s = await checkForUpdate("0.2.0", { token: "t", fetchFn, cacheFile: cache() });
      expect(s.newer).toBe(false);
      expect(typeof s.reason).toBe("string");
      expect(updateLine(s)).toBeNull();
    }
  });

  test("gives up quickly rather than holding the terminal", async () => {
    const hang = ((_u: unknown, init: unknown) =>
      new Promise((_r, rej) => { (init as { signal: AbortSignal }).signal.addEventListener("abort", () => rej(new Error("aborted"))); })) as unknown as typeof fetch;
    const s = await checkForUpdate("0.2.0", { token: "t", fetchFn: hang, cacheFile: cache(), timeoutMs: 20 });
    expect(s.reason).toBe("the check timed out");
  });

  test("asks once and then reads the cache, and re-decides `newer` against the running version", async () => {
    const file = cache();
    let calls = 0;
    const counting = (async () => { calls += 1; return new Response(JSON.stringify({ tag_name: "v0.4.0" }), { status: 200 }); }) as unknown as typeof fetch;

    const first = await checkForUpdate("0.2.0", { token: "t", fetchFn: counting, cacheFile: file });
    expect(first.from).toBe("network");
    const second = await checkForUpdate("0.2.0", { token: "t", fetchFn: counting, cacheFile: file });
    expect(second.from).toBe("cache");
    expect(calls).toBe(1);

    // the same cached answer, read by a process that has since been upgraded PAST it: still not newer
    const upgraded = await checkForUpdate("0.5.0", { token: "t", fetchFn: counting, cacheFile: file });
    expect(upgraded).toMatchObject({ from: "cache", latest: "0.4.0", newer: false });
    expect(calls).toBe(1);
  });

  test("a stale cache is ignored, and an unreadable one is not an error", async () => {
    const file = cache();
    writeFileSync(file, JSON.stringify({ at: 0, status: { current: "0.1.0", latest: "0.1.0", newer: false, from: "network" } }));
    const s = await checkForUpdate("0.2.0", { token: "t", fetchFn: release("v0.9.0"), cacheFile: file, now: () => 10 * 60 * 60 * 1000 });
    expect(s).toMatchObject({ latest: "0.9.0", from: "network", newer: true });

    writeFileSync(file, "not json at all");
    const s2 = await checkForUpdate("0.2.0", { token: "t", fetchFn: release("v0.9.0"), cacheFile: file });
    expect(s2.latest).toBe("0.9.0");
  });

  test("a home it cannot write to still yields an answer", async () => {
    const s = await checkForUpdate("0.2.0", { token: "t", fetchFn: release("v0.3.0"), cacheFile: join(tmpdir(), "rovecode-no-such-dir-\u0000", "x.json") });
    expect(s).toMatchObject({ latest: "0.3.0", newer: true });
  });

  test("the cached file records the answer, not the request", async () => {
    const file = cache();
    await checkForUpdate("0.2.0", { token: "sekrit-token", ghToken: async () => "gh-token-too", fetchFn: release("v0.3.0"), cacheFile: file });
    const raw = readFileSync(file, "utf8");
    expect(raw).toContain("0.3.0");
    expect(raw).not.toContain("sekrit-token");   // a cache in the home directory is not a place for a token
    expect(raw).not.toContain("gh-token-too");
  });
});

describe("cacheOnly", () => {
  test("answers from the cache and never opens a socket", async () => {
    const file = cache();
    // a cold cache: it says it has not asked, rather than asking. `rovecode --version` took 3.2 s on a
    // fresh machine before this existed — a courtesy line making the one command scripts call to find out
    // which build they have wait on a network round-trip.
    const cold = await checkForUpdate("0.2.0", {
      cacheOnly: true, cacheFile: file,
      fetchFn: (() => { throw new Error("must not be called"); }) as unknown as typeof fetch,
      ghToken: async () => { throw new Error("must not be called"); },
    });
    expect(cold.reason).toContain("not asked yet");
    expect(cold.latest).toBeUndefined();
    expect(updateLine(cold)).toBeNull();                       // silent unless asked verbosely
    expect(updateLine(cold, true)).toContain("not asked yet");

    // once something HAS asked, the same call reports it without a request of its own
    await checkForUpdate("0.2.0", { token: "t", fetchFn: release("v0.9.0"), cacheFile: file });
    const warm = await checkForUpdate("0.2.0", {
      cacheOnly: true, cacheFile: file,
      fetchFn: (() => { throw new Error("must not be called"); }) as unknown as typeof fetch,
    });
    expect(warm).toMatchObject({ latest: "0.9.0", newer: true, from: "cache" });
    expect(updateLine(warm)).toContain("0.2.0 → 0.9.0");
  });
});
