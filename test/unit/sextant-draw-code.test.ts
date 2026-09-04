/** Port #42 — code panel painter. Pins: title per mode (+a −b stats, activity word, spinner/exit
 *  chip, crew counts, search summary), rail glyphs + active mode, minimap thumb/marks, file view
 *  (line numbers, highlight band + "◂ reading", auto-center while reading, scroll clamp, tokenizer
 *  seam with class names and ready styles), run view (pinned `$ cmd` header budgeted to 3 rows with
 *  the `… +N more lines` marker, output + verdict anchored to the bottom, verbatim rows, hard-wrap,
 *  PASS/FAIL chips, spinner, tail-follow, 10k chars), search rows, diff unified + split (>110), hunksFromUnified
 *  over real previewDiff output, agents seam, empty states, nothing outside the rect. */

import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ATTR, SPIN, type CodeMode, type DiffHunk, type SextantState } from "../../src/sextant/types.ts";
import { codeScrollTop, codeTitle, diffRows, drawCode, hunkMarks, hunksFromUnified, langOf, runCmdRows, setAgentsPainter, tokStyle } from "../../src/sextant/draw-code.ts";
import { previewDiff } from "../../src/coding/diff.ts";
import { GridScreen, THEME, baseState, untouchedOutside } from "../helpers/sextant-grid.ts";
import type { TaskInfo } from "../../src/core/tasks.ts";

const RECT = { x: 3, y: 2, w: 80, h: 20 }; // inner (5,3) 76×18 → body x 5..75 (71 wide), rail x 78..80, glyph column 79
const BX = 5, BY = 3, BODY_W = 71, RAIL_GX = 79;
const numbered = (n: number, pre = "line") => Array.from({ length: n }, (_, i) => `${pre} ${i + 1}`).join("\n") + "\n";
const FILE = "src/auth/callback.ts";

function draw(s: SextantState, now = 0, deps?: Parameters<typeof drawCode>[5], grid = new GridScreen(100, 30, "░")): GridScreen {
  drawCode(grid, RECT, s, THEME, now, deps);
  return grid;
}
function codeState(over: Partial<SextantState["code"]> = {}, more: Partial<SextantState> = {}): SextantState {
  const s = baseState(more);
  Object.assign(s.code, { file: FILE, content: numbered(40) }, over);
  return s;
}
const task = (id: string, status: TaskInfo["status"], label = `task ${id}`): TaskInfo => ({ id, label, agent: "worker", goal: label, isolated: false, depth: 1, status, createdAt: 0 });
const HUNK: DiffHunk = { oldStart: 1, newStart: 1, rows: [{ op: " ", text: "a" }, { op: "-", text: "b" }, { op: "+", text: "B" }, { op: " ", text: "c" }] };

// ------------------------------------------------------------------ titles

test("title: code mode shows `code  <file> +a −b  editing` (stats colored, activity word while the run edits it)", () => {
  const s = codeState({ diff: { file: FILE, hunks: [], add: 21, del: 4 } }, { running: true, activity: { state: "EDITING", label: "editing callback.ts", runId: "r", startedAt: 0, endedAt: null } });
  const g = draw(s);
  const top = g.row(RECT.y);
  expect(top).toContain(" code ");
  expect(top).toContain(`${FILE}  +21 −4   editing`);
  const plus = top.indexOf("+21"), minus = top.indexOf("−4"), word = top.indexOf("editing");
  expect(g.cell(plus, RECT.y).fg).toBe(THEME.ok);
  expect(g.cell(minus, RECT.y).fg).toBe(THEME.err);
  expect(g.cell(word, RECT.y).fg).toBe(THEME.accent);
  expect(g.cell(top.indexOf("code"), RECT.y)).toMatchObject({ fg: THEME.fg2, at: ATTR.BOLD }); // unfocused title
  s.running = false; s.activity.state = "IDLE";
  expect(draw(s).row(RECT.y)).not.toContain("editing"); // the word follows the live activity
  s.focus = "code";
  const f = draw(s);
  expect(f.cell(f.row(RECT.y).indexOf("code"), RECT.y).fg).toBe(THEME.accent); // focused → accent title + border
  expect(f.cell(RECT.x, RECT.y).fg).toBe(THEME.accent);
});

