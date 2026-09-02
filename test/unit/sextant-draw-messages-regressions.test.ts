/** Port #42 critic findings pinned as regressions (each reproduced through the real edit tool /
 *  composed frames): a FAILED edit row shows its rejection, never `+a −b` (MED-1); the approval card
 *  drops the `---`/`+++` header pair and budgets `h − 5` detail rows so a small hunk shows its +/−
 *  lines at the frame's 160×44 message height (MED-2); tool names of 7+ chars keep a space before the
 *  label (MED-3); the run header says `needs you` while a card is open, like the frame header (LOW-1);
 *  wrap/hardWrap/toolRow count cells per code point — no split surrogate pairs, no 39-cell "40-cell"
 *  rows (LOW-2); a system/compaction row that opens a run draws the `◆ aion` header first. */

import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CardState, MessageRow, Seg, SextantState, ToolRow } from "../../src/sextant/types.ts";
import { activityLabel, buildRows, cardRows, cardShape, drawMessages, toolRow } from "../../src/sextant/draw-messages.ts";
import { hardWrap, wrap } from "../../src/sextant/draw-util.ts";
import { applyEvent } from "../../src/sextant/model.ts";
import { previewDiff } from "../../src/coding/diff.ts";
import { GridScreen, THEME, baseState } from "../helpers/sextant-grid.ts";

