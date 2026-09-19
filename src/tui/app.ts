/** TUI chat app (port #1): wires the ONE agentLoop (ADR-003) into a Renderer.
 *  All vendor contact lives behind Renderer (renderer.ts) — swap-friendly. Slash handlers live
 *  beside it (ADR-002 cap): info-cmd.ts (/help /status /cost /skills /memory /export /todos
 *  /tasks), session-cmd.ts (/new /rewind /sessions /resume), checkpoints-cmd.ts, modes-cmd.ts. */

import { agentLoop, outstandingClause, outstandingTone } from "../core/loop.ts";
import { resetTurnFailureCount } from "../memory/tools.ts";
import { createRuntime } from "../cli/runtime.ts";
import { SandboxConfigError } from "../core/sandbox-config.ts";
import { SessionStore } from "../core/session.ts";
import { adoptLegacyMemory } from "../memory/scope.ts";
import { runMemoryNote } from "./memory-note.ts";
import { runShellLine, shellLine, type ShellCtx } from "./shell-cmd.ts";
import { cmdCommit, cmdUndo, type GitCmdCtx } from "./git-cmds.ts"; // port #65: /commit /undo
import { ModelCatalog } from "../providers/catalog.ts";
import { ModeManager, loadModesConfig, modeFromEntries, type AgentMode } from "../core/modes.ts";
import { isTerminal, taskNote } from "../core/tasks.ts";
import { togglePlanAct, applyModeToRun, flushModeSwitch } from "./modes-cmd.ts";
import { cmdCheckpoints, cmdRestore, type CheckpointCmdCtx } from "./checkpoints-cmd.ts";
import type { SessionCmdCtx } from "./session-cmd.ts";
import type { InfoCmdCtx } from "./info-cmd.ts";
import { todoLabel } from "./todo-label.ts";
import { cmdAttach, cmdPasteImage, carryOverAttachments, queuedAttachNote, userTurnLine, type AttachCtx } from "./attach.ts";
import { cmdConnect, cmdModel as cmdModelSwitch, cmdModels, cmdProvider, cmdSetup, listModelIds, watchProviders, MODEL_COMMAND, type ProviderCmdCtx } from "./providers-cmd.ts";
import { SETUP_PICKS } from "../cli/setup.ts";
import { isConfigured } from "../providers/provider-config.ts";
import { cmdMcp } from "./mcp-cmd.ts";
import { cmdTrustCard } from "./trust-card.ts";
import { ReasoningViews } from "./reasoning-view.ts";
import { cmdAgents } from "./agents-cmd.ts";
import { cmdConfigView } from "./config-view.ts";
import { runContextCommand, type ContextCmdCtx } from "./context-cmds.ts"; // port #53
import { emitBootNotes } from "./boot-notes.ts"; // boot-note extraction port
import { waitForStartup } from "./startup.ts";
import { acceptEditsNote, effortNote, modeSwitchNote, noModelHint } from "../core/voice.ts";
import { checkForUpdate, updateLine } from "../core/update-check.ts";
import pkg from "../../package.json";
import { rovecodeHome, saveCredential } from "../providers/auth.ts";
import { installCrashGuard } from "./crash-guard.ts";
import { compactionNote } from "./replay-marker.ts";
import { previewDiff } from "../coding/diff.ts";
import { discoverCommands, commandsForPalette, dispatchCustomCommand, type CustomCommandCtx } from "./commands.ts";
import type { Renderer, AssistantView, StatusInfo } from "./renderer.ts";
// pi-renderer.ts (and the vendored pi-tui under it) costs ~27 MB resident; a sextant session never
// constructs it, so it is required where it is constructed, not imported here (tests: pi-renderer-lazy)
type PiRendererMod = typeof import("./pi-renderer.ts");
import { buildSextantAttach, SEXTANT_LOCAL_NAMES } from "./sextant-attach.ts";
import type { ApprovalFn, ModelRef, PermissionLevel, RunEvent, ThinkingEffort } from "../core/types.ts";
import { thinkingLine } from "../providers/thinking.ts";
import { anthropicShapeFor } from "../providers/stream.ts";
import { parseEffort, THINKING_EFFORTS } from "../core/types.ts";
import { resolvePermission, saveSetting } from "../core/settings.ts";
import { TUI_COMMANDS, type TuiAppOptions } from "./tui-commands.ts"; // options/table extraction port
export { TUI_COMMANDS, type TuiAppOptions } from "./tui-commands.ts"; // existing import paths keep working
import { join } from "node:path";

