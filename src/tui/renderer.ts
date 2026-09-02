/** The Renderer seam (BLUEPRINT port #1): the TUI app talks only to this interface.
 *  PiTuiRenderer is today's implementation; OpenTUI or others can slot in later
 *  without touching the app/loop. House code outside src/tui must not import vendor. */

import type { QuestionAnswer, QuestionPrompt } from "../tools/ask-user.ts";
import type { RunEvent } from "../core/types.ts";
import type { SextantAttach } from "../sextant/types.ts";

export type { QuestionAnswer, QuestionPrompt, SextantAttach };

export type ApprovalAnswer = "once" | "always" | "deny";

export interface StatusInfo {
  provider: string;
  model: string;
  yolo: boolean;
  turns: number;
  tokensIn: number;
  tokensOut: number;
  /** port #20: plan/act mode indicator (optional — plain surfaces omit it) */
  mode?: "plan" | "act";
  /** port #32: "todos done/total" for the status bar; omitted when the session has no list */
  todos?: string;
}

export interface RendererHooks {
  /** user submitted a line from the editor (already trimmed, non-empty) */
  onSubmit: (text: string) => void;
  /** user asked to interrupt the in-flight run (Escape on the loader) */
  onInterrupt: () => void;
  /** user asked to leave (Ctrl+C) */
  onExit: () => void;
}

/** A streaming assistant message in the transcript. */
export interface AssistantView {
  append(delta: string): void;
  /** finalize; no more appends */
  done(): void;
}

export interface SlashCommand { name: string; description: string }

export interface PickItem { value: string; label: string; description?: string }

export interface Renderer {
  start(hooks: RendererHooks): void;
  stop(): void;
  /** slash commands offered by editor autocomplete; call before start() */
  setCommands(cmds: SlashCommand[]): void;
  addUser(text: string): void;
  addSystemNote(text: string, tone?: "info" | "warn" | "error"): void;
  beginAssistant(): AssistantView;
  toolStart(callId: string, tool: string, argsPreview: string): void;
  toolUpdate(callId: string, note: string): void;
  toolEnd(callId: string, ok: boolean, outputPreview: string, durationMs: number): void;
  /** modal approval; resolves deny on cancel/escape. `detail` (port #24): pre-rendered
   *  unified diff of a pending edit/write, shown inside the overlay above the verdicts */
  askApproval(tool: string, argsPreview: string, detail?: string): Promise<ApprovalAnswer>;
  /** modal picker (session/turn navigators); resolves null on cancel/escape/stop */
  pickOne(items: PickItem[], title?: string): Promise<string | null>;
  /** modal question for the ask_user tool (port #33): options + a free-text entry when allowed.
   *  Resolves the pick/typed text; null when the user declines, `signal` aborts (the run's
   *  controller — the card must dismiss, never leak), or the UI stops. Implementations may
   *  reject a SECOND concurrent ask with a clear error (the tool turns it into a failed result). */
  askQuestion(q: QuestionPrompt, signal?: AbortSignal): Promise<QuestionAnswer | null>;
  /** remove all transcript items (history replay after rewind/resume) */
  clearTranscript(): void;
  /** place text in the editor for edit-and-resubmit (pi sessions.md:106-116) */
  prefillEditor(text: string): void;
  setBusy(busy: boolean, label?: string): void;
  setStatus(info: StatusInfo): void;
  /** port #44 (OPTIONAL — FakeRenderer/PiTuiRenderer omit it): every RunEvent of the live run, delivered
   *  as the FIRST statement of the app's event loop, BEFORE the toolStart/beginAssistant/addSystemNote
   *  calls the same event triggers. A renderer that implements it (sextant) treats the event stream as
   *  its source of truth for transcript rows and ignores the duplicate per-event calls while busy. */
  onEvent?(ev: RunEvent): void;
  /** port #44 (OPTIONAL): the runtime handles the sextant panels read — cwd, sessions dir, the ACTIVE
   *  store, tasks, model + context window, usage math. Called exactly once by runTui, after runtime
   *  construction and before start(). */
  attach?(ctx: SextantAttach): void;
}
