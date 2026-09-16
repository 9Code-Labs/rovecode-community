/** Notification sequences + focus tracking for the interactive TUI — PURE: no I/O, no env reads, no timers, no settings.
 *
 *  Pattern source: openai/codex (Apache-2.0, pattern level; no code copied) — codex-rs/tui/src/notifications/mod.rs (the
 *  `auto` backend chooser: OSC 9 on Ghostty / iTerm2 / kitty / Warp / WezTerm, else BEL; the not-OSC-9 list incl. Windows
 *  Terminal, VsCode, AppleTerminal, Alacritty, Vte, Konsole), codex-rs/tui/src/notifications/osc9.rs (the tmux DCS
 *  passthrough: `ESC P tmux ;` + the OSC with every ESC doubled + `ESC \`, and its three test vectors),
 *  codex-rs/terminal-detection/src/lib.rs (the env markers each terminal sets; TERM_PROGRAM masks nothing here — any
 *  marker counts), codex-rs/tui/src/chatwidget/notifications.rs (the whitespace-normalised, capped preview). The
 *  focus-report idiom (DECSET 1004 → CSI I / CSI O) is xterm's. OSC 777 (rxvt-unicode / VTE `notify;title;body`), the
 *  control-byte scrub and the argv parser are rovecode's own.
 *
 *  Why a scrub at all: the model's last answer rides inside an OSC payload whose own terminator is BEL — an embedded BEL
 *  or ESC would end the toast early or start a second sequence. Nothing a model wrote reaches the wire unfiltered. */

export type Env = Readonly<Record<string, string | undefined>>;
export type NotifyMethod = "bell" | "osc9" | "osc777";
export type NotifyKind = "run_end" | "approval" | "question";
export interface NotifyDetail { tool?: string; argsPreview?: string; question?: string; lastText?: string }

export const BEL = "\x07";
/** DECSET 1004: the terminal reports focus changes as CSI I (in) / CSI O (out) */
export const FOCUS_ON = "\x1b[?1004h";
export const FOCUS_OFF = "\x1b[?1004l";
export const FOCUS_IN = "\x1b[I";
export const FOCUS_OUT = "\x1b[O";

/** strip every C0 / C1 control byte (tab, newline, CR count as whitespace first, so words never fuse), collapse
 *  whitespace, trim, and cut to `max` characters with a closing `…` */
export function scrub(text: string, max: number): string {
  const flat = text.replace(/[\x00-\x1f\x7f-\x9f]/g, (c) => (/\s/.test(c) ? " " : "")).replace(/\s+/g, " ").trim();
  if (max <= 0) return "";
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const has = (env: Env, key: string): boolean => (env[key] ?? "") !== "";
/** codex terminal-detection normalisation of TERM_PROGRAM: spaces, `-`, `_`, `.` dropped, lower-cased */
const program = (env: Env): string => (env.TERM_PROGRAM ?? "").replace(/[\s_.-]/g, "").toLowerCase();

/** `auto`: OSC 9 only where codex lists a toast-capable terminal (Ghostty, iTerm2, kitty, Warp, WezTerm), else the bell
 *  (Windows Terminal, vscode, Apple_Terminal, alacritty, VTE, unknown). OSC 777 is never picked automatically. */
export function autoMethod(env: Env): NotifyMethod {
  const p = program(env), term = env.TERM ?? "";
  const ghostty = p === "ghostty" || term === "xterm-ghostty" || has(env, "GHOSTTY_RESOURCES_DIR");
  const iterm = p === "itermapp" || p === "iterm" || p === "iterm2" || has(env, "ITERM_SESSION_ID");
  const kitty = p === "kitty" || term === "xterm-kitty" || has(env, "KITTY_WINDOW_ID");
  const warp = p === "warpterminal" || p === "warp";
  const wezterm = p === "wezterm" || has(env, "WEZTERM_VERSION");
  return ghostty || iterm || kitty || warp || wezterm ? "osc9" : "bell";
}

/** inside tmux (a non-empty TMUX): OSC sequences must ride a DCS passthrough to reach the outer terminal */
export const isTmux = (env: Env): boolean => has(env, "TMUX");

/** the byte-exact sequence for one notification (`msg` already scrubbed by the caller): bell `\x07`; osc9 `ESC ] 9 ; msg BEL`;
 *  osc777 `ESC ] 777 ; notify ; rovecode ; msg BEL`; under tmux the two OSC forms become `ESC P tmux ;` + the sequence with
 *  every ESC doubled + `ESC \` (BEL needs no wrap, tmux passes it through) */
export function sequenceFor(method: NotifyMethod, msg: string, tmux: boolean): string {
  if (method === "bell") return BEL;
  const osc = method === "osc9" ? `\x1b]9;${msg}\x07` : `\x1b]777;notify;rovecode;${msg}\x07`;
  return tmux ? `\x1bPtmux;${osc.replace(/\x1b/g, "\x1b\x1b")}\x1b\\` : osc;
}

/** the human line a toast shows — every part scrubbed and capped (approval: ≤ 40 chars of args; question ≤ 60; answer ≤ 120) */
export function message(kind: NotifyKind, d: NotifyDetail): string {
  if (kind === "approval") return `approval needed: ${scrub(d.tool ?? "", 40)} ${scrub(d.argsPreview ?? "", 40)}`.trimEnd();
  if (kind === "question") return `question: ${scrub(d.question ?? "", 60)}`;
  const last = scrub(d.lastText ?? "", 120);
  return last ? `run finished: ${last}` : "run finished";
}

export type Argv = string[] | { error: string };
export const isArgvError = (a: Argv): a is { error: string } => !Array.isArray(a);

/** `notify_command` text → argv: a JSON string array when it starts with `[` (`["notify-send","rovecode"]`), else split on
 *  whitespace; NEVER handed to a shell (a Windows path with `\` or an argument holding spaces needs the JSON form). `{ error }`
 *  for a `[`-prefixed value that is not a non-empty array of non-empty strings, and for an empty argv. */
export function parseArgv(value: string): Argv {
  const text = value.trim();
  if (text.startsWith("[")) {
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch (e) { return { error: `not a JSON array (${e instanceof Error ? e.message : String(e)})` }; }
    if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every((x) => typeof x === "string" && x.length > 0)) return { error: "a JSON array must hold one or more non-empty strings" };
    return parsed as string[];
  }
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  return words.length === 0 ? { error: "empty command" } : words;
}

/** Consumes CSI I / CSI O (focus in / out) from a raw input chunk BEFORE the surface's parser sees it. `focused` starts
 *  true: a terminal that never reports focus reads as focused — watched — so `notify_when: unfocused` stays silent there
 *  instead of ringing on every run. No carry across chunks — the classic surface feeds StdinBuffer-reassembled sequences
 *  and the sextant's parseInput degrades a split CSI to a harmless unknown key. */
export class FocusTracker {
  focused = true;
  /** the chunk with every focus report removed (the flag follows the LAST one in it); "" when nothing else was there */
  feed(chunk: string): string {
    if (!chunk.includes("\x1b[")) return chunk;
    return chunk.replace(/\x1b\[([IO])/g, (_m, c: string) => { this.focused = c === "I"; return ""; });
  }
}
