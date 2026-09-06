/** The context overlay (/context, ⌃g): what is in the window right now, item by item, and how far our
 *  arithmetic is from the provider's own count.
 *
 *  Same reading order as `rovecode context` on a shell (src/cli/context-cmd.ts) so the two surfaces teach
 *  each other rather than competing: the meter, the slices largest first, drift, then what was billed. The
 *  one thing this surface can do that the CLI cannot is count the SYSTEM PROMPT and the TOOL SCHEMAS from
 *  the live runtime — headless has to leave them out, and in a fresh session they are most of the window.
 *  When they are missing the panel says the total is a floor rather than quietly under-reporting.
 *
 *  Like draw-market.ts this file owns FLAT view types and never imports core/context-report.ts: the adapter
 *  (context-source.ts) maps the report onto `ContextState`, so the drawer is a pure function of its own data
 *  and a test builds a state by hand.
 *
 *  Drift is drawn, not hidden. Compaction fires on OUR estimate, so a model whose real prompt is a fifth
 *  bigger than we think gets compacted late; past the tolerance the row is painted as a warning and says
 *  which way the meter is wrong. No reported usage yet says exactly that instead of a confident zero. */

import { st } from "./draw-util.ts";
import { strWidth } from "./screen.ts";
import { openOverlay } from "./overlays.ts";
import { ATTR, type HitZone, type KeyEvent, type Layout, type ScreenLike, type SextantState, type Theme } from "./types.ts";

export interface ContextSliceRow {
  label: string;
  tokens: number;
  /** 0..1 of the estimated total */
  share: number;
  /** "not supplied" and the like — printed dim after the numbers */
  note?: string;
}

export interface ContextDriftRow {
  estimated: number;
  reported: number;
  /** reported − estimated; positive means the real prompt is bigger than we think */
  delta: number;
  /** |delta| / reported, 0..1 */
  fraction: number;
  beyondTolerance: boolean;
}

export interface ContextState {
  model: string;
  /** what o200k actually counted, BEFORE the per-model correction. Kept beside `estimated` rather than
   *  replaced by it: a silently corrected number is not a measurement, and someone comparing this panel
   *  with `rovecode context` or with a provider dashboard needs to know which of the two they are reading. */
  raw: number;
  /** the correction applied to `raw` to get `estimated`, and where its factor came from */
  scale: { factor: number; measured: boolean; note: string };
  /** the catalog's window; absent when the model is not in the catalog */
  window?: number;
  estimated: number;
  remaining?: number;
  /** estimated / window, 0..1 */
  fraction?: number;
  nearLimit?: boolean;
  slices: ContextSliceRow[];
  /** images cannot be estimated in tokens; counted so the meter's silence is explained */
  images: number;
  drift?: ContextDriftRow;
  billed: { input: number; output: number; cacheRead: number; cacheWrite: number };
  costUsd?: number;
  unpricedTurns: number;
  /** the runtime supplied the system prompt and the tool schemas, so the total is complete */
  live: boolean;
  /** the tolerance drift was compared against, as a fraction — printed, never assumed by the reader */
  tolerance: number;
  scroll: number;
}

/** Open it through the ONE transition (overlays.ts openOverlay), like every other overlay: whatever was
 *  open closes first, so the help card can never paint over this and swallow its keys. */
export function openContext(s: SextantState, state: Omit<ContextState, "scroll">): void {
  openOverlay(s, "context");
  s.context = { ...state, scroll: 0 };
}
export function closeContext(s: SextantState): void { s.context = null; }

const n = (v: number): string => v.toLocaleString("en-US");
const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;

/** the meter, with the CLI's glyphs so a screenshot of one reads as the other */
export function meterBar(fraction: number, width: number): string {
  const w = Math.max(1, width);
  const filled = Math.max(0, Math.min(w, Math.round((Number.isFinite(fraction) ? Math.max(0, fraction) : 0) * w)));
  return "█".repeat(filled) + "·".repeat(w - filled);
}

/** a slice's bar, scaled to the LARGEST slice rather than to the window: at 3% of a 1M window every bar
 *  would be empty and the panel would say nothing about proportions */
