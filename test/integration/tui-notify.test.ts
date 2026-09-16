/** Notifications through the REAL app loop on both surfaces (runTui → agentLoop → the wrapped Renderer), the way
 *  tui-sextant.test.ts and tui-app.test.ts drive them: the sextant over a MemoryIO, the classic PiTuiRenderer over
 *  FocusTerminal(RecordingTerminal(VirtualTerminal)). With the terminal reported unfocused: exactly ONE sequence when the
 *  approval card opens and ONE at run end, DECSET 1004 around the surface's start / stop writes, quit hygiene unchanged;
 *  focused (the default a terminal that never reports focus also reads as): zero sequences and zero spawns across boot /
 *  approval / run end / quit. */

import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileTag, lineHash } from "../../src/coding/hashline.ts";
import { resetExecutor } from "../../src/core/executor.ts";
import { mockStream, textTurn, toolTurn } from "../../src/providers/stream.ts";
import { enterSequence, leaveSequence } from "../../src/sextant/input.ts";
import { SextantRenderer } from "../../src/sextant/sextant-renderer.ts";
import { runTui } from "../../src/tui/app.ts";
import { FocusTerminal } from "../../src/tui/focus-terminal.ts";
import { Notifier, withNotifications, type NotifyConfig } from "../../src/tui/notify.ts";
import { FocusTracker } from "../../src/tui/notify-seq.ts";
import { PiTuiRenderer } from "../../src/tui/pi-renderer.ts";
import { MemoryIO } from "../../src/tui/sextant-io.ts";
import type { Terminal } from "../../vendor/pi-tui/src/index.ts";
import { VirtualTerminal } from "../../vendor/pi-tui/test/virtual-terminal.ts";

afterEach(() => resetExecutor());

const BELL: NotifyConfig = { method: "bell", when: "unfocused", tmux: false, notes: [] };
const OSC9: NotifyConfig = { method: "osc9", when: "unfocused", tmux: false, notes: [] };
const count = (s: string, needle: string): number => s.split(needle).length - 1;
const noSpawn = (): never => { throw new Error("notify_command must not be spawned"); };

// ---------- helpers (tui-sextant.test.ts) ----------

async function until(r: SextantRenderer, pred: (frame: string) => boolean, ms = 8000): Promise<string> {
  const deadline = Date.now() + ms;
  let text = "";
  while (Date.now() < deadline) {
    r.tick();
    text = r.frameText();
    if (pred(text)) return text;
    await new Promise((res) => setTimeout(res, 20));
  }
  return text;
}
async function waitFor(cond: () => boolean, ms = 8000, what = "condition"): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`${what}: not true within ${ms}ms`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
function deadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const bomb = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error(`${what}: not settled within ${ms}ms`)), ms); });
  return Promise.race([p, bomb]).finally(() => clearTimeout(t));
}
async function rmTemp(cwd: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { rmSync(cwd, { recursive: true, force: true }); return; }
    catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if ((code !== "EBUSY" && code !== "EPERM" && code !== "ENOTEMPTY") || attempt >= 20) throw e;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}
function surface() {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-notify-sx-"));
  const io = new MemoryIO(160, 44, { COLORTERM: "truecolor" });
  const renderer = new SextantRenderer({ io, cwd, pet: "rovecode" });
  return { cwd, io, renderer };
}
/** gated TUI whose first scripted turn is an anchored edit of notes.txt (old-line → new-line) */
function gatedEditApp(cwd: string, io: MemoryIO, renderer: SextantRenderer, wrapped: SextantRenderer, finalText: string) {
  const target = join(cwd, "notes.txt");
  const content = "keep-1\nold-line\nkeep-2\n";
  writeFileSync(target, content);
  const edit = { path: target, edits: [{ tag: fileTag(content), anchorLine: 2, anchorHash: lineHash("old-line"), newLines: ["new-line"] }] };
  const stream = mockStream({ turns: [toolTurn([{ id: "t1", tool: "edit", args: edit }]), textTurn(finalText)] });
  const app = runTui({ renderer: wrapped, stream, cwd, yolo: false, exitOnClose: false, model: "scripted" });
  void renderer;
  io.feed("edit it\r");
  return { app, target };
}
async function quit(io: MemoryIO, renderer: SextantRenderer, app: Promise<void>, cwd: string): Promise<string> {
  io.feed("\x03");
  await deadline(app, 8000, "runTui after ⌃c");
  const tail = io.output().slice(-400);
  expect(renderer.active).toBe(false);
  expect(io.listeners).toBe(0);
  expect(io.raw).toBe(false);
  await renderer.drain();
  await rmTemp(cwd);
  return tail;
}

// ---------- sextant ----------

