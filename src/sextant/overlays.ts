/** Sextant overlays (port #43): prompt parsing, the suggestion box, the command palette and the
 *  help card. Ported from the user's own sextant v0.4.0 prototype — src/commands.js:8-29
 *  (parseInput, mentionAt), :51-59 (resolveFile), src/engine.js:125-137 (fuzzy) and
 *  src/app.js:940-1029 (SLASH table, fileOptions, suggestions, drawSuggest), :1075-1089 (drawHelp),
 *  :1097-1156 (palette groups/open/close/draw), :1564-1574 (onPaletteKey).
 *  Dropped: intent matching, the mock shell table (`!cmd` is plain text for onSubmit), /spawn
 *  /crew /undo /permissions /mode /changes /pet /tasks-as-scenarios. Renderer-local commands
 *  (/help card, /theme, /open, /diff, /focus, /agents) are listed in LOCAL_COMMANDS and run by
 *  local-commands.ts; every other slash line (built-ins + custom, from `s.commands` = setCommands)
 *  is handed to onSubmit by keys.ts. `suggestions` caps its rows at MAX_SUGGESTIONS in one place;
 *  the drawers never write the state (a paint is not an event).
 *  Pure: no Date.now(), no timers, no process access. Palette actions are strings (contract
 *  PaletteState.items): a slash line, or `theme:<name>` `mode:<CodeMode>` `focus:<Focus>`
 *  `open:<path>` — keys.ts runs them. `fuzzy` is a parameter everywhere (default = the ported
 *  scorer) so #40's engine.fuzzy can be plugged in without a hard import. */

import type { HitZone } from "./keys.ts";
import {
  ATTR, THEME_ORDER, type CodeMode, type KeyEvent, type Layout, type PaletteState, type Rect,
  type ScreenLike, type SextantState, type Style, type Theme, type ThemeName,
} from "./types.ts";
import { markNoticesRead } from "./model.ts";
import { MENTION_RE } from "./mentions.ts";

// ------------------------------------------------------------------ parsing (commands.js)

export type Fuzzy = (q: string, s: string) => { score: number; idx: number[] } | null;

/** engine.js:125-137 — subsequence match; +3 for a consecutive hit, +2 at a word/path start */
export const fuzzy: Fuzzy = (q, s) => {
  q = q.toLowerCase(); s = s.toLowerCase();
  let qi = 0, score = 0, last = -2;
  const idx: number[] = [];
  for (let i = 0; i < s.length && qi < q.length; i++) {
    if (s[i] === q[qi]) {
      idx.push(i);
      score += (last === i - 1 ? 3 : 1) + (i === 0 || s[i - 1] === " " || s[i - 1] === "/" ? 2 : 0);
      last = i; qi++;
    }
  }
  return qi === q.length ? { score, idx } : null;
};

export interface ParsedInput {
  kind: "slash" | "shell" | "text";
  /** slash: the command name (may be ""); shell: the command after `!` */
  cmd?: string;
  /** slash only: undefined = no space typed yet, "" = space typed and nothing after */
  arg?: string;
  mentions: string[];
}

/** commands.js:8-21 — classify one prompt line (an empty line is `text` with no mentions) */
export function parseInput(text: string): ParsedInput {
  const t = text.trim();
  if (t[0] === "/") {
    const m = /^\/(\S*)(\s+(.*))?$/s.exec(text.trimStart());
    return { kind: "slash", cmd: m?.[1] ?? "", arg: m?.[2] === undefined ? undefined : (m[3] ?? "").trim(), mentions: [] };
  }
  // `!cmd` runs a shell command (tui/shell-cmd.ts). Narrow on purpose: the bang must be followed by something that
  // is neither whitespace nor another bang, so `!`, `! x` and `!!x` stay plain text for the model. Until the
  // consumer existed this returned "shell" for a lone `!` too — harmless only for as long as nothing ran it.
  if (t[0] === "!" && t.length > 1 && t[1] !== "!" && !/\s/.test(t[1]!)) return { kind: "shell", cmd: t.slice(1).trim(), mentions: [] };
  return { kind: "text", mentions: [...t.matchAll(MENTION_RE)].map((m) => m[1]!) }; // one regex for both surfaces (mentions.ts)
}

