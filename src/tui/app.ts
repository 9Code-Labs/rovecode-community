/** TUI chat app (port #1): wires the ONE agentLoop (ADR-003) into a Renderer.
 *  All vendor contact lives behind Renderer (renderer.ts) — swap-friendly. */

import { agentLoop, SteeringQueue, partsText } from "../core/loop.ts";
import { resetTurnFailureCount } from "../memory/tools.ts";
import { createRuntime } from "../cli/runtime.ts";
import { SandboxConfigError, describeSandbox } from "../core/sandbox-config.ts";
import { SessionStore, listSessions } from "../core/session.ts";
import { BlockStore } from "../memory/blocks.ts";
import { ModelCatalog } from "../providers/catalog.ts";
import { ModeManager, loadModesConfig, modeFromEntries, type AgentMode } from "../core/modes.ts";
import { togglePlanAct, applyModeToRun, flushModeSwitch, replayLabel } from "./modes-cmd.ts";
import { cmdCheckpoints, cmdRestore, type CheckpointCmdCtx } from "./checkpoints-cmd.ts";
import { cmdRewind, cmdSessions, cmdNew, type SessionCmdCtx } from "./session-cmd.ts";
import { buildCostNote } from "./cost.ts";
import { exportSession } from "../cli/export.ts";
import { previewDiff } from "../coding/diff.ts";
import type { Renderer, AssistantView, StatusInfo } from "./renderer.ts";
import { PiTuiRenderer } from "./pi-renderer.ts";
import type { RunEvent, StreamFn } from "../core/types.ts";
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
}

export const TUI_COMMANDS = [
  { name: "help", description: "Show commands" },
  { name: "exit", description: "Quit aion" },
  { name: "yolo", description: "Toggle gated/yolo permissions" },
  { name: "model", description: "Switch model: /model <id>" },
  { name: "status", description: "Provider, model, turns, tokens" },
  { name: "skills", description: "List installed skills" },
  { name: "memory", description: "Show memory blocks" },
  { name: "new", description: "Branch back to session start" },
  { name: "cost", description: "Session tokens, cache hits, USD estimate (/cost refresh: update pricing)" },
  { name: "rewind", description: "Jump to an earlier turn and edit it (alias: /tree)" },
  { name: "tree", description: "Alias of /rewind" },
  { name: "sessions", description: "Pick a previous session to resume" },
  { name: "resume", description: "Resume a session by id: /resume <id>" },
  { name: "plan", description: "Switch to plan mode (read-only tools)" },
  { name: "act", description: "Switch to act mode (full tools)" },
  { name: "checkpoints", description: "List shadow-git snapshots of this session" },
  { name: "restore", description: "Restore a checkpoint: /restore <ref> [files|conversation|both]" },
  { name: "export", description: "Export this session: /export [--json] [path] [--force]" },
];

interface TuiState {
  yolo: boolean; provider: string; model: string; mode: AgentMode;
  turns: number; tokensIn: number; tokensOut: number;
  busy: boolean;
}

