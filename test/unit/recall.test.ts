/** Port #17 cross-session recall: indexing, ranking (exact > partial), mtime-keyed
 *  incremental updates, result budget, tool output shape, policy gating. */

import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, appendFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecallIndex, recallTool, tokenize, type RecallHit } from "../../src/memory/recall.ts";
import { ToolRegistry } from "../../src/core/tools.ts";
import type { ToolContext, ToolCallPart, PermissionRule } from "../../src/core/types.ts";

// ---------- fixtures ----------

const ctx = (sessionId = "live-session"): ToolContext => ({
  sessionId, cwd: process.cwd(), signal: new AbortController().signal,
  permissions: { effect: "allow" as const },
});

let seq = 0;
/** One entries.jsonl line in the SessionStore wrapped-envelope shape (session.ts). */
function msgLine(text: string, o: { id?: string; role?: string; ts?: number } = {}): string {
  const id = o.id ?? `e${++seq}`;
  const ts = o.ts ?? 1_700_000_000_000 + seq;
  return JSON.stringify({
    id, parentId: null, createdAt: ts, prevHash: "", hash: "h",
    entry: { id, role: o.role ?? "user", parts: [{ kind: "text", text }], parentId: null, createdAt: ts },
  });
}

function eventLine(text: string): string {
  const id = `ev${++seq}`;
  return JSON.stringify({
    id, parentId: null, createdAt: 1, prevHash: "", hash: "h",
    entry: { id, kind: "event", parentId: null, createdAt: 1, event: { type: "steer", text } },
  });
}

function toolResultLine(output: string): string {
  const id = `tr${++seq}`;
  return JSON.stringify({
    id, parentId: null, createdAt: 2, prevHash: "", hash: "h",
    entry: { id, role: "tool", parts: [{ kind: "tool_result", callId: "c", ok: true, output }], parentId: null, createdAt: 2 },
  });
}

function writeSession(root: string, sid: string, lines: string[]): void {
  mkdirSync(join(root, sid), { recursive: true });
  writeFileSync(join(root, sid, "entries.jsonl"), lines.join("\n") + "\n");
}

function tmpRoot(): string { return mkdtempSync(join(tmpdir(), "aion-recall-")); }

function hitsOf(out: { data?: unknown }): RecallHit[] {
  return (out.data as { hits: RecallHit[] }).hits;
}

// ---------- tokenization ----------

test("tokenize: case-folds and splits on non-alphanumerics (unicode61-style)", () => {
  expect(tokenize("Foo-bar_baz v2.1, DONE!")).toEqual(["foo", "bar", "baz", "v2", "1", "done"]);
  expect(tokenize("  \n\t ")).toEqual([]);
});

// ---------- indexing ----------

test("indexing: finds message text across sessions; skips events, tool results, malformed lines", () => {
  const root = tmpRoot();
  writeSession(root, "s-alpha", [
    msgLine("the quick brown fox", { id: "m1", ts: 1000 }),
    eventLine("secret zeppelin cargo"),
    "{not json oops",
    toolResultLine("gigantic walrus output"),
    msgLine("zebra pattern notes", { id: "m2" }),
  ]);
  writeSession(root, "s-beta", [msgLine("fox hunting season", { id: "m3" })]);

  const idx = new RecallIndex(root);
  const stats = idx.refresh();
  expect(stats).toEqual({ scanned: 2, indexed: 2, removed: 0 });

  const hits = idx.search("fox", 10);
  expect(hits.length).toBe(2);
  expect(hits.map((h) => h.sessionId).sort()).toEqual(["s-alpha", "s-beta"]);
  const alpha = hits.find((h) => h.sessionId === "s-alpha")!;
  expect(alpha.entryId).toBe("m1");          // wrapped-envelope id
  expect(alpha.timestamp).toBe(1000);        // wrapper createdAt
  expect(alpha.preview).toContain("fox");

  // event payload text and tool_result output are NOT message text
  expect(idx.search("zeppelin", 10)).toEqual([]);
  expect(idx.search("walrus", 10)).toEqual([]);
  rmSync(root, { recursive: true, force: true });
});

// ---------- ranking ----------

test("ranking: exact term match outranks higher-frequency partial matches", () => {
  const root = tmpRoot();
  // partial doc is NEWER and has 4x term frequency — exact must still win
  writeSession(root, "s-exact", [msgLine("we will deploy tomorrow", { ts: 1000 })]);
  writeSession(root, "s-partial", [msgLine("deployment deployment deployment deployment", { ts: 9000 })]);
  const idx = new RecallIndex(root);
  const hits = idx.search("deploy", 10);
  expect(hits.length).toBe(2);               // partial matches still surface
  expect(hits[0]!.sessionId).toBe("s-exact");
  expect(hits[1]!.sessionId).toBe("s-partial");
  rmSync(root, { recursive: true, force: true });
});

