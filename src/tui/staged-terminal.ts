/** Classic TUI's first frame is measured AND serialized offscreen. No raw mode, terminal writes or
 *  input subscription until reveal(). Re-preparing replaces the buffer (resize/status), never appends
 *  an obsolete screen. Imported only by the optional classic renderer. */
import type { Terminal } from "../../vendor/pi-tui/src/terminal.ts";

export class StagedTerminal implements Terminal {
  private pending: (() => void)[] = [];
  private visible = false;
  private discarded = false;
  constructor(private readonly inner: Terminal) {}
  get columns(): number { return this.inner.columns; }
  get rows(): number { return this.inner.rows; }
  get kittyProtocolActive(): boolean { return this.inner.kittyProtocolActive; }
  prepare(render: () => void): void { this.pending = []; render(); }
  reveal(start: () => void, handoff?: () => void): void {
    if (this.discarded || this.visible) return;
    const frame = this.pending; this.pending = [];
    const esc = String.fromCharCode(27);
    this.inner.write(`${esc}[?2026h`);
    try {
      handoff?.();
      this.visible = true;
      start(); // protocol setup/input first, followed immediately by the already-computed complete frame
      for (const write of frame) write();
    } finally { this.inner.write(`${esc}[?2026l`); }
  }
  private emit(write: () => void): void {
    if (this.discarded) return;
    if (this.visible) write(); else this.pending.push(write);
  }
  start(input: (data: string) => void, resize: () => void): void {
    if (this.visible) this.inner.start(input, resize);
  }
  stop(): void {
    this.discarded = true; this.pending = [];
    if (this.visible) this.inner.stop();
  }
  drainInput(maxMs?: number, idleMs?: number): Promise<void> {
    return this.visible ? this.inner.drainInput(maxMs, idleMs) : Promise.resolve();
  }
  write(data: string): void { this.emit(() => this.inner.write(data)); }
  moveBy(lines: number): void { this.emit(() => this.inner.moveBy(lines)); }
  hideCursor(): void { this.emit(() => this.inner.hideCursor()); }
  showCursor(): void { this.emit(() => this.inner.showCursor()); }
  clearLine(): void { this.emit(() => this.inner.clearLine()); }
  clearFromCursor(): void { this.emit(() => this.inner.clearFromCursor()); }
  clearScreen(): void { this.emit(() => this.inner.clearScreen()); }
  setTitle(title: string): void { this.emit(() => this.inner.setTitle(title)); }
  setProgress(active: boolean): void { this.emit(() => this.inner.setProgress(active)); }
}
