import { test, expect, beforeAll, afterAll } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  VersionLedger, LEDGER_SUFFIX, DEFAULT_MAX_EDITS,
  type CommitResult, type RollbackResult,
} from "../../src/skills/versioned.ts";

// A UNIQUE root per process: the old fixed `rovecode-versioned-test` path was shared by every
// concurrent `bun test` (several worktrees run suites at once here) and beforeAll's rm -rf wiped
// another process's ledgers mid-test — the "version-conflict … current version 0" load flake.
const root = mkdtempSync(join(tmpdir(), "rovecode-versioned-"));
let caseId = 0;

/** Fresh target path per test so cases stay independent. */
function freshTarget(seed?: string): string {
  const dir = join(root, `case-${caseId++}`);
  mkdirSync(dir, { recursive: true });
  const target = join(dir, "SKILL.md");
  if (seed !== undefined) writeFileSync(target, seed);
  return target;
}

function mustOk(r: CommitResult | RollbackResult): asserts r is Extract<typeof r, { ok: true }> {
  if (!r.ok) throw new Error(`expected ok, got ${r.code}: ${r.message}`);
}

beforeAll(() => {
  mkdirSync(root, { recursive: true });
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

// ---------- version bump ----------

test("commit bumps version and records {baseVersion, before, after, reason, timestamp}", () => {
  const target = freshTarget("original\n");
  const ledger = new VersionLedger(target);
  expect(ledger.version()).toBe(0);

  const r1 = ledger.commit("v1 content\n", "first edit", 0, 1111);
  mustOk(r1);
  expect(r1.edit).toEqual({
    version: 1, baseVersion: 0, before: "original\n", after: "v1 content\n",
    reason: "first edit", timestamp: 1111,
  });
  expect(ledger.version()).toBe(1);
  expect(readFileSync(target, "utf8")).toBe("v1 content\n");

  const r2 = ledger.commit("v2 content\n", "second edit", 1, 2222);
  mustOk(r2);
  expect(r2.edit.version).toBe(2);
  expect(r2.edit.baseVersion).toBe(1);
  expect(r2.edit.before).toBe("v1 content\n");
  expect(ledger.version()).toBe(2);

  // sidecar lives beside the target, one JSONL line per edit
  const sidecar = target + LEDGER_SUFFIX;
  expect(ledger.ledgerPath).toBe(sidecar);
  expect(existsSync(sidecar)).toBe(true);
  const lines = readFileSync(sidecar, "utf8").trim().split("\n");
  expect(lines.length).toBe(2);
  expect(JSON.parse(lines[0]!).version).toBe(1);
  expect(JSON.parse(lines[1]!).version).toBe(2);
});

test("first commit on a missing target records before as empty string", () => {
  const target = freshTarget(); // file does not exist
  const ledger = new VersionLedger(target);
  const r = ledger.commit("hello", "create", 0);
  mustOk(r);
  expect(r.edit.before).toBe("");
  expect(readFileSync(target, "utf8")).toBe("hello");
});

// ---------- optimistic concurrency ----------

test("stale baseVersion is a typed reject with no partial write", () => {
  const target = freshTarget("base\n");
  const ledger = new VersionLedger(target);
  mustOk(ledger.commit("v1\n", "seed", 0));

  // two writers both read version 1; A lands first
  mustOk(ledger.commit("writer A\n", "A", 1));
  const ledgerBytes = readFileSync(ledger.ledgerPath);

  const rejected = ledger.commit("writer B\n", "B", 1);
  expect(rejected.ok).toBe(false);
  if (rejected.ok) throw new Error("unreachable");
  expect(rejected.code).toBe("version-conflict");
  expect(rejected.baseVersion).toBe(1);
  expect(rejected.currentVersion).toBe(2);

  // no partial write: target keeps A's content, ledger is byte-identical, version unchanged
  expect(readFileSync(target, "utf8")).toBe("writer A\n");
  expect(Buffer.compare(readFileSync(ledger.ledgerPath), ledgerBytes)).toBe(0);
  expect(ledger.version()).toBe(2);
  expect(ledger.history().length).toBe(2);
});

test("future baseVersion is also rejected", () => {
  const target = freshTarget("x");
  const ledger = new VersionLedger(target);
  const r = ledger.commit("y", "bad base", 5);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.code).toBe("version-conflict");
  expect(existsSync(ledger.ledgerPath)).toBe(false); // nothing was written at all
  expect(readFileSync(target, "utf8")).toBe("x");
});

// ---------- rollback ----------

test("rollback round-trip restores byte-exact content in one call", () => {
  const v1 = "alpha ßéta\r\nline two\n\n  trailing spaces  \n";
  const v2 = "completely different\n";
  const target = freshTarget("pristine-☃\n");
  const ledger = new VersionLedger(target);
  mustOk(ledger.commit(v1, "to v1", 0));
  mustOk(ledger.commit(v2, "to v2", 1));

  const rb = ledger.rollback(1);
  mustOk(rb);
  expect(rb.edit.version).toBe(3); // rollback is a new recorded edit
  expect(rb.edit.rollbackTo).toBe(1);
  expect(rb.edit.before).toBe(v2);
  expect(Buffer.compare(readFileSync(target), Buffer.from(v1, "utf8"))).toBe(0);

  // roll forward again to v2 content, then back to pristine version 0
  const fwd = ledger.rollback(2, "restore v2");
  mustOk(fwd);
  expect(Buffer.compare(readFileSync(target), Buffer.from(v2, "utf8"))).toBe(0);
  expect(fwd.edit.reason).toBe("restore v2");

  const rb0 = ledger.rollback(0);
  mustOk(rb0);
  expect(Buffer.compare(readFileSync(target), Buffer.from("pristine-☃\n", "utf8"))).toBe(0);
  expect(ledger.version()).toBe(5);
});

test("rollback to an unrecorded version is a typed reject and mutates nothing", () => {
  const target = freshTarget("a");
  const ledger = new VersionLedger(target);
  mustOk(ledger.commit("b", "edit", 0));

  const r = ledger.rollback(7);
  expect(r.ok).toBe(false);
  if (r.ok) throw new Error("unreachable");
  expect(r.code).toBe("unknown-version");
  expect(r.requested).toBe(7);
  expect(r.available).toEqual({ from: 0, to: 1 });
  expect(ledger.version()).toBe(1);
  expect(readFileSync(target, "utf8")).toBe("b");
});

// ---------- bounded snapshot count ----------

test("history is bounded: oldest evicted, versions stay monotonic, window rollbacks still work", () => {
  const target = freshTarget("v0");
  const ledger = new VersionLedger(target, { maxEdits: 3 });
  for (let i = 1; i <= 5; i++) {
    mustOk(ledger.commit(`v${i}`, `edit ${i}`, i - 1));
  }

  const hist = ledger.history();
  expect(hist.length).toBe(3); // bound enforced
  expect(hist.map((e) => e.version)).toEqual([3, 4, 5]); // oldest (1, 2) evicted
  expect(ledger.version()).toBe(5); // monotonic, unaffected by eviction
  const lines = readFileSync(ledger.ledgerPath, "utf8").trim().split("\n");
  expect(lines.length).toBe(3); // evicted from disk too

  // oldest retained record's `before` still restores version 2...
  expect(ledger.range()).toEqual({ from: 2, to: 5 });
  const rb = ledger.rollback(2);
  mustOk(rb);
  expect(readFileSync(target, "utf8")).toBe("v2");

  // ...but version 1 fell out of the window: typed reject
  const gone = ledger.rollback(1);
  expect(gone.ok).toBe(false);
  if (!gone.ok) {
    expect(gone.code).toBe("unknown-version");
    expect(gone.available).toEqual({ from: 3, to: 6 }); // rollback above evicted one more
  }
});

test("default bound is DEFAULT_MAX_EDITS", () => {
  const target = freshTarget("");
  const ledger = new VersionLedger(target);
  for (let i = 1; i <= DEFAULT_MAX_EDITS + 4; i++) {
    mustOk(ledger.commit(`v${i}`, "e", i - 1));
  }
  expect(ledger.history().length).toBe(DEFAULT_MAX_EDITS);
  expect(ledger.version()).toBe(DEFAULT_MAX_EDITS + 4);
});

// ---------- resilience + drift ----------

test("malformed ledger lines are skipped, never fatal (prime refinements.jsonl pattern)", () => {
  const target = freshTarget("t");
  const ledger = new VersionLedger(target);
  mustOk(ledger.commit("t1", "one", 0));
  appendFileSync(ledger.ledgerPath, "{not json\n", "utf8");
  appendFileSync(ledger.ledgerPath, JSON.stringify({ version: "bad-shape" }) + "\n", "utf8");

  expect(ledger.version()).toBe(1); // corrupt lines invisible
  const r = ledger.commit("t2", "two", 1);
  mustOk(r);
  expect(r.edit.version).toBe(2);
  expect(ledger.rollback(1).ok).toBe(true);
  expect(readFileSync(target, "utf8")).toBe("t1");
});

test("external edits are detected as drift and the next record stays truthful", () => {
  const target = freshTarget("start");
  const ledger = new VersionLedger(target);
  mustOk(ledger.commit("managed", "edit", 0));
  expect(ledger.drifted()).toBe(false);

  writeFileSync(target, "hand-edited"); // user edits the file directly
  expect(ledger.drifted()).toBe(true);

  const r = ledger.commit("next", "after drift", 1);
  mustOk(r);
  expect(r.edit.before).toBe("hand-edited"); // before = what was really on disk
  expect(ledger.drifted()).toBe(false);
});

// ---------- torn trailing append (crash mid-write) ----------

test("a torn trailing line without newline cannot swallow the next commit", () => {
  const target = freshTarget("t0");
  const ledger = new VersionLedger(target);
  mustOk(ledger.commit("t1", "one", 0));

  // crash shape 1: complete last record, trailing "\n" lost
  const whole = readFileSync(ledger.ledgerPath, "utf8");
  writeFileSync(ledger.ledgerPath, whole.slice(0, -1));
  expect(ledger.version()).toBe(1);
  mustOk(ledger.commit("t2", "two", 1));
  expect(ledger.version()).toBe(2); // the new commit is visible to history()/version()
  expect(ledger.history().map((e) => e.version)).toEqual([1, 2]);

  // crash shape 2: partial garbage with no newline
  appendFileSync(ledger.ledgerPath, '{"version":9,"basePart', "utf8");
  expect(ledger.version()).toBe(2); // torn line skipped, not fatal
  mustOk(ledger.commit("t3", "three", 2));
  expect(ledger.version()).toBe(3);
  expect(ledger.history().map((e) => e.version)).toEqual([1, 2, 3]);
  const rb = ledger.rollback(2);
  mustOk(rb);
  expect(readFileSync(target, "utf8")).toBe("t2");
});

// ---------- corruption holes: contentAt via `before`, range() honesty ----------

test("contentAt recovers a version from the successor's before when its own record is corrupted", () => {
  const target = freshTarget("v0");
  const ledger = new VersionLedger(target);
  for (let i = 1; i <= 3; i++) mustOk(ledger.commit(`v${i}`, `e${i}`, i - 1));

  // garble the record that PRODUCED version 2; v3.before still holds v2's content
  const lines = readFileSync(ledger.ledgerPath, "utf8").trim().split("\n");
  const damaged = lines.map((l) => (JSON.parse(l).version === 2 ? "{corrupt" : l));
  writeFileSync(ledger.ledgerPath, damaged.join("\n") + "\n");

  expect(ledger.contentAt(3)).toBe("v3"); // direct `after`
  expect(ledger.contentAt(2)).toBe("v2"); // recovered via v3.before
  expect(ledger.contentAt(0)).toBe("v0"); // recovered via v1.before
  expect(ledger.rollback(2).ok).toBe(true);
  expect(readFileSync(target, "utf8")).toBe("v2");
});

test("range() spans only the contiguous valid suffix, never a corruption hole", () => {
  const target = freshTarget("v0");
  const ledger = new VersionLedger(target);
  for (let i = 1; i <= 4; i++) mustOk(ledger.commit(`v${i}`, `e${i}`, i - 1));

  // hole: records v2 AND v3 lost → version 2 has neither an `after` nor a
  // successor's `before` left; a naive first..last span (0..4) would advertise it
  const lines = readFileSync(ledger.ledgerPath, "utf8").trim().split("\n");
  const kept = lines.filter((l) => { const v = JSON.parse(l).version; return v !== 2 && v !== 3; });
  writeFileSync(ledger.ledgerPath, kept.join("\n") + "\n");

  expect(ledger.range()).toEqual({ from: 3, to: 4 }); // contiguous suffix only
  const gone = ledger.rollback(2);
  expect(gone.ok).toBe(false);
  if (!gone.ok) expect(gone.available).toEqual({ from: 3, to: 4 });
  const rb = ledger.rollback(3); // advertised versions really restore (via v4.before)
  mustOk(rb);
  expect(readFileSync(target, "utf8")).toBe("v3");
});

// ---------- ouroboros / surface check ----------

test("module exposes no grader, eval, or auto-refine surface", async () => {
  const mod = await import("../../src/skills/versioned.ts");
  const names = Object.keys(mod).join(" ").toLowerCase();
  for (const banned of ["grade", "grader", "eval", "score", "reward", "autorefine", "refineloop"]) {
    expect(names).not.toContain(banned);
  }
});
