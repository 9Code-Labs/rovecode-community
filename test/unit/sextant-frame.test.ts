/** Port #41 headless frame: dumpFrame goldens at a FIXED clock (welcome / reading / editing / done /
 *  denied at 160×44 and 100×30 — the frame, files, plan and usage panels; code/messages/pet are the
 *  titled placeholder boxes until #42/#45 plug their painters in), the painters/layout dependency
 *  seam, layoutFallback breakpoints, the boot reveal, toasts, GridScreen clipping, and the negative
 *  bar: dumpFrame creates no timers (spy on setTimeout/setInterval) so this file exits by itself.
 *  Regenerate the goldens with SEXTANT_UPDATE_GOLDENS=1 after an intentional visual change. */

import { test, expect } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dumpFrame, layoutFallback, renderFrame, defaultPainters, type FrameDeps } from "../../src/sextant/frame.ts";
import { GridScreen } from "../../src/sextant/grid.ts";
import { applyEvent, initialState, pushToast, setCrew, setFiles, setPlan, setUsage } from "../../src/sextant/model.ts";
import type { FileStatus, SextantState } from "../../src/sextant/types.ts";
import type { RunEvent } from "../../src/core/types.ts";
import type { TaskInfo } from "../../src/core/tasks.ts";
import { nightTheme } from "../helpers/sextant-theme-41.ts";

const theme = nightTheme();
const T0 = 1_700_000_000_000; // fixed clock: boot
const NOW = T0 + 60_000;      // fixed clock: the frame (well past the boot reveal)
const FIXTURES = join(import.meta.dir, "..", "fixtures", "sextant");
const UPDATE = process.env.SEXTANT_UPDATE_GOLDENS === "1";

// ---------- scenario builders (deterministic — every timestamp derives from T0/NOW, monotonic) ----------

const PATHS = ["README.md", "package.json", "src/app.ts", "src/auth/callback.ts", "src/auth/session.ts", "src/api/routes.ts", "src/api/middleware.ts", "tests/auth.test.ts"];
const STATUSES = new Map<string, FileStatus>([["src/auth/callback.ts", "M"], ["src/auth/session.ts", "M"], ["src/auth/guard.ts", "A"], ["src/legacy.ts", "D"]]);

function base(): SextantState {
  const s = initialState({
    cwd: "C:/projects/atlas", repo: { name: "atlas", branch: "feature/auth" }, version: "0.2.0", theme: "night", mode: "act", yolo: false,
    commands: [{ name: "help", description: "commands" }], now: T0, model: { provider: "anthropic", model: "claude-sonnet-4" },
  });
  setFiles(s, PATHS, STATUSES);
  s.files.expanded.add("src"); s.files.expanded.add("src/auth");
  return s;
}
const ev = (s: SextantState, e: RunEvent, at: number) => applyEvent(s, e, at);
const READ_OUT = "src/auth/callback.ts#a1b2\n1#c3d4|export async function callback(req, res) {\n2#e5f6|  const { code, state } = req.query;\n3#0a1b|}\n(showing lines 1-3 of 3)";
const EDIT_ARGS = { path: "src/auth/callback.ts", edits: [
  { tag: "a1b2", anchorLine: 2, anchorHash: "e5f6", newLines: ["  const { code, state } = req.query;", "  if (!code || !state) {", "    return res.status(400).end();"] },
  { tag: "a1b2", anchorLine: 3, anchorHash: "0a1b", newLines: ["  }"] },
] };
const TODOS_MID = [
  { id: "t1", content: "read the auth flow", status: "completed" as const },
  { id: "t2", content: "add the state check", status: "in_progress" as const, priority: "high" as const },
  { id: "t3", content: "run the auth tests", status: "pending" as const },
  { id: "t4", content: "update the notes", status: "pending" as const, priority: "low" as const },
];
const CREW: TaskInfo[] = [
  { id: "task-1", label: "write tests", agent: "worker", goal: "write tests for guard.ts", isolated: true, depth: 1, status: "running", createdAt: T0 + 1000, startedAt: T0 + 1100 },
  { id: "task-2", label: "review", agent: "reviewer", goal: "review the callback", isolated: false, depth: 1, status: "done", createdAt: T0 + 1000, startedAt: T0 + 1100, finishedAt: T0 + 9000, summary: "looks good" },
];