test("title: diff / run / agents / search modes", () => {
  const diff = draw(codeState({ mode: "diff", diff: { file: FILE, hunks: [HUNK], add: 1, del: 1 } })).row(RECT.y);
  expect(diff).toContain(" diff ");
  expect(diff).toContain(`${FILE}  +1 −1`);
  const running = codeState({ mode: "run", run: { cmd: "bun test", lines: [], status: "running" } });
  expect(draw(running, 280).row(RECT.y)).toContain(`─ ${SPIN[2]} ╮`); // spinner phase from `now`; the status is the only extra
  expect(draw(running, 0).row(RECT.y)).toContain(`─ ${SPIN[0]} ╮`);
  expect(draw(running).row(RECT.y)).not.toContain("bun test"); // the command is the body's pinned header, not a second copy in the title
  running.code.run!.status = "ok";
  expect(draw(running).row(RECT.y)).toContain("─ exit 0 ╮");
  running.code.run!.status = "fail";
  const failed = draw(running);
  expect(failed.row(RECT.y)).toContain("─ failed ╮");
  expect(failed.cell(failed.row(RECT.y).indexOf("failed"), RECT.y).fg).toBe(THEME.err);
  expect(draw(codeState({ mode: "run", run: null })).row(RECT.y)).toMatch(/^░{3}╭─ run ─+╮/);
  const crew = codeState({ mode: "agents" }, { crew: [task("t1", "running"), task("t2", "queued"), task("t3", "done"), task("t4", "failed")] });
  expect(draw(crew).row(RECT.y)).toContain("2 running  1 done  1 failed");
  expect(draw(codeState({ mode: "agents" })).row(RECT.y)).toContain(" agents ─");
  expect(draw(codeState({ mode: "agents" })).row(RECT.y)).toContain(" crew ");
  const search = draw(codeState({ mode: "search", search: { query: "TODO", lines: ["a", "b", "c"] } })).row(RECT.y);
  expect(search).toContain(" search ");
  expect(search).toContain("TODO  3 results");
  expect(codeTitle(codeState({ mode: "search", search: null }), THEME, 0)).toEqual({ title: "search", extra: [] });
});

test("title: a path too long for the border is clipped with an ellipsis instead of vanishing", () => {
  const s = codeState({ file: "src/" + "deep/".repeat(20) + "callback.ts" });
  const g = new GridScreen(60, 10, "░");
  drawCode(g, { x: 0, y: 0, w: 60, h: 10 }, s, THEME, 0);
  const top = g.row(0);
  expect(top).toContain(" code ");
  expect(top).toMatch(/src\/deep\/[^╮]*… ─*╮$/);
});

// ------------------------------------------------------------------ rail + minimap

test("rail: ▤ ± $ ∷ in the right strip, the active mode accented + bold, search counts as code", () => {
  const modes: [CodeMode, string][] = [["code", "▤"], ["diff", "±"], ["run", "$"], ["agents", "∷"]];
  for (const [mode, glyph] of modes) {
    const g = draw(codeState({ mode }));
    const column = [1, 2, 3, 4].map((i) => g.cell(RAIL_GX, BY + i).ch).join("");
    expect(column).toBe("▤±$∷");
    for (const [m, gl] of modes) {
      const c = g.cell(RAIL_GX, BY + 1 + modes.findIndex(([mm]) => mm === m));
      if (m === mode) expect(c).toMatchObject({ ch: gl, fg: THEME.accent, at: ATTR.BOLD });
      else expect(c).toMatchObject({ ch: gl, fg: THEME.dim, at: 0 });
    }
    expect(glyph.length).toBe(1);
    expect(g.cell(RAIL_GX - 1, BY + 1).ch).toBe("│"); // the rail box borders
    expect(g.cell(RAIL_GX + 1, BY + 1).ch).toBe("│");
  }
  const search = draw(codeState({ mode: "search", search: { query: "x", lines: [] } }));
  expect(search.cell(RAIL_GX, BY + 1)).toMatchObject({ ch: "▤", fg: THEME.accent });
});

test("minimap: thick ▌ over the visible region, ▏ elsewhere; added = ok, changed = warn", () => {
  const hunks: DiffHunk[] = [{ oldStart: 50, newStart: 50, rows: [{ op: "+", text: "new" }] }, { oldStart: 90, newStart: 90, rows: [{ op: "-", text: "old" }, { op: "+", text: "NEW" }] }];
  const g = draw(codeState({ content: numbered(100), diff: { file: FILE, hunks, add: 2, del: 1 } }));
  const top = BY + 6, rows = 11; // 18 rail rows − 7 → 11 minimap rows over 100 lines
  const thumbs = Array.from({ length: rows }, (_, i) => g.cell(RAIL_GX, top + i).ch).join("");
  expect(thumbs).toBe("▌▌▏▏▏▏▏▏▏▏▏"); // view = lines 1-18 → rows 0 (0-9) and 1 (9-18)
  expect(g.cell(RAIL_GX, top).fg).toBe(THEME.rule2); // in view, unmarked
  expect(g.cell(RAIL_GX, top + 2).fg).toBe(THEME.rule); // out of view, unmarked
  expect(g.cell(RAIL_GX, top + 5).fg).toBe(THEME.ok); // line 50 added (rows cover 45-54)
  expect(g.cell(RAIL_GX, top + 9).fg).toBe(THEME.warn); // line 90 changed (rows cover 81-90)
  const scrolled = draw(codeState({ content: numbered(100), scroll: 60 }));
  const t2 = Array.from({ length: rows }, (_, i) => scrolled.cell(RAIL_GX, top + i).ch).join("");
  expect(t2).toBe("▏▏▏▏▏▏▌▌▌▏▏"); // view = lines 61-78
  expect(Array.from({ length: rows }, (_, i) => draw(codeState({ mode: "run", run: null })).cell(RAIL_GX, top + i).ch).join("")).toBe(" ".repeat(rows)); // no map without a file view
});

