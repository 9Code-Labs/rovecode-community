/** Sextant input (port #43): keys, mouse, focus, prompt editing and the overlay key routes.
 *  Ported from the user's own sextant v0.4.0 prototype — src/app.js:1438-1584 (submit, insertText,
 *  FOCUS_ORDER, onKey incl. the ctrl map, esc / esc-esc, tab focus, per-focus enter, files nav,
 *  code scroll/mode, message paging, history/suggestion ↑↓, line editing; onMouse with wheel 64/65
 *  and the reverse hit order) and :1024-1029 (runSlash history push). Dropped: intent matching, the
 *  mock shell, /spawn /crew; /undo /permissions /mode become notes. Split for the line budget: the
 *  card key route is card-keys.ts; the renderer-local slash commands, those notes and the
 *  state-then-hook effect helpers are local-commands.ts.
 *  `handleInput` is a PURE state mutator: `now` is a parameter (esc-esc window), no Date.now(),
 *  timers or process access; everything that leaves the state goes through KeyCtx.hooks (rovecode's
 *  RendererHooks) or KeyCtx.local (renderer-owned effects: theme rebuild, file/diff loading,
 *  toasts); a state field is written BEFORE its local hook fires, so the renderer only loads
 *  content / rebuilds the palette.
 *  Deviations from the prototype, all deliberate: Enter runs the highlighted slash row only for a
 *  ≥ 2-letter prefix stem (`/hel` → /help) or a ↓-picked row — a fuzzy-only top row (`/x` → /exit,
 *  `/exot` → /export) or a one-letter stem (`/e` → /exit would quit) submits the line verbatim so
 *  handleSlash reports the unknown command (the #43 bar); ⇧Tab also completes while the box is
 *  open (README table); Esc closes a visible box first (sgSel = -1 until the text changes) before
 *  arming the interrupt or clearing the line; ↑↓ keep browsing history once started, and ↓ past the
 *  newest yields "" (faithful — no draft field; a draft is a types.ts question for #44); ⌃c with a
 *  pending card while a run is live denies/nulls the card AND interrupts (the prototype only
 *  answered the card); End re-sticks the messages tail but wheel-down never does — only the drawer
 *  knows maxScroll (#44 handoff: re-stick in the messages drawer at the tail); /help opens the
 *  keys card AND reaches handleSlash; a left-button drag never clicks; a click on a panel body with
 *  no hit zone focuses it; ←/→, Backspace and Delete step by code point (😀 is never split); the
 *  mouse goes through the #40 mouseKind, so a shift/alt/ctrl + wheel scrolls and never clicks.
 *  NOTE for #44: once sextant is the default, app.ts discoverCommands `reserved` should include the
 *  renderer-local names (theme open diff focus agents) so a custom command file cannot shadow them. */

import {
  THEME_ORDER, type CodeMode, type Focus, type HitZone, type InputEvent, type KeyEvent, type Layout, type MouseEvent, type Page,
  type Rect, type SextantState, type ThemeName, type TreeRow,
} from "./types.ts";
import { type Fuzzy, type Suggestion, onPaletteKey, openPalette, parseInput, resolveFile, suggestions } from "./overlays.ts";
import { onMarketKey, type MarketViewRow } from "./draw-market.ts";
import { onWizardKey, wizardPaste } from "./draw-wizard.ts";
import { onContextKey } from "./draw-context.ts";
import { dispatch, openFile, runAction, setFocus, setMode, setTheme, showAgents } from "./local-commands.ts";
import { dismissCard, onCardKey } from "./card-keys.ts";
import { gridFor } from "./draw-agents.ts";
import { mouseKind } from "./input.ts";
import { mainPage, nextPage } from "./draw-tabs.ts";
import { openNotices, openOverlays } from "./overlays.ts";

// ------------------------------------------------------------------ contract

/** a click zone a drawer registered this frame; the LAST registered zone under the pointer wins (contract: types.ts) */
export type { HitZone } from "./types.ts";

