/** SextantRenderer (port #44): the sextant surface as aion's `Renderer` — the ONE controller stays
 *  runTui (ADR-003, no second loop); this class maps the Renderer seam plus the optional onEvent/attach
 *  members onto the SextantState (#41 model), paints through FrameLoop (#40 screen, #41-#46 painters)
 *  and routes keys through #43. Ported from the user's sextant v0.4.0 app.js:1599-1632 (boot: enter
 *  the alt screen, state, tick, input, resize, leave).
 *
 *  ONE source of truth for transcript rows while a run is busy: the RunEvent stream (onEvent →
 *  applyEvent). The per-event Renderer calls app.ts makes for the same events are therefore no-ops
 *  while busy (beginAssistant views, toolStart/toolUpdate/toolEnd) or dropped by exact count (the
 *  compaction / "↪ steering applied" / run_end notes — sextant-bridge duplicateNotes); every other
 *  note (boot, slash commands, task settlements, "queued as steering", router notes) is a row + toast.
 *  When NOT busy (history replay after /resume, /rewind, /new) the same methods build rows directly.
 *  Renderer-local slash commands (/theme /open /diff /focus /agents, the /help card) run in keys.ts
 *  runLocal through the `local` hooks below — src/sextant/local-commands.ts is their future home.
 *  I/O: the terminal through TerminalIO; git/fs through sextant-files, scheduled OFF the frame loop. */

import { basename, join } from "node:path";
import pkg from "../../package.json";
import type { RunEvent } from "../core/types.ts";
import { loadTodos } from "../tools/todo.ts";
import type { ApprovalAnswer, AssistantView, PickItem, QuestionAnswer, QuestionPrompt, Renderer, RendererHooks, SlashCommand, StatusInfo } from "../tui/renderer.ts";
import { drawAgents } from "./draw-agents.ts";
import { hunksFromUnified, setAgentsPainter } from "./draw-code.ts";
import { fuzzy } from "./engine.ts";
import type { GitRunner } from "./git-status.ts";
import { enterSequence, leaveSequence } from "./input.ts";
import { ESC_WINDOW_MS, type KeyCtx } from "./keys.ts";
import { initialState, makeApplyEvent, planCounts, pushToast, setCrew, setFiles, setPlan, setUsage } from "./model.ts";
import { suggestions } from "./overlays.ts";
import { createPet, type Pet } from "./pet.ts";
import { argsFromPreview, duplicateNotes, petOnEvent, petOnTask, replayToolRow, userRow, type LiveCall } from "./sextant-bridge.ts";
import { CardHost } from "./sextant-cards.ts";
import { fileDiff, headDiff, readFileBounded, scanRepo, statusOnly } from "./sextant-files.ts";
import { FrameLoop } from "./sextant-frame-loop.ts";
import { buildTheme, isThemeName } from "./theme.ts";
import { clipText, relPath, summarizeEnd } from "./tool-rows.ts";
import type { ApplyEvent, InputEvent, SextantAttach, SextantState, TerminalIO, Theme, ThemeName, ToolRow } from "./types.ts";

export interface SextantRendererOptions {
  io: TerminalIO;
  /** the frame clock (Date.now in production; tests inject a controllable one) */
  clock?: () => number;
  /** starting palette (AION_THEME / --theme); an unknown name falls back to night */
  theme?: string;
  /** the pet's name (`--pet <name>`); attach() may override it */
  pet?: string;
  /** emit truecolor SGR (default true; false quantizes to xterm-256) */
  truecolor?: boolean;
  /** the project dir until attach() supplies the runtime's cwd */
  cwd?: string;
  /** git seam for tests; undefined = spawn git */
  git?: GitRunner;
  /** false disables the repo scan entirely (pure tests) */
  scan?: boolean;
}

/** while idle, the porcelain statuses are re-read at most this often */
export const IDLE_SCAN_MS = 5000;
const TOAST_MAX = 48;
const NOOP_VIEW: AssistantView = { append() {}, done() {} };
const NO_HOOKS: RendererHooks = { onSubmit() {}, onInterrupt() {}, onExit() {} };

