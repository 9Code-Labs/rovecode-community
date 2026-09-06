/** Port #42 critic findings pinned as regressions (each reproduced through the real edit tool /
 *  composed frames): a FAILED edit row shows its rejection, never `+a −b` (MED-1); the approval card
 *  drops the `---`/`+++` header pair and budgets `h − 5` detail rows so a small hunk shows its +/−
 *  lines at the frame's 160×44 message height (MED-2); tool names of 7+ chars keep a space before the
 *  label (MED-3); the run header says `needs you` while a card is open, like the frame header (LOW-1);
 *  wrap/hardWrap/toolRow count cells per code point — no split surrogate pairs, no 39-cell "40-cell"
 *  rows (LOW-2); a system/compaction row that opens a run draws the `◆ rovecode` header first; the live
 *  line — a run that has said nothing shows `◆ rovecode  · <word>  14s · 1.2k tokens`, the word
 *  rotating every 4 s from QUIPS.thinking, the tail degrading tokens-then-clock to the width. */

import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CardState, MessageRow, Seg, SextantState, ToolRow } from "../../src/sextant/types.ts";
import { activityLabel, buildRows, cardRows, cardShape, drawMessages, toolRow } from "../../src/sextant/draw-messages.ts";
import { hardWrap, wrap } from "../../src/sextant/draw-util.ts";
import { layout } from "../../src/sextant/layout.ts";
import { applyEvent } from "../../src/sextant/model.ts";
import { summarizeEnd } from "../../src/sextant/tool-rows.ts";
import { previewDiff } from "../../src/coding/diff.ts";
import { describeEditFailure } from "../../src/coding/hashline.ts";
import { GridScreen, THEME, baseState } from "../helpers/sextant-grid.ts";
import { activityLabel as frameLabel } from "../../src/sextant/draw-frame.ts";

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
const approval = (detail: string, selected: 0 | 1 | 2 = 0): CardState => ({ kind: "approval", verdicts: ["once", "always", "deny"], tool: "write", argsPreview: "f.txt", detail, selected, resolve: noop });
/** a real previewDiff of writing `after` over a file that holds `before` */
function realDiff(before: string, after: string): string {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-f42-"));
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

// ------------------------------------------------------------------ re-verify MED: the reason survives at the frame's width

/** the REAL rejection the edit tool emits for a stale anchor, with an absolute temp path in the message */
const REJECTION = describeEditFailure({ kind: "hash-mismatch", path: "C:\\Users\\admins\\AppData\\Local\\Temp\\rovecode-sextant-Ab3xYz\\notes.txt", line: 2, expected: "cd3", actual: "e5f", nearest: "", text: "old-line", matches: [] });
const REASON = "Edit rejected: anchor mismatch — line 2 now reads \"old-line\" (hash e5f), your anchor expected hash cd3.";

test("a failed edit's row detail drops the ` at <abs path>:N` locator (the label names the file) so the 80-cell detail carries the reason and what the line holds now; other verbs keep their text", () => {
  expect(REJECTION).toContain(" at C:\\Users\\admins\\AppData\\Local\\Temp\\rovecode-sextant-Ab3xYz\\notes.txt:2 — ");
  const end = summarizeEnd({ verb: "edit" }, "edit", false, REJECTION);
  expect(end.detail).not.toContain("Temp");
  expect(end.detail!.startsWith(REASON.slice(0, 79))).toBe(true);           // firstLine's 80-cell clip lands inside the reason's tail, not the path
  expect([...end.detail!]).toHaveLength(80);
  expect(summarizeEnd({ verb: "write" }, "write", false, "Write rejected: directory C:\\x does not exist — create it first").detail).toBe("Write rejected: directory C:\\x does not exist — create it first");
  expect(summarizeEnd({ verb: "read" }, "read", false, "read failed at C:\\x\\y.ts:3 — nope").detail).toBe("read failed at C:\\x\\y.ts:3 — nope"); // only file-writing verbs strip
});

test("a failed edit row at 60 / 83 / 120 cells keeps its reason: the label stays whole, the detail is clipped with … to the room left (never dropped), the row is exactly w cells; at 120 the whole detail fits", () => {
  const detail = summarizeEnd({ verb: "edit" }, "edit", false, REJECTION).detail!;
  const row = (w: number): string => rowText(toolRow(tool({ verb: "edit", label: "notes.txt", ok: false, add: 1, del: 1, detail }), w, THEME, 0));
  const r60 = row(60), r83 = row(83), r120 = row(120);
  for (const [w, r] of [[60, r60], [83, r83], [120, r120]] as [number, string][]) {
    expect(r.startsWith("~ edit   notes.txt  ")).toBe(true);                 // the label is never clipped for a 9-cell name
    expect(r).toContain("Edit rejected: anchor mismatch");                  // (mutation: the drop rule → a bare `~ edit   notes.txt`)
    expect([...r]).toHaveLength(w);
    expect(r).not.toContain("+1"); expect(r).not.toContain("−1");
  }
  expect(r60).toBe("~ edit   notes.txt  " + [...detail].slice(0, 39).join("") + "…");   // room 51 − 9 − 2 = 40 cells of detail
  expect(r83).toBe("~ edit   notes.txt  " + [...detail].slice(0, 62).join("") + "…");   // room 74 − 9 − 2 = 63
  expect(r83).toContain("line 2 now reads \"old-line\"");                    // the tail the critic wanted, not the path
  expect(r120).toBe("~ edit   notes.txt" + " ".repeat(120 - 2 - 7 - 9 - 80) + detail); // fits whole, right-aligned
  // a long label yields down to 24 cells before the detail is clipped; a detail with under 6 cells of room is dropped; the counts pair is dropped whole when it cannot fit
  const long = rowText(toolRow(tool({ verb: "edit", label: "a-very-long-file-name-that-goes-on-and-on.ts", ok: false, detail }), 60, THEME, 0));
  expect(long.startsWith("~ edit   a-very-long-file-name-t…  Edit rejected")).toBe(true);
  expect([...long]).toHaveLength(60);
  expect(rowText(toolRow(tool({ verb: "edit", label: "notes.txt", ok: false, detail }), 22, THEME, 0))).toBe("~ edit   notes.txt");       // room 13: 13 − 9 − 2 = 2 < 6 → dropped
  expect(rowText(toolRow(tool({ verb: "edit", label: "a-very-long-file-name.ts", add: 21, del: 4 }), 30, THEME, 0))).toBe("~ edit   a-very-long-…  +21 −4"); // the prototype's rule: the label yields only what the pair needs
  expect(rowText(toolRow(tool({ verb: "edit", label: "a-very-long-file-name.ts", add: 21, del: 4 }), 22, THEME, 0))).toBe("~ edit   a-very-long-…");        // under 8 label cells left → the pair is dropped whole
});

test("composed at the frame's 160×44 messages rect through the real reducer + real rejection text: the failed edit row shows its reason (previously a bare red `~ edit notes.txt`)", () => {
  const L = layout(160, 44, { pet: true });
  const s = baseState({ cwd: "C:/repo" });
  applyEvent(s, { type: "run_start", runId: "r1", sessionId: "sess", goal: "fix" }, 0);
  s.messages.push({ kind: "user", text: "fix the note" });
  applyEvent(s, { type: "tool_execution_start", callId: "e1", tool: "edit", args: { path: "C:/repo/notes.txt", edits: [{ tag: "a1b2", anchorLine: 2, anchorHash: "cd3", newLines: ["x"] }] } }, 1);
  applyEvent(s, { type: "tool_execution_end", callId: "e1", ok: false, output: REJECTION, durationMs: 3 }, 2);
  const g = new GridScreen(160, 44, "░");
  drawMessages(g, L.messages, s, THEME, 0);
  const y = rowOf(g, "~ edit");
  const line = g.span(L.messages.x + 2, y, L.messages.w - 4);
  expect(line).toMatch(/^ {2}~ edit {3}notes\.txt {2}Edit rejected: anchor mismatch — line 2 now reads "old-line" \(…$/); // 63 cells of detail beside the 9-cell label
  expect(line).not.toContain("Temp");
  expect(g.cell(g.row(y).indexOf("Edit rejected"), y).fg).toBe(THEME.err);
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
  expect(rowsOf(live)).toContain("◆ rovecode  · needs you");
  const g = draw(live);
  expect(g.span(BX, rowOf(g, "◆ rovecode"), BW)).toBe("◆ rovecode  · needs you");
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

test("a system or compaction row that opens a run draws the `◆ rovecode` header first; idle notes before any user row get no header", () => {
  const denied = msgState([{ kind: "user", text: "fix" }, { kind: "system", text: "permission denied: user denied", tone: "error" }, tool({ verb: "read", label: "note.ts", detail: "3 lines" })],
    { running: true, activity: { state: "ERROR", label: "note.ts denied", runId: "r", startedAt: 0, endedAt: null } });
  const r = rowsOf(denied);
  expect(r.slice(0, 5)).toEqual(["you  · sent", "  fix", "", "◆ rovecode  · note.ts denied", "× permission denied: user denied"]);
  expect(r[5]).toMatch(/^ {2}· read {3}note\.ts {2,}… 3 lines$/);
  expect(r).toHaveLength(6); // one header per run
  const g = draw(denied);
  expect(rowOf(g, "◆ rovecode")).toBeLessThan(rowOf(g, "× permission denied"));
  const ended = msgState([{ kind: "user", text: "fix" }, { kind: "system", text: "boom", tone: "error" }], { activity: { state: "ERROR", label: "error", runId: "r", startedAt: 0, endedAt: 1 } });
  expect(rowsOf(ended)).toEqual(["you  · sent", "  fix", "", "◆ rovecode  · error", "× boom"]); // a run whose only row is its failure
  const compacted = msgState([{ kind: "user", text: "go" }, { kind: "compaction", text: "compacted 12 turns" }], { activity: { state: "SUCCESS", label: "done", runId: "r", startedAt: 0, endedAt: 1 } });
  expect(rowsOf(compacted)).toEqual(["you  · sent", "  go", "", "◆ rovecode  · done", "▸ compacted 12 turns"]);
  const goalRun = msgState([{ kind: "system", text: "boom", tone: "error" }], running); // a run started from the CLI goal: no user row, but live
  expect(rowsOf(goalRun)).toEqual(["", "◆ rovecode  · writing", "× boom"]);
  const older = msgState([{ kind: "user", text: "a" }, { kind: "system", text: "denied", tone: "error" }, { kind: "user", text: "b" }, { kind: "assistant", text: "B", streaming: false }],
    { activity: { state: "SUCCESS", label: "done", runId: "r", startedAt: 0, endedAt: 1 } });
  expect(rowsOf(older).filter((l) => l.startsWith("◆ rovecode"))).toEqual(["◆ rovecode", "◆ rovecode  · done"]); // the earlier run's header keeps just the diamond
  const idle = msgState([{ kind: "system", text: "plan mode on", tone: "info" }, { kind: "system", text: "yolo off", tone: "info" }]);
  expect(rowsOf(idle)).toEqual(["▸ plan mode on", "▸ yolo off"]); // no run → no header, no blank
});

test("live line: a silent run shows `◆ rovecode  · <word>  14s · 1.2k tokens`; the word rotates every 4 s, the tail drops tokens then the clock to fit; tools, cards and idle keep the old header", () => {
  const live = (tokens: number, state: "THINKING" | "WRITING" = "THINKING", rows: MessageRow[] = [{ kind: "user", text: "fix" }]): SextantState =>
    msgState(rows, { running: true, activity: { state, label: state.toLowerCase(), runId: "r", startedAt: 0, endedAt: null, turnAt: 0, tokens } });
  const rowsAt = (s: SextantState, now: number, w = BW): string[] => buildRows(s, w, THEME, now).map((r) => " ".repeat(r.indent ?? 0) + rowText(r.segs));
  expect(rowsAt(live(0), 0)).toEqual(["you  · sent", "  fix", "", "◆ rovecode  · thinking  0s"]); // the header exists before the first token; no count while it is 0
  expect(rowsAt(live(1200), 14_000)).toEqual(["you  · sent", "  fix", "", "◆ rovecode  · mulling  14s · 1.2k tokens"]); // 14 s → the fourth word
  expect([3_999, 4_000, 32_000, 406_000].map((t) => rowsAt(live(1200), t).at(-1))).toEqual([
    "◆ rovecode  · thinking  3s · 1.2k tokens", // the familiar word for the first 4 s
    "◆ rovecode  · brewing  4s · 1.2k tokens",
    "◆ rovecode  · thinking  32s · 1.2k tokens", // eight words: wraps at 32 s
    "◆ rovecode  · condensing  6m 46s · 1.2k tokens", // 101 steps → index 5
  ]);
  // width: the token count goes first, then the clock, the word never
  expect(rowsAt(live(1200), 14_000, 40).at(-1)).toBe("◆ rovecode  · mulling  14s · 1.2k tokens"); // 40 cells exactly
  expect(rowsAt(live(1200), 14_000, 39).at(-1)).toBe("◆ rovecode  · mulling  14s");
  expect(rowsAt(live(1200), 14_000, 26).at(-1)).toBe("◆ rovecode  · mulling  14s"); // 26 cells exactly
  expect(rowsAt(live(1200), 14_000, 25).at(-1)).toBe("◆ rovecode  · mulling");
  // writing: the activity's own word, the tail stays and counts the answer too
  const writing = live(301, "WRITING", [{ kind: "user", text: "fix" }, { kind: "assistant", text: "Hel", streaming: true }]);
  expect(rowsAt(writing, 15_000)).toEqual(["you  · sent", "  fix", "", "◆ rovecode  · writing  15s · 301 tokens", "  Hel▌"]);
  // a tool runs (no turn in flight): the plain label and no tail; idle: no header at all
  const tooling = msgState([{ kind: "user", text: "fix" }, tool({ running: true })], { running: true, activity: { state: "READING", label: "reading callback.ts", runId: "r", startedAt: 0, endedAt: null } });
  expect(rowsAt(tooling, 14_000)[3]).toBe("◆ rovecode  · reading callback.ts");
  expect(rowsAt(msgState([{ kind: "user", text: "fix" }]), 14_000)).toEqual(["you  · sent", "  fix"]);
  // one word per screen: the frame header rotates with the same clock, and keeps its plain label otherwise
  expect(frameLabel(live(1200), 14_000)).toBe("mulling");
  expect(frameLabel(tooling, 14_000)).toBe("reading callback.ts");
  expect(activityLabel(live(1200))).toBe("thinking"); // without a clock (the pet's mood path) the word is the plain one
  // the painted row at the 100×30 floor's narrowest messages panel (layout fallback: 40 cells inner) fits the frame
  const narrow = new GridScreen(60, 10, "░");
  drawMessages(narrow, { x: 0, y: 0, w: 44, h: 8 }, live(1200), THEME, 14_000);
  expect(narrow.span(0, 4, 44)).toBe("│ ◆ rovecode  · mulling  14s · 1.2k tokens │"); // inner 40: the full line ends at the border
  expect(narrow.row(4).slice(44)).toBe("░".repeat(16)); // nothing past it
});
