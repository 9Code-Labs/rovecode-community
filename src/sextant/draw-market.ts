/** The market overlay (/market, ⌃m): one shelf for the three kinds rovecode can install — MCP servers,
 *  skills and plugins — browsed and installed without leaving the cockpit.
 *
 *  Shape, deliberately: the same reading order as the site's market page, so the two surfaces teach each
 *  other. A tab strip (all · mcp · skill · plugin) with counts, a query line, the results on the left, and
 *  the selected row's detail on the right — what it runs, which variables it needs, what the install will
 *  write. Enter turns the detail into a PLAN card (src/market/types.ts InstallPlanView.preview, verbatim)
 *  and nothing is written until that card is confirmed: the market obeys the same see-then-approve rule the
 *  approval card does, because installing a server is running someone else's code.
 *
 *  Data comes in already resolved — `openMarket` takes rows and a status, it never fetches. That keeps this
 *  file pure over (state, screen) like every other drawer here, and it is why the empty, error and offline
 *  states are drawn from `MarketState.status` rather than guessed from an empty list: a market with no rows
 *  because the registry is down must not read like a market with no matches.
 *
 *  Hit zones follow the card-hits.ts rule — only cells that were actually painted are registered, in the
 *  order they were painted, and the frame loop walks them in reverse. */

import { st } from "./draw-util.ts";
import { strWidth } from "./screen.ts";
import { fuzzy as defaultFuzzy, openOverlay, type Fuzzy } from "./overlays.ts";
import { ATTR, type HitZone, type KeyEvent, type Layout, type ScreenLike, type SextantState, type Theme } from "./types.ts";

/** the synthetic key a click carries, as overlays.ts does it */
const ENTER: KeyEvent = { type: "key", name: "enter" };

/** the kinds, in the order the tab strip shows them */
export const MARKET_TABS = ["all", "mcp", "skill", "plugin"] as const;
export type MarketTab = (typeof MARKET_TABS)[number];

/** One row as the overlay draws it. A flattened view of src/market/types.ts MarketRow: the adapter
 *  (market-source.ts) maps that type onto this one, so this file never imports the market module and the
 *  drawer stays testable with plain objects. */
export interface MarketViewRow {
  id: string;
  kind: "mcp" | "skill" | "plugin";
  title: string;
  publisher: string;
  description: string;
  version?: string;
  /** the command, endpoint or path this row runs once installed */
  runs: string;
  /** variables the install will ask for or write as ${NAME}; `secret` draws a lock */
  env: { name: string; required: boolean; secret: boolean; description?: string }[];
  /** other ways in the catalog offers (a remote endpoint beside a local runtime) */
  alternatives?: string[];
  /** values only the human can supply (a directory to expose, a database URL) */
  pending?: string[];
  /** present when it is on this machine — MarketRow.installed, flattened */
  installed?: { path: string; scope: "user" | "project"; version?: string; updateAvailable?: boolean; trusted?: boolean };
  /** the npm package spec when the row starts through `npx <package>` — the install-once offer
   *  (mcp/local-package.ts) has something to say about this row; absent = no offer, Enter goes to the plan */
  localOffer?: string;
  /** the item's own documentation, already made safe for a terminal: no escape sequences, no control
   *  characters, markdown flattened to kinds a cockpit can draw. Absent = the catalog carries none, which
   *  is a quiet state and not an error. */
  docs?: { source: string; truncated: boolean; lines: MarketDocLine[] };
}

/** one line of a document as the overlay draws it */
export interface MarketDocLine { kind: "head" | "text" | "code" | "blank" | "rule"; text: string }

/** why the list is what it is; the three not-ready states are drawn differently on purpose */
export type MarketStatus =
  | { kind: "ready" }
  | { kind: "loading" }
  /** rows came from a cache or the curated shelf because the network was not reached */
  | { kind: "offline"; note: string }
  /** a source failed; `reason` is src/market/types.ts SourceStatus.reason, printed as it came */
  | { kind: "error"; reason: string };