test("ranking: within the exact tier, higher term frequency wins; recency breaks ties", () => {
  const root = tmpRoot();
  writeSession(root, "s-one", [msgLine("kiwi", { ts: 5000 })]);
  writeSession(root, "s-three", [msgLine("kiwi kiwi kiwi", { ts: 1000 })]);
  writeSession(root, "s-newer", [msgLine("kiwi", { ts: 9000 })]);
  const idx = new RecallIndex(root);
  const hits = idx.search("kiwi", 10);
  expect(hits.map((h) => h.sessionId)).toEqual(["s-three", "s-newer", "s-one"]);
  rmSync(root, { recursive: true, force: true });
});

test("ranking: query terms are ANDed (FTS5 implicit AND)", () => {
  const root = tmpRoot();
  writeSession(root, "s-both", [msgLine("alpha and beta together")]);
  writeSession(root, "s-alpha-only", [msgLine("alpha alone here")]);
  const idx = new RecallIndex(root);
  const hits = idx.search("alpha beta", 10);
  expect(hits.map((h) => h.sessionId)).toEqual(["s-both"]);
  rmSync(root, { recursive: true, force: true });
});

test("ranking: partial (substring) matching needs terms >=3 chars, exact always works", () => {
  const root = tmpRoot();
  writeSession(root, "s-sub", [msgLine("abcdef stream")]);
  writeSession(root, "s-ex", [msgLine("ab standalone")]);
  const idx = new RecallIndex(root);
  // "ab" (2 chars): exact-only — never a substring match into "abcdef"
  expect(idx.search("ab", 10).map((h) => h.sessionId)).toEqual(["s-ex"]);
  // "abc" (3 chars): substring tier active
  expect(idx.search("abc", 10).map((h) => h.sessionId)).toEqual(["s-sub"]);
  rmSync(root, { recursive: true, force: true });
});

// ---------- incremental indexing ----------

test("incremental: unchanged files are not re-indexed; appends re-index only the changed file", () => {
  const root = tmpRoot();
  writeSession(root, "s-a", [msgLine("original alpha content")]);
  writeSession(root, "s-b", [msgLine("original beta content")]);
  const idx = new RecallIndex(root);
  expect(idx.refresh().indexed).toBe(2);
  expect(idx.refresh()).toEqual({ scanned: 2, indexed: 0, removed: 0 }); // no changes → no work

  const fileA = join(root, "s-a", "entries.jsonl");
  appendFileSync(fileA, msgLine("freshly appended quokka") + "\n");
  const future = Math.floor(Date.now() / 1000) + 60;
  utimesSync(fileA, future, future); // deterministic mtime bump across filesystems
  const stats = idx.refresh();
  expect(stats).toEqual({ scanned: 2, indexed: 1, removed: 0 }); // ONLY s-a re-read
  expect(idx.search("quokka", 10).map((h) => h.sessionId)).toEqual(["s-a"]);
  expect(idx.search("beta", 10).length).toBe(1); // s-b untouched and intact
  rmSync(root, { recursive: true, force: true });
});

test("incremental: mtime change alone (same size) forces re-index; deleted sessions drop out", () => {
  const root = tmpRoot();
  writeSession(root, "s-a", [msgLine("stable text")]);
  writeSession(root, "s-gone", [msgLine("vanishing narwhal")]);
  const idx = new RecallIndex(root);
  expect(idx.refresh().indexed).toBe(2);

  const fileA = join(root, "s-a", "entries.jsonl");
  const future = Math.floor(Date.now() / 1000) + 120;
  utimesSync(fileA, future, future); // touch, no content change
  expect(idx.refresh()).toEqual({ scanned: 2, indexed: 1, removed: 0 }); // keyed by mtime

  rmSync(join(root, "s-gone"), { recursive: true, force: true });
  expect(idx.refresh()).toEqual({ scanned: 1, indexed: 0, removed: 1 });
  expect(idx.search("narwhal", 10)).toEqual([]); // dropped docs are unfindable
  rmSync(root, { recursive: true, force: true });
});

// ---------- result budget ----------

test("budget: limit clamps to [1, 10], defaults to 5, and maxResults lowers the ceiling", async () => {
  const root = tmpRoot();
  for (let i = 0; i < 15; i++) writeSession(root, `s-${i}`, [msgLine(`banana note ${i}`, { ts: i })]);
  const tool = recallTool(root);

  const wide = await tool.execute({ query: "banana", limit: 50 }, ctx());
  expect(hitsOf(wide).length).toBe(10);      // hermes ceiling max(1, min(limit, 10))

  const low = await tool.execute({ query: "banana", limit: -3 }, ctx());
  expect(hitsOf(low).length).toBe(1);        // clamps up to 1

  const dflt = await tool.execute({ query: "banana" }, ctx());
  expect(hitsOf(dflt).length).toBe(5);       // default

  const tight = recallTool(root, { maxResults: 2 });
  const capped = await tight.execute({ query: "banana", limit: 50 }, ctx());
  expect(hitsOf(capped).length).toBe(2);
  rmSync(root, { recursive: true, force: true });
});

// ---------- tool output shape ----------

