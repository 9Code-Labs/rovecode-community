/** Port #45 rovecode panel (src/sextant/draw-pet.ts) on a local GridScreen: title (name · lv · mood, degrading
 *  on a narrow panel), the 1.8 s step sway (frames at t, t+40 and t+3600 identical, t+1800 differs by one row),
 *  determinism at identical clocks, weather per state (drizzle / lightning / sun + sparkles / zzz / thinking
 *  dots / patient ?), the storm (░ body, brows, red eyes, rain, bolts + panel flash + reddened border on strike
 *  frames), hearts after a poke, the ≤2-line clipped speech bubble, nothing outside the rect (also on a short
 *  rect), null rect = no-op, petHit, booting eyes, and the glyph inventory. */
import { test, expect, describe } from "bun:test";
import { GridScreen } from "../helpers/sextant-grid-pet.ts";
import { T0, themeFixture, stateFixture, activity, task, approvalCard } from "../helpers/sextant-pet-fixtures.ts";
import { drawPet, petHit, mix, swayBob, wrapText, moodColor, SWAY_MS, STORM_PERIOD_MS, STORM_FLASH_MS } from "../../src/sextant/draw-pet.ts";
import { createPet, SPRITE, CODE_RAIN, type Pet } from "../../src/sextant/pet.ts";
import type { Rect, SextantState } from "../../src/sextant/types.ts";

const theme = themeFixture();
const RECT: Rect = { x: 3, y: 2, w: 30, h: 14 };
const NARROW: Rect = { x: 3, y: 2, w: 26, h: 14 };
/** inner rect of RECT (panel() strips the 1-cell border and a 1-cell horizontal margin) */
const B = { x: RECT.x + 2, y: RECT.y + 1, w: RECT.w - 4, h: RECT.h - 2 };

function frame(pet: Pet, s: SextantState, now: number, rect: Rect | null = RECT, fill = " "): GridScreen {
  const scr = new GridScreen(60, 24, fill);
  drawPet(scr, rect, pet, s, theme, now);
  return scr;
}
const born = (seed = 1): Pet => { const pet = createPet({ seed }); pet.tick(T0); return pet; };
/** y of the sprite's first row and x of its first column (the left lobe ╭───╮ sits at sprite column 4;
 *  the dip between the lobes carries interior shading, so the search anchors on the lobe alone) */
function sprite(scr: GridScreen, rect: Rect = RECT): { top: number; sx: number } {
  for (let y = rect.y + 1; y < rect.y + rect.h - 1; y++) {
    const i = scr.row(y).indexOf("╭───╮");
    if (i >= 0) return { top: y, sx: i - 4 };
  }
  throw new Error("sprite not found:\n" + scr.toText());
}
const EDITING = () => stateFixture({ running: true, activity: activity("EDITING", T0 - 3000) });
const TESTING = () => stateFixture({ running: true, activity: activity("TESTING", T0 - 3000) });
const READING = () => stateFixture({ running: true, activity: activity("READING", T0 - 3000) });
const SUCCESS = () => stateFixture({ activity: activity("SUCCESS", T0 - 5000, T0 - 100) });

// ---------- frame + title ----------

