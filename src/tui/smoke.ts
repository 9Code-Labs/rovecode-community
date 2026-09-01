/** `aion smoke-tui`: end-to-end render check through the real pipeline —
 *  agentLoop → Renderer → pi-tui → ANSI → @xterm/headless terminal emulator.
 *  Prints the emulated 80x24 screen; exits 0 iff the scripted session rendered. */

import { VirtualTerminal } from "../../vendor/pi-tui/test/virtual-terminal.ts";
import { PiTuiRenderer } from "./pi-renderer.ts";
import { runTui } from "./app.ts";
import { mockStream, textTurn, toolTurn } from "../providers/stream.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function runTuiSmoke(): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), "aion-tui-smoke-"));
  const term = new VirtualTerminal(80, 24);
  const renderer = new PiTuiRenderer({ terminal: term, cwd });
  const probe = join(cwd, "smoke.txt");
  const stream = mockStream({
    turns: [
      toolTurn([{ id: "t1", tool: "write", args: { path: probe, content: "smoke-ok\n" } }]),
      textTurn("# Smoke OK\n\nrendered **markdown**, a tool card, and the status line."),
    ],
  });

  const app = runTui({ renderer, stream, cwd, yolo: true, exitOnClose: false, model: "scripted" });

  // type a prompt into the (focused) editor and submit
  term.sendInput("hello aion");
  term.sendInput("\r");

  const deadline = Date.now() + 10_000;
  let screen: string[] = [];
  let ok = false;
  while (Date.now() < deadline) {
    screen = await term.flushAndGetViewport();
    const text = screen.join("\n");
    if (text.includes("Smoke OK") && text.includes("write")) { ok = true; break; }
    await new Promise((r) => setTimeout(r, 50));
  }

  term.sendInput("\x03"); // Ctrl+C → clean exit path
  await app;
  rmSync(cwd, { recursive: true, force: true });

  console.log("── emulated 80x24 screen ──────────────────────────────────────────────");
  for (const line of screen) console.log(line.trimEnd());
  console.log("───────────────────────────────────────────────────────────────────────");
  console.log(ok ? "smoke-tui: PASS (markdown + tool card rendered through full pipeline)" : "smoke-tui: FAIL");
  process.exit(ok ? 0 : 1);
}
