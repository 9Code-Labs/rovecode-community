/** Sextant surface (Wave 4, ports #40-#46) — the shared type contract every `src/sextant/*`
 *  module builds against. Ported from the user's own sextant v0.4.0 prototype (term.js cell
 *  buffer, app.js state `S`, layout(), themes); the mock scenario/fixture fields are gone and
 *  every panel is fed by real rovecode seams (RunEvent stream, SessionStore, TaskManager, todos.json,
 *  approval + ask_user seams, model catalog).
 *
 *  Rules for the whole directory (ADR-001/002/003 + the Bun test hazards):
 *  - structural interfaces (ScreenLike) so panels, input and the pet compile and test before the
 *    core renderer lands; only screen.ts implements ScreenLike for real;
 *  - pure modules (model, the draw modules, pet, layout, engine, frame) take `now` as a
 *    parameter — no Date.now(), no timers, no process access; the ONE interval lives in
 *    sextant-renderer.ts;
 *  - one cell per code point unless screen.ts measures otherwise; -1 means "unset" for colors;
 *  - this file is types + tiny constants only: no I/O, no imports beyond rovecode type modules. */

import type { RunEvent } from "../core/types.ts";
import type { TaskInfo } from "../core/tasks.ts";
import type { TodoItem } from "../tools/todo.ts";
import type { QuestionPrompt } from "../tools/ask-user.ts";

// ------------------------------------------------------------------ styling

/** attribute bits (term.js `A`) */
export const ATTR = { BOLD: 1, DIM: 2, ITALIC: 4, UNDERLINE: 8, INVERSE: 16, STRIKE: 32 } as const;

/** packed 0xRRGGBB colors; -1 = unset (inherit the cell's current value) */
export interface Style { fg: number; bg: number; a: number }
/** a text run: [string, style]; an undefined style means "unstyled" */
export type Seg = readonly [string, Style | undefined];

export interface Rect { x: number; y: number; w: number; h: number }

/** The cell-buffer surface every draw function paints on (term.js Screen, minus I/O).
 *  Coordinates are 0-based cells; writes outside the buffer are clipped, never thrown. */
export interface ScreenLike {
  readonly w: number;
  readonly h: number;
  /** write a string at (x,y); returns the x after the last cell written */
  put(x: number, y: number, str: string, st?: Style, maxW?: number): number;
  /** write segments clipped to maxW; returns the x after the last cell */
  text(x: number, y: number, segs: readonly Seg[], maxW?: number): number;
  /** clipped text with a trailing ellipsis when it does not fit */
  clip(x: number, y: number, str: string, st: Style | undefined, maxW: number): number;
  fill(x: number, y: number, w: number, h: number, ch: string, st?: Style): void;
  /** recolor a rectangle's background only */
  tint(x: number, y: number, w: number, h: number, bg: number): void;
  hline(x: number, y: number, w: number, st?: Style, ch?: string): void;
  vline(x: number, y: number, h: number, st?: Style, ch?: string): void;
  /** rounded box (╭╮╰╯); bgFill paints the interior first when given */
  box(x: number, y: number, w: number, h: number, st?: Style, bgFill?: number): void;
}

// ------------------------------------------------------------------ themes

export type ThemeName = "night" | "ember" | "contrast";
export const THEME_ORDER: readonly ThemeName[] = ["night", "ember", "contrast"];

/** buildTheme() output: the palette (app.js THEMES) plus derived mixes, all packed ints */
export interface Theme {
  name: ThemeName;
  label: string;
  bg: number; bg2: number; fg: number; fg2: number; muted: number; dim: number;
  rule: number; rule2: number; accent: number; accent2: number;
  ok: number; err: number; warn: number; info: number; str: number; ty: number;
  /** derived: mix(bg, accent, .12) / mix(bg, ok, .15) / mix(bg, err, .15) / mix(bg, fg, .08) */
  hlBg: number; addBg: number; delBg: number; selBg: number;
  /** derived: mix(bg, accent, .45) / mix(bg, ok, .55) / mix(bg, fg2, .55) */
  accentDim: number; okDim: number; mixDim: number;
  /** derived frame colors: mix(bg, fg, .28) and .17 */
  frame: number; frameDim: number;
}

