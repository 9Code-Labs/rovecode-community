/** The opening intro: ROVECODE assembles itself in the middle of the terminal.
 *
 *  Four acts, all of them Berkay's picks (2026-09-06). The mark fills in left to right — chosen over a
 *  checklist that ticks itself off and a single progress bar. A hairline frame draws inward from the four
 *  corners until the halves meet — chosen over a shimmer pass and a rain of blocks. The cloud mascot leans
 *  down out of the frame's top line — chosen over raining the letters into place and rising from the
 *  bottom. Then the mark breathes once. Centred on a cleared screen, and it hands over to the session's
 *  card (core/voice.ts).
 *
 *  The CLI holds this screen until the runtime and interface are ready, not merely until their modules
 *  are imported. The CLI waits for both the choreography and the prepared first frame, concurrently.
 *  Fast boots still show the intro (~1.1s); slow boots hold the completed mark with a two-Hz activity line.
 *  Standalone callers can still play the finite animation. Off for pipes, --plain, ROVECODE_INTRO=0
 *  and --no-intro.
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

/** The mascot, hanging down from behind the frame's top line — Berkay's pick over the cloud raining the
 *  letters into place and rising from the bottom (2026-09-06).
 *
 *  This is a COPY of SPRITE + FACE from sextant/pet.ts, not an import, and that is deliberate: importing
 *  the sextant module here would pull the panel painter into the boot path of a process that has not
 *  decided to draw panels yet, which is the opposite of the work that made startup cheap. The copy cannot
 *  drift — test/unit/intro.test.ts asserts these rows are identical to the ones the TUI paints, so the
 *  intro's cloud and the session's cloud are the same cloud or the suite fails. */
const CLOUD_OUTLINE: readonly string[] = [
  "       ╭────╮     ",
  "   ╭───╯    ╰──╮  ",
  "  ╭╯           ╰╮ ",
  "  │             │ ",
  "  ╰╮           ╭╯ ",
  "   ╰───────────╯  ",
];
/** the face's columns and rows, copied from pet.ts FACE. Placed by INDEX rather than typed into the art,
 *  so an eye cannot end up one column off the anchor the TUI paints it on — which is exactly what happened
 *  when these rows were written by hand. */
const FACE_AT = { EYE_L: 6, EYE_R: 12, MOUTH: 9, EYE_ROW: 3, MOUTH_ROW: 4 } as const;
const CLOUD: readonly string[] = CLOUD_OUTLINE.map((row, r) => {
  const cells = [...row];
  if (r === FACE_AT.EYE_ROW) { cells[FACE_AT.EYE_L] = "•"; cells[FACE_AT.EYE_R] = "•"; }
  if (r === FACE_AT.MOUTH_ROW) cells[FACE_AT.MOUTH] = "◡";
  return cells.join("");
});
export const CLOUD_COLS = 18;
/** rows of cloud that hang BELOW the frame line once it has fully descended */
const CLOUD_BODY = CLOUD.length - 1;

/** the four acts, in steps */
const SWEEP_STEPS = LETTERS.length + RAMP.length - 1;                 // the mark fills in
const FRAME_STEPS = Math.ceil(FRAME_COLS / 2 / FRAME_GROWTH);          // the corners reach the middle
const CLOUD_STEPS = CLOUD.length;                                      // the mascot leans over the line
const BREATHE = [3, 2, 3] as const;                                    // █ ▓ █, once
export const INTRO_STEPS = SWEEP_STEPS + FRAME_STEPS + CLOUD_STEPS + BREATHE.length;
/** how long the whole show takes when nothing interrupts it */
export const INTRO_MS = 1100;

/** the two mark rows at `step`; step 0 is the whole word at its faintest, SWEEP_STEPS is solid. Past the
 *  sweep the mark holds, except for the breath at the very end. */
