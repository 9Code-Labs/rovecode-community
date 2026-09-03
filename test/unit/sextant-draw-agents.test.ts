/** Port #46 crew board (src/sextant/draw-agents.ts) on a GridScreen: grid shape by width (1/2/3 columns at
 *  60/110/140) and count (0/1/2/5), exact header / goal / meta / result strings, the running spinner and sweep
 *  bar moving with `now`, done/failed/cancelled rows, the selected border accent, paging with the footer, the
 *  laneOpen full view (wrapped + clipped summary, scroll clamp, `esc back`, usage, merged line), the isolated
 *  `+N lines merged` line, a task update changing the cell within one frame (pure painter), the `/tasks cancel`
 *  outcome, nothing outside the rect (incl. 20×6), determinism, the real setAgentsPainter seam, and the source
 *  pins (no clock/timers/random/process, type-only TaskInfo import, no manager calls, ≤400 lines, header). */

import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ATTR, SPIN, type Rect, type SextantState } from "../../src/sextant/types.ts";
import type { TaskInfo } from "../../src/core/tasks.ts";
import {
  EMPTY_NOTE, SWEEP_MS, agentsScrollTop, crewSummary, drawAgents, gridFor, laneCells, laneClock, laneElapsed, laneGlyph,
  laneMerged, laneResult, laneStatus, laneTokens, laneTone, sweepCells,
} from "../../src/sextant/draw-agents.ts";
import { drawCode, setAgentsPainter, type Painter } from "../../src/sextant/draw-code.ts";
import { crewWorking } from "../../src/sextant/draw-plan.ts";
import { GridScreen, THEME, baseState, untouchedOutside } from "../helpers/sextant-grid.ts";

/** T is a multiple of 560 ms → spinner phase 0; NOW = phase 1 (◈), NOW+140 = phase 2 (◆) */
const T = 1_699_999_999_600, NOW = T + 140;
const GOAL = "write unit tests for src/guard.ts covering the deny path and the allow path";
const R60: Rect = { x: 3, y: 2, w: 60, h: 20 }, R110: Rect = { x: 3, y: 2, w: 110, h: 20 }, R140: Rect = { x: 3, y: 2, w: 140, h: 20 };
const IX = 5, IY = 3, IW = 56; // inner of a cell that fills R60: 2 cells of padding, 1 border row

const mk = (id: string, status: TaskInfo["status"], over: Partial<TaskInfo> = {}): TaskInfo => ({
  id, label: `task ${id}`, agent: "worker", goal: GOAL, isolated: false, depth: 1, status, createdAt: NOW - 15_000,
  ...(status !== "queued" ? { startedAt: NOW - 12_000 } : {}),
  ...(status === "done" || status === "failed" || status === "cancelled" ? { finishedAt: NOW - 2_000 } : {}),
  ...over,
});
const RUNNING = mk("t1", "running", { label: "write tests" });
const state = (crew: TaskInfo[], over: Partial<SextantState["code"]> = {}, more: Partial<SextantState> = {}): SextantState => {
  const s = baseState({ crew, focus: "code", ...more });
  Object.assign(s.code, { mode: "agents" }, over);
  return s;
};
function draw(s: SextantState, rect: Rect = R60, now = NOW, grid = new GridScreen(150, 26, "░")): GridScreen {
  drawAgents(grid, rect, s, THEME, now);
  return grid;
}
const boxAt = (g: GridScreen, r: Rect): boolean => g.cell(r.x, r.y).ch === "╭" && g.cell(r.x + r.w - 1, r.y).ch === "╮" && g.cell(r.x, r.y + r.h - 1).ch === "╰" && g.cell(r.x + r.w - 1, r.y + r.h - 1).ch === "╯";
const spanIn = (g: GridScreen, r: Rect, row: number): string => g.span(r.x + 2, r.y + 1 + row, r.w - 4);

// ------------------------------------------------------------------ pure helpers

test("gridFor: 1 column below 70, 2 below 120, 3 from 120 on — never more columns than tasks; rows = ⌈n/cols⌉", () => {
  expect(gridFor(60, 0)).toEqual({ cols: 0, rows: 0 });
  expect(gridFor(60, 5)).toEqual({ cols: 1, rows: 5 });
  expect(gridFor(69, 2)).toEqual({ cols: 1, rows: 2 });
  expect(gridFor(70, 2)).toEqual({ cols: 2, rows: 1 });
  expect(gridFor(110, 5)).toEqual({ cols: 2, rows: 3 });
  expect(gridFor(119, 3)).toEqual({ cols: 2, rows: 2 });
  expect(gridFor(120, 3)).toEqual({ cols: 3, rows: 1 });
  expect(gridFor(140, 5)).toEqual({ cols: 3, rows: 2 });
  expect(gridFor(140, 2)).toEqual({ cols: 2, rows: 1 });
  expect(gridFor(140, 1)).toEqual({ cols: 1, rows: 1 });
});

