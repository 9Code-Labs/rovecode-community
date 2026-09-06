/** The intro's one hard rule: it must never BE the wait. No sleep, no minimum duration — it paints while
 *  boot works and stops the instant the caller is ready. The rest is arithmetic on a wave of shades. */

import { describe, expect, test } from "bun:test";
import { INTRO_STEPS, introFrame, startIntro } from "../../src/core/intro.ts";

describe("introFrame", () => {
  test("step 0 is the whole word at its faintest, and the shape is already readable", () => {
    const [top, bottom] = introFrame(0);
    expect(top).toBe("░▀░ ░▀░ ░ ░ ░▀▀ ░▀▀ ░▀░ ░▀▄ ░▀▀");
    expect(bottom).toBe("░▀▄ ░▄░ ▀▄▀ ░▄▄ ░▄▄ ░▄░ ░▄▀ ░▄▄");
    expect(top).not.toContain("█");        // nothing is lit yet
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

  test("at INTRO_STEPS every letter is solid, and it stays solid past the end", () => {
    const solid = introFrame(INTRO_STEPS);
    expect(solid[0]).toBe("█▀█ █▀█ █ █ █▀▀ █▀▀ █▀█ █▀▄ █▀▀");
    expect(solid[1]).toBe("█▀▄ █▄█ ▀▄▀ █▄▄ █▄▄ █▄█ █▄▀ █▄▄");
    expect(introFrame(INTRO_STEPS + 50)).toEqual(solid);   // a slow boot does not overshoot into nonsense
  });
});

describe("startIntro", () => {
  const harness = () => {
    const out: string[] = [];
    let tick: (() => void) | null = null;
    let cleared = false;
    const intro = startIntro({
      write: (s) => out.push(s), tty: true, version: "0.2.0",
      setInterval: (fn) => { tick = fn; return 1; },
      clearInterval: () => { cleared = true; },
    });
    return { out, intro, step: () => tick?.(), get cleared() { return cleared; } };
  };

  test("paints immediately, advances on the timer, and rewinds over itself instead of scrolling", () => {
    const h = harness();
    expect(h.out).toHaveLength(1);            // the first frame is on screen before any timer fires
    expect(h.out[0]).not.toContain("\x1b[3A"); // ...and does not rewind over lines that are not there
    expect(h.out[0]).toContain("0.2.0");
    h.step();
    expect(h.out[1]).toContain("\x1b[3A");    // every later frame repaints in place
    expect(h.out.at(-1)).not.toContain("█");  // two steps in, nothing is full yet
  });

  test("finish snaps to solid, clears the status, stops the timer, and is safe to call twice", () => {
    const h = harness();
    h.intro.status("mcp connecting…");
    expect(h.out.at(-1)).toContain("mcp connecting…");
    h.intro.finish();
    expect(h.cleared).toBe(true);
    expect(h.out.at(-1)).toContain("█▀█ █▀█ █ █");   // solid without waiting out the sweep
    expect(h.out.at(-1)).not.toContain("mcp connecting…");
    const painted = h.out.length;
    h.intro.finish();
    h.intro.status("too late");
    h.step();
    expect(h.out).toHaveLength(painted);            // nothing paints after the handover
  });

  test("off a terminal it writes nothing at all — an intro in a log file is noise", () => {
    const out: string[] = [];
    const intro = startIntro({ write: (s) => out.push(s), tty: false, version: "0.2.0" });
    intro.status("loading");
    intro.finish();
    expect(out).toEqual([]);
  });
});