export function shareBar(share: number, largest: number, width: number): string {
  if (width <= 0 || share <= 0) return "";
  const rel = largest > 0 ? share / largest : 0;
  return "▏".repeat(Math.max(1, Math.min(width, Math.round(rel * width))));
}

export type Tone = "normal" | "dim" | "warn" | "head";
export interface ContextLine { text: string; tone: Tone }

/** Every line of the overlay in order, tagged with how it is painted. Pure — a test reads these. */
export function contextLines(s: ContextState, width: number): ContextLine[] {
  const out: ContextLine[] = [];
  const inner = Math.max(24, width);
  out.push({ text: s.model, tone: "head" });

  if (s.window !== undefined) {
    const f = s.fraction ?? 0;
    out.push({ text: `${meterBar(f, Math.max(8, Math.min(28, inner - 30)))}  ~${n(s.estimated)} of ${n(s.window)} (${pct(f)})`, tone: s.nearLimit ? "warn" : "normal" });
    out.push({ text: `${n(s.remaining ?? 0)} left${s.nearLimit ? " — near the limit, compaction is due" : ""}`, tone: s.nearLimit ? "warn" : "dim" });
  } else {
    out.push({ text: `~${n(s.estimated)} tokens — this model's window is not in the catalog`, tone: "dim" });
  }
  // what the number IS, before anything else is said about it. o200k is our stand-in for every tokenizer
  // that is not OpenAI's, and the factor is measured per model generation — so the panel names both the
  // count and the correction rather than presenting one number as if nothing happened to it.
  if (s.scale.factor !== 1) {
    out.push({ text: `o200k counted ${n(s.raw)}, scaled ${s.scale.factor}× for this model — ${s.scale.note}`, tone: "dim" });
  } else {
    out.push({ text: `o200k counted ${n(s.raw)} — ${s.scale.note}`, tone: "dim" });
  }
  if (!s.live) out.push({ text: "system prompt and tool schemas are not counted — this total is a floor", tone: "warn" });
  else out.push({ text: "MCP tools are not counted — their schemas exist only once a server is connected", tone: "dim" });
  out.push({ text: "", tone: "dim" });

  const rows = [...s.slices].sort((a, b) => b.tokens - a.tokens);
  const labelW = Math.max(10, ...rows.map((r) => r.label.length));
  const largest = rows[0]?.share ?? 0;
  for (const r of rows) {
    const head = `${r.label.padEnd(labelW)}  ${n(r.tokens).padStart(9)}  ${pct(r.share).padStart(6)}`;
    const room = inner - strWidth(head) - (r.note ? r.note.length + 4 : 1);
    out.push({ text: `${head} ${shareBar(r.share, largest, Math.min(12, room))}${r.note ? `  — ${r.note}` : ""}`, tone: r.note ? "dim" : "normal" });
  }
  if (rows.length === 0) out.push({ text: "nothing in the window yet", tone: "dim" });
  if (s.images > 0) out.push({ text: `${"images".padEnd(labelW)}  ${String(s.images).padStart(9)}         — not estimated; image tokens are provider-specific`, tone: "dim" });

  out.push({ text: "", tone: "dim" });
  if (s.drift) {
    const d = s.drift;
    out.push({ text: `drift    provider counted ${n(d.reported)} for the last turn's prompt, we estimated ${n(d.estimated)}`, tone: d.beyondTolerance ? "warn" : "normal" });
    out.push({
      text: `         ${n(Math.abs(d.delta))} ${d.delta > 0 ? "more" : "less"} than we estimate (${pct(d.fraction)})${d.beyondTolerance ? ` — beyond the ${pct(s.tolerance)} tolerance; the meter reads ${d.delta > 0 ? "LOW" : "HIGH"} here` : ""}`,
      tone: d.beyondTolerance ? "warn" : "dim",
    });
  } else {
    out.push({ text: "drift    no turn reported usage yet — nothing to compare the estimate against", tone: "dim" });
  }

  out.push({ text: "", tone: "dim" });
  const b = s.billed;
  out.push({ text: `billed   ${n(b.input)} in · ${n(b.output)} out · ${n(b.cacheRead)} cache read · ${n(b.cacheWrite)} cache written`, tone: "normal" });
  out.push({
    text: s.costUsd !== undefined
      ? `cost     $${s.costUsd.toFixed(4)}${s.unpricedTurns > 0 ? ` — lower bound, ${s.unpricedTurns} turn${s.unpricedTurns > 1 ? "s" : ""} unpriced` : ""}`
      : `cost     unknown — no pricing for ${s.model}`,
    tone: s.costUsd === undefined ? "dim" : "normal",
  });
  return out;
}

