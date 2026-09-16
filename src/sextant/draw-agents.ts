/** Port #46 — the CREW BOARD: the `∷` agents mode of the code panel, a grid of lane cells over the
 *  runtime's background tasks (core/tasks.ts TaskManager → SextantState.crew: TaskInfo[]). Ported from
 *  the user's own sextant v0.4.0 prototype src/app.js:758-892 (laneGlyph/laneStatus, drawLane cell,
 *  drawAgents grid, the full-lane view; user-owned) + README "Crew". The mock lanes are gone (spawnLane/
 *  runLane scripts, the AGENTS roster, log tail, progress steps): a cell shows one real TaskInfo —
 *  header `label · elapsed · tokens`, the goal, `id · agent`, the result row — and the board NEVER starts
 *  a task (ADR-013: only the `task` tool spawns children; this file only reads TaskInfo). PURE painter:
 *  `now` is a parameter, no timers, no wall clock, no randomness, no process access, no state writes —
 *  the renderer replaces s.crew (model.ts setCrew) from tasks.subscribe()/list() and #44 wires the board
 *  with ONE line, `setAgentsPainter(drawAgents)` (draw-code.ts seam). Keys live in keys.ts (#43):
 *  ←→↑↓ move s.code.lane, ⏎ toggles s.code.laneOpen, Esc closes. */

import type { TaskInfo } from "../core/tasks.ts";
import { ATTR, type Rect, type ScreenLike, type Seg, type SextantState, type Theme } from "./types.ts";
import { spinner, st, wrap } from "./draw-util.ts";
import { fmtClock, fmtK } from "./model.ts";

type LaneStatus = TaskInfo["status"];
type Tone = "fg" | "fg2" | "muted" | "dim" | "ok" | "err" | "accent";
type Run = { text: string; tone: Tone; bold?: boolean };
type Row = Run[];

/** columns by body width: 1 below 70 cells, 2 below 120, else 3 — never more than there are tasks */
export const GRID_BREAKS: readonly [number, number] = [70, 120];
/** a cell needs its two border rows + the header + one body row + the result row */
const MIN_CELL_H = 5, MIN_CELL_W = 12;
/** goal preview rows in a grid cell / in the full lane */
const GOAL_ROWS = 2, GOAL_ROWS_FULL = 4;
/** the activity sweep advances one cell per 100 ms */
export const SWEEP_MS = 100;
export const EMPTY_NOTE = "no background tasks — I start them with the task tool for parallel work";
const ESC_HINT = "esc back";

// ------------------------------------------------------------------ pure lane helpers

/** ◇ queued · spinner while running (phase from `now`) · ◆ done · × failed · ▪ cancelled */
export function laneGlyph(status: LaneStatus, now = 0): string {
  switch (status) {
    case "queued": return "◇";
    case "running": return spinner(now);
    case "done": return "◆";
    case "failed": return "×";
    default: return "▪";
  }
}
export function laneTone(status: LaneStatus, theme: Theme): number {
  switch (status) {
    case "queued": return theme.dim;
    case "running": return theme.accent;
    case "done": return theme.ok;
    case "failed": return theme.err;
    default: return theme.muted;
  }
}
/** ms the task has been (or was) active: startedAt — createdAt while still queued — to finishedAt or `now` */
export function laneElapsed(t: TaskInfo, now: number): number {
  return Math.max(0, (t.finishedAt ?? now) - (t.startedAt ?? t.createdAt));
}
/** mm:ss — lane headers drop fmtClock's tenths (app.js:848) */
export const laneClock = (ms: number): string => fmtClock(ms).replace(/\.\d$/, "");
/** total tokens the child used; TaskManager fills usage only when the run settles → "—" until then */
export const laneTokens = (t: TaskInfo): string => (t.usage ? fmtK(t.usage.input + t.usage.output) : "—");
/** short status for lists (the plan panel's `agent · status` column): a live clock while working.
 *  The prototype's `needs you` (a lane blocked on a permission) is not knowable from TaskInfo today —
 *  children run with prompt→deny rules (tasks.ts childPolicy), so no task ever waits on the user. */
