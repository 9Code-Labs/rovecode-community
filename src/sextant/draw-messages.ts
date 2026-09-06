/** Sextant surface (port #42) — the MESSAGES panel: user / assistant / tool / steer / compaction /
 *  system rows, the ONE modal card (approval or ask_user question) pinned above the ╌ rule, and the
 *  prompt line with its cursor cell. Ported from the user's own sextant v0.4.0 prototype,
 *  src/app.js:561-672 (toolRow, buildRows, drawMessages); the mock welcome/"try" rows, permission
 *  items and click hit-boxes are gone — rows come from SextantState.messages, the card from
 *  SextantState.card, the agent label reads "rovecode". Pure painter: no clock, no timers, no state
 *  mutation; the prototype's msgScroll write-back became the `messagesScroll` seam. */

import type { CardState, Rect, ScreenLike, Seg, SextantState, Theme, ToolRow } from "./types.ts";
import { ATTR } from "./types.ts";
import { moreMarker } from "../coding/diff.ts";
import { inner, panel, spinner, st, wrap } from "./draw-util.ts";
import { clipText } from "./tool-rows.ts";
import { segWidth } from "./layout.ts";
import { fmtElapsed, fmtK } from "./model.ts";
import { thinkingWord } from "./pet.ts";
import { scrollbar } from "./scrollbar.ts";

/** one painted line of the transcript; `path` marks a tool row that names a file (message-hits.ts opens it on click) */
export interface Row { segs: Seg[]; indent?: number; path?: string }

/** 1-slot cache: buildRows is called twice per frame (once in drawMessages, once in messagesScroll).
 *  Within a single frame now/w/theme are constant and messages is the same array, so the second call
 *  is always a cache hit. Keyed by array identity + length (cheap mutation guard) + w + theme.name + now. */
let _rowsCache: { msgs: readonly unknown[]; len: number; w: number; name: string; now: number; rows: Row[] } | null = null;
export function cachedBuildRows(s: SextantState, w: number, theme: Theme, now: number): Row[] {
  if (_rowsCache && _rowsCache.msgs === s.messages && _rowsCache.len === s.messages.length
      && _rowsCache.w === w && _rowsCache.name === theme.name && _rowsCache.now === now) {
    return _rowsCache.rows;
  }
  const rows = buildRows(s, w, theme, now);
  _rowsCache = { msgs: s.messages, len: s.messages.length, w, name: theme.name, now, rows };
  return rows;
}

/** the attachment cap the chip row quotes (core/images.ts MAX_IMAGES_PER_MESSAGE; a literal here keeps this painter free of node:fs) */
const MAX_STAGED_HINT = 8;
/** prompt placeholder when the input is empty */
export const PLACEHOLDER = "ask rovecode — e.g. fix the failing test";
/** button label per verdict — `all edits` reads as the mode it turns on, not as a third yes */
export const VERDICT_LABEL: Record<"once" | "always" | "all-edits" | "deny", string> =
  { once: "allow", always: "always", "all-edits": "all edits", deny: "deny" };
/** the default row, for a card that offers no extra door */
export const VERDICTS: readonly string[] = ["allow", "always", "deny"];
export const FREE_TEXT_HINT = "type an answer…";
export const SKIP_LABEL = "skip this question";
/** the longest question shown in the card (wrapped rows) before it is elided */
const MAX_QUESTION_ROWS = 6;

const VERB_GLYPH: Record<string, string> = { read: "·", edit: "~", write: "+", remove: "−", run: "$", search: "⌕", fetch: "↗", task: "»" };
/** the label shrinks to this many cells before a detail that would still fit whole is touched (app.js) */
const LABEL_MIN = 8;
/** when the detail must be clipped instead, the label keeps up to this many cells (all of a shorter one) */
const LABEL_KEEP = 24;
/** a text detail that would keep fewer cells than this says nothing — dropped instead of clipped */
const DETAIL_MIN = 6;

/** cells a string takes: one per code point (types.ts) — `.length` would count an emoji twice */
const cells = (s: string): number => [...s].length;
const segCells = (segs: readonly Seg[]): number => segs.reduce((n, [s]) => n + cells(s), 0);