test("title: name left, `lv N  mood` right in the top border; a narrow panel keeps the mood and drops the level", () => {
  const s = stateFixture();
  s.usage.tokensIn = 5000; s.usage.tokensOut = 1000; // 6000 tokens → lv 3
  const f = frame(born(), s, T0 + 1000);
  const top = f.row(RECT.y);
  expect(top).toContain(" rovecode ");
  expect(top).toContain(" lv 3  humming ");
  expect(f.at(RECT.x, RECT.y)!.ch).toBe("╭");
  expect(f.at(RECT.x + RECT.w - 1, RECT.y)!.ch).toBe("╮");
  expect(f.at(RECT.x, RECT.y + RECT.h - 1)!.ch).toBe("╰");
  expect(f.at(RECT.x, RECT.y)!.fg).toBe(theme.frame);
  expect(f.at(top.indexOf("humming"), RECT.y)!.fg).toBe(theme.muted);
  expect(f.at(top.indexOf("rovecode"), RECT.y)!.fg).toBe(theme.fg2);
  const n = frame(born(), s, T0 + 1000, NARROW);
  const ntop = n.row(NARROW.y);
  expect(ntop).toContain(" rovecode ");
  expect(ntop).toContain(" humming ");
  expect(ntop).not.toContain("lv 3");
  expect(n.at(NARROW.x + NARROW.w - 1, NARROW.y)!.ch).toBe("╮");
  const named = createPet({ name: "stratus", seed: 1 });
  expect(frame(named, s, T0 + 1000).row(RECT.y)).toContain(" stratus ");
});

test("mood colors: sunny ok · furious err · patient warn · focused/zapping/conducting accent · humming/sleepy muted", () => {
  expect(moodColor("sunny", theme)).toBe(theme.ok);
  expect(moodColor("furious", theme)).toBe(theme.err);
  expect(moodColor("patient", theme)).toBe(theme.warn);
  for (const m of ["focused", "zapping", "conducting"] as const) expect(moodColor(m, theme)).toBe(theme.accent);
  for (const m of ["humming", "sleepy"] as const) expect(moodColor(m, theme)).toBe(theme.muted);
  const f = frame(born(), EDITING(), T0 + 1000);
  expect(f.at(f.row(RECT.y).indexOf("focused"), RECT.y)!.fg).toBe(theme.accent);
});

// ---------- motion + determinism ----------

test("sway (pet.js:196 floor(t/1800)%2): frames at t and t+3600 identical; t+1800 differs only by a one-row shift; t+40 identical (no per-frame jitter); no sideways wander", () => {
  expect(SWAY_MS).toBe(1800);
  const s = stateFixture();
  const at = (dt: number) => frame(born(), s, T0 + 1000 + dt);
  const f0 = at(0), fHalf = at(SWAY_MS), fFull = at(2 * SWAY_MS), fNext = at(40);
  expect(JSON.stringify(fFull.cells)).toBe(JSON.stringify(f0.cells)); // full period 3.6 s
  expect(JSON.stringify(fNext.cells)).toBe(JSON.stringify(f0.cells)); // a frame later within the same half-period
  expect(fHalf.toText()).not.toBe(f0.toText());
  const a = sprite(f0), b = sprite(fHalf);
  expect(Math.abs(b.top - a.top)).toBe(1);
  expect(b.sx).toBe(a.sx); // vertical only — "titreme yok": the prototype's ±1-column drift (pet.js:197) is not ported
  const band = (f: GridScreen, top: number) => Array.from({ length: SPRITE.length }, (_, i) => f.row(top + i)).join("\n");
  expect(band(fHalf, b.top)).toBe(band(f0, a.top)); // the same picture, one row over
  expect(swayBob(0)).toBe(0);
  expect(swayBob(SWAY_MS - 1)).toBe(0);
  expect(swayBob(SWAY_MS)).toBe(1);
  expect(swayBob(2 * SWAY_MS - 1)).toBe(1);
  expect(swayBob(2 * SWAY_MS)).toBe(0);
  expect(swayBob(T0 + 1000)).toBe(swayBob(T0 + 1040));
  expect(swayBob(T0 + 1000)).not.toBe(swayBob(T0 + 2800));
});

test("determinism: same seed + same script → identical cells; redrawing the same pet at the same clock is idempotent", () => {
  const s = EDITING();
  const script = (pet: Pet) => {
    pet.tick(T0); pet.event("start", undefined, T0); pet.event("edit", { f: "x.ts" }, T0 + 10);
    pet.poke(T0 + 20); pet.event("pass", { r: "9 passed" }, T0 + 30);
  };
  const a = createPet({ seed: 21 }), b = createPet({ seed: 21 });
  script(a); script(b);
  const fa = frame(a, s, T0 + 100), fb = frame(b, s, T0 + 100);
  expect(JSON.stringify(fa.cells)).toBe(JSON.stringify(fb.cells));
  expect(JSON.stringify(frame(a, s, T0 + 100).cells)).toBe(JSON.stringify(fa.cells));
  expect(JSON.stringify(a.state)).toBe(JSON.stringify(b.state));
});

