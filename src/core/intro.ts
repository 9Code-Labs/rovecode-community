/** The opening intro: ROVECODE assembles itself in the middle of the terminal.
 *
 *  Berkay picked this shape over a shimmer pass and a rain of blocks (2026-09-06): the mark fills in left
 *  to right, a hairline frame draws itself from the four corners toward the middle, and the mark breathes
 *  once. Centred, on a cleared screen, then it hands over to the session's card (core/voice.ts).
 *
 *  The one thing to understand before changing it. The first version of this file refused to have a
 *  duration of its own: it painted only while boot happened to be working and snapped to the end the
 *  moment the session was ready. That is the right instinct and it produced nothing to look at — the
 *  shipped CLI is a single bundled file, so `import("../tui/app.ts")` resolves with no wait at all and the
 *  whole sequence collapsed into one frame. Berkay asked for an intro, so this one HAS a duration
 *  (INTRO_MS, ~0.9s) and the cost is stated rather than hidden: boot runs underneath it, in parallel, so
 *  the added wall time is only whatever is left of the animation when the session is already ready. It is
 *  off for a pipe, off under --plain, and off with ROVECODE_INTRO=0 or --no-intro.
 *
 *  It never reads stdin. Someone who starts typing immediately types into the terminal's buffer and the
 *  TUI gets those keys when it begins reading — an intro that swallowed the first keystroke to offer a
 *  skip would cost more than it saved. */

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

/** columns the mark occupies: three per letter plus the gaps */
export const MARK_COLS = LETTERS.length * 4 - 1;
/** the frame sits this many columns clear of the mark on each side */
const FRAME_PAD = 4;
/** columns the frame's two horizontal runs cover between them. Kept EVEN so the two halves meet exactly
 *  instead of leaving a one-column gap the eye reads as a mistake. */
const FRAME_COLS = MARK_COLS + FRAME_PAD * 2 + ((MARK_COLS + FRAME_PAD * 2) % 2);
/** columns each end of the frame grows per step — 3 makes the draw snappy without skipping */
const FRAME_GROWTH = 3;

/** the three acts, in steps */
const SWEEP_STEPS = LETTERS.length + RAMP.length - 1;                 // the mark fills in
const FRAME_STEPS = Math.ceil(FRAME_COLS / 2 / FRAME_GROWTH);          // the corners reach the middle
const BREATHE = [3, 2, 3] as const;                                    // █ ▓ █, once
export const INTRO_STEPS = SWEEP_STEPS + FRAME_STEPS + BREATHE.length;
/** how long the whole show takes when nothing interrupts it */
export const INTRO_MS = 900;

/** the two mark rows at `step`; step 0 is the whole word at its faintest, SWEEP_STEPS is solid. Past the
 *  sweep the mark holds, except for the breath at the very end. */
export function introFrame(step: number): [string, string] {
  const breathIx = step - SWEEP_STEPS - FRAME_STEPS;
  const held = breathIx >= 0 ? BREATHE[Math.min(breathIx, BREATHE.length - 1)]! : undefined;
  const rows: [string, string] = ["", ""];
  LETTERS.forEach((letter, i) => {
    const level = held ?? Math.max(0, Math.min(RAMP.length - 1, step - i));
    const shade = RAMP[level]!;
    for (const r of [0, 1] as const) rows[r] += (rows[r].length > 0 ? " " : "") + letter[r]!.replaceAll("█", shade);
  });
  return rows;
}

/** the frame's top and bottom rows at `step`: two runs growing inward from the corners until they meet.
 *  Empty strings before the mark has finished filling in — one thing happens at a time. */
export function frameRows(step: number): [string, string] {
  const grown = step - SWEEP_STEPS;
  if (grown < 0) return ["", ""];
  const half = Math.min(FRAME_COLS / 2, Math.max(0, grown) * FRAME_GROWTH);
  if (half === 0) return ["", ""];
  const run = "─".repeat(Math.max(0, half - 1));   // the corner glyph is the half's first column
  const gap = Math.max(0, FRAME_COLS - half * 2);
  const line = (l: string, r: string) => `${l}${run}${" ".repeat(gap)}${run}${r}`;
  return [line("╭", "╮"), line("╰", "╯")];
}

export interface IntroOptions {
  /** where the frames go; injected in tests */
  write: (s: string) => void;
  /** false → nothing is written, ever. A pipe is not a screen. */
  tty: boolean;
  version?: string;
  columns?: number;
  rows?: number;
  /** ms between steps; the default spreads INTRO_STEPS over INTRO_MS */
  frameMs?: number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (h: unknown) => void;
}

export interface Intro {
  /** what the session is doing right now, under the mark; "" clears the line */
  status: (line: string) => void;
  /** resolves when the show has played out — the caller awaits this before taking the screen */
  done: Promise<void>;
  /** cut it short: paint the final state and stop. Safe to call twice, and after `done`. */
  finish: () => void;
}

const CLEAR_SCREEN = "\x1b[2J\x1b[H";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";

/** Play the intro centred on a cleared screen. Off a terminal this is a no-op whose `done` is already
 *  resolved, so callers do not branch — the check lives here, once. */
export function startIntro(opts: IntroOptions): Intro {
  if (!opts.tty) return { status: () => {}, done: Promise.resolve(), finish: () => {} };
  const setI = opts.setInterval ?? setInterval;
  const clearI = opts.clearInterval ?? ((h: unknown) => clearInterval(h as ReturnType<typeof setInterval>));
  const cols = opts.columns ?? 80, rows = opts.rows ?? 24;
  const version = opts.version ?? "";
  let step = 0, line = "", ended = false, handle: unknown = null;
  let settle: () => void = () => {};
  const done = new Promise<void>((r) => { settle = r; });

  // the block is: frame top, blank, two mark rows, version, blank, frame bottom — centred as a whole, so
  // the frame does not shift the mark when it appears
  const BLOCK_ROWS = 7;
  const pad = (width: number): string => " ".repeat(Math.max(0, Math.floor((cols - width) / 2)));
  const markPad = pad(MARK_COLS), framePad = pad(FRAME_COLS);
  const top = "\n".repeat(Math.max(0, Math.floor((rows - BLOCK_ROWS) / 2)));

  const paint = (): void => {
    const [markTop, markBottom] = introFrame(step);
    const [frameTop, frameBottom] = frameRows(step);
    const frameLine = (s: string) => (s.length > 0 ? `${framePad}${s}` : "");
    opts.write([
      CLEAR_SCREEN, HIDE_CURSOR, top,
      `${frameLine(frameTop)}\n\n`,
      `${markPad}${markTop}\n${markPad}${markBottom}\n`,
      version.length > 0 ? `${pad(version.length)}${version}\n` : "\n",
      `${line.length > 0 ? `${pad(line.length)}${line}` : ""}\n`,
      `${frameLine(frameBottom)}\n`,
    ].join(""));
  };

  const end = (): void => {
    if (ended) return;
    ended = true;
    clearI(handle);
    step = INTRO_STEPS;
    line = "";
    paint();
    opts.write(`${SHOW_CURSOR}${CLEAR_SCREEN}`);   // hand a clean screen to whatever comes next
    settle();
  };

  paint();
  handle = setI(() => { if (step < INTRO_STEPS) { step += 1; paint(); } else end(); }, opts.frameMs ?? Math.round(INTRO_MS / INTRO_STEPS));

  return { status: (l: string) => { if (!ended) { line = l; paint(); } }, done, finish: end };
}