test("laneGlyph / laneTone / laneStatus / laneElapsed / laneClock / laneTokens / laneResult / laneMerged", () => {
  expect(laneGlyph("queued")).toBe("◇"); expect(laneGlyph("done")).toBe("◆"); expect(laneGlyph("failed")).toBe("×"); expect(laneGlyph("cancelled")).toBe("▪");
  expect(laneGlyph("running", T)).toBe(SPIN[0]!); expect(laneGlyph("running", NOW)).toBe(SPIN[1]!); expect(laneGlyph("running", NOW + 140)).toBe(SPIN[2]!);
  expect([laneTone("queued", THEME), laneTone("running", THEME), laneTone("done", THEME), laneTone("failed", THEME), laneTone("cancelled", THEME)]).toEqual([THEME.dim, THEME.accent, THEME.ok, THEME.err, THEME.muted]);
  expect(laneStatus(mk("q", "queued"), NOW)).toBe("queued");
  expect(laneStatus(RUNNING, NOW)).toBe("working 00:12");
  expect(laneStatus(RUNNING, NOW + 61_000)).toBe("working 01:13"); // the clock is live
  expect(laneStatus(mk("d", "done"), NOW)).toBe("done"); expect(laneStatus(mk("f", "failed"), NOW)).toBe("failed"); expect(laneStatus(mk("c", "cancelled"), NOW)).toBe("cancelled");
  expect(laneElapsed(mk("q", "queued"), NOW)).toBe(15_000); // queued: since createdAt
  expect(laneElapsed(RUNNING, NOW)).toBe(12_000); // running: since startedAt
  expect(laneElapsed(mk("d", "done"), NOW)).toBe(10_000); // terminal: frozen at finishedAt …
  expect(laneElapsed(mk("d", "done"), NOW + 99_000)).toBe(10_000); // … whatever the clock says now
  expect(laneClock(12_000)).toBe("00:12"); expect(laneClock(73_400)).toBe("01:13"); expect(laneClock(-5)).toBe("00:00");
  expect(laneTokens(RUNNING)).toBe("—"); // TaskManager fills usage when the run settles
  expect(laneTokens(mk("d", "done", { usage: { input: 1200, output: 300 } }))).toBe("1.5k");
  expect(laneTokens(mk("d", "done", { usage: { input: 120, output: 30 } }))).toBe("150");
  expect(laneResult(mk("d", "done", { summary: "\n  added 12 tests, all green  \nsecond line" }))).toBe("done: added 12 tests, all green");
  expect(laneResult(mk("d", "done"))).toBe("done: (no output)");
  expect(laneResult(mk("f", "failed", { error: "child runner threw: boom" }))).toBe("failed: child runner threw: boom");
  expect(laneResult(mk("f", "failed"))).toBe("failed: (no reason)");
  expect(laneResult(mk("c", "cancelled", { error: "cancelled" }))).toBe("cancelled");
  expect(laneResult(mk("q", "queued"))).toBe("queued · waiting for a slot");
  expect(laneResult(RUNNING)).toBe("running");
  expect(laneMerged(mk("d", "done", { isolated: true, patchLines: 42 }))).toBe("+42 lines merged");
  expect(laneMerged(mk("d", "done", { isolated: true, patchLines: 0 }))).toBe("nothing merged");
  expect(laneMerged(mk("d", "done", { isolated: true }))).toBeNull(); // still running / no patch yet
  expect(laneMerged(mk("d", "done", { isolated: false, patchLines: 5 }))).toBeNull(); // only isolated children merge a patch
});

test("crewSummary: counts, working = queued + running (agrees with draw-plan crewWorking), text variants, needsYou is 0 today", () => {
  const crew = [mk("1", "running"), mk("2", "done"), mk("3", "queued"), mk("4", "failed"), mk("5", "cancelled"), mk("6", "running")];
  const c = crewSummary(crew);
  expect(c).toEqual({ total: 6, queued: 1, running: 2, done: 1, failed: 1, cancelled: 1, working: 3, needsYou: 0, text: "3 working" });
  expect(c.working).toBe(crewWorking(crew));
  expect(crewSummary([mk("2", "done"), mk("4", "failed")]).text).toBe("1/2 done");
  expect(crewSummary([]).text).toBe("no background tasks");
  expect(crewSummary([]).total).toBe(0);
});

test("sweepCells: a ¼-width block sweeps one cell per SWEEP_MS, wraps after leaving the right edge, deterministic, never random", () => {
  expect(SWEEP_MS).toBe(100);
  expect(sweepCells(20, 0)).toEqual(Array(20).fill(false)); // the block is about to enter
  expect(sweepCells(20, 100).map(Number).join("")).toBe("10000000000000000000");
  expect(sweepCells(20, 500).map(Number).join("")).toBe("11111000000000000000"); // block = 5 for width 20
  expect(sweepCells(20, 1000).map(Number).join("")).toBe("00000111110000000000");
  expect(sweepCells(20, 2400).map(Number).join("")).toBe("00000000000000000001"); // leaving: head 24 → only cell 19 lit
  expect(sweepCells(20, 2500)).toEqual(Array(20).fill(false)); // period = 20 + 5
  expect(sweepCells(20, 2600).map(Number).join("")).toBe("10000000000000000000"); // re-entered
  expect(sweepCells(20, 700)).toEqual(sweepCells(20, 700));
  expect(sweepCells(3, 100)).toEqual([true, false, false]); // block ≥ 1
  expect(sweepCells(0, 100)).toEqual([true]); // width clamps to 1
});