// ---------- weather per state ----------

test("editing: code drizzle under the cloud (accentDim / dim), bright body, mood focused", () => {
  const pet = born(2);
  pet.event("edit", { f: "a.ts" }, T0);
  const f = frame(pet, EDITING(), T0 + 1000);
  const { top, sx } = sprite(f);
  const wy = top + SPRITE.length;
  const drops = [wy, wy + 1].flatMap((y) => f.cells[y]!.filter((c) => CODE_RAIN.includes(c.ch) && (c.fg === theme.accentDim || c.fg === theme.dim)));
  expect(drops.length).toBeGreaterThanOrEqual(4);
  expect(f.at(sx + 7, top)!.fg).toBe(theme.fg); // busy → full-bright outline
  expect(f.row(RECT.y)).toContain("focused");
  expect(f.toText()).toContain("a.ts"); // the edit quip
});

test("running/testing: a ╲╱ bolt under the cloud on 'on' half-periods, none on 'off', flat mouth, mood zapping", () => {
  const base = T0 + 1000;
  const on = Math.floor(base / 700) % 2 === 0 ? base : base + 700;
  const f = frame(born(3), TESTING(), on);
  const { top, sx } = sprite(f);
  const wy = top + SPRITE.length;
  const cols = [...f.row(wy)].map((ch, x) => (ch === "╲" ? x : -1)).filter((x) => x >= 0);
  expect(cols.length).toBe(1);
  expect(f.at(cols[0]!, wy + 1)!.ch).toBe("╱");
  expect(f.at(cols[0]!, wy)!.fg).toBe(theme.warn);
  expect(f.at(sx + 9, top + 4)!.ch).toBe("─"); // flat mouth
  expect(f.row(RECT.y)).toContain("zapping");
  const off = frame(born(3), TESTING(), on + 700);
  expect([...off.row(sprite(off).top + SPRITE.length)].includes("╲")).toBe(false);
});

test("success: ☼ beside the cloud, ◠◠ eyes, mood sunny; sparkles (* +) after a pass event", () => {
  // seed chosen so (a) not all seven hashed sparkle positions fall inside the sprite band at these clocks (seed 4's
  // did once the sway put the sprite on its low row at T0+1000 — sparkles under the cloud are culled) and (b) the
  // pass quip keeps "12 passed" on one 23-cell line ("clear skies ☼ 12 passed." wraps after "12")
  const pet = born(5);
  pet.event("pass", { r: "12 passed" }, T0);
  const f = frame(pet, SUCCESS(), T0 + 1000);
  const { top, sx } = sprite(f);
  expect(f.at(sx + 15, top - 1)!.ch).toBe("☼");
  expect(f.at(sx + 15, top - 1)!.fg).toBe(theme.warn);
  expect(f.at(sx + 6, top + 3)!.ch).toBe("◠");
  expect(f.at(sx + 12, top + 3)!.ch).toBe("◠");
  expect(f.row(RECT.y)).toContain("sunny");
  expect(f.at(f.row(RECT.y).indexOf("sunny"), RECT.y)!.fg).toBe(theme.ok);
  // sparkles blink on a 520 ms half-period (all flip together), so count the frame and its complement
  const sparkles = (t: number) => frame(pet, SUCCESS(), t).cells.flat()
    .filter((c) => ((c.ch === "*" || c.ch === "+") && (c.fg === theme.warn || c.fg === theme.ok)) || (c.ch === "·" && c.fg === theme.ok)).length;
  expect(sparkles(T0 + 1000) + sparkles(T0 + 1520)).toBeGreaterThan(0);
  expect(sparkles(T0 + 5000)).toBe(0); // the sparkle fx has expired (3.6 s)
  expect(f.toText()).toContain("12 passed");
});

