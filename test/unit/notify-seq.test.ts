/** tui/notify-seq.ts, the pure half of the notifications port (aion #79, 2026-09-07): byte-exact sequences (bell / OSC 9 /
 *  OSC 777 and the tmux DCS wrap with codex's three osc9.rs vectors), the `auto` chooser over env maps, scrub(), message(),
 *  parseArgv() and the FocusTracker. No I/O, no env, no timers. Mutation targets are named inline. */

import { describe, expect, test } from "bun:test";
import { BEL, FOCUS_IN, FOCUS_OFF, FOCUS_ON, FOCUS_OUT, FocusTracker, autoMethod, isArgvError, isTmux, message, parseArgv, scrub, sequenceFor } from "../../src/tui/notify-seq.ts";

describe("sequenceFor", () => {
  test("bell / osc9 / osc777 are byte-exact; the bell never wraps", () => {
    expect(BEL).toBe("\x07");
    expect(sequenceFor("bell", "anything", false)).toBe("\x07");
    expect(sequenceFor("bell", "anything", true)).toBe("\x07");
    expect(sequenceFor("osc9", "hello", false)).toBe("\x1b]9;hello\x07");
    expect(sequenceFor("osc777", "hello", false)).toBe("\x1b]777;notify;rovecode;hello\x07");
    expect(sequenceFor("osc9", "", false)).toBe("\x1b]9;\x07");
  });

  test("tmux: the DCS passthrough with every ESC doubled — codex osc9.rs vectors (hello, done, danger ESC [31m)", () => {
    expect(sequenceFor("osc9", "hello", true)).toBe("\x1bPtmux;\x1b\x1b]9;hello\x07\x1b\\");
    expect(sequenceFor("osc9", "done", true)).toBe("\x1bPtmux;\x1b\x1b]9;done\x07\x1b\\");
    expect(sequenceFor("osc9", "danger\x1b[31m", true)).toBe("\x1bPtmux;\x1b\x1b]9;danger\x1b\x1b[31m\x07\x1b\\"); // MUTATION: ESC doubling dropped
    expect(sequenceFor("osc777", "x", true)).toBe("\x1bPtmux;\x1b\x1b]777;notify;rovecode;x\x07\x1b\\");
    expect(isTmux({ TMUX: "/tmp/tmux-1000/default,123,0" })).toBe(true);
    expect(isTmux({ TMUX: "" })).toBe(false);
    expect(isTmux({ TMUX_PANE: "%0" })).toBe(false); // TMUX alone decides (the injected env, never the process's)
    expect(isTmux({})).toBe(false);
  });
});

describe("autoMethod", () => {
  test("osc9 for each Ghostty / iTerm2 / kitty / Warp / WezTerm marker", () => {
    const osc9: Record<string, string>[] = [
      { TERM_PROGRAM: "ghostty" }, { TERM_PROGRAM: "Ghostty" }, { TERM: "xterm-ghostty" }, { GHOSTTY_RESOURCES_DIR: "/usr/share/ghostty" },
      { TERM_PROGRAM: "iTerm.app" }, { ITERM_SESSION_ID: "w0t1p0:0000" },
      { KITTY_WINDOW_ID: "1" }, { TERM: "xterm-kitty" },
      { TERM_PROGRAM: "WarpTerminal" },
      { TERM_PROGRAM: "WezTerm" }, { WEZTERM_VERSION: "20240203-110809-5046fc22" },
    ];
    for (const env of osc9) expect([env, autoMethod(env)]).toEqual([env, "osc9"]);
    expect(autoMethod({ TERM_PROGRAM: "WezTerm", TERM: "xterm-256color", COLORTERM: "truecolor" })).toBe("osc9");
  });

  test("bell for Windows Terminal, vscode, Apple_Terminal, alacritty, VTE, konsole and an empty env — osc777 is never auto-picked", () => {
    const bell: Record<string, string>[] = [
      { WT_SESSION: "9b3c4b8e" }, { WT_SESSION: "1", TERM: "xterm-256color", COLORTERM: "truecolor" },
      { TERM_PROGRAM: "vscode" }, { TERM_PROGRAM: "Apple_Terminal" }, { TERM_SESSION_ID: "w0t0p0" }, { TERM_PROGRAM: "alacritty" },
      { VTE_VERSION: "7200" }, { KONSOLE_VERSION: "230800" }, { TERM: "xterm-256color" }, { TERM: "dumb" }, {},
      { TERM_PROGRAM: "", TERM: "", WEZTERM_VERSION: "" }, // empty markers are not markers
    ];
    for (const env of bell) expect([env, autoMethod(env)]).toEqual([env, "bell"]); // MUTATION: osc9 under WT_SESSION
    for (const env of [...bell, { TERM_PROGRAM: "WezTerm" }]) expect(autoMethod(env)).not.toBe("osc777");
  });
});

