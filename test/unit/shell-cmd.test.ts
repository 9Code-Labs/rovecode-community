/** `!cmd` in the composer (src/tui/shell-cmd.ts, 2026-09-07) and the classifier behind it.
 *
 *  The rule that matters: the person's own command goes through the SAME ToolRegistry.dispatch, permission rules
 *  and approval chain a model-issued `bash` call gets — never a raw spawn, never a second policy path. These pin
 *  that the dispatch is the one used, that a refusal before execution records NOTHING (the model must learn only
 *  what actually ran), and that the record round-trips so a resumed transcript shows the command rather than the
 *  XML the model reads. */

import { describe, expect, test } from "bun:test";
import { outputBlock, parseShellRecord, replayShellRecord, runShellLine, shellLine, shellRecord, REFUSED_DETAIL, type ShellCtx } from "../../src/tui/shell-cmd.ts";
import { parseInput } from "../../src/sextant/overlays.ts";
import type { ApprovalAnswer, AssistantView, PickItem, QuestionPrompt, Renderer, RendererHooks, StatusInfo } from "../../src/tui/renderer.ts";
import type { Message, RunEvent, ToolOutput } from "../../src/core/types.ts";

describe("the classifier (sextant/overlays.ts parseInput — the ONE rule)", () => {
  test("`!cmd` is a command; `!` alone, `! x` and `!!x` are plain text for the model", () => {
    expect(shellLine("!bun test")).toBe("bun test");
    expect(shellLine("  !git status  ")).toBe("git status");
    expect(shellLine("!ls -la")).toBe("ls -la");
    // MUTATION: the pre-2026-09-07 rule was `t[0] === "!"` alone — harmless only while nothing consumed it
    for (const t of ["!", "! x", "! ", "!!x", "!!", "hello !ls", "the file is foo!", ""]) {
      expect([t, shellLine(t)]).toEqual([t, null]);
    }
    expect(parseInput("!bun test").kind).toBe("shell");
    expect(parseInput("! x").kind).toBe("text");
    expect(parseInput("!!x").kind).toBe("text");
    expect(parseInput("!").kind).toBe("text");
  });

  test("a shell line carries no @mentions: `!grep @foo` is one command, not a file attach", () => {
    expect(parseInput("!grep @foo src/").mentions).toEqual([]);
  });
});

// ---------- the record ----------

describe("the session record the model reads next turn", () => {
  test("shellRecord → parseShellRecord round-trips the command, the exit code and the body; the bash tool's exit header becomes the attribute", () => {
    const out: ToolOutput = { ok: true, output: "exit=0\nhello\nworld\n" };
    const m = shellRecord("echo hello", out, null);
    expect(m.role).toBe("user");
    const text = (m.parts[0] as { text: string }).text;
    expect(text).toContain("<user_shell_command>\n$ echo hello\n</user_shell_command>");
    expect(text).toContain('<user_shell_output exit="0">');
    const parsed = parseShellRecord(text)!;
    expect(parsed).toEqual({ cmd: "echo hello", exit: "0", output: "hello\nworld" });
    // a failure keeps its code, an output with no exit header says so rather than inventing 0
    expect(parseShellRecord((shellRecord("false", { ok: false, output: "exit=1\n" }, null).parts[0] as { text: string }).text)).toEqual({ cmd: "false", exit: "1", output: "" });
    expect(parseShellRecord((shellRecord("x", { ok: false, output: "no header here" }, null).parts[0] as { text: string }).text)).toEqual({ cmd: "x", exit: "?", output: "no header here" });
    expect(parseShellRecord("just a normal user message")).toBeNull();
    expect(parseShellRecord("")).toBeNull();
  });

  test("outputBlock shows a bounded head and names the rest, so the classic transcript cannot be flooded", () => {
    const many = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
    const block = outputBlock(many);
    expect(block.split("\n").length).toBe(41);                    // 40 lines + the footer
    expect(block).toContain("… 60 more lines (the session record keeps the full output)");
    expect(outputBlock("one\ntwo")).toBe("one\ntwo");             // short output is untouched, no footer
  });

  test("replayShellRecord renders the typed line and the bash card pair; a normal message is left alone", () => {
    const r = new FakeRenderer();
    const text = (shellRecord("bun test", { ok: true, output: "exit=0\nall pass" }, null).parts[0] as { text: string }).text;
    expect(replayShellRecord(r, text)).toBe(true);
    expect(r.users).toEqual(["!bun test"]);
    expect(r.toolStarts[0]).toMatchObject({ tool: "bash" });
    expect(r.toolEnds[0]!.ok).toBe(true);
    expect(r.toolEnds[0]!.preview).toContain("exit=0");
    expect(replayShellRecord(r, "please fix it")).toBe(false);
    expect(r.users.length).toBe(1);
  });
});

// ---------- the dispatch ----------

class FakeRenderer implements Renderer {
  users: string[] = []; notes: { text: string; tone: string }[] = [];
  toolStarts: { callId: string; tool: string }[] = []; toolEnds: { callId: string; ok: boolean; preview: string }[] = [];
  busy: { b: boolean; label?: string }[] = [];
  approvals: string[] = []; answer: ApprovalAnswer = "once";
  start(_h: RendererHooks): void {}
  stop(): void {}
  setCommands(): void {}
  addUser(t: string): void { this.users.push(t); }
  addSystemNote(text: string, tone: "info" | "warn" | "error" = "info"): void { this.notes.push({ text, tone }); }
  beginAssistant(): AssistantView { return { append() {}, done() {} }; }
  toolStart(callId: string, tool: string): void { this.toolStarts.push({ callId, tool }); }
  toolUpdate(): void {}
  toolEnd(callId: string, ok: boolean, preview: string): void { this.toolEnds.push({ callId, ok, preview }); }
  async askApproval(tool: string): Promise<ApprovalAnswer> { this.approvals.push(tool); return this.answer; }
  async pickOne(_i: PickItem[]): Promise<null> { return null; }
  async askQuestion(_q: QuestionPrompt): Promise<null> { return null; }
  clearTranscript(): void {}
  prefillEditor(): void {}
  setBusy(b: boolean, label?: string): void { this.busy.push({ b, ...(label !== undefined ? { label } : {}) }); }
  setStatus(_i: StatusInfo): void {}
}

