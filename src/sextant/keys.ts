/** Sextant input (port #43): keys, mouse, focus, prompt editing and the card/overlay key routes.
 *  Ported from the user's own sextant v0.4.0 prototype — src/app.js:1438-1584 (submit, insertText,
 *  FOCUS_ORDER, onKey incl. the ctrl map, card keys, esc / esc-esc, tab focus, per-focus enter,
 *  files nav, code scroll/mode, message paging, history/suggestion ↑↓, line editing; onMouse with
 *  wheel 64/65 and the reverse hit order) and :1024-1029 (runSlash history push). Dropped: intent
 *  matching, the mock shell, /spawn /crew; /undo /permissions /mode become notes (ALIAS_NOTE).
 *  `handleInput` is a PURE state mutator: `now` is a parameter (esc-esc window), no Date.now(),
 *  timers or process access; everything that leaves the state goes through KeyCtx.hooks (aion's
 *  RendererHooks) or KeyCtx.local (renderer-owned effects: theme rebuild, file/diff loading,
 *  toasts). keys.ts writes the state fields it can (s.code.mode/file/scroll, s.theme) BEFORE the
 *  matching local hook fires, so the renderer only loads content / rebuilds the palette.
 *  Deviations: ⇧Tab also completes when the suggestion box is open (README table); Esc closes a
 *  visible box first (sgSel = -1 until the text changes) before arming the interrupt or clearing
 *  the line; ↑↓ keep browsing history once started even when the recalled line opens the box; End
 *  re-sticks the messages tail; a left-button drag (b & 32) never clicks; a click on a panel body
 *  with no hit zone focuses that panel. */

import {
  THEME_ORDER, type CodeMode, type Focus, type InputEvent, type KeyEvent, type Layout, type MouseEvent,
  type Rect, type SextantState, type ThemeName, type TreeRow,
} from "./types.ts";
import { type Fuzzy, type Suggestion, onPaletteKey, openPalette, parseInput, resolveFile, suggestions } from "./overlays.ts";

// ------------------------------------------------------------------ contract

/** a click zone a drawer registered this frame; the LAST registered zone under the pointer wins */
export interface HitZone {
  rect: Rect;
  onClick: () => void;
  /** a key replayed through handleInput after onClick (e.g. Enter to run the row just selected) */
  key?: KeyEvent;
}

export interface KeyCtx {
  layout: Layout;
  /** aion RendererHooks (tui/renderer.ts): the controller's submit / interrupt / exit */
  hooks: { onSubmit(text: string): void; onInterrupt(): void; onExit(): void };
  /** renderer-owned effects; the state field is already written when these fire */
  local: { setTheme(name: ThemeName): void; setMode(mode: CodeMode): void; openFile(path: string): void; toast(text: string): void };
  /** click zones the drawers registered while painting the current frame */
  hits: readonly HitZone[];
  /** the flattened files tree as drawn this frame (cursor / Enter / ←→ act on these rows) */
  rows: readonly TreeRow[];
  /** #40 engine.fuzzy when wired; defaults to the ported scorer in overlays.ts */
  fuzzy?: Fuzzy;
}

/** what the renderer must do after a key: repaint. A union of one today, kept extensible. */
export type KeyEffect = "render";

export const ESC_WINDOW_MS = 1500;
export const FOCUS_ORDER: readonly Focus[] = ["messages", "code", "files"];
/** ←/→ in the code panel (app.js:1547); `search` joins the cycle only while a result is shown */
export const CODE_MODE_CYCLE: readonly CodeMode[] = ["code", "diff", "run", "agents"];
/** "scroll to the tail" sentinel — the drawer clamps to the last row */
export const SCROLL_TAIL = 1e9;
const ALIAS_NOTE: Record<string, string> = {
  undo: "/undo → use /checkpoints + /restore", permissions: "/permissions → use /yolo", mode: "/mode → use /plan or /act",
};

const R = (): KeyEffect[] => ["render"], NONE = (): KeyEffect[] => [];
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, hi));
const inRect = (x: number, y: number, r: Rect) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;

