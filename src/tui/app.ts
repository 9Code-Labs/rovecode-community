/** TUI chat app (port #1): wires the ONE agentLoop (ADR-003) into a Renderer.
 *  All vendor contact lives behind Renderer (renderer.ts) — swap-friendly. Slash handlers live
 *  beside it (ADR-002 cap): info-cmd.ts (/help /status /cost /skills /memory /export /todos
 *  /tasks), session-cmd.ts (/new /rewind /sessions /resume), checkpoints-cmd.ts, modes-cmd.ts. */

import { agentLoop } from "../core/loop.ts";
import { resetTurnFailureCount } from "../memory/tools.ts";
import { createRuntime } from "../cli/runtime.ts";
import { SandboxConfigError } from "../core/sandbox-config.ts";
import type { SpawnRunner } from "../core/executor.ts";
import { SessionStore } from "../core/session.ts";
import { BlockStore } from "../memory/blocks.ts";
import { ModelCatalog } from "../providers/catalog.ts";
import { ModeManager, loadModesConfig, modeFromEntries, type AgentMode } from "../core/modes.ts";
import { isTerminal, taskNote } from "../core/tasks.ts";
import { togglePlanAct, applyModeToRun, flushModeSwitch } from "./modes-cmd.ts";
import { cmdCheckpoints, cmdRestore, type CheckpointCmdCtx } from "./checkpoints-cmd.ts";
import { cmdRewind, cmdSessions, cmdNew, replayTranscript, usageOf, resolveBootSession, type SessionCmdCtx } from "./session-cmd.ts";
import { cmdHelp, cmdStatus, cmdCost, cmdSkills, cmdMemory, cmdExport, cmdTodos, cmdTasks, todoLabel, type InfoCmdCtx } from "./info-cmd.ts";
import { cmdAttach, carryOverAttachments, queuedAttachNote, userTurnLine, ATTACH_COMMAND, type AttachCtx } from "./attach.ts";
import { cmdConnect, cmdModel as cmdModelSwitch, cmdModels, cmdProvider, cmdSetup, watchProviders, CONNECT_COMMAND, MODEL_COMMAND, PROVIDER_COMMANDS, SETUP_COMMAND, type ProviderCmdCtx } from "./providers-cmd.ts";
import { acceptEditsNote, effortNote, modeSwitchNote, noModelHint, resumedLine, welcomeCard } from "../core/voice.ts";
import { compactionNote } from "./replay-marker.ts";
import { previewDiff } from "../coding/diff.ts";
import { discoverCommands, commandsForPalette, dispatchCustomCommand, type CustomCommandCtx } from "./commands.ts";
import type { Renderer, AssistantView, SlashCommand, StatusInfo } from "./renderer.ts";
import { PiTuiRenderer } from "./pi-renderer.ts";
import { buildSextantAttach, SEXTANT_LOCAL_NAMES } from "./sextant-attach.ts";
import type { PermissionLevel, RunEvent, StreamFn } from "../core/types.ts";
import { parseEffort, THINKING_EFFORTS } from "../core/types.ts";
import { resolvePermission, saveSetting } from "../core/settings.ts";
import type { ThinkingEffort } from "../core/types.ts";
import { join } from "node:path";

export { buildCostNote } from "./cost.ts"; // moved for the ADR-002 cap; re-exported for tests

export interface TuiAppOptions {
  yolo?: boolean;
  model?: string;
  cwd?: string;
  /** resume an existing session id instead of starting a fresh one */
  sessionId?: string;
  /** injected by tests/smoke (VirtualTerminal-backed renderer, mock stream) */
  renderer?: Renderer;
  stream?: StreamFn | null;
  /** default true: process.exit(0) when the user quits */
  exitOnClose?: boolean;
  /** port #27 test seams, threaded into createRuntime: the process runner behind the rung
   *  probe (never a real wsl.exe/docker in tests) and the platform the probe assumes */
  spawnRunner?: SpawnRunner;
  platform?: NodeJS.Platform;
  /** port #44: the sextant pet's name (`--pet <name>`); the classic renderer ignores it */
  pet?: string;
  /** start in the middle permission tier (`--accept-edits`, ROVECODE_ACCEPT_EDITS=1) */
  acceptEdits?: boolean;
  /** `--effort <level>`; overrides ROVECODE_EFFORT for this session */
  effort?: ThinkingEffort;
}

