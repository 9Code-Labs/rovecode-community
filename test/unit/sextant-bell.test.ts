/** The terminal bell (src/sextant/sextant-renderer.ts ring): BEL when a run ends and when an approval or
 *  question card opens — the one signal a human who tabbed away gets. Pinned: it rings at exactly those
 *  moments and nowhere else (not at boot, not on setBusy(true), not after quit); settings.json `"bell": false`
 *  in either scope silences it, as does the renderer option; a non-boolean value is ignored, not "truthy". */

import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSettings } from "../../src/core/settings.ts";
import { SextantRenderer } from "../../src/sextant/sextant-renderer.ts";
import type { RendererHooks } from "../../src/tui/renderer.ts";
import { MemoryIO } from "../../src/tui/sextant-io.ts";

const BEL = "\x07";
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const hooks: RendererHooks = { onSubmit() {}, onInterrupt() {}, onExit() {} };

function make(o: { cwd?: string; bell?: boolean; start?: boolean } = {}) {
  let now = 100_000;
  const io = new MemoryIO(160, 44, {});
  const renderer = new SextantRenderer({ io, clock: () => now, cwd: o.cwd ?? "C:/repo", scan: false, pet: "rovecode", ...(o.bell !== undefined ? { bell: o.bell } : {}) });
  if (o.start !== false) renderer.start(hooks);
  const bells = () => io.output().split(BEL).length - 1;
  return { io, renderer, bells, tick: (ms: number) => { now += ms; } };
}

test("rings once when a run ends, once when an approval card opens, once when a question card opens — and not at boot, not on setBusy(true)", async () => {
  const t = make();
  expect(t.bells()).toBe(0);                       // boot painted a frame, no bell
  t.renderer.setBusy(true, "thinking");
  expect(t.bells()).toBe(0);
  t.renderer.setBusy(false);
  expect(t.bells()).toBe(1);                       // the run ended
  t.renderer.setBusy(false);
  expect(t.bells()).toBe(1);                       // idle → idle is not a run ending
  const approval = t.renderer.askApproval("write", "notes.md", "+ hello");
  expect(t.bells()).toBe(2);                       // the card is up: the human is needed
  t.renderer.state.card = null;                    // the test does not answer the card; drop it so the next one can open
  void approval;
  const q = t.renderer.askQuestion({ question: "which?", options: [{ label: "a" }, { label: "b" }] } as never);
  expect(t.bells()).toBe(3);
  void q;
  t.renderer.stop();
  const before = t.bells();
  t.renderer.setBusy(true); t.renderer.setBusy(false);
  expect(t.bells()).toBe(before);                  // nothing rings after leave
});

test("settings.json `\"bell\": false` — project scope — silences it; a string is not a boolean and changes nothing; the renderer option wins over the file", () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-bell-")); dirs.push(cwd);
  mkdirSync(join(cwd, ".rovecode"), { recursive: true });
  writeFileSync(join(cwd, ".rovecode", "settings.json"), JSON.stringify({ bell: false }));
  expect(loadSettings(cwd).bell).toBe(false);
  const quiet = make({ cwd });
  quiet.renderer.setBusy(true); quiet.renderer.setBusy(false);
  void quiet.renderer.askApproval("write", "x", "y");
  expect(quiet.bells()).toBe(0);
  // the option is the caller's word (tests, a future flag): it beats the file either way
  const forced = make({ cwd, bell: true });
  forced.renderer.setBusy(true); forced.renderer.setBusy(false);
  expect(forced.bells()).toBe(1);
  const off = make({ bell: false });
  off.renderer.setBusy(true); off.renderer.setBusy(false);
  expect(off.bells()).toBe(0);
  // "off" is not false: sanitize drops it and the default (on) stands
  writeFileSync(join(cwd, ".rovecode", "settings.json"), JSON.stringify({ bell: "off" }));
  expect(loadSettings(cwd).bell).toBeUndefined();
  const loud = make({ cwd });
  loud.renderer.setBusy(true); loud.renderer.setBusy(false);
  expect(loud.bells()).toBe(1);
});

test("a renderer that was never started does not ring (no terminal is in raw mode to hear it)", () => {
  const t = make({ start: false });
  t.renderer.setBusy(true); t.renderer.setBusy(false);
  expect(t.bells()).toBe(0);
});
