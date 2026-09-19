/** The Renderer seam (BLUEPRINT port #1): the TUI app talks only to this interface.
 *  PiTuiRenderer is today's implementation; OpenTUI or others can slot in later
 *  without touching the app/loop. House code outside src/tui must not import vendor. */

import type { QuestionAnswer, QuestionPrompt } from "../tools/ask-user.ts";
import type { PermissionLevel, ThinkingEffort, RunEvent } from "../core/types.ts";
import type { SextantAttach } from "../sextant/types.ts";

export type { QuestionAnswer, QuestionPrompt, SextantAttach };

/** `all-edits` is offered only on an edit/write card: it answers THIS call and asks the surface to
 *  drop to accept-edits for the rest of the session (writes inside the workspace stop prompting). */
export type ApprovalAnswer = "once" | "always" | "all-edits" | "deny";

export interface StatusInfo {
  provider: string;
  model: string;
  yolo: boolean;
  /** the full permission tier; `yolo` stays for the surfaces that only know two. Optional so a
   *  renderer that does not paint it needs no change. */
  permission?: PermissionLevel;
  /** the thinking dial, painted next to the model when it is on */
  effort?: ThinkingEffort;
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
  /** port #60 (OPTIONAL): replace the view's content — the reasoning card uses it because a reasoning_update
   *  carries the cumulative TOKEN count, not deltas, so the card repaints one line per event. A view without
   *  it (plain transcript appends) is left alone; ReasoningViews skips the update instead of appending counts. */
  set?(content: string): void;
}

export interface SlashCommand {
  name: string;
  description: string;
  /** /help topic the command is listed under (info-cmd.ts); the palette ignores it */
  group?: string;
  /** the argument values (`/effort` levels; `/model` ids): the sextant lists them as suggestions once
   *  the command is typed and completes the one picked. A function is read at suggestion time, for a
   *  set that changes while the TUI runs (the models of the providers that have a key). */
  choices?: readonly string[] | (() => readonly string[]);
  /** what Enter does on a picked choice: "submit" (default — `/effort high` runs) or "complete" — the
   *  choice is a subcommand that wants more words (`/mcp add ` waits for a name) */
  choicesThen?: "submit" | "complete";
}

export interface PickItem { value: string; label: string; description?: string }

export interface RendererStartOptions {
  /** false after a loading intro: reveal the complete layout, not a second panel animation. */
  animate?: boolean;
  /** Called once the scene exists but before its first paint, to seed transcript and status. */
  beforeFirstRender?: () => void;
  /** Keep the prepared frame offscreen while the loading intro completes. Never reads stdin. */
  beforeReveal?: () => Promise<void>;
  /** Last handoff: the frame is laid out, immediately before terminal takeover/output. */
  onReveal?: () => void;
}

export interface Renderer {
  start(hooks: RendererHooks, options?: RendererStartOptions): void | Promise<void>;
  stop(): void;
  /** Put the terminal back and nothing else — no settling, no child processes, no async. `stop()` is the
   *  orderly shutdown and calls this as its last act; this is what the CRASH path calls, because there
   *  the only thing that still matters is that the person gets their shell back. Separated because
   *  `stop()` does work that can itself throw, and a throw before the restore is how a crash turns into
   *  "my terminal is broken": the alt screen never closes and mouse reporting keeps typing escape
   *  sequences at the prompt. Must be idempotent and must never throw. Optional: a renderer that never
   *  touched the terminal (the test fake) has nothing to restore. */
  restoreTerminal?(): void;
  /** slash commands offered by editor autocomplete; call before start() */
  setCommands(cmds: SlashCommand[]): void;
  addUser(text: string): void;
  addSystemNote(text: string, tone?: "info" | "warn" | "error"): void;
  beginAssistant(): AssistantView;
  /** port #60 (OPTIONAL): a collapsed reasoning block for the assistant message being streamed — its view
   *  settles on done(); surfaces render a SIZE (tokens), never the text. A renderer without it gets one
   *  system note per block from tui/reasoning-view.ts instead. */
  beginReasoning?(): AssistantView;
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
  /** OPTIONAL (sextant): /mouse — turn terminal mouse tracking off so the terminal's own drag
   *  selection works again (select + copy across panels), or back on for clicks/scrollbars. A
   *  renderer that never captures the mouse (classic, fakes) omits it and the command says so. */
  setMouse?(on: boolean): void;
}
