/** Port #42 — messages panel painter. Pins: tool row wording per verb (spinner while running,
 *  detail when done, +a −b stats, failure color, narrow widths), user rows (`you · sent` on the
 *  latest, @mentions, image chips), the `◆ rovecode · <status>` run header, streaming caret, steer /
 *  compaction / system / error rows, the approval card (previewDiff text from a real file, bounded
 *  detail, three verdicts with the selected one inverted), the question card (options, free-text
 *  row, skip row, selection), the ╌ rule, the prompt line + placeholder + cursor cell, stick /
 *  msgScroll geometry, wrapping, the pinned card, nothing outside the rect. */

import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ATTR, SPIN, type CardState, type MessageRow, type SextantState, type ToolRow } from "../../src/sextant/types.ts";
import { FREE_TEXT_HINT, SKIP_LABEL, activityLabel, buildRows, cardRows, cardShape, drawMessages, messagesScroll, promptCursor, toolRow } from "../../src/sextant/draw-messages.ts";
import { previewDiff } from "../../src/coding/diff.ts";
import { GridScreen, THEME, baseState, untouchedOutside } from "../helpers/sextant-grid.ts";

const RECT = { x: 2, y: 1, w: 70, h: 16 }; // inner (4,2) 66×14 → 12 message rows y 2..13, rule y 14, prompt y 15
const BX = 4, BY = 2, BW = 66, RULE_Y = 14, PROMPT_Y = 15, IW = BW - 2;
const TALL = { x: 2, y: 1, w: 70, h: 26 }; // same columns, 22 message rows (y 2..23), rule y 24
const noop = (): void => {};

function draw(s: SextantState, now = 0, grid = new GridScreen(90, 24, "░")): GridScreen {
  drawMessages(grid, RECT, s, THEME, now);
  return grid;
}
const drawTall = (s: SextantState, now = 0): GridScreen => { const g = new GridScreen(90, 30, "░"); drawMessages(g, TALL, s, THEME, now); return g; };
const msgState = (messages: MessageRow[], over: Partial<SextantState> = {}): SextantState => baseState({ messages, ...over });
const tool = (over: Partial<ToolRow>): ToolRow => ({ kind: "tool", callId: "c1", tool: over.verb ?? "read", verb: "read", label: "callback.ts", running: false, ok: true, ...over });
/** rows of the message area as trimmed strings (x from the inner left edge) */
const rows = (g: GridScreen, from = BY, to = RULE_Y): string[] => Array.from({ length: to - from }, (_, i) => g.span(BX, from + i, BW));
const rowOf = (g: GridScreen, needle: string): number => { for (let y = 0; y < g.h; y++) if (g.row(y).includes(needle)) return y; return -1; };
const running = { running: true, activity: { state: "EDITING" as const, label: "editing callback.ts", runId: "r", startedAt: 0, endedAt: null } };

// ------------------------------------------------------------------ tool rows

test("tool rows: `· read <base> … N lines`, `~ edit <base> +a −b`, `+ write`, `− remove`, `$ run <cmd> … <last line>`, ⌕ search, ↗ fetch, » task", () => {
  const g = drawTall(msgState([{ kind: "user", text: "go" },
    tool({ verb: "read", label: "callback.ts", detail: "12 lines" }),
    tool({ verb: "edit", label: "callback.ts", add: 21, del: 4 }),
    tool({ verb: "write", label: "guard.ts" }),
    tool({ verb: "remove", label: "old.ts" }),
    tool({ verb: "run", label: "bun test", detail: "18 passed" }),
    tool({ verb: "search", label: "**/*.ts", detail: "7 files" }),
    tool({ verb: "fetch", label: "example.com", detail: "text/html 12kB" }),
    tool({ verb: "task", label: "write tests" }),
    tool({ verb: "other", tool: "todo", label: "3 items" })]));
  const r = rows(g, BY, TALL.y + TALL.h - 2).filter(Boolean);
  expect(r[0]).toBe("you  · sent");
  expect(r[1]).toBe("  go");
  expect(r[2]).toBe("◆ rovecode"); // idle → header without a status word
  expect(r[3]).toMatch(/^ {2}· read {3}callback\.ts {2,}… 12 lines$/);
  expect(r[3]!.length).toBe(BW); // detail right-aligned to the inner edge
  expect(r[4]).toMatch(/^ {2}~ edit {3}callback\.ts {2,}\+21 −4$/);
  expect(r[5]).toBe("  + write  guard.ts");
  expect(r[6]).toBe("  − remove old.ts");
  expect(r[7]).toMatch(/^ {2}\$ run {4}bun test {2,}… 18 passed$/);
  expect(r[8]).toMatch(/^ {2}⌕ search \*\*\/\*\.ts {2,}… 7 files$/);
  expect(r[9]).toMatch(/^ {2}↗ fetch {2}example\.com {2,}… text\/html 12kB$/);
  expect(r[10]).toBe("  » task   write tests");
  expect(r[11]).toBe("  · todo   3 items"); // verb "other" shows the tool name
  const y = rowOf(g, "~ edit");
  const row = g.row(y);
  expect(g.cell(row.indexOf("+21"), y).fg).toBe(THEME.ok);
  expect(g.cell(row.indexOf("−4"), y).fg).toBe(THEME.err);
  expect(g.cell(BX + 2, y).fg).toBe(THEME.fg2); // ~ + − glyphs read as fg2, · as dim
  const ry = rowOf(g, "· read");
  expect(g.cell(BX + 2, ry).fg).toBe(THEME.dim);
  expect(g.cell(g.row(ry).indexOf("… 12"), ry).fg).toBe(THEME.muted);
});

