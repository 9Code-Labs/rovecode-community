/** Wave-2 fixes for port #2 (MED-1b + LOW-4 fixtures):
 *  - append() must chain prevHash off the SUPPLIED parentId's entry, never a moved leaf
 *  - reload() must detect parent/prevHash disagreement ("chain-broken")
 *  - listSessions() must skip bad-shape meta, survive bad JSONL, and never trust meta.id */

import { test, expect } from "bun:test";
import { SessionStore, listSessions, chainHash } from "../../src/core/session.ts";
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

function msg(text: string, parentId: string | null, role: "user" | "assistant" = "user") {
  return { id: randomUUID(), role, parts: [{ kind: "text" as const, text }], parentId, createdAt: Date.now() };
}

// ── MED-1b: explicit parentId must drive the hash chain ──

test("append after a leaf move chains prevHash off the SUPPLIED parent, not the moved leaf", () => {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-chain-"));
  const s = new SessionStore(dir, "c1");
  const a = msg("A", null); s.append(a);
  const b = msg("B", a.id, "assistant"); s.append(b);
  // leaf moves back to A (what /new or /rewind does) while a run still holds B as its tail
  expect(s.branch(a.id)).toBe(true);
  const c = msg("C", b.id); s.append(c); // mid-run append: parentId points at B
  const lines = readFileSync(join(dir, "c1", "entries.jsonl"), "utf8").split("\n").filter(Boolean);
  const wb = JSON.parse(lines[1]!);
  const wc = JSON.parse(lines[2]!);
  expect(wc.parentId).toBe(b.id);
  expect(wc.prevHash).toBe(wb.hash);            // chains off B (the parent), NOT off A (the moved leaf)
  expect(new SessionStore(dir, "c1").reload()).toEqual([]); // tree and chain agree
  rmSync(dir, { recursive: true, force: true });
});

test("append with parentId null (new root) chains off the empty hash", () => {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-chain-"));
  const s = new SessionStore(dir, "c2");
  const a = msg("A", null); s.append(a);
  const b = msg("B", a.id, "assistant"); s.append(b);
  const r = msg("R", null); s.append(r);        // second root while leaf sits at B
  const lines = readFileSync(join(dir, "c2", "entries.jsonl"), "utf8").split("\n").filter(Boolean);
  const wr = JSON.parse(lines[2]!);
  expect(wr.parentId).toBe(null);
  expect(wr.prevHash).toBe("");                 // roots chain off "", never off the old leaf
  expect(new SessionStore(dir, "c2").reload()).toEqual([]);
  rmSync(dir, { recursive: true, force: true });
});

test("reload flags chain-broken when prevHash disagrees with the parent's hash", () => {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-chain-"));
  const s = new SessionStore(dir, "c3");
  const a = msg("A", null); s.append(a);
  const b = msg("B", a.id, "assistant"); s.append(b);
  const lines = readFileSync(join(dir, "c3", "entries.jsonl"), "utf8").split("\n").filter(Boolean);
  const wb = JSON.parse(lines[1]!);
  // exactly what the old buggy writer produced: parentId → A, prevHash → moved-leaf B
  const evil = { id: randomUUID(), parentId: a.id, createdAt: Date.now(), prevHash: wb.hash, hash: "", entry: msg("X", a.id) };
  evil.hash = chainHash(evil.prevHash, evil);
  appendFileSync(join(dir, "c3", "entries.jsonl"), JSON.stringify(evil) + "\n");
  const corrupt = new SessionStore(dir, "c3").reload();
  expect(corrupt.some((c) => c.kind === "chain-broken" && c.entryId === evil.id)).toBe(true);
  expect(corrupt.some((c) => c.kind === "orphan-entry")).toBe(false); // linkage, not orphanhood
  rmSync(dir, { recursive: true, force: true });
});

