/** Terminal-native CRT receiver companion painter.
 *
 * Compatibility: the surrounding code still calls this surface `pet` and imports
 * drawPet/petHit. Those names are deprecated implementation aliases; the visual
 * identity and painter are receiver/companion based. Pure: caller supplies time.
 */
import { ATTR, type Rect, type ScreenLike, type Seg, type SextantState, type Style, type Theme } from "./types.ts";
import { moodCtxFrom, type Mood, type MoodCtx, type Pet } from "./pet.ts";
import { mix, st } from "./theme.ts";
export { mix };

export const SWAY_MS = 1800; // compatibility pacing constant
export const STORM_PERIOD_MS = 2600; // deprecated alias used by old integrations
export const STORM_FLASH_MS = 260;
export const SPRITE_W = 18;

/** Unicode receiver, exactly 18 cells per row. Antennas/body/feet are distinct from a cloud. */
export const RECEIVER_SPRITE: readonly string[] = [
  "     ╲      ╱     ",
  "      ╲    ╱      ",
  "  ╭────────────╮  ",
  "  │ ┌────────┐ │  ",
  "  │ │        │ ●  ",
  "  │ └────────┘ ▪  ",
  "  ╰────────────╯  ",
  "     ▔      ▔     ",
];
export const ASCII_RECEIVER_SPRITE: readonly string[] = [
  "     \\      /     ",
  "      \\    /      ",
  "  +------------+  ",
  "  | +--------+ |  ",
  "  | |        | o  ",
  "  | +--------+ .  ",
  "  +------------+  ",
  "     _      _     ",
];
export const FACE = { EYE_L: 7, EYE_R: 10, MOUTH: 9, EYE_ROW: 4, MOUTH_ROW: 5 } as const;
export const FILL_GLYPH: readonly string[] = [" "];
export const FILL_MIX: readonly number[] = [0.12];

export function petHit(rect: Rect | null): Rect | null { return rect; }
export function moodColor(m: Mood, theme: Theme): number {
  if (m === "sunny") return theme.ok;
  if (m === "furious") return theme.err;
  if (m === "patient") return theme.warn;
  if (m === "focused" || m === "zapping" || m === "conducting") return theme.accent;
  return theme.muted;
}
export function swayBob(now: number): 0 | 1 { return (Math.floor(now / SWAY_MS) % 2) as 0 | 1; }

export function wrapText(text: string, w: number): string[] {
  const out: string[] = [], width = Math.max(1, w); let line = "";
  for (const raw of text.split(" ")) {
    const cps = [...raw];
    while (cps.length > width) { if (line) { out.push(line); line = ""; } out.push(cps.splice(0, width).join("")); }
    const word = cps.join(""); if (!word) continue;
    if (!line) line = word;
    else if ([...line].length + 1 + cps.length <= width) line += ` ${word}`;
    else { out.push(line); line = word; }
  }
  if (line) out.push(line); return out;
}

export function drawPet(scr: ScreenLike, rect: Rect | null, pet: Pet, s: SextantState, theme: Theme, now: number): void {
  if (!rect || rect.w < 8 || rect.h < 4) return;
  const ctx = moodCtxFrom(s, now); pet.tick(now, ctx); const mood = pet.mood(ctx, now);
  const inner = panel(scr, rect, pet.state.name, pet.level(ctx.tokens), mood, theme);
  drawReceiver(scr, inner, pet, ctx, mood, theme, now, false);
}

function panel(scr: ScreenLike, r: Rect, name: string, lvl: number, mood: Mood, theme: Theme): Rect {
  const alert = mood === "furious", col = alert ? mix(theme.bg, theme.err, 0.6) : theme.frame;
  scr.box(r.x, r.y, r.w, r.h, st(col));
  scr.text(r.x + 2, r.y, [[" ", st(-1)], [name, st(alert ? col : theme.fg2, -1, ATTR.BOLD)], [" ", st(-1)]], r.w - 3);
  const moodSeg: Seg = [mood, st(moodColor(mood, theme), -1, alert ? ATTR.BOLD : 0)];
  for (const extra of [[[`lv ${lvl}`, st(theme.muted)], ["  ", st(-1)], moodSeg], [moodSeg]] as Seg[][]) {
    const ew = extra.reduce((n, [t]) => n + [...t].length, 0), x = r.x + r.w - 3 - ew;
    if (x > r.x + 4 + name.length) { scr.text(x, r.y, [[" ", st(-1)], ...extra, [" ", st(-1)]]); break; }
  }
  return { x: r.x + 2, y: r.y + 1, w: r.w - 4, h: r.h - 2 };
}