test("sleepy after 45 s idle: ── eyes, z/Z above the cloud, dim outline, a snore from the sleep pool", () => {
  const f = frame(born(5), stateFixture(), T0 + 50_000);
  expect(f.row(RECT.y)).toContain("sleepy");
  const { top, sx } = sprite(f);
  expect(f.at(sx + 6, top + 3)!.ch).toBe("─");
  expect(f.at(sx + 12, top + 3)!.ch).toBe("─");
  expect(f.at(sx + 6, top + 3)!.fg).toBe(theme.muted);
  expect(/[zZ]/.test(f.row(top - 1) + f.row(top))).toBe(true);
  expect(f.at(sx + 7, top)!.fg).toBe(theme.mixDim);
  expect(top).toBe(B.y + 1); // settled low
});

test("patient (card open): a blinking ? beside the cloud and an ○ mouth; conducting (crew): thinking dots", () => {
  const waiting = stateFixture({ card: approvalCard(), running: true, activity: activity("THINKING", T0 - 3000) });
  const pet = born(6);
  pet.event("permission", undefined, T0);
  const f = frame(pet, waiting, T0 + 1000);
  const { top, sx } = sprite(f);
  expect(f.row(RECT.y)).toContain("patient");
  expect(f.at(sx + 9, top + 4)!.ch).toBe("○");
  expect(f.at(sx + 17, top)!.ch + f.at(sx + 17, top + 1)!.ch).toContain("?");
  const crew = stateFixture({ crew: [task("running")], running: true, activity: activity("THINKING", T0 - 3000) });
  const g = frame(born(6), crew, T0 + 1000);
  const sp = sprite(g);
  expect(g.row(RECT.y)).toContain("conducting");
  expect(g.at(sp.sx + 17, sp.top + 1)!.ch).toBe("◌");
});

test("booting (first 1.3 s after bootAt): eyes stay closed", () => {
  const s = stateFixture({ bootAt: T0 });
  const f = frame(born(7), s, T0 + 1000);
  const { top, sx } = sprite(f);
  expect(f.at(sx + 6, top + 3)!.ch).toBe("─");
  const g = frame(born(7), stateFixture({ bootAt: T0 - 1300 }), T0 + 1000);
  const sp = sprite(g);
  expect(g.at(sp.sx + 6, sp.top + 3)!.ch).toBe("•");
});

// ---------- storm ----------

