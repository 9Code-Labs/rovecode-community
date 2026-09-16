/** `rovecode --resume <x>` / `--continue` at boot (cli/resume.ts resolveBoot, 2026-09-07): a typed id that is unknown,
 *  ambiguous or malformed is REFUSED through `fail` (main.ts: exit 2, one stderr line) instead of opening a new session
 *  under that name; a unique prefix becomes the full id; nothing to continue from starts fresh WITH the note the
 *  startup card shows. Nothing here creates a directory. */

import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { SessionStore } from "../../src/core/session.ts";
import { NOTHING_TO_CONTINUE, resolveBoot, resolveResume } from "../../src/cli/resume.ts";

const user = (text: string, at: number) => ({ id: randomUUID(), role: "user" as const, parts: [{ kind: "text" as const, text }], parentId: null, createdAt: at });
const argv = (...a: string[]) => ["bun", "main.ts", ...a];
const fail = (msg: string): never => { throw new Error(msg); };

test("resolveBoot: unique prefix → the full id; exact id; unknown / ambiguous / malformed → refused with the reason, and no directory appears", () => {
  const root = mkdtempSync(join(tmpdir(), "rovecode-boot-"));
  try {
    const t = Date.now();
    new SessionStore(root, "alpha-one").append(user("a", t - 5_000));
    new SessionStore(root, "alpha-two").append(user("b", t - 4_000));
    new SessionStore(root, "beta").append(user("c", t - 1_000));
    expect(resolveBoot(argv("--resume", "beta"), root, fail)).toEqual({ id: "beta" });
    expect(resolveBoot(argv("--resume", "alpha-o"), root, fail)).toEqual({ id: "alpha-one" });
    expect(() => resolveBoot(argv("--resume", "alpha"), root, fail)).toThrow(/^--resume: "alpha" matches 2 sessions: .* — be more specific$/);
    expect(() => resolveBoot(argv("--resume", "typo"), root, fail)).toThrow(`--resume: no session matching "typo" in ${root} (rovecode sessions lists them)`); // used to open a new session named "typo", silently
    expect(() => resolveBoot(argv("--resume", "../x"), root, fail)).toThrow(/--resume: session id "..\/x" is not a plain directory name/);
    expect(() => resolveBoot(argv("--resume", ""), root, fail)).toThrow("--resume: session id is empty");
    expect(readdirSync(root).sort()).toEqual(["alpha-one", "alpha-two", "beta"]);
    expect(resolveResume(argv("--resume", "alpha-t"), root, fail)).toBe("alpha-two");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("--continue / bare --resume: the newest session that holds something; with nothing to continue from, no id and THE note; a hollow directory (meta only) is not a place to continue from but IS resumable by its exact id", () => {
  const root = mkdtempSync(join(tmpdir(), "rovecode-boot-"));
  try {
    expect(resolveBoot(argv("--continue"), root, fail)).toEqual({ note: NOTHING_TO_CONTINUE });
    expect(resolveBoot(argv("--resume"), root, fail)).toEqual({ note: NOTHING_TO_CONTINUE });
    expect(resolveBoot(argv(), root, fail)).toEqual({});
    expect(NOTHING_TO_CONTINUE).toBe("nothing to continue from — this is a new session");
    mkdirSync(join(root, "hollow"));
    writeFileSync(join(root, "hollow", "meta.json"), JSON.stringify({ id: "hollow", createdAt: Date.now() + 60_000 }));
    expect(resolveBoot(argv("--continue"), root, fail)).toEqual({ note: NOTHING_TO_CONTINUE }); // hollow ≠ something to continue
    expect(resolveBoot(argv("--resume", "hollow"), root, fail)).toEqual({ id: "hollow" });        // the user named it: it opens
    new SessionStore(root, "spoken").append(user("hi", Date.now()));
    expect(resolveBoot(argv("--continue"), root, fail)).toEqual({ id: "spoken" });
    expect(readdirSync(root).sort()).toEqual(["hollow", "spoken"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