// ------------------------------------------------------------------ the empty board

test("empty crew: the muted note and nothing else — no fake agents, no cells", () => {
  const g = draw(state([]));
  expect(g.span(R60.x, R60.y, R60.w)).toBe(EMPTY_NOTE.slice(0, R60.w - 1) + "…"); // 62 chars into a 60-wide body
  expect(g.cell(R60.x, R60.y).fg).toBe(THEME.muted);
  expect(draw(state([]), R110).span(R110.x, R110.y, R110.w)).toBe(EMPTY_NOTE);
  for (let y = R60.y + 1; y < R60.y + R60.h; y++) expect(draw(state([])).span(R60.x, y, R60.w)).toBe("");
  const text = draw(state([]), R140).toText();
  for (const fake of ["◇", "◈", "◆", "worker", "claude", "codex", "crew", "╭"]) expect(text).not.toContain(fake);
  expect(EMPTY_NOTE).toBe("no background tasks — I start them with the task tool for parallel work");
});

// ------------------------------------------------------------------ one cell

test("one running task fills the body: bordered cell, header `◈ label … mm:ss · —`, goal wrapped to 2 rows, `id · agent`, sweep bar + running", () => {
  const g = draw(state([RUNNING]));
  expect(boxAt(g, R60)).toBe(true);
  expect(laneCells(R60, state([RUNNING]))).toEqual({ cells: [{ index: 0, rect: R60 }], page: 0, pages: 1, footer: false });
  const header = g.span(IX, IY, IW);
  expect(header).toBe("◈ write tests" + " ".repeat(IW - 13 - 9) + "00:12 · —");
  expect(header.length).toBe(IW);
  expect(g.cell(IX, IY)).toMatchObject({ ch: SPIN[1], fg: THEME.accent });
  expect(g.cell(IX + 2, IY)).toMatchObject({ ch: "w", fg: THEME.accent, at: ATTR.BOLD }); // selected (lane 0, code focused) → accent label
  expect(g.cell(IX + IW - 9, IY).fg).toBe(THEME.dim);
  expect(g.span(IX, IY + 1, IW)).toBe("write unit tests for src/guard.ts covering the deny path"); // exactly 56 cells
  expect(g.span(IX, IY + 2, IW)).toBe("and the allow path");
  expect(g.cell(IX, IY + 1).fg).toBe(THEME.muted);
  expect(g.span(IX, IY + 3, IW)).toBe("t1 · worker");
  expect(g.cell(IX, IY + 3).fg).toBe(THEME.dim);
  for (let y = IY + 4; y < IY + 17; y++) expect(g.span(IX, y, IW)).toBe("");
  const bottom = g.span(IX, IY + 17, IW); // the result row: 47 bar cells, two blanks, `running`
  expect(bottom).toMatch(/^[━─]{47}  running$/);
  expect(bottom.length).toBe(IW);
  const lit = sweepCells(47, NOW);
  for (let i = 0; i < 47; i++) expect(g.cell(IX + i, IY + 17)).toMatchObject({ ch: lit[i] ? "━" : "─", fg: lit[i] ? THEME.accent : THEME.rule2 });
  expect(lit.some(Boolean)).toBe(true);
  expect(g.cell(IX + 49, IY + 17).fg).toBe(THEME.muted);
});

test("running lane animates with `now`: spinner phase and the sweep block move; identical clocks → identical frames", () => {
  const s = state([RUNNING]);
  const a = draw(s), b = draw(s, R60, NOW + 140), c = draw(s, R60, NOW + SWEEP_MS), again = draw(s);
  expect(a.cell(IX, IY).ch).toBe(SPIN[1]!);
  expect(b.cell(IX, IY).ch).toBe(SPIN[2]!);
  expect(a.span(IX, IY + 17, 47)).not.toBe(c.span(IX, IY + 17, 47)); // the block advanced one cell
  expect(a.toText()).toBe(again.toText());
  for (let y = 0; y < a.h; y++) for (let x = 0; x < a.w; x++) expect(a.cell(x, y)).toEqual(again.cell(x, y));
  expect(draw(s, R60, T).cell(IX, IY).ch).toBe(SPIN[0]!);
});

