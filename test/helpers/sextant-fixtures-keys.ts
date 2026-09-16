/** Port #43 test fixtures: a blank SextantState, a Layout with the 140/110 breakpoints (files
 *  column only at ≥ 140 cols), a spy KeyCtx that records every hook/local call, key builders and
 *  a `type` helper that feeds a string through handleInput one character at a time. */

import { handleInput, type KeyCtx, type KeyEffect } from "../../src/sextant/keys.ts";
import type { InputEvent, KeyEvent, Layout, MouseEvent, SextantState, Theme } from "../../src/sextant/types.ts";

export const FILES = ["README.md", "src/auth/callback.ts", "src/core/session.ts", "src/core/loop.ts", "src/tui/app.ts", "test/unit/session.test.ts", "package.json"];

export function makeState(over: Partial<SextantState> = {}): SextantState {
  return {
    cwd: "/repo", repo: { name: "repo", branch: "main", modified: 1 },
    files: { paths: [...FILES], statuses: new Map([["src/core/session.ts", "M"]]), expanded: new Set(), touched: new Map(), cursor: 0, scroll: 0, version: 0 },
    activity: { state: "IDLE", label: "", runId: null, startedAt: null, endedAt: null },
    code: { mode: "code", file: null, content: null, hl: null, scroll: 0, search: null, run: null, diff: null, lane: 0, laneOpen: false },
    messages: [], msgScroll: 0, stick: true, card: null, plan: { todos: [] }, crew: [],
    usage: { provider: "p", model: "m", turns: 0, tokensIn: 0, tokensOut: 0, contextPct: null, costUsd: null },
    input: { text: "", cur: 0, history: [], histIdx: -1, sgSel: 0 },
    focus: "messages", page: "code", palette: null, market: null, context: null, wizard: null, help: false, toasts: [], notices: [], staged: [], escUntil: 0, running: false, mode: "act", yolo: false,
    theme: "night", bootAt: 0,
    commands: [{ name: "help", description: "Show commands" }, { name: "exit", description: "Quit rovecode" }, { name: "new", description: "Branch back to session start" }, { name: "hello", description: "custom greeting" }],
    version: "0.2.0", ...over,
  };
}

/** app.js layout() breakpoints: files at ≥140 (30 wide), right column at ≥110 (34), msgs 34% */
export function makeLayout(w: number, h: number): Layout {
  const files = w >= 140 ? { x: 1, y: 1, w: 30, h: h - 2 } : null;
  const left = files ? 31 : 1, right = w >= 110 ? 34 : 0, cw = w - left - right - 1, mh = Math.max(8, Math.round((h - 2) * 0.34));
  return {
    w, h, frame: { x: 0, y: 0, w, h }, files,
    code: { x: left, y: 1, w: cw, h: h - 2 - mh }, messages: { x: left, y: 1 + h - 2 - mh, w: cw, h: mh },
    plan: right ? { x: w - 1 - right, y: 1, w: right, h: h - 7 } : null, usage: right ? { x: w - 1 - right, y: h - 6, w: right, h: 5 } : null, pet: null,
  };
}

/** every hook / local call, recorded: `n` holds the counters (mutated in place by the hooks) */
export interface Spy { ctx: KeyCtx; submits: string[]; themes: string[]; modes: string[]; opened: string[]; toasts: string[]; images: string[]; market: string[]; context: string[]; n: { interrupts: number; exits: number } }

export function spyCtx(layout: Layout = makeLayout(160, 44)): Spy {
  const spy: Spy = { submits: [], themes: [], modes: [], opened: [], toasts: [], images: [], market: [], context: [], n: { interrupts: 0, exits: 0 }, ctx: null as unknown as KeyCtx };
  spy.ctx = {
    layout,
    hooks: { onSubmit: (t) => { spy.submits.push(t); }, onInterrupt: () => { spy.n.interrupts++; }, onExit: () => { spy.n.exits++; } },
    local: {
      setTheme: (n) => { spy.themes.push(n); }, setMode: (m) => { spy.modes.push(m); }, openFile: (p) => { spy.opened.push(p); }, toast: (t) => { spy.toasts.push(t); },
      attachImage: (abs) => { spy.images.push(abs); },
      openMarket: () => { spy.market.push("open"); },
      openContext: () => { spy.context.push("open"); },
      // `:local` only when the install-once chooser answered yes — every existing expectation stays as it was
      marketPlan: (row, local) => { spy.market.push(`plan:${row.kind}:${row.id}${local === true ? ":local" : ""}`); },
      marketInstall: (row, local) => { spy.market.push(`install:${row.kind}:${row.id}${local === true ? ":local" : ""}`); },
      marketDocs: (row) => { spy.market.push(`docs:${row.kind}:${row.id}`); },
      openWizard: () => {}, wizardLoadModels: () => {}, wizardRegister: () => {}, wizardStoreKey: () => {}, wizardModel: () => {}, wizardActivate: () => {},
    },
    hits: [], rows: [], drag: { zone: null, y0: 0 },
  };
  return spy;
}

export const key = (name: string, mods: Partial<KeyEvent> = {}): KeyEvent => ({ type: "key", name, ...(name.length === 1 ? { ch: name } : {}), ...mods });
export const ctrl = (name: string): KeyEvent => ({ type: "key", name, ctrl: true });
export const mouse = (b: number, x: number, y: number, press = true): MouseEvent => ({ type: "mouse", b, x, y, press });
export const paste = (text: string): InputEvent => ({ type: "paste", text });

export function press(s: SextantState, spy: Spy, ev: InputEvent, now = 1000): KeyEffect[] { return handleInput(s, ev, spy.ctx, now); }
export function type(s: SextantState, spy: Spy, text: string, now = 1000): void { for (const ch of text) handleInput(s, key(ch), spy.ctx, now); }

export const THEME: Theme = {
  name: "night", label: "night", bg: 0x0b0e12, bg2: 0x11161c, fg: 0xe6edf3, fg2: 0xaab4bf, muted: 0x7d8590, dim: 0x4b545e, rule: 0x2a323b, rule2: 0x3a4550,
  accent: 0x3ddbb9, accent2: 0x9af2df, ok: 0x3fb950, err: 0xf0605d, warn: 0xe3b341, info: 0x79c0ff, str: 0x9ee7d6, ty: 0xb6c2ce,
  hlBg: 0, addBg: 0, delBg: 0, selBg: 0, accentDim: 0, okDim: 0, mixDim: 0, frame: 0, frameDim: 0,
};