test("tool rows: the spinner (phase from `now`, accent) replaces the glyph while running; done shows the detail; a failed call turns red", () => {
  const live = msgState([{ kind: "user", text: "go" }, tool({ verb: "read", running: true, ok: undefined })], running);
  const t0 = draw(live, 0), t1 = draw(live, 140), t2 = draw(live, 280);
  expect(rows(t0).filter(Boolean)[3]).toBe(`  ${SPIN[0]} read   callback.ts`);
  expect(rows(t1).filter(Boolean)[3]).toBe(`  ${SPIN[1]} read   callback.ts`);
  expect(rows(t2).filter(Boolean)[3]).toBe(`  ${SPIN[2]} read   callback.ts`);
  const y = rowOf(t0, "read   callback");
  expect(t0.cell(BX + 2, y).fg).toBe(THEME.accent);
  expect(t0.cell(BX + 4, y).fg).toBe(THEME.fg2); // verb brightens while live
  expect(t0.cell(BX + 11, y).fg).toBe(THEME.fg);
  const done = draw(msgState([{ kind: "user", text: "go" }, tool({ verb: "read", detail: "12 lines" })]));
  expect(rows(done).filter(Boolean)[3]).toMatch(/^ {2}· read {3}callback\.ts {2,}… 12 lines$/);
  const failed = draw(msgState([{ kind: "user", text: "go" }, tool({ verb: "run", label: "bun test", ok: false, detail: "exit 1" })]));
  const fy = rowOf(failed, "$ run");
  expect(failed.span(BX, fy, BW)).toMatch(/^ {2}\$ run {4}bun test {2,}… exit 1$/);
  expect(failed.cell(BX + 2, fy).fg).toBe(THEME.err);
  expect(failed.cell(BX + 11, fy).fg).toBe(THEME.err);
  expect(failed.cell(failed.row(fy).indexOf("… exit"), fy).fg).toBe(THEME.err);
  const edited = draw(msgState([{ kind: "user", text: "go" }, tool({ verb: "edit", detail: "+3 −1" })])); // no add/del numbers → the detail text as is
  expect(rows(edited).filter(Boolean)[3]).toMatch(/^ {2}~ edit {3}callback\.ts {2,}\+3 −1$/);
});

test("tool rows: narrow widths clip the label before dropping the detail; never wider than w", () => {
  const long = tool({ verb: "run", label: "bun test --coverage --timeout 20000 test/unit/very-long-name.test.ts", detail: "18 passed" });
  for (const w of [12, 20, 30, 45, 64]) {
    const segs = toolRow(long, w, THEME, 0);
    const text = segs.map(([t]) => t).join("");
    expect(text.length).toBeLessThanOrEqual(w);
    expect(text.startsWith(w >= 30 ? "$ run    bun te" : "$ run    bu")).toBe(true);
    if (w === 30) expect(text).toBe("$ run    bun tes…  … 18 passed"); // label clipped to 8 cells so the detail fits
    if (w >= 30) expect(text.endsWith("… 18 passed")).toBe(true); else expect(text).not.toContain("18 passed");
    if (w >= 30) expect(text).toContain("…"); // clipped label carries an ellipsis
  }
  expect(toolRow(tool({ verb: "edit", add: 0, del: 0 }), 40, THEME, 0).map(([t]) => t).join("")).toBe("~ edit   callback.ts"); // zero stats → nothing
});

// ------------------------------------------------------------------ user / assistant / other rows

