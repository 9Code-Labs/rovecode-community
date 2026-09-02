/** Port #45 — paints nimbus into its panel: a rounded frame titled `<name>  lv N  <mood>`, the cloud
 *  sprite on a 1.8 s cosine sway, weather (code drizzle while editing, lightning while running/testing,
 *  sun on success, zzz when sleepy), the storm (dark filled body, furrowed brows, red eyes, rain + bolts,
 *  panel flash, reddened border), sparkles/hearts, and a ≤2-line speech bubble — everything clipped to
 *  the panel rect. Ported from the user's own sextant v0.4.0 prototype `src/pet.js` draw() + `app.js`
 *  drawPet()/panel() (user-owned). PURE: `now` is a parameter; no timers, no unseeded randomness. */

import { ATTR, type Rect, type ScreenLike, type Seg, type SextantState, type Style, type Theme } from "./types.ts";
import { CODE_RAIN, FACE, INNER, SPRITE, moodCtxFrom, type Mood, type MoodCtx, type Pet } from "./pet.ts";

/** one full up-down sway (README: "1.8 s salınım, titreme yok") */
export const SWAY_MS = 1800;
/** a double-flicker strike every 2.6 s; the panel flashes for the first 260 ms */
export const STORM_PERIOD_MS = 2600;
export const STORM_FLASH_MS = 260;
export const SPRITE_W = 18;

const st = (fg: number, bg = -1, a = 0): Style => ({ fg, bg, a });

/** term.js mix(): linear blend of two packed 0xRRGGBB colors (theme.ts owns the shared one — port #40) */
export function mix(c1: number, c2: number, t: number): number {
  const r = Math.round(((c1 >> 16) & 255) + ((((c2 >> 16) & 255) - ((c1 >> 16) & 255)) * t));
  const g = Math.round(((c1 >> 8) & 255) + ((((c2 >> 8) & 255) - ((c1 >> 8) & 255)) * t));
  const b = Math.round((c1 & 255) + (((c2 & 255) - (c1 & 255)) * t));
  return (r << 16) | (g << 8) | b;
}

/** the click zone the input layer registers (a click anywhere in the panel pokes); null when hidden */
export function petHit(rect: Rect | null): Rect | null { return rect; }

export function moodColor(m: Mood, theme: Theme): number {
  if (m === "sunny") return theme.ok;
  if (m === "furious") return theme.err;
  if (m === "patient") return theme.warn;
  if (m === "focused" || m === "zapping" || m === "conducting") return theme.accent;
  return theme.muted;
}

/** vertical sway phase: 0 for the first half of the cosine, 1 for the second — no per-frame jitter */
export function swayBob(now: number): 0 | 1 { return Math.cos((2 * Math.PI * (now % SWAY_MS)) / SWAY_MS) < 0 ? 1 : 0; }

/** word wrap to w cells; a single over-long word is left whole (put() clips it) */
export function wrapText(text: string, w: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (!line) { line = word; continue; }
    if (line.length + 1 + word.length <= w) line += " " + word;
    else { out.push(line); line = word; }
  }
  if (line) out.push(line);
  return out;
}

/** no-op when the layout hides the pet (rect null below 34 rows, or AION_PET=0) */
export function drawPet(scr: ScreenLike, rect: Rect | null, pet: Pet, s: SextantState, theme: Theme, now: number): void {
  if (!rect || rect.w < 8 || rect.h < 4) return;
  const ctx = moodCtxFrom(s, now);
  pet.tick(now, ctx);
  const m = pet.mood(ctx, now);
  const B = panel(scr, rect, pet.state.name, pet.level(ctx.tokens), m, theme);
  drawCloud(scr, B, pet, ctx, m, theme, now);
}

/** app.js panel(): rounded box, bold title in the top border, right-aligned extras; returns the inner rect.
 *  When the row is too narrow for `lv N  mood` the level is dropped first, then the mood. */
function panel(scr: ScreenLike, R: Rect, name: string, lvl: number, m: Mood, theme: Theme): Rect {
  const furious = m === "furious";
  const col = furious ? mix(theme.bg, theme.err, 0.6) : theme.frame;
  scr.box(R.x, R.y, R.w, R.h, st(col));
  scr.text(R.x + 2, R.y, [[" ", st(-1)], [name, st(furious ? col : theme.fg2, -1, ATTR.BOLD)], [" ", st(-1)]], R.w - 3);
  const moodSeg: Seg = [m, st(moodColor(m, theme), -1, furious ? ATTR.BOLD : 0)];
  const variants: Seg[][] = [[[`lv ${lvl}`, st(theme.muted)], ["  ", st(-1)], moodSeg], [moodSeg]];
  for (const extra of variants) {
    const ew = extra.reduce((n, [t]) => n + t.length, 0);
    const ex = R.x + R.w - 3 - ew;
    if (ex > R.x + 4 + name.length) { scr.text(ex, R.y, [[" ", st(-1)], ...extra, [" ", st(-1)]]); break; }
  }
  return { x: R.x + 2, y: R.y + 1, w: R.w - 4, h: R.h - 2 };
}