describe("scrub", () => {
  test("strips C0/C1 control bytes (whitespace controls become a space first), collapses whitespace, trims, caps with …", () => {
    expect(scrub("  hello\n\n  world\t!  ", 120)).toBe("hello world !");
    expect(scrub("line1\nline2", 120)).toBe("line1 line2"); // a newline never fuses two words
    expect(scrub("a\x07\x1b]9;x\x07b", 120)).toBe("a]9;xb");
    const injected = scrub("done \x07\x1b]9;x\x07 now", 120);
    expect(injected).toBe("done ]9;x now");
    expect(/[\x00-\x1f\x7f-\x9f]/.test(injected)).toBe(false); // MUTATION: scrub removed → BEL / ESC survive
    expect(scrub("\x7f\x80\x9f\x00", 10)).toBe("");
    expect(scrub("abcdefghij", 10)).toBe("abcdefghij");
    expect(scrub("abcdefghijk", 10)).toBe("abcdefghi…");
    expect(scrub("abcdefghijk", 10).length).toBe(10);
    expect(scrub("x", 0)).toBe("");
    expect(scrub("", 40)).toBe("");
    expect(scrub("é✓ ünïcode", 40)).toBe("é✓ ünïcode"); // non-ASCII text is not control
  });

  test("message(): the three shapes with their caps (args ≤ 40, question ≤ 60, answer ≤ 120) and the `run finished` fallback", () => {
    expect(message("approval", { tool: "bash", argsPreview: '{"command":"ls -la"}' })).toBe('approval needed: bash {"command":"ls -la"}');
    expect(message("approval", { tool: "edit", argsPreview: "x".repeat(80) })).toBe(`approval needed: edit ${"x".repeat(39)}…`);
    expect(message("approval", { tool: "undo" })).toBe("approval needed: undo");
    expect(message("approval", { tool: "bash", argsPreview: "{\"command\":\"echo \x07\"}" })).toBe('approval needed: bash {"command":"echo "}');
    expect(message("question", { question: "Which\nfile?" })).toBe("question: Which file?");
    expect(message("question", { question: "q".repeat(70) })).toBe(`question: ${"q".repeat(59)}…`);
    expect(message("run_end", {})).toBe("run finished");
    expect(message("run_end", { lastText: "  \x07 \n " })).toBe("run finished");
    expect(message("run_end", { lastText: "all done\x1b]9;x\x07." })).toBe("run finished: all done]9;x.");
    expect(message("run_end", { lastText: "y".repeat(200) })).toBe(`run finished: ${"y".repeat(119)}…`);
    for (const m of [message("run_end", { lastText: "a\x07\x1b]9;x\x07" }), message("approval", { tool: "t\x1b", argsPreview: "\x9f" }), message("question", { question: "\x1b[2J" })]) {
      expect(/[\x00-\x1f\x7f-\x9f]/.test(m)).toBe(false);
    }
  });
});

describe("parseArgv", () => {
  test("a JSON string array, a whitespace split, and the error shapes (never a shell)", () => {
    expect(parseArgv('["notify-send","rovecode"]')).toEqual(["notify-send", "rovecode"]);
    expect(parseArgv('  ["C:\\\\tools\\\\toast.exe", "a b"] ')).toEqual(["C:\\tools\\toast.exe", "a b"]);
    expect(parseArgv("notify-send rovecode  done")).toEqual(["notify-send", "rovecode", "done"]);
    expect(parseArgv("\tnotify-send\n rovecode ")).toEqual(["notify-send", "rovecode"]);
    expect(parseArgv("C:\\tools\\x.exe")).toEqual(["C:\\tools\\x.exe"]); // a backslash path is fine — no shell parser is involved
    expect(parseArgv("notify-send $(rm -rf ~) ; echo `x` | cat")).toEqual(["notify-send", "$(rm", "-rf", "~)", ";", "echo", "`x`", "|", "cat"]); // operators are literal argv words: nothing interprets them
    for (const bad of ["[bad", "[1,2]", "[]", '[""]', '["a", 1]', "[\"a\":1}", "", "   ", "[]   "]) {
      const r = parseArgv(bad);
      expect([bad, isArgvError(r)]).toEqual([bad, true]);
      if (isArgvError(r)) expect(r.error.length).toBeGreaterThan(0);
    }
    expect(isArgvError(["x"])).toBe(false);
    expect(isArgvError({ error: "e" })).toBe(true);
  });
});

describe("FocusTracker", () => {
  test("starts focused; CSI O → false, CSI I → true; the reports are removed and the rest forwarded verbatim; the LAST report wins", () => {
    const t = new FocusTracker();
    expect(t.focused).toBe(true); // MUTATION: initialised false → a terminal that never reports focus rings on every run
    expect(t.feed(FOCUS_OUT)).toBe("");
    expect(t.focused).toBe(false);
    expect(t.feed(FOCUS_IN)).toBe("");
    expect(t.focused).toBe(true);
    expect(t.feed("\x1b[Oabc")).toBe("abc"); // MUTATION: CSI O forwarded to the parser
    expect(t.focused).toBe(false);
    expect(t.feed("\x1b[Ia")).toBe("a");
    expect(t.focused).toBe(true);
    expect(t.feed("\x1b[O\x1b[I")).toBe("");
    expect(t.focused).toBe(true);
    expect(t.feed("\x1b[I\x1b[O")).toBe("");
    expect(t.focused).toBe(false);
    expect(t.feed("ab\x1b[Icd\x1b[Oef")).toBe("abcdef");
    expect(t.focused).toBe(false);
  });

  test("plain text, other CSI keys, a paste, a lone ESC, SS3 and an empty chunk pass through untouched and leave the flag alone", () => {
    const t = new FocusTracker();
    for (const s of ["hello", "\x1b[A", "\x1b[Z", "\x1b[200~paste\x1b[201~", "\x1b", "", "\x1bO", "\x1bOI", "\x1b[1;", "\x1b[?1004h", "é✓", "\x1b[<0;10;5M"]) {
      expect([s, t.feed(s)]).toEqual([s, s]);
    }
    expect(t.focused).toBe(true);
    expect(FOCUS_ON).toBe("\x1b[?1004h");
    expect(FOCUS_OFF).toBe("\x1b[?1004l");
    expect(FOCUS_IN).toBe("\x1b[I");
    expect(FOCUS_OUT).toBe("\x1b[O");
  });
});