/** the plan the human must see before anything is written (InstallPlanView, flattened) */
export interface MarketPlan {
  /** the row this plan was built for — the installer uses THIS, never the current selection */
  row: MarketViewRow;
  title: string;
  target: string;
  scope: "user" | "project";
  preview: string[];
  asks: { name: string; required: boolean; secret: boolean }[];
  pending: string[];
  replaces?: string;
  /** the human chose "install once" on the chooser card: this plan was drawn for `node <bin>`, and the
   *  install must run with the same answer — the card is the plan that runs, never a re-derivation */
  local?: boolean;
  /** set once the confirmed install has answered */
  outcome?: { ok: boolean; text: string };
  /** true while runInstall is in flight */
  running?: boolean;
}

/** the install-once chooser (mcp/local-package.ts), open over the list BEFORE the plan card for a row that
 *  starts through npx: the same question the CLI asks on a terminal and /mcp asks as a pick. `sel` 0 =
 *  install once, 1 = npx at every start, as today. Enter asks for the plan with that answer; Esc backs out. */
export interface MarketChoice { row: MarketViewRow; sel: 0 | 1 }
export const CHOICE_LINES: readonly { label: string; hint: string }[] = [
  { label: "install once — node starts it in ~0.4 s", hint: "npm install runs now, AFTER the plan is approved: the package's code lands under ~/.rovecode/mcp (typically 20–30 MB, once); no network needed to start" },
  { label: "run through npx at every start — as today", hint: "~2 s per start, re-resolves the package and asks the npm registry each time; nothing is installed now" },
];

export interface MarketState {
  tab: MarketTab;
  query: string;
  sel: number;
  rows: MarketViewRow[];
  status: MarketStatus;
  /** notes worth showing once (MarketResult.notes) */
  notes: string[];
  /** the plan card, open over the list until it is confirmed or dismissed */
  plan: MarketPlan | null;
  /** the install-once chooser, open between Enter on an npx row and its plan card */
  choice: MarketChoice | null;
  /** alt+d opens the selected row's documentation in the detail column; ↑↓ then scroll it */
  docs: boolean;
  docScroll: number;
  /** body rows the pane last painted, so the keys can clamp the scroll to what actually fits */
  docRows: number;
}

export function openMarket(s: SextantState, rows: MarketViewRow[], status: MarketStatus = { kind: "ready" }, notes: string[] = []): void {
  openOverlay(s, "market"); // one overlay at a time; the transition lives in overlays.ts
  s.market = { tab: "all", query: "", sel: 0, rows, status, notes, plan: null, choice: null, docs: false, docScroll: 0, docRows: 12 };
}
export function closeMarket(s: SextantState): void { s.market = null; }

/** rows the tab and the query leave, best match first when there is a query */
export function marketVisible(m: MarketState, fz: Fuzzy = defaultFuzzy): MarketViewRow[] {
  const byTab = m.rows.filter((r) => m.tab === "all" || r.kind === m.tab);
  const q = m.query.trim();
  if (!q) return byTab;
  return byTab
    .map((r) => ({ r, hit: fz(q, `${r.title} ${r.id} ${r.publisher} ${r.description}`) }))
    .filter((x): x is { r: MarketViewRow; hit: { score: number; idx: number[] } } => x.hit !== null)
    .sort((a, b) => b.hit.score - a.hit.score)
    .map((x) => x.r);
}

/** counts for the tab strip — of the whole catalog, not of the filtered list, so switching tabs is
 *  predictable while a query is typed */
export function marketCounts(m: MarketState): Record<MarketTab, number> {
  return {
    all: m.rows.length,
    mcp: m.rows.filter((r) => r.kind === "mcp").length,
    skill: m.rows.filter((r) => r.kind === "skill").length,
    plugin: m.rows.filter((r) => r.kind === "plugin").length,
  };
}

/** the badge a row carries on the right of the list: nothing when it is not installed */
export function rowBadge(r: MarketViewRow): { text: string; tone: "ok" | "warn" | "info" } | null {
  if (!r.installed) return null;
  if (r.installed.updateAvailable) return { text: "update", tone: "warn" };
  if (r.installed.scope === "project" && r.installed.trusted === false) return { text: "not approved", tone: "warn" };
  return { text: "installed", tone: "ok" };
}

/** the sentence the empty / offline / error states print, so the three never read alike */
export function statusLine(m: MarketState, visible: number): { text: string; tone: "muted" | "warn" | "err" } | null {
  if (m.status.kind === "loading") return { text: "reading the catalogs…", tone: "muted" };
  if (m.status.kind === "error") return { text: m.status.reason, tone: "err" };
  if (m.status.kind === "offline") return { text: m.status.note, tone: "warn" };
  if (visible === 0) {
    return m.query.trim() || m.tab !== "all"
      ? { text: `nothing matches${m.query.trim() ? ` "${m.query.trim()}"` : ""}${m.tab !== "all" ? ` in ${m.tab}` : ""}`, tone: "muted" }
      : { text: "the catalog is empty", tone: "muted" };
  }
  return null;
}

