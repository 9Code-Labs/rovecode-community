import { test, expect } from "bun:test";
import { SessionStore, chainHash } from "../../src/core/session.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

function msg(text: string, parentId: string | null = null) {
  return { id: randomUUID(), role: "user" as const, parts: [{ kind: "text" as const, text }], parentId, createdAt: Date.now() };
}

test("session store appends and replays path", () => {
  const dir = mkdtempSync(join(tmpdir(), "aion-test-"));
  const s = new SessionStore(dir, "s1");
  const m1 = msg("hello", null);
  const m2 = msg("world", m1.id);
  s.append(m1); s.append(m2);
  const msgs = s.messages();
  expect(msgs.length).toBe(2);
  expect(msgs[0]!.parts[0]).toEqual({ kind: "text", text: "hello" });
  rmSync(dir, { recursive: true, force: true });
});

test("branch rewinds leaf without deleting", () => {
  const dir = mkdtempSync(join(tmpdir(), "aion-test-"));
  const s = new SessionStore(dir, "s2");
  const m1 = msg("a"); s.append(m1);
  const m2 = msg("b", m1.id); s.append(m2);
  const ok = s.branch(m1.id);
  expect(ok).toBe(true);
  expect(s.messages().length).toBe(1);
  // re-branch forward still possible (nothing deleted)
  expect(s.branch(m2.id)).toBe(true);
  expect(s.messages().length).toBe(2);
  rmSync(dir, { recursive: true, force: true });
});

test("reload detects malformed json corruption", () => {
  const dir = mkdtempSync(join(tmpdir(), "aion-test-"));
  const s = new SessionStore(dir, "s3");
  s.append(msg("x"));
  const f = join(dir, "s3", "entries.jsonl");
  const lines = require("node:fs").readFileSync(f, "utf8").split("\n").filter(Boolean);
  require("node:fs").writeFileSync(f, lines.join("\n") + "\nnot json\n");
  const s2 = new SessionStore(dir, "s3");
  const corrupt = s2.reload();
  expect(corrupt.some((c) => c.kind === "malformed-json")).toBe(true);
  rmSync(dir, { recursive: true, force: true });
});

test("chain hash is tamper-evident", () => {
  const m = msg("seed");
  const h1 = chainHash("", m as never);
  const h2 = chainHash("", { ...m, parts: [{ kind: "text", text: "tampered" }] } as never);
  expect(h1).not.toBe(h2);
});

// ── port #2: branch navigator + rewind (durable leaf, listSessions, turnPoints) ──

import { listSessions } from "../../src/core/session.ts";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";

function amsg(text: string, parentId: string | null) {
  return { id: randomUUID(), role: "assistant" as const, parts: [{ kind: "text" as const, text }], parentId, createdAt: Date.now() };
}

test("durable leaf round-trip: branch survives restart, appends chain off branched entry", () => {
  const dir = mkdtempSync(join(tmpdir(), "aion-test-"));
  const s1 = new SessionStore(dir, "d1");
  const a = msg("A", null); s1.append(a);
  const b = amsg("B", a.id); s1.append(b);
  const c = msg("C", b.id); s1.append(c);
  expect(s1.branch(b.id)).toBe(true);
  const meta = JSON.parse(readFileSync(join(dir, "d1", "meta.json"), "utf8"));
  expect(meta.leaf).toBe(b.id);

  const s2 = new SessionStore(dir, "d1");           // fresh instance, same dir
  expect(s2.path().at(-1)!.id).toBe(b.id);          // restored leaf = B, not last entry C
  const d = msg("D", b.id); s2.append(d);

  const lines = readFileSync(join(dir, "d1", "entries.jsonl"), "utf8").split("\n").filter(Boolean);
  const wd = JSON.parse(lines.at(-1)!);
  const wb = JSON.parse(lines[1]!);
  expect(wd.parentId).toBe(b.id);                   // D.parentId === B
  expect(wd.prevHash).toBe(wb.hash);                // D chains off B's hash, not C's

  const s3 = new SessionStore(dir, "d1");           // reload once more
  expect(s3.path().map((e) => e.id)).toEqual([a.id, b.id, d.id]);
  expect(s3.reload()).toEqual([]);                  // hash-chain replay: zero corruption findings
  rmSync(dir, { recursive: true, force: true });
});

test("legacy meta.json without leaf: leaf = last entry (behavior unchanged)", () => {
  const dir = mkdtempSync(join(tmpdir(), "aion-test-"));
  const s = new SessionStore(dir, "d2");
  const m1 = msg("a"); s.append(m1);
  const m2 = amsg("b", m1.id); s.append(m2);
  const meta = JSON.parse(readFileSync(join(dir, "d2", "meta.json"), "utf8"));
  expect("leaf" in meta).toBe(false);               // appends alone never add a leaf field
  const s2 = new SessionStore(dir, "d2");
  expect(s2.path().at(-1)!.id).toBe(m2.id);
  rmSync(dir, { recursive: true, force: true });
});