/** `<glyph> <verb> <label>` with the detail right-aligned: `· read x … N lines`, `~ edit x +a −b`,
 *  `$ run cmd … last line`; the spinner replaces the glyph while the call runs (app.js:561-571).
 *  A failed edit shows its rejection detail, never the +a −b it did not apply. When label and detail
 *  do not both fit, the label yields first (down to LABEL_MIN cells, the prototype's rule); when even
 *  that leaves no room, a TEXT detail is clipped with `…` beside a label kept at up to LABEL_KEEP cells
 *  — a rejection's reason stays on the row at the frame's 160×44 message width instead of vanishing;
 *  the `+a −b` pair is dropped whole when it cannot fit. */
export function toolRow(t: ToolRow, w: number, theme: Theme, now: number): Seg[] {
  const failed = !t.running && t.ok === false;
  const g = t.running ? spinner(now) : VERB_GLYPH[t.verb] ?? "·";
  const gc = t.running ? theme.accent : failed ? theme.err : "~+−".includes(g) ? theme.fg2 : theme.dim;
  const verb = ((t.verb === "other" ? t.tool : t.verb) + " ").padEnd(7); // always ≥1 space before the label (ask_user, todo_write, MCP names)
  const detail: Seg[] = [];
  if (t.verb === "edit" && !failed && (t.add || t.del)) {
    if (t.add) detail.push([`+${t.add}`, st(theme.ok)]);
    if (t.del) detail.push([`${t.add ? " " : ""}−${t.del}`, st(theme.err)]);
  } else if (t.detail) detail.push([(t.verb === "edit" ? "" : "… ") + t.detail, st(failed ? theme.err : theme.muted)]);
  let dw = segCells(detail);
  let label = t.label;
  const room = w - 2 - verb.length; // cells for label + gap + detail
  let labelMax = room;
  if (dw) {
    const keep = Math.min(cells(label), LABEL_KEEP);
    if (room - dw - 2 >= Math.min(cells(label), LABEL_MIN)) labelMax = room - dw - 2; // both fit once the label is clipped
    else if (detail.length === 1 && room - keep - 2 >= DETAIL_MIN) { // clip the text detail beside the kept label
      const [text, style] = detail[0]!;
      detail[0] = [clipText(text, room - keep - 2), style];
      labelMax = keep; dw = segCells(detail);
    } else { detail.length = 0; dw = 0; }
  }
  if (cells(label) > labelMax) label = labelMax > 1 ? [...label].slice(0, labelMax - 1).join("") + "…" : "";
  const segs: Seg[] = [[g + " ", st(gc)], [verb, st(t.running ? theme.fg2 : theme.muted)], [label, st(t.running ? theme.fg : failed ? theme.err : theme.fg2)]];
  if (detail.length) segs.push([" ".repeat(Math.max(1, w - 2 - verb.length - cells(label) - dw)), st(-1)], ...detail);
  return segs;
}

/** the status word after `◆ rovecode ·` for the current run: `needs you` while a card waits (the frame
 *  header's word, draw-frame.ts), else the live activity while running, else the outcome */
export function activityLabel(s: SextantState, now?: number): string {
  if (s.card) return "needs you";
  const a = s.activity;
  // a provider turn with no text yet: the word rotates with the clock so the eye can tell live from frozen
  if (s.running) return now !== undefined && a.turnAt !== undefined && a.state === "THINKING" ? thinkingWord(now - a.turnAt) : a.label || a.state.toLowerCase();
  switch (a.state) {
    case "SUCCESS": return "done";
    case "ERROR": return "error";
    case "WAITING": return "needs you";
    case "IDLE": return "";
    default: return a.label || a.state.toLowerCase();
  }
}

/** `  14s · 1.2k tokens` for the provider turn in flight — proof the run is alive while the model
 *  is silent (a reasoning phase runs 15 s and more at high effort). The clock starts at turn_start,
 *  the count is reasoning plus answer tokens so far. Degrades in steps to fit `room`: the token count
 *  goes first, then the clock, so a narrow panel never overflows. Empty when no turn is in flight. */
export function liveTail(s: SextantState, now: number, room: number): string {
  const a = s.activity;
  if (a.turnAt === undefined) return "";
  const clock = fmtElapsed(now - a.turnAt);
  const full = a.tokens ? `  ${clock} · ${fmtK(a.tokens)} tokens` : `  ${clock}`;
  if ([...full].length <= room) return full;
  const short = `  ${clock}`;
  return [...short].length <= room ? short : "";
}