function welcome(): SextantState {
  const s = base();
  pushToast(s, "theme · night", NOW - 1000);
  return s;
}
/** run started 14 s ago, the first read still running */
function reading(): SextantState {
  const s = base();
  ev(s, { type: "run_start", runId: "run-1", sessionId: "sess", goal: "implement authentication" }, NOW - 14_000);
  ev(s, { type: "turn_start", turn: 1 }, NOW - 13_900);
  ev(s, { type: "message_update", messageId: "m1", delta: "Let me look at the auth flow first." }, NOW - 13_000);
  ev(s, { type: "tool_execution_start", callId: "c1", tool: "read", args: { path: "src/auth/callback.ts" } }, NOW - 1000);
  setPlan(s, { items: TODOS_MID.map((t, i) => (i === 0 ? { ...t, status: "in_progress" as const } : { ...t, status: "pending" as const })) });
  setUsage(s, { turns: 1, tokensIn: 1200, tokensOut: 80, contextTokens: 1280, contextWindow: 200_000, costUsd: 0.004 });
  return s;
}
/** the read landed, an edit started 300 ms ago (touched spinner live), crew + usage populated */
function editing(): SextantState {
  const s = reading();
  ev(s, { type: "tool_execution_end", callId: "c1", ok: true, output: READ_OUT, durationMs: 12 }, NOW - 900);
  ev(s, { type: "turn_start", turn: 2 }, NOW - 800);
  ev(s, { type: "tool_execution_start", callId: "c2", tool: "edit", args: EDIT_ARGS }, NOW - 300);
  setPlan(s, { items: TODOS_MID });
  setCrew(s, CREW);
  setUsage(s, { turns: 2, tokensIn: 4200, tokensOut: 1300, contextTokens: 24_000, contextWindow: 200_000, costUsd: 0.03 });
  return s;
}
/** the whole run: read → edit → tests → summary → run_end done 2 s ago (clock frozen at 12 s) */
function done(): SextantState {
  const s = base();
  ev(s, { type: "run_start", runId: "run-1", sessionId: "sess", goal: "implement authentication" }, NOW - 14_000);
  ev(s, { type: "turn_start", turn: 1 }, NOW - 13_900);
  ev(s, { type: "message_update", messageId: "m1", delta: "Let me look at the auth flow first." }, NOW - 13_000);
  ev(s, { type: "tool_execution_start", callId: "c1", tool: "read", args: { path: "src/auth/callback.ts" } }, NOW - 12_900);
  ev(s, { type: "tool_execution_end", callId: "c1", ok: true, output: READ_OUT, durationMs: 12 }, NOW - 12_800);
  ev(s, { type: "turn_start", turn: 2 }, NOW - 12_700);
  ev(s, { type: "tool_execution_start", callId: "c2", tool: "edit", args: EDIT_ARGS }, NOW - 12_000);
  ev(s, { type: "tool_execution_end", callId: "c2", ok: true, output: "applied 2 edit(s); new TAG b7c8", durationMs: 42 }, NOW - 11_000);
  ev(s, { type: "turn_start", turn: 3 }, NOW - 7900);
  ev(s, { type: "tool_execution_start", callId: "c3", tool: "bash", args: { command: "bun test test/auth.test.ts" } }, NOW - 7800);
  ev(s, { type: "tool_execution_end", callId: "c3", ok: true, output: "exit=0\n 18 pass\n 0 fail\nRan 18 tests across 1 files.", durationMs: 2100 }, NOW - 5000);
  ev(s, { type: "turn_start", turn: 4 }, NOW - 4900);
  ev(s, { type: "message_update", messageId: "m4", delta: "All green — the callback now rejects requests without code/state." }, NOW - 4000);
  ev(s, { type: "turn_end", turn: 4, stopReason: "end_turn" as never }, NOW - 3000);
  ev(s, { type: "run_end", status: "done", summary: "authentication implemented" }, NOW - 2000);
  setPlan(s, { items: TODOS_MID.map((t) => ({ ...t, status: "completed" as const })) });
  setCrew(s, CREW.map((t) => ({ ...t, status: "done" as const, finishedAt: T0 + 9000 })));
  setUsage(s, { turns: 4, tokensIn: 9800, tokensOut: 2100, contextTokens: 41_000, contextWindow: 200_000, costUsd: 0.071 });
  return s;
}
/** the read landed, then the edit was refused at the permission gate (no tool row exists for it) */
function denied(): SextantState {
  const s = reading();
  ev(s, { type: "tool_execution_end", callId: "c1", ok: true, output: READ_OUT, durationMs: 12 }, NOW - 900);
  ev(s, { type: "turn_start", turn: 2 }, NOW - 800);
  ev(s, { type: "tool_call_failed", callId: "c2", reason: "permission_denied", detail: "user denied" }, NOW - 500);
  setPlan(s, { items: TODOS_MID });
  return s;
}
const SCENARIOS: Record<string, () => SextantState> = { welcome, reading, editing, done, denied };
const SIZES: [number, number][] = [[160, 44], [100, 30]];