export interface KeyCtx {
  layout: Layout;
  /** rovecode RendererHooks (tui/renderer.ts): the controller's submit / interrupt / exit */
  hooks: { onSubmit(text: string): void; onInterrupt(): void; onExit(): void };
  /** renderer-owned effects; the state field is already written when these fire */
  local: {
    setTheme(name: ThemeName): void; setMode(mode: CodeMode): void; openFile(path: string): void; toast(text: string): void;
    /** port #54: an @image mention reached dispatch — stage it for the next message (tui/attach.ts's seam,
     *  the store's stage: caps, the vision note and the chip are that seam's, nothing duplicated here) */
    attachImage(abs: string): void;
    /** open /market: the renderer loads the catalog (async) and fills s.market when it answers */
    openMarket(): void;
    /** open /context: the renderer asks the LIVE runtime for the system prompt and tool schemas — the two
     *  rows a transcript cannot know — and fills s.context when the count is done */
    openContext(): void;
    /** open the connect wizard (/connect, /setup): the provider rows come from the attach seam's
     *  wizardProviders; without it (no runtime behind the surface) the call degrades to a toast */
    openWizard(): void;
    /** the human pressed Enter on a row (and answered the install-once chooser for an npx row: `local`):
     *  build the plan and write it into s.market.plan */
    marketPlan(row: MarketViewRow, local?: boolean): void;
    /** the human confirmed the plan card: run THAT plan (its `local` included) and write the outcome back onto the card */
    marketInstall(row: MarketViewRow, local?: boolean): void;
    /** the docs pane opened on a row whose body has not been read: fetch it and fill the row's lines */
    marketDocs(row: MarketViewRow): void;
    /** the connect wizard (draw-wizard.ts): register a url door's endpoint (reg.add), store the pasted
     *  key for `provider` (credentials file, not the transcript), load the model list for the chosen
     *  provider, pin the checked rows as the active list */
    wizardRegister(id: string, url: string, protocol: "openai" | "anthropic"): void;
    wizardStoreKey(provider: string, secret: string): void;
    wizardModel(model: string): void;
    /** the model step OPENED: fetch the endpoint's model list through the wizardModels seam (the
     *  renderer answers with wizardModelConfirmed; empty or failed → the typed fallback stays) */
    wizardLoadModels(): void;
    /** the model step's ACTIVATE answer (confirmModels): pin `models` as the provider's active list
     *  (registry setModels) and make `makeDefault` the default when one is named */
    wizardActivate(provider: string, models: readonly string[], makeDefault?: string): void;
  };
  /** click zones the drawers registered while painting the current frame */
  hits: readonly HitZone[];
  /** the zone grabbed by the last click that had an onDrag (a scrollbar thumb); owned by the frame loop
   *  so it outlives the per-frame `hits` list — drag events go to it until the button is released */
  drag: { zone: HitZone | null; y0: number };
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

const R = (): KeyEffect[] => ["render"], NONE = (): KeyEffect[] => [];
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, hi));
const inRect = (x: number, y: number, r: Rect) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;

/** messages→code→files, files only while the layout shows the column (app.js:1520) */
/** files is in the Tab cycle when its panel is on screen — its own column, or paged into the main slot */
export function focusOrder(L: Layout, page: Page = "code"): Focus[] {
  return FOCUS_ORDER.filter((f) => f !== "files" || L.files !== null || page === "files");
}

// ------------------------------------------------------------------ entry