/** commands.js:24-29 — the @mention token under the cursor */
export function mentionAt(text: string, cur: number): { start: number; query: string } | null {
  const m = /(?:^|\s)@([\w./-]*)$/.exec(text.slice(0, cur));
  return m ? { start: cur - m[1]!.length - 1, query: m[1]! } : null;
}

/** commands.js:51-59 — exact path, then a unique basename, then the best fuzzy hit */
export function resolveFile(query: string, paths: readonly string[], fz: Fuzzy = fuzzy): string | null {
  if (!query) return null;
  const q = query.replace(/^@/, "");
  if (paths.includes(q)) return q;
  const byBase = paths.filter((p) => p.endsWith("/" + q) || p.split("/").pop() === q);
  if (byBase.length === 1) return byBase[0]!;
  return rank(q, paths, fz)[0] ?? null;
}

/** fuzzy-ranked copy of `items` (stable: equal scores keep their order); all items when q is empty */
function rank<T>(q: string, items: readonly T[], fz: Fuzzy, key: (t: T) => string = String): T[] {
  if (!q) return [...items];
  return items.map((it) => ({ it, m: fz(q, key(it)) })).filter((x) => x.m).sort((a, b) => b.m!.score - a.m!.score).map((x) => x.it);
}

// ------------------------------------------------------------------ commands

export interface CommandInfo { name: string; description: string; arg?: string; local?: boolean; choices?: readonly string[] | (() => readonly string[]); choicesThen?: "submit" | "complete" }
/** the argument set of an app command right now: a list as given, a function read at suggestion time */
export const choicesOf = (c: { choices?: readonly string[] | (() => readonly string[]) }): readonly string[] =>
  typeof c.choices === "function" ? c.choices() : c.choices ?? [];
interface Option { label: string; hint: string }

/** app.js:940-965 SLASH minus the mock rows; `options` feeds the argument suggestions */
export const LOCAL_COMMANDS: readonly (CommandInfo & { options?: (s: SextantState, q: string, fz: Fuzzy) => Option[] })[] = [
  { name: "help", description: "commands + keys card", local: true },
  { name: "theme", description: "switch palette", arg: "night·ember·contrast", local: true,
    options: (_s, q, fz) => rank(q, THEME_ORDER, fz).map((t) => ({ label: t, hint: THEME_HINT[t] })) },
  { name: "open", description: "open a file in the code view", arg: "path", local: true,
    options: (s, q, fz) => fileOptions(s, q, s.files.paths, fz) },
  { name: "diff", description: "diff of a file (or the current one)", arg: "path?", local: true,
    options: (s, q, fz) => { const changed = s.files.paths.filter((p) => s.files.statuses.has(p)); return fileOptions(s, q, changed.length ? changed : s.files.paths, fz); } },
  { name: "focus", description: "move keyboard focus", arg: "messages·code·files", local: true,
    options: (_s, q, fz) => rank(q, ["messages", "code", "files"], fz).map((f) => ({ label: f, hint: "" })) },
  { name: "agents", description: "the crew board (code panel ∷)", local: true },
  { name: "notices", description: "notification history (⌃b)", local: true },
  { name: "market", description: "install MCP servers, skills, plugins (⌃m)", local: true },
  { name: "context", description: "what is in the window right now, item by item (⌃g)", local: true },
];

const THEME_HINT: Record<ThemeName, string> = { night: "night + mint", ember: "ink + ember", contrast: "pure contrast" };
/** kbd hints for palette view rows and the help card */
const MODE_KBD: Partial<Record<CodeMode, string>> = { code: "⌃s", diff: "⌃d", run: "⌃r", agents: "⌃a" };

/** the prompt's command table: renderer-local rows first, then setCommands (built-ins + custom) */
export function allCommands(s: SextantState): CommandInfo[] {
  const local = new Set(LOCAL_COMMANDS.map((c) => c.name));
  return [...LOCAL_COMMANDS.map(({ name, description, arg, local: l }) => ({ name, description, arg, local: l })),
    // an app command with a fixed argument set shows it the way a local one does ("auto·off·low·medium·high")
    // a fixed set reads like a local command's ("auto·off·low·medium·high"); a live one is named, not listed
    ...s.commands.filter((c) => !local.has(c.name)).map((c) => {
      if (!c.choices) return { name: c.name, description: c.description };
      const arg = typeof c.choices === "function" ? "provider/model" : c.choices.join("·");
      return { name: c.name, description: c.description, arg, choices: c.choices, ...(c.choicesThen ? { choicesThen: c.choicesThen } : {}) };
    })];
}