export async function runTui(opts: TuiAppOptions = {}): Promise<void> {
  // opts.sessionId may be a unique id prefix (aion --resume <id>); resolve it against
  // the sessions dir. Exact ids and brand-new ids pass through; an AMBIGUOUS prefix
  // must not silently pick one — start fresh and say so (same rule as /resume).
  let bootId = opts.sessionId;
  let bootWarn: string | undefined;
  if (bootId !== undefined) {
    const known = listSessions(join(opts.cwd ?? process.cwd(), ".aion", "sessions"));
    if (!known.some((s) => s.id === bootId)) {
      const pre = known.filter((s) => s.id.startsWith(bootId!));
      if (pre.length === 1) bootId = pre[0]!.id;
      else if (pre.length > 1) { bootWarn = `"${bootId}" matches ${pre.length} sessions — started fresh; use /resume to pick one`; bootId = undefined; }
    }
  }
  // opts.stream passes through verbatim: a StreamFn overrides, explicit null forces
  // "no provider", undefined defers to the runtime's env-resolved provider
  // port #27: a sandbox MISCONFIG throws synchronously here (before any side effect) — a clean
  // one-line startup error (exit 2), never a stack, never a silent direct fallback. The rung
  // PROBE verdict (rt.sandbox.ready) is awaited at the end of boot: runTui must stay
  // synchronous until the renderer's input handlers are wired (tests/smoke send input right
  // after calling runTui), so no await may sit above that point.
  const rt = (() => {
    try { return createRuntime({ cwd: opts.cwd, stream: opts.stream, sessionId: bootId }); }
    catch (e) {
      if (e instanceof SandboxConfigError && opts.exitOnClose !== false) { console.error(`error: ${e.message}`); process.exit(2); }
      throw e;
    }
  })();
  const renderer: Renderer = opts.renderer ?? new PiTuiRenderer({ cwd: rt.cwd });
  const sessionsDir = join(rt.cwd, ".aion", "sessions");
  // /cost pricing + context window. Boots from the offline snapshot; the live models.dev
  // half is user-invoked only (/cost refresh), cached to .aion/cache with a 24h TTL —
  // lookup() itself never fetches, so the TUI stays network-free unless asked.
  const catalog = new ModelCatalog({ fetchFn: fetch, cacheDir: join(rt.cwd, ".aion", "cache") });
  // session-scoped stores are swappable at runtime (/sessions, /rewind-to-root)
  let store = rt.store;
  let blocks = rt.blockStore;
  const steering = new SteeringQueue();
  // port #20: per-mode model slots from .aion/modes.json, restored from session entries
  const modesCfg = loadModesConfig(rt.cwd);
  const modes = new ModeManager(modesCfg, {
    provider: rt.provider?.id ?? "mock",
    model: opts.model ?? process.env.AION_MODEL ?? rt.defaultModel ?? "",
  });
  modes.restore(modeFromEntries(store.messages()) ?? modes.mode);
  const state: TuiState = {
    yolo: opts.yolo ?? process.env.AION_YOLO === "1",
    provider: modes.modelFor().provider,
    model: modes.modelFor().model,
    mode: modes.mode,
    turns: 0, tokensIn: 0, tokensOut: 0, busy: false,
  };
  let run: AsyncGenerator<RunEvent> | null = null; let runAbort: AbortController | null = null; // port #21: one controller per run
  let closed = false;
  let resolveClosed: () => void = () => {};
  const closedP = new Promise<void>((r) => { resolveClosed = r; });

  const status = (): StatusInfo => ({
    provider: state.provider, model: state.model, yolo: state.yolo, mode: state.mode,
    turns: state.turns, tokensIn: state.tokensIn, tokensOut: state.tokensOut,
  });
  const pushStatus = () => renderer.setStatus(status());

  const close = () => {
    if (closed) return;
    closed = true;
    // port #20 MED-2: /plan then quit resumes in plan (append is sync — lands pre-exit)
    flushModeSwitch(modes, store);
    runAbort?.abort(); void run?.return(undefined as never); // abort kills in-flight fetch/tools; return settles the generator
    void rt.mcp?.close().catch(() => {}); // stop MCP child processes/connections
    renderer.stop();
    resolveClosed();
    if (opts.exitOnClose !== false) process.exit(0);
  };

  const refreshUsage = () => {
    let inTok = 0, outTok = 0;
    for (const m of store.messages()) { inTok += m.usage?.input ?? 0; outTok += m.usage?.output ?? 0; }
    state.tokensIn = inTok; state.tokensOut = outTok;
  };

  /** Re-render the whole transcript from the active session path. */
  const replayHistory = () => {
    renderer.clearTranscript();
    for (const m of store.messages()) {
      const text = partsText(m.parts);
      if (m.role === "user") { if (text) renderer.addUser(text); }
      else if (m.role === "assistant") {
        if (text) { const v = renderer.beginAssistant(); v.append(text); v.done(); }
        for (const p of m.parts) {
          if (p.kind === "tool_call") renderer.toolStart(p.id, p.tool, JSON.stringify(p.args).slice(0, 120));
        }
      } else if (m.role === "tool") {
        for (const p of m.parts) {
          if (p.kind === "tool_result") renderer.toolEnd(p.callId, p.ok, p.output.slice(0, 160).replace(/\n/g, " ⏎ "), 0);
        }
      // port #20 LOW-3: mode switches replay as a human line, not raw <mode_notice> XML
      } else if (m.role === "system" && text) renderer.addSystemNote(replayLabel(m, text));
    }
  };

  const switchSession = (id: string, announce = true) => {
    flushModeSwitch(modes, store); // port #20 MED-2: don't discard a pending switch on /sessions away
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

  const handleSlash = (text: string): boolean => {
    const [cmd, ...rest] = text.slice(1).split(/\s+/);
    const arg = rest.join(" ").trim();
    switch (cmd) {
      case "exit": case "quit": close(); return true;
      case "help":
        renderer.addSystemNote(TUI_COMMANDS.map((c) => `/${c.name} — ${c.description}`).join("\n"));
        return true;
      case "yolo":
        state.yolo = !state.yolo;
        renderer.addSystemNote(`mode: ${state.yolo ? "yolo (all tools allowed)" : "gated (asks before writes/exec)"}`);
        pushStatus(); return true;
      case "model":
        // port #20: model writes land in the CURRENT mode's slot (mirrored to both
        // when planActSeparateModels is off)
        if (arg) { modes.setModel({ model: arg }); state.model = modes.modelFor().model; renderer.addSystemNote(`model → ${arg}${modes.separate ? ` (${modes.mode} mode)` : ""}`); pushStatus(); }
        else renderer.addSystemNote("usage: /model <id>", "warn");
        return true;
      case "plan": case "act":
        togglePlanAct(modes, cmd as AgentMode, state, renderer, pushStatus);
        return true;
      case "checkpoints":
        void cmdCheckpoints(cpCtx);
        return true;
      case "restore":
        void cmdRestore(cpCtx, arg);
        return true;
      case "status": {
        // port #8: config provenance — dropped/truncated sources must be visible (HIGH-2)
        const pc = rt.projectContext;
        const cfgBits = pc.sources.map((s) => s.chars === 0 ? `${s.path} (dropped)` : s.truncated ? `${s.path} (truncated)` : s.path);
        if (pc.skippedFiles > 0) cfgBits.push(`+${pc.skippedFiles} skipped (file cap)`);
        renderer.addSystemNote(
          `provider=${state.provider} model=${state.model} turns=${state.turns} tokens=${state.tokensIn}in/${state.tokensOut}out` +
          `\nsandbox: ${describeSandbox(rt.sandbox)}` + // port #27: active executor rung + origin
          `\nconfig: ${cfgBits.length > 0 ? cfgBits.join(", ") : "(none)"}`,
        );
        return true;
      }
      case "cost": {
        // port #6 live half: /cost refresh re-fetches models.dev pricing (24h disk cache)
        if (arg === "refresh") {
          void catalog.refresh().then((ok) => renderer.addSystemNote(
            ok ? "model catalog refreshed from models.dev" : "catalog refresh failed — using the offline snapshot",
            ok ? "info" : "warn",
          ));
          return true;
        }
        // ports #5+#6: normalized usage (incl. cache traffic) priced per message at its origin model
        renderer.addSystemNote(buildCostNote(store.messages(), catalog, { provider: state.provider, model: state.model }));
        return true;
      }
      case "skills": {
        const rows = rt.skillStore.list().map((s) => `${s.name} — ${s.description}`);
        renderer.addSystemNote(rows.length ? rows.join("\n") : "(no skills installed)");
        return true;
      }
      case "memory":
        renderer.addSystemNote(blocks.renderForPrompt() || "(empty)");
        return true;
      case "new": cmdNew(sessCtx); return true;
      case "rewind": case "tree": void cmdRewind(sessCtx); return true;
      case "sessions": void cmdSessions(sessCtx); return true;
      case "resume":
        if (arg) void cmdSessions(sessCtx, arg); else void cmdSessions(sessCtx);
        return true;
      case "export": {
        // port #38: write THIS session as markdown (raw JSONL with --json), local only.
        // Read-only over the store (exportSession re-reads from disk) — no busy gate needed.
        try {
          const words = arg.split(/\s+/).filter(Boolean);
          const res = exportSession(sessionsDir, store.id, {
            json: words.includes("--json"), force: words.includes("--force"),
            out: words.filter((w) => !w.startsWith("-")).join(" ") || undefined, cwd: rt.cwd,
          });
          renderer.addSystemNote(`exported ${res.format} → ${res.path}`);
        } catch (e) {
          renderer.addSystemNote(e instanceof Error ? e.message : String(e), "error");
        }
        return true;
      }
      default:
        renderer.addSystemNote(`unknown command: /${cmd} (try /help)`, "warn");
        return true;
    }
  };

  const startRun = async (goal: string) => {
    const stream = rt.stream; // runtime already applied any opts.stream override
    if (!stream) {
      renderer.addSystemNote("no provider — set AION_BASE_URL/AION_API_KEY or a <NAME>_API_KEY env and restart", "error");
      return;
    }
    state.busy = true;
    renderer.setBusy(true, "thinking…");
    pushStatus();
    const cfg = rt.buildCfg(state.yolo, state.yolo ? undefined : async (req) => {
      // port #24: edit/write approvals carry a bounded unified diff of the pending change
      // (in-memory preview; any failure degrades to the plain overlay, never blocks the ask)
      let detail: string | undefined;
      if (req.tool === "edit" || req.tool === "write") {
        try { detail = previewDiff(req.tool, req.revisedArgs, rt.cwd).text || undefined; } catch { detail = undefined; }
      }
      return renderer.askApproval(req.tool, JSON.stringify(req.revisedArgs).slice(0, 140), detail);
    });
    // port #20: per-mode model resolution + plan-mode rule/prompt enforcement
    const cur = modes.modelFor();
    const def = rt.buildDef({ provider: cur.provider, model: cur.model });
    applyModeToRun(modes, cfg, def);
    const views = new Map<string, AssistantView>();
    let lastView: AssistantView | null = null;
    runAbort = new AbortController();
    run = agentLoop(def, goal, {}, cfg, {
      stream, registry: rt.registry, store,
      tools: rt.registry.list().map((t) => t.schema),
      guard: rt.guard, signal: runAbort.signal, // port #21: Esc aborts this run's controller
    }, steering);
    try {
      for await (const ev of run) {
        if (ev.type === "turn_start") { resetTurnFailureCount(); state.turns++; pushStatus(); }
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
          renderer.addSystemNote(`compacted (${ev.strategy}): ${ev.tokensBefore} → ${ev.tokensAfter} tokens`);
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

  renderer.setCommands(TUI_COMMANDS);
  renderer.start({
    onSubmit: (text) => {
      if (text.startsWith("/")) { handleSlash(text); return; }
      renderer.addUser(text);
      // port #20: a pending mode switch becomes a durable session entry on the next
      // submit (round-trip cancellation: toggling back before submitting records nothing)
      flushModeSwitch(modes, store);
      if (state.busy) { steering.push(text); renderer.addSystemNote("queued as steering (applies before the next model turn)"); return; }
      void startRun(text);
    },
    // port #21: abort FIRST (kills in-flight fetch/subprocesses), then return() settles the generator
    onInterrupt: () => { runAbort?.abort(); void run?.return(undefined as never); renderer.addSystemNote("run interrupted", "warn"); },
    onExit: close,
  });
  // resumed boot: restore the transcript and usage counters (a bare session open left both blank)
  if (bootId !== undefined) { replayHistory(); refreshUsage(); }
  renderer.addSystemNote(
    `aion — session in ${rt.cwd}\nmode: ${state.yolo ? "yolo" : "gated"} · /help for commands` +
    (rt.stream ? "" : "\nno provider configured — run `aion auth set <provider>`, or set AION_BASE_URL/AION_API_KEY or a <NAME>_API_KEY"),
  );
  if (bootWarn) renderer.addSystemNote(bootWarn, "warn");
  pushStatus();
  // port #27: an unavailable configured rung (probe failed) is a clean one-line startup
  // error — stop the renderer first so the terminal is restored, then exit 2
  await rt.sandbox.ready.catch((e: unknown) => {
    if (e instanceof SandboxConfigError && opts.exitOnClose !== false) { renderer.stop(); console.error(`error: ${e.message}`); process.exit(2); }
    throw e;
  });
  await closedP;
}