const KIND_LABEL: Record<string, string> = { mcp: "mcp", skill: "skill", plugin: "plugin" };

// ------------------------------------------------------------------ painting

/** the plan card: the whole write, in the human's words, over the list. Enter installs, esc backs out. */
function drawPlan(scr: ScreenLike, L: Layout, C: Theme, m: MarketState, hits?: HitZone[]): void {
  const p = m.plan;
  if (!p) { if (m.choice) drawChoice(scr, L, C, m, hits); return; }
  const w = Math.min(76, L.w - 8);
  const lines = [
    ...p.preview,
    ...(p.replaces ? [`replaces ${p.replaces}`] : []),
    ...p.asks.map((a) => `asks ${a.name}${a.secret ? " (secret, masked)" : ""}${a.required ? "" : " — optional"}`),
    ...p.pending.map((x) => `you supply ${x}`),
  ];
  const h = Math.min(L.h - 4, lines.length + 7);
  const x = Math.floor((L.w - w) / 2), y = Math.max(1, Math.floor((L.h - h) / 2));
  scr.box(x, y, w, h, st(C.accent), C.bg2);
  scr.text(x + 2, y, [[" install plan ", st(C.accent, -1, ATTR.BOLD)]]);
  scr.clip(x + 3, y + 1, p.title, st(C.fg, C.bg2, ATTR.BOLD), w - 6);
  scr.clip(x + 3, y + 2, `${p.scope} scope · ${p.target}`, st(C.muted, C.bg2), w - 6);
  scr.hline(x + 1, y + 3, w - 2, st(C.rule2, C.bg2), "╌");
  lines.slice(0, h - 6).forEach((line, i) => scr.clip(x + 3, y + 4 + i, line, st(C.fg2, C.bg2), w - 6));
  const footY = y + h - 2;
  if (p.outcome) {
    scr.clip(x + 3, footY, p.outcome.text, st(p.outcome.ok ? C.ok : C.err, C.bg2), w - 6);
    hits?.push({ rect: { x, y, w, h }, onClick: () => { m.plan = null; } });
    return;
  }
  if (p.running) {
    scr.put(x + 3, footY, "installing…", st(C.muted, C.bg2));
    hits?.push({ rect: { x, y, w, h }, onClick: () => {} });
    return;
  }
  scr.text(x + 3, footY, [
    ["⏎ install", st(C.accent, C.bg2, ATTR.BOLD)],
    ["   esc cancel", st(C.dim, C.bg2)],
  ], w - 6);
  hits?.push({ rect: { x, y, w, h }, onClick: () => {} });
  hits?.push({ rect: { x: x + 3, y: footY, w: 9, h: 1 }, onClick: () => {}, key: ENTER });
}

/** the chooser card: two ways to start an npx server, the trade under each, Enter picks, esc backs out. It
 *  is not the gate — the plan card that follows is — so it writes nothing and runs nothing itself. */