test("user rows: `you  · sent` only on the latest user message, bold text, @mentions accented, image chips", () => {
  const g = draw(msgState([{ kind: "user", text: "look at @src/auth/callback.ts please" }, { kind: "assistant", text: "ok", streaming: false }, { kind: "user", text: "and this", images: ["shot.png", "diagram.jpg"] }]));
  const r = rows(g);
  expect(r[0]).toBe("you");
  expect(g.cell(BX, BY).fg).toBe(THEME.muted);
  expect(r[1]).toBe("  look at @src/auth/callback.ts please");
  const at = g.row(BY + 1).indexOf("@src");
  expect(g.cell(at, BY + 1)).toMatchObject({ fg: THEME.accent, at: ATTR.BOLD });
  expect(g.cell(BX + 2, BY + 1)).toMatchObject({ fg: THEME.fg, at: ATTR.BOLD });
  const y = rowOf(g, "you  · sent");
  expect(y).toBeGreaterThan(BY + 1);
  expect(g.cell(BX, y).fg).toBe(THEME.accent);
  expect(g.cell(BX + 5, y).fg).toBe(THEME.accentDim);
  expect(g.span(BX, y + 1, BW)).toBe("  and this");
  expect(g.span(BX, y + 2, BW)).toBe("   ▣ shot.png    ▣ diagram.jpg");
  expect(g.cell(BX + 3, y + 2).bg).toBe(THEME.selBg);
});

test("run header `◆ rovecode  · <status>`: live activity while running, done/error/needs you after, older runs keep just the diamond", () => {
  const live = draw(msgState([{ kind: "user", text: "fix" }, { kind: "assistant", text: "Looking.", streaming: false }], running));
  const y = rowOf(live, "◆ rovecode");
  expect(live.span(BX, y, BW)).toBe("◆ rovecode  · editing callback.ts");
  expect(live.cell(BX, y).fg).toBe(THEME.accent);
  expect(live.cell(live.row(y).indexOf("editing"), y).fg).toBe(THEME.accent); // the live status word takes the accent
  expect(live.cell(BX + 2, y)).toMatchObject({ fg: THEME.fg, at: ATTR.BOLD });
  expect(live.span(BX, y + 1, BW)).toBe("  Looking.");
  const done = draw(msgState([{ kind: "user", text: "fix" }, { kind: "assistant", text: "Fixed.", streaming: false }], { activity: { state: "SUCCESS", label: "done", runId: "r", startedAt: 0, endedAt: 1 } }));
  const dy = rowOf(done, "◆ rovecode");
  expect(done.span(BX, dy, BW)).toBe("◆ rovecode  · done");
  expect(done.cell(BX, dy).fg).toBe(THEME.ok);
  expect(done.cell(done.row(dy).indexOf("done"), dy).fg).toBe(THEME.muted);
  const err = draw(msgState([{ kind: "user", text: "fix" }, tool({ verb: "run", label: "bun test", ok: false })], { activity: { state: "ERROR", label: "", runId: "r", startedAt: 0, endedAt: 1 } }));
  const ey = rowOf(err, "◆ rovecode");
  expect(err.span(BX, ey, BW)).toBe("◆ rovecode  · error"); // the header precedes a run that opened with a tool
  expect(err.cell(BX, ey).fg).toBe(THEME.err);
  const two = draw(msgState([{ kind: "user", text: "one" }, { kind: "assistant", text: "A", streaming: false }, { kind: "user", text: "two" }, { kind: "assistant", text: "B", streaming: false }], { activity: { state: "WAITING", label: "waiting for you", runId: "r", startedAt: 0, endedAt: null } }));
  const heads = rows(two).filter((r) => r.startsWith("◆ rovecode"));
  expect(heads).toEqual(["◆ rovecode", "◆ rovecode  · needs you"]);
  expect(two.cell(BX, rowOf(two, "◆ rovecode")).fg).toBe(THEME.accentDim);
  expect(activityLabel(baseState({ running: true, activity: { state: "THINKING", label: "", runId: "r", startedAt: 0, endedAt: null } }))).toBe("thinking");
  expect(activityLabel(baseState())).toBe("");
});