/** The one row the usage panel carries. Short, because the panel is narrow — and silent (undefined) when
 *  there is nothing honest to say, rather than drawing a placeholder. */
export function driftRow(d: ContextDriftRow | undefined, tolerance: number): { text: string; warn: boolean } | undefined {
  if (!d) return undefined;
  if (!d.beyondTolerance) return { text: `est ±${pct(d.fraction)} of provider`, warn: false };
  return { text: `est reads ${d.delta > 0 ? "LOW" : "HIGH"} ${pct(d.fraction)}`, warn: true };
}

export function contextMaxScroll(s: ContextState, width: number, height: number): number {
  return Math.max(0, contextLines(s, width).length - height);
}

/** Paint the overlay. Returns null when it is closed, so the frame loop can use it in the caret ternary
 *  exactly like drawMarket. */
export function drawContext(scr: ScreenLike, L: Layout, C: Theme, s: SextantState, hits?: HitZone[]): { x: number; y: number } | null {
  const c = s.context;
  if (!c) return null;
  hits?.push({ rect: { x: 0, y: 0, w: L.w, h: L.h }, onClick: () => closeContext(s) });

  const w = Math.min(L.w - 6, 92);
  const bodyW = w - 6;
  const lines = contextLines(c, bodyW);
  const h = Math.max(10, Math.min(L.h - 4, lines.length + 4));
  const x = Math.floor((L.w - w) / 2), y = Math.max(1, Math.floor((L.h - h) / 2));
  scr.box(x, y, w, h, st(C.accent), C.bg2);
  scr.text(x + 2, y, [[" context ", st(C.accent, -1, ATTR.BOLD)]]);
  scr.put(x + w - 14, y, " esc closes ", st(C.dim));
  hits?.push({ rect: { x, y, w, h }, onClick: () => {} });

  const rows = h - 3;
  const top = Math.max(0, Math.min(Math.max(0, lines.length - rows), c.scroll));
  c.scroll = top;
  lines.slice(top, top + rows).forEach((line, i) => {
    const style = line.tone === "head" ? st(C.fg, C.bg2, ATTR.BOLD)
      : line.tone === "warn" ? st(C.warn, C.bg2)
      : line.tone === "dim" ? st(C.muted, C.bg2)
      : st(C.fg2, C.bg2);
    scr.clip(x + 3, y + 1 + i, line.text, style, bodyW);
  });
  if (lines.length > rows) {
    scr.put(x + w - 22, y + h - 1, ` ${top + rows} of ${lines.length} lines `, st(C.dim, C.bg2));
  }
  return null; // no caret: the overlay takes no typed input
}

/** Keys, while the panel is up. It is a reader, not a chooser: there is nothing to select and nothing to
 *  confirm, so the whole map is "move through it" and "leave". Anything else is swallowed rather than
 *  falling through to the prompt — an overlay that lets keystrokes reach the composer behind it types
 *  into a message the human cannot see. */
export function onContextKey(s: SextantState, ev: KeyEvent, page: number): void {
  const c = s.context;
  if (!c) return;
  const { name, ctrl } = ev;
  if (name === "escape" || name === "enter" || (ctrl && name === "g")) { closeContext(s); return; }
  const step = Math.max(1, page - 1);
  if (name === "up" || name === "k") c.scroll -= 1;
  else if (name === "down" || name === "j") c.scroll += 1;
  else if (name === "pageup") c.scroll -= step;
  else if (name === "pagedown" || name === "space") c.scroll += step;
  else if (name === "home") c.scroll = 0;
  else if (name === "end") c.scroll = Number.MAX_SAFE_INTEGER;
  c.scroll = Math.max(0, c.scroll);
}