export function handleInput(s: SextantState, ev: InputEvent, ctx: KeyCtx, now: number): KeyEffect[] {
  if (ev.type === "mouse") return onMouse(s, ev, ctx, now);
  if (ev.type === "paste") return onPaste(s, ev.text, ctx);
  if (s.palette) {
    if (ev.ctrl && ev.name === "c") return ctrlC(s, ctx);
    onPaletteKey(s, ev, (a) => runAction(s, a, ctx), ctx.fuzzy);
    return R();
  }
  if (s.market) {
    if (ev.ctrl && ev.name === "c") return ctrlC(s, ctx);
    const req = onMarketKey(s, ev, ctx.fuzzy);
    // the overlay decides WHAT should happen; the renderer owns the market module and does it
    if (req.kind === "plan") ctx.local.marketPlan(req.row, req.local);
    else if (req.kind === "docs") ctx.local.marketDocs(req.row);
    // the plan card names an item; installing re-read the SELECTION instead, and the two can differ —
    // the plan arrives asynchronously, so an arrow key (or a click on a list row that outlived the card)
    // moved the selection while the card still showed the first item. Install what the human approved.
    else if (req.kind === "install") ctx.local.marketInstall(req.plan.row, req.plan.local);
    return R();
  }
  if (s.context) {
    if (ev.ctrl && ev.name === "c") return ctrlC(s, ctx);
    // a page is the drawn body height; the panel is centred and capped, so this matches drawContext
    onContextKey(s, ev, Math.max(4, Math.min(ctx.layout.h - 4, 24)));
    return R();
  }
  if (s.wizard) {
    if (ev.ctrl && ev.name === "c") return ctrlC(s, ctx);
    // the overlay decides WHAT should happen; the renderer owns the registry and runs it
    const req = onWizardKey(s, ev);
    if (req.kind === "registerEndpoint") ctx.local.wizardRegister(req.id, req.url, req.protocol);
    else if (req.kind === "storeKey") ctx.local.wizardStoreKey(req.provider, req.secret);
    else if (req.kind === "confirmModels") ctx.local.wizardActivate(req.provider, req.models, req.makeDefault === undefined ? undefined : req.makeDefault);
    else if (req.kind === "confirmModel") ctx.local.wizardModel(req.model);
    else if (req.kind === "loadModels") ctx.local.wizardLoadModels();
    return R();
  }
  if (s.help) { // app.js:1488 — the card swallows every key; the usual closers dismiss it
    const closer = ev.name === "escape" || ev.name === "enter" || ev.name === "space" || (ev.ctrl && ev.name === "c");
    if (closer || (ev.ch && !ev.ctrl)) s.help = false;
    return R();
  }
  if (ev.ctrl) return onCtrl(s, ev, ctx);
  if (s.card && onCardKey(s, s.card, ev)) return R();
  const { name } = ev;
  if (name === "escape") return onEscape(s, ctx, now);
  if (name === "tab" || name === "shift-tab") return onTab(s, name, ctx);
  if (name === "enter") return onEnter(s, ctx);
  if (s.focus === "files") { const fx = onFilesKey(s, name, ctx); if (fx) return fx; }
  if (s.focus === "code") { const fx = onCodeKey(s, name, ctx); if (fx) return fx; }
  return onPromptKey(s, ev, ctx);
}

// ------------------------------------------------------------------ ctrl map (app.js:1489-1502)

/** The chords that put an overlay on the screen. A card is modal, and an overlay painted over it also
 *  registers its hit zones first — so the card underneath stops answering the mouse and the tool call
 *  waiting on it is stuck until the user finds their way back out. ⌃c was special-cased for this from
 *  the start; the rest fell through by omission. Typing still reaches the prompt while a card waits
 *  (onCardKey returning false is deliberate) — this only stops a second surface from covering it. */
const OPENS_OVERLAY = new Set(["k", "p", "b", "m", "g"]);

