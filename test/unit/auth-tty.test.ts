/** Port #37 MED-1 pin: the cooked-mode fallback scrub must erase EVERY row the echoed secret
 *  wrapped onto, not just the last one. Drives the real xterm.js emulator (headless) the way
 *  tui-app.test.ts does: feed exactly what a cooked terminal shows after Enter (prompt + echoed
 *  key + CRLF), then the sequence readSecret emits, and count key chars left in the buffer.
 *  Discriminating: the pre-fix single-row scrub ("\x1b[1A\x1b[2K") leaves 47 of 108 key chars
 *  visible at 80 columns and 87 at 120 (the critic's numbers). */

import { test, expect } from "bun:test";
import { VirtualTerminal } from "../../vendor/pi-tui/test/virtual-terminal.ts";
import { echoScrubSequence } from "../../src/providers/auth.ts";

const PROMPT = "ANTHROPIC_API_KEY for anthropic: "; // the real `rovecode auth set anthropic` prompt: 33 cols
// 108 chars like an Anthropic key, drawn from an alphabet DISJOINT from the prompt's so every key
// char left on screen is countable (prompt letters: A N T H R O P I C _ K E Y f o r a n t h i c)
const KEY = "sk-" + "0123456789bdegjlmqsuvwxz".repeat(5).slice(0, 105);
const KEY_CHARS = new Set(KEY);
const PROMPT_CHARS = new Set(PROMPT);
const UP_ERASE = "\x1b[1A\x1b[2K";

function visibleKeyChars(lines: string[]): number {
  let n = 0;
  for (const ch of lines.join("")) if (KEY_CHARS.has(ch) && !PROMPT_CHARS.has(ch)) n++;
  return n;
}

/** A terminal after the driver echoed the prompt + typed key and the user pressed Enter. */
async function cookedEcho(cols: number, key: string): Promise<VirtualTerminal> {
  const term = new VirtualTerminal(cols, 24);
  term.write(PROMPT + key + "\r\n");
  await term.flush();
  return term;
}

for (const cols of [80, 120]) {
  test(`echo scrub: 0 key chars remain after a wrapped 108-char key at ${cols} columns`, async () => {
    expect(KEY).toHaveLength(108);
    const term = await cookedEcho(cols, KEY);
    expect(visibleKeyChars(term.getScrollBuffer())).toBe(108); // sanity: the emulator saw the whole key
    term.write(echoScrubSequence(PROMPT.length, KEY.length, cols));
    await term.flush();
    expect(visibleKeyChars(term.getScrollBuffer())).toBe(0);
    expect(term.getScrollBuffer().join("")).not.toContain(KEY.slice(0, 8));
  });
}

test("echo scrub at an exact multiple of the width (deferred wrap) still leaves 0 key chars", async () => {
  const cols = 80;
  const key = KEY.slice(0, 2 * cols - PROMPT.length); // prompt + key fill two rows exactly (160 cells)
  const term = await cookedEcho(cols, key);
  expect(visibleKeyChars(term.getScrollBuffer())).toBe(key.length);
  term.write(echoScrubSequence(PROMPT.length, key.length, cols));
  await term.flush();
  expect(visibleKeyChars(term.getScrollBuffer())).toBe(0);
});

test("echoScrubSequence: one up+erase per wrapped row (ceil), never zero rows, unknown width assumes 80", () => {
  expect(echoScrubSequence(33, 108, 80)).toBe(UP_ERASE.repeat(2) + "\r"); // 141 cells → 2 rows
  expect(echoScrubSequence(33, 108, 120)).toBe(UP_ERASE.repeat(2) + "\r");
  expect(echoScrubSequence(33, 108, 200)).toBe(UP_ERASE + "\r"); // fits on one row
  expect(echoScrubSequence(33, 47, 80)).toBe(UP_ERASE + "\r"); // exactly 80 cells: still one row
  expect(echoScrubSequence(33, 48, 80)).toBe(UP_ERASE.repeat(2) + "\r"); // 81 → two rows
  expect(echoScrubSequence(0, 0, 80)).toBe(UP_ERASE + "\r");
  expect(echoScrubSequence(33, 108, 0)).toBe(UP_ERASE.repeat(2) + "\r"); // width unknown → 80
});