test("assistant text wraps to the inner width; the streaming caret ▌ rides the last line (or stands alone on an empty stream)", () => {
  const words = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");
  const g = draw(msgState([{ kind: "user", text: "go" }, { kind: "assistant", text: words, streaming: true }], running));
  const body = rows(g).filter((r) => r.startsWith("  word"));
  expect(body.length).toBeGreaterThan(1);
  for (const r of body) expect(r.length).toBeLessThanOrEqual(BW);
  expect(body.at(-1)!.endsWith("▌")).toBe(true);
  expect(body.join(" ").replace(/▌$/, "").replace(/\s+/g, " ").trim()).toBe(words);
  const y = rowOf(g, "▌");
  expect(g.cell(g.row(y).lastIndexOf("▌"), y).fg).toBe(THEME.accent);
  const still = draw(msgState([{ kind: "user", text: "go" }, { kind: "assistant", text: "done", streaming: false }]));
  expect(still.toText()).not.toContain("done▌");
  const empty = draw(msgState([{ kind: "user", text: "go" }, { kind: "assistant", text: "", streaming: true }], running));
  expect(rows(empty).filter(Boolean).at(-1)).toBe("  ▌");
  const token = "z".repeat(150); // a word wider than the panel is hard-split, never lost
  const hard = draw(msgState([{ kind: "user", text: "go" }, { kind: "assistant", text: `see ${token} ok`, streaming: false }]));
  const zrows = rows(hard).filter((r) => r.includes("z"));
  expect(zrows.length).toBe(3);
  for (const r of zrows) expect(r.length).toBeLessThanOrEqual(BW);
  expect(zrows.map((r) => r.trim()).join("")).toBe(`${token} ok`); // 64 + 64 + 22 cells, "ok" rejoins the last chunk
  expect(rows(hard).some((r) => r === "  see")).toBe(true); // the word before the giant one keeps its own row
});

test("steer », compaction ▸ (italic), system ▸ info / warn, error ×", () => {
  const g = draw(msgState([{ kind: "steer", text: "task t1 finished: tests green" }, { kind: "compaction", text: "compacted 12 turns" }, { kind: "system", text: "plan mode on", tone: "info" }, { kind: "system", text: "careful", tone: "warn" }, { kind: "system", text: "boom", tone: "error" }]));
  const r = rows(g).filter(Boolean);
  expect(r).toEqual(["◆ rovecode", "» task t1 finished: tests green", "▸ compacted 12 turns", "▸ plan mode on", "▸ careful", "× boom"]);
  expect(g.cell(BX, rowOf(g, "» task")).fg).toBe(THEME.accent);
  const cy = rowOf(g, "compacted");
  expect(g.cell(BX + 2, cy)).toMatchObject({ fg: THEME.muted, at: ATTR.ITALIC });
  expect(g.cell(BX, rowOf(g, "plan mode")).fg).toBe(THEME.accentDim);
  expect(g.cell(BX, rowOf(g, "careful")).fg).toBe(THEME.warn);
  const ey = rowOf(g, "× boom");
  expect(g.cell(BX, ey).fg).toBe(THEME.err);
  expect(g.cell(BX + 2, ey).fg).toBe(THEME.err);
});

// ------------------------------------------------------------------ cards

function approval(selected: 0 | 1 | 2, detail?: string): CardState {
  return { kind: "approval", verdicts: ["once", "always", "deny"], tool: "edit", argsPreview: "src/auth/callback.ts", detail, selected, resolve: noop };
}
const verdictCells = (g: GridScreen, y: number, label: string) => { const x = g.row(y).indexOf(` ${label} `); return Array.from({ length: label.length + 2 }, (_, i) => g.cell(x + i, y)); };