/** app.js:966-970 — top 6 fuzzy-ranked files with their git status as the hint */
export function fileOptions(s: SextantState, q: string, pool: readonly string[], fz: Fuzzy = fuzzy): Option[] {
  return rank(q, pool, fz).slice(0, 6).map((p) => ({ label: p, hint: s.files.statuses.get(p) ?? "" }));
}

// ------------------------------------------------------------------ suggestions (app.js:973-1003)

export interface Suggestion {
  kind: "slash" | "arg" | "mention";
  label: string;
  hint: string;
  /** argument placeholder shown dim after a slash command */
  arg?: string;
  /** what Tab does: the completed prompt text and cursor */
  apply: { text: string; cur: number };
  /** what Enter does after applying: "submit" the completed line, or only "complete" it
   *  (a mention, or a command that still needs its argument) */
  enter: "submit" | "complete";
}

/** rows the box can show — keys.ts wraps ↑↓ over exactly these, so the cap lives here alone.
 *  Raised from 8 when /market made the local list eight long: at 8 a bare `/` showed nothing BUT the
 *  renderer-local commands, and the app's own (/exit, /model, /effort…) fell off the box entirely. */
export const MAX_SUGGESTIONS = 10;

/** the dropdown above the prompt, at most MAX_SUGGESTIONS rows; [] when nothing applies
 *  (overlays, cards, empty or free text) */
export function suggestions(s: SextantState, files: readonly string[], fz: Fuzzy = fuzzy): Suggestion[] {
  return suggestionRows(s, files, fz).slice(0, MAX_SUGGESTIONS);
}

function suggestionRows(s: SextantState, files: readonly string[], fz: Fuzzy): Suggestion[] {
  if (s.palette || s.help || s.card) return [];
  const text = s.input.text;
  if (!text.trim()) return [];
  const men = mentionAt(text, s.input.cur);
  if (men) {
    return fileOptions(s, men.query, files, fz).map((o) => ({
      kind: "mention", label: o.label, hint: o.hint, enter: "complete",
      apply: { text: text.slice(0, men.start) + "@" + o.label + " " + text.slice(s.input.cur), cur: men.start + o.label.length + 2 },
    }));
  }
  const p = parseInput(text);
  if (p.kind !== "slash") return [];
  if (p.arg === undefined) {
    return rank(p.cmd ?? "", allCommands(s), fz, (c) => c.name).map((c) => {
      const needsArg = c.arg !== undefined && !c.arg.endsWith("?");
      const t = "/" + c.name + (c.arg ? " " : "");
      return { kind: "slash", label: "/" + c.name, hint: c.description, arg: c.arg, apply: { text: t, cur: t.length }, enter: needsArg ? "complete" : "submit" };
    });
  }
  const c = LOCAL_COMMANDS.find((x) => x.name === p.cmd);
  if (c?.options) {
    return c.options(s, p.arg, fz).map((o) => {
      const t = "/" + c.name + " " + o.label;
      return { kind: "arg", label: o.label, hint: o.hint, apply: { text: t, cur: t.length }, enter: "submit" };
    });
  }
  // an app command with a fixed argument set (/effort auto|off|low|medium|high): the same rows, ranked by what is typed
  const app = allCommands(s).find((x) => x.name === p.cmd && x.choices);
  const values = app ? choicesOf(app) : [];
  if (!app || !values.length) return [];
  // a subcommand-style set ("complete") leaves the prompt open with a trailing space for the next word
  const complete = app.choicesThen === "complete";
  return rank(p.arg, values, fz).map((label) => {
    const t = "/" + app.name + " " + label + (complete ? " " : "");
    return { kind: "arg", label, hint: "", apply: { text: t, cur: t.length }, enter: complete ? "complete" : "submit" };
  });
}

const st = (fg: number, bg = -1, a = 0): Style => ({ fg, bg, a });
const ENTER: KeyEvent = { type: "key", name: "enter" };