/** `@path` mentions in a user line get the accent (app.js:596) */
function mentionSegs(line: string, theme: Theme): Seg[] {
  return line.split(/(@[\w./\\-]+)/).filter(Boolean).map((part): Seg => [part, part[0] === "@" ? st(theme.accent, -1, ATTR.BOLD) : st(theme.fg, -1, ATTR.BOLD)]);
}

/** Flatten s.messages into drawable rows for a panel `w` cells wide (app.js:572-637). Each run
 *  (the rows after a user row) opens with a `◆ rovecode · <status>` header before its first row of any
 *  kind — a permission refusal can be the first thing a run says; the current run carries the live
 *  status, earlier ones just the diamond. System/compaction rows outside a run (idle notes before
 *  any user row) get no header. */
export function buildRows(s: SextantState, w: number, theme: Theme, now: number): Row[] {
  const rows: Row[] = [];
  const blank = (): void => { rows.push({ segs: [] }); };
  const iw = Math.max(1, w - 2);
  let lastUser = -1;
  s.messages.forEach((m, i) => { if (m.kind === "user") lastUser = i; });
  let prev: SextantState["messages"][number] | null = null;
  let headerDue = true;
  let inRun = s.running; // a live run, or the rows after a user row
  const outcome = s.activity.state === "SUCCESS" ? theme.ok : s.activity.state === "ERROR" ? theme.err : theme.accentDim;
  const header = (i: number): void => {
    const current = i > lastUser;
    const label = current ? activityLabel(s, now) : "";
    const dc = !current ? theme.accentDim : s.running ? theme.accent : outcome;
    const segs: Seg[] = [["◆ ", st(dc)], ["rovecode", st(theme.fg, -1, ATTR.BOLD)], [label ? "  · " + label : "", st(s.running ? theme.accent : theme.muted)]];
    if (current && s.running && !s.card) { const tail = liveTail(s, now, w - segWidth(segs)); if (tail) segs.push([tail, st(theme.muted)]); }
    rows.push({ segs });
    headerDue = false;
  };
  s.messages.forEach((m, i) => {
    switch (m.kind) {
      case "user": {
        if (prev) blank();
        const last = i === lastUser;
        rows.push({ segs: [["you", st(last ? theme.accent : theme.muted)], [last ? "  · sent" : "", st(theme.accentDim)]] });
        for (const l of wrap(m.text, iw)) rows.push({ segs: mentionSegs(l, theme), indent: 2 });
        if (m.images?.length) rows.push({ segs: m.images.flatMap((name): Seg[] => [[` ▣ ${name} `, st(theme.fg2, theme.selBg)], ["  ", st(-1)]]), indent: 2 });
        // one chip per @file attached (mentions.ts): the read block itself is in the session, not on screen
        if (m.files?.length) for (const f of m.files) rows.push({ segs: [[` ▤ ${f} `, st(theme.fg2, theme.selBg)]], indent: 2 });
        headerDue = true; inRun = true;
        break;
      }
      case "assistant": {
        if (headerDue) { blank(); header(i); } else if (prev && prev.kind !== "assistant") blank();
        const lines = m.text ? wrap(m.text, iw) : [];
        lines.forEach((l, k) => {
          const segs: Seg[] = [[l, st(theme.fg2)]];
          if (m.streaming && k === lines.length - 1) segs.push(["▌", st(theme.accent)]);
          rows.push({ segs, indent: 2 });
        });
        if (m.streaming && !lines.length) rows.push({ segs: [["▌", st(theme.accent)]], indent: 2 });
        break;
      }
      case "tool":
        if (headerDue) { blank(); header(i); } else if (prev && prev.kind === "assistant") blank();
        rows.push({ segs: toolRow(m, iw, theme, now), indent: 2, ...(m.path ? { path: m.path } : {}) });
        break;
      case "steer":
        if (headerDue) { blank(); header(i); } else blank();
        wrap(m.text, iw).forEach((l, k) => rows.push({ segs: [[k === 0 ? "» " : "  ", st(theme.accent)], [l, st(theme.fg)]] }));
        break;
      case "compaction":
        if (headerDue && inRun) { blank(); header(i); } else blank();
        for (const l of wrap(m.text, iw)) rows.push({ segs: [["▸ ", st(theme.accentDim)], [l, st(theme.muted, -1, ATTR.ITALIC)]] });
        break;
      case "system": {
        if (headerDue && inRun) { blank(); header(i); } else if (prev && prev.kind !== "system") blank();
        const err = m.tone === "error";
        const gc = err ? theme.err : m.tone === "warn" ? theme.warn : theme.accentDim;
        for (const l of wrap(m.text, iw)) rows.push({ segs: [[err ? "× " : "▸ ", st(gc)], [l, st(err ? theme.err : theme.muted)]] });
        break;
      }
    }
    prev = m;
  });
  // a run that has not said anything yet still shows it is alive: the header with the live line
  // is the ONLY thing between the sent prompt and a first token that may be 15 s away. Not under a
  // card — the card is the status then, and the message rows above it are budgeted to the row.
  if (headerDue && s.running && inRun && !s.card) { blank(); header(s.messages.length); }
  return rows;
}