describe("storm frames", () => {
  const stormPet = () => { const pet = born(8); pet.event("tool_fail", { f: "a.ts" }, T0); return pet; };
  const border = mix(theme.bg, theme.err, 0.6);

  test("strike frame: panel flash tint, ▪▪ red eyes, brows, ░ interior (corners empty), bolts, reddened border + title", () => {
    expect((T0 + 100) % STORM_PERIOD_MS).toBeLessThan(STORM_FLASH_MS);
    const f = frame(stormPet(), READING(), T0 + 100);
    expect(f.row(RECT.y)).toContain("furious");
    expect(f.at(RECT.x, RECT.y)!.fg).toBe(border);
    expect(f.at(f.row(RECT.y).indexOf("rovecode"), RECT.y)!.fg).toBe(border);
    expect(f.at(f.row(RECT.y).indexOf("furious"), RECT.y)!.fg).toBe(theme.err);
    expect(f.at(B.x, B.y)!.bg).toBe(mix(theme.bg, theme.warn, 0.07));
    expect(f.at(B.x + B.w - 1, B.y + B.h - 1)!.bg).toBe(mix(theme.bg, theme.warn, 0.07));
    expect(f.at(RECT.x, RECT.y)!.bg).toBe(-1); // the border row is not tinted
    const { top, sx } = sprite(f);
    expect(f.at(sx + 6, top + 3)!.ch).toBe("▪");
    expect(f.at(sx + 6, top + 3)!.fg).toBe(theme.err);
    expect(f.at(sx + 12, top + 3)!.ch).toBe("▪");
    expect(f.at(sx + 6, top + 2)!.ch).toBe("╲");
    expect(f.at(sx + 12, top + 2)!.ch).toBe("╱");
    expect(f.at(sx + 6, top + 2)!.fg).toBe(theme.err);
    expect(f.at(sx + 9, top + 4)!.ch).toBe("∩");
    expect(f.at(sx + 6, top + 1)!.ch).toBe("░"); // the row-1 interior under the left lobe
    expect(f.at(sx + 4, top + 3)!.ch).toBe("░");
    expect(f.at(sx, top)!.ch).toBe(" "); // outside the outline: the row-0 corner stays empty
    expect(f.at(sx + 7, top)!.fg).toBe(theme.warn); // lit outline
    const wy = top + SPRITE.length;
    expect([...f.row(wy)].some((ch) => ch === "╲")).toBe(true);
  });

  test("calm storm frame: no tint, •• red eyes, rain ╷│ under the cloud, no bolts, dark-red outline", () => {
    const f = frame(stormPet(), READING(), T0 + 1000);
    expect(f.at(B.x, B.y)!.bg).toBe(-1);
    const { top, sx } = sprite(f);
    expect(f.at(sx + 6, top + 3)!.ch).toBe("•");
    expect(f.at(sx + 6, top + 3)!.fg).toBe(theme.err);
    expect(f.at(sx + 7, top)!.fg).toBe(mix(theme.bg, theme.err, 0.7));
    const wy = top + SPRITE.length;
    const rain = f.cells[wy]!.filter((c) => c.ch === "│" && c.fg === theme.info);
    expect(rain.length).toBeGreaterThanOrEqual(3);
    expect(f.cells[wy + 1]!.some((c) => c.ch === "╷")).toBe(true);
    expect([...f.row(wy)].includes("╲")).toBe(false);
    expect(f.at(RECT.x, RECT.y)!.fg).toBe(border);
  });

  test("after the storm (≥7 s) the border is the frame color again and the mood follows the state", () => {
    const f = frame(stormPet(), READING(), T0 + 8000);
    expect(f.at(RECT.x, RECT.y)!.fg).toBe(theme.frame);
    expect(f.row(RECT.y)).toContain("humming");
    // the storm fill is gone; what is left is the calm body shading (░ over the crown, ▒ then ▓ lower),
    // which the storm never draws — it fills flat with ░
    expect(f.toText()).toContain("▒");
  });
});

// ---------- extras + speech ----------

test("poke: ♥ hearts beside the cloud and the “hi.” bubble; a second heart once they rise", () => {
  const pet = born(9);
  pet.poke(T0 + 1000);
  const f = frame(pet, stateFixture(), T0 + 1000);
  expect(f.toText()).toContain("♥");
  expect(f.toText()).toContain("“hi.”");
  expect(f.cells.flat().filter((c) => c.ch === "♥").length).toBe(1);
  const g = frame(pet, stateFixture(), T0 + 1000 + 1500);
  expect(g.cells.flat().filter((c) => c.ch === "♥").length).toBe(2);
});

