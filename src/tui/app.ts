/** TUI chat app (port #1): wires the ONE agentLoop (ADR-003) into a Renderer.
 *  All vendor contact lives behind Renderer (renderer.ts) — swap-friendly. */

import { agentLoop, SteeringQueue, partsText } from "../core/loop.ts";
import { resetTurnFailureCount } from "../memory/tools.ts";
import { createRuntime } from "../cli/runtime.ts";
import { SessionStore, listSessions } from "../core/session.ts";
import { BlockStore } from "../memory/blocks.ts";
import { ModelCatalog } from "../providers/catalog.ts";
import { costUsd, contextHealth, countTokens } from "../core/usage.ts";
import type { Renderer, AssistantView, StatusInfo } from "./renderer.ts";
import { PiTuiRenderer } from "./pi-renderer.ts";
import type { RunEvent, StreamFn } from "../core/types.ts";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

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
  { name: "cost", description: "Session tokens, cache hits, and USD estimate" },
  { name: "rewind", description: "Jump to an earlier turn and edit it (alias: /tree)" },
  { name: "tree", description: "Alias of /rewind" },
  { name: "sessions", description: "Pick a previous session to resume" },
  { name: "resume", description: "Resume a session by id: /resume <id>" },
];

interface TuiState {
  yolo: boolean; provider: string; model: string;
  turns: number; tokensIn: number; tokensOut: number;
  busy: boolean;
}