/** app.js:1004-1023 — the box sits just above the prompt line inside the messages panel `rect`;
 *  `sugs` is the `suggestions()` list (already capped); a row click selects it and replays Enter
 *  (HitZone.key). Painting never writes the state: the highlight is clamped locally. */
export function drawSuggest(scr: ScreenLike, rect: Rect, s: SextantState, sugs: readonly Suggestion[], C: Theme, hits?: HitZone[]): void {
  if (!sugs.length || s.input.sgSel < 0) return;
  const selected = Math.min(s.input.sgSel, sugs.length - 1);
  const kind = sugs[0]!.kind, cmd = parseInput(s.input.text).cmd;
  const title = kind === "mention" ? "mention a file" : kind === "slash" ? "commands"
    : `/${cmd} · ${allCommands(s).find((c) => c.name === cmd)?.arg ?? ""}`;
  const w = Math.min(rect.w - 4, 76), x = rect.x + 2, h = sugs.length + 3, y0 = Math.max(rect.y + 1, rect.y + rect.h - 3 - h);
  scr.box(x, y0, w, h, st(C.rule2), C.bg2);
  scr.text(x + 2, y0 + 1, [[title, st(C.dim, C.bg2)]]);
  const help = kind === "mention" ? "tab insert" : "tab complete  ⏎ run";
  scr.put(x + w - 2 - help.length, y0 + 1, help, st(C.dim, C.bg2));
  sugs.forEach((it, i) => {
    const y = y0 + 2 + i, sel = i === selected;
    const segs: [string, Style][] = [[sel ? "▸ " : "  ", st(C.accent, C.bg2)], [it.label, st(sel ? C.fg : C.fg2, C.bg2, sel ? ATTR.BOLD : 0)]];
    if (it.arg) segs.push([" " + it.arg, st(C.dim, C.bg2)]);
    scr.text(x + 2, y, segs, w - 4);
    if (it.hint) { const hw = Math.min(it.hint.length, 34); scr.clip(x + w - 2 - hw, y, it.hint, st(C.muted, C.bg2), hw); }
    hits?.push({ rect: { x, y, w, h: 1 }, onClick: () => { s.input.sgSel = i; }, key: ENTER });
  });
}

// ------------------------------------------------------------------ palette (app.js:1097-1156)

const GROUPS = ["commands", "theme", "view", "open"];
type PaletteItem = PaletteState["items"][number];

/** groups: commands (local + setCommands), theme, view (code modes + focus), open (every file) */
export function paletteItems(s: SextantState): PaletteItem[] {
  const items: PaletteItem[] = allCommands(s).map((c) => ({ label: "/" + c.name, group: "commands", action: "/" + c.name }));
  for (const t of THEME_ORDER) items.push({ label: `theme ${t}`, group: "theme", action: `theme:${t}` });
  const views: [string, CodeMode][] = [["code view", "code"], ["diff view", "diff"], ["run output", "run"], ["agents board", "agents"]];
  for (const [label, mode] of views) items.push({ label, group: "view", action: `mode:${mode}` });
  for (const f of ["messages", "code", "files"]) items.push({ label: `focus ${f}`, group: "view", action: `focus:${f}` });
  for (const p of s.files.paths) items.push({ label: p, group: "open", action: `open:${p}` });
  return items;
}

/** The overlays that can be on screen, and the one rule about them: at most one at a time.
 *
 *  Nothing enforced that before — help, the palette and the market each wrote their own field, so ⌃m with
 *  the help card up left BOTH set and help painted over a market nobody could reach. The fix is one
 *  transition instead of three closers: every opener calls `openOverlay` first, and an opener that forgets
 *  is caught by the invariant test rather than by a reader six months later.
 *
 *  ADDING A FIFTH: add its field to `closeOthers` below and its name here. That is the whole contract —
 *  do not write closing lines into your own opener, or the next one will forget one of them. */
export type OverlayKind = "palette" | "market" | "help" | "context" | "wizard";

/** close every overlay except `keep` (pass null to close them all). The single place that knows the set. */
export function openOverlay(s: SextantState, keep: OverlayKind | null): void {
  if (keep !== "palette") s.palette = null;
  if (keep !== "market") s.market = null;
  if (keep !== "help") s.help = false;
  if (keep !== "context") s.context = null;
  if (keep !== "wizard") s.wizard = null;
}