function golden(name: string, text: string): void {
  const file = join(FIXTURES, `${name}.txt`);
  if (UPDATE || !existsSync(file)) { mkdirSync(FIXTURES, { recursive: true }); writeFileSync(file, text + "\n"); }
  expect(text + "\n").toBe(readFileSync(file, "utf8"));
}

// ---------- goldens ----------

for (const [name, build] of Object.entries(SCENARIOS)) {
  for (const [cols, rows] of SIZES) {
    test(`golden ${name} ${cols}x${rows}`, () => {
      const a = dumpFrame(build(), cols, rows, NOW, theme);
      const b = dumpFrame(build(), cols, rows, NOW, theme);
      expect(a).toBe(b); // deterministic at a fixed clock
      expect(a.split("\n")).toHaveLength(rows);
      for (const line of a.split("\n")) { expect([...line].length).toBeLessThanOrEqual(cols); expect(line).not.toMatch(/\s$/); }
      golden(`${name}-${cols}x${rows}`, a);
    });
  }
}

test("the crew card names the CLI that opened, and a queued lane never looks like a running one", () => {
  const s = editing();
  setCrew(s, [
    { id: "l1", label: "scan the tree", agent: "codex", goal: "scan", isolated: true, depth: 1, status: "running", createdAt: T0 + 1000, startedAt: T0 + 1100, kind: "external", lane: "codex", batch: "r1", batchLabel: "test-project-scan", progress: { toolCalls: 12, filesWritten: ["src/a.ts"], filesWrittenTotal: 1, usage: { input: 3000, output: 1200 } } },
    { id: "l2", label: "second opinion", agent: "claude", goal: "review", isolated: true, depth: 1, status: "running", createdAt: T0 + 1000, startedAt: T0 + 1200, kind: "external", lane: "claude", batch: "r1", batchLabel: "test-project-scan" },
    { id: "l3", label: "third pass", agent: "codex", goal: "again", isolated: true, depth: 1, status: "queued", createdAt: T0 + 1000, kind: "external", lane: "codex", batch: "r1", batchLabel: "test-project-scan" },
  ] as TaskInfo[]);
  const f = dumpFrame(s, 160, 44, NOW, theme);
  expect(f).toMatch(/test-project-scan +›/); // ONE card for the three tasks of one run
  expect(f).toContain("3 agents · 59s"); // the queued task has no startedAt: the card ages from its createdAt
  expect(f).toContain("▪▪▫  codex claude codex"); // two running, one queued — and each CLI named
  expect(f).not.toContain("scan the tree");       // the card is the workflow, not its tasks
  // the progress row: a RUNNING lane's confirmed write is "so far", never "wrote" — its patch has not reached the tree
  // the panel's body is 30 cells: the row's segments drop from the RIGHT, so the token count is what goes
  const progressLine = f.split("\n").find((l) => l.includes("1 file so far"))!;
  expect(progressLine).toContain("1 file so far · 12 calls");
  expect(progressLine).not.toContain("4.2k"); // (the usage panel's own 4.2k is elsewhere in the frame)
  expect(f).not.toContain("wrote 1 file");
});