// ------------------------------------------------------------------ input

export interface KeyEvent {
  type: "key";
  /** "up" "down" "left" "right" "home" "end" "pageup" "pagedown" "insert" "delete" "enter" "tab"
   *  "shift-tab" "backspace" "escape" "space" "f1".."f12", a single character, or "unknown".
   *  "space" is Ctrl+Space (the NUL byte) ONLY — the space bar arrives as the character " " with
   *  `ch: " "` (input.ts CTRL_NAMES); consumers that insert text must accept both. */
  name: string;
  /** the printable character for plain keys (and the letter for alt+letter) */
  ch?: string;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
}
/** SGR mouse report: b = button bits (0 left, 1 middle, 2 right, 32 = motion/drag, 64/65 = wheel
 *  up/down), 0-based cell coordinates, press = "M" (press/motion) vs release "m" */
export interface MouseEvent { type: "mouse"; b: number; x: number; y: number; press: boolean }
/** bracketed paste (CSI 200~ … 201~) delivered as ONE event so multi-line pastes never submit */
export interface PasteEvent { type: "paste"; text: string }
export type InputEvent = KeyEvent | MouseEvent | PasteEvent;

/** a click zone a drawer registered while painting the current frame (drawSuggest / drawPalette /
 *  drawHelp / the pet panel); keys.ts walks the list in REVERSE so the last registered zone under
 *  the pointer wins (overlays sit above panels) */
export interface HitZone {
  rect: Rect;
  onClick: () => void;
  /** a key replayed through handleInput after onClick (e.g. Enter to run the row just selected) */
  key?: KeyEvent;
  /** a zone that can be GRABBED: a click inside it makes it the active drag target and every following
   *  left-button drag event (until the release) calls this with the pointer's row and the rows moved
   *  since the press — the scrollbar thumbs use `dy` to slide proportionally, so the thumb stays under
   *  the finger wherever it was grabbed. The closure captures the frame's geometry at grab time. */
  onDrag?: (y: number, dy: number) => void;
}

/** The terminal the renderer drives (#44): the ONE place raw stdin/stdout live. tui/sextant-io.ts
 *  implements it over the process streams (+ the Windows VT-input helper); tests and the smoke use
 *  an in-memory double. `env` is the process environment the renderer reads ROVECODE_PET/ROVECODE_THEME from. */
export interface TerminalIO {
  write(s: string): void;
  /** raw input chunks (utf8); returns the unsubscribe */
  onInput(cb: (chunk: string) => void): () => void;
  onResize(cb: (cols: number, rows: number) => void): () => void;
  size(): { cols: number; rows: number };
  enterRaw(): void;
  leaveRaw(): void;
  env: Readonly<Record<string, string | undefined>>;
}

// ------------------------------------------------------------------ layout

/** layout(w, h, opts) → panel rectangles. Breakpoints (app.js layout()): files column at
 *  w ≥ 140 (30 wide at ≥150, else 26); right column (plan + usage) at w ≥ 110 (34 / 28);
 *  messages = max(8, round(contentH · 0.34)) rows; usage 5 rows; pet 14 rows when contentH ≥ 36
 *  (under files when present, else under plan); null = hidden at this size. */
export interface Layout {
  w: number;
  h: number;
  /** outer frame (title in the top border, key hints in the bottom border) */
  frame: Rect;
  files: Rect | null;
  code: Rect;
  messages: Rect;
  plan: Rect | null;
  usage: Rect | null;
  pet: Rect | null;
}
export interface LayoutOptions { pet: boolean }

// ------------------------------------------------------------------ model (state)

/** git porcelain classes shown next to a file: M modified · A added/untracked · D deleted */
export type FileStatus = "M" | "A" | "D";

