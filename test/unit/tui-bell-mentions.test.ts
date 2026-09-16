/** The classic chat (src/tui/pi-renderer.ts) gets the same two things the sextant got, because its editor
 *  autocompletes files after `@` — a promise that used to do nothing — and because a `--classic` user tabbed
 *  away had no signal either. Pinned: BEL at run end / approval / question and nowhere else, through the same
 *  notifier decorator as the sextant (tui/notify.ts; the renderer's own ring() moved there on 2026-09-07), only
 *  while the terminal is unfocused, off with the same settings.json `bell: false`; a mention that is an exact
 *  cwd-relative path rides along as the read block, a mention that is not is said as a note and the message still
 *  goes; the transcript shows the typed line and one `attached` row per file, never the body; slash and shell lines
 *  are untouched. */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lineHash } from "../../src/coding/hashline.ts";
import { MENTION_FRAME } from "../../src/sextant/mentions.ts";
import { Notifier, resolveNotifyConfig, withNotifications, type NotifyConfig } from "../../src/tui/notify.ts";
import { PiTuiRenderer } from "../../src/tui/pi-renderer.ts";
import type { Renderer, RendererHooks } from "../../src/tui/renderer.ts";
import { VirtualTerminal } from "../../vendor/pi-tui/test/virtual-terminal.ts";

const BEL = "\x07";
const ALWAYS: NotifyConfig = { method: "bell", when: "always", tmux: false, notes: [] };
const dirs: string[] = [];
let active: PiTuiRenderer[] = [];
afterEach(() => { for (const r of active) r.stop(); active = []; for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs.length = 0; });

function tmp(): string { const d = mkdtempSync(join(tmpdir(), "rovecode-classic-")); dirs.push(d); return d; }

function boot(o: { cwd?: string; config?: NotifyConfig; start?: boolean; focused?: boolean } = {}) {
  const term = new VirtualTerminal(80, 24);
  // record raw writes without re-implementing the Terminal interface: BEL is a byte, not a cell
  const writes: string[] = [];
  const orig = term.write.bind(term);
  term.write = (data: string) => { writes.push(data); orig(data); };
  const submits: string[] = [];
  const hooks: RendererHooks = { onSubmit: (t) => { submits.push(t); }, onInterrupt() {}, onExit() {} };
  const cwd = o.cwd ?? process.cwd();
  const inner = new PiTuiRenderer({ terminal: term, cwd });
  const focus = { focused: o.focused ?? false }; // the default here: the person tabbed away
  const config = o.config ?? resolveNotifyConfig(cwd, { env: {} }); // an empty env: the files decide, auto → bell
  const renderer: Renderer = withNotifications(inner, new Notifier({ config, write: (s) => term.write(s), focused: () => focus.focused }));
  if (o.start !== false) renderer.start(hooks);
  active.push(inner);
  // pi-tui itself ends OSC sequences (title, progress) with a BEL byte, so count only the standalone writes the notifier makes
  const bells = () => writes.filter((w) => w === BEL).length;
  return { term, renderer, submits, bells, focus };
}

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
async function screen(term: VirtualTerminal): Promise<string> { await term.waitForRender(); return (await term.flushAndGetViewport()).map(strip).join("\n"); }