test("result rows: done `done: <first summary line>` (ok/fg2), failed `failed: <error>` (err), cancelled (muted), queued `waiting for a slot` (dim), long text clipped with …", () => {
  const done = draw(state([mk("t2", "done", { label: "review", summary: "\nlooks good, two nits\nsecond paragraph" })]));
  expect(done.span(IX, IY, IW)).toBe("◆ review" + " ".repeat(IW - 8 - 9) + "00:10 · —");
  expect(done.cell(IX, IY).fg).toBe(THEME.ok);
  expect(done.span(IX, IY + 17, IW)).toBe("done: looks good, two nits");
  expect(done.cell(IX, IY + 17).fg).toBe(THEME.ok);
  expect(done.cell(IX + 6, IY + 17).fg).toBe(THEME.fg2);
  expect(done.toText()).not.toContain("second paragraph");
  const failed = draw(state([mk("t3", "failed", { error: "child runner threw: boom" })]));
  expect(failed.cell(IX, IY)).toMatchObject({ ch: "×", fg: THEME.err });
  expect(failed.span(IX, IY + 17, IW)).toBe("failed: child runner threw: boom");
  expect(failed.cell(IX, IY + 17).fg).toBe(THEME.err); expect(failed.cell(IX + 8, IY + 17).fg).toBe(THEME.err);
  const cancelled = draw(state([mk("t4", "cancelled", { error: "cancelled" })]));
  expect(cancelled.cell(IX, IY)).toMatchObject({ ch: "▪", fg: THEME.muted });
  expect(cancelled.span(IX, IY + 17, IW)).toBe("cancelled");
  expect(cancelled.cell(IX, IY + 17).fg).toBe(THEME.muted);
  const queued = draw(state([mk("t5", "queued")]));
  expect(queued.cell(IX, IY)).toMatchObject({ ch: "◇", fg: THEME.dim });
  expect(queued.span(IX, IY, IW)).toMatch(/00:15 · —$/); // waiting since createdAt
  expect(queued.span(IX, IY + 17, IW)).toBe("queued · waiting for a slot");
  expect(queued.cell(IX, IY + 17).fg).toBe(THEME.dim);
  const long = draw(state([mk("t6", "done", { summary: "s".repeat(200) })]));
  expect(long.span(IX, IY + 17, IW)).toBe("done: " + "s".repeat(IW - 7) + "…");
  const noOut = draw(state([mk("t7", "done", { summary: "   \n\n" })]));
  expect(noOut.span(IX, IY + 17, IW)).toBe("done: (no output)");
});

test("isolated child with a merged patch shows `+N lines merged` (ok) under the meta row; 0 → `nothing merged`; non-isolated never", () => {
  const g = draw(state([mk("t2", "done", { isolated: true, patchLines: 42, usage: { input: 1200, output: 300 } })]));
  expect(g.span(IX, IY, IW)).toMatch(/00:10 · 1\.5k$/);
  expect(g.span(IX, IY + 3, IW)).toBe("t2 · worker · isolated");
  expect(g.span(IX, IY + 4, IW)).toBe("+42 lines merged");
  expect(g.cell(IX, IY + 4).fg).toBe(THEME.ok);
  const zero = draw(state([mk("t2", "done", { isolated: true, patchLines: 0 })]));
  expect(zero.span(IX, IY + 4, IW)).toBe("nothing merged");
  expect(zero.cell(IX, IY + 4).fg).toBe(THEME.dim);
  expect(draw(state([mk("t2", "done", { isolated: false, patchLines: 42 })])).toText()).not.toContain("merged");
  expect(draw(state([mk("t2", "running", { isolated: true })])).toText()).not.toContain("merged");
});

// ------------------------------------------------------------------ the grid

test("2 tasks at 110 → two 55-wide columns; selected cell (s.code.lane) gets the accent border when code is focused, frame otherwise", () => {
  const s = state([RUNNING, mk("t2", "done", { label: "review", summary: "ok" })], { lane: 1 });
  const g = draw(s, R110);
  const left: Rect = { x: 3, y: 2, w: 55, h: 20 }, right: Rect = { x: 58, y: 2, w: 55, h: 20 };
  expect(laneCells(R110, s).cells).toEqual([{ index: 0, rect: left }, { index: 1, rect: right }]);
  expect(boxAt(g, left)).toBe(true); expect(boxAt(g, right)).toBe(true);
  expect(spanIn(g, left, 0)).toMatch(/^◈ write tests\s+00:12 · —$/);
  expect(spanIn(g, right, 0)).toMatch(/^◆ review\s+00:10 · —$/);
  expect(spanIn(g, right, 17)).toBe("done: ok"); // 20-row cell → 18 inner rows → the result row is row 17
  expect(g.cell(right.x, right.y).fg).toBe(THEME.accent); // selected
  expect(g.cell(right.x + 10, right.y + right.h - 1).fg).toBe(THEME.accent);
  expect(g.cell(left.x, left.y).fg).toBe(THEME.frameDim);
  expect(g.cell(right.x + 4, right.y + 1)).toMatchObject({ ch: "r", fg: THEME.accent, at: ATTR.BOLD }); // selected label
  expect(g.cell(left.x + 4, left.y + 1)).toMatchObject({ ch: "w", fg: THEME.fg, at: ATTR.BOLD });
  s.focus = "messages";
  const blurred = draw(s, R110);
  expect(blurred.cell(right.x, right.y).fg).toBe(THEME.frame); // still marked, quieter
  expect(blurred.cell(left.x, left.y).fg).toBe(THEME.frameDim);
  s.focus = "code"; s.code.lane = 0;
  const first = draw(s, R110);
  expect(first.cell(left.x, left.y).fg).toBe(THEME.accent); expect(first.cell(right.x, right.y).fg).toBe(THEME.frameDim);
  s.code.lane = 99; // out of range → clamped to the last lane
  expect(draw(s, R110).cell(right.x, right.y).fg).toBe(THEME.accent);
});