export function introFrame(step: number): [string, string] {
  const breathIx = step - SWEEP_STEPS - FRAME_STEPS - CLOUD_STEPS;
  const held = breathIx >= 0 ? BREATHE[Math.min(breathIx, BREATHE.length - 1)]! : undefined;
  const rows: [string, string] = ["", ""];
  LETTERS.forEach((letter, i) => {
    const level = held ?? Math.max(0, Math.min(RAMP.length - 1, step - i));
    const shade = RAMP[level]!;
    for (const r of [0, 1] as const) rows[r] += (rows[r].length > 0 ? " " : "") + letter[r]!.replaceAll("█", shade);
  });
  return rows;
}

/** How far the cloud has leaned over the top line: 0 before it starts, CLOUD.length when it is all the
 *  way out. It only begins once the frame has closed — one thing happens at a time. */
export function cloudDescent(step: number): number {
  return Math.max(0, Math.min(CLOUD.length, step - SWEEP_STEPS - FRAME_STEPS));
}

/** The cloud's rows that hang BELOW the frame line, padded to a fixed count so the block below never
 *  shifts as it comes down — the mark must not jump while the mascot arrives. */
export function cloudRows(step: number): string[] {
  const d = cloudDescent(step);
  const shown = CLOUD.slice(1, Math.max(0, d));
  return [...shown, ...Array.from({ length: CLOUD_BODY - shown.length }, () => "")];
}

/** The cloud's FIRST row is drawn into the frame's top line rather than under it, which is what makes it
 *  read as leaning over the edge instead of floating below it. Spaces in the sprite leave the line
 *  showing through; the sprite's own glyphs cut into it. */
export function mergeCloudIntoLine(line: string, step: number): string {
  if (cloudDescent(step) === 0 || line.length === 0) return line;
  const at = Math.max(0, Math.floor((line.length - CLOUD_COLS) / 2));
  // always the sprite's FIRST row: it is the cloud's crown, and it stays cut into the line while the body
  // appears underneath. Advancing it row by row instead made the line show the cloud's underside.
  const row = CLOUD[0]!;
  const chars = [...line];
  [...row].forEach((ch, i) => { if (ch !== " " && at + i < chars.length) chars[at + i] = ch; });
  return chars.join("");
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
  /** CLI loading mode: stay visible after the sequence until finish(), with a low-frequency activity line. */
  holdUntilReady?: boolean;
  /** Live terminal dimensions and resize subscription; no stdin is read by the intro. */
  size?: () => { columns: number; rows: number };
  onResize?: (paint: () => void) => () => void;
  /** ms between steps; the default spreads INTRO_STEPS over INTRO_MS */
  frameMs?: number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (h: unknown) => void;
}

/** rows the whole block occupies: frame top (the cloud’s crown cut into it), the cloud’s body, a blank,
 *  the two mark rows, the version, the status line, the frame bottom */
export const INTRO_ROWS = 7 + (CLOUD.length - 1);

/** Is there room to play it? A terminal too narrow wraps the frame into nonsense; one too short scrolls
 *  its own top away. Both were real — 34×24 overflowed by six columns, 40×10 painted thirteen lines — and
 *  neither is worth degrading the animation for: the session’s card already has a prose form for a small
 *  terminal, and no intro at all is better than a broken one. One row and one column of margin, so the
 *  block is never flush against the edges. */
export function introFits(columns: number, rows: number): boolean {
  return columns >= FRAME_COLS + 2 && rows >= INTRO_ROWS + 2;
}

