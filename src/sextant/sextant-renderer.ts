/** SextantRenderer (port #44): the sextant surface as rovecode's `Renderer` — the ONE controller stays
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
 *  I/O: the terminal through TerminalIO; git/fs through sextant-repo.ts (RepoWatcher: scheduled OFF
 *  the frame loop from the tick and run async, so a slow `git status` never freezes a frame). */

import { homedir } from "node:os";
import { basename, join } from "node:path";
import pkg from "../../package.json";
import type { RunEvent } from "../core/types.ts";
import { loadTodos } from "../tools/todo.ts";
import type { ApprovalAnswer, AssistantView, PickItem, QuestionAnswer, QuestionPrompt, Renderer, RendererHooks, RendererStartOptions, SlashCommand, StatusInfo } from "../tui/renderer.ts";
import { drawAgents } from "./draw-agents.ts";
import { openMarket } from "./draw-market.ts";
import { closeWizard, openWizard, wizardEndpointRegistered, wizardKeyStored, wizardModelConfirmed, type WizardProvider } from "./draw-wizard.ts";
import { docsFor, install, loadMarket, planFor } from "./market-source.ts";
import { openContext } from "./draw-context.ts";
import { fixedFrom, loadContext } from "./context-source.ts";
import { hunksFromUnified, setAgentsPainter } from "./draw-code.ts";
import { fuzzy } from "./engine.ts";
import { spawnGitAsync, toAsync, type GitRunner, type GitRunnerAsync } from "./git-status.ts";
import { enterSequence, leaveSequence } from "./input.ts";
import { ESC_WINDOW_MS, type KeyCtx } from "./keys.ts";
import { initialState, makeApplyEvent, planCounts, pushToast, setCrew, setPlan, setUsage } from "./model.ts";
import { suggestions } from "./overlays.ts";
import { createPet, type Pet } from "./pet.ts";
import { argsFromPreview, duplicateNotes, petOnEvent, petOnTask, replayToolRow, userRow, type LiveCall } from "./sextant-bridge.ts";
import { CardHost } from "./sextant-cards.ts";
import { editOpsOf, type HashlineOp } from "./sextant-diff-base.ts";
import { readFileBounded } from "./sextant-files.ts";
import { FrameLoop } from "./sextant-frame-loop.ts";
import { RepoWatcher } from "./sextant-repo.ts";
import { buildTheme, isThemeName } from "./theme.ts";
import { clipText, relPath, summarizeEnd } from "./tool-rows.ts";
import type { ApplyEvent, InputEvent, SextantAttach, SextantState, TerminalIO, Theme, ThemeName, ToolRow } from "./types.ts";

export { IDLE_SCAN_MS } from "./sextant-repo.ts";

