/** The intro owns the screen until required work is ready, then the FIRST TUI frame is complete.
 *  Fake sandbox runners exercise the real runtime gate without spawning wsl/docker. */
import { expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { INTRO_STEPS, startIntro } from "../../src/core/intro.ts";
import { resetExecutor } from "../../src/core/executor.ts";
import { runTui } from "../../src/tui/app.ts";
import { Notifier, withNotifications } from "../../src/tui/notify.ts";
import { MemoryIO } from "../../src/tui/sextant-io.ts";
import { SextantRenderer } from "../../src/sextant/sextant-renderer.ts";
import type { RendererHooks, RendererStartOptions } from "../../src/tui/renderer.ts";
import { scratchDirs } from "../helpers/scratch.ts";
const scratch = scratchDirs();

function fixture(scan = false) {
  const cwd = scratch("rovecode-startup-");
  const keys = ["ROVECODE_SANDBOX", "ROVECODE_NO_REPOMAP", "ROVECODE_NO_UPDATE_CHECK"];
  const saved = keys.map((key) => process.env[key]);
  process.env.ROVECODE_SANDBOX = "wsl";
  process.env.ROVECODE_NO_REPOMAP = "1";
  process.env.ROVECODE_NO_UPDATE_CHECK = "1";
  const io = new MemoryIO(160, 44);
  const events: string[] = [], frames: string[] = [], introWrites: string[] = [];
  class Surface extends SextantRenderer {
    override start(hooks: RendererHooks, opts?: RendererStartOptions) {
      const starting = super.start(hooks, opts);
      const shown = () => { events.push("start"); frames.push(this.frameText()); };
      return starting ? starting.then(shown) : shown();
    }
  }
  const renderer = new Surface({ io, cwd, scan });
  let tick = () => {};
  const intro = startIntro({ tty: true, columns: 160, rows: 44, holdUntilReady: true,
    write: (s) => introWrites.push(s), setInterval: (fn) => { tick = fn; return 1; }, clearInterval: () => {} });
  let release!: (r: { code: number; stdout: string; stderr: string }) => void;
  const probe = new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => { release = resolve; });
  const startup = { status: intro.status, animationDone: intro.animationDone, finish: () => { events.push("finish"); intro.finish(); } };
  const close = async () => {
    release({ code: 0, stdout: "", stderr: "" }); intro.finish(); renderer.stop(); await renderer.drain(); resetExecutor();
    keys.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i]; });
  };
  return { cwd, io, renderer, frames, events, introWrites, startup, intro, release, tick: () => tick(), close, spawnRunner: () => probe };
}
const until = async (predicate: () => boolean) => {
  const deadline = Date.now() + 3000;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(2);
  expect(predicate()).toBe(true);
};

test("slow preparation keeps the intro; notified sextant starts once with all panels, input and boot notes in its first frame", async () => {
  const f = fixture();
  const wrapped = withNotifications(f.renderer, new Notifier({ config: { when: "unfocused", tmux: false, notes: [] } }));
  const app = runTui({ cwd: f.cwd, renderer: wrapped, stream: null, exitOnClose: false, platform: "win32", spawnRunner: f.spawnRunner, startup: f.startup });
  try {
    for (let i = 0; i <= INTRO_STEPS + 10; i++) f.tick(); // even after the choreography, NOT after readiness
    await Promise.resolve();
    expect(f.events).toEqual([]);
    expect(f.io.raw).toBe(false); expect(f.io.writes).toHaveLength(0);
    expect(f.introWrites.at(-1)).toContain("checking sandbox");
    f.io.resize(180, 48); // the eventual layout must use the latest terminal dimensions
    f.release({ code: 0, stdout: "", stderr: "" });
    await until(() => f.frames.length === 1);
    expect(f.events).toEqual(["finish", "start"]);
    const first = f.frames[0]!;
    for (const panel of ["─ files ─", "─ code ─", "─ messages ─", "─ plan ─", "─ usage ─"]) expect(first).toContain(panel);
    expect(first).toContain("ask rovecode");
    expect(first).toContain("no model connected yet — /setup");
    expect(f.io.raw).toBe(true);
    const count = f.introWrites.length; f.tick(); expect(f.introWrites).toHaveLength(count);
    f.io.feed(String.fromCharCode(3)); await app;
    expect(f.io.listeners).toBe(0); expect(f.io.raw).toBe(false);
  } finally { f.io.feed(String.fromCharCode(3)); await f.close(); await app.catch(() => {}); }
});

