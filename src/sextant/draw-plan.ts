/** Sextant plan + usage painters (port #41). Ported from the user's sextant v0.4.0 app.js:675-744
 *  (drawPlan steps/crew/next, drawUsage tokens/context bar/cost); the scenario phases are gone — the
 *  steps ARE the session's todos (tools/todo.ts loadTodos), the crew rows are TaskManager TaskInfo,
 *  usage comes from the run's real token/cost accounting. Pure: `now` only drives the crew spinner. */

import { ATTR } from "./types.ts";
import type { Rect, ScreenLike, Seg, SextantState, Theme } from "./types.ts";
import type { TaskInfo } from "../core/tasks.ts";
import { EMPTY } from "../core/voice.ts";
import type { TodoItem } from "../tools/todo.ts";
import { fmtK, planCounts } from "./model.ts";
import { crewSummary, laneGlyph, laneStatus, laneTone } from "./draw-agents.ts";
import { crewCardBlock, crewCardHeight, groupCrew, paintCrewCards, type CrewTask } from "./crew-cards.ts";
import { panel } from "./layout.ts";
import { st } from "./theme.ts";
import { driftRow } from "./draw-context.ts";

/** the crew section's row ceiling: two full cards and the separator between them (the card is 3 rows —
 *  crew-cards.ts). Beyond that the plan's own steps lose their room, and the `+N more` footer says what is
 *  not shown; the full board is `∷` (draw-agents.ts). */
const CREW_ROWS_MAX = 7;
export const STEP_GLYPH: Record<TodoItem["status"], string> = { completed: "◆", in_progress: "◈", pending: "◇" };

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();
/** greedy word wrap (app.js wrap) — long words are split at the width */
export function wrapText(text: string, width: number): string[] {
  const out: string[] = [];
  if (width <= 0) return out;
  for (const para of oneLine(text).split("\n")) {
    let line = "";
    for (const w of para.split(" ")) {
      if (!line) { line = w; continue; }
      if ([...line].length + 1 + [...w].length <= width) line += " " + w; else { out.push(line); line = w; }
    }
    while ([...line].length > width) { const cps = [...line]; out.push(cps.slice(0, width).join("")); line = cps.slice(width).join(""); }
    out.push(line);
  }
  return out;
}

/** `next` = the in_progress item, then the first pending one */
export function nextSteps(todos: readonly TodoItem[]): TodoItem[] {
  const out: TodoItem[] = [];
  const cur = todos.find((t) => t.status === "in_progress"); if (cur) out.push(cur);
  const pend = todos.find((t) => t.status === "pending"); if (pend) out.push(pend);
  return out;
}
/** non-terminal tasks = "working" (queued + running) — crewSummary(crew).working agrees */
export const crewWorking = (crew: readonly TaskInfo[]): number => crewSummary(crew).working;
/** the crew board's glyph + tone (#46 draw-agents): ◇ queued · spinner running · ◆ done · × failed · ▪ cancelled */
export function crewGlyph(t: TaskInfo, theme: Theme, now: number): [string, number] {
  return [laneGlyph(t.status, now), laneTone(t.status, theme)];
}
/** the crew board's status word (#46 laneStatus): `working mm:ss` while running, else the status */
export const crewStatus = (t: TaskInfo, now = 0): string => laneStatus(t, now);

/** Plan panel: `plan  done/total` title, todo steps (◆ done · ◈ in_progress · ◇ pending, priority hint
 *  at the right), then — anchored to the bottom — `crew  k working` (when any) and `next`. */