test("hunkMarks: pure inserts are `added`, replaced lines `changed`, keyed by new-file line numbers", () => {
  const marks = hunkMarks([{ oldStart: 1, newStart: 1, rows: [{ op: " ", text: "a" }, { op: "-", text: "b" }, { op: "+", text: "B" }, { op: " ", text: "c" }, { op: "+", text: "d" }, { op: "+", text: "e" }] }]);
  expect([...marks.entries()]).toEqual([[2, "changed"], [4, "added"], [5, "added"]]);
});

// ------------------------------------------------------------------ file view

test("file view: right-aligned line numbers, the highlight band tinted with the accent numbers, `◂ reading` on its first row while reading", () => {
  const g = draw(codeState({ hl: [3, 4] }));
  expect(g.span(BX, BY, BODY_W)).toMatch(/^ {2}1 {3}line 1/); // numbers padded to 3, mark column, code
  expect(g.span(BX, BY + 2, BODY_W)).toMatch(/^ {2}3 {3}line 3/);
  for (let x = BX; x < BX + BODY_W; x++) { expect(g.cell(x, BY + 2).bg).toBe(THEME.hlBg); expect(g.cell(x, BY + 3).bg).toBe(THEME.hlBg); }
  expect(g.cell(BX + 8, BY + 1).bg).toBe(THEME.bg); // rows outside the band keep the panel background
  expect(g.cell(BX + 2, BY + 2).fg).toBe(THEME.accent); // highlighted number
  expect(g.cell(BX + 2, BY + 1).fg).toBe(THEME.dim);
  expect(g.toText()).not.toContain("◂ reading"); // idle: band only
  const reading = codeState({ hl: [3, 4] }, { running: true, activity: { state: "READING", label: "reading callback.ts", runId: "r", startedAt: 0, endedAt: null } });
  const r = draw(reading);
  expect(r.span(BX, BY + 2, BODY_W)).toMatch(/^ {2}3 {3}line 3\s+◂ reading$/);
  expect(r.span(BX, BY + 2, BODY_W).length).toBe(BODY_W); // the tag ends at the body's right edge
  expect(r.row(BY + 3)).not.toContain("◂");
  expect(r.cell(BX + BODY_W - 9, BY + 2)).toMatchObject({ ch: "◂", fg: THEME.accent, bg: THEME.hlBg });
});

test("file view: scroll offset honored and clamped; reading auto-centers the highlight; codeScrollTop agrees", () => {
  const s = codeState({ scroll: 5 });
  expect(draw(s).span(BX, BY, BODY_W)).toMatch(/^ {2}6 {3}line 6/);
  expect(codeScrollTop(RECT, s)).toBe(5);
  s.code.scroll = 1000;
  expect(draw(s).span(BX, BY, BODY_W)).toMatch(/^ 23 {3}line 23/); // 40 lines − 18 rows
  expect(draw(s).span(BX, BY + 17, BODY_W)).toMatch(/^ 40 {3}line 40/);
  expect(codeScrollTop(RECT, s)).toBe(22);
  const reading = codeState({ hl: [30, 32], scroll: 0 }, { running: true, activity: { state: "READING", label: "reading callback.ts", runId: "r", startedAt: 0, endedAt: null } });
  expect(codeScrollTop(RECT, reading)).toBe(20); // 29 − ⌊18/2⌋
  const g = draw(reading);
  expect(g.span(BX, BY, BODY_W)).toMatch(/^ 21 {3}line 21/);
  expect(g.span(BX, BY + 9, BODY_W)).toMatch(/^ 30 {3}line 30\s+◂ reading$/);
  reading.running = false; // the run ended: the plain scroll rules again
  expect(codeScrollTop(RECT, reading)).toBe(0);
});

test("file view: change marks ▎ from the diff hunks (changed = warn, added = ok) only for the shown file", () => {
  const hunks: DiffHunk[] = [{ oldStart: 2, newStart: 2, rows: [{ op: "-", text: "x" }, { op: "+", text: "line 2" }, { op: " ", text: "line 3" }, { op: "+", text: "line 4" }] }];
  const g = draw(codeState({ diff: { file: FILE, hunks, add: 2, del: 1 } }));
  expect(g.cell(BX + 4, BY + 1)).toMatchObject({ ch: "▎", fg: THEME.warn });
  expect(g.cell(BX + 4, BY + 3)).toMatchObject({ ch: "▎", fg: THEME.ok });
  expect(g.cell(BX + 4, BY + 2).ch).toBe(" ");
  const other = draw(codeState({ diff: { file: "other.ts", hunks, add: 2, del: 1 } }));
  expect(other.cell(BX + 4, BY + 1).ch).toBe(" ");
});