test("goldens pin the panel content: header, activity + clock, files statuses, plan steps, crew, usage", () => {
  const f = dumpFrame(editing(), 160, 44, NOW, theme);
  expect(f).toContain("◆ rovecode  ·  atlas  ·  feature/auth  ·  4 modified");
  expect(f).toContain("editing callback.ts  00:14.0");
  expect(f).toMatch(/callback\.ts [◇◈◆] +M/); // touched spinner + M status
  expect(f).toMatch(/guard\.ts +A/);
  expect(f).toMatch(/legacy\.ts +D/);
  expect(f).toContain("▸ api/");
  expect(f).toContain("▾ auth/");
  expect(f).toContain("─ plan ─");
  expect(f).toContain("steps  1/4");
  expect(f).toContain("◆  read the auth flow");
  expect(f).toContain("◈  add the state check    high");
  expect(f).toContain("◇  run the auth tests");
  expect(f).toContain("◇  update the notes        low");
  expect(f).toContain("crew  1 working");
  // the crew section is CARDS (sextant/crew-cards.ts): one per workflow, newest first, each `title ›`,
  // `N agents · age`, then a chip per agent. A run's tasks would share one card; these two have no batch.
  expect(f).toMatch(/review +›/);
  expect(f).toContain("1 agent · 07s");
  expect(f).toMatch(/write tests +›/);
  expect(f).toContain("1 agent · 58s");
  expect(f).toMatch(/▪ +worker/);   // running: a filled chip
  expect(f).toMatch(/◆ +reviewer/); // done: and the name is the AGENT's, never a CLI's
  expect(f).toContain("next");
  expect(f).toContain("◈ add the state check");
  expect(f).toContain("tokens    5.5k  4.2k/1.3k");
  expect(f).toMatch(/context   ━+─+ +24k\/200k 12%/); // the counts carry this row; a percent alone goes blind on a 1M window
  expect(f).toContain("cost      $0.030  claude-sonn…");
  expect(f).toContain("esc stop   ⌃k commands");
  expect(f).toContain("claude-sonnet-4 · night · v0.2.0");
  expect(f).toContain("─ code ─");
  expect(f).toContain("─ messages ─");
  expect(f).toContain("─ rovecode ─");
});

test("welcome at 100x30: no files/plan/usage columns, idle header, no clock, toast top-right, hints drop whole keys", () => {
  const f = dumpFrame(welcome(), 100, 30, NOW, theme);
  expect(f).not.toContain("─ files ─");
  expect(f).not.toContain("─ plan ─");
  expect(f).not.toContain("─ usage ─");
  expect(f).toContain("◆ idle ─");
  expect(f).not.toMatch(/\d\d:\d\d\.\d/);
  expect(f.split("\n")[2]).toContain("◆ theme · night");
  expect(f).toContain("⏎ send   tab focus   ⌃k commands   ⌃d diff   ⌃c quit ─");
  expect(dumpFrame(welcome(), 100, 30, NOW + 5000, theme)).not.toContain("theme · night"); // expired
  expect(dumpFrame(welcome(), 160, 44, NOW, theme)).toContain("⏎ send   tab focus   ⌃k commands   ⌃d diff   ⌃t theme   ⌃c quit");
});