function onCtrl(s: SextantState, ev: KeyEvent, ctx: KeyCtx): KeyEffect[] {
  if (s.card && ev.name !== undefined && OPENS_OVERLAY.has(ev.name)) return R();
  switch (ev.name) {
    case "c": return ctrlC(s, ctx);
    case "k": case "p": openPalette(s); return R();
    case "g": ctx.local.openContext(); return R();
    case "t": {
      const next: ThemeName = THEME_ORDER[(THEME_ORDER.indexOf(s.theme) + 1) % THEME_ORDER.length]!;
      setTheme(s, ctx, next);
      return R();
    }
    case "e": setFocus(s, ctx, "files"); return R();
    // ⌃o: cycle the tab strip (draw-tabs.ts) — code → files → plan on a narrow terminal; inert when wide
    case "o": {
      const next = nextPage(ctx.layout, s);
      if (next !== s.page) { s.page = next; s.focus = next === "files" ? "files" : "code"; }
      return R();
    }
    case "b": openNotices(s); return R(); // the notification history (overlays.ts openNotices)
    case "m": ctx.local.openMarket(); return R(); // the market overlay (draw-market.ts)
    // ⌃v with an IMAGE on the clipboard: the terminal sends no paste for it, only this key — ask the
    // OS for the image through /paste (tui/attach.ts cmdPasteImage). Text pastes never arrive here.
    case "v": ctx.hooks.onSubmit("/paste"); return R();
    case "s": setMode(s, ctx, "code"); s.focus = "code"; return R();
    case "d": setMode(s, ctx, s.code.mode === "diff" ? "code" : "diff"); return R();
    case "r": setMode(s, ctx, "run"); return R();
    case "a": showAgents(s, ctx); return R();
    case "n": ctx.hooks.onSubmit("/new"); return R();
    case "u": clearInput(s); return R();
    case "left": case "right":
      s.input.cur = wordJump(s.input.text, s.input.cur, ev.name === "left" ? -1 : 1);
      return R();
    default: return NONE();
  }
}

/** ⌃c: a pending card is dismissed (deny / null) AND a running turn is interrupted (the prototype
 *  only answered the card); idle → exit, so the second ⌃c after a run was stopped leaves (app.js:1491) */
function ctrlC(s: SextantState, ctx: KeyCtx): KeyEffect[] {
  if (s.card) dismissCard(s);
  if (s.running) ctx.hooks.onInterrupt(); else ctx.hooks.onExit();
  return R();
}

function clearInput(s: SextantState): void { s.input.text = ""; s.input.cur = 0; s.input.sgSel = 0; s.input.histIdx = -1; }

// ------------------------------------------------------------------ esc / tab / enter

function onEscape(s: SextantState, ctx: KeyCtx, now: number): KeyEffect[] {
  if (s.focus !== "messages") { // a panel: close its open lane first, then hand focus back to the prompt
    if (s.code.laneOpen) s.code.laneOpen = false; else s.focus = "messages";
    return R();
  }
  if (openSuggestions(s, ctx).length) { s.input.sgSel = -1; return R(); } // close the box, keep the text
  if (s.running) { // app.js:1513 — the first Esc arms the window, the second inside it interrupts
    if (now < s.escUntil) { s.escUntil = 0; ctx.hooks.onInterrupt(); }
    else s.escUntil = now + ESC_WINDOW_MS;
    return R();
  }
  if (s.input.text) { clearInput(s); return R(); }
  return NONE();
}

function onTab(s: SextantState, name: string, ctx: KeyCtx): KeyEffect[] {
  const sugs = openSuggestions(s, ctx);
  if (s.focus === "messages" && sugs.length) { applySuggestion(s, sugs[clamp(s.input.sgSel, 0, sugs.length - 1)]!); return R(); }
  const order = focusOrder(ctx.layout, s.page), i = Math.max(0, order.indexOf(s.focus));
  s.focus = order[(i + (name === "tab" ? 1 : order.length - 1)) % order.length]!;
  return R();
}

