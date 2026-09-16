/** `/trust` reaches the card through the real TUI: runTui + a scripted FakeRenderer over a scratch cwd and a scratch
 *  ROVECODE_HOME. The card's own decisions are pinned in test/unit/tui-trust-card.test.ts; what is pinned HERE is the
 *  wiring — the command is typeable, it acts on the RUN's cwd, `show` never asks, and a yes taken in the TUI is the same
 *  yes `rovecode trust` would have recorded (the gate's own predicate agrees afterwards), so nobody has to leave the
 *  session to answer. Plus the palette entries: /trust exists, and /sessions offers the four verbs. */

import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isTrustedFile } from "../../src/core/trust.ts";
import { rovecodeHome } from "../../src/providers/auth.ts";
import { mockStream, textTurn } from "../../src/providers/stream.ts";
import { runTui, TUI_COMMANDS } from "../../src/tui/app.ts";
import type { ApprovalAnswer, AssistantView, PickItem, Renderer, RendererHooks, SlashCommand, StatusInfo } from "../../src/tui/renderer.ts";
import { scratchHome } from "../helpers/mcp-trust.ts";
import { scratchDirs } from "../helpers/scratch.ts";

const scratch = scratchDirs();

class FakeRenderer implements Renderer {
  hooks!: RendererHooks;
  notes: { text: string; tone: string }[] = [];
  pickCalls: { items: PickItem[]; title?: string }[] = [];
  commands: SlashCommand[] = [];
  nextPick: (items: PickItem[]) => string | null = () => null;
  start(h: RendererHooks): void { this.hooks = h; }
  stop(): void {}
  setCommands(cmds: SlashCommand[]): void { this.commands = cmds; }
  addUser(): void {}
  addSystemNote(text: string, tone: "info" | "warn" | "error" = "info"): void { this.notes.push({ text, tone }); }
  beginAssistant(): AssistantView { return { append() {}, done() {} }; }
  toolStart(): void {}
  toolUpdate(): void {}
  toolEnd(): void {}
  async askApproval(): Promise<ApprovalAnswer> { return "deny"; }
  async askQuestion(): Promise<null> { return null; }
  async pickOne(items: PickItem[], title?: string): Promise<string | null> { this.pickCalls.push({ items, title }); return this.nextPick(items); }
  clearTranscript(): void {}
  prefillEditor(): void {}
  setBusy(): void {}
  setStatus(_info: StatusInfo): void {}
  texts(): string[] { return this.notes.map((n) => n.text); }
}

async function waitFor(cond: () => boolean, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (cond()) return; await new Promise((r) => setTimeout(r, 10)); }
  if (!cond()) throw new Error("waitFor timed out");
}

test("/trust in a running TUI: `show` lists this repo's gated file and asks nothing; `/trust` opens ONE card whose first item refuses, and approving it makes the gate's own predicate say trusted — without leaving the session", async () => {
  const restore = scratchHome();
  try {
    const cwd = scratch("rovecode-trust-wiring-");
    mkdirSync(join(cwd, ".rovecode"), { recursive: true });
    const file = join(cwd, ".rovecode", "settings.json");
    writeFileSync(file, JSON.stringify({ verify: "bun test", permission: "ask" }), "utf8");
    const fake = new FakeRenderer();
    const app = runTui({ renderer: fake, stream: mockStream({ turns: [textTurn("ok")] }), cwd, sessionId: "trust-1", yolo: true, exitOnClose: false, model: "scripted" });

    fake.hooks.onSubmit("/trust show");
    await waitFor(() => fake.texts().some((t) => t.startsWith("· UNTRUSTED") && t.includes(file)));
    expect(fake.texts().some((t) => t.includes("verify: bun test"))).toBe(true);
    expect(fake.pickCalls.length).toBe(0);
    expect(isTrustedFile(rovecodeHome(), file)).toBe(false);

    fake.nextPick = (items) => items.find((i) => i.value === file)!.value;
    fake.hooks.onSubmit("/trust");
    await waitFor(() => fake.texts().some((t) => t.startsWith(`trusted ${file}`)));
    expect(fake.pickCalls.length).toBe(1);
    expect(fake.pickCalls[0]!.items[0]!.label).toBe("keep them untrusted");
    expect(fake.pickCalls[0]!.title).toContain(cwd);
    expect(isTrustedFile(rovecodeHome(), file)).toBe(true);

    fake.hooks.onSubmit("/trust bogus");
    await waitFor(() => fake.notes.some((n) => n.tone === "warn" && n.text.includes('unknown /trust verb "bogus"')));
    fake.hooks.onExit();
    await app;
    expect(fake.commands.some((c) => c.name === "trust")).toBe(true);
    const sessions = fake.commands.find((c) => c.name === "sessions")!;
    expect(sessions.choices).toEqual(["rename", "delete", "fork", "search"]);
  } finally { restore(); }
}, 20_000);

test("the palette table itself carries /trust and the /sessions verbs (a command nothing offers is a command nobody finds)", () => {
  const trust = TUI_COMMANDS.find((c) => c.name === "trust");
  expect(trust).toBeDefined();
  expect(trust!.choices).toEqual(["show", "untrust"]);
  expect(trust!.description).toContain("/trust");
  expect(TUI_COMMANDS.find((c) => c.name === "sessions")!.description).toContain("rename");
});
