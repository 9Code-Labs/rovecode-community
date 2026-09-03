/** `rovecode smoke-tui --sextant` (port #44): the sextant surface end-to-end through the real pipeline —
 *  agentLoop → SextantRenderer → Screen → an in-memory TerminalIO at 160×44 (no @xterm/headless, so it
 *  also runs from an installed tree or the compiled binary). Gated session: a scripted write, then an
 *  anchored edit of that file, each raise the approval card and are allowed once the card is on
 *  screen; a text turn closes the run; ⌃c quits and the terminal must be restored (leave sequence in
 *  the output tail, frame interval cleared). Prints the edit's card frame and the final frame; the CLI
 *  wrapper exits 0 iff every stage rendered. */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileTag, lineHash } from "../coding/hashline.ts";
import { mockStream, textTurn, toolTurn } from "../providers/stream.ts";
import { SextantRenderer } from "../sextant/sextant-renderer.ts";
import { runTui } from "./app.ts";
import { MemoryIO } from "./sextant-io.ts";

export interface SextantSmokeResult {
  ok: boolean;
  reasons: string[];
  /** the frame with the edit's approval card on screen */
  cardFrame: string;
  /** the final frame */
  frame: string;
  /** the last 400 bytes written to the terminal (the leave sequence lives here) */
  tail: string;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** the two approval cards, in order: the write's, then the edit's */
const CARDS: readonly RegExp[] = [/needs your permission\s+write\b/, /needs your permission\s+edit\b/];
/** what quitting must leave in the output: main screen, cursor shown, SGR mouse off, bracketed paste off */
const LEAVE: readonly string[] = ["\x1b[?1049l", "\x1b[?25h", "\x1b[?1006l", "\x1b[?2004l"];

/** drive the surface headlessly and report; never exits the process (runSextantSmoke does) */
export async function sextantSmoke(opts: { cols?: number; rows?: number; deadlineMs?: number } = {}): Promise<SextantSmokeResult> {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-sextant-smoke-"));
  const io = new MemoryIO(opts.cols ?? 160, opts.rows ?? 44, { COLORTERM: "truecolor" });
  const renderer = new SextantRenderer({ io, cwd, pet: "rovecode" });
  const probe = join(cwd, "smoke.txt");
  const written = "smoke-ok\n";
  const stream = mockStream({
    turns: [
      toolTurn([{ id: "t1", tool: "write", args: { path: probe, content: written } }]),
      toolTurn([{ id: "t2", tool: "edit", args: { path: probe, edits: [{ tag: fileTag(written), anchorLine: 1, anchorHash: lineHash("smoke-ok"), newLines: ["smoke-edited"] }] } }]),
      textTurn("Smoke OK — the sextant surface rendered a write, an anchored edit and this summary."),
    ],
  });
  const reasons: string[] = [];
  const app = runTui({ renderer, stream, cwd, yolo: false, exitOnClose: false, model: "scripted" });
  io.feed("hello rovecode\r");
  const deadline = Date.now() + (opts.deadlineMs ?? 15_000);
  const cardFrames: string[] = [];
  let frame = "", done = false;
  while (Date.now() < deadline) {
    renderer.tick();
    frame = renderer.frameText();
    if (cardFrames.length === CARDS.length && frame.includes("Smoke OK") && !frame.includes("needs your permission")) { done = true; break; }
    const want = CARDS[cardFrames.length];
    if (want !== undefined && want.test(frame) && frame.includes("allow")) { cardFrames.push(frame); io.feed("\r"); } // Enter = allow once
    await sleep(25);
  }
  if (!done) reasons.push(`final frame not reached (approval cards seen ${cardFrames.length}/${CARDS.length})`);
  if (!/~ edit\s+smoke\.txt/.test(frame)) reasons.push("no `~ edit smoke.txt` tool row in the messages panel");
  if (!/\+ write\s+smoke\.txt/.test(frame)) reasons.push("no `+ write smoke.txt` tool row in the messages panel");
  for (const p of ["─ files ─", "─ code ─", "─ messages ─", "─ plan ─", "─ usage ─", "─ rovecode ─"]) if (!frame.includes(p) && !(p === "─ code ─" && frame.includes("─ diff ─"))) reasons.push(`panel ${p.trim()} missing at ${io.cols}×${io.rows}`);
  const wasActive = renderer.active;
  io.feed("\x03");
  await app;
  const tail = io.output().slice(-400);
  for (const seq of LEAVE) if (!tail.includes(seq)) reasons.push(`the output tail lacks ${JSON.stringify(seq)} — terminal not restored`);
  if (!wasActive) reasons.push("the frame interval was not running before quit");
  if (renderer.active) reasons.push("the frame interval survived quit");
  rmSync(cwd, { recursive: true, force: true });
  return { ok: reasons.length === 0, reasons, cardFrame: cardFrames[1] ?? cardFrames[0] ?? "(no approval card rendered)", frame, tail };
}

export async function runSextantSmoke(): Promise<void> {
  const r = await sextantSmoke();
  console.log("── sextant: approval card for the anchored edit (160x44) ──────────────────────");
  console.log(r.cardFrame);
  console.log("── sextant: final frame (160x44) ────────────────────────────────────────────────");
  console.log(r.frame);
  console.log("─────────────────────────────────────────────────────────────────────────────────");
  console.log(r.ok
    ? "smoke-tui --sextant: PASS (files · code · messages · plan · usage · rovecode + two approval cards through the full pipeline; terminal restored on quit)"
    : `smoke-tui --sextant: FAIL — ${r.reasons.join("; ")}`);
  process.exit(r.ok ? 0 : 1);
}
