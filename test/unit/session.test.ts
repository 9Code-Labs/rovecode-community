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

// ── port #34: image parts — sidecar persistence, staging, export ──

import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { imageFromBytes, imageData } from "../../src/core/images.ts";
import { exportSession } from "../../src/cli/export.ts";
import type { ImagePart, Message } from "../../src/core/types.ts";
import { PNG_1x1, PNG_1x1_B64 } from "../fixtures/images.ts";

const PNG_SHA = createHash("sha256").update(PNG_1x1).digest("hex");
function dot(): ImagePart { const r = imageFromBytes(PNG_1x1, { name: "dot.png" }); if ("error" in r) throw new Error(r.error); return r; }
function imsg(text: string, img: ImagePart, parentId: string | null = null) {
  return { id: randomUUID(), role: "user" as const, parts: [{ kind: "text" as const, text }, img], parentId, createdAt: Date.now() };
}

test("image round-trip: sidecar on disk, JSONL carries a relative path and NO bytes, in-memory parts resolve to the absolute path, bytes read back identical, chain intact", () => {
  const dir = mkdtempSync(join(tmpdir(), "aion-test-"));
  const s = new SessionStore(dir, "img1");
  const img = dot();
  const m = imsg("look", img);
  s.append(m);
  const sidecar = join(dir, "img1", "attachments", `${PNG_SHA}.png`);
  expect(existsSync(sidecar)).toBe(true);
  expect(Buffer.compare(readFileSync(sidecar), PNG_1x1)).toBe(0);
  const raw = readFileSync(join(dir, "img1", "entries.jsonl"), "utf8");
  expect(raw.includes(PNG_1x1_B64)).toBe(false);                    // the JSONL stays small
  const w = JSON.parse(raw.trim());
  expect(w.entry.parts[1]).toEqual({ kind: "image", mime: "image/png", path: `attachments/${PNG_SHA}.png`, width: 1, height: 1, name: "dot.png" });
  expect(chainHash(w.prevHash, { ...w, hash: "" })).toBe(w.hash);     // the chain covers the persisted (path) form
  expect(m.parts[1]).toBe(img);                                     // the caller's object is untouched (its inline bytes serve this run)
  for (const store of [s, new SessionStore(dir, "img1")]) {         // fresh cache and a reload agree
    const part = store.messages()[0]!.parts[1] as ImagePart;
    expect(part.path).toBe(sidecar);
    expect(part.bytes).toBeUndefined();
    expect(imageData(part)).toBe(PNG_1x1_B64);
  }
  expect(new SessionStore(dir, "img1").reload()).toEqual([]);
  // the same image attached again is the same content-addressed file
  s.append(imsg("again", dot(), m.id));
  expect(readdirSync(join(dir, "img1", "attachments"))).toEqual([`${PNG_SHA}.png`]);
  rmSync(dir, { recursive: true, force: true });
});

test("aion export --json of a session with an image is still a byte-verbatim copy of entries.jsonl (the attachments dir is not bundled)", () => {
  const root = mkdtempSync(join(tmpdir(), "aion-test-"));
  const out = mkdtempSync(join(tmpdir(), "aion-test-out-"));
  const s = new SessionStore(root, "imgexp");
  s.append(imsg("look", dot()));
  const src = readFileSync(join(root, "imgexp", "entries.jsonl"));
  const res = exportSession(root, "imgexp", { json: true, cwd: out });
  expect(res.format).toBe("jsonl");
  const copied = readFileSync(res.path);
  expect(Buffer.compare(copied, src)).toBe(0);
  expect(readdirSync(out)).toEqual(["imgexp.jsonl"]);
  expect(JSON.parse(copied.toString("utf8").trim()).entry.parts[1].path).toBe(`attachments/${PNG_SHA}.png`); // export references, does not carry, the bytes
  rmSync(root, { recursive: true, force: true }); rmSync(out, { recursive: true, force: true });
});

test("stageAttachments: a system entry leaves the stage alone; the next USER append gets the parts folded IN PLACE (the loop's history object), persisted as a sidecar, then the stage is empty", () => {
  const dir = mkdtempSync(join(tmpdir(), "aion-test-"));
  const s = new SessionStore(dir, "img3");
  const img = dot();
  s.stageAttachments([img]);
  expect(s.stagedAttachments.length).toBe(1);
  const sys = { id: randomUUID(), role: "system" as const, parts: [{ kind: "text" as const, text: "<mode_notice>plan</mode_notice>" }], parentId: null, createdAt: Date.now() };
  s.append(sys);                                                    // e.g. flushModeSwitch before the run
  expect(sys.parts.length).toBe(1);
  expect(s.stagedAttachments.length).toBe(1);
  // the loop's userMsg (loop.ts:116-120): text only, built from the goal
  const u: Message = { id: randomUUID(), role: "user", parts: [{ kind: "text", text: "describe" }], parentId: sys.id, createdAt: Date.now() };
  s.append(u);
  expect(u.parts.length).toBe(2);
  expect(u.parts[1]).toBe(img);                                     // same object → the loop's in-memory history carries it
  expect(s.stagedAttachments.length).toBe(0);
  const back = new SessionStore(dir, "img3").messages();
  expect(back.map((e) => e.parts.map((p) => p.kind))).toEqual([["text"], ["text", "image"]]);
  expect(existsSync(join(dir, "img3", "attachments", `${PNG_SHA}.png`))).toBe(true);
  s.append(msg("plain", u.id));                                     // nothing staged → nothing folded
  expect(new SessionStore(dir, "img3").messages().at(-1)!.parts.length).toBe(1);
  rmSync(dir, { recursive: true, force: true });
});

test("sidecar write failure keeps the image inline in the JSONL — nothing dropped, the round-trip still reads back", () => {
  const dir = mkdtempSync(join(tmpdir(), "aion-test-"));
  const s = new SessionStore(dir, "img4");
  writeFileSync(join(dir, "img4", "attachments"), "a file where the directory should be");
  s.append(imsg("look", dot()));
  const w = JSON.parse(readFileSync(join(dir, "img4", "entries.jsonl"), "utf8").trim());
  expect(w.entry.parts[1].bytes).toBe(PNG_1x1_B64);
  expect(w.entry.parts[1].path).toBeUndefined();
  const back = new SessionStore(dir, "img4").messages()[0]!.parts[1] as ImagePart;
  expect(imageData(back)).toBe(PNG_1x1_B64);
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