export function receiverFace(ctx: MoodCtx, mood: Mood, now: number): { eyes: string; mouth: string; antenna: "up" | "in" | "out" } {
  if (ctx.booting || mood === "sleepy") return { eyes: "--", mouth: "_", antenna: "in" };
  if (mood === "furious") return { eyes: "!!", mouth: "x", antenna: "out" };
  if (mood === "patient") return { eyes: "??", mouth: "o", antenna: "up" };
  if (mood === "sunny") return { eyes: "^^", mouth: "u", antenna: "out" };
  if (ctx.state === "EDITING") return { eyes: "><", mouth: "-", antenna: "in" };
  if (ctx.state === "READING") return { eyes: "oo", mouth: ".", antenna: "up" };
  if (ctx.state === "RUNNING" || ctx.state === "TESTING") return { eyes: "**", mouth: "-", antenna: "out" };
  if (ctx.running) return { eyes: now % 1200 < 600 ? "oO" : "Oo", mouth: ".", antenna: "up" };
  return { eyes: "oo", mouth: "u", antenna: "up" };
}

function drawReceiver(scr: ScreenLike, b: Rect, pet: Pet, ctx: MoodCtx, mood: Mood, theme: Theme, now: number, ascii: boolean): void {
  const sprite = ascii ? ASCII_RECEIVER_SPRITE : RECEIVER_SPRITE;
  const inside = (x: number, y: number) => x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h;
  const put = (x: number, y: number, ch: string, style: Style) => { if (inside(x, y)) scr.put(x, y, ch, style); };
  const fx = pet.state.fx.some((f) => f.until > now && (f.kind === "bounce" || f.kind === "shiver"));
  const bob = fx ? Math.floor(now / 200) % 2 : 0;
  const sx = b.x + Math.max(0, Math.floor((b.w - SPRITE_W) / 2)), sy = b.y + 1 - bob;
  const color = mood === "furious" ? theme.err : mood === "sleepy" ? theme.mixDim : ctx.running ? theme.fg : theme.fg2;
  for (let y = 0; y < sprite.length; y++) for (let x = 0; x < (sprite[y]?.length ?? 0); x++) {
    const ch = sprite[y]![x]!; if (ch !== " ") put(sx + x, sy + y, ch, st(color));
  }
  const f = receiverFace(ctx, mood, now), eyeColor = mood === "furious" ? theme.err : mood === "patient" ? theme.warn : theme.fg;
  put(sx + FACE.EYE_L, sy + FACE.EYE_ROW, f.eyes[0]!, st(eyeColor, -1, ATTR.BOLD));
  put(sx + FACE.EYE_R, sy + FACE.EYE_ROW, f.eyes[1]!, st(eyeColor, -1, ATTR.BOLD));
  put(sx + FACE.MOUTH, sy + FACE.MOUTH_ROW, f.mouth, st(eyeColor));
  // Signal LED and tiny scan line communicate activity without animation dependence.
  put(sx + 15, sy + 4, mood === "furious" ? "!" : ctx.running ? "●" : "·", st(moodColor(mood, theme), -1, ATTR.BOLD));
  if (ctx.state === "EDITING") for (let x = 6; x <= 11; x++) put(sx + x, sy + 5, x % 2 ? ":" : ".", st(theme.accentDim));
  const q = pet.state.quip && pet.state.quip.until > now ? pet.state.quip.text : null;
  if (q) {
    const qy = b.y + b.h - 2, lines = wrapText(q, b.w - 3).slice(0, 2);
    lines.forEach((line, i) => putText(scr, b, b.x + 1, qy + i, `${i ? " " : ascii ? '"' : "“"}${line}${i === lines.length - 1 ? ascii ? '"' : "”" : ""}`, theme));
  }
}

function putText(scr: ScreenLike, b: Rect, x: number, y: number, text: string, theme: Theme): void {
  if (y >= b.y && y < b.y + b.h) scr.put(x, y, text, st(theme.fg2, -1, ATTR.ITALIC), b.w - 1);
}
