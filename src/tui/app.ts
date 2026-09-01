/** TUI chat app (port #1): wires the ONE agentLoop (ADR-003) into a Renderer.
 *  All vendor contact lives behind Renderer (renderer.ts) — swap-friendly. */

import { agentLoop, SteeringQueue } from "../core/loop.ts";
import { resetTurnFailureCount } from "../memory/tools.ts";
import { createRuntime } from "../cli/runtime.ts";
import type { Renderer, AssistantView, StatusInfo } from "./renderer.ts";
import { PiTuiRenderer } from "./pi-renderer.ts";
import type { RunEvent, StreamFn } from "../core/types.ts";

export interface TuiAppOptions {
  yolo?: boolean;
  model?: string;
  cwd?: string;
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
];

interface TuiState {
  yolo: boolean; provider: string; model: string;
  turns: number; tokensIn: number; tokensOut: number;
  busy: boolean;
}

export async function runTui(opts: TuiAppOptions = {}): Promise<void> {
  const rt = createRuntime({ cwd: opts.cwd, stream: opts.stream ?? undefined });
  const renderer: Renderer = opts.renderer ?? new PiTuiRenderer({ cwd: rt.cwd });
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
    renderer.stop();
    resolveClosed();
    if (opts.exitOnClose !== false) process.exit(0);
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
      case "skills": {
        const rows = rt.skillStore.list().map((s) => `${s.name} — ${s.description}`);
        renderer.addSystemNote(rows.length ? rows.join("\n") : "(no skills installed)");
        return true;
      }
      case "memory":
        renderer.addSystemNote(rt.blockStore.renderForPrompt() || "(empty)");
        return true;
      case "new":
        rt.store.branch(rt.store.messages()[0]?.id ?? "");
        renderer.addSystemNote("branched to session start");
        return true;
      default:
        renderer.addSystemNote(`unknown command: /${cmd} (try /help)`, "warn");
        return true;
    }
  };

  const refreshUsage = () => {
    let inTok = 0, outTok = 0;
    for (const m of rt.store.messages()) { inTok += m.usage?.input ?? 0; outTok += m.usage?.output ?? 0; }
    state.tokensIn = inTok; state.tokensOut = outTok;
  };

  const startRun = async (goal: string) => {
    const stream = opts.stream ?? rt.stream;
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
      stream, registry: rt.registry, store: rt.store,
      tools: rt.registry.list().map((t) => t.schema),
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
    (rt.stream || opts.stream ? "" : "\nno provider configured — set AION_BASE_URL/AION_API_KEY or a <NAME>_API_KEY"),
  );
  pushStatus();
  await closedP;
}