/** messages→code→files, files only while the layout shows the column (app.js:1520) */
export function focusOrder(L: Layout): Focus[] { return FOCUS_ORDER.filter((f) => f !== "files" || L.files !== null); }

// ------------------------------------------------------------------ entry

export function handleInput(s: SextantState, ev: InputEvent, ctx: KeyCtx, now: number): KeyEffect[] {
  if (ev.type === "mouse") return onMouse(s, ev, ctx, now);
  if (ev.type === "paste") return onPaste(s, ev.text);
  if (s.palette) {
    if (ev.ctrl && ev.name === "c") return ctrlC(s, ctx);
    onPaletteKey(s, ev, (a) => runAction(s, a, ctx), ctx.fuzzy);
    return R();
  }
  if (s.help) { // app.js:1488 — the card swallows every key; the usual closers dismiss it
    if (ev.name === "escape" || ev.name === "enter" || ev.name === "space" || (ev.ctrl && ev.name === "c") || (ev.ch && !ev.ctrl)) s.help = false;
    return R();
  }
  if (ev.ctrl) return onCtrl(s, ev, ctx);
  if (s.card) { const fx = onCardKey(s, ev); if (fx) return fx; }
  const { name } = ev;
  if (name === "escape") return onEscape(s, ctx, now);
  if (name === "tab" || name === "shift-tab") return onTab(s, name, ctx);
  if (name === "enter") return onEnter(s, ctx);
  if (s.focus === "files") { const fx = onFilesKey(s, name, ctx); if (fx) return fx; }
  if (s.focus === "code") { const fx = onCodeKey(s, name, ctx); if (fx) return fx; }
  return onPromptKey(s, ev, ctx);
}

// ------------------------------------------------------------------ ctrl map (app.js:1489-1502)

function onCtrl(s: SextantState, ev: KeyEvent, ctx: KeyCtx): KeyEffect[] {
  switch (ev.name) {
    case "c": return ctrlC(s, ctx);
    case "k": case "p": openPalette(s); return R();
    case "t": setTheme(s, ctx, THEME_ORDER[(THEME_ORDER.indexOf(s.theme) + 1) % THEME_ORDER.length]!); return R();
    case "e": return setFocus(s, ctx, "files");
    case "s": setMode(s, ctx, "code"); s.focus = "code"; return R();
    case "d": setMode(s, ctx, s.code.mode === "diff" ? "code" : "diff"); return R();
    case "r": setMode(s, ctx, "run"); return R();
    case "a": setMode(s, ctx, "agents"); s.code.laneOpen = false; s.focus = "code"; return R();
    case "n": ctx.hooks.onSubmit("/new"); return R();
    case "u": clearInput(s); return R();
    case "left": case "right": s.input.cur = wordJump(s.input.text, s.input.cur, ev.name === "left" ? -1 : 1); return R();
    default: return NONE();
  }
}

/** ⌃c: a pending card is dismissed (deny / null); a running turn is interrupted; otherwise exit —
 *  so the second ⌃c after a run was stopped leaves (app.js:1491) */
function ctrlC(s: SextantState, ctx: KeyCtx): KeyEffect[] {
  if (s.card) dismissCard(s);
  if (s.running) ctx.hooks.onInterrupt(); else ctx.hooks.onExit();
  return R();
}

function setTheme(s: SextantState, ctx: KeyCtx, name: ThemeName): void { s.theme = name; ctx.local.setTheme(name); }
function setMode(s: SextantState, ctx: KeyCtx, mode: CodeMode): void { s.code.mode = mode; s.code.scroll = 0; ctx.local.setMode(mode); }
/** app.js:944 — parent dirs expand, the code panel shows the file; focus is the caller's call */
function openFile(s: SextantState, ctx: KeyCtx, path: string): void {
  const parts = path.split("/");
  for (let i = 1; i < parts.length; i++) s.files.expanded.add(parts.slice(0, i).join("/"));
  s.code.file = path; s.code.mode = "code"; s.code.scroll = 0;
  ctx.local.openFile(path);
}
function setFocus(s: SextantState, ctx: KeyCtx, f: Focus): KeyEffect[] {
  if (f === "files" && !ctx.layout.files) ctx.local.toast("the files panel needs ≥ 140 columns"); else s.focus = f;
  return R();
}
function clearInput(s: SextantState): void { s.input.text = ""; s.input.cur = 0; s.input.sgSel = 0; s.input.histIdx = -1; }