test("file view: tokenizer seam — class names go through tokStyle, ready styles pass through, default is plain fg2", () => {
  const s = codeState({ content: "const x = 1;\n" });
  const plain = draw(s);
  const cx = BX + 6; // 3 digits + space + mark + space
  expect(plain.span(cx, BY, BODY_W - 6)).toBe("const x = 1;");
  for (let i = 0; i < 12; i++) expect(plain.cell(cx + i, BY)).toMatchObject({ fg: THEME.fg2, at: 0 });
  const classes = draw(s, 0, { tokenize: (line) => [[line.slice(0, 5), "kw"], [line.slice(5, 10), "plain"], [line.slice(10, 11), "num"], [line.slice(11), "pu"]] });
  expect(classes.span(cx, BY, BODY_W - 6)).toBe("const x = 1;");
  expect(classes.cell(cx, BY)).toMatchObject({ fg: THEME.fg, at: ATTR.BOLD }); // kw
  expect(classes.cell(cx + 10, BY).fg).toBe(THEME.str); // num
  expect(classes.cell(cx + 11, BY).fg).toBe(THEME.fg2); // pu → default
  const styled = draw(s, 0, { tokenize: (line) => [[line, { fg: 0x123456, bg: -1, a: ATTR.ITALIC }]] });
  expect(styled.cell(cx + 3, BY)).toMatchObject({ fg: 0x123456, at: ATTR.ITALIC });
  expect(tokStyle("cm", THEME, 7)).toEqual({ fg: THEME.muted, bg: 7, a: ATTR.ITALIC });
  expect(tokStyle("ty", THEME)).toEqual({ fg: THEME.ty, bg: -1, a: 0 });
  // a highlighted row keeps its tint under class-styled tokens
  const hl = draw(codeState({ content: "const x = 1;\n", hl: [1, 1] }), 0, { tokenize: (line) => [[line, "kw"]] });
  expect(hl.cell(cx, BY)).toMatchObject({ fg: THEME.fg, bg: THEME.hlBg });
  expect(langOf("a/b.tsx")).toBe("ts"); expect(langOf("x.mjs")).toBe("ts"); expect(langOf("p.json")).toBe("json"); expect(langOf("R.md")).toBe("md"); expect(langOf("Makefile")).toBe("text");
});

test("empty states: no file / unreadable / empty content / nothing run / no diff / no search", () => {
  expect(draw(codeState({ file: null, content: null })).span(BX, BY, BODY_W)).toMatch(/^nothing open/);
  expect(draw(codeState({ content: null })).span(BX, BY, BODY_W)).toMatch(/^cannot read src\/auth\/callback\.ts/);
  expect(draw(codeState({ content: "" })).span(BX, BY, BODY_W)).toMatch(/^\(empty\)/);
  expect(draw(codeState({ mode: "run", run: null })).span(BX, BY, BODY_W)).toMatch(/^nothing has run yet/);
  expect(draw(codeState({ mode: "diff", diff: null })).span(BX, BY, BODY_W)).toMatch(/^no changes in this file/);
  expect(draw(codeState({ mode: "diff", diff: { file: FILE, hunks: [], add: 0, del: 0 } })).span(BX, BY, BODY_W)).toMatch(/^no changes in this file/);
  expect(draw(codeState({ mode: "search", search: null })).span(BX, BY, BODY_W)).toMatch(/^no search yet/);
});

// ------------------------------------------------------------------ run

const TAIL = BY + 17; // the body's last row (inner h = 18): output and the verdict sit against it

