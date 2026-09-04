/** Render real sextant frames headlessly and emit HTML (and an SVG fallback) with per-cell colours
 *  from the night theme. The scenarios derive from the golden-test builders in
 *  test/unit/sextant-frame.test.ts, but paint through the REAL code/messages/pet painters (the ones
 *  sextant-frame-loop.ts wires) instead of the placeholder boxes.
 *
 *    bun run scripts/render-frames.ts            → scripts/out/<name>.html  (screenshot these at 2×)
 *    bun run scripts/render-frames.ts --svg      → also public/shots/<name>.svg (no browser needed)
 *
 *  Everything outside site/ is imported read-only. */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderFrame } from "../../src/sextant/frame.ts";
import { GridScreen } from "../../src/sextant/grid.ts";
import { layout } from "../../src/sextant/layout.ts";
import { drawCode, setAgentsPainter } from "../../src/sextant/draw-code.ts";
import { drawAgents } from "../../src/sextant/draw-agents.ts";
import { drawMessages } from "../../src/sextant/draw-messages.ts";
import { drawPet } from "../../src/sextant/draw-pet.ts";
import { drawPalette, openPalette } from "../../src/sextant/overlays.ts";
import { tokenize } from "../../src/sextant/engine.ts";
import { createPet, type Pet } from "../../src/sextant/pet.ts";
import { buildTheme, hex } from "../../src/sextant/theme.ts";
import { initialState, makeApplyEvent, pushToast, setCrew, setFiles, setPlan, setUsage } from "../../src/sextant/model.ts";
import { ATTR, type DiffHunk, type FileStatus, type SextantState, type Theme } from "../../src/sextant/types.ts";
import type { RunEvent } from "../../src/core/types.ts";
import type { TaskInfo } from "../../src/core/tasks.ts";

const OUT_HTML = join(import.meta.dir, "out");
const OUT_SVG = join(import.meta.dir, "..", "public", "shots");
const WANT_SVG = process.argv.includes("--svg");

const theme: Theme = buildTheme("night");
const T0 = 1_700_000_000_000;
const NOW = T0 + 60_000;

// ---------- fixture data (a plausible repo; mirrors the golden test) ----------

const PATHS = ["README.md", "package.json", "src/app.ts", "src/auth/callback.ts", "src/auth/session.ts", "src/auth/guard.ts", "src/api/routes.ts", "src/api/middleware.ts", "tests/auth.test.ts"];
const STATUSES = new Map<string, FileStatus>([["src/auth/callback.ts", "M"], ["src/auth/session.ts", "M"], ["src/auth/guard.ts", "A"], ["src/legacy.ts", "D"]]);

