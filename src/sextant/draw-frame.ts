/** Sextant frame + files + toasts painters (port #41). Ported from the user's sextant v0.4.0
 *  app.js:150-161 (glyph/stateColor/stateLabel), :209-220 (panel), :245-269 (drawFrame header +
 *  footer), :300-330 (GUIDE/drawFiles) and :1090-1096 (drawToasts); the mock repo/branch/model
 *  constants are read from SextantState. Pure: `now` is a parameter — no clocks, no timers. */

import { ATTR, SPIN } from "./types.ts";
import type { ActivityState, FileStatus, Rect, ScreenLike, Seg, SextantState, Style, Theme } from "./types.ts";
import { elapsed, fileCount, fmtClock, repoModified, treeGuides, treeRows, type Guide } from "./model.ts";

export const st = (fg: number, bg = -1, a = 0): Style => ({ fg, bg, a });
/** cells a segment list occupies (one per code point) */
export const segWidth = (segs: readonly Seg[]): number => segs.reduce((n, [t]) => n + [...t].length, 0);
const gap: Seg = [" ", undefined];

/** rounded panel with a bold title in the border (+ right-aligned extra); returns the inner rect */
export function panel(scr: ScreenLike, P: Rect, title: string, focused: boolean, extra: readonly Seg[], theme: Theme, color?: number): Rect {
  const col = color ?? (focused ? theme.accent : theme.frame);
  scr.box(P.x, P.y, P.w, P.h, st(col));
  if (title) scr.text(P.x + 2, P.y, [gap, [title, st(color ?? (focused ? theme.accent : theme.fg2), -1, ATTR.BOLD)], gap]);
  if (extra.length) {
    const ew = segWidth(extra);
    const ex = P.x + P.w - 3 - ew;
    if (ex > P.x + 4 + title.length) scr.text(ex, P.y, [gap, ...extra, gap]);
  }
  return { x: P.x + 2, y: P.y + 1, w: P.w - 4, h: P.h - 2 };
}

type Mode = "idle" | "thinking" | "active" | "waiting" | "complete" | "error";
const MODE: Record<ActivityState, Mode> = {
  IDLE: "idle", THINKING: "thinking", WRITING: "thinking", READING: "thinking",
  EDITING: "active", RUNNING: "active", TESTING: "active", DELEGATING: "active",
  WAITING: "waiting", SUCCESS: "complete", ERROR: "error",
};
const modeOf = (s: SextantState): Mode => (s.card ? "waiting" : MODE[s.activity.state]);
export const spin = (now: number, period = 140): string => SPIN[Math.floor(Math.max(0, now) / period) % SPIN.length] ?? "◆";

/** header glyph + color (app.js glyph()): spinner while working, blinking ◆ while waiting,
 *  ok/err ◆ when done, a slow accent pulse when idle */
export function activityGlyph(s: SextantState, theme: Theme, now: number): [string, number] {
  switch (modeOf(s)) {
    case "thinking": case "active": return [spin(now), theme.accent];
    case "waiting": return ["◆", Math.floor(now / 450) % 2 ? theme.warn : theme.mixDim];
    case "complete": return ["◆", theme.ok];
    case "error": return ["◆", theme.err];
    default: return ["◆", [theme.accent, theme.accentDim, theme.mixDim, theme.accentDim][Math.floor(now / 500) % 4] ?? theme.accent];
  }
}
export function activityColor(s: SextantState, theme: Theme): number {
  const m = modeOf(s);
  return m === "idle" ? theme.muted : m === "waiting" ? theme.warn : m === "complete" ? theme.ok : m === "error" ? theme.err : theme.accent;
}
/** what the header says: "needs you" over a card, else the model's activity label */
export const activityLabel = (s: SextantState): string => (s.card ? "needs you" : s.activity.label || s.activity.state.toLowerCase());

/** Outer frame: `◆ aion · repo · branch · n modified` left, glyph + activity + run clock right,
 *  key hints bottom-left, mode/yolo markers + `model · theme · vX` bottom-right. Without git the
 *  header shows the cwd basename only. */