test("approval card: `◆ needs your permission  <tool> <args>`, the previewDiff text colored, verdicts allow · always · deny with the selection inverted", () => {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-p42-"));
  let text: string;
  try {
    const before = Array.from({ length: 10 }, (_, i) => `line-${i + 1}`).join("\n") + "\n";
    writeFileSync(join(dir, "f.txt"), before);
    text = previewDiff("write", { path: "f.txt", content: before.replace("line-5", "LINE-5") }, dir).text;
  } finally { rmSync(dir, { recursive: true, force: true }); }
  const s = msgState([{ kind: "user", text: "fix" }], { card: approval(0, text), ...running });
  const g = draw(s);
  const ty = rowOf(g, "needs your permission");
  expect(g.span(BX, ty, BW)).toBe("◆ needs your permission   edit src/auth/callback.ts");
  expect(g.cell(BX, ty).fg).toBe(THEME.warn);
  expect(g.cell(BX + 2, ty)).toMatchObject({ fg: THEME.fg, at: ATTR.BOLD });
  const detailRows = rows(g, ty + 1, RULE_Y - 1);
  expect(detailRows).toEqual(["  @@ -2,7 +2,7 @@", "   line-2", "   line-3", "   line-4", "  -line-5", "  +LINE-5", "  … +3 more lines"]); // 12 rows → 7 detail rows (h − 5): 6 + the clip marker; the ---/+++ pair is never drawn
  expect(g.cell(BX + 2, ty + 1).fg).toBe(THEME.dim);
  const tall = new GridScreen(90, 40, "░");
  drawMessages(tall, { x: 2, y: 1, w: 70, h: 30 }, s, THEME, 0); // 26 rows → 21 detail rows: the whole 9-line hunk fits
  const tty = rowOf(tall, "needs your permission");
  expect(rows(tall, tty + 1, tty + 10)).toEqual(text.split("\n").slice(2).map((l) => "  " + l)); expect(tall.toText()).not.toContain("+++ b/f.txt");
  expect(tall.cell(BX + 2, rowOf(tall, "-line-5")).fg).toBe(THEME.err);
  expect(tall.cell(BX + 2, rowOf(tall, "+LINE-5")).fg).toBe(THEME.ok);
  expect(tall.cell(BX + 2, rowOf(tall, " line-2")).fg).toBe(THEME.fg2);
  expect(tall.cell(BX + 2, rowOf(tall, "@@ -2,7")).fg).toBe(THEME.dim);
  const vy = RULE_Y - 1; // the buttons are the last row above the rule
  expect(g.span(BX, vy, BW)).toBe("   allow    always    deny    ⏎ confirm  ←→ choose  esc deny");
  for (const sel of [0, 1, 2] as const) {
    const gg = draw(msgState([{ kind: "user", text: "fix" }], { card: approval(sel, text), ...running }));
    ["allow", "always", "deny"].forEach((label, i) => {
      for (const c of verdictCells(gg, vy, label)) {
        if (i === sel) expect(c).toMatchObject({ fg: THEME.bg, bg: THEME.accent, at: ATTR.BOLD });
        else expect(c).toMatchObject({ fg: THEME.muted, bg: THEME.bg, at: 0 });
      }
    });
  }
  expect(g.cell(BX + 4, RULE_Y).ch).toBe("╌"); // the rule sits right under the card
  const plain = draw(msgState([], { card: approval(2) }));
  expect(rows(plain).filter(Boolean)).toEqual(["◆ needs your permission   edit src/auth/callback.ts", "   allow    always    deny    ⏎ confirm  ←→ choose  esc deny"]);
  expect(cardShape(approval(0, text), BW, 4)).toEqual({ total: 7, freeText: null });
  expect(cardRows(approval(0, text), BW, 4, THEME).length).toBe(7);
  expect(cardRows(approval(0), BW, 4, THEME).length).toBe(cardShape(approval(0), BW, 4).total);
});

function question(selected: number, over: Partial<CardState & { kind: "question" }> = {}): CardState {
  return { kind: "question", prompt: { question: "Which approach?", options: ["A (recommended)", "B"], allowFreeText: true }, selected, freeText: "", resolve: noop, ...over };
}

