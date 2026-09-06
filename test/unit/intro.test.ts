/** The intro is four acts — the mark fills in, the frame draws from the corners, the cloud leans out of it,
 *  the mark breathes once — centred on a cleared screen. What is pinned here is the arithmetic of those
 *  acts, that the mascot is the SAME sprite the session paints, that the show ends by itself and hands back
 *  a clean screen with the cursor restored, and that off a terminal it writes nothing at all. */

import { describe, expect, test } from "bun:test";
import { INTRO_MS, INTRO_STEPS, MARK_COLS, cloudRows, frameRows, introFrame, mergeCloudIntoLine, startIntro } from "../../src/core/intro.ts";

describe("introFrame", () => {
  test("step 0 is the whole word at its faintest, and the shape is already readable", () => {
    const [top, bottom] = introFrame(0);
    expect(top).toBe("░▀░ ░▀░ ░ ░ ░▀▀ ░▀▀ ░▀░ ░▀▄ ░▀▀");
    expect(bottom).toBe("░▀▄ ░▄░ ▀▄▀ ░▄▄ ░▄▄ ░▄░ ░▄▀ ░▄▄");
    expect(top).not.toContain("█");
    expect(top).toHaveLength(MARK_COLS);   // what the centring maths is told the mark is
  });

  test("the wave moves left to right and trails three shades behind it", () => {
    // V carries a space of its own, so letters are read by position, not by splitting on blanks
    const letter = (row: string, i: number) => row.slice(i * 4, i * 4 + 3);
    const [top] = introFrame(3);
    expect(letter(top, 0)).toBe("█▀█");   // R has had four steps: full
    expect(letter(top, 1)).toBe("▓▀▓");
    expect(letter(top, 2)).toBe("▒ ▒");
    expect(letter(top, 3)).toBe("░▀▀");   // the wave has not reached E yet
  });

  test("the mark holds solid while the frame draws, then breathes exactly once", () => {
    const solid = "█▀█ █▀█ █ █ █▀▀ █▀▀ █▀█ █▀▄ █▀▀";
    const tops = Array.from({ length: INTRO_STEPS + 2 }, (_, s) => introFrame(s)[0]);
    const dimmed = tops.map((t, s) => [s, t] as const).filter(([s, t]) => s > 11 && t !== solid);
    expect(dimmed).toHaveLength(1);                       // one breath, not a flicker
    expect(dimmed[0]![1]).toBe("▓▀▓ ▓▀▓ ▓ ▓ ▓▀▀ ▓▀▀ ▓▀▓ ▓▀▄ ▓▀▀");
    expect(tops.at(-1)).toBe(solid);                      // and it ends lit
  });
});

describe("frameRows", () => {
  test("nothing until the mark is done — one thing happens at a time", () => {
    expect(frameRows(0)).toEqual(["", ""]);
    expect(frameRows(11)).toEqual(["", ""]);
  });

  test("the two halves grow inward from the corners and meet exactly, with no gap left over", () => {
    const early = frameRows(13)[0];
    expect(early.startsWith("╭─")).toBe(true);
    expect(early.endsWith("─╮")).toBe(true);
    expect(early).toContain("  ");                         // still open in the middle

    const closed = frameRows(INTRO_STEPS)[0];
    expect(closed).not.toContain(" ");                     // met exactly: a one-column gap reads as a bug
    expect(closed.startsWith("╭")).toBe(true);
    expect(closed.endsWith("╮")).toBe(true);
    expect(frameRows(INTRO_STEPS)[1]).toHaveLength(closed.length);
    expect(closed.length).toBeGreaterThan(MARK_COLS);      // the frame stands clear of the mark
  });
});

