/** ONE session-id validator (core/session-id.ts) behind every id-consuming entry point (aion hygiene h2, 2026-09-07).
 *  The rule: a session id is a plain directory name — not empty, not `.`/`..`, no `/` or `\` on any platform. Routed
 *  through `rovecode export` (cli/export.ts, before the listing), the CLI gate for `--resume` and `rovecode trace`
 *  (cli/session-arg.ts) and every `sessions` verb (core/session-ops.ts resolveSession). MUTATION TARGETS: accept a
 *  separator or `..` in isPlainSessionId → the table fails; drop the export check → the export row lists instead of
 *  refusing; resolveSessionArg returning the first of several matches → the ambiguity row fails. */

import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { describeBadSessionId, isPlainSessionId } from "../../src/core/session-id.ts";
import { resolveSession } from "../../src/core/session-ops.ts";
import { SessionStore } from "../../src/core/session.ts";
import { exportSession } from "../../src/cli/export.ts";
import { resolveSessionArg, sessionIdArg } from "../../src/cli/session-arg.ts";

const BAD = ["", "  ", ".", "..", "../escape", "..\\escape", "a/b", "a\\b", "/abs", "C:\\x", "a/../b", "sessions/.."];
const GOOD = ["abc", "e2e-fixed-id", "..x", "x..", "a.b", "1a2b3c4d-0000-4000-8000-000000000000", "a b", "-dash"];
const fail = (msg: string): never => { throw new Error(msg); };

test("isPlainSessionId: the table — every traversal / separator / empty / dot form is refused, plain names pass; describeBadSessionId words the refusal and is undefined for a good id", () => {
  for (const id of BAD) expect([id, isPlainSessionId(id)]).toEqual([id, false]);
  for (const id of GOOD) expect([id, isPlainSessionId(id)]).toEqual([id, true]);
  expect(describeBadSessionId("")).toBe("session id is empty");
  expect(describeBadSessionId("   ")).toBe("session id is empty");
  expect(describeBadSessionId("../escape")).toBe('session id "../escape" is not a plain directory name (no / or \\, not . or ..)');
  expect(describeBadSessionId("..")).toContain("not a plain directory name");
  for (const id of GOOD) expect([id, describeBadSessionId(id)]).toEqual([id, undefined]);
});

test("rovecode export <bad id>: exportSession refuses before the listing (usage in the message) and creates nothing; a bad id never reaches SessionStore", () => {
  const outer = mkdtempSync(join(tmpdir(), "rovecode-h2-export-"));
  try {
    const root = join(outer, "sessions");
    mkdirSync(root);
    new SessionStore(root, "abc-one").append({ id: randomUUID(), role: "user", parts: [{ kind: "text", text: "hello" }], parentId: null, createdAt: Date.now() }); // one real session, so a listing WOULD have something to match
    for (const id of ["../escape", "..", ".", "a/b", "a\\b", "   "]) {
      expect(() => exportSession(root, id, { cwd: outer }), id).toThrow(/not a plain directory name|session id is empty/);
      expect(() => exportSession(root, id, { cwd: outer }), id).toThrow(/usage: rovecode export/);
    }
    expect(() => exportSession(root, "", { cwd: outer })).toThrow(/^usage: rovecode export/); // the pre-existing empty rule
    expect(readdirSync(outer).sort()).toEqual(["sessions"]);   // no export file, no escaped dir
    expect(readdirSync(root)).toEqual(["abc-one"]);            // no session dir named after a bad id
  } finally { rmSync(outer, { recursive: true, force: true }); }
});

test("cli/session-arg.ts: sessionIdArg refuses a missing / empty / traversal value through `fail`; resolveSessionArg resolves an exact id or a UNIQUE prefix and refuses an ambiguous or unknown one (never the first hit, never a new dir) — the rule --resume and trace share", () => {
  const outer = mkdtempSync(join(tmpdir(), "rovecode-h2-arg-"));
  try {
    const root = join(outer, "sessions");
    mkdirSync(root);
    for (const id of ["zz-one", "zz-two", "yy-three"]) {
      const s = new SessionStore(root, id);
      s.append({ id: randomUUID(), role: "user", parts: [{ kind: "text", text: `hello ${id}` }], parentId: null, createdAt: Date.now() });
    }
    expect(() => sessionIdArg("--resume", undefined, fail)).toThrow("--resume needs a session id or prefix");
    expect(() => sessionIdArg("--resume", "", fail)).toThrow("--resume: session id is empty");
    expect(() => sessionIdArg("--resume", "../escape", fail)).toThrow('--resume: session id "../escape" is not a plain directory name');
    expect(sessionIdArg("--resume", "brand-new", fail)).toBe("brand-new"); // validity only — resolution is the next step
    expect(resolveSessionArg("rovecode trace", root, "zz-two", fail)).toBe("zz-two");     // exact id beats its own prefix matches
    expect(resolveSessionArg("rovecode trace", root, "yy", fail)).toBe("yy-three");      // unique prefix
    expect(() => resolveSessionArg("rovecode trace", root, "zz", fail)).toThrow(/rovecode trace: "zz" matches 2 sessions: .* — be more specific/); // MUTATION TARGET: first hit
    expect(() => resolveSessionArg("rovecode trace", root, "nope", fail)).toThrow(`rovecode trace: no session matching "nope" in ${root} (rovecode sessions lists them)`);
    expect(() => resolveSessionArg("--resume", root, "brand-new", fail)).toThrow(/--resume: no session matching "brand-new"/); // the typed-id-creates-a-session affordance is gone
    expect(() => resolveSessionArg("rovecode trace", root, "../escape", fail)).toThrow(/not a plain directory name/);
    expect(() => resolveSessionArg("rovecode trace", root, undefined, fail)).toThrow("rovecode trace needs a session id or prefix");
    // the core resolver says the same things without the CLI's `what` prefix
    expect(resolveSession(root, "../escape")).toEqual({ ok: false, error: 'session id "../escape" is not a plain directory name (no / or \\, not . or ..)' });
    expect(resolveSession(root, "")).toEqual({ ok: false, error: "a session id or prefix is required" });
    expect(readdirSync(root).sort()).toEqual(["yy-three", "zz-one", "zz-two"]); // resolution created nothing
    expect(readdirSync(outer)).toEqual(["sessions"]);
  } finally { rmSync(outer, { recursive: true, force: true }); }
});