// ------------------------------------------------------------------ cards (app.js:1503-1510, 1434)

/** null = not a card key: it falls through to the prompt (typing a follow-up while a card waits) */
function onCardKey(s: SextantState, ev: KeyEvent): KeyEffect[] | null {
  const c = s.card!, { name } = ev;
  const n = c.kind === "approval" ? 3 : (c.prompt.options?.length ?? 0) + (c.prompt.allowFreeText !== false ? 1 : 0) + 1;
  const move = (d: number) => { const v = (c.selected + d + n) % n; if (c.kind === "approval") c.selected = v as 0 | 1 | 2; else c.selected = v; };
  if (name === "left" || name === "up") { move(-1); return R(); }
  if (name === "right" || name === "down" || name === "tab") { move(1); return R(); }
  if (name === "escape") { dismissCard(s); return R(); }
  if (c.kind === "approval") {
    if (name === "enter") { s.card = null; c.resolve((["once", "always", "deny"] as const)[c.selected]); return R(); }
    return null;
  }
  const opts = c.prompt.options?.length ?? 0, freeIdx = c.prompt.allowFreeText !== false ? opts : -1;
  if (name === "enter") {
    if (c.selected === n - 1) { dismissCard(s); return R(); } // skip
    if (c.selected === freeIdx) { const t = c.freeText.trim(); if (!t) return R(); s.card = null; c.resolve({ kind: "text", text: t }); return R(); }
    s.card = null; c.resolve({ kind: "option", index: c.selected }); return R();
  }
  if (c.selected !== freeIdx) return null;
  if (name === "backspace") { c.freeText = c.freeText.slice(0, -1); return R(); }
  const ch = name === "space" ? " " : ev.ch;
  if (ch && !ev.alt) { c.freeText += ch; return R(); }
  return null;
}

/** approval → deny, question → null; the card leaves the state before the promise settles */
function dismissCard(s: SextantState): void {
  const c = s.card;
  s.card = null;
  if (c?.kind === "approval") c.resolve("deny"); else c?.resolve(null);
}

// ------------------------------------------------------------------ esc / tab / enter

function onEscape(s: SextantState, ctx: KeyCtx, now: number): KeyEffect[] {
  if (s.focus !== "messages") { if (s.code.laneOpen) s.code.laneOpen = false; else s.focus = "messages"; return R(); }
  if (openSuggestions(s, ctx).length) { s.input.sgSel = -1; return R(); }
  if (s.running) { // app.js:1513 — arm, then interrupt inside the window
    if (now < s.escUntil) { s.escUntil = 0; ctx.hooks.onInterrupt(); } else s.escUntil = now + ESC_WINDOW_MS;
    return R();
  }
  if (s.input.text) { clearInput(s); return R(); }
  return NONE();
}

function onTab(s: SextantState, name: string, ctx: KeyCtx): KeyEffect[] {
  const sugs = openSuggestions(s, ctx);
  if (s.focus === "messages" && sugs.length) { applySuggestion(s, sugs[clamp(s.input.sgSel, 0, sugs.length - 1)]!); return R(); }
  const order = focusOrder(ctx.layout), i = Math.max(0, order.indexOf(s.focus));
  s.focus = order[(i + (name === "tab" ? 1 : order.length - 1)) % order.length]!;
  return R();
}

