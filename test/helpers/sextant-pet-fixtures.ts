/** Port #45 test fixtures: a fixed clock, the night Theme (app.js THEMES + buildTheme mixes), and
 *  SextantState / ActivityInfo / TaskInfo / card builders for driving moodCtxFrom and drawPet. */
import type { ActivityInfo, ActivityState, CardState, SextantState, Theme } from "../../src/sextant/types.ts";
import type { TaskInfo, TaskStatus } from "../../src/core/tasks.ts";
import { mix } from "../../src/sextant/draw-pet.ts";

/** = 400 × 2600 (storm period) = 200 × 5200 (blink period): every clock offset below has a known phase */
export const T0 = 1_040_000;

const rgb = (hex: string): number => parseInt(hex.slice(1), 16);
const NIGHT = {
  bg: "#0b0e12", bg2: "#11161c", fg: "#e6edf3", fg2: "#aab4bf", muted: "#7d8590", dim: "#4b545e",
  rule: "#2a323b", rule2: "#3a4550", accent: "#3ddbb9", accent2: "#9af2df", ok: "#3fb950", err: "#f0605d",
  warn: "#e3b341", info: "#79c0ff", str: "#9ee7d6", ty: "#b6c2ce",
};

export function themeFixture(): Theme {
  const c = Object.fromEntries(Object.entries(NIGHT).map(([k, v]) => [k, rgb(v)])) as Record<keyof typeof NIGHT, number>;
  return {
    name: "night", label: "Night", ...c,
    hlBg: mix(c.bg, c.accent, 0.12), addBg: mix(c.bg, c.ok, 0.15), delBg: mix(c.bg, c.err, 0.15), selBg: mix(c.bg, c.fg, 0.08),
    accentDim: mix(c.bg, c.accent, 0.45), okDim: mix(c.bg, c.ok, 0.55), mixDim: mix(c.bg, c.fg2, 0.55),
    frame: mix(c.bg, c.fg, 0.28), frameDim: mix(c.bg, c.fg, 0.17),
  };
}

export function activity(state: ActivityState, startedAt: number | null = null, endedAt: number | null = null): ActivityInfo {
  return { state, label: state.toLowerCase(), runId: startedAt == null ? null : "run-1", startedAt, endedAt };
}

export function task(status: TaskStatus, id = "t1"): TaskInfo {
  return { id, label: "lane", agent: "worker", goal: "do it", isolated: false, depth: 1, status, createdAt: T0 };
}

export const approvalCard = (): CardState => ({ kind: "approval", verdicts: ["once", "always", "deny"], tool: "edit", argsPreview: "src/a.ts", selected: 0, resolve: () => {} });
export const questionCard = (): CardState =>
  ({ kind: "question", prompt: { question: "which?", options: ["a", "b"] }, selected: 0, freeText: "", resolve: () => {} });

/** an idle, booted (60 s ago), not-running surface at cwd /repo; override any top-level field */
export function stateFixture(over: Partial<SextantState> = {}): SextantState {
  const base: SextantState = {
    cwd: "/repo",
    repo: { name: "repo", branch: "main", modified: 0 },
    files: { paths: [], statuses: new Map(), expanded: new Set(), touched: new Map(), cursor: 0, scroll: 0, version: 0 },
    activity: activity("IDLE"),
    code: { mode: "code", file: null, content: null, hl: null, scroll: 0, search: null, run: null, diff: null, lane: 0, laneOpen: false },
    messages: [], msgScroll: 0, stick: true, card: null, plan: { todos: [] }, crew: [],
    usage: { provider: "mock", model: "m", turns: 0, tokensIn: 0, tokensOut: 0, contextPct: null, costUsd: null },
    input: { text: "", cur: 0, history: [], histIdx: -1, sgSel: 0 },
    focus: "messages", page: "code", palette: null, market: null, context: null, wizard: null, help: false, toasts: [], notices: [], staged: [], escUntil: 0, running: false, mode: "act", yolo: false,
    theme: "night", bootAt: T0 - 60_000, commands: [], version: "0.0.0-test",
  };
  return { ...base, ...over };
}
