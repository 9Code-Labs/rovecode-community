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
  const dir = mkdtempSync(join(tmpdir(), "rovecode-test-"));
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
  const dir = mkdtempSync(join(tmpdir(), "rovecode-test-"));
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
  const dir = mkdtempSync(join(tmpdir(), "rovecode-test-"));
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
  const dir = mkdtempSync(join(tmpdir(), "rovecode-test-"));
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
  const dir = mkdtempSync(join(tmpdir(), "rovecode-test-"));
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
  const dir = mkdtempSync(join(tmpdir(), "rovecode-test-"));
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
  const root = mkdtempSync(join(tmpdir(), "rovecode-test-"));
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
  const dir = mkdtempSync(join(tmpdir(), "rovecode-test-"));
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
  const dir = mkdtempSync(join(tmpdir(), "rovecode-test-"));
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

test("rovecode export --json of a session with an image is still a byte-verbatim copy of entries.jsonl (the attachments dir is not bundled)", () => {
  const root = mkdtempSync(join(tmpdir(), "rovecode-test-"));
  const out = mkdtempSync(join(tmpdir(), "rovecode-test-out-"));
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
  const dir = mkdtempSync(join(tmpdir(), "rovecode-test-"));
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
  const dir = mkdtempSync(join(tmpdir(), "rovecode-test-"));
  const s = new SessionStore(dir, "img4");
  mkdirSync(join(dir, "img4"), { recursive: true }); // the store creates its directory with the first entry, so plant the obstacle first
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
  const dir = mkdtempSync(join(tmpdir(), "rovecode-test-"));
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

// ── port #34 hardening (wiring pass): F1 corrupt-shape tolerance, F2 sidecar path confinement ──

import { appendFileSync } from "node:fs";
import { entryShape } from "../../src/core/session.ts";
import { toAnthropicMessages } from "../../src/providers/wire-messages.ts";

/** Hand-write a chain-consistent wrapped line after `prev`, so ONLY the entry shape/paths are wrong. */
function wrap(prev: { id: string; hash: string }, id: string, entry: unknown) {
  const w = { id, parentId: prev.id, createdAt: 1, prevHash: prev.hash, hash: "", entry };
  w.hash = chainHash(prev.hash, w);
  return w;
}

test("F1 (ADR-004): foreign/corrupt entry shapes — entry null, a scalar entry, parts:[null], parts not an array, a bare {} and a scalar LINE — load without throwing, are reported as unknown-shape, and messages()/turnPoints()/path()/listSessions carry on with the good entry (9261dc1: the constructor threw TypeError from hydrateImages; c4ac431: loaded, but messages() threw on the null entry)", () => {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-test-"));
  const s = new SessionStore(dir, "shapes");
  const good = msg("good"); s.append(good);
  const f = join(dir, "shapes", "entries.jsonl");
  const lines = readFileSync(f, "utf8").split("\n").filter(Boolean);
  let prev = JSON.parse(lines[0]!) as { id: string; hash: string };
  const foreign: unknown[] = [null, 5, { role: "user", parts: [null] }, { role: "user", parts: "nope" }, {}];
  foreign.forEach((entry, i) => { const w = wrap(prev, `f${i}`, entry); lines.push(JSON.stringify(w)); prev = w; });
  lines.push("7"); // a scalar LINE: valid JSON, not an entry object
  writeFileSync(f, lines.join("\n") + "\n");

  const s2 = new SessionStore(dir, "shapes");                       // must not throw
  const corrupt = s2.reload();
  expect(corrupt.map((c) => [c.kind, c.entryId ?? c.line])).toEqual([
    ["unknown-shape", "f0"], ["unknown-shape", "f1"], ["unknown-shape", "f2"], ["unknown-shape", "f3"], ["unknown-shape", "f4"], ["unknown-shape", 6],
  ]);
  expect(s2.messages().map((m) => m.parts)).toEqual([[{ kind: "text", text: "good" }]]);
  expect(s2.turnPoints().map((t) => t.text)).toEqual(["good"]);
  expect(s2.path().length).toBe(1);
  expect(listSessions(dir).find((x) => x.id === "shapes")?.preview).toBe("good");
  // still appendable: the loop parents on the last GOOD message and the chain follows that parent
  s2.append(msg("after", good.id));
  expect(new SessionStore(dir, "shapes").messages().map((m) => (m.parts[0] as { text: string }).text)).toEqual(["good", "after"]);
  // the predicate itself
  expect(entryShape({ role: "user", parts: [{ kind: "text", text: "x" }] })).toBe("message");
  expect(entryShape({ kind: "event", event: { type: "steer", text: "t" } })).toBe("event");
  for (const bad of [null, 5, "x", {}, { role: "user" }, { role: "user", parts: [null] }, { role: "user", parts: [{}] }, { role: "user", parts: "x" }]) expect(entryShape(bad)).toBeUndefined();
  rmSync(dir, { recursive: true, force: true });
});

test("F2: a persisted image path hydrates ONLY as attachments/<file> — `../outside.png` (a real PNG next to the session dir that the old join resolved to), attachments/../x.png, a nested path, a backslash form, `attachments/..` and `attachments/` stay unhydrated → imageData declines them → the wire sends placeholders; the canonical form still resolves", () => {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-test-"));
  writeFileSync(join(dir, "outside.png"), PNG_1x1);                 // readable PNG OUTSIDE the session dir (= join(sessionDir, "../outside.png"))
  const s = new SessionStore(dir, "f2");
  s.append(imsg("ok", dot()));
  const f = join(dir, "f2", "entries.jsonl");
  const first = JSON.parse(readFileSync(f, "utf8").trim()) as { id: string; hash: string };
  const bad = ["../outside.png", "attachments/../outside.png", "attachments/sub/x.png", "attachments\\..\\x.png", "attachments/..", "attachments/"];
  const parts = bad.map((path, i) => ({ kind: "image", mime: "image/png", path, name: `b${i}.png` }));
  appendFileSync(f, JSON.stringify(wrap(first, "f2-bad", { id: "f2-bad", role: "user", parts, parentId: first.id, createdAt: 1 })) + "\n");

  const s2 = new SessionStore(dir, "f2");
  expect(s2.reload()).toEqual([]);                                   // well-formed lines: the PATHS are the problem, not the shape
  const [okMsg, badMsg] = s2.messages();
  expect((okMsg!.parts[1] as ImagePart).path).toBe(join(dir, "f2", "attachments", `${PNG_SHA}.png`));
  expect(imageData(okMsg!.parts[1] as ImagePart)).toBe(PNG_1x1_B64);
  expect(badMsg!.parts.map((p) => (p as ImagePart).path)).toEqual(bad); // untouched: still relative, never joined onto the session dir
  for (const p of badMsg!.parts) expect(imageData(p as ImagePart)).toBeUndefined(); // ../outside.png EXISTS and is still not read
  expect(toAnthropicMessages([badMsg!])[0]!.content).toEqual(bad.map((_, i) => ({ type: "text", text: `[image: b${i}.png — file unavailable]` })));
  rmSync(dir, { recursive: true, force: true });
});

// ── port #34 wiring re-verify: F3 persisted ABSOLUTE sidecar paths, F4 id-less entry lines ──

import { isAbsolute } from "node:path";
import { describeImage } from "../../src/core/images.ts";
import { toOpenAiMessages } from "../../src/providers/wire-messages.ts";

test("F3: a persisted ABSOLUTE image path is foreign — the store writes only `attachments/<file>` — so hydration DROPS it (native and forward-slash forms of a real PNG in another directory, and even the session's OWN sidecar named absolutely): imageData declines, describeImage leaks no size, both wires send `file unavailable`; the canonical part beside them and the store's own round-trip still read; the JSONL line itself is untouched", () => {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-test-"));
  const elsewhere = mkdtempSync(join(tmpdir(), "rovecode-elsewhere-"));
  writeFileSync(join(elsewhere, "secret.png"), PNG_1x1);            // a readable PNG in an unrelated directory
  const s = new SessionStore(dir, "f3");
  s.append(imsg("ok", dot()));                                      // the store's own round-trip: relative on disk, absolute in memory
  const f = join(dir, "f3", "entries.jsonl");
  const first = JSON.parse(readFileSync(f, "utf8").trim()) as { id: string; hash: string };
  const own = join(dir, "f3", "attachments", `${PNG_SHA}.png`);
  const abs = [join(elsewhere, "secret.png"), join(elsewhere, "secret.png").replace(/\\/g, "/"), own];
  expect(abs.every(isAbsolute)).toBe(true);
  const parts = [{ kind: "text", text: "see" }, ...abs.map((path, i) => ({ kind: "image", mime: "image/png", path, width: 1, height: 1, name: `abs${i}.png` })), { kind: "image", mime: "image/png", path: `attachments/${PNG_SHA}.png`, name: "canon.png" }];
  appendFileSync(f, JSON.stringify(wrap(first, "f3-abs", { id: "f3-abs", role: "user", parts, parentId: first.id, createdAt: 1 })) + "\n");

  const s2 = new SessionStore(dir, "f3");
  expect(s2.reload()).toEqual([]);                                   // well-formed lines: the PATHS are the problem, not the shape
  const [okMsg, absMsg] = s2.messages();
  expect((okMsg!.parts[1] as ImagePart).path).toBe(own);
  expect(imageData(okMsg!.parts[1] as ImagePart)).toBe(PNG_1x1_B64); // the store's own hydration (relative → absolute) still reads
  const imgs = absMsg!.parts.filter((p): p is ImagePart => p.kind === "image");
  expect(imgs.length).toBe(4);
  for (const p of imgs.slice(0, 3)) {
    expect("path" in p).toBe(false);                                 // dropped, not rewritten
    expect(imageData(p)).toBeUndefined();                            // secret.png EXISTS and is not read
    expect(describeImage(p)).toBe(`${p.name}, 1x1`);                 // no byte size: nothing was stat'ed either
  }
  expect(imgs[3]!.path).toBe(own);                                   // the canonical part beside them resolves
  const placeholders = [0, 1, 2].map((i) => ({ type: "text", text: `[image: abs${i}.png, 1x1 — file unavailable]` }));
  expect(toAnthropicMessages([absMsg!])[0]!.content).toEqual([{ type: "text", text: "see" }, ...placeholders, { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_1x1_B64 } }]);
  expect(toOpenAiMessages([absMsg!])[0]!.content).toEqual([{ type: "text", text: "see" }, ...placeholders, { type: "image_url", image_url: { url: `data:image/png;base64,${PNG_1x1_B64}`, detail: "auto" } }]);
  expect(readFileSync(f, "utf8")).toContain(JSON.stringify(abs[0]));  // in memory only: the persisted line keeps its path (and its hash)
  rmSync(dir, { recursive: true, force: true }); rmSync(elsewhere, { recursive: true, force: true });
});

test("an ancestry CYCLE in the file is reported and TRUNCATES the path — it does not hang the resume (regression: RangeError: Out of memory)", () => {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-test-"));
  const s = new SessionStore(dir, "cyc");
  const a = msg("A"); s.append(a);
  const f = join(dir, "cyc", "entries.jsonl");
  // a self-parented line, as a tampered or half-written file carries it: reload() has always REPORTED
  // this, but wrappedPath() walked parentId links with no visited set, so path() spun until the process
  // died of memory exhaustion — every surface that resumes a session (run --resume, trace, export,
  // context) went with it. Found by the gauntlet's session-tamper case (eval/gauntlet-wave4.ts).
  const cycle = { id: "loop", parentId: "loop", createdAt: 3, prevHash: "", hash: "dead", entry: { id: "loop", role: "user", parts: [{ kind: "text", text: "loop" }], parentId: "loop", createdAt: 3 } };
  appendFileSync(f, JSON.stringify(cycle) + "\n");

  const store = new SessionStore(dir, "cyc");
  const findings = store.reload();
  expect(findings.some((c) => c.kind === "cycle")).toBe(true);
  // MUTATION TARGET: drop the `seen` set in wrappedPath() → this call never returns
  const path = store.path();
  expect(path.length).toBe(1);
  expect(path.map((e) => e.id)).toEqual(["loop"]);
  expect(store.messages().length).toBe(1);
  // and a cycle that is NOT the leaf leaves the good ancestry intact
  const child = { id: "kid", parentId: a.id, createdAt: 4, prevHash: "", hash: "kid", entry: { id: "kid", role: "user", parts: [{ kind: "text", text: "kid" }], parentId: a.id, createdAt: 4 } };
  appendFileSync(f, JSON.stringify(child) + "\n");
  const store2 = new SessionStore(dir, "cyc");
  expect(store2.reload().some((c) => c.kind === "cycle")).toBe(true);
  expect(store2.messages().map((m) => (m.parts[0] as { text: string }).text)).toEqual(["A", "kid"]);
  rmSync(dir, { recursive: true, force: true });
});

test("F4: id-less object lines — `{\"entry\":null}` and `{\"entry\":{\"role\":\"user\",\"parts\":[null,5]}}` — appended after a 2-message session are reported as unknown-shape only (no spurious duplicate-id/cycle) and never become the leaf: messages() keeps both, turnPoints intact, the loop's next parent (history.at(-1)) is the real leaf, appendEvent hangs off it and the next append chains onto it; the same two lines mid-file report the same two findings and nothing else", () => {
  const IDLESS = ['{"entry":null}', '{"entry":{"role":"user","parts":[null,5]}}'];
  const text = (m: Message) => (m.parts[0] as { text: string }).text;
  const dir = mkdtempSync(join(tmpdir(), "rovecode-test-"));
  const s = new SessionStore(dir, "idless");
  const a = msg("A"); s.append(a);
  const b = amsg("B", a.id); s.append(b);
  const f = join(dir, "idless", "entries.jsonl");
  const good = readFileSync(f, "utf8").split("\n").filter(Boolean);
  appendFileSync(f, IDLESS.join("\n") + "\n");

  const s2 = new SessionStore(dir, "idless");                       // must not throw
  expect(s2.reload().map((c) => [c.kind, c.entryId, c.line, c.detail])).toEqual([
    ["unknown-shape", undefined, 2, "entry line has no string id"], ["unknown-shape", undefined, 3, "entry line has no string id"],
  ]);
  expect(s2.messages().map(text)).toEqual(["A", "B"]);
  expect(s2.turnPoints().map((t) => [t.text, t.parentId, t.branches])).toEqual([["A", null, 0]]);
  const parent = s2.messages().at(-1)?.id ?? null;                  // loop.ts:125 — the goal message's parentId
  expect(parent).toBe(b.id);                                        // (was null → a NEW ROOT; the conversation fell off the active path)
  expect(s2.appendEvent({ type: "steer", text: "t" }).parentId).toBe(b.id); // the leaf itself, not an id-less ghost
  const c = msg("C", parent); s2.append(c);
  const wc = JSON.parse(readFileSync(f, "utf8").split("\n").filter(Boolean).at(-1)!);
  expect([wc.parentId, wc.prevHash]).toEqual([b.id, JSON.parse(good[1]!).hash]);
  expect(new SessionStore(dir, "idless").messages().map(text)).toEqual(["A", "B", "C"]);
  // mid-file: the same two findings and nothing else (no duplicate-id for a second undefined id, no cycle through it)
  writeFileSync(f, [good[0], ...IDLESS, good[1]].join("\n") + "\n");
  const s3 = new SessionStore(dir, "idless");
  expect(s3.reload().map((c) => [c.kind, c.line])).toEqual([["unknown-shape", 1], ["unknown-shape", 2]]);
  expect(s3.messages().map(text)).toEqual(["A", "B"]);
  rmSync(dir, { recursive: true, force: true });
});

// ── final Wave-3 re-verify LOW-A (#34): a FOREIGN id-bearing tail line must not become the fallback leaf ──

/** the two repros: a well-shaped user entry whose parent does not exist, and a bare id */
const GHOST = JSON.stringify({ id: "ghost", parentId: "nope", createdAt: 1, prevHash: "", hash: "gh", entry: { id: "ghost", role: "user", parts: [{ kind: "text", text: "G" }], parentId: "nope", createdAt: 1 } });
const BARE = '{"id":"bare"}';
const textOf = (m: Message) => (m.parts[0] as { text: string }).text;

/** a 2-message session A ← B on disk (legacy meta: no leaf field) + its two good lines */
function seeded(id: string) {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-test-"));
  const s = new SessionStore(dir, id);
  const a = msg("A"); s.append(a);
  const b = amsg("B", a.id); s.append(b);
  const f = join(dir, id, "entries.jsonl");
  return { dir, a, b, f, good: readFileSync(f, "utf8").split("\n").filter(Boolean) };
}

/** the LOW-A bar once `foreign` sits at the tail: the findings are exactly `findings` (kind, id — line 2), the
 *  active path is still A→B, turnPoints intact, the loop's next parent (history.at(-1)) and appendEvent's parent
 *  are B, the next append chains onto B's hash, a fresh reload reads 3; the same line mid-file (line 1) → the
 *  same findings and the same path */
function stillAB(id: string, foreign: string, findings: [string, string][]) {
  const { dir, b, f, good } = seeded(id);
  appendFileSync(f, foreign + "\n");
  const s2 = new SessionStore(dir, id);                              // must not throw
  expect(s2.reload().map((c) => [c.kind, c.entryId, c.line])).toEqual(findings.map(([k, e]) => [k, e, 2]));
  expect(s2.messages().map(textOf)).toEqual(["A", "B"]);
  expect(s2.turnPoints().map((t) => [t.text, t.parentId, t.branches])).toEqual([["A", null, 0]]);
  const parent = s2.messages().at(-1)?.id ?? null;                  // loop.ts:125 — the goal message's parentId
  expect(parent).toBe(b.id);
  expect(s2.appendEvent({ type: "steer", text: "t" }).parentId).toBe(b.id);
  s2.append(msg("C", parent));
  const wc = JSON.parse(readFileSync(f, "utf8").split("\n").filter(Boolean).at(-1)!);
  expect([wc.parentId, wc.prevHash]).toEqual([b.id, JSON.parse(good[1]!).hash]);
  expect(new SessionStore(dir, id).messages().map(textOf)).toEqual(["A", "B", "C"]);
  writeFileSync(f, [good[0], foreign, good[1]].join("\n") + "\n");  // mid-file placement
  const s3 = new SessionStore(dir, id);
  expect(s3.reload().map((c) => [c.kind, c.entryId, c.line])).toEqual(findings.map(([k, e]) => [k, e, 1]));
  expect(s3.messages().map(textOf)).toEqual(["A", "B"]);
  rmSync(dir, { recursive: true, force: true });
}

test("LOW-A (#34): a well-shaped ORPHAN tail `{id:ghost,parentId:nope,…}` after A ← B is reported as orphan-entry ONLY and stays in the tree, yet the leaf is B, not the ghost — messages() [A, B] (was [G]: A and B fell off the path), next parent B (was the ghost), chain onto B's hash, reload 3; mid-file → the same finding (mutation: fallback leaf = cache.at(-1))", () => {
  stillAB("ghost", GHOST, [["orphan-entry", "ghost"]]);
});

test("LOW-A (#34): a bare `{id:bare}` tail after A ← B is reported as orphan-entry + unknown-shape and stays in the tree, yet the leaf is B — messages() [A, B] (was []), next parent B (was null → a NEW ROOT: the 6947dd6 symptom through an id-bearing line), chain onto B's hash, reload 3; mid-file → the same findings", () => {
  stillAB("bare", BARE, [["orphan-entry", "bare"], ["unknown-shape", "bare"]]);
});

test("LOW-A guard: the fallback leaf is the last TREE-LINKED entry, not the last linear one — a legacy file (no meta.leaf) A ← B, A ← C with the sibling branch tip C as the real last line resumes at C: path [A, C], C's turn point counts B as the abandoned branch, zero findings", () => {
  const { dir, a, f } = seeded("tip");
  const wa = JSON.parse(readFileSync(f, "utf8").split("\n")[0]!) as { id: string; hash: string };
  appendFileSync(f, JSON.stringify(wrap(wa, "c", { id: "c", role: "user", parts: [{ kind: "text", text: "C" }], parentId: a.id, createdAt: 1 })) + "\n");
  expect("leaf" in JSON.parse(readFileSync(join(dir, "tip", "meta.json"), "utf8"))).toBe(false);
  const s2 = new SessionStore(dir, "tip");
  expect(s2.reload()).toEqual([]);
  expect(s2.path().map((e) => e.id)).toEqual([a.id, "c"]);
  expect(s2.turnPoints().map((t) => [t.text, t.parentId, t.branches])).toEqual([["A", null, 0], ["C", a.id, 1]]);
  expect(s2.messages().map(textOf)).toEqual(["A", "C"]);
  rmSync(dir, { recursive: true, force: true });
});