export function laneStatus(t: TaskInfo, now: number): string {
  switch (t.status) {
    case "queued": return "queued";
    case "running": return `working ${laneClock(laneElapsed(t, now))}`;
    default: return t.status;
  }
}
const firstLine = (text: string | undefined): string => (text ?? "").split("\n").map((l) => l.trim()).find((l) => l !== "") ?? "";
/** the result row — what the bottom line of a cell says (the running row is the sweep bar instead) */
export function laneResult(t: TaskInfo): string {
  switch (t.status) {
    case "done": return `done: ${firstLine(t.summary) || "(no output)"}`;
    case "failed": return `failed: ${firstLine(t.error) || "(no reason)"}`;
    case "cancelled": return "cancelled";
    case "queued": return "queued · waiting for a slot";
    default: return "running";
  }
}
/** `+N lines merged` for an isolated child whose patch landed; null when there is nothing to say */
export function laneMerged(t: TaskInfo): string | null {
  if (!t.isolated || t.patchLines === undefined) return null;
  return t.patchLines > 0 ? `+${t.patchLines} lines merged` : "nothing merged";
}

export interface CrewSummary {
  total: number; queued: number; running: number; done: number; failed: number; cancelled: number;
  /** non-terminal = queued + running (draw-plan crewWorking agrees) */
  working: number;
  /** lanes blocked on the user — always 0 today (see laneStatus); a runtime signal would fill it */
  needsYou: number;
  /** `k working` · `d/n done` · `no background tasks` */
  text: string;
}
export function crewSummary(crew: readonly TaskInfo[]): CrewSummary {
  const c = { total: crew.length, queued: 0, running: 0, done: 0, failed: 0, cancelled: 0 };
  for (const t of crew) c[t.status]++;
  const working = c.queued + c.running;
  const text = working ? `${working} working` : c.total ? `${c.done}/${c.total} done` : "no background tasks";
  return { ...c, working, needsYou: 0, text };
}

export function gridFor(width: number, n: number): { cols: number; rows: number } {
  if (n <= 0) return { cols: 0, rows: 0 };
  const cols = Math.min(n, width < GRID_BREAKS[0] ? 1 : width < GRID_BREAKS[1] ? 2 : 3);
  return { cols, rows: Math.ceil(n / cols) };
}
/** indeterminate activity bar: a block a quarter of the width (≥1) sweeps left→right one cell per
 *  SWEEP_MS, leaves at the right edge and re-enters at the left — deterministic in `now`, no randomness */
export function sweepCells(width: number, now: number): boolean[] {
  const w = Math.max(1, width), block = Math.max(1, Math.floor(w / 4));
  const head = Math.floor(Math.max(0, now) / SWEEP_MS) % (w + block);
  return Array.from({ length: w }, (_, i) => i < head && i >= head - block);
}

// ------------------------------------------------------------------ geometry

const clampLane = (s: SextantState): number => Math.max(0, Math.min(s.code.lane, s.crew.length - 1));
const innerOf = (R: Rect): Rect => ({ x: R.x + 2, y: R.y + 1, w: R.w - 4, h: R.h - 2 });

export interface BoardPage {
  /** crew index + the cell rect (border included) — the renderer's click zones */
  cells: { index: number; rect: Rect }[];
  page: number;
  pages: number;
  /** the last body row is the `p/n · k tasks` footer because not every lane fits */
  footer: boolean;
}
/** Where each visible lane goes: the open lane fills the body; otherwise a gridFor() grid of equal cells,
 *  paged so the selected lane is always on screen (page = ⌊lane / perPage⌋). [] when the body is too small
 *  for cells (drawAgents then lists lanes compactly). */
export function laneCells(body: Rect, s: SextantState): BoardPage {
  const n = s.crew.length;
  if (n === 0 || body.w < MIN_CELL_W || body.h < 3) return { cells: [], page: 0, pages: 0, footer: false };
  const lane = clampLane(s);
  if (s.code.laneOpen) return { cells: [{ index: lane, rect: body }], page: 0, pages: 1, footer: false };
  const { cols, rows } = gridFor(body.w, n);
  const fit = (h: number): number => cols * Math.max(1, Math.min(rows, Math.floor(h / MIN_CELL_H)));
  const footer = fit(body.h) < n;
  const perPage = fit(body.h - (footer ? 1 : 0)), h = body.h - (footer ? 1 : 0);
  const pages = Math.ceil(n / perPage), page = Math.floor(lane / perPage);
  const first = page * perPage, shown = Math.min(perPage, n - first);
  const cw = Math.floor(body.w / cols), ch = Math.floor(h / Math.ceil(shown / cols));
  const cells = Array.from({ length: shown }, (_, i) => ({ index: first + i, rect: { x: body.x + (i % cols) * cw, y: body.y + Math.floor(i / cols) * ch, w: cw, h: ch } }));
  return { cells, page, pages, footer };
}

