import { expect, test } from "bun:test";
import { VirtualTerminal } from "../../vendor/pi-tui/test/virtual-terminal.ts";
import { PiTuiRenderer } from "../../src/tui/pi-renderer.ts";
import type { RendererHooks } from "../../src/tui/renderer.ts";

class TerminalProbe extends VirtualTerminal {
  writes: string[] = [];
  starts = 0;
  override write(data: string): void { this.writes.push(data); super.write(data); }
  override start(input: (data: string) => void, resize: () => void): void { this.starts++; super.start(input, resize); }
}
const hooks: RendererHooks = { onSubmit() {}, onInterrupt() {}, onExit() {} };

test("classic prepares the real editor/layout/output behind the intro; no delayed first paint or lost textbox at reveal", async () => {
  const terminal = new TerminalProbe(100, 30);
  const renderer = new PiTuiRenderer({ terminal });
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const submitted: string[] = [], events: string[] = [];
  const starting = renderer.start({ ...hooks, onSubmit: (s) => { submitted.push(s); } }, {
    beforeFirstRender: () => { renderer.addSystemNote("PREPARED-TRANSCRIPT"); renderer.prefillEditor("READY-TEXTBOX"); },
    beforeReveal: () => { events.push("prepared"); return gate; },
    onReveal: () => { expect(terminal.starts).toBe(0); expect(terminal.writes.join("")).toBe(String.fromCharCode(27) + "[?2026h"); events.push("reveal"); },
  });
  try {
    await Bun.sleep(30);
    expect(events).toEqual(["prepared"]); expect(terminal.starts).toBe(0);
    expect(terminal.writes).toHaveLength(0);
    expect((await terminal.flushAndGetViewport()).join("").trim()).toBe("");
    terminal.resize(70, 24);
    renderer.addSystemNote("LATEST-STATE");
    release(); await starting;
    // No sleep/timer to wait for the textbox. Its serialized first frame is already written.
    const visible = (await terminal.flushAndGetViewport()).join("\n");
    expect(events).toEqual(["prepared", "reveal"]); expect(terminal.starts).toBe(1);
    expect(visible).toContain("PREPARED-TRANSCRIPT"); expect(visible).toContain("LATEST-STATE");
    expect(visible).toContain("READY-TEXTBOX");
    terminal.sendInput("\r"); expect(submitted).toEqual(["READY-TEXTBOX"]);
  } finally { renderer.stop(); release(); await starting; }
});

test("stopping a prepared classic screen discards output and late readiness never opens raw input", async () => {
  const terminal = new TerminalProbe(80, 24);
  const renderer = new PiTuiRenderer({ terminal });
  let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
  const starting = renderer.start(hooks, { beforeFirstRender: () => renderer.prefillEditor("do not show"), beforeReveal: () => gate });
  renderer.stop(); release(); await starting; await Bun.sleep(25);
  expect(terminal.starts).toBe(0); expect(terminal.writes).toHaveLength(0);
  expect((await terminal.flushAndGetViewport()).join("").trim()).toBe("");
});