function drawChoice(scr: ScreenLike, L: Layout, C: Theme, m: MarketState, hits?: HitZone[]): void {
  const c = m.choice;
  if (!c) return;
  const w = Math.min(84, L.w - 8);
  const inner = w - 6;
  const rows: { text: string; sel: boolean; head: boolean }[] = [];
  CHOICE_LINES.forEach((o, i) => {
    rows.push({ text: `${i === c.sel ? "●" : "○"} ${o.label}`, sel: i === c.sel, head: true });
    for (const l of wrap(o.hint, inner - 4)) rows.push({ text: `    ${l}`, sel: false, head: false });
  });
  const h = Math.min(L.h - 4, rows.length + 6);
  const x = Math.floor((L.w - w) / 2), y = Math.max(1, Math.floor((L.h - h) / 2));
  scr.box(x, y, w, h, st(C.accent), C.bg2);
  scr.text(x + 2, y, [[" how to start it ", st(C.accent, -1, ATTR.BOLD)]]);
  scr.clip(x + 3, y + 1, `${c.row.title} · ${c.row.localOffer ?? c.row.runs}`, st(C.fg, C.bg2, ATTR.BOLD), inner);
  scr.hline(x + 1, y + 2, w - 2, st(C.rule2, C.bg2), "╌");
  let optionIndex = -1;
  rows.slice(0, h - 5).forEach((r, i) => {
    const yy = y + 3 + i;
    scr.clip(x + 3, yy, r.text, r.head ? st(r.sel ? C.accent : C.fg, C.bg2, r.sel ? ATTR.BOLD : 0) : st(C.muted, C.bg2), inner);
    if (r.head) {
      optionIndex += 1;
      const pick = optionIndex as 0 | 1;
      hits?.push({ rect: { x: x + 3, y: yy, w: inner, h: 1 }, onClick: () => { c.sel = pick; } }); // a click selects; Enter still decides
    }
  });
  scr.text(x + 3, y + h - 2, [["↑↓ choose   ⏎ show the plan", st(C.accent, C.bg2, ATTR.BOLD)], ["   esc back", st(C.dim, C.bg2)]], inner);
  hits?.push({ rect: { x, y, w, h }, onClick: () => {} });
}

/** the detail column: everything the row promises, in the order a reader asks for it */
function drawDetail(scr: ScreenLike, x: number, y: number, w: number, h: number, C: Theme, r: MarketViewRow): void {
  let yy = y;
  const line = (text: string, style: ReturnType<typeof st>, gap = 0) => {
    if (yy >= y + h) return;
    yy += gap;
    if (yy >= y + h) return;
    scr.clip(x, yy, text, style, w);
    yy += 1;
  };
  scr.text(x, yy, [[r.title, st(C.fg, C.bg2, ATTR.BOLD)], [r.version ? `  ${r.version}` : "", st(C.dim, C.bg2)]], w);
  yy += 1;
  line(r.publisher, st(C.muted, C.bg2));
  // the description wraps by word inside the column — a one-line clip loses the half that matters
  for (const part of wrap(r.description, w).slice(0, 4)) line(part, st(C.fg2, C.bg2));
  line("what it runs", st(C.dim, C.bg2), 1);
  for (const part of wrap(r.runs, w).slice(0, 3)) line(part, st(C.fg, C.bg2));
  for (const alt of (r.alternatives ?? []).slice(0, 2)) line(`also ${alt}`, st(C.dim, C.bg2));
  line("environment", st(C.dim, C.bg2), 1);
  if (r.env.length === 0) line("nothing — it needs no key", st(C.fg2, C.bg2));
  for (const v of r.env.slice(0, 4)) {
    line(`${v.name}${v.secret ? " · secret" : ""}${v.required ? "" : " · optional"}`, st(v.secret ? C.warn : C.fg, C.bg2));
    if (v.description) for (const part of wrap(v.description, w - 2).slice(0, 2)) line(`  ${part}`, st(C.muted, C.bg2));
  }
  if ((r.pending ?? []).length) {
    line("you supply", st(C.dim, C.bg2), 1);
    for (const p of r.pending!.slice(0, 3)) line(p, st(C.fg2, C.bg2));
  }
  line("where it lands", st(C.dim, C.bg2), 1);
  line(r.installed ? r.installed.path : "shown in the plan before anything is written", st(C.fg2, C.bg2));
  if (r.installed) line(`${r.installed.scope} scope${r.installed.version ? ` · ${r.installed.version}` : ""}${r.installed.trusted === false ? " · not approved here" : ""}`, st(C.muted, C.bg2));
}

/** The documentation pane: the item's own text, scrolled in the detail column. Every line was made safe at
 *  build time (market-docs.mjs docsToLines) — no escape sequences, no control characters — so a document
 *  cannot paint the cockpit. Headings and code keep their shape; nothing else is interpreted. */
export function docMaxScroll(r: MarketViewRow | undefined, rows: number): number {
  return Math.max(0, (r?.docs?.lines.length ?? 0) - Math.max(1, rows));
}

