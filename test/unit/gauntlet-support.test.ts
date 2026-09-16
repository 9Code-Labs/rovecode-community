/** eval/gauntlet-support.ts: the per-run scratch root (create · list · bounded removal), env scoping,
 *  and the trust seeding the wave tasks depend on. The root's whole point is that a run never looks
 *  outside it, so the pins here are "only this root's children are ever seen" and "a busy root is
 *  reported, not retried forever". */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GAUNTLET_ROOT_PREFIX, createGauntletRoot, removeGauntletRoot, rootEntries, waveEnv, withEnv, writeTrustedHooks,
} from "../../src/eval/gauntlet-support.ts";
import { fileTrustStatus } from "../../src/core/trust.ts";
import { scratchDirs } from "../helpers/scratch.ts";

const scratch = scratchDirs();

describe("the per-run scratch root", () => {
  test("createGauntletRoot makes one prefixed dir under the OS temp dir; rootEntries lists ONLY its direct children, never a sibling run's", () => {
    const mine = createGauntletRoot();
    const theirs = createGauntletRoot(); // a concurrent run
    try {
      expect(mine.startsWith(join(tmpdir(), GAUNTLET_ROOT_PREFIX))).toBe(true);
      expect(mine).not.toBe(theirs);
      const a = mkdtempSync(join(mine, "rovecode-g-"));
      const b = mkdtempSync(join(theirs, "rovecode-g-"));
      expect([...rootEntries(mine)]).toEqual([a]);
      expect([...rootEntries(theirs)]).toEqual([b]); // MUTATION TARGET: scan tmpdir() again → each sees the other's
      // a nested dir is not a direct child, so a runner's own subdirs never read as leaks
      mkdirSync(join(a, "deeper"), { recursive: true });
      expect([...rootEntries(mine)]).toEqual([a]);
    } finally {
      removeGauntletRoot(mine);
      removeGauntletRoot(theirs);
    }
  });

  test("removeGauntletRoot returns null once the root is gone, and rootEntries of a missing root is empty", () => {
    const root = createGauntletRoot();
    writeFileSync(join(root, "x.txt"), "x");
    expect(removeGauntletRoot(root)).toBeNull();
    expect(existsSync(root)).toBe(false);
    expect([...rootEntries(root)]).toEqual([]);
    expect(removeGauntletRoot(root)).toBeNull(); // idempotent
  });

  test("a root the OS will not release is REPORTED after a bounded number of attempts — never retried forever", () => {
    const root = createGauntletRoot();
    try {
      let calls = 0;
      const note = removeGauntletRoot(root, { attempts: 3, pauseMs: 1, rm: () => { calls++; throw new Error("EBUSY (injected)"); } });
      expect(calls).toBe(3); // MUTATION TARGET: a `while (true)` retry → this test hangs instead of passing
      expect(note).toContain(root);
      expect(note).toContain("3 attempts");
      expect(note).toContain("EBUSY (injected)");
      expect(existsSync(root)).toBe(true); // the injected rm never deleted it
    } finally {
      removeGauntletRoot(root);
    }
  });
});

describe("withEnv", () => {
  test("sets, deletes and restores exactly — including a key that was absent and one that was set", async () => {
    process.env.ROVECODE_GAUNTLET_PROBE_SET = "before";
    delete process.env.ROVECODE_GAUNTLET_PROBE_ABSENT;
    const inside = await withEnv({ ROVECODE_GAUNTLET_PROBE_SET: undefined, ROVECODE_GAUNTLET_PROBE_ABSENT: "on" }, async () => ({
      set: process.env.ROVECODE_GAUNTLET_PROBE_SET,
      absent: process.env.ROVECODE_GAUNTLET_PROBE_ABSENT,
    }));
    expect(inside).toEqual({ set: undefined, absent: "on" });
    expect(process.env.ROVECODE_GAUNTLET_PROBE_SET).toBe("before");
    expect("ROVECODE_GAUNTLET_PROBE_ABSENT" in process.env).toBe(false);
    delete process.env.ROVECODE_GAUNTLET_PROBE_SET;
  });

  test("restores even when the body throws", async () => {
    process.env.ROVECODE_GAUNTLET_PROBE_SET = "keep";
    await expect(withEnv({ ROVECODE_GAUNTLET_PROBE_SET: "temp" }, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(process.env.ROVECODE_GAUNTLET_PROBE_SET).toBe("keep");
    delete process.env.ROVECODE_GAUNTLET_PROBE_SET;
  });

  test("waveEnv points the home at the task's dir, keeps hooks ON and turns the two slow features off", () => {
    expect(waveEnv("/h")).toEqual({ ROVECODE_HOME: "/h", ROVECODE_NO_REPOMAP: "1", ROVECODE_NO_CHECKPOINTS: "1", ROVECODE_NO_HOOKS: undefined });
  });
});

describe("writeTrustedHooks", () => {
  test("writes .rovecode/hooks.ts AND approves it in that home — both halves, so the hook a wave task writes actually loads", () => {
    const cwd = scratch("rovecode-gsupport-");
    const home = scratch("rovecode-gsupport-home-");
    const file = writeTrustedHooks(cwd, home, `approval() { return "allow"; }`);
    expect(file).toBe(join(cwd, ".rovecode", "hooks.ts"));
    const text = readFileSync(file, "utf8");
    expect(text).toContain("version: 1");
    expect(text).toContain(`approval() { return "allow"; }`);
    // the half that is easy to forget: without it loadHooks skips the file and a wave case tests nothing
    expect(fileTrustStatus(home, file)).toBe("trusted"); // MUTATION TARGET: drop the trustFile call → "untrusted"
  });

  test("a rewrite re-approves the NEW bytes (the digest is of the content, so an edit would otherwise fall back to untrusted)", () => {
    const cwd = scratch("rovecode-gsupport-");
    const home = scratch("rovecode-gsupport-home-");
    const file = writeTrustedHooks(cwd, home, `approval() { return "allow"; }`);
    expect(fileTrustStatus(home, file)).toBe("trusted");
    writeTrustedHooks(cwd, home, `pre_tool() { return { deny: "no" }; }`);
    expect(readFileSync(file, "utf8")).toContain("pre_tool");
    expect(fileTrustStatus(home, file)).toBe("trusted");
  });
});