export { buildCostNote } from "./cost.ts"; // moved for the ADR-002 cap; re-exported for tests

// lazy loaders — info-cmd and session-cmd are deferred until the first slash command
type InfoCmdMod = typeof import("./info-cmd.ts");
let _infoCmdMod: InfoCmdMod | null = null;
function lazyInfoCmd(): InfoCmdMod {
  if (_infoCmdMod === null) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    _infoCmdMod = require("./info-cmd.ts") as InfoCmdMod;
  }
  return _infoCmdMod;
}

type SessionCmdMod = typeof import("./session-cmd.ts");
let _sessionCmdMod: SessionCmdMod | null = null;
function lazySessionCmd(): SessionCmdMod {
  if (_sessionCmdMod === null) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    _sessionCmdMod = require("./session-cmd.ts") as SessionCmdMod;
  }
  return _sessionCmdMod;
}

type SessionManageMod = typeof import("./session-manage.ts");
let _sessionManageMod: SessionManageMod | null = null;
function lazySessionManage(): SessionManageMod {
  if (_sessionManageMod === null) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    _sessionManageMod = require("./session-manage.ts") as SessionManageMod;
  }
  return _sessionManageMod;
}

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
  const _t0 = process.env.ROVECODE_TRACE_BOOT === "1" ? (Number(process.env._ROVECODE_BOOT_T0) || Date.now()) : -1;
  const _trace = _t0 >= 0 ? (label: string) => process.stderr.write(`[boot] +${Date.now() - _t0}ms ${label}\n`) : (_: string) => {};
  _trace("runTui entered");
  opts.startup?.signal?.throwIfAborted();
  opts.startup?.status("loading workspace");
  // opts.sessionId is already the full id of an existing session, or undefined (see TuiAppOptions.sessionId)
  const boot = { id: opts.sessionId, warn: opts.bootNote };
  // opts.stream passes through verbatim: a StreamFn overrides, explicit null forces
  // "no provider", undefined defers to the runtime's env-resolved provider
  // port #27: a sandbox MISCONFIG throws synchronously here (before any side effect) — a clean
  // one-line startup error (exit 2), never a stack, never a silent direct fallback. The rung
  // PROBE verdict (rt.sandbox.ready) is awaited at the end of boot: runTui must stay
  // synchronous until the renderer's input handlers are wired (tests/smoke send input right
  // after calling runTui), so no await may sit above that point.
  const rt = (() => {
    try {
      _trace("createRuntime start");
      const r = createRuntime({ cwd: opts.cwd, stream: opts.stream, sessionId: boot.id, spawnRunner: opts.spawnRunner, platform: opts.platform, ...(opts.addDirs !== undefined ? { addDirs: opts.addDirs } : {}) });
      _trace("createRuntime done");
      return r;
    }
    catch (e) {
      if (e instanceof SandboxConfigError && opts.exitOnClose !== false) { console.error(`error: ${e.message}`); process.exit(2); }
      throw e;
    }
  })();
  const renderer: Renderer = opts.renderer ?? new (require("./pi-renderer.ts") as PiRendererMod).PiTuiRenderer({ cwd: rt.cwd }); // eslint-disable-line @typescript-eslint/no-require-imports
  _trace("renderer created");
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
  // opts.permission is the flag rung for in-process callers; yolo/acceptEdits stay the boolean flags they were
  // (true = demand, false = say nothing) — see TuiAppOptions.permission for why false cannot mean "ask"
  const flagLevel: PermissionLevel | undefined = opts.permission ?? (opts.yolo === true ? "auto" : opts.acceptEdits === true ? "accept-edits" : undefined);
  const startLevel = resolvePermission(rt.cwd, flagLevel, { ROVECODE_PERMISSION: process.env.ROVECODE_PERMISSION, ROVECODE_YOLO: process.env.ROVECODE_YOLO, ROVECODE_ACCEPT_EDITS: process.env.ROVECODE_ACCEPT_EDITS });
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

  /** set once the surface owns the screen (below renderer.start); puts Node's warning printer back */
  let restoreWarnings: (() => void) | undefined;
  /** set once renderer.start() has put the terminal into raw/alt mode (crash-guard.ts); cleared on a
   *  clean quit, which performs its own restore and its own process.exit — a guard still listening
   *  would restore a second time and log an "exit" it caused itself. */
  let uninstallCrashGuard: (() => void) | null = null;
  const close = (exitProcess = true) => {
    if (closed) return;
    closed = true;
    uninstallCrashGuard?.(); uninstallCrashGuard = null;
    // port #20 MED-2: /plan then quit resumes in plan (append is sync — lands pre-exit)
    flushModeSwitch(modes, store);
    runAbort?.abort(); // abort kills in-flight fetch/tools; return() settles the generator — kept, so the exit below waits for it
    const settled = run?.return(undefined as never).then(() => undefined, () => undefined) ?? Promise.resolve();
    const mapSettled = rt.stopRepoMapWarmup(); // no background scan or cache write after the app resolves
    rt.tasks.cancelAll(); // port #26: background children die with the surface, never after it
    const mcpSettled = rt.mcp?.close().catch(() => {}); // stop and drain MCP child processes/connections
    restoreWarnings?.();   // the screen is going away; Node's own printer is the right one again
    renderer.stop();
    // port #29: session_close fires ONCE, after the aborted run settled and its in-flight on_event
    // taps drained (hooks.close() waits for those) — cmdRun's exit() order; the app promise
    // resolves (and the process exits) only after it, so a quit never outruns the hook
    void (async () => {
      await Promise.all([settled, mapSettled, mcpSettled]);
      await rt.hooks.close().catch(() => {});
      // the sextant renderer's git children (repo watcher) must be GONE before the process exits — on
      // Windows a live child holds its cwd, so a scratch repo removed at quit throws EBUSY (fee2e8c root
      // cause). Optional: the Renderer seam stays untouched; FakeRenderer and pi-tui have no drain()
      await (renderer as { drain?: () => Promise<void> }).drain?.()?.catch(() => {});
      resolveClosed();
      if (exitProcess && opts.exitOnClose !== false) process.exit(0);
    })();
  };

  // both read the ACTIVE store live — /sessions and a root /rewind swap it (session-cmd.ts helpers)
  const refreshUsage = () => { const u = lazySessionCmd().usageOf(store); state.tokensIn = u.tokensIn; state.tokensOut = u.tokensOut; };
  const replayHistory = () => lazySessionCmd().replayTranscript(renderer, store);
  // port #34: /attach context — the stage lives on the ACTIVE store (read live); the vision check uses the current mode's model
  const attachCtx: AttachCtx = { renderer, cwd: rt.cwd, store: () => store, modelRef: () => modes.modelFor() };

  const switchSession = (id: string, announce = true) => {
    flushModeSwitch(modes, store); // port #20 MED-2: don't discard a pending switch on /sessions away
    const pending = store.stagedAttachments; // port #34: the stage lives on the instance — re-staged on the new one below
    store = new SessionStore(sessionsDir, id);
    // memory is PROJECT-scoped (memory/scope.ts), so switching sessions KEEPS the store — it is the same project.
    // The exception: a switched-to session that still carries a legacy per-session store copies it forward once,
    // and then the prompt should show the migrated text now rather than next run, so that hands back a fresh store.
    const adopted = adoptLegacyMemory(rt.cwd, sessionsDir, id);
    if (adopted.blocks) blocks = adopted.blocks;
    if (adopted.note !== null) for (const line of adopted.note.split("\n")) renderer.addSystemNote(line);
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
    cwd: rt.cwd, // /sessions delete removes the checkpoints shadow dir under the cwd as well (session-manage.ts)
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

  // port #53: context commands (/compact /clear /init /copy) — store/modes read live, like sessCtx;
  // bindAbort is the app's interrupt target (runAbort), the same seam `!cmd` holds its child under
  const ctxCmdCtx: ContextCmdCtx = {
    renderer, cwd: rt.cwd,
    busy: () => state.busy,
    store: () => store,
    modes, state,
    defaultMode: modesCfg.defaultMode ?? "act",
    buildCfg: () => rt.buildCfg(permissionLevel(), humanApprover()),
    // no summarizer is wired on this tree (context-cmds.ts header): /compact falls back to
    // keep-window and says so — the seam is here for #68's runtime wiring to fill
    bindAbort: (ac) => { runAbort = ac; },
    switchSession,
    replayHistory,
    refreshUsage,
    pushStatus,
    submit: (t) => submit(t),
  };

  // /model /models /provider (providers-cmd.ts) read the live registry; built lazily so pushStatus is bound
  const provCtx = (): ProviderCmdCtx => ({ rt, modes, state, renderer, pushStatus, catalog }); // port #60: existing picker reads /cost metadata
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

  /** what the CURRENT model's endpoint receives for a level — the /effort note's second line (providers/thinking.ts).
   *  Built like buildDef builds a ref (catalog reasoning flag), without touching the runtime's active model. */
  const receives = (level: ThinkingEffort): string => {
    const info = catalog.lookup(state.provider, state.model);
    const ref: ModelRef = { provider: state.provider, model: state.model, effort: level, ...(info?.supportsReasoning !== undefined ? { reasoning: info.supportsReasoning } : {}) };
    return thinkingLine(ref, rt.providers.get(state.provider)?.protocol ?? "openai", { shape: anthropicShapeFor(ref) });
  };

  /** the /mouse toggle's memory: sextant starts with tracking ON (enterSequence), the app mirrors it */
  let mouseOn = true;
  const handleSlash = (text: string): boolean => {
    const [cmd, ...rest] = text.slice(1).split(/\s+/);
    const arg = rest.join(" ").trim();
    switch (cmd) {
      case "exit": case "quit": close(); return true;
      case "help": lazyInfoCmd().cmdHelp(infoCtx); return true;
      case "mouse": {
        const want = (arg.length > 0 ? arg : "toggle").toLowerCase();
        if (want !== "on" && want !== "off" && want !== "toggle") {
          renderer.addSystemNote(`usage: /mouse on | off | toggle — "off" hands the drag to the terminal so you can select and copy text`, "warn");
          return true;
        }
        if (!renderer.setMouse) {
          renderer.addSystemNote("this view never captures the mouse — select and copy with the terminal as usual");
          return true;
        }
        mouseOn = want === "toggle" ? !mouseOn : want === "on";
        renderer.setMouse(mouseOn);
        renderer.addSystemNote(mouseOn
          ? "mouse on — clicks, panel focus and scrollbar dragging are back"
          : "mouse off — drag to select and copy text in any panel; /mouse on brings the clicks back (Shift+drag also works while the mouse is on)");
        return true;
      }
      case "effort": {
        const want = arg.trim();
        if (want.length === 0) { renderer.addSystemNote(effortNote(rt.effort, receives(rt.effort))); return true; }
        const level = parseEffort(want);
        if (level === undefined) { renderer.addSystemNote(`"${want}" is not a level — ${THINKING_EFFORTS.join(" · ")}`, "warn"); return true; }
        rt.setEffort(level);
        renderer.addSystemNote(effortNote(level, receives(level)));
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
      case "setup": void cmdSetup(provCtx()); return true; // the classic chain; the cockpit answers /setup with the wizard before handleSlash runs
      // the same job on one line (cli/connect.ts through the live registry); bare, it hands over to /setup
      case "connect": void cmdConnect(provCtx(), arg); return true;
      case "plan": case "act":
        togglePlanAct(modes, cmd as AgentMode, state, renderer, pushStatus);
        return true;
      case "checkpoints": void cmdCheckpoints(cpCtx); return true;
      case "restore": void cmdRestore(cpCtx, arg); return true;
      case "commit": void cmdCommit(gitCtx, text.slice(1 + (cmd ?? "").length)); return true; // port #65: RAW remainder — a message body keeps its newlines
      case "undo": void cmdUndo(gitCtx); return true; // port #65
      case "status": lazyInfoCmd().cmdStatus(infoCtx); return true;
      case "cost": lazyInfoCmd().cmdCost(infoCtx, arg); return true;
      case "skills": lazyInfoCmd().cmdSkills(infoCtx); return true;
      case "memory": lazyInfoCmd().cmdMemory(infoCtx, arg); return true; // bare = show both blocks; `--user` one; with text = append (memory-note.ts)
      case "todos": lazyInfoCmd().cmdTodos(infoCtx); return true; // port #32
      case "tasks": lazyInfoCmd().cmdTasks(infoCtx, arg); return true; // port #26
      case "new": lazySessionCmd().cmdNew(sessCtx); return true;
      case "rewind": case "tree": void lazySessionCmd().cmdRewind(sessCtx); return true;
      case "sessions": void lazySessionManage().cmdSessionsVerb(sessCtx, arg); return true; // bare = the picker; rename/delete/fork/search = session-manage.ts
      case "compact": case "clear": case "init": case "copy": void runContextCommand(ctxCmdCtx, cmd ?? "", arg); return true; // port #53
      case "trust": void cmdTrustCard({ renderer, cwd: rt.cwd }, arg); return true; // the project trust gate, answerable without quitting (trust-card.ts)
      case "agents": cmdAgents({ renderer, agents: rt.agents }); return true; // the definitions list (port #62); the BARE /agents is the sextant crew board (local-commands.ts pass-through: only "/agents list" reaches here)
      case "config": cmdConfigView({ renderer, cwd: rt.cwd }, arg); return true; // the read-only settings view (config-view.ts): what THIS run actually loads
      case "resume":
        if (arg) void lazySessionCmd().cmdSessions(sessCtx, arg); else void lazySessionCmd().cmdSessions(sessCtx);
        return true;
      case "export": lazyInfoCmd().cmdExport(infoCtx, arg); return true;
      case "attach": cmdAttach(attachCtx, arg); return true; // port #34
      case "paste": cmdPasteImage(attachCtx); return true;    // clipboard image → attachment (⌃v)
      case "mcp": void cmdMcp({ renderer, cwd: rt.cwd }, arg); return true; // the MCP market (mcp-cmd.ts): palette → approval card → mcp.json
      default:
        // port #30: a discovered custom command renders its template and submits it as a user turn.
        // MED-2: it gets the RAW remainder of the line (whitespace runs and pasted newlines intact —
        // renderCommand trims the ends itself); built-ins keep the collapsed `arg` above.
        if (!dispatchCustomCommand(cmdCtx, custom.commands, cmd ?? "", text.slice(1 + (cmd ?? "").length))) renderer.addSystemNote(`unknown command: /${cmd} (try /help)`, "warn");
        return true;
    }
  };

  /** the session's permission level as a model turn would run under */
  const permissionLevel = (): PermissionLevel => state.yolo ? "auto" : state.acceptEdits ? "accept-edits" : "ask";

  /** THE human approver — one implementation for a model-issued call and for the person's own `!cmd`, so the diff
   *  preview and the "all edits" door behave identically either way. undefined under `auto`: nothing is asked. */
  const humanApprover = (): ApprovalFn | undefined => state.yolo ? undefined : async (req) => {
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
  };

  /** `!cmd` (tui/shell-cmd.ts): the person's own command, through the same dispatch, rules and approver */
  const shellCtx: ShellCtx = {
    renderer, rt, store: () => store,
    level: permissionLevel,
    approve: humanApprover,
    busy: () => state.busy,
    setBusy: (b) => { state.busy = b; pushStatus(); },
    bindAbort: (ac) => { runAbort = ac; },
  };

  // port #65 (tui/git-cmds.ts): /commit and /undo run on the SAME seams as `!cmd` — one busy flag,
  // one abort binding, one approver — plus the router (the COMMIT role drafts the message) and the
  // session's checkpoints (/undo restores through them; the conversation is left to /restore).
  const gitCtx: GitCmdCtx = {
    renderer, rt, store: () => store,
    approve: humanApprover,
    yolo: () => state.yolo,
    busy: () => state.busy,
    setBusy: (b) => { state.busy = b; pushStatus(); },
    bindAbort: (ac) => { runAbort = ac; },
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
    const level = permissionLevel();
    const cfg = rt.buildCfg(level, humanApprover());
    // port #20: per-mode model resolution + plan-mode rule/prompt enforcement
    const cur = modes.modelFor();
    const def = rt.buildDef({ provider: cur.provider, model: cur.model });
    applyModeToRun(modes, cfg, def);
    const views = new Map<string, AssistantView>();
    const reasoning = new ReasoningViews(renderer); // port #60: one collapsed reasoning block per assistant message
    let lastView: AssistantView | null = null;
    runAbort = new AbortController();
    // port #26: Esc/quit cancel the background tasks THIS run starts; a normal end leaves them running.
    // The label is the run's own prompt: it titles the crew card that groups this run's agents
    // (sextant/crew-cards.ts). tasks.ts one-lines and clips it — a surface passes what the person typed.
    rt.tasks.bindRun(runAbort.signal, { label: goal });
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
        reasoning.onEvent(ev); // port #60: reasoning_update → the collapsed block (settled when the text starts)
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
        } else if (ev.type === "verify") {
          // the verify gate (core/verify-gate.ts): say that the check is running — a silent two minutes reads as a hang
          renderer.addSystemNote(ev.state === "running" ? `⧗ verify: ${ev.command.slice(0, 120)}` : `verify ${ev.state}: ${ev.detail ?? ""}`, ev.state === "running" || ev.state === "passed" ? "info" : "warn");
        } else if (ev.type === "run_end") {
          lastView?.done();
          if (ev.status === "error") renderer.addSystemNote(ev.summary, "error");
          else if (ev.status !== "done") renderer.addSystemNote(`run ${ev.status}: ${ev.summary}`, "warn");
          else if (ev.outstanding) { const c = outstandingClause(ev.outstanding); if (c !== null) renderer.addSystemNote(`done · ${c}`, outstandingTone(ev.outstanding)); } // "done" ≠ finished: say what was left (core/loop.ts)
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
  const failedStartup = async (e: unknown): Promise<never> => {
    opts.startup?.finish();
    close(false);
    await closedP;
    if (e instanceof SandboxConfigError && opts.exitOnClose !== false) { console.error(`error: ${e.message}`); process.exit(2); }
    throw e;
  };
  const ready = async (): Promise<void> => {
    try { await waitForStartup(rt.sandbox.ready, opts.startup?.signal); }
    catch (e) { await failedStartup(e); }
  };
  // CLI startup keeps the intro on screen through the required probe. Embedders without a loading
  // screen retain the synchronous input-wiring contract (tests may type immediately after runTui()).
  if (opts.startup) { opts.startup.status("checking sandbox"); await ready(); opts.startup.status("preparing interface"); }
  // port #44: a renderer with panels (sextant) reads the runtime through this handle — once, before start()
  _trace("renderer.attach");
  renderer.attach?.(buildSextantAttach({
    cwd: rt.cwd, sessionsDir, store: () => store, tasks: rt.tasks, model: () => modes.modelFor(), catalog, runtime: () => rt, petName: opts.pet,
    // the connect wizard's registry seams (draw-wizard.ts): the same ones /setup walks — SETUP_PICKS
    // for the rows, saveCredential + refresh for the key, reg.models for the list, probe + setDefault
    // for the test. Classic keeps cmdSetup's pickOne chain; only the sextant surface opens the wizard.
    wizard: {
      // the LIVE registry is the list: configured providers first (the ones one ⏎ from working),
      // then every other row the registry knows (built-ins without a key, custom rows like a proxy
      // added with /provider add), then the two "your own URL" doors. SETUP_PICKS alone hid the
      // person's own rows — a default of kaesra or an hn added by hand never appeared, and the
      // walk had no way to reach them.
      providers: () => {
        const rows: { key: string; label: string; configured?: boolean; local?: boolean; url?: "openai" | "anthropic" }[] = [];
        const seen = new Set<string>();
        const ordered = [...rt.providers.list()].sort((a, b) => Number(isConfigured(b)) - Number(isConfigured(a)));
        for (const p of ordered) {
          if (seen.has(p.id) || p.id === "custom") continue; // the env ROVECODE_BASE_URL pair is not a wizard row
          seen.add(p.id);
          rows.push({ key: p.id, label: p.id === "kaesra" ? "kaesra — the default host" : p.id, ...(isConfigured(p) ? { configured: true } : {}), ...(p.noKey === true ? { local: true } : {}) });
        }
        for (const p of SETUP_PICKS) if (p.url !== undefined) rows.push({ key: p.key, label: p.label, url: p.url });
        return rows;
      },
      // a url door (SETUP_PICKS 8/9): register the row FIRST — without it, KEY had "unknown provider 8"
      register: (id, url, protocol) => {
        const r = rt.providers.add({ id, baseUrl: url, protocol }, "user");
        return "error" in r ? { ok: false, error: r.error } : { ok: true };
      },
      storeKey: (provider, secret) => {
        try {
          // a registry row's key IS its id; a url door was rewritten to its id at registration
          const row = rt.providers.get(provider);
          const id = row?.id ?? provider;
          if (row === undefined) return { ok: false, error: `unknown provider "${provider}"` };
          saveCredential(row.id, secret, row.keyEnv);
          rt.providers.refresh();
          return { ok: true };
        } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
      },
      models: async (provider) => {
        const id = provider; // a registry row's key is its id; a door key never reaches here (it registers first)
        const row = rt.providers.get(id);
        // each row carries the provider's OWN facts so the step's checked set can seed from them:
        // `active` = pinned today (spec.models), `defaultModel` = the row's default. The list itself
        // is the same source /models reads — a pinned provider serves its file list, an unpinned one
        // its endpoint — so the rows and what /models would answer cannot disagree.
        const pinned = new Set(row?.models ?? []);
        const def = row?.defaultModel;
        const rows: { id: string; note?: string; active?: boolean; defaultModel?: boolean }[] = [];
        const mark = (m: string): void => {
          rows.push({ id: m, ...(pinned.has(m) ? { active: true } : {}), ...(m === def ? { defaultModel: true, note: "default" } : {}) });
        };
        const r = await rt.providers.models(id);
        if (r.ok) { for (const m of r.models) if (!rows.some((x) => x.id === m)) mark(m); }
        // a pinned list the endpoint no longer names still shows (the file is the truth until edited);
        // fetch failed AND nothing pinned: an empty list → the caller falls back to typing the id
        for (const m of pinned) if (!rows.some((x) => x.id === m)) mark(m);
        return rows;
      },
      // the model step's ACTIVATE answer: pin the checked rows as the provider's active list
      // (spec.models — /models serves them from the file after this), or un-pin with an empty
      // list ("use them all": the endpoint is asked every time, nothing frozen). `makeDefault`
      // also becomes the row's default and the session's model, like the test step does.
      activateModels: (provider, models, makeDefault) => {
        const id = provider;
        if (rt.providers.get(id) === undefined) return { ok: false, error: "no provider behind this row" };
        const r = rt.providers.setModels(id, models, "user");
        if ("error" in r) return { ok: false, error: r.error };
        if (makeDefault !== undefined) {
          const d = rt.providers.setDefault(`${id}/${makeDefault}`, "user");
          if (!("error" in d)) {
            modes.setModel({ provider: d.provider, model: d.model });
            state.provider = modes.modelFor().provider;
            state.model = modes.modelFor().model;
            pushStatus();
          }
        }
        return { ok: true, ...r };
      },
      test: async (provider, model) => {
        const id = provider;
        if (rt.providers.get(id) === undefined) return { ok: false, detail: "no provider behind this row" };
        const probe = await rt.providers.probe(id, model);
        if (!probe.ok) return { ok: false, detail: probe.detail };
        const d = rt.providers.setDefault(`${id}/${model}`, "user");
        if ("error" in d) return { ok: false, detail: d.error };
        // the session switches with the default (providers-cmd applyRef's three lines, inlined —
        // that helper needs a ProviderCmdCtx; the wizard seam already holds the same pieces)
        modes.setModel({ provider: d.provider, model: d.model });
        state.provider = modes.modelFor().provider;
        state.model = modes.modelFor().model;
        pushStatus();
        return { ok: true, detail: `${probe.detail} — default → ${id}/${model}` };
      },
    },
  }));
  // /model suggestions: the ids of every configured provider's models, fetched off the boot path and again
  // whenever the registry changes; the sextant reads the list at suggestion time (SlashCommand.choices)
  const modelChoices: string[] = [];
  const refreshModelChoices = (): void => { void listModelIds(rt.providers).then((ids) => { modelChoices.splice(0, modelChoices.length, ...ids); }).catch(() => {}); };
  renderer.setCommands([...TUI_COMMANDS.map((c) => (c.name === MODEL_COMMAND.name ? { ...c, choices: () => modelChoices } : c)), ...commandsForPalette(custom.commands)]);
  setTimeout(refreshModelChoices, 0);
  // Node prints warnings on stderr, and stderr goes straight onto the alternate screen. A
  // MaxListenersExceededWarning does not just say its sentence — it dumps the emitter it is complaining
  // about, which for a stream is pages of `[Function: …]`, over the panels. Berkay hit exactly that
  // during a Playwright MCP session (the leak itself is fixed in mcp/client.ts; this is the other half:
  // no warning from anywhere should be able to garble the screen). Node's own printer is removed and the
  // warning becomes a note — still said, never drawn over anything — and put back on the way out.
  const nodeWarnListeners = process.listeners("warning");
  // assigned here, read by `close` above (declared before this point, called only after start)
  process.removeAllListeners("warning");
  const onWarning = (w: Error): void => {
    // the first line only: a MaxListenersExceededWarning's body is the emitter it is complaining about
    const first = w.message.split("\n")[0] ?? w.message;
    renderer.addSystemNote(`node: ${w.name === "Warning" ? "" : `${w.name}: `}${first}`, "warn");
  };
  process.on("warning", onWarning);
  restoreWarnings = (): void => {
    process.off("warning", onWarning);
    for (const l of nodeWarnListeners) process.on("warning", l as (w: Error) => void);
  };
  let seeded = false;
  const seed = (): void => {
    if (seeded) return;
    seeded = true;
    if (boot.id !== undefined) { replayHistory(); refreshUsage(); }
    emitBootNotes({ renderer, rt, yolo: state.yolo, modelRef: state, mode: state.mode, version: pkg.version, width: process.stdout.columns ?? 80, sessionId: boot.id !== undefined ? store.id : undefined, bootWarn: boot.warn, commandWarnings: custom.warnings });
    pushStatus();
  };
  let revealed = false;
  const reveal = (): void => {
    if (revealed) return;
    opts.startup?.signal?.throwIfAborted();
    revealed = true;
    _trace("complete first frame ready; releasing intro");
    opts.startup?.finish();
  };
  _trace("renderer.start");
  try {
    const starting = renderer.start({
      // `#<text>` is a memory note, not a prompt: it short-circuits before any model turn (tui/memory-note.ts),
      // the way `/` does. The classifier is narrow on purpose — a pasted `#include` block or a `# heading` is a
      // prompt for the model, so only a single line of `#` + a letter or digit is taken as a note.
      onSubmit: (text) => {
        if (text.startsWith("/")) handleSlash(text);
        else if (runMemoryNote({ renderer, blocks: () => blocks }, text)) return;
        else if (shellLine(text) !== null) void runShellLine(shellCtx, text);
        else void submit(text);
      },
      // port #21: abort FIRST (kills in-flight fetch/subprocesses), then return() settles the generator
      onInterrupt: () => { runAbort?.abort(); void run?.return(undefined as never); renderer.addSystemNote("run interrupted", "warn"); },
      onExit: () => close(),
    }, { beforeFirstRender: seed, onReveal: reveal, ...(opts.startup ? {
      animate: false,
      beforeReveal: () => {
        _trace("first frame prepared; waiting for intro");
        return waitForStartup(opts.startup?.animationDone ?? Promise.resolve(), opts.startup?.signal);
      },
    } : {}) });
    seed(); // compatibility with injected renderers that ignore beforeFirstRender
    rt.warmRepoMap(); // cooperate with the intro while the prepared scene waits to be revealed
    if (starting) await waitForStartup(starting, opts.startup?.signal);
    reveal(); // legacy renderers without the optional handoff callback
  } catch (e) { await failedStartup(e); }
  if (closed) { await closedP; return; }
  _trace("interface ready");
  // From here the terminal is in a mode the shell cannot live in: alt screen, raw stdin, mouse and focus
  // reporting. `close()` undoes all of it; a crash used to undo none of it, leaving the prompt inside the
  // alt screen under a frame that never erased, with every mouse movement typing escape sequences at it.
  // The guard restores the terminal FIRST and only then writes the reason to a file — the screen a stack
  // trace would print on is the one the restore erases, so the file is the only copy that survives.
  uninstallCrashGuard = installCrashGuard({
    restore: () => renderer.restoreTerminal?.(),
    logDir: join(rovecodeHome(), "logs"),
    version: pkg.version,
  });
  // The update fetch stays outside the note emitter: fresh sessions only, never blocking the first prompt.
  if (boot.id === undefined) void checkForUpdate(pkg.version).then((s) => { const l = updateLine(s); if (l !== null) renderer.addSystemNote(l); }).catch(() => {});
  watchProviders(provCtx()); // follow a default-model change made elsewhere; announce the first provider
  if (!opts.startup) await ready();
  await closedP;
}