const Q = '"';
const CALLBACK_BEFORE = [
  `import type { Request, Response } from ${Q}express${Q};`,
  `import { exchangeCode } from ${Q}./session${Q};`,
  `import { verifyState } from ${Q}./guard${Q};`,
  ``,
  `/** OAuth callback: swap the code for a session cookie. */`,
  `export async function callback(req: Request, res: Response) {`,
  `  const { code, state } = req.query;`,
  `  const session = await exchangeCode(String(code));`,
  `  res.cookie(${Q}sid${Q}, session.id, { httpOnly: true, sameSite: ${Q}lax${Q} });`,
  `  return res.redirect(302, ${Q}/${Q});`,
  `}`,
  ``,
  `export function logout(_req: Request, res: Response) {`,
  `  res.clearCookie(${Q}sid${Q});`,
  `  return res.redirect(302, ${Q}/login${Q});`,
  `}`,
].join("\n") + "\n";
const CALLBACK_AFTER = [
  `import type { Request, Response } from ${Q}express${Q};`,
  `import { exchangeCode } from ${Q}./session${Q};`,
  `import { verifyState } from ${Q}./guard${Q};`,
  ``,
  `/** OAuth callback: swap the code for a session cookie. */`,
  `export async function callback(req: Request, res: Response) {`,
  `  const { code, state } = req.query;`,
  `  if (typeof code !== ${Q}string${Q} || !verifyState(state)) {`,
  `    return res.status(400).json({ error: ${Q}missing or invalid state${Q} });`,
  `  }`,
  `  const session = await exchangeCode(code);`,
  `  res.cookie(${Q}sid${Q}, session.id, { httpOnly: true, sameSite: ${Q}lax${Q} });`,
  `  return res.redirect(302, ${Q}/${Q});`,
  `}`,
  ``,
  `export function logout(_req: Request, res: Response) {`,
  `  res.clearCookie(${Q}sid${Q});`,
  `  return res.redirect(302, ${Q}/login${Q});`,
  `}`,
].join("\n") + "\n";
const READ_OUT = "src/auth/callback.ts#a1b2\n" + CALLBACK_BEFORE.split("\n").slice(0, 16).map((l, i) => `${i + 1}#c3d4|${l}`).join("\n") + "\n(showing lines 1-16 of 16)";
const EDIT_ARGS = { path: "src/auth/callback.ts", edits: [
  { tag: "a1b2", anchorLine: 7, anchorHash: "e5f6", newLines: [`  const { code, state } = req.query;`, `  if (typeof code !== ${Q}string${Q} || !verifyState(state)) {`, `    return res.status(400).json({ error: ${Q}missing or invalid state${Q} });`, `  }`] },
  { tag: "a1b2", anchorLine: 8, anchorHash: "0a1b", newLines: [`  const session = await exchangeCode(code);`] },
] };
const HUNK: DiffHunk = {
  oldStart: 6, newStart: 6,
  rows: [
    { op: " ", text: `export async function callback(req: Request, res: Response) {` },
    { op: " ", text: `  const { code, state } = req.query;` },
    { op: "+", text: `  if (typeof code !== ${Q}string${Q} || !verifyState(state)) {` },
    { op: "+", text: `    return res.status(400).json({ error: ${Q}missing or invalid state${Q} });` },
    { op: "+", text: `  }` },
    { op: "-", text: `  const session = await exchangeCode(String(code));` },
    { op: "+", text: `  const session = await exchangeCode(code);` },
    { op: " ", text: `  res.cookie(${Q}sid${Q}, session.id, { httpOnly: true, sameSite: ${Q}lax${Q} });` },
    { op: " ", text: `  return res.redirect(302, ${Q}/${Q});` },
  ],
};
const TEST_OUT = [
  "exit=0", "bun test v1.3.14", "", "tests/auth.test.ts:",
  "✓ callback > rejects a missing code [3.10ms]",
  "✓ callback > rejects a forged state [1.42ms]",
  "✓ callback > sets the session cookie [2.08ms]",
  "✓ logout > clears the cookie [0.61ms]",
  "", " 18 pass", " 0 fail", " 41 expect() calls", "Ran 18 tests across 1 files. [212.00ms]",
].join("\n");
const TODOS = [
  { id: "t1", content: "read the auth flow", status: "completed" as const },
  { id: "t2", content: "add the state check", status: "in_progress" as const, priority: "high" as const },
  { id: "t3", content: "run the auth tests", status: "pending" as const },
  { id: "t4", content: "update the notes", status: "pending" as const, priority: "low" as const },
];
const CREW: TaskInfo[] = [
  { id: "task-1", label: "write tests", agent: "worker", goal: "write tests for guard.ts", isolated: true, depth: 1, status: "running", createdAt: T0 + 1000, startedAt: T0 + 1100 },
  { id: "task-2", label: "review", agent: "reviewer", goal: "review the callback", isolated: false, depth: 1, status: "done", createdAt: T0 + 1000, startedAt: T0 + 1100, finishedAt: T0 + 9000, summary: "looks good" },
];

const applyEvent = makeApplyEvent({ diffFor: () => ({ hunks: [HUNK], add: 4, del: 1 }) });
const ev = (s: SextantState, e: RunEvent, at: number) => applyEvent(s, e, at);

function base(): { s: SextantState; pet: Pet } {
  const s = initialState({
    cwd: "C:/projects/atlas", repo: { name: "atlas", branch: "feature/auth" }, version: "0.2.0", theme: "night", mode: "act", yolo: false,
    commands: [{ name: "help", description: "commands" }], now: T0, model: { provider: "anthropic", model: "claude-sonnet-4" },
  });
  setFiles(s, PATHS, STATUSES);
  s.files.expanded.add("src"); s.files.expanded.add("src/auth");
  const pet = createPet({ name: "rovecode", seed: 7 });
  pet.event("start", undefined, T0 + 2000);
  return { s, pet };
}
const startRun = (s: SextantState) => {
  s.messages.push({ kind: "user", text: "add a state check to the oauth callback and run the auth tests", at: NOW - 14_100 });
  ev(s, { type: "run_start", runId: "run-1", sessionId: "sess", goal: "implement authentication" }, NOW - 14_000);
  ev(s, { type: "turn_start", turn: 1 }, NOW - 13_900);
  ev(s, { type: "message_update", messageId: "m1", delta: "Let me look at the auth flow first." }, NOW - 13_000);
  ev(s, { type: "tool_execution_start", callId: "c1", tool: "read", args: { path: "src/auth/callback.ts" } }, NOW - 12_900);
};