function onEnter(s: SextantState, ctx: KeyCtx): KeyEffect[] {
  if (s.focus === "files") {
    const r = ctx.rows[s.files.cursor];
    if (r?.dir) { // toggle the fold
      if (s.files.expanded.has(r.path)) s.files.expanded.delete(r.path); else s.files.expanded.add(r.path);
    } else if (r) openFile(s, ctx, r.path);
    return R();
  }
  if (s.focus === "code") {
    if (s.code.mode === "agents" && s.crew.length) { // open / close the selected lane; opened = at its tail
      s.code.laneOpen = !s.code.laneOpen;
      s.code.scroll = s.code.laneOpen ? SCROLL_TAIL : 0;
    }
    return R();
  }
  const sugs = openSuggestions(s, ctx);
  if (sugs.length) {
    const pick = sugs[clamp(s.input.sgSel, 0, sugs.length - 1)]!;
    if (!autoRuns(s, pick)) return submitLine(s, s.input.text, ctx);
    applySuggestion(s, pick);
    if (pick.enter === "complete") return R();
  }
  return submitLine(s, s.input.text, ctx);
}

/** Enter takes the highlighted row when the user picked it with ↓, when it is an argument or mention
 *  row, or when the typed stem is a ≥ 2-letter prefix of the command (`/hel` → /help); a fuzzy-only
 *  top row (`/x` → /exit) or a one-letter stem (`/e`) would run a command the user never named */