describe("startIntro", () => {
  const harness = (cols = 72) => {
    const out: string[] = [];
    let tick: (() => void) | null = null;
    let cleared = false;
    const intro = startIntro({
      write: (s) => out.push(s), tty: true, version: "0.2.0", columns: cols, rows: 20,
      setInterval: (fn) => { tick = fn; return 1; },
      clearInterval: () => { cleared = true; },
    });
    return { out, intro, step: () => tick?.(), get cleared() { return cleared; } };
  };

  test("every frame is centred, clears the screen and hides the cursor", () => {
    const h = harness(72);
    expect(h.out).toHaveLength(1);                          // painted before any timer fired
    const first = h.out[0]!;
    expect(first.startsWith("\x1b[2J\x1b[H")).toBe(true);
    expect(first).toContain("\x1b[?25l");
    const markLine = first.split("\n").find((l) => l.includes("░▀░"))!;
    const left = markLine.length - markLine.trimStart().length;
    expect(left).toBe(Math.floor((72 - MARK_COLS) / 2));    // centred, not indented by two
  });

  test("it plays out by itself: `done` resolves, the timer stops, the screen and cursor are handed back", async () => {
    const h = harness();
    for (let i = 0; i <= INTRO_STEPS + 1; i++) h.step();
    await h.intro.done;                                     // would hang if the show never ended
    expect(h.cleared).toBe(true);
    expect(h.out.at(-1)).toBe("\x1b[?25h\x1b[2J\x1b[H");    // cursor back, screen clean for the TUI
  });

  test("finish cuts it short at the final state, and is safe to call twice", async () => {
    const h = harness();
    h.intro.status("starting the session");
    expect(h.out.at(-1)).toContain("starting the session");
    h.intro.finish();
    await h.intro.done;
    const solidFrame = h.out.at(-2)!;
    expect(solidFrame).toContain("█▀█ █▀█ █ █");            // solid without waiting out the sweep
    expect(solidFrame).not.toContain("starting the session");
    const painted = h.out.length;
    h.intro.finish();
    h.intro.status("too late");
    h.step();
    expect(h.out).toHaveLength(painted);                    // nothing paints after the handover
  });

  test("off a terminal it writes nothing and does not make the caller wait", async () => {
    const out: string[] = [];
    const intro = startIntro({ write: (s) => out.push(s), tty: false, version: "0.2.0" });
    intro.status("loading");
    await intro.done;                                       // already resolved: a pipe waits for no show
    intro.finish();
    expect(out).toEqual([]);
  });

  test("the default pace spreads the whole show over INTRO_MS", () => {
    expect(Math.round(INTRO_MS / INTRO_STEPS)).toBeGreaterThanOrEqual(25);
    expect(Math.round(INTRO_MS / INTRO_STEPS)).toBeLessThanOrEqual(60);
  });
});

describe("the mascot", () => {
  test("the intro's cloud IS the session's cloud — the copy in intro.ts cannot drift from pet.ts", async () => {
    // intro.ts deliberately copies the sprite rather than importing sextant/pet.ts, which would pull the
    // panel painter into the boot path of a process that has not decided to draw panels. This is what
    // keeps the copy honest: the outline must match row for row, and the face must sit on pet.ts's own
    // anchors, or the intro shows a different animal from the one the session opens with.
    const { SPRITE, FACE } = await import("../../src/sextant/pet.ts");
    const introCloud = [...Array(6).keys()].map((d) => mergeCloudIntoLine(" ".repeat(60), 100 + d));
    void introCloud; // the merge is exercised below; this asserts the import shape stays valid

    const faceless = (row: string) => row.replaceAll("•", " ").replaceAll("◡", " ");
    const body = cloudRows(INTRO_STEPS);            // rows 1..5, fully descended
    SPRITE.slice(1).forEach((row, i) => expect(faceless(body[i]!)).toBe(row));

    // and the face is on pet.ts's anchors, not eyeballed into place
    const eyes = body[FACE.EYE_ROW - 1]!, mouth = body[FACE.MOUTH_ROW - 1]!;
    expect([...eyes][FACE.EYE_L]).toBe("•");
    expect([...eyes][FACE.EYE_R]).toBe("•");
    expect([...mouth][FACE.MOUTH]).toBe("◡");
  });

  test("it leans out of the frame's top line, and the block below never moves while it arrives", () => {
    const line = "╭" + "─".repeat(38) + "╮";
    expect(mergeCloudIntoLine(line, 0)).toBe(line);                  // nothing until the frame has closed
    expect(cloudRows(0).join("")).toBe("");
    const leaning = mergeCloudIntoLine(line, INTRO_STEPS);
    expect(leaning).toContain("╭────╮");                             // the crown cuts into the line
    expect(leaning).toHaveLength(line.length);                       // ...without widening it
    expect(leaning.startsWith("╭─")).toBe(true);
    // the reserved rows are constant from the first step to the last: the mark cannot jump
    const counts = [0, 12, 19, 22, INTRO_STEPS].map((s) => cloudRows(s).length);
    expect(new Set(counts).size).toBe(1);
  });
});