const RECT = { x: 2, y: 1, w: 70, h: 14 }; // the 160×44 frame's messages height: inner 66×12 → message area h = 10 (y 2..11), rule y 12, prompt y 13
const BX = 4, BW = 66, IW = BW - 2;
const BUTTONS = "   allow    always    deny    ⏎ confirm  ←→ choose  esc deny";
const LONE = /[\uD800-\uDBFF]$|^[\uDC00-\uDFFF]/; // a chunk ending in a high or starting with a low surrogate
const noop = (): void => {};
const msgState = (messages: MessageRow[], over: Partial<SextantState> = {}): SextantState => baseState({ messages, ...over });
const tool = (over: Partial<ToolRow>): ToolRow => ({ kind: "tool", callId: "c1", tool: over.verb ?? "read", verb: "read", label: "callback.ts", running: false, ok: true, ...over });
const rowText = (segs: readonly Seg[]): string => segs.map(([t]) => t).join("");
/** buildRows as strings, indent applied */
const rowsOf = (s: SextantState): string[] => buildRows(s, BW, THEME, 0).map((r) => " ".repeat(r.indent ?? 0) + rowText(r.segs));
function draw(s: SextantState, rect = RECT): GridScreen { const g = new GridScreen(90, rect.y + rect.h + 2, "░"); drawMessages(g, rect, s, THEME, 0); return g; }
const rowOf = (g: GridScreen, needle: string): number => { for (let y = 0; y < g.h; y++) if (g.row(y).includes(needle)) return y; return -1; };
const span = (g: GridScreen, from: number, to: number): string[] => Array.from({ length: to - from }, (_, i) => g.span(BX, from + i, BW));
const running = { running: true, activity: { state: "WRITING" as const, label: "writing", runId: "r", startedAt: 0, endedAt: null } };
const approval = (detail: string, selected: 0 | 1 | 2 = 0): CardState => ({ kind: "approval", tool: "write", argsPreview: "f.txt", detail, selected, resolve: noop });
/** a real previewDiff of writing `after` over a file that holds `before` */
function realDiff(before: string, after: string): string {
  const dir = mkdtempSync(join(tmpdir(), "aion-f42-"));
  try { writeFileSync(join(dir, "f.txt"), before); return previewDiff("write", { path: "f.txt", content: after }, dir).text; }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

// ------------------------------------------------------------------ MED-1: a failed edit shows its rejection

test("a failed edit row shows its rejection detail in red and never the +a −b it did not apply — direct row and through the real reducer", () => {
  const rejected = "Edit rejected: stale anchor";
  const t = tool({ verb: "edit", label: "note.ts", ok: false, add: 1, del: 1, detail: rejected });
  const text = rowText(toolRow(t, IW, THEME, 0));
  expect(text).toBe(`~ edit   note.ts${" ".repeat(IW - 16 - rejected.length)}${rejected}`);
  expect(text).not.toContain("+1"); expect(text).not.toContain("−1");
  const g = draw(msgState([{ kind: "user", text: "fix" }, t], { activity: { state: "ERROR", label: "edit failed", runId: "r", startedAt: 0, endedAt: 1 } }));
  const y = rowOf(g, "~ edit");
  expect(g.span(BX, y, BW)).toMatch(/^ {2}~ edit {3}note\.ts {2,}Edit rejected: stale anchor$/);
  expect(g.cell(BX + 2, y).fg).toBe(THEME.err); // glyph
  expect(g.cell(BX + 11, y).fg).toBe(THEME.err); // label
  expect(g.cell(g.row(y).indexOf("Edit rejected"), y).fg).toBe(THEME.err); // detail
  const ok = rowText(toolRow(tool({ verb: "edit", label: "note.ts", add: 1, del: 1, detail: "note" }), IW, THEME, 0)); // a landed edit keeps its counts
  expect(ok).toMatch(/^~ edit {3}note\.ts {2,}\+1 −1$/);
  // the real path: describeCall puts the proposed counts on the row at start; a rejected end keeps them and adds the detail
  const s = baseState();
  applyEvent(s, { type: "run_start", runId: "r1", sessionId: "sess", goal: "fix" }, 0);
  applyEvent(s, { type: "tool_execution_start", callId: "f42-e1", tool: "edit", args: { path: "note.ts", edits: [{ tag: "a1b2", anchorLine: 2, anchorHash: "e5f6", newLines: ["x"] }] } }, 1);
  applyEvent(s, { type: "tool_execution_end", callId: "f42-e1", ok: false, output: `${rejected}\nline 2 hash is e5f6, the edit expects ffff`, durationMs: 3 }, 2);
  expect(s.messages.at(-1)).toMatchObject({ kind: "tool", verb: "edit", ok: false, add: 1, del: 1, detail: rejected });
  const gr = draw(s);
  const ry = rowOf(gr, "~ edit");
  expect(gr.span(BX, ry, BW)).toMatch(/^ {2}~ edit {3}note\.ts {2,}Edit rejected: stale anchor$/);
  expect(gr.toText()).not.toContain("+1 −1");
});

// ------------------------------------------------------------------ MED-2: the approval card shows the hunk

test("approval card at the frame's message height (h = 10): no ---/+++ pair, a one-line change shows its whole hunk, the clip marker stays exact; h = 6 keeps title + 2 detail rows + buttons", () => {
  const small = realDiff("a\nb\nc\n", "a\nB\nc\n");
  expect(small.split("\n")).toEqual(["--- a/f.txt", "+++ b/f.txt", "@@ -1,3 +1,3 @@", " a", "-b", "+B", " c"]);
  const g = draw(msgState([{ kind: "user", text: "fix" }], { card: approval(small), ...running }));
  const ty = rowOf(g, "needs your permission");
  expect(span(g, 2, ty)).toEqual(["you  · sent", "  fix", ""]); // both message rows survive above the card
  expect(span(g, ty + 1, 12)).toEqual(["  @@ -1,3 +1,3 @@", "   a", "  -b", "  +B", "   c", BUTTONS]);
  expect(g.toText()).not.toContain("--- a/"); expect(g.toText()).not.toContain("+++ b/");
  expect(g.cell(BX + 2, rowOf(g, "-b")).fg).toBe(THEME.err); expect(g.cell(BX + 2, rowOf(g, "+B")).fg).toBe(THEME.ok);
  // a 9-line hunk into 5 rows: 4 lines + a marker that accounts for every hidden line
  const before = Array.from({ length: 10 }, (_, i) => `line-${i + 1}`).join("\n") + "\n";
  const big = realDiff(before, before.replace("line-5", "LINE-5"));
  expect(big.split("\n")).toHaveLength(11);
  const gb = draw(msgState([{ kind: "user", text: "fix" }], { card: approval(big), ...running }));
  const tb = rowOf(gb, "needs your permission");
  expect(span(gb, tb + 1, 12)).toEqual(["  @@ -2,7 +2,7 @@", "   line-2", "   line-3", "   line-4", "  … +5 more lines", BUTTONS]);
  expect(cardShape(approval(big), BW, 5)).toEqual({ total: 8, freeText: null });
  expect(cardRows(approval(big), BW, 5, THEME)).toHaveLength(8);
  expect(cardRows(approval(big), BW, 21, THEME).slice(2, -1).map((r) => rowText(r.segs))).toEqual(big.split("\n").slice(2)); // room for all: the 9 body lines, nothing else
  expect(cardShape(approval(big), BW, 21)).toEqual({ total: 12, freeText: null }); // shape counts the same header-less lines the rows draw…
  const gt = draw(msgState([{ kind: "user", text: "fix" }], { card: approval(big), ...running }), { x: 2, y: 1, w: 70, h: 30 });
  expect(rowOf(gt, " allow ")).toBe(28 - 1); // …so the buttons sit right above the rule (y 28) instead of two blank rows up
  // h = 6 (rect h 10): budget 2 → title, `@@` + marker, buttons; one message row survives above the card
  const g6 = draw(msgState([{ kind: "user", text: "fix" }], { card: approval(big), ...running }), { x: 2, y: 1, w: 70, h: 10 });
  expect(span(g6, 2, 8)).toEqual(["  fix", "", "◆ needs your permission   write f.txt", "  @@ -2,7 +2,7 @@", "  … +8 more lines", BUTTONS]);
  expect(g6.row(8).slice(BX, BX + 3)).toBe("╌╌╌");
  // a non-diff detail is untouched by the header skip
  expect(cardRows(approval("diff unavailable: binary file"), BW, 5, THEME).map((r) => rowText(r.segs))[2]).toBe("diff unavailable: binary file");
  expect(cardShape(approval("diff unavailable: binary file"), BW, 5).total).toBe(4);
});

// ------------------------------------------------------------------ MED-3: long tool names keep a separator

test("tool names of any length keep ≥1 space before the label: ≤6 chars pad to 7 as before, 7+ chars get one space (ask_user, todo_write, MCP names)", () => {
  const other = (name: string, label: string, detail?: string): string => rowText(toolRow(tool({ verb: "other", tool: name, label, detail }), 40, THEME, 0));
  expect(rowText(toolRow(tool({ verb: "read", label: "x" }), 40, THEME, 0))).toBe("· read   x");
  expect(other("recall", "notes")).toBe("· recall notes");
  expect(other("compact", "3 turns")).toBe("· compact 3 turns");
  expect(other("ask_user", "Which database?")).toBe("· ask_user Which database?");
  expect(other("todo_write", "3 items")).toBe("· todo_write 3 items");
  expect(other("mcp_fetch_v2", "example.com")).toBe("· mcp_fetch_v2 example.com");
  const detailed = other("todo_write", "3 items", "ok");
  expect(detailed).toBe("· todo_write 3 items" + " ".repeat(40 - 20 - 4) + "… ok"); // the detail still lands on the right edge
  expect(detailed).toHaveLength(40);
});

// ------------------------------------------------------------------ LOW-1: `needs you` while a card is open

test("run header while a card waits: `needs you` (the frame header's word) instead of the raw activity, for approval and question cards", () => {
  const live = msgState([{ kind: "user", text: "fix" }, tool({ verb: "read" })], { card: approval("+x"), ...running });
  expect(activityLabel(live)).toBe("needs you");
  expect(rowsOf(live)).toContain("◆ aion  · needs you");
  const g = draw(live);
  expect(g.span(BX, rowOf(g, "◆ aion"), BW)).toBe("◆ aion  · needs you");
  const q: CardState = { kind: "question", prompt: { question: "Which?", options: ["a"], allowFreeText: false }, selected: 0, freeText: "", resolve: noop };
  expect(activityLabel(msgState([], { card: q, running: true, activity: { state: "THINKING", label: "thinking", runId: "r", startedAt: 0, endedAt: null } }))).toBe("needs you");
  expect(activityLabel(msgState([], { card: q }))).toBe("needs you"); // idle + card → still the user's move
  expect(activityLabel(msgState([], running))).toBe("writing"); // no card → the live activity as before
  expect(activityLabel(msgState([], { activity: { state: "SUCCESS", label: "done", runId: "r", startedAt: 0, endedAt: 1 } }))).toBe("done");
});

// ------------------------------------------------------------------ LOW-2: one cell per code point

test("wrap/hardWrap split by code points — an emoji is one cell, no chunk ends in a lone surrogate — and BMP text wraps exactly as before", () => {
  const party = "🎉ok 🎉ok 🎉ok"; // 11 code points, 14 UTF-16 units
  expect(hardWrap(party, 7)).toEqual(["🎉ok 🎉ok", " 🎉ok"]);
  expect(hardWrap("🎉".repeat(9), 4)).toEqual(["🎉🎉🎉🎉", "🎉🎉🎉🎉", "🎉"]);
  expect(hardWrap("a🎉b", 2)).toEqual(["a🎉", "b"]);
  expect(wrap("🎉🎉🎉🎉 ok", 3)).toEqual(["🎉🎉🎉", "🎉", "ok"]);
  expect(wrap(party, 5)).toEqual(["🎉ok", "🎉ok", "🎉ok"]);
  expect(wrap(party, 7)).toEqual(["🎉ok 🎉ok", "🎉ok"]);
  for (const chunk of [...hardWrap(party, 7), ...hardWrap("🎉".repeat(9), 4), ...hardWrap("a🎉b", 2), ...wrap("🎉🎉🎉🎉 ok", 3), ...wrap(party, 5)]) expect(chunk).not.toMatch(LONE);
  expect(wrap("hello world this is a test", 11)).toEqual(["hello world", "this is a", "test"]);
  expect(wrap("short averyveryverylongword", 8)).toEqual(["short", "averyver", "yverylon", "gword"]);
  expect(wrap("one  two", 5)).toEqual(["one ", "two"]);
  expect(wrap("a\nb c", 3)).toEqual(["a", "b c"]);
  expect(wrap("", 5)).toEqual([""]);
  expect(hardWrap("", 3)).toEqual([""]);
  expect(hardWrap("abcdefg", 3)).toEqual(["abc", "def", "g"]);
});

test("toolRow and the assistant rows measure cells per code point: an emoji label yields exactly w cells, clipping never splits a pair, emoji text wraps at the inner width", () => {
  const text = rowText(toolRow(tool({ verb: "read", label: "🎉 party.ts", detail: "3 lines" }), 40, THEME, 0));
  expect([...text]).toHaveLength(40); // 40 cells, not 39
  expect(text).toBe("· read   🎉 party.ts" + " ".repeat(40 - 2 - 7 - 10 - 9) + "… 3 lines");
  const clipped = rowText(toolRow(tool({ verb: "read", label: "🎉".repeat(32) }), 20, THEME, 0));
  expect(clipped).toBe("· read   " + "🎉".repeat(10) + "…");
  expect([...clipped]).toHaveLength(20);
  expect(clipped).not.toMatch(LONE);
  const g = draw(msgState([{ kind: "user", text: "go" }, { kind: "assistant", text: "🎉".repeat(70), streaming: false }]));
  const rows = span(g, 2, 12).filter((r) => r.includes("🎉"));
  expect(rows.map((r) => [...r].length)).toEqual([2 + IW, 2 + 6]); // 64 + 6 glyphs, two rows — not three rows of 32
  for (const r of rows) expect(r).not.toMatch(LONE);
});

// ------------------------------------------------------------------ cosmetic: the run header precedes any first row

test("a system or compaction row that opens a run draws the `◆ aion` header first; idle notes before any user row get no header", () => {
  const denied = msgState([{ kind: "user", text: "fix" }, { kind: "system", text: "permission denied: user denied", tone: "error" }, tool({ verb: "read", label: "note.ts", detail: "3 lines" })],
    { running: true, activity: { state: "ERROR", label: "note.ts denied", runId: "r", startedAt: 0, endedAt: null } });
  const r = rowsOf(denied);
  expect(r.slice(0, 5)).toEqual(["you  · sent", "  fix", "", "◆ aion  · note.ts denied", "× permission denied: user denied"]);
  expect(r[5]).toMatch(/^ {2}· read {3}note\.ts {2,}… 3 lines$/);
  expect(r).toHaveLength(6); // one header per run
  const g = draw(denied);
  expect(rowOf(g, "◆ aion")).toBeLessThan(rowOf(g, "× permission denied"));
  const ended = msgState([{ kind: "user", text: "fix" }, { kind: "system", text: "boom", tone: "error" }], { activity: { state: "ERROR", label: "error", runId: "r", startedAt: 0, endedAt: 1 } });
  expect(rowsOf(ended)).toEqual(["you  · sent", "  fix", "", "◆ aion  · error", "× boom"]); // a run whose only row is its failure
  const compacted = msgState([{ kind: "user", text: "go" }, { kind: "compaction", text: "compacted 12 turns" }], { activity: { state: "SUCCESS", label: "done", runId: "r", startedAt: 0, endedAt: 1 } });
  expect(rowsOf(compacted)).toEqual(["you  · sent", "  go", "", "◆ aion  · done", "▸ compacted 12 turns"]);
  const goalRun = msgState([{ kind: "system", text: "boom", tone: "error" }], running); // a run started from the CLI goal: no user row, but live
  expect(rowsOf(goalRun)).toEqual(["", "◆ aion  · writing", "× boom"]);
  const older = msgState([{ kind: "user", text: "a" }, { kind: "system", text: "denied", tone: "error" }, { kind: "user", text: "b" }, { kind: "assistant", text: "B", streaming: false }],
    { activity: { state: "SUCCESS", label: "done", runId: "r", startedAt: 0, endedAt: 1 } });
  expect(rowsOf(older).filter((l) => l.startsWith("◆ aion"))).toEqual(["◆ aion", "◆ aion  · done"]); // the earlier run's header keeps just the diamond
  const idle = msgState([{ kind: "system", text: "plan mode on", tone: "info" }, { kind: "system", text: "yolo off", tone: "info" }]);
  expect(rowsOf(idle)).toEqual(["▸ plan mode on", "▸ yolo off"]); // no run → no header, no blank
});
