/** Sextant terminal I/O + surface choice (port #44). The ONE module on the sextant path that touches
 *  vendor: ProcessIO drives process.stdin/stdout (raw mode, utf8, resize, and pi-tui's Windows
 *  ENABLE_VIRTUAL_TERMINAL_INPUT helper — without it libuv's console reader drops modifier state and
 *  Shift+Tab arrives as a plain \t instead of CSI Z; the helper is loaded AFTER setRawMode(true), which
 *  resets the console mode, exactly as vendor/pi-tui/src/terminal.ts:186-190 does). MemoryIO is the
 *  in-memory double tests and the smoke drive. chooseSurface() is the pure `aion` default rule:
 *  sextant only on a TTY of at least 100×30 that renders truecolor; `--classic` beats everything;
 *  AION_TUI=classic|sextant overrides the heuristics (a non-TTY still never gets sextant). */

import { createRequire } from "node:module";
import { join } from "node:path";
import { getNativeModuleCandidates } from "../../vendor/pi-tui/src/native-module-path.ts";
import { SextantRenderer } from "../sextant/sextant-renderer.ts";
import { SEXTANT_MIN_COLS, SEXTANT_MIN_ROWS, type TerminalIO } from "../sextant/types.ts";
import type { Renderer } from "./renderer.ts";

const cjsRequire = createRequire(import.meta.url);
/** the vendored pi-tui source dir — getNativeModuleCandidates resolves `native/…` beside it */
const VENDOR_TUI_URL = new URL("../../vendor/pi-tui/src/terminal.ts", import.meta.url).href;

export type Env = Readonly<Record<string, string | undefined>>;

/** where pi-tui's prebuilt console-mode helper may live (vendor tree, or beside a compiled binary) */
export function vtInputCandidates(arch: string = process.arch, execPath: string = process.execPath): string[] {
  return getNativeModuleCandidates(join("native", "win32", "prebuilds", `win32-${arch}`, "win32-console-mode.node"), { moduleUrl: VENDOR_TUI_URL, execPath });
}

/** pi-tui terminal.ts enableWindowsVTInput: flip ENABLE_VIRTUAL_TERMINAL_INPUT on the stdin console;
 *  false when the helper is unavailable (Shift+Tab is then indistinguishable from Tab) */
export function enableWindowsVTInput(arch: string = process.arch): boolean {
  if (arch !== "x64" && arch !== "arm64") return false;
  for (const p of vtInputCandidates(arch)) {
    try {
      const helper = cjsRequire(p) as { enableVirtualTerminalInput?: () => boolean };
      return helper.enableVirtualTerminalInput?.() ?? false;
    } catch { /* try the next packaging location */ }
  }
  return false;
}

/** the slice of process.stdin the surface uses (tests inject a fake) */
export interface RawStdin {
  isRaw?: boolean;
  setRawMode?(mode: boolean): unknown;
  setEncoding(enc: BufferEncoding): unknown;
  resume(): unknown;
  pause(): unknown;
  on(event: "data", cb: (chunk: string | Buffer) => void): unknown;
  off(event: "data", cb: (chunk: string | Buffer) => void): unknown;
}
/** the slice of process.stdout the surface uses */
export interface RawStdout {
  write(s: string): unknown;
  isTTY?: boolean;
  columns?: number;
  rows?: number;
  on(event: "resize", cb: () => void): unknown;
  off(event: "resize", cb: () => void): unknown;
}
export interface ProcessIOOptions {
  /** default process.platform; the VT helper runs on win32 only */
  platform?: string;
  /** the VT-input helper (default enableWindowsVTInput) */
  vtInput?: () => boolean;
}

export class ProcessIO implements TerminalIO {
  private wasRaw = false;
  constructor(
    private readonly stdin: RawStdin = process.stdin,
    private readonly stdout: RawStdout = process.stdout,
    readonly env: Env = process.env,
    private readonly opts: ProcessIOOptions = {},
  ) {}
  write(s: string): void { this.stdout.write(s); }
  onInput(cb: (chunk: string) => void): () => void {
    const h = (d: string | Buffer): void => cb(typeof d === "string" ? d : d.toString("utf8"));
    this.stdin.on("data", h);
    return () => { this.stdin.off("data", h); };
  }
  onResize(cb: (cols: number, rows: number) => void): () => void {
    const h = (): void => { const { cols, rows } = this.size(); cb(cols, rows); };
    this.stdout.on("resize", h);
    return () => { this.stdout.off("resize", h); };
  }
  size(): { cols: number; rows: number } { return { cols: this.stdout.columns || 80, rows: this.stdout.rows || 24 }; }
  /** raw mode + utf8 + flowing, then the Windows VT-input helper (must follow setRawMode, which resets the console flags) */
  enterRaw(): void {
    this.wasRaw = this.stdin.isRaw ?? false;
    this.stdin.setRawMode?.(true);
    this.stdin.setEncoding("utf8");
    this.stdin.resume();
    if ((this.opts.platform ?? process.platform) === "win32") (this.opts.vtInput ?? enableWindowsVTInput)();
  }
  /** restore the previous raw state and pause stdin so buffered bytes never reach the parent shell */
  leaveRaw(): void {
    this.stdin.setRawMode?.(this.wasRaw);
    this.stdin.pause();
  }
}