export async function runTui(opts: TuiAppOptions = {}): Promise<void> {
  // opts.stream passes through verbatim: a StreamFn overrides, explicit null forces
  // "no provider", undefined defers to the runtime's env-resolved provider
  const rt = createRuntime({ cwd: opts.cwd, stream: opts.stream, sessionId: opts.sessionId });
  const renderer: Renderer = opts.renderer ?? new PiTuiRenderer({ cwd: rt.cwd });
  const sessionsDir = join(rt.cwd, ".aion", "sessions");
  const catalog = new ModelCatalog(); // offline snapshot; /cost pricing + context window
  // session-scoped stores are swappable at runtime (/sessions, /rewind-to-root)
  let store = rt.store;
  let blocks = rt.blockStore;
  const steering = new SteeringQueue();
  const state: TuiState = {
    yolo: opts.yolo ?? process.env.AION_YOLO === "1",
    provider: rt.provider?.id ?? "mock",
    model: opts.model ?? process.env.AION_MODEL ?? rt.defaultModel ?? "",
    turns: 0, tokensIn: 0, tokensOut: 0, busy: false,
  };
  let run: AsyncGenerator<RunEvent> | null = null;
  let closed = false;
  let resolveClosed: () => void = () => {};
  const closedP = new Promise<void>((r) => { resolveClosed = r; });

  const status = (): StatusInfo => ({
    provider: state.provider, model: state.model, yolo: state.yolo,
    turns: state.turns, tokensIn: state.tokensIn, tokensOut: state.tokensOut,
  });
  const pushStatus = () => renderer.setStatus(status());

  const close = () => {
    if (closed) return;
    closed = true;
    void run?.return(undefined as never);
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
      } else if (m.role === "system" && text) renderer.addSystemNote(text);
    }
  };

  const switchSession = (id: string, announce = true) => {
    store = new SessionStore(sessionsDir, id);
    blocks = new BlockStore(join(sessionsDir, id, "memory"));
    // rebind BOTH consumers: the memory tool AND the system prompt's memory block
    // (critic finding: prompt kept reading the boot session's memory after /resume)
    rt.setBlockStore(blocks);
    state.turns = 0;
    replayHistory();
    refreshUsage();
    pushStatus();
    if (announce) renderer.addSystemNote(`session ${id.slice(0, 8)} (${store.messages().length} messages)`);
  };

  const cmdRewind = async () => {
    if (state.busy) { renderer.addSystemNote("finish or interrupt the run first (Esc)", "warn"); return; }
    const points = store.turnPoints();
    if (points.length === 0) { renderer.addSystemNote("nothing to rewind — no turns yet"); return; }
    const items = [...points].reverse().map((p) => ({
      value: p.entryId,
      label: `#${p.index} ${p.text}`,
      description: p.branches > 0 ? `◆ ${p.branches} other branch${p.branches > 1 ? "es" : ""}` : undefined,
    }));
    const picked = await renderer.pickOne(items, "rewind to a turn (Enter = edit & resubmit, Esc = cancel)");
    if (!picked) { replayHistory(); return; } // cancel: clear the overlay title note
    const point = points.find((p) => p.entryId === picked);
    if (!point) return;
    if (point.parentId === null) {
      // pi resets the leaf to an empty conversation (sessions.md:116); root reset would need
      // core support — v1 approximates it with a fresh session, old one untouched
      switchSession(randomUUID(), false);
      renderer.addSystemNote("rewound to the start — fresh session, previous one kept");
    } else {
      if (!store.branch(point.parentId)) { renderer.addSystemNote("rewind failed: turn not found", "error"); return; }
      replayHistory();
      renderer.addSystemNote(`rewound to before turn #${point.index} — edit and resubmit (branch kept)`);
    }
    renderer.prefillEditor(point.fullText); // FULL text, never the ≤80-char overlay label
    pushStatus();
  };

  const cmdSessions = async (directId?: string) => {
    if (state.busy) { renderer.addSystemNote("finish or interrupt the run first (Esc)", "warn"); return; }
    const all = listSessions(sessionsDir);
    if (directId) {
      const hit = all.find((s) => s.id === directId || s.id.startsWith(directId));
      if (hit) switchSession(hit.id);
      else renderer.addSystemNote(`no session matching "${directId}"`, "warn");
      return;
    }
    const items = all.slice(0, 20).map((s) => ({
      value: s.id,
      label: s.preview || "(empty session)",
      description: `${new Date(s.updatedAt).toLocaleString()} · ${s.entryCount} entries · ${s.id.slice(0, 8)}${s.id === store.id ? " · current" : ""}`,
    }));
    if (items.length === 0) { renderer.addSystemNote("no sessions found"); return; }
    const picked = await renderer.pickOne(items, "resume a session (Esc = cancel)");
    if (picked && picked !== store.id) switchSession(picked);
    else if (!picked) replayHistory(); // cancel: clear the overlay title note
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
        if (arg) { state.model = arg; renderer.addSystemNote(`model → ${arg}`); pushStatus(); }
        else renderer.addSystemNote("usage: /model <id>", "warn");
        return true;
      case "status":
        renderer.addSystemNote(`provider=${state.provider} model=${state.model} turns=${state.turns} tokens=${state.tokensIn}in/${state.tokensOut}out`);
        return true;
      case "cost": {
        // ports #5+#6: normalized usage (incl. cache hits) priced via the models.dev catalog
        let inTok = 0, outTok = 0, cacheRead = 0, cacheWrite = 0;
        for (const m of store.messages()) {
          inTok += m.usage?.input ?? 0; outTok += m.usage?.output ?? 0;
          cacheRead += m.usage?.cacheRead ?? 0; cacheWrite += m.usage?.cacheWrite ?? 0;
        }
        const info = catalog.lookup(state.provider, state.model);
        const cost = info?.pricing ? costUsd({ input: inTok, output: outTok, cacheRead, cacheWrite }, info.pricing) : undefined;
        const est = countTokens(store.messages().map((m) => partsText(m.parts)).join("\n"));
        const health = info?.contextWindow ? contextHealth(est, info.contextWindow) : undefined;
        renderer.addSystemNote([
          `tokens: ${inTok} in / ${outTok} out · cache: ${cacheRead} read / ${cacheWrite} written`,
          health ? `context: ~${est} of ${info?.contextWindow} (${Math.round(health.fraction * 100)}%${health.nearLimit ? " — near limit" : ""})` : `context: ~${est} tokens (window unknown)`,
          cost !== undefined ? `estimated cost: $${cost.toFixed(4)}` : `pricing unknown for ${state.provider}/${state.model}`,
        ].join("\n"));
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
      case "new":
        store.branch(store.messages()[0]?.id ?? "");
        renderer.addSystemNote("branched to session start");
        return true;
      case "rewind": case "tree":
        void cmdRewind();
        return true;
      case "sessions":
        void cmdSessions();
        return true;
      case "resume":
        if (arg) void cmdSessions(arg);
        else void cmdSessions();
        return true;
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
    const cfg = rt.buildCfg(state.yolo, state.yolo ? undefined : async (req) =>
      renderer.askApproval(req.tool, JSON.stringify(req.revisedArgs).slice(0, 140)));
    const def = rt.buildDef({ provider: state.provider, model: state.model });
    const views = new Map<string, AssistantView>();
    let lastView: AssistantView | null = null;
    run = agentLoop(def, goal, {}, cfg, {
      stream, registry: rt.registry, store,
      tools: rt.registry.list().map((t) => t.schema),
      guard: rt.guard,
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
      run = null;
      state.busy = false;
      refreshUsage();
      renderer.setBusy(false);
      pushStatus();
    }
  };

  renderer.setCommands(TUI_COMMANDS);
  renderer.start({
    onSubmit: (text) => {
      if (text.startsWith("/")) { handleSlash(text); return; }
      renderer.addUser(text);
      if (state.busy) { steering.push(text); renderer.addSystemNote("queued as steering (applies before the next model turn)"); return; }
      void startRun(text);
    },
    onInterrupt: () => { void run?.return(undefined as never); renderer.addSystemNote("run interrupted", "warn"); },
    onExit: close,
  });
  renderer.addSystemNote(
    `aion — session in ${rt.cwd}\nmode: ${state.yolo ? "yolo" : "gated"} · /help for commands` +
    (rt.stream ? "" : "\nno provider configured — set AION_BASE_URL/AION_API_KEY or a <NAME>_API_KEY"),
  );
  pushStatus();
  await closedP;
}