test("running frame footer: esc stop, then 'again to stop' while armed; plan mode + yolo markers", () => {
  const s = reading();
  expect(dumpFrame(s, 160, 44, NOW, theme)).toContain("esc stop   ⌃k commands");
  s.escUntil = NOW + 1500;
  expect(dumpFrame(s, 160, 44, NOW, theme)).toContain("esc again to stop   ⌃k commands");
  s.mode = "plan"; s.yolo = true;
  expect(dumpFrame(s, 160, 44, NOW, theme)).toContain("plan mode  ·  auto  ·  claude-sonnet-4 · night · v0.2.0"); // the yolo flag shows as "auto" (core/voice.ts)
});

test("done frame: SUCCESS header with the clock frozen at endedAt; denied frame: ERROR 'denied' + system row", () => {
  const d = done();
  expect(d.activity.state).toBe("SUCCESS");
  const f = dumpFrame(d, 160, 44, NOW, theme);
  expect(f).toContain("◆ done  00:12.0");
  expect(f).not.toMatch(/callback\.ts [◇◈◆]/); // touched spinner pruned at run_end
  expect(dumpFrame(d, 160, 44, NOW + 60_000, theme)).toContain("◆ done  00:12.0"); // frozen
  const n = denied();
  expect(n.activity).toMatchObject({ state: "ERROR", label: "denied" });
  expect(n.messages.at(-1)).toEqual({ kind: "system", tone: "error", text: "permission denied: user denied" });
  expect(dumpFrame(n, 160, 44, NOW, theme)).toContain("◆ denied  00:14.0");
});

test("no-git repo: header shows the cwd basename only (no branch, no modified count)", () => {
  const s = welcome();
  s.repo.branch = null;
  const f = dumpFrame(s, 160, 44, NOW, theme);
  expect(f).toContain("◆ rovecode  ·  atlas ─");
  expect(f).not.toContain("modified");
  expect(f).not.toContain("null");
});

// ---------- deps seam ----------

test("painters seam: an injected painter replaces the placeholder; missing painters paint titled boxes", () => {
  const seen: string[] = [];
  const deps: FrameDeps = { painters: { code: (scr, rect) => { seen.push(`code ${rect.w}x${rect.h}`); scr.put(rect.x + 2, rect.y + 1, "CODE HERE"); }, pet: undefined } };
  const f = dumpFrame(welcome(), 160, 44, NOW, theme, deps);
  expect(seen).toEqual(["code 89x28"]);
  expect(f).toContain("CODE HERE");
  expect(f).not.toContain("─ code ─");
  expect(f).toContain("─ messages ─");
  expect(f).toContain("─ rovecode ─");
  expect(Object.keys(defaultPainters).sort()).toEqual(["code", "files", "frame", "messages", "pet", "plan", "usage"]);
});

test("layout seam: an injected layout() is used instead of layoutFallback", () => {
  let calls = 0;
  const deps: FrameDeps = { layout: (w, h, o) => { calls++; return { ...layoutFallback(w, h, o), files: null, pet: null }; }, layoutOpts: { pet: false } };
  const f = dumpFrame(welcome(), 160, 44, NOW, theme, deps);
  expect(calls).toBe(1);
  expect(f).not.toContain("─ files ─");
  expect(f).not.toContain("─ rovecode ─");
});