export interface Intro {
  /** what the session is doing right now, under the mark; "" clears the line */
  status: (line: string) => void;
  /** The mark has actually played through. Does not clear it; slow preparation may still be running. */
  animationDone: Promise<void>;
  /** resolves after finish(), or after the finite sequence when holdUntilReady is false */
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
  const size = opts.size ?? (() => ({ columns: opts.columns ?? 80, rows: opts.rows ?? 24 }));
  const initial = size();
  if (!opts.tty || !introFits(initial.columns, initial.rows)) return { status: () => {}, animationDone: Promise.resolve(), done: Promise.resolve(), finish: () => {} };
  const setI = opts.setInterval ?? setInterval;
  const clearI = opts.clearInterval ?? ((h: unknown) => clearInterval(h as ReturnType<typeof setInterval>));
  let step = 0, line = "", ended = false, holding = false, pulse = 0, handle: unknown = null;
  let paintedSize = initial;
  let unsubscribe: (() => void) | undefined;
  let settle: () => void = () => {};
  const done = new Promise<void>((r) => { settle = r; });
  let animationSettled: () => void = () => {};
  const animationDone = new Promise<void>((r) => { animationSettled = r; });
  const label = (): string => line && holding && !ended ? `${line} ${"·".repeat(pulse + 1)}` : line;
  const centred = (text: string, cols: number): string => {
    const clipped = [...text.replace(/\s+/g, " ")].slice(0, Math.max(0, cols - 2)).join("");
    return " ".repeat(Math.max(0, Math.floor((cols - clipped.length) / 2))) + clipped;
  };
  const paint = (): void => {
    const { columns: cols, rows } = paintedSize = size();
    if (!introFits(cols, rows)) { opts.write(CLEAR_SCREEN + HIDE_CURSOR); return; }
    const pad = (width: number): string => " ".repeat(Math.max(0, Math.floor((cols - width) / 2)));
    const markPad = pad(MARK_COLS), framePad = pad(FRAME_COLS);
    const cloudPad = framePad + " ".repeat(Math.max(0, Math.floor((FRAME_COLS - CLOUD_COLS) / 2)));
    const top = "\n".repeat(Math.max(0, Math.floor((rows - INTRO_ROWS) / 2)));
    const [markTop, markBottom] = introFrame(step);
    const [frameTop, frameBottom] = frameRows(step);
    const frameLine = (s: string) => (s.length > 0 ? `${framePad}${s}` : "");
    opts.write([
      CLEAR_SCREEN, HIDE_CURSOR, top,
      `${frameLine(mergeCloudIntoLine(frameTop, step))}\n`,
      cloudRows(step).map((r) => `${r.length > 0 ? cloudPad + r : ""}\n`).join(""),
      "\n",
      `${markPad}${markTop}\n${markPad}${markBottom}\n`,
      `${centred(opts.version ?? "", cols)}\n`,
      `${centred(label(), cols)}\n`,
      `${frameLine(frameBottom)}\n`,
    ].join(""));
  };
  const paintStatus = (): void => {
    if (ended) return;
    const s = size();
    if (s.columns !== paintedSize.columns || s.rows !== paintedSize.rows) { paint(); return; }
    if (!introFits(s.columns, s.rows)) return;
    const y = Math.max(0, Math.floor((s.rows - INTRO_ROWS) / 2)) + INTRO_ROWS - 1;
    const esc = String.fromCharCode(27);
    // Keep the logo still: slow boots repaint one short status row, not the entire terminal.
    opts.write(`${esc}[${y};1H${esc}[2K${centred(label(), s.columns)}`);
  };
  const end = (): void => {
    if (ended) return;
    ended = true;
    clearI(handle);
    unsubscribe?.();
    step = INTRO_STEPS;
    line = "";
    paint();
    opts.write(`${SHOW_CURSOR}${CLEAR_SCREEN}`);
    animationSettled();
    settle();
  };

  paint();
  unsubscribe = opts.onResize?.(() => { if (!ended) paint(); });
  handle = setI(() => {
    if (ended) return;
    if (step < INTRO_STEPS) { step += 1; paint(); if (step === INTRO_STEPS) animationSettled(); }
    else if (!opts.holdUntilReady) end();
    else {
      clearI(handle);
      holding = true;
      paintStatus();
      handle = setI(() => { pulse = (pulse + 1) % 3; paintStatus(); }, 500);
    }
  }, opts.frameMs ?? Math.round(INTRO_MS / INTRO_STEPS));

  return { status: (l: string) => { if (!ended && l !== line) { line = l; paintStatus(); } }, animationDone, done, finish: end };
}
