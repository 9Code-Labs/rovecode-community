/** The opening intro: ROVECODE draws itself in, left to right, while the session actually boots.
 *
 *  Berkay picked this over a checklist that fills in and a single progress bar (2026-09-06). The rule it
 *  is built to is that the animation must never BE the wait. There is no sleep in here and no minimum
 *  duration: frames advance on a timer while boot does its work, and the moment the caller says it is
 *  ready the mark snaps to full brightness and hands the screen over. On a warm start that means a
 *  glimpse; on a cold one — a real home with skills, plugins and MCP servers to read — the whole sweep
 *  plays, because there was genuinely that much to wait for. A frozen frame means the process is busy
 *  inside a synchronous stretch, which is the truth and not worth hiding.
 *
 *  It writes nothing at all off a terminal: piped into a file, an intro is noise in someone's log. */

/** ░ ▒ ▓ █ — a letter's brightness as the wave passes over it */
const RAMP = ["░", "▒", "▓", "█"] as const;

/** ROVECODE, two rows per letter, three columns each. Only the full blocks take the ramp; the halves
 *  (▀ ▄) are the letter's shape and stay put, which is what keeps the word readable at every step. */
const LETTERS: readonly (readonly [string, string])[] = [
  ["█▀█", "█▀▄"], // R
  ["█▀█", "█▄█"], // O
  ["█ █", "▀▄▀"], // V
  ["█▀▀", "█▄▄"], // E
  ["█▀▀", "█▄▄"], // C
  ["█▀█", "█▄█"], // O
  ["█▀▄", "█▄▀"], // D
  ["█▀▀", "█▄▄"], // E
];

/** steps until every letter is full: one per letter, plus the length of the trail behind the wave */
export const INTRO_STEPS = LETTERS.length + RAMP.length - 1;

/** the two mark rows at `step`; step 0 is the whole word at its faintest, INTRO_STEPS is solid */
export function introFrame(step: number): [string, string] {
  const rows: [string, string] = ["", ""];
  LETTERS.forEach((letter, i) => {
    const level = Math.max(0, Math.min(RAMP.length - 1, step - i));
    const shade = RAMP[level]!;
    for (const r of [0, 1] as const) rows[r] += (rows[r].length > 0 ? " " : "") + letter[r]!.replaceAll("█", shade);
  });
  return rows;
}

export interface IntroOptions {
  /** where the frames go; defaults to stdout at the call site, injected in tests */
  write: (s: string) => void;
  /** false → nothing is written, ever. A pipe is not a screen. */
  tty: boolean;
  version?: string;
  /** ms between frames (default 30: the sweep is ~330 ms, about as long as a cold boot's first stretch) */
  frameMs?: number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (h: unknown) => void;
}

export interface Intro {
  /** what the session is doing right now, shown under the mark; "" clears the line */
  status: (line: string) => void;
  /** snap to full brightness, leave the cursor on a fresh line, stop painting. Safe to call twice. */
  finish: () => void;
}

const CLEAR_LINE = "\x1b[2K";

/** Paint the intro in place until `finish()`. Returns a no-op controller off a terminal, so callers do
 *  not need to branch — the check lives here, once. */
export function startIntro(opts: IntroOptions): Intro {
  if (!opts.tty) return { status: () => {}, finish: () => {} };
  const setI = opts.setInterval ?? setInterval;
  const clearI = opts.clearInterval ?? ((h: unknown) => clearInterval(h as ReturnType<typeof setInterval>));
  const version = opts.version !== undefined ? `  ${opts.version}` : "";
  let step = 0, line = "", painted = false, done = false, handle: unknown = null;

  const paint = (): void => {
    const [top, bottom] = introFrame(step);
    // after the first paint every frame rewinds over its own three lines rather than scrolling: an intro
    // that leaves eleven copies of itself in the scrollback is worse than no intro
    const rewind = painted ? "\x1b[3A" : "";
    opts.write(`${rewind}${CLEAR_LINE}  ${top}\n${CLEAR_LINE}  ${bottom}${version}\n${CLEAR_LINE}${line.length > 0 ? `     ${line}` : ""}\n`);
    painted = true;
  };

  paint();
  handle = setI(() => { if (step < INTRO_STEPS) { step += 1; paint(); } }, opts.frameMs ?? 30);

  return {
    status: (l: string) => { if (done) return; line = l; paint(); },
    finish: () => {
      if (done) return;
      done = true;
      clearI(handle);
      step = INTRO_STEPS;
      line = "";
      paint();
    },
  };
}