test("run: `$ cmd` bold at the top, output rows verbatim against the bottom, PASS/FAIL line chips, the status chip on the tail row", () => {
  const s = codeState({ mode: "run", run: { cmd: "bun test", lines: ["ran 3 files", "PASS test/a.test.ts", "FAIL test/b.test.ts  expected 1", "done ⏎ kept"], status: "ok" } });
  const g = draw(s);
  expect(g.span(BX, BY, BODY_W)).toBe("$ bun test");
  expect(g.cell(BX, BY)).toMatchObject({ fg: THEME.fg, at: ATTR.BOLD });
  for (let y = BY + 1; y < TAIL - 4; y++) expect(g.span(BX, y, BODY_W)).toBe(""); // the slack is above the output, not below it
  expect(g.span(BX, TAIL - 4, BODY_W)).toBe("ran 3 files");
  expect(g.span(BX, TAIL - 3, BODY_W)).toBe(" PASS  test/a.test.ts");
  for (let i = 0; i < 6; i++) expect(g.cell(BX + i, TAIL - 3)).toMatchObject({ bg: THEME.ok, fg: THEME.bg, at: ATTR.BOLD });
  expect(g.span(BX, TAIL - 2, BODY_W)).toBe(" FAIL  test/b.test.ts  expected 1");
  expect(g.cell(BX + 1, TAIL - 2).bg).toBe(THEME.err);
  expect(g.span(BX, TAIL - 1, BODY_W)).toBe("done ⏎ kept"); // a literal ⏎ in the output is just a character
  expect(g.span(BX, TAIL, BODY_W)).toBe(" PASS   exit 0"); // the verdict from run.status
  expect(g.cell(BX + 2, TAIL).bg).toBe(THEME.ok);
  s.code.run!.status = "fail";
  const f = draw(s);
  expect(f.span(BX, TAIL, BODY_W)).toBe(" FAIL   non-zero exit");
  expect(f.cell(BX + 2, TAIL).bg).toBe(THEME.err);
  s.code.run!.status = "running";
  const r = draw(s, 280);
  expect(r.span(BX, TAIL, BODY_W)).toBe(`${SPIN[2]}  running`);
  expect(r.cell(BX, TAIL).fg).toBe(THEME.accent);
  expect(r.toText()).not.toContain("PASS   exit"); // no verdict chip while running
});

test("run: 10k chars of output stay verbatim rows (tail-follow under the pinned `$ cmd`, no ⏎ one-lining) and long rows hard-wrap like a terminal", () => {
  const lines = Array.from({ length: 250 }, (_, i) => `L${String(i + 1).padStart(3, "0")} ${"x".repeat(35)}`); // 250 × 40 = 10 000 chars
  expect(lines.join("").length).toBe(10_000);
  const g = draw(codeState({ mode: "run", run: { cmd: "bun run big", lines, status: "ok" } }));
  expect(g.span(BX, BY, BODY_W)).toBe("$ bun run big"); // the header does not scroll off: the title no longer names the command
  for (let i = 0; i < 16; i++) expect(g.span(BX, BY + 1 + i, BODY_W)).toBe(lines[250 - 16 + i]!); // the last 16 lines between the header and the tail row
  expect(g.span(BX, TAIL, BODY_W)).toBe(" PASS   exit 0");
  expect(g.toText()).not.toContain("⏎");
  const long = "y".repeat(200);
  const w = draw(codeState({ mode: "run", run: { cmd: "echo", lines: [long, "next"], status: "ok" } }));
  expect(w.span(BX, BY, BODY_W)).toBe("$ echo");
  expect(w.span(BX, TAIL - 4, BODY_W) + w.span(BX, TAIL - 3, BODY_W) + w.span(BX, TAIL - 2, BODY_W)).toBe(long); // 200 = 71 + 71 + 58
  expect(w.span(BX, TAIL - 1, BODY_W)).toBe("next");
  expect(w.span(BX, TAIL, BODY_W)).toBe(" PASS   exit 0");
});

test("run: a long command is budgeted to 3 rows — two of text + `… +N more lines` — and the output keeps the bottom", () => {
  const cmd = `cd "C:/Users/x/site" && ffmpeg -v error -i hero.mp4 -vf scale=1920:-2 out.mp4 | node -e "${"j".repeat(800)}"`; // 902 cells with `$ ` → 13 rows at 71
  const lines = ["frame 1", "frame 2", "frame 3", "frame 4", "frame 5", "done"];
  const g = draw(codeState({ mode: "run", run: { cmd, lines, status: "ok" } }));
  const all = [..."$ " + cmd];
  expect(Math.ceil(all.length / BODY_W)).toBe(13);
  expect(g.span(BX, BY, BODY_W)).toBe(all.slice(0, 71).join(""));
  expect(g.span(BX, BY + 1, BODY_W)).toBe(all.slice(71, 142).join(""));
  expect(g.span(BX, BY + 2, BODY_W)).toBe("… +11 more lines"); // 13 wrapped rows − 2 shown = 11 folded into the marker row
  expect(g.cell(BX, BY)).toMatchObject({ fg: THEME.fg, at: ATTR.BOLD });
  expect(g.cell(BX, BY + 2).fg).toBe(THEME.dim);
  for (let y = BY + 3; y < TAIL - 6; y++) expect(g.span(BX, y, BODY_W)).toBe(""); // nothing of the command leaks past its budget
  lines.forEach((l, i) => expect(g.span(BX, TAIL - 6 + i, BODY_W)).toBe(l));
  expect(g.span(BX, TAIL, BODY_W)).toBe(" PASS   exit 0");
  // the budget boundary is exact: three rows fit whole, a fourth folds two into the marker (never a marker for one hidden row)
  expect(runCmdRows("x".repeat(211), BODY_W, 3)).toEqual(["$ " + "x".repeat(69), "x".repeat(71), "x".repeat(71)]);
  expect(runCmdRows("x".repeat(212), BODY_W, 3)).toEqual(["$ " + "x".repeat(69), "x".repeat(71), "… +2 more lines"]);
  expect(runCmdRows("x".repeat(212), BODY_W, 0)).toEqual([]);
});