test("reload flags chain-broken for a root entry with a non-empty prevHash", () => {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-chain-"));
  const s = new SessionStore(dir, "c4");
  const a = msg("A", null); s.append(a);
  const la = readFileSync(join(dir, "c4", "entries.jsonl"), "utf8").split("\n").filter(Boolean)[0]!;
  const wa = JSON.parse(la);
  const evil = { id: randomUUID(), parentId: null, createdAt: Date.now(), prevHash: wa.hash, hash: "", entry: msg("R", null) };
  evil.hash = chainHash(evil.prevHash, evil);
  appendFileSync(join(dir, "c4", "entries.jsonl"), JSON.stringify(evil) + "\n");
  const corrupt = new SessionStore(dir, "c4").reload();
  expect(corrupt.some((c) => c.kind === "chain-broken" && c.entryId === evil.id)).toBe(true);
  rmSync(dir, { recursive: true, force: true });
});

test("orphan parents do not double-report as chain-broken", () => {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-chain-"));
  const s = new SessionStore(dir, "c5");
  s.append(msg("A", null));
  const orphan = { id: randomUUID(), parentId: "no-such-entry", createdAt: Date.now(), prevHash: "whatever", hash: "", entry: msg("O", "no-such-entry") };
  orphan.hash = chainHash(orphan.prevHash, orphan);
  appendFileSync(join(dir, "c5", "entries.jsonl"), JSON.stringify(orphan) + "\n");
  const corrupt = new SessionStore(dir, "c5").reload();
  expect(corrupt.some((c) => c.kind === "orphan-entry" && c.entryId === orphan.id)).toBe(true);
  expect(corrupt.some((c) => c.kind === "chain-broken")).toBe(false);
  rmSync(dir, { recursive: true, force: true });
});

// ── LOW-4: listSessions guard fixtures ──

test("listSessions skips bad-shape meta.json (array, string, wrong field types)", () => {
  const root = mkdtempSync(join(tmpdir(), "rovecode-ls-"));
  const good = new SessionStore(root, "good-one");
  good.append(msg("real question", null));
  for (const [name, content] of [
    ["shape-array", "[1,2,3]"],
    ["shape-string", "\"just a string\""],
    ["shape-types", JSON.stringify({ id: 42, createdAt: "not-a-number" })],
    ["shape-null", "null"],
  ] as const) {
    mkdirSync(join(root, name));
    writeFileSync(join(root, name, "meta.json"), content);
  }
  const list = listSessions(root);
  expect(list.map((s) => s.id)).toEqual(["good-one"]);
  rmSync(root, { recursive: true, force: true });
});

test("listSessions survives bad JSONL lines and counts only object entries", () => {
  const root = mkdtempSync(join(tmpdir(), "rovecode-ls-"));
  const s = new SessionStore(root, "noisy");
  s.append(msg("only valid entry", null));
  appendFileSync(join(root, "noisy", "entries.jsonl"), "not json at all\n42\n\"bare string\"\n");
  const list = listSessions(root);
  expect(list.length).toBe(1);
  expect(list[0]!.entryCount).toBe(1);          // garbage lines are skipped, not counted
  expect(list[0]!.preview).toBe("only valid entry");
  rmSync(root, { recursive: true, force: true });
});

test("listSessions reports the DIRECTORY name, never a lying meta.id", () => {
  const root = mkdtempSync(join(tmpdir(), "rovecode-ls-"));
  const s = new SessionStore(root, "honest-dir");
  s.append(msg("hi", null));
  const metaP = join(root, "honest-dir", "meta.json");
  const meta = JSON.parse(readFileSync(metaP, "utf8"));
  meta.id = "../../escaped";                    // tampered/copied meta must not redirect resume
  writeFileSync(metaP, JSON.stringify(meta));
  const list = listSessions(root);
  expect(list.length).toBe(1);
  expect(list[0]!.id).toBe("honest-dir");
  rmSync(root, { recursive: true, force: true });
});