export function drawPlan(scr: ScreenLike, R: Rect, s: SextantState, theme: Theme, now = 0): void {
  const todos = s.plan.todos, c = planCounts(s);
  const B = panel(scr, R, "plan", false, todos.length ? [[`${c.completed}/${c.total}`, st(theme.muted)]] : [], theme);
  const yEnd = B.y + B.h;
  let y = B.y;
  if (s.plan.note) for (const line of wrapText(s.plan.note, B.w).slice(0, 2)) if (y < yEnd) scr.put(B.x, y++, line, st(theme.warn), B.w);
  const next = nextSteps(todos);
  // the crew section is CARDS now (Berkay's pick): one card per workflow — the tasks of one run — never one row
  // per task. The height is what the cards actually need, capped; the block itself drops spacing, then names,
  // then whole cards behind a footer (crew-cards.ts states the order).
  const groups = groupCrew(s.crew as readonly CrewTask[]);
  const crewNeed = groups.length ? Math.min(CREW_ROWS_MAX, crewCardHeight(groups, B.w, now)) : 0;
  let nextRows = next.length ? next.length + 1 : 0, crewRows = crewNeed ? crewNeed + 1 : 0;
  let nextY = yEnd - nextRows;
  let crewY = (nextRows ? nextY - 1 : yEnd) - crewRows;
  const minY = y + 2; // keep the steps header + one row above the anchored blocks
  if (crewRows && crewY < minY) { crewRows = 0; crewY = yEnd; }
  if (nextRows && nextY < minY) { nextRows = 0; nextY = yEnd; }
  const stepsEnd = crewRows ? crewY - 1 : nextRows ? nextY - 1 : yEnd;
  scr.text(B.x, y++, [["steps", st(theme.muted)], [todos.length ? `  ${c.completed}/${c.total}` : "", st(theme.dim)]], B.w);
  if (!todos.length && y < stepsEnd) { // empty plan: the hint's second line only when there is room
    scr.put(B.x, y++, EMPTY.plan[0], st(theme.dim), B.w);
    if (y < stepsEnd) scr.put(B.x, y++, EMPTY.plan[1], st(theme.dim), B.w);
  }
  // a long plan windows around the step in progress instead of always showing its head: the person
  // wants to see what is being done now, not steps 1-8 of 30. One row above says how many are earlier.
  const room = Math.max(0, stepsEnd - y), curIdx = todos.findIndex((t) => t.status === "in_progress");
  let start = 0;
  if (todos.length > room && curIdx >= room - 1) { // the current step would be hidden (or be the marker row)
    const visible = Math.max(1, room - 2); // minus the "earlier" row and the "+N more" row
    start = Math.max(0, Math.min(curIdx - Math.floor(visible / 2), todos.length - visible));
  }
  if (start > 0 && y < stepsEnd) scr.put(B.x, y++, `  …${start} earlier`, st(theme.dim), B.w);
  let shown = start;
  for (const t of todos.slice(start)) {
    if (y >= stepsEnd) break;
    const cur = t.status === "in_progress", done = t.status === "completed";
    const pr = t.priority === "high" ? "high" : t.priority === "low" ? "low" : "";
    scr.put(B.x, y, STEP_GLYPH[t.status], st(done ? theme.okDim : cur ? theme.accent : theme.dim));
    scr.clip(B.x + 3, y, oneLine(t.content), st(done ? theme.fg2 : cur ? theme.fg : theme.muted, -1, cur ? ATTR.BOLD : 0), B.w - 3 - (pr ? pr.length + 1 : 0));
    if (pr) scr.put(B.x + B.w - pr.length, y, pr, st(t.priority === "high" ? theme.warn : theme.dim));
    y++; shown++;
  }
  if (shown < todos.length && shown > 0) { y--; scr.fill(B.x, y, B.w, 1, " "); scr.put(B.x, y, `  +${todos.length - shown + 1} more`, st(theme.dim), B.w); }
  if (crewRows) {
    let cy = crewY;
    scr.text(B.x, cy++, [["crew", st(theme.muted)], [`  ${crewSummary(s.crew).text}`, st(theme.dim)]], B.w);
    const block = crewCardBlock(groups, B.w, crewRows - 1, now);
    paintCrewCards(scr, B.x, cy, B.w, block.lines, theme);
  }
  if (nextRows) {
    let ny = nextY;
    scr.put(B.x, ny++, "next", st(theme.muted));
    for (const t of next) {
      const cur = t.status === "in_progress";
      scr.text(B.x, ny++, [[STEP_GLYPH[t.status] + " ", st(cur ? theme.accent : theme.dim)], [oneLine(t.content), st(cur ? theme.fg : theme.muted)]], B.w);
    }
  }
}

/** filled cells of a `width`-wide context bar at `pct` (0..100) */
export const barFilled = (pct: number, width: number): number => Math.round((Math.max(0, Math.min(100, pct)) / 100) * width);
/** the first candidate that fits `width` cells, else the last one clipped with an ellipsis */
export function fitText(candidates: readonly string[], width: number): string {
  for (const c of candidates) if ([...c].length <= width) return c;
  const last = candidates[candidates.length - 1];
  if (last === undefined || width <= 0) return "";
  return width === 1 ? "…" : [...last].slice(0, width - 1).join("") + "…";
}

/** Usage panel (3 inner rows): `tokens 4.2k` (+ in/out split when it fits), `context ━━──── 12%`
 *  (or `context ?` when the window is unknown), `cost $0.030` (or `cost —` when unpriced) +
 *  provider/model (model alone, then clipped, when narrow). */