/** The built-in slash commands, worded in rovecode's voice (core/voice.ts) and tagged with the /help topic
 *  they are listed under (info-cmd.ts cmdHelp groups by `group`; the palette shows name + description). */
export const TUI_COMMANDS: SlashCommand[] = [
  { name: "help", description: "This list, by topic", group: "start here" },
  CONNECT_COMMAND, // providers-cmd.ts: /connect — bare it is /setup; with an id it takes the answers on the line
  SETUP_COMMAND, // providers-cmd.ts: /setup — pick a provider, name the model, hand over the key, one test call
  { name: "exit", description: "Quit (Ctrl+C does the same)", group: "start here" },
  { name: "new", description: "Start over in this session (branch back to the beginning)", group: "session" },
  { name: "sessions", description: "Pick an earlier session to continue", group: "session" },
  { name: "resume", description: "Continue a session by id: /resume <id>", group: "session" },
  { name: "rewind", description: "Go back to an earlier turn and edit it (alias: /tree)", group: "session" },
  { name: "tree", description: "Alias of /rewind", group: "session" },
  { name: "export", description: "Save this session as markdown: /export [--json] [path] [--force]", group: "session" },
  MODEL_COMMAND, // providers-cmd.ts: /model <provider/model | model> [--save]
  ...PROVIDER_COMMANDS, // /models · /provider — providers-cmd.ts (live registry: no restart after add/key/use)
  { name: "yolo", description: "Toggle ask first / auto (never asks)", group: "modes & safety" },
  { name: "accept-edits", description: "Stop asking for writes inside this folder; shell, subagents and writes outside it still ask", group: "modes & safety" },
  { name: "effort", description: "How hard I think before answering: /effort off | low | medium | high", group: "model & provider" },
  { name: "plan", description: "Plan mode: I only read and plan, nothing changes", group: "modes & safety" },
  { name: "act", description: "Act mode: I can edit and run again", group: "modes & safety" },
  { name: "checkpoints", description: "Snapshots I took before each change (shadow git)", group: "files & history" },
  { name: "restore", description: "Go back to a snapshot: /restore <ref> [files|conversation|both]", group: "files & history" },
  { ...ATTACH_COMMAND, group: "files & history" }, // port #34: /attach <path> · /attach (list) · /attach clear — attach.ts
  { name: "status", description: "Provider, model, turns, tokens, sandbox", group: "info" },
  { name: "cost", description: "Tokens, cache hits and the USD estimate (/cost refresh updates prices)", group: "info" },
  { name: "todos", description: "My step list for the current task", group: "info" },
  { name: "tasks", description: "Background subagents: /tasks [cancel <id>|cancel all]", group: "info" },
  { name: "skills", description: "Installed skills", group: "info" },
  { name: "memory", description: "What I remember across turns (memory blocks)", group: "info" },
];

interface TuiState {
  yolo: boolean;
  /** the middle tier (port: Claude Code's acceptEdits): writes inside the workspace stop asking,
   *  shell/spawn/network and writes outside it still do. Ignored while `yolo` is on — auto already
   *  covers everything. Turned on by `/accept-edits`, `--accept-edits`, or the `all edits` button on
   *  a write approval card. */
  acceptEdits: boolean;
  provider: string; model: string; mode: AgentMode;
  turns: number; tokensIn: number; tokensOut: number;
  busy: boolean;
}