function onEnter(s: SextantState, ctx: KeyCtx): KeyEffect[] {
  if (s.focus === "files") {
    const r = ctx.rows[s.files.cursor];
    if (r?.dir) { if (s.files.expanded.has(r.path)) s.files.expanded.delete(r.path); else s.files.expanded.add(r.path); }
    else if (r) openFile(s, ctx, r.path);
    return R();
  }
  if (s.focus === "code") {
    if (s.code.mode === "agents" && s.crew.length) { s.code.laneOpen = !s.code.laneOpen; s.code.scroll = s.code.laneOpen ? SCROLL_TAIL : 0; }
    return R();
  }
  const sugs = openSuggestions(s, ctx);
  if (sugs.length) {
    const pick = sugs[clamp(s.input.sgSel, 0, sugs.length - 1)]!;
    applySuggestion(s, pick);
    if (pick.enter === "complete") return R();
  }
  return submitLine(s, s.input.text, ctx);
}

/** app.js:1438-1457 minus the mock paths: trimmed non-empty → history, clear, dispatch */
function submitLine(s: SextantState, raw: string, ctx: KeyCtx): KeyEffect[] {
  const text = raw.trim();
  if (!text) return NONE();
  s.input.history.push(text);
  clearInput(s);
  dispatch(s, text, ctx);
  return R();
}

/** renderer-local slash commands run here; everything else (built-ins, custom, `!cmd`, free
 *  text, unknown `/x`) reaches onSubmit unchanged — app.ts handleSlash owns the rest */
function dispatch(s: SextantState, text: string, ctx: KeyCtx): void {
  const p = parseInput(text);
  if (p.kind !== "slash" || !runLocal(s, p.cmd ?? "", p.arg ?? "", ctx)) ctx.hooks.onSubmit(text);
}

function runLocal(s: SextantState, cmd: string, arg: string, ctx: KeyCtx): boolean {
  switch (cmd) {
    case "help": s.help = true; return false; // the card opens AND /help reaches the transcript
    case "theme":
      if ((THEME_ORDER as readonly string[]).includes(arg)) setTheme(s, ctx, arg as ThemeName);
      else ctx.local.toast(`unknown theme "${arg}" · night, ember or contrast`);
      return true;
    case "open": {
      const p = resolveFile(arg, s.files.paths, ctx.fuzzy);
      if (p) { openFile(s, ctx, p); s.focus = "code"; } else ctx.local.toast(arg ? `no file matches "${arg}"` : "usage: /open <file>");
      return true;
    }
    case "diff": {
      if (arg) { const p = resolveFile(arg, s.files.paths, ctx.fuzzy); if (!p) { ctx.local.toast(`no file matches "${arg}"`); return true; } s.code.file = p; }
      setMode(s, ctx, "diff");
      return true;
    }
    case "focus":
      if (arg === "messages" || arg === "code" || arg === "files") setFocus(s, ctx, arg); else ctx.local.toast("focus is messages, code or files");
      return true;
    case "agents": setMode(s, ctx, "agents"); s.code.laneOpen = false; s.focus = "code"; return true;
    default:
      if (ALIAS_NOTE[cmd]) { ctx.local.toast(ALIAS_NOTE[cmd]); return true; }
      return false;
  }
}

/** palette actions (overlays.ts paletteItems): a slash line, or theme: / mode: / focus: / open: */
function runAction(s: SextantState, action: string, ctx: KeyCtx): void {
  if (action.startsWith("/")) {
    const p = parseInput(action), needsArg = ["theme", "open", "focus"].includes(p.cmd ?? "");
    if (needsArg && !p.arg) { s.input.text = action + " "; s.input.cur = s.input.text.length; s.input.sgSel = 0; s.focus = "messages"; return; }
    dispatch(s, action, ctx);
    return;
  }
  const i = action.indexOf(":"), kind = action.slice(0, i), rest = action.slice(i + 1);
  if (kind === "theme" && (THEME_ORDER as readonly string[]).includes(rest)) setTheme(s, ctx, rest as ThemeName);
  else if (kind === "mode") { setMode(s, ctx, rest as CodeMode); if (rest === "agents") s.code.laneOpen = false; }
  else if (kind === "focus") setFocus(s, ctx, rest as Focus);
  else if (kind === "open") { openFile(s, ctx, rest); s.focus = "code"; }
}

