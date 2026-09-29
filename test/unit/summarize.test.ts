/** core/summarize.ts (the head summarizer — auto-compaction's missing wire + /compact's engine)
 *  and session-cmd.ts cmdCompact (the durable manual compact: summary → fresh session, old intact). */

import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHeadSummarizer } from "../../src/core/summarize.ts";
import { cmdCompact } from "../../src/tui/session-cmd.ts";
import { SessionStore } from "../../src/core/session.ts";
import { mockStream, textTurn } from "../../src/providers/stream.ts";
import type { StreamFn } from "../../src/core/types.ts";

const ref = { provider: "p", model: "m" };

test("summarizer: one call, the prompt carries the texts, the answer comes back; provider error → \"\" (fallback engages)", async () => {
  let seen = "";
  const stream: StreamFn = async function* (_m, messages) {
    seen = messages[0]!.parts.map((p) => (p.kind === "text" ? p.text : "")).join("");
    yield { type: "turn", turn: textTurn("dense summary") };
  };
  const s = createHeadSummarizer(stream, ref);
  expect(await s(["first half", "second half"])).toBe("dense summary");
  expect(seen).toContain("first half");
  expect(seen).toContain("second half");
  expect(seen).toContain("Summarize");

  const boom: StreamFn = async function* () { throw new Error("provider down"); };
  expect(await createHeadSummarizer(boom, ref)(["x"])).toBe(""); // never throws — compaction must not crash the run
  expect(await createHeadSummarizer(stream, ref)(["", "  "])).toBe(""); // nothing to say, no call spent
});

// ---------- /compact ----------

function ctxWith(store: SessionStore, sessionsDir: string, summary: string) {
  const notes: { text: string; tone?: string }[] = [];
  let switched: string | null = null;
  const ctx = {
    renderer: { addSystemNote: (text: string, tone?: "info" | "warn" | "error") => { notes.push({ text, ...(tone ? { tone } : {}) }); } },
    sessionsDir,
    busy: () => false,
    store: () => store,
    switchSession: (id: string) => { switched = id; },
    replayHistory: () => {}, refreshUsage: () => {}, pushStatus: () => {},
    summarize: async () => summary,
  };
  return { ctx, notes, switched: () => switched };
}

test("/compact: the transcript becomes one summary seeded into a FRESH session; the old one keeps every byte", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-compact-"));
  try {
    const old = new SessionStore(dir, "old-session");
    let parent: string | null = null;
    for (let i = 0; i < 6; i++) {
      const id = `m${i}`;
      old.append({ id, role: i % 2 ? "assistant" : "user", parts: [{ kind: "text", text: `message ${i} with content` }], parentId: parent, createdAt: i });
      parent = id;
    }
    const h = ctxWith(old, dir, "we were building the thing; files a.ts and b.ts touched");
    await cmdCompact(h.ctx as never);
    expect(h.switched()).not.toBeNull();
    const fresh = new SessionStore(dir, h.switched()!);
    const msgs = fresh.messages();
    expect(msgs.length).toBe(1);
    expect(msgs[0]!.parts.map((p) => (p.kind === "text" ? p.text : "")).join("")).toContain("we were building the thing");
    expect(new SessionStore(dir, "old-session").messages().length).toBe(6); // intact
    expect(h.notes.at(-1)!.text).toContain("compacted → new session");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("/compact: too few messages → a note, no provider call; empty summary → error note, no switch", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-compact-"));
  try {
    const old = new SessionStore(dir, "tiny");
    old.append({ id: "a", role: "user", parts: [{ kind: "text", text: "hi" }], parentId: null, createdAt: 1 });
    const h = ctxWith(old, dir, "unused");
    await cmdCompact(h.ctx as never);
    expect(h.switched()).toBeNull();
    expect(h.notes.at(-1)!.text).toContain("nothing to compact");

    let parent: string | null = "a";
    for (let i = 1; i < 5; i++) { const id = `m${i}`; old.append({ id, role: "assistant", parts: [{ kind: "text", text: `work ${i}` }], parentId: parent, createdAt: i }); parent = id; }
    const h2 = ctxWith(old, dir, ""); // the summarizer failed
    await cmdCompact(h2.ctx as never);
    expect(h2.switched()).toBeNull();
    expect(h2.notes.at(-1)).toMatchObject({ tone: "error" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