test("tool shape: ok output lists hits; data.hits carry exactly {sessionId, entryId, preview, timestamp}", async () => {
  const root = tmpRoot();
  const long = "x".repeat(300) + " hidden pangolin fact " + "y".repeat(300);
  writeSession(root, "s-alpha", [msgLine(long, { id: "m9", ts: 4242 })]);
  const tool = recallTool(root);
  expect(tool.kind).toBe("read");
  expect(tool.schema.name).toBe("recall");

  const out = await tool.execute({ query: "pangolin" }, ctx());
  expect(out.ok).toBe(true);
  expect(out.output).toContain("[s-alpha]");
  expect(out.output).toContain("m9");

  const hits = hitsOf(out);
  expect(hits.length).toBe(1);
  const h = hits[0]!;
  expect(Object.keys(h).sort()).toEqual(["entryId", "preview", "sessionId", "timestamp"]);
  expect(h.sessionId).toBe("s-alpha");
  expect(h.entryId).toBe("m9");
  expect(h.timestamp).toBe(4242);
  // preview: single line, windowed around the match, clipped with ellipses
  expect(h.preview).toContain("pangolin");
  expect(h.preview).not.toContain("\n");
  expect(h.preview.length).toBeLessThanOrEqual(122); // 120-char window + 2 ellipses
  expect(h.preview.startsWith("…")).toBe(true);
  expect(h.preview.endsWith("…")).toBe(true);
  rmSync(root, { recursive: true, force: true });
});

test("tool shape: empty result is ok:true with guidance; bad query is ok:false", async () => {
  const root = tmpRoot();
  writeSession(root, "s-alpha", [msgLine("nothing relevant")]);
  const tool = recallTool(root);
  const none = await tool.execute({ query: "xylophone" }, ctx());
  expect(none.ok).toBe(true);
  expect(none.output).toContain("no matches");
  expect(hitsOf(none)).toEqual([]);

  expect((await tool.execute({ query: "   " }, ctx())).ok).toBe(false);
  expect((await tool.execute({}, ctx())).ok).toBe(false);
  expect((await tool.execute({ query: "!!! ???" }, ctx())).ok).toBe(true); // tokenizes to nothing → no matches
  rmSync(root, { recursive: true, force: true });
});

test("cross-session: hits from the live session are excluded", async () => {
  const root = tmpRoot();
  writeSession(root, "s-alpha", [msgLine("shared ocelot topic")]);
  writeSession(root, "s-beta", [msgLine("shared ocelot topic too")]);
  const tool = recallTool(root);
  const out = await tool.execute({ query: "ocelot" }, ctx("s-alpha"));
  expect(hitsOf(out).map((h) => h.sessionId)).toEqual(["s-beta"]);
  rmSync(root, { recursive: true, force: true });
});

// ---------- policy gating ----------

test("policy: registry dispatch gates recall as file.read (deny-by-default)", async () => {
  const root = tmpRoot();
  writeSession(root, "s-alpha", [msgLine("gated gecko data")]);
  const registry = new ToolRegistry();
  registry.register(recallTool(root));
  const call: ToolCallPart = { kind: "tool_call", id: "c1", tool: "recall", args: { query: "gecko" } };

  const denied = await registry.dispatch(call, ctx(), undefined, [], undefined, () => {});
  expect(denied.ok).toBe(false);
  expect(denied.output).toContain("Permission denied");

  const allow: PermissionRule[] = [{ action: "file.read", resource: "*", effect: "allow" }];
  const ok = await registry.dispatch(call, ctx(), undefined, allow, undefined, () => {});
  expect(ok.ok).toBe(true);
  expect(ok.output).toContain("gecko");

  const blocked: PermissionRule[] = [
    { action: "file.read", resource: "*", effect: "allow" },
    { action: "file.read", resource: "recall", effect: "deny" }, // tool-targeted rule (resource = tool name)
  ];
  const rehidden = await registry.dispatch(call, ctx(), undefined, blocked, undefined, () => {});
  expect(rehidden.ok).toBe(false);
  rmSync(root, { recursive: true, force: true });
});

// ---------- pluggable summarize ----------

test("summarize: optional injected fn runs after search; failures never lose hits", async () => {
  const root = tmpRoot();
  writeSession(root, "s-alpha", [msgLine("tapir migration report")]);
  const seen: Array<{ q: string; n: number }> = [];
  const withSum = recallTool(root, {
    summarize: (q, hits) => { seen.push({ q, n: hits.length }); return "one tapir session"; },
  });
  const out = await withSum.execute({ query: "tapir" }, ctx());
  expect(out.output).toContain("summary: one tapir session");
  expect(seen).toEqual([{ q: "tapir", n: 1 }]);

  const plain = recallTool(root);
  expect((await plain.execute({ query: "tapir" }, ctx())).output).not.toContain("summary:");

  const boom = recallTool(root, { summarize: () => { throw new Error("llm down"); } });
  const failed = await boom.execute({ query: "tapir" }, ctx());
  expect(failed.ok).toBe(true);              // search result survives the summarizer
  expect(hitsOf(failed).length).toBe(1);
  expect(failed.output).toContain("summarize step failed");
  rmSync(root, { recursive: true, force: true });
});
