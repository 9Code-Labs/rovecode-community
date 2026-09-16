/** FocusTerminal: a pi-tui `Terminal` decorator for the classic surface. Every post-StdinBuffer input sequence goes through
 *  a FocusTracker BEFORE the TUI's input handlers — CSI I / CSI O flip the tracker and never reach the editor; a chunk
 *  emptied by the filter is not forwarded. Nothing else changes: the remaining members forward to the inner terminal
 *  (vendor/pi-tui/src/terminal.ts Terminal). The DECSET 1004 writes are NOT here: withNotifications (tui/notify.ts) writes
 *  them around the surface's own start / stop writes, on both surfaces, only when something can fire — so this decorator
 *  alone adds zero bytes to the stdout stream. Compose any further Terminal decorator OUTSIDE this one (it must stay
 *  innermost after ProcessTerminal to see complete sequences). */

import type { Terminal } from "../../vendor/pi-tui/src/index.ts";
import type { FocusTracker } from "./notify-seq.ts";

export class FocusTerminal implements Terminal {
  constructor(private readonly inner: Terminal, private readonly tracker: FocusTracker) {}
  start(onInput: (data: string) => void, onResize: () => void): void {
    this.inner.start((data) => {
      const rest = this.tracker.feed(data); // CSI I / CSI O consumed here; the editor never sees them
      if (rest.length > 0) onInput(rest);
    }, onResize);
  }
  stop(): void { this.inner.stop(); }
  drainInput(maxMs?: number, idleMs?: number): Promise<void> { return this.inner.drainInput(maxMs, idleMs); }
  write(data: string): void { this.inner.write(data); }
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
