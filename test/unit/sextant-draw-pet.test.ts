/** CRT receiver companion golden/state matrix. */
import { expect, test } from "bun:test";
import { GridScreen } from "../helpers/sextant-grid-pet.ts";
import { T0, activity, approvalCard, stateFixture, task, themeFixture } from "../helpers/sextant-pet-fixtures.ts";
import { ASCII_RECEIVER_SPRITE, RECEIVER_SPRITE, drawPet, moodColor, petHit, receiverFace, wrapText } from "../../src/sextant/draw-pet.ts";
import { createPet, moodCtxFrom, type Pet } from "../../src/sextant/pet.ts";
import type { Rect, SextantState } from "../../src/sextant/types.ts";

const theme = themeFixture();
const WIDE: Rect = { x: 2, y: 1, w: 30, h: 14 };
const NARROW: Rect = { x: 2, y: 1, w: 26, h: 12 };
const born = (): Pet => { const p = createPet({ seed: 7 }); p.tick(T0); return p; };
function render(state: SextantState, rect = WIDE, pet = born(), now = T0 + 2000): string {
  const screen = new GridScreen(40, 18, " "); drawPet(screen, rect, pet, state, theme, now); return screen.toText();
}

const states: [string, SextantState, string, string][] = [
  ["idle/listening", stateFixture(), "oo", "humming"],
  ["thinking", stateFixture({ running: true, activity: activity("THINKING", T0) }), "oO", "humming"],
  ["reading", stateFixture({ running: true, activity: activity("READING", T0) }), "oo", "humming"],
  ["editing", stateFixture({ running: true, activity: activity("EDITING", T0) }), "><", "focused"],
  ["running tool", stateFixture({ running: true, activity: activity("RUNNING", T0) }), "**", "zapping"],
  ["approval/waiting", stateFixture({ running: true, activity: activity("WAITING", T0), card: approvalCard() }), "??", "patient"],
  ["success", stateFixture({ activity: activity("SUCCESS", T0, T0 + 1) }), "^^", "sunny"],
  ["error", stateFixture({ activity: activity("ERROR", T0, T0 + 1) }), "!!", "furious"],
  ["coordinating", stateFixture({ running: true, activity: activity("DELEGATING", T0), crew: [task("running")] }), "oO", "conducting"],
];

test("receiver sprites are fixed-width, terminal-native, and unmistakably rectangular", () => {
  for (const sprite of [RECEIVER_SPRITE, ASCII_RECEIVER_SPRITE]) {
    expect(sprite).toHaveLength(8);
    expect(sprite.every((row) => [...row].length === 18)).toBe(true);
    expect(sprite.join("\n")).not.toMatch(/cloud|☁/i);
  }
  expect(RECEIVER_SPRITE.join("\n")).toContain("╭────────────╮");
  expect(RECEIVER_SPRITE.join("\n")).toContain("╰────────────╯");
  expect(ASCII_RECEIVER_SPRITE.join("\n")).toContain("+------------+");
});

for (const [name, state, eyes, mood] of states) test(`state golden: ${name}`, () => {
  const text = render(state);
  expect(text).toContain("╭────────────╮");
  const faceLine = text.split("\n").find((line) => line.includes(eyes[0]!) && line.includes(eyes[1]!));
  expect(faceLine).toBeDefined();
  expect(text).toContain(mood);
  expect(text).not.toContain("☼");
});

test("offline face is compact and antennas remain within the body width", () => {
  const p = born(), state = stateFixture();
  const ctx = moodCtxFrom(state, T0 + 60_000);
  expect(p.mood(ctx, T0 + 60_000)).toBe("sleepy");
  expect(receiverFace(ctx, "sleepy", T0 + 60_000)).toEqual({ eyes: "--", mouth: "_", antenna: "in" });
  expect(render(state, WIDE, p, T0 + 60_000)).toMatch(/-\s+-/);
});

test("narrow and wide layouts never write outside the panel or leak ANSI", () => {
  for (const rect of [NARROW, WIDE]) for (const [, state] of states) {
    const screen = new GridScreen(40, 18, "."); drawPet(screen, rect, born(), state, theme, T0 + 2000);
    expect(screen.toText()).not.toContain("\u001b");
    for (let y = 0; y < screen.h; y++) for (let x = 0; x < screen.w; x++) {
      const inside = x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h;
      if (!inside) expect(screen.at(x, y)!.ch).toBe(".");
    }
    expect(screen.at(rect.x + rect.w - 1, rect.y + rect.h - 1)!.ch).toBe("╯");
  }
});

test("same clock redraw is byte-identical; no ambient sway/flicker", () => {
  const state = stateFixture({ running: true, activity: activity("THINKING", T0) }), p = born();
  expect(render(state, WIDE, p, T0 + 2000)).toBe(render(state, WIDE, p, T0 + 2000));
  expect(render(state, WIDE, born(), T0 + 2000)).toBe(render(state, WIDE, born(), T0 + 2040));
});

test("speech stays within two clipped rows and compatibility hit/colour APIs remain", () => {
  const p = born(); p.say("a very long receiver message about a deterministic tool call that remains bounded", T0, 5000);
  const text = render(stateFixture(), NARROW, p, T0 + 1000);
  expect(text).toContain("“"); expect(text).toContain("”");
  expect(wrapText("supercalifragilistic x", 6)).toEqual(["superc", "alifra", "gilist", "ic x"]);
  expect(petHit(WIDE)).toBe(WIDE); expect(petHit(null)).toBeNull();
  expect(moodColor("sunny", theme)).toBe(theme.ok);
  expect(moodColor("furious", theme)).toBe(theme.err);
});