test("run: short output is anchored to the bottom rows of a tall panel; a body under 4 rows drops the header for the output", () => {
  const s = codeState({ mode: "run", run: { cmd: "bun test", lines: ["a", "b", "c"], status: "running" } });
  const g = draw(s, 280);
  expect(g.span(BX, BY, BODY_W)).toBe("$ bun test");
  for (let y = BY + 1; y <= TAIL - 4; y++) expect(g.span(BX, y, BODY_W)).toBe("");
  expect([TAIL - 3, TAIL - 2, TAIL - 1].map((y) => g.span(BX, y, BODY_W))).toEqual(["a", "b", "c"]);
  expect(g.span(BX, TAIL, BODY_W)).toBe(`${SPIN[2]}  running`);
  const short = { x: 3, y: 2, w: 80, h: 5 }; // inner h = 3: no room for a header that would leave less than output + verdict
  const t = new GridScreen(100, 30, "░");
  drawCode(t, short, codeState({ mode: "run", run: { cmd: "bun test", lines: ["a"], status: "ok" } }), THEME, 0);
  expect([3, 4, 5].map((y) => t.span(BX, y, BODY_W))).toEqual(["", "a", " PASS   exit 0"]);
  const four = { x: 3, y: 2, w: 80, h: 6 }; // inner h = 4: the header gets min(3, h − 2) = 2 rows, so a long command is one row + the marker
  const u = new GridScreen(100, 30, "░");
  drawCode(u, four, codeState({ mode: "run", run: { cmd: "x".repeat(300), lines: ["a"], status: "ok" } }), THEME, 0);
  expect([3, 4, 5, 6].map((y) => u.span(BX, y, BODY_W))).toEqual(["$ " + "x".repeat(69), "… +4 more lines", "a", " PASS   exit 0"]); // 302 cells → 5 rows; 5 − 2 + 1 = 4
});

// ------------------------------------------------------------------ search

test("search: `path:line:` locations muted + the match colored, plain rows dotted, a results summary", () => {
  const g = draw(codeState({ mode: "search", search: { query: "x", lines: ["src/a.ts:12:  const x = 1", "src/b.ts:3:4: x()", "plain hit"] } }));
  expect(g.span(BX, BY, BODY_W)).toMatch(/^src\/a\.ts:12\s+const x = 1$/);
  expect(g.cell(BX, BY).fg).toBe(THEME.muted);
  expect(g.row(BY).indexOf("const")).toBe(BX + 27); // 26-wide location column + gap
  expect(g.span(BX, BY + 1, BODY_W)).toMatch(/^src\/b\.ts:3:4\s+x\(\)$/);
  expect(g.span(BX, BY + 2, BODY_W)).toBe("· plain hit");
  expect(g.span(BX, BY + 4, BODY_W)).toBe("3 results");
  expect(draw(codeState({ mode: "search", search: { query: "x", lines: [] } })).span(BX, BY, BODY_W)).toBe("no results");
  expect(draw(codeState({ mode: "search", search: { query: "x", lines: ["only"] } })).span(BX, BY + 2, BODY_W)).toBe("1 result");
});

// ------------------------------------------------------------------ diff

test("diff unified: hunk header dim, old/new numbers, +/− signs, add/del backgrounds across the body, deleted text muted", () => {
  const g = draw(codeState({ mode: "diff", diff: { file: FILE, hunks: [HUNK], add: 1, del: 1 } }));
  expect(g.span(BX, BY, BODY_W)).toBe("@@ -1,3 +1,3 @@");
  expect(g.cell(BX, BY).fg).toBe(THEME.dim);
  expect(g.span(BX, BY + 1, BODY_W)).toBe("   1    1   a");
  expect(g.span(BX, BY + 2, BODY_W)).toBe("   2      − b");
  expect(g.span(BX, BY + 3, BODY_W)).toBe("        2 + B");
  expect(g.span(BX, BY + 4, BODY_W)).toBe("   3    3   c");
  for (let x = BX; x < BX + BODY_W; x++) { expect(g.cell(x, BY + 2).bg).toBe(THEME.delBg); expect(g.cell(x, BY + 3).bg).toBe(THEME.addBg); }
  expect(g.cell(BX + 8, BY + 1).bg).toBe(THEME.bg);
  expect(g.cell(BX + 10, BY + 2)).toMatchObject({ ch: "−", fg: THEME.err });
  expect(g.cell(BX + 10, BY + 3)).toMatchObject({ ch: "+", fg: THEME.ok });
  expect(g.cell(BX + 12, BY + 2).fg).toBe(THEME.muted); // deleted text
  expect(g.cell(BX + 12, BY + 3).fg).toBe(THEME.fg2);
  expect(g.cell(RAIL_GX, BY + 2)).toMatchObject({ ch: "±", fg: THEME.accent });
});