/** the full lane's text body: the child's final text (done), its failure reason, or a placeholder */
function fullText(t: TaskInfo): string {
  if (t.status === "done") return t.summary?.trim() || "(no output)";
  if (t.status === "failed" || t.status === "cancelled") return t.error?.trim() || t.status;
  return "no result yet";
}
/** rows under the header of a grid cell: goal preview, `id · agent[ · isolated]`, merged note. In a short
 *  cell (`avail` rows between header and result) the id/agent row wins over goal lines — `/tasks cancel <id>`
 *  needs the id, and the header already carries the label. */
function cellRows(t: TaskInfo, width: number, avail: number): Row[] {
  const goalRows = Math.max(0, Math.min(GOAL_ROWS, avail - 1));
  const rows: Row[] = wrap(t.goal, width).filter((l) => l !== "").slice(0, goalRows).map((l) => [{ text: l, tone: "muted" }]);
  rows.push([{ text: `${t.id} · ${t.agent}${t.isolated ? " · isolated" : ""}`, tone: "dim" }]);
  const merged = laneMerged(t);
  if (merged) rows.push([{ text: merged, tone: t.patchLines ? "ok" : "dim" }]);
  return rows;
}
/** the full lane's head: goal (wrapped, room for `esc back`), meta with depth, status, usage, merged, a blank */
function fullHead(t: TaskInfo, width: number, now: number): Row[] {
  const rows: Row[] = wrap(t.goal, Math.max(1, width - ESC_HINT.length - 2)).filter((l) => l !== "").slice(0, GOAL_ROWS_FULL).map((l) => [{ text: l, tone: "muted" }]);
  if (!rows.length) rows.push([{ text: "", tone: "muted" }]); // the hint row exists even without a goal
  rows.push([{ text: `${t.id} · ${t.agent} · depth ${t.depth}${t.isolated ? " · isolated" : ""}`, tone: "dim" }]);
  rows.push([{ text: laneGlyph(t.status, now) + " ", tone: statusTone(t.status) }, { text: laneStatus(t, now), tone: "fg2" }]);
  if (t.usage) {
    const cost = t.usage.costUsd !== undefined ? ` · $${t.usage.costUsd.toFixed(3)}` : "";
    rows.push([{ text: "tokens ", tone: "muted" }, { text: `${fmtK(t.usage.input)} in · ${fmtK(t.usage.output)} out${cost}`, tone: "fg2" }]);
  }
  const merged = laneMerged(t);
  if (merged) rows.push([{ text: merged, tone: t.patchLines ? "ok" : "dim" }]);
  rows.push([]);
  return rows;
}
const statusTone = (status: LaneStatus): Tone =>
  status === "queued" ? "dim" : status === "running" ? "accent" : status === "done" ? "ok" : status === "failed" ? "err" : "muted";

/** Effective first visible row of the open lane's text body — s.code.scroll clamped to the text (keys.ts
 *  opens with SCROLL_TAIL = the last rows). 0 when no lane is open. The renderer writes this back into
 *  s.code.scroll after a frame (codeScrollTop counts 0 rows for the agents mode — see the #44 notes). */
export function agentsScrollTop(body: Rect, s: SextantState): number {
  if (!s.code.laneOpen || !s.crew.length) return 0;
  const t = s.crew[clampLane(s)]!, I = innerOf(body);
  if (I.w < 4 || I.h < 3) return 0;
  const textRows = I.h - 2 - fullHead(t, I.w, 0).length;
  const max = Math.max(0, wrap(fullText(t), I.w).length - textRows);
  return Math.max(0, Math.min(s.code.scroll, max));
}

// ------------------------------------------------------------------ painting

const runSt = (r: Run, theme: Theme) => st(theme[r.tone], -1, r.bold ? ATTR.BOLD : 0);
const putRow = (scr: ScreenLike, x: number, y: number, w: number, row: Row, theme: Theme): void => {
  if (row.length) scr.text(x, y, row.map((r): Seg => [r.text, runSt(r, theme)]), w);
};

/** `<glyph> <label>` left (bold; accent when selected), `mm:ss · tokens` right (dim) */
function drawHeader(scr: ScreenLike, I: Rect, t: TaskInfo, theme: Theme, now: number, selected: boolean): void {
  const right = `${laneClock(laneElapsed(t, now))} · ${laneTokens(t)}`;
  const showRight = right.length + 6 <= I.w;
  const gx = scr.put(I.x, I.y, laneGlyph(t.status, now) + " ", st(laneTone(t.status, theme)), I.w);
  scr.clip(gx, I.y, t.label, st(selected ? theme.accent : theme.fg, -1, ATTR.BOLD), I.x + I.w - gx - (showRight ? right.length + 1 : 0));
  if (showRight) scr.put(I.x + I.w - right.length, I.y, right, st(theme.dim));
}