test("5 tasks: 60 → 1 column paged (3 per page + footer, the page follows the selection); 110 → 2×3 cells of 55×6; 140 → 3×2 cells of 46×10", () => {
  const crew = [RUNNING, mk("t2", "done", { summary: "ok" }), mk("t3", "queued"), mk("t4", "failed", { error: "boom" }), mk("t5", "cancelled", { error: "cancelled" })];
  const s60 = state(crew);
  const p0 = laneCells(R60, s60);
  expect(p0).toEqual({ cells: [{ index: 0, rect: { x: 3, y: 2, w: 60, h: 6 } }, { index: 1, rect: { x: 3, y: 8, w: 60, h: 6 } }, { index: 2, rect: { x: 3, y: 14, w: 60, h: 6 } }], page: 0, pages: 2, footer: true });
  const g0 = draw(s60);
  for (const c of p0.cells) expect(boxAt(g0, c.rect)).toBe(true);
  expect(spanIn(g0, p0.cells[0]!.rect, 0)).toMatch(/^◈ write tests\s+00:12 · —$/);
  expect(spanIn(g0, p0.cells[0]!.rect, 1)).toBe("write unit tests for src/guard.ts covering the deny path");
  expect(spanIn(g0, p0.cells[0]!.rect, 2)).toBe("t1 · worker"); // 6-row cell: header, ONE goal row, the id/agent row wins, result
  expect(spanIn(g0, p0.cells[0]!.rect, 3)).toMatch(/^[━─]{47}  running$/);
  expect(g0.toText()).not.toContain("and the allow path");
  expect(spanIn(g0, p0.cells[1]!.rect, 3)).toBe("done: ok");
  expect(spanIn(g0, p0.cells[2]!.rect, 0)).toMatch(/^◇ task t3\s+00:15 · —$/);
  expect(g0.span(R60.x, R60.y + R60.h - 1, R60.w)).toBe("1/2 · 5 tasks · ←→↑↓ select");
  expect(g0.cell(R60.x, R60.y + R60.h - 1).fg).toBe(THEME.dim);
  expect(g0.toText()).not.toContain("task t4");
  s60.code.lane = 4;
  const p1 = laneCells(R60, s60);
  expect(p1).toEqual({ cells: [{ index: 3, rect: { x: 3, y: 2, w: 60, h: 9 } }, { index: 4, rect: { x: 3, y: 11, w: 60, h: 9 } }], page: 1, pages: 2, footer: true });
  const g1 = draw(s60);
  expect(spanIn(g1, p1.cells[0]!.rect, 0)).toMatch(/^× task t4\s+00:10 · —$/);
  expect(spanIn(g1, p1.cells[0]!.rect, 6)).toBe("failed: boom");
  expect(spanIn(g1, p1.cells[1]!.rect, 6)).toBe("cancelled");
  expect(g1.cell(p1.cells[1]!.rect.x, p1.cells[1]!.rect.y).fg).toBe(THEME.accent);
  expect(g1.span(R60.x, R60.y + R60.h - 1, R60.w)).toBe("2/2 · 5 tasks · ←→↑↓ select");
  expect(g1.toText()).not.toContain("write tests");
  const s110 = state(crew);
  expect(laneCells(R110, s110).cells.map((c) => c.rect)).toEqual([{ x: 3, y: 2, w: 55, h: 6 }, { x: 58, y: 2, w: 55, h: 6 }, { x: 3, y: 8, w: 55, h: 6 }, { x: 58, y: 8, w: 55, h: 6 }, { x: 3, y: 14, w: 55, h: 6 }]);
  expect(laneCells(R110, s110).footer).toBe(false);
  const g110 = draw(s110, R110);
  for (const c of laneCells(R110, s110).cells) expect(boxAt(g110, c.rect)).toBe(true);
  expect(spanIn(g110, { x: 58, y: 8, w: 55, h: 6 }, 3)).toBe("failed: boom");
  expect(g110.span(R110.x, R110.y + R110.h - 1, R110.w)).toBe(""); // no footer: everything fits
  expect(laneCells(R140, state(crew)).cells.map((c) => c.rect)).toEqual([{ x: 3, y: 2, w: 46, h: 10 }, { x: 49, y: 2, w: 46, h: 10 }, { x: 95, y: 2, w: 46, h: 10 }, { x: 3, y: 12, w: 46, h: 10 }, { x: 49, y: 12, w: 46, h: 10 }]);
  const g140 = draw(state(crew), R140);
  for (const c of laneCells(R140, state(crew)).cells) expect(boxAt(g140, c.rect)).toBe(true);
  expect(spanIn(g140, { x: 95, y: 2, w: 46, h: 10 }, 0)).toMatch(/^◇ task t3\s+00:15 · —$/);
  expect(spanIn(g140, { x: 95, y: 2, w: 46, h: 10 }, 7)).toBe("queued · waiting for a slot");
  expect(spanIn(g140, { x: 3, y: 12, w: 46, h: 10 }, 7)).toBe("failed: boom");
  expect(spanIn(g140, { x: 49, y: 12, w: 46, h: 10 }, 7)).toBe("cancelled");
});