/** Re-wrap the document to the column it is actually drawn in.
 *
 *  `docLines` wraps at a fixed 96 columns, but the detail column is `w = x + boxW - 2 - detailX` and
 *  tops out around 65 even on the widest box the overlay will draw — so every prose line longer than
 *  the column was hard-clipped by `scr.clip`, and the clipped part was simply gone. Not a narrow-
 *  terminal corner case: it fired on every terminal, for most paragraphs of a real README.
 *
 *  Wrapping belongs here rather than at fetch time for a second reason — the terminal can be resized
 *  while the pane is open, and a width decided when the document was read is wrong the moment it is.
 *  Prose re-wraps on words; code is chunked instead, because breaking a command on a space would show
 *  the reader something they could copy and run that is not what the document said. */
export function rewrap(lines: readonly MarketDocLine[], w: number): MarketDocLine[] {
  if (w < 8) return [...lines];
  const out: MarketDocLine[] = [];
  for (const line of lines) {
    if (line.kind === "text") {
      if (line.text.length <= w) { out.push(line); continue; }
      let cur = "";
      for (const word of line.text.split(/\s+/).filter(Boolean)) {
        const piece = word.length > w ? word.slice(0, w) : word;
        if (!cur) { cur = piece; continue; }
        if (cur.length + 1 + piece.length <= w) cur += ` ${piece}`;
        else { out.push({ kind: "text", text: cur }); cur = piece; }
      }
      if (cur) out.push({ kind: "text", text: cur });
    } else if (line.kind === "code" && line.text.length > w) {
      for (let i = 0; i < line.text.length; i += w) out.push({ kind: "code", text: line.text.slice(i, i + w) });
    } else out.push(line);
  }
  return out;
}

function drawDocs(scr: ScreenLike, x: number, y: number, w: number, h: number, C: Theme, r: MarketViewRow, scroll: number): number {
  const lines = rewrap(r.docs?.lines ?? [], w);
  if (lines.length === 0) {
    scr.clip(x, y, `documentation · ${r.title}`, st(C.fg, C.bg2, ATTR.BOLD), w);
    scr.clip(x, y + 2, "reading…", st(C.muted, C.bg2), w);
    return 0;
  }
  // two rows of heading above, one row of position below: the body gets what is left
  const body = Math.max(1, h - 4);
  const max = Math.max(0, lines.length - body);
  const off = Math.max(0, Math.min(scroll, max));
  scr.clip(x, y, `documentation · ${r.title}`, st(C.fg, C.bg2, ATTR.BOLD), w);
  scr.clip(x, y + 1, r.docs?.source ?? "", st(C.dim, C.bg2), w);
  for (let i = 0; i < body; i++) {
    const line = lines[off + i];
    if (!line) break;
    const yy = y + 2 + i;
    if (line.kind === "head") scr.clip(x, yy, line.text, st(C.accent, C.bg2, ATTR.BOLD), w);
    else if (line.kind === "code") scr.clip(x, yy, line.text, st(C.fg2, C.selBg), w);
    else if (line.kind === "rule") scr.hline(x, yy, Math.min(w, 24), st(C.rule2, C.bg2), "╌");
    else if (line.kind === "text") scr.clip(x, yy, line.text, st(C.fg2, C.bg2), w);
  }
  // where you are, and whether there is more of it upstream
  const more = off < max ? `${off + body}/${lines.length}` : `${lines.length}/${lines.length}`;
  const tail = r.docs?.truncated ? `${more} · the rest is at the source` : more;
  scr.clip(x, y + h - 1, tail, st(C.dim, C.bg2), w);
  return max;
}

/** greedy word wrap; a word longer than the column is cut rather than allowed to overflow */
export function wrap(text: string, w: number): string[] {
  if (w <= 0) return [];
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const piece = word.length > w ? word.slice(0, w) : word;
    if (!line) { line = piece; continue; }
    if (strWidth(line) + 1 + strWidth(piece) <= w) line += ` ${piece}`;
    else { out.push(line); line = piece; }
  }
  if (line) out.push(line);
  return out;
}

