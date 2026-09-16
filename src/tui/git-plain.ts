/** `/commit` and `/undo` for `rovecode --plain` (port #65): the readline REPL has no Renderer, so this adapter maps
 *  the handful of Renderer calls git-cmds.ts makes onto console lines and the REPL's own y/n question — the SAME
 *  cmdCommit / cmdUndo run (one implementation, ADR-002), the same bash-tool dispatch and approval chain. A denied
 *  card cannot prefill a readline prompt, so the draft is printed for copy-and-resubmit instead. */

import type { Runtime } from "../cli/runtime.ts";
import { cmdCommit, cmdUndo, type GitCmdCtx } from "./git-cmds.ts";
import type { ApprovalAnswer, AssistantView, Renderer, RendererHooks, StatusInfo } from "./renderer.ts";
import type { ApprovalFn } from "../core/types.ts";

export interface PlainGitDeps {
  rt: GitCmdCtx["rt"] & Pick<Runtime, "store">;
  /** the REPL's own approver (its y/n asker) — what a card would have asked, asked on the line */
  approve: ApprovalFn | undefined;
  yolo: boolean;
  /** the REPL's readline question (answers arrive trimmed + lowercased) */
  ask(question: string): Promise<string>;
  /** console.log by default; tests capture */
  out?: (line: string) => void;
  /** Share the REPL's busy/interrupt state with shell and model turns. */
  busy?: () => boolean;
  bindAbort?: (ac: AbortController | null) => void;
}

/** the console Renderer: notes, tool card lines, the approval question; everything else inert */
export function plainRenderer(ask: PlainGitDeps["ask"], out: (line: string) => void): Renderer {
  const oneLine = (s: string): string => s.replace(/\n/g, " ⏎ ");
  return {
    start(_h: RendererHooks): void {}, stop(): void {}, setCommands(): void {},
    addUser(text: string): void { out(text); },
    addSystemNote(text: string, tone: "info" | "warn" | "error" = "info"): void { out(`  ${tone === "info" ? "" : `${tone}: `}${text}`); },
    beginAssistant(): AssistantView { return { append() {}, done() {} }; },
    toolStart(_id: string, tool: string, args: string): void { out(`\n  → ${tool} ${args}`); },
    toolUpdate(): void {},
    toolEnd(_id: string, ok: boolean, preview: string): void { out(`  ← ${ok ? "ok" : "FAIL"} ${oneLine(preview)}`); },
    async askApproval(tool: string, argsPreview: string, detail?: string): Promise<ApprovalAnswer> {
      out(`\n  approval needed: ${tool} ${argsPreview}`);
      if (detail) for (const l of detail.split("\n")) out(`    ${l}`);
      const a = await ask("  allow? [y]es / [n]o: ");
      return a === "y" || a === "yes" ? "once" : "deny";
    },
    async askQuestion(): Promise<null> { return null; },
    async pickOne(): Promise<null> { return null; },
    clearTranscript(): void {},
    prefillEditor(text: string): void { out(`  resubmit with: ${oneLine(text)}`); }, // no editor to prefill in --plain
    setBusy(_b: boolean, _label?: string): void {},
    setStatus(_i: StatusInfo): void {},
  };
}

/** `/commit [message]` or `/undo` typed at the `--plain` prompt (the REPL gates a busy run before calling this) */
export async function runPlainGitCommand(deps: PlainGitDeps, text: string): Promise<void> {
  const renderer = plainRenderer(deps.ask, deps.out ?? console.log);
  const ctx: GitCmdCtx = { renderer, rt: deps.rt, store: () => deps.rt.store, approve: () => deps.approve, yolo: () => deps.yolo, busy: deps.busy ?? (() => false), setBusy(): void {}, bindAbort: deps.bindAbort ?? (() => {}) };
  const line = text.trim();
  if (line === "/undo") await cmdUndo(ctx);
  else if (line === "/commit" || line.startsWith("/commit ")) await cmdCommit(ctx, line.slice("/commit".length));
}