describe("the bell in the classic chat", () => {
  test("rings when a run ends, when an approval opens, when a question opens; not at boot, not on setBusy(true), not after stop", async () => {
    const t = boot();
    await screen(t.term);
    expect(t.bells()).toBe(0);
    t.renderer.setBusy(true, "thinking…");
    expect(t.bells()).toBe(0);
    t.renderer.setBusy(false);
    expect(t.bells()).toBe(1);
    t.renderer.setBusy(false);                        // no loader was up: idle → idle is not a run ending
    expect(t.bells()).toBe(1);
    const approval = t.renderer.askApproval("write", "notes.md");
    expect(t.bells()).toBe(2);
    t.term.sendInput("\x1b");                         // dismiss → deny; the card is not the subject here
    await approval;
    const q = t.renderer.askQuestion({ question: "which?", options: ["a", "b"] });
    expect(t.bells()).toBe(3);
    t.term.sendInput("\x1b");
    await q;
    t.renderer.stop();
    const before = t.bells();
    t.renderer.setBusy(true); t.renderer.setBusy(false);
    expect(t.bells()).toBe(before);                   // nothing rings after leave
  });

  test("focused (watching): nothing rings at any of the three moments; focus out → it does", async () => {
    const t = boot({ focused: true });
    await screen(t.term);
    t.renderer.setBusy(true, "thinking…"); t.renderer.setBusy(false);
    const approval = t.renderer.askApproval("write", "notes.md");
    t.term.sendInput("\x1b"); await approval;
    expect(t.bells()).toBe(0);                        // MUTATION: the gate inverted or dropped
    t.focus.focused = false;
    t.renderer.setBusy(true, "thinking…"); t.renderer.setBusy(false);
    expect(t.bells()).toBe(1);
  });

  test("settings.json `bell: false` in the cwd's project scope silences it; a config handed in beats the file; never started never rings", () => {
    const cwd = tmp();
    mkdirSync(join(cwd, ".rovecode"), { recursive: true });
    writeFileSync(join(cwd, ".rovecode", "settings.json"), JSON.stringify({ bell: false }));
    const quiet = boot({ cwd });
    quiet.renderer.setBusy(true); quiet.renderer.setBusy(false);
    expect(quiet.bells()).toBe(0);
    const forced = boot({ cwd, config: ALWAYS, focused: true });
    forced.renderer.setBusy(true); forced.renderer.setBusy(false);
    expect(forced.bells()).toBe(1);
    const cold = boot({ start: false, config: ALWAYS });
    cold.renderer.setBusy(true); cold.renderer.setBusy(false);
    expect(cold.bells()).toBe(0);
  });
});

describe("@file in the classic chat", () => {
  test("an exact cwd-relative path rides along as the read block; a non-path mention is a note; slash and shell lines are untouched; the transcript shows the typed line plus an attached row", async () => {
    const cwd = tmp();
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, "src", "a.ts"), "const a = 1;\n");
    const t = boot({ cwd });
    await screen(t.term);
    t.term.sendInput("explain @src/a.ts please");
    t.term.sendInput("\r");
    await t.term.drainInput();
    expect(t.submits).toHaveLength(1);
    const sent = t.submits[0]!;
    expect(sent.startsWith(`explain @src/a.ts please\n\n${MENTION_FRAME}\n\n[@src/a.ts — attached: 2 lines]\n`)).toBe(true);
    expect(sent).toContain(`1#${lineHash("const a = 1;")}|const a = 1;`);
    // what app.ts then echoes back is shown as the typed line and one attached row, not the block
    t.renderer.addUser(sent);
    const view = await screen(t.term);
    expect(view).toContain("> explain @src/a.ts please");
    expect(view).toContain("▤ attached src/a.ts · 2 lines");
    expect(view).not.toContain("|const a = 1;");
    // this surface has no file list: a basename alone is not a path here, and that is said
    t.term.sendInput("see @a.ts");
    t.term.sendInput("\r");
    await t.term.drainInput();
    expect(t.submits).toHaveLength(2);
    expect(t.submits[1]).toBe("see @a.ts");
    expect(await screen(t.term)).toContain("@a.ts: no file in the workspace matches");
    // never expanded
    t.term.sendInput("/zzz @src/a.ts"); t.term.sendInput("\r");
    await t.term.drainInput();
    t.term.sendInput("!cat @src/a.ts"); t.term.sendInput("\r");
    await t.term.drainInput();
    expect(t.submits.slice(2)).toEqual(["/zzz @src/a.ts", "!cat @src/a.ts"]);
  });
});