export async function runTui(opts: TuiAppOptions = {}): Promise<void> {
  // opts.sessionId may be a unique id prefix (rovecode --resume <id>): resolved by the /resume rule
  // (session-cmd.ts) — exact/new ids pass, a unique prefix resolves, an ambiguous one starts fresh + warns
  const boot = resolveBootSession(join(opts.cwd ?? process.cwd(), ".rovecode", "sessions"), opts.sessionId);
  // opts.stream passes through verbatim: a StreamFn overrides, explicit null forces
  // "no provider", undefined defers to the runtime's env-resolved provider
  // port #27: a sandbox MISCONFIG throws synchronously here (before any side effect) — a clean
  // one-line startup error (exit 2), never a stack, never a silent direct fallback. The rung
  // PROBE verdict (rt.sandbox.ready) is awaited at the end of boot: runTui must stay
  // synchronous until the renderer's input handlers are wired (tests/smoke send input right
  // after calling runTui), so no await may sit above that point.
  const rt = (() => {
    try { return createRuntime({ cwd: opts.cwd, stream: opts.stream, sessionId: boot.id, spawnRunner: opts.spawnRunner, platform: opts.platform }); }
    catch (e) {
      if (e instanceof SandboxConfigError && opts.exitOnClose !== false) { console.error(`error: ${e.message}`); process.exit(2); }
      throw e;
    }
  })();
  const renderer: Renderer = opts.renderer ?? new PiTuiRenderer({ cwd: rt.cwd });
  rt.setAskUser((q, signal) => renderer.askQuestion(q, signal)); // port #33: ask_user → the question overlay (Esc/abort dismisses it via signal)
  const sessionsDir = join(rt.cwd, ".rovecode", "sessions");
  // /cost pricing + context window. Boots from the offline snapshot; the live models.dev
  // half is user-invoked only (/cost refresh), cached to .rovecode/cache with a 24h TTL —
  // lookup() itself never fetches, so the TUI stays network-free unless asked.
  const catalog = new ModelCatalog({ fetchFn: fetch, cacheDir: join(rt.cwd, ".rovecode", "cache") });
  // session-scoped stores are swappable at runtime (/sessions, /rewind-to-root)
  let store = rt.store;
  let blocks = rt.blockStore;
  // port #26: the runtime's ONE steering queue — background-task completion notes land on the
  // next model turn; settled tasks also show in the transcript as they happen (failed → warn)
  const steering = rt.steering;
  rt.tasks.subscribe((t) => { if (isTerminal(t.status)) renderer.addSystemNote(taskNote(t), t.status === "failed" ? "warn" : "info"); });
  // port #20: per-mode model slots from .rovecode/modes.json, restored from session entries
  const modesCfg = loadModesConfig(rt.cwd);
  const modes = new ModeManager(modesCfg, {
    provider: rt.provider?.id ?? "mock",
    model: opts.model ?? process.env.ROVECODE_MODEL ?? rt.defaultModel ?? "",
  });
  modes.restore(modeFromEntries(store.messages()) ?? modes.mode);
  // port #30: custom slash commands — .rovecode/commands/*.md, project shadows ~/.rovecode/commands (commands.ts);
  // LOW-1: /quit is a `case` alias of /exit below, not a TUI_COMMANDS entry — reserve it explicitly;
  // port #44: the sextant surface's own /theme /open /diff /focus /agents never reach handleSlash — reserved too
  // plugins (src/plugins): an ACTIVE plugin's commands folder is one more root, after the folder of its own
  // scope — the same path setCommands feeds the palette and suggestions from, so nothing else changes
  const pluginCommandDirs = rt.plugins.found.flatMap((p) => (p.status === "active" && p.commandsDir ? [{ dir: p.commandsDir, scope: p.scope }] : []));
  const custom = discoverCommands(rt.cwd, { reserved: [...TUI_COMMANDS.map((c) => c.name), "quit", ...SEXTANT_LOCAL_NAMES], extraDirs: pluginCommandDirs });
  if (opts.effort !== undefined) rt.setEffort(opts.effort);
  // one resolved answer instead of two independent booleans: flag → env → project file → user file →
  // "ask" (core/settings.ts). This is what makes `/yolo --save` survive the terminal closing.
  const startLevel = resolvePermission(rt.cwd, opts.yolo === true ? "auto" : opts.acceptEdits === true ? "accept-edits" : undefined, { ROVECODE_PERMISSION: process.env.ROVECODE_PERMISSION, ROVECODE_YOLO: process.env.ROVECODE_YOLO, ROVECODE_ACCEPT_EDITS: process.env.ROVECODE_ACCEPT_EDITS });
  const state: TuiState = {
    yolo: startLevel === "auto",
    acceptEdits: startLevel === "accept-edits",
    provider: modes.modelFor().provider,
    model: modes.modelFor().model,
    mode: modes.mode,
    turns: 0, tokensIn: 0, tokensOut: 0, busy: false,
  };
  let run: AsyncGenerator<RunEvent> | null = null; let runAbort: AbortController | null = null; // port #21: one controller per run
  let closed = false;
  let resolveClosed: () => void = () => {};
  const closedP = new Promise<void>((r) => { resolveClosed = r; });

  const status = (): StatusInfo => {
    const todos = todoLabel(join(sessionsDir, store.id)); // port #32: "todos done/total"; key omitted while the list is empty
    return {
      provider: state.provider, model: state.model, yolo: state.yolo, mode: state.mode,
      permission: state.yolo ? "auto" : state.acceptEdits ? "accept-edits" : "ask",
      effort: rt.effort,
      turns: state.turns, tokensIn: state.tokensIn, tokensOut: state.tokensOut,
      ...(todos !== undefined ? { todos } : {}),
    };
  };
  const pushStatus = () => renderer.setStatus(status());

  const close = () => {
    if (closed) return;
    closed = true;
    // port #20 MED-2: /plan then quit resumes in plan (append is sync — lands pre-exit)
    flushModeSwitch(modes, store);
    runAbort?.abort(); // abort kills in-flight fetch/tools; return() settles the generator — kept, so the exit below waits for it
    const settled = run?.return(undefined as never).then(() => undefined, () => undefined) ?? Promise.resolve();
    rt.tasks.cancelAll(); // port #26: background children die with the surface, never after it
    void rt.mcp?.close().catch(() => {}); // stop MCP child processes/connections
    renderer.stop();
    // port #29: session_close fires ONCE, after the aborted run settled and its in-flight on_event
    // taps drained (hooks.close() waits for those) — cmdRun's exit() order; the app promise
    // resolves (and the process exits) only after it, so a quit never outruns the hook
    void (async () => {
      await settled;
      await rt.hooks.close().catch(() => {});
      // the sextant renderer's git children (repo watcher) must be GONE before the process exits — on
      // Windows a live child holds its cwd, so a scratch repo removed at quit throws EBUSY (fee2e8c root
      // cause). Optional: the Renderer seam stays untouched; FakeRenderer and pi-tui have no drain()
      await (renderer as { drain?: () => Promise<void> }).drain?.()?.catch(() => {});
      resolveClosed();
      if (opts.exitOnClose !== false) process.exit(0);
    })();
  };

  // both read the ACTIVE store live — /sessions and a root /rewind swap it (session-cmd.ts helpers)
  const refreshUsage = () => { const u = usageOf(store); state.tokensIn = u.tokensIn; state.tokensOut = u.tokensOut; };
  const replayHistory = () => replayTranscript(renderer, store);
  // port #34: /attach context — the stage lives on the ACTIVE store (read live); the vision check uses the current mode's model
  const attachCtx: AttachCtx = { renderer, cwd: rt.cwd, store: () => store, modelRef: () => modes.modelFor() };

  const switchSession = (id: string, announce = true) => {
    flushModeSwitch(modes, store); // port #20 MED-2: don't discard a pending switch on /sessions away
    const pending = store.stagedAttachments; // port #34: the stage lives on the instance — re-staged on the new one below
    store = new SessionStore(sessionsDir, id);
    blocks = new BlockStore(join(sessionsDir, id, "memory"));
    // rebind BOTH consumers: the memory tool AND the system prompt's memory block
    // (critic finding: prompt kept reading the boot session's memory after /resume)
    rt.setBlockStore(blocks);
    rt.setSessionStore(store); // port #11: checkpoint entryId capture follows the active session
    // port #20: the switched-to session resumes ITS last recorded mode
    modes.restore(modeFromEntries(store.messages()) ?? modesCfg.defaultMode ?? "act");
    const cur = modes.modelFor();
    state.mode = modes.mode; state.model = cur.model; state.provider = cur.provider;
    state.turns = 0;
    replayHistory();
    refreshUsage();
    pushStatus();
    if (announce) renderer.addSystemNote(`session ${id.slice(0, 8)} (${store.messages().length} messages)`);
    carryOverAttachments(attachCtx, pending); // port #34: a swap must never lose staged images silently
  };

  // port #11: checkpoint command context (store/busy read live via closures)
  const cpCtx: CheckpointCmdCtx = {
    renderer,
    busy: () => state.busy,
    sessionId: () => store.id,
    checkpointsFor: (sid) => rt.checkpointsFor(sid),
    branchTo: (entryId) => store.branch(entryId),
    replayAndRefresh: () => { replayHistory(); refreshUsage(); pushStatus(); },
  };

  // port #2: session navigation context (store read live via closure — /sessions and a root /rewind swap it)
  const sessCtx: SessionCmdCtx = {
    renderer,
    sessionsDir,
    busy: () => state.busy,
    store: () => store,
    switchSession,
    replayHistory,
    refreshUsage,
    pushStatus,
  };

  // read-only info commands (info-cmd.ts) — store/blocks read live, the status slice is `state` itself
  const infoCtx: InfoCmdCtx = {
    renderer, rt, sessionsDir, catalog, state,
    store: () => store, blocks: () => blocks,
    commands: { builtin: TUI_COMMANDS, custom: custom.commands },
  };

  // port #30: custom command dispatch context (submit = the plain user-turn path, defined below)
  const cmdCtx: CustomCommandCtx = { renderer, modes, state, pushStatus, submit: (t) => submit(t) };

  // /model /models /provider (providers-cmd.ts) read the live registry; built lazily so pushStatus is bound
  const provCtx = (): ProviderCmdCtx => ({ rt, modes, state, renderer, pushStatus });
  /** `--save` writes the level the toggles just produced, so the next launch starts there;
   *  `--project` pins it to this checkout instead of to you. Without --save nothing is written —
   *  a toggle you meant for one run must not follow you into the next. */
  const persistLevel = (arg: string): string => {
    const words = arg.split(/\s+/).filter((w) => w.length > 0);
    if (!words.includes("--save")) return "this session only — add --save to make it the default (--project pins it to this repo)";
    const scope = words.includes("--project") ? "project" : "user";
    const level: PermissionLevel = state.yolo ? "auto" : state.acceptEdits ? "accept-edits" : "ask";
    try {
      const path = saveSetting("permission", level, scope, rt.cwd);
      return `saved: ${level} is the default now (${path})`;
    } catch (e) {
      return `could not save it: ${e instanceof Error ? e.message : String(e)}`;
    }
  };

  const handleSlash = (text: string): boolean => {
    const [cmd, ...rest] = text.slice(1).split(/\s+/);
    const arg = rest.join(" ").trim();
    switch (cmd) {
      case "exit": case "quit": close(); return true;
      case "help": cmdHelp(infoCtx); return true;
      case "effort": {
        const want = arg.trim();
        if (want.length === 0) { renderer.addSystemNote(effortNote(rt.effort)); return true; }
        const level = parseEffort(want);
        if (level === undefined) { renderer.addSystemNote(`"${want}" is not a level — ${THINKING_EFFORTS.join(" · ")}`, "warn"); return true; }
        rt.setEffort(level);
        renderer.addSystemNote(effortNote(level));
        pushStatus(); return true;
      }
      case "accept-edits":
        state.acceptEdits = !state.acceptEdits;
        renderer.addSystemNote(state.yolo
          ? `${acceptEditsNote(state.acceptEdits)}  (auto mode is on, so nothing asks either way — /yolo turns it off)`
          : acceptEditsNote(state.acceptEdits));
        renderer.addSystemNote(persistLevel(arg));
        pushStatus(); return true;
      case "yolo":
        state.yolo = !state.yolo;
        renderer.addSystemNote(modeSwitchNote(state.yolo)); // "ask first" / "auto (never asks)" — the flag keeps its name
        renderer.addSystemNote(persistLevel(arg));
        pushStatus(); return true;
      // port #20: model writes land in the CURRENT mode's slot (mirrored to both when
      // planActSeparateModels is off); the selector may name another provider — the registry's
      // dispatcher routes per call, so the switch needs no restart. --save persists the default.
      case "model": cmdModelSwitch(provCtx(), arg); return true;
      case "models": void cmdModels(provCtx(), arg); return true;
      case "provider": void cmdProvider(provCtx(), arg); return true;
      case "setup": void cmdSetup(provCtx()); return true; // guided connect: picker → model → key hand-off → test → default
      // the same job on one line (cli/connect.ts through the live registry); bare, it hands over to /setup
      case "connect": void cmdConnect(provCtx(), arg); return true;
      case "plan": case "act":
        togglePlanAct(modes, cmd as AgentMode, state, renderer, pushStatus);
        return true;
      case "checkpoints": void cmdCheckpoints(cpCtx); return true;
      case "restore": void cmdRestore(cpCtx, arg); return true;
      case "status": cmdStatus(infoCtx); return true;
      case "cost": cmdCost(infoCtx, arg); return true;
      case "skills": cmdSkills(infoCtx); return true;
      case "memory": cmdMemory(infoCtx); return true;
      case "todos": cmdTodos(infoCtx); return true; // port #32
      case "tasks": cmdTasks(infoCtx, arg); return true; // port #26
      case "new": cmdNew(sessCtx); return true;
      case "rewind": case "tree": void cmdRewind(sessCtx); return true;
      case "sessions": void cmdSessions(sessCtx); return true;
      case "resume":
        if (arg) void cmdSessions(sessCtx, arg); else void cmdSessions(sessCtx);
        return true;
      case "export": cmdExport(infoCtx, arg); return true;
      case "attach": cmdAttach(attachCtx, arg); return true; // port #34
      default:
        // port #30: a discovered custom command renders its template and submits it as a user turn.
        // MED-2: it gets the RAW remainder of the line (whitespace runs and pasted newlines intact —
        // renderCommand trims the ends itself); built-ins keep the collapsed `arg` above.
        if (!dispatchCustomCommand(cmdCtx, custom.commands, cmd ?? "", text.slice(1 + (cmd ?? "").length))) renderer.addSystemNote(`unknown command: /${cmd} (try /help)`, "warn");
        return true;
    }
  };

  const startRun = async (goal: string) => {
    const stream = rt.stream; // runtime already applied any opts.stream override
    // live check: /provider add + /provider key (or `rovecode provider add` in another terminal) clears
    // it for the next prompt — no restart
    const reason = rt.noProviderReason();
    if (!stream || reason !== null) {
      renderer.addSystemNote(reason !== null ? noModelHint("tui") : "no provider stream", "error");
      return;
    }
    state.busy = true;
    renderer.setBusy(true, "thinking…");
    pushStatus();
    const level: PermissionLevel = state.yolo ? "auto" : state.acceptEdits ? "accept-edits" : "ask";
    const cfg = rt.buildCfg(level, state.yolo ? undefined : async (req) => {
      // port #24: edit/write approvals carry a bounded unified diff of the pending change
      // (in-memory preview; any failure degrades to the plain overlay, never blocks the ask)
      const isEdit = req.tool === "edit" || req.tool === "write";
      // `all edits` pressed DURING this run: the rules were built before it, so the switch is honored
      // here too — otherwise the mode would only start at the next prompt, which is not what the
      // button says. The rules still gate the call; this only skips the card.
      if (isEdit && state.acceptEdits) return "once";
      let detail: string | undefined;
      if (isEdit) {
        try { detail = previewDiff(req.tool as "edit" | "write", req.revisedArgs, rt.cwd).text || undefined; } catch { detail = undefined; }
      }
      const answer = await renderer.askApproval(req.tool, JSON.stringify(req.revisedArgs).slice(0, 140), detail);
      if (answer !== "all-edits") return answer;
      // the surface-level door: flip the session and let THIS call through once. The core approval
      // engine stays a three-verdict system — "all-edits" never crosses into it.
      state.acceptEdits = true;
      renderer.addSystemNote(acceptEditsNote(true));
      pushStatus();
      return "once";
    });
    // port #20: per-mode model resolution + plan-mode rule/prompt enforcement
    const cur = modes.modelFor();
    const def = rt.buildDef({ provider: cur.provider, model: cur.model });
    applyModeToRun(modes, cfg, def);
    const views = new Map<string, AssistantView>();
    let lastView: AssistantView | null = null;
    runAbort = new AbortController();
    rt.tasks.bindRun(runAbort.signal); // port #26: Esc/quit cancel the background tasks THIS run starts; a normal end leaves them running
    run = agentLoop(def, goal, {}, cfg, {
      stream, registry: rt.registry, store,
      tools: rt.registry.list().map((t) => t.schema),
      guard: rt.guard, planReminder: rt.planReminder, signal: runAbort.signal, // port #21: Esc aborts this run's controller
      cwd: rt.cwd, // cwd must be threaded — tools resolve relative paths against it, same as checkpoints/LSP/preview
      hooks: rt.hooks, // port #29: pre_tool/approval/post_tool at dispatch, pre_run/compaction/post_run/on_event via the loop observer
    }, steering);
    try {
      for await (const ev of run) {
        renderer.onEvent?.(ev); // port #44: FIRST — the sextant reducer is its rows' source of truth; the calls below are duplicates it ignores while busy
        if (ev.type === "turn_start") { resetTurnFailureCount(); state.turns++; pushStatus(); } // pushStatus here + in the finally also refreshes the port #32 todo label after a todo_write
        else if (ev.type === "message_update") {
          let v = views.get(ev.messageId);
          if (!v) { v = renderer.beginAssistant(); views.set(ev.messageId, v); lastView?.done(); lastView = v; }
          v.append(ev.delta);
        } else if (ev.type === "tool_execution_start") {
          renderer.toolStart(ev.callId, ev.tool, JSON.stringify(ev.args).slice(0, 120));
        } else if (ev.type === "tool_execution_update") {
          renderer.toolUpdate(ev.callId, ev.note);
        } else if (ev.type === "tool_execution_end") {
          renderer.toolEnd(ev.callId, ev.ok, ev.output.slice(0, 160).replace(/\n/g, " ⏎ "), ev.durationMs);
        } else if (ev.type === "tool_call_failed") {
          renderer.toolEnd(ev.callId, false, `${ev.reason}: ${ev.detail}`.slice(0, 160), 0);
        } else if (ev.type === "compaction") {
          renderer.addSystemNote(compactionNote(ev)); // one wording with the replayed marker (port #25 LOW-4)
        } else if (ev.type === "steer") {
          renderer.addSystemNote("↪ steering applied");
        } else if (ev.type === "run_end") {
          lastView?.done();
          if (ev.status === "error") renderer.addSystemNote(ev.summary, "error");
          else if (ev.status !== "done") renderer.addSystemNote(`run ${ev.status}: ${ev.summary}`, "warn");
          // if the model produced no streaming deltas, surface the final text
          if (views.size === 0 && ev.status === "done" && ev.summary) {
            const v = renderer.beginAssistant(); v.append(ev.summary); v.done();
          }
        }
      }
    } finally {
      run = null; runAbort = null;
      state.busy = false;
      refreshUsage();
      // port #14: surface any fallback-chain advances the router made during the run
      for (const n of rt.drainRouterNotes()) renderer.addSystemNote(n, "warn");
      renderer.setBusy(false);
      pushStatus();
    }
  };

  /** A plain user turn — also the path custom commands submit their rendered prompt through (port #30). */
  const submit = (text: string): Promise<void> => {
    // port #34: text is required. The editor drops an empty Enter before onSubmit (pi-renderer.ts),
    // but a custom command whose template renders to "" (`/ask` on a bare `$ARGUMENTS`) lands here:
    // an empty goal never starts a run, is never queued as a steer, and leaves the stage (and any
    // pending mode switch) for the next real message
    if (!text.trim()) {
      const n = store.stagedAttachments.length;
      renderer.addSystemNote(n === 0 ? "nothing to send — the message is empty" : `type a message to send with the attached image${n === 1 ? "" : "s"}`, "warn");
      return Promise.resolve();
    }
    renderer.addUser(userTurnLine(text, store.stagedAttachments)); // port #34: image chips under the text — the stage folds into this message
    // port #20: a pending mode switch becomes a durable session entry on the next
    // submit (round-trip cancellation: toggling back before submitting records nothing)
    flushModeSwitch(modes, store);
    if (state.busy) { steering.push(text); renderer.addSystemNote(`queued as steering (applies before the next model turn)${queuedAttachNote(store)}`); return Promise.resolve(); }
    return startRun(text);
  };
  // port #44: a renderer with panels (sextant) reads the runtime through this handle — once, before start()
  renderer.attach?.(buildSextantAttach({ cwd: rt.cwd, sessionsDir, store: () => store, tasks: rt.tasks, model: () => modes.modelFor(), catalog, petName: opts.pet }));
  renderer.setCommands([...TUI_COMMANDS, ...commandsForPalette(custom.commands)]);
  renderer.start({
    onSubmit: (text) => { if (text.startsWith("/")) handleSlash(text); else void submit(text); },
    // port #21: abort FIRST (kills in-flight fetch/subprocesses), then return() settles the generator
    onInterrupt: () => { runAbort?.abort(); void run?.return(undefined as never); renderer.addSystemNote("run interrupted", "warn"); },
    onExit: close,
  });
  // resumed boot: restore the transcript and usage counters (a bare session open left both blank)
  if (boot.id !== undefined) { replayHistory(); refreshUsage(); }
  // the welcome card (core/voice.ts): a fresh session opens with rovecode's card — connected, or the /setup
  // pointer when no model is configured; a resumed session keeps its transcript and gets one line
  const connected = rt.stream && rt.noProviderReason() === null ? { provider: state.provider, model: state.model } : null;
  if (boot.id !== undefined) renderer.addSystemNote(resumedLine(store.id, rt.cwd, state.yolo));
  else renderer.addSystemNote(welcomeCard({ connected, cwd: rt.cwd, yolo: state.yolo, mode: state.mode }));
  if (boot.warn) renderer.addSystemNote(boot.warn, "warn");
  for (const w of custom.warnings) renderer.addSystemNote(w, "warn"); // port #30: skipped/shadowed command files
  for (const w of rt.providers.warnings()) renderer.addSystemNote(`providers: ${w}`, "warn"); // malformed providers.json entries
  rt.hooks.onWarning((w) => renderer.addSystemNote(`hooks: ${w}`, "warn")); // port #29: hook load/runtime notes (buffered ones replay first)
  rt.plugins.onWarning((w) => renderer.addSystemNote(`plugins: ${w}`, "warn")); // plugin discovery/activation notes, the same way
  pushStatus();
  watchProviders(provCtx()); // follow a default-model change made elsewhere; announce the first provider
  // port #27: an unavailable configured rung (probe failed) is a clean one-line startup
  // error — stop the renderer first so the terminal is restored, reap the MCP children
  // construction spawned (LOW-3, as bootRuntime does), then exit 2 (embedders: rethrow)
  await rt.sandbox.ready.catch(async (e: unknown) => {
    renderer.stop();
    await rt.hooks.close().catch(() => {}); // port #29: a runtime exists (session_open fired) — session_close before this exit too
    await rt.mcp?.close().catch(() => {});
    if (e instanceof SandboxConfigError && opts.exitOnClose !== false) { console.error(`error: ${e.message}`); process.exit(2); }
    throw e;
  });
  await closedP;
}