/** row skeleton of the card: total rows and the free-text row index (question card) — the shared
 *  geometry behind `cardRows` and `promptCursor` */
export function cardShape(card: CardState, w: number, maxDetail: number): { total: number; freeText: number | null } {
  if (card.kind === "approval") {
    const n = card.detail ? detailLines(card.detail).length : 0;
    return { total: 3 + Math.min(n, Math.max(1, maxDetail)), freeText: null };
  }
  const { q, opts, freeRows } = questionRows(card, w);
  return { total: 1 + q + opts + freeRows + 2, freeText: freeRows > 0 ? 1 + q + opts : null };
}

/** the longest free-text answer shown (wrapped rows) before the head scrolls off — the tail keeps
 *  the caret and the last words in view, the way a chat box behaves */
export const MAX_FREE_TEXT_ROWS = 6;

/** Row arithmetic the question card shares between its shape, its rows, the caret and the click
 *  zones (card-hits.ts): `q` question rows (capped), `opts` option rows, and `freeRows` — the typed
 *  answer WRAPPED to the card width (Berkay: a long answer used to be clipped to one row with `…`,
 *  so the text you were typing vanished; it belongs on the next line). 0 when free text is off. */
export function questionRows(card: Extract<CardState, { kind: "question" }>, w: number): { q: number; opts: number; freeRows: number; freeLines: string[] } {
  const q = Math.min(MAX_QUESTION_ROWS, wrap(card.prompt.question, Math.max(1, w - 2)).length);
  const opts = card.prompt.options?.length ?? 0;
  if (card.prompt.allowFreeText === false) return { q, opts, freeRows: 0, freeLines: [] };
  // the hint occupies the single empty row; typed text wraps at the row width minus the `▌ ` marker
  const all = card.freeText.length === 0 ? [""] : wrap(card.freeText, Math.max(1, w - 4));
  const freeLines = all.length > MAX_FREE_TEXT_ROWS ? all.slice(all.length - MAX_FREE_TEXT_ROWS) : all;
  return { q, opts, freeRows: freeLines.length, freeLines };
}

/** the previewDiff lines worth a card row: the leading `--- a/x` / `+++ b/x` pair is dropped (the
 *  title's `<tool> <args>` already names the file); hunk headers, signed lines and markers stay */
function detailLines(detail: string): string[] {
  const all = detail.split("\n");
  return all[0]?.startsWith("--- ") && all[1]?.startsWith("+++ ") ? all.slice(2) : all;
}

/** color of one previewDiff line inside the approval card */
function diffLineStyle(l: string, theme: Theme): Seg {
  if (l.startsWith("+++") || l.startsWith("---") || l.startsWith("@@") || l.startsWith("…") || l.startsWith("\\")) return [l, st(theme.dim)];
  if (l[0] === "+") return [l, st(theme.ok)];
  if (l[0] === "-") return [l, st(theme.err)];
  return [l, st(theme.fg2)];
}

/** The modal card rows (app.js:607-616): approval = `◆ needs your permission  <tool> <args>`, the
 *  previewDiff detail bounded to `maxDetail` rows (clip marker), the verdict buttons
 *  `allow · always · deny` with the selected one inverted; question = the question, its options,
 *  the free-text row (when allowed) and `skip this question`, selection inverted the same way. */
