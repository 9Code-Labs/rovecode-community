/** A session directory exists from its FIRST entry, not from construction (core/session.ts materialize()).
 *
 *  Why a test and not an argument: the change moves the mkdir + meta.json write out of the constructor, and
 *  three things downstream have always assumed the directory is there by the time they look — listSessions
 *  (resume pickers, `rovecode context`, GET /sessions), the recall index, and the store's own reload. Each of
 *  them is exercised here across the boundary: before the first entry (nothing on disk, nothing listed,
 *  recall finds nothing and throws nothing) and after it (listed, resumable with the same content, found by
 *  recall). The pre-fix leftovers — a directory holding only meta.json — stay resumable: nothing is deleted. */

import { test, expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { SessionStore, listSessions, scanSessions } from "../../src/core/session.ts";
import { RecallIndex, recallTool } from "../../src/memory/recall.ts";
import { BlockStore } from "../../src/memory/blocks.ts";
import type { ToolContext } from "../../src/core/types.ts";

const user = (text: string) => ({ id: randomUUID(), role: "user" as const, parts: [{ kind: "text" as const, text }], parentId: null, createdAt: Date.now() });
const ctx = (): ToolContext => ({ sessionId: "probe", cwd: process.cwd(), signal: new AbortController().signal, permissions: { effect: "allow" } });
const root = () => mkdtempSync(join(tmpdir(), "rovecode-lazy-"));

test("opening a store writes nothing: no directory, not listed, invisible to recall — and recall does not throw over it", async () => {
  const r = root();
  const s = new SessionStore(r, "fresh");
  expect(existsSync(join(r, "fresh"))).toBe(false);
  expect(s.messages()).toEqual([]);
  expect(listSessions(r)).toEqual([]);
  const idx = new RecallIndex(r);
  expect(idx.refresh().scanned).toBe(0);
  const hit = await recallTool(r).execute({ query: "anything" }, ctx());
  expect(hit.ok).toBe(true);
  expect(hit.output).toContain("no matches");
  // the sessions root itself may be missing too (a cwd that never ran): still nothing thrown
  expect(listSessions(join(r, "never-made"))).toEqual([]);
  rmSync(r, { recursive: true, force: true });
});

test("the first message creates the directory + meta.json; the session is then listed, resumable with the same content, and found by recall", async () => {
  const r = root();
  const s = new SessionStore(r, "spoken");
  const opened = Date.now();
  s.append(user("remember the pangolin"));
  expect(existsSync(join(r, "spoken", "entries.jsonl"))).toBe(true);
  const meta = JSON.parse(readFileSync(join(r, "spoken", "meta.json"), "utf8")) as { id: string; createdAt: number; leaf?: string };
  expect(meta.id).toBe("spoken");
  expect(meta.createdAt).toBeLessThanOrEqual(opened);   // when it was opened, not when the entry landed
  expect("leaf" in meta).toBe(false);                    // an append alone never adds a leaf (legacy shape kept)

  const listed = listSessions(r);
  expect(listed.map((x) => x.id)).toEqual(["spoken"]);
  expect(listed[0]!.preview).toBe("remember the pangolin");
  expect(listed[0]!.entryCount).toBe(1);

  const resumed = new SessionStore(r, "spoken");         // a second instance over the same directory
  expect(resumed.messages().map((m) => m.parts[0])).toEqual([{ kind: "text", text: "remember the pangolin" }]);
  expect(resumed.reload()).toEqual([]);                  // zero corruption findings on the replay

  const hit = await recallTool(r).execute({ query: "pangolin" }, ctx());
  expect(hit.ok).toBe(true);
  expect(hit.output).toContain("[spoken]");
  rmSync(r, { recursive: true, force: true });
});

test("a session that only ever received an event (a compaction marker, a system note) is on disk and resumes to that event", () => {
  const r = root();
  const s = new SessionStore(r, "noted");
  s.appendEvent({ type: "turn_start", turn: 1 });
  expect(existsSync(join(r, "noted", "meta.json"))).toBe(true);
  expect(listSessions(r).map((x) => [x.id, x.entryCount])).toEqual([["noted", 1]]);
  const back = new SessionStore(r, "noted");
  expect(back.path().map((e) => ("kind" in e ? e.kind : e.role))).toEqual(["event"]);
  expect(back.messages()).toEqual([]);
  rmSync(r, { recursive: true, force: true });
});

test("branch() on an empty store is a no-op that creates nothing; branch() after entries persists the leaf as before", () => {
  const r = root();
  const s = new SessionStore(r, "b");
  expect(s.branch("nothing")).toBe(false);
  expect(existsSync(join(r, "b"))).toBe(false);
  const a = user("A"); s.append(a);
  const b = { ...user("B"), parentId: a.id }; s.append(b);
  expect(s.branch(a.id)).toBe(true);
  expect((JSON.parse(readFileSync(join(r, "b", "meta.json"), "utf8")) as { leaf: string }).leaf).toBe(a.id);
  expect(new SessionStore(r, "b").path().map((e) => e.id)).toEqual([a.id]);
  rmSync(r, { recursive: true, force: true });
});

test("a pre-fix leftover (meta.json, no entries) is still listed and still resumable — the fix never deletes", async () => {
  const r = root();
  mkdirSync(join(r, "legacy-empty"));
  writeFileSync(join(r, "legacy-empty", "meta.json"), JSON.stringify({ id: "legacy-empty", createdAt: 1_700_000_000_000 }));
  new SessionStore(r, "opened-only");                    // never spoken to: contributes nothing
  const live = new SessionStore(r, "live"); live.append(user("the live one"));

  expect(listSessions(r).map((x) => x.id)).toEqual(["live"]);                              // the picker list: sessions that hold something
  expect(listSessions(r, { includeHollow: true }).map((x) => x.id)).toEqual(["live", "legacy-empty"]); // newest first; the hollow dir untouched, still openable
  expect(scanSessions(r).hollow).toEqual(["legacy-empty"]);                                // counted from the stat alone (`rovecode sessions` footer)
  expect(readdirSync(r).sort()).toEqual(["legacy-empty", "live"]);
  const resumedLegacy = new SessionStore(r, "legacy-empty");
  expect(resumedLegacy.messages()).toEqual([]);
  resumedLegacy.append(user("now it speaks"));             // and it takes entries like any other
  expect(listSessions(r).find((x) => x.id === "legacy-empty")!.preview).toBe("now it speaks");
  expect(new RecallIndex(r).refresh().scanned).toBe(2);
  const hit = await recallTool(r).execute({ query: "live" }, ctx());
  expect(hit.output).toContain("[live]");
  rmSync(r, { recursive: true, force: true });
});

test("a session directory swept away between two appends comes back on the next one instead of throwing", () => {
  const r = root();
  const s = new SessionStore(r, "swept");
  s.append(user("one"));
  rmSync(join(r, "swept"), { recursive: true, force: true });
  expect(() => s.append(user("two"))).not.toThrow();
  expect(existsSync(join(r, "swept", "meta.json"))).toBe(true);
  expect(readFileSync(join(r, "swept", "entries.jsonl"), "utf8").trim().split("\n").length).toBe(1);   // only what landed after the sweep
  rmSync(r, { recursive: true, force: true });
});

test("BlockStore: opening the memory blocks creates no directory; the first commit does", () => {
  const r = root();
  const dir = join(r, "sess", "memory");
  const blocks = new BlockStore(dir);
  expect(existsSync(join(r, "sess"))).toBe(false);
  expect(blocks.liveText("memory")).toBe("");
  expect(blocks.add("memory", "prefers tabs").ok).toBe(true);
  expect(existsSync(join(dir, "MEMORY.md"))).toBe(true);
  expect(new BlockStore(dir).liveText("memory")).toBe("prefers tabs");
  rmSync(r, { recursive: true, force: true });
});