test("speech bubble: at most two lines, clipped to the panel width, opening quote first, border intact", () => {
  const pet = born(10);
  const text = { a: "an-extremely-long-agent-name", r: "seventeen files rewritten and every single test passing" };
  pet.event("laneDone", text, T0);
  expect(wrapText(pet.state.quip!.text, B.w - 3).length).toBeGreaterThan(2);
  const f = frame(pet, stateFixture(), T0 + 1000);
  const qy = B.y + B.h - 2;
  expect(f.at(B.x + 1, qy)!.ch).toBe("“");
  expect(f.at(B.x + 1, qy)!.a & 4).toBe(4); // italic
  const textCells = (y: number) => f.cells[y]!.slice(B.x + 1, B.x + B.w).filter((c) => c.ch !== " ").length;
  expect(textCells(qy)).toBeGreaterThan(10);
  expect(textCells(qy + 1)).toBeGreaterThan(10);
  expect(f.row(qy + 2)).toBe(f.row(RECT.y + RECT.h - 1)); // the bottom border row carries no text
  expect(/^[╰─╯ ]+$/.test(f.row(qy + 2).trimEnd())).toBe(true);
  for (const y of [qy, qy + 1]) {
    expect(f.at(RECT.x + RECT.w - 1, y)!.ch).toBe("│"); // right border survives
    expect(f.at(RECT.x + RECT.w - 2, y)!.ch).toBe(" "); // the margin cell is never written
  }
  expect(wrapText("a bb ccc", 5)).toEqual(["a bb", "ccc"]);
  expect(wrapText("supercalifragilistic x", 6)).toEqual(["superc", "alifra", "gilist", "ic x"]); // an over-long word (a host, a path) is hard-split: a bubble row is never wider than the panel, so the closing ” below survives
});

test("speech bubble: a quip that exactly fills the line keeps both quotes — the closing ” lands on the last inner column, never clipped", () => {
  const qy = B.y + B.h - 2;
  const full = "a".repeat(11) + " " + "b".repeat(11); // 23 = B.w - 3 chars: the longest single line
  const pet = born(10);
  pet.say(full, T0);
  const f = frame(pet, stateFixture(), T0 + 1000);
  expect(f.row(qy).slice(B.x + 1, B.x + B.w)).toBe("“" + full + "”");
  expect(f.at(B.x + B.w - 1, qy)!.ch).toBe("”");
  expect(f.at(B.x + B.w, qy)!.ch).toBe(" "); // the margin cell stays empty
  expect(f.at(RECT.x + RECT.w - 1, qy)!.ch).toBe("│");
  expect(f.row(qy + 1).slice(B.x, B.x + B.w).trim()).toBe("");
  // one char more (B.w - 2) no longer fits one line with its quotes: it wraps and both quotes survive
  const over = "a".repeat(12) + " " + "b".repeat(11);
  const pet2 = born(10);
  pet2.say(over, T0);
  const g = frame(pet2, stateFixture(), T0 + 1000);
  const glyphs = g.cells.flat().map((c) => c.ch);
  expect(glyphs.filter((ch) => ch === "“").length).toBe(1);
  expect(glyphs.filter((ch) => ch === "”").length).toBe(1);
  expect(g.row(qy).slice(B.x + 1, B.x + B.w).trimEnd()).toBe("“" + "a".repeat(12));
  expect(g.row(qy + 1).slice(B.x + 1, B.x + B.w).trimEnd()).toBe(" " + "b".repeat(11) + "”");
});

// ---------- clipping, hiding, hits ----------

