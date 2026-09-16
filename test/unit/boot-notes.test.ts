/** Boot-note extraction port: aion's banner/warning/once-only cases adapted to rovecode's real channels.
 *  Existing tui-wiring, tui-hooks and tui-session-nav tests additionally pin the runTui wiring. */
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime } from "../../src/cli/runtime.ts";
import { resetExecutor } from "../../src/core/executor.ts";
import { emitBootNotes, type BootNotesCtx } from "../../src/tui/boot-notes.ts";
import { mockStream, textTurn } from "../../src/providers/stream.ts";
import { removeDir } from "../helpers/scratch.ts";

async function rig(run: (ctx: BootNotesCtx, notes: { text: string; tone: string }[]) => void | Promise<void>, setup?: (cwd: string, home: string) => void): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), "rovecode-boot-notes-"));
  const home = mkdtempSync(join(tmpdir(), "rovecode-boot-home-"));
  const saved = process.env.ROVECODE_HOME;
  process.env.ROVECODE_HOME = home;
  setup?.(cwd, home);
  const rt = createRuntime({ cwd, sessionId: "legacy-session", stream: null });
  const notes: { text: string; tone: string }[] = [];
  const ctx: BootNotesCtx = { rt, renderer: { addSystemNote(text, tone = "info") { notes.push({ text, tone }); } }, yolo: false, modelRef: { provider: "mock", model: "scripted" }, mode: "act", version: "0.3.2", width: 80, sessionId: undefined, bootWarn: undefined, commandWarnings: [] };
  try { await rt.hooks.ready; await run(ctx, notes); }
  finally {
    await rt.hooks.close(); await rt.mcp?.close(); rt.bashJobs.dispose(); resetExecutor();
    if (saved === undefined) delete process.env.ROVECODE_HOME; else process.env.ROVECODE_HOME = saved;
    removeDir(cwd); removeDir(home);
  }
}

test("boot banner: no provider keeps the exact wordmark, setup hint and ask-first line", async () => {
  await rig((ctx, notes) => {
    emitBootNotes(ctx);
    expect(notes).toEqual([{ text: ["  █▀█ █▀█ █ █ █▀▀ █▀▀ █▀█ █▀▄ █▀▀", "  █▀▄ █▄█ ▀▄▀ █▄▄ █▄▄ █▄█ █▄▀ █▄▄  0.3.2", "", "  no model connected yet — /setup fixes that in about a minute", `  ${ctx.rt.cwd} · ask first`].join(String.fromCharCode(10)), tone: "info" }]);
  });
});

test("boot banner: connected, narrow, yolo and plan keep rovecode's wording", async () => {
  await rig((ctx, notes) => {
    ctx.rt.stream = mockStream({ turns: [textTurn("ok")] }); ctx.rt.noProviderReason = () => null;
    emitBootNotes({ ...ctx, yolo: true, mode: "plan", width: 40, modelRef: { provider: "test", model: "model" } });
    expect(notes[0]).toEqual({ text: [`◆ rovecode 0.3.2 here. Connected to test/model.`, "Tell me what you want done; I read first, then work without asking.", "/help lists commands by topic.", `${ctx.rt.cwd} · auto · plan mode (read-only)`].join(String.fromCharCode(10)), tone: "info" });
  });
});

test("resumed boot emits one resume line, then the boot fact, command and provider warnings unchanged", async () => {
  await rig((ctx, notes) => {
    ctx.rt.providers.warnings = () => ["malformed entry"];
    emitBootNotes({ ...ctx, sessionId: "abcdef123456", bootWarn: "nothing to continue from — this is a new session", commandWarnings: ["/quit is a built-in command — built-in kept (quit.md)"] });
    expect(notes).toEqual([
      { text: `◆ back in session abcdef12 · ${ctx.rt.cwd} · ask first`, tone: "info" },
      { text: "nothing to continue from — this is a new session", tone: "info" },
      { text: "/quit is a built-in command — built-in kept (quit.md)", tone: "warn" },
      { text: "providers: malformed entry", tone: "warn" },
    ]);
  });
});

test("legacy-memory copy note rides the existing channel exactly once, and not on the next runtime", async () => {
  await rig(async (ctx, notes) => {
    emitBootNotes(ctx);
    const from = join(ctx.rt.cwd, ".rovecode", "sessions", "legacy-session", "memory");
    const text = `memory: copied MEMORY.md → ${join(ctx.rt.cwd, ".rovecode", "memory")} forward from the legacy per-session store ${from} (left in place; in the prompt from this run on)`;
    expect(notes.filter((n) => n.text.startsWith("memory:"))).toEqual([{ text, tone: "warn" }]);
    const again = createRuntime({ cwd: ctx.rt.cwd, sessionId: "legacy-session", stream: null });
    try { notes.length = 0; emitBootNotes({ ...ctx, rt: again }); expect(notes.some((n) => n.text.includes("legacy per-session"))).toBe(false); }
    finally { await again.hooks.close(); await again.mcp?.close(); again.bashJobs.dispose(); }
  }, (cwd) => {
    const dir = join(cwd, ".rovecode", "sessions", "legacy-session", "memory");
    mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, "MEMORY.md"), "remember this");
  });
});

test("buffered hook warnings replay once and live warnings use the same prefix and tone", async () => {
  await rig((ctx, notes) => {
    let hookNote!: (text: string) => void;
    ctx.rt.hooks.onWarning = (fn) => { hookNote = fn; fn("broken hooks.ts"); };
    let startupNote!: (text: string) => void;
    ctx.rt.plugins.onWarning = (fn) => { startupNote = fn; fn("trust: project file withheld"); fn("agents: invalid tools"); fn("roots: duplicate directory"); };
    let routerNote!: (text: string) => void;
    ctx.rt.onRouterNote = (fn) => { routerNote = fn; };
    emitBootNotes(ctx);
    hookNote("approval hook timed out"); startupNote("plugins: activation failed"); routerNote("anthropic: overloaded — retrying in 4 s (2/4)");
    expect(notes.slice(1)).toEqual([
      { text: "hooks: broken hooks.ts", tone: "warn" },
      { text: "trust: project file withheld", tone: "warn" },
      { text: "agents: invalid tools", tone: "warn" },
      { text: "roots: duplicate directory", tone: "warn" },
      { text: "hooks: approval hook timed out", tone: "warn" },
      { text: "plugins: activation failed", tone: "warn" },
      { text: "anthropic: overloaded — retrying in 4 s (2/4)", tone: "warn" },
    ]);
  });
});
