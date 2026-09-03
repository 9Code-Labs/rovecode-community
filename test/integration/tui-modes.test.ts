/** Port #20 integration: plan/act mode WIRING through the real headless TUI
 *  (runTui → agentLoop → dispatch → Renderer → pi-tui → xterm emulator).
 *  Pins the layer R2 found mutation-free: run-start rule enforcement (M1),
 *  busy gate (M2), durable switch entries (M4), per-mode modelFor (M7), the
 *  status-line indicator (M8), MED-2 resume-to-last-mode, and LOW-3 replay. */

import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { SessionStore } from "../../src/core/session.ts";
import { buildModeChangeEntry, modeFromEntries } from "../../src/core/modes.ts";
import { VirtualTerminal } from "../../vendor/pi-tui/test/virtual-terminal.ts";
import { PiTuiRenderer } from "../../src/tui/pi-renderer.ts";
import { runTui } from "../../src/tui/app.ts";
import { mockStream, textTurn, toolTurn } from "../../src/providers/stream.ts";
import type { Message, ModelRef } from "../../src/core/types.ts";

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

function userMsg(text: string, parentId: string | null): Message {
  return { id: randomUUID(), role: "user", parts: [{ kind: "text", text }], parentId, createdAt: Date.now() };
}

function entriesOf(cwd: string, sid: string): Message[] {
  return new SessionStore(join(cwd, ".rovecode", "sessions"), sid).messages();
}

// The critic-designed core case: yolo boot → /plan → scripted write turn.
// (a) kills M1 (delete the applyModeRules assignment → the write lands),
// (b) kills M8 (status-line mode indicator), (c) kills M4 (durable entry).
test("plan under yolo: scripted write is denied end-to-end, status shows plan, switch is durable", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-tuimodes-"));
  const sid = randomUUID();
  const term = new VirtualTerminal(80, 24);
  const renderer = new PiTuiRenderer({ terminal: term, cwd });
  const probe = join(cwd, "must-not-exist.txt");
  const stream = mockStream({
    turns: [
      toolTurn([{ id: "t1", tool: "write", args: { path: probe, content: "leak\n" } }]),
      textTurn("plan-run-finished"),
    ],
  });
  const app = runTui({ renderer, stream, cwd, sessionId: sid, yolo: true, exitOnClose: false, model: "scripted" });
  await until(term, (s) => s.includes("rovecode"));

  term.sendInput("/plan"); term.sendInput("\r");
  await until(term, (s) => s.includes("read-only tools"));

  term.sendInput("try to write"); term.sendInput("\r");
  const screen = await until(term, (s) => s.includes("plan-run-finished"));
  expect(screen).toContain("plan-run-finished");    // the run completed…
  expect(existsSync(probe)).toBe(false);            // (a) …but the write never materialized
  expect(screen).toContain("plan · ");              // (b) status line carries the mode indicator

  term.sendInput("\x03");
  await app;
  expect(modeFromEntries(entriesOf(cwd, sid))).toBe("plan"); // (c) durable modeSwitch entry
  rmSync(cwd, { recursive: true, force: true });
}, 20_000);

test("busy gate: /plan mid-run is refused, mode stays act, nothing lands in the session (M2)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-tuimodes-"));
  const sid = randomUUID();
  const term = new VirtualTerminal(80, 24);
  const renderer = new PiTuiRenderer({ terminal: term, cwd });
  const slow = async function* () {
    await new Promise((r) => setTimeout(r, 600));
    yield { type: "turn" as const, turn: textTurn("slow-done") };
  };
  const app = runTui({ renderer, stream: slow, cwd, sessionId: sid, yolo: true, exitOnClose: false, model: "scripted" });
  await until(term, (s) => s.includes("rovecode"));

  term.sendInput("go"); term.sendInput("\r");
  await until(term, (s) => s.includes("> go"));      // run is in flight (busy set synchronously)
  term.sendInput("/plan"); term.sendInput("\r");
  const refused = await until(term, (s) => s.includes("finish or interrupt the run first"));
  expect(refused).toContain("finish or interrupt the run first");

  const done = await until(term, (s) => s.includes("slow-done"));
  expect(done).toContain("act · ");                  // status never left act
  expect(done).not.toContain("plan · ");

  term.sendInput("\x03");
  await app;
  expect(modeFromEntries(entriesOf(cwd, sid))).toBeNull(); // refused switch is not durable
  rmSync(cwd, { recursive: true, force: true });
}, 20_000);

