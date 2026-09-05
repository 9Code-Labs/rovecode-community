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
import { fuzzy as defaultFuzzy, type Fuzzy } from "./overlays.ts";
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
}

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
  title: string;
  target: string;
  scope: "user" | "project";
  preview: string[];
  asks: { name: string; required: boolean; secret: boolean }[];
  pending: string[];
  replaces?: string;
  /** set once the confirmed install has answered */
  outcome?: { ok: boolean; text: string };
  /** true while runInstall is in flight */
  running?: boolean;
}

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
}

export function openMarket(s: SextantState, rows: MarketViewRow[], status: MarketStatus = { kind: "ready" }, notes: string[] = []): void {
  s.market = { tab: "all", query: "", sel: 0, rows, status, notes, plan: null };
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
  if (!p) return;
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
  hits?.push({ rect: { x: 0, y: 0, w: L.w, h: L.h }, onClick: () => closeMarket(s) });

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
    hits?.push({ rect: { x: x + 2, y: yy, w: listW + 2, h: 1 }, onClick: () => { m.sel = idx; }, key: ENTER });
  }

  scr.vline(detailX - 2, listY, rowsH, st(C.rule2, C.bg2), "│");
  const current = vis[m.sel];
  if (current) drawDetail(scr, detailX, listY, detailW, y + h - 2 - listY, C, current);

  // the foot: what Enter will do, said before it is pressed
  const foot = current
    ? current.installed && !current.installed.updateAvailable
      ? "⏎ install again · ↑↓ move · ⇥ next kind · esc closes"
      : "⏎ install · ↑↓ move · ⇥ next kind · esc closes"
    : "↑↓ move · ⇥ next kind · esc closes";
  scr.clip(x + 3, y + h - 1, foot, st(C.dim), w - 6);

  drawPlan(scr, L, C, m, hits);
  return { x: x + 5 + strWidth(m.query), y: y + 2 };
}

// ------------------------------------------------------------------ keys

/** What a key press asked the app to do. The overlay never installs anything itself: it asks, and the
 *  renderer (which owns src/market/) answers by writing back into `plan`. */
export type MarketRequest =
  | { kind: "plan"; row: MarketViewRow }
  | { kind: "install"; plan: MarketPlan }
  | { kind: "none" };

/** Esc closes (the plan card first), ↑↓ move, ⇥/⇧⇥ cycle the kind, Enter asks for the plan and then
 *  confirms it, typing edits the query. Returns what the renderer must do next. */
export function onMarketKey(s: SextantState, ev: KeyEvent, fz: Fuzzy = defaultFuzzy): MarketRequest {
  const m = s.market;
  if (!m) return { kind: "none" };
  const { name, ctrl, alt, ch } = ev;

  if (m.plan) {
    const p = m.plan;
    if (name === "escape" || (ctrl && name === "c")) { m.plan = null; return { kind: "none" }; }
    if (p.running) return { kind: "none" };
    if (name === "enter") {
      if (p.outcome) { m.plan = null; return { kind: "none" }; } // a finished plan: Enter just dismisses it
      p.running = true;
      return { kind: "install", plan: p };
    }
    return { kind: "none" };
  }

  if (name === "escape" || (ctrl && name === "m")) { closeMarket(s); return { kind: "none" }; }
  const vis = marketVisible(m, fz);
  const n = Math.max(1, vis.length);
  if (name === "up") { m.sel = (m.sel - 1 + n) % n; return { kind: "none" }; }
  if (name === "down") { m.sel = (m.sel + 1) % n; return { kind: "none" }; }
  if (name === "pageup") { m.sel = Math.max(0, m.sel - 10); return { kind: "none" }; }
  if (name === "pagedown") { m.sel = Math.min(n - 1, m.sel + 10); return { kind: "none" }; }
  if (name === "home") { m.sel = 0; return { kind: "none" }; }
  if (name === "end") { m.sel = n - 1; return { kind: "none" }; }
  if (name === "tab" || name === "shift-tab") {
    const i = MARKET_TABS.indexOf(m.tab);
    const step = name === "tab" ? 1 : MARKET_TABS.length - 1;
    m.tab = MARKET_TABS[(i + step) % MARKET_TABS.length]!;
    m.sel = 0;
    return { kind: "none" };
  }
  if (name === "enter") {
    const row = vis[m.sel];
    return row ? { kind: "plan", row } : { kind: "none" };
  }
  if (name === "backspace") { m.query = [...m.query].slice(0, -1).join(""); m.sel = 0; return { kind: "none" }; }
  const c = name === "space" ? " " : ch;
  if (c && !ctrl && !alt) { m.query += c; m.sel = 0; }
  return { kind: "none" };
}