test("layoutFallback breakpoints: files ≥ 140 (30 wide ≥ 150), right column ≥ 110 (34 / 28), pet needs 36 content rows", () => {
  const L = layoutFallback(160, 44, { pet: true });
  expect(L.frame).toEqual({ x: 0, y: 0, w: 159, h: 44 });
  expect(L.files).toEqual({ x: 2, y: 1, w: 30, h: 28 });
  expect(L.pet).toEqual({ x: 2, y: 29, w: 30, h: 14 });
  expect(L.plan).toEqual({ x: 123, y: 1, w: 34, h: 37 });
  expect(L.usage).toEqual({ x: 123, y: 38, w: 34, h: 5 });
  expect(L.code).toEqual({ x: 33, y: 1, w: 89, h: 28 });
  expect(L.messages).toEqual({ x: 33, y: 29, w: 89, h: 14 });
  expect(layoutFallback(139, 44, { pet: true }).files).toBeNull();
  expect(layoutFallback(140, 44, { pet: true }).files?.w).toBe(26);
  expect(layoutFallback(109, 44, { pet: true }).plan).toBeNull();
  expect(layoutFallback(110, 44, { pet: true }).plan?.w).toBe(28);
  expect(layoutFallback(160, 37, { pet: true }).pet).toBeNull(); // contentH 36 needed: 37 rows → 35
  expect(layoutFallback(160, 38, { pet: true }).pet).not.toBeNull();
  expect(layoutFallback(160, 33, { pet: true }).pet).toBeNull(); // the #40 bar's case
  expect(layoutFallback(160, 44, { pet: false }).pet).toBeNull();
  const noFiles = layoutFallback(120, 44, { pet: true }); // pet carved out of plan
  expect(noFiles.pet).toEqual({ x: 89, y: 24, w: 28, h: 14 });
  expect(noFiles.plan?.h).toBe(23);
  expect(noFiles.usage?.y).toBe(38);
});

test("boot reveal: panels appear in 90 ms steps after bootAt", () => {
  const s = welcome();
  const at = (ms: number) => dumpFrame(s, 160, 44, T0 + ms, theme);
  expect(at(0)).toContain("─ files ─");
  expect(at(0)).not.toContain("─ code ─");
  expect(at(90)).toContain("─ code ─");
  expect(at(90)).not.toContain("─ messages ─");
  expect(at(180)).toContain("─ messages ─");
  expect(at(269)).not.toContain("─ plan ─");
  expect(at(270)).toContain("─ plan ─");
  expect(at(360)).toContain("─ usage ─");
  expect(at(449)).not.toContain("─ rovecode ─");
  expect(at(450)).toContain("─ rovecode ─");
});

test("renderFrame paints onto any ScreenLike and returns the layout; expired toasts are pruned from state", () => {
  const s = welcome();
  const scr = new GridScreen(100, 30);
  const L = renderFrame(scr, s, theme, NOW + 10_000);
  expect(L.w).toBe(100);
  expect(scr.toText()).toContain("◆ rovecode");
  expect(s.toasts).toEqual([]);
});

test("GridScreen: clipping, ellipsis, bg inheritance, box corners, toText trims trailing space", () => {
  const g = new GridScreen(10, 3);
  expect(g.put(-2, 0, "abcdef")).toBe(4);
  expect(g.put(8, 0, "xyz")).toBe(10);
  expect(g.put(0, 5, "off")).toBe(0);
  g.box(0, 0, 10, 3, undefined, 0x111111);
  g.clip(1, 1, "0123456789ABC", undefined, 6);
  g.put(1, 1, "hi", { fg: 1, bg: -1, a: 0 });
  expect(g.bg[1 * 10 + 1]).toBe(0x111111); // bg -1 inherits the fill
  expect(g.toText()).toBe("╭────────╮\n│hi234…  │\n╰────────╯");
  expect(g.text(0, 2, [["ab", undefined], ["cd", undefined]], 3)).toBe(3);
});

test("negative: dumpFrame creates no timers or intervals", () => {
  const origT = globalThis.setTimeout, origI = globalThis.setInterval;
  let timers = 0;
  globalThis.setTimeout = ((...a: Parameters<typeof setTimeout>) => { timers++; return origT(...a); }) as typeof setTimeout;
  globalThis.setInterval = ((...a: Parameters<typeof setInterval>) => { timers++; return origI(...a); }) as typeof setInterval;
  try {
    for (const build of Object.values(SCENARIOS)) for (const [c, r] of SIZES) dumpFrame(build(), c, r, NOW, theme);
  } finally {
    globalThis.setTimeout = origT; globalThis.setInterval = origI;
  }
  expect(timers).toBe(0);
});