interface Scenario { s: SextantState; pet: Pet; cols: number; rows: number; now: number }
type Builder = () => Scenario;

/** the hero: read landed, an anchored edit running — highlight band on the anchor lines, crew live */
const editing: Builder = () => {
  const { s, pet } = base();
  startRun(s);
  ev(s, { type: "tool_execution_end", callId: "c1", ok: true, output: READ_OUT, durationMs: 12 }, NOW - 12_800);
  ev(s, { type: "turn_start", turn: 2 }, NOW - 800);
  ev(s, { type: "tool_execution_start", callId: "c2", tool: "edit", args: EDIT_ARGS }, NOW - 300);
  s.code.content = CALLBACK_BEFORE;
  setPlan(s, { items: TODOS });
  setCrew(s, CREW);
  setUsage(s, { turns: 2, tokensIn: 4200, tokensOut: 1300, contextTokens: 24_000, contextWindow: 200_000, costUsd: 0.03 });
  pet.event("edit", { f: "callback.ts" }, NOW - 300);
  return { s, pet, cols: 160, rows: 44, now: NOW };
};

/** the edit landed: code panel in ± mode with the ONE hunk that changed */
const diff: Builder = () => {
  const sc = editing();
  const { s } = sc;
  ev(s, { type: "tool_execution_end", callId: "c2", ok: true, output: "applied 2 edit(s); new TAG b7c8", durationMs: 42 }, NOW - 200);
  s.code.content = CALLBACK_AFTER;
  s.code.hl = [8, 11];
  setUsage(s, { turns: 2, tokensIn: 5100, tokensOut: 1600, contextTokens: 26_000, contextWindow: 200_000, costUsd: 0.034 });
  return sc;
};

/** the approval card: the model wants to run the tests, the human decides */
const approval: Builder = () => {
  const sc = diff();
  const { s, pet } = sc;
  ev(s, { type: "turn_start", turn: 3 }, NOW - 150);
  s.code.mode = "code";
  s.card = { kind: "approval", tool: "bash", argsPreview: "bun test tests/auth.test.ts", verdicts: ["once", "always", "deny"], selected: 0, resolve: () => {} };
  s.activity = { ...s.activity, state: "WAITING", label: "waiting for you" };
  pet.event("permission", undefined, NOW - 100);
  return sc;
};

/** the run finished: $ mode with the PASS chip, plan complete, pet sunny */
const tests: Builder = () => {
  const sc = diff();
  const { s, pet } = sc;
  ev(s, { type: "turn_start", turn: 3 }, NOW - 7900);
  ev(s, { type: "tool_execution_start", callId: "c3", tool: "bash", args: { command: "bun test tests/auth.test.ts" } }, NOW - 7800);
  ev(s, { type: "tool_execution_end", callId: "c3", ok: true, output: TEST_OUT, durationMs: 2100 }, NOW - 5000);
  ev(s, { type: "turn_start", turn: 4 }, NOW - 4900);
  ev(s, { type: "message_update", messageId: "m4", delta: "All green. The callback now rejects a request without a code or with a forged state before it touches the session store." }, NOW - 4000);
  ev(s, { type: "turn_end", turn: 4, stopReason: "end_turn" as never }, NOW - 3000);
  ev(s, { type: "run_end", status: "done", summary: "authentication hardened" }, NOW - 2000);
  s.code.mode = "run";
  setPlan(s, { items: TODOS.map((t) => ({ ...t, status: "completed" as const })) });
  setCrew(s, CREW.map((t) => ({ ...t, status: "done" as const, finishedAt: T0 + 9000 })));
  setUsage(s, { turns: 4, tokensIn: 9800, tokensOut: 2100, contextTokens: 41_000, contextWindow: 200_000, costUsd: 0.071 });
  pet.event("pass", undefined, NOW - 4900);
  pet.event("done", undefined, NOW - 2000);
  return sc;
};

