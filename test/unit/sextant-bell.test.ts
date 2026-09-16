/** The notifier over the sextant (tui/notify.ts withNotifications; the renderer's own ring() moved there on 2026-09-07):
 *  BEL when a run ends and when an approval or question card opens — the one signal a human who tabbed away gets, and
 *  ONLY when they have: a focused terminal hears nothing. Pinned: it rings at exactly those moments and nowhere else (not
 *  at boot, not on setBusy(true), not after quit); settings.json `"bell": false` in the project scope silences it; a
 *  non-boolean value is ignored, not "truthy"; a config handed in beats the file; never started never rings. */

import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSettings } from "../../src/core/settings.ts";
import { SextantRenderer } from "../../src/sextant/sextant-renderer.ts";
import { Notifier, resolveNotifyConfig, withNotifications, type NotifyConfig } from "../../src/tui/notify.ts";
import type { Renderer, RendererHooks } from "../../src/tui/renderer.ts";
import { MemoryIO } from "../../src/tui/sextant-io.ts";

const BEL = "\x07";
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const hooks: RendererHooks = { onSubmit() {}, onInterrupt() {}, onExit() {} };
const ALWAYS: NotifyConfig = { method: "bell", when: "always", tmux: false, notes: [] };

function make(o: { cwd?: string; config?: NotifyConfig; start?: boolean; focused?: boolean } = {}) {
  let now = 100_000;
  const io = new MemoryIO(160, 44, {});
  const cwd = o.cwd ?? "C:/repo";
  const inner = new SextantRenderer({ io, clock: () => now, cwd, scan: false, pet: "rovecode" });
  const focus = { focused: o.focused ?? false }; // the default here: the person tabbed away
  const config = o.config ?? resolveNotifyConfig(cwd, { env: {} }); // an empty env: the files decide, auto → bell
  const renderer: Renderer = withNotifications(inner, new Notifier({ config, write: (s) => io.write(s), focused: () => focus.focused }));
  if (o.start !== false) renderer.start(hooks);
  const bells = () => io.output().split(BEL).length - 1;
  return { io, inner, renderer, bells, focus, tick: (ms: number) => { now += ms; } };
}

test("unfocused: rings once when a run ends, once when an approval card opens, once when a question card opens — and not at boot, not on setBusy(true), not after stop", async () => {
  const t = make();
  expect(t.bells()).toBe(0);                       // boot painted a frame, no bell
  expect(t.io.output()).toContain("\x1b[?1004h");  // the terminal is asked to report focus
  t.renderer.setBusy(true, "thinking");
  expect(t.bells()).toBe(0);
  t.renderer.setBusy(false);
  expect(t.bells()).toBe(1);                       // the run ended
  t.renderer.setBusy(false);
  expect(t.bells()).toBe(1);                       // idle → idle is not a run ending
  const approval = t.renderer.askApproval("write", "notes.md", "+ hello");
  expect(t.bells()).toBe(2);                       // the card is up: the human is needed
  t.inner.state.card = null;                       // the test does not answer the card; drop it so the next one can open
  void approval;
  const q = t.renderer.askQuestion({ question: "which?", options: [{ label: "a" }, { label: "b" }] } as never);
  expect(t.bells()).toBe(3);
  void q;
  t.renderer.stop();
  const before = t.bells();
  t.renderer.setBusy(true); t.renderer.setBusy(false);
  expect(t.bells()).toBe(before);                  // nothing rings after leave
});

test("focused (the person is watching): the same three moments ring NOTHING — until the terminal reports focus out", () => {
  const t = make({ focused: true });
  t.renderer.setBusy(true, "thinking"); t.renderer.setBusy(false);
  void t.renderer.askApproval("write", "x", "y");
  t.inner.state.card = null;
  expect(t.bells()).toBe(0);                       // MUTATION: the gate inverted or dropped → the bell nobody hears
  t.focus.focused = false;
  t.renderer.setBusy(true, "thinking"); t.renderer.setBusy(false);
  expect(t.bells()).toBe(1);
  t.focus.focused = true;
  t.renderer.setBusy(true, "thinking"); t.renderer.setBusy(false);
  expect(t.bells()).toBe(1);
});

test("settings.json `\"bell\": false` — project scope — silences it (and no DECSET is written); a string is not a boolean and changes nothing; a config handed in wins over the file", () => {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-bell-")); dirs.push(cwd);
  mkdirSync(join(cwd, ".rovecode"), { recursive: true });
  writeFileSync(join(cwd, ".rovecode", "settings.json"), JSON.stringify({ bell: false }));
  expect(loadSettings(cwd).bell).toBe(false);
  const quiet = make({ cwd });
  quiet.renderer.setBusy(true); quiet.renderer.setBusy(false);
  void quiet.renderer.askApproval("write", "x", "y");
  expect(quiet.bells()).toBe(0);
  expect(quiet.io.output()).not.toContain("?1004"); // nothing can fire, so the terminal is not asked to report focus
  const forced = make({ cwd, config: ALWAYS });
  forced.renderer.setBusy(true); forced.renderer.setBusy(false);
  expect(forced.bells()).toBe(1);
  // "off" is not false: sanitize drops it and the default (on) stands
  writeFileSync(join(cwd, ".rovecode", "settings.json"), JSON.stringify({ bell: "off" }));
  expect(loadSettings(cwd).bell).toBeUndefined();
  const loud = make({ cwd });
  loud.renderer.setBusy(true); loud.renderer.setBusy(false);
  expect(loud.bells()).toBe(1);
  // notify_when: always in the file — rings while focused too
  writeFileSync(join(cwd, ".rovecode", "settings.json"), JSON.stringify({ notify_when: "always" }));
  const always = make({ cwd, focused: true });
  always.renderer.setBusy(true); always.renderer.setBusy(false);
  expect(always.bells()).toBe(1);
});

test("a renderer that was never started does not ring (no terminal is in raw mode to hear it)", () => {
  const t = make({ start: false, config: ALWAYS });
  t.renderer.setBusy(true); t.renderer.setBusy(false);
  expect(t.bells()).toBe(0);
});