test("per-mode model: the NEXT run streams with the plan slot's model from .rovecode/modes.json (M7)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-tuimodes-"));
  mkdirSync(join(cwd, ".rovecode"), { recursive: true });
  writeFileSync(join(cwd, ".rovecode", "modes.json"), JSON.stringify({
    planActSeparateModels: true, plan: { model: "plan-o1" },
  }));
  const term = new VirtualTerminal(80, 24);
  const renderer = new PiTuiRenderer({ terminal: term, cwd });
  const seen: string[] = [];
  const stream = async function* (model: ModelRef) {
    seen.push(model.model);
    yield { type: "turn" as const, turn: textTurn(`ok-${seen.length}`) };
  };
  const app = runTui({ renderer, stream, cwd, yolo: true, exitOnClose: false, model: "base-m" });
  await until(term, (s) => s.includes("rovecode"));

  term.sendInput("one"); term.sendInput("\r");
  await until(term, (s) => s.includes("ok-1"));
  expect(seen[0]).toBe("base-m");                    // act runs on the fallback model

  term.sendInput("/plan"); term.sendInput("\r");
  await until(term, (s) => s.includes("read-only tools"));
  term.sendInput("two"); term.sendInput("\r");
  await until(term, (s) => s.includes("ok-2"));
  expect(seen[1]).toBe("plan-o1");                   // plan runs on ITS slot, not the act model

  term.sendInput("\x03");
  await app;
  rmSync(cwd, { recursive: true, force: true });
}, 20_000);

// MED-2: a switch must survive WITHOUT a submit in between — quit path.
test("/plan then quit: reopening the session resumes in plan (MED-2 flush on close)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-tuimodes-"));
  const sid = randomUUID();
  {
    const term = new VirtualTerminal(80, 24);
    const renderer = new PiTuiRenderer({ terminal: term, cwd });
    const app = runTui({ renderer, stream: mockStream({ turns: [textTurn("x")] }), cwd, sessionId: sid, yolo: true, exitOnClose: false, model: "scripted" });
    await until(term, (s) => s.includes("rovecode"));
    term.sendInput("/plan"); term.sendInput("\r");
    await until(term, (s) => s.includes("read-only tools"));
    term.sendInput("\x03");                          // quit with the switch still pending
    await app;
  }
  expect(modeFromEntries(entriesOf(cwd, sid))).toBe("plan"); // flushed at close

  const term = new VirtualTerminal(80, 24);
  const renderer = new PiTuiRenderer({ terminal: term, cwd });
  const app = runTui({ renderer, stream: mockStream({ turns: [textTurn("x")] }), cwd, sessionId: sid, yolo: true, exitOnClose: false, model: "scripted" });
  const screen = await until(term, (s) => s.includes("plan · "));
  expect(screen).toContain("plan · ");               // reopened session boots in plan
  term.sendInput("\x03");
  await app;
  rmSync(cwd, { recursive: true, force: true });
}, 20_000);

// MED-2: switching away used to DISCARD the pending switch via modes.restore.
test("/plan then /resume away and back: the session keeps plan (MED-2 flush on switchSession)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-tuimodes-"));
  const sessionsDir = join(cwd, ".rovecode", "sessions");
  const aId = randomUUID();
  const bId = randomUUID();
  new SessionStore(sessionsDir, bId).append(userMsg("b-anchor", null)); // target to switch away to
  const term = new VirtualTerminal(80, 24);
  const renderer = new PiTuiRenderer({ terminal: term, cwd });
  const app = runTui({ renderer, stream: mockStream({ turns: [textTurn("x")] }), cwd, sessionId: aId, yolo: true, exitOnClose: false, model: "scripted" });
  await until(term, (s) => s.includes("rovecode"));

  term.sendInput("/plan"); term.sendInput("\r");
  await until(term, (s) => s.includes("read-only tools"));
  term.sendInput(`/resume ${bId}`); term.sendInput("\r");
  const inB = await until(term, (s) => s.includes(`session ${bId.slice(0, 8)}`));
  expect(inB).toContain("act · ");                   // B never switched → its own mode (act)

  term.sendInput(`/resume ${aId}`); term.sendInput("\r");
  await until(term, (s) => s.includes(`session ${aId.slice(0, 8)}`));
  const back = await until(term, (s) => s.includes("plan · "));
  expect(back).toContain("plan · ");                 // A resumed in ITS last mode

  term.sendInput("\x03");
  await app;
  expect(modeFromEntries(entriesOf(cwd, aId))).toBe("plan");
  expect(modeFromEntries(entriesOf(cwd, bId))).toBeNull();
  rmSync(cwd, { recursive: true, force: true });
}, 20_000);

// LOW-3: replay must render the switch as a human line, not the raw XML notice.
test("replay renders modeSwitch entries as 'mode → plan', never raw <mode_notice> XML (LOW-3)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-tuimodes-"));
  const sid = randomUUID();
  const fixture = new SessionStore(join(cwd, ".rovecode", "sessions"), sid);
  const u1 = userMsg("hello there", null);
  fixture.append(u1);
  fixture.append(buildModeChangeEntry({ from: "act", to: "plan" }, u1.id));

  const term = new VirtualTerminal(80, 24);
  const renderer = new PiTuiRenderer({ terminal: term, cwd });
  const app = runTui({ renderer, stream: mockStream({ turns: [textTurn("x")] }), cwd, sessionId: sid, yolo: true, exitOnClose: false, model: "scripted" });
  const screen = await until(term, (s) => s.includes("mode → plan"));
  expect(screen).toContain("hello there");           // transcript replayed
  expect(screen).toContain("mode → plan");           // human line
  expect(screen).not.toContain("mode_notice");       // raw XML never shown
  expect(screen).toContain("plan · ");               // and the mode itself was restored

  term.sendInput("\x03");
  await app;
  rmSync(cwd, { recursive: true, force: true });
}, 20_000);