/** one row of the flattened tree (drawFiles consumes rows, not the tree) */
export interface TreeRow {
  /** cwd-relative posix path ("src/auth/callback.ts" or "src/auth" for a dir) */
  path: string;
  name: string;
  depth: number;
  dir: boolean;
  expanded?: boolean;
  status?: FileStatus;
  /** a collapsed dir containing changed files shows "·" */
  hasChanges?: boolean;
  /** the agent touched this file (read/edit/write) — diamond spinner until this clock */
  touchedUntil?: number;
}

export interface FilesState {
  /** all cwd-relative posix file paths (gitListFiles, or a bounded walk when git is absent) */
  paths: string[];
  statuses: Map<string, FileStatus>;
  expanded: Set<string>;
  touched: Map<string, number>;
  cursor: number;
  scroll: number;
  /** bumped at every mutation of paths/statuses/expanded/touched so treeRows can cache by (version, now) */
  version: number;
}

export interface RepoInfo { name: string; branch: string | null; modified: number }

/** activity shown in the frame header (with the run timer) and driving the pet's mood */
export type ActivityState =
  | "IDLE" | "THINKING" | "WRITING" | "READING" | "EDITING" | "RUNNING" | "TESTING"
  | "WAITING" | "DELEGATING" | "SUCCESS" | "ERROR";

export interface ActivityInfo {
  state: ActivityState;
  /** e.g. "editing callback.ts", "running tests", "waiting for you" */
  label: string;
  runId: string | null;
  startedAt: number | null;
  endedAt: number | null;
  /** clock of the transition into ERROR (the pet's storm trigger); absent until the first error */
  errorAt?: number;
  /** the provider turn in flight: when the loop called the model (turn_start) — absent once a tool
   *  runs, the turn ends or the run ends, so the live line only paints while the model itself is busy */
  turnAt?: number;
  /** estimated output tokens streamed so far in that turn — reasoning plus answer text */
  tokens?: number;
}

export type CodeMode = "code" | "diff" | "run" | "agents" | "search";

export interface DiffHunk {
  /** rendered rows: prefix " " | "+" | "-" plus the line text */
  rows: { op: " " | "+" | "-"; text: string }[];
  oldStart: number;
  newStart: number;
}

export interface CodeState {
  mode: CodeMode;
  /** file shown in code/diff mode (cwd-relative) */
  file: string | null;
  /** current file contents (disk) or null when unreadable */
  content: string | null;
  /** [fromLine, toLine] 1-based highlight (the anchor range of the last edit / read) */
  hl: [number, number] | null;
  scroll: number;
  /** last glob/grep result lines */
  search: { query: string; lines: string[] } | null;
  /** last bash call: command, output lines (10k-char tool bound applies), verdict, and the exit
   *  code from the tool's `exit=N` header once the call ended (absent while running / unparsable) */
  run: { cmd: string; lines: string[]; status: "running" | "ok" | "fail"; exitCode?: number } | null;
  /** pre-approval preview or post-edit hunks; `base: "head"` marks a HEAD-vs-disk view (no pre-edit
   *  content — the /diff command, or an ungated edit whose base could not be rebuilt): cumulative
   *  over every uncommitted change, so the title says `vs HEAD` and the row keeps its own counts */
  diff: { file: string; hunks: DiffHunk[]; add: number; del: number; base?: "head" } | null;
  /** agents board selection */
  lane: number;
  laneOpen: boolean;
}

/** compact tool row in the messages panel: `· read x` `~ edit x +a −b` `+ write x` `− remove x`
 *  `$ run cmd … last line` — verb/glyph derived from the tool name */
export interface ToolRow {
  kind: "tool";
  callId: string;
  tool: string;
  /** "read" | "edit" | "write" | "remove" | "run" | "search" | "fetch" | "task" | "other" */
  verb: string;
  /** what the row names: basename, command head, url host… */
  label: string;
  /** cwd-relative posix path for file tools (read/edit/write/remove) — the code panel target */
  path?: string;
  running: boolean;
  ok?: boolean;
  /** trailing summary: "18 passed", "+21 −4", "N lines", first output line… */
  detail?: string;
  add?: number;
  del?: number;
  ms?: number;
}