test("a fast runtime does not dismiss the intro: textbox is prepared offscreen, then the latest resized frame is revealed", async () => {
  const f = fixture();
  const app = runTui({ cwd: f.cwd, renderer: withNotifications(f.renderer, new Notifier({ config: { when: "unfocused", tmux: false, notes: [] } })), stream: null, exitOnClose: false, platform: "win32", spawnRunner: f.spawnRunner, startup: f.startup });
  try {
    f.release({ code: 0, stdout: "", stderr: "" });
    await until(() => f.renderer.frameText().includes("ask rovecode"));
    await Bun.sleep(25); // queued render callbacks must NOT take over stdout
    expect(f.events).toEqual([]); expect(f.io.writes).toHaveLength(0);
    expect(f.io.raw).toBe(false); expect(f.renderer.frames).toBe(0);
    f.io.resize(140, 40);
    f.renderer.addSystemNote("LATEST-PREPARED-STATE");
    for (let i = 0; i < INTRO_STEPS; i++) f.tick();
    await until(() => f.frames.length === 1);
    expect(f.events).toEqual(["finish", "start"]);
    expect(f.frames[0]).toContain("LATEST-PREPARED-STATE");
    expect(f.frames[0]).toContain("ask rovecode");
    expect(f.frames[0]!.split("\n")).toHaveLength(40);
    expect(f.renderer.frames).toBe(1); expect(f.io.raw).toBe(true);
    f.io.feed("ready textbox");
    expect(f.renderer.frameText()).toContain("ready textbox");
    f.io.feed(String.fromCharCode(3)); await app;
  } finally { f.intro.finish(); f.io.feed(String.fromCharCode(3)); await f.close(); await app.catch(() => {}); }
});

test("the initial file listing is already present in the first visible frame", async () => {
  const f = fixture(true);
  writeFileSync(join(f.cwd, "ready-file.ts"), "export const ready = true;\n");
  const app = runTui({ cwd: f.cwd, renderer: f.renderer, stream: null, exitOnClose: false, platform: "win32", spawnRunner: f.spawnRunner, startup: { ...f.startup, animationDone: Promise.resolve() } });
  try {
    f.release({ code: 0, stdout: "", stderr: "" });
    await until(() => f.frames.length === 1);
    expect(f.frames[0]).toContain("ready-file.ts");
    expect(f.frames[0]).toContain("ask rovecode");
    f.io.feed(String.fromCharCode(3)); await app;
  } finally { f.intro.finish(); f.io.feed(String.fromCharCode(3)); await f.close(); await app.catch(() => {}); }
});

test("cancellation after offscreen preparation never flashes the TUI, even when the intro later settles", async () => {
  const f = fixture(); const ac = new AbortController();
  const app = runTui({ cwd: f.cwd, renderer: f.renderer, stream: null, exitOnClose: false, platform: "win32", spawnRunner: f.spawnRunner, startup: { ...f.startup, signal: ac.signal } });
  try {
    f.release({ code: 0, stdout: "", stderr: "" });
    await until(() => f.renderer.frameText().includes("ask rovecode"));
    ac.abort(new Error("cancel prepared screen"));
    await expect(app).rejects.toThrow("cancel prepared screen");
    for (let i = 0; i <= INTRO_STEPS; i++) f.tick();
    await Promise.resolve();
    expect(f.events).toEqual(["finish"]); expect(f.io.writes).toHaveLength(0);
    expect(f.io.listeners).toBe(0); expect(f.io.raw).toBe(false);
  } finally { await f.close(); }
});

test("a failed probe cleans up the intro without ever entering the TUI or raw mode", async () => {
  const f = fixture();
  try {
    const app = runTui({ cwd: f.cwd, renderer: f.renderer, stream: null, exitOnClose: false, platform: "win32", spawnRunner: f.spawnRunner, startup: f.startup });
    f.release({ code: 1, stdout: "", stderr: "probe refused" });
    await expect(app).rejects.toThrow("probe refused");
    await f.intro.done;
    expect(f.events).toEqual(["finish"]);
    expect(f.io.writes).toHaveLength(0); expect(f.io.listeners).toBe(0);
  } finally { await f.close(); }
});

test("Ctrl+C during preparation does not wait for the probe or show a partial TUI", async () => {
  const f = fixture(); const ac = new AbortController();
  try {
    const app = runTui({ cwd: f.cwd, renderer: f.renderer, stream: null, exitOnClose: false, platform: "win32", spawnRunner: f.spawnRunner, startup: { ...f.startup, signal: ac.signal } });
    ac.abort(new Error("cancel startup"));
    await expect(app).rejects.toThrow("cancel startup");
    expect(f.events).toEqual(["finish"]);
    expect(f.io.raw).toBe(false); expect(f.frames).toHaveLength(0);
  } finally { await f.close(); }
});

test("already-cancelled startup creates no runtime state", async () => {
  const f = fixture(); const ac = new AbortController(); ac.abort(new Error("cancelled already"));
  try {
    await expect(runTui({ cwd: f.cwd, renderer: f.renderer, exitOnClose: false, startup: { ...f.startup, signal: ac.signal } })).rejects.toThrow("cancelled already");
    expect(existsSync(join(f.cwd, ".rovecode"))).toBe(false);
    expect(f.io.writes).toHaveLength(0);
  } finally { await f.close(); }
});