/** which overlays are currently set — the invariant test asserts this is never longer than one */
export function openOverlays(s: SextantState): OverlayKind[] {
  const out: OverlayKind[] = [];
  if (s.palette) out.push("palette");
  if (s.market) out.push("market");
  if (s.help) out.push("help");
  if (s.context) out.push("context");
  if (s.wizard) out.push("wizard");
  return out;
}

/** the help card, through the one transition (local-commands /help and anything else that opens it) */
export function openHelp(s: SextantState): void {
  openOverlay(s, "help");
  s.help = true;
}

export function openPalette(s: SextantState, items: PaletteItem[] = paletteItems(s), title?: string): void {
  openOverlay(s, "palette");
  s.palette = { query: "", sel: 0, items, ...(title !== undefined ? { title } : {}) };
}
export function closePalette(s: SextantState): void { s.palette = null; }

/** The notification history (⌃b, /notices): the palette box titled "notifications", newest first,
 *  one row per Notice with its clock as the hint. Read-only rows — Enter just closes (the "noop:"
 *  action is ignored by runAction). Opening marks everything read, which clears the frame badge.
 *  Reuses the palette rather than adding a fourth overlay: same box, same keys, nothing new to learn. */
export function openNotices(s: SextantState, now: number = Date.now()): void {
  const items = [...s.notices].reverse().map((n) => ({
    label: `${n.tone === "error" ? "✗" : n.tone === "warn" ? "◆" : "·"} ${n.text}`,
    group: "notices",
    action: "noop:",
    hint: agoLabel(now - n.at),
  }));
  markNoticesRead(s);
  openPalette(s, items.length ? items : [{ label: "no notifications yet", group: "notices", action: "noop:", hint: "" }], "notifications");
}

/** "just now" · "12s" · "3m" · "2h" — the age of a notice, coarse on purpose */
export function agoLabel(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  return `${Math.round(sec / 3600)}h`;
}

/** the rows the query leaves: no query = everything with `open` capped at 6; otherwise fuzzy
 *  hits, best first inside each group, groups in their fixed order (app.js:1112-1118) */
export function paletteVisible(p: PaletteState, fz: Fuzzy = fuzzy): PaletteItem[] {
  const q = p.query.trim();
  if (!q) { let open = 0; return p.items.filter((it) => it.group !== "open" || open++ < 6); }
  return rank(q, p.items, fz, (it) => it.label).sort((a, b) => GROUPS.indexOf(a.group) - GROUPS.indexOf(b.group));
}

/** right-aligned hint: command description, theme label, key chord, or git status */
export function paletteHint(s: SextantState, it: PaletteItem): string {
  if (it.hint !== undefined) return it.hint; // an explicit hint wins, as PaletteState says it does
  if (it.action.startsWith("/")) return allCommands(s).find((c) => "/" + c.name === it.action)?.description ?? "";
  const i = it.action.indexOf(":"), kind = it.action.slice(0, i), rest = it.action.slice(i + 1);
  switch (kind) {
    case "theme": return THEME_HINT[rest as ThemeName] ?? "";
    case "mode": return MODE_KBD[rest as CodeMode] ?? "";
    case "focus": return rest === "files" ? "⌃e" : "";
    case "open": return s.files.statuses.get(rest) ?? "";
    default: return "";
  }
}

/** app.js:1122-1156 — returns the cursor cell (after the query). Hits: full-screen close, the box
 *  (swallows), each row (select + Enter). */