export function cardRows(card: CardState, w: number, maxDetail: number, theme: Theme): Row[] {
  const rows: Row[] = [{ segs: [] }];
  const button = (label: string, sel: boolean): Seg => [` ${label} `, sel ? st(theme.bg, theme.accent, ATTR.BOLD) : st(theme.muted)];
  if (card.kind === "approval") {
    rows.push({ segs: [["◆ ", st(theme.warn)], ["needs your permission", st(theme.fg, -1, ATTR.BOLD)], [`   ${card.tool} ${card.argsPreview}`.trimEnd(), st(theme.fg2)]] });
    if (card.detail) {
      const all = detailLines(card.detail);
      const max = Math.max(1, maxDetail);
      const lines = all.length > max ? [...all.slice(0, max - 1), moreMarker(all.length - max + 1)] : all;
      for (const l of lines) rows.push({ segs: [diffLineStyle(l, theme)], indent: 2 });
    }
    const segs: Seg[] = [];
    card.verdicts.forEach((v, i) => { segs.push(button(VERDICT_LABEL[v], i === card.selected), ["  ", st(-1)]); });
    segs.push([" ⏎ confirm  ←→ choose  esc deny", st(theme.dim)]);
    rows.push({ segs, indent: 2 });
    return rows;
  }
  const q = wrap(card.prompt.question, Math.max(1, w - 2));
  const shown = q.length > MAX_QUESTION_ROWS ? [...q.slice(0, MAX_QUESTION_ROWS - 1), (q[MAX_QUESTION_ROWS - 1] ?? "").slice(0, Math.max(0, w - 4)) + "…"] : q;
  shown.forEach((l, k) => rows.push({ segs: [[k === 0 ? "◆ " : "  ", st(theme.warn)], [l, st(theme.fg, -1, ATTR.BOLD)]] }));
  const opts = card.prompt.options ?? [];
  opts.forEach((o, i) => rows.push({ segs: [button(o, i === card.selected)], indent: 2 }));
  const { freeRows, freeLines } = questionRows(card, w);
  const free = freeRows > 0;
  if (free) {
    const sel = card.selected === opts.length;
    // the answer wraps: `▌ ` marks the first row, continuation rows align under the text
    freeLines.forEach((line, k) => {
      const marker: Seg = [k === 0 ? "▌ " : "  ", st(sel ? theme.accent : theme.accentDim)];
      const empty = card.freeText.length === 0;
      rows.push({ segs: [marker, [empty ? FREE_TEXT_HINT : line, empty ? st(theme.dim) : st(theme.fg, -1, ATTR.BOLD)]], indent: 2 });
    });
  }
  rows.push({ segs: [button(SKIP_LABEL, card.selected === opts.length + (free ? 1 : 0))], indent: 2 });
  rows.push({ segs: [["⏎ confirm  ↑↓ choose", st(theme.dim)]], indent: 2 });
  return rows;
}

/** detail rows an approval card may take inside a message area `h` rows tall: all but the card's
 *  blank + title + buttons and two message rows (the 160×44 frame's h = 10 → 5: a small hunk whole) */
const detailBudget = (h: number): number => Math.max(2, h - 5);

/** message rows above the rule, card rows (bounded so ≥1 message row survives), rows per message area */
export function areas(B: Rect, s: SextantState): { h: number; cardH: number; msgH: number; maxDetail: number } {
  const h = Math.max(0, B.h - 2);
  const maxDetail = detailBudget(h);
  const cardH = s.card ? Math.min(cardShape(s.card, B.w, maxDetail).total, Math.max(0, h - 1)) : 0;
  return { h, cardH, msgH: h - cardH, maxDetail };
}

/** Scroll geometry for the message rows: `max` = rows that do not fit, `offset` = the row drawn
 *  first — the tail when `stick`, else s.msgScroll clamped. The renderer writes `offset` back into
 *  s.msgScroll after a frame (the prototype mutated S.msgScroll in place; a pure painter cannot). */
export function messagesScroll(rect: Rect, s: SextantState, theme: Theme, now: number): { offset: number; max: number } {
  const B = inner(rect);
  const { msgH } = areas(B, s);
  const rows = cachedBuildRows(s, B.w, theme, now);
  const max = Math.max(0, rows.length - msgH);
  return { offset: s.stick ? max : Math.max(0, Math.min(s.msgScroll, max)), max };
}

/** Where the terminal cursor belongs for the prompt (or the question card's free-text row when it
 *  is selected); null when the messages panel is not taking text (other focus, palette/help, approval). */