test("persisted leaf pointing at unknown id falls back to last entry without throwing", () => {
  const dir = mkdtempSync(join(tmpdir(), "aion-test-"));
  const s = new SessionStore(dir, "d3");
  const m1 = msg("a"); s.append(m1);
  const m2 = amsg("b", m1.id); s.append(m2);
  const metaP = join(dir, "d3", "meta.json");
  const meta = JSON.parse(readFileSync(metaP, "utf8"));
  meta.leaf = "deleted-entry-id";
  writeFileSync(metaP, JSON.stringify(meta, null, 2));
  const s2 = new SessionStore(dir, "d3");           // must not throw
  expect(s2.path().at(-1)!.id).toBe(m2.id);
  rmSync(dir, { recursive: true, force: true });
});

test("listSessions: sorted updatedAt desc, previews single-line ≤80, garbage skipped", () => {
  const root = mkdtempSync(join(tmpdir(), "aion-test-"));
  const t = Date.now();
  const mk = (id: string, at: number, text: string) => {
    const s = new SessionStore(root, id);
    s.append({ id: randomUUID(), role: "user" as const, parts: [{ kind: "text" as const, text }], parentId: null, createdAt: at });
  };
  mk("sa", t + 1000, "first question");
  mk("sb", t + 3000, "multi\nline " + "L".repeat(200));
  mk("sc", t + 2000, "third");
  mkdirSync(join(root, "garbage"));
  writeFileSync(join(root, "garbage", "junk.txt"), "not a session");
  mkdirSync(join(root, "hollow"));                  // empty dir, no meta.json
  const list = listSessions(root);
  expect(list.length).toBe(3);
  expect(list.map((x) => x.id)).toEqual(["sb", "sc", "sa"]);
  expect(list[0]!.updatedAt).toBe(t + 3000);
  expect(list[0]!.entryCount).toBe(1);
  expect(list[0]!.preview.includes("\n")).toBe(false);
  expect(list[0]!.preview.length).toBe(80);         // truncated at 80
  expect(list[0]!.preview.startsWith("multi line L")).toBe(true);
  expect(list[2]!.preview).toBe("first question");
  rmSync(root, { recursive: true, force: true });
});

test("turnPoints: active-path user turns with 1-based index, parentId, branch counts", () => {
  const dir = mkdtempSync(join(tmpdir(), "aion-test-"));
  const s = new SessionStore(dir, "d5");
  const u1 = msg("U1", null); s.append(u1);
  const a1 = amsg("A1", u1.id); s.append(a1);
  const u2 = msg("U2", a1.id); s.append(u2);
  const a2 = amsg("A2", u2.id); s.append(a2);
  expect(s.branch(a1.id)).toBe(true);               // rewind to A1
  const u2b = msg("U2b", a1.id); s.append(u2b);     // sibling of the abandoned U2
  const pts = s.turnPoints();
  expect(pts.length).toBe(2);
  expect(pts[0]!.entryId).toBe(u1.id);
  expect(pts[0]!.index).toBe(1);
  expect(pts[0]!.text).toBe("U1");
  expect(pts[0]!.parentId).toBe(null);              // root turn's actual parent
  expect(pts[0]!.branches).toBe(0);                 // linear point
  expect(pts[1]!.entryId).toBe(u2b.id);
  expect(pts[1]!.index).toBe(2);
  expect(pts[1]!.text).toBe("U2b");
  expect(pts[1]!.parentId).toBe(a1.id);             // actual parent entry
  expect(pts[1]!.branches).toBe(1);                 // the abandoned U2 sibling
  rmSync(dir, { recursive: true, force: true });
});

test("hash chain valid after restart → branch → append: zero corruption, per-entry hashes verify", () => {
  const dir = mkdtempSync(join(tmpdir(), "aion-test-"));
  const s1 = new SessionStore(dir, "d6");
  const a = msg("A", null); s1.append(a);
  const b = amsg("B", a.id); s1.append(b);
  const c = msg("C", b.id); s1.append(c);
  s1.branch(b.id);
  const s2 = new SessionStore(dir, "d6");
  s2.append(msg("D", b.id));
  const s3 = new SessionStore(dir, "d6");
  expect(s3.reload()).toEqual([]);                  // full reload: zero corruption findings
  const lines = readFileSync(join(dir, "d6", "entries.jsonl"), "utf8").split("\n").filter(Boolean);
  expect(lines.length).toBe(4);
  for (const line of lines) {
    const w = JSON.parse(line);
    expect(chainHash(w.prevHash, { ...w, hash: "" })).toBe(w.hash); // tamper-evident chain intact
  }
  rmSync(dir, { recursive: true, force: true });
});