export function drawPalette(scr: ScreenLike, L: Layout, C: Theme, s: SextantState, fz: Fuzzy = fuzzy, hits?: HitZone[]): { x: number; y: number } | null {
  const P = s.palette;
  if (!P) return null;
  hits?.push({ rect: { x: 0, y: 0, w: L.w, h: L.h }, onClick: () => closePalette(s) });
  const vis = paletteVisible(P, fz);
  P.sel = Math.max(0, Math.min(P.sel, vis.length - 1));
  const list: ({ type: "group"; name: string } | { type: "item"; it: PaletteItem; idx: number })[] = [];
  let g = "";
  vis.forEach((it, idx) => { if (it.group !== g) { g = it.group; list.push({ type: "group", name: g }); } list.push({ type: "item", it, idx }); });
  const pw = Math.min(72, L.w - 10), px = Math.floor((L.w - pw) / 2);
  const maxList = Math.max(3, Math.min(list.length || 1, Math.floor(L.h / 2)));
  const ph = maxList + 5, py = Math.max(2, Math.floor(L.h * 0.14));
  scr.box(px, py, pw, ph, st(C.accent), C.bg2);
  // the box says what it is. A picker's title comes from the caller, so it is CLIPPED to the box —
  // leaving room for the corner and the `esc` label — rather than trusted to fit (an unclipped
  // sentence ran past the right border and over the panel behind it).
  const boxTitle = ` ${P.title ?? "commands"} `;
  scr.clip(px + 2, py, boxTitle, st(C.accent, -1, ATTR.BOLD), Math.max(0, pw - 4));
  hits?.push({ rect: { x: px, y: py, w: pw, h: ph }, onClick: () => {} });
  scr.put(px + 2, py + 1, "▌", st(C.accent, C.bg2));
  if (P.query) scr.put(px + 4, py + 1, P.query, st(C.fg, C.bg2, ATTR.BOLD), pw - 12);
  else scr.put(px + 4, py + 1, P.title === undefined ? "commands, themes, views, files…" : "type to filter…", st(C.dim, C.bg2), pw - 12);
  scr.put(px + pw - 6, py + 1, "esc", st(C.dim, C.bg2));
  scr.hline(px + 1, py + 2, pw - 2, st(C.rule2, C.bg2), "╌");
  const selRow = list.findIndex((r) => r.type === "item" && r.idx === P.sel);
  const off = selRow >= maxList - 1 ? selRow - maxList + 2 : 0;
  if (!list.length) scr.put(px + 4, py + 3, "no matches", st(C.muted, C.bg2));
  for (let i = 0; i < maxList; i++) {
    const r = list[off + i];
    if (!r) break;
    const y = py + 3 + i;
    if (r.type === "group") { scr.put(px + 4, y, r.name, st(C.dim, C.bg2), pw - 6); continue; } // clipped: a group name is data too
    const sel = r.idx === P.sel;
    scr.text(px + 2, y, [[sel ? "▸ " : "  ", st(C.accent, C.bg2)], [r.it.label, st(sel ? C.fg : C.fg2, C.bg2, sel ? ATTR.BOLD : 0)]], pw - 30);
    const hint = paletteHint(s, r.it);
    if (hint) scr.clip(px + pw - 3 - Math.min(hint.length, 24), y, hint, st(C.muted, C.bg2), 24);
    hits?.push({ rect: { x: px, y, w: pw, h: 1 }, onClick: () => { P.sel = r.idx; }, key: ENTER });
  }
  return { x: px + 4 + P.query.length, y: py + 1 };
}

/** app.js:1564-1574 minus ⌃c (keys.ts handles it before delegating): Esc/⌃k/⌃p close, ↑↓ wrap,
 *  Enter closes then runs the selected action through `run`, backspace/typing edit the query */
export function onPaletteKey(s: SextantState, ev: KeyEvent, run: (action: string) => void, fz: Fuzzy = fuzzy): void {
  const P = s.palette;
  if (!P) return;
  const { name, ctrl, alt, ch } = ev;
  if (name === "escape" || (ctrl && (name === "k" || name === "p"))) { closePalette(s); return; }
  const vis = paletteVisible(P, fz), n = Math.max(1, vis.length);
  if (name === "up") { P.sel = (P.sel - 1 + n) % n; return; }
  if (name === "down") { P.sel = (P.sel + 1) % n; return; }
  if (name === "enter") { const it = vis[P.sel]; closePalette(s); if (it) run(it.action); return; }
  if (name === "backspace") { P.query = [...P.query].slice(0, -1).join(""); P.sel = 0; return; } // by code point (😀 is one)
  const c = name === "space" ? " " : ch;
  if (c && !ctrl && !alt) { P.query += c; P.sel = 0; }
}

// ------------------------------------------------------------------ help card (app.js:1075-1089)

