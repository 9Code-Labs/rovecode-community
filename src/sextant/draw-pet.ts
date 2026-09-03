/** Port #45 — paints rovecode into its panel: a rounded frame titled `<name>  lv N  <mood>`, the cloud
 *  sprite on the prototype's 1.8 s step sway (pet.js:196), weather (code drizzle while editing, lightning while running/testing,
 *  sun on success, zzz when sleepy), the storm (dark filled body, furrowed brows, red eyes, rain + bolts,
 *  panel flash, reddened border), sparkles/hearts, and a ≤2-line speech bubble — everything clipped to
 *  the panel rect. Ported from the user's own sextant v0.4.0 prototype `src/pet.js` draw() + `app.js`
 *  drawPet()/panel() (user-owned). PURE: `now` is a parameter; no timers, no unseeded randomness. */

import { ATTR, type Rect, type ScreenLike, type Seg, type SextantState, type Style, type Theme } from "./types.ts";
import { CODE_RAIN, FACE, INNER, SPRITE, moodCtxFrom, type Mood, type MoodCtx, type Pet } from "./pet.ts";
import { mix, st } from "./theme.ts";

/** term.js mix() lives in theme.ts (port #40); re-exported for the pet tests/fixtures that import it here */
export { mix };

/** the sprite shifts one row every SWAY_MS — pet.js:196 `Math.floor(t / 1800) % 2`, the README's "1.8 s salınım"
 *  (full period 3.6 s); the prototype's ±1-column drift (pet.js:197) is deliberately not ported: "titreme yok" */
export const SWAY_MS = 1800;
/** a double-flicker strike every 2.6 s; the panel flashes for the first 260 ms */
export const STORM_PERIOD_MS = 2600;
export const STORM_FLASH_MS = 260;
export const SPRITE_W = 18;

/** the interior shading, per sprite row: light at the top, heaviest along the base (see the fill in
 *  drawPet). Rows past the end fall back to ░, so a re-drawn sprite cannot crash the painter. */
export const FILL_GLYPH: readonly string[] = ["░", "░", "░", "▒", "▓", "▓"];
export const FILL_MIX: readonly number[] = [0.10, 0.12, 0.14, 0.18, 0.24, 0.26];

/** the click zone the input layer registers (a click anywhere in the panel pokes); null when hidden */
export function petHit(rect: Rect | null): Rect | null { return rect; }

export function moodColor(m: Mood, theme: Theme): number {
  if (m === "sunny") return theme.ok;
  if (m === "furious") return theme.err;
  if (m === "patient") return theme.warn;
  if (m === "focused" || m === "zapping" || m === "conducting") return theme.accent;
  return theme.muted;
}

/** vertical sway phase: a step that flips every SWAY_MS (frames within one step are identical — no per-frame jitter) */
export function swayBob(now: number): 0 | 1 { return (Math.floor(now / SWAY_MS) % 2) as 0 | 1; }

/** word wrap to w cells (code points); a word longer than a row — a host, a path — is hard-split, so a
 *  bubble line is never wider than the row and the closing ” survives put()'s clip (it used to be left
 *  whole and the quote fell off the edge) */
export function wrapText(text: string, w: number): string[] {
  const out: string[] = [];
  const width = Math.max(1, w);
  let line = "", len = 0;
  for (const raw of text.split(" ")) {
    const cps = [...raw];
    while (cps.length > width) { if (line) { out.push(line); line = ""; len = 0; } out.push(cps.splice(0, width).join("")); }
    if (!cps.length) continue;
    const word = cps.join("");
    if (!line) { line = word; len = cps.length; continue; }
    if (len + 1 + cps.length <= width) { line += " " + word; len += 1 + cps.length; }
    else { out.push(line); line = word; len = cps.length; }
  }
  if (line) out.push(line);
  return out;
}

/** no-op when the layout hides the pet (rect null below 34 rows, or ROVECODE_PET=0) */
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
  // the interior is always painted now: ░ across the top rows, ▒ through the middle, ▓ along the base —
  // two shading steps that read as volume without touching the outline. The tone is mixed from the body
  // colour, so the cloud dims asleep and brightens while busy with the rest of the sprite. A storm keeps
  // its own flat, brighter fill (and its flash), which is what makes it read as a different thing.
  const stormFill = stormy ? mix(theme.bg, theme.fg, flash ? 0.35 : 0.22) : null;
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
      else if (i > a && i < b) {
        putSafe(sx + i, y, stormFill != null ? "░" : (FILL_GLYPH[r] ?? "░"),
                st(stormFill ?? mix(theme.bg, body, FILL_MIX[r] ?? 0.14)));
      }
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
    // B.w - 3: the two quote marks share the line and put() clips at B.w - 1, so a full line keeps its closing ”
    const lines = wrapText(q, B.w - 3).slice(0, 2);
    lines.forEach((l, i) => {
      if (qy + i < B.y + B.h) scr.put(B.x + 1, qy + i, (i === 0 ? "“" : " ") + l + (i === lines.length - 1 ? "”" : ""), st(theme.fg2, -1, ATTR.ITALIC), B.w - 1);
    });
  }
}