function drawCloud(scr: ScreenLike, B: Rect, pet: Pet, ctx: MoodCtx, m: Mood, theme: Theme, t: number): void {
  const P = pet.state;
  const has = (k: string) => P.fx.find((f) => f.kind === k);
  const inB = (x: number, y: number) => x >= B.x && x < B.x + B.w && y >= B.y && y < B.y + B.h;
  const putSafe = (x: number, y: number, ch: string, s: Style) => { if (inB(x, y)) scr.put(x, y, ch, s); };
  const sleeping = m === "sleepy", stormy = m === "furious", sunny = m === "sunny";
  const zapping = ctx.state === "RUNNING" || ctx.state === "TESTING";
  // storm timing: a double-flicker strike every 2.6 s; the panel lights up for the first 260 ms
  let flash = false, boltCols: number[] = [];
  if (stormy) {
    const cyc = Math.floor(t / STORM_PERIOD_MS);
    flash = t % STORM_PERIOD_MS < STORM_FLASH_MS;
    boltCols = [3 + ((cyc * 7919) % 11), 3 + ((cyc * 104729 + 5) % 11)];
    if (flash) scr.tint(B.x, B.y, B.w, B.h, mix(theme.bg, theme.warn, 0.07));
  }
  // body colour: dark red outline over a ░-filled body in a storm, dim while asleep, bright while busy
  let body = theme.fg2;
  if (sunny) body = theme.fg;
  else if (stormy) body = flash ? theme.warn : mix(theme.bg, theme.err, 0.7);
  else if (sleeping) body = theme.mixDim;
  else if (ctx.state === "EDITING" || ctx.running) body = theme.fg;
  const fill = stormy ? mix(theme.bg, theme.fg, flash ? 0.35 : 0.22) : null;
  const faceFg = stormy ? theme.err : sleeping ? theme.muted : theme.fg;
  const mouthFg = stormy ? theme.fg2 : sleeping ? theme.muted : theme.fg;
  // motion: bounce fx hops every 200 ms, shiver fx jitters sideways, a strike shakes the cloud,
  // otherwise the calm 1.8 s sway (asleep: settled low)
  const bob = has("bounce") ? Math.floor(t / 200) % 2 : sleeping ? 1 : swayBob(t);
  const drift = has("shiver") ? Math.floor(t / 160) % 2 : flash ? 1 : 0;
  const sx = B.x + Math.max(0, Math.floor((B.w - SPRITE_W) / 2)) + drift, sy = B.y + 2 - bob;
  // face
  let eyes = "••", mouth = "◡", eyeShift = 0;
  const blink = !sleeping && t % 5200 < 170;
  if (ctx.booting) eyes = "──";
  else if (stormy) { eyes = flash ? "▪▪" : "••"; mouth = "∩"; }
  else if (sleeping) eyes = "──";
  else if (sunny) eyes = "◠◠";
  else if (m === "patient") mouth = "○";
  else if (zapping) mouth = "─";
  else if (ctx.state === "READING") eyeShift = [-1, 0, 1, 0][Math.floor(t / 900) % 4] ?? 0;
  else if (ctx.running) eyeShift = 1;
  if (P.glance && P.glance.until > t && !sleeping && !stormy) eyeShift = P.glance.dir;
  if (ctx.typing && !ctx.running) eyeShift = 1;
  if (blink && !stormy) eyes = "──";
  for (let r = 0; r < SPRITE.length; r++) {
    const y = sy + r, row = SPRITE[r] ?? "", [a, b] = INNER[r] ?? [0, 0];
    for (let i = 0; i < row.length; i++) {
      const ch = row[i] ?? " ";
      if (ch !== " ") putSafe(sx + i, y, ch, st(body));
      else if (fill != null && i > a && i < b) putSafe(sx + i, y, "░", st(fill));
    }
    if (r === FACE.EYE_ROW) {
      putSafe(sx + FACE.EYE_L + eyeShift, y, eyes[0] ?? "•", st(faceFg, -1, ATTR.BOLD));
      putSafe(sx + FACE.EYE_R + eyeShift, y, eyes[1] ?? "•", st(faceFg, -1, ATTR.BOLD));
    }
    if (r === FACE.EYE_ROW - 1 && stormy) { // furrowed brows
      putSafe(sx + FACE.EYE_L + eyeShift, y, "╲", st(theme.err, -1, ATTR.BOLD));
      putSafe(sx + FACE.EYE_R + eyeShift, y, "╱", st(theme.err, -1, ATTR.BOLD));
    }
    if (r === FACE.MOUTH_ROW) putSafe(sx + FACE.MOUTH + (eyeShift > 0 ? 1 : 0), y, mouth, st(mouthFg));
  }
  // weather + extras
  const wy = sy + SPRITE.length; // first row under the cloud
  if (sunny) {
    putSafe(sx + 15, sy - 1, "☼", st(theme.warn, -1, ATTR.BOLD));
    putSafe(sx + 17, sy - 2, "·", st(theme.warn));
    putSafe(sx + 13, sy - 2, "·", st(theme.warn));
    putSafe(sx + 18, sy, "·", st(theme.warn));
  }
  if (sleeping) {
    const ph = Math.floor(t / 1200) % 3;
    putSafe(sx + 13, sy - (ph >= 1 ? 1 : 0), "z", st(theme.muted));
    if (ph >= 1) putSafe(sx + 15, sy - 1 - (ph === 2 ? 1 : 0), "Z", st(theme.muted));
  }
  if (ctx.running && !stormy && m !== "patient" && ctx.state !== "EDITING" && !zapping) { // thinking
    const ph = Math.floor(t / 800) % 4;
    putSafe(sx + 17, sy + 1, "◌", st(theme.muted));
    if (ph >= 1) putSafe(sx + 18, sy, "○", st(theme.muted));
    if (ph >= 2) putSafe(sx + 20, sy - 1, ["…", "·", "?", "…"][Math.floor(t / 3000) % 4] ?? "…", st(theme.fg2));
  }
  if (m === "patient") putSafe(sx + 17, sy + (Math.floor(t / 900) % 2 ? 0 : 1), "?", st(theme.warn, -1, ATTR.BOLD)); // slow blink
  if (ctx.state === "EDITING") { // code drizzle
    for (let row = 0; row < 2; row++) {
      const phase = Math.floor(t / 420) + row * 2;
      for (let x = sx + 3; x < sx + 16; x++) {
        if ((x + phase) % 4 !== 0) continue;
        const ch = CODE_RAIN[(x * 7 + Math.floor(t / 1400) + row) % CODE_RAIN.length] ?? ".";
        putSafe(x, wy + row, ch, st(row ? theme.dim : theme.accentDim));
      }
    }
  }
  if (zapping && Math.floor(t / 700) % 2 === 0) { // lightning
    const k = sx + 4 + (Math.floor(t / 2100) % 3) * 5;
    putSafe(k, wy, "╲", st(theme.warn, -1, ATTR.BOLD));
    putSafe(k, wy + 1, "╱", st(theme.warn, -1, ATTR.BOLD));
  }
  if (stormy) {
    const rows = Math.max(1, Math.min(3, B.y + B.h - 2 - wy));
    for (let row = 0; row < rows; row++) {
      for (let x = sx + 1; x < sx + 17; x++) {
        if ((x * 3 + Math.floor(t / 330) + row * 2) % 4 === 0) putSafe(x, wy + row, row % 2 ? "╷" : "│", st(flash ? theme.fg2 : theme.info));
      }
    }
    if (flash) {
      for (const k of boltCols) for (let r = 0; r < rows; r++) putSafe(sx + k, wy + r, r % 2 ? "╱" : "╲", st(theme.warn, -1, ATTR.BOLD));
      putSafe(sx - 1, sy + 2, "╲", st(theme.warn, -1, ATTR.BOLD));
      putSafe(sx + 18, sy + 1, "╱", st(theme.warn, -1, ATTR.BOLD));
    }
  }
  const sp = has("sparkle");
  if (sp) {
    for (let i = 0; i < 7; i++) {
      const h = (sp.seed * (i + 3) * 2654435761) >>> 0;
      const x = B.x + (h % B.w), y = B.y + ((h >>> 8) % Math.max(1, wy + 1 - B.y));
      const on = Math.floor((t + (h % 500)) / 520) % 2 === 0;
      if (on && !(y >= sy && y < wy && x >= sx + 1 && x < sx + 18)) putSafe(x, y, ["*", "·", "+"][i % 3] ?? "*", st(i % 2 ? theme.warn : theme.ok));
    }
  }
  const hearts = has("hearts");
  if (hearts) {
    const age = t - (hearts.until - 1800);
    const rise = Math.min(2, Math.floor(Math.max(0, age) / 700));
    putSafe(sx + 16, sy + 1 - rise, "♥", st(theme.err));
    if (rise >= 1) putSafe(sx + 19, sy + 2 - rise, "♥", st(theme.err));
  }
  // speech bubble: at most two lines at the bottom of the panel, clipped to its width
  const q = P.quip && P.quip.until > t ? P.quip.text : null;
  if (q) {
    const qy = B.y + B.h - 2;
    const lines = wrapText(q, B.w - 2).slice(0, 2);
    lines.forEach((l, i) => {
      if (qy + i < B.y + B.h) scr.put(B.x + 1, qy + i, (i === 0 ? "“" : " ") + l + (i === lines.length - 1 ? "”" : ""), st(theme.fg2, -1, ATTR.ITALIC), B.w - 1);
    });
  }
}