test("nothing outside the rect — across states, clocks and rects, including a short rect where weather rows would spill", () => {
  const scenarios: [SextantState, (p: Pet) => void, number[]][] = [
    [EDITING(), () => {}, [T0 + 1000, T0 + 1300]],
    [TESTING(), () => {}, [T0 + 1000, T0 + 1700]],
    [READING(), (p) => p.event("tool_fail", undefined, T0), [T0 + 100, T0 + 1000, T0 + 2700]],
    [SUCCESS(), (p) => p.event("pass", { r: "ok" }, T0), [T0 + 1000, T0 + 2000]],
    [stateFixture(), (p) => p.poke(T0 + 900), [T0 + 1000, T0 + 2400]],
    [stateFixture(), () => {}, [T0 + 50_000, T0 + 51_300]],
    [stateFixture({ card: approvalCard(), running: true, activity: activity("THINKING", T0 - 3000) }), (p) => p.event("permission", undefined, T0), [T0 + 1000]],
    [stateFixture({ crew: [task("running")], running: true, activity: activity("THINKING", T0 - 3000) }), () => {}, [T0 + 1000, T0 + 2600]],
  ];
  const rects: Rect[] = [RECT, NARROW, { x: 10, y: 5, w: 26, h: 9 }, { x: 0, y: 0, w: 34, h: 14 }, { x: 26, y: 10, w: 34, h: 14 }];
  for (const rect of rects) {
    for (const [s, prep, clocks] of scenarios) {
      const pet = born(11);
      prep(pet);
      for (const t of clocks) {
        const f = frame(pet, s, t, rect, ".");
        for (let y = 0; y < f.h; y++) {
          for (let x = 0; x < f.w; x++) {
            const inside = x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h;
            const c = f.at(x, y)!;
            if (!inside && (c.ch !== "." || c.bg !== -1 || c.fg !== -1)) {
              throw new Error(`cell (${x},${y}) written outside ${JSON.stringify(rect)} at t=${t} state=${s.activity.state}: ${JSON.stringify(c)}`);
            }
          }
        }
        expect(f.at(rect.x + rect.w - 1, rect.y + rect.h - 1)!.ch).toBe("╯");
      }
    }
  }
});

test("null rect: no-op — the screen and the pet state are untouched", () => {
  const pet = born(12);
  const before = JSON.stringify(pet.state);
  const scr = new GridScreen(40, 20, ".");
  drawPet(scr, null, pet, stateFixture(), theme, T0 + 1000);
  expect(scr.toText()).toBe(Array.from({ length: 20 }, () => ".".repeat(40)).join("\n"));
  expect(JSON.stringify(pet.state)).toBe(before);
});

test("petHit returns the panel rect as the click zone, or null when hidden", () => {
  expect(petHit(RECT)).toBe(RECT);
  expect(petHit(null)).toBeNull();
});

test("glyph inventory: every non-ASCII glyph drawn comes from the prototype's set", () => {
  // ▒▓ join ░ as of the filled body: the interior is shaded light→heavy top to bottom, a deliberate
  // step past the prototype (which drew a hollow cloud outside a storm)
  const ALLOWED = new Set([..."╭╮╰╯─│╲╱╷░▒▓•◡◠∩○▪☼·◌…♥“”♪▸"]);
  const seen = new Set<string>();
  const runs: [SextantState, (p: Pet) => void, number[]][] = [
    [EDITING(), (p) => p.event("edit", { f: "a.ts" }, T0), [T0 + 1000, T0 + 1420]],
    [TESTING(), (p) => p.event("run", undefined, T0), [T0 + 1000, T0 + 1700]],
    [READING(), (p) => { p.event("tool_fail", undefined, T0); p.observe("httpOnly", "ins", T0 + 1); }, [T0 + 100, T0 + 1000]],
    [SUCCESS(), (p) => p.event("pass", { r: "9 passed" }, T0), [T0 + 1000]],
    [stateFixture(), (p) => { p.poke(T0 + 900); p.event("allowed", undefined, T0 + 950); }, [T0 + 1000]],
    [stateFixture(), (p) => p.event("permission", undefined, T0), [T0 + 1000]],
    [stateFixture(), () => {}, [T0 + 50_000, T0 + 7000]],
    [stateFixture({ crew: [task("running")], running: true, activity: activity("THINKING", T0 - 3000) }), () => {}, [T0 + 1000, T0 + 2600]],
  ];
  for (const [s, prep, clocks] of runs) {
    const pet = born(13);
    prep(pet);
    for (const t of clocks) for (const c of frame(pet, s, t).cells.flat()) if (c.ch.charCodeAt(0) > 0x7e) seen.add(c.ch);
  }
  const stray = [...seen].filter((g) => !ALLOWED.has(g));
  expect(stray).toEqual([]);
  expect(seen.size).toBeGreaterThan(12);
});