test("question card: the question, options, free-text row (hint / typed text), `skip this question`, the selected row inverted", () => {
  const g = draw(msgState([{ kind: "user", text: "go" }], { card: question(0), ...running }));
  const qy = rowOf(g, "◆ Which approach?");
  expect(g.cell(qy > 0 ? BX : 0, qy).fg).toBe(THEME.warn);
  expect(g.cell(BX + 2, qy)).toMatchObject({ fg: THEME.fg, at: ATTR.BOLD });
  expect(rows(g, qy + 1, RULE_Y)).toEqual(["   A (recommended)", "   B", `  ▌ ${FREE_TEXT_HINT}`, `   ${SKIP_LABEL}`, "  ⏎ confirm  ↑↓ choose"]);
  for (const c of verdictCells(g, qy + 1, "A (recommended)")) expect(c).toMatchObject({ fg: THEME.bg, bg: THEME.accent, at: ATTR.BOLD });
  for (const c of verdictCells(g, qy + 2, "B")) expect(c).toMatchObject({ fg: THEME.muted, bg: THEME.bg });
  expect(g.cell(BX + 2, qy + 3).fg).toBe(THEME.accentDim); // free-text glyph unselected
  expect(g.cell(BX + 4, qy + 3).fg).toBe(THEME.dim); // hint
  const b = draw(msgState([{ kind: "user", text: "go" }], { card: question(1), ...running }));
  for (const c of verdictCells(b, qy + 2, "B")) expect(c).toMatchObject({ fg: THEME.bg, bg: THEME.accent });
  for (const c of verdictCells(b, qy + 1, "A (recommended)")) expect(c).toMatchObject({ fg: THEME.muted, bg: THEME.bg });
  const typing = draw(msgState([{ kind: "user", text: "go" }], { card: question(2, { freeText: "custom" }), ...running }));
  expect(typing.span(BX, qy + 3, BW)).toBe("  ▌ custom");
  expect(typing.cell(BX + 2, qy + 3).fg).toBe(THEME.accent);
  expect(typing.cell(BX + 4, qy + 3)).toMatchObject({ fg: THEME.fg, at: ATTR.BOLD });
  const skip = draw(msgState([{ kind: "user", text: "go" }], { card: question(3), ...running }));
  for (const c of verdictCells(skip, qy + 4, SKIP_LABEL)) expect(c).toMatchObject({ fg: THEME.bg, bg: THEME.accent, at: ATTR.BOLD });
  const noFree = draw(msgState([{ kind: "user", text: "go" }], { card: question(2, { prompt: { question: "Which approach?", options: ["A (recommended)", "B"], allowFreeText: false } }), ...running }));
  const qy2 = rowOf(noFree, "◆ Which approach?");
  expect(qy2).toBe(qy + 1); // one row shorter, still pinned to the rule
  expect(rows(noFree, qy2 + 1, RULE_Y)).toEqual(["   A (recommended)", "   B", `   ${SKIP_LABEL}`, "  ⏎ confirm  ↑↓ choose"]);
  for (const c of verdictCells(noFree, qy2 + 3, SKIP_LABEL)) expect(c).toMatchObject({ bg: THEME.accent }); // index 2 = skip when there is no free-text row
  const onlyText = question(0, { prompt: { question: "Name?", allowFreeText: true } });
  expect(cardRows(onlyText, BW, 4, THEME).map((r) => r.segs.map(([t]) => t).join(""))).toEqual(["", "◆ Name?", `▌ ${FREE_TEXT_HINT}`, ` ${SKIP_LABEL} `, "⏎ confirm  ↑↓ choose"]);
  for (const c of [question(0), question(3), onlyText, question(0, { prompt: { question: "long ".repeat(200), options: ["x"], allowFreeText: false } })]) {
    expect(cardRows(c, BW, 4, THEME).length).toBe(cardShape(c, BW, 4).total);
  }
  expect(cardShape(question(0), BW, 4)).toEqual({ total: 7, freeText: 4 });
  expect(cardShape(onlyText, BW, 4)).toEqual({ total: 5, freeText: 2 });
  const longQ = draw(msgState([], { card: question(0, { prompt: { question: "word ".repeat(120), options: ["x"] } }) }));
  expect(rows(longQ).filter((r) => r.startsWith("◆ ") || r.startsWith("  word")).length).toBe(6); // bounded to 6 wrapped rows, elided
  expect(rows(longQ).some((r) => r.endsWith("…"))).toBe(true);
});

test("the card is pinned above the rule even when the user scrolled up, and keeps ≥1 message row in a short panel", () => {
  const many: MessageRow[] = Array.from({ length: 30 }, (_, i) => ({ kind: "system", text: `msg ${i + 1}`, tone: "info" }));
  const g = draw(msgState(many, { card: approval(1), stick: false, msgScroll: 0 }));
  expect(g.span(BX, BY, BW - 1)).toBe("▸ msg 1"); // BW-1 excludes the scrollbar column
  expect(g.span(BX, RULE_Y - 1, BW)).toContain(" allow ");
  // 12 rows − 3 card rows = 9 msg rows; scrollbar replaces the old ▾ at the end
  expect(g.span(BX, RULE_Y - 4, BW - 1)).toBe("▸ msg 9"); // 12 rows − 3 card rows = 9 message rows (+ the more-below marker), then the card
  expect(g.span(BX, RULE_Y - 3, BW)).toBe(""); // the card's blank separator
  expect(g.span(BX, RULE_Y - 2, BW)).toContain("needs your permission");
  const short = new GridScreen(90, 24, "░");
  drawMessages(short, { x: 2, y: 1, w: 70, h: 7 }, msgState(many, { card: question(0) }), THEME, 0); // 3 message rows in total
  expect(short.span(BX, 2, BW)).toBe("▸ msg 30"); // one message row survives (the tail, stick)
  expect(short.span(BX, 3, BW)).toBe(`   ${SKIP_LABEL}`); // the card shows its tail: skip + hint
  expect(short.span(BX, 4, BW)).toBe("  ⏎ confirm  ↑↓ choose");
  expect(short.row(5).slice(BX, BX + 3)).toBe("╌╌╌");
});

// ------------------------------------------------------------------ prompt line + cursor