/** Token counts for the context row, as short as they can be and still be read: `842`, `4.2k`, `24k`,
 *  `200k`, `1M`. fmtK keeps a decimal at every size, which is right where a number stands alone and
 *  wrong in a pair — `24.0k/200.0k` costs six characters that say nothing and eats the bar beside it. */
function fmtCtx(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  const m = n / 1_000_000;
  return m < 10 && m !== Math.round(m) ? `${m.toFixed(1)}M` : `${Math.round(m)}M`;
}

export function drawUsage(scr: ScreenLike, R: Rect, s: SextantState, theme: Theme): void {
  const B = panel(scr, R, "usage", false, [], theme);
  const u = s.usage;
  const label = (t: string): Seg => [t.padEnd(10), st(theme.muted)];
  const total = fmtK(u.tokensIn + u.tokensOut);
  const split = fitText([`  ${fmtK(u.tokensIn)} in · ${fmtK(u.tokensOut)} out`, `  ${fmtK(u.tokensIn)}/${fmtK(u.tokensOut)}`, ""], B.w - 10 - total.length);
  if (u.tokensIn + u.tokensOut === 0) scr.text(B.x, B.y, [label("tokens"), [EMPTY.usage, st(theme.dim)]], B.w); // nothing spent yet
  else scr.text(B.x, B.y, [label("tokens"), [total, st(theme.fg)], [split, st(theme.dim)]], B.w);
  scr.text(B.x, B.y + 1, [label("context")]);
  if (u.contextPct === null) scr.put(B.x + 10, B.y + 1, "?", st(theme.dim));
  else {
    // A percentage alone goes blind on a large window. claude-opus-5 carries 1,000,000 tokens, so a
    // real working session sits at 0% for hours: you need 10k tokens to move the first digit, and
    // Berkay's report was exactly this — "context shows 0%, we cannot see how much context there is".
    // The numbers are what a person acts on ("42k of 1M" is a decision; "0%" is not), so they get the
    // room and the percent keeps only what is left. The bar stays: it is the at-a-glance channel, and
    // it is the only part that reads correctly when the window is small.
    const pct = `${Math.round(u.contextPct)}%`;
    const nums = u.contextWindow !== undefined ? `${fmtCtx(u.contextTokens ?? 0)}/${fmtCtx(u.contextWindow)}` : "";
    const tail = nums === "" ? pct : `${nums} ${pct}`;
    const barW = Math.max(4, B.w - 10 - tail.length - 2);
    const filled = barFilled(u.contextPct, barW);
    for (let i = 0; i < barW; i++) scr.put(B.x + 10 + i, B.y + 1, i < filled ? "━" : "─", st(i < filled ? theme.accent : theme.rule2));
    const tailX = B.x + 10 + barW + 2;
    if (nums !== "") scr.put(tailX, B.y + 1, nums, st(theme.dim));
    scr.put(tailX + (nums === "" ? 0 : nums.length + 1), B.y + 1, pct, st(u.contextPct > 80 ? theme.warn : theme.fg));
  }
  const cost = u.costUsd === null ? "—" : `$${u.costUsd.toFixed(3)}`;
  const model = u.model ? fitText([u.provider ? `  ${u.provider}/${u.model}` : `  ${u.model}`, `  ${u.model}`], B.w - 10 - cost.length) : "";
  scr.text(B.x, B.y + 2, [label("cost"), [cost, st(theme.fg)], [model, st(theme.dim)]], B.w);

  // How far the bar above is from what the provider actually counted. It matters here rather than only
  // inside /context because compaction fires on OUR estimate: a model whose real prompt is a fifth bigger
  // than the bar says gets compacted late, and the bar is the thing the human is looking at when they
  // decide whether one more turn fits.
  //
  // Drawn only once /context has been opened, and silent otherwise. The number comes from comparing our
  // count with a turn that reported usage, which the cockpit does not do on its own — and inventing a
  // placeholder ("drift —") would take a row to say nothing. `driftRow` returns undefined when there is
  // nothing honest to say, so this is one condition rather than a special case.
  const d = s.context ? driftRow(s.context.drift, s.context.tolerance) : undefined;
  if (d && B.h > 3) {
    scr.text(B.x, B.y + 3, [label("drift"), [fitText([d.text, ""], B.w - 10), st(d.warn ? theme.warn : theme.dim)]], B.w);
  }
}