export function drawFrame(scr: ScreenLike, L: { frame: Rect }, s: SextantState, theme: Theme, now: number): void {
  const F = L.frame;
  scr.box(F.x, F.y, F.w, F.h, st(theme.frameDim));
  const [g, gc] = activityGlyph(s, theme, now);
  const right: Seg[] = [gap, [g, st(gc)], [" " + activityLabel(s), st(activityColor(s, theme))]];
  if (s.activity.startedAt !== null) right.push(["  " + fmtClock(elapsed(s, now)), st(theme.muted)]);
  right.push(gap);
  const rw = segWidth(right);
  scr.text(F.x + F.w - 2 - rw, F.y, right);
  const dot: Seg = ["  ·  ", st(theme.dim)];
  const short: Seg[] = [gap, ["◆ ", st(theme.accent)], ["aion", st(theme.fg, -1, ATTR.BOLD)], dot, [s.repo.name, st(theme.fg2)], gap];
  const full: Seg[] = s.repo.branch === null ? short
    : [...short.slice(0, -1), dot, [s.repo.branch, st(theme.fg2)], dot, [`${repoModified(s)} modified`, st(theme.fg2)], gap];
  const avail = F.w - 4 - rw - 2;
  scr.text(F.x + 2, F.y, segWidth(full) > avail ? short : full, avail);
  // bottom: mode/yolo markers + `model · theme · vX` right; key hints left, whole hints dropped
  // (theme, diff, focus first) rather than clipped mid-word when the row is narrow
  const tag = [s.usage.model, s.theme, `v${s.version}`].filter(Boolean).join(" · ");
  const ver: Seg[] = [gap, ...(s.mode === "plan" ? [["plan mode", st(theme.warn)] as Seg, dot] : []), ...(s.yolo ? [["yolo", st(theme.warn)] as Seg, dot] : []), [tag, st(theme.dim)], gap];
  const vw = segWidth(ver);
  const armed = now < s.escUntil;
  const key = (k: string, what: string, kc = theme.fg2): Seg[] => [[k, st(kc)], [what, st(theme.muted)]];
  const hints: Seg[][] = s.running
    ? [key("esc", armed ? " again to stop" : " stop", armed ? theme.accent : theme.fg2), key("⌃k", " commands")]
    : [key("⏎", " send"), key("tab", " focus"), key("⌃k", " commands"), key("⌃d", " diff"), key("⌃t", " theme"), key("⌃c", " quit")];
  const hintsAvail = F.w - 4 - vw - 2;
  const join = (hs: Seg[][]): Seg[] => [gap, ...hs.flatMap((h, i) => (i ? [["   ", undefined] as Seg, ...h] : h)), gap];
  for (const drop of ["⌃t", "⌃d", "tab", "⌃k"]) {
    if (segWidth(join(hints)) <= hintsAvail) break;
    const i = hints.findIndex((h) => h[0]?.[0] === drop);
    if (i >= 0) hints.splice(i, 1);
  }
  scr.text(F.x + 2, F.y + F.h - 1, join(hints), hintsAvail);
  scr.text(F.x + F.w - 2 - vw, F.y + F.h - 1, ver);
}

const GUIDE: Record<Guide, string> = { bar: "│ ", tee: "├ ", end: "└ ", blank: "  " };
const statusColor = (s: FileStatus, theme: Theme): number => (s === "M" ? theme.warn : s === "A" ? theme.ok : theme.err);

/** Files tree: ▾/▸ dirs with GUIDE connectors, M/A/D at the right edge, a diamond spinner beside
 *  a touched file, `·` on a collapsed dir with changes, cursor tint when focused; scrolls to the cursor. */
export function drawFiles(scr: ScreenLike, R: Rect, s: SextantState, theme: Theme, now: number): void {
  const focused = s.focus === "files";
  const B = panel(scr, R, "files", focused, [[String(fileCount(s)), st(theme.muted)]], theme);
  const rows = treeRows(s), guides = treeGuides(rows), f = s.files;
  f.cursor = Math.max(0, Math.min(f.cursor, rows.length - 1));
  if (f.cursor < f.scroll) f.scroll = f.cursor;
  if (f.cursor >= f.scroll + B.h) f.scroll = f.cursor - B.h + 1;
  f.scroll = Math.max(0, Math.min(f.scroll, Math.max(0, rows.length - B.h)));
  for (let i = 0; i < B.h; i++) {
    const idx = f.scroll + i, r = rows[idx];
    if (!r) break;
    const y = B.y + i, isCur = idx === f.cursor, isSel = r.path === s.code.file;
    const bg = isCur && focused ? theme.selBg : -1;
    if (bg >= 0) scr.tint(B.x, y, B.w, 1, bg);
    let cx = B.x;
    for (const g of guides[idx] ?? []) cx = scr.put(cx, y, GUIDE[g], st(theme.rule2, bg));
    if (r.dir) cx = scr.put(cx, y, r.expanded ? "▾ " : "▸ ", st(theme.dim, bg));
    const nameSt = r.dir ? st(theme.fg2, bg) : r.status === "D" ? st(theme.dim, bg, ATTR.STRIKE) : isSel ? st(theme.accent, bg, ATTR.BOLD) : r.status ? st(theme.fg, bg) : st(theme.muted, bg);
    cx = scr.clip(cx, y, r.name + (r.dir ? "/" : ""), nameSt, B.x + B.w - 2 - cx - 1);
    if (!r.dir && r.touchedUntil !== undefined && r.touchedUntil > now) scr.put(cx + 1, y, spin(now), st(theme.accent, bg));
    if (!r.dir && r.status) scr.put(B.x + B.w - 1, y, r.status, st(statusColor(r.status, theme), bg));
    else if (r.dir && !r.expanded && r.hasChanges) scr.put(B.x + B.w - 1, y, "·", st(theme.dim, bg));
  }
}

/** the last three live toasts, top-right inside the frame */
export function drawToasts(scr: ScreenLike, s: SextantState, theme: Theme, now: number): void {
  s.toasts.filter((t) => t.until > now).slice(-3).forEach((t, i) => {
    const col = t.tone === "error" ? theme.err : t.tone === "warn" ? theme.warn : theme.accent;
    const x = scr.w - 4 - [...` ◆ ${t.text} `].length;
    scr.text(x, 2 + i, [[" ◆ ", st(col, theme.bg2)], [t.text + " ", st(theme.fg, theme.bg2)]]);
  });
}