/** the bottom row: the sweep bar + `running` while the child runs, else laneResult() colored by outcome */
function drawResult(scr: ScreenLike, x: number, y: number, w: number, t: TaskInfo, theme: Theme, now: number): void {
  if (t.status === "running") {
    const word = "running", bw = w - word.length - 2;
    if (bw < 4) { scr.put(x, y, word, st(theme.muted), w); return; }
    sweepCells(bw, now).forEach((lit, i) => scr.put(x + i, y, lit ? "━" : "─", st(lit ? theme.accent : theme.rule2)));
    scr.put(x + bw + 2, y, word, st(theme.muted));
    return;
  }
  const text = laneResult(t), colon = text.indexOf(": ");
  const tone = laneTone(t.status, theme);
  if (colon < 0) { scr.clip(x, y, text, st(t.status === "queued" ? theme.dim : tone), w); return; }
  const px = scr.put(x, y, text.slice(0, colon + 2), st(tone), w);
  scr.clip(px, y, text.slice(colon + 2), st(t.status === "failed" ? theme.err : theme.fg2), x + w - px);
}

function drawCell(scr: ScreenLike, R: Rect, t: TaskInfo, s: SextantState, theme: Theme, now: number, selected: boolean): void {
  const focused = s.focus === "code", full = s.code.laneOpen;
  scr.box(R.x, R.y, R.w, R.h, st(selected ? (focused ? theme.accent : theme.frame) : theme.frameDim));
  const I = innerOf(R);
  if (I.w < 4 || I.h < 1) return;
  drawHeader(scr, I, t, theme, now, selected);
  if (I.h < 2) return;
  const fy = I.y + I.h - 1;
  const head = full ? fullHead(t, I.w, now) : cellRows(t, I.w, I.h - 2);
  let y = I.y + 1;
  for (const row of head) { if (y >= fy) break; putRow(scr, I.x, y++, I.w, row, theme); }
  if (full) {
    if (I.w > ESC_HINT.length + 4 && I.y + 1 < fy) scr.put(I.x + I.w - ESC_HINT.length, I.y + 1, ESC_HINT, st(theme.dim));
    const lines = wrap(fullText(t), I.w), top = agentsScrollTop(R, s);
    const tone = t.status === "failed" ? theme.err : t.status === "done" ? theme.fg2 : theme.muted;
    for (let i = top; i < lines.length && y < fy; i++) scr.put(I.x, y++, lines[i]!, st(tone), I.w);
  }
  drawResult(scr, I.x, fy, I.w, t, theme, now);
}

/** a body too small for cells: one line per lane, `<glyph> <label>` + the status word at the right */
function drawCompact(scr: ScreenLike, B: Rect, s: SextantState, theme: Theme, now: number): void {
  const lane = clampLane(s);
  s.crew.slice(0, B.h).forEach((t, i) => {
    const status = laneStatus(t, now), room = B.w - status.length - 1;
    const gx = scr.put(B.x, B.y + i, laneGlyph(t.status, now) + " ", st(laneTone(t.status, theme)), B.w);
    scr.clip(gx, B.y + i, t.label, st(i === lane ? theme.accent : theme.fg), Math.max(0, Math.min(B.x + B.w, B.x + room) - gx));
    if (room > 8) scr.put(B.x + B.w - status.length, B.y + i, status, st(theme.dim));
  });
}

/** Paint the crew board into `rect` (the code panel's body, from draw-code's setAgentsPainter seam): the
 *  lane grid, or the selected lane full-size when s.code.laneOpen, or the empty note. Pure over its inputs. */
export function drawAgents(scr: ScreenLike, rect: Rect, s: SextantState, theme: Theme, now: number): void {
  if (rect.w <= 0 || rect.h <= 0) return;
  scr.fill(rect.x, rect.y, rect.w, rect.h, " ", st(-1, theme.bg)); // the board owns its body (panel() idiom)
  if (!s.crew.length) { scr.clip(rect.x, rect.y, EMPTY_NOTE, st(theme.muted), rect.w); return; }
  const page = laneCells(rect, s);
  if (!page.cells.length) { drawCompact(scr, rect, s, theme, now); return; }
  const lane = clampLane(s);
  for (const { index, rect: R } of page.cells) drawCell(scr, R, s.crew[index]!, s, theme, now, index === lane);
  if (page.footer) scr.clip(rect.x, rect.y + rect.h - 1, `${page.page + 1}/${page.pages} · ${s.crew.length} tasks · ←→↑↓ select`, st(theme.dim), rect.w);
}