// ------------------------------------------------------------------ the full lane

test("laneOpen: the selected lane fills the body — header, goal + `esc back`, meta with depth, status, usage, merged, the summary wrapped and clipped to the rows, result row", () => {
  const summary = Array.from({ length: 30 }, (_, i) => `line ${String(i + 1).padStart(2, "0")}`).join("\n");
  const t = mk("t2", "done", { label: "review", isolated: true, patchLines: 42, usage: { input: 1200, output: 300, costUsd: 0.004 }, summary });
  const s = state([RUNNING, t], { lane: 1, laneOpen: true, scroll: 0 });
  const g = draw(s);
  expect(laneCells(R60, s)).toEqual({ cells: [{ index: 1, rect: R60 }], page: 0, pages: 1, footer: false });
  expect(boxAt(g, R60)).toBe(true);
  expect(g.toText()).not.toContain("write tests"); // only the open lane
  expect(g.span(IX, IY, IW)).toBe("◆ review" + " ".repeat(IW - 8 - 12) + "00:10 · 1.5k");
  expect(g.span(IX, IY + 1, IW)).toBe("write unit tests for src/guard.ts covering the  esc back"); // goal wrapped to 46, hint at the right
  expect(g.cell(IX + IW - 8, IY + 1).fg).toBe(THEME.dim);
  expect(g.span(IX, IY + 2, IW)).toBe("deny path and the allow path");
  expect(g.span(IX, IY + 3, IW)).toBe("t2 · worker · depth 1 · isolated");
  expect(g.span(IX, IY + 4, IW)).toBe("◆ done");
  expect(g.cell(IX, IY + 4).fg).toBe(THEME.ok); expect(g.cell(IX + 2, IY + 4).fg).toBe(THEME.fg2);
  expect(g.span(IX, IY + 5, IW)).toBe("tokens 1.2k in · 300 out · $0.004");
  expect(g.span(IX, IY + 6, IW)).toBe("+42 lines merged");
  expect(g.span(IX, IY + 7, IW)).toBe("");
  for (let i = 0; i < 9; i++) expect(g.span(IX, IY + 8 + i, IW)).toBe(`line ${String(i + 1).padStart(2, "0")}`); // 9 text rows
  expect(g.cell(IX, IY + 8).fg).toBe(THEME.fg2);
  expect(g.span(IX, IY + 17, IW)).toBe("done: line 01");
  expect(g.toText()).not.toContain("line 10");
  expect(agentsScrollTop(R60, s)).toBe(0);
  s.code.scroll = 1e9; // keys.ts SCROLL_TAIL on open → clamped to the last rows
  expect(agentsScrollTop(R60, s)).toBe(21);
  const tail = draw(s);
  expect(tail.span(IX, IY + 8, IW)).toBe("line 22"); expect(tail.span(IX, IY + 16, IW)).toBe("line 30");
  expect(tail.toText()).not.toContain("line 21");
  s.code.scroll = 4;
  expect(agentsScrollTop(R60, s)).toBe(4);
  expect(draw(s).span(IX, IY + 8, IW)).toBe("line 05");
  s.code.laneOpen = false;
  expect(agentsScrollTop(R60, s)).toBe(0);
  expect(draw(s).toText()).toContain("write tests"); // the grid is back
});

test("laneOpen: a long failure wraps at the inner width (words kept, long words split) and only the rows that fit are shown; running lane shows `no result yet` + live status", () => {
  const error = "the child could not finish because " + "verylongtoken".repeat(8) + " appeared in the middle and then some more words followed it";
  const s = state([mk("t3", "failed", { error })], { laneOpen: true });
  const g = draw(s);
  expect(g.span(IX, IY + 3, IW)).toBe("t3 · worker · depth 1");
  expect(g.span(IX, IY + 4, IW)).toBe("× failed");
  expect(g.span(IX, IY + 5, IW)).toBe(""); // no usage row → the blank comes right after the status
  expect(g.span(IX, IY + 6, IW)).toBe("the child could not finish because");
  expect(g.span(IX, IY + 7, IW)).toBe("verylongtoken".repeat(8).slice(0, IW));
  expect(g.span(IX, IY + 8, IW)).toBe("verylongtoken".repeat(8).slice(IW));
  expect(g.span(IX, IY + 9, IW)).toBe("appeared in the middle and then some more words followed");
  expect(g.span(IX, IY + 10, IW)).toBe("it");
  expect(g.cell(IX, IY + 6).fg).toBe(THEME.err);
  expect(g.span(IX, IY + 17, IW)).toBe("failed: " + error.slice(0, IW - 9) + "…");
  const run = draw(state([RUNNING], { laneOpen: true }));
  expect(run.span(IX, IY + 4, IW)).toBe("◈ working 00:12");
  expect(run.cell(IX, IY + 4).fg).toBe(THEME.accent);
  expect(run.span(IX, IY + 6, IW)).toBe("no result yet");
  expect(run.span(IX, IY + 17, IW)).toMatch(/^[━─]{47}  running$/);
  expect(draw(state([RUNNING], { laneOpen: true }), R60, NOW + 5_040).span(IX, IY + 4, IW)).toBe("◈ working 00:17"); // +5040 keeps spinner phase 1
  const noGoal = draw(state([mk("t9", "queued", { goal: "" })], { laneOpen: true }));
  expect(noGoal.span(IX, IY + 1, IW)).toBe(" ".repeat(IW - 8) + "esc back"); // the hint row exists without a goal
  expect(noGoal.span(IX, IY + 2, IW)).toBe("t9 · worker · depth 1");
});