// ------------------------------------------------------------------ files / code panels

function onFilesKey(s: SextantState, name: string, ctx: KeyCtx): KeyEffect[] | null {
  const rows = ctx.rows, F = s.files;
  if (name === "up" || name === "down") {
    F.cursor = clamp(F.cursor + (name === "up" ? -1 : 1), 0, Math.max(0, rows.length - 1));
    const body = Math.max(1, (ctx.layout.files?.h ?? 3) - 2); // panel() body = rect minus borders
    if (F.cursor < F.scroll) F.scroll = F.cursor; else if (F.cursor >= F.scroll + body) F.scroll = F.cursor - body + 1;
    const r = rows[F.cursor];
    if (r && !r.dir) openFile(s, ctx, r.path);
    return R();
  }
  if (name === "left" || name === "right") {
    const r = rows[F.cursor];
    if (r?.dir) { if (name === "right") F.expanded.add(r.path); else F.expanded.delete(r.path); }
    return R();
  }
  return null;
}

function onCodeKey(s: SextantState, name: string, ctx: KeyCtx): KeyEffect[] | null {
  const c = s.code, n = s.crew.length;
  if (c.mode === "agents" && n && !c.laneOpen) { // app.js:1535-1541 — lane grid navigation
    const cols = n <= 1 ? 1 : n <= 4 ? 2 : 3;
    const step: Record<string, number> = { left: n - 1, right: 1, up: n - cols, down: cols };
    if (name in step) { c.lane = (c.lane + step[name]!) % n; return R(); }
  }
  if (name === "up") { c.scroll = Math.max(0, c.scroll - 1); return R(); }
  if (name === "down") { c.scroll += 1; return R(); }
  if (name === "pageup") { c.scroll = Math.max(0, c.scroll - 10); return R(); }
  if (name === "pagedown") { c.scroll += 10; return R(); }
  if (name === "left" || name === "right") {
    const modes = c.search ? [...CODE_MODE_CYCLE, "search" as CodeMode] : [...CODE_MODE_CYCLE];
    const i = Math.max(0, modes.indexOf(c.mode));
    setMode(s, ctx, modes[(i + (name === "right" ? 1 : modes.length - 1)) % modes.length]!);
    return R();
  }
  return null;
}

// ------------------------------------------------------------------ prompt (app.js:1549-1562)

function onPromptKey(s: SextantState, ev: KeyEvent, ctx: KeyCtx): KeyEffect[] {
  const { name } = ev, I = s.input;
  if (name === "pageup") { s.stick = false; s.msgScroll = Math.max(0, s.msgScroll - 5); return R(); }
  if (name === "pagedown") { s.msgScroll += 5; return R(); }
  if (name === "up" || name === "down") {
    const d = name === "up" ? -1 : 1, sugs = I.histIdx < 0 ? openSuggestions(s, ctx) : [];
    if (sugs.length) { I.sgSel = (clamp(I.sgSel, 0, sugs.length - 1) + d + sugs.length) % sugs.length; return R(); }
    const h = I.history;
    if (!h.length) return NONE();
    if (I.histIdx < 0) I.histIdx = h.length;
    I.histIdx = clamp(I.histIdx + d, 0, h.length);
    I.text = h[I.histIdx] ?? ""; I.cur = I.text.length; I.sgSel = 0;
    return R();
  }
  if (name === "left" || name === "right") {
    I.cur = ev.alt ? wordJump(I.text, I.cur, name === "left" ? -1 : 1) : clamp(I.cur + (name === "left" ? -1 : 1), 0, I.text.length);
    return R();
  }
  if (name === "home") { I.cur = 0; return R(); }
  if (name === "end") { I.cur = I.text.length; s.stick = true; return R(); }
  if (name === "backspace") {
    if (I.cur > 0) { I.text = I.text.slice(0, I.cur - 1) + I.text.slice(I.cur); I.cur--; I.sgSel = 0; I.histIdx = -1; }
    s.focus = "messages";
    return R();
  }
  if (name === "delete") { if (I.cur < I.text.length) { I.text = I.text.slice(0, I.cur) + I.text.slice(I.cur + 1); I.sgSel = 0; } return R(); }
  const ch = name === "space" ? " " : ev.ch;
  if (ch && !ev.alt) { insertText(s, ch); return R(); }
  return NONE();
}