/** in-memory TerminalIO: records writes, replays fed input, emulates resizes (tests + `smoke-tui --sextant`) */
export class MemoryIO implements TerminalIO {
  readonly writes: string[] = [];
  raw = false;
  private readonly inputs = new Set<(chunk: string) => void>();
  private readonly resizes = new Set<(cols: number, rows: number) => void>();
  constructor(public cols = 160, public rows = 44, readonly env: Env = {}) {}
  write(s: string): void { this.writes.push(s); }
  onInput(cb: (chunk: string) => void): () => void { this.inputs.add(cb); return () => { this.inputs.delete(cb); }; }
  onResize(cb: (cols: number, rows: number) => void): () => void { this.resizes.add(cb); return () => { this.resizes.delete(cb); }; }
  size(): { cols: number; rows: number } { return { cols: this.cols, rows: this.rows }; }
  enterRaw(): void { this.raw = true; }
  leaveRaw(): void { this.raw = false; }
  /** deliver raw terminal bytes (keys, mouse, paste) */
  feed(chunk: string): void { for (const cb of [...this.inputs]) cb(chunk); }
  resize(cols: number, rows: number): void { this.cols = cols; this.rows = rows; for (const cb of [...this.resizes]) cb(cols, rows); }
  /** everything written so far */
  output(): string { return this.writes.join(""); }
  /** live input + resize subscriptions (0 after stop) */
  get listeners(): number { return this.inputs.size + this.resizes.size; }
}

// ------------------------------------------------------------------ surface choice

const TC_PROGRAMS = new Set(["vscode", "iTerm.app", "WezTerm", "ghostty"]);

/** the terminal renders 24-bit color: COLORTERM truecolor/24bit, Windows Terminal (WT_SESSION), a
 *  known TERM_PROGRAM (vscode, iTerm.app, WezTerm, ghostty) or a kitty/`-direct` TERM */
export function truecolor(env: Env): boolean {
  const ct = (env.COLORTERM ?? "").toLowerCase();
  if (ct === "truecolor" || ct === "24bit") return true;
  if (env.WT_SESSION) return true;
  if (TC_PROGRAMS.has(env.TERM_PROGRAM ?? "")) return true;
  return /kitty|direct/.test(env.TERM ?? "");
}

export interface StdoutInfo { isTTY?: boolean; columns?: number; rows?: number }

/** the heuristic: a TTY of at least SEXTANT_MIN_COLS×SEXTANT_MIN_ROWS with truecolor */
export function sextantOk(env: Env, stdout: StdoutInfo): boolean {
  return !!stdout.isTTY && (stdout.columns ?? 0) >= SEXTANT_MIN_COLS && (stdout.rows ?? 0) >= SEXTANT_MIN_ROWS && truecolor(env);
}

export type Surface = "sextant" | "classic";

/** `--classic` wins; AION_TUI=classic forces classic, AION_TUI=sextant forces sextant on any TTY (size and
 *  color heuristics skipped); otherwise sextantOk(). A non-TTY stdout never gets sextant. */
export function chooseSurface(cli: { classic: boolean }, env: Env, stdout: StdoutInfo): Surface {
  if (cli.classic) return "classic";
  const force = (env.AION_TUI ?? "").trim().toLowerCase();
  if (force === "classic") return "classic";
  if (force === "sextant") return stdout.isTTY ? "sextant" : "classic";
  return sextantOk(env, stdout) ? "sextant" : "classic";
}

/** main.ts: the renderer to hand runTui — a SextantRenderer over the process terminal, or undefined
 *  (runTui then builds the classic PiTuiRenderer exactly as before) */
export function pickRenderer(cli: { classic: boolean; pet?: string }, env: Env = process.env, stdout: RawStdout = process.stdout): Renderer | undefined {
  if (chooseSurface(cli, env, stdout) !== "sextant") return undefined;
  return new SextantRenderer({ io: new ProcessIO(process.stdin, stdout, env), truecolor: truecolor(env), ...(cli.pet !== undefined ? { pet: cli.pet } : {}), ...(env.AION_THEME ? { theme: env.AION_THEME } : {}) });
}