export type MessageRow =
  /** `at` = the clock the line was sent (renderer addUser); the `· sent` tag fades 1.4 s after it */
  | { kind: "user"; text: string; /** image chips `[image: name]` */ images?: string[];
      /** `@file` chips — "src/x.ts · 120 lines": the attached read blocks are in the session, never in the panel (mentions.ts) */
      files?: string[]; at?: number }
  /** `id` = the RunEvent messageId the streaming row belongs to (absent on replayed/summary rows) */
  | { kind: "assistant"; text: string; streaming: boolean; id?: string }
  | ToolRow
  | { kind: "system"; text: string; tone: "info" | "warn" | "error" }
  /** a steering note that reached the run (task completion, reflection nudge) */
  | { kind: "steer"; text: string }
  | { kind: "compaction"; text: string };

/** the modal card rendered inside the messages panel (ONE at a time) */
export type CardState =
  | {
      kind: "approval";
      tool: string;
      argsPreview: string;
      /** port #24 unified diff preview when the tool is edit/write */
      detail?: string;
      /** the buttons this card offers, in order — an edit/write card carries the extra `all-edits`
       *  door, everything else keeps allow · always · deny */
      verdicts: readonly ("once" | "always" | "all-edits" | "deny")[];
      /** index into `verdicts` */
      selected: number;
      resolve: (answer: "once" | "always" | "all-edits" | "deny") => void;
    }
  | {
      kind: "question";
      prompt: QuestionPrompt;
      /** option index; options.length = the free-text row when allowed; +1 = "skip" */
      selected: number;
      freeText: string;
      resolve: (answer: { kind: "option"; index: number } | { kind: "text"; text: string } | null) => void;
    };

export interface UsageState {
  provider: string;
  model: string;
  /** the thinking dial as the runtime holds it ("auto" | "off" | "low" | …); painted in the footer tag
   *  next to the model so the person can see what the answer is costing them; unset = not reported */
  effort?: string;
  turns: number;
  tokensIn: number;
  tokensOut: number;
  /** 0..100 estimated context fill, null when the window is unknown */
  contextPct: number | null;
  /** the inputs behind contextPct when known: estimated tokens in the prompt + the model's window */
  contextTokens?: number;
  contextWindow?: number;
  /** null = unpriced */
  costUsd: number | null;
}

export interface PlanState {
  todos: TodoItem[];
  /** loader note (corrupt todos.json) */
  note?: string;
}

export interface InputState {
  text: string;
  cur: number;
  history: string[];
  histIdx: number;
  /** selected row in the suggestion box; -1 = the box was dismissed with Esc and stays hidden until
   *  the text changes (keys.ts resets it to 0 on every edit) */
  sgSel: number;
}

export type Focus = "messages" | "code" | "files";

/** Which panel occupies the MAIN slot when the terminal is too narrow to show them side by side
 *  (layout.ts hides files under 140 columns and the plan column under 110). The tab strip on the main
 *  panel's border pages between them; on a wide terminal every panel is on screen and `page` is inert. */
export type Page = "code" | "files" | "plan";
export const PAGES: readonly Page[] = ["code", "files", "plan"];

export interface Toast { text: string; until: number; tone: "info" | "warn" | "error" }

/** A notification worth keeping after its toast fades: a run finishing, a failed tool, a card
 *  waiting for the human. Toasts are the transient surface (three seconds, top right); notices are
 *  the record behind them, so what you missed while looking away can be read back (⌃b / /notices). */
export interface Notice {
  id: number;
  /** clock when it happened */
  at: number;
  tone: Toast["tone"];
  kind: "done" | "error" | "approval" | "info";
  text: string;
  /** cleared when the history is opened */
  read: boolean;
}
/** the history keeps this many; older notices fall off the front */
export const MAX_NOTICES = 50;