/** The overlay. Returns the cursor cell (after the query) so the frame loop can park the caret there. */
export function drawMarket(scr: ScreenLike, L: Layout, C: Theme, s: SextantState, fz: Fuzzy = defaultFuzzy, hits?: HitZone[]): { x: number; y: number } | null {
  const m = s.market;
  if (!m) return null;
  // Clicking the backdrop closes the overlay — except while an install is running. The keyboard has
  // refused that since the plan card was written ("an install in flight cannot be dismissed"), but the
  // guard lived only in the key handler, so a click anywhere outside the plan box walked away from a
  // write that was still happening, and the outcome was then discarded on arrival. Same rule, both
  // input devices: the write is happening whatever the surface does, so the surface stays.
  hits?.push({ rect: { x: 0, y: 0, w: L.w, h: L.h }, onClick: () => { if (!m.plan?.running) closeMarket(s); } });

  // the box follows its content: a five-row catalog does not need thirty rows of empty night. The floor
  // keeps the detail column readable, the ceiling keeps the cockpit visible behind it.
  // The box follows its content, but the floor is set by the DETAIL column, not the list: a five-row
  // catalog still has to show what a row runs, what it needs and where it lands without cutting the last
  // heading off. 20 rows is that column at its longest (four wrapped description lines, four variables).
  const bodyRows = Math.max(m.rows.length + 6, 20);
  const w = Math.min(L.w - 6, 120), h = Math.max(12, Math.min(L.h - 4, 30, bodyRows));
  const x = Math.floor((L.w - w) / 2), y = Math.max(1, Math.floor((L.h - h) / 2));
  scr.box(x, y, w, h, st(C.accent), C.bg2);
  scr.text(x + 2, y, [[" market ", st(C.accent, -1, ATTR.BOLD)]]);
  scr.put(x + w - 14, y, " esc closes ", st(C.dim));
  hits?.push({ rect: { x, y, w, h }, onClick: () => {} });

  // the tab strip, with the whole catalog's counts
  const counts = marketCounts(m);
  let tx = x + 3;
  for (const tab of MARKET_TABS) {
    const label = `${tab === "all" ? "all" : KIND_LABEL[tab]} ${counts[tab]}`;
    const on = m.tab === tab;
    scr.put(tx, y + 1, label, st(on ? C.accent : C.muted, C.bg2, on ? ATTR.BOLD : 0));
    hits?.push({ rect: { x: tx, y: y + 1, w: strWidth(label), h: 1 }, onClick: () => { m.tab = tab; m.sel = 0; } });
    tx += strWidth(label) + 3;
  }

  // the query line
  scr.put(x + 3, y + 2, "▌", st(C.accent, C.bg2));
  if (m.query) scr.put(x + 5, y + 2, m.query, st(C.fg, C.bg2, ATTR.BOLD), w - 12);
  else scr.put(x + 5, y + 2, "type to search the market…", st(C.dim, C.bg2), w - 12);
  scr.hline(x + 1, y + 3, w - 2, st(C.rule2, C.bg2), "╌");

  const vis = marketVisible(m, fz);
  m.sel = Math.max(0, Math.min(m.sel, Math.max(vis.length - 1, 0)));
  const listW = Math.max(24, Math.floor((w - 5) * 0.42));
  const detailX = x + 3 + listW + 2;
  const detailW = x + w - 2 - detailX;
  const rowsH = h - 6;

  const state = statusLine(m, vis.length);
  if (state && vis.length === 0) {
    const tone = state.tone === "err" ? C.err : state.tone === "warn" ? C.warn : C.muted;
    for (const [i, part] of wrap(state.text, w - 8).slice(0, 3).entries()) scr.clip(x + 4, y + 5 + i, part, st(tone, C.bg2), w - 8);
    if (m.status.kind === "error") scr.clip(x + 4, y + 9, "the curated shelf still works offline · esc closes", st(C.dim, C.bg2), w - 8);
    drawPlan(scr, L, C, m, hits);
    return { x: x + 5 + strWidth(m.query), y: y + 2 };
  }

  // a status that still has rows (offline, stale cache) is said once above the list, not instead of it
  let listY = y + 4;
  if (state && vis.length > 0) {
    scr.clip(x + 3, listY, state.text, st(state.tone === "err" ? C.err : C.warn, C.bg2), w - 6);
    listY += 1;
  }
  const maxRows = Math.max(1, y + h - 2 - listY);
  const off = m.sel >= maxRows ? m.sel - maxRows + 1 : 0;
  for (let i = 0; i < maxRows; i++) {
    const r = vis[off + i];
    if (!r) break;
    const yy = listY + i;
    const sel = off + i === m.sel;
    if (sel) scr.tint(x + 2, yy, listW + 2, 1, C.selBg);
    const badge = rowBadge(r);
    const badgeW = badge ? strWidth(badge.text) + 1 : 0;
    // the same three facts, in the same order, as the web card: kind, title, publisher
    scr.text(x + 2, yy, [
      [sel ? "▸ " : "  ", st(C.accent, sel ? C.selBg : C.bg2)],
      [`${KIND_LABEL[r.kind]} `.padEnd(7), st(C.dim, sel ? C.selBg : C.bg2)],
      [r.title, st(sel ? C.fg : C.fg2, sel ? C.selBg : C.bg2, sel ? ATTR.BOLD : 0)],
      [`  ${r.publisher}`, st(C.dim, sel ? C.selBg : C.bg2)],
    ], listW - badgeW);
    if (badge) scr.put(x + 3 + listW - badgeW, yy, badge.text, st(badge.tone === "ok" ? C.ok : badge.tone === "warn" ? C.warn : C.info, sel ? C.selBg : C.bg2));
    const idx = off + i;
    // a click may not reach a row while the plan card is up: the card is a decision, not a backdrop
    if (!m.plan) hits?.push({ rect: { x: x + 2, y: yy, w: listW + 2, h: 1 }, onClick: () => { m.sel = idx; }, key: ENTER });
  }

  scr.vline(detailX - 2, listY, rowsH, st(C.rule2, C.bg2), "│");
  const current = vis[m.sel];
  const detailH = y + h - 2 - listY;
  if (current && m.docs && current.docs) { m.docRows = Math.max(1, detailH - 4); drawDocs(scr, detailX, listY, detailW, detailH, C, current, m.docScroll); }
  else if (current) drawDetail(scr, detailX, listY, detailW, detailH, C, current);

  // the foot: what Enter will do, said before it is pressed
  const docsKey = current?.docs ? (m.docs ? " · d closes the docs" : " · ⌥d docs") : "";
  const foot = current
    ? m.docs
      ? `↑↓ scroll${docsKey} · esc closes`
      : current.installed && !current.installed.updateAvailable
        ? `⏎ install again · ↑↓ move · ⇥ next kind${docsKey} · esc closes`
        : `⏎ install · ↑↓ move · ⇥ next kind${docsKey} · esc closes`
    : "↑↓ move · ⇥ next kind · esc closes";
  scr.clip(x + 3, y + h - 1, foot, st(C.dim), w - 6);

  drawPlan(scr, L, C, m, hits);
  return { x: x + 5 + strWidth(m.query), y: y + 2 };
}