/** the crew board: ∷ mode over the background tasks */
const agents: Builder = () => {
  const sc = editing();
  sc.s.code.mode = "agents";
  sc.s.code.lane = 0;
  return sc;
};

/** the gate said no: ERROR state, system row, the pet's storm */
const denied: Builder = () => {
  const { s, pet } = base();
  startRun(s);
  ev(s, { type: "tool_execution_end", callId: "c1", ok: true, output: READ_OUT, durationMs: 12 }, NOW - 900);
  ev(s, { type: "turn_start", turn: 2 }, NOW - 800);
  ev(s, { type: "tool_execution_start", callId: "c2", tool: "bash", args: { command: "rm -rf node_modules && git checkout -- ." } }, NOW - 700);
  ev(s, { type: "tool_call_failed", callId: "c2", reason: "permission_denied", detail: "user denied" }, NOW - 500);
  s.code.mode = "code";
  s.code.content = CALLBACK_BEFORE;
  setPlan(s, { items: TODOS });
  setUsage(s, { turns: 2, tokensIn: 3900, tokensOut: 400, contextTokens: 9_000, contextWindow: 200_000, costUsd: 0.012 });
  pet.event("denied", undefined, NOW - 500);
  return { s, pet, cols: 160, rows: 44, now: NOW };
};

/** the compact layout a 100×30 terminal gets */
const compact: Builder = () => {
  const sc = diff();
  pushToast(sc.s, "theme · night", NOW - 1000);
  return { ...sc, cols: 100, rows: 30 };
};

/** the gate: a destructive shell command waits on the card, deny pre-selected */
const rmrf: Builder = () => {
  const sc = diff();
  const { s, pet } = sc;
  ev(s, { type: "turn_start", turn: 3 }, NOW - 150);
  s.code.mode = "code";
  s.card = { kind: "approval", tool: "bash", argsPreview: "rm -rf node_modules && git checkout -- .", verdicts: ["once", "always", "deny"], selected: 2, resolve: () => {} };
  s.activity = { ...s.activity, state: "WAITING", label: "waiting for you" };
  pet.event("permission", undefined, NOW - 100);
  return sc;
};

/** /rewind: the turn picker the renderer opens through pickOne (a palette titled like session-cmd.ts does) */
const rewind: Builder = () => {
  const sc = tests();
  const { s } = sc;
  s.running = false;
  const title = "rewind to a turn (Enter = edit & resubmit, Esc = cancel)";
  openPalette(s, [
    { label: "#38 read src/auth/session.ts and explain the cookie flow", group: title, action: "pick:t38" },
    { label: "#39 add a state check to the oauth callback and run the auth tests", group: title, action: "pick:t39" },
    { label: "#40 also delete the legacy session store while you are there", group: title, action: "pick:t40" },
    { label: "#41 undo that, keep legacy.ts until the migration lands", group: title, action: "pick:t41" },
  ]);
  s.palette!.sel = 2;
  return sc;
};

const SCENARIOS: Record<string, Builder> = { editing, diff, approval, tests, agents, denied, compact, rmrf, rewind };

// ---------- paint ----------

function paint(sc: Scenario): GridScreen {
  setAgentsPainter(drawAgents);
  const scr = new GridScreen(sc.cols, sc.rows, theme.bg);
  const L = renderFrame(scr, sc.s, theme, sc.now, {
    layout,
    layoutOpts: { pet: true },
    painters: {
      code: (g, r, st, th, t) => drawCode(g, r, st, th, t, { tokenize }),
      messages: drawMessages,
      pet: (g, r, st, th, t) => drawPet(g, r, sc.pet, st, th, t),
    },
  });
  if (sc.s.palette) drawPalette(scr, L, theme, sc.s);
  return scr;
}

// ---------- emit ----------

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const isAscii = (c: string) => c.length === 1 && c.charCodeAt(0) < 0x7f;