/** a ShellCtx over a recording registry: the point is WHICH door the command goes through */
function rig(o: { output?: ToolOutput; emit?: (e: (ev: RunEvent) => void) => void; busy?: boolean } = {}) {
  const renderer = new FakeRenderer();
  const appended: Message[] = [];
  const dispatched: { tool: string; args: unknown; rules: unknown; hasApproval: boolean }[] = [];
  const store = {
    id: "s1", staged: [] as readonly unknown[],
    get stagedAttachments() { return this.staged; },
    stageAttachments(p: readonly unknown[]) { this.staged = p; },
    messages: () => appended,
    append: (m: Message) => { appended.push(m); },
  };
  let busy = o.busy ?? false;
  const ctx: ShellCtx = {
    renderer,
    rt: {
      cwd: "C:/repo", hooks: undefined as never,
      buildCfg: ((level: unknown, approval: unknown) => ({ permissionRules: [`rules-for-${String(level)}`], approval })) as never,
      registry: {
        dispatch: async (call: { tool: string; args: unknown; id: string }, _c: unknown, _h: unknown, rules: unknown, approval: unknown, emit: (e: RunEvent) => void) => {
          dispatched.push({ tool: call.tool, args: call.args, rules, hasApproval: approval !== undefined });
          if (o.emit) o.emit(emit);
          else {
            emit({ type: "tool_execution_start", callId: call.id, tool: "bash", args: call.args } as RunEvent);
            emit({ type: "tool_execution_end", callId: call.id, ok: true, output: "exit=0\nok", durationMs: 5 } as RunEvent);
          }
          return o.output ?? { ok: true, output: "exit=0\nok" };
        },
      } as never,
    },
    store: () => store as never,
    level: () => "ask",
    approve: () => (async () => "once") as never,
    busy: () => busy,
    setBusy: (b) => { busy = b; },
    bindAbort: () => {},
  };
  return { ctx, renderer, appended, dispatched, store };
}

describe("the door a `!cmd` goes through", () => {
  test("it is the bash TOOL through ToolRegistry.dispatch, with the session's rules and the surface's approver — not a spawn", async () => {
    const r = rig();
    await runShellLine(r.ctx, "!bun test");
    expect(r.dispatched.length).toBe(1);
    expect(r.dispatched[0]).toMatchObject({ tool: "bash", args: { command: "bun test" }, hasApproval: true });
    expect(r.dispatched[0]!.rules).toEqual(["rules-for-ask"]);     // MUTATION: a private rule set / no rules → the command escapes the ladder
    expect(r.renderer.users).toEqual(["!bun test"]);
    expect(r.renderer.toolStarts[0]!.tool).toBe("bash");
    expect(r.appended.length).toBe(1);                              // the record the model reads next turn
    expect(parseShellRecord((r.appended[0]!.parts[0] as { text: string }).text)).toMatchObject({ cmd: "bun test", exit: "0" });
  });

  test("under `auto` the approver is absent — nothing is asked, and the level still reaches buildCfg", async () => {
    const r = rig();
    r.ctx.level = () => "auto";
    r.ctx.approve = () => undefined;
    await runShellLine(r.ctx, "!ls");
    expect(r.dispatched[0]).toMatchObject({ rules: ["rules-for-auto"], hasApproval: false });
  });

  test("a call refused BEFORE execution records NOTHING and says why — the model must not learn about a command that never ran", async () => {
    const r = rig({
      output: { ok: false, output: "" },
      emit: (emit) => emit({ type: "tool_call_failed", callId: "c1", reason: "permission_denied", detail: "user denied" } as RunEvent),
    });
    await runShellLine(r.ctx, "!rm -rf /");
    expect(r.appended).toEqual([]);                                 // MUTATION: record anyway → the model sees a command that was blocked
    const warn = r.renderer.notes.find((n) => n.tone === "warn")!;
    expect(warn.text).toContain("nothing ran, nothing recorded");
    expect(warn.text).toContain("refused before any approval prompt");
    // and the card the surfaces paint says the policy stopped it, not the person
    expect(r.renderer.toolEnds[0]!.preview).toContain(REFUSED_DETAIL);
  });

  test("a busy app refuses the line outright: no dispatch, no record — a shell record mid-run would fork the run's chain", async () => {
    const r = rig({ busy: true });
    await runShellLine(r.ctx, "!bun test");
    expect(r.dispatched).toEqual([]);
    expect(r.appended).toEqual([]);
    expect(r.renderer.notes[0]!.text).toContain("runs only while the agent is idle");
    expect(r.renderer.users).toEqual([]);
  });

  test("staged /attach images do not ride on a shell record — they wait for the next typed message", async () => {
    const r = rig();
    r.store.stageAttachments(["img"]);
    await runShellLine(r.ctx, "!ls");
    expect(r.store.stagedAttachments).toEqual(["img"]);             // still staged after the command
    expect(r.appended[0]!.parts.length).toBe(1);                    // the record is text only
  });

  test("a line that is not a shell line does nothing at all", async () => {
    const r = rig();
    await runShellLine(r.ctx, "please run the tests");
    expect([r.dispatched, r.appended, r.renderer.users]).toEqual([[], [], []]);
  });
});