export function promptCursor(rect: Rect, s: SextantState): { x: number; y: number } | null {
  if (s.palette || s.help) return null;
  const B = inner(rect);
  if (B.w < 3 || B.h < 3) return null;
  const { cardH, msgH, maxDetail } = areas(B, s);
  if (s.card) {
    if (s.card.kind !== "question") return null;
    const shape = cardShape(s.card, B.w, maxDetail);
    if (shape.freeText === null || s.card.selected !== (s.card.prompt.options?.length ?? 0)) return null; // selection index = options.length is the free-text row
    // the caret sits at the end of the LAST wrapped row of the answer (questionRows keeps the tail)
    const { freeRows, freeLines } = questionRows(s.card, B.w);
    const row = shape.freeText + freeRows - 1 - (shape.total - cardH); // rows hidden when the card is clipped scroll off the top
    if (row < 0) return null;
    const last = freeLines[freeLines.length - 1] ?? "";
    return { x: Math.min(B.x + 4 + [...last].length, B.x + B.w - 1), y: B.y + msgH + row };
  }
  if (s.focus !== "messages") return null;
  const inW = B.w - 2;
  const off = Math.max(0, s.input.cur - inW + 1);
  return { x: B.x + 2 + s.input.cur - off, y: B.y + B.h - 1 };
}

/** Paint the messages panel into `rect`: frame + count, rows (scrolled), the pinned card, the ╌
 *  rule, the prompt line `▌ <text>` (placeholder when empty). Pure over its inputs. */
export function drawMessages(scr: ScreenLike, rect: Rect, s: SextantState, theme: Theme, now: number): void {
  if (rect.w < 4 || rect.h < 3) return;
  const count = s.messages.filter((m) => m.kind === "user").length;
  const focused = s.focus === "messages";
  const B = panel(scr, rect, "messages", focused, count ? [[String(count), st(theme.muted)]] : [], theme);
  const { h, cardH, msgH, maxDetail } = areas(B, s);
  if (h > 0) {
    const rows = cachedBuildRows(s, B.w, theme, now);
    const max = Math.max(0, rows.length - msgH);
    const offset = s.stick ? max : Math.max(0, Math.min(s.msgScroll, max));
    scrollbar(scr, theme, B.x + B.w - 1, B.y, msgH, rows.length, msgH, offset); // scroll-hits.ts rebuilds this geometry for the drag zone
    for (let i = 0; i < msgH; i++) {
      const r = rows[offset + i];
      if (!r) break;
      const cx = B.x + (r.indent ?? 0);
      scr.text(cx, B.y + i, r.segs, B.x + B.w - cx);
    }
    if (s.card && cardH > 0) {
      const all = cardRows(s.card, B.w, maxDetail, theme);
      const shown = all.slice(all.length - cardH); // when clipped keep the tail: the buttons must stay reachable
      shown.forEach((r, i) => { const cx = B.x + (r.indent ?? 0); scr.text(cx, B.y + msgH + i, r.segs, B.x + B.w - cx); });
    }
  }
  const py = B.y + B.h - 1;
  if (B.h >= 2) scr.hline(B.x, py - 1, B.w, st(theme.frameDim), "╌");
  // staged images ride ON the rule row as chips — visible before the message is sent, and no row is
  // taken from the transcript for them (Berkay: keep the surface simple). Clipped, oldest dropped first.
  if (B.h >= 2 && s.staged.length > 0) {
    const segs: Seg[] = [[" ", st(-1)]];
    for (const name of s.staged) segs.push([` ▣ ${name} `, st(theme.fg2, theme.selBg)], [" ", st(-1)]);
    segs.push([`${s.staged.length}/${MAX_STAGED_HINT} · enter sends · /attach clear`, st(theme.dim)]);
    scr.text(B.x, py - 1, segs, B.w);
  }
  const hasText = s.input.text.length > 0;
  scr.put(B.x, py, "▌", st(hasText || focused ? theme.accent : theme.accentDim));
  const inW = B.w - 2;
  if (inW <= 0) return;
  if (hasText) {
    const off = Math.max(0, s.input.cur - inW + 1);
    scr.put(B.x + 2, py, s.input.text.slice(off), st(theme.fg, -1, ATTR.BOLD), inW);
  } else scr.put(B.x + 2, py, PLACEHOLDER, st(theme.dim), inW);
}
