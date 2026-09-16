/** Port #44 — sextant-io.ts: the surface choice (truecolor / 256-color heuristics, the 100×30 floor, the
 *  40×12 Screen floor even when forced, the TTY gate, ROVECODE_TUI / --classic overrides), MemoryIO, ProcessIO
 *  raw-mode ordering incl. the Windows VT-input helper (win32 only, AFTER setRawMode), utf8 decoding of
 *  Buffer chunks, resize, and pickRenderer (incl. the SGR mode it hands the renderer). */

import { test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { SextantRenderer } from "../../src/sextant/sextant-renderer.ts";
import { chooseSurface, colorDepth, fitsFloor, MemoryIO, pickRenderer, ProcessIO, sextantOk, truecolor, vtInputCandidates, type RawStdout } from "../../src/tui/sextant-io.ts";

const tty = (columns = 160, rows = 44) => ({ isTTY: true, columns, rows });
const NOOP_HOOKS = { onSubmit() {}, onInterrupt() {}, onExit() {} };

class FakeStdin {
  isRaw = false;
  log: string[] = [];
  handlers = new Set<(d: string | Buffer) => void>();
  enders = new Set<() => void>();
  setRawMode(m: boolean): this { this.isRaw = m; this.log.push(`raw:${m}`); return this; }
  setEncoding(e: string): this { this.log.push(`enc:${e}`); return this; }
  resume(): this { this.log.push("resume"); return this; }
  pause(): this { this.log.push("pause"); return this; }
  on(_e: "data" | "end", cb: unknown): this {
    if (_e === "end") this.enders.add(cb as () => void); else this.handlers.add(cb as (d: string | Buffer) => void);
    return this;
  }
  off(_e: "data" | "end", cb: unknown): this {
    if (_e === "end") this.enders.delete(cb as () => void); else this.handlers.delete(cb as (d: string | Buffer) => void);
    return this;
  }
  emit(d: string | Buffer): void { for (const h of this.handlers) h(d); }
  end(): void { for (const e of this.enders) e(); }
}
class FakeStdout implements RawStdout {
  isTTY = true; columns: number | undefined = 120; rows: number | undefined = 40; out = "";
  resizers = new Set<() => void>();
  write(s: string): boolean { this.out += s; return true; }
  on(_e: "resize", cb: () => void): this { this.resizers.add(cb); return this; }
  off(_e: "resize", cb: () => void): this { this.resizers.delete(cb); return this; }
  emitResize(): void { for (const r of this.resizers) r(); }
}

test("truecolor(): COLORTERM truecolor/24bit, WT_SESSION, TERM_PROGRAM vscode/iTerm.app/WezTerm/ghostty, TERM kitty/-direct — nothing else", () => {
  expect(truecolor({ COLORTERM: "truecolor" })).toBe(true);
  expect(truecolor({ COLORTERM: "24bit" })).toBe(true);
  expect(truecolor({ COLORTERM: "TRUECOLOR" })).toBe(true);
  expect(truecolor({ WT_SESSION: "abc" })).toBe(true);
  for (const p of ["vscode", "iTerm.app", "WezTerm", "ghostty"]) expect(truecolor({ TERM_PROGRAM: p })).toBe(true);
  expect(truecolor({ TERM: "xterm-kitty" })).toBe(true);
  expect(truecolor({ TERM: "xterm-direct" })).toBe(true);
  expect(truecolor({ TERM: "xterm-256color" })).toBe(false);
  expect(truecolor({ TERM_PROGRAM: "Apple_Terminal" })).toBe(false);
  expect(truecolor({ COLORTERM: "yes" })).toBe(false);
  expect(truecolor({})).toBe(false);
});

test("colorDepth(): truecolor per the heuristics; 256 for a *-256color TERM with COLORTERM unset or blank; none for a plain TERM or a COLORTERM that says something else", () => {
  expect(colorDepth({ COLORTERM: "truecolor", TERM: "xterm-256color" })).toBe("truecolor");
  expect(colorDepth({ WT_SESSION: "1", TERM: "xterm-256color" })).toBe("truecolor");
  expect(colorDepth({ TERM: "xterm-256color" })).toBe("256");
  expect(colorDepth({ TERM: "screen-256color" })).toBe("256");
  expect(colorDepth({ TERM: "tmux-256color", COLORTERM: "  " })).toBe("256");
  expect(colorDepth({ TERM: "xterm-256color", COLORTERM: "yes" })).toBe("none");   // COLORTERM present but not truecolor: not claimed
  expect(colorDepth({ TERM: "xterm" })).toBe("none");
  expect(colorDepth({ TERM: "dumb" })).toBe("none");
  expect(colorDepth({})).toBe("none");
});

test("sextantOk(): TTY and ≥ 100×30 and truecolor OR 256 colors — every leg is necessary, the floor is inclusive", () => {
  const env = { COLORTERM: "truecolor" };
  expect(sextantOk(env, tty(160, 44))).toBe(true);
  expect(sextantOk(env, tty(100, 30))).toBe(true);
  expect(sextantOk(env, tty(99, 44))).toBe(false);
  expect(sextantOk(env, tty(160, 29))).toBe(false);
  expect(sextantOk(env, { isTTY: false, columns: 160, rows: 44 })).toBe(false);
  expect(sextantOk(env, { columns: 160, rows: 44 })).toBe(false); // isTTY undefined = a pipe
  expect(sextantOk({}, tty(160, 44))).toBe(false);                // no color evidence at all
  expect(sextantOk({ TERM: "xterm-256color" }, tty(160, 44))).toBe(true);  // 256 colors suffice (the quantizer paints)
  expect(sextantOk({ TERM: "xterm-256color" }, tty(99, 44))).toBe(false);  // …but the 100×30 floor still holds
  expect(sextantOk({ TERM: "xterm" }, tty(160, 44))).toBe(false);
  expect(sextantOk(env, { isTTY: true })).toBe(false);            // unknown size
});

test("fitsFloor(): the 40×12 Screen floor, inclusive; an unknown size counts as ProcessIO's 80×24 fallback", () => {
  expect(fitsFloor(tty(40, 12))).toBe(true);
  expect(fitsFloor(tty(39, 12))).toBe(false);
  expect(fitsFloor(tty(40, 11))).toBe(false);
  expect(fitsFloor(tty(30, 10))).toBe(false);
  expect(fitsFloor({ isTTY: true })).toBe(true);
  expect(fitsFloor({ isTTY: true, columns: 200 })).toBe(true);
});

test("chooseSurface() matrix: heuristics by default (truecolor or 256); ROVECODE_TUI overrides both ways but a forced sextant still needs a TTY at or above 40×12; a non-TTY never gets sextant; --classic wins over everything", () => {
  const tc = { COLORTERM: "truecolor" };
  expect(chooseSurface({ classic: false }, tc, tty(160, 44))).toBe("sextant");
  expect(chooseSurface({ classic: false }, { TERM: "xterm-256color" }, tty(160, 44))).toBe("sextant");      // 256-color terminal
  expect(chooseSurface({ classic: false }, tc, tty(99, 44))).toBe("classic");
  expect(chooseSurface({ classic: false }, {}, tty(160, 44))).toBe("classic");
  expect(chooseSurface({ classic: false }, { TERM: "xterm" }, tty(160, 44))).toBe("classic");
  expect(chooseSurface({ classic: false }, tc, { isTTY: false, columns: 160, rows: 44 })).toBe("classic");
  expect(chooseSurface({ classic: false }, { ...tc, ROVECODE_TUI: "classic" }, tty(160, 44))).toBe("classic");   // forced classic on a capable TTY
  expect(chooseSurface({ classic: false }, { ROVECODE_TUI: "sextant" }, tty(99, 20))).toBe("sextant");           // forced sextant skips the 100×30 + color rules
  expect(chooseSurface({ classic: false }, { ROVECODE_TUI: " Sextant " }, tty(80, 24))).toBe("sextant");         // trimmed, case-insensitive
  expect(chooseSurface({ classic: false }, { ROVECODE_TUI: "sextant" }, tty(40, 12))).toBe("sextant");           // exactly the Screen floor
  expect(chooseSurface({ classic: false }, { ROVECODE_TUI: "sextant" }, tty(39, 12))).toBe("classic");           // under the floor the buffer would outgrow the terminal
  expect(chooseSurface({ classic: false }, { ROVECODE_TUI: "sextant" }, tty(40, 11))).toBe("classic");
  expect(chooseSurface({ classic: false }, { ROVECODE_TUI: "sextant" }, tty(30, 10))).toBe("classic");           // the critic's 30×10 case
  expect(chooseSurface({ classic: false }, { ROVECODE_TUI: "sextant" }, { isTTY: true })).toBe("sextant");       // unknown size = the 80×24 fallback
  expect(chooseSurface({ classic: false }, { ROVECODE_TUI: "sextant" }, { isTTY: false, columns: 160, rows: 44 })).toBe("classic"); // never on a pipe
  expect(chooseSurface({ classic: true }, { ...tc, ROVECODE_TUI: "sextant" }, tty(160, 44))).toBe("classic");   // --classic wins
  expect(chooseSurface({ classic: false }, { ...tc, ROVECODE_TUI: "bogus" }, tty(160, 44))).toBe("sextant");    // an unknown value = heuristics
});

test("pickRenderer(): undefined for classic (runTui builds the PiTuiRenderer) and for a forced sextant under the floor; a SextantRenderer when sextant is chosen, carrying ROVECODE_THEME and the SGR mode — truecolor on a truecolor terminal, the 256 quantizer on a 256-color one", () => {
  expect(pickRenderer({ classic: true }, { ROVECODE_TUI: "sextant" }, new FakeStdout())).toBeUndefined();
  expect(pickRenderer({ classic: false }, {}, new FakeStdout())).toBeUndefined();               // no color evidence → classic
  const tiny = new FakeStdout(); tiny.columns = 30; tiny.rows = 10;
  expect(pickRenderer({ classic: false }, { ROVECODE_TUI: "sextant" }, tiny)).toBeUndefined();     // (mutation: forced ignores the floor → a renderer)
  const r = pickRenderer({ classic: false, pet: "stormy" }, { ROVECODE_TUI: "sextant", ROVECODE_THEME: "ember" }, new FakeStdout());
  expect(r).toBeInstanceOf(SextantRenderer);
  const sx = r as SextantRenderer;
  expect(sx.themeName).toBe("ember");
  expect(sx.active).toBe(false);                                                              // constructed, not started: no interval, no writes
  expect(sx.truecolor).toBe(false);                                                           // forced with no color evidence: the quantizer
  const plain = pickRenderer({ classic: false }, { COLORTERM: "truecolor" }, new FakeStdout()) as SextantRenderer;
  expect(plain).toBeInstanceOf(SextantRenderer);
  expect(plain.themeName).toBe("night");
  expect(plain.truecolor).toBe(true);
  const x256 = pickRenderer({ classic: false }, { TERM: "xterm-256color" }, new FakeStdout()) as SextantRenderer;
  expect(x256).toBeInstanceOf(SextantRenderer);
  expect(x256.truecolor).toBe(false);
  // the SGR mode reaches the wire: a 256-color renderer emits 38;5;N and never a 38;2;r;g;b triple
  const io = new MemoryIO(100, 30, {});
  const q = new SextantRenderer({ io, truecolor: false, scan: false, cwd: "C:/repo" });
  q.start(NOOP_HOOKS); q.stop();
  expect(io.output()).toMatch(/\x1b\[[0-9;]*38;5;\d+/);
  expect(io.output()).not.toContain("38;2;");
  const io2 = new MemoryIO(100, 30, {});
  const t = new SextantRenderer({ io: io2, truecolor: true, scan: false, cwd: "C:/repo" });
  t.start(NOOP_HOOKS); t.stop();
  expect(io2.output()).toContain("38;2;");
});

test("ProcessIO.enterRaw: setRawMode(true) → utf8 → resume → the Windows VT-input helper (win32 only, AFTER raw mode); leaveRaw restores the previous raw state and pauses stdin", () => {
  const stdin = new FakeStdin(), stdout = new FakeStdout();
  let vt = 0;
  const win = new ProcessIO(stdin, stdout, {}, { platform: "win32", vtInput: () => { stdin.log.push("vt"); vt++; return true; } });
  win.enterRaw();
  expect(stdin.log).toEqual(["raw:true", "enc:utf8", "resume", "vt"]); // order pinned: the helper must follow setRawMode (it resets the console flags)
  expect(vt).toBe(1);
  win.leaveRaw();
  expect(stdin.log.slice(4)).toEqual(["raw:false", "pause"]);          // wasRaw = false restored, stdin paused
  const posix = new ProcessIO(new FakeStdin(), stdout, {}, { platform: "linux", vtInput: () => { throw new Error("must not run off win32"); } });
  expect(() => posix.enterRaw()).not.toThrow();
  const already = new FakeStdin(); already.isRaw = true;
  const p2 = new ProcessIO(already, stdout, {}, { platform: "linux" });
  p2.enterRaw(); p2.leaveRaw();
  expect(already.log).toEqual(["raw:true", "enc:utf8", "resume", "raw:true", "pause"]); // a stdin that was raw before stays raw after
});

test("ProcessIO: input chunks arrive as utf8 strings (Buffers decoded), resize reports the stream size, size() falls back to 80×24, unsubscribes work, env is the injected map", () => {
  const stdin = new FakeStdin(), stdout = new FakeStdout();
  const io = new ProcessIO(stdin, stdout, { X: "1" }, { platform: "linux" });
  const chunks: string[] = [];
  const off = io.onInput((c) => chunks.push(c));
  stdin.emit("abc"); stdin.emit(Buffer.from("é✓", "utf8"));
  expect(chunks).toEqual(["abc", "é✓"]);
  off(); stdin.emit("zzz");
  expect(chunks).toEqual(["abc", "é✓"]);
  const sizes: [number, number][] = [];
  const offR = io.onResize((c, r) => sizes.push([c, r]));
  stdout.columns = 90; stdout.rows = 31; stdout.emitResize();
  expect(sizes).toEqual([[90, 31]]);
  offR(); stdout.emitResize();
  expect(sizes).toHaveLength(1);
  io.write("hi");
  expect(stdout.out).toBe("hi");
  expect(io.env).toEqual({ X: "1" });
  const bare = new FakeStdout(); bare.columns = undefined; bare.rows = undefined;
  expect(new ProcessIO(stdin, bare, {}, { platform: "linux" }).size()).toEqual({ cols: 80, rows: 24 });
});

test("vtInputCandidates(): pi-tui's prebuilt console-mode helper resolves from src/tui — the win32-x64 build ships in the vendor tree", () => {
  const c = vtInputCandidates("x64");
  expect(c.some((p) => /vendor[\\/]pi-tui[\\/]native[\\/]win32[\\/]prebuilds[\\/]win32-x64[\\/]win32-console-mode\.node$/.test(p))).toBe(true);
  expect(c.some((p) => existsSync(p))).toBe(true);
  expect(vtInputCandidates("arm64").some((p) => p.includes("win32-arm64"))).toBe(true);
  expect(vtInputCandidates("x64", "C:/bin/rovecode.exe").some((p) => p.replace(/\\/g, "/").startsWith("C:/bin/native/"))).toBe(true); // beside a compiled binary
});

test("MemoryIO: records writes, replays fed input to subscribers, emulates resizes, tracks raw + listeners", () => {
  const io = new MemoryIO(100, 30, { ROVECODE_PET: "0" });
  const got: string[] = [];
  const sizes: [number, number][] = [];
  const off = io.onInput((c) => got.push(c));
  const offR = io.onResize((c, r) => sizes.push([c, r]));
  expect(io.listeners).toBe(2);
  io.feed("x"); io.resize(120, 40);
  expect(got).toEqual(["x"]);
  expect(sizes).toEqual([[120, 40]]);
  expect(io.size()).toEqual({ cols: 120, rows: 40 });
  io.enterRaw(); expect(io.raw).toBe(true);
  io.leaveRaw(); expect(io.raw).toBe(false);
  io.write("a"); io.write("b");
  expect(io.output()).toBe("ab");
  expect(io.writes).toEqual(["a", "b"]);
  off(); offR();
  expect(io.listeners).toBe(0);
  expect(io.env.ROVECODE_PET).toBe("0");
});

// ---------- EOF: stdin ending must not hang the surface ----------

test("ProcessIO: stdin END is delivered to the input subscriber as ETX — a piped launch that loses its writer exits instead of hanging", () => {
  const stdin = new FakeStdin();
  const out = new FakeStdout();
  const io = new ProcessIO(stdin, out, {});
  const got: string[] = [];
  io.onInput((c) => got.push(c));
  io.enterRaw();
  stdin.emit("typed");
  stdin.end();               // the pipe on the other end closed
  // ETX is what a real Ctrl+C delivers: the input layer treats EOF exactly as an interrupt, so a
  // running turn aborts and an idle surface quits through its normal close path.
  expect(got).toEqual(["typed", "\x03"]);
});

test("ProcessIO: unsubscribing removes the END listener too — no leak after a stop()", () => {
  const stdin = new FakeStdin();
  const io = new ProcessIO(stdin, new FakeStdout(), {});
  const off = io.onInput(() => {});
  off();
  expect(stdin.handlers.size).toBe(0);
  expect(stdin.enders.size).toBe(0);   // both listeners gone, not just the data one
});