test("diff split view when the body is wider than 110: equal lines mirrored, a delete paired with its insert on one row", () => {
  const s = codeState({ mode: "diff", diff: { file: FILE, hunks: [{ oldStart: 1, newStart: 1, rows: [{ op: " ", text: "a" }, { op: "-", text: "b" }, { op: "-", text: "b2" }, { op: "+", text: "B" }, { op: " ", text: "c" }] }], add: 1, del: 2 } });
  const g = new GridScreen(140, 30, "░");
  const rect = { x: 3, y: 2, w: 130, h: 20 }; // inner 126 → body 121 > 110 → split, halves of 60
  drawCode(g, rect, s, THEME, 0);
  const L = 5, R = 5 + 61;
  expect(g.span(L, BY, 121)).toBe("@@ -1,4 +1,3 @@");
  expect(g.row(BY + 1).slice(L, L + 8)).toBe("   1   a"); expect(g.row(BY + 1).slice(R, R + 8)).toBe("   1   a");
  expect(g.row(BY + 2).slice(L, L + 8)).toBe("   2 − b"); expect(g.row(BY + 2).slice(R, R + 8)).toBe("   2 + B");
  expect(g.row(BY + 3).slice(L, L + 9)).toBe("   3 − b2"); expect(g.span(R, BY + 3, 60)).toBe(""); // unpaired delete: empty right side
  expect(g.row(BY + 4).slice(L, L + 8)).toBe("   4   c"); expect(g.row(BY + 4).slice(R, R + 8)).toBe("   3   c");
  expect(g.cell(L + 3, BY + 2).bg).toBe(THEME.delBg); expect(g.cell(R + 3, BY + 2).bg).toBe(THEME.addBg);
  expect(g.cell(L + 59, BY + 2).bg).toBe(THEME.delBg); expect(g.cell(L + 60, BY + 2).bg).toBe(THEME.bg); // the gutter between halves
  expect(g.cell(L + 3, BY + 1).bg).toBe(THEME.bg);
  expect(diffRows([HUNK], false).map((r) => r.t)).toEqual(["hunk", "line", "line", "line", "line"]);
  expect(diffRows([HUNK], true).map((r) => r.t)).toEqual(["hunk", "pair", "pair", "pair"]);
  const narrow = draw(s); // 71-wide body → unified
  expect(narrow.span(BX, BY + 2, BODY_W)).toBe("   2      − b");
});

test("hunksFromUnified: previewDiff output on a real file → hunks the diff view renders; create = all adds from 0; garbage → []", () => {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-p42-"));
  try {
    const before = numbered(10, "line-");
    writeFileSync(join(dir, "f.txt"), before);
    const after = before.replace("line- 5", "LINE- 5");
    const pv = previewDiff("write", { path: "f.txt", content: after }, dir);
    expect(pv.kind).toBe("modify");
    const hunks = hunksFromUnified(pv.text);
    expect(hunks).toEqual([{ oldStart: 2, newStart: 2, rows: [
      { op: " ", text: "line- 2" }, { op: " ", text: "line- 3" }, { op: " ", text: "line- 4" }, { op: "-", text: "line- 5" }, { op: "+", text: "LINE- 5" },
      { op: " ", text: "line- 6" }, { op: " ", text: "line- 7" }, { op: " ", text: "line- 8" }] }]);
    const g = draw(codeState({ mode: "diff", diff: { file: "f.txt", hunks, add: 1, del: 1 } }));
    expect(g.span(BX, BY, BODY_W)).toBe("@@ -2,7 +2,7 @@");
    expect(g.span(BX, BY + 4, BODY_W)).toBe("   5      − line- 5");
    expect(g.span(BX, BY + 5, BODY_W)).toBe("        5 + LINE- 5");
    const created = previewDiff("write", { path: "new.txt", content: "a\nb\n" }, dir);
    expect(created.kind).toBe("create");
    expect(hunksFromUnified(created.text)).toEqual([{ oldStart: 0, newStart: 1, rows: [{ op: "+", text: "a" }, { op: "+", text: "b" }] }]);
    const clipped = previewDiff("write", { path: "f.txt", content: numbered(60, "new-") }, dir, { maxLines: 12 });
    expect(clipped.truncated).toBe(true);
    const ch = hunksFromUnified(clipped.text);
    expect(ch.length).toBe(1);
    expect(ch[0]!.rows.every((r) => r.op === "+" || r.op === "-")).toBe(true); // the "… +N more lines" marker is not a row
    expect(ch[0]!.rows.length).toBe(9); // 12 lines − 2 headers − 1 @@ = 9 rows before the marker
  } finally { rmSync(dir, { recursive: true, force: true }); }
  expect(hunksFromUnified("diff unavailable: binary file")).toEqual([]);
  expect(hunksFromUnified("")).toEqual([]);
  expect(hunksFromUnified("--- a/x\n+++ b/x\n@@ -1 +1,2 @@\r\n-old\r\n+new\r\n+more\r\n\\ No newline at end of file\n")).toEqual([{ oldStart: 1, newStart: 1, rows: [{ op: "-", text: "old" }, { op: "+", text: "new" }, { op: "+", text: "more" }] }]);
});