function cellStyle(scr: GridScreen, i: number): string {
  const a = scr.at[i]!;
  let fg = scr.fg[i]! >= 0 ? scr.fg[i]! : theme.fg;
  let bg = scr.bg[i]! >= 0 ? scr.bg[i]! : theme.bg;
  if (a & ATTR.INVERSE) [fg, bg] = [bg, fg];
  let css = `color:${hex(fg)};background:${hex(bg)}`;
  if (a & ATTR.BOLD) css += ";font-weight:600";
  if (a & ATTR.DIM) css += ";opacity:.6";
  if (a & ATTR.ITALIC) css += ";font-style:italic";
  if (a & ATTR.UNDERLINE) css += ";text-decoration:underline";
  if (a & ATTR.STRIKE) css += ";text-decoration:line-through";
  return css;
}

function toHtml(scr: GridScreen, name: string): string {
  const rows: string[] = [];
  for (let y = 0; y < scr.h; y++) {
    let row = "", run = "", runStyle = "";
    const flush = () => { if (run) row += `<span style="${runStyle}">${run}</span>`; run = ""; };
    for (let x = 0; x < scr.w; x++) {
      const i = y * scr.w + x;
      const css = cellStyle(scr, i);
      const ch = scr.ch[i]!;
      const cell = isAscii(ch) ? esc(ch) : `<i>${esc(ch)}</i>`;
      if (css !== runStyle) { flush(); runStyle = css; }
      run += cell;
    }
    flush();
    rows.push(`<div class="r">${row}</div>`);
  }
  const font = `"Geist Mono","Cascadia Mono","Consolas","Segoe UI Symbol",monospace`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${name}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Geist+Mono:wght@400;600&display=block" rel="stylesheet">
<style>
html,body{margin:0;background:${hex(theme.bg)}}
#frame{display:inline-block;padding:0;font-family:${font};font-size:26px;line-height:34px;font-variant-ligatures:none;white-space:pre;letter-spacing:0}
.r{height:34px;white-space:pre}
span{display:inline-block;height:34px;vertical-align:top}
i{display:inline-block;width:1ch;text-align:center;font-style:inherit;overflow:visible}
</style></head><body><div id="frame">${rows.join("")}</div></body></html>`;
}

function toSvg(scr: GridScreen): string {
  const cw = 15.6, ch = 34;
  const W = scr.w * cw, H = scr.h * ch;
  const rects: string[] = [], texts: string[] = [];
  for (let y = 0; y < scr.h; y++) {
    let x = 0;
    while (x < scr.w) {
      const i = y * scr.w + x;
      const bgOf = (j: number) => (scr.bg[j]! >= 0 ? scr.bg[j]! : theme.bg);
      const bg = bgOf(i);
      let x2 = x + 1;
      while (x2 < scr.w && bgOf(y * scr.w + x2) === bg) x2++;
      if (bg !== theme.bg) rects.push(`<rect x="${(x * cw).toFixed(1)}" y="${y * ch}" width="${((x2 - x) * cw).toFixed(1)}" height="${ch}" fill="${hex(bg)}"/>`);
      x = x2;
    }
    for (let xx = 0; xx < scr.w; xx++) {
      const i = y * scr.w + xx;
      const c = scr.ch[i]!;
      if (c === " ") continue;
      const fg = scr.fg[i]! >= 0 ? scr.fg[i]! : theme.fg;
      const bold = scr.at[i]! & ATTR.BOLD ? ' font-weight="600"' : "";
      texts.push(`<text x="${(xx * cw + cw / 2).toFixed(1)}" y="${y * ch + 24}" fill="${hex(fg)}"${bold}>${esc(c)}</text>`);
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Geist Mono, Cascadia Mono, Consolas, monospace" font-size="26" text-anchor="middle"><rect width="100%" height="100%" fill="${hex(theme.bg)}"/>${rects.join("")}${texts.join("")}</svg>`;
}

mkdirSync(OUT_HTML, { recursive: true });
if (WANT_SVG) mkdirSync(OUT_SVG, { recursive: true });
for (const [name, build] of Object.entries(SCENARIOS)) {
  const sc = build();
  const scr = paint(sc);
  const file = `${name}-${sc.cols}x${sc.rows}`;
  writeFileSync(join(OUT_HTML, `${file}.html`), toHtml(scr, file));
  writeFileSync(join(OUT_HTML, `${file}.txt`), scr.toText() + "\n");
  if (WANT_SVG) writeFileSync(join(OUT_SVG, `${file}.svg`), toSvg(scr));
  console.log(`${file}  ${scr.w}x${scr.h}`);
}
