/** Port #41 plan + usage panels: todo glyphs (◆ done · ◈ in_progress · ◇ pending) and n/m counts
 *  following a REAL todos.json through loadTodos (incl. a corrupt file → note, never throws), the
 *  `next` block, the crew block over TaskInfo, the overflow marker, and the usage panel math
 *  (bar fill, unknown window → `context ?`, unpriced → `cost —`, narrow-width fitting). */

import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTodos, saveTodos, TODOS_FILE, type TodoItem } from "../../src/tools/todo.ts";
import { drawPlan, drawUsage, barFilled, fitText, nextSteps, wrapText, crewWorking, crewStatus, STEP_GLYPH } from "../../src/sextant/draw-plan.ts";
import { GridScreen } from "../../src/sextant/grid.ts";
import { initialState, setCrew, setPlan, setUsage } from "../../src/sextant/model.ts";
import type { SextantState } from "../../src/sextant/types.ts";
import type { TaskInfo } from "../../src/core/tasks.ts";
import { nightTheme } from "../helpers/sextant-theme-41.ts";

const theme = nightTheme();
const T = 1_700_000_000_000;
const state = (): SextantState => initialState({ cwd: "C:/w", repo: { name: "w", branch: "main" }, version: "0.2.0", theme: "night", mode: "act", yolo: false, commands: [], now: T, model: { provider: "anthropic", model: "claude-sonnet-4" } });
const TODOS: TodoItem[] = [
  { id: "t1", content: "read the auth flow", status: "completed" },
  { id: "t2", content: "add the state check", status: "in_progress", priority: "high" },
  { id: "t3", content: "run the auth tests", status: "pending" },
  { id: "t4", content: "update the notes", status: "pending", priority: "low" },
];
const plan = (s: SextantState, w = 34, h = 20, now = T): string => { const g = new GridScreen(w, h); drawPlan(g, { x: 0, y: 0, w, h }, s, theme, now); return g.toText(); };
const usage = (s: SextantState, w = 34): string => { const g = new GridScreen(w, 5); drawUsage(g, { x: 0, y: 0, w, h: 5 }, s, theme); return g.toText(); };
const lines = (t: string) => t.split("\n").map((l) => l.replace(/^│ | │$/g, "").trimEnd());

test("plan: title n/m, steps with ◆/◈/◇ glyphs + priority hints, `next` = in_progress then the first pending", () => {
  const s = state();
  setPlan(s, { items: TODOS });
  const t = plan(s);
  expect(t.split("\n")[0]).toBe("╭─ plan ──────────────────── 1/4 ╮");
  expect(lines(t).slice(1, 6)).toEqual(["steps  1/4", "◆  read the auth flow", "◈  add the state check    high", "◇  run the auth tests", "◇  update the notes        low"]);
  expect(lines(t).slice(-4, -1)).toEqual(["next", "◈ add the state check", "◇ run the auth tests"]);
  expect(STEP_GLYPH).toEqual({ completed: "◆", in_progress: "◈", pending: "◇" });
  expect(nextSteps(TODOS).map((x) => x.id)).toEqual(["t2", "t3"]);
  expect(nextSteps(TODOS.map((x) => ({ ...x, status: "completed" as const })))).toEqual([]);
  expect(nextSteps([TODOS[2]!, TODOS[3]!]).map((x) => x.id)).toEqual(["t3"]);
});

test("plan: empty list → 'no plan yet', no counts in the title, no next block", () => {
  const t = plan(state());
  expect(t.split("\n")[0]).toBe("╭─ plan ─────────────────────────╮");
  expect(lines(t).slice(1, 3)).toEqual(["steps", "no plan yet"]);
  expect(t).not.toContain("next");
});