// ------------------------------------------------------------------ the bar's behaviors (#46)

test("a task update changes its cell within one frame: the painter is pure over s.crew (queued → running → done; cancel → cancelled)", () => {
  const s = state([mk("t1", "queued", { label: "write tests" })]);
  const queued = draw(s);
  expect(queued.span(IX, IY + 17, IW)).toBe("queued · waiting for a slot");
  expect(queued.cell(IX, IY).ch).toBe("◇");
  s.crew = [mk("t1", "running", { label: "write tests" })]; // what setCrew(s, tasks.list()) does on a subscribe callback
  const running = draw(s);
  expect(running.cell(IX, IY)).toMatchObject({ ch: SPIN[1], fg: THEME.accent });
  expect(running.span(IX, IY + 17, IW)).toMatch(/^[━─]{47}  running$/);
  s.crew = [mk("t1", "done", { label: "write tests", summary: "added 12 tests, all green", usage: { input: 4000, output: 100 } })];
  const done = draw(s);
  expect(done.span(IX, IY, IW)).toMatch(/^◆ write tests\s+00:10 · 4\.1k$/);
  expect(done.span(IX, IY + 17, IW)).toBe("done: added 12 tests, all green");
  s.crew = [mk("t1", "cancelled", { label: "write tests", error: "cancelled" })]; // `/tasks cancel t1` → TaskManager.cancel → status cancelled
  const cancelled = draw(s);
  expect(cancelled.cell(IX, IY)).toMatchObject({ ch: "▪", fg: THEME.muted });
  expect(cancelled.span(IX, IY + 17, IW)).toBe("cancelled");
  s.crew = [mk("t1", "queued", { label: "write tests" })];
  expect(draw(s).toText()).toBe(queued.toText()); // no memory between frames
});