export class SextantRenderer implements Renderer {
  /** the surface state (keys.ts and the reducer mutate it; tests read it) */
  readonly state: SextantState;
  private theme: Theme;
  private readonly io: TerminalIO;
  private readonly clock: () => number;
  private readonly pet: Pet;
  private readonly loop: FrameLoop;
  private readonly git: GitRunner | undefined;
  private readonly applyEv: ApplyEvent;
  private hooks: RendererHooks | null = null;
  private ctx: SextantAttach | null = null;
  private unsubTasks: (() => void) | null = null;
  private started = false;
  private stopped = false;
  /** between setBusy(true) and setBusy(false): the event stream owns the rows */
  private busy = false;
  private dropNotes = 0;
  /** the approval / question / picker promises (sextant-cards.ts) */
  private readonly cards: CardHost;
  private readonly liveCalls = new Map<string, LiveCall>();
  /** per cwd-relative path: the content when its edit/write was APPROVED (null = did not exist) — the diff
   *  base outside git. Captured at askApproval, not at tool_execution_start: events reach the consumer
   *  through the loop's buffer, so a fast synchronous tool has often already written by then. */
  private readonly before = new Map<string, string | null>();
  /** deferred diff computations (setTimeout(0) from the end event), cleared on stop() */
  private readonly deferred = new Set<ReturnType<typeof setTimeout>>();
  private scanTimer: ReturnType<typeof setTimeout> | null = null;
  private scanWanted: "full" | "status" | null;
  private lastScanAt = -Infinity;
  private hasGit = false;
  /** the file whose content the code panel holds (null → reload on the next tick) */
  private loadedFile: string | null = null;
  private planLoaded = false;
  private todoDone = 0;

  constructor(o: SextantRendererOptions) {
    this.io = o.io; this.clock = o.clock ?? Date.now; this.git = o.git;
    this.scanWanted = (o.scan ?? true) ? "full" : null;
    const themeName: ThemeName = isThemeName(o.theme ?? "") ? (o.theme as ThemeName) : "night";
    this.theme = buildTheme(themeName);
    const cwd = o.cwd ?? process.cwd();
    this.state = initialState({ cwd, repo: { name: basename(cwd) || cwd, branch: null }, version: pkg.version, theme: themeName, mode: "act", yolo: false, commands: [], now: this.clock() });
    this.pet = createPet({ name: o.pet });
    // the reducer's diffFor seam stays empty: the hunks arrive through scheduleDiff (a setTimeout(0)
    // from the end event — git + fs never run inside the event dispatch or a painter)
    this.applyEv = makeApplyEvent();
    this.cards = new CardHost({
      state: this.state, dirty: () => this.loop.markDirty(), stopped: () => this.stopped,
      onApprovalOpen: () => this.pet.event("permission", undefined, this.clock()),
      onAllowed: () => this.pet.event("allowed", undefined, this.clock()),
    });
    setAgentsPainter(drawAgents); // #46: the crew board paints the ∷ mode
    this.loop = new FrameLoop({
      io: this.io, clock: this.clock, state: this.state, theme: () => this.theme, pet: this.pet, truecolor: o.truecolor ?? true,
      keyCtx: () => ({ hooks: this.hooks ?? NO_HOOKS, local: this.local }),
      beforeInput: (ev, now) => this.beforeInput(ev, now),
      afterInput: (ev, now) => this.afterInput(ev, now),
      onTick: (now) => this.onTick(now),
    });
  }

  // ------------------------------------------------------------------ test/smoke seams
  /** the last painted frame as text ("" before start) */
  frameText(): string { return this.loop.frameText(); }
  /** the frame interval is live */
  get active(): boolean { return this.loop.active; }
  /** frames painted so far (tests: "nothing paints after stop") */
  get frames(): number { return this.loop.frames; }
  get themeName(): ThemeName { return this.theme.name; }
  /** run one frame-loop tick now (tests: deterministic instead of waiting 40 ms) */
  tick(): void { this.loop.tick(); }
  /** parse input held by the ESC-hold timer now (tests) */
  flushInput(): void { this.loop.flushInput(); }

  // ------------------------------------------------------------------ lifecycle
  start(hooks: RendererHooks): void {
    if (this.started) return;
    this.started = true; this.hooks = hooks;
    this.io.enterRaw();
    this.io.write(enterSequence(true));
    this.state.bootAt = this.clock();
    this.loop.start();
  }

