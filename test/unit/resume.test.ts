/** `rovecode --continue` / `--resume` with no id → the newest session that holds something (cli/resume.ts). */

import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { SessionStore, newestSession } from "../../src/core/session.ts";
import { parseResume, resolveResume } from "../../src/cli/resume.ts";

const user = (text: string, at: number) => ({ id: randomUUID(), role: "user" as const, parts: [{ kind: "text" as const, text }], parentId: null, createdAt: at });
const argv = (...a: string[]) => ["bun", "main.ts", ...a];

test("parseResume: an explicit id wins; --resume alone, --resume before another flag, and --continue all mean 'newest'", () => {
  expect(parseResume(argv("--resume", "abc"))).toEqual({ id: "abc", newest: false });
  expect(parseResume(argv("--resume"))).toEqual({ newest: true });
  expect(parseResume(argv("--resume", "--yolo"))).toEqual({ newest: true });   // never "the session named --yolo"
  expect(parseResume(argv("--continue"))).toEqual({ newest: true });
  expect(parseResume(argv("--continue", "--resume", "abc"))).toEqual({ id: "abc", newest: false });
  expect(parseResume(argv("--yolo"))).toEqual({ newest: false });
});

test("newest = most recently updated session WITH entries: a hollow directory (meta.json only) is skipped, none → undefined", () => {
  const root = mkdtempSync(join(tmpdir(), "rovecode-resume-"));
  try {
    expect(newestSession(root)).toBeUndefined();
    expect(resolveResume(argv("--continue"), root)).toBeUndefined();                     // nothing to continue: fresh
    const t = Date.now();
    new SessionStore(root, "older").append(user("first", t - 5_000));
    new SessionStore(root, "newer").append(user("second", t - 1_000));
    // a pre-fix leftover, newer than both by its meta timestamp, but empty
    mkdirSync(join(root, "hollow"));
    writeFileSync(join(root, "hollow", "meta.json"), JSON.stringify({ id: "hollow", createdAt: t + 60_000 }));
    new SessionStore(root, "opened-not-spoken");                                          // lazy: not even on disk
    expect(newestSession(root)?.id).toBe("newer");
    expect(resolveResume(argv("--continue"), root)).toBe("newer");
    expect(resolveResume(argv("--resume"), root)).toBe("newer");
    expect(resolveResume(argv("--resume", "older"), root)).toBe("older");                 // explicit wins
    expect(resolveResume(argv("--resume", "hollow"), root)).toBe("hollow");               // explicit even when empty: the user named it
    expect(resolveResume(argv(), root)).toBeUndefined();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