/** the README keys table with rovecode names */
export const HELP_KEYS: readonly (readonly [string, string])[] = [
  ["⏎", "send · confirm a card · run the suggestion"],
  ["tab ⇧tab", "complete a suggestion · cycle focus"],
  ["esc esc", "stop the run (the first esc warns)"],
  ["⌃c", "quit (interrupts a run first)"],
  ["⌃k ⌃p", "command palette"],
  ["⌃s ⌃d ⌃r", "code · diff · run view"],
  ["⌃a", "agents board"],
  ["⌃e", "files panel"],
  ["⌃o", "next tab (narrow terminal)"],
  ["⌃b", "notifications"],
  ["⌃m", "market (install servers, skills, plugins)"],
  ["⌃g", "context (what is in the window, and how far our count is from the provider’s)"],
  ["⌥d", "market: the selected item's documentation"],
  ["⌃v", "paste image · drop a file to attach"],
  ["⌃t", "next theme"],
  ["⌃n", "new session (/new)"],
  ["⌃u", "clear the prompt line"],
  ["↑↓ ←→", "files: pick · fold — code: scroll · mode — prompt: history"],
  ["⌃← ⌃→", "prompt: jump by word"],
  ["home end", "prompt: line start · end (end re-sticks the tail)"],
  ["pgup pgdn", "scroll messages · end sticks to the tail"],
  ["mouse", "click · wheel · drag a scrollbar — drag over the chat to select and copy it"],
  ["@file", "mention a file (picker)"],
];

/** [name, description, arg] per command: local rows first, then setCommands */
export function helpRows(s: SextantState): [string, string, string][] {
  return allCommands(s).map((c) => ["/" + c.name, c.description, c.arg ?? ""]);
}

/** centered card; the command column is cut to the height with an "… N more" row; any click closes */
export function drawHelp(scr: ScreenLike, L: Layout, C: Theme, s: SextantState, hits?: HitZone[]): void {
  const rows = helpRows(s);
  const w = Math.min(L.w - 8, 112), wide = w >= 110;
  const maxRows = Math.max(1, L.h - 8);
  const shown = rows.length > maxRows ? [...rows.slice(0, maxRows - 1), ["…", `${rows.length - maxRows + 1} more · /help lists all`, ""] as [string, string, string]] : rows;
  // the KEYS column is capped by the same rule as the commands column. It used not to be, because it was
  // shorter than every terminal anyone tried — and then the box height took the max of the two, so adding
  // one chord pushed the bottom border past the frame on a 30-row terminal. A list that grows is a list
  // that has to be cut somewhere.
  const keys: (readonly [string, string])[] = HELP_KEYS.length > maxRows
    ? [...HELP_KEYS.slice(0, maxRows - 1), ["…", `${HELP_KEYS.length - maxRows + 1} more`] as [string, string]]
    : [...HELP_KEYS];
  const h = Math.max(shown.length, keys.length) + 6, x = Math.floor((L.w - w) / 2), y = Math.max(1, Math.floor((L.h - h) / 2));
  scr.box(x, y, w, h, st(C.accent), C.bg2);
  scr.text(x + 2, y, [[" help ", st(C.accent, -1, ATTR.BOLD)]]);
  scr.put(x + w - 14, y, " esc closes ", st(C.dim));
  const kx = wide ? x + 70 : x + 50;
  scr.put(x + 3, y + 2, "commands", st(C.muted, C.bg2)); scr.put(kx, y + 2, "keys", st(C.muted, C.bg2));
  shown.forEach(([name, desc, arg], i) => {
    const yy = y + 3 + i;
    scr.put(x + 3, yy, name, st(C.accent, C.bg2), 13); scr.put(x + 17, yy, desc, st(C.fg2, C.bg2), wide ? 28 : 30);
    if (wide && arg) scr.put(x + 46, yy, arg, st(C.dim, C.bg2), 22);
  });
  keys.forEach(([a, b], i) => {
    const yy = y + 3 + i;
    scr.put(kx, yy, a, st(C.fg, C.bg2, ATTR.BOLD), 10); scr.put(kx + 11, yy, b, st(C.fg2, C.bg2), w - (kx - x) - 13);
  });
  scr.put(x + 3, y + h - 2, "plain text and !commands reach the agent as typed · @file attaches the file as a read (400 lines, 8 files)", st(C.dim, C.bg2), w - 6);
  hits?.push({ rect: { x: 0, y: 0, w: L.w, h: L.h }, onClick: () => { s.help = false; } });
}