test("sextant, unfocused + bell: exactly one BEL when the approval card opens and one at run end; ?1004h after the start writes, ?1004l before the leave sequence; quit rings nothing", async () => {
  const { cwd, io, renderer } = surface();
  const tracker = new FocusTracker();
  const spawns: string[][] = [];
  const wrapped = withNotifications(renderer, new Notifier({ config: BELL, cwd, write: (s) => io.write(s), focused: () => tracker.focused, spawn: (a) => { spawns.push(a); } }));
  tracker.focused = false;
  const { app, target } = gatedEditApp(cwd, io, renderer, wrapped, "applied.");
  const bells = (): number => count(io.output(), "\x07");
  const card = await until(renderer, (f) => f.includes("needs your permission"));
  expect(card).toMatch(/allow\s+always\s+all edits\s+deny/);
  expect(bells()).toBe(1);                                          // the approval trigger
  expect(count(io.output(), "\x1b[?1004h")).toBe(1);
  expect(io.output().indexOf("\x1b[?1004h")).toBeGreaterThan(io.output().indexOf(enterSequence(true)));
  io.feed("\r");                                                    // allow once
  await until(renderer, (f) => f.includes("applied."));
  await waitFor(() => bells() === 2, 8000, "the run-end bell");     // the label-less setBusy(false) of the run's finally
  expect(readFileSync(target, "utf8")).toBe("keep-1\nnew-line\nkeep-2\n");
  await new Promise((r) => setTimeout(r, 150));
  expect(bells()).toBe(2);                                          // MUTATION: a second false / the status refresh would ring again
  expect(spawns).toEqual([]);
  const tail = await quit(io, renderer, app, cwd);
  expect(tail).toContain("\x1b[?1004l");
  expect(tail.indexOf("\x1b[?1004l")).toBeLessThan(tail.lastIndexOf(leaveSequence()));
  expect(count(io.output(), "\x1b[?1004l")).toBe(1);
  expect(bells()).toBe(2);                                          // quit never rings
}, 20_000);

test("sextant, bell while FOCUSED (the default gate) and off while unfocused: zero BEL, zero spawns across boot / approval / run end / quit; DECSET follows what can fire, never the focus", async () => {
  for (const [config, focused] of [[BELL, true], [{ when: "unfocused", tmux: false, notes: [] } as NotifyConfig, false]] as const) {
    const { cwd, io, renderer } = surface();
    const tracker = new FocusTracker();
    tracker.focused = focused;
    const wrapped = withNotifications(renderer, new Notifier({ config, cwd, write: (s) => io.write(s), focused: () => tracker.focused, spawn: noSpawn }));
    const { app, target } = gatedEditApp(cwd, io, renderer, wrapped, "applied.");
    await until(renderer, (f) => f.includes("needs your permission"));
    io.feed("\r");
    await until(renderer, (f) => f.includes("applied.") && !renderer.state.running);
    expect(readFileSync(target, "utf8")).toBe("keep-1\nnew-line\nkeep-2\n");
    await quit(io, renderer, app, cwd);
    const out = io.output();
    expect([focused, count(out, "\x07"), count(out, "\x1b]9;"), count(out, "\x1b]777;")]).toEqual([focused, 0, 0, 0]); // MUTATION: the bell nobody hears
    expect(count(out, "\x1b[?1004h")).toBe(config.method ? 1 : 0);
    expect(count(out, "\x1b[?1004l")).toBe(config.method ? 1 : 0);
  }
}, 30_000);

// ---------- classic ----------

class RecordingTerminal implements Terminal {
  writes: string[] = [];
  constructor(private readonly inner: VirtualTerminal) {}
  start(onInput: (data: string) => void, onResize: () => void): void { this.inner.start(onInput, onResize); }
  stop(): void { this.inner.stop(); }
  drainInput(maxMs?: number, idleMs?: number): Promise<void> { return this.inner.drainInput(maxMs, idleMs); }
  write(data: string): void { this.writes.push(data); this.inner.write(data); }
  get columns(): number { return this.inner.columns; }
  get rows(): number { return this.inner.rows; }
  get kittyProtocolActive(): boolean { return this.inner.kittyProtocolActive; }
  moveBy(lines: number): void { this.inner.moveBy(lines); }
  hideCursor(): void { this.inner.hideCursor(); }
  showCursor(): void { this.inner.showCursor(); }
  clearLine(): void { this.inner.clearLine(); }
  clearFromCursor(): void { this.inner.clearFromCursor(); }
  clearScreen(): void { this.inner.clearScreen(); }
  setTitle(title: string): void { this.inner.setTitle(title); }
  setProgress(active: boolean): void { this.inner.setProgress(active); }
}
async function screenUntil(term: VirtualTerminal, pred: (screen: string) => boolean, ms = 8000): Promise<string> {
  const stop = Date.now() + ms;
  let text = "";
  while (Date.now() < stop) {
    text = (await term.flushAndGetViewport()).join("\n");
    if (pred(text)) return text;
    await new Promise((r) => setTimeout(r, 25));
  }
  return text;
}
/** ours, not pi-tui's OSC 9;4 progress */
const toastsOf = (rec: RecordingTerminal): string[] => rec.writes.filter((w) => w.startsWith("\x1b]9;") && !w.startsWith("\x1b]9;4;"));