export interface PaletteState {
  query: string;
  sel: number;
  /** flat items: label + what pressing enter does (a slash line, a renderer-local action, or
   *  `pick:<value>` for a Renderer.pickOne picker); `hint` overrides the derived right-hand hint */
  items: { label: string; group: string; action: string; hint?: string }[];
  /** what this palette IS, shown on the box: the command palette says nothing and keeps its default,
   *  a Renderer.pickOne picker names what is being picked. Painted clipped — a caller's sentence is
   *  not a layout contract. */
  title?: string;
}

import type { MarketState } from "./draw-market.ts";
import type { ContextState } from "./draw-context.ts";
import type { LiveRuntime } from "./context-source.ts";

/** the whole surface state — owned by model.ts (pure `applyEvent`) and mutated by keys.ts */
export interface SextantState {
  cwd: string;
  repo: RepoInfo;
  files: FilesState;
  activity: ActivityInfo;
  code: CodeState;
  messages: MessageRow[];
  /** messages scroll offset; stick = follow the tail */
  msgScroll: number;
  stick: boolean;
  card: CardState | null;
  plan: PlanState;
  crew: TaskInfo[];
  usage: UsageState;
  input: InputState;
  focus: Focus;
  /** the panel in the main slot on a narrow terminal (see Page); "code" on a wide one */
  page: Page;
  palette: PaletteState | null;
  /** the market overlay (/market, ⌃m); null when it is closed — see draw-market.ts */
  market: MarketState | null;
  /** the context overlay (/context); null when it is closed — see draw-context.ts */
  context: ContextState | null;
  /** the connect wizard (/connect, /setup); null when it is closed — see draw-wizard.ts */
  wizard: import("./draw-wizard.ts").WizardState | null;
  help: boolean;
  toasts: Toast[];
  /** the notification history behind the toasts (Notice); newest last */
  notices: Notice[];
  /** images staged for the next user message (names), shown as chips above the prompt; synced from
   *  SextantAttach.staged() each tick — the store owns the stage, this is the painted mirror */
  staged: string[];
  /** first Esc while busy arms "again to stop" until this clock */
  escUntil: number;
  /** two-press ⌃c guarantee (renderer-level): a ⌃c while busy interrupts and arms this clock; a
   *  second ⌃c before it quits even if the interrupted run has not settled yet */
  ctrlCUntil?: number;
  running: boolean;
  mode: "plan" | "act";
  yolo: boolean;
  /** the middle permission tier — painted next to plan/auto in the frame footer */
  acceptEdits?: boolean;
  theme: ThemeName;
  /** boot clock for the staggered panel reveal (90 ms steps) */
  bootAt: number;
  /** slash commands known to the prompt/palette (built-ins + custom) */
  /** the app's slash commands for the palette and the suggestions; `choices` = a fixed argument set
   *  offered once the command is typed (tui/renderer.ts SlashCommand.choices) */
  commands: { name: string; description: string; choices?: readonly string[] | (() => readonly string[]); choicesThen?: "submit" | "complete" }[];
  version: string;
}

// ------------------------------------------------------------------ seams

/** what the renderer receives from the ONE controller (app.ts runTui) beyond the Renderer
 *  interface: raw RunEvents (paths, diffs, outputs) and the runtime handles the panels read */