function autoRuns(s: SextantState, pick: Suggestion): boolean {
  if (pick.kind !== "slash" || s.input.sgSel !== 0) return true;
  const stem = (parseInput(s.input.text).cmd ?? "").toLowerCase();
  return stem.length >= 2 && pick.label.slice(1).toLowerCase().startsWith(stem);
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

/** the agents board's body width: drawCode's inner rect (w − 4) minus the 3-wide rail and its 2-cell gap */
const agentsBodyWidth = (code: Rect): number => code.w - 9;

function onCodeKey(s: SextantState, name: string, ctx: KeyCtx): KeyEffect[] | null {
  const c = s.code, n = s.crew.length;
  if (c.mode === "agents" && n && !c.laneOpen) { // app.js:1535-1541 — lane grid navigation
    const { cols } = gridFor(agentsBodyWidth(ctx.layout.code), n); // the board's own grid (#46), not a lane count
    const step: Record<string, number> = { left: n - 1, right: 1, up: n - cols, down: cols };
    // own keys only: a key named "constructor" or "__proto__" is not a move (`in` would make lane NaN)
    if (Object.hasOwn(step, name)) { c.lane = (c.lane + step[name]!) % n; return R(); }
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
  if (name === "up" || name === "down") return onHistoryKey(s, name === "up" ? -1 : 1, ctx);
  if (name === "left" || name === "right") {
    const d = name === "left" ? -1 : 1;
    if (ev.alt) I.cur = wordJump(I.text, I.cur, d);
    else I.cur = clamp(d < 0 ? I.cur - cpBefore(I.text, I.cur) : I.cur + cpAt(I.text, I.cur), 0, I.text.length);
    return R();
  }
  if (name === "home") { I.cur = 0; return R(); }
  if (name === "end") { I.cur = I.text.length; s.stick = true; return R(); }
  if (name === "backspace") {
    if (I.cur > 0) { // the whole code point before the cursor goes (😀 is two UTF-16 units)
      const n = cpBefore(I.text, I.cur);
      I.text = I.text.slice(0, I.cur - n) + I.text.slice(I.cur);
      I.cur -= n; I.sgSel = 0; I.histIdx = -1;
    }
    s.focus = "messages";
    return R();
  }
  if (name === "delete") {
    if (I.cur < I.text.length) { // the whole code point under the cursor goes
      I.text = I.text.slice(0, I.cur) + I.text.slice(I.cur + cpAt(I.text, I.cur));
      I.sgSel = 0;
    }
    return R();
  }
  const ch = name === "space" ? " " : ev.ch;
  if (ch && !ev.alt) { insertText(s, ch); return R(); }
  return NONE();
}

/** ↑↓: the open suggestion box first (wrap over its rows), else browse history (app.js:1556) */
function onHistoryKey(s: SextantState, d: -1 | 1, ctx: KeyCtx): KeyEffect[] {
  const I = s.input, sugs = I.histIdx < 0 ? openSuggestions(s, ctx) : [];
  if (sugs.length) { // no browse running and the box is open: move its highlight
    I.sgSel = (clamp(I.sgSel, 0, sugs.length - 1) + d + sugs.length) % sugs.length;
    return R();
  }
  const h = I.history;
  if (!h.length) return NONE();
  if (I.histIdx < 0) I.histIdx = h.length; // a browse starts just past the newest entry
  I.histIdx = clamp(I.histIdx + d, 0, h.length);
  I.text = h[I.histIdx] ?? ""; // past the newest again: an empty line (no draft is kept)
  I.cur = I.text.length;
  I.sgSel = 0;
  return R();
}

/** a pasted line that is ONE image path — what a terminal delivers when a file is dragged onto it
 *  (Windows Terminal quotes paths with spaces). Syntactic only: keys.ts is pure and never touches the
 *  disk; app.ts's /attach loads the file, sniffs the magic bytes and reports a non-image as a note. */
export function pastedImagePath(text: string): string | null {
  const t = text.trim();
  if (t.length === 0 || t.includes("\n")) return null;
  const m = /^(?:"([^"]+)"|'([^']+)'|(\S+))$/.exec(t);
  const p = m?.[1] ?? m?.[2] ?? m?.[3];
  return p !== undefined && /\.(png|jpe?g|gif|webp)$/i.test(p) ? p : null;
}

function onPaste(s: SextantState, text: string, ctx: KeyCtx): KeyEffect[] {
  if (s.help) return NONE();
  if (s.palette) { s.palette.query += text.replace(/\s+/g, " "); s.palette.sel = 0; return R(); }
  // the connect wizard's KEY step takes its whole input as paste (a key is one paste event, not
  // keystrokes) — and a paste it does not take is swallowed, never typed into the composer under it
  if (s.wizard) { wizardPaste(s, text); return R(); }
  // a dropped image file attaches instead of landing in the prompt as a path string
  if (!s.card) {
    const img = pastedImagePath(text);
    if (img !== null) { ctx.hooks.onSubmit(`/attach "${img}"`); return R(); }
  }
  const c = s.card;
  if (c?.kind === "question" && c.prompt.allowFreeText !== false) {
    const onFreeText = c.selected === (c.prompt.options?.length ?? 0); // index options.length = the free-text row
    if (onFreeText) { c.freeText += text; return R(); }
  }
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

/** UTF-16 length of the code point that ends at `cur` — 2 for an astral pair such as 😀 */
function cpBefore(text: string, cur: number): number { return cur >= 2 && text.codePointAt(cur - 2)! > 0xffff ? 2 : 1; }
/** UTF-16 length of the code point that starts at `cur` (1 past the end — callers clamp) */
function cpAt(text: string, cur: number): number { return (text.codePointAt(cur) ?? 0) > 0xffff ? 2 : 1; }

function wordJump(text: string, cur: number, d: -1 | 1): number {
  let i = cur;
  if (d < 0) { while (i > 0 && /\s/.test(text[i - 1]!)) i--; while (i > 0 && !/\s/.test(text[i - 1]!)) i--; }
  else { while (i < text.length && /\s/.test(text[i]!)) i++; while (i < text.length && !/\s/.test(text[i]!)) i++; }
  return i;
}

// ------------------------------------------------------------------ mouse (app.js:1575-1584)

/** the button kinds come from the #40 parser's mouseKind, which masks the modifier bits (4 shift, 8 meta,
 *  16 ctrl) first: shift/alt/ctrl + wheel (b 68/69, 72/73, 80/81) is a wheel — the prototype's raw
 *  `b === 64 || b === 65` let those fall through into the click walk, so shift+wheel over the `/exit`
 *  suggestion row ran it; a modified or non-left button, a drag and a release never click */
function onMouse(s: SextantState, ev: MouseEvent, ctx: KeyCtx, now: number): KeyEffect[] {
  const kind = mouseKind(ev);
  const L = ctx.layout;
  if (kind === "wheel-up" || kind === "wheel-down") return onWheel(s, ev, L, kind === "wheel-up" ? -1 : 1, ctx);
  // a grabbed zone (a scrollbar thumb) follows the pointer until the button is released
  if (kind === "release") { const had = ctx.drag.zone !== null; ctx.drag.zone = null; return had ? R() : NONE(); }
  if (kind === "drag") { const z = ctx.drag.zone; if (z?.onDrag) { z.onDrag(ev.y, ev.y - ctx.drag.y0); return R(); } return NONE(); }
  if (kind !== "click") return NONE();
  for (let i = ctx.hits.length - 1; i >= 0; i--) {
    const z = ctx.hits[i]!;
    if (!inRect(ev.x, ev.y, z.rect)) continue;
    ctx.drag.zone = z.onDrag ? z : null;
    ctx.drag.y0 = ev.y;
    z.onClick();
    if (z.key) handleInput(s, z.key, ctx, now);
    return R();
  }
  // ANY open overlay swallows the fall-through, not just the two that existed when this was written:
  // `market` and `context` were added later and never added here, so a click that missed every hit
  // zone still moved focus in the cockpit behind the box. openOverlays is the invariant table — asking
  // it means the next overlay is covered on the day it is added rather than the day someone notices.
  if (openOverlays(s).length > 0) return NONE();
  // the main slot is code unless the layout hid the paged panel and it is showing there instead
  const main = mainPage(L, s);
  const panels: [Focus, Rect | null][] = [
    ["messages", L.messages],
    ["code", main === "code" ? L.code : null],
    ["files", L.files ?? (main === "files" ? L.code : null)],
  ];
  for (const [f, r] of panels) {
    if (r && inRect(ev.x, ev.y, r)) { s.focus = f; return R(); }
  }
  return NONE();
}

/** the panel under the pointer scrolls: messages by 2 (wheel-up unsticks the tail), code by 3,
 *  files by 2; wheel-down never re-sticks — only the drawer knows maxScroll (#44 handoff) */
/** the wheel scrolls the panel under the pointer. Messages: up unsticks (the frame loop re-sticks when the
 *  view reaches the tail again — scroll-hits.ts followTailIfAtEnd); code clamps in codeScrollTop; the files
 *  tree — in its panel, or paged into the main slot on a narrow terminal — clamps to its rows here and
 *  pulls the cursor along, because drawFiles snaps the window back to the cursor otherwise. */
function onWheel(s: SextantState, ev: MouseEvent, L: Layout, d: -1 | 1, ctx: KeyCtx): KeyEffect[] {
  // the wheel never reaches the hit zones at all — it does its own rect maths against the panels — so
  // with the market open, scrolling over the box scrolled the transcript UNDERNEATH it, invisibly.
  // Same fix as onMouse: ask the overlay table rather than naming two of the four by hand.
  if (openOverlays(s).length > 0) return NONE();
  if (inRect(ev.x, ev.y, L.messages)) {
    s.msgScroll = Math.max(0, s.msgScroll + d * 2);
    if (d < 0) s.stick = false;
    return R();
  }
  const main = mainPage(L, s);
  const filesRect = L.files ?? (main === "files" ? L.code : null);
  if (filesRect && inRect(ev.x, ev.y, filesRect)) {
    const h = Math.max(1, filesRect.h - 2), f = s.files;
    f.scroll = Math.max(0, Math.min(f.scroll + d * 2, Math.max(0, ctx.rows.length - h)));
    f.cursor = Math.max(f.scroll, Math.min(f.cursor, f.scroll + h - 1));
    return R();
  }
  if (main === "code" && inRect(ev.x, ev.y, L.code)) { s.code.scroll = Math.max(0, s.code.scroll + d * 3); return R(); }
  return NONE();
}