test("plan follows a REAL todos.json through loadTodos; a corrupt file renders its note and never throws", () => {
  const dir = mkdtempSync(join(tmpdir(), "rovecode-sx-plan-"));
  try {
    const s = state();
    setPlan(s, loadTodos(dir)); // missing file: empty, no note
    expect(s.plan).toEqual({ todos: [] });
    saveTodos(dir, TODOS);
    setPlan(s, loadTodos(dir));
    expect(plan(s)).toContain("─ plan ──────────────────── 1/4 ╮");
    saveTodos(dir, TODOS.map((x) => ({ ...x, status: "completed" as const })));
    setPlan(s, loadTodos(dir));
    const done = plan(s);
    expect(done).toContain(" 4/4 ╮");
    expect(lines(done).slice(2, 6).every((l) => l.startsWith("◆  "))).toBe(true);
    expect(done).not.toContain("next");
    writeFileSync(join(dir, TODOS_FILE), "{ not json");
    expect(() => setPlan(s, loadTodos(dir))).not.toThrow();
    const corrupt = plan(s);
    expect(s.plan.note).toContain("not valid JSON");
    expect(lines(corrupt)[1]).toBe("todos.json is not valid JSON —");
    expect(corrupt).toContain("no plan yet");
    expect(corrupt.split("\n")[0]).toBe("╭─ plan ─────────────────────────╮");
    writeFileSync(join(dir, TODOS_FILE), JSON.stringify({ version: 1, items: [{ id: "a", content: "x", status: "bogus" }] }));
    setPlan(s, loadTodos(dir));
    expect(plan(s)).toContain("failed validation");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("crew block: `crew k working` counts queued + running, the section is CARDS (working workflows first), done/total when idle", () => {
  const s = state();
  setPlan(s, { items: TODOS });
  const mk = (id: string, label: string, status: TaskInfo["status"]): TaskInfo => ({ id, label, agent: "worker", goal: "g", isolated: false, depth: 1, status, createdAt: T });
  setCrew(s, [mk("1", "write tests", "running"), mk("2", "review", "done"), mk("3", "docs", "queued"), mk("4", "lint", "failed"), mk("5", "old", "cancelled")]);
  const t = plan(s, 34, 24, T + 200);
  const L = lines(t);
  const crewAt = L.indexOf("crew  2 working");
  expect(crewAt).toBeGreaterThan(0);
  // one CARD per workflow (sextant/crew-cards.ts): `title ›`, `N agents · age`, then a chip per agent. These five
  // tasks carry no batch, so each is its own workflow; the two WORKING ones lead (the header just said 2 working),
  // newest first, and the rest are behind the footer rather than pushing the live work off the panel.
  expect(L.slice(crewAt + 1, crewAt + 8)).toEqual([
    "docs                         ›", "1 agent · 00s", "▫  worker",
    "write tests                  ›", "1 agent · 00s", "▪  worker",
    "+3 more",
  ]);
  expect(L[crewAt + 8]).toBe("");
  expect(L[crewAt + 9]).toBe("next");
  expect(crewWorking(s.crew)).toBe(2);
  expect(crewStatus(mk("x", "x", "running"), T + 61_500)).toBe("working 01:01");
  expect(crewStatus(mk("x", "x", "failed"))).toBe("failed");
  setCrew(s, [mk("2", "review", "done"), mk("4", "lint", "failed")]);
  expect(plan(s)).toContain("crew  1/2 done");
  setCrew(s, []);
  expect(plan(s)).not.toContain("crew");
});

test("a long plan windows around the step in progress: `…k earlier` above, `+k more` below, the current step visible", () => {
  const s = state();
  const items: TodoItem[] = Array.from({ length: 30 }, (_, i) => ({ id: `t${i}`, content: `step ${i}`, status: i < 20 ? "completed" as const : i === 20 ? "in_progress" as const : "pending" as const }));
  setPlan(s, { items });
  const L = lines(plan(s, 34, 12));
  expect(L[1]).toBe("steps  20/30");
  expect(L.find((l) => l.startsWith("  …"))).toMatch(/^ {2}…\d+ earlier$/);
  expect(L.some((l) => l.includes("◈ step 20"))).toBe(true); // the current step is on screen
  expect(L.some((l) => l.includes("step 0"))).toBe(false);   // the head is not
  expect(L.find((l) => l.startsWith("  +"))).toMatch(/^ {2}\+\d+ more$/);
  // the current step near the head: no window, the head shows as before
  setPlan(s, { items: items.map((t, i) => ({ ...t, status: i < 2 ? "completed" as const : i === 2 ? "in_progress" as const : "pending" as const })) });
  const H = lines(plan(s, 34, 12));
  expect(H.some((l) => l.startsWith("  …"))).toBe(false);
  expect(H.some((l) => l.includes("step 0"))).toBe(true);
});

test("plan overflow: steps that do not fit collapse into a `+k more` marker; the anchored blocks yield when the panel is too short", () => {
  const s = state();
  setPlan(s, { items: Array.from({ length: 12 }, (_, i) => ({ id: `t${i}`, content: `step ${i}`, status: i < 3 ? "completed" as const : i === 3 ? "in_progress" as const : "pending" as const })) });
  const t = plan(s, 34, 12);
  const L = lines(t);
  expect(L[1]).toBe("steps  3/12");
  expect(L.find((l) => l.startsWith("  +"))).toBe("  +8 more");
  expect(t).toContain("next");
  expect(t).toContain("◈ step 3");
  const tiny = plan(s, 34, 5); // 3 inner rows: header + steps only, no next block
  expect(tiny).not.toContain("next");
  expect(lines(tiny)[1]).toBe("steps  3/12");
});

test("usage: tokens + in/out split, context bar fill + percent, cost + provider/model; unknown window → `context ?`; unpriced → `cost —`", () => {
  const s = state();
  setUsage(s, { tokensIn: 4200, tokensOut: 1300, contextTokens: 24_000, contextWindow: 200_000, costUsd: 0.03 });
  const wide = lines(usage(s, 44)); // inner 40: barW 23, filled = round(.12 * 23) = 3
  expect(wide[1]).toBe("tokens    5.5k  4.2k in · 1.3k out");
  // The COUNTS carry this row, not the percent. A percentage alone goes blind on a large window —
  // claude-opus-5 has 1,000,000 tokens, so a real session sits at "0%" for hours (see the case below).
  expect(wide[2]).toBe("context   " + "━".repeat(2) + "─".repeat(14) + "  24k/200k 12%");
  expect(wide[3]).toBe("cost      $0.030  claude-sonnet-4"); // provider/model needs 27 cells; 24 remain → model alone
  expect(lines(usage(s, 50))[3]).toBe("cost      $0.030  anthropic/claude-sonnet-4");
  const narrow = lines(usage(s, 34)); // inner 30: barW 13, filled 2; tails shrink instead of clipping mid-word
  expect(narrow[1]).toBe("tokens    5.5k  4.2k/1.3k");
  expect(narrow[2]).toBe("context   ━─────  24k/200k 12%"); // the bar yields room; the numbers do not
  expect(narrow[3]).toBe("cost      $0.030  claude-sonn…");
  setUsage(s, { contextTokens: 5, contextWindow: undefined, costUsd: null });
  const unknown = lines(usage(s, 34));
  expect(unknown[2]).toBe("context   ?");
  expect(unknown[3]).toBe("cost      —  claude-sonnet-4");
  setUsage(s, { contextTokens: 190_000, contextWindow: 200_000 });
  expect(lines(usage(s, 34))[2]).toBe("context   ━━━━━  190k/200k 95%");
  // THE CASE THIS ROW WAS CHANGED FOR. A million-token window rounds a working session to 0% and the
  // bar to empty: the percent and the bar both say "nothing is happening" while 42,000 tokens are in
  // the window. The counts are the only channel that survives the scale, which is why they are here.
  setUsage(s, { contextTokens: 42_000, contextWindow: 1_000_000 });
  expect(lines(usage(s, 34))[2]).toBe("context   ─────────  42k/1M 4%");
  setUsage(s, { contextTokens: 900, contextWindow: 1_000_000 });
  expect(lines(usage(s, 34))[2]).toBe("context   ─────────  900/1M 0%"); // under 1k stays exact
  setUsage(s, { contextTokens: 400_000, contextWindow: 200_000 });
  expect(lines(usage(s, 34))[2]).toBe("context   ━━━━  400k/200k 100%");
  expect(barFilled(12, 13)).toBe(2);
  expect(barFilled(50, 13)).toBe(7);
  expect(barFilled(0, 13)).toBe(0);
  expect(barFilled(100, 13)).toBe(13);
  expect(barFilled(-5, 13)).toBe(0);
  expect(barFilled(140, 13)).toBe(13);
});

test("fitText / wrapText helpers", () => {
  expect(fitText(["long candidate", "short", ""], 6)).toBe("short");
  expect(fitText(["long candidate", "shorter"], 5)).toBe("shor…");
  expect(fitText(["abc"], 1)).toBe("…");
  expect(fitText(["abc"], 0)).toBe("");
  expect(fitText([], 5)).toBe("");
  expect(wrapText("the quick brown fox", 9)).toEqual(["the quick", "brown fox"]);
  expect(wrapText("supercalifragilistic", 5)).toEqual(["super", "calif", "ragil", "istic"]);
  expect(wrapText("a  b   c", 10)).toEqual(["a b c"]);
  expect(wrapText("x", 0)).toEqual([]);
});
