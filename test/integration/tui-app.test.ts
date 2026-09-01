/** Port #1 integration: full app loop (agentLoop → Renderer → pi-tui → xterm emulator).
 *  Covers: streaming render, tool cards, gated approval via overlay, steering note, exit. */

import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VirtualTerminal } from "../../vendor/pi-tui/test/virtual-terminal.ts";
import { PiTuiRenderer } from "../../src/tui/pi-renderer.ts";
import { runTui } from "../../src/tui/app.ts";
import { mockStream, textTurn, toolTurn } from "../../src/providers/stream.ts";

async function until(term: VirtualTerminal, pred: (screen: string) => boolean, ms = 8000): Promise<string> {
  const deadline = Date.now() + ms;
  let text = "";
  while (Date.now() < deadline) {
    text = (await term.flushAndGetViewport()).join("\n");
    if (pred(text)) return text;
    await new Promise((r) => setTimeout(r, 25));
  }
  return text;
}

test("yolo run renders markdown + tool card end-to-end", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "aion-tuiapp-"));
  const term = new VirtualTerminal(80, 24);
  const renderer = new PiTuiRenderer({ terminal: term, cwd });
  const probe = join(cwd, "e2e.txt");
  const stream = mockStream({
    turns: [
      toolTurn([{ id: "t1", tool: "write", args: { path: probe, content: "e2e\n" } }]),
      textTurn("# Done\n\nwrote the file."),
    ],
  });
  const app = runTui({ renderer, stream, cwd, yolo: true, exitOnClose: false, model: "scripted" });
  term.sendInput("do the thing");
  term.sendInput("\r");

  const screen = await until(term, (s) => s.includes("Done") && s.includes("write"));
  expect(screen).toContain("Done");
  expect(screen).toContain("write");          // tool card
  expect(screen).toContain("do the thing");   // user echo
  expect(existsSync(probe)).toBe(true);
  expect(readFileSync(probe, "utf8")).toBe("e2e\n");

  term.sendInput("\x03");
  await app;
  rmSync(cwd, { recursive: true, force: true });
}, 20_000);

test("gated run: write tool requires approval; Enter approves once and the write lands", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "aion-tuiapp-"));
  const term = new VirtualTerminal(80, 24);
  const renderer = new PiTuiRenderer({ terminal: term, cwd });
  const probe = join(cwd, "gated.txt");
  const stream = mockStream({
    turns: [
      toolTurn([{ id: "t1", tool: "write", args: { path: probe, content: "approved\n" } }]),
      textTurn("finished."),
    ],
  });
  const app = runTui({ renderer, stream, cwd, yolo: false, exitOnClose: false, model: "scripted" });
  term.sendInput("write it");
  term.sendInput("\r");

  const asked = await until(term, (s) => s.toLowerCase().includes("approval"));
  expect(asked.toLowerCase()).toContain("approval");
  expect(existsSync(probe)).toBe(false);       // nothing written before consent

  term.sendInput("\r");                        // select first option: allow once
  const done = await until(term, (s) => s.includes("finished"));
  expect(done).toContain("finished");
  expect(existsSync(probe)).toBe(true);
  expect(readFileSync(probe, "utf8")).toBe("approved\n");

  term.sendInput("\x03");
  await app;
  rmSync(cwd, { recursive: true, force: true });
}, 20_000);

test("closing mid-run is clean: the run's finally after renderer.stop() must not reject", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "aion-tuiapp-"));
  const term = new VirtualTerminal(80, 24);
  const renderer = new PiTuiRenderer({ terminal: term, cwd });
  const rejections: unknown[] = [];
  const collect = (e: unknown) => rejections.push(e);
  process.on("unhandledRejection", collect);
  try {
    // busy long enough for Ctrl+C to land mid-run, but SHORT enough that the run's
    // finally executes inside this test — that finally is the crash under test
    const slow = async function* () {
      await new Promise((r) => setTimeout(r, 400));
      yield { type: "turn" as const, turn: textTurn("late") };
    };
    const app = runTui({ renderer, stream: slow, cwd, yolo: true, exitOnClose: false, model: "scripted" });
    term.sendInput("go");
    term.sendInput("\r");
    await until(term, (s) => s.includes("> go"));
    term.sendInput("\x03"); // exit while the run is in flight
    await app;              // must resolve
    await new Promise((r) => setTimeout(r, 700)); // let the run's finally fire post-stop
    expect(rejections).toEqual([]);
  } finally {
    process.off("unhandledRejection", collect);
    rmSync(cwd, { recursive: true, force: true });
  }
}, 20_000);

test("slash command /status renders without starting a run", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "aion-tuiapp-"));
  const term = new VirtualTerminal(80, 24);
  const renderer = new PiTuiRenderer({ terminal: term, cwd });
  const app = runTui({ renderer, stream: mockStream({ turns: [textTurn("x")] }), cwd, yolo: true, exitOnClose: false, model: "m1" });
  term.sendInput("/status");
  term.sendInput("\r");
  const screen = await until(term, (s) => s.includes("provider="));
  expect(screen).toContain("model=m1");
  term.sendInput("\x03");
  await app;
  rmSync(cwd, { recursive: true, force: true });
}, 20_000);