test("classic, unfocused (CSI O typed into the terminal) + osc9: one toast at the approval card, one at run end carrying the answer; the editor never sees `[O`; ?1004h at start, ?1004l at stop", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-notify-cl-"));
  try {
    const term = new VirtualTerminal(80, 24);
    const rec = new RecordingTerminal(term);
    const tracker = new FocusTracker();
    const renderer = new PiTuiRenderer({ terminal: new FocusTerminal(rec, tracker), cwd });
    const spawns: string[][] = [];
    const wrapped = withNotifications(renderer, new Notifier({ config: OSC9, cwd, write: (s) => rec.write(s), focused: () => tracker.focused, spawn: (a) => { spawns.push(a); } }));
    const probe = join(cwd, "gated.txt");
    const stream = mockStream({ turns: [toolTurn([{ id: "t1", tool: "write", args: { path: probe, content: "approved\n" } }]), textTurn("finished.")] });
    const app = runTui({ renderer: wrapped, stream, cwd, yolo: false, exitOnClose: false, model: "scripted" });
    expect(rec.writes).toContain("\x1b[?1004h");
    term.sendInput("\x1b[O");                                         // the terminal reports focus out
    expect(tracker.focused).toBe(false);
    term.sendInput("write it");
    term.sendInput("\r");
    const asked = await screenUntil(term, (s) => s.toLowerCase().includes("approval"));
    expect(asked).not.toContain("[O");                                // MUTATION: CSI O forwarded → typed into the editor
    expect(existsSync(probe)).toBe(false);
    expect(toastsOf(rec).length).toBe(1);
    expect(toastsOf(rec)[0]!.startsWith("\x1b]9;approval needed: write ")).toBe(true);
    expect(toastsOf(rec)[0]!.endsWith("\x07")).toBe(true);
    term.sendInput("\r");                                             // allow once
    await screenUntil(term, (s) => s.includes("finished."));
    await waitFor(() => toastsOf(rec).length === 2, 8000, "the run-end toast");
    expect(toastsOf(rec)[1]).toBe("\x1b]9;run finished: finished.\x07");
    expect(readFileSync(probe, "utf8")).toBe("approved\n");
    await new Promise((r) => setTimeout(r, 150));
    expect(toastsOf(rec).length).toBe(2);
    expect(rec.writes.filter((w) => w === "\x07").length).toBe(0);    // no stray bell write (pi-tui's own OSC sequences end in BEL — those are not ours)
    const before = rec.writes.length;
    term.sendInput("\x03");
    await deadline(app, 8000, "runTui after ⌃c");
    expect(rec.writes.slice(before)).toContain("\x1b[?1004l");
    expect(toastsOf(rec).length).toBe(2);
    expect(spawns).toEqual([]);
  } finally { await rmTemp(cwd); }
}, 20_000);

test("classic, focused with the default config: the wrapped run's bytes hold zero BEL / OSC toast and the hook is never spawned — even though the terminal was asked to report focus", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-notify-cl-"));
  try {
    const term = new VirtualTerminal(80, 24);
    const rec = new RecordingTerminal(term);
    const tracker = new FocusTracker();
    const renderer = new PiTuiRenderer({ terminal: new FocusTerminal(rec, tracker), cwd });
    const wrapped = withNotifications(renderer, new Notifier({ config: { ...BELL, hook: ["hook"], hookSource: "test" }, cwd, write: (s) => rec.write(s), focused: () => tracker.focused, spawn: noSpawn }));
    const probe = join(cwd, "gated.txt");
    const stream = mockStream({ turns: [toolTurn([{ id: "t1", tool: "write", args: { path: probe, content: "approved\n" } }]), textTurn("finished.")] });
    const app = runTui({ renderer: wrapped, stream, cwd, yolo: false, exitOnClose: false, model: "scripted" });
    term.sendInput("write it");
    term.sendInput("\r");
    await screenUntil(term, (s) => s.toLowerCase().includes("approval"));
    term.sendInput("\r");
    await screenUntil(term, (s) => s.includes("finished."));
    term.sendInput("\x03");
    await deadline(app, 8000, "runTui after ⌃c");
    const out = rec.writes.join("");
    expect([rec.writes.filter((w) => w === "\x07").length, toastsOf(rec).length, count(out, "\x1b]777;")]).toEqual([0, 0, 0]);
    expect(count(out, "\x1b[?1004h")).toBe(1);
    expect(readFileSync(probe, "utf8")).toBe("approved\n");
  } finally { await rmTemp(cwd); }
}, 20_000);