// ------------------------------------------------------------------ agents seam

test("agents: crew summary from s.crew until a painter is registered; setAgentsPainter receives the body rect", () => {
  setAgentsPainter(null); // a SextantRenderer built by another test file leaves drawAgents registered (bun shares the module cache across files; file order differs per OS)
  const s = codeState({ mode: "agents" }, { crew: [task("t1", "done", "write tests"), task("t2", "queued", "review")] });
  const g = draw(s);
  expect(g.span(BX, BY, BODY_W)).toBe("crew: 2 tasks");
  expect(g.span(BX, BY + 2, BODY_W)).toMatch(/^◆ write tests\s+done$/);
  expect(g.span(BX, BY + 2, BODY_W).length).toBe(BODY_W); // status right-aligned to the body edge
  expect(g.cell(BX, BY + 2).fg).toBe(THEME.ok);
  expect(g.span(BX, BY + 3, BODY_W)).toMatch(/^◇ review\s+queued$/);
  expect(draw(codeState({ mode: "agents" }, { crew: [task("t1", "running")] }), 280).row(BY + 2).slice(BX, BX + 1)).toBe(SPIN[2]!);
  expect(draw(codeState({ mode: "agents" })).span(BX, BY, BODY_W)).toBe("crew: 0 tasks");
  const calls: unknown[][] = [];
  setAgentsPainter((scr, rect, st, th, now) => { calls.push([rect, st, th, now]); scr.put(rect.x, rect.y, "BOARD"); });
  try {
    const p = draw(s, 42);
    expect(calls).toEqual([[{ x: BX, y: BY, w: BODY_W, h: 18 }, s, THEME, 42]]);
    expect(p.span(BX, BY, BODY_W)).toBe("BOARD");
    expect(p.toText()).not.toContain("crew: 2 tasks");
    expect(draw(codeState({ mode: "code" })).toText()).not.toContain("BOARD"); // only the ∷ mode calls it
  } finally { setAgentsPainter(null); }
  expect(draw(s).span(BX, BY, BODY_W)).toBe("crew: 2 tasks");
});

// ------------------------------------------------------------------ bounds

test("nothing is drawn outside the rect in any mode; the panel box sits exactly on its edges", () => {
  const states: SextantState[] = [
    codeState({ hl: [2, 3], diff: { file: FILE, hunks: [HUNK], add: 1, del: 1 } }),
    codeState({ mode: "diff", diff: { file: FILE, hunks: [HUNK], add: 1, del: 1 } }),
    codeState({ mode: "run", run: { cmd: "x".repeat(300), lines: Array.from({ length: 50 }, () => "y".repeat(500)), status: "fail" } }),
    codeState({ mode: "search", search: { query: "q".repeat(200), lines: Array.from({ length: 40 }, (_, i) => `p${i}.ts:1:${"z".repeat(300)}`) } }),
    codeState({ mode: "agents" }, { crew: [task("t1", "running", "L".repeat(400))] }),
    codeState({ file: "a/".repeat(80) + "x.ts", content: Array.from({ length: 200 }, () => "w".repeat(400)).join("\n"), hl: [1, 200] }, { running: true, activity: { state: "EDITING", label: "editing x.ts", runId: "r", startedAt: 0, endedAt: null } }),
  ];
  for (const s of states) {
    const g = draw(s);
    expect(untouchedOutside(g, RECT, "░")).toBe(true);
    expect(g.cell(RECT.x, RECT.y).ch).toBe("╭"); expect(g.cell(RECT.x + RECT.w - 1, RECT.y).ch).toBe("╮");
    expect(g.cell(RECT.x, RECT.y + RECT.h - 1).ch).toBe("╰"); expect(g.cell(RECT.x + RECT.w - 1, RECT.y + RECT.h - 1).ch).toBe("╯");
  }
  const tiny = new GridScreen(20, 8, "░");
  drawCode(tiny, { x: 1, y: 1, w: 3, h: 2 }, codeState(), THEME, 0); // below the minimum: nothing at all
  expect(untouchedOutside(tiny, { x: 0, y: 0, w: 0, h: 0 }, "░")).toBe(true);
  const small = new GridScreen(20, 8, "░");
  drawCode(small, { x: 1, y: 1, w: 12, h: 5 }, codeState(), THEME, 0);
  expect(untouchedOutside(small, { x: 1, y: 1, w: 12, h: 5 }, "░")).toBe(true);
});