test("prompt line: `▌ <text>` bold with the cursor cell from promptCursor; placeholder when empty; horizontal scroll keeps the cursor inside", () => {
  const s = msgState([], { input: { text: "fix the failing test", cur: 4, history: [], histIdx: -1, sgSel: 0 } });
  const g = draw(s);
  expect(g.span(BX, PROMPT_Y, BW)).toBe("▌ fix the failing test");
  expect(g.cell(BX, PROMPT_Y).fg).toBe(THEME.accent);
  expect(g.cell(BX + 2, PROMPT_Y)).toMatchObject({ fg: THEME.fg, at: ATTR.BOLD });
  expect(promptCursor(RECT, s)).toEqual({ x: BX + 2 + 4, y: PROMPT_Y });
  expect(g.row(RULE_Y).slice(BX, BX + BW)).toBe("╌".repeat(BW));
  expect(g.cell(BX, RULE_Y).fg).toBe(THEME.frameDim);
  const empty = draw(baseState());
  expect(empty.span(BX, PROMPT_Y, BW)).toBe("▌ ask rovecode — e.g. fix the failing test"); // the bar's literal wording, not the constant
  expect(empty.cell(BX + 2, PROMPT_Y).fg).toBe(THEME.dim);
  expect(empty.cell(BX, PROMPT_Y).fg).toBe(THEME.accent); // focused → accent bar even when empty
  expect(promptCursor(RECT, baseState())).toEqual({ x: BX + 2, y: PROMPT_Y });
  const blurred = draw(baseState({ focus: "code" }));
  expect(blurred.cell(BX, PROMPT_Y).fg).toBe(THEME.accentDim);
  expect(promptCursor(RECT, baseState({ focus: "code" }))).toBeNull();
  const long = "x".repeat(100);
  const ls = msgState([], { input: { text: long, cur: 100, history: [], histIdx: -1, sgSel: 0 } });
  const lg = draw(ls);
  expect(lg.span(BX, PROMPT_Y, BW)).toBe("▌ " + "x".repeat(IW - 1)); // text.slice(37) = 63 chars, one cell left for the cursor
  expect(promptCursor(RECT, ls)).toEqual({ x: BX + BW - 1, y: PROMPT_Y });
  ls.input.cur = 10;
  expect(promptCursor(RECT, ls)).toEqual({ x: BX + 2 + 10, y: PROMPT_Y });
  expect(draw(ls).span(BX, PROMPT_Y, BW)).toBe("▌ " + "x".repeat(IW));
});

test("promptCursor: null under the palette/help or an approval card; on the question card's free-text row when it is selected", () => {
  expect(promptCursor(RECT, baseState({ palette: { query: "", sel: 0, items: [] } }))).toBeNull();
  expect(promptCursor(RECT, baseState({ help: true }))).toBeNull();
  expect(promptCursor(RECT, baseState({ card: approval(0) }))).toBeNull();
  expect(promptCursor(RECT, baseState({ card: question(0) }))).toBeNull(); // an option is selected: keys pick, no text cursor
  const s = baseState({ card: question(2, { freeText: "cus" }) });
  const g = draw(s);
  const y = rowOf(g, "▌ cus");
  expect(y).toBeGreaterThan(0);
  expect(promptCursor(RECT, s)).toEqual({ x: BX + 4 + 3, y });
  const noFree = baseState({ card: question(2, { prompt: { question: "Q?", options: ["a", "b"], allowFreeText: false } }) });
  expect(promptCursor(RECT, noFree)).toBeNull();
  expect(promptCursor({ x: 0, y: 0, w: 5, h: 3 }, baseState())).toBeNull(); // no room for a prompt
});

// ------------------------------------------------------------------ scroll