// ------------------------------------------------------------------ keys

/** What a key press asked the app to do. The overlay never installs anything itself: it asks, and the
 *  renderer (which owns src/market/) answers by writing back into `plan`. */
export type MarketRequest =
  /** `local` = the chooser's answer for an npx row (true: install once); absent = no offer was made */
  | { kind: "plan"; row: MarketViewRow; local?: boolean }
  | { kind: "install"; plan: MarketPlan }
  /** the pane opened on a row whose body has not been read yet (search carries metadata, not bodies) */
  | { kind: "docs"; row: MarketViewRow }
  | { kind: "none" };

/** Enter on a row: a row that starts through npx gets the chooser first (the same question the CLI and /mcp
 *  ask), every other row goes straight to its plan. Either way nothing is written until the plan card. */
function askOrPlan(m: MarketState, row: MarketViewRow): MarketRequest {
  if (row.localOffer !== undefined) { m.choice = { row, sel: 0 }; return { kind: "none" }; }
  return { kind: "plan", row };
}

/** Esc closes (the plan card first), ↑↓ move, ⇥/⇧⇥ cycle the kind, Enter asks for the plan and then
 *  confirms it, typing edits the query. Returns what the renderer must do next. */
export function onMarketKey(s: SextantState, ev: KeyEvent, fz: Fuzzy = defaultFuzzy): MarketRequest {
  const m = s.market;
  if (!m) return { kind: "none" };
  const { name, ctrl, alt, ch } = ev;

  if (m.plan) {
    const p = m.plan;
    // an install in flight cannot be dismissed: the write is happening whatever the card does, and a
    // card that vanishes mid-write tells the human "nothing happened" while something did. Wait for it.
    if (p.running) return { kind: "none" };
    if (name === "escape" || (ctrl && name === "c")) { m.plan = null; return { kind: "none" }; }
    if (name === "enter") {
      if (p.outcome) { m.plan = null; return { kind: "none" }; } // a finished plan: Enter just dismisses it
      p.running = true;
      return { kind: "install", plan: p };
    }
    return { kind: "none" };
  }

  // the install-once chooser: the answer decides which plan is drawn; nothing runs here. Esc backs out to
  // the list — no plan, no install, exactly as if Enter had not been pressed.
  if (m.choice) {
    const c = m.choice;
    if (name === "escape" || (ctrl && name === "c")) { m.choice = null; return { kind: "none" }; }
    if (name === "up" || name === "down") { c.sel = c.sel === 0 ? 1 : 0; return { kind: "none" }; }
    if (name === "enter") { m.choice = null; return { kind: "plan", row: c.row, local: c.sel === 0 }; }
    return { kind: "none" };
  }

  if (name === "escape" || (ctrl && name === "m")) {
    // esc backs out of the documentation first, then closes the overlay — one step at a time
    if (m.docs) { m.docs = false; m.docScroll = 0; return { kind: "none" }; }
    closeMarket(s);
    return { kind: "none" };
  }
  const vis = marketVisible(m, fz);
  const n = Math.max(1, vis.length);
  const current = vis[m.sel];
  // `d` opens the selected row's documentation, and closes it again; a row without docs says so once
  // the docs key is alt+d, not a bare d: d is the first letter of "docker", "deepwiki" and "docs",
  // and a shortcut that eats a search letter is a shortcut in the wrong place
  if (ch === "d" && alt && !ctrl) {
    if (m.docs) { m.docs = false; m.docScroll = 0; return { kind: "none" }; }
    if (!current?.docs) return { kind: "none" };
    m.docs = true;
    m.docScroll = 0;
    // the list knows a document EXISTS; the body is read on demand, so ask for it the first time
    return current.docs.lines.length === 0 ? { kind: "docs", row: current } : { kind: "none" };
  }
  // ⇥ means "next kind" everywhere, so it closes an open document rather than doing nothing inside it
  if (name === "tab" || name === "shift-tab") {
    const i = MARKET_TABS.indexOf(m.tab);
    const step = name === "tab" ? 1 : MARKET_TABS.length - 1;
    m.tab = MARKET_TABS[(i + step) % MARKET_TABS.length]!;
    m.sel = 0;
    m.docs = false;
    m.docScroll = 0;
    return { kind: "none" };
  }
  if (m.docs) {
    if (ch === "d" && !ctrl && !alt) { m.docs = false; m.docScroll = 0; return { kind: "none" }; }
    // the pane owns the arrows while it is open; the list selection stays where it was
    if (name === "up") { m.docScroll = Math.max(0, m.docScroll - 1); return { kind: "none" }; }
    if (name === "down") { m.docScroll = Math.min(m.docScroll + 1, docMaxScroll(current, m.docRows)); return { kind: "none" }; }
    if (name === "pageup") { m.docScroll = Math.max(0, m.docScroll - 12); return { kind: "none" }; }
    if (name === "pagedown") { m.docScroll = Math.min(m.docScroll + 12, docMaxScroll(current, m.docRows)); return { kind: "none" }; }
    if (name === "home") { m.docScroll = 0; return { kind: "none" }; }
    if (name === "end") { m.docScroll = docMaxScroll(current, m.docRows); return { kind: "none" }; }
    if (name === "enter") return current ? askOrPlan(m, current) : { kind: "none" };
    return { kind: "none" }; // typing does not filter while a document is being read
  }
  if (name === "up") { m.sel = (m.sel - 1 + n) % n; return { kind: "none" }; }
  if (name === "down") { m.sel = (m.sel + 1) % n; return { kind: "none" }; }
  if (name === "pageup") { m.sel = Math.max(0, m.sel - 10); return { kind: "none" }; }
  if (name === "pagedown") { m.sel = Math.min(n - 1, m.sel + 10); return { kind: "none" }; }
  if (name === "home") { m.sel = 0; return { kind: "none" }; }
  if (name === "end") { m.sel = n - 1; return { kind: "none" }; }
  if (name === "enter") {
    const row = vis[m.sel];
    return row ? askOrPlan(m, row) : { kind: "none" };
  }
  if (name === "backspace") { m.query = [...m.query].slice(0, -1).join(""); m.sel = 0; return { kind: "none" }; }
  const c = name === "space" ? " " : ch;
  if (c && !ctrl && !alt) { m.query += c; m.sel = 0; }
  return { kind: "none" };
}
