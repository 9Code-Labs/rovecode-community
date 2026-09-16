/** tui/focus-terminal.ts on the classic surface: a PiTuiRenderer over FocusTerminal(RecordingTerminal(VirtualTerminal)).
 *  CSI O / CSI I sent to the terminal flip the tracker and never reach the editor (the view never shows `[O`); the
 *  decorator alone adds no bytes (the writes equal a plain RecordingTerminal boot); wrapped in withNotifications with a
 *  live config, `?1004h` is the last write of start() and `?1004l` the first write of stop(); with notifications off the
 *  byte stream is the control run's; the forwarded members reach the inner. */

import { afterEach, describe, expect, it } from "bun:test";
import { FocusTerminal } from "../../src/tui/focus-terminal.ts";
import { Notifier, withNotifications, type NotifyConfig } from "../../src/tui/notify.ts";
import { FocusTracker } from "../../src/tui/notify-seq.ts";
import { PiTuiRenderer } from "../../src/tui/pi-renderer.ts";
import type { RendererHooks } from "../../src/tui/renderer.ts";
import type { Terminal } from "../../vendor/pi-tui/src/index.ts";
import { VirtualTerminal } from "../../vendor/pi-tui/test/virtual-terminal.ts";

/** a Terminal that records every write and forwards to the VirtualTerminal */
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

const HOOKS: RendererHooks = { onSubmit() {}, onInterrupt() {}, onExit() {} };
const ON: NotifyConfig = { method: "bell", when: "unfocused", tmux: false, notes: [] };
const OFF: NotifyConfig = { when: "unfocused", tmux: false, notes: [] };

let active: PiTuiRenderer[] = [];
afterEach(() => { for (const r of active) r.stop(); active = []; });

function boot(o: { focus?: FocusTracker; config?: NotifyConfig } = {}) {
  const term = new VirtualTerminal(80, 24);
  const rec = new RecordingTerminal(term);
  const tracker = o.focus ?? new FocusTracker();
  const inner = new PiTuiRenderer({ terminal: o.focus ? new FocusTerminal(rec, tracker) : rec, cwd: process.cwd() });
  active.push(inner);
  const renderer = o.config ? withNotifications(inner, new Notifier({ config: o.config, write: (s) => rec.write(s), focused: () => tracker.focused })) : inner;
  renderer.start(HOOKS);
  return { term, rec, tracker, renderer };
}
async function screen(term: VirtualTerminal): Promise<string> { await term.waitForRender(); return (await term.flushAndGetViewport()).join("\n"); }

describe("FocusTerminal", () => {
  it("CSI O / CSI I flip the tracker and never reach the editor; typed text still does", async () => {
    const tracker = new FocusTracker();
    const t = boot({ focus: tracker });
    await screen(t.term);
    expect(tracker.focused).toBe(true);
    t.term.sendInput("\x1b[O");
    expect(tracker.focused).toBe(false);
    t.term.sendInput("hello");
    t.term.sendInput("\x1b[I");
    expect(tracker.focused).toBe(true);
    const view = await screen(t.term);
    expect(view).toContain("hello");
    expect(view).not.toContain("[O");   // MUTATION: CSI O forwarded → typed into the editor
    expect(view).not.toContain("[I");
  });

  it("the decorator alone adds no bytes: a boot through FocusTerminal writes exactly what a plain terminal boot writes", async () => {
    const plain = boot();
    const wrapped = boot({ focus: new FocusTracker() });
    await screen(plain.term); await screen(wrapped.term);
    expect(wrapped.rec.writes.join("")).toBe(plain.rec.writes.join(""));
    expect(wrapped.rec.writes.join("")).not.toContain("?1004"); // DECSET is the notifier's, not this decorator's
  });

  it("withNotifications: `?1004h` is the last write of start() and `?1004l` the first write of stop() when something can fire; off → the control's bytes", async () => {
    const on = boot({ focus: new FocusTracker(), config: ON });
    expect(on.rec.writes.at(-1)).toBe("\x1b[?1004h"); // right after the surface's own start writes
    await screen(on.term);
    const before = on.rec.writes.length;
    on.renderer.stop();
    expect(on.rec.writes[before]).toBe("\x1b[?1004l");   // before the surface's stop writes
    expect(on.rec.writes.filter((w) => w === "\x1b[?1004h").length).toBe(1);
    expect(on.rec.writes.filter((w) => w === "\x1b[?1004l").length).toBe(1);
    on.renderer.stop(); // a second stop writes nothing new
    expect(on.rec.writes.filter((w) => w === "\x1b[?1004l").length).toBe(1);
    const control = boot({ focus: new FocusTracker() });
    const off = boot({ focus: new FocusTracker(), config: OFF });
    await screen(control.term); await screen(off.term);
    control.renderer.stop(); off.renderer.stop();
    expect(off.rec.writes.join("")).toBe(control.rec.writes.join("")); // MUTATION: DECSET written with notifications off
  });

  it("the forwarded members reach the inner terminal", () => {
    const calls: string[] = [];
    const fake: Terminal = {
      start: () => { calls.push("start"); }, stop: () => { calls.push("stop"); }, drainInput: async () => { calls.push("drain"); },
      write: (d) => { calls.push(`write:${d}`); }, get columns() { return 120; }, get rows() { return 40; }, get kittyProtocolActive() { return true; },
      moveBy: (n) => { calls.push(`moveBy:${n}`); }, hideCursor: () => { calls.push("hide"); }, showCursor: () => { calls.push("show"); },
      clearLine: () => { calls.push("clearLine"); }, clearFromCursor: () => { calls.push("clearFrom"); }, clearScreen: () => { calls.push("clearScreen"); },
      setTitle: (t) => { calls.push(`title:${t}`); }, setProgress: (a) => { calls.push(`progress:${a}`); },
    };
    const ft = new FocusTerminal(fake, new FocusTracker());
    ft.write("x"); ft.moveBy(2); ft.hideCursor(); ft.showCursor(); ft.clearLine(); ft.clearFromCursor(); ft.clearScreen(); ft.setTitle("t"); ft.setProgress(true); void ft.drainInput(); ft.stop();
    expect(ft.columns).toBe(120); expect(ft.rows).toBe(40); expect(ft.kittyProtocolActive).toBe(true);
    expect(calls).toEqual(["write:x", "moveBy:2", "hide", "show", "clearLine", "clearFrom", "clearScreen", "title:t", "progress:true", "drain", "stop"]);
  });
});