function onPaste(s: SextantState, text: string): KeyEffect[] {
  if (s.help) return NONE();
  if (s.palette) { s.palette.query += text.replace(/\s+/g, " "); s.palette.sel = 0; return R(); }
  const c = s.card;
  if (c?.kind === "question" && c.prompt.allowFreeText !== false && c.selected === (c.prompt.options?.length ?? 0)) { c.freeText += text; return R(); }
  insertText(s, text);
  return R();
}

/** app.js:1476-1482 — typing pulls focus back to the prompt and drops a history browse */
function insertText(s: SextantState, t: string): void {
  const I = s.input;
  I.text = I.text.slice(0, I.cur) + t + I.text.slice(I.cur); I.cur += t.length;
  I.sgSel = 0; I.histIdx = -1; s.focus = "messages";
}

function applySuggestion(s: SextantState, sg: Suggestion): void {
  s.input.text = sg.apply.text; s.input.cur = sg.apply.cur; s.input.sgSel = 0; s.input.histIdx = -1;
}

/** the visible suggestion rows: none once Esc dismissed the box (sgSel = -1) */
function openSuggestions(s: SextantState, ctx: KeyCtx): Suggestion[] {
  return s.input.sgSel < 0 ? [] : suggestions(s, s.files.paths, ctx.fuzzy);
}

function wordJump(text: string, cur: number, d: -1 | 1): number {
  let i = cur;
  if (d < 0) { while (i > 0 && /\s/.test(text[i - 1]!)) i--; while (i > 0 && !/\s/.test(text[i - 1]!)) i--; }
  else { while (i < text.length && /\s/.test(text[i]!)) i++; while (i < text.length && !/\s/.test(text[i]!)) i++; }
  return i;
}

// ------------------------------------------------------------------ mouse (app.js:1575-1584)

function onMouse(s: SextantState, ev: MouseEvent, ctx: KeyCtx, now: number): KeyEffect[] {
  if (!ev.press) return NONE();
  const L = ctx.layout;
  if (ev.b === 64 || ev.b === 65) { // wheel: the panel under the pointer scrolls
    if (s.palette || s.help) return NONE();
    const d = ev.b === 64 ? -1 : 1;
    if (inRect(ev.x, ev.y, L.messages)) { s.msgScroll = Math.max(0, s.msgScroll + d * 2); if (d < 0) s.stick = false; return R(); }
    if (inRect(ev.x, ev.y, L.code)) { s.code.scroll = Math.max(0, s.code.scroll + d * 3); return R(); }
    if (L.files && inRect(ev.x, ev.y, L.files)) { s.files.scroll = Math.max(0, s.files.scroll + d * 2); return R(); }
    return NONE();
  }
  if ((ev.b & 3) !== 0 || (ev.b & 32) !== 0) return NONE(); // left button only, no drag
  for (let i = ctx.hits.length - 1; i >= 0; i--) {
    const z = ctx.hits[i]!;
    if (!inRect(ev.x, ev.y, z.rect)) continue;
    z.onClick();
    if (z.key) handleInput(s, z.key, ctx, now);
    return R();
  }
  if (s.palette || s.help) return NONE();
  for (const [f, r] of [["messages", L.messages], ["code", L.code], ["files", L.files]] as [Focus, Rect | null][]) {
    if (r && inRect(ev.x, ev.y, r)) { s.focus = f; return R(); }
  }
  return NONE();
}
