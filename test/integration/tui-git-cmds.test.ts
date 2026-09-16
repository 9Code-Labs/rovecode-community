/** Port #65 wiring — the TUI dispatch lines: `/undo` and `/commit …` typed at the prompt reach tui/git-cmds.ts through
 *  app.ts handleSlash (FakeRenderer, tui-session-nav idiom; the runtime is real, the cwd a temp dir); the sextant's
 *  renderer-local dispatch no longer swallows `/undo` as an alias toast — it reaches onSubmit like any built-in. */

import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTui } from "../../src/tui/app.ts";
import { resetExecutor } from "../../src/core/executor.ts";
import { dispatch } from "../../src/sextant/local-commands.ts";
import type { ApprovalAnswer, AssistantView, PickItem, Renderer, RendererHooks, SlashCommand, StatusInfo } from "../../src/tui/renderer.ts";
import { makeState, spyCtx } from "../helpers/sextant-fixtures-keys.ts";

afterEach(() => resetExecutor());

class FakeRenderer implements Renderer {
  hooks!: RendererHooks;
  notes: { text: string; tone: string }[] = [];
  asks: { tool: string; preview: string; detail?: string }[] = [];
  commands: SlashCommand[] = [];
  start(h: RendererHooks): void { this.hooks = h; }
  stop(): void {}
  setCommands(c: SlashCommand[]): void { this.commands = c; }
  addUser(): void {}
  addSystemNote(text: string, tone: "info" | "warn" | "error" = "info"): void { this.notes.push({ text, tone }); }
  beginAssistant(): AssistantView { return { append() {}, done() {} }; }
  toolStart(): void {} toolUpdate(): void {} toolEnd(): void {}
  async askApproval(tool: string, preview: string, detail?: string): Promise<ApprovalAnswer> { this.asks.push({ tool, preview, detail }); return "deny"; }
  async askQuestion(): Promise<null> { return null; }
  async pickOne(_items: PickItem[]): Promise<string | null> { return null; }
  clearTranscript(): void {} prefillEditor(): void {}
  setBusy(): void {} setStatus(_i: StatusInfo): void {}
}

async function waitFor(cond: () => boolean, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`${what}: not true within ${ms}ms`);
    await new Promise((r) => setTimeout(r, 15));
  }
}
function deadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const bomb = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error(`${what}: not settled within ${ms}ms`)), ms); });
  return Promise.race([p, bomb]).finally(() => clearTimeout(t));
}

test("TUI: /undo with no checkpoint notes it; /commit reaches cmdCommit (the git diff runs through the bash tool in a non-repo cwd → the honest error note); both commands are offered to the palette", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rove-p65-tui-"));
  const fake = new FakeRenderer();
  const app = runTui({ renderer: fake, stream: null, cwd, yolo: false, exitOnClose: false });
  try {
    expect(fake.commands.map((c) => c.name)).toContain("commit");
    expect(fake.commands.map((c) => c.name)).toContain("undo");
    fake.hooks.onSubmit("/undo");
    await waitFor(() => fake.notes.some((n) => n.text.startsWith("no checkpoint to undo to")), 20_000, "/undo note");
    fake.hooks.onSubmit("/commit feat: x");
    await waitFor(() => fake.notes.some((n) => /^git diff failed \(exit 12[89]\): .* is not inside a git repository$/.test(n.text)), 40_000, "/commit note");
    expect(fake.asks).toEqual([]); // `git diff --cached` is allow-listed: no card; the commit never got that far
    expect(fake.notes.filter((n) => n.text.startsWith("unknown command"))).toEqual([]); // both are real built-ins now
  } finally {
    fake.hooks.onExit();
    await deadline(app, 15_000, "runTui close");
    try { rmSync(cwd, { recursive: true, force: true }); } catch { /* lingering handle on Windows */ }
  }
}, 90_000);

test("sextant: `/undo` is no longer a renderer-local alias — dispatch hands it to onSubmit (the app's handleSlash), no toast", () => {
  const s = makeState(), spy = spyCtx();
  dispatch(s, "/undo", spy.ctx);
  dispatch(s, "/commit feat: x", spy.ctx);
  expect(spy.submits).toEqual(["/undo", "/commit feat: x"]);
  expect(spy.toasts).toEqual([]);
});
