/** `rovecode smoke-tui`: end-to-end render check through the real pipeline —
 *  agentLoop → Renderer → pi-tui → ANSI → @xterm/headless terminal emulator.
 *  Gated session: a scripted write, then an anchored edit of that file, each raise the
 *  approval overlay with its diff card (port #24) and are approved once the card is on
 *  screen; a markdown turn closes the run. Prints the edit's diff-card screen and the
 *  final 80x24 screen; exits 0 iff every stage rendered. */

import { VirtualTerminal } from "../../vendor/pi-tui/test/virtual-terminal.ts";
import { PiTuiRenderer } from "./pi-renderer.ts";
import { runTui } from "./app.ts";
import { mockStream, textTurn, toolTurn } from "../providers/stream.ts";
import { fileTag, lineHash } from "../coding/hashline.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function runTuiSmoke(): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-tui-smoke-"));
  const term = new VirtualTerminal(80, 24);
  const renderer = new PiTuiRenderer({ terminal: term, cwd });
  const probe = join(cwd, "smoke.txt");
  const written = "smoke-ok\n";
  const stream = mockStream({
    turns: [
      toolTurn([{ id: "t1", tool: "write", args: { path: probe, content: written } }]),
      // port #24: anchored edit of the file just written → the approval card shows -old/+new
      toolTurn([{ id: "t2", tool: "edit", args: { path: probe, edits: [
        { tag: fileTag(written), anchorLine: 1, anchorHash: lineHash("smoke-ok"), newLines: ["smoke-edited"] },
      ] } }]),
      textTurn("# Smoke OK\n\nrendered **markdown**, a tool card, and the status line."),
    ],
  });

  // pinned, not inherited: this smoke asserts approval cards, and a ~/.rovecode/settings.json with
  // "permission":"auto" would allow everything silently (`yolo: false` is "no flag" to app.ts, not "ask")
  const app = runTui({ renderer, stream, cwd, permission: "ask", exitOnClose: false, model: "scripted" });

  // type a prompt into the (focused) editor and submit
  term.sendInput("hello rovecode");
  term.sendInput("\r");

  // each approval overlay must show its diff card before Enter (= allow once) approves it:
  // the write is an all-adds create diff, the edit a modify diff with the removed line
  const cards = ["+smoke-ok", "-smoke-ok"];
  const cardScreens: string[][] = [];
  const deadline = Date.now() + 10_000;
  let screen: string[] = [];
  let ok = false;
  while (Date.now() < deadline) {
    screen = await term.flushAndGetViewport();
    const text = screen.join("\n");
    if (text.includes("Smoke OK") && text.includes("write") && cardScreens.length === cards.length) { ok = true; break; }
    const want = cards[cardScreens.length];
    if (want !== undefined && text.includes("allow once") && text.includes(want)) {
      cardScreens.push(screen);
      term.sendInput("\r");
    }
    await new Promise((r) => setTimeout(r, 50));
  }

  term.sendInput("\x03"); // Ctrl+C → clean exit path
  await app;
  rmSync(cwd, { recursive: true, force: true });

  console.log("── approval overlay with diff card (edit) ──────────────────────────────");
  for (const line of cardScreens[1] ?? ["(diff card never rendered)"]) console.log(line.trimEnd());
  console.log("── emulated 80x24 screen ──────────────────────────────────────────────");
  for (const line of screen) console.log(line.trimEnd());
  console.log("───────────────────────────────────────────────────────────────────────");
  console.log(ok ? "smoke-tui: PASS (markdown + tool card + diff card rendered through full pipeline)" : `smoke-tui: FAIL (diff cards seen: ${cardScreens.length}/${cards.length})`);
  process.exit(ok ? 0 : 1);
}