  /** clear the interval, settle every open card/picker (deny / null), restore the terminal */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.loop.stop();
    if (this.scanTimer) { clearTimeout(this.scanTimer); this.scanTimer = null; }
    for (const t of this.deferred) clearTimeout(t);
    this.deferred.clear();
    this.unsubTasks?.(); this.unsubTasks = null;
    this.cards.settleAll();
    if (this.started) { this.io.write(leaveSequence()); this.io.leaveRaw(); }
    this.hooks = null;
  }

  attach(ctx: SextantAttach): void {
    this.ctx = ctx;
    const s = this.state;
    s.cwd = ctx.cwd; s.repo.name = basename(ctx.cwd) || ctx.cwd;
    if (ctx.petName) this.pet.state.name = ctx.petName.slice(0, 14);
    this.unsubTasks?.();
    const sync = (): void => {
      const list = ctx.tasks.list();
      if (list.length > s.crew.length) s.code.lane = list.length - 1; // the newest lane is selected
      setCrew(s, list); this.loop.markDirty();
    };
    sync();
    this.unsubTasks = ctx.tasks.subscribe((t) => { sync(); petOnTask(this.pet, t, this.clock()); });
    if (this.scanWanted !== null || this.lastScanAt !== -Infinity) this.scanWanted = "full";
    this.refreshPlan();
  }

  // ------------------------------------------------------------------ the event stream (source of truth while busy)
  onEvent(ev: RunEvent): void {
    const now = this.clock(), s = this.state;
    this.applyEv(s, ev, now);
    petOnEvent(this.pet, ev, this.liveCalls, s.cwd, now);
    this.dropNotes += duplicateNotes(ev);
    if (ev.type === "tool_execution_end" || ev.type === "tool_call_failed") {
      const row = this.rowOf(ev.callId);
      const before = row?.path !== undefined ? this.before.get(row.path) : undefined;
      if (row?.path !== undefined) this.before.delete(row.path);
      if (row && (row.verb === "edit" || row.verb === "write" || row.verb === "remove" || row.verb === "run")) {
        if (this.scanWanted !== null || this.hasGit) this.scanWanted = "full";
        if (row.path !== undefined && row.path === s.code.file) s.code.content = null; // reload the edited file
        this.loadedFile = null;
        if (ev.type === "tool_execution_end" && ev.ok && row.path !== undefined && (row.verb === "edit" || row.verb === "write")) this.scheduleDiff(row, row.path, before);
      }
    }
    this.loop.markDirty();
  }

  /** the #41 diffFor seam, deferred: HEAD-vs-disk (or the captured pre-edit content) hunks for the file
   *  an edit/write just changed → the row's real +a −b, s.code.diff and the diff view (what the reducer
   *  would have applied synchronously) */
  private scheduleDiff(row: ToolRow, file: string, before: string | null | undefined): void {
    const t = setTimeout(() => {
      this.deferred.delete(t);
      if (this.stopped) return;
      const d = fileDiff(this.state.cwd, file, before, this.git);
      if (!d) return;
      row.add = d.add; row.del = d.del;
      this.state.code.diff = { file, ...d }; this.state.code.mode = "diff";
      this.loop.markDirty();
    }, 0);
    this.deferred.add(t);
  }

  /** pre-approval (the approver runs BEFORE the tool executes — the one real-time moment): capture the
   *  file's current content as the diff base, and let the card's previewDiff text fill the code panel's
   *  diff view for the pending file */
  private previewInCodePanel(tool: string, argsPreview: string, detail: string | undefined): void {
    if (tool !== "edit" && tool !== "write") return;
    const path = argsFromPreview(argsPreview).path;
    if (typeof path !== "string" || !path) return;
    const file = relPath(this.state.cwd, path);
    this.before.set(file, readFileBounded(this.state.cwd, file));
    const hunks = detail ? hunksFromUnified(detail) : [];
    if (!hunks.length) return;
    const rows = hunks.flatMap((h) => h.rows);
    this.state.code.diff = { file, hunks, add: rows.filter((r) => r.op === "+").length, del: rows.filter((r) => r.op === "-").length };
    this.state.code.mode = "diff";
  }

  // ------------------------------------------------------------------ Renderer → state
  setCommands(cmds: SlashCommand[]): void { this.state.commands = cmds.map((c) => ({ name: c.name, description: c.description })); this.loop.markDirty(); }

  addUser(text: string): void { this.push(userRow(text, this.clock())); }

  addSystemNote(text: string, tone: "info" | "warn" | "error" = "info"): void {
    if (this.dropNotes > 0) { this.dropNotes--; return; } // the reducer already made this row from the event
    this.push({ kind: "system", text, tone });
    // toasts: every warning/error, and one-line info notes; a multi-line info note (boot banner, /help,
    // /cost) is a transcript row only — a clipped first line would only smear the top of the code panel
    if (tone !== "info" || (!text.includes("\n") && text.length <= TOAST_MAX)) this.toast(text.split("\n")[0] ?? "", tone);
  }

  beginAssistant(): AssistantView {
    if (this.busy) return NOOP_VIEW; // message_update events stream the row
    const row: Extract<SextantState["messages"][number], { kind: "assistant" }> = { kind: "assistant", text: "", streaming: true };
    this.push(row);
    return { append: (delta) => { row.text += delta; this.loop.markDirty(); }, done: () => { row.streaming = false; this.loop.markDirty(); } };
  }

  toolStart(callId: string, tool: string, argsPreview: string): void {
    if (this.busy) return;
    this.push(replayToolRow(callId, tool, argsPreview, this.state.cwd));
  }
  toolUpdate(callId: string, note: string): void {
    if (this.busy) return;
    const row = this.rowOf(callId);
    if (row) { row.detail = clipText(note, 80); this.loop.markDirty(); }
  }
  toolEnd(callId: string, ok: boolean, outputPreview: string, durationMs: number): void {
    if (this.busy) return;
    let row = this.rowOf(callId);
    if (!row) { row = replayToolRow(callId, "tool", "{}", this.state.cwd); this.push(row); }
    row.running = false; row.ok = ok; row.ms = durationMs;
    const end = summarizeEnd({ verb: row.verb }, row.tool, ok, outputPreview);
    if (end.detail) row.detail = end.detail;
    this.loop.markDirty();
  }

  /** the approval card (sextant-cards.ts); an edit/write preview also fills the code panel's diff view */
  askApproval(tool: string, argsPreview: string, detail?: string): Promise<ApprovalAnswer> {
    this.previewInCodePanel(tool, argsPreview, detail);
    return this.cards.approval(tool, argsPreview, detail);
  }
  /** the palette as a picker (sextant-cards.ts) */
  pickOne(items: PickItem[], title?: string): Promise<string | null> { return this.cards.pick(items, title); }
  /** the question card (sextant-cards.ts): `signal` abort dismisses it, a second concurrent ask is rejected */
  askQuestion(q: QuestionPrompt, signal?: AbortSignal): Promise<QuestionAnswer | null> { return this.cards.question(q, signal); }

  clearTranscript(): void { this.state.messages = []; this.state.stick = true; this.pet.event("fresh", undefined, this.clock()); this.loop.markDirty(); }

  prefillEditor(text: string): void {
    const I = this.state.input;
    I.text = text; I.cur = text.length; I.sgSel = 0; I.histIdx = -1; this.state.focus = "messages"; this.loop.markDirty();
  }

  /** busy = a run is in flight: the event stream owns the rows. setBusy(false) after a run the
   *  reducer never saw end (an interrupted generator yields no run_end) settles what run_end would have. */
  setBusy(busy: boolean, label?: string): void {
    const s = this.state, now = this.clock();
    this.busy = busy;
    if (busy) { s.running = true; if (label) s.activity.label = label.replace(/…$/, ""); }
    else {
      this.dropNotes = 0;
      if (s.running) {
        s.running = false;
        if (s.activity.startedAt !== null && s.activity.endedAt === null) s.activity.endedAt = now;
        if (s.activity.state !== "SUCCESS" && s.activity.state !== "ERROR") { s.activity.state = "IDLE"; s.activity.label = "stopped"; }
        for (const r of s.messages) if (r.kind === "tool" && r.running) { r.running = false; r.ok = false; r.detail ??= "interrupted"; }
        this.pet.event("stopped", undefined, now);
      }
      s.escUntil = 0; delete s.ctrlCUntil;
    }
    this.loop.markDirty();
  }

  setStatus(info: StatusInfo): void {
    const s = this.state;
    s.yolo = info.yolo; if (info.mode) s.mode = info.mode;
    const u = this.ctx?.usage?.();
    setUsage(s, {
      provider: info.provider, model: info.model, turns: info.turns, tokensIn: info.tokensIn, tokensOut: info.tokensOut,
      contextTokens: u?.contextTokens ?? 0, contextWindow: this.ctx?.contextWindow(), costUsd: u ? u.costUsd : null,
    });
    this.refreshPlan();
    this.loop.markDirty();
  }

  // ------------------------------------------------------------------ internals
  private push(row: SextantState["messages"][number]): void { this.state.messages.push(row); this.state.stick = true; this.loop.markDirty(); }
  private rowOf(callId: string): ToolRow | undefined {
    for (let i = this.state.messages.length - 1; i >= 0; i--) { const r = this.state.messages[i]!; if (r.kind === "tool" && r.callId === callId) return r; }
    return undefined;
  }
  private toast(text: string, tone: "info" | "warn" | "error" = "info"): void { pushToast(this.state, clipText(text.trim(), TOAST_MAX), this.clock(), tone); this.loop.markDirty(); }

  /** the session's todos.json → plan panel; a newly completed step is a pet quip */
  private refreshPlan(): void {
    if (!this.ctx) return;
    setPlan(this.state, loadTodos(join(this.ctx.sessionsDir, this.ctx.store().id)));
    const c = planCounts(this.state);
    if (this.planLoaded && c.completed > this.todoDone) this.pet.event("todo_done", { d: c.completed, n: c.total }, this.clock());
    this.planLoaded = true; this.todoDone = c.completed;
  }

  private loadDiff(file: string | null): void {
    if (!file) return;
    const d = headDiff(this.state.cwd, file, this.git);
    this.state.code.diff = d ? { file, ...d } : null;
  }

  /** the renderer-owned effects keys.ts fires after writing the state field (theme rebuild, file/diff loading, toasts) */
  private readonly local: KeyCtx["local"] = {
    setTheme: (name) => { this.theme = buildTheme(name); this.state.theme = name; this.toast(`theme · ${name}`); this.pet.event("theme", undefined, this.clock()); },
    setMode: (mode) => { if (mode === "diff") this.loadDiff(this.state.code.file); },
    openFile: (path) => { this.state.code.content = readFileBounded(this.state.cwd, path); this.state.code.hl = null; this.loadedFile = path; },
    toast: (text) => this.toast(text),
  };

  /** renderer-level intercepts: the picker's Enter/Esc, and the two-press ⌃c guarantee (a ⌃c while busy
   *  interrupts through keys.ts and arms ctrlCUntil; a second one inside the window quits even before the
   *  interrupted run settled — keys.ts alone would interrupt again while s.running is still true) */
  private beforeInput(ev: InputEvent, now: number): boolean {
    const s = this.state;
    if (this.cards.interceptKey(ev)) return true;
    if (ev.type === "key" && ev.ctrl && ev.name === "c" && s.running && s.ctrlCUntil !== undefined && now < s.ctrlCUntil) { this.hooks?.onExit(); return true; }
    return false;
  }
  private afterInput(ev: InputEvent, now: number): void {
    const s = this.state;
    this.cards.afterKey();
    if (ev.type === "key" && ev.ctrl && ev.name === "c" && s.running) s.ctrlCUntil = now + ESC_WINDOW_MS;
    if (ev.type === "key" && !ev.ctrl && s.input.text.startsWith("/")) { const first = suggestions(s, s.files.paths, fuzzy)[0]; if (first?.kind === "slash") this.pet.suggest(first.label, now); }
  }

  /** off-frame work: the code panel's file content and the repo scan (full after a mutating tool, statuses while idle) */
  private onTick(now: number): void {
    const s = this.state;
    if (s.code.file && s.code.content === null && this.loadedFile !== s.code.file) { s.code.content = readFileBounded(s.cwd, s.code.file); this.loadedFile = s.code.file; this.loop.markDirty(); }
    if (this.scanWanted === null && this.hasGit && !s.running && now - this.lastScanAt >= IDLE_SCAN_MS) this.scanWanted = "status";
    if (this.scanWanted !== null) this.scheduleScan();
  }
  private scheduleScan(): void {
    if (this.scanTimer || this.stopped) return;
    this.scanTimer = setTimeout(() => {
      this.scanTimer = null;
      if (this.stopped || this.scanWanted === null) return;
      const kind = this.scanWanted, s = this.state;
      this.scanWanted = null; this.lastScanAt = this.clock();
      if (kind === "full") { const snap = scanRepo(s.cwd, this.git); setFiles(s, snap.paths, snap.statuses); s.repo.branch = snap.branch; this.hasGit = snap.git; }
      else { const st = statusOnly(s.cwd, this.git); if (st) setFiles(s, s.files.paths, st); }
      this.loop.markDirty();
    }, 0);
  }
}