export interface SextantRendererOptions {
  io: TerminalIO;
  /** the frame clock (Date.now in production; tests inject a controllable one) */
  clock?: () => number;
  /** starting palette (ROVECODE_THEME / --theme); an unknown name falls back to night */
  theme?: string;
  /** the pet's name (`--pet <name>`); attach() may override it */
  pet?: string;
  /** emit truecolor SGR (default true; false quantizes to xterm-256) */
  truecolor?: boolean;
  /** the project dir until attach() supplies the runtime's cwd */
  cwd?: string;
  /** git seam for tests (a sync fake is wrapped); undefined = spawn git asynchronously */
  git?: GitRunner | GitRunnerAsync;
  /** false disables the repo scan entirely (pure tests) */
  scan?: boolean;
}

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
  /** the git/fs work, off the loop and async (sextant-repo.ts) */
  private readonly repo: RepoWatcher;
  private readonly applyEv: ApplyEvent;
  /** SGR mode the Screen emits (false = the xterm-256 quantizer; tests/pickRenderer read it) */
  readonly truecolor: boolean;
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
  /** per cwd-relative path: the content when its edit/write was APPROVED (null = did not exist) — the
   *  pre-edit diff base. Captured at askApproval (the one moment before the tool runs), NOT at
   *  tool_execution_start: that event reaches the renderer through the loop's buffered pump after
   *  rovecode's synchronous edit/write already wrote, so a snapshot then is the post-edit file. Ungated
   *  calls (yolo / always) rebuild their base from the hashline ops instead (sextant-diff-base.ts). */
  private readonly before = new Map<string, string | null>();
  /** per live edit callId: its hashline ops (the base of an ungated edit is rebuilt from them at the end) */
  private readonly editOps = new Map<string, HashlineOp[]>();
  /** the file whose content the code panel holds (null → reload on the next tick) */
  private loadedFile: string | null = null;
  private planLoaded = false;
  private todoDone = 0;

  /** the model step's ONE fetch: the chosen provider through the wizardModels seam, the answer
   *  written with wizardModelConfirmed. Empty or failed leaves the step on the typed fallback. */
  private fetchWizardModels(): void {
    const w = this.state.wizard;
    if (!w) return;
    w.modelsLoading = true;
    this.loop.markDirty();
    const provider = w.providers[w.selected]?.key ?? "";
    void (this.ctx?.wizardModels?.(provider) ?? Promise.resolve([]))
      .then((models) => {
        if (!this.state.wizard) return;
        wizardModelConfirmed(this.state.wizard, models);
        if (models.length === 0) this.state.wizard.error = "the endpoint listed no models — type the id by hand (it still pins)";
        this.loop.markDirty();
      })
      .catch(() => {
        if (!this.state.wizard) return;
        this.state.wizard.modelsLoading = false;
        this.state.wizard.error = "the model list could not be read — type the id by hand";
        this.loop.markDirty();
      });
  }

  constructor(o: SextantRendererOptions) {
    this.io = o.io; this.clock = o.clock ?? Date.now; this.truecolor = o.truecolor ?? true;
    const themeName: ThemeName = isThemeName(o.theme ?? "") ? (o.theme as ThemeName) : "night";
    this.theme = buildTheme(themeName);
    const cwd = o.cwd ?? process.cwd();
    this.state = initialState({ cwd, repo: { name: basename(cwd) || cwd, branch: null }, version: pkg.version, theme: themeName, mode: "act", yolo: false, commands: [], now: this.clock() });
    this.pet = createPet({ name: o.pet });
    // the reducer's diffFor seam stays empty: the hunks arrive through the watcher's scheduleDiff (a
    // setTimeout(0) from the end event, then async git — nothing runs inside the event dispatch or a painter)
    this.applyEv = makeApplyEvent();
    this.repo = new RepoWatcher({ state: this.state, clock: this.clock, git: o.git ? toAsync(o.git) : spawnGitAsync, dirty: () => this.loop.markDirty() }, o.scan ?? true);
    this.cards = new CardHost({
      state: this.state, dirty: () => this.loop.markDirty(), stopped: () => this.stopped,
      onApprovalOpen: () => this.pet.event("permission", undefined, this.clock()),
      onAllowed: () => this.pet.event("allowed", undefined, this.clock()),
    });
    setAgentsPainter(drawAgents); // #46: the crew board paints the ∷ mode
    this.loop = new FrameLoop({
      io: this.io, clock: this.clock, state: this.state, theme: () => this.theme, pet: this.pet, truecolor: this.truecolor,
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
  start(hooks: RendererHooks, options?: RendererStartOptions): void | Promise<void> {
    if (this.started) return;
    this.started = true; this.hooks = hooks;
    this.state.bootAt = options?.animate === false ? -Infinity : this.clock();
    options?.beforeFirstRender?.();
    const reveal = (): void => {
      if (this.stopped) return;
      // Rebuild at the current size/state before handing off: a resize or file refresh may have landed.
      this.loop.start(() => {
        options?.onReveal?.();
        this.terminalEntered = true;
        this.io.enterRaw();
        this.io.write(enterSequence(true));
      }, options?.beforeReveal !== undefined);
    };
    if (!options?.beforeReveal) { reveal(); return; }
    this.loop.prepare(); // textbox, cursor and all panels really rendered behind the intro
    const files = this.repo.prepare().catch(() => {
      if (!this.stopped) this.addSystemNote("initial file list unavailable — file tools remain available", "warn");
    });
    return Promise.all([files, options.beforeReveal()]).then(reveal);
  }
  private terminalEntered = false;

  /** clear the interval, settle every open card/picker (deny / null), restore the terminal */
  /** settled once stop() has run AND the repo watcher's git children are gone (sextant-repo.ts stop) */
  private drained: Promise<void> | null = null;
  /** wait for the git children a stop() killed to be gone — call after stop(); a caller that removes
   *  the cwd (a test's scratch repo) must await this first, or Windows answers EBUSY */
  drain(): Promise<void> { return this.drained ?? this.repo.stop(); }
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.loop.stop();
    this.drained = this.repo.stop(); // kills the git children in flight; drain() awaits them
    this.unsubTasks?.(); this.unsubTasks = null;
    this.cards.settleAll();
    this.restoreTerminal();
    this.hooks = null;
  }

  /** The terminal, and nothing else. `stop()` ends with this; the crash guard (tui/crash-guard.ts)
   *  calls it on its own, because everything above in `stop()` — settling cards, killing the repo
   *  watcher's git children — can throw, and a throw before the restore leaves the alt screen open with
   *  mouse reporting on, which is the state where every pointer movement types escape sequences at the
   *  shell prompt. Idempotent (the second call has nothing to undo) and silent on failure: if writing to
   *  stdout is itself what broke, there is nothing left to try. */
  restoreTerminal(): void {
    if (!this.terminalEntered || this.restored) return;
    this.restored = true;
    try { this.io.write(leaveSequence()); } catch { /* the pipe may already be gone */ }
    try { this.io.leaveRaw(); } catch { /* ditto */ }
  }
  private restored = false;

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
    this.repo.afterAttach();
    this.refreshPlan();
  }

  // ------------------------------------------------------------------ the event stream (source of truth while busy)
  onEvent(ev: RunEvent): void {
    const now = this.clock(), s = this.state;
    this.applyEv(s, ev, now);
    petOnEvent(this.pet, ev, this.liveCalls, s.cwd, now);
    this.dropNotes += duplicateNotes(ev);
    if (ev.type === "tool_execution_start" && ev.tool === "edit") this.editOps.set(ev.callId, editOpsOf(ev.args));
    if (ev.type === "tool_execution_end" || ev.type === "tool_call_failed") {
      const row = this.rowOf(ev.callId);
      const before = row?.path !== undefined ? this.before.get(row.path) : undefined;
      if (row?.path !== undefined) this.before.delete(row.path);
      const ops = this.editOps.get(ev.callId) ?? [];
      this.editOps.delete(ev.callId);
      if (row && (row.verb === "edit" || row.verb === "write" || row.verb === "remove" || row.verb === "run")) {
        this.repo.afterMutation();
        if (row.path !== undefined && row.path === s.code.file) s.code.content = null; // reload the edited file (before the next paint: onTick)
        this.loadedFile = null;
        if (ev.type === "tool_execution_end" && ev.ok && row.path !== undefined && (row.verb === "edit" || row.verb === "write")) this.repo.scheduleDiff(row, row.path, before, ops);
      }
    }
    this.loop.markDirty();
  }

  /** pre-approval (the approver runs BEFORE the tool executes — the one real-time moment): capture the
   *  file's current content as the diff base, and let the card's previewDiff text fill the code panel's
   *  diff view for the pending file; returns the cwd-relative file (null when the card names none) */
  private previewInCodePanel(tool: string, argsPreview: string, detail: string | undefined): string | null {
    if (tool !== "edit" && tool !== "write") return null;
    const path = argsFromPreview(argsPreview).path;
    if (typeof path !== "string" || !path) return null;
    const file = relPath(this.state.cwd, path);
    this.before.set(file, readFileBounded(this.state.cwd, file));
    const hunks = detail ? hunksFromUnified(detail) : [];
    if (!hunks.length) return file;
    const rows = hunks.flatMap((h) => h.rows);
    this.state.code.diff = { file, hunks, add: rows.filter((r) => r.op === "+").length, del: rows.filter((r) => r.op === "-").length };
    this.state.code.mode = "diff";
    return file;
  }

  // ------------------------------------------------------------------ Renderer → state
  setCommands(cmds: SlashCommand[]): void {
    this.state.commands = cmds.map((c) => ({ name: c.name, description: c.description, ...(c.choices ? { choices: c.choices } : {}), ...(c.choicesThen ? { choicesThen: c.choicesThen } : {}) }));
    this.loop.markDirty();
  }

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

  /** the approval card (sextant-cards.ts); an edit/write preview also fills the code panel's diff view.
   *  A denied call never executes (no row, no end event), so its captured base is dropped here — a later
   *  ungated edit of the same file must not diff against that stale snapshot */
  askApproval(tool: string, argsPreview: string, detail?: string): Promise<ApprovalAnswer> {
    const file = this.previewInCodePanel(tool, argsPreview, detail);
    const answer = this.cards.approval(tool, argsPreview, detail);
    if (file !== null) void answer.then((a) => { if (a === "deny") this.before.delete(file); });
    return answer;
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
    s.yolo = info.yolo; s.acceptEdits = info.permission === "accept-edits"; if (info.mode) s.mode = info.mode;
    const u = this.ctx?.usage?.();
    setUsage(s, {
      provider: info.provider, model: info.model, turns: info.turns, tokensIn: info.tokensIn, tokensOut: info.tokensOut,
      ...(info.effort !== undefined ? { effort: info.effort } : {}),
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

  /** the renderer-owned effects keys.ts fires after writing the state field (theme rebuild, file/diff loading, toasts) */
  private readonly local: KeyCtx["local"] = {
    setTheme: (name) => { this.theme = buildTheme(name); this.state.theme = name; this.toast(`theme · ${name}`); this.pet.event("theme", undefined, this.clock()); },
    // port #54: an @image mention stages onto the store the surface attached (SextantAttach.attachImage)
    attachImage: (abs) => this.ctx?.attachImage?.(abs),
    setMode: (mode) => { if (mode === "diff" && this.state.code.file) this.repo.loadDiff(this.state.code.file); },
    openFile: (path) => { this.state.code.content = readFileBounded(this.state.cwd, path); this.state.code.hl = null; this.loadedFile = path; },
    toast: (text) => this.toast(text),
    // the market: the overlay is opened at once in its loading state so the frame after ⌃m already shows
    // the box, and the catalog is joined in when the module answers (it may touch the network)
    openMarket: () => {
      openMarket(this.state, [], { kind: "loading" });
      this.loop.markDirty();
      void loadMarket(this.state.cwd, homedir())
        .then((load) => { if (this.state.market) { this.state.market.rows = load.rows; this.state.market.status = load.status; this.state.market.notes = load.notes; this.loop.markDirty(); } })
        .catch((e: unknown) => { if (this.state.market) { this.state.market.status = { kind: "error", reason: e instanceof Error ? e.message : String(e) }; this.loop.markDirty(); } });
    },
    // /context (⌃g). The panel opens on the NEXT frame with what we already have — the model and an
    // empty count — so the chord feels instant, and the real numbers are joined in when counting is
    // done. Counting is synchronous but not free on a long transcript, so it happens off the frame.
    openWizard: () => {
      const rows = this.ctx?.wizardProviders?.();
      if (!rows || rows.length === 0) { this.toast("no provider table behind this surface"); return; }
      openWizard(this.state, rows satisfies WizardProvider[]);
      this.loop.markDirty();
    },
    openContext: () => {
      const ref = this.ctx?.model() ?? { provider: "unknown", model: "unknown" };
      const inputs = this.ctx?.contextInputs?.();
      openContext(this.state, {
        model: `${ref.provider}/${ref.model}`, raw: 0, estimated: 0,
        scale: { factor: 1, measured: false, note: "counting…" },
        slices: [], images: 0, billed: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        unpricedTurns: 0, live: false, tolerance: 0.05,
      });
      this.loop.markDirty();
      if (!inputs) return;   // the panel stays in its "not counted" state and says so
      void loadContext({
        messages: inputs.messages, current: ref, lookup: inputs.lookup,
        fixed: fixedFrom(inputs.runtime, ref),
      }).then((state) => {
        // the human may have closed it while we counted; writing into a closed panel would reopen it
        if (!this.state.context) return;
        this.state.context = { ...state, scroll: this.state.context.scroll };
        this.loop.markDirty();
      }).catch(() => { /* loadContext does not reject; this is belt and braces on the dynamic import */ });
    },
    marketPlan: (row, local) => {
      void planFor(row, { scope: "user", cwd: this.state.cwd, home: homedir() }, local)
        .then((plan) => {
          const m = this.state.market;
          if (!m) return;
          if ("error" in plan) { this.toast(plan.error); return; }
          m.plan = plan;
          this.loop.markDirty();
        });
    },
    // the connect wizard (draw-wizard.ts): the overlay owns the WALK, the attach seams own the
    // registry — a surface without them (the smoke harness) degrades to honest errors, the same
    // way reloadMcp does
    wizardRegister: (id, url, protocol) => {
      const w = this.state.wizard;
      const r = this.ctx?.wizardRegister?.(id, url, protocol);
      if (!w) return;
      // on success the chosen row IS this endpoint now — the walk continues at KEY with a live row
      wizardEndpointRegistered(w, r?.ok ?? false, r?.error ?? "this surface cannot register endpoints — use rovecode provider add");
      if (r?.ok) w.providers[w.selected] = { key: id, label: `${id} — ${url}`, configured: false };
      this.loop.markDirty();
    },
    wizardStoreKey: (provider, secret) => {
      const w = this.state.wizard;
      const r = this.ctx?.wizardStoreKey?.(provider, secret);
      if (!w) return;
      wizardKeyStored(w, r?.ok ?? false, r?.error ?? "this surface cannot store keys — use rovecode auth set");
      // a stored key is what makes the endpoint ASKABLE: the model step that just opened fetches now
      if (r?.ok) this.fetchWizardModels();
      this.loop.markDirty();
    },
    wizardLoadModels: () => { this.fetchWizardModels(); },
    // confirmModels: pin the checked rows as the provider's active list + name the default. The
    // seam (SextantAttach.wizardActivateModels → app.ts activateModels → registry setModels) is
    // Berkay's; this only runs it and advances on its answer. The confirmed id rides the state
    // (modelDefaultTo), so a walk back to re-edit the list keeps the marker where the person left it.
    wizardActivate: (provider, models, makeDefault) => {
      const w = this.state.wizard;
      if (!w) return;
      const r = this.ctx?.wizardActivateModels?.(provider, models, makeDefault);
      if (r?.ok) {
        closeWizard(this.state);            // the walk is DONE: the list is pinned, the default is set
        this.toast(`connected — ${r.models !== undefined && r.models.length > 0 ? `${r.models.length} models active` : "all models live"}`);
      } else {
        w.error = r?.error ?? "the model list could not be written";
      }
      this.loop.markDirty();
    },
    wizardModel: (model) => {
      const w = this.state.wizard;
      if (!w) return;
      const provider = w.providers[w.selected]?.key ?? "";
      void (this.ctx?.wizardModels?.(provider) ?? Promise.resolve([]))
        .then((models) => {
          if (!this.state.wizard) return;
          if (models.length === 0) { closeWizard(this.state); this.toast(`connected — ${model} pinned by hand`); }  // the typed fallback IS the finish
          else wizardModelConfirmed(this.state.wizard, models);
          this.loop.markDirty();
        })
        .catch(() => { if (this.state.wizard) { this.state.wizard.error = "the model list could not be read — type the id instead"; this.loop.markDirty(); } });
    },
    marketDocs: (row) => {
      void docsFor(row).then((docs) => {
        const m = this.state.market;
        if (!m || !docs) return;
        // write onto the row the list holds, so closing and reopening the pane costs nothing
        const target = m.rows.find((r) => r.kind === row.kind && r.id === row.id);
        if (target) target.docs = docs;
        this.loop.markDirty();
      });
    },
    marketInstall: (row, local) => {
      // `local` is the approved card's own answer (keys.ts hands over req.plan.local): npm runs only now
      void install(row, { scope: "user", cwd: this.state.cwd, home: homedir() }, local === true ? { local: true } : {}).then(async (outcome) => {
        // An MCP server lands in a file this session already read, so the install used to end in
        // "restart rovecode" — a poor answer to "I just installed it". Ask the runtime to re-read the
        // files and connect what is new, and report what actually happened instead of what to do next.
        // Only on success, only for MCP, and never fatal: a reload that throws leaves the install
        // reported exactly as it was, because the write DID happen and saying otherwise would be worse.
        let text = outcome.text;
        if (outcome.ok && row.kind === "mcp" && this.ctx?.reloadMcp) {
          try {
            const r = await this.ctx.reloadMcp();
            const failed = r.failed.find((f) => r.added.includes(f.name));
            text = text.replace(/ · restart rovecode[^·]*/, "");
            // `skipped` before `added`: an entry the loader refused never reaches `added`, so without this
            // the install read "installed" and then said nothing at all about why no tools appeared.
            const skipped = r.skipped.length > 0 ? ` · ${r.skipped.join(" · ")}` : "";
            text += failed
              ? ` · ${failed.name} did not connect: ${failed.error}`
              : r.added.length > 0 ? ` · connected as ${r.added.join(", ")} — no restart needed${skipped}` : skipped;
          } catch { /* the install stands on its own */ }
        }
        const m = this.state.market;
        if (!m?.plan) return;
        m.plan.running = false;
        m.plan.outcome = { ...outcome, text };
        this.loop.markDirty();
      });
    },
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

  /** off-frame work, BEFORE the tick's paint: the code panel's file content (a bounded sync read, so
   *  the frame that follows an edit shows the file, never `cannot read`) and the repo scan (full after
   *  a mutating tool, statuses while idle — async, sextant-repo.ts) */
  private onTick(now: number): void {
    const s = this.state;
    if (s.code.file && s.code.content === null && this.loadedFile !== s.code.file) { s.code.content = readFileBounded(s.cwd, s.code.file); this.loadedFile = s.code.file; this.loop.markDirty(); }
    // the staged images are owned by the store (tui/attach.ts); mirror their names so the prompt shows
    // chips before the message is sent — one read per tick, never a second copy of the list
    const staged = this.ctx?.staged?.() ?? [];
    if (staged.length !== s.staged.length || staged.some((n, i) => n !== s.staged[i])) { s.staged = staged; this.loop.markDirty(); }
    this.repo.onTick(now, s.running);
  }
}