test("the board never starts a task: draw-agents.ts imports only the TaskInfo type from core/tasks.ts and calls nothing on a manager; no clock, timers, random or process; ≤400 lines; provenance header; no NUL", () => {
  const src = readFileSync(join(import.meta.dir, "../../src/sextant/draw-agents.ts"), "utf8");
  const taskImports = src.split(/\r?\n/).filter((l) => /^import\b.*tasks\.ts/.test(l));
  expect(taskImports).toEqual(['import type { TaskInfo } from "../core/tasks.ts";']);
  expect(src.split(/\r?\n/).filter((l) => /^import\b/.test(l))).toEqual([ // the whole import surface: types + two pure helper modules
    'import type { TaskInfo } from "../core/tasks.ts";',
    'import { ATTR, type Rect, type ScreenLike, type Seg, type SextantState, type Theme } from "./types.ts";',
    'import { spinner, st, wrap } from "./draw-util.ts";',
    'import { fmtClock, fmtK } from "./model.ts";',
  ]);
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, ""); // comments may NAME the manager; code may not touch it
  for (const bad of [/TaskManager/, /\.start\(/, /\.cancel\(/, /\.cancelAll\(/, /\.subscribe\(/, /\.list\(/, /\.result\(/, /runChild/, /SpawnRequest/, /\bspawn\b/]) expect(code).not.toMatch(bad);
  for (const bad of [/Math\.random/, /Date\.now/, /new Date\b/, /setTimeout|setInterval|setImmediate|queueMicrotask/, /\bprocess\s*[.[]/, /performance\.now/]) expect(src).not.toMatch(bad);
  expect(src.split(/\r?\n/).length).toBeLessThanOrEqual(400);
  expect(src.includes("\0")).toBe(false);
  expect(src.startsWith("/** Port #46 ")).toBe(true);
  const tests = readFileSync(join(import.meta.dir, "sextant-draw-agents.test.ts"), "utf8");
  expect(tests.includes("\0")).toBe(false);
});

test("wired through the real seam: setAgentsPainter(drawAgents) makes the code panel's ∷ mode show the board in its body rect", () => {
  const s = state([RUNNING, mk("t2", "done", { label: "review", summary: "ok" })]);
  const painter: Painter = drawAgents; // the one-line wiring's type contract
  setAgentsPainter(painter);
  try {
    const g = new GridScreen(100, 30, "░");
    const rect: Rect = { x: 3, y: 2, w: 80, h: 20 }; // draw-code body = inner minus the rail: (5,3) 71×18
    drawCode(g, rect, s, THEME, NOW);
    expect(g.row(rect.y)).toContain("1 running  1 done");
    const cells = laneCells({ x: 5, y: 3, w: 71, h: 18 }, s).cells;
    expect(cells.map((c) => c.rect)).toEqual([{ x: 5, y: 3, w: 35, h: 18 }, { x: 40, y: 3, w: 35, h: 18 }]);
    for (const c of cells) expect(boxAt(g, c.rect)).toBe(true);
    expect(spanIn(g, cells[0]!.rect, 0)).toMatch(/^◈ write tests\s+00:12 · —$/);
    expect(spanIn(g, cells[1]!.rect, 15)).toBe("done: ok"); // 18-row cell → 16 inner rows → the result row is row 15
    expect(g.cell(79, 7)).toMatchObject({ ch: "∷", fg: THEME.accent }); // the rail (▤±$∷ at rows 4-7) still marks the mode
    expect(g.toText()).not.toContain("crew: 2 tasks"); // the placeholder summary is gone
  } finally { setAgentsPainter(null); }
  const back = new GridScreen(100, 30, "░");
  drawCode(back, { x: 3, y: 2, w: 80, h: 20 }, s, THEME, NOW);
  expect(back.span(5, 3, 71)).toBe("crew: 2 tasks");
});

// ------------------------------------------------------------------ bounds

test("nothing outside the rect: 1/2/5/12 tasks at 60/110/140, the full lane, long texts, a 20×6 rect (paged 1 per page), a 30×2 compact list, a 0-wide rect", () => {
  const long = mk("t1", "done", { label: "L".repeat(120), goal: "g".repeat(600), summary: Array.from({ length: 80 }, () => "s".repeat(300)).join("\n"), usage: { input: 1e9, output: 1e9 }, isolated: true, patchLines: 123456 });
  const twelve = Array.from({ length: 12 }, (_, i) => mk(`t${i + 1}`, (["queued", "running", "done", "failed", "cancelled"] as const)[i % 5]!));
  const cases: [SextantState, Rect][] = [
    [state([RUNNING]), R60], [state([RUNNING, long], { lane: 1 }), R110], [state([long, RUNNING, ...twelve.slice(0, 3)]), R140], [state(twelve, { lane: 11 }), R60],
    [state(twelve, { lane: 7 }), R140], [state([long], { laneOpen: true }), R60], [state([long], { laneOpen: true, scroll: 1e9 }), R140], [state([]), R60],
  ];
  for (const [s, r] of cases) {
    const g = draw(s, r);
    expect(untouchedOutside(g, r, "░")).toBe(true);
  }
  const tiny: Rect = { x: 2, y: 1, w: 20, h: 6 };
  const t5 = state(twelve.slice(0, 5), { lane: 1 });
  expect(laneCells(tiny, t5)).toEqual({ cells: [{ index: 1, rect: { x: 2, y: 1, w: 20, h: 5 } }], page: 1, pages: 5, footer: true });
  const tg = draw(t5, tiny, NOW, new GridScreen(30, 10, "░"));
  expect(untouchedOutside(tg, tiny, "░")).toBe(true);
  expect(boxAt(tg, { x: 2, y: 1, w: 20, h: 5 })).toBe(true);
  expect(tg.span(4, 2, 16)).toBe("◈ tas… 00:12 · —"); // header squeezed: label clipped, clock kept
  expect(tg.span(4, 3, 16)).toBe("t2 · worker"); // a single body row goes to the id/agent, not the goal
  expect(tg.span(4, 4, 16)).toMatch(/^[━─]{7}  running$/); // the result row
  expect(tg.span(2, 6, 20)).toBe("2/5 · 5 tasks · ←→↑…");
  const open = draw(state([long], { laneOpen: true }), tiny, NOW, new GridScreen(30, 10, "░"));
  expect(untouchedOutside(open, tiny, "░")).toBe(true);
  const flat: Rect = { x: 1, y: 1, w: 30, h: 2 }; // too short for cells → compact rows
  const fg = draw(state([RUNNING, mk("t2", "done"), mk("t3", "queued")], { lane: 1 }), flat, NOW, new GridScreen(40, 6, "░"));
  expect(untouchedOutside(fg, flat, "░")).toBe(true);
  expect(fg.span(1, 1, 30)).toBe("◈ write tests    working 00:12");
  expect(fg.span(1, 2, 30)).toBe("◆ task t2                 done");
  expect(fg.cell(3, 2).fg).toBe(THEME.accent); // selected row label
  expect(fg.cell(3, 1).fg).toBe(THEME.fg);
  expect(fg.toText()).not.toContain("t3");
  const zero = draw(state([RUNNING]), { x: 5, y: 5, w: 0, h: 10 }, NOW, new GridScreen(20, 20, "░"));
  expect(untouchedOutside(zero, { x: 0, y: 0, w: 0, h: 0 }, "░")).toBe(true);
});