export interface SextantAttach {
  cwd: string;
  sessionsDir: string;
  /** the ACTIVE session store (changes on /sessions /resume /new) */
  store(): { id: string };
  tasks: { list(): TaskInfo[]; subscribe(fn: (t: TaskInfo) => void): () => void };
  model(): { provider: string; model: string };
  /** context window for the usage bar; undefined when the catalog does not know the model */
  contextWindow(): number | undefined;
  /** session accounting for the usage panel (tui/cost.ts math over the ACTIVE store): cost priced
   *  per message at its origin model (null = unpriced), context = estimated prompt tokens */
  usage?(): { costUsd: number | null; contextTokens: number };
  /** Everything /context needs and no other panel does: the transcript to count, the catalog to look a
   *  model's window and pricing up in, and the LIVE runtime.
   *
   *  The runtime is the point. `rovecode context` on a shell has to BUILD one to learn the system prompt
   *  and the tool schemas, and in a fresh session those two are most of the window; here they already
   *  exist. Optional all the same — a surface that cannot supply this (a headless dump, a test) still
   *  opens the panel, and the panel says its total is a floor rather than under-reporting in silence. */
  contextInputs?(): {
    messages: readonly unknown[];
    lookup: (r: { provider: string; model: string }) => unknown;
    runtime: LiveRuntime | null;
  };
  /** Re-read the MCP files and connect anything new, in this session. The market overlay calls it after
   *  installing an MCP server so the answer is "connected" rather than "restart rovecode" — the tools
   *  that reach a server (`mcp_list`, `mcp_call`) dispatch by name, so nothing else has to change.
   *  Absent when the surface has no runtime behind it (the smoke harness, the tests). */
  reloadMcp?(): Promise<{ added: string[]; removed: string[]; failed: { name: string; error: string }[]; skipped: string[] }>;
  /** `--pet <name>`; the renderer's own option is the fallback */
  petName?: string;
  /** names of the images staged for the NEXT user message (tui/attach.ts stage on the active store),
   *  read live each tick so the prompt can show them as chips before they are sent */
  staged?(): string[];
  /** port #54: stage one @image mention for the next message — the SAME stage /attach writes, so the
   *  caps and the chip row stay that seam's. Absent in surfaces without a store behind them. */
  attachImage?(abs: string): void;
  /** the connect wizard (draw-wizard.ts): the provider rows step 1 lists (SETUP_PICKS + what the
   *  registry already knows; a row may be a "your own URL" door that registers itself when chosen).
   *  Absent in surfaces without a runtime — the wizard cannot open there. */
  wizardProviders?(): { key: string; label: string; configured?: boolean; local?: boolean; url?: "openai" | "anthropic" }[];
  /** register a url door's endpoint (providers/registry add, the user file) — the row the walk then keys */
  wizardRegister?(id: string, url: string, protocol: "openai" | "anthropic"): { ok: boolean; error?: string };
  /** store a pasted key (credentials file via auth.ts, never the transcript) and refresh the registry */
  wizardStoreKey?(provider: string, secret: string): { ok: boolean; error?: string };
  /** the models the registry can name for a provider — /models' own source, reused here */
  wizardModels?(provider: string): Promise<{ id: string; note?: string }[]>;
  /** the model step's activate answer: pin the checked rows as the provider's active list
   *  (registry setModels — spec.models), empty = un-pin; makeDefault also becomes the default */
  wizardActivateModels?(provider: string, models: readonly string[], makeDefault?: string): { ok: boolean; error?: string; models?: string[] };
  /** the one test call + make-default (registry probe + setDefault, /setup's finish) */
  wizardTest?(provider: string, model: string): Promise<{ ok: boolean; detail: string }>;
}

/** pure reducer contract (model.ts): (state, event, now) → same state object, mutated in place */
export type ApplyEvent = (s: SextantState, ev: RunEvent, now: number) => void;

/** what a headless dump may inject (frame.ts FrameDeps is the concrete shape): the layout function,
 *  per-panel painters and the layout options */
export type PanelPainter = (scr: ScreenLike, rect: Rect, s: SextantState, theme: Theme, now: number) => void;
export interface DumpFrameDeps {
  layout?: (w: number, h: number, opts: LayoutOptions) => Layout;
  painters?: Partial<Record<"frame" | "files" | "code" | "messages" | "plan" | "usage" | "pet", PanelPainter>>;
  layoutOpts?: LayoutOptions;
}
/** headless frame dump (frame.ts): deterministic at a fixed clock — the golden-test seam */
export type DumpFrame = (s: SextantState, cols: number, rows: number, now: number, theme: Theme, deps?: DumpFrameDeps) => string;

export const SEXTANT_MIN_COLS = 100;
export const SEXTANT_MIN_ROWS = 30;
/** the four spinner glyphs (SPIN in app.js) */
export const SPIN: readonly string[] = ["◇", "◈", "◆", "◈"];