test("stick follows the tail; msgScroll is an offset from the top, clamped; scrollbar replaces ▾; messagesScroll reports the geometry", () => {
  const many: MessageRow[] = Array.from({ length: 30 }, (_, i) => ({ kind: "system", text: `msg ${i + 1}`, tone: "info" }));
  const stuck = draw(msgState(many, { stick: true, msgScroll: 0 }));
  // BW-1: exclude the scrollbar column when checking message content
  expect(stuck.span(BX, BY, BW - 1)).toBe("▸ msg 19");
  expect(stuck.span(BX, RULE_Y - 1, BW - 1)).toBe("▸ msg 30");
  expect(stuck.toText()).not.toContain("▾");
  // scrollbar visible: track (│) or thumb (▌) in the last column
  expect(["│", "▌"]).toContain(stuck.cell(BX + BW - 1, BY).ch);
  expect(messagesScroll(RECT, msgState(many, { stick: true, msgScroll: 0 }), THEME, 0)).toEqual({ offset: 18, max: 18 });
  const top = draw(msgState(many, { stick: false, msgScroll: 0 }));
  expect(top.span(BX, BY, BW - 1)).toBe("▸ msg 1");
  expect(top.row(RULE_Y - 1).slice(BX, BX + 8)).toBe("▸ msg 12");
  // scrollbar replaces the old ▾ marker: last column holds track or thumb glyph
  expect(["│", "▌"]).toContain(top.cell(BX + BW - 1, RULE_Y - 1).ch);
  const mid = msgState(many, { stick: false, msgScroll: 5 });
  expect(draw(mid).span(BX, BY, BW - 1)).toBe("▸ msg 6");
  expect(messagesScroll(RECT, mid, THEME, 0)).toEqual({ offset: 5, max: 18 });
  const over = msgState(many, { stick: false, msgScroll: 999 });
  expect(draw(over).span(BX, BY, BW - 1)).toBe("▸ msg 19");
  expect(draw(over).toText()).not.toContain("▾");
  expect(messagesScroll(RECT, over, THEME, 0)).toEqual({ offset: 18, max: 18 });
  const few = msgState(many.slice(0, 3), { stick: false, msgScroll: 7 });
  expect(draw(few).span(BX, BY, BW)).toBe("▸ msg 1"); // no scrollbar when content fits
  expect(messagesScroll(RECT, few, THEME, 0)).toEqual({ offset: 0, max: 0 });
  expect(buildRows(msgState(many), BW, THEME, 0).length).toBe(30);
});

// ------------------------------------------------------------------ frame + bounds

test("panel frame: `messages` title, the user-message count in the border, accent border when focused", () => {
  const g = draw(msgState([{ kind: "user", text: "a" }, { kind: "assistant", text: "b", streaming: false }, { kind: "user", text: "c" }]));
  expect(g.row(RECT.y)).toMatch(/^░{2}╭─ messages ─+ 2 ╮/);
  expect(g.cell(RECT.x, RECT.y).fg).toBe(THEME.accent); // focus = messages by default
  const blurred = draw(baseState({ focus: "files" }));
  expect(blurred.cell(RECT.x, RECT.y).fg).toBe(THEME.frame);
  expect(blurred.row(RECT.y)).toMatch(/^░{2}╭─ messages ─+╮/);
});

test("nothing is drawn outside the rect: long rows, wide cards, huge prompt text, scrolled and stuck", () => {
  const long = "w".repeat(500);
  const states: SextantState[] = [
    msgState([{ kind: "user", text: long, images: [long] }, { kind: "assistant", text: long, streaming: true }, tool({ verb: "run", label: long, detail: long })], running),
    msgState(Array.from({ length: 40 }, (_, i) => ({ kind: "system", text: `msg ${i} ${long}`, tone: "error" })), { stick: false, msgScroll: 3, input: { text: long, cur: 250, history: [], histIdx: -1, sgSel: 0 } }),
    msgState([], { card: { kind: "approval", verdicts: ["once", "always", "deny"], tool: long, argsPreview: long, detail: Array.from({ length: 80 }, () => "+" + long).join("\n"), selected: 2, resolve: noop } }),
    msgState([], { card: question(1, { prompt: { question: long, options: [long, long, long], allowFreeText: true }, freeText: long }) }),
    msgState([{ kind: "user", text: "hi", images: [long] }, { kind: "steer", text: long }]), // the chip row is the one unclipped row kind; it stays on screen here
  ];
  for (const s of states) {
    const g = draw(s);
    expect(untouchedOutside(g, RECT, "░")).toBe(true);
    expect(g.cell(RECT.x, RECT.y).ch).toBe("╭"); expect(g.cell(RECT.x + RECT.w - 1, RECT.y + RECT.h - 1).ch).toBe("╯");
    for (let y = RECT.y + 1; y < RECT.y + RECT.h - 1; y++) expect(g.cell(RECT.x + RECT.w - 1, y).ch).toBe("│"); // the right border survives every row
  }
  const tiny = new GridScreen(20, 8, "░");
  drawMessages(tiny, { x: 1, y: 1, w: 3, h: 2 }, baseState(), THEME, 0);
  expect(untouchedOutside(tiny, { x: 0, y: 0, w: 0, h: 0 }, "░")).toBe(true);
  const small = new GridScreen(20, 8, "░");
  drawMessages(small, { x: 1, y: 1, w: 10, h: 4 }, msgState([{ kind: "user", text: "hello there" }], { card: approval(0, "+x\n+y") }), THEME, 0);
  expect(untouchedOutside(small, { x: 1, y: 1, w: 10, h: 4 }, "░")).toBe(true);
});
